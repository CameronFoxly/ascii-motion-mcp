import { parseCellKey, type CanvasData, type Cell } from './types.js';

export interface CellDifference {
  x: number; y: number; before: Cell | null; after: Cell | null;
  change: 'added' | 'removed' | 'modified' | 'unchanged';
}

export function compareCells(before: CanvasData, after: CanvasData, includeUnchanged = false) {
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const differences: CellDifference[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    const change = !a ? 'added' : !b ? 'removed'
      : a.char === b.char && a.color === b.color && a.bgColor === b.bgColor ? 'unchanged' : 'modified';
    counts[change]++;
    if (change !== 'unchanged' || includeUnchanged) {
      differences.push({ ...parseCellKey(key), before: a ?? null, after: b ?? null, change });
    }
  }
  differences.sort((a, b) => a.y - b.y || a.x - b.x);
  return { counts, differences };
}

export function differencePage(before: CanvasData, after: CanvasData, offset: number, limit: number, includeUnchanged = false) {
  const { counts, differences } = compareCells(before, after, includeUnchanged);
  const page = differences.slice(offset, offset + limit);
  return {
    summary: counts, totalDiffs: counts.added + counts.removed + counts.modified,
    totalItems: differences.length, returnedCount: page.length,
    nextOffset: offset + page.length < differences.length ? offset + page.length : null,
    truncated: offset + page.length < differences.length, diffs: page,
  };
}
