/**
 * Core Types for ascii-motion-mcp
 * 
 * These types mirror the Ascii-Motion application types but are adapted
 * for MCP server usage with Zod validation schemas.
 */

import { z } from 'zod';

// ============================================================================
// Cell Types - Single character on canvas
// ============================================================================

/**
 * Cell represents a single character position on the canvas
 */
export const CellSchema = z.object({
  char: z.string().length(1).describe('Single ASCII character'),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('Foreground hex color (e.g., #FFFFFF)'),
  bgColor: z.string().describe('Background hex color or "transparent"'),
});

export type Cell = z.infer<typeof CellSchema>;

/**
 * Default empty cell
 */
export const EMPTY_CELL: Cell = {
  char: ' ',
  color: '#FFFFFF',
  bgColor: 'transparent',
};

// ============================================================================
// Canvas Types
// ============================================================================

export const CanvasDimensionsSchema = z.object({
  width: z.number().int().min(4).max(200).describe('Canvas width in characters (4-200)'),
  height: z.number().int().min(4).max(100).describe('Canvas height in characters (4-100)'),
});

export type CanvasDimensions = z.infer<typeof CanvasDimensionsSchema>;

/**
 * Canvas cell data stored as a record with "x,y" keys
 * We use Record instead of Map for JSON serialization
 */
export const CanvasDataSchema = z.record(
  z.string().regex(/^\d+,\d+$/),
  CellSchema
).describe('Canvas cells keyed by "x,y" coordinate strings');

export type CanvasData = z.infer<typeof CanvasDataSchema>;

export const CanvasSchema = z.object({
  width: z.number().int().min(4).max(200),
  height: z.number().int().min(4).max(100),
  cells: CanvasDataSchema,
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#000000'),
  showGrid: z.boolean().default(true),
});

export type Canvas = z.infer<typeof CanvasSchema>;

// ============================================================================
// Frame Types - Animation frames
// ============================================================================

export const FrameIdSchema = z.string().uuid().describe('Unique frame identifier');
export type FrameId = z.infer<typeof FrameIdSchema>;

export const FrameSchema = z.object({
  id: FrameIdSchema,
  name: z.string().min(1).max(100).describe('Frame display name'),
  duration: z.number().int().min(10).max(60000).describe('Frame duration in milliseconds (10-60000)'),
  data: CanvasDataSchema.describe('Frame cell data'),
  thumbnail: z.string().optional().describe('Base64 encoded thumbnail image'),
});

export type Frame = z.infer<typeof FrameSchema>;

// ============================================================================
// Animation Types
// ============================================================================

export const AnimationSchema = z.object({
  frames: z.array(FrameSchema).min(1).describe('Animation frames'),
  currentFrameIndex: z.number().int().min(0).describe('Currently active frame index'),
  frameRate: z.number().min(1).max(60).default(12).describe('Display frame rate (fps)'),
  looping: z.boolean().default(true).describe('Whether animation loops'),
});

export type Animation = z.infer<typeof AnimationSchema>;

// ============================================================================
// Project / Session Types
// ============================================================================

export const ToolStateSchema = z.object({
  activeTool: z.enum([
    'pencil', 'eraser', 'paintbucket', 'select', 'lasso', 'magicwand',
    'rectangle', 'ellipse', 'eyedropper', 'line', 'text', 'asciitype',
    'asciibox', 'brush', 'beziershape', 'gradientfill', 'fliphorizontal', 'flipvertical'
  ]).default('pencil'),
  selectedColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FFFFFF'),
  selectedBgColor: z.string().default('transparent'),
  selectedCharacter: z.string().length(1).default('@'),
  paintBucketContiguous: z.boolean().default(true),
  rectangleFilled: z.boolean().default(false),
});

export type ToolState = z.infer<typeof ToolStateSchema>;

export const TypographySettingsSchema = z.object({
  fontSize: z.number().min(8).max(32).default(16),
  characterSpacing: z.number().min(0).max(10).default(0),
  lineSpacing: z.number().min(0).max(10).default(0),
  selectedFontId: z.string().default('jetbrains-mono'),
});

export type TypographySettings = z.infer<typeof TypographySettingsSchema>;

export const UIStateSchema = z.object({
  zoom: z.number().min(0.1).max(5).default(1),
  panOffset: z.object({
    x: z.number().default(0),
    y: z.number().default(0),
  }).default({ x: 0, y: 0 }),
  theme: z.enum(['light', 'dark']).default('dark'),
});

