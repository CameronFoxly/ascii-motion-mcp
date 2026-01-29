/**
 * Canvas Tools
 * 
 * Tools for manipulating individual cells and regions on the canvas.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager, broadcastStateChange } from '../state.js';
import { isInBounds } from '../types.js';

export function registerCanvasTools(server: McpServer): void {
  // ==========================================================================
  // get_cell - Get a single cell from the canvas
  // ==========================================================================
  server.tool(
    'get_cell',
    'Get the character and colors at a specific canvas position',
    {
      x: z.number().int().describe('X coordinate (0-based, left to right)'),
      y: z.number().int().describe('Y coordinate (0-based, top to bottom)'),
      frameIndex: z.number().int().optional().describe('Frame index (defaults to current frame)'),
    },
    async ({ x, y, frameIndex }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      // Switch frame if specified
      if (frameIndex !== undefined) {
        if (frameIndex < 0 || frameIndex >= state.frames.length) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Frame index ${frameIndex} out of range (0-${state.frames.length - 1})` }) }],
            isError: true,
          };
        }
        pm.goToFrame(frameIndex);
      }
      
      if (!isInBounds(x, y, state.width, state.height)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Coordinates (${x}, ${y}) out of bounds (canvas is ${state.width}x${state.height})` }) }],
          isError: true,
        };
      }
      
      const cell = pm.getCell(x, y);
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            x, 
            y, 
            cell,
            isEmpty: cell.char === ' ' && cell.bgColor === 'transparent',
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // set_cell - Set a single cell on the canvas
  // ==========================================================================
  server.tool(
    'set_cell',
    'Set the character and/or colors at a specific canvas position',
    {
      x: z.number().int().describe('X coordinate (0-based)'),
      y: z.number().int().describe('Y coordinate (0-based)'),
      char: z.string().length(1).optional().describe('Single character to set'),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Foreground color (hex, e.g., #FFFFFF)'),
      bgColor: z.string().optional().describe('Background color (hex or "transparent")'),
    },
    async ({ x, y, char, color, bgColor }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (!isInBounds(x, y, state.width, state.height)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Coordinates (${x}, ${y}) out of bounds` }) }],
          isError: true,
        };
      }
      
      // Get current cell and merge with new values
      const currentCell = pm.getCell(x, y);
      const newCell = {
        char: char ?? currentCell.char,
        color: color ?? currentCell.color,
        bgColor: bgColor ?? currentCell.bgColor,
      };
      
      pm.setCell(x, y, newCell);
      
      // Broadcast state change to connected browsers
      broadcastStateChange('set_cell', { x, y, cell: newCell });
      
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, x, y, cell: newCell }) }],
      };
    }
  );

  // ==========================================================================
  // clear_cell - Clear a single cell (reset to empty)
  // ==========================================================================
  server.tool(
    'clear_cell',
    'Clear a cell, resetting it to empty (space with transparent background)',
    {
      x: z.number().int().describe('X coordinate'),
      y: z.number().int().describe('Y coordinate'),
    },
    async ({ x, y }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (!isInBounds(x, y, state.width, state.height)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Coordinates (${x}, ${y}) out of bounds` }) }],
          isError: true,
        };
      }
      
      pm.clearCell(x, y);
      
      // Broadcast state change to connected browsers
      broadcastStateChange('clear_cell', { x, y });
      
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, x, y }) }],
      };
    }
  );

  // ==========================================================================
  // set_cells_batch - Set multiple cells at once (efficient for large edits)
  // ==========================================================================
  server.tool(
    'set_cells_batch',
    'Set multiple cells in a single operation. More efficient than calling set_cell repeatedly.',
    {
      cells: z.array(z.object({
        x: z.number().int(),
        y: z.number().int(),
        char: z.string().length(1).optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        bgColor: z.string().optional(),
      })).describe('Array of cells to set (max 10,000). Each cell can specify any combination of char, color, bgColor.'),
    },
    async ({ cells }) => {
      // Security: limit batch size to prevent DoS
      const MAX_BATCH_SIZE = 10000;
      if (cells.length > MAX_BATCH_SIZE) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Batch size ${cells.length} exceeds maximum of ${MAX_BATCH_SIZE}` }) }],
        };
      }
      const pm = getProjectManager();
      const state = pm.getState();
      
      const toSet: Array<{ x: number; y: number; cell: { char: string; color: string; bgColor: string } }> = [];
      const errors: string[] = [];
      
      for (const { x, y, char, color, bgColor } of cells) {
        if (!isInBounds(x, y, state.width, state.height)) {
          errors.push(`(${x}, ${y}) out of bounds`);
          continue;
        }
        
        const currentCell = pm.getCell(x, y);
        toSet.push({
          x,
          y,
          cell: {
            char: char ?? currentCell.char,
            color: color ?? currentCell.color,
            bgColor: bgColor ?? currentCell.bgColor,
          },
        });
      }
      
      const count = pm.setCells(toSet);
      
      // Broadcast state change to connected browsers
      broadcastStateChange('set_cells_batch', { cells: toSet });
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true, 
            cellsSet: count,
            errors: errors.length > 0 ? errors : undefined,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // paste_ascii_block - Paste a block of ASCII text onto the canvas
  // ==========================================================================
  server.tool(
    'paste_ascii_block',
    'Paste a multi-line ASCII art block onto the canvas at a specified position. Great for pasting found ASCII art.',
    {
      text: z.string().describe('Multi-line ASCII text to paste'),
      x: z.number().int().default(0).describe('X position for top-left corner'),
      y: z.number().int().default(0).describe('Y position for top-left corner'),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FFFFFF').describe('Text color for all pasted characters'),
      bgColor: z.string().default('transparent').describe('Background color for all pasted characters'),
      preserveSpaces: z.boolean().default(false).describe('If true, spaces will overwrite existing cells. If false, spaces are transparent.'),
    },
    async ({ text, x, y, color, bgColor, preserveSpaces }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const lines = text.split('\n');
      const toSet: Array<{ x: number; y: number; cell: { char: string; color: string; bgColor: string } }> = [];
      let charsPasted = 0;
      let charsSkipped = 0;
      
      for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
        for (let col = 0; col < line.length; col++) {
          const char = line[col];
          const cellX = x + col;
          const cellY = y + row;
          
          if (!isInBounds(cellX, cellY, state.width, state.height)) {
            charsSkipped++;
            continue;
          }
          
          // Skip spaces unless preserveSpaces is true
          if (char === ' ' && !preserveSpaces) {
            continue;
          }
          
          toSet.push({
            x: cellX,
            y: cellY,
            cell: { char, color, bgColor },
          });
          charsPasted++;
        }
      }
      
      pm.setCells(toSet);
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            lines: lines.length,
            maxWidth: Math.max(...lines.map(l => l.length)),
            charsPasted,
            charsSkipped,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // fill_region - Flood fill or global fill
  // ==========================================================================
  server.tool(
    'fill_region',
    'Fill a region with a character and colors. Can be contiguous (flood fill) or global (all matching cells).',
    {
      x: z.number().int().describe('Starting X coordinate'),
      y: z.number().int().describe('Starting Y coordinate'),
      char: z.string().length(1).describe('Character to fill with'),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FFFFFF').describe('Fill color'),
      bgColor: z.string().default('transparent').describe('Fill background color'),
      contiguous: z.boolean().default(true).describe('If true, only fills connected cells. If false, fills all matching cells.'),
      matchChar: z.boolean().default(false).describe('Only fill cells that match the starting cell character'),
      matchColor: z.boolean().default(false).describe('Only fill cells that match the starting cell color'),
      matchBgColor: z.boolean().default(false).describe('Only fill cells that match the starting cell background'),
    },
    async ({ x, y, char, color, bgColor, contiguous, matchChar, matchColor, matchBgColor }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (!isInBounds(x, y, state.width, state.height)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Starting position (${x}, ${y}) out of bounds` }) }],
          isError: true,
        };
      }
      
      const fillCell = { char, color, bgColor };
      const cellsFilled = pm.fillRegion(x, y, fillCell, {
        contiguous,
        matchChar,
        matchColor,
        matchBgColor,
      });
      
      // Broadcast state change to connected browsers
      broadcastStateChange('fill_region', { cellsFilled });
      
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, cellsFilled }) }],
      };
    }
  );

  // ==========================================================================
  // resize_canvas - Change canvas dimensions
  // ==========================================================================
  server.tool(
    'resize_canvas',
    'Resize the canvas. Content outside the new bounds will be clipped.',
    {
      width: z.number().int().min(4).max(200).describe('New width (4-200)'),
      height: z.number().int().min(4).max(100).describe('New height (4-100)'),
    },
    async ({ width, height }) => {
      const pm = getProjectManager();
      const previousState = pm.getState();
      const previousWidth = previousState.width;
      const previousHeight = previousState.height;
      
      pm.resizeCanvas(width, height);
      
      // Broadcast state change to connected browsers
      broadcastStateChange('resize_canvas', { width, height });
      
      const newState = pm.getState();
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            previousSize: { width: previousWidth, height: previousHeight },
            newSize: { width: newState.width, height: newState.height },
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // clear_canvas - Clear all cells on current frame
  // ==========================================================================
  server.tool(
    'clear_canvas',
    'Clear all cells on the current frame, leaving it empty',
    {},
    async () => {
      const pm = getProjectManager();
      const previousCellCount = Object.keys(pm.getCurrentFrame().data).length;
      
      pm.clearCanvas();
      
      // Broadcast state change to connected browsers
      broadcastStateChange('clear_canvas', {});
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            cellsCleared: previousCellCount,
          }) 
        }],
      };
    }
  );
}
