/**
 * Keyframe easing evaluation — port of Ascii-Motion's src/types/easing.ts so
 * headless generator settings resolve exactly like the app.
 */
import type { EasingCurve, EasingPreset } from '../types.js';

export const EASING_PRESETS: Record<EasingPreset, [number, number, number, number]> = {
  'linear': [0, 0, 1, 1],
  'hold': [0, 0, 0, 0],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  'ease-out-back': [0.34, 1.56, 0.64, 1],
  'ease-in-back': [0.36, 0, 0.66, -0.56],
  'bounce': [0.34, 1.4, 0.64, 1],
};

function cubicBezier(t: number, p1: number, p2: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}

function cubicBezierDerivative(t: number, p1: number, p2: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

function solveCubicBezierX(x: number, x1: number, x2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const currentX = cubicBezier(t, x1, x2) - x;
    if (Math.abs(currentX) < 1e-7) return t;
    const derivative = cubicBezierDerivative(t, x1, x2);
    if (Math.abs(derivative) < 1e-12) break;
    t -= currentX / derivative;
  }
  let a = 0;
  let b = 1;
  t = x;
  for (let i = 0; i < 10; i++) {
    const currentX = cubicBezier(t, x1, x2) - x;
    if (Math.abs(currentX) < 1e-7) return t;
    if (currentX > 0) b = t;
    else a = t;
    t = (a + b) / 2;
  }
  return t;
}

/** Evaluate an easing curve at progress 0..1 */
export function evaluateEasing(progress: number, easing: EasingCurve | undefined): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  if (!easing || easing.type === 'linear') return progress;
  if (easing.type === 'hold') return 0;
  const [x1, y1, x2, y2] = easing.type === 'custom'
    ? [easing.x1 ?? 0, easing.y1 ?? 0, easing.x2 ?? 1, easing.y2 ?? 1]
    : EASING_PRESETS[easing.type];
  return cubicBezier(solveCubicBezierX(progress, x1, x2), y1, y2);
}

export function defaultEasing(): EasingCurve {
  return { type: 'linear' };
}

/** Accept a preset name or an easing object and normalize to an EasingCurve */
export function normalizeEasing(easing: unknown): EasingCurve {
  if (easing === undefined || easing === null) return defaultEasing();
  if (typeof easing === 'string') {
    if (easing in EASING_PRESETS) return { type: easing as EasingPreset };
    throw new Error(`Unknown easing "${easing}". Use one of: ${Object.keys(EASING_PRESETS).join(', ')}, or a custom { type: 'custom', x1, y1, x2, y2 } curve.`);
  }
  if (typeof easing === 'object' && 'type' in (easing as Record<string, unknown>)) {
    const curve = easing as EasingCurve;
    if (curve.type === 'custom' || curve.type in EASING_PRESETS) return { ...curve };
  }
  throw new Error('Invalid easing value');
}
