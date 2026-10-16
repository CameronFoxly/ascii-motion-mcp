import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyExactCellChanges, setBrowserCommandCallback } from '../live-sync.js';
import { getProjectManager, resetProjectManager, setEnsureFreshStateCallback } from '../state.js';
import { setLiveGeneratorCatalog } from '../generators/catalog.js';
import type { BrowserCommand, BrowserCommandApplied, BrowserCommandResult } from '../transport/websocket.js';
import { SessionDataV2Schema, type MCPGeneratorSource } from '../types.js';
import { registerLayerTools } from './layers.js';
import { registerProceduralGeneratorTools } from './procedural-generators.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;
interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function captureTools(...registers: Array<(server: McpServer) => void>): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool(name: string, ...args: unknown[]): void {
      handlers.set(name, args.at(-1) as ToolHandler);
    },
  };
  for (const register of registers) register(server as unknown as McpServer);
  return handlers;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loosely-typed JSON
type Json = Record<string, any>;
function body(response: ToolResponse): Json {
  return JSON.parse(response.content[0].text) as Json;
}

async function call(tools: Map<string, ToolHandler>, name: string, args: Record<string, unknown> = {}) {
  const response = await tools.get(name)!(args);
  return { response, data: body(response) };
}

function ok(applied?: BrowserCommandApplied): BrowserCommandResult {
  return { type: 'command_result', requestId: 'r', success: true, applied };
}

let tools: Map<string, ToolHandler>;

beforeEach(() => {
  resetProjectManager();
  setBrowserCommandCallback(null);
  setEnsureFreshStateCallback(null);
  setLiveGeneratorCatalog(null);
  const pm = getProjectManager();
  pm.newProject({ width: 40, height: 10 });
  pm.addLayer('Base');
  pm.setTimelineDuration(24);
  tools = captureTools(registerProceduralGeneratorTools, registerLayerTools);
});

afterEach(() => {
  setBrowserCommandCallback(null);
  setEnsureFreshStateCallback(null);
  setLiveGeneratorCatalog(null);
});

