import { z } from 'zod';
import { McpServer } from '../mcp.js';
import { getProjectManager } from '../state.js';
import { executeBridgeOperation, isBrowserBridgeConfigured } from '../bridge.js';
import { DEFAULT_RESPONSE_BYTES, storeArtifact } from '../artifacts.js';
import { registerGuideResources } from './guide.js';

export function registerResources(server: McpServer): void {
  function register(
    name: string, uri: string, description: string,
    local: () => unknown, live: () => Promise<unknown>, mimeType = 'application/json',
  ) {
    server.resource(name, uri, { description, mimeType }, async () => {
      const data = await (isBrowserBridgeConfigured() ? live() : local());
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      const response = { contents: [{ uri, mimeType, text }] };
      if (Buffer.byteLength(JSON.stringify(response)) <= DEFAULT_RESPONSE_BYTES) return response;
      const artifact = await storeArtifact(text, `${name}.${mimeType === 'text/plain' ? 'txt' : 'json'}`, mimeType);
      return { contents: [{
        uri, mimeType: 'application/json',
        text: JSON.stringify({
          inline: false, artifact,
          read: { tool: 'read_artifact', artifactId: artifact.id, offset: 0, length: 4096 },
        }),
      }] };
    });
  }

  register('project-state', 'project://state',
    'Compact authoritative document summary. Use get_document for the complete native session.',
    () => {
      const pm = getProjectManager();
      const state = pm.getState();
      return {
        name: state.name, description: state.description,
        width: state.width, height: state.height, backgroundColor: state.backgroundColor,
        isLayerMode: pm.isLayerMode(), frameCount: state.frames.length,
        currentFrameIndex: state.currentFrameIndex, isDirty: state.isDirty,
        toolState: state.toolState, hasSelection: state.selection !== null,
        layerCount: state.layers.length, activeLayerId: state.activeLayerId,
        timeline: state.timelineConfig, groupCount: state.layerGroups.length,
      };
    },
    () => executeBridgeOperation('get_document_summary', {}));

  register('project-canvas', 'project://canvas',
    'Current timeline-frame cells; live reads use the compositor. Large results become paged artifacts.',
    () => {
      const pm = getProjectManager();
      const state = pm.getState();
      const frame = pm.getFrameAtTime(state.currentFrameIndex);
      return {
        frameIndex: state.currentFrameIndex, frameName: frame?.name,
        width: state.width, height: state.height,
        cellCount: Object.keys(frame?.data ?? {}).length, data: frame?.data ?? {},
      };
    },
    () => executeBridgeOperation('read_cells', { scope: 'composite', format: 'cells' }));

  register('project-frames', 'project://frames',
    'Content-frame metadata. Content-frame ordinals are not timeline positions.',
    () => {
      const state = getProjectManager().getState();
      return {
        frameCount: state.frames.length, currentFrameIndex: state.currentFrameIndex,
        totalDuration: state.frames.reduce((sum, frame) => sum + frame.duration, 0),
        frames: state.frames.map((frame, index) => ({
          index, id: frame.id, name: frame.name, duration: frame.duration,
          cellCount: Object.keys(frame.data).length,
        })),
      };
    },
    async () => {
      const summary = await executeBridgeOperation('get_document_summary', {});
      const layers = z.array(z.object({ id: z.string(), contentFrames: z.array(z.unknown()) })).parse(summary.layers);
      return { timeline: summary.timeline, activeLayerId: summary.activeLayerId, layers };
    });

  register('project-selection', 'project://selection',
    'Current authoritative selection and clipboard summary.',
    () => {
      const selection = getProjectManager().getState().selection;
      return { hasSelection: selection !== null, selection };
    },
    () => executeBridgeOperation('get_selection', {}));

  register('project-history', 'project://history',
    'Actual undo/redo history status.',
    () => getProjectManager().getHistoryInfo(),
    () => executeBridgeOperation('get_history', {}));

  register('project-ascii', 'project://ascii',
    'Plain text at the current timeline frame; composited in live mode.',
    () => {
      const pm = getProjectManager();
      const state = pm.getState();
      const frame = pm.getFrameAtTime(state.currentFrameIndex);
      const lines = Array.from({ length: state.height }, (_, y) =>
        Array.from({ length: state.width }, (_, x) => frame?.data[`${x},${y}`]?.char ?? ' ').join('').trimEnd());
      while (lines.length && !lines.at(-1)) lines.pop();
      return lines.join('\n') || '(empty canvas)';
    },
    async () => {
      const result = await executeBridgeOperation('read_cells', { scope: 'composite', format: 'text' });
      return z.array(z.string()).parse(result.text).join('\n');
    }, 'text/plain');

  register('project-layers', 'project://layers',
    'Layer, group, timeline and procedural-block structure.',
    () => {
      const state = getProjectManager().getState();
      return {
        activeLayerId: state.activeLayerId, currentFrame: state.currentFrameIndex,
        timeline: state.timelineConfig,
        layers: state.layers.map(layer => ({
          id: layer.id, name: layer.name, visible: layer.visible, solo: layer.solo,
          locked: layer.locked, opacity: layer.opacity, parentGroupId: layer.parentGroupId,
          contentFrames: layer.contentFrames.map(({ data, ...frame }) => ({
            ...frame, cellCount: Object.keys(data).length,
          })),
          propertyTracks: layer.propertyTracks.map(({ keyframes, ...track }) => ({
            ...track, keyframeCount: keyframes.length,
          })),
          effectTracks: layer.effectTracks, generator: layer.generator,
        })),
        groups: state.layerGroups,
      };
    },
    async () => {
      const summary = await executeBridgeOperation('get_document_summary', {});
      return {
        activeLayerId: summary.activeLayerId, timeline: summary.timeline,
        layers: summary.layers, groups: summary.groups, effects: summary.effects, shaders: summary.shaders,
      };
    });

  registerGuideResources(server);
}
