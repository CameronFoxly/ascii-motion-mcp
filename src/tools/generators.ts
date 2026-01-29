/**
 * Generator Tools
 * 
 * Tools for generating procedural ASCII animations:
 * - Digital rain (Matrix-style)
 * - Radio waves (expanding circles)
 * - Turbulent noise
 * - Particle physics
 * - Rain drops
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';
import { type Cell } from '../types.js';

// Character sets for different generators
const MATRIX_CHARS = 'ｦｱｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';
const NOISE_CHARS = ' .:-=+*#%@';
const WAVE_CHARS = ' ·∙●○◌◯';
const PARTICLE_CHARS = '.*+#@';
const RAIN_CHARS = '|:;\'"`';

export function registerGeneratorTools(server: McpServer): void {
  // ==========================================================================
  // run_generator - Generate procedural animation frames
  // ==========================================================================
  server.tool(
    'run_generator',
    'Generate procedural animation frames. Creates new frames with animated patterns.',
    {
      generator: z.enum(['digital-rain', 'radio-waves', 'turbulent-noise', 'particle-physics', 'rain-drops', 'static-noise', 'gradient'])
        .describe('Generator type'),
      
      frameCount: z.number().int().min(1).max(100).default(10).describe('Number of frames to generate'),
      frameDuration: z.number().int().min(10).max(1000).default(100).describe('Duration of each frame in ms'),
      
      // Common settings
      color: z.string().default('#00FF00').describe('Primary color (hex)'),
      secondaryColor: z.string().optional().describe('Secondary color for gradients'),
      backgroundColor: z.string().default('transparent').describe('Background color'),
      characterSet: z.string().optional().describe('Custom characters to use (overrides default)'),
      
      // Digital rain settings
      density: z.number().min(0.01).max(1).default(0.1).describe('Density of elements (0-1)'),
      speed: z.number().min(0.1).max(5).default(1).describe('Animation speed multiplier'),
      trailLength: z.number().int().min(1).max(20).default(8).describe('Length of trails'),
      
      // Wave settings
      waveSpeed: z.number().min(0.1).max(5).default(1).describe('Wave expansion speed'),
      waveCount: z.number().int().min(1).max(10).default(3).describe('Number of simultaneous waves'),
      centerX: z.number().int().optional().describe('Wave center X (defaults to canvas center)'),
      centerY: z.number().int().optional().describe('Wave center Y (defaults to canvas center)'),
      
      // Noise settings
      noiseScale: z.number().min(0.01).max(1).default(0.1).describe('Noise scale (smaller = more detailed)'),
      noiseSpeed: z.number().min(0.01).max(1).default(0.05).describe('How fast noise evolves'),
      
      // Particle settings  
      particleCount: z.number().int().min(1).max(200).default(20).describe('Number of particles'),
      gravity: z.number().min(-1).max(1).default(0.1).describe('Gravity effect (-1 to 1)'),
      
      // Output control
      replaceFrames: z.boolean().default(false).describe('Replace existing frames (otherwise append)'),
      seed: z.number().int().optional().describe('Random seed for reproducibility'),
    },
    async ({ 
      generator, frameCount, frameDuration,
      color, secondaryColor, backgroundColor, characterSet,
      density, speed, trailLength,
      waveSpeed, waveCount, centerX, centerY,
      noiseScale, noiseSpeed,
      particleCount, gravity,
      replaceFrames, seed,
    }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      const { width, height } = state;
      
      // Set up RNG with seed if provided
      const rng = seed !== undefined ? seededRandom(seed) : Math.random;
      
      // Generate frames based on generator type
      const frames: Array<{ data: Record<string, Cell>; name: string }> = [];
      
      switch (generator) {
        case 'digital-rain': {
          const chars = characterSet || MATRIX_CHARS;
          const columns: Array<{ y: number; speed: number; length: number }> = [];
          
          // Initialize rain columns
          for (let x = 0; x < width; x++) {
            if (rng() < density) {
              columns.push({
                y: Math.floor(rng() * height),
                speed: 0.5 + rng() * speed,
                length: Math.floor(trailLength * (0.5 + rng() * 0.5)),
              });
            }
          }
          
          for (let f = 0; f < frameCount; f++) {
            const data: Record<string, Cell> = {};
            
            // Fill background if specified
            if (backgroundColor !== 'transparent') {
              for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                  data[`${x},${y}`] = { char: ' ', color: '#000000', bgColor: backgroundColor };
                }
              }
            }
            
            // Draw rain columns
            for (let colIdx = 0; colIdx < columns.length; colIdx++) {
              const col = columns[colIdx];
              const x = colIdx % width;
              
              for (let i = 0; i < col.length; i++) {
                const y = Math.floor(col.y - i) % height;
                if (y >= 0 && y < height) {
                  // Fade color based on trail position
                  const brightness = 1 - (i / col.length);
                  const cellColor = i === 0 ? '#FFFFFF' : fadeColor(color, brightness);
                  
                  data[`${x},${y}`] = {
                    char: chars[Math.floor(rng() * chars.length)],
                    color: cellColor,
                    bgColor: backgroundColor,
                  };
                }
              }
              
              // Advance column
              col.y = (col.y + col.speed) % (height + col.length);
            }
            
            frames.push({ data, name: `Rain ${f + 1}` });
          }
          break;
        }
        
        case 'radio-waves': {
          const chars = characterSet || WAVE_CHARS;
          const cx = centerX ?? Math.floor(width / 2);
          const cy = centerY ?? Math.floor(height / 2);
          const maxRadius = Math.sqrt(width * width + height * height);
          
          for (let f = 0; f < frameCount; f++) {
            const data: Record<string, Cell> = {};
            const time = f * waveSpeed;
            
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const dx = x - cx;
                const dy = (y - cy) * 2; // Compensate for character aspect ratio
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                // Multiple waves
                let intensity = 0;
                for (let w = 0; w < waveCount; w++) {
                  const wavePhase = (time + w * maxRadius / waveCount) % maxRadius;
                  const waveDist = Math.abs(dist - wavePhase);
                  intensity += Math.max(0, 1 - waveDist / 3);
                }
                intensity = Math.min(1, intensity);
                
                if (intensity > 0.1) {
                  const charIdx = Math.floor(intensity * (chars.length - 1));
                  data[`${x},${y}`] = {
                    char: chars[charIdx],
                    color: fadeColor(color, intensity),
                    bgColor: backgroundColor,
                  };
                }
              }
            }
            
            frames.push({ data, name: `Wave ${f + 1}` });
          }
          break;
        }
        
        case 'turbulent-noise':
        case 'static-noise': {
          const chars = characterSet || NOISE_CHARS;
          const isStatic = generator === 'static-noise';
          
          for (let f = 0; f < frameCount; f++) {
            const data: Record<string, Cell> = {};
            
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                // Simple noise approximation
                const time = isStatic ? 0 : f * noiseSpeed;
                const noise = simplexNoise2D(x * noiseScale, y * noiseScale + time, rng);
                const normalized = (noise + 1) / 2; // 0 to 1
                
                const charIdx = Math.floor(normalized * (chars.length - 1));
                const brightness = normalized;
                
                data[`${x},${y}`] = {
                  char: chars[charIdx],
                  color: secondaryColor 
                    ? lerpColor(color, secondaryColor, normalized)
                    : fadeColor(color, brightness),
                  bgColor: backgroundColor,
                };
              }
            }
            
            frames.push({ data, name: `Noise ${f + 1}` });
          }
          break;
        }
        
        case 'particle-physics': {
          const chars = characterSet || PARTICLE_CHARS;
          
          // Initialize particles
          const particles: Array<{ x: number; y: number; vx: number; vy: number; life: number }> = [];
          for (let i = 0; i < particleCount; i++) {
            particles.push({
              x: rng() * width,
              y: rng() * height,
              vx: (rng() - 0.5) * 2,
              vy: (rng() - 0.5) * 2,
              life: 0.5 + rng() * 0.5,
            });
          }
          
          for (let f = 0; f < frameCount; f++) {
            const data: Record<string, Cell> = {};
            
            // Update and draw particles
            for (const p of particles) {
              // Apply gravity
              p.vy += gravity * 0.1;
              
              // Update position
              p.x += p.vx;
              p.y += p.vy;
              
              // Bounce off walls
              if (p.x < 0 || p.x >= width) { p.vx *= -0.8; p.x = Math.max(0, Math.min(width - 1, p.x)); }
              if (p.y < 0 || p.y >= height) { p.vy *= -0.8; p.y = Math.max(0, Math.min(height - 1, p.y)); }
              
              const px = Math.floor(p.x);
              const py = Math.floor(p.y);
              
              if (px >= 0 && px < width && py >= 0 && py < height) {
                const charIdx = Math.floor(p.life * (chars.length - 1));
                data[`${px},${py}`] = {
                  char: chars[charIdx],
                  color: fadeColor(color, p.life),
                  bgColor: backgroundColor,
                };
              }
            }
            
            frames.push({ data, name: `Particle ${f + 1}` });
          }
          break;
        }
        
        case 'rain-drops': {
          const chars = characterSet || RAIN_CHARS;
          
          // Initialize rain drops
          const drops: Array<{ x: number; y: number; speed: number }> = [];
          for (let i = 0; i < Math.floor(width * density); i++) {
            drops.push({
              x: Math.floor(rng() * width),
              y: Math.floor(rng() * height),
              speed: 0.5 + rng() * speed,
            });
          }
          
          for (let f = 0; f < frameCount; f++) {
            const data: Record<string, Cell> = {};
            
            for (const drop of drops) {
              const x = Math.floor(drop.x);
              const y = Math.floor(drop.y);
              
              if (x >= 0 && x < width && y >= 0 && y < height) {
                const charIdx = Math.floor(rng() * chars.length);
                data[`${x},${y}`] = {
                  char: chars[charIdx],
                  color: color,
                  bgColor: backgroundColor,
                };
              }
              
              // Move drop down
              drop.y += drop.speed;
              if (drop.y >= height) {
                drop.y = 0;
                drop.x = Math.floor(rng() * width);
              }
            }
            
            frames.push({ data, name: `Rain ${f + 1}` });
          }
          break;
        }
        
        case 'gradient': {
          const chars = characterSet || NOISE_CHARS;
          const endColor = secondaryColor || '#000000';
          
          for (let f = 0; f < frameCount; f++) {
            const data: Record<string, Cell> = {};
            const offset = (f / frameCount) * 2 * Math.PI;
            
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                // Animated diagonal gradient
                const t = ((x / width) + (y / height) + Math.sin(offset)) / 3;
                const normalized = (Math.sin(t * Math.PI * 2) + 1) / 2;
                
                const charIdx = Math.floor(normalized * (chars.length - 1));
                
                data[`${x},${y}`] = {
                  char: chars[charIdx],
                  color: lerpColor(color, endColor, normalized),
                  bgColor: backgroundColor,
                };
              }
            }
            
            frames.push({ data, name: `Gradient ${f + 1}` });
          }
          break;
        }
      }
      
      // Apply frames to project
      if (replaceFrames) {
        // Delete all existing frames except first
        while (state.frames.length > 1) {
          pm.deleteFrame(1);
        }
        // Clear first frame and use it for first generated frame
        if (frames.length > 0) {
          pm.clearCanvas();
          for (const [key, cell] of Object.entries(frames[0].data)) {
            const [x, y] = key.split(',').map(Number);
            pm.setCell(x, y, cell);
          }
          pm.setFrameName(0, frames[0].name);
        }
        // Add remaining frames
        for (let i = 1; i < frames.length; i++) {
          pm.addFrame(i, undefined, frameDuration);
          pm.goToFrame(i);
          for (const [key, cell] of Object.entries(frames[i].data)) {
            const [x, y] = key.split(',').map(Number);
            pm.setCell(x, y, cell);
          }
        }
      } else {
        // Append frames
        const startIdx = state.frames.length;
        for (let i = 0; i < frames.length; i++) {
          pm.addFrame(i, undefined, frameDuration);
          pm.goToFrame(startIdx + i);
          for (const [key, cell] of Object.entries(frames[i].data)) {
            const [x, y] = key.split(',').map(Number);
            pm.setCell(x, y, cell);
          }
        }
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            generator,
            framesGenerated: frames.length,
            frameDuration,
            totalDuration: frames.length * frameDuration,
            hint: replaceFrames ? 'Replaced existing frames' : `Appended to existing ${state.frames.length} frames`,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // preview_generator - Preview without applying
  // ==========================================================================
  server.tool(
    'preview_generator',
    'Preview a single frame from a generator without applying to the project.',
    {
      generator: z.enum(['digital-rain', 'radio-waves', 'turbulent-noise', 'particle-physics', 'rain-drops', 'static-noise', 'gradient'])
        .describe('Generator type'),
      color: z.string().default('#00FF00').describe('Primary color'),
      density: z.number().min(0.01).max(1).default(0.1).describe('Element density'),
      seed: z.number().int().optional().describe('Random seed'),
    },
    async ({ generator, density, seed }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      const { width, height } = state;
      
      const rng = seed !== undefined ? seededRandom(seed) : Math.random;
      
      // Generate single preview frame (simplified)
      const lines: string[] = [];
      
      for (let y = 0; y < height; y++) {
        let line = '';
        for (let x = 0; x < width; x++) {
          const val = rng();
          if (val < density) {
            line += generator === 'digital-rain' ? MATRIX_CHARS[Math.floor(rng() * MATRIX_CHARS.length)]
                  : generator === 'radio-waves' ? WAVE_CHARS[Math.floor(rng() * WAVE_CHARS.length)]
                  : NOISE_CHARS[Math.floor(rng() * NOISE_CHARS.length)];
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
            generator,
            preview: lines.join('\n'),
            width,
            height,
            hint: 'This is a simplified preview. Use run_generator to create the full animation.',
          }) 
        }],
      };
    }
  );
}

// =============================================================================
// Helper Functions
// =============================================================================

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

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

function fadeColor(color: string, brightness: number): string {
  const { r, g, b } = hexToRgb(color);
  return rgbToHex(r * brightness, g * brightness, b * brightness);
}

function lerpColor(c1: string, c2: string, t: number): string {
  const rgb1 = hexToRgb(c1);
  const rgb2 = hexToRgb(c2);
  return rgbToHex(
    rgb1.r + (rgb2.r - rgb1.r) * t,
    rgb1.g + (rgb2.g - rgb1.g) * t,
    rgb1.b + (rgb2.b - rgb1.b) * t
  );
}

// Simple 2D noise approximation (not true simplex, but good enough for visual effects)
function simplexNoise2D(x: number, y: number, __rng: () => number): number {
  // Simple hash-based noise
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  
  // Smooth interpolation
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  
  // Hash corners (deterministic based on position)
  const hash = (px: number, py: number) => {
    const n = Math.sin(px * 127.1 + py * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  
  // Bilinear interpolation
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