describe('procedural generator tools (headless)', () => {
  it('lists generator types and property details', async () => {
    const { data } = await call(tools, 'list_generator_types');
    expect(data.catalogSource).toBe('bundled');
    expect(data.generators).toHaveLength(6);

    const { data: detail } = await call(tools, 'list_generator_types', { generatorType: 'animated-text', category: 'Animation' });
    const props = detail.propertiesByCategory.Animation as Array<Record<string, unknown>>;
    expect(props.find(p => p.path === 'wave.speed')).toMatchObject({ rate: true, activeWhen: 'effect in [wave]' });
    expect(detail.creationDefaults['position.x']).toBe(18);
  });

  it('adds, edits, keyframes, and inspects a generator layer', async () => {
    const pm = getProjectManager();
    const { data: added } = await call(tools, 'add_generator_layer', {
      generatorType: 'radio-waves',
      startFrame: 2,
      durationFrames: 10,
      settings: { frequency: 99 },
    });
    expect(added.success).toBe(true);
    expect(added.browserSynced).toBe(false);
    expect(added.settings.frequency).toBe(5);
    expect(added.notes[0]).toContain('clamped');
    expect(typeof added.settings.seed).toBe('undefined');
    const layerId = added.layerId as string;
    expect(pm.getActiveLayer()?.id).toBe(layerId);

    const { data: keyed } = await call(tools, 'set_generator_keyframes', {
      layerId,
      propertyPath: 'startRotation',
      keyframes: [{ frame: 2, value: 0 }, { frame: 11, value: 90, easing: 'ease-in-out' }],
    });
    expect(keyed.keyframeIds).toHaveLength(2);
    expect(keyed.track.keyframes[1].easing).toBe('ease-in-out');

    const { data: prop } = await call(tools, 'set_generator_property', { layerId, propertyPath: 'startRotation', value: 45, frame: 6 });
    expect(prop.keyed).toBe(true);

    const { data: staticEdit } = await call(tools, 'update_generator_layer', { layerId, settings: { startRotation: 10 }, enabled: false });
    expect(staticEdit.enabled).toBe(false);
    expect(staticEdit.warnings.some((w: string) => w.includes('keyframed'))).toBe(true);

    const { data: inspected } = await call(tools, 'get_generator_layers', { layerId, frame: 6 });
    expect(inspected.resolvedSettings.startRotation).toBe(45);
    expect(inspected.tracks[0].keyframes.map((k: { frame: number }) => k.frame)).toEqual([2, 6, 11]);

    const { data: removed } = await call(tools, 'remove_generator_keyframes', { layerId, propertyPath: 'startRotation', clearTrack: true, frame: 6 });
    expect(removed.trackRemoved).toBe(true);
    expect(removed.staticValue).toBe(45);

    const { response: badPath } = await call(tools, 'set_generator_property', { layerId, propertyPath: 'nope', value: 1 });
    expect(badPath.isError).toBe(true);

    expect(pm.undo()).toBe(true);
    expect(pm.requireGeneratorLayer(layerId).generator.propertyTracks).toHaveLength(1);
  });

  it('creates animated text with a typewriter reveal', async () => {
    const { data } = await call(tools, 'add_animated_text', { text: 'Hello', effect: 'typewriter', revealFrames: 5, startFrame: 0, durationFrames: 12 });
    expect(data.success).toBe(true);
    expect(data.settings.text).toBe('Hello');
    expect(data.settings['position.x']).toBe(17);
    expect(data.settings.effect).toBe('typewriter');
    const end = data.tracks.find((t: { propertyPath: string }) => t.propertyPath === 'typewriter.end');
    expect(end.keyframes.map((k: { frame: number; value: number }) => [k.frame, k.value])).toEqual([[0, 0], [4, 100]]);

    const { data: units } = await call(tools, 'set_generator_property', { layerId: data.layerId, propertyPath: 'typewriter.units', value: 'index', frame: 0 });
    expect(units.staticValue).toBe('index');
    const { data: state } = await call(tools, 'get_generator_layers', { layerId: data.layerId, frame: 4 });
    expect(state.resolvedSettings['typewriter.end']).toBeCloseTo(5);

    const { response: seed } = await call(tools, 'randomize_generator_seed', { layerId: data.layerId });
    expect(seed.isError).toBe(true);
  });

  it('round-trips generator layers through a 2.2.0 session file', async () => {
    const { data } = await call(tools, 'add_generator_layer', { generatorType: 'digital-rain' });
    const pm = getProjectManager();
    const session = pm.toSessionDataV2();
    expect(session.version).toBe('2.2.0');
    expect(SessionDataV2Schema.safeParse(session).success).toBe(true);
    const saved = session.layers!.find(l => l.id === data.layerId)!;
    expect(saved.kind).toBe('generator');

    resetProjectManager();
    getProjectManager().loadFromSessionDataV2(JSON.parse(JSON.stringify(session)));
    const reloaded = getProjectManager().requireGeneratorLayer(data.layerId);
    expect(reloaded.generator.generatorType).toBe('digital-rain');
    expect(reloaded.generator.settings.seed).toBe(saved.generator!.settings.seed);
  });

  it('guards content-only operations on generator layers', async () => {
    const { data } = await call(tools, 'add_generator_layer', { generatorType: 'turbulent-noise' });
    await expect(applyExactCellChanges({ cells: [{ x: 0, y: 0, cell: { char: 'A', color: '#FFFFFF', bgColor: 'transparent' } }] }))
      .rejects.toThrow(/generator layer/);
    const { response } = await call(tools, 'add_content_frame', { layerId: data.layerId, startFrame: 0, durationFrames: 1 });
    expect(response.isError).toBe(true);
    const { data: layers } = await call(tools, 'get_layers');
    expect(layers.layers.find((l: { id: string }) => l.id === data.layerId).kind).toBe('generator');

    const pm = getProjectManager();
    const dup = pm.duplicateLayer(data.layerId)!;
    expect(dup.generator!.id).not.toBe(pm.requireGeneratorLayer(data.layerId).generator.id);
  });

  it('render and bake require a live browser', async () => {
    const { data } = await call(tools, 'add_generator_layer', { generatorType: 'rain-drops' });
    for (const name of ['render_generator_frames', 'bake_generator_layer']) {
      const { response, data: err } = await call(tools, name, { layerId: data.layerId });
      expect(response.isError).toBe(true);
      expect(err.error).toContain('live Ascii-Motion');
    }
  });
});

