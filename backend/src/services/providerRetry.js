import { getProviderStatus } from "./providerErrors.js";

/**
 * Bounded retry for TRANSIENT provider failures (HTTP 429, 500, 502, 503). Everything else (400 bad request / schema
 * rejection, 401/403, 404, timeouts, malformed output, application errors) is never retried.
 *
 * Retry-After handling: a `Retry-After` header (seconds or HTTP date) or Google's `retryDelay` ("34s") in the error body
 * is honoured; if the requested wait exceeds `maxDelayMs` the error is NOT retried (fail fast, the caller can retry).
 * Otherwise: exponential backoff `baseDelayMs * 2^attempt` with jitter (50-100 % of the nominal delay), capped at maxDelayMs.
 *
 * Retrying only re-issues the provider call. Persistence happens after a validated result exists, so a retry can never
 * duplicate messages or commit a schema twice.
 */

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
});

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

export const isRetryableProviderError = (err) => !err?.expose && RETRYABLE_STATUSES.has(getProviderStatus(err));

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** Server-requested wait in ms, or null when the error does not say. */
export function getRetryAfterMs(err, nowMs = Date.now()) {
  const header = readHeader(err?.headers, "retry-after") ?? readHeader(err?.response?.headers, "retry-after");
  if (header !== undefined && header !== null && String(header).trim() !== "") {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(String(header));
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  const m = String(err?.message ?? "").match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/**
 * Runs `fn()` and retries transient failures. `fn` is invoked afresh per attempt (build per-attempt abort signals inside).
 * Rethrows the LAST error unchanged so the caller can map it (mapProviderError).
 */
export async function withRetry(fn, policy = {}) {
  const { maxRetries, baseDelayMs, maxDelayMs, sleep, random } = { ...DEFAULT_RETRY_POLICY, ...policy };
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableProviderError(err)) throw err;
      const requested = getRetryAfterMs(err);
      if (requested !== null && requested > maxDelayMs) throw err;
      const nominal = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = requested ?? Math.round(nominal * (0.5 + random() * 0.5));
      await sleep(delay);
    }
  }
}
