/**
 * Frame Tools
 * 
 * Tools for managing animation frames.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager, broadcastStateChange } from '../state.js';
import {
  hasBrowserCommandCallback,
  requestBrowserCommand,
} from '../live-sync.js';
import { ensureFreshBrowserState } from '../state.js';
import type { BrowserCommandResult } from '../transport/websocket.js';

export function registerFrameTools(server: McpServer): void {
  // ==========================================================================
  // list_frames - Get all frames in the animation
  // ==========================================================================
  server.tool(
    'list_frames',
    'List all frames in the animation with their metadata',
    {},
    async () => {
      await ensureFreshBrowserState();
      const pm = getProjectManager();
      const state = pm.getState();
      
      const frames = state.frames.map((frame, index) => ({
        index,
        id: frame.id,
        name: frame.name,
        duration: frame.duration,
        cellCount: Object.keys(frame.data).length,
        isCurrent: index === state.currentFrameIndex,
      }));
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            frameCount: frames.length,
            currentFrameIndex: state.currentFrameIndex,
            totalDuration: frames.reduce((sum, f) => sum + f.duration, 0),
            frames,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // add_frame - Add a new frame
  // ==========================================================================
  server.tool(
    'add_frame',
    'Add a new frame to the animation',
    {
      atIndex: z.number().int().optional().describe('Index to insert at (defaults to end)'),
      duration: z.number().int().min(10).max(60000).optional().describe('Frame duration in ms (default: 100)'),
      copyFromIndex: z.number().int().optional().describe('Copy content from this frame index'),
      name: z.string().optional().describe('Frame name'),
    },
    async ({ atIndex, duration, copyFromIndex, name }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      let canvasData = undefined;
      
      if (copyFromIndex !== undefined) {
        if (copyFromIndex < 0 || copyFromIndex >= state.frames.length) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Source frame index ${copyFromIndex} out of range` }) }],
            isError: true,
          };
        }
        canvasData = { ...state.frames[copyFromIndex].data };
      }
      
      const newFrame = pm.addFrame(atIndex, canvasData, duration);
      
      if (name) {
        const frameIndex = pm.getState().frames.findIndex(f => f.id === newFrame.id);
        pm.setFrameName(frameIndex, name, false);
      }
      
      const updatedState = pm.getState();
      const frameIndex = updatedState.frames.findIndex(f => f.id === newFrame.id);
      // Broadcast frame added with full data
      broadcastStateChange('add_frame', { 
        frame: { 
          ...newFrame, 
          index: frameIndex 
        }, 
        totalFrames: updatedState.frames.length 
      });
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            frame: {
              id: newFrame.id,
              name: name ?? newFrame.name,
              index: updatedState.frames.findIndex(f => f.id === newFrame.id),
              duration: newFrame.duration,
            },
            totalFrames: updatedState.frames.length,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // delete_frame - Delete a frame
  // ==========================================================================
  server.tool(
    'delete_frame',
    'Delete a frame from the animation. Cannot delete the last remaining frame.',
    {
      index: z.number().int().describe('Index of frame to delete'),
    },
    async ({ index }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (index < 0 || index >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame index ${index} out of range` }) }],
          isError: true,
        };
      }
      
      if (state.frames.length === 1) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Cannot delete the last frame' }) }],
          isError: true,
        };
      }
      
      const deletedFrame = state.frames[index];
      const success = pm.deleteFrame(index);
      
      const updatedState = pm.getState();
      // Broadcast frame deleted
      broadcastStateChange('delete_frame', { index, totalFrames: updatedState.frames.length });
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success,
            deletedFrame: {
              id: deletedFrame.id,
              name: deletedFrame.name,
            },
            totalFrames: updatedState.frames.length,
            currentFrameIndex: updatedState.currentFrameIndex,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // duplicate_frame - Duplicate a frame
  // ==========================================================================
  server.tool(
    'duplicate_frame',
    'Duplicate a frame, inserting the copy immediately after the original',
    {
      index: z.number().int().describe('Index of frame to duplicate'),
    },
    async ({ index }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (index < 0 || index >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame index ${index} out of range` }) }],
          isError: true,
        };
      }
      
      const newFrame = pm.duplicateFrame(index);
      
      if (!newFrame) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to duplicate frame' }) }],
          isError: true,
        };
      }
      
      const updatedState = pm.getState();
      // Broadcast frame duplicated
      const newFrameIndex = updatedState.frames.findIndex(f => f.id === newFrame.id);
      broadcastStateChange('duplicate_frame', { 
        newFrame: {
          index: newFrameIndex,
          id: newFrame.id,
          name: newFrame.name,
          duration: newFrame.duration,
          data: newFrame.data,
        },
        totalFrames: updatedState.frames.length 
      });
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            originalIndex: index,
            newFrame: {
              id: newFrame.id,
              name: newFrame.name,
              index: updatedState.frames.findIndex(f => f.id === newFrame.id),
              duration: newFrame.duration,
              cellCount: Object.keys(newFrame.data).length,
            },
            totalFrames: updatedState.frames.length,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // go_to_frame - Navigate to a frame
  // ==========================================================================
  server.tool(
    'go_to_frame',
    'Navigate to a specific frame, making it the current/active frame',
    {
      index: z.number().int().describe('Frame index to navigate to'),
    },
    async ({ index }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      const navigationFrameCount = pm.isLayerMode()
        ? state.timelineConfig.durationFrames
        : state.frames.length;
      
      if (index < 0 || index >= navigationFrameCount) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame index ${index} out of range (0-${navigationFrameCount - 1})` }) }],
          isError: true,
        };
      }
      
      let commandResult;
      let reconciled = false;
      const reconcileNavigation = (result: BrowserCommandResult): void => {
        const appliedFrameIndex = result.applied?.currentFrameIndex;
        if (
          typeof appliedFrameIndex !== 'number'
          || !Number.isInteger(appliedFrameIndex)
          || !pm.goToFrame(appliedFrameIndex)
        ) {
          throw new Error('Browser did not confirm a valid applied frame index for go_to_frame');
        }

        reconciled = true;
        if (appliedFrameIndex !== index) {
          throw new Error(
            `Browser applied frame index ${appliedFrameIndex} instead of requested index ${index}`,
          );
        }
      };
      
      try {
        if (!hasBrowserCommandCallback()) {
          if (!pm.goToFrame(index)) {
            throw new Error(`Failed to navigate to frame index ${index}`);
          }
          commandResult = null;
        } else {
          commandResult = await requestBrowserCommand(
            { type: 'go_to_frame', index },
            undefined,
            reconcileNavigation,
          );
          if (commandResult === null) {
            throw new Error('Browser command callback was removed during frame navigation');
          }
        }
        if (commandResult !== null && !reconciled) {
          reconcileNavigation(commandResult);
        }
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

      const appliedFrameIndex = pm.getState().currentFrameIndex;
      const activeContentFrame = pm.isLayerMode()
        ? pm.getActiveContentFrame()
        : null;
      const frame = activeContentFrame
        ? {
            id: activeContentFrame.id,
            name: activeContentFrame.name,
            duration: activeContentFrame.durationFrames
              * (1000 / pm.getState().timelineConfig.frameRate),
            data: activeContentFrame.data,
          }
        : pm.isLayerMode()
          ? {
              id: null,
              name: `Timeline Frame ${appliedFrameIndex + 1}`,
              duration: 1000 / pm.getState().timelineConfig.frameRate,
              data: {},
            }
          : pm.getCurrentFrame();
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            browserSynced: commandResult !== null,
            currentFrame: {
              index: appliedFrameIndex,
              id: frame.id,
              name: frame.name,
              duration: frame.duration,
              cellCount: Object.keys(frame.data).length,
            },
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // set_frame_duration - Change frame duration
  // ==========================================================================
  server.tool(
    'set_frame_duration',
    'Set the duration of a frame in milliseconds',
    {
      index: z.number().int().describe('Frame index'),
      duration: z.number().int().min(10).max(60000).describe('Duration in milliseconds (10-60000)'),
    },
    async ({ index, duration }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (index < 0 || index >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame index ${index} out of range` }) }],
          isError: true,
        };
      }
      
      const previousDuration = state.frames[index].duration;
      let commandResult;
      try {
        commandResult = await requestBrowserCommand({
          type: 'set_frame_duration',
          index,
          duration,
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

      const appliedDuration = commandResult?.applied?.durationMs ?? duration;
      const success = pm.setFrameDuration(
        index,
        appliedDuration,
        true,
        commandResult === null,
      );
      if (commandResult?.applied?.currentFrameIndex !== undefined) {
        pm.goToFrame(commandResult.applied.currentFrameIndex);
      }

      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success,
            browserSynced: commandResult !== null,
            frameIndex: index,
            previousDuration,
            requestedDuration: duration,
            newDuration: pm.getState().frames[index].duration,
            currentFrameIndex: pm.getState().currentFrameIndex,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // set_frame_name - Rename a frame
  // ==========================================================================
  server.tool(
    'set_frame_name',
    'Set or change the name of a frame',
    {
      index: z.number().int().describe('Frame index'),
      name: z.string().min(1).max(100).describe('New frame name'),
    },
    async ({ index, name }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (index < 0 || index >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame index ${index} out of range` }) }],
          isError: true,
        };
      }
      
      const previousName = state.frames[index].name;
      const success = pm.setFrameName(index, name);
      
      // Broadcast name change
      broadcastStateChange('set_frame_name', { index, name });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success,
            frameIndex: index,
            previousName,
            newName: name,
          }) 
        }],
      };
    }
  );
}
