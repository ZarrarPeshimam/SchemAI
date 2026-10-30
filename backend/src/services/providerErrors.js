import { createAppError, redact } from "./appError.js";

/** HTTP status of a provider/SDK/LangChain error, or NaN. LangChain sometimes only puts it in the message ("[503 Service Unavailable]"). */
export function getProviderStatus(err) {
  const direct = Number(err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.code);
  // Only real HTTP statuses count: e.g. the legacy DOMException code 23 of an AbortSignal.timeout() TimeoutError is not one.
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  const m = String(err?.message ?? "").match(/\[(\d{3})\b/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Maps any provider/SDK failure to a safe, typed API error. Provider details are logged (redacted), never returned.
 *
 * Codes (frontend can distinguish):
 *   LLM_TIMEOUT, RATE_LIMIT_EXCEEDED, LLM_AUTH_ERROR, MODEL_UNAVAILABLE (404), MODEL_TEMPORARILY_UNAVAILABLE (503),
 *   MODEL_INCOMPATIBLE (model rejects a feature SchemAI needs), LLM_SCHEMA_REJECTED (provider rejected the request's
 *   response schema), LLM_PROVIDER_ERROR (anything else).
 */
export function mapProviderError(err) {
  if (err?.expose) return err;

  const status = getProviderStatus(err);
  const name = err?.name || "";
  const message = String(err?.message || "");
  console.error(`[SchemAI] Gemini request failed: name=${name} status=${Number.isFinite(status) ? status : "n/a"} message=${redact(message)}`);

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    status === 408 ||
    status === 504 ||
    /timed? ?out|timeout|deadline exceeded|ETIMEDOUT/i.test(message)
  ) {
    return createAppError("LLM_TIMEOUT", "The AI service took too long to respond. Please try again.", 504);
  }
  if (status === 429) {
    return createAppError(
      "RATE_LIMIT_EXCEEDED",
      "The AI service is rate-limited or over quota right now. Please wait a moment and try again, or select another model.",
      429
    );
  }
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(message))) {
    return createAppError(
      "LLM_AUTH_ERROR",
      "The AI provider rejected the server's credentials or permissions. Check GEMINI_API_KEY in backend/.env.",
      503
    );
  }
  if (status === 400 && /developer instruction|system instruction|json mode|response mime|not (enabled|supported) for|does not support/i.test(message)) {
    return createAppError(
      "MODEL_INCOMPATIBLE",
      "The selected AI model does not support a feature SchemAI needs (such as structured JSON output). Select another model.",
      422
    );
  }
  if (status === 400 && /schema|function_declarations|function declaration|responseJsonSchema|response_schema/i.test(message)) {
    return createAppError(
      "LLM_SCHEMA_REJECTED",
      "The AI provider rejected the structured-output schema for this request. Try another model or report this issue.",
      502
    );
  }
  if (status === 404) {
    return createAppError(
      "MODEL_UNAVAILABLE",
      "The selected AI model is unavailable (it may have been retired). Select another model.",
      503
    );
  }
  if (status === 503) {
    return createAppError(
      "MODEL_TEMPORARILY_UNAVAILABLE",
      "The selected AI model is temporarily unavailable (high demand). Your schema was not changed. Retry in a moment or select another model.",
      503
    );
  }
  return createAppError("LLM_PROVIDER_ERROR", "The AI provider returned an error. Please try again.", 502);
}
