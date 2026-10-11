import React, { useState, useEffect, useCallback } from 'react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import RequirementPanel from '../components/RequirementPanel';
import ERDViewer from '../components/ERDViewer';
import RefinementBar from '../components/RefinementBar';
import SchemaPanel from '../components/SchemaPanel';
import { api } from '../services/api';
import { AlertCircle, RefreshCw, Loader2 } from 'lucide-react';

export default function Dashboard() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [feedbackNotice, setFeedbackNotice] = useState(null);
  const [schema, setSchema] = useState(null);
  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [validationData, setValidationData] = useState(null);

  const fetchSchemaFromBackend = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const res = await api.getSchema();
    if (res.ok && res.data?.success && res.data?.data) {
      setSchema(res.data.data);
      // Run backend validation on loaded schema
      try {
        const valRes = await api.validateSchema(res.data.data);
        if (valRes.ok && valRes.data?.success) {
          setValidationData(valRes.data.data);
        }
      } catch (e) {
        console.warn('Backend validation check skipped:', e);
      }
    } else {
      const msg =
        res.data?.error?.message ||
        'Failed to connect to SchemAI backend at ' +
          (import.meta.env.VITE_API_URL || 'http://localhost:5000') +
          '. Make sure the backend server is running.';
      setError(msg);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchSchemaFromBackend();
  }, [fetchSchemaFromBackend]);

  const handleGenerate = async (requirementText) => {
    try {
      const res = await api.generateSchema(requirementText || 'e-commerce database');
      if (res.data?.error?.message) {
        setFeedbackNotice(res.data.error.message);
      } else {
        setFeedbackNotice('AI generation endpoint responded (Phase 2 feature).');
      }
    } catch {
      setFeedbackNotice('AI generation endpoint unreachable.');
    }
    setTimeout(() => setFeedbackNotice(null), 4500);
  };

  const handleRefine = async (text) => {
    if (!text?.trim() || !schema) return;
    try {
      const res = await api.refineSchema(schema, text);
      if (res.data?.error?.message) {
        setFeedbackNotice(res.data.error.message);
      } else {
        setFeedbackNotice('Schema refinement endpoint responded (Phase 2 feature).');
      }
    } catch {
      setFeedbackNotice('Schema refinement endpoint unreachable.');
    }
    setTimeout(() => setFeedbackNotice(null), 4500);
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
          {/* Notification toast */}
          {feedbackNotice && (
            <div className="fixed top-16 right-6 z-50 bg-dark-850 border border-brand-500/60 text-dark-100 px-4 py-2.5 rounded-md shadow-2xl text-xs font-mono flex items-center space-x-2.5 animate-fade-in">
              <span className="w-2 h-2 rounded-full bg-brand-500 animate-ping"></span>
              <span>{feedbackNotice}</span>
            </div>
          )}

          {/* Loading or Error State */}
          {isLoading && (
            <div className="flex-1 min-h-[460px] flex flex-col items-center justify-center space-y-3 border border-dark-800 rounded-lg bg-dark-900/60 p-8">
              <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
              <p className="text-sm font-medium text-dark-300 font-mono">
                Loading schema from SchemAI backend...
              </p>
            </div>
          )}

          {!isLoading && error && (
            <div className="flex-1 min-h-[460px] flex flex-col items-center justify-center space-y-4 border border-rose-900/40 rounded-lg bg-rose-950/20 p-8 text-center">
              <div className="p-3 rounded-full bg-rose-900/30 text-rose-400">
                <AlertCircle className="w-8 h-8" />
              </div>
              <div className="max-w-md space-y-1.5">
                <h3 className="text-sm font-semibold text-rose-300">Backend Connection Error</h3>
                <p className="text-xs text-dark-300 leading-relaxed">{error}</p>
              </div>
              <button
                onClick={fetchSchemaFromBackend}
                className="mt-2 px-4 py-2 bg-dark-800 hover:bg-dark-750 text-brand-400 border border-brand-500/40 rounded-md text-xs font-semibold flex items-center space-x-2 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry Connection</span>
              </button>
            </div>
          )}

          {!isLoading && !error && schema && (
            <>
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
                <SchemaPanel
                  schema={schema}
                  selectedEntityId={selectedEntityId}
                  onSelectEntity={setSelectedEntityId}
                  validationData={validationData}
                />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
