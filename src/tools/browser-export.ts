/**
 * Browser-Delegated Export Tools
 * 
 * These tools delegate rendering to the connected browser app, which has
 * full Canvas API access for high-quality PNG/JPG/Video exports.
 * 
 * Flow:
 * 1. MCP tool sends an export_request to the browser via WebSocket
 * 2. Browser runs ExportDataCollector + ExportRenderer
 * 3. Browser sends back export_result with base64-encoded file data
 * 4. MCP server saves the file to disk
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ExportRequest, ExportResult } from '../transport/websocket.js';

// Export request callback - set by index.ts when live mode is enabled
let requestExportCallback: ((request: ExportRequest, timeoutMs?: number) => Promise<ExportResult>) | null = null;

export function setExportRequestCallback(
  callback: (request: ExportRequest, timeoutMs?: number) => Promise<ExportResult>,
): void {
  requestExportCallback = callback;
}

function ensureLiveMode(): string | null {
  if (!requestExportCallback) {
    return 'Browser export requires live mode. Start server with --live flag and connect a browser.';
  }
  return null;
}

function resolveExportPath(filePath: string): { fullPath: string; error?: string } {
  const projectDir = process.env.ASCII_MOTION_PROJECT_DIR || process.cwd();
  const fullPath = path.resolve(projectDir, filePath);

  // Security: ensure path is within project dir
  if (!fullPath.startsWith(projectDir)) {
    return { fullPath: '', error: 'Path must be within project directory' };
  }
  return { fullPath };
}

export function registerBrowserExportTools(server: McpServer): void {
  // ==========================================================================
  // export_image - Export current frame as PNG, JPG, or SVG via browser
  // ==========================================================================
  server.tool(
    'export_image',
    'Export the current frame as an image (PNG, JPG, or SVG). The browser renders the image at full quality. Requires live mode with a connected browser.',
    {
      filePath: z.string().describe('File path to save (relative to project dir). Extension determines format (.png, .jpg, .svg).'),
      format: z.enum(['png', 'jpg', 'svg']).optional().describe('Image format (auto-detected from file extension if omitted)'),
      sizeMultiplier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1).describe('Size multiplier (1x, 2x, 3x, or 4x)'),
      includeGrid: z.boolean().default(false).describe('Include grid lines in the export'),
      quality: z.number().int().min(1).max(100).default(90).describe('JPEG quality (1-100, only used for JPG format)'),
      frameIndex: z.number().int().optional().describe('Frame to export (defaults to current frame)'),
    },
    async ({ filePath, format, sizeMultiplier, includeGrid, quality, frameIndex }) => {
      const error = ensureLiveMode();
      if (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
      }

      // Auto-detect format from extension
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const resolvedFormat = format ?? (ext === 'jpg' || ext === 'jpeg' ? 'jpg' : ext === 'svg' ? 'svg' : 'png');

      const { fullPath, error: pathError } = resolveExportPath(filePath);
      if (pathError) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: pathError }) }], isError: true };
      }

      const requestId = crypto.randomUUID();
      const request: ExportRequest = {
        requestId,
        exportType: 'image',
        format: resolvedFormat,
        settings: {
          sizeMultiplier,
          includeGrid,
          quality,
          format: resolvedFormat,
          frameIndex,
        },
        filename: path.basename(filePath, path.extname(filePath)),
      };

      const result = await requestExportCallback!(request, 30000);

      if (!result.success || !result.data) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: result.error ?? 'Export failed' }) }],
          isError: true,
        };
      }

      // Decode base64 and save to disk
      const buffer = Buffer.from(result.data, 'base64');
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, buffer);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            filePath: fullPath,
            format: resolvedFormat,
            bytes: buffer.length,
            mimeType: result.mimeType,
          }),
        }],
      };
    },
  );

  // ==========================================================================
  // export_video - Export animation as MP4 or WebM via browser
  // ==========================================================================
  server.tool(
    'export_video',
    'Export the animation as a video file (MP4 or WebM). The browser renders each frame and encodes the video. Requires live mode with a connected browser.',
    {
      filePath: z.string().describe('File path to save (relative to project dir). Extension determines format (.mp4, .webm).'),
      format: z.enum(['mp4', 'webm']).optional().describe('Video format (auto-detected from file extension if omitted)'),
      sizeMultiplier: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1).describe('Size multiplier (1x, 2x, or 4x)'),
      frameRate: z.union([z.number().int().min(1).max(60), z.literal('auto')]).default('auto').describe('Frame rate in fps, or "auto" to use project frame rate'),
      quality: z.enum(['high', 'medium', 'low']).default('high').describe('Encoding quality'),
      includeGrid: z.boolean().default(false).describe('Include grid lines in the export'),
      loops: z.enum(['none', '2x', '4x', '8x']).default('none').describe('Number of times to loop the animation in the video'),
      frameRange: z.object({
        start: z.number().int().min(0),
        end: z.number().int(),
      }).optional().describe('Frame range to export (defaults to all frames)'),
    },
    async ({ filePath, format, sizeMultiplier, frameRate, quality, includeGrid, loops, frameRange }) => {
      const error = ensureLiveMode();
      if (error) {
        return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
      }

      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const resolvedFormat = format ?? (ext === 'webm' ? 'webm' : 'mp4');

      const { fullPath, error: pathError } = resolveExportPath(filePath);
      if (pathError) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: pathError }) }], isError: true };
      }

      const requestId = crypto.randomUUID();
      const request: ExportRequest = {
        requestId,
        exportType: 'video',
        format: resolvedFormat,
        settings: {
          sizeMultiplier,
          frameRate,
          quality,
          includeGrid,
          loops,
          format: resolvedFormat,
          frameRange: frameRange ?? 'all',
          crf: quality === 'high' ? 18 : quality === 'medium' ? 24 : 32,
        },
        filename: path.basename(filePath, path.extname(filePath)),
      };

      // Video encoding can take a while — use 120s timeout
      const result = await requestExportCallback!(request, 120000);

      if (!result.success || !result.data) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: result.error ?? 'Video export failed' }) }],
          isError: true,
        };
      }

      const buffer = Buffer.from(result.data, 'base64');
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, buffer);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            filePath: fullPath,
            format: resolvedFormat,
            bytes: buffer.length,
            mimeType: result.mimeType,
          }),
        }],
      };
    },
  );
}
