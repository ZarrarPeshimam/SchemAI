import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalogService, MODELS_ENDPOINT } from "../src/services/modelCatalogService.js";
import { evaluateCompatibility, deriveChannel } from "../src/services/modelCompatibility.js";
import { normalizeModelId } from "../src/services/modelId.js";
import { withRetry, getRetryAfterMs, isRetryableProviderError } from "../src/services/providerRetry.js";
import { mapProviderError } from "../src/services/providerErrors.js";

/** Model discovery, compatibility, caching, retry and provider-error tests. Pure unit tests: no network, no real key. */

const KEY = "AIzaSyFAKE_SECRET_KEY_1234567890abcdef";
const raw = (id, extra = {}) => ({
  name: `models/${id}`,
  displayName: id.toUpperCase(),
  description: `desc ${id}`,
  version: "1",
  inputTokenLimit: 1000,
  outputTokenLimit: 100,
  supportedGenerationMethods: ["generateContent", "countTokens"],
  ...extra,
});
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function makeCatalog({ responses, now, ...opts } = {}) {
  const calls = [];
  const queue = [...(responses ?? [])];
  const clock = { t: 1_000_000 };
  const svc = new ModelCatalogService({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (queue.length === 0) throw new Error("unexpected extra fetch");
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(url) : next;
    },
    now: now ?? (() => clock.t),
    getApiKey: () => KEY,
    getDefaultModel: () => "gemini-default",
    ...opts,
  });
  return { svc, calls, clock };
}

describe("model id normalisation", () => {
  it("strips only a leading models/ prefix and rejects invalid ids", () => {
    assert.equal(normalizeModelId("models/gemini-x"), "gemini-x");
    assert.equal(normalizeModelId("gemini-x"), "gemini-x");
    assert.equal(normalizeModelId("  gemini-x  "), "gemini-x");
    for (const bad of ["", "models/", "tunedModels/a", "a b", "a/b", "../x", "x'y", 42, null, undefined, "a".repeat(200)]) {
      assert.equal(normalizeModelId(bad), null, String(bad));
    }
  });
});

describe("compatibility rules", () => {
  it("requires generateContent and removes clearly non-text models", () => {
    assert.equal(evaluateCompatibility(raw("gemini-a")).compatible, true);
    assert.equal(evaluateCompatibility(raw("gemini-a", { supportedGenerationMethods: ["embedContent"] })).compatible, false);
    assert.equal(evaluateCompatibility(raw("gemini-a", { supportedGenerationMethods: undefined })).compatible, false);
    for (const id of ["text-embedding-004", "imagen-4", "gemini-x-image", "veo-3", "gemini-x-tts", "gemini-x-native-audio", "gemini-x-live", "aqa", "gemma-3-27b"]) {
      assert.equal(evaluateCompatibility(raw(id)).compatible, false, id);
    }
    assert.equal(evaluateCompatibility({ displayName: "no name", supportedGenerationMethods: ["generateContent"] }).compatible, false);
  });
  it("derives a release channel as a hint only", () => {
    assert.equal(deriveChannel("gemini-x-preview-05"), "preview");
    assert.equal(deriveChannel("gemini-x-exp-1"), "experimental");
    assert.equal(deriveChannel("gemini-x-flash"), "stable");
  });
});

