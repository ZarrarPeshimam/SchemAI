import { normalizeModelId } from "./modelId.js";

/**
 * Model compatibility rules for SchemAI. ALL model-eligibility decisions live in this file so they are easy to find,
 * review and update when Google changes its lineup.
 *
 * What the provider metadata can establish reliably (GET /v1beta/models -> `supportedGenerationMethods`):
 *   - whether a model supports `generateContent` (required by every SchemAI operation).
 *
 * What the provider metadata does NOT establish:
 *   - whether a `generateContent` model accepts a JSON `responseJsonSchema` (structured output), a system
 *     instruction, or tool/function declarations (used by LangChain's `withStructuredOutput`).
 *   - what a model OUTPUTS (text vs. image vs. audio). Some image/audio-output models still list `generateContent`.
 *   - capacity, quota or billing eligibility.
 * Therefore every accepted model is reported with `structuredOutput: "unverified"`. SchemAI never claims a model is
 * guaranteed to work; the provider can still reject a request and the backend handles that (see providerErrors.js).
 *
 * The id-based exclusions below are heuristics derived from Google's naming conventions (verify against current
 * documentation when the lineup changes). They only REMOVE models that clearly are not text-generation models, or that
 * are known to reject features SchemAI always sends; they never add a model the provider did not list.
 */

/** Generation method every SchemAI operation needs. */
export const REQUIRED_GENERATION_METHOD = "generateContent";

/**
 * Id fragments of non-text-output or otherwise unsuitable models. Matched against the canonical id.
 * Each entry documents WHY it is excluded.
 */
export const EXCLUDED_ID_PATTERNS = [
  { pattern: /embedding|(^|-)embed(-|$)/i, reason: "embedding model" },
  { pattern: /imagen|(^|-)image(-|$)|image-generation/i, reason: "image-generation model" },
  { pattern: /(^|-)veo(-|$)/i, reason: "video-generation model" },
  { pattern: /(^|-)tts(-|$)|text-to-speech/i, reason: "speech-generation model" },
  { pattern: /native-audio|(^|-)audio(-|$)|(^|-)live(-|$)/i, reason: "audio / realtime (Live API) model" },
  { pattern: /(^|-)aqa$/i, reason: "attributed-question-answering model" },
  { pattern: /robotics|computer-use/i, reason: "specialised agent model (not a plain text generator)" },
  { pattern: /^gemma/i, reason: "Gemma models reject system instructions / JSON mode on the Gemini API" },
];

/** @returns {{ compatible: boolean, reason?: string }} */
export function evaluateCompatibility(rawModel) {
  const id = normalizeModelId(rawModel?.name ?? rawModel?.baseModelId);
  if (!id) return { compatible: false, reason: "missing or invalid model name" };

  const methods = Array.isArray(rawModel.supportedGenerationMethods) ? rawModel.supportedGenerationMethods : [];
  if (!methods.includes(REQUIRED_GENERATION_METHOD)) {
    return { compatible: false, reason: `does not support ${REQUIRED_GENERATION_METHOD}` };
  }
  for (const { pattern, reason } of EXCLUDED_ID_PATTERNS) {
    if (pattern.test(id)) return { compatible: false, reason };
  }
  return { compatible: true };
}

/**
 * Release channel, derived from the id (the API has no explicit field). "preview" / "experimental" models can change or
 * disappear without notice. This is shown as a hint only and never used to include or exclude a model.
 */
export function deriveChannel(id) {
  if (/(^|-)exp(-|$|erimental)/i.test(id)) return "experimental";
  if (/preview/i.test(id)) return "preview";
  return "stable";
}

const CHANNEL_RANK = { stable: 0, preview: 1, experimental: 2 };

/** Frontend-safe representation of one model. Deliberately an allow-list: no raw provider fields leak through. */
export function toPublicModel(rawModel) {
  const id = normalizeModelId(rawModel.name ?? rawModel.baseModelId);
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const num = (v) => (Number.isInteger(v) && v > 0 ? v : undefined);
  const model = {
    id,
    displayName: str(rawModel.displayName, 100) ?? id,
    description: str(rawModel.description, 400),
    version: str(rawModel.version, 40),
    channel: deriveChannel(id),
    inputTokenLimit: num(rawModel.inputTokenLimit),
    outputTokenLimit: num(rawModel.outputTokenLimit),
    capabilities: { generateContent: true, structuredOutput: "unverified" },
  };
  return Object.fromEntries(Object.entries(model).filter(([, v]) => v !== undefined));
}

/** Stable-first, then natural (numeric-aware) display-name order. */
export function compareModels(a, b) {
  const byChannel = CHANNEL_RANK[a.channel] - CHANNEL_RANK[b.channel];
  if (byChannel !== 0) return byChannel;
  return a.displayName.localeCompare(b.displayName, "en", { numeric: true, sensitivity: "base" });
}
