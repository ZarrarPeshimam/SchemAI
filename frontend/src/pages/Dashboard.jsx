import React, { useState } from 'react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import RequirementPanel from '../components/RequirementPanel';
import ERDViewer from '../components/ERDViewer';
import RefinementBar from '../components/RefinementBar';
import SchemaPanel from '../components/SchemaPanel';
import { mockSchema } from '../data/mockSchema';

export default function Dashboard() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [feedbackNotice, setFeedbackNotice] = useState(null);
  // Current schema JSON. A future LLM response can replace this via setSchema().
  // eslint-disable-next-line no-unused-vars
  const [schema, setSchema] = useState(mockSchema);
  const [selectedEntityId, setSelectedEntityId] = useState(null);

  const handleGenerate = () => {
    setFeedbackNotice("Frontend demo: AI generation is not connected yet.");
    setTimeout(() => setFeedbackNotice(null), 3500);
  };

  const handleRefine = (text) => {
    if (!text.trim()) return;
    setFeedbackNotice("Frontend demo: schema refinement is not connected yet.");
    setTimeout(() => setFeedbackNotice(null), 3500);
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-dark-950 text-dark-100 overflow-hidden font-sans">
      {/* Top Header */}
      <Header projectName="E-Commerce Database" />

      {/* Main Container with Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Navigation Sidebar */}
        <Sidebar />

        {/* Workspace Central Area */}
        <main className="flex-1 flex flex-col overflow-y-auto p-3 lg:p-4 space-y-3.5 bg-dark-950">
          
          {/* Subtle notification toast for prototype actions */}
          {feedbackNotice && (
            <div className="fixed top-16 right-6 z-50 bg-dark-850 border border-brand-500/50 text-dark-100 px-3.5 py-2 rounded-md shadow-lg text-xs font-mono flex items-center space-x-2 animate-fade-in">
              <span className="w-2 h-2 rounded-full bg-brand-500"></span>
              <span>{feedbackNotice}</span>
            </div>
          )}

          {/* Top Main Workspace: Split into Left (Input) & Right (ERD) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5 flex-1 min-h-[440px]">
            {/* Left: Requirement / Input Panel (4 cols on lg) */}
            <div className="lg:col-span-4 xl:col-span-4 flex flex-col h-full min-h-[320px]">
              <RequirementPanel onGenerate={handleGenerate} />
            </div>

            {/* Right: ERD Workspace (8 cols on lg) */}
            <div className="lg:col-span-8 xl:col-span-8 flex flex-col h-full min-h-[460px]">
              <ERDViewer 
                schema={schema}
                selectedEntityId={selectedEntityId}
                onSelectEntity={setSelectedEntityId}
                isFullscreen={isFullscreen} 
                onToggleFullscreen={() => setIsFullscreen(!isFullscreen)} 
              />
            </div>
          </div>

          {/* Schema Refinement Bar */}
          <div className="w-full">
            <RefinementBar onUpdate={handleRefine} />
          </div>

          {/* Bottom Secondary Panel: Schema Entities, Relationships, Validation */}
          <div className="w-full pb-2">
            <SchemaPanel schema={schema} selectedEntityId={selectedEntityId} onSelectEntity={setSelectedEntityId} />
          </div>

        </main>
      </div>
    </div>
  );
}