describe("ModelCatalogService discovery", () => {
  it("calls the official REST endpoint with the server-side key, parses and normalises the models", async () => {
    const { svc, calls } = makeCatalog({
      responses: [jsonResponse({ models: [raw("gemini-b"), raw("gemini-a"), raw("text-embedding-004", { supportedGenerationMethods: ["embedContent"] })] })],
    });
    const cat = await svc.getCatalog();
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(`${url.origin}${url.pathname}`, MODELS_ENDPOINT);
    assert.equal(MODELS_ENDPOINT, "https://generativelanguage.googleapis.com/v1beta/models");
    assert.equal(url.searchParams.get("key"), KEY);
    assert.equal(calls[0].init.method, "GET");
    assert.deepEqual(cat.models.map((m) => m.id), ["gemini-a", "gemini-b"]);
    assert.equal(cat.models[0].displayName, "GEMINI-A");
    assert.equal(cat.models[0].capabilities.structuredOutput, "unverified");
    assert.equal(cat.stale, false);
    assert.equal(cat.refreshError, undefined);
    assert.ok(!Number.isNaN(Date.parse(cat.sourceUpdatedAt)));
  });

  it("never exposes the key, raw provider fields or credential URLs in the public result", async () => {
    const { svc } = makeCatalog({ responses: [jsonResponse({ models: [raw("gemini-a", { temperature: 1, topK: 40, secretField: "x" })] })] });
    const text = JSON.stringify(await svc.getCatalog());
    for (const leaked of [KEY, "key=", "googleapis", "secretField", "topK", "supportedGenerationMethods", "models/"]) {
      assert.equal(text.includes(leaked), false, leaked);
    }
  });

  it("follows nextPageToken until complete and de-duplicates", async () => {
    const { svc, calls } = makeCatalog({
      responses: [
        jsonResponse({ models: [raw("gemini-a")], nextPageToken: "T1" }),
        jsonResponse({ models: [raw("gemini-b"), raw("gemini-a")], nextPageToken: "T2" }),
        jsonResponse({ models: [raw("gemini-c")] }),
      ],
    });
    const cat = await svc.getCatalog();
    assert.deepEqual(cat.models.map((m) => m.id), ["gemini-a", "gemini-b", "gemini-c"]);
    assert.equal(new URL(calls[1].url).searchParams.get("pageToken"), "T1");
    assert.equal(new URL(calls[2].url).searchParams.get("pageToken"), "T2");
  });

  it("stops at the page safety limit instead of caching a partial list", async () => {
    const pages = Array.from({ length: 5 }, (_, i) => jsonResponse({ models: [raw(`gemini-${i}`)], nextPageToken: `T${i}` }));
    const { svc } = makeCatalog({ responses: pages, maxPages: 3 });
    await assert.rejects(svc.getCatalog(), { code: "MODEL_LIST_UNAVAILABLE", statusCode: 503 });
  });

  const failureCases = [
    ["HTTP 500", jsonResponse({}, 500), "MODEL_LIST_HTTP_ERROR"],
    ["HTTP 403", jsonResponse({}, 403), "MODEL_LIST_AUTH_ERROR"],
    ["HTTP 429", jsonResponse({}, 429), "MODEL_LIST_RATE_LIMITED"],
    ["network failure", new TypeError("fetch failed"), "MODEL_LIST_NETWORK_ERROR"],
    ["timeout", Object.assign(new Error("t"), { name: "TimeoutError" }), "MODEL_LIST_TIMEOUT"],
    ["non-JSON body", { ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } }, "MODEL_LIST_MALFORMED"],
    ["non-object body", jsonResponse([1, 2]), "MODEL_LIST_MALFORMED"],
    ["models not an array", jsonResponse({ models: "nope" }), "MODEL_LIST_MALFORMED"],
    ["empty object", jsonResponse({}), "MODEL_LIST_EMPTY"],
    ["empty list", jsonResponse({ models: [] }), "MODEL_LIST_EMPTY"],
    ["no usable models", jsonResponse({ models: [{ foo: 1 }, null, raw("text-embedding-004", { supportedGenerationMethods: ["embedContent"] })] }), "MODEL_LIST_EMPTY"],
  ];
  for (const [label, response, code] of failureCases) {
    it(`${label} with no cache -> 503 MODEL_LIST_UNAVAILABLE (${code}), no secrets`, async () => {
      const { svc } = makeCatalog({ responses: [response] });
      await assert.rejects(svc.getCatalog(), (err) => {
        assert.equal(err.code, "MODEL_LIST_UNAVAILABLE");
        assert.equal(err.statusCode, 503);
        assert.deepEqual(err.details, [code]);
        assert.equal(JSON.stringify({ m: err.message, d: err.details }).includes(KEY), false);
        return true;
      });
    });
  }

  it("tolerates individual malformed entries when others are valid", async () => {
    const { svc } = makeCatalog({ responses: [jsonResponse({ models: [null, "str", { name: "models/a b" }, raw("gemini-ok")] })] });
    assert.deepEqual((await svc.getCatalog()).models.map((m) => m.id), ["gemini-ok"]);
  });

  it("does not log the API key or credential URL when a fetch fails", async () => {
    const logged = [];
    const orig = console.warn;
    console.warn = (...a) => logged.push(a.join(" "));
    try {
      const { svc } = makeCatalog({ responses: [new Error(`connect failed for https://generativelanguage.googleapis.com/v1beta/models?key=${KEY}`)] });
      await assert.rejects(svc.getCatalog());
    } finally {
      console.warn = orig;
    }
    assert.ok(logged.length > 0);
    assert.equal(logged.join("\n").includes(KEY), false);
  });
});

