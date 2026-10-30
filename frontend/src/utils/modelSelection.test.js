import { describe, it, expect, beforeEach } from 'vitest';
import {
  MODEL_STORAGE_KEY,
  SAVED_MODEL_UNAVAILABLE_MESSAGE,
  clearStoredModelId,
  isValidModelId,
  readStoredModelId,
  resolveSelection,
  writeStoredModelId,
} from './modelSelection';

const catalog = (ids, extra = {}) => ({ models: ids.map((id) => ({ id })), defaultModelId: null, stale: false, ...extra });

describe('localStorage preference', () => {
  beforeEach(() => window.localStorage.clear());

  it('uses the documented key and stores only the canonical id', () => {
    expect(MODEL_STORAGE_KEY).toBe('schemai:selectedGeminiModel');
    expect(writeStoredModelId('gemini-x-flash')).toBe(true);
    expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe('gemini-x-flash');
    expect(readStoredModelId()).toBe('gemini-x-flash');
  });

  it('rejects invalid ids on write and discards invalid stored values on read', () => {
    for (const bad of ['', 'models/x', 'a b', '../x', null, 42, { id: 'x' }]) expect(writeStoredModelId(bad)).toBe(false);
    expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
    window.localStorage.setItem(MODEL_STORAGE_KEY, '{"id":"x"}');
    expect(readStoredModelId()).toBeNull();
    expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
  });

  it('survives unavailable storage', () => {
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    expect(readStoredModelId(broken)).toBeNull();
    expect(writeStoredModelId('gemini-x', broken)).toBe(false);
    expect(() => clearStoredModelId(broken)).not.toThrow();
    expect(isValidModelId('gemini-x')).toBe(true);
  });
});

describe('resolveSelection', () => {
  it('first time: uses the verified default and asks to persist it', () => {
    expect(resolveSelection({ storedId: null, catalog: catalog(['a', 'b'], { defaultModelId: 'b' }) })).toEqual({ selectedId: 'b', status: 'default', notice: null, persist: 'write' });
  });

  it('first time without a verified default: no selection, nothing persisted', () => {
    expect(resolveSelection({ storedId: null, catalog: catalog(['a']) })).toMatchObject({ selectedId: null, status: 'none', persist: 'keep' });
    // A default that is not in the list is never trusted.
    expect(resolveSelection({ storedId: null, catalog: catalog(['a'], { defaultModelId: 'zzz' }) })).toMatchObject({ selectedId: null, status: 'none' });
  });

  it('returning user: restores a saved model that is listed', () => {
    expect(resolveSelection({ storedId: 'a', catalog: catalog(['a', 'b'], { defaultModelId: 'b' }) })).toMatchObject({ selectedId: 'a', status: 'restored' });
  });

  it('returning user: a missing saved model is cleared with a message and NOT replaced by the default', () => {
    const r = resolveSelection({ storedId: 'old', catalog: catalog(['a', 'b'], { defaultModelId: 'b' }) });
    expect(r).toEqual({ selectedId: null, status: 'saved-unavailable', notice: SAVED_MODEL_UNAVAILABLE_MESSAGE, persist: 'clear' });
  });

  it('returning user: with a stale list the saved value is kept', () => {
    expect(resolveSelection({ storedId: 'old', catalog: catalog(['a'], { stale: true }) })).toMatchObject({ selectedId: null, persist: 'keep' });
  });

  it('list unavailable: saved id stays as unverified, otherwise unavailable', () => {
    expect(resolveSelection({ storedId: 'a', catalog: null })).toEqual({ selectedId: 'a', status: 'unverified', notice: null, persist: 'keep' });
    expect(resolveSelection({ storedId: null, catalog: null })).toMatchObject({ selectedId: null, status: 'unavailable' });
  });
});
