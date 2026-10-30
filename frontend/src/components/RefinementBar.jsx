import React, { useState } from 'react';
import { RefreshCw, Wand2, Loader2, AlertCircle, HelpCircle, CheckCircle2 } from 'lucide-react';
import { MAX_INSTRUCTION_LENGTH } from '../utils/refinement';

/**
 * Natural-language refinement input shown under the ER diagram.
 * `onRefine(text)` must resolve to `true` when the change was accepted (the input is then cleared) and `false`
 * otherwise (the text is kept so the user can edit and retry). The diagram itself is only updated by the parent
 * after the backend has validated the change.
 */
export default function RefinementBar({ onRefine, isRefining = false, result = null, disabled = false }) {
  const [text, setText] = useState('');
  const tooLong = text.trim().length > MAX_INSTRUCTION_LENGTH;
  const canSubmit = !!text.trim() && !tooLong && !isRefining && !disabled;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit || !onRefine) return;
    const accepted = await onRefine(text);
    if (accepted) setText('');
  };

  return (
    <div className="bg-dark-900 border border-dark-750 rounded-lg p-3 shadow-sm space-y-2.5" data-testid="refinement-bar">
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        {/* Title and Icon */}
        <div className="flex items-center space-x-2 shrink-0 select-none">
          <Wand2 aria-hidden="true" className="w-4 h-4 text-brand-500" />
          <span className="text-xs font-semibold uppercase tracking-wider text-dark-100">Refine your schema</span>
        </div>

        {/* Input Bar */}
        <div className="relative flex-1">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isRefining}
            aria-label="Refinement instruction"
            placeholder="e.g. Add a salary attribute of type DECIMAL to Employee..."
            className="w-full px-3.5 py-2 text-xs font-mono bg-dark-950 border border-dark-700 rounded-md text-dark-100 placeholder-dark-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors disabled:opacity-60"
          />
        </div>

        {/* Update Schema Button */}
        <button
          type="submit"
          disabled={!canSubmit}
          aria-label={isRefining ? 'Updating schema' : 'Update schema'}
          className="px-4 py-2 bg-dark-800 hover:bg-dark-750 active:bg-dark-700 text-brand-500 border border-brand-500/40 hover:border-brand-500 rounded-md text-xs font-medium flex items-center justify-center space-x-1.5 transition-all shrink-0 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRefining ? (
            <Loader2 aria-hidden="true" className="w-3.5 h-3.5 text-brand-500 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="w-3.5 h-3.5 text-brand-500" />
          )}
          <span>{isRefining ? 'Updating…' : 'Update Schema'}</span>
        </button>
      </form>

      {tooLong && (
        <p className="text-[10px] text-rose-300">
          {text.trim().length} / {MAX_INSTRUCTION_LENGTH} characters — please shorten the instruction.
        </p>
      )}

      {isRefining && (
        <p className="text-[10px] text-dark-400" data-testid="refinement-progress">
          Interpreting your instruction and validating the result… this can take up to a minute.
        </p>
      )}

      {!isRefining && result?.kind === 'error' && (
        <div role="alert" data-testid="refinement-error" className="bg-rose-950/30 border border-rose-900/50 rounded-md p-2.5 flex items-start space-x-2.5">
          <AlertCircle aria-hidden="true" className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-rose-300 leading-snug">{result.message}</p>
            {result.details?.length > 0 && (
              <ul className="list-disc pl-4 text-[10px] text-dark-300 space-y-0.5">
                {result.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-dark-400">The diagram was not changed.</p>
          </div>
        </div>
      )}

      {!isRefining && result?.kind === 'clarification' && (
        <div role="alert" data-testid="refinement-clarification" className="bg-amber-950/20 border border-amber-800/50 rounded-md p-2.5 flex items-start space-x-2.5">
          <HelpCircle aria-hidden="true" className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-amber-200 leading-snug">{result.message}</p>
            <p className="text-[10px] text-dark-400">Nothing was changed. Reply by editing your instruction above.</p>
          </div>
        </div>
      )}

      {!isRefining && result?.kind === 'applied' && (
        <div role="status" data-testid="refinement-summary" className="bg-emerald-950/20 border border-emerald-900/40 rounded-md p-2.5 flex items-start space-x-2.5">
          <CheckCircle2 aria-hidden="true" className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <p className="text-[11px] font-medium text-dark-100 leading-snug">
              {result.message || 'Schema updated.'}
              {result.repairAttempts > 0 && <span className="text-dark-400"> (after {result.repairAttempts} automatic correction{result.repairAttempts > 1 ? 's' : ''})</span>}
            </p>
            {result.changes?.length > 0 && (
              <ul className="list-disc pl-4 text-[10px] text-dark-300 space-y-0.5">
                {result.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
