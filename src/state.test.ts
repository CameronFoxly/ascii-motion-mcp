import { describe, expect, it } from 'vitest';
import { ProjectStateManager } from './state.js';
import { detectSessionVersion, SessionDataV2Schema } from './types.js';

const cell = (char: string) => ({ char, color: '#FFFFFF', bgColor: 'transparent' });
function document() {
  return SessionDataV2Schema.parse({
    version: '2.2.0', name: 'Native', description: 'Preserve me', metadata: { extension: 'preserved' },
    canvas: { width: 8, height: 4, canvasBackgroundColor: '#000000', showGrid: false, extension: 1 },
    timeline: { frameRate: 10, durationFrames: 10, looping: false, workArea: { start: 1, end: 8 } },
    typography: { fontId: 'ibm-vga', fontSize: 48, characterSpacing: -1, lineSpacing: 2 },
    palettes: [{ id: 'p1', colors: ['#FFFFFF'] }],
    characterPalettes: [{ id: 'c1', characters: ['A'] }],
    shaderEffects: [{ id: 's1', shaderType: 'glow', settings: { intensity: 2 }, propertyTracks: [] }],
    extension: { nested: true },
    layers: [{
      id: 'l1', name: 'Held frames', extension: true,
      contentFrames: [
        { id: 'a', name: 'A', startFrame: 0, durationFrames: 4, data: { '0,0': cell('A') }, labelColor: '#123456', extension: 2 },
        { id: 'b', name: 'B', startFrame: 6, durationFrames: 2, data: { '7,3': cell('B') } },
      ],
      propertyTracks: [{
        id: 't1', propertyPath: 'transform.position.x', extension: 3,
        keyframes: [{ id: 'k1', frame: 0, value: 1, easing: { type: 'linear', extension: 4 }, extension: 5 }],
      }],
      effectTracks: [{
        id: 'e1', ownerId: 'l1', extension: 6, effectBlock: {
          id: 'block1', effectType: 'motion-trails', startFrame: 0, durationFrames: 10,
          settings: { length: 4 }, propertyTracks: [], extension: 7,
        },
      }],
    }, {
      id: 'l2', name: 'Second', contentFrames: [
        { id: 'c', name: 'C', startFrame: 0, durationFrames: 10, data: { '7,3': cell('C') } },
      ], propertyTracks: [],
    }],
    layerGroups: [{
      id: 'g1', name: 'Group', childLayerIds: ['l1'], extension: 8,
      propertyTracks: [{
        id: 'gt', propertyPath: 'transform.scale.x', extension: 9,
        keyframes: [{ id: 'gk', frame: 0, value: 1, easing: { type: 'linear' }, extension: 10 }],
      }],
    }],
  });
}

