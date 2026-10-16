/**
 * Types describing Ascii-Motion procedural generator definitions.
 * Mirrors the app's GeneratorRegistryEntry / EffectPropertyDefinition metadata.
 */

export type GeneratorMode = 'stateless' | 'simulation' | 'cells';

export type GeneratorValueType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'color'
  | 'select'
  | 'mapping'
  | 'palette'
  | 'characterSet';

export interface GeneratorVisibilityCondition {
  path: string;
  values: string[];
}

export interface GeneratorPropertyDefinition {
  path: string;
  displayName: string;
  category: string;
  valueType: GeneratorValueType;
  defaultValue: number | boolean | string | Record<string, string>;
  interpolation: 'numeric' | 'hold';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  control?: 'slider' | 'multiline';
  options?: Array<{ label: string; value: string }>;
  visibleWhen?: GeneratorVisibilityCondition;
  visibleWhenAll?: GeneratorVisibilityCondition[];
}

export interface GeneratorCatalogEntry {
  type: string;
  name: string;
  description: string;
  mode: GeneratorMode;
  /** Per-second rate properties integrated over time (keyframing them changes accumulated phase) */
  phaseProperties: string[];
  defaultSettings: Record<string, unknown>;
  properties: GeneratorPropertyDefinition[];
  /** Canvas-aware creation defaults (only present on catalogs fetched from the browser) */
  initialSettings?: Record<string, unknown>;
}
