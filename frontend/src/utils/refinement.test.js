import { describe, it, expect } from 'vitest';
import { MAX_INSTRUCTION_LENGTH, interpretRefineResponse, isVersionConflict, validateInstructionInput } from './refinement';

const schema = { entities: [], relationships: [] };
const ok = (data) => ({ status: 200, ok: true, data: { success: true, data } });

describe('validateInstructionInput', () => {
  it('rejects blank and over-long input, accepts normal input', () => {
    expect(validateInstructionInput('   ')).toMatch(/describe the change/i);
    expect(validateInstructionInput(undefined)).toMatch(/describe the change/i);
    expect(validateInstructionInput('x'.repeat(MAX_INSTRUCTION_LENGTH + 1))).toMatch(/too long/i);
    expect(validateInstructionInput('Add salary to Employee')).toBeNull();
  });
});

describe('interpretRefineResponse', () => {
  it('maps an applied response', () => {
    const out = interpretRefineResponse(ok({ status: 'applied', schema, validation: { valid: true }, summary: { message: 'm', changes: ['c'] }, repairAttempts: 1 }));
    expect(out).toMatchObject({ kind: 'applied', schema, message: 'm', changes: ['c'], repairAttempts: 1 });
  });

  it('does not treat an applied response without a schema as success', () => {
    expect(interpretRefineResponse(ok({ status: 'applied' })).kind).toBe('error');
    expect(interpretRefineResponse(ok({ status: 'applied', schema: { entities: [] } })).kind).toBe('error');
  });

  it('maps clarification responses', () => {
    expect(interpretRefineResponse(ok({ status: 'needs_clarification', message: 'Which one?' }))).toEqual({ kind: 'clarification', message: 'Which one?' });
  });

  it('maps backend errors with string and object details, truncating long lists', () => {
    const res = { status: 422, ok: false, data: { success: false, error: { code: 'REFINEMENT_FAILED', message: 'failed', details: ['a', { message: 'b' }, 'c', 'd', 'e', 'f'] } } };
    expect(interpretRefineResponse(res)).toEqual({ kind: 'error', message: 'failed', details: ['a', 'b', 'c', 'd', '…and 2 more'], code: 'REFINEMENT_FAILED' });
  });

  it('maps network failures and unknown shapes to friendly errors', () => {
    expect(interpretRefineResponse({ status: 0, ok: false, data: { error: { code: 'NETWORK_ERROR' } } }).message).toMatch(/could not reach/i);
    expect(interpretRefineResponse({ status: 500, ok: false, data: null }).message).toMatch(/HTTP 500/);
    expect(interpretRefineResponse(undefined).kind).toBe('error');
  });
});

describe('interpretRefineResponse: conversation fields', () => {
  it('carries the new schemaVersion / persisted flag of a saved conversation', () => {
    const out = interpretRefineResponse(ok({ status: 'applied', schema, schemaVersion: 4, persisted: true, summary: { message: 'm', changes: [] } }));
    expect(out).toMatchObject({ kind: 'applied', schemaVersion: 4, persisted: true });
  });

  it('reports no version for a stateless (unsaved) refinement', () => {
    const out = interpretRefineResponse(ok({ status: 'applied', schema, schemaVersion: null, persisted: false }));
    expect(out).toMatchObject({ schemaVersion: null, persisted: false });
  });

  it('recognises a version conflict so the dashboard can reload the conversation', () => {
    const res = { status: 409, ok: false, data: { success: false, error: { code: 'SCHEMA_VERSION_CONFLICT', message: 'changed' } } };
    expect(isVersionConflict(interpretRefineResponse(res))).toBe(true);
    expect(isVersionConflict(interpretRefineResponse({ status: 422, ok: false, data: { error: { code: 'REFINEMENT_FAILED' } } }))).toBe(false);
  });
});
