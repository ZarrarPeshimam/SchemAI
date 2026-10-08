import React from 'react';
import { Database, Plus, Settings, Sparkles, FolderGit2 } from 'lucide-react';

export default function Header({ projectName = "E-Commerce Database" }) {
  return (
    <header className="h-14 bg-dark-900 border-b border-dark-700 flex items-center justify-between px-4 select-none shrink-0 z-20">
      {/* Left: Logo & Subtitle */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-md bg-dark-800 border border-dark-700 text-brand-500 shadow-sm">
          <Database className="w-4 h-4" />
        </div>
        <div className="flex flex-col">
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-sm tracking-tight text-dark-50">SchemAI</span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-dark-800 text-brand-500 border border-dark-700">v0.1</span>
          </div>
          <span className="text-[11px] text-dark-400 font-normal leading-tight">AI Database Designer</span>
        </div>
      </div>

      {/* Center: Current Project Name */}
      <div className="hidden md:flex items-center space-x-2 px-3 py-1 rounded-md bg-dark-850 border border-dark-700/80">
        <FolderGit2 className="w-3.5 h-3.5 text-dark-400" />
        <span className="text-xs text-dark-400">Project:</span>
        <span className="text-xs font-medium text-dark-100">{projectName}</span>
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 ml-1"></span>
      </div>

      {/* Right Actions */}
      <div className="flex items-center space-x-2.5">
        <button 
          type="button"
          className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-md transition-colors shadow-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Schema</span>
        </button>

        <button 
          type="button"
          aria-label="Settings"
          className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-800 rounded-md transition-colors border border-transparent hover:border-dark-700"
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* User Avatar Placeholder */}
        <div className="w-7 h-7 rounded-full bg-dark-800 border border-dark-600 flex items-center justify-center text-xs font-medium text-dark-200 cursor-pointer hover:border-brand-500 transition-colors">
          SC
        </div>
      </div>
    </header>
  );
}
