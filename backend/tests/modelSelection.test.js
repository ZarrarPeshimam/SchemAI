import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RunnableLambda } from "@langchain/core/runnables";
import app from "../src/app.js";
import { geminiService } from "../src/services/geminiService.js";
import { modelCatalogService } from "../src/services/modelCatalogService.js";
import { RefinementService } from "../src/services/refinementService.js";
import { RefinementChain } from "../src/services/refinement/refinementChain.js";
import { ConversationRefinementService } from "../src/services/conversationRefinementService.js";
import { mockSchema } from "../src/data/mockSchema.js";
import { useTestModelCatalog, resetTestModelCatalog } from "./helpers/testModelCatalog.js";
import { makeFakeModel } from "./helpers/fakeConversationModel.js";

/**
 * Request-scoped model selection: GET /api/models, model validation, and propagation of the chosen model to generation,
 * refinement and repair calls. No test reaches the network; a fake Gemini client / fake LangChain model records the
 * model each call used.
 */

const KEY = "AIzaSyFAKE_SECRET_KEY_1234567890abcdef";
const pk = (name) => ({ name, type: "INT", primaryKey: true, foreignKey: false, nullable: false, unique: true });
const validLlmSchema = () => ({
  entities: [{ id: "owner", name: "Owner", description: "Owners", attributes: [pk("owner_id")] }],
  relationships: [],
});
const invalidLlmSchema = () => {
  const s = validLlmSchema();
  s.entities[0].attributes[0].primaryKey = false;
  return s;
};
const providerError = (status, message = "provider failure") => Object.assign(new Error(message), { name: "ApiError", status });

function makeFakeClient(queue) {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (params) => {
        calls.push(params);
        if (queue.length === 0) throw new Error("Unexpected extra LLM call");
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return { text: typeof next === "string" ? next : JSON.stringify(next) };
      },
    },
  };
}

