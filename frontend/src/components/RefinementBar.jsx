import React, { useState } from 'react';
import { RefreshCw, Wand2, ArrowRight } from 'lucide-react';

export default function RefinementBar({ onUpdate }) {
  const [refinementText, setRefinementText] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (onUpdate) onUpdate(refinementText);
  };

  return (
    <div className="bg-dark-900 border border-dark-750 rounded-lg p-3 shadow-sm select-none">
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        {/* Title and Icon */}
        <div className="flex items-center space-x-2 shrink-0">
          <Wand2 className="w-4 h-4 text-brand-500" />
          <span className="text-xs font-semibold uppercase tracking-wider text-dark-100">
            Refine your schema
          </span>
        </div>

        {/* Input Bar */}
        <div className="relative flex-1">
          <input
            type="text"
            value={refinementText}
            onChange={(e) => setRefinementText(e.target.value)}
            placeholder="e.g. Add a payment entity where each order has one payment..."
            className="w-full px-3.5 py-2 text-xs font-mono bg-dark-950 border border-dark-700 rounded-md text-dark-100 placeholder-dark-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors"
          />
        </div>

        {/* Update Schema Button */}
        <button
          type="submit"
          className="px-4 py-2 bg-dark-800 hover:bg-dark-750 active:bg-dark-700 text-brand-500 border border-brand-500/40 hover:border-brand-500 rounded-md text-xs font-medium flex items-center justify-center space-x-1.5 transition-all shrink-0 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <RefreshCw className="w-3.5 h-3.5 text-brand-500" />
          <span>Update Schema</span>
        </button>
      </form>
    </div>
  );
}
