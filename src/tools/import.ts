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
import {
  applyExactCellChanges,
  requireFreshBrowserState,
  type ExactCellChange,
} from '../live-sync.js';

interface ImagePixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface DecodedImage {
  backend: 'sharp' | 'jimp';
  sourceDimensions: { width?: number; height?: number };
  width: number;
  height: number;
  getPixel: (x: number, y: number) => ImagePixel;
}

interface ImageCellOptions {
  charset: string;
  colorMode: 'none' | 'foreground' | 'background' | 'both';
  dithering: 'none' | 'floyd-steinberg' | 'ordered';
  offsetX: number;
  offsetY: number;
  canvasWidth: number;
  canvasHeight: number;
}

const BAYER_MATRIX = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

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

      try {
        await requireFreshBrowserState();
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }

      const state = pm.getState();
      const width = targetWidth ?? state.width;
      const height = targetHeight ?? Math.floor(width / 2);

      let decoded: DecodedImage;
      try {
        decoded = await decodeImage(fullPath, width, height);
      } catch {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Image import requires either "sharp" or "jimp" npm package.',
              installCommand: 'npm install sharp  # or: npm install jimp',
              alternativeHint: 'You can also manually convert images using an external tool and paste the ASCII text using paste_ascii_block.',
            }),
          }],
          isError: true,
        };
      }

      const cells = buildImageCells(decoded, {
        charset,
        colorMode,
        dithering,
        offsetX,
        offsetY,
        canvasWidth: state.width,
        canvasHeight: state.height,
      });

      let applied;
      try {
        applied = await applyExactCellChanges({
          projectManager: pm,
          frameIndex,
          cells,
        });
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            browserSynced: applied.browserSynced,
            sourceFile: fullPath,
            sourceDimensions: decoded.sourceDimensions,
            targetDimensions: { width: decoded.width, height: decoded.height },
            frameIndex: applied.frameIndex,
            cellsCreated: applied.cellsChanged,
            colorMode,
            charset,
            ...(decoded.backend === 'jimp' ? { note: 'Used jimp for image processing' } : {}),
          }),
        }],
      };
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
    async ({ filePath, frameIndex, offsetX, offsetY, color, bgColor, replaceSpaces }) => {
      const pm = getProjectManager();

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

      try {
        await requireFreshBrowserState();
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }

      const state = pm.getState();
      const lines = content.split('\n');
      const cells = [];

      for (let y = 0; y < lines.length; y++) {
        const line = lines[y];
        for (let x = 0; x < line.length; x++) {
          const char = line[x];

          // Skip spaces unless replaceSpaces is true
          if (char === ' ' && !replaceSpaces) continue;

          const canvasX = x + offsetX;
          const canvasY = y + offsetY;

          if (canvasX >= 0 && canvasX < state.width && canvasY >= 0 && canvasY < state.height) {
            cells.push({
              x: canvasX,
              y: canvasY,
              cell: { char, color, bgColor },
            });
          }
        }
      }

      let applied;
      try {
        applied = await applyExactCellChanges({
          projectManager: pm,
          frameIndex,
          cells,
        });
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            browserSynced: applied.browserSynced,
            sourceFile: fullPath,
            dimensions: { width: Math.max(...lines.map(l => l.length)), height: lines.length },
            frameIndex: applied.frameIndex,
            cellsSet: applied.cellsChanged,
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

async function decodeImage(fullPath: string, width: number, height: number): Promise<DecodedImage> {
  try {
    return await decodeWithSharp(fullPath, width, height);
  } catch {
    return decodeWithJimp(fullPath, width, height);
  }
}

async function decodeWithSharp(fullPath: string, width: number, height: number): Promise<DecodedImage> {
  // @ts-expect-error - optional dependency
  const sharp = await import('sharp');
  const image = sharp.default(fullPath);
  const metadata = await image.metadata();
  const { data, info } = await image
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;

  return {
    backend: 'sharp',
    sourceDimensions: { width: metadata.width, height: metadata.height },
    width: info.width,
    height: info.height,
    getPixel(x, y) {
      const index = (y * info.width + x) * channels;
      return {
        r: data[index],
        g: data[index + 1],
        b: data[index + 2],
        a: channels === 4 ? data[index + 3] : 255,
      };
    },
  };
}

async function decodeWithJimp(fullPath: string, width: number, height: number): Promise<DecodedImage> {
  // @ts-expect-error - optional dependency
  const Jimp = (await import('jimp')).default;
  const image = await Jimp.read(fullPath);
  const sourceDimensions = {
    width: image.getWidth(),
    height: image.getHeight(),
  };
  image.resize(width, height);

  return {
    backend: 'jimp',
    sourceDimensions,
    width: image.getWidth(),
    height: image.getHeight(),
    getPixel(x, y) {
      return Jimp.intToRGBA(image.getPixelColor(x, y));
    },
  };
}

function buildImageCells(image: DecodedImage, options: ImageCellOptions): ExactCellChange[] {
  const cells: ExactCellChange[] = [];

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const { r, g, b, a } = image.getPixel(x, y);
      if (a < 128) continue;

      let brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (options.dithering === 'ordered') {
        const threshold = BAYER_MATRIX[y % 4][x % 4] / 16;
        brightness = Math.max(0, Math.min(1, brightness + (threshold - 0.5) * 0.2));
      }

      const charIndex = Math.floor(brightness * (options.charset.length - 1));
      const hexColor = rgbToHex(r, g, b);
      const canvasX = x + options.offsetX;
      const canvasY = y + options.offsetY;
      if (
        canvasX < 0
        || canvasX >= options.canvasWidth
        || canvasY < 0
        || canvasY >= options.canvasHeight
      ) {
        continue;
      }

      cells.push({
        x: canvasX,
        y: canvasY,
        cell: {
          char: options.charset[charIndex],
          color: options.colorMode === 'foreground' || options.colorMode === 'both'
            ? hexColor
            : '#ffffff',
          bgColor: options.colorMode === 'background' || options.colorMode === 'both'
            ? hexColor
            : 'transparent',
        },
      });
    }
  }

  return cells;
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}