export type UIState = z.infer<typeof UIStateSchema>;

/**
 * Full session/project data structure
 * This matches the .asciimtn file format
 */
export const SessionDataSchema = z.object({
  version: z.string().default('1.0.0'),
  name: z.string().optional(),
  description: z.string().optional(),
  
  canvas: z.object({
    width: z.number().int().min(4).max(200),
    height: z.number().int().min(4).max(100),
    canvasBackgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    showGrid: z.boolean().default(true),
  }),
  
  animation: z.object({
    frames: z.array(z.object({
      id: z.string(),
      name: z.string().optional(),
      duration: z.number().optional(),
      data: z.record(z.string(), CellSchema).optional(),
      thumbnail: z.string().optional(),
    })),
    currentFrameIndex: z.number().int().min(0),
    frameRate: z.number().optional(),
    looping: z.boolean().optional(),
  }),
  
  tools: ToolStateSchema.optional(),
  typography: TypographySettingsSchema.optional(),
  ui: UIStateSchema.optional(),
});

export type SessionData = z.infer<typeof SessionDataSchema>;

// ============================================================================
// Layer Timeline Types (v2)
// ============================================================================

/**
 * Easing preset types for keyframe interpolation.
 */
export const EasingPresetSchema = z.enum([
  'linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out',
  'ease-out-back', 'ease-in-back', 'bounce',
]);
export type EasingPreset = z.infer<typeof EasingPresetSchema>;

/**
 * Easing curve definition (cubic bezier).
 */
export const EasingCurveSchema = z.object({
  type: z.union([EasingPresetSchema, z.literal('custom')]),
  x1: z.number().optional(),
  y1: z.number().optional(),
  x2: z.number().optional(),
  y2: z.number().optional(),
});
export type EasingCurve = z.infer<typeof EasingCurveSchema>;

/**
 * Known property paths that can be keyframed on a layer.
 */
export const PropertyPathSchema = z.enum([
  'transform.position.x',
  'transform.position.y',
  'transform.scale.x',
  'transform.scale.y',
  'transform.rotation',
  'transform.anchorPoint.x',
  'transform.anchorPoint.y',
]);
export type PropertyPath = z.infer<typeof PropertyPathSchema>;

/**
 * A single keyframe on a property track.
 */
export const KeyframeSchema = z.object({
  id: z.string().describe('Unique keyframe identifier'),
  frame: z.number().int().min(0).describe('Frame number'),
  value: z.union([z.number(), z.boolean(), z.string()]).describe('Keyframe value'),
  easing: EasingCurveSchema.describe('Easing curve for interpolation to next keyframe'),
});
export type MCPKeyframe = z.infer<typeof KeyframeSchema>;

/**
 * A property track contains keyframes for a single animatable property.
 */
export const PropertyTrackSchema = z.object({
  id: z.string().describe('Unique property track identifier'),
  propertyPath: PropertyPathSchema.describe('Property being keyframed'),
  keyframes: z.array(KeyframeSchema).describe('Keyframes on this track'),
  loopKeyframes: z.boolean().default(false).describe('Loop keyframe pattern'),
});
export type MCPPropertyTrack = z.infer<typeof PropertyTrackSchema>;

/**
 * A content frame: a segment of ASCII canvas data with timing.
 */
export const ContentFrameSchema = z.object({
  id: z.string().describe('Unique content frame identifier'),
  name: z.string().describe('Content frame display name'),
  startFrame: z.number().int().min(0).describe('Starting frame number'),
  durationFrames: z.number().int().min(1).describe('Duration in frames'),
  data: CanvasDataSchema.describe('Cell data for this content frame'),
  hidden: z.boolean().optional().describe('Whether frame is hidden from playback'),
});
export type MCPContentFrame = z.infer<typeof ContentFrameSchema>;

/**
 * An effect keyframe for animating effect properties.
 */
export const EffectKeyframeSchema = z.object({
  id: z.string().describe('Unique keyframe identifier'),
  frame: z.number().int().min(0).describe('Frame number'),
  value: z.union([z.number(), z.boolean(), z.string(), z.record(z.string(), z.string())]).describe('Keyframe value'),
  easing: EasingCurveSchema.describe('Easing curve'),
});
export type MCPEffectKeyframe = z.infer<typeof EffectKeyframeSchema>;

/**
 * An effect property track for keyframing a single property of an effect.
 */
