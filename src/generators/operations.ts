/**
 * Pure operations on procedural generator sources. Each function returns a new
 * source (sources are treated as immutable, like in the app) and mirrors the
 * corresponding Ascii-Motion timeline-store action so headless edits produce
 * the same data the browser would.
 */
import {
  generateEffectPropertyTrackId,
  generateKeyframeId,
  type EasingCurve,
  type MCPEffectKeyframe,
  type MCPEffectPropertyTrack,
  type MCPGeneratorSource,
} from '../types.js';
import {
  ANIMATED_TEXT_TYPE,
  getAnimatedTextCharacterCount,
  getGeneratorEntry,
  getGeneratorInitialSettings,
  type GeneratorPropertyDefinition,
} from './catalog.js';
import { defaultEasing, evaluateEasing } from './easing.js';

type KeyframeValue = MCPEffectKeyframe['value'];

export function isFrameInGeneratorRange(source: MCPGeneratorSource, frame: number): boolean {
  return frame >= source.startFrame && frame < source.startFrame + source.durationFrames;
}

function wrapFrame(sorted: MCPEffectKeyframe[], frame: number): number {
  if (sorted.length < 2) return frame;
  const first = sorted[0].frame;
  const duration = sorted[sorted.length - 1].frame - first;
  if (duration <= 0) return frame;
  return first + (((frame - first) % duration) + duration) % duration;
}

/** Interpolate one generator property track at a frame (same rules as effect tracks) */
export function interpolateGeneratorTrack(
  track: MCPEffectPropertyTrack,
  frame: number,
  def: Pick<GeneratorPropertyDefinition, 'interpolation' | 'defaultValue'>,
): KeyframeValue {
  const keyframes = track.keyframes;
  if (keyframes.length === 0) return def.defaultValue;
  if (keyframes.length === 1) return keyframes[0].value;
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  const f = track.loopKeyframes ? wrapFrame(sorted, frame) : frame;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (def.interpolation === 'hold') {
    if (f <= first.frame) return first.value;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].frame <= f) return sorted[i].value;
    }
    return first.value;
  }
  if (f <= first.frame) return first.value;
  if (f >= last.frame) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (f >= a.frame && f <= b.frame) {
      if (a.frame === b.frame) return a.value;
      const progress = evaluateEasing((f - a.frame) / (b.frame - a.frame), a.easing);
      return (a.value as number) + ((b.value as number) - (a.value as number)) * progress;
    }
  }
  return last.value;
}

/** Defaults → static settings → keyframed values at `frame` */
export function resolveGeneratorSettings(
  source: MCPGeneratorSource,
  frame: number,
): Record<string, unknown> {
  const entry = getGeneratorEntry(source.generatorType);
  const resolved: Record<string, unknown> = entry
    ? { ...entry.defaultSettings, ...source.settings }
    : { ...source.settings };
  if (!entry) return resolved;
  for (const track of source.propertyTracks) {
    if (track.keyframes.length === 0) continue;
    const def = entry.properties.find(p => p.path === track.propertyPath);
    if (!def) continue;
    resolved[track.propertyPath] = interpolateGeneratorTrack(track, frame, def);
  }
  return resolved;
}

export function findTrack(source: MCPGeneratorSource, propertyPath: string): MCPEffectPropertyTrack | undefined {
  return source.propertyTracks.find(t => t.propertyPath === propertyPath);
}

function mapTrack(
  source: MCPGeneratorSource,
  trackId: string,
  fn: (track: MCPEffectPropertyTrack) => MCPEffectPropertyTrack,
): MCPGeneratorSource {
  return {
    ...source,
    propertyTracks: source.propertyTracks.map(t => (t.id === trackId ? fn(t) : t)),
  };
}

export function updateSettings(source: MCPGeneratorSource, patch: Record<string, unknown>): MCPGeneratorSource {
  return { ...source, settings: { ...source.settings, ...patch } };
}

export function updateTiming(
  source: MCPGeneratorSource,
  startFrame: number,
  durationFrames: number,
  shiftKeyframes = false,
): MCPGeneratorSource {
  const nextStart = Math.max(0, Math.round(startFrame));
  const nextDuration = Math.max(1, Math.round(durationFrames));
  const delta = nextStart - source.startFrame;
  const propertyTracks = shiftKeyframes && delta !== 0
    ? source.propertyTracks.map(t => ({
      ...t,
      keyframes: t.keyframes.map(kf => ({ ...kf, frame: Math.max(0, kf.frame + delta) })),
    }))
    : source.propertyTracks;
  return { ...source, startFrame: nextStart, durationFrames: nextDuration, propertyTracks };
}

/** Idempotent: returns the existing track when one exists */
export function ensureTrack(
  source: MCPGeneratorSource,
  propertyPath: string,
): { source: MCPGeneratorSource; trackId: string } {
  const existing = findTrack(source, propertyPath);
  if (existing) return { source, trackId: existing.id };
  const trackId = generateEffectPropertyTrackId();
  return {
    source: {
      ...source,
      propertyTracks: [...source.propertyTracks, { id: trackId, propertyPath, keyframes: [], loopKeyframes: false }],
    },
    trackId,
  };
}

