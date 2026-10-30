import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Cpu, RefreshCw } from 'lucide-react';

/**
 * Compact "AI Model" selector for the bottom of the sidebar.
 * Listbox pattern: the trigger opens a popup list; ArrowUp/Down/Home/End move, Enter/Space select, Escape closes.
 * In the collapsed (icon-only) sidebar the trigger shows just the icon with a tooltip; the popup is the same.
 */
export default function ModelSelector({ selection }) {
  const {
    status,
    models,
    selectedModelId,
    selectionStatus,
    notice,
    stale,
    refreshError,
    loadError,
    isRefreshing,
    select,
    refresh,
    ensureFresh,
  } = selection;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const uid = useId();
  const listId = `${uid}-list`;

  const selected = models.find((m) => m.id === selectedModelId) || null;
  // A saved id that could not be verified (backend/list unavailable) is shown as-is, flagged as unverified.
  const label = selected?.displayName ?? (selectionStatus === 'unverified' ? selectedModelId : null);
  const triggerText = status === 'loading' && !label ? 'Loading models…' : label ?? (status === 'error' ? 'Models unavailable' : 'Select model');

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const openList = () => {
    ensureFresh();
    const idx = models.findIndex((m) => m.id === selectedModelId);
    setActiveIndex(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = (id) => {
    select(id);
    close();
  };

  const onListKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, models.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(models.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (models[activeIndex]) choose(models[activeIndex].id);
    }
  };

  const onTriggerKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openList();
    }
  };

  const statusLine = (() => {
    if (notice) return { tone: 'warn', text: notice };
    if (status === 'error' && !label) return { tone: 'error', text: loadError || 'Could not load the model list.' };
    if (selectionStatus === 'unverified') return { tone: 'warn', text: 'Saved model could not be verified right now.' };
    if (stale || refreshError) return { tone: 'muted', text: 'Could not refresh availability. Showing the last known list.' };
    if (status === 'ready' && !selected) return { tone: 'muted', text: 'Choose a model to generate or refine.' };
    return null;
  })();

  return (
    <div ref={rootRef} className="relative px-2 pb-3" data-testid="model-selector">
      <div className="px-2 mb-1 hidden md:flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-dark-500">AI Model</span>
        <button
          type="button"
          onClick={refresh}
          disabled={isRefreshing}
          aria-label="Refresh model list"
          title="Refresh model list"
          className="p-0.5 rounded text-dark-500 hover:text-dark-200 disabled:opacity-60 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <button
        ref={triggerRef}
        type="button"
        data-testid="model-selector-trigger"
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`AI model: ${triggerText}`}
        title={`AI model: ${triggerText}`}
        className={`w-full flex items-center justify-center md:justify-between gap-2 px-2.5 py-2 rounded-md border text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-brand-500 ${
          selected || label
            ? 'bg-dark-800 border-dark-700 text-dark-100 hover:bg-dark-750'
            : 'bg-dark-850 border-amber-700/40 text-amber-300 hover:bg-dark-800'
        }`}
      >
        <Cpu className="w-4 h-4 shrink-0 text-dark-400" />
        <span className="hidden md:block flex-1 min-w-0 truncate text-left">{triggerText}</span>
        <ChevronDown className={`hidden md:block w-3.5 h-3.5 shrink-0 text-dark-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {statusLine && (
        <p
          role="status"
          className={`hidden md:flex items-start gap-1 mt-1.5 px-1 text-[10px] leading-snug ${
            statusLine.tone === 'muted' ? 'text-dark-400' : statusLine.tone === 'error' ? 'text-rose-300' : 'text-amber-300'
          }`}
        >
          {statusLine.tone !== 'muted' && <AlertTriangle className="w-3 h-3 mt-px shrink-0" />}
          <span>{statusLine.text}</span>
        </p>
      )}
      {status === 'error' && !label && (
        <button
          type="button"
          onClick={refresh}
          className="hidden md:inline-flex mt-1 px-1 text-[10px] font-semibold text-brand-500 hover:text-brand-400"
        >
          Retry
        </button>
      )}

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label="Gemini models"
          aria-activedescendant={models[activeIndex] ? `${uid}-opt-${activeIndex}` : undefined}
          onKeyDown={onListKeyDown}
          className="absolute left-2 bottom-full mb-1 z-50 w-64 max-h-64 overflow-y-auto rounded-md border border-dark-700 bg-dark-800 py-1 shadow-lg focus:outline-none"
        >
          {models.length === 0 && (
            <li role="presentation" className="px-3 py-2 text-xs text-dark-400">
              {status === 'loading' ? 'Loading models…' : 'No models available.'}
            </li>
          )}
          {models.map((m, i) => {
            const isSelected = m.id === selectedModelId;
            return (
              <li
                key={m.id}
                id={`${uid}-opt-${i}`}
                role="option"
                aria-selected={isSelected}
                title={m.description || m.id}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(m.id)}
                className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer text-xs ${
                  i === activeIndex ? 'bg-dark-750 text-dark-50' : 'text-dark-200'
                }`}
              >
                <Check className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isSelected ? 'text-brand-500' : 'opacity-0'}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{m.displayName}</span>
                    {m.channel && m.channel !== 'stable' && (
                      <span className="shrink-0 rounded border border-dark-600 px-1 text-[9px] uppercase tracking-wide text-dark-300">
                        {m.channel === 'preview' ? 'Preview' : 'Experimental'}
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-dark-400">{m.id}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
