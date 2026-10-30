// Pure helpers for the natural-language "Refine your schema" workflow (no React, easy to unit test).

/** Must match the backend limit in validators/schemaValidator.js (refineRequestSchema). */
export const MAX_INSTRUCTION_LENGTH = 1000;

const MAX_DETAILS = 4;

/** Validate the instruction before calling the backend. Returns an error message or null. */
export function validateInstructionInput(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return 'Describe the change you want to make.';
  if (trimmed.length > MAX_INSTRUCTION_LENGTH) {
    return `The instruction is too long (maximum ${MAX_INSTRUCTION_LENGTH} characters).`;
  }
  return null;
}

/**
 * Convert an `api.refineSchema` response into one of:
 *   { kind: 'applied', schema, schemaVersion, persisted, validation, message, changes, repairAttempts }
 *   { kind: 'clarification', message }
 *   { kind: 'error', message, details, code }
 * Backend messages are already sanitised (no secrets / provider internals), so they are shown as-is.
 * A response only counts as 'applied' if it carries a schema; nothing else may update the diagram.
 */
export function interpretRefineResponse(res) {
  const data = res?.ok && res?.data?.success ? res.data.data : null;

  if (data?.status === 'applied' && data.schema?.entities && data.schema?.relationships) {
    return {
      kind: 'applied',
      schema: data.schema,
      validation: data.validation ?? null,
      message: data.summary?.message ?? '',
      changes: Array.isArray(data.summary?.changes) ? data.summary.changes : [],
      repairAttempts: data.repairAttempts ?? 0,
      // Version of the saved conversation after this change (null when nothing was persisted).
      schemaVersion: Number.isInteger(data.schemaVersion) ? data.schemaVersion : null,
      persisted: data.persisted === true,
    };
  }

  if (data?.status === 'needs_clarification') {
    return { kind: 'clarification', message: data.message || 'Could you clarify what you want to change?' };
  }

  const error = res?.data?.error;
  if (error?.code === 'NETWORK_ERROR' || res?.status === 0) {
    return { kind: 'error', code: 'NETWORK_ERROR', message: 'Could not reach the SchemAI backend. Make sure it is running and try again.', details: [] };
  }

  const raw = Array.isArray(error?.details) ? error.details : [];
  const details = raw.slice(0, MAX_DETAILS).map((d) => (typeof d === 'string' ? d : d?.message)).filter(Boolean);
  if (raw.length > MAX_DETAILS) details.push(`…and ${raw.length - MAX_DETAILS} more`);

  return {
    kind: 'error',
    message: error?.message || `Schema refinement failed (HTTP ${res?.status ?? 'unknown'}).`,
    details,
    code: error?.code ?? null,
  };
}

/** The saved conversation changed under us (another tab/request committed first): the client must reload it. */
export const isVersionConflict = (outcome) => outcome?.kind === 'error' && outcome.code === 'SCHEMA_VERSION_CONFLICT';