/** Add a keyframe, replacing any keyframe on the same frame */
export function addKeyframe(
  source: MCPGeneratorSource,
  trackId: string,
  frame: number,
  value: KeyframeValue,
  easing: EasingCurve = defaultEasing(),
): { source: MCPGeneratorSource; keyframeId: string } {
  const keyframeId = generateKeyframeId();
  return {
    source: mapTrack(source, trackId, t => ({
      ...t,
      keyframes: [
        ...t.keyframes.filter(kf => kf.frame !== frame),
        { id: keyframeId, frame, value, easing },
      ].sort((a, b) => a.frame - b.frame),
    })),
    keyframeId,
  };
}

export function updateKeyframe(
  source: MCPGeneratorSource,
  trackId: string,
  keyframeId: string,
  updates: Partial<Pick<MCPEffectKeyframe, 'frame' | 'value' | 'easing'>>,
): MCPGeneratorSource {
  return mapTrack(source, trackId, t => ({
    ...t,
    keyframes: t.keyframes
      .map(kf => (kf.id === keyframeId ? { ...kf, ...updates } : kf))
      .sort((a, b) => a.frame - b.frame),
  }));
}

export function removeKeyframes(
  source: MCPGeneratorSource,
  trackId: string,
  predicate: (kf: MCPEffectKeyframe) => boolean,
): MCPGeneratorSource {
  return mapTrack(source, trackId, t => ({ ...t, keyframes: t.keyframes.filter(kf => !predicate(kf)) }));
}

/** Remove a track; its value at `frame` becomes the static setting (app behavior) */
export function removeTrack(source: MCPGeneratorSource, trackId: string, frame: number): MCPGeneratorSource {
  const track = source.propertyTracks.find(t => t.id === trackId);
  if (!track) return source;
  const valueAtFrame = resolveGeneratorSettings(source, frame)[track.propertyPath];
  return {
    ...source,
    settings: valueAtFrame !== undefined
      ? { ...source.settings, [track.propertyPath]: valueAtFrame }
      : source.settings,
    propertyTracks: source.propertyTracks.filter(t => t.id !== trackId),
  };
}

export function setTrackLoop(source: MCPGeneratorSource, trackId: string, loop: boolean): MCPGeneratorSource {
  return mapTrack(source, trackId, t => ({ ...t, loopKeyframes: loop }));
}

/**
 * The app's "edit at playhead": updates the keyframe at `frame`, auto-keys an
 * animated property, or edits the static value when it isn't animated.
 */
export function setValueAtFrame(
  source: MCPGeneratorSource,
  propertyPath: string,
  value: KeyframeValue,
  frame: number,
): { source: MCPGeneratorSource; keyed: boolean; keyframeId?: string } {
  const track = findTrack(source, propertyPath);
  const kfAtFrame = track?.keyframes.find(kf => kf.frame === frame);
  if (track && kfAtFrame) {
    return { source: updateKeyframe(source, track.id, kfAtFrame.id, { value }), keyed: true, keyframeId: kfAtFrame.id };
  }
  if (track && track.keyframes.length > 0) {
    const added = addKeyframe(source, track.id, frame, value);
    return { source: added.source, keyed: true, keyframeId: added.keyframeId };
  }
  return { source: updateSettings(source, { [propertyPath]: value }), keyed: false };
}

/** Reset to creation defaults (keeps the seed) and drop all keyframes */
export function resetSettings(
  source: MCPGeneratorSource,
  canvasWidth: number,
  canvasHeight: number,
  foregroundColor?: string,
): MCPGeneratorSource {
  const defaults = getGeneratorInitialSettings(source.generatorType, canvasWidth, canvasHeight, { foregroundColor });
  if ('seed' in defaults && source.settings.seed !== undefined) defaults.seed = source.settings.seed;
  return { ...source, settings: defaults, propertyTracks: [] };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 100000);
}

export function randomizeSeed(
  source: MCPGeneratorSource,
  frame: number,
  seed: number = randomSeed(),
): { source: MCPGeneratorSource; seed: number } {
  const seedTrack = source.propertyTracks.find(t => t.propertyPath === 'seed' && t.keyframes.length > 0);
  if (seedTrack) return { source: addKeyframe(source, seedTrack.id, frame, seed).source, seed };
  return { source: updateSettings(source, { seed }), seed };
}

/**
 * When Typewriter is chosen, reveal the text over the span by keying
 * End 0 → 100 (percent). Existing End keyframes are left alone.
 */
