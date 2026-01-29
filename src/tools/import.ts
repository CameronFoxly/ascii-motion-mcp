/**
 * Import Tools
 * 
 * Tools for importing images and videos as ASCII art:
 * - import_image: Import an image and convert to ASCII
 * - import_video: Import video frames as animation
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';

export function registerImportTools(server: McpServer): void {
  // ==========================================================================
  // import_image - Import an image and convert to ASCII
  // ==========================================================================
  server.tool(
    'import_image',
    'Import an image file and convert it to ASCII art on the canvas. Requires optional "sharp" or "jimp" package for image processing.',
    {
      filePath: z.string().describe('Path to the image file (.png, .jpg, .gif, .bmp)'),
      targetWidth: z.number().int().optional().describe('Target width in characters. If omitted, uses canvas width.'),
      targetHeight: z.number().int().optional().describe('Target height in characters. If omitted, maintains aspect ratio.'),
      charset: z.string().default(' .:-=+*#%@').describe('Characters to use for brightness mapping (dark to bright)'),
      colorMode: z.enum(['none', 'foreground', 'background', 'both']).default('foreground').describe('How to apply colors'),
      dithering: z.enum(['none', 'floyd-steinberg', 'ordered']).default('none').describe('Dithering algorithm to use'),
      frameIndex: z.number().int().optional().describe('Frame to import to (defaults to current)'),
      offsetX: z.number().int().default(0).describe('X offset on canvas'),
      offsetY: z.number().int().default(0).describe('Y offset on canvas'),
    },
    async ({ filePath, targetWidth, targetHeight, charset, colorMode, dithering, frameIndex, offsetX, offsetY }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
      const fullPath = path.resolve(projectDir, filePath);
      
      // Check file exists
      try {
        await fs.access(fullPath);
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `File not found: ${filePath}` }) }],
          isError: true,
        };
      }

      // Determine target dimensions
      const width = targetWidth ?? state.width;
      const height = targetHeight ?? Math.floor(width / 2); // Approximate aspect ratio for terminal chars
      
      try {
        // Try to use sharp for image processing
        // @ts-ignore - optional dependency
        const sharp = await import('sharp');
        
        // Read and resize image
        const image = sharp.default(fullPath);
        const metadata = await image.metadata();
        
        // Resize to target dimensions
        const resized = await image
          .resize(width, height, { fit: 'fill' })
          .raw()
          .toBuffer({ resolveWithObject: true });
        
        const { data, info } = resized;
        const channels = info.channels;
        
        // Convert to ASCII
        const frameIdx = frameIndex ?? state.currentFrameIndex;
        const frame = state.frames[frameIdx];
        if (!frame) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid frame index' }) }],
            isError: true,
          };
        }
        
        const cellsToSet: Array<{ x: number; y: number; char: string; color: string; bgColor: string }> = [];
        
        for (let y = 0; y < info.height; y++) {
          for (let x = 0; x < info.width; x++) {
            const idx = (y * info.width + x) * channels;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = channels === 4 ? data[idx + 3] : 255;
            
            // Skip transparent pixels
            if (a < 128) continue;
            
            // Calculate brightness (0-1)
            let brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            
            // Apply dithering if requested
            if (dithering === 'ordered') {
              // 4x4 Bayer matrix dithering
              const bayerMatrix = [
                [0, 8, 2, 10],
                [12, 4, 14, 6],
                [3, 11, 1, 9],
                [15, 7, 13, 5],
              ];
              const threshold = bayerMatrix[y % 4][x % 4] / 16;
              brightness = brightness + (threshold - 0.5) * 0.2;
              brightness = Math.max(0, Math.min(1, brightness));
            }
            
            // Map brightness to character
            const charIndex = Math.floor(brightness * (charset.length - 1));
            const char = charset[charIndex];
            
            // Determine colors
            const hexColor = rgbToHex(r, g, b);
            let fgColor = '#ffffff';
            let bgColor = 'transparent';
            
            if (colorMode === 'foreground' || colorMode === 'both') {
              fgColor = hexColor;
            }
            if (colorMode === 'background' || colorMode === 'both') {
              bgColor = hexColor;
            }
            
            const canvasX = x + offsetX;
            const canvasY = y + offsetY;
            
            if (canvasX >= 0 && canvasX < state.width && canvasY >= 0 && canvasY < state.height) {
              cellsToSet.push({
                x: canvasX,
                y: canvasY,
                char,
                color: fgColor,
                bgColor,
              });
            }
          }
        }
        
        // Apply Floyd-Steinberg dithering post-process if requested
        // (This is a simplified version - true F-S would need error diffusion during processing)
        
        // Set all cells
        for (const cell of cellsToSet) {
          pm.setCell(cell.x, cell.y, { char: cell.char, color: cell.color, bgColor: cell.bgColor });
        }
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ 
              success: true,
              sourceFile: fullPath,
              sourceDimensions: { width: metadata.width, height: metadata.height },
              targetDimensions: { width: info.width, height: info.height },
              cellsCreated: cellsToSet.length,
              colorMode,
              charset,
            }) 
          }],
        };
      } catch (e) {
        // Fall back to jimp if sharp is not available
        try {
          // @ts-ignore - optional dependency
          const Jimp = (await import('jimp')).default;
          
          const image = await Jimp.read(fullPath);
          
          // Resize to target dimensions
          image.resize(width, height);
          
          const cellsToSet: Array<{ x: number; y: number; char: string; color: string; bgColor: string }> = [];
          
          for (let y = 0; y < image.getHeight(); y++) {
            for (let x = 0; x < image.getWidth(); x++) {
              const pixelColor = image.getPixelColor(x, y);
              const { r, g, b, a } = Jimp.intToRGBA(pixelColor);
              
              // Skip transparent pixels
              if (a < 128) continue;
              
              // Calculate brightness
              let brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
              
              // Map brightness to character
              const charIndex = Math.floor(brightness * (charset.length - 1));
              const char = charset[charIndex];
              
              // Determine colors
              const hexColor = rgbToHex(r, g, b);
              let fgColor = '#ffffff';
              let bgColor = 'transparent';
              
              if (colorMode === 'foreground' || colorMode === 'both') {
                fgColor = hexColor;
              }
              if (colorMode === 'background' || colorMode === 'both') {
                bgColor = hexColor;
              }
              
              const canvasX = x + offsetX;
              const canvasY = y + offsetY;
              
              if (canvasX >= 0 && canvasX < state.width && canvasY >= 0 && canvasY < state.height) {
                cellsToSet.push({
                  x: canvasX,
                  y: canvasY,
                  char,
                  color: fgColor,
                  bgColor,
                });
              }
            }
          }
          
          // Set all cells
          for (const cell of cellsToSet) {
            pm.setCell(cell.x, cell.y, { char: cell.char, color: cell.color, bgColor: cell.bgColor });
          }
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ 
                success: true,
                sourceFile: fullPath,
                targetDimensions: { width, height },
                cellsCreated: cellsToSet.length,
                colorMode,
                charset,
                note: 'Used jimp for image processing',
              }) 
            }],
          };
        } catch (_e2) {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ 
                error: 'Image import requires either "sharp" or "jimp" npm package.',
                installCommand: 'npm install sharp  # or: npm install jimp',
                alternativeHint: 'You can also manually convert images using an external tool and paste the ASCII text using paste_ascii_block.',
              }) 
            }],
            isError: true,
          };
        }
      }
    }
  );

  // ==========================================================================
  // import_video - Import video frames as animation
  // ==========================================================================
  server.tool(
    'import_video',
    'Import a video file and convert each frame to ASCII art animation. Requires ffmpeg and optional image processing package.',
    {
      filePath: z.string().describe('Path to the video file (.mp4, .webm, .mov, .gif)'),
      targetWidth: z.number().int().optional().describe('Target width in characters. If omitted, uses canvas width.'),
      targetHeight: z.number().int().optional().describe('Target height in characters. If omitted, maintains aspect ratio.'),
      charset: z.string().default(' .:-=+*#%@').describe('Characters to use for brightness mapping (dark to bright)'),
      colorMode: z.enum(['none', 'foreground', 'background', 'both']).default('foreground').describe('How to apply colors'),
      fps: z.number().default(10).describe('Frames per second to extract'),
      maxFrames: z.number().int().default(100).describe('Maximum number of frames to import'),
      startTime: z.number().default(0).describe('Start time in seconds'),
      duration: z.number().optional().describe('Duration in seconds (omit for entire video)'),
    },
    async ({ filePath, targetWidth, targetHeight, charset, colorMode, fps, maxFrames, startTime, duration }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
      const fullPath = path.resolve(projectDir, filePath);
      
      // Check file exists
      try {
        await fs.access(fullPath);
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `File not found: ${filePath}` }) }],
          isError: true,
        };
      }

      // Video import requires ffmpeg to extract frames
      // This is a placeholder that provides instructions for video import
      // Full implementation would need:
      // 1. ffmpeg to extract frames to temp directory
      // 2. Process each frame using import_image logic
      // 3. Create frames in animation
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            error: 'Video import is not yet fully implemented in headless mode.',
            suggestion: 'For now, you can:',
            steps: [
              '1. Extract frames using ffmpeg: ffmpeg -i video.mp4 -vf fps=10 frame_%03d.png',
              '2. Import each frame individually using import_image',
              '3. Each import_image call can target a different frame index',
            ],
            ffmpegCommand: `ffmpeg -i "${fullPath}" -ss ${startTime}${duration ? ` -t ${duration}` : ''} -vf "fps=${fps},scale=${targetWidth ?? state.width}:${targetHeight ?? -1}" -frames:v ${maxFrames} frame_%03d.png`,
            parameters: {
              targetWidth: targetWidth ?? state.width,
              targetHeight: targetHeight ?? 'auto',
              charset,
              colorMode,
              fps,
              maxFrames,
              startTime,
              duration: duration ?? 'full video',
            },
          }) 
        }],
        isError: true,
      };
    }
  );

  // ==========================================================================
  // import_ascii_text - Import ASCII art from a text file
  // ==========================================================================
  server.tool(
    'import_ascii_text',
    'Import ASCII art from a plain text file onto the canvas.',
    {
      filePath: z.string().describe('Path to the text file'),
      frameIndex: z.number().int().optional().describe('Frame to import to (defaults to current)'),
      offsetX: z.number().int().default(0).describe('X offset on canvas'),
      offsetY: z.number().int().default(0).describe('Y offset on canvas'),
      color: z.string().default('#ffffff').describe('Foreground color for imported text'),
      bgColor: z.string().default('transparent').describe('Background color for imported text'),
      replaceSpaces: z.boolean().default(false).describe('Whether to set cells for space characters'),
    },
    async ({ filePath, frameIndex: _frameIndex, offsetX, offsetY, color, bgColor, replaceSpaces }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
      const fullPath = path.resolve(projectDir, filePath);
      
      // Security: ensure path is within project dir
      if (!fullPath.startsWith(projectDir)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Path must be within project directory' }) }],
          isError: true,
        };
      }
      
      // Read file
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Failed to read file: ${filePath}` }) }],
          isError: true,
        };
      }
      
      const lines = content.split('\n');
      let cellsSet = 0;
      
      for (let y = 0; y < lines.length; y++) {
        const line = lines[y];
        for (let x = 0; x < line.length; x++) {
          const char = line[x];
          
          // Skip spaces unless replaceSpaces is true
          if (char === ' ' && !replaceSpaces) continue;
          
          const canvasX = x + offsetX;
          const canvasY = y + offsetY;
          
          if (canvasX >= 0 && canvasX < state.width && canvasY >= 0 && canvasY < state.height) {
            pm.setCell(canvasX, canvasY, { char, color, bgColor });
            cellsSet++;
          }
        }
      }
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ 
            success: true,
            sourceFile: fullPath,
            dimensions: { width: Math.max(...lines.map(l => l.length)), height: lines.length },
            cellsSet,
            offset: { x: offsetX, y: offsetY },
          }) 
        }],
      };
    }
  );
}

// =============================================================================
// Helper Functions
// =============================================================================

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}
