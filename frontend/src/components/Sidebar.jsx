import React, { useState } from 'react';
import { 
  LayoutDashboard, 
  Database, 
  LayoutTemplate, 
  History, 
  HelpCircle, 
  Settings,
  Layers
} from 'lucide-react';

export default function Sidebar() {
  const [activeItem, setActiveItem] = useState('dashboard');

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'schemas', label: 'Schemas', icon: Database },
    { id: 'templates', label: 'Templates', icon: LayoutTemplate },
    { id: 'history', label: 'History', icon: History },
  ];

  const bottomItems = [
    { id: 'help', label: 'Help', icon: HelpCircle },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <aside className="w-16 md:w-56 bg-dark-900 border-r border-dark-700 flex flex-col justify-between select-none shrink-0 py-3 transition-all duration-200">
      {/* Top Section */}
      <div className="flex flex-col space-y-4">
        {/* Navigation Category Label (hidden on small) */}
        <div className="px-4 hidden md:block">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-dark-500">Navigation</span>
        </div>

        {/* Primary Nav List */}
        <nav className="flex flex-col space-y-1 px-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeItem === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveItem(item.id)}
                className={`flex items-center space-x-3 px-3 py-2 rounded-md text-xs font-medium transition-colors group relative ${
                  isActive
                    ? 'bg-dark-800 text-brand-500 border border-dark-700 font-semibold'
                    : 'text-dark-300 hover:text-dark-100 hover:bg-dark-850'
                }`}
                title={item.label}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-1 bg-brand-500 rounded-r"></span>
                )}
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-brand-500' : 'text-dark-400 group-hover:text-dark-200'}`} />
                <span className="hidden md:inline truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Section */}
      <div className="flex flex-col space-y-1 px-2 pt-3 border-t border-dark-700/60">
        <div className="px-2 mb-1 hidden md:block">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-dark-500">System</span>
        </div>

        {bottomItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className="flex items-center space-x-3 px-3 py-2 rounded-md text-xs font-medium text-dark-400 hover:text-dark-100 hover:bg-dark-850 transition-colors group"
              title={item.label}
            >
              <Icon className="w-4 h-4 shrink-0 text-dark-400 group-hover:text-dark-200" />
              <span className="hidden md:inline truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
