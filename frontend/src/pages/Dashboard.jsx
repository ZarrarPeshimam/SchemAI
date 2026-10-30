import React, { useState, useEffect, useCallback, useRef } from 'react';
import Header from '../components/Header';
import Sidebar from '../components/Sidebar';
import RequirementPanel from '../components/RequirementPanel';
import ERDViewer from '../components/ERDViewer';
import RefinementBar from '../components/RefinementBar';
import SchemaPanel from '../components/SchemaPanel';
import { api } from '../services/api';
import { useModelSelection } from '../hooks/useModelSelection';
import { toGenerationError, validateRequirementInput } from '../utils/generation';
import { interpretRefineResponse, isVersionConflict, validateInstructionInput } from '../utils/refinement';
import { AlertCircle, RefreshCw, Loader2 } from 'lucide-react';

const NO_MODEL_MESSAGE = 'Select a Gemini model in the sidebar (AI Model) before generating or refining.';

export default function Dashboard() {
  // Gemini model list + the user's selection (persisted in localStorage). Handlers below capture `selectedModelId` when
  // a request STARTS, so changing the dropdown never alters a request that is already in flight.
  const modelSelection = useModelSelection();
  const { selectedModelId } = modelSelection;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [schema, setSchema] = useState(null);
  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [validationData, setValidationData] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  // Version of the saved conversation's schema that this client currently shows (null when not persisted).
  const [conversationVersion, setConversationVersion] = useState(null);

  // AI generation workflow state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState(null);
  const [lastGeneration, setLastGeneration] = useState(null);
  const [schemaSource, setSchemaSource] = useState('sample'); // 'sample' | 'generated' | 'refined'
  const generationInFlight = useRef(false); // guards against double submits before state re-renders

  // Schema refinement state
  const [isRefining, setIsRefining] = useState(false);
  const [refineResult, setRefineResult] = useState(null);
  const refineInFlight = useRef(false);
  // Incremented whenever the displayed schema is replaced by something other than a refinement (generation, loading
  // a conversation). A refinement response that arrives after that is outdated and must not overwrite the newer schema.
  const schemaEpoch = useRef(0);
  const loadSeq = useRef(0);
  const loadInFlight = useRef(false);

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
    if (generationInFlight.current) return; // duplicate request while one is running
    if (refineInFlight.current || loadInFlight.current) {
      setGenerationError({ message: 'Please wait for the current schema update to finish.', details: [] });
      return;
    }

    const inputError = validateRequirementInput(requirementText);
    if (inputError) {
      setGenerationError({ message: inputError, details: [] });
      return;
    }

    const modelId = selectedModelId; // captured now: this request keeps this model even if the selection changes
    if (!modelId) {
      setGenerationError({ message: NO_MODEL_MESSAGE, details: [] });
      return;
    }

    generationInFlight.current = true;
    setIsGenerating(true);
    setGenerationError(null);

    try {
      const res = await api.generateSchema(requirementText.trim(), modelId);
      const payload = res.ok && res.data?.success ? res.data.data : null;

      if (payload?.schema) {
        // Replace the canonical schema state with the validated result from the backend.
        schemaEpoch.current += 1;
        setSchema(payload.schema);
        setValidationData(payload.validation ?? null);
        setSelectedEntityId(null);
        setRefineResult(null); // the previous refinement summary described the old schema
        setSchemaSource('generated');
        setConversationId(payload.conversationId ?? null);
        setConversationVersion(Number.isInteger(payload.schemaVersion) ? payload.schemaVersion : null);
        setLastGeneration({
          entityCount: payload.schema.entities.length,
          relationshipCount: payload.schema.relationships.length,
          repaired: !!payload.repaired,
        });
      } else {
        // Keep whatever diagram is currently shown; surface the error instead of faking a result.
        setGenerationError(toGenerationError(res));
      }
    } catch (e) {
      console.error('Schema generation failed unexpectedly:', e);
      setGenerationError({ message: 'Something went wrong while generating the schema. Please try again.', details: [] });
    } finally {
      generationInFlight.current = false;
      setIsGenerating(false);
    }
  };

  /**
   * Refines the current schema. For a saved conversation only the conversation id + known schema version are sent and
   * the backend refines its stored (authoritative) schema; otherwise the current schema is sent and nothing is saved.
   * The diagram/app state is replaced only when the backend reports an accepted (validated, committed) change;
   * clarifications and errors leave the schema untouched, and responses that became outdated are ignored.
   * Resolves to true only when the change was accepted.
   */
  const handleRefine = async (text) => {
    if (refineInFlight.current || loadInFlight.current || !schema) return false;

    const inputError = validateInstructionInput(text);
    if (inputError) {
      setRefineResult({ kind: 'error', message: inputError, details: [] });
      return false;
    }

    const modelId = selectedModelId; // captured now (see handleGenerate)
    if (!modelId) {
      setRefineResult({ kind: 'error', message: NO_MODEL_MESSAGE, details: [] });
      return false;
    }

    console.log(`[Refine:Request] Starting refinement in frontend. Model: ${modelId}, instruction: "${text.trim()}", conversationId: ${conversationId || 'none'}`);
    refineInFlight.current = true;
    setIsRefining(true);
    setRefineResult(null);
    const epoch = schemaEpoch.current;

    try {
      const res = conversationId
        ? await api.refineSchema(schema, text.trim(), { conversationId, schemaVersion: conversationVersion }, modelId)
        : await api.refineSchema(schema, text.trim(), null, modelId);
      console.log('[Refine:UI] Frontend refineSchema API response received:', { status: res?.status, ok: res?.ok, dataSuccess: res?.data?.success, statusField: res?.data?.data?.status, errorCode: res?.data?.error?.code });
      if (epoch !== schemaEpoch.current) return false; // the schema was replaced meanwhile: this answer is outdated
      const outcome = interpretRefineResponse(res);
      console.log('[Refine:UI] Interpreted refine outcome for UI:', { kind: outcome.kind, message: outcome.message, detailsCount: outcome.details?.length, details: outcome.details });

      if (outcome.kind === 'applied') {
        schemaEpoch.current += 1;
        setSchema(outcome.schema);
        setValidationData(outcome.validation);
        if (conversationId && outcome.schemaVersion !== null) setConversationVersion(outcome.schemaVersion);
        setSelectedEntityId((current) => (outcome.schema.entities.some((e) => e.id === current) ? current : null));
        setSchemaSource('refined');
      }
      setRefineResult(outcome);

      if (isVersionConflict(outcome) && conversationId) {
        // Someone else changed this conversation: bring the latest schema in so the next instruction applies to it.
        await loadConversation(conversationId, { keepResult: true });
        setRefineResult({
          ...outcome,
          message: 'This conversation was changed elsewhere. The latest schema has been reloaded; please repeat your instruction.',
        });
      }
      return outcome.kind === 'applied';
    } catch (e) {
      console.error('Schema refinement failed unexpectedly:', e);
      setRefineResult({ kind: 'error', message: 'Something went wrong while refining the schema. Please try again.', details: [] });
      return false;
    } finally {
      refineInFlight.current = false;
      setIsRefining(false);
    }
  };

  // Load a saved conversation and restore state (its stored schema and version are the source of truth).
  const loadConversation = async (id, { keepResult = false } = {}) => {
    if (!keepResult && (refineInFlight.current || generationInFlight.current)) {
      setRefineResult({ kind: 'error', message: 'Please wait for the current schema update to finish before opening another conversation.', details: [] });
      return;
    }
    const seq = ++loadSeq.current;
    loadInFlight.current = true;
    try {
      const res = await api.getConversation(id);
      if (seq !== loadSeq.current) return; // a newer load superseded this one
      if (res.ok && res.data?.success && res.data.data?.schema?.entities) {
        const conv = res.data.data;
        schemaEpoch.current += 1;
        setConversationId(conv._id || id);
        setConversationVersion(Number.isInteger(conv.schemaVersion) ? conv.schemaVersion : 1);
        setSchema(conv.schema);
        if (!keepResult) setRefineResult(null);
        setSchemaSource('generated');
        setSelectedEntityId(null);
        // Attempt to validate the loaded schema for UI consistency
        try {
          const valRes = await api.validateSchema(conv.schema);
          if (seq === loadSeq.current && valRes.ok && valRes.data?.success) {
            setValidationData(valRes.data.data);
          }
        } catch (e) {
          console.warn('Validation of loaded schema failed', e);
        }
      } else {
        console.warn('Failed to fetch conversation', res);
      }
    } catch (e) {
      console.error('Error loading conversation', e);
    } finally {
      if (seq === loadSeq.current) loadInFlight.current = false;
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-dark-950 text-dark-100 overflow-hidden font-sans">
      {/* Top Header */}
      <Header projectName={
          schemaSource === 'refined'
            ? 'Refined Schema'
            : schemaSource === 'generated'
              ? 'Generated Schema'
              : 'E-Commerce Database (sample)'
        } />

      {/* Main Container with Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Navigation Sidebar */}
        <Sidebar onSelectConversation={loadConversation} modelSelection={modelSelection} />

        {/* Workspace Central Area */}
        <main className="flex-1 flex flex-col overflow-y-auto p-3 lg:p-4 space-y-3.5 bg-dark-950">
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
                  <RequirementPanel
                    onGenerate={handleGenerate}
                    isGenerating={isGenerating}
                    error={generationError}
                    lastResult={lastGeneration}
                  />
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

              {/* Schema Refinement Bar (temporarily hidden) */}
              {/*
              <div className="w-full">
                <RefinementBar onRefine={handleRefine} isRefining={isRefining} result={refineResult} disabled={isGenerating} />
              </div>
              */}

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
