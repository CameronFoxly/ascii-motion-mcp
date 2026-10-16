import { describe, expect, it } from 'vitest';
import type { MCPGeneratorSource } from '../types.js';
import {
  getGeneratorCatalog,
  getGeneratorInitialSettings,
  requireGeneratorEntry,
  requirePropertyDefinition,
  validateGeneratorValue,
} from './catalog.js';
import { evaluateEasing, normalizeEasing } from './easing.js';
import {
  addKeyframe,
  applyTypewriterDefaultKeyframes,
  convertTypewriterUnits,
  ensureTrack,
  interpolateGeneratorTrack,
  randomizeSeed,
  removeTrack,
  resetSettings,
  resolveGeneratorSettings,
  setValueAtFrame,
  updateTiming,
} from './operations.js';

function source(type: string, overrides: Partial<MCPGeneratorSource> = {}): MCPGeneratorSource {
  return {
    id: 'gen-test',
    generatorType: type,
    startFrame: 0,
    durationFrames: 24,
    enabled: true,
    settings: getGeneratorInitialSettings(type, 40, 10),
    propertyTracks: [],
    ...overrides,
  };
}

describe('generator catalog', () => {
  it('bundles all six generator types', () => {
    expect(getGeneratorCatalog().map(e => e.type).sort()).toEqual([
      'animated-text', 'digital-rain', 'particle-physics', 'radio-waves', 'rain-drops', 'turbulent-noise',
    ]);
  });

  it('builds canvas-aware creation defaults', () => {
    const waves = getGeneratorInitialSettings('radio-waves', 40, 10);
    expect(waves.originX).toBe(20);
    expect(waves.originY).toBe(5);
    expect(waves['mapping.characterPaletteId']).toBe('minimal-ascii');

    const text = getGeneratorInitialSettings('animated-text', 40, 11, { foregroundColor: '#00FF00' });
    expect(text['position.x']).toBe(18);
    expect(text['position.y']).toBe(5);
    expect(text.textColor).toBe('#00FF00');
  });

  it('validates and clamps values', () => {
    const entry = requireGeneratorEntry('animated-text');
    const amplitude = requirePropertyDefinition(entry, 'wave.amplitude');
    expect(validateGeneratorValue(entry, amplitude, 99)).toMatchObject({ value: 30 });
    expect(validateGeneratorValue(entry, amplitude, 99).note).toContain('clamped');
    expect(() => validateGeneratorValue(entry, requirePropertyDefinition(entry, 'effect'), 'spin')).toThrow(/one of/);
    expect(() => validateGeneratorValue(entry, requirePropertyDefinition(entry, 'textColor'), 'red')).toThrow(/hex color/);
    expect(() => requirePropertyDefinition(entry, 'nope')).toThrow(/list_generator_types/);

    const end = requirePropertyDefinition(entry, 'typewriter.end');
    expect(validateGeneratorValue(entry, end, 50, { text: 'Hello', 'typewriter.units': 'index' }).value).toBe(5);
  });
});

describe('easing', () => {
  it('accepts presets and evaluates hold', () => {
    expect(normalizeEasing('ease-in')).toEqual({ type: 'ease-in' });
    expect(() => normalizeEasing('wobble')).toThrow(/Unknown easing/);
    expect(evaluateEasing(0.5, { type: 'linear' })).toBeCloseTo(0.5);
    expect(evaluateEasing(0.99, { type: 'hold' })).toBe(0);
  });
});

