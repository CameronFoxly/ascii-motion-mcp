/**
 * Procedural Generator Layer Tools
 *
 * Ascii-Motion 2.2.0+ generators are live, keyframeable layers: a generator
 * source (type + static settings + keyframed property tracks + visible span)
 * renders every frame on demand instead of baking cells.
 *
 * Live mode is browser-first: every edit is sent as an acknowledged browser
 * command (recorded in the app's undo history) and the MCP mirror adopts the
 * browser's resulting source. Headless mode edits the same data with ports of
 * the app's store actions so saved .asciimtn files open identically in the app.
 * Rendering generator pixels requires the browser (generator engines live
 * in the app).
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager, ensureFreshBrowserState } from '../state.js';
import { hasBrowserCommandCallback, requestBrowserCommand, requireFreshBrowserState } from '../live-sync.js';
import type { BrowserCommand, BrowserCommandApplied } from '../transport/websocket.js';
import {
  EasingCurveSchema,
  type MCPEffectKeyframe,
  type MCPGeneratorSource,
  type MCPLayer,
} from '../types.js';
import {
  ANIMATED_TEXT_TYPE,
  getGeneratorCatalog,
  getGeneratorEntry,
  getGeneratorInitialSettings,
  getNumericBounds,
  isPropertyVisible,
  isUsingLiveGeneratorCatalog,
  requireGeneratorEntry,
  requirePropertyDefinition,
  setLiveGeneratorCatalog,
  validateGeneratorValue,
  type GeneratorCatalogEntry,
  type GeneratorPropertyDefinition,
} from '../generators/catalog.js';
import { EASING_PRESETS, normalizeEasing } from '../generators/easing.js';
import {
  addKeyframe,
  applyTypewriterDefaultKeyframes,
  convertTypewriterUnits,
  ensureTrack,
  findTrack,
  isFrameInGeneratorRange,
  randomSeed,
  randomizeSeed,
  removeKeyframes,
  removeTrack,
  resetSettings,
  resolveGeneratorSettings,
  setTrackLoop,
  setValueAtFrame,
  updateSettings,
  updateTiming,
} from '../generators/operations.js';

type KeyframeValue = MCPEffectKeyframe['value'];

const MAX_RENDER_FRAMES = 60;

export const UPDATE_APP_MESSAGE =
  'The connected Ascii-Motion build does not support procedural generator commands. ' +
  'Update Ascii-Motion to a version with MCP generator support (reload the app), ' +
  'or disconnect the browser to edit the project headlessly.';

const LIVE_ONLY_RENDER_MESSAGE =
  'Rendering procedural generators requires a live Ascii-Motion browser connection — the generator ' +
  'engines run in the app. Headless mode can create and edit generator layers (they render when the ' +
  'saved project is opened in Ascii-Motion).';

// ============================================================================
// Shared schemas
// ============================================================================

const GeneratorValueSchema = z
  .union([z.number(), z.boolean(), z.string(), z.record(z.string(), z.string())])
  .describe('Property value: number, boolean, string, hex color ("#ff8800"/"transparent"), select option value, or mapping object');

const EasingInputSchema = z
  .union([z.enum(Object.keys(EASING_PRESETS) as [string, ...string[]]), EasingCurveSchema])
  .describe('Easing from this keyframe to the next: preset name (linear, hold, ease-in, ease-out, ease-in-out, ease-out-back, ease-in-back, bounce) or { type: "custom", x1, y1, x2, y2 }');

const SettingsPatchSchema = z
  .record(z.string(), GeneratorValueSchema)
  .describe('Static settings keyed by property path (see list_generator_types), e.g. { "wave.amplitude": 3, "textColor": "#00ff88" }');

// ============================================================================
// Helpers
// ============================================================================

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(error: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }),
    }],
    isError: true,
  };
}

/**
 * Send a generator command to the browser. Returns null in headless mode.
 * Maps "Unsupported browser command" (older app builds) to an update hint.
 */
async function sendGeneratorCommand(command: BrowserCommand): Promise<BrowserCommandApplied | null> {
  try {
    const result = await requestBrowserCommand(command);
    if (!result) return null;
    return result.applied ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unsupported browser command/i.test(message)) {
      throw new Error(`${UPDATE_APP_MESSAGE} (${message})`, { cause: error });
    }
    throw new Error(message, { cause: error });
  }
}

function isLive(): boolean {
  return hasBrowserCommandCallback();
}

/** Make sure the MCP mirror knows about a layer the browser just acted on */
async function ensureMirrorHasGeneratorLayer(layerId: string): Promise<void> {
  const layer = getProjectManager().getLayer(layerId);
  if (!layer || !layer.generator) await requireFreshBrowserState();
}

/** Adopt the browser's post-change source (falls back to a full refresh) */
async function adoptBrowserGenerator(
  layerId: string,
  description: string,
  applied: BrowserCommandApplied,
): Promise<MCPGeneratorSource> {
  const pm = getProjectManager();
  await ensureMirrorHasGeneratorLayer(layerId);
  if (applied.generator) {
    return pm.updateGeneratorSource(layerId, description, () => applied.generator as MCPGeneratorSource);
  }
  await requireFreshBrowserState();
  return pm.requireGeneratorLayer(layerId).generator;
}