export const EffectPropertyTrackSchema = z.object({
  id: z.string().describe('Unique property track identifier'),
  propertyPath: z.string().describe('Property path within effect settings'),
  keyframes: z.array(EffectKeyframeSchema).describe('Keyframes on this property'),
  loopKeyframes: z.boolean().optional().describe('Whether keyframes loop'),
});
export type MCPEffectPropertyTrack = z.infer<typeof EffectPropertyTrackSchema>;

/**
 * An effect block: a single effect instance with settings and timing.
 */
export const EffectBlockSchema = z.object({
  id: z.string().describe('Unique effect block identifier'),
  effectType: z.string().describe('Effect type (levels, hue-saturation, remap-colors, remap-characters, scatter, wave-warp, wiggle)'),
  startFrame: z.number().int().min(0).describe('Start frame of effect'),
  durationFrames: z.number().int().min(1).describe('Duration in frames'),
  enabled: z.boolean().default(true).describe('Whether effect is active'),
  settings: z.record(z.string(), z.unknown()).describe('Effect-specific settings'),
  propertyTracks: z.array(EffectPropertyTrackSchema).describe('Keyframed effect properties'),
});
export type MCPEffectBlock = z.infer<typeof EffectBlockSchema>;

/**
 * An effect track: wraps an effect block with ownership and UI state.
 */
export const EffectTrackSchema = z.object({
  id: z.string().describe('Unique effect track identifier'),
  ownerId: z.string().nullable().describe('Owner layer/group ID, null for global'),
  effectBlock: EffectBlockSchema.describe('The effect block'),
  collapsed: z.boolean().optional().describe('Whether track is collapsed in UI'),
});
export type MCPEffectTrack = z.infer<typeof EffectTrackSchema>;

/**
 * A layer in the composition.
 */
export const LayerSchema = z.object({
  id: z.string().describe('Unique layer identifier'),
  name: z.string().describe('Layer display name'),
  visible: z.boolean().default(true).describe('Whether layer is visible'),
  solo: z.boolean().default(false).describe('Solo mode'),
  locked: z.boolean().default(false).describe('Prevent editing'),
  opacity: z.number().min(0).max(100).default(100).describe('Layer opacity 0-100'),
  contentFrames: z.array(ContentFrameSchema).describe('Content frames on this layer'),
  propertyTracks: z.array(PropertyTrackSchema).describe('Keyframeable property tracks'),
  effectTracks: z.array(EffectTrackSchema).optional().describe('Procedural effect tracks on this layer'),
  staticProperties: z.record(z.string(), z.number()).optional().describe('Non-keyframed property values'),
  parentGroupId: z.string().optional().describe('Parent group ID if in a group'),
  syncKeyframesToFrames: z.boolean().optional().describe('Sync keyframes when content frames move'),
});
export type MCPLayer = z.infer<typeof LayerSchema>;

/**
 * A layer group for organizational and transform purposes.
 */
export const LayerGroupSchema = z.object({
  id: z.string().describe('Unique group identifier'),
  name: z.string().describe('Group display name'),
  childLayerIds: z.array(z.string()).describe('IDs of layers in this group'),
  visible: z.boolean().default(true),
  solo: z.boolean().default(false),
  locked: z.boolean().default(false),
  collapsed: z.boolean().default(false),
  propertyTracks: z.array(PropertyTrackSchema).optional().describe('Group-level keyframeable tracks'),
  effectTracks: z.array(EffectTrackSchema).optional().describe('Procedural effect tracks on this group'),
  staticProperties: z.record(z.string(), z.number()).optional(),
});
export type MCPLayerGroup = z.infer<typeof LayerGroupSchema>;

/**
 * Timeline configuration.
 */
export const TimelineConfigSchema = z.object({
  frameRate: z.number().min(1).max(120).default(12).describe('Frames per second'),
  durationFrames: z.number().int().min(1).default(12).describe('Total timeline length in frames'),
});
export type TimelineConfig = z.infer<typeof TimelineConfigSchema>;

/**
 * v2.0.0 Session data format with layer support.
 */
