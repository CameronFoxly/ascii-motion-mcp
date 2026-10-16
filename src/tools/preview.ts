/**
 * Preview Tools
 * 
 * Token-efficient tools for getting canvas state without transferring full data.
 * LLMs should use these to understand content before making edits.
 */

import { z } from 'zod';
import { McpServer } from '../mcp.js';
import { getProjectManager } from '../state.js';
import { ensureFreshBrowserState } from '../state.js';
import { parseCellKey, type Cell, type Frame } from '../types.js';
import {
  framesToAnsi,
  type AnsiColorMode,
  type AnsiFrameSelection,
} from './ansi-renderer.js';

export const MAX_CANVAS_RENDER_FRAMES = 24;
export const MAX_CANVAS_RENDER_OUTPUT_BYTES = 1024 * 1024;
export const MAX_CANVAS_RENDER_WIDTH = 200;

export interface CanvasRenderInput {
  frameIndex?: number;
  allFrames?: boolean;
  colorMode?: AnsiColorMode;
  maxWidth?: number;
  trimEmpty?: boolean;
}

export interface CanvasRenderState {
  width: number;
  height: number;
  backgroundColor: string;
  frames: readonly Frame[];
  currentFrameIndex: number;
}

export interface CanvasRenderDependencies {
  ensureFreshState: () => Promise<unknown>;
  getState: () => CanvasRenderState;
  getFrameAtTime?: (frame: number) => Frame;
  getFrameCount?: () => number;
}

export interface CanvasRenderLimits {
  maxFrames: number;
  maxOutputBytes: number;
}

export interface CanvasRenderToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

const DEFAULT_CANVAS_RENDER_DEPENDENCIES: CanvasRenderDependencies = {
  ensureFreshState: ensureFreshBrowserState,
  getState: () => getProjectManager().getState(),
  getFrameAtTime: frame => {
    const pm = getProjectManager();
    const sample = pm.getFrameAtTime(frame);
    return pm.isLayerMode() ? { ...sample, duration: 1000 / pm.getState().frameRate } : sample;
  },
  getFrameCount: () => {
    const pm = getProjectManager();
    return pm.isLayerMode() ? pm.getState().timelineConfig.durationFrames : pm.getState().frames.length;
  },
};

const DEFAULT_CANVAS_RENDER_LIMITS: CanvasRenderLimits = {
  maxFrames: MAX_CANVAS_RENDER_FRAMES,
  maxOutputBytes: MAX_CANVAS_RENDER_OUTPUT_BYTES,
};

// Region schema with optional fields to handle partial inputs from MCP Inspector
const RegionSchema = z.object({
  x: z.number().int().optional().default(0),
  y: z.number().int().optional().default(0),
  width: z.number().int().min(1).optional(),
  height: z.number().int().min(1).optional(),
}).optional();

/** Preview tools read flattened cell frames; procedural generators render in the app */
function generatorNote(): { generatorNote?: string } {
  const count = getProjectManager().getGeneratorLayers().length;
  if (count === 0) return {};
  return {
    generatorNote: `${count} procedural generator layer(s) are not included in this cell preview. ` +
      'Use render_generator_frames (live) to see generator output.',
  };
}

