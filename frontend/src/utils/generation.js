// Pure helpers for the "Generate ERD" workflow (no React, easy to unit test).

/** Must match the backend limit in validators/schemaValidator.js (generateRequestSchema). */
export const MAX_REQUIREMENT_LENGTH = 4000;

/** Generation can involve one automatic repair call on the server, so allow generous headroom. */
export const GENERATION_TIMEOUT_MS = 150_000;

const MAX_DETAILS = 4;

/**
 * Convert a failed `api.generateSchema` result into `{ message, details }` for display.
 * Backend messages are already sanitised (no secrets / provider internals), so they are shown as-is.
 */
export function toGenerationError(res) {
  const error = res?.data?.error;

  if (error?.code === 'TIMEOUT') {
    return { message: error.message, details: [] };
  }

  if (error?.code === 'NETWORK_ERROR' || res?.status === 0) {
    return {
      message: 'Could not reach the SchemAI backend. Make sure it is running and try again.',
      details: [],
    };
  }

  const validationErrors = error?.validation?.errors;
  const details = Array.isArray(validationErrors)
    ? validationErrors.slice(0, MAX_DETAILS).map((e) => e.message)
    : [];
  if (Array.isArray(validationErrors) && validationErrors.length > MAX_DETAILS) {
    details.push(`…and ${validationErrors.length - MAX_DETAILS} more`);
  }

  return {
    message: error?.message || `Schema generation failed (HTTP ${res?.status ?? 'unknown'}).`,
    details,
  };
}

/** Validate the requirement text before calling the backend. Returns an error message or null. */
export function validateRequirementInput(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return 'Describe your database before generating.';
  if (trimmed.length > MAX_REQUIREMENT_LENGTH) {
    return `The description is too long (maximum ${MAX_REQUIREMENT_LENGTH} characters).`;
  }
  return null;
}
