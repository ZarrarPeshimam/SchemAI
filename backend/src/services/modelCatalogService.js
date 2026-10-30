import { createAppError, redact } from "./appError.js";
import { getConfiguredDefaultModel, getGeminiApiKey } from "./geminiConfig.js";
import { normalizeModelId } from "./modelId.js";
import { compareModels, evaluateCompatibility, toPublicModel } from "./modelCompatibility.js";

/**
 * Dynamic Gemini model discovery.
 *
 * Source of truth: Google's official REST endpoint (NOT an SDK list method)
 *     GET https://generativelanguage.googleapis.com/v1beta/models?key=<server-side key>&pageSize=1000[&pageToken=...]
 * called from the backend only. The key never reaches the browser, logs or error messages.
 *
 * Caching / refresh policy (single instance, in memory):
 *   - A successful fetch is cached for CACHE_TTL_MS and served without touching Google.
 *   - Upstream is never contacted more often than MIN_UPSTREAM_INTERVAL_MS (success OR failure), even for an explicit
 *     refresh, so browsers cannot trigger uncontrolled upstream traffic. Concurrent callers share one in-flight fetch.
 *   - If a refresh fails, the last successful list is KEPT and returned with `stale: true` + a sanitised `refreshError`.
 *     `sourceUpdatedAt` always remains the time of the last SUCCESSFUL fetch.
 *   - With no cached list a failure throws a typed MODEL_LIST_UNAVAILABLE error.
 */

export const MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const CACHE_TTL_MS = 5 * 60 * 1000;
export const MIN_UPSTREAM_INTERVAL_MS = 10 * 1000;
export const FETCH_TIMEOUT_MS = 10 * 1000;
export const MAX_PAGES = 10;
const PAGE_SIZE = 1000;

/** Internal failure carrying only sanitised, client-safe fields. */
function discoveryError(code, message) {
  return Object.assign(new Error(message), { discoveryCode: code, discoveryMessage: message });
}

function statusToDiscoveryError(status) {
  if (status === 401 || status === 403 || status === 400) {
    return discoveryError("MODEL_LIST_AUTH_ERROR", "The AI provider rejected the server's credentials while listing models.");
  }
  if (status === 429) return discoveryError("MODEL_LIST_RATE_LIMITED", "The AI provider rate-limited the model list request.");
  if (status === 408 || status === 504) return discoveryError("MODEL_LIST_TIMEOUT", "The AI provider took too long to list models.");
  return discoveryError("MODEL_LIST_HTTP_ERROR", `The AI provider returned HTTP ${status} while listing models.`);
}

export class ModelCatalogService {
  /**
   * All collaborators are injectable so tests never touch the network, the real clock or real environment secrets.
   */
  constructor({
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    getApiKey = getGeminiApiKey,
    getDefaultModel = getConfiguredDefaultModel,
    ttlMs = CACHE_TTL_MS,
    minIntervalMs = MIN_UPSTREAM_INTERVAL_MS,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxPages = MAX_PAGES,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.getApiKey = getApiKey;
    this.getDefaultModel = getDefaultModel;
    this.ttlMs = ttlMs;
    this.minIntervalMs = minIntervalMs;
    this.timeoutMs = timeoutMs;
    this.maxPages = maxPages;

    this.cache = null; // { models, fetchedAt }  (last SUCCESSFUL fetch only)
    this.lastAttemptAt = null;
    this.lastError = null; // { code, message } of the most recent failed attempt (cleared on success)
    this.inflight = null;
  }

  /** Primes the cache as if a fetch had just succeeded. Used by tests and optional warm-up; models are filtered like a real fetch. */
  seed(rawModels, { fetchedAt = this.now() } = {}) {
    this.cache = { models: this.#filterAndNormalize(rawModels).models, fetchedAt };
    this.lastAttemptAt = fetchedAt;
    this.lastError = null;
  }

  /** Test helper: forget everything. */
  reset() {
    this.cache = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.inflight = null;
  }

  // ---- public API ---------------------------------------------------------------------------------------------------

  /**
   * @param {{ forceRefresh?: boolean }} options
   * @returns {Promise<{ models: object[], sourceUpdatedAt: string, stale: boolean, refreshError?: object, defaultModelId: string|null }>}
   * @throws MODEL_LIST_UNAVAILABLE (503) when no list has ever been fetched successfully and the fetch failed.
   */
  async getCatalog({ forceRefresh = false } = {}) {
    if (this.#shouldFetch(forceRefresh)) {
      await this.#refresh();
    }
    if (!this.cache) {
      throw this.#unavailableError();
    }
    return this.#snapshot();
  }

  /**
   * Validates a request-scoped model id against the current compatible-model list and returns the canonical id.
   *  - requested id present & listed            -> that id
   *  - requested id present & not listed/invalid -> 400 MODEL_NOT_AVAILABLE
   *  - nothing requested                         -> the configured default, but ONLY if the list verifies it;
   *                                                 otherwise 400 MODEL_NOT_SELECTED
   * Never falls back to a different model and never trusts an unverified id.
   */
  async resolveModel(requested) {
    const catalog = await this.getCatalog();
    const listed = new Set(catalog.models.map((m) => m.id));

    const hasRequest = requested !== undefined && requested !== null && String(requested).trim() !== "";
    if (hasRequest) {
      const id = normalizeModelId(requested);
      if (id && listed.has(id)) return id;
      throw createAppError(
        "MODEL_NOT_AVAILABLE",
        "The selected AI model is not available or not supported. Choose another model from the list.",
        400
      );
    }

    const fallback = normalizeModelId(this.getDefaultModel());
    if (fallback && listed.has(fallback)) return fallback;
    throw createAppError(
      "MODEL_NOT_SELECTED",
      "No AI model is selected, and the server's default model is not currently available. Select a model and try again.",
      400
    );
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  #shouldFetch(forceRefresh) {
    if (this.inflight) return true; // join the running fetch
    const now = this.now();
    if (this.lastAttemptAt !== null && now - this.lastAttemptAt < this.minIntervalMs) return false; // throttle
    if (forceRefresh) return true;
    if (!this.cache) return true;
    return now - this.cache.fetchedAt >= this.ttlMs;
  }

  async #refresh() {
    if (!this.inflight) {
      // Resolve to undefined either way: failures are recorded in state, not thrown to every waiter.
      this.inflight = this.#fetchAll()
        .then((raw) => {
          const { models } = this.#filterAndNormalize(raw);
          this.cache = { models, fetchedAt: this.now() };
          this.lastError = null;
        })
        .catch((err) => {
          this.lastError = this.#sanitize(err);
          console.warn(`[SchemAI] Gemini model list refresh failed: code=${this.lastError.code} detail=${redact(err?.message)}`);
        })
        .finally(() => {
          this.lastAttemptAt = this.now();
          this.inflight = null;
        });
    }
    await this.inflight;
  }

  #sanitize(err) {
    if (err?.discoveryCode) return { code: err.discoveryCode, message: err.discoveryMessage };
    if (err?.code === "MISSING_API_KEY") return { code: "MISSING_API_KEY", message: err.message };
    return { code: "MODEL_LIST_NETWORK_ERROR", message: "Could not reach the AI provider to list models." };
  }

