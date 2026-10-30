import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getProviderStatus, mapProviderError } from "../src/services/providerErrors.js";
import { isRetryableProviderError, withRetry } from "../src/services/providerRetry.js";

/**
 * Timeout classification. The error below is the REAL error the platform throws for AbortSignal.timeout() (the same
 * mechanism RefinementChain.propose uses), not a hand-made imitation.
 */
async function realTimeoutError() {
  const signal = AbortSignal.timeout(5);
  await new Promise((resolve) => setTimeout(resolve, 40));
  return signal.reason;
}

describe("Gemini timeout handling", () => {
  it("a platform TimeoutError is not mistaken for an HTTP status (its legacy DOMException code is 23)", async () => {
    const err = await realTimeoutError();
    assert.equal(err.name, "TimeoutError");
    assert.equal(err.code, 23, "sanity check of the platform behaviour this guards against");
    assert.ok(Number.isNaN(getProviderStatus(err)));
  });

  it("real HTTP statuses (direct, nested, or in the message) are still recognised", () => {
    assert.equal(getProviderStatus({ status: 429 }), 429);
    assert.equal(getProviderStatus({ response: { status: 503 } }), 503);
    assert.equal(getProviderStatus({ message: "[503 Service Unavailable] try later" }), 503);
    assert.ok(Number.isNaN(getProviderStatus({ code: "ECONNRESET" })));
    assert.ok(Number.isNaN(getProviderStatus({ code: 0 })));
  });

  it("maps a platform TimeoutError to 504 LLM_TIMEOUT with a safe message", async () => {
    const mapped = mapProviderError(await realTimeoutError());
    assert.equal(mapped.code, "LLM_TIMEOUT");
    assert.equal(mapped.statusCode, 504);
    assert.equal(mapped.expose, true);
  });

  it("a timeout is never retried: the provider is called exactly once", async () => {
    const err = await realTimeoutError();
    assert.equal(isRetryableProviderError(err), false);
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw err;
      }, { sleep: async () => {} }),
      (e) => e === err
    );
    assert.equal(calls, 1);
  });

  it("transient 503s are still retried a bounded number of times, then surfaced", async () => {
    let calls = 0;
    const err = Object.assign(new Error("overloaded"), { status: 503 });
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw err;
      }, { maxRetries: 2, sleep: async () => {}, random: () => 1 })
    );
    assert.equal(calls, 3);
  });

  it("other failure classes keep their own codes (not reported as timeouts)", () => {
    assert.equal(mapProviderError(Object.assign(new Error("x"), { status: 429 })).code, "RATE_LIMIT_EXCEEDED");
    assert.equal(mapProviderError(Object.assign(new Error("x"), { status: 500 })).code, "LLM_PROVIDER_ERROR");
    assert.equal(mapProviderError(Object.assign(new Error("x"), { status: 503 })).code, "MODEL_TEMPORARILY_UNAVAILABLE");
  });
});