export const SessionDataV2Schema = z.object({
  version: z.enum(['2.0.0', '2.1.0']),
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: z.object({
    exportedAt: z.string().optional(),
    exportVersion: z.string().optional(),
    userAgent: z.string().optional(),
  }).optional(),

  canvas: z.object({
    width: z.number().int().min(4).max(200),
    height: z.number().int().min(4).max(100),
    canvasBackgroundColor: z.string(),
    showGrid: z.boolean().default(true),
  }),

  timeline: z.object({
    frameRate: z.number().min(1).max(120).default(12),
    durationFrames: z.number().int().min(1).default(12),
    looping: z.boolean().default(true),
  }),

  layers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    visible: z.boolean().default(true),
    solo: z.boolean().default(false),
    locked: z.boolean().default(false),
    opacity: z.number().default(100),
    parentGroupId: z.string().optional(),
    contentFrames: z.array(z.object({
      id: z.string(),
      name: z.string(),
      startFrame: z.number().int().min(0),
      durationFrames: z.number().int().min(1),
      data: z.record(z.string(), CellSchema).optional(),
      hidden: z.boolean().optional(),
    })),
    propertyTracks: z.array(z.object({
      id: z.string(),
      propertyPath: z.string(),
      loopKeyframes: z.boolean().default(false),
      keyframes: z.array(z.object({
        id: z.string(),
        frame: z.number().int().min(0),
        value: z.union([z.number(), z.boolean(), z.string()]),
        easing: EasingCurveSchema,
      })),
    })),
    staticProperties: z.record(z.string(), z.number()).optional(),
    syncKeyframesToFrames: z.boolean().optional(),
  })),

  layerGroups: z.array(LayerGroupSchema).optional(),
  globalEffects: z.array(EffectTrackSchema).optional(),
  tools: ToolStateSchema.optional(),
  typography: TypographySettingsSchema.optional(),
  ui: UIStateSchema.optional(),
});

export type SessionDataV2 = z.infer<typeof SessionDataV2Schema>;

/**
 * Detect session format version from raw data.
 */
export function detectSessionVersion(data: unknown): '1.0.0' | '2.0.0' | 'unknown' {
  if (typeof data !== 'object' || data === null) return 'unknown';
  const session = data as Record<string, unknown>;
  if (session.version === '2.0.0' && 'layers' in session) return '2.0.0';
  if (session.version === '2.1.0' && 'layers' in session) return '2.0.0';
  if ('animation' in session) return '1.0.0';
  return 'unknown';
}

/**
 * Generate a unique layer ID.
 */
export function generateLayerId(): string {
  return `layer-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate a unique content frame ID.
 */
export function generateContentFrameId(): string {
  return `cf-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate a unique property track ID.
 */
export function generatePropertyTrackId(): string {
  return `pt-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate a unique keyframe ID.
 */
export function generateKeyframeId(): string {
  return `kf-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate a unique layer group ID.
 */
export function generateLayerGroupId(): string {
  return `group-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate a unique effect track ID.
 */
export function generateEffectTrackId(): string {
  return `et-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate a unique effect block ID.
 */
export function generateEffectBlockId(): string {
  return `eb-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate a unique effect property track ID.
 */
export function generateEffectPropertyTrackId(): string {
  return `ept-${crypto.randomUUID().slice(0, 8)}`;
}

// ============================================================================
// Selection Types
// ============================================================================

export const RectangleSelectionSchema = z.object({
  type: z.literal('rectangle'),
  start: z.object({ x: z.number().int(), y: z.number().int() }),
  end: z.object({ x: z.number().int(), y: z.number().int() }),
});

export const CellSetSelectionSchema = z.object({
  type: z.literal('cells'),
  cells: z.array(z.string().regex(/^\d+,\d+$/)).describe('Array of "x,y" cell keys'),
});

export const SelectionSchema = z.discriminatedUnion('type', [
  RectangleSelectionSchema,
  CellSetSelectionSchema,
]);

export type Selection = z.infer<typeof SelectionSchema>;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create a cell key from coordinates
 */
export function createCellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Parse a cell key to coordinates
 */
export function parseCellKey(key: string): { x: number; y: number } {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

/**
 * Check if coordinates are within canvas bounds
 */
export function isInBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && x < width && y >= 0 && y < height;
}

/**
 * Generate a new UUID for frame IDs
 */
export function generateFrameId(): FrameId {
  return crypto.randomUUID() as FrameId;
}

/**
 * Convert Map-based canvas data to Record for serialization
 */
export function mapToRecord(map: Map<string, Cell>): CanvasData {
  const record: CanvasData = {};
  map.forEach((cell, key) => {
    record[key] = cell;
  });
  return record;
}

/**
 * Convert Record-based canvas data to Map for manipulation
 */
export function recordToMap(record: CanvasData): Map<string, Cell> {
  return new Map(Object.entries(record));
}
