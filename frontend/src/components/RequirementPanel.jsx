import React, { useState } from 'react';
import { Sparkles, Terminal, CheckCircle2, Loader2, AlertCircle } from 'lucide-react';
import { INITIAL_REQUIREMENT } from '../data/mockSchema';
import { MAX_REQUIREMENT_LENGTH } from '../utils/generation';

export default function RequirementPanel({ onGenerate, isGenerating = false, error = null, lastResult = null }) {
  const [prompt, setPrompt] = useState(INITIAL_REQUIREMENT);
  const tooLong = prompt.length > MAX_REQUIREMENT_LENGTH;
  const canGenerate = !isGenerating && prompt.trim().length > 0 && !tooLong;

  return (
    <div className="bg-dark-900 border border-dark-750 rounded-lg flex flex-col h-full shadow-sm overflow-hidden">
      {/* Panel Header */}
      <div className="px-4 py-3 border-b border-dark-750 flex items-center justify-between bg-dark-850/70">
        <div className="flex items-center space-x-2">
          <Terminal className="w-4 h-4 text-brand-500" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-dark-100">
            Describe your database
          </h2>
        </div>
        <span className="text-[10px] font-mono text-dark-400 bg-dark-800 px-2 py-0.5 rounded border border-dark-700">
          Natural Language
        </span>
      </div>

      {/* Main Content Area */}
      <div className="p-4 flex-1 flex flex-col justify-between space-y-4">
        <div className="flex-1 flex flex-col space-y-2">
          <label htmlFor="requirement-input" className="text-xs text-dark-300 font-medium">
            Natural Language Specification
          </label>
          <div className="relative flex-1">
            <textarea
              id="requirement-input"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              readOnly={isGenerating}
              aria-busy={isGenerating}
              rows={8}
              className="w-full h-full min-h-[140px] p-3 text-xs font-mono bg-dark-950 border border-dark-700 rounded-md text-dark-100 placeholder-dark-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 resize-none leading-relaxed transition-colors"
              placeholder="Describe your entities, fields, relationships, and constraints in plain English..."
            />
          </div>
          <div className="flex justify-between items-center text-[11px] text-dark-400 pt-1">
            <span>Natural language requirements input</span>
            <span className={tooLong ? 'text-rose-400' : ''}>
              {prompt.length} / {MAX_REQUIREMENT_LENGTH} chars
            </span>
          </div>
        </div>

        {/* Action Button & Status Info */}
        <div className="flex flex-col space-y-3 pt-2">
          <button
            type="button"
            onClick={() => onGenerate && onGenerate(prompt)}
            disabled={!canGenerate}
            aria-busy={isGenerating}
            className="w-full py-2.5 px-4 bg-brand-600 hover:bg-brand-500 active:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-brand-600 text-white rounded-md text-xs font-semibold flex items-center justify-center space-x-2 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 focus:ring-offset-dark-900"
          >
            {isGenerating ? (
              <Loader2 className="w-4 h-4 text-blue-200 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 text-blue-200" />
            )}
            <span>{isGenerating ? 'Generating…' : 'Generate ERD'}</span>
          </button>

          {/* Error from the last generation attempt (the previous diagram is left untouched) */}
          {error && !isGenerating && (
            <div role="alert" className="bg-rose-950/30 border border-rose-900/50 rounded-md p-3 flex items-start space-x-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-1 min-w-0">
                <p className="text-[11px] font-medium text-rose-300 leading-snug">{error.message}</p>
                {error.details?.length > 0 && (
                  <ul className="list-disc pl-4 text-[10px] text-dark-300 space-y-0.5">
                    {error.details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                )}
                <p className="text-[10px] text-dark-400">The diagram below was not changed.</p>
              </div>
            </div>
          )}

          {/* Status */}
          <div className="bg-dark-850/80 border border-dark-700/80 rounded-md p-3 flex items-center space-x-2" role="status">
            {isGenerating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 text-brand-500 animate-spin shrink-0" />
                <div className="flex flex-col">
                  <span className="text-[11px] font-medium text-dark-200">Generating schema…</span>
                  <span className="text-[10px] text-dark-400">This can take up to a minute.</span>
                </div>
              </>
            ) : lastResult ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="text-[11px] font-medium text-dark-200">
                    Generated {lastResult.entityCount} entities &bull; {lastResult.relationshipCount} relationships
                  </span>
                  <span className="text-[10px] text-dark-400">
                    Validated{lastResult.repaired ? ' after one automatic correction' : ''}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="w-2 h-2 rounded-full bg-dark-500 shrink-0"></div>
                <div className="flex flex-col">
                  <span className="text-[11px] font-medium text-dark-200">Ready</span>
                  <span className="text-[10px] text-dark-400">Showing the sample schema. Click Generate ERD to create your own.</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