export function registerPreviewTools(server: McpServer): void {
  // ==========================================================================
  // get_canvas_summary - Very compact overview (~30 tokens)
  // ==========================================================================
  server.tool(
    'get_canvas_summary',
    'Get a compact summary of the canvas (dimensions, fill count, bounding box). Use this first to understand the canvas before requesting more detail.',
    {
      frameIndex: z.number().int().optional().describe('Frame index (defaults to current)'),
    },
    async ({ frameIndex }) => {
      await ensureFreshBrowserState();
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frameCount = pm.isLayerMode() ? state.timelineConfig.durationFrames : state.frames.length;
      if (frameIndex !== undefined && (frameIndex < 0 || frameIndex >= frameCount)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      const frame = pm.getFrameAtTime(frameIndex ?? state.currentFrameIndex);
      const cells = Object.entries(frame.data);
      
      if (cells.length === 0) {
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({
              width: state.width,
              height: state.height,
              isEmpty: true,
              cellCount: 0,
              ...generatorNote(),
            }) 
          }],
        };
      }
      
      // Calculate bounding box
      let minX = state.width, maxX = 0, minY = state.height, maxY = 0;
      const charCounts: Record<string, number> = {};
      
      for (const [key, cell] of cells) {
        const { x, y } = parseCellKey(key);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        charCounts[cell.char] = (charCounts[cell.char] || 0) + 1;
      }
      
      // Get top 5 most used characters
      const topChars = Object.entries(charCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([char, count]) => ({ char, count }));
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            width: state.width,
            height: state.height,
            isEmpty: false,
            cellCount: cells.length,
            boundingBox: {
              minX, minY, maxX, maxY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            },
            topCharacters: topChars,
            ...generatorNote(),
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // get_canvas_render - Raw ANSI terminal render
  // ==========================================================================
  server.tool(
    'get_canvas_render',
    'Render the current frame (or a bounded set of all frames) as raw ANSI-colored terminal text. The text payload contains actual ESC bytes and can be printed directly.',
    {
      frameIndex: z.number().int().min(0).optional().describe('Frame index (defaults to current). Cannot be combined with allFrames.'),
      allFrames: z.boolean().default(false).describe(`Render every frame with separators (maximum ${MAX_CANVAS_RENDER_FRAMES} frames)`),
      colorMode: z.enum(['16', '256', 'truecolor']).default('truecolor').describe('ANSI color mode'),
      maxWidth: z.number().int().min(1).max(MAX_CANVAS_RENDER_WIDTH).optional().describe('Downsample to at most this many character columns without upscaling'),
      trimEmpty: z.boolean().default(true).describe('Trim empty outer rows and columns before rendering'),
    },
    async (input) => getCanvasRender(input)
  );

  // ==========================================================================
  // get_canvas_preview - Sparse cell data
  // ==========================================================================
  server.tool(
    'get_canvas_preview',
    'Get non-empty cells in a region. Use for inspecting specific areas.',
    {
      frameIndex: z.number().int().optional().describe('Frame index (defaults to current)'),
      region: RegionSchema.describe('Region to preview (defaults to entire canvas)'),
      maxCells: z.number().int().min(1).max(1000).default(100).describe('Maximum cells to return'),
      offset: z.number().int().min(0).default(0).describe('Cell offset from the previous page'),
    },
    async ({ frameIndex, region, maxCells, offset = 0 }) => {
      await ensureFreshBrowserState();
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frameCount = pm.isLayerMode() ? state.timelineConfig.durationFrames : state.frames.length;
      if (frameIndex !== undefined && (frameIndex < 0 || frameIndex >= frameCount)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }

      const frame = pm.getFrameAtTime(frameIndex ?? state.currentFrameIndex);
      
      const regionX = region?.x ?? 0;
      const regionY = region?.y ?? 0;
      const regionWidth = region?.width ?? state.width;
      const regionHeight = region?.height ?? state.height;
      
      const cells: Array<{ x: number; y: number; char: string; color: string; bgColor: string }> = [];
      
      for (const [key, cell] of Object.entries(frame.data)) {
        const { x, y } = parseCellKey(key);
        
        if (x >= regionX && x < regionX + regionWidth && y >= regionY && y < regionY + regionHeight) {
          cells.push({ x, y, ...cell });
        }
      }
      
      // Sort by row, then column for readability
      cells.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
      const page = cells.slice(offset, offset + maxCells);
      const nextOffset = offset + page.length < cells.length ? offset + page.length : null;
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            region: { x: regionX, y: regionY, width: regionWidth, height: regionHeight },
            cellCount: page.length,
            totalCells: cells.length,
            truncated: nextOffset !== null,
            nextOffset,
            cells: page,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // get_canvas_ascii - Raw text grid
  // ==========================================================================
  server.tool(
    'get_canvas_ascii',
    'Get the canvas as raw ASCII text (characters only, no color info). Good for verifying visual appearance.',
    {
      frameIndex: z.number().int().optional().describe('Frame index (defaults to current)'),
      region: RegionSchema.describe('Region to render (defaults to bounding box of content)'),
      trimEmpty: z.boolean().default(true).describe('Trim empty rows/columns around content'),
      overlayPreviousFrame: z.boolean().default(false).describe('Show previous frame content as dim (for motion context)'),
    },
    async ({ frameIndex, region, trimEmpty, overlayPreviousFrame }) => {
      await ensureFreshBrowserState();
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frameIdx = frameIndex ?? state.currentFrameIndex;
      const frameCount = pm.isLayerMode() ? state.timelineConfig.durationFrames : state.frames.length;
      if (frameIdx < 0 || frameIdx >= frameCount) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      const frame = pm.getFrameAtTime(frameIdx);
      const cells = Object.entries(frame.data);
      
      // Handle empty canvas
      if (cells.length === 0) {
        // If region is specified, render that region as empty
        if (region?.width && region?.height) {
          const emptyLines = Array(region.height).fill(' '.repeat(region.width));
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                isEmpty: true,
                bounds: { x: region.x ?? 0, y: region.y ?? 0, width: region.width, height: region.height },
                ascii: emptyLines.join('\n'),
              }) 
            }],
          };
        }
        // No region and no content - return empty indicator
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              isEmpty: true, 
              ascii: '',
              hint: 'Canvas is empty. Draw some characters first with set_cell or paste_ascii_block.',
              ...generatorNote(),
            }) 
          }],
        };
      }
      
      // Calculate bounds from existing content
      let minX = state.width, maxX = 0, minY = state.height, maxY = 0;
      
      for (const [key] of cells) {
        const { x, y } = parseCellKey(key);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      
      // Use provided region or calculated bounds
      const renderX = region?.x ?? (trimEmpty ? minX : 0);
      const renderY = region?.y ?? (trimEmpty ? minY : 0);
      const renderWidth = region?.width ?? (trimEmpty ? maxX - minX + 1 : state.width);
      const renderHeight = region?.height ?? (trimEmpty ? maxY - minY + 1 : state.height);
      
      // Build ASCII grid
      const lines: string[] = [];
      
      for (let y = renderY; y < renderY + renderHeight; y++) {
        let line = '';
        for (let x = renderX; x < renderX + renderWidth; x++) {
          const key = `${x},${y}`;
          const cell = frame.data[key];
          
          if (cell) {
            line += cell.char;
          } else if (overlayPreviousFrame && frameIdx > 0) {
            // Show previous frame content as placeholder
            const prevFrame = pm.getFrameAtTime(frameIdx - 1);
            const prevCell = prevFrame.data[key];
            line += prevCell ? '·' : ' '; // Dim dot for previous frame content
          } else {
            line += ' ';
          }
        }
        lines.push(line);
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            bounds: { x: renderX, y: renderY, width: renderWidth, height: renderHeight },
            ascii: lines.join('\n'),
            ...generatorNote(),
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // get_frame_diff - Difference between two frames
  // ==========================================================================
  server.tool(
    'get_frame_diff',
    'Get the cells that differ between two frames. Useful for understanding animation changes.',
    {
      frameA: z.number().int().describe('First frame index'),
      frameB: z.number().int().describe('Second frame index'),
      maxCells: z.number().int().min(1).max(500).default(50).describe('Maximum changed cells per page'),
      offset: z.number().int().min(0).default(0).describe('Changed-cell offset from the previous page'),
    },
    async ({ frameA, frameB, maxCells, offset = 0 }) => {
      await ensureFreshBrowserState();
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frameCount = pm.isLayerMode() ? state.timelineConfig.durationFrames : state.frames.length;
      if (frameA < 0 || frameA >= frameCount || frameB < 0 || frameB >= frameCount) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      const dataA = pm.getFrameAtTime(frameA).data;
      const dataB = pm.getFrameAtTime(frameB).data;
      
      const allKeys = new Set([...Object.keys(dataA), ...Object.keys(dataB)]);
      const diffs: Array<{
        x: number;
        y: number;
        before: Cell | null;
        after: Cell | null;
        change: 'added' | 'removed' | 'modified';
      }> = [];
      
      for (const key of allKeys) {
        const cellA = dataA[key];
        const cellB = dataB[key];
        
        if (!cellA && cellB) {
          diffs.push({ ...parseCellKey(key), before: null, after: cellB, change: 'added' });
        } else if (cellA && !cellB) {
          diffs.push({ ...parseCellKey(key), before: cellA, after: null, change: 'removed' });
        } else if (cellA && cellB && (cellA.char !== cellB.char || cellA.color !== cellB.color || cellA.bgColor !== cellB.bgColor)) {
          diffs.push({ ...parseCellKey(key), before: cellA, after: cellB, change: 'modified' });
        }
        
      }
      
      const summary = {
        added: diffs.filter(d => d.change === 'added').length,
        removed: diffs.filter(d => d.change === 'removed').length,
        modified: diffs.filter(d => d.change === 'modified').length,
      };
      diffs.sort((a, b) => a.y - b.y || a.x - b.x);
      const page = diffs.slice(offset, offset + maxCells);
      const nextOffset = offset + page.length < diffs.length ? offset + page.length : null;
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            frameA,
            frameB,
            totalDiffs: diffs.length,
            returnedCount: page.length,
            truncated: nextOffset !== null,
            nextOffset,
            summary,
            diffs: page,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // describe_animation - High-level animation description
  // ==========================================================================
  server.tool(
    'describe_animation',
    'Get a high-level description of the animation: frame count, timing, and motion patterns.',
    {},
    async () => {
      await ensureFreshBrowserState();
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frames = state.frames;
      const totalDuration = frames.reduce((sum, f) => sum + f.duration, 0);
      const avgDuration = totalDuration / frames.length;
      
      // Analyze motion by comparing consecutive frames
      const motionAnalysis: Array<{ fromFrame: number; toFrame: number; cellsChanged: number }> = [];
      
      for (let i = 0; i < frames.length - 1; i++) {
        const dataA = frames[i].data;
        const dataB = frames[i + 1].data;
        const allKeys = new Set([...Object.keys(dataA), ...Object.keys(dataB)]);
        
        let changes = 0;
        for (const key of allKeys) {
          const cellA = dataA[key];
          const cellB = dataB[key];
          
          if (!cellA !== !cellB) {
            changes++;
          } else if (cellA && cellB && (cellA.char !== cellB.char || cellA.color !== cellB.color || cellA.bgColor !== cellB.bgColor)) {
            changes++;
          }
        }
        
        motionAnalysis.push({ fromFrame: i, toFrame: i + 1, cellsChanged: changes });
      }
      
      const totalChanges = motionAnalysis.reduce((sum, m) => sum + m.cellsChanged, 0);
      const avgChangesPerTransition = motionAnalysis.length > 0 ? totalChanges / motionAnalysis.length : 0;
      
      // Identify the most active transition
      const mostActiveTransition = motionAnalysis.length > 0
        ? motionAnalysis.reduce((max, m) => m.cellsChanged > max.cellsChanged ? m : max)
        : null;
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            frameCount: frames.length,
            looping: state.looping,
            frameRate: state.frameRate,
            timing: {
              totalDurationMs: totalDuration,
              totalDurationSeconds: (totalDuration / 1000).toFixed(2),
              averageFrameDurationMs: Math.round(avgDuration),
              frameRangeMs: { min: Math.min(...frames.map(f => f.duration)), max: Math.max(...frames.map(f => f.duration)) },
            },
            motion: {
              totalCellChanges: totalChanges,
              averageChangesPerTransition: Math.round(avgChangesPerTransition),
              mostActiveTransition,
              isStatic: totalChanges === 0,
            },
            frames: frames.map((f, i) => ({
              index: i,
              name: f.name,
              duration: f.duration,
              cellCount: Object.keys(f.data).length,
            })),
          }) 
        }],
      };
    }
  );
}