describe('canonical native document state', () => {
  it('resolves holds, gaps and timeline bounds independently of content ordinals', () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    expect(pm.getFrameAtTime(3).data['0,0'].char).toBe('A');
    expect(pm.getFrameAtTime(5).data).toEqual({});
    expect(pm.getFrameAtTime(7).data['7,3'].char).toBe('B');
    expect(() => pm.getFrameAtTime(10)).toThrow('out of range');
    expect(pm.getState().currentFrameIndex).toBe(0);
  });

  it('links legacy frame views to canonical content, rather than copying their metadata/data', () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    const frame = pm.getState().frames[1];
    frame.name = 'Renamed';
    frame.duration = 300;
    frame.data = { '1,1': cell('Z') };
    const saved = pm.toSessionDataV2().layers[0].contentFrames[1];
    expect(saved).toMatchObject({ name: 'Renamed', durationFrames: 3, data: { '1,1': cell('Z') } });
  });

  it('preserves native effects, shaders, palettes, typography, labels and additive fields', () => {
    const pm = new ProjectStateManager();
    const original = document();
    pm.loadFromSessionDataV2(original);
    pm.setCell(1, 0, cell('Z'));
    const saved = pm.toSessionDataV2();
    expect(saved).toMatchObject(original);
    expect(saved.layers[0].contentFrames[0].data?.['1,0']).toEqual(cell('Z'));
    expect(saved.layerGroups?.[0].propertyTracks?.[0].keyframes[0].extension).toBe(10);
  });

  it('does not let the legacy canvas projection overwrite an authoritative document', () => {
    const pm = new ProjectStateManager();
    pm.loadFromBrowserSnapshot({
      document: document(), activeLayerId: 'l2', currentFrame: 7,
      canvas: { width: 8, height: 4, cells: { '0,0': cell('WRONG') } },
    });
    expect(pm.hasCompleteBrowserDocument()).toBe(true);
    expect(pm.getState().activeLayerId).toBe('l2');
    expect(pm.getCurrentFrame().data['7,3'].char).toBe('C');
    expect(pm.toSessionDataV2().layers[1].contentFrames[0].data?.['0,0']).toBeUndefined();
  });

  it('rejects malformed snapshots without changing the document', () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    const before = pm.toSessionDataV2();
    expect(() => pm.loadFromBrowserSnapshot({})).toThrow();
    expect(() => pm.loadFromBrowserSnapshot({ document: { version: '2.2.0' } })).toThrow();
    expect(pm.toSessionDataV2()).toEqual(before);
  });

  it('accepts an explicit empty legacy layer list instead of retaining old layers', () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    pm.loadFromBrowserSnapshot({ layers: [], layerGroups: [], globalEffects: [] });
    expect(pm.getState().layers).toEqual([]);
    expect(pm.getState().layerGroups).toEqual([]);
    expect(pm.getState().globalEffects).toEqual([]);
    expect(pm.hasCompleteBrowserDocument()).toBe(false);
  });

  it('keeps empty native documents in layer mode without inventing a legacy frame cache', () => {
    const native = document();
    native.layers = [];
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(native);
    expect(pm.isLayerMode()).toBe(true);
    expect(pm.getFrameAtTime(7).data).toEqual({});
    expect(() => pm.setCell(0, 0, cell('X'))).toThrow('No active layer');
    pm.addLayer('First real layer');
    expect(pm.getState().layers).toHaveLength(1);
    expect(pm.toSessionDataV2().extension).toEqual({ nested: true });
  });

  it('inserts and duplicates canonical frames without overwriting held content', () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    pm.addFrame(1, { '1,0': cell('X') }, 200);
    expect(pm.getState().layers[0].contentFrames.map(frame => frame.startFrame)).toEqual([0, 6, 8]);
    expect(pm.getFrameAtTime(3).data['0,0'].char).toBe('A');
    expect(pm.undo()).toBe(true);
    expect(pm.getState().layers[0].contentFrames.map(frame => frame.id)).toEqual(['a', 'b']);
    expect(pm.redo()).toBe(true);
    expect(pm.getState().layers[0].contentFrames[1].data['1,0'].char).toBe('X');
    const duplicate = pm.duplicateFrame(0)!;
    expect(duplicate.data['0,0'].char).toBe('A');
    duplicate.data['0,0'] = cell('D');
    expect(pm.getState().layers[0].contentFrames[0].data['0,0'].char).toBe('A');
  });

  it('resizes and restores every layer, not only the active content-frame view', () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    pm.resizeCanvas(4, 4);
    expect(pm.getState().layers[1].contentFrames[0].data).toEqual({});
    expect(pm.undo()).toBe(true);
    expect(pm.getState().layers[1].contentFrames[0].data['7,3'].char).toBe('C');
    expect(pm.getState().width).toBe(8);
    expect(pm.redo()).toBe(true);
    expect(pm.getState().layers[1].contentFrames[0].data).toEqual({});
  });

  it('ripples active-layer holds without truncating the other layers timeline', () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    const before = pm.toSessionDataV2();
    expect(pm.setFrameDuration(0, 200)).toBe(true);
    const after = pm.toSessionDataV2();
    expect(after.layers[0].contentFrames.map(frame => [frame.startFrame, frame.durationFrames])).toEqual([[0, 2], [4, 2]]);
    expect(after.timeline.durationFrames).toBe(10);
    expect(after.layers[1]).toEqual(before.layers[1]);
    expect(pm.undo()).toBe(true);
    expect(pm.toSessionDataV2()).toEqual(before);
  });

  it('retains existing legacy artwork and timing when the first layer is added', () => {
    const pm = new ProjectStateManager();
    pm.setCell(0, 0, cell('A'));
    pm.addFrame(undefined, { '1,0': cell('B') }, 300);
    pm.addLayer('New layer');
    expect(pm.getState().layers).toHaveLength(2);
    const migrated = pm.getState().layers[0];
    expect(migrated.contentFrames[0].data['0,0'].char).toBe('A');
    expect(migrated.contentFrames[1].data['1,0'].char).toBe('B');
    expect(migrated.contentFrames[1].startFrame).toBe(1);
    expect(migrated.contentFrames[1].durationFrames).toBe(4);
  });

  it('does not mistake a future layered format with a gallery cache for a legacy session', () => {
    expect(detectSessionVersion({ version: '3.0.0', layers: [], animation: { frames: [] } })).toBe('unknown');
    expect(detectSessionVersion({ version: '9.0.0', animation: { frames: [] } })).toBe('unknown');
  });

  it('rejects missing/locked cell targets without creating holds or recording history', () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    pm.goToFrame(5);
    expect(() => pm.setCell(0, 0, cell('X'))).toThrow('No content frame');
    expect(() => pm.clearCanvas()).toThrow('No content frame');
    expect(() => pm.setCellsAtTimelineFrame(5, [{ x: 0, y: 0, cell: cell('X') }])).toThrow('No content frame');
    expect(pm.getState().layers[0].contentFrames).toHaveLength(2);
    expect(pm.canUndo()).toBe(false);
    pm.getState().layers[0].locked = true;
    expect(() => pm.setCellsOnFrame(0, [{ x: 0, y: 0, cell: cell('X') }])).toThrow('locked');
    expect(pm.canUndo()).toBe(false);
  });

  it('groups nested headless edits into one reversible transaction', async () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    const before = pm.toSessionDataV2();
    await pm.transaction('Batch cells', async () => {
      pm.setCell(1, 0, cell('X'));
      pm.setCell(2, 0, cell('Y'));
      return { success: true };
    }, () => false);
    expect(pm.getState().historyStack).toHaveLength(1);
    expect(pm.undo()).toBe(true);
    expect(pm.toSessionDataV2()).toEqual(before);
    expect(pm.redo()).toBe(true);
    expect(pm.toSessionDataV2().layers[0].contentFrames[0].data?.['2,0']).toEqual(cell('Y'));
    expect(pm.undo()).toBe(true);
    expect(pm.toSessionDataV2()).toEqual(before);
  });

  it('rolls back thrown and explicit failures while preserving redo history and selection', async () => {
    const pm = new ProjectStateManager();
    pm.loadFromSessionDataV2(document());
    await pm.transaction('Successful', async () => pm.setCell(1, 0, cell('X')), () => false);
    pm.undo();
    const before = pm.toSessionDataV2();
    const history = pm.getHistoryInfo();
    const result = await pm.transaction('Failure', async () => {
      pm.setCell(2, 0, cell('Y'));
      return { isError: true };
    }, result => result.isError);
    expect(result.isError).toBe(true);
    expect(pm.toSessionDataV2()).toEqual(before);
    expect(pm.getHistoryInfo()).toEqual(history);
    await expect(pm.transaction('Exception', async () => {
      pm.resizeCanvas(4, 4);
      throw new Error('rejected');
    }, () => false)).rejects.toThrow('rejected');
    expect(pm.toSessionDataV2()).toEqual(before);
    expect(pm.redo()).toBe(true);
    expect(pm.getCurrentFrame().data['1,0']).toEqual(cell('X'));
  });
});
