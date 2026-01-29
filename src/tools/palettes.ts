/**
 * Palette Tools
 * 
 * Tools for managing character palettes and color palettes.
 * These help LLMs discover and use appropriate characters and colors.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager, broadcastStateChange } from '../state.js';

// ============================================================================
// Character Palette Definitions
// ============================================================================

interface CharacterPalette {
  id: string;
  name: string;
  characters: string[];
  category: 'ascii' | 'blocks' | 'unicode' | 'custom';
  description: string;
}

const CHARACTER_PALETTES: CharacterPalette[] = [
  {
    id: 'minimal-ascii',
    name: 'Minimal ASCII',
    characters: [' ', '.', ':', ';', '+', '*', '#', '@'],
    category: 'ascii',
    description: 'Simple 8-character palette, great for basic shading. Ordered light to dark.',
  },
  {
    id: 'standard-ascii',
    name: 'Standard ASCII',
    characters: [
      ' ', '.', ',', ':', ';', '!', 'i', 'l', 'I', '|', 
      '/', '\\', 'r', 'c', 'v', 'x', 'z', 'u', 'n', 'o', 
      'e', 'a', 'h', 'k', 'b', 'd', 'p', 'q', 'w', 'm', 
      'A', 'U', 'J', 'C', 'L', 'Q', 'O', 'Z', 'X', '0', 
      '#', 'M', 'W', '&', '8', '%', 'B', '@'
    ],
    category: 'ascii',
    description: 'Full keyboard character range, 48 characters ordered by visual density.',
  },
  {
    id: 'block-characters',
    name: 'Block Characters',
    characters: [' ', '░', '▒', '▓', '█'],
    category: 'blocks',
    description: 'Unicode block elements for solid fills and clean gradients.',
  },
  {
    id: 'retro-computing',
    name: 'Retro Computing',
    characters: [
      ' ', '.', ':', '=', '+', '*', '#', '&', '@',
      '░', '▒', '▓', '█', '▄', '▀', '▌', '▐',
      '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼',
      '╔', '╗', '╚', '╝', '╠', '╣', '╦', '╩', '╬'
    ],
    category: 'blocks',
    description: 'Classic box drawing and block characters from early computing.',
  },
  {
    id: 'box-drawing-light',
    name: 'Box Drawing (Light)',
    characters: ['─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼'],
    category: 'unicode',
    description: 'Light box drawing characters for borders and frames.',
  },
  {
    id: 'box-drawing-double',
    name: 'Box Drawing (Double)',
    characters: ['═', '║', '╔', '╗', '╚', '╝', '╠', '╣', '╦', '╩', '╬'],
    category: 'unicode',
    description: 'Double-line box drawing for prominent borders.',
  },
];

// ============================================================================
// Color Palette Definitions
// ============================================================================

interface ColorPalette {
  id: string;
  name: string;
  colors: Array<{ hex: string; name?: string }>;
  description: string;
}

const COLOR_PALETTES: ColorPalette[] = [
  {
    id: 'ansi-16',
    name: 'ANSI 16-Color',
    colors: [
      { hex: '#000000', name: 'Black' },
      { hex: '#CC0000', name: 'Red' },
      { hex: '#00CC00', name: 'Green' },
      { hex: '#CCCC00', name: 'Yellow' },
      { hex: '#0000CC', name: 'Blue' },
      { hex: '#CC00CC', name: 'Magenta' },
      { hex: '#00CCCC', name: 'Cyan' },
      { hex: '#CCCCCC', name: 'White' },
      { hex: '#666666', name: 'Bright Black' },
      { hex: '#FF0000', name: 'Bright Red' },
      { hex: '#00FF00', name: 'Bright Green' },
      { hex: '#FFFF00', name: 'Bright Yellow' },
      { hex: '#0000FF', name: 'Bright Blue' },
      { hex: '#FF00FF', name: 'Bright Magenta' },
      { hex: '#00FFFF', name: 'Bright Cyan' },
      { hex: '#FFFFFF', name: 'Bright White' },
    ],
    description: 'Standard ANSI terminal colors. Best for CLI/terminal compatibility.',
  },
  {
    id: 'monochrome-green',
    name: 'Monochrome Green',
    colors: [
      { hex: '#001100', name: 'Darkest' },
      { hex: '#003300', name: 'Darker' },
      { hex: '#005500', name: 'Dark' },
      { hex: '#007700', name: 'Medium Dark' },
      { hex: '#009900', name: 'Medium' },
      { hex: '#00BB00', name: 'Medium Light' },
      { hex: '#00DD00', name: 'Light' },
      { hex: '#00FF00', name: 'Lightest' },
    ],
    description: 'Classic terminal green for matrix/hacker aesthetics.',
  },
  {
    id: 'grayscale',
    name: 'Grayscale',
    colors: [
      { hex: '#000000', name: 'Black' },
      { hex: '#333333', name: '20%' },
      { hex: '#666666', name: '40%' },
      { hex: '#999999', name: '60%' },
      { hex: '#CCCCCC', name: '80%' },
      { hex: '#FFFFFF', name: 'White' },
    ],
    description: 'Neutral grayscale for classic ASCII art.',
  },
  {
    id: 'rainbow',
    name: 'Rainbow',
    colors: [
      { hex: '#FF0000', name: 'Red' },
      { hex: '#FF7F00', name: 'Orange' },
      { hex: '#FFFF00', name: 'Yellow' },
      { hex: '#00FF00', name: 'Green' },
      { hex: '#00FFFF', name: 'Cyan' },
      { hex: '#0000FF', name: 'Blue' },
      { hex: '#8B00FF', name: 'Violet' },
      { hex: '#FF00FF', name: 'Magenta' },
    ],
    description: 'Classic rainbow spectrum for colorful effects.',
  },
  {
    id: 'retro-8bit',
    name: 'Retro 8-bit',
    colors: [
      { hex: '#000000', name: 'Black' },
      { hex: '#1D2B53', name: 'Dark Blue' },
      { hex: '#7E2553', name: 'Dark Purple' },
      { hex: '#008751', name: 'Dark Green' },
      { hex: '#AB5236', name: 'Brown' },
      { hex: '#5F574F', name: 'Dark Grey' },
      { hex: '#C2C3C7', name: 'Light Grey' },
      { hex: '#FFF1E8', name: 'White' },
      { hex: '#FF004D', name: 'Red' },
      { hex: '#FFA300', name: 'Orange' },
      { hex: '#FFEC27', name: 'Yellow' },
      { hex: '#00E436', name: 'Green' },
      { hex: '#29ADFF', name: 'Blue' },
      { hex: '#83769C', name: 'Lavender' },
      { hex: '#FF77A8', name: 'Pink' },
      { hex: '#FFCCAA', name: 'Peach' },
    ],
    description: 'PICO-8 inspired palette. Great for pixel art style.',
  },
];

// ============================================================================
// Tool Registration
// ============================================================================

export function registerPaletteTools(server: McpServer): void {
  server.tool(
    'list_character_palettes',
    'List all available character palettes for ASCII art.',
    {},
    async () => {
      const summary = CHARACTER_PALETTES.map(p => ({
        id: p.id,
        name: p.name,
        category: p.category,
        characterCount: p.characters.length,
        description: p.description,
        preview: p.characters.slice(0, 8).join(''),
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: summary.length, palettes: summary }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_character_palette',
    'Get all characters from a specific palette.',
    { paletteId: z.string().describe('Palette ID') },
    async ({ paletteId }) => {
      const palette = CHARACTER_PALETTES.find(p => p.id === paletteId);
      if (!palette) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Palette not found', available: CHARACTER_PALETTES.map(p => p.id) }) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ id: palette.id, name: palette.name, characters: palette.characters, asString: palette.characters.join('') }, null, 2) }],
      };
    }
  );

  server.tool(
    'list_color_palettes',
    'List all available color palettes.',
    {},
    async () => {
      const summary = COLOR_PALETTES.map(p => ({
        id: p.id,
        name: p.name,
        colorCount: p.colors.length,
        description: p.description,
        preview: p.colors.slice(0, 4).map(c => c.hex),
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: summary.length, palettes: summary }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_color_palette',
    'Get all colors from a specific palette.',
    { paletteId: z.string().describe('Palette ID') },
    async ({ paletteId }) => {
      const palette = COLOR_PALETTES.find(p => p.id === paletteId);
      if (!palette) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Palette not found', available: COLOR_PALETTES.map(p => p.id) }) }] };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ id: palette.id, name: palette.name, colors: palette.colors }, null, 2) }],
      };
    }
  );

  server.tool(
    'get_active_colors',
    'Get the currently active foreground and background colors.',
    {},
    async () => {
      const pm = getProjectManager();
      const state = pm.getState();
      return {
        content: [{ type: 'text', text: JSON.stringify({
          foregroundColor: state.toolState.selectedColor,
          backgroundColor: state.toolState.selectedBgColor,
          selectedCharacter: state.toolState.selectedCharacter,
        }) }],
      };
    }
  );

  server.tool(
    'set_foreground_color',
    'Set the active foreground (text) color.',
    { color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).describe('Hex color (e.g., #FF0000)') },
    async ({ color }) => {
      const pm = getProjectManager();
      pm.setToolState({ selectedColor: color.toUpperCase() });
      broadcastStateChange('set_foreground_color', { color: color.toUpperCase() });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, foregroundColor: color.toUpperCase() }) }] };
    }
  );

  server.tool(
    'set_background_color',
    'Set the active background color.',
    { color: z.string().describe('Hex color or "transparent"') },
    async ({ color }) => {
      const pm = getProjectManager();
      const normalized = color === 'transparent' ? 'transparent' : color.toUpperCase();
      pm.setToolState({ selectedBgColor: normalized });
      broadcastStateChange('set_background_color', { color: normalized });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, backgroundColor: normalized }) }] };
    }
  );

  server.tool(
    'set_selected_character',
    'Set the active character used for drawing.',
    { character: z.string().length(1).describe('Single character') },
    async ({ character }) => {
      const pm = getProjectManager();
      pm.setToolState({ selectedCharacter: character });
      broadcastStateChange('set_selected_character', { character });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, selectedCharacter: character }) }] };
    }
  );

  server.tool(
    'suggest_palette_for_style',
    'Get palette recommendations for a specific style.',
    { style: z.enum(['terminal', 'retro', 'matrix', 'minimalist', 'detailed', 'colorful']).describe('Style theme') },
    async ({ style }) => {
      const recommendations: Record<string, { characters: string[]; colors: string[]; tips: string }> = {
        terminal: { characters: ['minimal-ascii'], colors: ['ansi-16', 'monochrome-green'], tips: 'Use ANSI colors for terminal compatibility.' },
        retro: { characters: ['retro-computing', 'block-characters'], colors: ['retro-8bit'], tips: 'Block characters create authentic retro aesthetics.' },
        matrix: { characters: ['standard-ascii'], colors: ['monochrome-green'], tips: 'Varying character densities with green shades.' },
        minimalist: { characters: ['minimal-ascii'], colors: ['grayscale'], tips: 'Less is more. Use sparse characters.' },
        detailed: { characters: ['standard-ascii'], colors: ['ansi-16'], tips: 'Full character range for fine gradients.' },
        colorful: { characters: ['block-characters'], colors: ['rainbow', 'retro-8bit'], tips: 'Full color spectrum with varied characters.' },
      };
      return { content: [{ type: 'text', text: JSON.stringify({ style, ...recommendations[style] }, null, 2) }] };
    }
  );
}
