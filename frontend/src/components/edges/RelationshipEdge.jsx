import React, { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import { EDGE_COLOR, EDGE_COLOR_ACTIVE } from "../../utils/schemaToFlow";

function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });
  const active = data?.highlighted;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: active ? EDGE_COLOR_ACTIVE : EDGE_COLOR, strokeWidth: active ? 1.75 : 1.5 }}
      />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className={`absolute pointer-events-none nodrag nopan px-1.5 py-0.5 rounded border bg-dark-950 font-mono text-[10px] leading-none whitespace-nowrap ${
            active ? "border-brand-500/60" : "border-dark-700"
          }`}
        >
          <span className="text-dark-300">{data?.name}</span>
          <span className="text-dark-500"> · </span>
          <span className={active ? "text-brand-400" : "text-dark-400"}>{data?.cardinality}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export default memo(RelationshipEdge);
