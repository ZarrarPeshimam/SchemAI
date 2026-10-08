import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  applyNodeChanges,
  useReactFlow,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Layers, LayoutGrid, Maximize2, Minimize2 } from "lucide-react";
import EntityNode from "./nodes/EntityNode";
import RelationshipEdge from "./edges/RelationshipEdge";
import { EDGE_COLOR, EDGE_COLOR_ACTIVE, edgeMarker, schemaToFlow } from "../utils/schemaToFlow";

// Defined outside the component so React Flow gets stable references.
const nodeTypes = { entity: EntityNode };
const edgeTypes = { relationship: RelationshipEdge };
const FIT_OPTIONS = { padding: 0.1, duration: 250 };

function ERDCanvas({ schema, selectedEntityId, onSelectEntity, isFullscreen, onToggleFullscreen }) {
  const { fitView } = useReactFlow();
  const { zoom } = useViewport();

  // Laid out once per schema. Dragging mutates `nodes` only; the layout is not re-run.
  const initial = useMemo(() => schemaToFlow(schema), [schema]);
  const [nodes, setNodes] = useState(initial.nodes);

  // A new schema (e.g. future LLM response) replaces the nodes and refits the view.
  useEffect(() => {
    setNodes(initial.nodes);
    const t = setTimeout(() => fitView(FIT_OPTIONS), 50);
    return () => clearTimeout(t);
  }, [initial, fitView]);

  const onNodesChange = useCallback(
    // Selection is owned by the dashboard, so ignore React Flow's own select changes.
    (changes) => setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "select"), ns)),
    []
  );

  const displayNodes = useMemo(
    () => nodes.map((n) => (n.selected === (n.id === selectedEntityId) ? n : { ...n, selected: n.id === selectedEntityId })),
    [nodes, selectedEntityId]
  );

  // Edges touching the selected entity are emphasised.
  const displayEdges = useMemo(
    () =>
      initial.edges.map((e) => {
        const highlighted = !!selectedEntityId && (e.source === selectedEntityId || e.target === selectedEntityId);
        return {
          ...e,
          data: { ...e.data, highlighted },
          markerEnd: edgeMarker(highlighted ? EDGE_COLOR_ACTIVE : EDGE_COLOR),
          zIndex: highlighted ? 1 : 0,
        };
      }),
    [initial.edges, selectedEntityId]
  );

  const resetLayout = () => {
    setNodes(initial.nodes);
    setTimeout(() => fitView(FIT_OPTIONS), 30);
  };

  // Re-frame after the workspace changes size (fullscreen toggle).
  useEffect(() => {
    const t = setTimeout(() => fitView(FIT_OPTIONS), 220);
    return () => clearTimeout(t);
  }, [isFullscreen, fitView]);

  // Esc exits fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e) => e.key === "Escape" && onToggleFullscreen();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen, onToggleFullscreen]);

  const headerBtn =
    "p-1.5 text-dark-300 hover:text-dark-100 hover:bg-dark-800 rounded transition-colors flex items-center space-x-1";

  return (
    <>
      {/* ERD Header */}
      <div className="px-4 py-3 border-b border-dark-750 flex items-center justify-between bg-dark-850/70 select-none">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2">
            <Layers className="w-4 h-4 text-brand-500" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-dark-100">
              Entity Relationship Diagram
            </h2>
          </div>
          <div className="flex items-center space-x-1.5 px-2.5 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-500/30 text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="text-[11px] font-medium">Schema Valid</span>
          </div>
        </div>

        <div className="flex items-center space-x-1 bg-dark-950 border border-dark-700/80 rounded-md p-0.5">
          <span className="px-1.5 text-[10px] font-mono text-dark-400 w-10 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <div className="w-[1px] h-4 bg-dark-700 mx-0.5"></div>
          <button type="button" onClick={resetLayout} className={headerBtn} title="Reset layout" aria-label="Reset layout">
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <div className="w-[1px] h-4 bg-dark-700 mx-0.5"></div>
          <button
            type="button"
            onClick={onToggleFullscreen}
            className={headerBtn}
            title={isFullscreen ? "Exit Fullscreen (Esc)" : "Fullscreen"}
            aria-label={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative min-h-[360px] bg-dark-950">
        <div className="absolute inset-0">
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => onSelectEntity(node.id)}
            onNodeDragStart={(_, node) => onSelectEntity(node.id)}
            onPaneClick={() => onSelectEntity(null)}
            nodesConnectable={false}
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.1 }}
            minZoom={0.3}
            maxZoom={2}
            attributionPosition="bottom-center"
            proOptions={{ hideAttribution: false }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2D3A54" />
            <Controls showInteractive={false} fitViewOptions={FIT_OPTIONS} position="bottom-left" />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              nodeColor="#2D3A54"
              nodeStrokeColor="#4A5B7D"
              nodeStrokeWidth={2}
              maskColor="rgba(9, 13, 20, 0.7)"
              style={{ width: 130, height: 90 }}
            />
          </ReactFlow>
        </div>
        <div className="absolute top-2 left-3 pointer-events-none text-[10px] font-mono text-dark-500 select-none">
          Scroll to zoom • Drag canvas to pan • Drag cards to rearrange
        </div>
      </div>
    </>
  );
}

export default function ERDViewer({ schema, selectedEntityId, onSelectEntity, isFullscreen, onToggleFullscreen }) {
  return (
    <>
      {isFullscreen && <div className="fixed inset-0 z-40 bg-dark-950/80" onClick={onToggleFullscreen} />}
      <div
        className={`bg-dark-900 border border-dark-750 rounded-lg flex flex-col shadow-sm overflow-hidden ${
          isFullscreen ? "fixed inset-4 z-50 rounded-xl shadow-2xl" : "h-full"
        }`}
      >
        <ReactFlowProvider>
          <ERDCanvas
            schema={schema}
            selectedEntityId={selectedEntityId}
            onSelectEntity={onSelectEntity}
            isFullscreen={isFullscreen}
            onToggleFullscreen={onToggleFullscreen}
          />
        </ReactFlowProvider>
      </div>
    </>
  );
}
