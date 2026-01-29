/**
 * Selection Tools
 * 
 * Tools for selecting regions of the canvas.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';
import { parseCellKey, createCellKey, isInBounds, type Cell, type Selection } from '../types.js';

export function registerSelectionTools(server: McpServer): void {
  // ==========================================================================
  // select_rectangle - Select a rectangular region
  // ==========================================================================
  server.tool(
    'select_rectangle',
    'Select a rectangular region of the canvas',
    {
      x: z.number().int().describe('Top-left X coordinate'),
      y: z.number().int().describe('Top-left Y coordinate'),
      width: z.number().int().min(1).describe('Width of selection'),
      height: z.number().int().min(1).describe('Height of selection'),
    },
    async ({ x, y, width, height }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      // Clamp to canvas bounds
      const clampedX = Math.max(0, Math.min(x, state.width - 1));
      const clampedY = Math.max(0, Math.min(y, state.height - 1));
      const clampedWidth = Math.min(width, state.width - clampedX);
      const clampedHeight = Math.min(height, state.height - clampedY);
      
      const selection: Selection = {
        type: 'rectangle',
        start: { x: clampedX, y: clampedY },
        end: { x: clampedX + clampedWidth - 1, y: clampedY + clampedHeight - 1 },
      };
      
      pm.setSelection(selection);
      
      // Count cells in selection
      const frame = pm.getCurrentFrame();
      let cellCount = 0;
      for (let sy = clampedY; sy < clampedY + clampedHeight; sy++) {
        for (let sx = clampedX; sx < clampedX + clampedWidth; sx++) {
          if (frame.data[createCellKey(sx, sy)]) cellCount++;
        }
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            selection: {
              x: clampedX,
              y: clampedY,
              width: clampedWidth,
              height: clampedHeight,
            },
            nonEmptyCells: cellCount,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // select_by_color - Magic wand selection
  // ==========================================================================
  server.tool(
    'select_by_color',
    'Select cells that match specific criteria (magic wand style)',
    {
      x: z.number().int().describe('Starting X coordinate'),
      y: z.number().int().describe('Starting Y coordinate'),
      matchChar: z.boolean().default(false).describe('Match character'),
      matchColor: z.boolean().default(true).describe('Match foreground color'),
      matchBgColor: z.boolean().default(false).describe('Match background color'),
      contiguous: z.boolean().default(true).describe('Only select connected cells'),
    },
    async ({ x, y, matchChar, matchColor, matchBgColor, contiguous }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (!isInBounds(x, y, state.width, state.height)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Starting position out of bounds' }) }],
          isError: true,
        };
      }
      
      const targetCell = pm.getCell(x, y);
      
      const matches = (cell: Cell): boolean => {
        if (matchChar && cell.char !== targetCell.char) return false;
        if (matchColor && cell.color !== targetCell.color) return false;
        if (matchBgColor && cell.bgColor !== targetCell.bgColor) return false;
        return true;
      };
      
      const selectedCells: string[] = [];
      
      if (contiguous) {
        // Flood fill selection
        const visited = new Set<string>();
        const queue: Array<{ x: number; y: number }> = [{ x, y }];
        
        while (queue.length > 0) {
          const { x: cx, y: cy } = queue.shift()!;
          const key = createCellKey(cx, cy);
          
          if (visited.has(key)) continue;
          if (!isInBounds(cx, cy, state.width, state.height)) continue;
          
          visited.add(key);
          
          const currentCell = pm.getCell(cx, cy);
          if (!matches(currentCell)) continue;
          
          selectedCells.push(key);
          
          queue.push({ x: cx - 1, y: cy });
          queue.push({ x: cx + 1, y: cy });
          queue.push({ x: cx, y: cy - 1 });
          queue.push({ x: cx, y: cy + 1 });
        }
      } else {
        // Select all matching cells
        for (let cy = 0; cy < state.height; cy++) {
          for (let cx = 0; cx < state.width; cx++) {
            const currentCell = pm.getCell(cx, cy);
            if (matches(currentCell)) {
              selectedCells.push(createCellKey(cx, cy));
            }
          }
        }
      }
      
      const selection: Selection = {
        type: 'cells',
        cells: selectedCells,
      };
      
      pm.setSelection(selection);
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            targetCell,
            criteria: { matchChar, matchColor, matchBgColor, contiguous },
            cellsSelected: selectedCells.length,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // get_selection - Get current selection
  // ==========================================================================
  server.tool(
    'get_selection',
    'Get the current selection bounds and contents',
    {
      includeCells: z.boolean().default(false).describe('Include the actual cell data in the response'),
      maxCells: z.number().int().min(1).max(500).default(100).describe('Maximum cells to include'),
    },
    async ({ includeCells, maxCells }) => {
      const pm = getProjectManager();
      const selection = pm.getSelection();
      
      if (!selection) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ hasSelection: false }) }],
        };
      }
      
      const frame = pm.getCurrentFrame();
      
      if (selection.type === 'rectangle') {
        const width = selection.end.x - selection.start.x + 1;
        const height = selection.end.y - selection.start.y + 1;
        
        const result: {
          hasSelection: boolean;
          type: 'rectangle';
          bounds: { x: number; y: number; width: number; height: number };
          nonEmptyCells: number;
          cells?: Array<{ x: number; y: number; char: string; color: string; bgColor: string }>;
        } = {
          hasSelection: true,
          type: 'rectangle',
          bounds: {
            x: selection.start.x,
            y: selection.start.y,
            width,
            height,
          },
          nonEmptyCells: 0,
        };
        
        const cells: Array<{ x: number; y: number; char: string; color: string; bgColor: string }> = [];
        
        for (let y = selection.start.y; y <= selection.end.y; y++) {
          for (let x = selection.start.x; x <= selection.end.x; x++) {
            const cell = frame.data[createCellKey(x, y)];
            if (cell) {
              result.nonEmptyCells++;
              if (includeCells && cells.length < maxCells) {
                cells.push({ x, y, ...cell });
              }
            }
          }
        }
        
        if (includeCells) {
          result.cells = cells;
        }
        
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } else {
        // Cell set selection
        const result: {
          hasSelection: boolean;
          type: 'cells';
          cellCount: number;
          cells?: Array<{ x: number; y: number; char: string; color: string; bgColor: string }>;
        } = {
          hasSelection: true,
          type: 'cells',
          cellCount: selection.cells.length,
        };
        
        if (includeCells) {
          const cells: Array<{ x: number; y: number; char: string; color: string; bgColor: string }> = [];
          for (const key of selection.cells.slice(0, maxCells)) {
            const { x, y } = parseCellKey(key);
            const cell = frame.data[key] ?? pm.getCell(x, y);
            cells.push({ x, y, ...cell });
          }
          result.cells = cells;
        }
        
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }
    }
  );

  // ==========================================================================
  // clear_selection - Deselect
  // ==========================================================================
  server.tool(
    'clear_selection',
    'Clear the current selection (deselect)',
    {},
    async () => {
      const pm = getProjectManager();
      const hadSelection = pm.getSelection() !== null;
      
      pm.clearSelection();
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            hadSelection,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // apply_to_selection - Apply operation to selected cells
  // ==========================================================================
  server.tool(
    'apply_to_selection',
    'Apply an operation to all cells in the current selection',
    {
      operation: z.enum(['clear', 'fill', 'recolor']).describe('Operation to apply'),
      char: z.string().length(1).optional().describe('Character for fill operation'),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Color for fill/recolor'),
      bgColor: z.string().optional().describe('Background color for fill/recolor'),
    },
    async ({ operation, char, color, bgColor }) => {
      const pm = getProjectManager();
      const selection = pm.getSelection();
      
      if (!selection) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No selection active' }) }],
          isError: true,
        };
      }
      
      
      // Get all cell coordinates in selection
      const cellKeys: string[] = [];
      
      if (selection.type === 'rectangle') {
        for (let y = selection.start.y; y <= selection.end.y; y++) {
          for (let x = selection.start.x; x <= selection.end.x; x++) {
            cellKeys.push(createCellKey(x, y));
          }
        }
      } else {
        cellKeys.push(...selection.cells);
      }
      
      let affected = 0;
      
      for (const key of cellKeys) {
        const { x, y } = parseCellKey(key);
        
        if (operation === 'clear') {
          pm.clearCell(x, y, false);
          affected++;
        } else if (operation === 'fill') {
          pm.setCell(x, y, {
            char: char ?? '@',
            color: color ?? '#FFFFFF',
            bgColor: bgColor ?? 'transparent',
          }, false);
          affected++;
        } else if (operation === 'recolor') {
          const current = pm.getCell(x, y);
          // Only recolor non-empty cells
          if (current.char !== ' ' || current.bgColor !== 'transparent') {
            pm.setCell(x, y, {
              char: current.char,
              color: color ?? current.color,
              bgColor: bgColor ?? current.bgColor,
            }, false);
            affected++;
          }
        }
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            operation,
            cellsAffected: affected,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // delete_selection_content - Delete content within selection
  // ==========================================================================
  server.tool(
    'delete_selection_content',
    'Delete all cell content within the current selection',
    {},
    async () => {
      const pm = getProjectManager();
      const selection = pm.getSelection();
      
      if (!selection) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No selection active' }) }],
          isError: true,
        };
      }
      
      const frame = pm.getCurrentFrame();
      let deleted = 0;
      
      if (selection.type === 'rectangle') {
        for (let y = selection.start.y; y <= selection.end.y; y++) {
          for (let x = selection.start.x; x <= selection.end.x; x++) {
            const key = createCellKey(x, y);
            if (frame.data[key]) {
              delete frame.data[key];
              deleted++;
            }
          }
        }
      } else {
        for (const key of selection.cells) {
          if (frame.data[key]) {
            delete frame.data[key];
            deleted++;
          }
        }
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            cellsDeleted: deleted,
          }) 
        }],
      };
    }
  );
}
