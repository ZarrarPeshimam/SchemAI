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
import { api } from '../services/api';
import ModelSelector from './ModelSelector';

export default function Sidebar({ onSelectConversation, modelSelection }) {
  const [activeItem, setActiveItem] = useState('dashboard');
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState([]);

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

  const openHistory = async () => {
    try {
      const res = await api.listConversations();
      if (res.ok && res.data?.success) {
        setConversations(res.data.data);
      }
    } catch (e) {
      console.warn('Failed to load conversation history', e);
    }
    setShowHistory(true);
  };

  const handleSelect = (id) => {
    if (onSelectConversation) onSelectConversation(id);
    setShowHistory(false);
    setActiveItem('dashboard');
  };

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
            const handleClick = () => {
              setActiveItem(item.id);
              if (item.id === 'history') {
                openHistory();
              }
            };
            return (
              <button
                key={item.id}
                onClick={handleClick}
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

      {/* Bottom Section: model selector sits above the System items */}
      <div className="flex flex-col">
      {modelSelection && (
        <div className="pt-3 border-t border-dark-700/60">
          <ModelSelector selection={modelSelection} />
        </div>
      )}
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
      </div>
      {/* History Modal */}
      {showHistory && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-dark-800 rounded-lg w-96 max-h-96 overflow-y-auto p-4">
            <h2 className="text-lg font-semibold mb-3 text-white">Conversation History</h2>
            {conversations.length === 0 ? (
              <p className="text-sm text-gray-400">No conversations found.</p>
            ) : (
              <ul className="space-y-2">
                {conversations.map((c) => (
                  <li key={c._id} className="border-b border-dark-600 pb-2">
                    <button
                      onClick={() => handleSelect(c._id)}
                      className="w-full text-left text-sm text-white hover:text-brand-400"
                    >
                      <div className="font-medium truncate">{c.title || 'Untitled'}</div>
                      <div className="text-xs text-gray-400">{new Date(c.createdAt).toLocaleString()}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => setShowHistory(false)}
              className="mt-4 w-full py-1 bg-dark-700 hover:bg-dark-600 text-sm text-gray-200 rounded"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
