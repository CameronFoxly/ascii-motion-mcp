/**
 * MCP Resources
 * 
 * Exposes project state as MCP resources for subscription-based access.
 * Resources allow clients to read project data without tool calls.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager } from '../state.js';

export function registerResources(server: McpServer): void {
  // ==========================================================================
  // project://state - Full project state snapshot
  // ==========================================================================
  server.resource(
    'project-state',
    'project://state',
    {
      description: 'Current project state including canvas, frames, and settings. Returns a complete snapshot.',
      mimeType: 'application/json',
    },
    async () => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      return {
        contents: [{
          uri: 'project://state',
          mimeType: 'application/json',
          text: JSON.stringify({
            name: state.name,
            description: state.description,
            width: state.width,
            height: state.height,
            backgroundColor: state.backgroundColor,
            frameCount: state.frames.length,
            currentFrameIndex: state.currentFrameIndex,
            isDirty: state.isDirty,
            toolState: state.toolState,
            hasSelection: state.selection !== null,
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // project://canvas - Current frame canvas data
  // ==========================================================================
  server.resource(
    'project-canvas',
    'project://canvas',
    {
      description: 'Current frame canvas data as a sparse map of cell positions to cell data.',
      mimeType: 'application/json',
    },
    async () => {
      const pm = getProjectManager();
      const state = pm.getState();
      const frame = state.frames[state.currentFrameIndex];
      
      return {
        contents: [{
          uri: 'project://canvas',
          mimeType: 'application/json',
          text: JSON.stringify({
            frameIndex: state.currentFrameIndex,
            frameName: frame?.name ?? 'Frame 1',
            width: state.width,
            height: state.height,
            cellCount: frame ? Object.keys(frame.data).length : 0,
            data: frame?.data ?? {},
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // project://frames - List of all frames with metadata
  // ==========================================================================
  server.resource(
    'project-frames',
    'project://frames',
    {
      description: 'List of all animation frames with their metadata (id, name, duration, cell count).',
      mimeType: 'application/json',
    },
    async () => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      return {
        contents: [{
          uri: 'project://frames',
          mimeType: 'application/json',
          text: JSON.stringify({
            frameCount: state.frames.length,
            currentFrameIndex: state.currentFrameIndex,
            totalDuration: state.frames.reduce((sum, f) => sum + f.duration, 0),
            frames: state.frames.map((f, i) => ({
              index: i,
              id: f.id,
              name: f.name,
              duration: f.duration,
              cellCount: Object.keys(f.data).length,
              isCurrent: i === state.currentFrameIndex,
            })),
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // project://selection - Current selection state
  // ==========================================================================
  server.resource(
    'project-selection',
    'project://selection',
    {
      description: 'Current selection state including type and selected cells.',
      mimeType: 'application/json',
    },
    async () => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      let selectionData: Record<string, unknown> = {
        hasSelection: false,
      };
      
      if (state.selection) {
        if (state.selection.type === 'rectangle') {
          selectionData = {
            hasSelection: true,
            type: 'rectangle',
            start: state.selection.start,
            end: state.selection.end,
            width: Math.abs(state.selection.end.x - state.selection.start.x) + 1,
            height: Math.abs(state.selection.end.y - state.selection.start.y) + 1,
          };
        } else if (state.selection.type === 'cells') {
          selectionData = {
            hasSelection: true,
            type: 'cells',
            cellCount: state.selection.cells.length,
            cells: Array.from(state.selection.cells),
          };
        }
      }
      
      return {
        contents: [{
          uri: 'project://selection',
          mimeType: 'application/json',
          text: JSON.stringify(selectionData, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // project://history - Undo/redo history status
  // ==========================================================================
  server.resource(
    'project-history',
    'project://history',
    {
      description: 'Undo/redo history status including available actions.',
      mimeType: 'application/json',
    },
    async () => {
      const pm = getProjectManager();
      const historyStatus = pm.getHistoryInfo();
      
      return {
        contents: [{
          uri: 'project://history',
          mimeType: 'application/json',
          text: JSON.stringify(historyStatus, null, 2),
        }],
      };
    }
  );

  // ==========================================================================
  // project://ascii - ASCII art preview of current frame
  // ==========================================================================
  server.resource(
    'project-ascii',
    'project://ascii',
    {
      description: 'Plain text ASCII art preview of the current frame.',
      mimeType: 'text/plain',
    },
    async () => {
      const pm = getProjectManager();
      const state = pm.getState();
      const frame = state.frames[state.currentFrameIndex];
      
      if (!frame) {
        return {
          contents: [{
            uri: 'project://ascii',
            mimeType: 'text/plain',
            text: '(empty canvas)',
          }],
        };
      }
      
      // Build ASCII preview
      const lines: string[] = [];
      for (let y = 0; y < state.height; y++) {
        let line = '';
        for (let x = 0; x < state.width; x++) {
          const cell = frame.data[`${x},${y}`];
          line += cell?.char ?? ' ';
        }
        lines.push(line.trimEnd());
      }
      
      // Trim empty lines from end
      while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      
      return {
        contents: [{
          uri: 'project://ascii',
          mimeType: 'text/plain',
          text: lines.join('\n') || '(empty canvas)',
        }],
      };
    }
  );
}
