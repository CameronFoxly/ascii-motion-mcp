import { parseCellKey, type SessionDataV2 } from './types.js';

export interface ContentOperation { op: string; input: Record<string, unknown> }

export function contentPatch(before: SessionDataV2, after: SessionDataV2): ContentOperation[] {
  const invariant = (document: SessionDataV2) => ({
    ...document,
    layers: document.layers.map(layer => ({ ...layer, contentFrames: [] })),
    timeline: { ...document.timeline, durationFrames: 0, frameRate: 0, looping: false },
  });
  if (JSON.stringify(invariant(before)) !== JSON.stringify(invariant(after))) {
    throw new Error('Legacy content computation attempted to change unsupported document structure');
  }
  const operations: ContentOperation[] = [];
  const timeline = {
    frameRate: after.timeline.frameRate,
    durationFrames: after.timeline.durationFrames,
    looping: after.timeline.looping,
  };
  const timelineChanged = JSON.stringify(before.timeline) !== JSON.stringify(after.timeline);
  if (timelineChanged && after.timeline.durationFrames >= before.timeline.durationFrames) {
    operations.push({ op: 'set_timeline', input: timeline });
  }
  for (const layer of before.layers) {
    const next = after.layers.find(candidate => candidate.id === layer.id)!;
    for (const frame of layer.contentFrames) {
      if (!next.contentFrames.some(candidate => candidate.id === frame.id)) {
        operations.push({ op: 'remove_content_frame', input: { layerId: layer.id, contentFrameId: frame.id } });
      }
    }
    for (const frame of next.contentFrames) {
      const previous = layer.contentFrames.find(candidate => candidate.id === frame.id);
      if (previous && frame.durationFrames < previous.durationFrames) {
        operations.push({
          op: 'update_content_frame',
          input: { layerId: layer.id, contentFrameId: frame.id, durationFrames: frame.durationFrames },
        });
      }
    }
    const existing = next.contentFrames.flatMap(frame => {
      const previous = layer.contentFrames.find(candidate => candidate.id === frame.id);
      return previous ? [{ frame, previous }] : [];
    });
    existing.sort((a, b) => {
      const deltaA = a.frame.startFrame - a.previous.startFrame;
      const deltaB = b.frame.startFrame - b.previous.startFrame;
      const orderA = deltaA < 0 ? 0 : deltaA > 0 ? 1 : 2;
      const orderB = deltaB < 0 ? 0 : deltaB > 0 ? 1 : 2;
      return orderA - orderB || (orderA === 1 ? b.frame.startFrame - a.frame.startFrame : a.frame.startFrame - b.frame.startFrame);
    });
    for (const { frame, previous } of existing) {
      const metadata: Record<string, unknown> = {};
      const editable = ['name', 'startFrame', 'durationFrames', 'hidden', 'labelColor'] as const;
      const opaque = (value: typeof frame) => Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'data' && !editable.some(editableKey => editableKey === key)));
      if (JSON.stringify(opaque(previous)) !== JSON.stringify(opaque(frame))) {
        throw new Error('Legacy content computation changed unsupported content-frame metadata');
      }
      for (const key of editable) {
        if (previous[key] === frame[key]) continue;
        if (key === 'durationFrames' && frame.durationFrames < previous.durationFrames) continue;
        if (frame[key] === undefined) throw new Error(`Cannot remove content-frame metadata: ${key}`);
        metadata[key] = frame[key];
      }
      if (Object.keys(metadata).length) operations.push({
        op: 'update_content_frame', input: { layerId: layer.id, contentFrameId: frame.id, ...metadata },
      });
      const data = frame.data ?? {};
      const oldData = previous.data ?? {};
      const changes = [...new Set([...Object.keys(data), ...Object.keys(oldData)])].flatMap(key => {
        if (JSON.stringify(data[key]) === JSON.stringify(oldData[key])) return [];
        const { x, y } = parseCellKey(key);
        return [{ x, y, ...(data[key] ?? { clear: true }) }];
      });
      if (changes.length) operations.push({
        op: 'set_cells', input: { target: { layerId: layer.id, contentFrameId: frame.id }, cells: changes },
      });
    }
    for (const frame of next.contentFrames) {
      if (layer.contentFrames.some(candidate => candidate.id === frame.id)) continue;
      if (frame.hidden || frame.labelColor || Object.keys(frame).some(key =>
        !['id', 'name', 'startFrame', 'durationFrames', 'data', 'hidden', 'labelColor'].includes(key))) {
        throw new Error('New content frame has metadata this compatibility batch cannot preserve');
      }
      operations.push({
        op: 'add_content_frame',
        input: {
          layerId: layer.id, name: frame.name, startFrame: frame.startFrame, durationFrames: frame.durationFrames,
          cells: Object.entries(frame.data ?? {}).map(([key, cell]) => ({ ...parseCellKey(key), ...cell })),
        },
      });
    }
  }
  if (timelineChanged && after.timeline.durationFrames < before.timeline.durationFrames) {
    operations.push({ op: 'set_timeline', input: timeline });
  }
  if (operations.length > 100) throw new Error('This edit exceeds the 100-operation atomic batch limit; reduce its frame count');
  return operations;
}
