/**
 * Browser Sync Tools
 * 
 * Tools for synchronizing state with the connected browser.
 */

import { z } from 'zod';
import { McpServer } from '../mcp.js';
import { getProjectManager } from '../state.js';
import { ensureFreshBrowserState } from '../state.js';
import { differencePage } from '../cell-diff.js';

// State request callback - will be set by index.ts
let requestBrowserStateCallback: (() => Promise<boolean>) | null = null;

export function setRequestBrowserStateCallback(callback: () => Promise<boolean>): void {
  requestBrowserStateCallback = callback;
}

export function registerSyncTools(server: McpServer): void {
  // ===========================================================================
  // refresh_state_from_browser - Request fresh state from connected browser
  // ===========================================================================
  server.tool(
    'refresh_state_from_browser',
    'Request the browser to send its current state. Use this before reading canvas data to ensure you have the latest state. Returns success if browser is connected and responded.',
    {},
    async () => {
      if (!requestBrowserStateCallback) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'Live mode not enabled. Start server with --live flag.',
            }),
          }],
        };
      }

      try {
        const success = await requestBrowserStateCallback();
        if (success) {
          const pm = getProjectManager();
          const state = pm.getState();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'State refreshed from browser',
                summary: {
                  frames: state.frames.length,
                  currentFrame: state.currentFrameIndex,
                  canvasSize: `${state.width}x${state.height}`,
                  projectName: state.name,
                },
              }),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'No browser connected or request timed out',
              }),
            }],
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: String(error),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // ===========================================================================
  // compare_frames - Show differences between two frames
  // ===========================================================================
  server.tool(
    'compare_frames',
    'Compare two frames and show what cells changed between them. Useful for understanding motion and edits in an animation.',
    {
      frameA: z.number().int().describe('Index of first frame'),
      frameB: z.number().int().describe('Index of second frame'),
      showUnchanged: z.boolean().optional().default(false).describe('Include unchanged cells in output'),
      maxCells: z.number().int().min(1).max(500).default(50).describe('Maximum cells per page'),
      offset: z.number().int().min(0).default(0).describe('Continue from the previous nextOffset'),
    },
    async ({ frameA, frameB, showUnchanged, maxCells = 50, offset = 0 }) => {
      await ensureFreshBrowserState();
      const pm = getProjectManager();
      const state = pm.getState();

      const frameCount = pm.isLayerMode() ? state.timelineConfig.durationFrames : state.frames.length;
      if (frameA < 0 || frameA >= frameCount) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame ${frameA} does not exist` }) }],
          isError: true,
        };
      }
      if (frameB < 0 || frameB >= frameCount) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame ${frameB} does not exist` }) }],
          isError: true,
        };
      }

      const first = pm.getFrameAtTime(frameA);
      const second = pm.getFrameAtTime(frameB);
      const page = differencePage(first.data, second.data, offset, maxCells, showUnchanged);
      const { diffs, ...metadata } = page;
      const result = {
        frameA: { index: frameA, name: first.name },
        frameB: { index: frameB, name: second.name },
        ...metadata,
        summary: { ...page.summary, changed: page.summary.modified },
        added: diffs.filter(diff => diff.change === 'added').map(diff => ({ x: diff.x, y: diff.y, cell: diff.after })),
        removed: diffs.filter(diff => diff.change === 'removed').map(diff => ({ x: diff.x, y: diff.y, cell: diff.before })),
        changed: diffs.filter(diff => diff.change === 'modified').map(diff => ({ x: diff.x, y: diff.y, from: diff.before, to: diff.after })),
        ...(showUnchanged ? { unchanged: diffs.filter(diff => diff.change === 'unchanged') } : {}),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
  );
}
