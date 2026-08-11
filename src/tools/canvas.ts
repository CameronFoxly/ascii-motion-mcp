/**
 * Canvas Tools
 * 
 * Tools for manipulating individual cells and regions on the canvas.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';
import { ensureFreshBrowserState } from '../state.js';
import { isInBounds, type Cell } from '../types.js';
import {
  applyExactCellChanges,
  hasBrowserCommandCallback,
  requestBrowserCommand,
  requireFreshBrowserState,
} from '../live-sync.js';

function mutationErrorResponse(error: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    }],
    isError: true as const,
  };
}

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
      await ensureFreshBrowserState();
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
      
      let newCell: Cell | undefined;
      let applied;
      try {
        applied = await applyExactCellChanges({
          projectManager: pm,
          cells: () => {
            const state = pm.getState();
            if (!isInBounds(x, y, state.width, state.height)) {
              throw new Error(`Coordinates (${x}, ${y}) out of bounds`);
            }
            const currentCell = pm.getCell(x, y);
            newCell = {
              char: char ?? currentCell.char,
              color: color ?? currentCell.color,
              bgColor: bgColor ?? currentCell.bgColor,
            };
            return [{ x, y, cell: newCell }];
          },
        });
      } catch (error) {
        return mutationErrorResponse(error);
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            browserSynced: applied.browserSynced,
            frameIndex: applied.frameIndex,
            x,
            y,
            cell: newCell,
          }),
        }],
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
      
      let applied;
      try {
        applied = await applyExactCellChanges({
          projectManager: pm,
          cells: () => {
            const state = pm.getState();
            if (!isInBounds(x, y, state.width, state.height)) {
              throw new Error(`Coordinates (${x}, ${y}) out of bounds`);
            }
            return [{
              x,
              y,
              cell: { char: ' ', color: '#FFFFFF', bgColor: 'transparent' },
            }];
          },
        });
      } catch (error) {
        return mutationErrorResponse(error);
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            browserSynced: applied.browserSynced,
            frameIndex: applied.frameIndex,
            x,
            y,
          }),
        }],
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
      
      const validCells: Array<{
        x: number;
        y: number;
        char?: string;
        color?: string;
        bgColor?: string;
      }> = [];
      const errors: string[] = [];
      
      let applied;
      try {
        applied = await applyExactCellChanges({
          projectManager: pm,
          cells: () => {
            const state = pm.getState();
            for (const cell of cells) {
              const { x, y } = cell;
              if (!isInBounds(x, y, state.width, state.height)) {
                errors.push(`(${x}, ${y}) out of bounds`);
                continue;
              }
              validCells.push(cell);
            }
            return validCells.map(({ x, y, char, color, bgColor }) => {
              const currentCell = pm.getCell(x, y);
              return {
                x,
                y,
                cell: {
                  char: char ?? currentCell.char,
                  color: color ?? currentCell.color,
                  bgColor: bgColor ?? currentCell.bgColor,
                },
              };
            });
          },
        });
      } catch (error) {
        return mutationErrorResponse(error);
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            browserSynced: applied.browserSynced,
            frameIndex: applied.frameIndex,
            cellsSet: applied.cellsChanged,
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
      
      const lines = text.split('\n');
      const toSet: Array<{ x: number; y: number; cell: { char: string; color: string; bgColor: string } }> = [];
      let charsPasted = 0;
      let charsSkipped = 0;
      
      let applied;
      try {
        applied = await applyExactCellChanges({
          projectManager: pm,
          cells: () => {
            const state = pm.getState();
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
            return toSet;
          },
        });
      } catch (error) {
        return mutationErrorResponse(error);
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            browserSynced: applied.browserSynced,
            frameIndex: applied.frameIndex,
            lines: lines.length,
            maxWidth: Math.max(...lines.map(l => l.length)),
            charsPasted,
            cellsChanged: applied.cellsChanged,
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
      
      const fillCell = { char, color, bgColor };

      let applied;
      try {
        applied = await applyExactCellChanges({
          projectManager: pm,
          beforePrepare: requireFreshBrowserState,
          cells: () => {
            const state = pm.getState();
            if (!isInBounds(x, y, state.width, state.height)) {
              throw new Error(`Starting position (${x}, ${y}) out of bounds`);
            }
            return pm.planFillRegion(x, y, fillCell, {
              contiguous,
              matchChar,
              matchColor,
              matchBgColor,
            });
          },
        });
      } catch (error) {
        return mutationErrorResponse(error);
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            browserSynced: applied.browserSynced,
            frameIndex: applied.frameIndex,
            cellsFilled: applied.cellsChanged,
          }),
        }],
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
      let commandResult;
      let reconciled = false;
      const reconcileResize = (): void => {
        if (reconciled) return;
        pm.resizeCanvas(width, height);
        reconciled = true;
      };

      try {
        if (!hasBrowserCommandCallback()) {
          reconcileResize();
          commandResult = null;
        } else {
          commandResult = await requestBrowserCommand(
            { type: 'resize_canvas', width, height },
            undefined,
            reconcileResize,
          );
          if (commandResult === null) {
            throw new Error('Browser command callback was removed during canvas resize');
          }
        }
        if (commandResult !== null && !reconciled) {
          reconcileResize();
        }
      } catch (error) {
        return mutationErrorResponse(error);
      }
      
      const newState = pm.getState();
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            browserSynced: commandResult !== null,
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
      let applied;
      try {
        applied = await applyExactCellChanges({
          projectManager: pm,
          beforePrepare: requireFreshBrowserState,
          cells: () => {
            const data = pm.isLayerMode()
              ? (pm.getActiveContentFrame()?.data ?? {})
              : pm.getCurrentFrame().data;
            return Object.keys(data).map(key => {
              const [x, y] = key.split(',').map(Number);
              return {
                x,
                y,
                cell: { char: ' ', color: '#FFFFFF', bgColor: 'transparent' },
              };
            });
          },
        });
      } catch (error) {
        return mutationErrorResponse(error);
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            browserSynced: applied.browserSynced,
            frameIndex: applied.frameIndex,
            cellsCleared: applied.cellsChanged,
          }) 
        }],
      };
    }
  );
}
