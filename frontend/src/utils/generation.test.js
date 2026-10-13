import { describe, it, expect } from 'vitest';
import { MAX_REQUIREMENT_LENGTH, toGenerationError, validateRequirementInput } from './generation';

describe('validateRequirementInput', () => {
  it('rejects blank / whitespace-only input', () => {
    expect(validateRequirementInput('')).toMatch(/describe your database/i);
    expect(validateRequirementInput('   \n ')).toMatch(/describe your database/i);
    expect(validateRequirementInput(undefined)).toMatch(/describe your database/i);
  });

  it('rejects input over the backend limit and accepts the limit itself', () => {
    expect(validateRequirementInput('x'.repeat(MAX_REQUIREMENT_LENGTH + 1))).toMatch(/too long/i);
    expect(validateRequirementInput('x'.repeat(MAX_REQUIREMENT_LENGTH))).toBeNull();
    expect(validateRequirementInput('A library with books')).toBeNull();
  });
});

describe('toGenerationError', () => {
  it('maps network failures to a friendly message', () => {
    const e = toGenerationError({ status: 0, ok: false, data: { error: { code: 'NETWORK_ERROR', message: 'Failed to fetch' } } });
    expect(e.message).toMatch(/could not reach the schemai backend/i);
    expect(e.message).not.toMatch(/failed to fetch/i);
  });

  it('maps client-side timeouts (status 0 but code TIMEOUT) to the timeout message, not the network one', () => {
    const e = toGenerationError({ status: 0, ok: false, data: { error: { code: 'TIMEOUT', message: 'The request timed out.' } } });
    expect(e.message).toBe('The request timed out.');
  });

  it('passes through sanitised backend messages (e.g. missing API key)', () => {
    const e = toGenerationError({ status: 503, ok: false, data: { success: false, error: { code: 'MISSING_API_KEY', message: 'AI generation is not configured on the server.' } } });
    expect(e.message).toBe('AI generation is not configured on the server.');
    expect(e.details).toEqual([]);
  });

  it('lists validation errors from a 422 as details (capped)', () => {
    const errors = Array.from({ length: 6 }, (_, i) => ({ code: 'X', message: `problem ${i + 1}` }));
    const e = toGenerationError({ status: 422, ok: false, data: { error: { code: 'SCHEMA_VALIDATION_FAILED', message: 'failed validation', validation: { errors } } } });
    expect(e.message).toBe('failed validation');
    expect(e.details.slice(0, 4)).toEqual(['problem 1', 'problem 2', 'problem 3', 'problem 4']);
    expect(e.details[4]).toMatch(/2 more/);
  });

  it('falls back to a generic message with the HTTP status', () => {
    expect(toGenerationError({ status: 500, ok: false, data: {} }).message).toMatch(/HTTP 500/);
  });
});
