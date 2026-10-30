// Pure helpers for the Gemini model preference (no React, easy to unit test).

/** localStorage key. The value is ONLY a canonical model id (e.g. "gemini-x-flash"), never a name, index or list. */
export const MODEL_STORAGE_KEY = 'schemai:selectedGeminiModel';

export const SAVED_MODEL_UNAVAILABLE_MESSAGE = 'Your saved model is no longer available. Please select another model.';

/** Same shape the backend accepts (services/modelId.js): plain id, no "models/" prefix, no slashes/whitespace. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const isValidModelId = (value) => typeof value === 'string' && MODEL_ID_PATTERN.test(value);

const getStorage = (storage) => {
  if (storage) return storage;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // storage access can throw (privacy mode / blocked cookies)
  }
};

/** Returns the saved canonical id, or null (nothing saved, unreadable, or an invalid value which is also discarded). */
export function readStoredModelId(storage) {
  const store = getStorage(storage);
  if (!store) return null;
  try {
    const raw = store.getItem(MODEL_STORAGE_KEY);
    if (raw === null) return null;
    if (isValidModelId(raw)) return raw;
    store.removeItem(MODEL_STORAGE_KEY); // garbage (old format, tampering): treat as "no preference"
  } catch {
    /* ignore */
  }
  return null;
}

export function writeStoredModelId(id, storage) {
  const store = getStorage(storage);
  if (!store || !isValidModelId(id)) return false;
  try {
    store.setItem(MODEL_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

export function clearStoredModelId(storage) {
  const store = getStorage(storage);
  try {
    store?.removeItem(MODEL_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Decide the active selection from the saved preference and the latest backend answer.
 *
 * @param {object} args
 * @param {string|null} args.storedId  saved canonical id (or null)
 * @param {{models: {id: string}[], defaultModelId?: string|null, stale?: boolean}|null} args.catalog
 *        latest `GET /api/models` data, or null when the list could not be loaded at all
 * @returns {{ selectedId: string|null, status: string, notice: string|null, persist: 'write'|'clear'|'keep' }}
 *   status: 'restored' | 'default' | 'none' | 'saved-unavailable' | 'unverified' | 'unavailable'
 *
 * Rules: never silently switch to a different model; a saved id is only restored if the list contains it; when the list
 * could not be loaded a saved id is kept as UNVERIFIED (the backend still validates every request); the configured
 * default is used for first-time users only when the backend reports it as verified.
 */
export function resolveSelection({ storedId, catalog }) {
  if (!catalog || !Array.isArray(catalog.models)) {
    return storedId
      ? { selectedId: storedId, status: 'unverified', notice: null, persist: 'keep' }
      : { selectedId: null, status: 'unavailable', notice: null, persist: 'keep' };
  }

  const ids = new Set(catalog.models.map((m) => m.id));

  if (storedId) {
    if (ids.has(storedId)) return { selectedId: storedId, status: 'restored', notice: null, persist: 'keep' };
    return {
      selectedId: null,
      status: 'saved-unavailable',
      notice: SAVED_MODEL_UNAVAILABLE_MESSAGE,
      // A stale list is not proof the model is gone for good: keep the saved value in that case.
      persist: catalog.stale ? 'keep' : 'clear',
    };
  }

  if (catalog.defaultModelId && ids.has(catalog.defaultModelId)) {
    return { selectedId: catalog.defaultModelId, status: 'default', notice: null, persist: 'write' };
  }
  return { selectedId: null, status: 'none', notice: null, persist: 'keep' };
}
