import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyExactCellChanges,
  setBrowserCommandCallback,
} from '../live-sync.js';
import {
  getProjectManager,
  resetProjectManager,
  setEnsureFreshStateCallback,
} from '../state.js';
import type {
  BrowserCommand,
  BrowserCommandApplied,
  BrowserCommandResult,
} from '../transport/websocket.js';
import { registerCanvasTools } from './canvas.js';
import { registerFrameTools } from './frames.js';
import { registerImportTools } from './import.js';
import { registerLayerTools } from './layers.js';
import { registerProjectTools } from './project.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function captureTools(register: (server: McpServer) => void): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool(name: string, ...args: unknown[]): void {
      handlers.set(name, args.at(-1) as ToolHandler);
    },
  };
  register(server as unknown as McpServer);
  return handlers;
}

function result(applied?: BrowserCommandApplied): BrowserCommandResult {
  return {
    type: 'command_result',
    requestId: 'test-request',
    success: true,
    applied,
  };
}

function responseBody(response: ToolResponse): Record<string, unknown> {
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

const v1Project = {
  version: '1.0.0',
  name: 'Legacy Project',
  canvas: {
    width: 8,
    height: 4,
    canvasBackgroundColor: '#000000',
    showGrid: true,
  },
  animation: {
    frames: [
      {
        id: 'legacy-1',
        name: 'One',
        duration: 100,
        data: {
          '0,0': { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
        },
      },
      {
        id: 'legacy-2',
        name: 'Two',
        duration: 200,
        data: {},
      },
    ],
    currentFrameIndex: 0,
    frameRate: 10,
    looping: true,
  },
};

const v2Project = {
  version: '2.0.0' as const,
  name: 'Timeline Project',
  canvas: {
    width: 8,
    height: 4,
    canvasBackgroundColor: '#000000',
    showGrid: true,
  },
  timeline: {
    frameRate: 10,
    durationFrames: 2,
    looping: true,
  },
  layers: [{
    id: 'layer-1',
    name: 'Layer 1',
    visible: true,
    solo: false,
    locked: false,
    opacity: 100,
    contentFrames: [
      {
        id: 'content-1',
        name: 'One',
        startFrame: 0,
        durationFrames: 1,
        data: {
          '0,0': { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
        },
      },
      {
        id: 'content-2',
        name: 'Two',
        startFrame: 1,
        durationFrames: 1,
        data: {},
      },
    ],
    propertyTracks: [],
  }],
  globalEffects: [{
    id: 'effect-track-1',
    ownerId: null,
    effectBlock: {
      id: 'effect-block-1',
      effectType: 'wiggle',
      startFrame: 0,
      durationFrames: 2,
      enabled: true,
      settings: {},
      propertyTracks: [],
    },
  }],
};

describe('acknowledged live tools', () => {
  let projectDir: string;
  let previousProjectDir: string | undefined;

  beforeEach(async () => {
    resetProjectManager();
    setBrowserCommandCallback(null);
    setEnsureFreshStateCallback(null);
    previousProjectDir = process.env.ASCII_MOTION_PROJECT_DIR;
    projectDir = await mkdtemp(join(tmpdir(), 'ascii-motion-mcp-test-'));
    process.env.ASCII_MOTION_PROJECT_DIR = projectDir;
  });

  afterEach(async () => {
    setBrowserCommandCallback(null);
    setEnsureFreshStateCallback(null);
    if (previousProjectDir === undefined) {
      delete process.env.ASCII_MOTION_PROJECT_DIR;
    } else {
      process.env.ASCII_MOTION_PROJECT_DIR = previousProjectDir;
    }
    await rm(projectDir, { recursive: true, force: true });
  });

  it('applies exact cells locally and reports local-only mode truthfully', async () => {
    const applied = await applyExactCellChanges({
      cells: [{
        x: 1,
        y: 1,
        cell: { char: 'L', color: '#FFFFFF', bgColor: 'transparent' },
      }],
    });

    expect(applied).toMatchObject({
      browserSynced: false,
      frameIndex: 0,
      cellsChanged: 1,
    });
    expect(getProjectManager().getCell(1, 1).char).toBe('L');
  });

  it('imports ASCII as one acknowledged exact batch on the requested frame', async () => {
    await writeFile(join(projectDir, 'art.txt'), 'A B', 'utf8');
    const pm = getProjectManager();
    pm.addFrame();
    let command: BrowserCommand | undefined;
    setEnsureFreshStateCallback(async () => true);
    setBrowserCommandCallback(async nextCommand => {
      command = nextCommand;
      return result({ currentFrameIndex: 1, cellsChanged: 2 });
    });

    const handler = captureTools(registerImportTools).get('import_ascii_text')!;
    const response = await handler({
      filePath: 'art.txt',
      frameIndex: 1,
      offsetX: 2,
      offsetY: 1,
      color: '#FFFFFF',
      bgColor: 'transparent',
      replaceSpaces: false,
    });

    expect(command).toEqual({
      type: 'set_cells_batch',
      frameIndex: 1,
      cells: [
        {
          x: 2,
          y: 1,
          cell: { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
        },
        {
          x: 4,
          y: 1,
          cell: { char: 'B', color: '#FFFFFF', bgColor: 'transparent' },
        },
      ],
    });
    expect(pm.getState().frames[0].data).toEqual({});
    expect(pm.getState().frames[1].data).toMatchObject({
      '2,1': { char: 'A' },
      '4,1': { char: 'B' },
    });
    expect(responseBody(response)).toMatchObject({
      success: true,
      browserSynced: true,
      frameIndex: 1,
      cellsSet: 2,
    });
  });

  it('targets an explicit layer timeline frame without navigating locally', async () => {
    const pm = getProjectManager();
    pm.loadFromUnknownSessionData(v2Project);
    let command: BrowserCommand | undefined;
    setBrowserCommandCallback(async nextCommand => {
      command = nextCommand;
      expect(pm.getState().currentFrameIndex).toBe(0);
      return result({ currentFrameIndex: 1, cellsChanged: 1 });
    });

    const applied = await applyExactCellChanges({
      projectManager: pm,
      frameIndex: 1,
      cells: [{
        x: 2,
        y: 1,
        cell: { char: 'T', color: '#FFFFFF', bgColor: 'transparent' },
      }],
    });

    expect(command).toMatchObject({
      type: 'set_cells_batch',
      frameIndex: 1,
    });
    expect(pm.getState().currentFrameIndex).toBe(0);
    expect(pm.getState().layers[0].contentFrames[0].data).not.toHaveProperty('2,1');
    expect(pm.getState().layers[0].contentFrames[1].data).toMatchObject({
      '2,1': { char: 'T' },
    });
    expect(applied).toMatchObject({
      browserSynced: true,
      frameIndex: 1,
      cellsChanged: 1,
    });
  });

  it('refreshes fill state first and sends exact empty cells for clear operations', async () => {
    const pm = getProjectManager();
    let refreshed = false;
    let command: BrowserCommand | undefined;
    setEnsureFreshStateCallback(async () => {
      refreshed = true;
      pm.setCells([
        {
          x: 0,
          y: 0,
          cell: { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
        },
        {
          x: 1,
          y: 0,
          cell: { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
        },
      ]);
      return true;
    });
    setBrowserCommandCallback(async nextCommand => {
      expect(refreshed).toBe(true);
      command = nextCommand;
      return result({ currentFrameIndex: 0, cellsChanged: 2 });
    });

    const handler = captureTools(registerCanvasTools).get('fill_region')!;
    const response = await handler({
      x: 0,
      y: 0,
      char: ' ',
      color: '#FFFFFF',
      bgColor: 'transparent',
      contiguous: true,
      matchChar: true,
      matchColor: false,
      matchBgColor: false,
    });

    expect(command).toEqual({
      type: 'set_cells_batch',
      frameIndex: 0,
      cells: [
        {
          x: 0,
          y: 0,
          cell: { char: ' ', color: '#FFFFFF', bgColor: 'transparent' },
        },
        {
          x: 1,
          y: 0,
          cell: { char: ' ', color: '#FFFFFF', bgColor: 'transparent' },
        },
      ],
    });
    expect(pm.getState().frames[0].data).toEqual({});
    expect(responseBody(response)).toMatchObject({
      success: true,
      browserSynced: true,
      cellsFilled: 2,
    });
  });

  it('changes FPS without changing frame count or timeline duration', async () => {
    const pm = getProjectManager();
    pm.loadFromUnknownSessionData(v2Project);
    const durationFrames = pm.getState().timelineConfig.durationFrames;
    const frameCount = pm.getState().frames.length;
    let command: BrowserCommand | undefined;
    setBrowserCommandCallback(async nextCommand => {
      command = nextCommand;
      return result({ frameRate: 24 });
    });

    const handler = captureTools(registerLayerTools).get('set_frame_rate')!;
    const response = await handler({ fps: 30 });

    expect(command).toEqual({
      type: 'set_frame_rate',
      fps: 30,
      preserveFrameCount: true,
    });
    expect(pm.getState().timelineConfig).toEqual({
      frameRate: 24,
      durationFrames,
    });
    expect(pm.getState().frames).toHaveLength(frameCount);
    expect(pm.getState().frames.map(frame => frame.duration)).toEqual([
      1000 / 24,
      1000 / 24,
    ]);
    expect(responseBody(response)).toMatchObject({
      success: true,
      browserSynced: true,
      previousFrameRate: 10,
      frameRate: 24,
      durationFrames,
    });
  });

  it('uses the acknowledged duration and reconciles layer timeline reflow', async () => {
    const pm = getProjectManager();
    pm.loadFromUnknownSessionData(v2Project);
    let command: BrowserCommand | undefined;
    setBrowserCommandCallback(async nextCommand => {
      command = nextCommand;
      return result({ currentFrameIndex: 1, durationMs: 250 });
    });

    const handler = captureTools(registerFrameTools).get('set_frame_duration')!;
    const response = await handler({ index: 0, duration: 208 });
    const state = pm.getState();

    expect(command).toEqual({
      type: 'set_frame_duration',
      index: 0,
      duration: 208,
    });
    expect(state.frames[0].duration).toBe(250);
    expect(state.layers[0].contentFrames[0].durationFrames).toBe(3);
    expect(state.layers[0].contentFrames[1].startFrame).toBe(3);
    expect(state.timelineConfig.durationFrames).toBe(4);
    expect(state.currentFrameIndex).toBe(1);
    expect(responseBody(response)).toMatchObject({
      success: true,
      browserSynced: true,
      requestedDuration: 208,
      newDuration: 250,
      currentFrameIndex: 1,
    });
  });

  it('surfaces duration rejection without mutating local state', async () => {
    const pm = getProjectManager();
    const previousDuration = pm.getState().frames[0].duration;
    setBrowserCommandCallback(async () => ({
      type: 'command_result',
      requestId: 'test-request',
      success: false,
      error: 'Duration reflow rejected',
    }));

    const handler = captureTools(registerFrameTools).get('set_frame_duration')!;
    const response = await handler({ index: 0, duration: 208 });

    expect(response.isError).toBe(true);
    expect(responseBody(response)).toEqual({
      success: false,
      error: 'Duration reflow rejected',
    });
    expect(pm.getState().frames[0].duration).toBe(previousDuration);
  });

  it('stores a browser-quantized duration exactly even when it is below the request minimum', async () => {
    const pm = getProjectManager();
    const quantizedDuration = 1000 / 120;
    setBrowserCommandCallback(async () => result({ durationMs: quantizedDuration }));

    const handler = captureTools(registerFrameTools).get('set_frame_duration')!;
    const response = await handler({ index: 0, duration: 10 });

    expect(pm.getState().frames[0].duration).toBe(quantizedDuration);
    expect(responseBody(response)).toMatchObject({
      success: true,
      requestedDuration: 10,
      newDuration: quantizedDuration,
    });
  });

  it('loads and acknowledges the full v1 project payload', async () => {
    await writeFile(
      join(projectDir, 'legacy.asciimtn'),
      JSON.stringify(v1Project),
      'utf8',
    );
    let command: BrowserCommand | undefined;
    setBrowserCommandCallback(async (nextCommand, _timeoutMs, afterAcknowledged) => {
      command = nextCommand;
      expect(getProjectManager().getState().name).toBe('Untitled Project');
      const commandResult = result({ currentFrameIndex: 1 });
      await afterAcknowledged?.(commandResult);
      return commandResult;
    });
    setEnsureFreshStateCallback(async () => true);

    const handler = captureTools(registerProjectTools).get('load_project')!;
    const response = await handler({ filePath: 'legacy.asciimtn' });

    expect(command).toEqual({
      type: 'load_project',
      sessionData: v1Project,
    });
    expect(getProjectManager().getState()).toMatchObject({
      name: 'Legacy Project',
      currentFrameIndex: 1,
      frameRate: 10,
    });
    expect(getProjectManager().getState().frames).toHaveLength(2);
    expect(responseBody(response)).toMatchObject({
      success: true,
      browserSynced: true,
      project: {
        name: 'Legacy Project',
        frames: 2,
        totalDuration: 300,
      },
    });
  });

  it('loads and acknowledges the full v2 project payload', async () => {
    await writeFile(
      join(projectDir, 'timeline.asciimtn'),
      JSON.stringify(v2Project),
      'utf8',
    );
    let command: BrowserCommand | undefined;
    setBrowserCommandCallback(async (nextCommand, _timeoutMs, afterAcknowledged) => {
      command = nextCommand;
      const commandResult = result({ currentFrameIndex: 0, frameRate: 10 });
      await afterAcknowledged?.(commandResult);
      return commandResult;
    });
    setEnsureFreshStateCallback(async () => true);

    const handler = captureTools(registerProjectTools).get('load_project')!;
    const response = await handler({ filePath: 'timeline.asciimtn' });
    const state = getProjectManager().getState();

    expect(command).toEqual({
      type: 'load_project',
      sessionData: v2Project,
    });
    expect(state.name).toBe('Timeline Project');
    expect(state.layers).toHaveLength(1);
    expect(state.globalEffects).toHaveLength(1);
    expect(state.frames).toHaveLength(2);
    expect(state.timelineConfig).toEqual({
      frameRate: 10,
      durationFrames: 2,
    });
    expect(responseBody(response)).toMatchObject({
      success: true,
      browserSynced: true,
      project: {
        name: 'Timeline Project',
        frames: 2,
        totalDuration: 200,
      },
    });
    expect(getProjectManager().toSessionDataV2().globalEffects).toEqual(
      v2Project.globalEffects,
    );
  });

  it('reports when the browser committed a load but final reconciliation failed', async () => {
    await writeFile(
      join(projectDir, 'reconcile-failure.asciimtn'),
      JSON.stringify(v1Project),
      'utf8',
    );
    setEnsureFreshStateCallback(async () => false);
    setBrowserCommandCallback(async (_command, _timeoutMs, afterAcknowledged) => {
      const commandResult = result({ currentFrameIndex: 0 });
      await afterAcknowledged?.(commandResult);
      return commandResult;
    });

    const handler = captureTools(registerProjectTools).get('load_project')!;
    const response = await handler({ filePath: 'reconcile-failure.asciimtn' });

    expect(response.isError).toBe(true);
    expect(responseBody(response)).toEqual({
      success: false,
      browserApplied: true,
      stateReconciled: false,
      error: 'Failed to load: No browser connected or state refresh timed out',
    });
    expect(getProjectManager().getState().name).toBe('Legacy Project');
  });

  it('saves a loaded v2 project without downgrading or dropping effects', async () => {
    const pm = getProjectManager();
    pm.loadFromUnknownSessionData(v2Project);
    const handler = captureTools(registerProjectTools).get('save_project')!;

    const response = await handler({ filePath: 'saved-timeline.asciimtn' });
    const saved = JSON.parse(
      await readFile(join(projectDir, 'saved-timeline.asciimtn'), 'utf8'),
    ) as Record<string, unknown>;

    expect(responseBody(response)).toMatchObject({ success: true });
    expect(saved.version).toBe('2.0.0');
    expect(saved.globalEffects).toEqual(v2Project.globalEffects);
  });
});
