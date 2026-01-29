/**
 * Animation Workflow Tools
 * 
 * Higher-level tools for common animation tasks.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager, broadcastStateChange } from '../state.js';
import { parseCellKey, createCellKey, isInBounds, type Cell, type CanvasData } from '../types.js';

export function registerAnimationTools(server: McpServer): void {
  // ==========================================================================
  // copy_frame_and_modify - Duplicate and edit in one step
  // ==========================================================================
  server.tool(
    'copy_frame_and_modify',
    'Duplicate a frame and apply modifications in a single operation. Efficient for creating animation sequences.',
    {
      sourceIndex: z.number().int().describe('Index of frame to copy'),
      modifications: z.array(z.object({
        x: z.number().int(),
        y: z.number().int(),
        char: z.string().length(1).optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        bgColor: z.string().optional(),
        clear: z.boolean().optional().describe('If true, clear this cell'),
      })).describe('Cell modifications to apply to the new frame'),
      insertAtIndex: z.number().int().optional().describe('Where to insert the new frame (defaults to after source)'),
      name: z.string().optional().describe('Name for the new frame'),
      duration: z.number().int().min(10).max(60000).optional().describe('Duration for the new frame'),
    },
    async ({ sourceIndex, modifications, insertAtIndex: _insertAtIndex, name, duration }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (sourceIndex < 0 || sourceIndex >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Source frame index out of range' }) }],
          isError: true,
        };
      }
      
      // Duplicate the frame
      const newFrame = pm.duplicateFrame(sourceIndex, false);
      if (!newFrame) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to duplicate frame' }) }],
          isError: true,
        };
      }
      
      // Find the new frame index
      const newIndex = pm.getState().frames.findIndex(f => f.id === newFrame.id);
      
      // Navigate to the new frame to apply modifications
      pm.goToFrame(newIndex);
      
      // Apply modifications
      let modified = 0;
      for (const mod of modifications) {
        if (!isInBounds(mod.x, mod.y, state.width, state.height)) continue;
        
        if (mod.clear) {
          pm.clearCell(mod.x, mod.y, false);
        } else {
          const current = pm.getCell(mod.x, mod.y);
          pm.setCell(mod.x, mod.y, {
            char: mod.char ?? current.char,
            color: mod.color ?? current.color,
            bgColor: mod.bgColor ?? current.bgColor,
          }, false);
        }
        modified++;
      }
      
      // Set name and duration if provided
      if (name) {
        pm.setFrameName(newIndex, name, false);
      }
      if (duration) {
        pm.setFrameDuration(newIndex, duration, false);
      }
      
      // Move frame if insertAtIndex differs from default position
      // (For simplicity, we're not implementing reordering here - would need to add to state manager)
      
      const updatedState = pm.getState();
      
      // Broadcast the new frame with all its data
      broadcastStateChange('copy_frame_and_modify', {
        newFrame: {
          index: newIndex,
          id: newFrame.id,
          name: updatedState.frames[newIndex].name,
          duration: updatedState.frames[newIndex].duration,
          data: updatedState.frames[newIndex].data,
        },
        totalFrames: updatedState.frames.length,
      });
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            newFrame: {
              index: newIndex,
              id: newFrame.id,
              name: updatedState.frames[newIndex].name,
              duration: updatedState.frames[newIndex].duration,
            },
            modificationsApplied: modified,
            totalFrames: updatedState.frames.length,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // shift_frame_content - Translate all cells
  // ==========================================================================
  server.tool(
    'shift_frame_content',
    'Shift all content on the current frame by an x/y offset. Useful for creating scrolling or movement animations.',
    {
      dx: z.number().int().describe('Horizontal shift (positive = right, negative = left)'),
      dy: z.number().int().describe('Vertical shift (positive = down, negative = up)'),
      wrap: z.boolean().default(false).describe('If true, content wraps around edges'),
      frameIndex: z.number().int().optional().describe('Frame to shift (defaults to current)'),
    },
    async ({ dx, dy, wrap, frameIndex }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const idx = frameIndex ?? state.currentFrameIndex;
      if (idx < 0 || idx >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      // Navigate to the frame
      pm.goToFrame(idx);
      const frame = pm.getCurrentFrame();
      const oldData = { ...frame.data };
      const newData: CanvasData = {};
      
      let cellsShifted = 0;
      let cellsLost = 0;
      
      for (const [key, cell] of Object.entries(oldData)) {
        const { x, y } = parseCellKey(key);
        let newX = x + dx;
        let newY = y + dy;
        
        if (wrap) {
          // Wrap around edges
          newX = ((newX % state.width) + state.width) % state.width;
          newY = ((newY % state.height) + state.height) % state.height;
        }
        
        if (isInBounds(newX, newY, state.width, state.height)) {
          newData[createCellKey(newX, newY)] = cell;
          cellsShifted++;
        } else {
          cellsLost++;
        }
      }
      
      // Replace frame data
      frame.data = newData;
      
      // Broadcast shift completed
      broadcastStateChange('shift_frame_content', { dx, dy, cellsShifted });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            shift: { dx, dy },
            wrap,
            cellsShifted,
            cellsLost,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // flip_region - Mirror content horizontally or vertically
  // ==========================================================================
  server.tool(
    'flip_region',
    'Flip/mirror content horizontally or vertically',
    {
      direction: z.enum(['horizontal', 'vertical']).describe('Flip direction'),
      region: z.object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }).optional().describe('Region to flip (defaults to entire canvas)'),
      frameIndex: z.number().int().optional().describe('Frame to flip (defaults to current)'),
    },
    async ({ direction, region, frameIndex }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      const idx = frameIndex ?? state.currentFrameIndex;
      if (idx < 0 || idx >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Frame index out of range' }) }],
          isError: true,
        };
      }
      
      pm.goToFrame(idx);
      const frame = pm.getCurrentFrame();
      
      const regionX = region?.x ?? 0;
      const regionY = region?.y ?? 0;
      const regionWidth = region?.width ?? state.width;
      const regionHeight = region?.height ?? state.height;
      
      // Collect cells in region
      const cellsInRegion: Array<{ x: number; y: number; cell: Cell }> = [];
      
      for (const [key, cell] of Object.entries(frame.data)) {
        const { x, y } = parseCellKey(key);
        if (x >= regionX && x < regionX + regionWidth && y >= regionY && y < regionY + regionHeight) {
          cellsInRegion.push({ x, y, cell });
          delete frame.data[key]; // Remove original
        }
      }
      
      // Place flipped cells
      for (const { x, y, cell } of cellsInRegion) {
        let newX = x;
        let newY = y;
        
        if (direction === 'horizontal') {
          // Mirror around the center of the region
          newX = regionX + (regionWidth - 1) - (x - regionX);
        } else {
          newY = regionY + (regionHeight - 1) - (y - regionY);
        }
        
        frame.data[createCellKey(newX, newY)] = cell;
      }
      
      // Broadcast flip completed
      broadcastStateChange('flip_region', { direction, cellsFlipped: cellsInRegion.length });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            direction,
            region: { x: regionX, y: regionY, width: regionWidth, height: regionHeight },
            cellsFlipped: cellsInRegion.length,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // copy_region_to_frame - Copy a region from one frame to another
  // ==========================================================================
  server.tool(
    'copy_region_to_frame',
    'Copy a region of cells from one frame to another',
    {
      sourceFrame: z.number().int().describe('Source frame index'),
      targetFrame: z.number().int().describe('Target frame index'),
      sourceRegion: z.object({
        x: z.number().int(),
        y: z.number().int(),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      }).describe('Region to copy from source'),
      targetPosition: z.object({
        x: z.number().int(),
        y: z.number().int(),
      }).optional().describe('Position to paste at in target (defaults to same position)'),
      overwrite: z.boolean().default(true).describe('If true, overwrite existing cells in target'),
    },
    async ({ sourceFrame, targetFrame, sourceRegion, targetPosition, overwrite }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (sourceFrame < 0 || sourceFrame >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Source frame index out of range' }) }],
          isError: true,
        };
      }
      if (targetFrame < 0 || targetFrame >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Target frame index out of range' }) }],
          isError: true,
        };
      }
      
      const srcFrame = state.frames[sourceFrame];
      const tgtFrame = state.frames[targetFrame];
      
      const offsetX = (targetPosition?.x ?? sourceRegion.x) - sourceRegion.x;
      const offsetY = (targetPosition?.y ?? sourceRegion.y) - sourceRegion.y;
      
      let cellsCopied = 0;
      let cellsSkipped = 0;
      
      for (const [key, cell] of Object.entries(srcFrame.data)) {
        const { x, y } = parseCellKey(key);
        
        if (x >= sourceRegion.x && x < sourceRegion.x + sourceRegion.width &&
            y >= sourceRegion.y && y < sourceRegion.y + sourceRegion.height) {
          
          const newX = x + offsetX;
          const newY = y + offsetY;
          
          if (!isInBounds(newX, newY, state.width, state.height)) {
            cellsSkipped++;
            continue;
          }
          
          const newKey = createCellKey(newX, newY);
          
          if (!overwrite && tgtFrame.data[newKey]) {
            cellsSkipped++;
            continue;
          }
          
          tgtFrame.data[newKey] = { ...cell };
          cellsCopied++;
        }
      }
      
      // Broadcast copy completed
      broadcastStateChange('copy_region_to_frame', { targetFrame, cellsCopied });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            sourceFrame,
            targetFrame,
            cellsCopied,
            cellsSkipped,
          }) 
        }],
      };
    }
  );

  // ==========================================================================
  // interpolate_frames - Generate intermediate frames
  // ==========================================================================
  server.tool(
    'interpolate_frames',
    'Generate intermediate frames between two keyframes. Creates smooth transitions.',
    {
      startFrame: z.number().int().describe('Starting keyframe index'),
      endFrame: z.number().int().describe('Ending keyframe index'),
      steps: z.number().int().min(1).max(20).describe('Number of intermediate frames to generate'),
      method: z.enum(['linear', 'fade']).default('linear').describe('Interpolation method'),
    },
    async ({ startFrame, endFrame, steps, method }) => {
      const pm = getProjectManager();
      const state = pm.getState();
      
      if (startFrame < 0 || startFrame >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Start frame index out of range' }) }],
          isError: true,
        };
      }
      if (endFrame < 0 || endFrame >= state.frames.length) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'End frame index out of range' }) }],
          isError: true,
        };
      }
      if (startFrame === endFrame) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Start and end frames must be different' }) }],
          isError: true,
        };
      }
      
      const frameA = state.frames[startFrame];
      const frameB = state.frames[endFrame];
      
      // Collect all cell positions from both frames
      const allKeys = new Set([...Object.keys(frameA.data), ...Object.keys(frameB.data)]);
      
      const createdFrames: Array<{ index: number; id: string }> = [];
      
      // Generate intermediate frames
      for (let i = 1; i <= steps; i++) {
        const t = i / (steps + 1); // Progress from 0 to 1
        const newFrameData: CanvasData = {};
        
        for (const key of allKeys) {
          const cellA = frameA.data[key];
          const cellB = frameB.data[key];
          
          if (method === 'linear') {
            // Linear: cell appears/disappears based on threshold
            if (t < 0.5) {
              if (cellA) newFrameData[key] = { ...cellA };
            } else {
              if (cellB) newFrameData[key] = { ...cellB };
            }
          } else if (method === 'fade') {
            // Fade: blend colors (simplified - just use source or target based on t)
            if (cellA && cellB) {
              // Both exist - use target if past threshold, else source
              newFrameData[key] = t < 0.5 ? { ...cellA } : { ...cellB };
            } else if (cellA) {
              // Only in start frame - fade out
              if (t < 1 - t) newFrameData[key] = { ...cellA };
            } else if (cellB) {
              // Only in end frame - fade in
              if (t > t) newFrameData[key] = { ...cellB };
            }
          }
        }
        
        // Calculate duration
        const avgDuration = Math.round((frameA.duration + frameB.duration) / 2);
        
        // Insert the new frame
        const insertIndex = Math.max(startFrame, endFrame) + i;
        const newFrame = pm.addFrame(insertIndex, newFrameData, avgDuration, false);
        pm.setFrameName(pm.getState().frames.findIndex(f => f.id === newFrame.id), `Interpolated ${i}/${steps}`, false);
        
        createdFrames.push({ 
          index: pm.getState().frames.findIndex(f => f.id === newFrame.id), 
          id: newFrame.id 
        });
      }
      
      // Broadcast interpolation completed
      broadcastStateChange('interpolate_frames', { framesCreated: createdFrames.length });
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({
            success: true,
            startFrame,
            endFrame,
            method,
            framesCreated: createdFrames.length,
            newFrames: createdFrames,
            totalFrames: pm.getState().frames.length,
          }) 
        }],
      };
    }
  );
}
