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
