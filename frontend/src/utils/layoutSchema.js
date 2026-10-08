import dagre from "@dagrejs/dagre";

// Fixed card metrics, shared by EntityNode (rendering) and the layout (sizing)
// so Dagre sees the true size of every card.
export const ENTITY_WIDTH = 224;
export const ENTITY_HEADER_HEIGHT = 36;
export const ENTITY_ROW_HEIGHT = 26;
export const ENTITY_BODY_PADDING = 8;

export const entityHeight = (attributeCount) =>
  ENTITY_HEADER_HEIGHT + attributeCount * ENTITY_ROW_HEIGHT + ENTITY_BODY_PADDING;

export const LAYOUT_DIRECTION = "LR";

/**
 * Deterministic left-to-right layered layout.
 * Pure function: returns new nodes with positions, never mutates input.
 * Only called on load / schema change / "Reset layout" — never on drag.
 */
export function layoutNodes(nodes, edges, direction = LAYOUT_DIRECTION) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    ranksep: 130, // wide gutters keep relationship labels clear of cards
    nodesep: 40,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n) => g.setNode(n.id, { width: n.initialWidth, height: n.initialHeight }));
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => {
    const { x, y } = g.node(n.id);
    // Dagre returns centers; React Flow wants top-left.
    return { ...n, position: { x: x - n.initialWidth / 2, y: y - n.initialHeight / 2 } };
  });
}
