/**
 * Effects Tools
 * 
 * Tools for applying visual effects to canvas content:
 * - Levels (brightness/contrast)
 * - Hue/Saturation adjustments
 * - Remap colors (change color palette)
 * - Remap characters (change character set)
 * - Scatter (randomize positions)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager, broadcastStateChange } from '../state.js';
import { parseCellKey, createCellKey, type Cell } from '../types.js';

export function registerEffectsTools(server: McpServer): void {
  // ==========================================================================
  // apply_effect - Main effect application tool
  // ==========================================================================
  server.tool(
    'apply_effect',
    'Apply a visual effect to the current frame or selection. Effects modify colors and/or characters.',
    {
      effect: z.enum(['levels', 'hue-saturation', 'remap-colors', 'remap-characters', 'scatter', 'invert', 'grayscale'])
        .describe('Type of effect to apply'),
      
      // Levels settings
      brightness: z.number().min(-100).max(100).optional().describe('Brightness adjustment (-100 to 100)'),
      contrast: z.number().min(-100).max(100).optional().describe('Contrast adjustment (-100 to 100)'),
      
      // Hue/Saturation settings
      hue: z.number().min(-180).max(180).optional().describe('Hue shift in degrees (-180 to 180)'),
      saturation: z.number().min(-100).max(100).optional().describe('Saturation adjustment (-100 to 100)'),
      lightness: z.number().min(-100).max(100).optional().describe('Lightness adjustment (-100 to 100)'),
      
      // Remap settings
      colorMap: z.record(z.string()).optional().describe('Map of old colors to new colors (e.g., {"#FF0000": "#00FF00"})'),
      characterMap: z.record(z.string()).optional().describe('Map of old characters to new (e.g., {"@": "#", "*": "+"})'),
      targetPalette: z.array(z.string()).optional().describe('Target color palette for automatic remapping'),
      
      // Scatter settings
      scatterAmount: z.number().min(1).max(20).optional().describe('Maximum pixel displacement for scatter effect'),
      
      // Scope
      frameIndex: z.number().int().optional().describe('Frame to apply effect to (defaults to current)'),
      applyToSelection: z.boolean().default(false).describe('Only apply effect within current selection'),
      affectForeground: z.boolean().default(true).describe('Apply color effects to foreground colors'),
      affectBackground: z.boolean().default(true).describe('Apply color effects to background colors'),
    },
    async ({ 
      effect, 
      brightness, contrast,
      hue, saturation, lightness,
      colorMap, characterMap, targetPalette,
      scatterAmount,
      frameIndex,
      applyToSelection,
      affectForeground,
      affectBackground,
    }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frameIdx = frameIndex ?? state.currentFrameIndex;
      if (frameIdx < 0 || frameIdx >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      // Get cells to modify
      const frame = state.frames[frameIdx];
      let cellsToProcess: [string, Cell][] = Object.entries(frame.data);
      
      // Filter to selection if requested
      if (applyToSelection && state.selection) {
        let selectionSet: Set<string>;
        
        if (state.selection.type === 'rectangle') {
          // Rectangle selection: compute all cells in the rectangle
          const sel = state.selection;
          const minX = Math.min(sel.start.x, sel.end.x);
          const maxX = Math.max(sel.start.x, sel.end.x);
          const minY = Math.min(sel.start.y, sel.end.y);
          const maxY = Math.max(sel.start.y, sel.end.y);
          
          selectionSet = new Set<string>();
          for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
              selectionSet.add(createCellKey(x, y));
            }
          }
        } else {
          // Cell set selection: use the cells directly
          selectionSet = new Set(state.selection.cells);
        }
        
        cellsToProcess = cellsToProcess.filter(([key]) => selectionSet.has(key));
      }
      
      if (cellsToProcess.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No cells to process', hint: 'Canvas may be empty or selection is empty' }) }],
          isError: true,
        };
      }
      
      let modifiedCount = 0;
      const modifications: Array<{ x: number; y: number; cell: Cell }> = [];
      
      for (const [key, cell] of cellsToProcess) {
        const { x, y } = parseCellKey(key);
        let newCell = { ...cell };
        let modified = false;
        
        switch (effect) {
          case 'levels': {
            if (affectForeground) {
              newCell.color = adjustLevels(cell.color, brightness ?? 0, contrast ?? 0);
              modified = true;
            }
            if (affectBackground && cell.bgColor !== 'transparent') {
              newCell.bgColor = adjustLevels(cell.bgColor, brightness ?? 0, contrast ?? 0);
              modified = true;
            }
            break;
          }
          
          case 'hue-saturation': {
            if (affectForeground) {
              newCell.color = adjustHueSaturation(cell.color, hue ?? 0, saturation ?? 0, lightness ?? 0);
              modified = true;
            }
            if (affectBackground && cell.bgColor !== 'transparent') {
              newCell.bgColor = adjustHueSaturation(cell.bgColor, hue ?? 0, saturation ?? 0, lightness ?? 0);
              modified = true;
            }
            break;
          }
          
          case 'invert': {
            if (affectForeground) {
              newCell.color = invertColor(cell.color);
              modified = true;
            }
            if (affectBackground && cell.bgColor !== 'transparent') {
              newCell.bgColor = invertColor(cell.bgColor);
              modified = true;
            }
            break;
          }
          
          case 'grayscale': {
            if (affectForeground) {
              newCell.color = toGrayscale(cell.color);
              modified = true;
            }
            if (affectBackground && cell.bgColor !== 'transparent') {
              newCell.bgColor = toGrayscale(cell.bgColor);
              modified = true;
            }
            break;
          }
          
          case 'remap-colors': {
            if (colorMap) {
              if (affectForeground && colorMap[cell.color]) {
                newCell.color = colorMap[cell.color];
                modified = true;
              }
              if (affectBackground && cell.bgColor !== 'transparent' && colorMap[cell.bgColor]) {
                newCell.bgColor = colorMap[cell.bgColor];
                modified = true;
              }
            } else if (targetPalette && targetPalette.length > 0) {
              // Auto-remap to closest color in palette
              if (affectForeground) {
                newCell.color = findClosestColor(cell.color, targetPalette);
                modified = true;
              }
              if (affectBackground && cell.bgColor !== 'transparent') {
                newCell.bgColor = findClosestColor(cell.bgColor, targetPalette);
                modified = true;
              }
            }
            break;
          }
          
          case 'remap-characters': {
            if (characterMap && characterMap[cell.char]) {
              newCell.char = characterMap[cell.char];
              modified = true;
            }
            break;
          }
          
          case 'scatter': {
            // Scatter is handled differently - we collect positions and shuffle
            // For now, just mark as needing scatter processing
            modified = true;
            break;
          }
        }
        
        if (modified) {
          modifications.push({ x, y, cell: newCell });
          modifiedCount++;
        }
      }
      
      // Handle scatter effect specially
      if (effect === 'scatter' && scatterAmount) {
        const scatteredMods = scatterCells(modifications, scatterAmount, state.width, state.height);
        
        // Apply scattered modifications
        for (const mod of scatteredMods) {
          pm.setCell(mod.x, mod.y, mod.cell);
        }
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              success: true, 
              effect,
              cellsModified: scatteredMods.length,
              scatterAmount,
            }) 
          }],
        };
      }
      
      // Apply modifications
      for (const mod of modifications) {
        pm.setCell(mod.x, mod.y, mod.cell);
      }
      
      // Broadcast effect applied
      broadcastStateChange('apply_effect', { effect, cellsModified: modifiedCount });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true, 
            effect,
            cellsModified: modifiedCount,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // get_color_stats - Analyze colors in canvas
  // ==========================================================================
  server.tool(
    'get_color_stats',
    'Get statistics about colors used in the current frame. Useful before applying color effects.',
    {
      frameIndex: z.number().int().optional().describe('Frame to analyze (defaults to current)'),
      includeBackground: z.boolean().default(true).describe('Include background colors in analysis'),
    },
    async ({ frameIndex, includeBackground }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frame = state.frames[frameIndex ?? state.currentFrameIndex];
      if (!frame) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }
      
      const fgColors: Record<string, number> = {};
      const bgColors: Record<string, number> = {};
      const characters: Record<string, number> = {};
      
      for (const cell of Object.values(frame.data)) {
        fgColors[cell.color] = (fgColors[cell.color] || 0) + 1;
        characters[cell.char] = (characters[cell.char] || 0) + 1;
        
        if (includeBackground && cell.bgColor !== 'transparent') {
          bgColors[cell.bgColor] = (bgColors[cell.bgColor] || 0) + 1;
        }
      }
      
      // Sort by frequency
      const sortedFg = Object.entries(fgColors).sort((a, b) => b[1] - a[1]);
      const sortedBg = Object.entries(bgColors).sort((a, b) => b[1] - a[1]);
      const sortedChars = Object.entries(characters).sort((a, b) => b[1] - a[1]);
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            foregroundColors: sortedFg.slice(0, 20).map(([color, count]) => ({ color, count })),
            backgroundColors: sortedBg.slice(0, 20).map(([color, count]) => ({ color, count })),
            uniqueForegroundColors: sortedFg.length,
            uniqueBackgroundColors: sortedBg.length,
            topCharacters: sortedChars.slice(0, 20).map(([char, count]) => ({ char, count })),
            totalCells: Object.keys(frame.data).length,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // batch_recolor - Quick color replacement
  // ==========================================================================
  server.tool(
    'batch_recolor',
    'Replace one color with another across the entire frame or selection.',
    {
      oldColor: z.string().describe('Color to replace (hex format like #FF0000)'),
      newColor: z.string().describe('New color (hex format)'),
      target: z.enum(['foreground', 'background', 'both']).default('both').describe('Which colors to replace'),
      frameIndex: z.number().int().optional().describe('Frame to modify (defaults to current)'),
    },
    async ({ oldColor, newColor, target, frameIndex }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frameIdx = frameIndex ?? state.currentFrameIndex;
      const frame = state.frames[frameIdx];
      
      if (!frame) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }
      
      let replacedCount = 0;
      
      for (const [key, cell] of Object.entries(frame.data)) {
        const { x, y } = parseCellKey(key);
        let modified = false;
        const newCell = { ...cell };
        
        if ((target === 'foreground' || target === 'both') && cell.color.toUpperCase() === oldColor.toUpperCase()) {
          newCell.color = newColor;
          modified = true;
        }
        
        if ((target === 'background' || target === 'both') && cell.bgColor.toUpperCase() === oldColor.toUpperCase()) {
          newCell.bgColor = newColor;
          modified = true;
        }
        
        if (modified) {
          pm.setCell(x, y, newCell);
          replacedCount++;
        }
      }
      
      // Broadcast recolor completed
      broadcastStateChange('batch_recolor', { oldColor, newColor, cellsModified: replacedCount });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true, 
            oldColor,
            newColor,
            cellsModified: replacedCount,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // batch_replace_char - Quick character replacement
  // ==========================================================================
  server.tool(
    'batch_replace_char',
    'Replace one character with another across the entire frame or selection.',
    {
      oldChar: z.string().length(1).describe('Character to replace'),
      newChar: z.string().length(1).describe('New character'),
      frameIndex: z.number().int().optional().describe('Frame to modify (defaults to current)'),
    },
    async ({ oldChar, newChar, frameIndex }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frameIdx = frameIndex ?? state.currentFrameIndex;
      const frame = state.frames[frameIdx];
      
      if (!frame) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
          isError: true,
        };
      }
      
      let replacedCount = 0;
      
      for (const [key, cell] of Object.entries(frame.data)) {
        if (cell.char === oldChar) {
          const { x, y } = parseCellKey(key);
          pm.setCell(x, y, { ...cell, char: newChar });
          replacedCount++;
        }
      }
      
      // Broadcast replace char completed
      broadcastStateChange('batch_replace_char', { oldChar, newChar, cellsModified: replacedCount });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true, 
            oldChar,
            newChar,
            cellsModified: replacedCount,
          }) 
        }],
      };
    }
  );
}

// =============================================================================
// Color Manipulation Helpers
// =============================================================================

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : { r: 255, g: 255, b: 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return '#' + [clamp(r), clamp(g), clamp(b)]
    .map(x => x.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function adjustLevels(color: string, brightness: number, contrast: number): string {
  const { r, g, b } = hexToRgb(color);
  
  // Brightness: simple offset
  const br = brightness * 2.55; // -255 to 255
  
  // Contrast: scale around midpoint
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  
  const newR = factor * (r + br - 128) + 128;
  const newG = factor * (g + br - 128) + 128;
  const newB = factor * (b + br - 128) + 128;
  
  return rgbToHex(newR, newG, newB);
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  
  let h = 0;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    case b: h = ((r - g) / d + 4) / 6; break;
  }
  
  return { h: h * 360, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360; // Normalize hue
  
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  
  let r = 0, g = 0, b = 0;
  
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  
  return {
    r: (r + m) * 255,
    g: (g + m) * 255,
    b: (b + m) * 255,
  };
}

function adjustHueSaturation(color: string, hueDelta: number, satDelta: number, lightDelta: number): string {
  const { r, g, b } = hexToRgb(color);
  const { h, s, l } = rgbToHsl(r, g, b);
  
  const newH = h + hueDelta;
  const newS = Math.max(0, Math.min(1, s + satDelta / 100));
  const newL = Math.max(0, Math.min(1, l + lightDelta / 100));
  
  const rgb = hslToRgb(newH, newS, newL);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

function invertColor(color: string): string {
  const { r, g, b } = hexToRgb(color);
  return rgbToHex(255 - r, 255 - g, 255 - b);
}

function toGrayscale(color: string): string {
  const { r, g, b } = hexToRgb(color);
  // Use luminance formula
  const gray = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return rgbToHex(gray, gray, gray);
}

function colorDistance(c1: string, c2: string): number {
  const rgb1 = hexToRgb(c1);
  const rgb2 = hexToRgb(c2);
  return Math.sqrt(
    Math.pow(rgb1.r - rgb2.r, 2) +
    Math.pow(rgb1.g - rgb2.g, 2) +
    Math.pow(rgb1.b - rgb2.b, 2)
  );
}

function findClosestColor(color: string, palette: string[]): string {
  let closest = palette[0];
  let minDist = Infinity;
  
  for (const p of palette) {
    const dist = colorDistance(color, p);
    if (dist < minDist) {
      minDist = dist;
      closest = p;
    }
  }
  
  return closest;
}

function scatterCells(
  cells: Array<{ x: number; y: number; cell: Cell }>,
  amount: number,
  width: number,
  height: number
): Array<{ x: number; y: number; cell: Cell }> {
  const result: Array<{ x: number; y: number; cell: Cell }> = [];
  
  for (const { x, y, cell } of cells) {
    // Random offset
    const dx = Math.round((Math.random() - 0.5) * 2 * amount);
    const dy = Math.round((Math.random() - 0.5) * 2 * amount);
    
    // Clamp to canvas bounds
    const newX = Math.max(0, Math.min(width - 1, x + dx));
    const newY = Math.max(0, Math.min(height - 1, y + dy));
    
    result.push({ x: newX, y: newY, cell });
  }
  
  return result;
}
