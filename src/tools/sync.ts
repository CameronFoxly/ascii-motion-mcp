/**
 * Browser Sync Tools
 * 
 * Tools for synchronizing state with the connected browser.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';
import { parseCellKey, type Cell } from '../types.js';

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
    },
    async ({ frameA, frameB, showUnchanged }) => {
      const pm = getProjectManager();
      const state = pm.getState();

      if (frameA < 0 || frameA >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame ${frameA} does not exist` }) }],
          isError: true,
        };
      }
      if (frameB < 0 || frameB >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame ${frameB} does not exist` }) }],
          isError: true,
        };
      }

      const dataA = state.frames[frameA].data;
      const dataB = state.frames[frameB].data;

      const allKeys = new Set([...Object.keys(dataA), ...Object.keys(dataB)]);
      
      const added: Array<{ x: number; y: number; cell: Cell }> = [];
      const removed: Array<{ x: number; y: number; cell: Cell }> = [];
      const changed: Array<{ x: number; y: number; from: Cell; to: Cell }> = [];
      const unchanged: Array<{ x: number; y: number; cell: Cell }> = [];

      for (const key of allKeys) {
        const { x, y } = parseCellKey(key);
        const cellA = dataA[key] as Cell | undefined;
        const cellB = dataB[key] as Cell | undefined;

        if (!cellA && cellB) {
          added.push({ x, y, cell: cellB });
        } else if (cellA && !cellB) {
          removed.push({ x, y, cell: cellA });
        } else if (cellA && cellB) {
          if (cellA.char !== cellB.char || cellA.color !== cellB.color || cellA.bgColor !== cellB.bgColor) {
            changed.push({ x, y, from: cellA, to: cellB });
          } else if (showUnchanged) {
            unchanged.push({ x, y, cell: cellA });
          }
        }
      }

      const result: Record<string, unknown> = {
        frameA: { index: frameA, name: state.frames[frameA].name },
        frameB: { index: frameB, name: state.frames[frameB].name },
        summary: {
          added: added.length,
          removed: removed.length,
          changed: changed.length,
          unchanged: showUnchanged ? unchanged.length : undefined,
        },
        added,
        removed,
        changed,
      };

      if (showUnchanged) {
        result.unchanged = unchanged;
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
