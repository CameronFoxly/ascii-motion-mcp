/**
 * MCP Prompts
 * 
 * Pre-built prompt templates for common ASCII art tasks.
 * These help users discover and invoke common workflows.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
  // ==========================================================================
  // Create Simple Animation
  // ==========================================================================
  server.prompt(
    'create-animation',
    'Create a simple animation with multiple frames',
    {
      subject: z.string().optional().describe('What to animate (e.g., "bouncing ball", "walking character")'),
      frameCount: z.string().optional().describe('Number of frames (2-60, default 8)'),
      width: z.string().optional().describe('Canvas width (10-200, default 40)'),
      height: z.string().optional().describe('Canvas height (5-100, default 20)'),
    },
    async ({ subject, frameCount, width, height }) => {
      const frames = parseInt(frameCount || '8', 10);
      const w = parseInt(width || '40', 10);
      const h = parseInt(height || '20', 10);
      
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Create an ASCII animation of ${subject || 'a simple animation'}.

Requirements:
- Canvas size: ${w}x${h} characters
- Number of frames: ${frames}
- Frame rate: ~10 FPS (100ms per frame)

Steps:
1. First call new_project to create a ${w}x${h} canvas
2. Design the animation frame by frame, using set_cells_batch for efficiency
3. Use copy_frame_and_modify to create variations
4. Preview with get_canvas_ascii between frames

Make the animation loop smoothly by ensuring the last frame transitions well to the first.`,
          },
        }],
      };
    }
  );

  // ==========================================================================
  // Import and Animate Image
  // ==========================================================================
  server.prompt(
    'import-and-animate',
    'Import an image and create an animation from it',
    {
      imagePath: z.string().describe('Path to the image file'),
      animationType: z.string().optional().describe('Type of animation: scroll, fade, zoom, reveal, glitch (default: reveal)'),
      frameCount: z.string().optional().describe('Number of frames (4-30, default 12)'),
    },
    async ({ imagePath, animationType, frameCount }) => {
      const type = animationType || 'reveal';
      const frames = parseInt(frameCount || '12', 10);
      
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Import the image at "${imagePath}" and create a ${type} animation.

Steps:
1. Use import_image to convert the image to ASCII art
2. Create ${frames} frames showing the ${type} effect:
   ${type === 'scroll' ? '- Shift the content across the canvas each frame' : ''}
   ${type === 'fade' ? '- Gradually reveal characters from dark to light' : ''}
   ${type === 'zoom' ? '- Scale the content in or out over frames' : ''}
   ${type === 'reveal' ? '- Reveal the image progressively (left-to-right, top-to-bottom, or random)' : ''}
   ${type === 'glitch' ? '- Add random character noise and color shifts' : ''}
3. Preview the animation with describe_animation
4. Export with export_session to save the project`,
          },
        }],
      };
    }
  );

  // ==========================================================================
  // Generate Rain Effect
  // ==========================================================================
  server.prompt(
    'generate-rain',
    'Generate a digital rain (Matrix-style) animation',
    {
      width: z.string().optional().describe('Canvas width (20-200, default 80)'),
      height: z.string().optional().describe('Canvas height (10-60, default 24)'),
      density: z.string().optional().describe('Rain density 0.1-1.0 (default 0.3)'),
      colors: z.string().optional().describe('Color scheme: green, blue, rainbow, white (default: green)'),
    },
    async ({ width, height, density, colors }) => {
      const w = parseInt(width || '80', 10);
      const h = parseInt(height || '24', 10);
      const d = parseFloat(density || '0.3');
      const c = colors || 'green';
      
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Create a ${c} digital rain animation (Matrix-style).

Configuration:
- Canvas: ${w}x${h}
- Density: ${d}
- Colors: ${c}

Steps:
1. Create a new project with new_project (${w}x${h})
2. Use run_generator with type "digital-rain" and these settings:
   - characterSet: Use Japanese-inspired characters or alphanumerics
   - density: ${d}
   - colorScheme: ${c}
3. Generate enough frames for smooth looping (16-24 frames)
4. Preview with describe_animation
5. Export as animated GIF or HTML`,
          },
        }],
      };
    }
  );

  // ==========================================================================
  // Create Text Banner
  // ==========================================================================
  server.prompt(
    'create-banner',
    'Create an animated text banner or logo',
    {
      text: z.string().describe('Text to display'),
      style: z.string().optional().describe('Text style: block, shadow, outline, gradient, simple (default: block)'),
      animation: z.string().optional().describe('Animation: none, typewriter, wave, pulse, rainbow (default: typewriter)'),
    },
    async ({ text, style, animation }) => {
      const s = style || 'block';
      const a = animation || 'typewriter';
      
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Create an animated ASCII text banner displaying: "${text}"

Style: ${s}
Animation: ${a}

Steps:
1. Create a project sized to fit the text (estimate ~10 chars wide per letter for block style)
2. ${s === 'block' ? 'Use large block letters made of # symbols' : ''}
   ${s === 'shadow' ? 'Create letters with a shadow effect using lighter characters' : ''}
   ${s === 'outline' ? 'Make hollow/outline letters' : ''}
   ${s === 'gradient' ? 'Use characters that create a gradient effect' : ''}
   ${s === 'simple' ? 'Use simple ASCII art letters' : ''}
3. Apply the ${a} animation:
   ${a === 'typewriter' ? 'Reveal letters one by one' : ''}
   ${a === 'wave' ? 'Make letters move up and down in a wave pattern' : ''}
   ${a === 'pulse' ? 'Cycle colors or brightness in a pulsing effect' : ''}
   ${a === 'rainbow' ? 'Cycle through rainbow colors on the text' : ''}
   ${a === 'none' ? 'No animation, static banner' : ''}
4. Export the result`,
          },
        }],
      };
    }
  );

  // ==========================================================================
  // Apply Effect to Canvas
  // ==========================================================================
  server.prompt(
    'apply-effects',
    'Apply visual effects to existing ASCII art',
    {
      effectType: z.string().describe('Effect: colorize, invert, blur, outline, pixelate, static'),
      intensity: z.string().optional().describe('Effect intensity 0-1 (default: 0.5)'),
    },
    async ({ effectType, intensity }) => {
      const i = parseFloat(intensity || '0.5');
      
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Apply a ${effectType} effect to the current canvas with intensity ${i}.

Steps:
1. First check the current state with get_canvas_summary
2. Apply the effect using apply_effect:
   ${effectType === 'colorize' ? '- Change colors while preserving brightness' : ''}
   ${effectType === 'invert' ? '- Invert characters and/or colors' : ''}
   ${effectType === 'blur' ? '- Soften edges by using transitional characters' : ''}
   ${effectType === 'outline' ? '- Add outline/border around existing art' : ''}
   ${effectType === 'pixelate' ? '- Replace detailed areas with block characters' : ''}
   ${effectType === 'static' ? '- Add TV static/noise effect' : ''}
3. Use intensity ${i} (0 = subtle, 1 = maximum)
4. Preview result with get_canvas_ascii`,
          },
        }],
      };
    }
  );

  // ==========================================================================
  // Export for Terminal CLI
  // ==========================================================================
  server.prompt(
    'export-for-cli',
    'Export ASCII art for use in terminal/CLI applications',
    {
      framework: z.string().optional().describe('Target: ink, bubbletea, opentui, ansi, plain (default: ansi)'),
      includeAnimation: z.string().optional().describe('Include animation support: true/false (default: true)'),
    },
    async ({ framework, includeAnimation }) => {
      const f = framework || 'ansi';
      const animate = includeAnimation !== 'false';
      
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Export the current project for ${f} CLI usage.

Framework: ${f}
Include Animation: ${animate}

Steps:
1. Check project status with get_project_info
2. Export using the appropriate tool:
   ${f === 'ink' ? '- Use export_ink to generate a React/Ink component' : ''}
   ${f === 'bubbletea' ? '- Use export_bubbletea to generate Go code' : ''}
   ${f === 'opentui' ? '- Use export_opentui to generate Python code' : ''}
   ${f === 'ansi' ? '- Use export_ansi to get ANSI escape codes' : ''}
   ${f === 'plain' ? '- Use export_text for plain ASCII text' : ''}
3. ${animate ? 'Enable animation support in the export' : 'Export static frame only'}
4. Provide instructions for integrating into a CLI project`,
          },
        }],
      };
    }
  );
}
