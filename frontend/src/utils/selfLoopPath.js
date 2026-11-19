/**
 * SVG path for a self-referencing relationship (e.g. Employee.manager_id -> Employee).
 * The source handle is on the right and the target handle on the left of the SAME card, so a normal edge path would be
 * drawn straight through the card. This arcs over the top of it instead, clear of the card's real (measured) height.
 * Pure function: easy to unit test.
 */
export const SELF_LOOP_CLEARANCE = 44;

export function selfLoopPath({ sourceX, sourceY, targetX, targetY, nodeHeight = 120 }) {
  const rise = nodeHeight / 2 + SELF_LOOP_CLEARANCE; // distance from the handles' line to the top of the arc
  const control = rise / 0.75; // a cubic with both controls at this height peaks at 75% of it
  const bulge = 70;
  const path = `M ${sourceX},${sourceY} C ${sourceX + bulge},${sourceY - control} ${targetX - bulge},${targetY - control} ${targetX},${targetY}`;
  return { path, labelX: (sourceX + targetX) / 2, labelY: Math.min(sourceY, targetY) - rise };
}
