import { MarkerType } from "@xyflow/react";
import { ENTITY_WIDTH, entityHeight, LAYOUT_DIRECTION, layoutNodes } from "./layoutSchema";
import { toTableName } from "./schemaHelpers";

export const EDGE_COLOR = "#4A5B7D"; // dark-500
export const EDGE_COLOR_ACTIVE = "#3B82F6"; // brand-500

export const edgeMarker = (color) => ({
  type: MarkerType.ArrowClosed,
  color,
  width: 14,
  height: 14,
});

/** schema.entities -> React Flow nodes (positions are filled in by the layout). */
export function entitiesToNodes(schema) {
  return schema.entities.map((entity) => ({
    id: entity.id,
    type: "entity",
    position: { x: 0, y: 0 },
    initialWidth: ENTITY_WIDTH,
    initialHeight: entityHeight(entity.attributes.length),
    data: {
      name: entity.name,
      tableName: toTableName(entity.name),
      attributes: entity.attributes,
      direction: LAYOUT_DIRECTION,
    },
  }));
}

/** schema.relationships -> React Flow edges. */
export function relationshipsToEdges(schema) {
  return schema.relationships.map((rel) => ({
    id: rel.id,
    source: rel.source,
    target: rel.target,
    type: "relationship",
    markerEnd: edgeMarker(EDGE_COLOR),
    data: { name: rel.name, cardinality: rel.cardinality, highlighted: false },
  }));
}

/** Full conversion: schema JSON -> laid-out { nodes, edges }. */
export function schemaToFlow(schema) {
  const edges = relationshipsToEdges(schema);
  const nodes = layoutNodes(entitiesToNodes(schema), edges);
  return { nodes, edges };
}
