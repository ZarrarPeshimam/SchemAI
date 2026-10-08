import React, { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Table2 } from "lucide-react";
import {
  ENTITY_BODY_PADDING,
  ENTITY_HEADER_HEIGHT,
  ENTITY_ROW_HEIGHT,
  ENTITY_WIDTH,
} from "../../utils/layoutSchema";

const KeyBadge = ({ label, tone }) => (
  <span
    className={`text-[9px] leading-none px-1 py-[3px] rounded font-bold border font-mono ${
      tone === "pk"
        ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
        : "bg-blue-500/15 text-blue-400 border-blue-500/30"
    }`}
  >
    {label}
  </span>
);

function EntityNode({ data, selected }) {
  const vertical = data.direction === "TB";
  const targetPos = vertical ? Position.Top : Position.Left;
  const sourcePos = vertical ? Position.Bottom : Position.Right;

  return (
    <div
      style={{ width: ENTITY_WIDTH }}
      className={`rounded-md bg-dark-850 border overflow-hidden transition-colors ${
        selected ? "border-brand-500 ring-1 ring-brand-500/60" : "border-dark-600 hover:border-dark-500"
      }`}
    >
      <Handle type="target" position={targetPos} className="erd-handle" isConnectable={false} />
      <Handle type="source" position={sourcePos} className="erd-handle" isConnectable={false} />

      {/* Header */}
      <div
        style={{ height: ENTITY_HEADER_HEIGHT }}
        className={`flex items-center gap-2 px-3 border-b ${
          selected ? "bg-dark-750 border-brand-500/40" : "bg-dark-800 border-dark-600"
        }`}
      >
        <Table2 className={`w-3.5 h-3.5 shrink-0 ${selected ? "text-brand-500" : "text-dark-400"}`} />
        <span className="text-xs font-semibold tracking-wide text-dark-50 truncate">
          {data.tableName}
        </span>
        <span className="ml-auto text-[10px] font-mono text-dark-500">{data.attributes.length}</span>
      </div>

      {/* Attributes */}
      <div style={{ paddingTop: ENTITY_BODY_PADDING / 2, paddingBottom: ENTITY_BODY_PADDING / 2 }}>
        {data.attributes.map((attr) => (
          <div
            key={attr.name}
            style={{ height: ENTITY_ROW_HEIGHT }}
            className="flex items-center gap-2 px-3 font-mono text-[11px]"
          >
            <div className="w-[34px] shrink-0 flex items-center gap-0.5">
              {attr.primaryKey && <KeyBadge label="PK" tone="pk" />}
              {attr.foreignKey && <KeyBadge label="FK" tone="fk" />}
            </div>
            <span
              className={`flex-1 truncate ${
                attr.primaryKey ? "text-dark-50 font-medium" : attr.foreignKey ? "text-dark-200" : "text-dark-300"
              }`}
            >
              {attr.name}
            </span>
            <span className="text-[10px] text-dark-500 shrink-0">{attr.type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(EntityNode);