describe('generator operations', () => {
  it('interpolates numeric tracks, holds at edges, and loops', () => {
    let s = source('radio-waves');
    const { source: withTrack, trackId } = ensureTrack(s, 'startRotation');
    s = addKeyframe(withTrack, trackId, 0, 0).source;
    s = addKeyframe(s, trackId, 10, 10).source;
    const track = s.propertyTracks[0];
    expect(interpolateGeneratorTrack(track, 5, 'numeric')).toBeCloseTo(5);
    expect(interpolateGeneratorTrack(track, 20, 'numeric')).toBe(10);
    expect(interpolateGeneratorTrack({ ...track, loopKeyframes: true }, 15, 'numeric')).toBeCloseTo(5);
    expect(resolveGeneratorSettings(s, 5).startRotation).toBeCloseTo(5);
  });

  it('replaces keyframes on the same frame', () => {
    const { source: s0, trackId } = ensureTrack(source('radio-waves'), 'startRotation');
    const s1 = addKeyframe(addKeyframe(s0, trackId, 4, 1).source, trackId, 4, 2).source;
    expect(s1.propertyTracks[0].keyframes).toHaveLength(1);
    expect(s1.propertyTracks[0].keyframes[0].value).toBe(2);
  });

  it('edits static value or auto-keys at the playhead', () => {
    const s = source('radio-waves');
    const statically = setValueAtFrame(s, 'startRotation', 3, 5);
    expect(statically.keyed).toBe(false);
    expect(statically.source.settings.startRotation).toBe(3);

    const { source: s0, trackId } = ensureTrack(s, 'startRotation');
    const animated = setValueAtFrame(addKeyframe(s0, trackId, 0, 1).source, 'startRotation', 7, 6);
    expect(animated.keyed).toBe(true);
    expect(animated.source.propertyTracks[0].keyframes.map(k => k.frame)).toEqual([0, 6]);
  });

  it('bakes the value at frame when removing a track', () => {
    const { source: s0, trackId } = ensureTrack(source('radio-waves'), 'startRotation');
    const s1 = addKeyframe(addKeyframe(s0, trackId, 0, 0).source, trackId, 10, 10).source;
    const removed = removeTrack(s1, trackId, 5);
    expect(removed.propertyTracks).toHaveLength(0);
    expect(removed.settings.startRotation).toBeCloseTo(5);
  });

  it('shifts keyframes with timing when requested', () => {
    const { source: s0, trackId } = ensureTrack(source('radio-waves'), 'startRotation');
    const s1 = addKeyframe(s0, trackId, 2, 1).source;
    expect(updateTiming(s1, 5, 10, true).propertyTracks[0].keyframes[0].frame).toBe(7);
    expect(updateTiming(s1, 5, 10, false).propertyTracks[0].keyframes[0].frame).toBe(2);
  });

  it('resets settings but keeps the seed', () => {
    const s = { ...source('rain-drops'), settings: { ...source('rain-drops').settings, seed: 1234, dropFrequency: 29 } };
    const reset = resetSettings(s, 40, 10);
    expect(reset.settings.seed).toBe(1234);
    expect(reset.propertyTracks).toEqual([]);
  });

  it('keys a new seed when the seed is animated', () => {
    const { source: s0, trackId } = ensureTrack(source('rain-drops'), 'seed');
    const s1 = addKeyframe(s0, trackId, 0, 1).source;
    const result = randomizeSeed(s1, 8, 42);
    expect(result.source.propertyTracks[0].keyframes.map(k => [k.frame, k.value])).toEqual([[0, 1], [8, 42]]);
  });

  it('applies typewriter defaults and converts units without changing the reveal', () => {
    let s = source('animated-text', { startFrame: 0, durationFrames: 11 });
    s = { ...s, settings: { ...s.settings, text: 'HelloWorld', effect: 'typewriter' } };
    s = applyTypewriterDefaultKeyframes(s);
    const end = s.propertyTracks.find(t => t.propertyPath === 'typewriter.end')!;
    expect(end.keyframes.map(k => [k.frame, k.value])).toEqual([[0, 0], [10, 100]]);
    expect(resolveGeneratorSettings(s, 5)['typewriter.end']).toBeCloseTo(50);

    const converted = convertTypewriterUnits(s, 'index', 0);
    expect(converted.settings['typewriter.units']).toBe('index');
    expect(resolveGeneratorSettings(converted, 10)['typewriter.end']).toBeCloseTo(10);
    expect(resolveGeneratorSettings(converted, 5)['typewriter.end']).toBeCloseTo(5);
  });
});
