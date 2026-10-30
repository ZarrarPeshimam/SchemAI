import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import {
  clearStoredModelId,
  readStoredModelId,
  resolveSelection,
  writeStoredModelId,
} from '../utils/modelSelection';

/** Re-ask the backend when the user opens the selector and the list is older than this (the backend has its own cache). */
const CLIENT_REFRESH_AFTER_MS = 5 * 60 * 1000;

/**
 * Model list + selected model for the sidebar selector and for every model-backed request.
 *
 *  - The list comes from SchemAI's `GET /api/models` (never from Google directly).
 *  - The preference lives in localStorage as a canonical id and is resolved against the latest list.
 *  - `selectedModelId` is a plain value: callers capture it when they START a request, so a later change in the
 *    dropdown cannot alter a request that is already in flight.
 */
export function useModelSelection() {
  const [state, setState] = useState({
    status: 'loading', // 'loading' | 'ready' | 'error'
    models: [],
    selectedModelId: null,
    selectionStatus: 'none',
    notice: null,
    stale: false,
    refreshError: null,
    loadError: null,
    sourceUpdatedAt: null,
    isRefreshing: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state; // latest committed state, readable from callbacks without side effects in updaters
  const selectedRef = useRef(null);
  const fetchedAtRef = useRef(0);
  const seq = useRef(0);

  const load = useCallback(async ({ refresh = false } = {}) => {
    const mySeq = ++seq.current;
    setState((s) => ({ ...s, isRefreshing: true, status: s.models.length ? s.status : 'loading' }));

    let res;
    try {
      res = await api.getModels({ refresh });
    } catch {
      res = null;
    }
    if (mySeq !== seq.current) return; // a newer load superseded this one

    const data = res?.ok && res?.data?.success && Array.isArray(res.data.data?.models) ? res.data.data : null;
    const storedId = selectedRef.current ?? readStoredModelId();

    if (!data) {
      const message = res?.data?.error?.message || 'Could not load the model list.';
      const current = stateRef.current;
      if (current.models.length) {
        // Keep showing a previously loaded list (backend unreachable now) but flag that it could not be refreshed.
        setState((s) => ({ ...s, isRefreshing: false, stale: true, refreshError: { message } }));
        return;
      }
      const decision = resolveSelection({ storedId, catalog: null });
      selectedRef.current = decision.selectedId;
      setState((s) => ({
        ...s,
        status: 'error',
        isRefreshing: false,
        loadError: message,
        selectedModelId: decision.selectedId,
        selectionStatus: decision.status,
        notice: decision.notice,
      }));
      return;
    }

    fetchedAtRef.current = Date.now();
    const decision = resolveSelection({ storedId, catalog: data });
    if (decision.persist === 'write') writeStoredModelId(decision.selectedId);
    if (decision.persist === 'clear') clearStoredModelId();
    selectedRef.current = decision.selectedId;

    setState({
      status: 'ready',
      models: data.models,
      selectedModelId: decision.selectedId,
      selectionStatus: decision.status,
      notice: decision.notice,
      stale: !!data.stale,
      refreshError: data.refreshError ?? null,
      loadError: null,
      sourceUpdatedAt: data.sourceUpdatedAt ?? null,
      isRefreshing: false,
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Select a model from the CURRENT list only; persists the canonical id. */
  const select = useCallback((id) => {
    if (!stateRef.current.models.some((m) => m.id === id)) return;
    writeStoredModelId(id);
    selectedRef.current = id;
    setState((s) => ({ ...s, selectedModelId: id, selectionStatus: 'selected', notice: null }));
  }, []);

  /** Called when the selector opens: refresh only if the list is stale, failed to load, or old. */
  const ensureFresh = useCallback(() => {
    const s = stateRef.current;
    const old = Date.now() - fetchedAtRef.current > CLIENT_REFRESH_AFTER_MS;
    if (!s.isRefreshing && (s.status === 'error' || s.stale || old)) load();
  }, [load]);

  const refresh = useCallback(() => load({ refresh: true }), [load]);

  return { ...state, select, refresh, ensureFresh, reload: load };
}
