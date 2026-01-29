/**
 * Preview Tools
 * 
 * Token-efficient tools for getting canvas state without transferring full data.
 * LLMs should use these to understand content before making edits.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';
import { parseCellKey, type Cell } from '../types.js';

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
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (frameIndex !== undefined && (frameIndex < 0 || frameIndex >= state.frames.length)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      const frame = frameIndex !== undefined ? state.frames[frameIndex] : pm.getCurrentFrame();
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
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // get_canvas_preview - Sparse cell data
  // ==========================================================================
  server.tool(
    'get_canvas_preview',
    'Get non-empty cells in a region. Use for inspecting specific areas.',
    {
      frameIndex: z.number().int().optional().describe('Frame index (defaults to current)'),
      region: z.object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }).optional().describe('Region to preview (defaults to entire canvas)'),
      maxCells: z.number().int().min(1).max(1000).default(100).describe('Maximum cells to return'),
    },
    async ({ frameIndex, region, maxCells }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (frameIndex !== undefined && (frameIndex < 0 || frameIndex >= state.frames.length)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      const frame = frameIndex !== undefined ? state.frames[frameIndex] : pm.getCurrentFrame();
      
      const regionX = region?.x ?? 0;
      const regionY = region?.y ?? 0;
      const regionWidth = region?.width ?? state.width;
      const regionHeight = region?.height ?? state.height;
      
      const cells: Array<{ x: number; y: number; char: string; color: string; bgColor: string }> = [];
      let truncated = false;
      
      for (const [key, cell] of Object.entries(frame.data)) {
        const { x, y } = parseCellKey(key);
        
        if (x >= regionX && x < regionX + regionWidth && y >= regionY && y < regionY + regionHeight) {
          if (cells.length >= maxCells) {
            truncated = true;
            break;
          }
          cells.push({ x, y, ...cell });
        }
      }
      
      // Sort by row, then column for readability
      cells.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            region: { x: regionX, y: regionY, width: regionWidth, height: regionHeight },
            cellCount: cells.length,
            truncated,
            cells,
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
      region: z.object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }).optional().describe('Region to render (defaults to bounding box of content)'),
      trimEmpty: z.boolean().default(true).describe('Trim empty rows/columns around content'),
      overlayPreviousFrame: z.boolean().default(false).describe('Show previous frame content as dim (for motion context)'),
    },
    async ({ frameIndex, region, trimEmpty, overlayPreviousFrame }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frameIdx = frameIndex ?? state.currentFrameIndex;
      if (frameIdx < 0 || frameIdx >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      const frame = state.frames[frameIdx];
      const cells = Object.entries(frame.data);
      
      if (cells.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ isEmpty: true, ascii: '' }) }],
        };
      }
      
      // Calculate bounds
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
            const prevFrame = state.frames[frameIdx - 1];
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
      maxCells: z.number().int().min(1).max(500).default(100).describe('Maximum cells to return'),
    },
    async ({ frameA, frameB, maxCells }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (frameA < 0 || frameA >= state.frames.length || frameB < 0 || frameB >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      const dataA = state.frames[frameA].data;
      const dataB = state.frames[frameB].data;
      
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
        
        if (diffs.length >= maxCells) break;
      }
      
      const summary = {
        added: diffs.filter(d => d.change === 'added').length,
        removed: diffs.filter(d => d.change === 'removed').length,
        modified: diffs.filter(d => d.change === 'modified').length,
      };
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            frameA,
            frameB,
            totalDiffs: diffs.length,
            truncated: diffs.length >= maxCells,
            summary,
            diffs,
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