export function applyTypewriterDefaultKeyframes(source: MCPGeneratorSource): MCPGeneratorSource {
  const existing = findTrack(source, 'typewriter.end');
  if (existing && existing.keyframes.length > 0) return source;
  const first = source.startFrame;
  const last = source.startFrame + Math.max(1, source.durationFrames) - 1;
  if (last <= first) {
    return updateSettings(source, { 'typewriter.units': 'percent', 'typewriter.start': 0, 'typewriter.end': 100 });
  }
  let next = updateSettings(source, { 'typewriter.units': 'percent', 'typewriter.start': 0 });
  const ensured = ensureTrack(next, 'typewriter.end');
  next = addKeyframe(ensured.source, ensured.trackId, first, 0).source;
  return addKeyframe(next, ensured.trackId, last, 100).source;
}

/**
 * Switch typewriter units, converting static Start/End and their keyframes
 * so the visible reveal is unchanged (port of the app's convertTypewriterUnits).
 */
export function convertTypewriterUnits(
  source: MCPGeneratorSource,
  units: 'percent' | 'index',
  frame: number,
): MCPGeneratorSource {
  if (source.generatorType !== ANIMATED_TEXT_TYPE) return source;
  if (resolveGeneratorSettings(source, frame)['typewriter.units'] === units) return source;
  const convert = (numeric: number, oldUnits: unknown, count: number): number => {
    const max = units === 'percent' ? 100 : count;
    const converted = oldUnits === units ? numeric
      : units === 'index' ? numeric * count / 100
        : count === 0 ? 0 : numeric * 100 / count;
    return Math.min(max, Math.max(0, converted));
  };
  const valuesAtFrame = (atFrame: number) => {
    const settings = resolveGeneratorSettings(source, atFrame);
    const count = getAnimatedTextCharacterCount(String(settings.text ?? ''));
    const oldUnits = settings['typewriter.units'];
    return {
      start: convert(Number(settings['typewriter.start'] ?? 0), oldUnits, count),
      end: convert(Number(settings['typewriter.end'] ?? 100), oldUnits, count),
    };
  };
  const staticValues = valuesAtFrame(frame);
  let next: MCPGeneratorSource = {
    ...source,
    settings: {
      ...source.settings,
      'typewriter.units': units,
      'typewriter.start': staticValues.start,
      'typewriter.end': staticValues.end,
    },
    propertyTracks: source.propertyTracks.map(t => (t.propertyPath === 'typewriter.units'
      ? { ...t, keyframes: t.keyframes.map(kf => ({ ...kf, value: units })) }
      : t)),
  };

  const first = Math.max(0, source.startFrame);
  const end = source.startFrame + source.durationFrames;
  const sampleFrames = new Set<number>([first, end - 1]);
  for (const track of source.propertyTracks) {
    if (['typewriter.start', 'typewriter.end', 'typewriter.units', 'text'].includes(track.propertyPath)) {
      for (const kf of track.keyframes) {
        if (kf.frame >= first && kf.frame < end) {
          sampleFrames.add(kf.frame);
          if (track.propertyPath === 'text' && kf.frame > first) sampleFrames.add(kf.frame - 1);
        }
      }
    }
  }
  const sampled = new Map<number, { start: number; end: number }>();
  for (const f of sampleFrames) sampled.set(f, valuesAtFrame(f));

  for (const path of ['typewriter.start', 'typewriter.end'] as const) {
    const key = path === 'typewriter.start' ? 'start' : 'end';
    const existing = findTrack(source, path);
    const values = [...sampled.values()].map(v => v[key]);
    if (!existing && values.some(v => v !== values[0])) next = ensureTrack(next, path).source;
  }

  return {
    ...next,
    propertyTracks: next.propertyTracks.map(track => {
      if (track.propertyPath !== 'typewriter.start' && track.propertyPath !== 'typewriter.end') return track;
      const key = track.propertyPath === 'typewriter.start' ? 'start' : 'end';
      const existingAtFrame = new Map(track.keyframes.map(kf => [kf.frame, kf]));
      const keyframes: MCPEffectKeyframe[] = track.keyframes.filter(kf => kf.frame < first || kf.frame >= end);
      for (const [f, values] of sampled) {
        const old = existingAtFrame.get(f);
        keyframes.push(old
          ? { ...old, value: values[key] }
          : { id: generateKeyframeId(), frame: f, value: values[key], easing: defaultEasing() });
      }
      keyframes.sort((a, b) => a.frame - b.frame);
      return { ...track, keyframes };
    }),
  };
}

/** Clamp and copy a deserialized source like the app's deserializeGeneratorSource */
export function normalizeGeneratorSource(data: MCPGeneratorSource): MCPGeneratorSource {
  return {
    id: data.id,
    generatorType: data.generatorType,
    startFrame: Math.max(0, Math.floor(data.startFrame)),
    durationFrames: Math.max(1, Math.floor(data.durationFrames)),
    enabled: data.enabled !== false,
    settings: { ...(data.settings ?? {}) },
    propertyTracks: (data.propertyTracks ?? []).map(t => ({
      id: t.id,
      propertyPath: t.propertyPath,
      keyframes: (t.keyframes ?? []).map(kf => ({ id: kf.id, frame: kf.frame, value: kf.value, easing: kf.easing })),
      loopKeyframes: t.loopKeyframes ?? false,
    })),
  };
}
