import { describe, it, expect } from 'vitest';
import { selfLoopPath, SELF_LOOP_CLEARANCE } from './selfLoopPath';

describe('selfLoopPath (self-referencing relationship)', () => {
  it('starts at the source handle, ends at the target handle and arcs above the card', () => {
    const { path, labelX, labelY } = selfLoopPath({ sourceX: 224, sourceY: 100, targetX: 0, targetY: 100, nodeHeight: 120 });
    expect(path.startsWith('M 224,100 C ')).toBe(true);
    expect(path.endsWith(' 0,100')).toBe(true);
    expect(labelX).toBe(112);
    // label sits above the top edge of the card (handle line is its vertical middle)
    expect(labelY).toBe(100 - (60 + SELF_LOOP_CLEARANCE));
    expect(labelY).toBeLessThan(100 - 60);
  });

  it('scales with taller cards so the loop never crosses the card', () => {
    const short = selfLoopPath({ sourceX: 224, sourceY: 100, targetX: 0, targetY: 100, nodeHeight: 100 });
    const tall = selfLoopPath({ sourceX: 224, sourceY: 100, targetX: 0, targetY: 100, nodeHeight: 300 });
    expect(tall.labelY).toBeLessThan(short.labelY);
  });
});