describe("model selection", () => {
  let server;
  let baseUrl;
  const savedEnv = {};

  before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}/api`;
        resolve();
      });
    });
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    useTestModelCatalog();
    for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_TIMEOUT_MS"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    geminiService.client = null;
  });
  afterEach(() => {
    geminiService.client = null;
    resetTestModelCatalog();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const get = async (path) => {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const post = async (path, body) => {
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  describe("GET /api/models", () => {
    it("returns the filtered, normalised list in the standard envelope without any secret", async () => {
      process.env.GEMINI_API_KEY = KEY;
      const { status, body, headers } = await get("/models");
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.ok(body.data.models.length >= 5);
      assert.deepEqual(Object.keys(body.data.models[0]).filter((k) => ["id", "displayName", "capabilities"].includes(k)).sort(), ["capabilities", "displayName", "id"]);
      assert.equal(body.data.stale, false);
      assert.ok(body.data.sourceUpdatedAt);
      assert.equal(headers.get("cache-control"), "no-store");
      const text = JSON.stringify(body);
      assert.equal(text.includes(KEY), false);
      assert.equal(text.includes("key="), false);
    });

    it("exposes defaultModelId only when the list verifies the configured default", async () => {
      process.env.GEMINI_MODEL = "gemini-a";
      assert.equal((await get("/models")).body.data.defaultModelId, "gemini-a");
      process.env.GEMINI_MODEL = "not-a-listed-model";
      assert.equal((await get("/models")).body.data.defaultModelId, null);
    });

    it("returns 503 MODEL_LIST_UNAVAILABLE (no secrets) when nothing has ever been fetched and discovery fails", async () => {
      process.env.GEMINI_API_KEY = KEY;
      modelCatalogService.reset();
      const original = modelCatalogService.fetchImpl;
      modelCatalogService.fetchImpl = async () => {
        throw new TypeError(`fetch failed for ?key=${KEY}`);
      };
      try {
        const { status, body } = await get("/models");
        assert.equal(status, 503);
        assert.equal(body.error.code, "MODEL_LIST_UNAVAILABLE");
        assert.equal(JSON.stringify(body).includes(KEY), false);
      } finally {
        modelCatalogService.fetchImpl = original;
      }
    });

    it("refresh=true is throttled: a second refresh right after a fetch does not call Google again", async () => {
      process.env.GEMINI_API_KEY = KEY;
      let calls = 0;
      const original = modelCatalogService.fetchImpl;
      modelCatalogService.reset();
      modelCatalogService.fetchImpl = async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({ models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }] }) };
      };
      try {
        await get("/models?refresh=true");
        await get("/models?refresh=true");
        await get("/models?refresh=true");
        assert.equal(calls, 1);
      } finally {
        modelCatalogService.fetchImpl = original;
      }
    });
  });

  describe("generation", () => {
    it("passes the selected model to Gemini (also when sent as models/<id>), and uses the SAME model for the repair call", async () => {
      const fake = makeFakeClient([invalidLlmSchema(), validLlmSchema()]);
      geminiService.client = fake;
      const { status, body } = await post("/schema/generate", { requirement: "owners", model: "models/gemini-b" });
      assert.equal(status, 200);
      assert.equal(body.data.repaired, true);
      assert.deepEqual(fake.calls.map((c) => c.model), ["gemini-b", "gemini-b"]);
    });

    it("ignores GEMINI_MODEL when a different valid model was selected", async () => {
      process.env.GEMINI_MODEL = "test-model-x";
      const fake = makeFakeClient([validLlmSchema()]);
      geminiService.client = fake;
      await post("/schema/generate", { requirement: "owners", model: "gemini-a" });
      assert.equal(fake.calls[0].model, "gemini-a");
    });

    it("rejects unknown / unsupported / malformed model ids with 400 MODEL_NOT_AVAILABLE and makes no provider call", async () => {
      for (const model of ["gemini-nope", "text-embedding-004", "../../etc", "x y"]) {
        const fake = makeFakeClient([validLlmSchema()]);
        geminiService.client = fake;
        const { status, body } = await post("/schema/generate", { requirement: "owners", model });
        assert.equal(status, 400, model);
        assert.equal(body.error.code, "MODEL_NOT_AVAILABLE");
        assert.equal(fake.calls.length, 0);
      }
    });

    it("rejects a non-string model with 400 MALFORMED_REQUEST", async () => {
      const { status, body } = await post("/schema/generate", { requirement: "owners", model: 42 });
      assert.equal(status, 400);
      assert.equal(body.error.code, "MALFORMED_REQUEST");
    });

    it("without a model uses the configured default only if verified; otherwise 400 MODEL_NOT_SELECTED", async () => {
      process.env.GEMINI_MODEL = "gemini-a";
      const fake = makeFakeClient([validLlmSchema()]);
      geminiService.client = fake;
      assert.equal((await post("/schema/generate", { requirement: "owners" })).status, 200);
      assert.equal(fake.calls[0].model, "gemini-a");

      process.env.GEMINI_MODEL = "retired-model";
      const fake2 = makeFakeClient([validLlmSchema()]);
      geminiService.client = fake2;
      const { status, body } = await post("/schema/generate", { requirement: "owners" });
      assert.equal(status, 400);
      assert.equal(body.error.code, "MODEL_NOT_SELECTED");
      assert.equal(fake2.calls.length, 0);
    });

    it("concurrent requests with different models never cross-contaminate", async () => {
      const seen = [];
      geminiService.client = {
        models: {
          generateContent: async (params) => {
            seen.push(params.model);
            await new Promise((r) => setTimeout(r, params.model === "gemini-a" ? 30 : 5));
            return { text: JSON.stringify(validLlmSchema()) };
          },
        },
      };
      const results = await Promise.all([
        post("/schema/generate", { requirement: "one", model: "gemini-a" }),
        post("/schema/generate", { requirement: "two", model: "gemini-b" }),
        post("/schema/generate", { requirement: "three", model: "gemini-a" }),
        post("/schema/generate", { requirement: "four", model: "gemini-b" }),
      ]);
      results.forEach((r) => assert.equal(r.status, 200));
      assert.deepEqual([...seen].sort(), ["gemini-a", "gemini-a", "gemini-b", "gemini-b"]);
    });

    it("the geminiService refuses to run without an explicit model (no hidden hardcoded fallback)", async () => {
      geminiService.client = makeFakeClient([validLlmSchema()]);
      await assert.rejects(geminiService.generateSchema("x"), { code: "MODEL_NOT_SELECTED" });
    });
  });

  describe("transient provider failures", () => {
    const fastRetry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} };

    it("retries HTTP 503 and then succeeds, with the same model and ONE successful result", async () => {
      geminiService.retry = fastRetry;
      const fake = makeFakeClient([providerError(503), providerError(503), validLlmSchema()]);
      geminiService.client = fake;
      const { status } = await post("/schema/generate", { requirement: "owners", model: "gemini-b" });
      assert.equal(status, 200);
      assert.deepEqual(fake.calls.map((c) => c.model), ["gemini-b", "gemini-b", "gemini-b"]);
    });

    it("exhausted retries (429) return a typed error; nothing is returned as a schema", async () => {
      geminiService.retry = fastRetry;
      const fake = makeFakeClient([providerError(429), providerError(429), providerError(429)]);
      geminiService.client = fake;
      const { status, body } = await post("/schema/generate", { requirement: "owners", model: "gemini-a" });
      assert.equal(status, 429);
      assert.equal(body.error.code, "RATE_LIMIT_EXCEEDED");
      assert.equal(body.data, undefined);
      assert.equal(fake.calls.length, 3);
    });

    it("does not retry a non-transient error (404 model gone)", async () => {
      geminiService.retry = fastRetry;
      const fake = makeFakeClient([providerError(404)]);
      geminiService.client = fake;
      const { status, body } = await post("/schema/generate", { requirement: "owners", model: "gemini-a" });
      assert.equal(status, 503);
      assert.equal(body.error.code, "MODEL_UNAVAILABLE");
      assert.equal(fake.calls.length, 1);
    });
  });

  describe("refinement", () => {
    /** Fake chain recording the model of every proposal request. */
    const makeChain = (responses) => {
      const modelsSeen = [];
      return {
        modelsSeen,
        propose: async ({ model }) => {
          modelsSeen.push(model);
          return responses.shift() ?? { ok: false, issues: ["none"] };
        },
      };
    };
    const emptyOps = { ok: true, response: { outcome: "operations", message: "", operations: [] } };

    it("passes the request model to the initial proposal AND every repair attempt", async () => {
      const chain = makeChain([emptyOps, emptyOps, emptyOps]);
      const service = new RefinementService(chain);
      await assert.rejects(service.refineSchema({ schema: mockSchema, instruction: "x", model: "gemini-b" }), { code: "REFINEMENT_FAILED" });
      assert.deepEqual(chain.modelsSeen, ["gemini-b", "gemini-b", "gemini-b"]);
    });

    it("two concurrent refinements keep their own models", async () => {
      const a = makeChain([emptyOps, emptyOps, emptyOps]);
      const b = makeChain([emptyOps, emptyOps, emptyOps]);
      await Promise.allSettled([
        new RefinementService(a).refineSchema({ schema: mockSchema, instruction: "x", model: "gemini-a" }),
        new RefinementService(b).refineSchema({ schema: mockSchema, instruction: "x", model: "gemini-b" }),
      ]);
      assert.deepEqual(new Set(a.modelsSeen), new Set(["gemini-a"]));
      assert.deepEqual(new Set(b.modelsSeen), new Set(["gemini-b"]));
    });

    it("the real chain builds its Gemini chat model from the request model and refuses to run without one", async () => {
      process.env.GEMINI_API_KEY = KEY;
      const chain = new RefinementChain();
      assert.equal(chain.getModel("gemini-b").model, "gemini-b");
      assert.throws(() => chain.getModel(undefined), { code: "MODEL_NOT_SELECTED" });
    });

    it("retries a transient 503 from the LangChain model and keeps the same chain model", async () => {
      geminiService.retry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} };
      let calls = 0;
      const lc = {
        withStructuredOutput: () =>
          RunnableLambda.from(async () => {
            calls++;
            if (calls < 3) throw providerError(503);
            return { outcome: "needs_clarification", message: "Which one?", operations: [] };
          }),
      };
      const chain = new RefinementChain({ model: lc });
      const result = await chain.propose({ schema: mockSchema, instruction: "x", model: "gemini-a" });
      assert.equal(result.ok, true);
      assert.equal(calls, 3);
    });

    it("exhausted LangChain retries surface MODEL_TEMPORARILY_UNAVAILABLE", async () => {
      geminiService.retry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2, sleep: async () => {} };
      const lc = { withStructuredOutput: () => RunnableLambda.from(async () => { throw providerError(503); }) };
      const chain = new RefinementChain({ model: lc });
      await assert.rejects(chain.propose({ schema: mockSchema, instruction: "x", model: "gemini-a" }), { code: "MODEL_TEMPORARILY_UNAVAILABLE" });
    });

    it("saved conversation: the model reaches the refiner; a failed refinement leaves the stored schema and version unchanged", async () => {
      const ID = "a".repeat(24);
      const fakeModel = makeFakeModel([{ _id: ID, schema: structuredClone(mockSchema), schemaVersion: 3, messages: [] }]);
      const seen = [];
      const refiner = {
        refineSchema: async (args) => {
          seen.push(args.model);
          throw Object.assign(new Error("provider down"), { expose: true, statusCode: 503, code: "MODEL_TEMPORARILY_UNAVAILABLE" });
        },
      };
      const svc = new ConversationRefinementService({ model: fakeModel, refiner, connected: () => true });
      await assert.rejects(svc.refine({ conversationId: ID, instruction: "x", model: "gemini-b" }), { code: "MODEL_TEMPORARILY_UNAVAILABLE" });
      assert.deepEqual(seen, ["gemini-b"]);
      assert.equal(fakeModel.calls.findOneAndUpdate, 0);
      assert.equal(fakeModel.store.get(ID).schemaVersion, 3);
      assert.equal(fakeModel.store.get(ID).messages.length, 0);
    });

    it("HTTP: an invalid model is rejected with 400 before the refinement runs (stateless mode)", async () => {
      const { status, body } = await post("/schema/refine", { schema: mockSchema, instruction: "Add a column", model: "gemini-nope" });
      assert.equal(status, 400);
      assert.equal(body.error.code, "MODEL_NOT_AVAILABLE");
    });
  });
});