describe("ModelCatalogService caching", () => {
  it("reuses the cache within the TTL and refetches after it expires", async () => {
    const { svc, calls, clock } = makeCatalog({ ttlMs: 60_000, minIntervalMs: 1000, responses: [jsonResponse({ models: [raw("gemini-a")] }), jsonResponse({ models: [raw("gemini-b")] })] });
    await svc.getCatalog();
    clock.t += 30_000;
    assert.deepEqual((await svc.getCatalog()).models.map((m) => m.id), ["gemini-a"]);
    assert.equal(calls.length, 1);
    clock.t += 31_000;
    assert.deepEqual((await svc.getCatalog()).models.map((m) => m.id), ["gemini-b"]);
    assert.equal(calls.length, 2);
  });

  it("explicit refresh refetches, but is throttled so browsers cannot hammer Google", async () => {
    const { svc, calls, clock } = makeCatalog({ minIntervalMs: 10_000, responses: [jsonResponse({ models: [raw("gemini-a")] }), jsonResponse({ models: [raw("gemini-b")] })] });
    await svc.getCatalog();
    clock.t += 2000;
    await svc.getCatalog({ forceRefresh: true });
    assert.equal(calls.length, 1, "refresh inside the minimum interval is served from cache");
    clock.t += 9000;
    const cat = await svc.getCatalog({ forceRefresh: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(cat.models.map((m) => m.id), ["gemini-b"]);
  });

  it("coalesces concurrent callers into one upstream fetch", async () => {
    const { svc, calls } = makeCatalog({ responses: [jsonResponse({ models: [raw("gemini-a")] })] });
    const results = await Promise.all([svc.getCatalog(), svc.getCatalog(), svc.getCatalog({ forceRefresh: true })]);
    assert.equal(calls.length, 1);
    assert.equal(results.length, 3);
  });

  it("keeps the last good list as STALE when a refresh fails, with a sanitised error and the old timestamp", async () => {
    const { svc, calls, clock } = makeCatalog({ ttlMs: 1000, minIntervalMs: 100, responses: [jsonResponse({ models: [raw("gemini-a")] }), jsonResponse({}, 503)] });
    const first = await svc.getCatalog();
    clock.t += 5000;
    const second = await svc.getCatalog();
    assert.equal(calls.length, 2);
    assert.deepEqual(second.models, first.models);
    assert.equal(second.stale, true);
    assert.equal(second.refreshError.code, "MODEL_LIST_HTTP_ERROR");
    assert.equal(second.sourceUpdatedAt, first.sourceUpdatedAt, "timestamp stays that of the last SUCCESSFUL fetch");
    assert.equal(JSON.stringify(second).includes(KEY), false);
  });

  it("does not retry a failed refresh before the minimum interval, and recovers afterwards", async () => {
    const { svc, calls, clock } = makeCatalog({ ttlMs: 1000, minIntervalMs: 10_000, responses: [jsonResponse({ models: [raw("gemini-a")] }), new TypeError("down"), jsonResponse({ models: [raw("gemini-b")] })] });
    await svc.getCatalog();
    clock.t += 11_000;
    assert.equal((await svc.getCatalog()).stale, true);
    clock.t += 1000;
    assert.equal((await svc.getCatalog()).stale, true);
    assert.equal(calls.length, 2);
    clock.t += 10_000;
    const recovered = await svc.getCatalog();
    assert.equal(recovered.stale, false);
    assert.equal(recovered.refreshError, undefined);
    assert.deepEqual(recovered.models.map((m) => m.id), ["gemini-b"]);
  });

  it("an empty/garbled refresh never replaces a good cache", async () => {
    const { svc, clock } = makeCatalog({ ttlMs: 1000, minIntervalMs: 100, responses: [jsonResponse({ models: [raw("gemini-a")] }), jsonResponse({ models: [] })] });
    await svc.getCatalog();
    clock.t += 5000;
    const cat = await svc.getCatalog();
    assert.deepEqual(cat.models.map((m) => m.id), ["gemini-a"]);
    assert.equal(cat.stale, true);
  });

  it("a missing API key makes no network call and surfaces MISSING_API_KEY", async () => {
    const { svc, calls } = makeCatalog({ getApiKey: () => { throw Object.assign(new Error("no key"), { code: "MISSING_API_KEY", statusCode: 503, expose: true }); } });
    await assert.rejects(svc.getCatalog(), { code: "MISSING_API_KEY", statusCode: 503 });
    assert.equal(calls.length, 0);
  });
});

describe("ModelCatalogService.resolveModel (request-scoped validation + default policy)", () => {
  const catalogWith = (ids, defaultModel = "gemini-default") => {
    const { svc } = makeCatalog({ getDefaultModel: () => defaultModel });
    svc.seed(ids.map((i) => raw(i)));
    return svc;
  };

  it("accepts a listed id (also as models/<id>) and returns the canonical id", async () => {
    const svc = catalogWith(["gemini-a", "gemini-b"]);
    assert.equal(await svc.resolveModel("gemini-b"), "gemini-b");
    assert.equal(await svc.resolveModel("models/gemini-a"), "gemini-a");
  });

  it("rejects unknown, unsupported and malformed ids with 400 MODEL_NOT_AVAILABLE (no fallback)", async () => {
    const svc = catalogWith(["gemini-a", "gemini-default"]);
    for (const bad of ["gemini-zzz", "text-embedding-004", "a b", "../x", "GEMINI-A"]) {
      await assert.rejects(svc.resolveModel(bad), { code: "MODEL_NOT_AVAILABLE", statusCode: 400 }, bad);
    }
  });

  it("without a requested id uses the configured default only when the list verifies it", async () => {
    assert.equal(await catalogWith(["gemini-a", "gemini-default"]).resolveModel(undefined), "gemini-default");
    assert.equal(await catalogWith(["gemini-a", "gemini-default"]).resolveModel("  "), "gemini-default");
    await assert.rejects(catalogWith(["gemini-a"]).resolveModel(undefined), { code: "MODEL_NOT_SELECTED", statusCode: 400 });
  });

  it("exposes defaultModelId only when it is verified in the list", async () => {
    assert.equal((await catalogWith(["gemini-default"]).getCatalog()).defaultModelId, "gemini-default");
    assert.equal((await catalogWith(["gemini-a"]).getCatalog()).defaultModelId, null);
  });

  it("cannot bypass validation when the list is unavailable", async () => {
    const { svc } = makeCatalog({ responses: [new TypeError("down")] });
    await assert.rejects(svc.resolveModel("gemini-a"), { code: "MODEL_LIST_UNAVAILABLE" });
  });

  it("concurrent resolutions return their own ids (no shared mutable selection)", async () => {
    const svc = catalogWith(["gemini-a", "gemini-b"]);
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => svc.resolveModel(i % 2 ? "gemini-a" : "gemini-b")));
    ids.forEach((id, i) => assert.equal(id, i % 2 ? "gemini-a" : "gemini-b"));
  });
});