  #unavailableError() {
    const e = this.lastError ?? { code: "MODEL_LIST_UNAVAILABLE", message: "The model list is not available." };
    // A missing key is a server configuration problem, surface it exactly like generation does.
    if (e.code === "MISSING_API_KEY") return createAppError("MISSING_API_KEY", e.message, 503);
    return createAppError(
      "MODEL_LIST_UNAVAILABLE",
      `The list of available AI models could not be loaded (${e.message}) Try refreshing the model list.`,
      503,
      { details: [e.code] }
    );
  }

  #snapshot() {
    const { models, fetchedAt } = this.cache;
    const defaultId = normalizeModelId(this.getDefaultModel());
    const out = {
      models,
      // Only a default that the (last successful) list verifies is ever exposed; otherwise null.
      defaultModelId: defaultId && models.some((m) => m.id === defaultId) ? defaultId : null,
      sourceUpdatedAt: new Date(fetchedAt).toISOString(),
      stale: this.lastError !== null,
    };
    if (this.lastError) out.refreshError = { ...this.lastError };
    return out;
  }

  /** Fetches every page. Throws sanitised discovery errors only. */
  async #fetchAll() {
    const apiKey = this.getApiKey(); // throws MISSING_API_KEY (no network call is made)
    const collected = [];
    let pageToken = "";
    for (let page = 0; page < this.maxPages; page++) {
      const body = await this.#fetchPage(apiKey, pageToken);
      if (Array.isArray(body.models)) collected.push(...body.models);
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
      if (!pageToken) return collected;
    }
    // Safety limit reached: the list may be incomplete. Fail rather than cache a partial list as if complete.
    throw discoveryError("MODEL_LIST_TOO_MANY_PAGES", "The AI provider returned more model pages than expected.");
  }

  async #fetchPage(apiKey, pageToken) {
    const url = new URL(MODELS_ENDPOINT);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    let response;
    try {
      // `url.href` contains the key: it is passed to fetch only and never logged or put into an error.
      response = await this.fetchImpl(url.href, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw discoveryError("MODEL_LIST_TIMEOUT", "The AI provider took too long to list models.");
      }
      throw discoveryError("MODEL_LIST_NETWORK_ERROR", "Could not reach the AI provider to list models.");
    }

    if (!response || typeof response.status !== "number") {
      throw discoveryError("MODEL_LIST_MALFORMED", "The AI provider returned an unreadable model list.");
    }
    if (!response.ok) throw statusToDiscoveryError(response.status);

    let body;
    try {
      body = await response.json();
    } catch {
      throw discoveryError("MODEL_LIST_MALFORMED", "The AI provider returned an unreadable model list.");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw discoveryError("MODEL_LIST_MALFORMED", "The AI provider returned an unreadable model list.");
    }
    if (body.models !== undefined && !Array.isArray(body.models)) {
      throw discoveryError("MODEL_LIST_MALFORMED", "The AI provider returned an unreadable model list.");
    }
    return body;
  }

  /**
   * Applies the compatibility rules and normalises. A result with zero usable models is treated as a failure so an
   * empty/garbled response can never replace a previously good list.
   */
  #filterAndNormalize(rawModels) {
    if (!Array.isArray(rawModels) || rawModels.length === 0) {
      throw discoveryError("MODEL_LIST_EMPTY", "The AI provider returned no models.");
    }
    const byId = new Map();
    for (const raw of rawModels) {
      if (raw === null || typeof raw !== "object") continue;
      if (!evaluateCompatibility(raw).compatible) continue;
      const model = toPublicModel(raw);
      if (!byId.has(model.id)) byId.set(model.id, model);
    }
    if (byId.size === 0) {
      throw discoveryError("MODEL_LIST_EMPTY", "The AI provider returned no models that SchemAI can use.");
    }
    return { models: [...byId.values()].sort(compareModels) };
  }
}

export const modelCatalogService = new ModelCatalogService();
