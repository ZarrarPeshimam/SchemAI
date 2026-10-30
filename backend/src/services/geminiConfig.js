import { createAppError } from "./appError.js";

/**
 * Default model. NOTE: `gemini-2.5-flash` is scheduled for shutdown on the Gemini Developer API
 * (October 16, 2026), so it is intentionally NOT the default. Override with GEMINI_MODEL.
 *
 * This is only the *configured default*. It is never used for a request unless the current model list verifies that
 * the provider reports it and it passes SchemAI's compatibility rules (see modelCatalogService.resolveModel).
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** The server-side configured default model id (GEMINI_MODEL, else the built-in default). */
export function getConfiguredDefaultModel() {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/** Returns the configured API key or throws a typed 503 MISSING_API_KEY. Server-side only. */
export function getGeminiApiKey() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey === "your_gemini_api_key_here") {
    throw createAppError(
      "MISSING_API_KEY",
      "AI generation is not configured on the server. Set GEMINI_API_KEY in backend/.env and restart the backend.",
      503
    );
  }
  return apiKey.trim();
}

/**
 * Guard for service-level callers: every Gemini operation needs an explicit, already-validated model id. There is no
 * implicit fallback here, so no operation can silently use a different (e.g. hardcoded) model.
 */
export function requireModelId(model) {
  if (typeof model !== "string" || model.trim() === "") {
    throw createAppError("MODEL_NOT_SELECTED", "No AI model was specified for this request.", 400);
  }
  return model.trim();
}
