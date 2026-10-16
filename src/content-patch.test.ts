import { describe, expect, it } from 'vitest';
import { contentPatch } from './content-patch.js';
import { validateOperation } from './contract.js';
import { SessionDataV2Schema } from './types.js';

const cell = (char: string) => ({ char, color: '#FFFFFF', bgColor: 'transparent' });
function document() {
  return SessionDataV2Schema.parse({
    version: '2.2.0',
    canvas: { width: 8, height: 4, canvasBackgroundColor: '#000000' },
    timeline: { frameRate: 12, durationFrames: 12, looping: true },
    layers: [{
      id: 'layer', name: 'Layer', propertyTracks: [],
      contentFrames: [
        { id: 'a', name: 'A', startFrame: 0, durationFrames: 4, data: { '0,0': cell('A') } },
        { id: 'b', name: 'B', startFrame: 4, durationFrames: 4, data: { '1,0': cell('B') } },
        { id: 'c', name: 'C', startFrame: 8, durationFrames: 4, data: {} },
      ],
    }],
  });
}

describe('strict native content patches', () => {
  it('emits validated explicit erasures and replacements without replacing the document', () => {
    const before = document();
    const after = structuredClone(before);
    after.layers[0].contentFrames[0].data = { '1,1': cell('X') };
    const operations = contentPatch(before, after);
    expect(operations).toEqual([{
      op: 'set_cells', input: {
        target: { layerId: 'layer', contentFrameId: 'a' },
        cells: [{ x: 1, y: 1, ...cell('X') }, { x: 0, y: 0, clear: true }],
      },
    }]);
    for (const operation of operations) expect(() => validateOperation(operation.op, 'input', operation.input)).not.toThrow();
  });

  it('extends the timeline first, moves later holds first, then inserts the new hold', () => {
    const before = document();
    const after = structuredClone(before);
    after.timeline.durationFrames += 2;
    for (const frame of after.layers[0].contentFrames.slice(1)) frame.startFrame += 2;
    after.layers[0].contentFrames.splice(1, 0, { id: 'local-new-id', name: 'New', startFrame: 4, durationFrames: 2, data: {} });
    const operations = contentPatch(before, after);
    expect(operations.map(operation => [operation.op, operation.input.contentFrameId])).toEqual([
      ['set_timeline', undefined], ['update_content_frame', 'c'], ['update_content_frame', 'b'], ['add_content_frame', undefined],
    ]);
    expect(operations.at(-1)?.input).not.toHaveProperty('contentFrameId');
    for (const operation of operations) validateOperation(operation.op, 'input', operation.input);
  });

  it('deletes before moving earlier holds and shrinks the timeline last', () => {
    const before = document();
    const after = structuredClone(before);
    after.layers[0].contentFrames.shift();
    for (const frame of after.layers[0].contentFrames) frame.startFrame -= 4;
    after.timeline.durationFrames -= 4;
    expect(contentPatch(before, after).map(operation => [operation.op, operation.input.contentFrameId])).toEqual([
      ['remove_content_frame', 'a'], ['update_content_frame', 'b'], ['update_content_frame', 'c'], ['set_timeline', undefined],
    ]);
  });

  it('shrinks a hold before moving its neighbor into the released interval', () => {
    const before = document();
    const after = structuredClone(before);
    after.layers[0].contentFrames[0].durationFrames = 3;
    for (const frame of after.layers[0].contentFrames.slice(1)) frame.startFrame--;
    after.timeline.durationFrames--;
    const operations = contentPatch(before, after);
    expect(operations.map(operation => [operation.op, operation.input.contentFrameId])).toEqual([
      ['update_content_frame', 'a'], ['update_content_frame', 'b'],
      ['update_content_frame', 'c'], ['set_timeline', undefined],
    ]);
    expect(operations[0].input).toMatchObject({ durationFrames: 3 });
    for (const operation of operations) validateOperation(operation.op, 'input', operation.input);
  });

  it('rejects unsupported structure or oversized batches before anything can apply', () => {
    const before = document();
    const renamed = structuredClone(before);
    renamed.layers[0].name = 'Changed outside content';
    expect(() => contentPatch(before, renamed)).toThrow('unsupported document structure');
    const oversized = structuredClone(before);
    oversized.layers[0].contentFrames = Array.from({ length: 101 }, (_, index) => ({
      id: `new-${index}`, name: 'New', startFrame: index, durationFrames: 1, data: {},
    }));
    expect(() => contentPatch(before, oversized)).toThrow('100-operation');
    expect(contentPatch(before, before)).toEqual([]);
  });
});
