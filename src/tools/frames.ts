/**
 * Frame Tools
 * 
 * Tools for managing animation frames.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager, broadcastStateChange } from '../state.js';

export function registerFrameTools(server: McpServer): void {
  // ==========================================================================
  // list_frames - Get all frames in the animation
  // ==========================================================================
  server.tool(
    'list_frames',
    'List all frames in the animation with their metadata',
    {},
    async () => {
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
      // Broadcast frame added
      broadcastStateChange('add_frame', { frame: newFrame, totalFrames: updatedState.frames.length });
      
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
      broadcastStateChange('duplicate_frame', { newFrame, totalFrames: updatedState.frames.length });
      
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
      
      if (index < 0 || index >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Frame index ${index} out of range (0-${state.frames.length - 1})` }) }],
          isError: true,
        };
      }
      
      const success = pm.goToFrame(index);
      const frame = pm.getCurrentFrame();
      
      // Broadcast frame change
      broadcastStateChange('go_to_frame', { index });
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success,
            currentFrame: {
              index,
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
      const success = pm.setFrameDuration(index, duration);
      
      // Broadcast duration change
      broadcastStateChange('set_frame_duration', { index, duration });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success,
            frameIndex: index,
            previousDuration,
            newDuration: pm.getState().frames[index].duration,
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