export async function getCanvasRender(
  input: CanvasRenderInput,
  dependencies: CanvasRenderDependencies = DEFAULT_CANVAS_RENDER_DEPENDENCIES,
  limits: CanvasRenderLimits = DEFAULT_CANVAS_RENDER_LIMITS
): Promise<CanvasRenderToolResult> {
  await dependencies.ensureFreshState();
  const state = dependencies.getState();
  const frameCount = dependencies.getFrameCount?.() ?? state.frames.length;
  const frameAt = (index: number): Frame => dependencies.getFrameAtTime?.(index) ?? state.frames[index];
  const allFrames = input.allFrames ?? false;

  if (allFrames && input.frameIndex !== undefined) {
    return canvasRenderError('frameIndex cannot be combined with allFrames=true.');
  }

  if (input.maxWidth !== undefined
    && (!Number.isInteger(input.maxWidth) || input.maxWidth < 1 || input.maxWidth > MAX_CANVAS_RENDER_WIDTH)) {
    return canvasRenderError(`maxWidth must be an integer between 1 and ${MAX_CANVAS_RENDER_WIDTH}.`);
  }

  if (frameCount === 0) {
    return canvasRenderError('The project has no frames to render.');
  }

  let selections: AnsiFrameSelection[];
  if (allFrames) {
    if (frameCount > limits.maxFrames) {
      return canvasRenderError(
        `Cannot render all ${frameCount} frames: allFrames is limited to ${limits.maxFrames} frames. Use frameIndex to render one frame.`
      );
    }
    selections = Array.from({ length: frameCount }, (_, index) => ({ frame: frameAt(index), index }));
  } else {
    const frameIndex = input.frameIndex ?? state.currentFrameIndex;
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frameCount) {
      return canvasRenderError(
        `Frame index ${frameIndex} is out of range. Valid frame indexes are 0-${frameCount - 1}.`
      );
    }
    selections = [{ frame: frameAt(frameIndex), index: frameIndex }];
  }

  const ansi = framesToAnsi(
    selections,
    state.width,
    state.height,
    {
      colorMode: input.colorMode ?? 'truecolor',
      canvasBackground: state.backgroundColor,
      maxWidth: input.maxWidth,
      trimEmpty: input.trimEmpty ?? true,
    },
    allFrames
  );

  const outputBytes = Buffer.byteLength(ansi, 'utf8');
  if (outputBytes > limits.maxOutputBytes) {
    return canvasRenderError(
      `ANSI render is ${outputBytes} bytes, exceeding the ${limits.maxOutputBytes}-byte output limit. Reduce maxWidth or render a single frame.`
    );
  }

  return {
    content: [{ type: 'text', text: ansi }],
  };
}

function canvasRenderError(message: string): CanvasRenderToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