describe('procedural generator tools (live)', () => {
  function liveSource(overrides: Partial<MCPGeneratorSource> = {}): MCPGeneratorSource {
    return {
      id: 'gen-live',
      generatorType: 'radio-waves',
      startFrame: 0,
      durationFrames: 12,
      enabled: true,
      settings: { frequency: 2 },
      propertyTracks: [],
      ...overrides,
    };
  }

  it('sends commands and adopts the browser result', async () => {
    const commands: BrowserCommand[] = [];
    const layer = {
      id: 'layer-live', name: 'Radio Waves', visible: true, solo: false, locked: false, opacity: 100,
      kind: 'generator', generator: liveSource(), contentFrames: [], propertyTracks: [],
    };
    setEnsureFreshStateCallback(async () => true);
    setBrowserCommandCallback(async (command) => {
      commands.push(command);
      switch (command.type) {
        case 'add_generator_layer':
          return ok({ layerId: 'layer-live', layer, generator: layer.generator });
        case 'set_generator_keyframes':
          return ok({
            layerId: 'layer-live',
            trackId: 'track-1',
            keyframeIds: ['kf-1'],
            generator: liveSource({
              propertyTracks: [{ id: 'track-1', propertyPath: 'frequency', loopKeyframes: false, keyframes: [{ id: 'kf-1', frame: 3, value: 4, easing: { type: 'ease-in' } }] }],
            }),
          });
        case 'render_generator_frames':
          return ok({ generatorFrames: [{ frame: 3, inRange: true, text: ['ab', 'cd'], cellCount: 4 }] });
        default:
          throw new Error(`unexpected ${command.type}`);
      }
    });

    const { data: added } = await call(tools, 'add_generator_layer', { generatorType: 'radio-waves', settings: { frequency: 2 } });
    expect(added.browserSynced).toBe(true);
    expect(added.layerId).toBe('layer-live');
    expect(commands[0]).toEqual({ type: 'add_generator_layer', generatorType: 'radio-waves', settings: { frequency: 2 } });

    const { data: keyed } = await call(tools, 'set_generator_keyframes', {
      layerId: 'layer-live', propertyPath: 'frequency', keyframes: [{ frame: 3, value: 4, easing: 'ease-in' }],
    });
    expect(commands[1]).toEqual({
      type: 'set_generator_keyframes', layerId: 'layer-live', propertyPath: 'frequency',
      keyframes: [{ frame: 3, value: 4, easing: { type: 'ease-in' } }],
    });
    expect(keyed.trackId).toBe('track-1');
    expect(getProjectManager().requireGeneratorLayer('layer-live').generator.propertyTracks).toHaveLength(1);

    const { data: rendered } = await call(tools, 'render_generator_frames', { layerId: 'layer-live', frames: [3] });
    expect(rendered.frames[0].text).toBe('ab\ncd');
  });

  it('maps unsupported commands to an update hint', async () => {
    setBrowserCommandCallback(async (command) => ({
      type: 'command_result', requestId: 'r', success: false, error: `Unsupported browser command: ${command.type}`,
    }));
    const { response, data } = await call(tools, 'add_generator_layer', { generatorType: 'radio-waves' });
    expect(response.isError).toBe(true);
    expect(data.error).toContain('Update Ascii-Motion');

    const { data: list } = await call(tools, 'list_generator_types');
    expect(list.catalogSource).toBe('bundled');
    expect(list.warning).toContain('Update Ascii-Motion');
  });
});