/** Fetch the browser's live catalog when connected (silently keeps bundled one on older builds) */
async function refreshLiveCatalog(): Promise<string | undefined> {
  if (!isLive()) return undefined;
  try {
    const applied = await sendGeneratorCommand({ type: 'get_generator_catalog' });
    if (applied?.generatorCatalog && applied.generatorCatalog.length > 0) {
      setLiveGeneratorCatalog(applied.generatorCatalog as GeneratorCatalogEntry[]);
    }
    return undefined;
  } catch (error) {
    return `Using bundled catalog: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function currentFrame(): number {
  return getProjectManager().getState().currentFrameIndex;
}

function canvasSize(): { width: number; height: number; foregroundColor: string } {
  const state = getProjectManager().getState();
  return { width: state.width, height: state.height, foregroundColor: state.toolState.selectedColor };
}

/** Centered Animated Text position for (possibly multi-line) text */
function centeredTextPosition(text: string, width: number, height: number): { x: number; y: number } {
  const lines = text.split('\n');
  const longest = Math.max(1, ...lines.map(l => Array.from(l).length));
  return {
    x: Math.floor((width - longest) / 2),
    y: Math.floor((height - lines.length) / 2),
  };
}

/**
 * Validate a static settings patch against the catalog (headless). Throws on
 * unknown paths or wrong types; numbers are clamped with notes.
 */
function validateSettingsPatch(
  entry: GeneratorCatalogEntry,
  patch: Record<string, unknown>,
  baseSettings: Record<string, unknown>,
): { patch: Record<string, unknown>; notes: string[] } {
  const context = { ...baseSettings, ...patch };
  const validated: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const [path, value] of Object.entries(patch)) {
    const def = requirePropertyDefinition(entry, path);
    const result = validateGeneratorValue(entry, def, value, context);
    validated[path] = result.value;
    if (result.note) notes.push(result.note);
  }
  return { patch: validated, notes };
}

/** Helpful warnings: hidden (inactive) properties, animated paths with static edits */
function describeEffectiveness(
  entry: GeneratorCatalogEntry | undefined,
  source: MCPGeneratorSource,
  paths: string[],
  frame: number,
  { staticEdit }: { staticEdit: boolean },
): string[] {
  if (!entry) return [];
  const resolved = resolveGeneratorSettings(source, frame);
  const warnings: string[] = [];
  for (const path of paths) {
    const def = entry.properties.find(p => p.path === path);
    if (def && !isPropertyVisible(def, resolved)) {
      const conditions = [...(def.visibleWhen ? [def.visibleWhen] : []), ...(def.visibleWhenAll ?? [])];
      warnings.push(
        `"${path}" currently has no effect; it applies when ${conditions.map(c => `${c.path} is ${c.values.join(' or ')}`).join(' and ')}.`,
      );
    }
    if (staticEdit) {
      const track = findTrack(source, path);
      if (track && track.keyframes.length > 0) {
        warnings.push(`"${path}" is keyframed, so its static value is ignored. Use set_generator_property with a frame or set_generator_keyframes to change it.`);
      }
    }
  }
  return warnings;
}

function summarizeTracks(source: MCPGeneratorSource) {
  return source.propertyTracks.map(t => ({
    propertyPath: t.propertyPath,
    trackId: t.id,
    loop: t.loopKeyframes ?? false,
    keyframes: t.keyframes.map(kf => ({
      id: kf.id,
      frame: kf.frame,
      value: kf.value,
      easing: kf.easing.type === 'custom' ? kf.easing : kf.easing.type,
    })),
  }));
}

function summarizeGeneratorLayer(layer: MCPLayer) {
  const source = layer.generator!;
  const entry = getGeneratorEntry(source.generatorType);
  return {
    layerId: layer.id,
    name: layer.name,
    generatorType: source.generatorType,
    generatorName: entry?.name ?? source.generatorType,
    mode: entry?.mode,
    startFrame: source.startFrame,
    durationFrames: source.durationFrames,
    lastFrame: source.startFrame + source.durationFrames - 1,
    enabled: source.enabled,
    visible: layer.visible,
    opacity: layer.opacity,
    ...(source.generatorType === ANIMATED_TEXT_TYPE ? {
      text: source.settings.text,
      effect: source.settings.effect,
    } : {}),
    animatedProperties: source.propertyTracks
      .filter(t => t.keyframes.length > 0)
      .map(t => ({ path: t.propertyPath, keyframes: t.keyframes.length, loop: t.loopKeyframes ?? false })),
  };
}

function formatProperty(entry: GeneratorCatalogEntry, def: GeneratorPropertyDefinition, settings: Record<string, unknown>) {
  const bounds = getNumericBounds(entry, def, settings);
  const conditions = [...(def.visibleWhen ? [def.visibleWhen] : []), ...(def.visibleWhenAll ?? [])];
  return {
    path: def.path,
    name: def.displayName,
    type: def.valueType,
    default: def.defaultValue,
    ...(bounds.min !== undefined ? { min: bounds.min } : {}),
    ...(bounds.max !== undefined ? { max: bounds.max } : {}),
    ...(def.step !== undefined ? { step: def.step } : {}),
    ...(def.unit ? { unit: def.unit } : {}),
    ...(def.options ? { options: def.options.map(o => o.value) } : {}),
    animation: def.interpolation === 'numeric' ? 'smooth' : 'stepped',
    ...(entry.phaseProperties.includes(def.path) ? { rate: true } : {}),
    ...(conditions.length > 0 ? { activeWhen: conditions.map(c => `${c.path} in [${c.values.join(', ')}]`).join(' and ') } : {}),
  };
}

// ============================================================================
// Core operations (shared by tools)
// ============================================================================

interface AddGeneratorOptions {
  generatorType: string;
  name?: string;
  startFrame?: number;
  durationFrames?: number;
  settings?: Record<string, unknown>;
}

async function addGenerator(options: AddGeneratorOptions) {
  const pm = getProjectManager();
  const state = pm.getState();
  const { width, height, foregroundColor } = canvasSize();
  const settingsPatch = { ...(options.settings ?? {}) };

  if (
    options.generatorType === ANIMATED_TEXT_TYPE &&
    typeof settingsPatch.text === 'string' &&
    settingsPatch['position.x'] === undefined &&
    settingsPatch['position.y'] === undefined
  ) {
    const pos = centeredTextPosition(settingsPatch.text, width, height);
    settingsPatch['position.x'] = pos.x;
    settingsPatch['position.y'] = pos.y;
  }

  const applied = await sendGeneratorCommand({
    type: 'add_generator_layer',
    generatorType: options.generatorType,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.startFrame !== undefined ? { startFrame: options.startFrame } : {}),
    ...(options.durationFrames !== undefined ? { durationFrames: options.durationFrames } : {}),
    ...(Object.keys(settingsPatch).length > 0 ? { settings: settingsPatch } : {}),
  });

  if (applied) {
    let layer: MCPLayer | null;
    if (applied.layer) {
      layer = pm.addGeneratorLayer({
        generatorType: options.generatorType,
        settings: {},
        name: '',
        startFrame: 0,
        durationFrames: 1,
        layer: applied.layer as MCPLayer,
      });
    } else {
      await requireFreshBrowserState();
      layer = applied.layerId ? pm.getLayer(applied.layerId) : pm.getActiveLayer();
    }
    if (!layer?.generator) throw new Error('Browser added the generator layer but it was not found in the synced state');
    return { layer, notes: [] as string[], browserSynced: true };
  }

  const entry = requireGeneratorEntry(options.generatorType);
  const base = getGeneratorInitialSettings(entry.type, width, height, { foregroundColor });
  if ('seed' in base) base.seed = randomSeed();
  const { patch, notes } = validateSettingsPatch(entry, settingsPatch, base);
  const startFrame = Math.max(0, Math.round(options.startFrame ?? 0));
  const durationFrames = Math.max(
    1,
    Math.round(options.durationFrames ?? state.timelineConfig.durationFrames - startFrame),
  );
  const layer = pm.addGeneratorLayer({
    generatorType: entry.type,
    settings: { ...base, ...patch },
    name: options.name ?? entry.name,
    startFrame,
    durationFrames,
  });
  return { layer, notes, browserSynced: false };
}

async function setProperty(options: {
  layerId: string;
  propertyPath: string;
  value: KeyframeValue;
  frame?: number;
  applyEffectDefaults?: boolean;
}) {
  const pm = getProjectManager();
  const applied = await sendGeneratorCommand({
    type: 'set_generator_property',
    layerId: options.layerId,
    propertyPath: options.propertyPath,
    value: options.value,
    ...(options.frame !== undefined ? { frame: options.frame } : {}),
    ...(options.applyEffectDefaults !== undefined ? { applyEffectDefaults: options.applyEffectDefaults } : {}),
  });

  if (applied) {
    const frame = options.frame ?? applied.currentFrameIndex ?? currentFrame();
    const source = await adoptBrowserGenerator(options.layerId, `Set ${options.propertyPath}`, applied);
    return { source, frame, notes: [] as string[], browserSynced: true };
  }

  const layer = pm.requireGeneratorLayer(options.layerId);
  const entry = requireGeneratorEntry(layer.generator.generatorType);
  const def = requirePropertyDefinition(entry, options.propertyPath);
  const frame = options.frame ?? currentFrame();
  const resolved = resolveGeneratorSettings(layer.generator, frame);
  const validated = validateGeneratorValue(entry, def, options.value, { ...resolved, [options.propertyPath]: options.value });
  const value = validated.value as KeyframeValue;
  const notes = validated.note ? [validated.note] : [];

  const source = pm.updateGeneratorSource(options.layerId, `Set ${options.propertyPath}`, (current) => {
    if (entry.type === ANIMATED_TEXT_TYPE && options.propertyPath === 'typewriter.units') {
      return convertTypewriterUnits(current, value as 'percent' | 'index', frame);
    }
    let next = setValueAtFrame(current, options.propertyPath, value, frame).source;
    if (
      entry.type === ANIMATED_TEXT_TYPE &&
      options.propertyPath === 'effect' &&
      value === 'typewriter' &&
      options.applyEffectDefaults !== false
    ) {
      next = applyTypewriterDefaultKeyframes(next);
    }
    return next;
  });
  return { source, frame, notes, browserSynced: false };
}

async function setKeyframes(options: {
  layerId: string;
  propertyPath: string;
  keyframes: Array<{ frame: number; value: KeyframeValue; easing?: unknown }>;
  replace?: boolean;
  loop?: boolean;
}) {
  const pm = getProjectManager();
  const keyframes = options.keyframes.map(kf => ({
    frame: Math.max(0, Math.round(kf.frame)),
    value: kf.value,
    ...(kf.easing !== undefined ? { easing: normalizeEasing(kf.easing) } : {}),
  }));

  const applied = await sendGeneratorCommand({
    type: 'set_generator_keyframes',
    layerId: options.layerId,
    propertyPath: options.propertyPath,
    keyframes,
    ...(options.replace !== undefined ? { replace: options.replace } : {}),
    ...(options.loop !== undefined ? { loop: options.loop } : {}),
  });

  if (applied) {
    const source = await adoptBrowserGenerator(options.layerId, `Keyframe ${options.propertyPath}`, applied);
    return {
      source,
      trackId: applied.trackId ?? findTrack(source, options.propertyPath)?.id,
      keyframeIds: applied.keyframeIds ?? [],
      notes: [] as string[],
      browserSynced: true,
    };
  }

  const layer = pm.requireGeneratorLayer(options.layerId);
  const entry = requireGeneratorEntry(layer.generator.generatorType);
  const def = requirePropertyDefinition(entry, options.propertyPath);
  const notes: string[] = [];
  const validated = keyframes.map(kf => {
    const context = { ...resolveGeneratorSettings(layer.generator, kf.frame), [options.propertyPath]: kf.value };
    const result = validateGeneratorValue(entry, def, kf.value, context);
    if (result.note) notes.push(`frame ${kf.frame}: ${result.note}`);
    return { ...kf, value: result.value as KeyframeValue };
  });

  let trackId = '';
  const keyframeIds: string[] = [];
  const source = pm.updateGeneratorSource(options.layerId, `Keyframe ${options.propertyPath}`, (current) => {
    const ensured = ensureTrack(current, options.propertyPath);
    trackId = ensured.trackId;
    let next = ensured.source;
    if (options.replace) next = removeKeyframes(next, trackId, () => true);
    for (const kf of validated) {
      const added = addKeyframe(next, trackId, kf.frame, kf.value, kf.easing);
      next = added.source;
      keyframeIds.push(added.keyframeId);
    }
    if (options.loop !== undefined) next = setTrackLoop(next, trackId, options.loop);
    return next;
  });
  return { source, trackId, keyframeIds, notes, browserSynced: false };
}

function outOfRangeNotes(source: MCPGeneratorSource, frames: number[]): string[] {
  const outside = frames.filter(f => !isFrameInGeneratorRange(source, f));
  if (outside.length === 0) return [];
  return [`Frames ${outside.join(', ')} are outside the generator's visible span (${source.startFrame}–${source.startFrame + source.durationFrames - 1}); values there only influence interpolation.`];
}

// ============================================================================
// Tool registration
// ============================================================================

export function registerProceduralGeneratorTools(server: McpServer): void {

  // --------------------------------------------------------------------------
  // list_generator_types
  // --------------------------------------------------------------------------
  server.tool(
    'list_generator_types',
    'List procedural generator types (radio-waves, turbulent-noise, particle-physics, rain-drops, digital-rain, animated-text). ' +
    'Pass generatorType to get every keyframeable property: path, type, range, options, default, whether it animates smoothly or stepped, ' +
    'and when it is active (e.g. wave.* only applies when effect is "wave"). Use these paths with the other generator tools.',
    {
      generatorType: z.string().optional().describe('Generator type to describe in full'),
      category: z.string().optional().describe('Only include properties in this category (e.g. "Mapping", "Animation")'),
    },
    async ({ generatorType, category }) => {
      try {
        const catalogWarning = await refreshLiveCatalog();
        const source = isUsingLiveGeneratorCatalog() ? 'browser' : 'bundled';
        const { width, height, foregroundColor } = canvasSize();

        if (!generatorType) {
          return textResult({
            catalogSource: source,
            ...(catalogWarning ? { warning: catalogWarning } : {}),
            generators: getGeneratorCatalog().map(e => ({
              type: e.type,
              name: e.name,
              description: e.description,
              mode: e.mode,
              propertyCount: e.properties.length,
              categories: [...new Set(e.properties.map(p => p.category))],
            })),
            modes: {
              stateless: 'Each frame is computed directly from settings and time — scrubbing is instant.',
              simulation: 'Frames are simulated forward from the generator start; seed controls randomness.',
              cells: 'Writes characters directly (Animated Text) — no brightness mapping.',
            },
            next: 'Call list_generator_types with generatorType for property paths, then add_generator_layer (or add_animated_text).',
          });
        }

        const entry = requireGeneratorEntry(generatorType);
        const initialSettings = entry.initialSettings
          ?? getGeneratorInitialSettings(entry.type, width, height, { foregroundColor });
        const properties = entry.properties
          .filter(p => !category || p.category.toLowerCase() === category.toLowerCase())
          .map(p => formatProperty(entry, p, initialSettings));
        const grouped: Record<string, unknown[]> = {};
        for (const prop of properties) {
          const cat = entry.properties.find(p => p.path === prop.path)!.category;
          (grouped[cat] ??= []).push(prop);
        }
        return textResult({
          catalogSource: source,
          ...(catalogWarning ? { warning: catalogWarning } : {}),
          type: entry.type,
          name: entry.name,
          description: entry.description,
          mode: entry.mode,
          creationDefaults: initialSettings,
          propertiesByCategory: grouped,
          notes: [
            'Every property can be keyframed. "smooth" properties interpolate with easing; "stepped" properties hold until the next keyframe.',
            ...(entry.phaseProperties.length > 0
              ? [`Rate properties (${entry.phaseProperties.join(', ')}) are per-second speeds integrated over time — keyframing them ramps the speed without jumps.`]
              : []),
            ...(entry.mode === 'simulation' ? ['Simulation generators are deterministic for a given seed; use randomize_generator_seed for a new variation.'] : []),
            ...(entry.properties.some(p => p.category === 'Mapping')
              ? ['Mapping properties convert generator brightness into characters/colors (mapping.characterPaletteId uses palette ids from list_character_palettes).']
              : []),
          ],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // get_generator_layers
  // --------------------------------------------------------------------------
  server.tool(
    'get_generator_layers',
    'List procedural generator layers, or inspect one in detail: its span, static settings, keyframed tracks, and the fully-resolved settings at a frame.',
    {
      layerId: z.string().optional().describe('Generator layer to inspect in detail (omit to list all)'),
      frame: z.number().int().min(0).optional().describe('Frame to resolve animated settings at (default: current frame)'),
    },
    async ({ layerId, frame }) => {
      try {
        await ensureFreshBrowserState();
        const pm = getProjectManager();
        if (!layerId) {
          const layers = pm.getGeneratorLayers();
          return textResult({
            count: layers.length,
            generatorLayers: layers.map(summarizeGeneratorLayer),
            ...(layers.length === 0 ? { hint: 'Use add_generator_layer or add_animated_text to create one.' } : {}),
          });
        }

        const layer = pm.requireGeneratorLayer(layerId);
        const atFrame = frame ?? currentFrame();
        let resolvedSettings = resolveGeneratorSettings(layer.generator, atFrame);
        let resolvedBy = 'mcp';
        const warnings: string[] = [];
        if (isLive()) {
          try {
            const applied = await sendGeneratorCommand({ type: 'get_generator_state', layerId, frame: atFrame });
            if (applied?.resolvedSettings) {
              resolvedSettings = applied.resolvedSettings;
              resolvedBy = 'browser';
            }
          } catch (error) {
            warnings.push(error instanceof Error ? error.message : String(error));
          }
        }
        return textResult({
          ...summarizeGeneratorLayer(layer),
          frame: atFrame,
          inRange: isFrameInGeneratorRange(layer.generator, atFrame),
          settings: layer.generator.settings,
          tracks: summarizeTracks(layer.generator),
          resolvedSettings,
          resolvedBy,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // add_generator_layer
  // --------------------------------------------------------------------------
  server.tool(
    'add_generator_layer',
    'Add a procedural generator layer (live, keyframeable — not baked cells). Uses canvas-aware defaults (centered origin/text, ' +
    'random seed) and merges any settings you pass. Span defaults to the whole timeline. Call list_generator_types first for property paths.',
    {
      generatorType: z.string().describe('Generator type: radio-waves, turbulent-noise, particle-physics, rain-drops, digital-rain, animated-text'),
      name: z.string().optional().describe('Layer name (default: generator name)'),
      startFrame: z.number().int().min(0).optional().describe('First visible frame (default 0)'),
      durationFrames: z.number().int().min(1).optional().describe('Visible span length (default: to the end of the timeline)'),
      settings: SettingsPatchSchema.optional(),
    },
    async (args) => {
      try {
        const { layer, notes, browserSynced } = await addGenerator(args);
        const entry = getGeneratorEntry(layer.generator!.generatorType);
        const warnings = describeEffectiveness(entry, layer.generator!, Object.keys(args.settings ?? {}), layer.generator!.startFrame, { staticEdit: false });
        return textResult({
          success: true,
          browserSynced,
          ...summarizeGeneratorLayer(layer),
          settings: layer.generator!.settings,
          ...(notes.length > 0 ? { notes } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
          ...(browserSynced ? {} : { info: LIVE_ONLY_RENDER_MESSAGE }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // add_animated_text
  // --------------------------------------------------------------------------
  server.tool(
    'add_animated_text',
    'Add an Animated Text generator layer: crisp text with optional typewriter reveal, blink, or wave effects — all keyframeable. ' +
    'Text is centered unless x/y are given. For typewriter, the reveal runs across the span (or revealFrames). ' +
    'Use set_generator_property / set_generator_keyframes afterwards for finer control.',
    {
      text: z.string().min(1).describe('Text to display (use \\n for multiple lines)'),
      x: z.number().int().optional().describe('Left column of the text box (default: centered)'),
      y: z.number().int().optional().describe('Top row of the text box (default: centered)'),
      effect: z.enum(['none', 'typewriter', 'blink', 'wave']).optional().describe('Animation effect (default none)'),
      revealFrames: z.number().int().min(1).optional().describe('Typewriter only: frames to fully reveal the text, starting at startFrame'),
      cursor: z.boolean().optional().describe('Typewriter only: show a cursor'),
      textColor: z.string().optional().describe('Text color (default: current foreground color)'),
      backgroundColor: z.string().optional().describe('Background color or "transparent"'),
      align: z.enum(['left', 'center', 'right']).optional().describe('Line alignment'),
      name: z.string().optional().describe('Layer name'),
      startFrame: z.number().int().min(0).optional().describe('First visible frame (default 0)'),
      durationFrames: z.number().int().min(1).optional().describe('Visible span length (default: to the end of the timeline)'),
      settings: SettingsPatchSchema.optional().describe('Any other Animated Text settings (e.g. { "wave.amplitude": 2, "blink.onFrames": 6 })'),
    },
    async (args) => {
      try {
        const settings: Record<string, unknown> = { ...(args.settings ?? {}), text: args.text };
        if (args.x !== undefined || args.y !== undefined) {
          const { width, height } = canvasSize();
          const centered = centeredTextPosition(args.text, width, height);
          settings['position.x'] = args.x ?? centered.x;
          settings['position.y'] = args.y ?? centered.y;
        }
        if (args.textColor !== undefined) settings.textColor = args.textColor;
        if (args.backgroundColor !== undefined) settings.backgroundColor = args.backgroundColor;
        if (args.align !== undefined) settings.align = args.align;
        if (args.cursor !== undefined) settings['typewriter.cursor'] = args.cursor;
        const effect = args.effect ?? (settings.effect as string | undefined) ?? 'none';
        if (effect !== 'typewriter') settings.effect = effect;
        else delete settings.effect;

        const added = await addGenerator({
          generatorType: ANIMATED_TEXT_TYPE,
          name: args.name ?? `Text: ${args.text.split('\n')[0].slice(0, 24)}`,
          startFrame: args.startFrame,
          durationFrames: args.durationFrames,
          settings,
        });
        const notes = [...added.notes];
        let layer = added.layer;
        let source = layer.generator!;

        if (effect === 'typewriter') {
          const result = await setProperty({ layerId: layer.id, propertyPath: 'effect', value: 'typewriter', frame: source.startFrame });
          source = result.source;
          notes.push(...result.notes);
          if (args.revealFrames !== undefined) {
            const start = source.startFrame;
            const end = start + Math.max(1, args.revealFrames) - 1;
            const keyed = await setKeyframes({
              layerId: layer.id,
              propertyPath: 'typewriter.end',
              keyframes: [{ frame: start, value: 0 }, { frame: end, value: 100 }],
              replace: true,
            });
            source = keyed.source;
            notes.push(...keyed.notes);
          }
          layer = getProjectManager().getLayer(layer.id) ?? layer;
        }

        return textResult({
          success: true,
          browserSynced: added.browserSynced,
          ...summarizeGeneratorLayer(layer),
          settings: source.settings,
          tracks: summarizeTracks(source),
          ...(notes.length > 0 ? { notes } : {}),
          ...(added.browserSynced ? {} : { info: LIVE_ONLY_RENDER_MESSAGE }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // update_generator_layer
  // --------------------------------------------------------------------------
  server.tool(
    'update_generator_layer',
    'Update a generator layer\'s static settings, visible span, enabled state, or name in one undoable step. ' +
    'Static settings are ignored for keyframed properties — use set_generator_property/set_generator_keyframes for those.',
    {
      layerId: z.string().describe('Generator layer ID'),
      settings: SettingsPatchSchema.optional(),
      startFrame: z.number().int().min(0).optional().describe('New first visible frame'),
      durationFrames: z.number().int().min(1).optional().describe('New visible span length'),
      shiftKeyframes: z.boolean().optional().describe('When moving startFrame, shift all keyframes by the same amount (default false)'),
      enabled: z.boolean().optional().describe('Enable/disable rendering'),
      name: z.string().optional().describe('Rename the layer'),
    },
    async ({ layerId, settings, startFrame, durationFrames, shiftKeyframes, enabled, name }) => {
      try {
        const pm = getProjectManager();
        if (settings === undefined && startFrame === undefined && durationFrames === undefined && enabled === undefined && name === undefined) {
          throw new Error('Nothing to update: pass settings, startFrame, durationFrames, enabled, or name');
        }
        const applied = await sendGeneratorCommand({
          type: 'update_generator_layer',
          layerId,
          ...(settings !== undefined ? { settings } : {}),
          ...(startFrame !== undefined ? { startFrame } : {}),
          ...(durationFrames !== undefined ? { durationFrames } : {}),
          ...(shiftKeyframes !== undefined ? { shiftKeyframes } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(name !== undefined ? { name } : {}),
        });

        let source: MCPGeneratorSource;
        let notes: string[] = [];
        if (applied) {
          source = await adoptBrowserGenerator(layerId, 'Update generator', applied);
          if (name !== undefined) pm.renameLayer(layerId, name);
        } else {
          const layer = pm.requireGeneratorLayer(layerId);
          const entry = requireGeneratorEntry(layer.generator.generatorType);
          const validated = settings
            ? validateSettingsPatch(entry, settings, layer.generator.settings)
            : { patch: {}, notes: [] };
          notes = validated.notes;
          source = pm.updateGeneratorSource(layerId, 'Update generator', (current) => {
            let next = settings ? updateSettings(current, validated.patch) : current;
            if (startFrame !== undefined || durationFrames !== undefined) {
              next = updateTiming(next, startFrame ?? next.startFrame, durationFrames ?? next.durationFrames, shiftKeyframes ?? false);
            }
            if (enabled !== undefined) next = { ...next, enabled };
            return next;
          });
          if (name !== undefined) pm.renameLayer(layerId, name);
        }
        const layer = pm.requireGeneratorLayer(layerId);
        const warnings = describeEffectiveness(getGeneratorEntry(source.generatorType), source, Object.keys(settings ?? {}), currentFrame(), { staticEdit: true });
        return textResult({
          success: true,
          browserSynced: applied !== null,
          ...summarizeGeneratorLayer(layer),
          settings: source.settings,
          ...(notes.length > 0 ? { notes } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // set_generator_property
  // --------------------------------------------------------------------------
  server.tool(
    'set_generator_property',
    'Set one generator property the way the app\'s inspector does at the playhead: if the property is keyframed, this adds/updates a keyframe at `frame`; ' +
    'otherwise it changes the static value. Animated Text extras: setting typewriter.units converts start/end so the reveal is unchanged, and ' +
    'setting effect to "typewriter" adds a default 0→100% reveal across the span (disable with applyEffectDefaults:false).',
    {
      layerId: z.string().describe('Generator layer ID'),
      propertyPath: z.string().describe('Property path from list_generator_types (e.g. "wave.amplitude", "text", "mapping.characterPaletteId")'),
      value: GeneratorValueSchema,
      frame: z.number().int().min(0).optional().describe('Frame for keyed edits (default: current frame)'),
      applyEffectDefaults: z.boolean().optional().describe('Animated Text: add default typewriter keyframes when switching effect to typewriter (default true)'),
    },
    async (args) => {
      try {
        const { source, frame, notes, browserSynced } = await setProperty(args);
        const track = findTrack(source, args.propertyPath);
        const keyframe = track?.keyframes.find(kf => kf.frame === frame);
        const warnings = describeEffectiveness(getGeneratorEntry(source.generatorType), source, [args.propertyPath], frame, { staticEdit: false });
        return textResult({
          success: true,
          browserSynced,
          layerId: args.layerId,
          propertyPath: args.propertyPath,
          frame,
          keyed: !!keyframe,
          ...(keyframe ? { keyframeId: keyframe.id } : {}),
          valueAtFrame: resolveGeneratorSettings(source, frame)[args.propertyPath],
          staticValue: source.settings[args.propertyPath],
          ...(track ? { track: summarizeTracks({ ...source, propertyTracks: [track] })[0] } : {}),
          ...(notes.length > 0 ? { notes } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // set_generator_keyframes
  // --------------------------------------------------------------------------
  server.tool(
    'set_generator_keyframes',
    'Keyframe a generator property: add one or more keyframes (absolute frames) with easing. A keyframe on an existing frame is replaced. ' +
    'Use replace:true to discard the track\'s previous keyframes, and loop:true to repeat the keyframed range. ' +
    'Before the first and after the last keyframe the value holds.',
    {
      layerId: z.string().describe('Generator layer ID'),
      propertyPath: z.string().describe('Property path from list_generator_types'),
      keyframes: z.array(z.object({
        frame: z.number().int().min(0).describe('Absolute timeline frame'),
        value: GeneratorValueSchema,
        easing: EasingInputSchema.optional(),
      })).min(1).describe('Keyframes to add'),
      replace: z.boolean().optional().describe('Remove existing keyframes on this property first (default false)'),
      loop: z.boolean().optional().describe('Loop the keyframed range'),
    },
    async (args) => {
      try {
        const result = await setKeyframes(args);
        const track = findTrack(result.source, args.propertyPath);
        const entry = getGeneratorEntry(result.source.generatorType);
        const notes = [
          ...result.notes,
          ...outOfRangeNotes(result.source, args.keyframes.map(k => k.frame)),
          ...(entry?.phaseProperties.includes(args.propertyPath)
            ? [`"${args.propertyPath}" is a rate; keyframes change speed over time (motion stays continuous).`]
            : []),
        ];
        const warnings = describeEffectiveness(entry, result.source, [args.propertyPath], args.keyframes[0].frame, { staticEdit: false });
        return textResult({
          success: true,
          browserSynced: result.browserSynced,
          layerId: args.layerId,
          propertyPath: args.propertyPath,
          trackId: result.trackId,
          keyframeIds: result.keyframeIds,
          ...(track ? { track: summarizeTracks({ ...result.source, propertyTracks: [track] })[0] } : {}),
          ...(notes.length > 0 ? { notes } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // remove_generator_keyframes
  // --------------------------------------------------------------------------
  server.tool(
    'remove_generator_keyframes',
    'Remove keyframes from a generator property by frame or keyframe ID, or clear the whole track (clearTrack:true). ' +
    'When a track is removed (or becomes empty), the value at `frame` becomes the static setting, like the app.',
    {
      layerId: z.string().describe('Generator layer ID'),
      propertyPath: z.string().describe('Keyframed property path'),
      frames: z.array(z.number().int().min(0)).optional().describe('Remove keyframes on these frames'),
      keyframeIds: z.array(z.string()).optional().describe('Remove keyframes with these IDs'),
      clearTrack: z.boolean().optional().describe('Remove the entire track'),
      frame: z.number().int().min(0).optional().describe('Frame whose value becomes static when the track is removed (default: current frame)'),
    },
    async ({ layerId, propertyPath, frames, keyframeIds, clearTrack, frame }) => {
      try {
        if (!clearTrack && !frames?.length && !keyframeIds?.length) {
          throw new Error('Pass frames, keyframeIds, or clearTrack:true');
        }
        const pm = getProjectManager();
        const applied = await sendGeneratorCommand({
          type: 'remove_generator_keyframes',
          layerId,
          propertyPath,
          ...(frames !== undefined ? { frames } : {}),
          ...(keyframeIds !== undefined ? { keyframeIds } : {}),
          ...(clearTrack !== undefined ? { clearTrack } : {}),
          ...(frame !== undefined ? { frame } : {}),
        });
        let source: MCPGeneratorSource;
        if (applied) {
          source = await adoptBrowserGenerator(layerId, `Remove ${propertyPath} keyframes`, applied);
        } else {
          const layer = pm.requireGeneratorLayer(layerId);
          const track = findTrack(layer.generator, propertyPath);
          if (!track) throw new Error(`"${propertyPath}" has no keyframes on this generator`);
          const bakeFrame = frame ?? currentFrame();
          source = pm.updateGeneratorSource(layerId, `Remove ${propertyPath} keyframes`, (current) => {
            if (clearTrack) return removeTrack(current, track.id, bakeFrame);
            const frameSet = new Set(frames ?? []);
            const idSet = new Set(keyframeIds ?? []);
            const next = removeKeyframes(current, track.id, kf => frameSet.has(kf.frame) || idSet.has(kf.id));
            const remaining = findTrack(next, propertyPath);
            if (remaining && remaining.keyframes.length === 0) {
              return removeTrack({ ...next, propertyTracks: current.propertyTracks }, track.id, bakeFrame);
            }
            return next;
          });
        }
        const track = findTrack(source, propertyPath);
        return textResult({
          success: true,
          browserSynced: applied !== null,
          layerId,
          propertyPath,
          trackRemoved: !track,
          remainingKeyframes: track ? summarizeTracks({ ...source, propertyTracks: [track] })[0].keyframes : [],
          staticValue: source.settings[propertyPath],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // reset_generator
  // --------------------------------------------------------------------------
  server.tool(
    'reset_generator',
    'Reset a generator to its creation defaults and remove all of its keyframes (the seed is kept).',
    { layerId: z.string().describe('Generator layer ID') },
    async ({ layerId }) => {
      try {
        const pm = getProjectManager();
        const applied = await sendGeneratorCommand({ type: 'reset_generator', layerId });
        let source: MCPGeneratorSource;
        if (applied) {
          source = await adoptBrowserGenerator(layerId, 'Reset generator', applied);
        } else {
          const { width, height, foregroundColor } = canvasSize();
          source = pm.updateGeneratorSource(layerId, 'Reset generator', current => resetSettings(current, width, height, foregroundColor));
        }
        return textResult({ success: true, browserSynced: applied !== null, layerId, settings: source.settings });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // randomize_generator_seed
  // --------------------------------------------------------------------------
  server.tool(
    'randomize_generator_seed',
    'Pick a new random seed for a generator (new variation of noise/particles/rain). If the seed is keyframed, keys the new seed at `frame`.',
    {
      layerId: z.string().describe('Generator layer ID'),
      frame: z.number().int().min(0).optional().describe('Frame to key the seed at when the seed is animated (default: current frame)'),
    },
    async ({ layerId, frame }) => {
      try {
        const pm = getProjectManager();
        const applied = await sendGeneratorCommand({
          type: 'randomize_generator_seed',
          layerId,
          ...(frame !== undefined ? { frame } : {}),
        });
        let source: MCPGeneratorSource;
        const atFrame = frame ?? applied?.currentFrameIndex ?? currentFrame();
        if (applied) {
          source = await adoptBrowserGenerator(layerId, 'Randomize seed', applied);
        } else {
          const layer = pm.requireGeneratorLayer(layerId);
          if (!('seed' in layer.generator.settings)) {
            throw new Error(`${layer.generator.generatorType} has no seed property`);
          }
          source = pm.updateGeneratorSource(layerId, 'Randomize seed', current => randomizeSeed(current, atFrame).source);
        }
        return textResult({
          success: true,
          browserSynced: applied !== null,
          layerId,
          seed: resolveGeneratorSettings(source, atFrame).seed,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // render_generator_frames (live only)
  // --------------------------------------------------------------------------
  server.tool(
    'render_generator_frames',
    'Render a generator layer\'s output at specific frames as ASCII text (generator only — no layer transforms, effects, or other layers). ' +
    `Use it to check what an animation looks like. Requires a live browser connection. Max ${MAX_RENDER_FRAMES} frames per call.`,
    {
      layerId: z.string().describe('Generator layer ID'),
      frames: z.array(z.number().int().min(0)).min(1).max(MAX_RENDER_FRAMES).optional().describe('Frames to render (default: current frame)'),
      includeCells: z.boolean().optional().describe('Also return per-cell char/color data (default false)'),
    },
    async ({ layerId, frames, includeCells }) => {
      try {
        if (!isLive()) throw new Error(LIVE_ONLY_RENDER_MESSAGE);
        const applied = await sendGeneratorCommand({
          type: 'render_generator_frames',
          layerId,
          frames: frames ?? [currentFrame()],
          ...(includeCells ? { includeCells: true } : {}),
        });
        const rendered = applied?.generatorFrames ?? [];
        return textResult({
          success: true,
          layerId,
          frames: rendered.map(f => ({
            frame: f.frame,
            inRange: f.inRange,
            cellCount: f.cellCount,
            text: f.text.join('\n'),
            ...(f.cells ? { cells: f.cells } : {}),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // --------------------------------------------------------------------------
  // bake_generator_layer (live only)
  // --------------------------------------------------------------------------
  server.tool(
    'bake_generator_layer',
    'Convert a generator layer into a normal content layer by rendering every frame of its span into editable cells (undoable in the app). ' +
    'The layer stops being procedural. Requires a live browser connection.',
    { layerId: z.string().describe('Generator layer ID') },
    async ({ layerId }) => {
      try {
        if (!isLive()) throw new Error(LIVE_ONLY_RENDER_MESSAGE);
        const pm = getProjectManager();
        const applied = await sendGeneratorCommand({ type: 'bake_generator_layer', layerId });
        if (applied?.layer && pm.getLayer(layerId)) {
          pm.replaceLayer(layerId, 'Bake generator', applied.layer as MCPLayer);
        } else {
          await requireFreshBrowserState();
        }
        const layer = pm.getLayer(layerId);
        return textResult({
          success: true,
          browserSynced: true,
          layerId,
          kind: layer?.kind ?? 'content',
          contentFrames: layer?.contentFrames.length ?? 0,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
