/**
 * Generator catalog lookup, creation defaults and value validation.
 *
 * The bundled catalog (generated from the app registry) is used headlessly.
 * When a browser is connected, its live catalog replaces it so validation
 * always matches the running Ascii-Motion build.
 */
import { BUNDLED_GENERATOR_CATALOG } from './catalog-data.js';
import type { GeneratorCatalogEntry, GeneratorPropertyDefinition } from './catalog-types.js';

export type { GeneratorCatalogEntry, GeneratorPropertyDefinition } from './catalog-types.js';

export const DEFAULT_GENERATOR_CHARACTER_PALETTE_ID = 'minimal-ascii';
export const ANIMATED_TEXT_TYPE = 'animated-text';

let liveCatalog: GeneratorCatalogEntry[] | null = null;

export function setLiveGeneratorCatalog(entries: GeneratorCatalogEntry[] | null): void {
  liveCatalog = entries && entries.length > 0
    ? entries.map(e => ({ ...e, phaseProperties: e.phaseProperties ?? [] }))
    : null;
}

export function getGeneratorCatalog(): GeneratorCatalogEntry[] {
  return liveCatalog ?? BUNDLED_GENERATOR_CATALOG;
}

export function isUsingLiveGeneratorCatalog(): boolean {
  return liveCatalog !== null;
}

export function getGeneratorEntry(type: string): GeneratorCatalogEntry | undefined {
  return getGeneratorCatalog().find(e => e.type === type);
}

export function requireGeneratorEntry(type: string): GeneratorCatalogEntry {
  const entry = getGeneratorEntry(type);
  if (!entry) {
    const known = getGeneratorCatalog().map(e => e.type).join(', ');
    throw new Error(`Unknown generator type "${type}". Available: ${known}`);
  }
  return entry;
}

export function getPropertyDefinition(
  entry: GeneratorCatalogEntry,
  path: string,
): GeneratorPropertyDefinition | undefined {
  return entry.properties.find(p => p.path === path);
}

export function requirePropertyDefinition(
  entry: GeneratorCatalogEntry,
  path: string,
): GeneratorPropertyDefinition {
  const def = getPropertyDefinition(entry, path);
  if (!def) {
    throw new Error(
      `Unknown property "${path}" for generator "${entry.type}". ` +
      'Use list_generator_types to see valid property paths.',
    );
  }
  return def;
}

/** Number of characters typewriter index units count (newlines excluded) */
export function getAnimatedTextCharacterCount(text: string): number {
  return Array.from(text).filter(ch => ch !== '\n').length;
}

/**
 * Settings for a newly created generator, mirroring the app's
 * getGeneratorInitialSettings (defaults + palette + canvas-aware overrides).
 */
export function getGeneratorInitialSettings(
  type: string,
  canvasWidth: number,
  canvasHeight: number,
  options: { foregroundColor?: string } = {},
): Record<string, unknown> {
  const entry = requireGeneratorEntry(type);
  const settings: Record<string, unknown> = { ...entry.defaultSettings };
  if (entry.mode !== 'cells' && 'mapping.characterPaletteId' in settings) {
    settings['mapping.characterPaletteId'] = DEFAULT_GENERATOR_CHARACTER_PALETTE_ID;
  }
  if ('originX' in settings && 'originY' in settings) {
    settings.originX = Math.floor(canvasWidth / 2);
    settings.originY = Math.floor(canvasHeight / 2);
  }
  if (type === ANIMATED_TEXT_TYPE) {
    const text = String(settings.text ?? 'Text');
    settings['position.x'] = Math.floor((canvasWidth - text.length) / 2);
    settings['position.y'] = Math.floor((canvasHeight - 1) / 2);
    const fg = options.foregroundColor;
    if (fg && fg !== 'transparent') settings.textColor = fg;
  }
  return settings;
}

/** True when the property's visibility conditions hold for the given settings */
export function isPropertyVisible(
  def: GeneratorPropertyDefinition,
  settings: Record<string, unknown>,
): boolean {
  const conditions = [
    ...(def.visibleWhen ? [def.visibleWhen] : []),
    ...(def.visibleWhenAll ?? []),
  ];
  return conditions.every(c => c.values.includes(String(settings[c.path])));
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export interface ValidatedValue {
  value: number | boolean | string | Record<string, string>;
  /** Present when the value was clamped or coerced */
  note?: string;
}

/** Effective numeric bounds, including Animated Text's dynamic typewriter range */
export function getNumericBounds(
  entry: GeneratorCatalogEntry,
  def: GeneratorPropertyDefinition,
  settings?: Record<string, unknown>,
): { min?: number; max?: number } {
  if (
    entry.type === ANIMATED_TEXT_TYPE &&
    settings &&
    (def.path === 'typewriter.start' || def.path === 'typewriter.end')
  ) {
    const percent = settings['typewriter.units'] !== 'index';
    return {
      min: 0,
      max: percent ? 100 : getAnimatedTextCharacterCount(String(settings.text ?? '')),
    };
  }
  return { min: def.min, max: def.max };
}

/**
 * Validate and normalize a value for a generator property.
 * Numbers are clamped to the property range (with a note); other mismatches throw.
 */
export function validateGeneratorValue(
  entry: GeneratorCatalogEntry,
  def: GeneratorPropertyDefinition,
  value: unknown,
  settings?: Record<string, unknown>,
): ValidatedValue {
  const where = `"${def.path}" (${entry.type})`;
  switch (def.valueType) {
    case 'number': {
      const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof num !== 'number' || !Number.isFinite(num)) {
        throw new Error(`${where} expects a number, got ${JSON.stringify(value)}`);
      }
      const { min, max } = getNumericBounds(entry, def, settings);
      let clamped = num;
      if (min !== undefined && clamped < min) clamped = min;
      if (max !== undefined && clamped > max) clamped = max;
      return clamped === num
        ? { value: num }
        : { value: clamped, note: `${def.path} clamped from ${num} to ${clamped} (range ${min ?? '-∞'}..${max ?? '∞'})` };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { value };
      if (value === 'true' || value === 'false') return { value: value === 'true' };
      throw new Error(`${where} expects a boolean, got ${JSON.stringify(value)}`);
    }
    case 'select': {
      const options = def.options ?? [];
      const str = String(value);
      if (options.some(o => o.value === str)) return { value: str };
      throw new Error(`${where} must be one of: ${options.map(o => o.value).join(', ')} (got ${JSON.stringify(value)})`);
    }
    case 'color': {
      if (typeof value === 'string' && (value === 'transparent' || HEX_COLOR.test(value))) return { value };
      throw new Error(`${where} expects a hex color like "#ff8800" or "transparent", got ${JSON.stringify(value)}`);
    }
    case 'mapping': {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return { value: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])) };
      }
      throw new Error(`${where} expects an object mapping`);
    }
    case 'characterSet': {
      if (Array.isArray(value)) return { value: value.map(String).join('') };
      if (typeof value === 'string') return { value };
      throw new Error(`${where} expects a string of characters ordered dark → bright`);
    }
    case 'palette':
    case 'string':
    default: {
      if (typeof value === 'string') return { value };
      if (typeof value === 'number') return { value: String(value) };
      throw new Error(`${where} expects a string, got ${JSON.stringify(value)}`);
    }
  }
}