describe("withRetry (transient provider failures)", () => {
  const err = (status, extra = {}) => Object.assign(new Error("x"), { status, ...extra });
  const policy = (delays = []) => ({ maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, sleep: async (ms) => delays.push(ms), random: () => 1 });

  it("retries 503 up to two times with exponential backoff, then succeeds", async () => {
    const delays = [];
    let n = 0;
    const result = await withRetry(async () => { if (++n < 3) throw err(503); return "ok"; }, policy(delays));
    assert.equal(result, "ok");
    assert.equal(n, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it("gives up after the bounded number of retries and rethrows the last error", async () => {
    let n = 0;
    await assert.rejects(withRetry(async () => { n++; throw err(429); }, policy()), { status: 429 });
    assert.equal(n, 3);
  });

  it("applies jitter within 50-100% of the nominal delay", async () => {
    const delays = [];
    let n = 0;
    await withRetry(async () => { if (++n < 2) throw err(503); }, { ...policy(delays), random: () => 0 });
    assert.deepEqual(delays, [50]);
  });

  it("does not retry non-retryable errors", async () => {
    for (const e of [err(400), err(401), err(404), err(504), new Error("plain"), Object.assign(err(503), { expose: true })]) {
      let n = 0;
      await assert.rejects(withRetry(async () => { n++; throw e; }, policy()));
      assert.equal(n, 1);
    }
  });

  it("honours Retry-After, and fails fast when it is longer than the cap", async () => {
    const delays = [];
    let n = 0;
    await withRetry(async () => { if (++n < 2) throw err(429, { headers: { "Retry-After": "1" } }); }, policy(delays));
    assert.deepEqual(delays, [1000]);
    let m = 0;
    await assert.rejects(withRetry(async () => { m++; throw err(429, { headers: new Headers({ "retry-after": "60" }) }); }, policy()));
    assert.equal(m, 1);
  });

  it("reads Google's retryDelay from the error body", () => {
    assert.equal(getRetryAfterMs(new Error('{"error":{"details":[{"retryDelay":"34s"}]}}')), 34000);
    assert.equal(getRetryAfterMs(new Error("nothing")), null);
    assert.equal(isRetryableProviderError(err(503)), true);
    assert.equal(isRetryableProviderError(new Error("[503 Service Unavailable] overloaded")), true);
  });
});

describe("mapProviderError distinguishes failure kinds", () => {
  const quiet = (fn) => { const o = console.error; console.error = () => {}; try { return fn(); } finally { console.error = o; } };
  const map = (status, message = "m") => quiet(() => mapProviderError(Object.assign(new Error(message), { status })));
  it("maps statuses to typed codes", () => {
    assert.equal(map(503).code, "MODEL_TEMPORARILY_UNAVAILABLE");
    assert.equal(map(429).code, "RATE_LIMIT_EXCEEDED");
    assert.equal(map(404).code, "MODEL_UNAVAILABLE");
    assert.equal(map(403).code, "LLM_AUTH_ERROR");
    assert.equal(map(500).code, "LLM_PROVIDER_ERROR");
    assert.equal(map(504).code, "LLM_TIMEOUT");
    assert.equal(map(400, "Invalid JSON payload: response schema has $ref").code, "LLM_SCHEMA_REJECTED");
    assert.equal(map(400, "JSON mode is not enabled for models/x").code, "MODEL_INCOMPATIBLE");
  });
  it("never returns provider text", () => {
    assert.equal(map(500, `boom ${KEY}`).message.includes("boom"), false);
  });
});
