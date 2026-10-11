import React, { useState } from 'react';
import { Sparkles, Terminal, CheckCircle2, Cpu } from 'lucide-react';
import { INITIAL_REQUIREMENT } from '../data/mockSchema';

export default function RequirementPanel({ onGenerate }) {
  const [prompt, setPrompt] = useState(INITIAL_REQUIREMENT);

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
              rows={8}
              className="w-full h-full min-h-[140px] p-3 text-xs font-mono bg-dark-950 border border-dark-700 rounded-md text-dark-100 placeholder-dark-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 resize-none leading-relaxed transition-colors"
              placeholder="Describe your entities, fields, relationships, and constraints in plain English..."
            />
          </div>
          <div className="flex justify-between items-center text-[11px] text-dark-400 pt-1">
            <span>Natural language requirements input</span>
            <span>{prompt.length} chars</span>
          </div>
        </div>

        {/* Action Button & Status Info */}
        <div className="flex flex-col space-y-3 pt-2">
          <button
            type="button"
            onClick={() => onGenerate && onGenerate(prompt)}
            className="w-full py-2.5 px-4 bg-brand-600 hover:bg-brand-500 active:bg-brand-700 text-white rounded-md text-xs font-semibold flex items-center justify-center space-x-2 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 focus:ring-offset-dark-900"
          >
            <Sparkles className="w-4 h-4 text-blue-200" />
            <span>Generate ERD</span>
          </button>

          {/* Status / Info Section */}
          <div className="bg-dark-850/80 border border-dark-700/80 rounded-md p-3 flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></div>
              <div className="flex flex-col">
                <span className="text-[11px] font-medium text-dark-200">AI Generation (Phase 2)</span>
                <span className="text-[10px] text-dark-400">Backend API Ready &bull; LLM In Next Phase</span>
              </div>
            </div>
            <div className="flex items-center space-x-1 text-[11px] text-dark-400 bg-dark-800 px-2 py-1 rounded border border-dark-700">
              <Cpu className="w-3 h-3 text-brand-500" />
              <span>Model Ready</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
