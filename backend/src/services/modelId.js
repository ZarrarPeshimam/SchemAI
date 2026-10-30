/**
 * Canonical Gemini model identifiers.
 *
 * Google's REST API reports models as resource names ("models/<id>"); the @google/genai SDK and LangChain accept the
 * bare id ("<id>"). The ONLY transformation SchemAI applies is stripping a leading "models/" prefix. Ids are never
 * guessed, lower-cased or otherwise rewritten, and anything that is not a plain id after stripping is rejected.
 */

/** A plain model id: letters, digits, dot, underscore, hyphen. No slashes, whitespace, quotes or colons. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Returns the canonical id for a provider resource name or an id, or null when it is not a valid id. */
export function normalizeModelId(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const id = trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
  return MODEL_ID_PATTERN.test(id) ? id : null;
}
