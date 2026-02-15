/**
 * Layer Management Tools
 * 
 * MCP tools for managing layers, content frames, keyframes, and groups
 * in the v2 layer-based timeline system.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getProjectManager, broadcastStateChange } from '../state.js';
import {
  EasingCurveSchema,
  PropertyPathSchema,
  CanvasDataSchema,
} from '../types.js';

export function registerLayerTools(server: McpServer): void {

  // ==========================================================================
  // get_layers - List all layers
  // ==========================================================================
  server.tool(
    'get_layers',
    'Get all layers in the project with their metadata, content frame count, and property track info.',
    {},
    async () => {
      const pm = getProjectManager();
      const state = pm.getState();

      if (!pm.isLayerMode()) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            isLayerMode: false,
            message: 'Project is in legacy frame mode. Use add_layer to switch to layer mode.',
            frameCount: state.frames.length,
          }) }],
        };
      }

      const layers = state.layers.map(l => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        solo: l.solo,
        locked: l.locked,
        opacity: l.opacity,
        isActive: l.id === state.activeLayerId,
        contentFrameCount: l.contentFrames.length,
        propertyTrackCount: l.propertyTracks.length,
        parentGroupId: l.parentGroupId,
        totalCells: l.contentFrames.reduce((sum, cf) => sum + Object.keys(cf.data).length, 0),
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          isLayerMode: true,
          layerCount: layers.length,
          activeLayerId: state.activeLayerId,
          timeline: state.timelineConfig,
          currentFrame: state.currentFrameIndex,
          layers,
          groups: state.layerGroups.map(g => ({
            id: g.id, name: g.name, childLayerIds: g.childLayerIds,
          })),
        }) }],
      };
    }
  );

  // ==========================================================================
  // add_layer - Add a new layer
  // ==========================================================================
  server.tool(
    'add_layer',
    'Add a new layer to the project. If project is in legacy frame mode, this switches it to layer mode.',
    {
      name: z.string().optional().describe('Layer name (auto-generated if omitted)'),
    },
    async ({ name }) => {
      const pm = getProjectManager();
      const layer = pm.addLayer(name);

      broadcastStateChange('add_layer', {
        layer: { id: layer.id, name: layer.name },
        totalLayers: pm.getState().layers.length,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          layer: { id: layer.id, name: layer.name },
          totalLayers: pm.getState().layers.length,
        }) }],
      };
    }
  );

  // ==========================================================================
  // remove_layer - Remove a layer
  // ==========================================================================
  server.tool(
    'remove_layer',
    'Remove a layer by ID. Cannot remove the last remaining layer.',
    {
      layerId: z.string().describe('ID of the layer to remove'),
    },
    async ({ layerId }) => {
      const pm = getProjectManager();
      const success = pm.removeLayer(layerId);

      if (!success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Failed to remove layer. It may not exist or may be the last layer.',
          }) }],
          isError: true,
        };
      }

      broadcastStateChange('remove_layer', { layerId });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          removedLayerId: layerId,
          remainingLayers: pm.getState().layers.length,
        }) }],
      };
    }
  );

  // ==========================================================================
  // duplicate_layer - Duplicate a layer
  // ==========================================================================
  server.tool(
    'duplicate_layer',
    'Duplicate a layer with all its content frames and property tracks.',
    {
      layerId: z.string().describe('ID of the layer to duplicate'),
    },
    async ({ layerId }) => {
      const pm = getProjectManager();
      const newLayer = pm.duplicateLayer(layerId);

      if (!newLayer) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Layer not found' }) }],
          isError: true,
        };
      }

      broadcastStateChange('duplicate_layer', {
        sourceLayerId: layerId,
        newLayer: { id: newLayer.id, name: newLayer.name },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          newLayer: { id: newLayer.id, name: newLayer.name },
          totalLayers: pm.getState().layers.length,
        }) }],
      };
    }
  );

  // ==========================================================================
  // set_active_layer - Set the active layer
  // ==========================================================================
  server.tool(
    'set_active_layer',
    'Set which layer is active for drawing and editing operations.',
    {
      layerId: z.string().describe('ID of the layer to make active'),
    },
    async ({ layerId }) => {
      const pm = getProjectManager();
      const success = pm.setActiveLayer(layerId);

      if (!success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Layer not found' }) }],
          isError: true,
        };
      }

      broadcastStateChange('set_active_layer', { layerId });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          activeLayerId: layerId,
        }) }],
      };
    }
  );

  // ==========================================================================
  // rename_layer - Rename a layer
  // ==========================================================================
  server.tool(
    'rename_layer',
    'Rename a layer.',
    {
      layerId: z.string().describe('ID of the layer to rename'),
      name: z.string().min(1).max(100).describe('New layer name'),
    },
    async ({ layerId, name }) => {
      const pm = getProjectManager();
      const success = pm.renameLayer(layerId, name);

      if (!success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Layer not found' }) }],
          isError: true,
        };
      }

      broadcastStateChange('rename_layer', { layerId, name });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, layerId, name }) }],
      };
    }
  );

  // ==========================================================================
  // reorder_layers - Move a layer to a new position
  // ==========================================================================
  server.tool(
    'reorder_layers',
    'Move a layer from one z-order position to another. Index 0 = bottom layer.',
    {
      fromIndex: z.number().int().min(0).describe('Current index of the layer'),
      toIndex: z.number().int().min(0).describe('Target index to move to'),
    },
    async ({ fromIndex, toIndex }) => {
      const pm = getProjectManager();
      const success = pm.reorderLayers(fromIndex, toIndex);

      if (!success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid layer indices' }) }],
          isError: true,
        };
      }

      broadcastStateChange('reorder_layers', { fromIndex, toIndex });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, fromIndex, toIndex }) }],
      };
    }
  );

  // ==========================================================================
  // set_layer_visibility - Toggle layer visibility/solo/lock
  // ==========================================================================
  server.tool(
    'set_layer_visibility',
    'Set visibility, solo, lock, or opacity on a layer.',
    {
      layerId: z.string().describe('Layer ID'),
      visible: z.boolean().optional().describe('Set visibility'),
      solo: z.boolean().optional().describe('Set solo mode'),
      locked: z.boolean().optional().describe('Set locked state'),
      opacity: z.number().min(0).max(100).optional().describe('Set opacity (0-100)'),
    },
    async ({ layerId, visible, solo, locked, opacity }) => {
      const pm = getProjectManager();
      let changed = false;

      if (visible !== undefined) changed = pm.setLayerVisibility(layerId, visible) || changed;
      if (solo !== undefined) changed = pm.setLayerSolo(layerId, solo) || changed;
      if (locked !== undefined) changed = pm.setLayerLocked(layerId, locked) || changed;
      if (opacity !== undefined) changed = pm.setLayerOpacity(layerId, opacity) || changed;

      if (!changed) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Layer not found or no changes applied' }) }],
          isError: true,
        };
      }

      broadcastStateChange('set_layer_visibility', { layerId, visible, solo, locked, opacity });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, layerId }) }],
      };
    }
  );

  // ==========================================================================
  // add_content_frame - Add a content frame to a layer
  // ==========================================================================
  server.tool(
    'add_content_frame',
    'Add a new content frame (canvas data segment) to a layer at a specific timeline position.',
    {
      layerId: z.string().describe('Layer ID'),
      startFrame: z.number().int().min(0).describe('Starting frame number'),
      durationFrames: z.number().int().min(1).describe('Duration in frames'),
      data: CanvasDataSchema.optional().describe('Initial cell data for the content frame'),
    },
    async ({ layerId, startFrame, durationFrames, data }) => {
      const pm = getProjectManager();
      const cf = pm.addContentFrame(layerId, startFrame, durationFrames, data);

      if (!cf) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Failed to add content frame. Layer not found or timing overlaps with existing frame.',
          }) }],
          isError: true,
        };
      }

      broadcastStateChange('add_content_frame', { layerId, contentFrame: cf });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          contentFrame: { id: cf.id, name: cf.name, startFrame: cf.startFrame, durationFrames: cf.durationFrames },
        }) }],
      };
    }
  );

  // ==========================================================================
  // remove_content_frame - Remove a content frame
  // ==========================================================================
  server.tool(
    'remove_content_frame',
    'Remove a content frame from a layer.',
    {
      layerId: z.string().describe('Layer ID'),
      contentFrameId: z.string().describe('Content frame ID to remove'),
    },
    async ({ layerId, contentFrameId }) => {
      const pm = getProjectManager();
      const success = pm.removeContentFrame(layerId, contentFrameId);

      if (!success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Content frame or layer not found' }) }],
          isError: true,
        };
      }

      broadcastStateChange('remove_content_frame', { layerId, contentFrameId });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, layerId, contentFrameId }) }],
      };
    }
  );

  // ==========================================================================
  // add_keyframe - Add a keyframe to a layer property
  // ==========================================================================
  server.tool(
    'add_keyframe',
    'Add a keyframe to a layer property track. Creates the property track if it doesn\'t exist.',
    {
      layerId: z.string().describe('Layer ID'),
      propertyPath: PropertyPathSchema.describe('Property to keyframe (e.g., transform.position.x)'),
      frame: z.number().int().min(0).describe('Frame number'),
      value: z.number().describe('Keyframe value'),
      easing: EasingCurveSchema.optional().describe('Easing curve (defaults to linear)'),
    },
    async ({ layerId, propertyPath, frame, value, easing }) => {
      const pm = getProjectManager();
      const kf = pm.addKeyframe(layerId, propertyPath, frame, value, easing);

      if (!kf) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Layer not found' }) }],
          isError: true,
        };
      }

      broadcastStateChange('add_keyframe', { layerId, propertyPath, keyframe: kf });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          keyframe: { id: kf.id, frame: kf.frame, value: kf.value, easing: kf.easing },
        }) }],
      };
    }
  );

  // ==========================================================================
  // remove_keyframe - Remove a keyframe
  // ==========================================================================
  server.tool(
    'remove_keyframe',
    'Remove a keyframe from a property track.',
    {
      layerId: z.string().describe('Layer ID'),
      trackId: z.string().describe('Property track ID'),
      keyframeId: z.string().describe('Keyframe ID to remove'),
    },
    async ({ layerId, trackId, keyframeId }) => {
      const pm = getProjectManager();
      const success = pm.removeKeyframe(layerId, trackId, keyframeId);

      if (!success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Keyframe, track, or layer not found' }) }],
          isError: true,
        };
      }

      broadcastStateChange('remove_keyframe', { layerId, trackId, keyframeId });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      };
    }
  );

  // ==========================================================================
  // get_layer_properties - Get all transform property values for a layer
  // ==========================================================================
  server.tool(
    'get_layer_properties',
    'Get all transform property values for a layer at the current frame, including keyframe status.',
    {
      layerId: z.string().describe('Layer ID'),
    },
    async ({ layerId }) => {
      const pm = getProjectManager();
      const properties = pm.getLayerProperties(layerId);

      if (Object.keys(properties).length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Layer not found' }) }],
          isError: true,
        };
      }

      const layer = pm.getLayer(layerId);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          layerId,
          layerName: layer?.name,
          currentFrame: pm.getState().currentFrameIndex,
          properties,
          propertyTracks: layer?.propertyTracks.map(pt => ({
            id: pt.id,
            propertyPath: pt.propertyPath,
            keyframeCount: pt.keyframes.length,
            loopKeyframes: pt.loopKeyframes,
          })),
        }) }],
      };
    }
  );

  // ==========================================================================
  // create_group - Create a layer group
  // ==========================================================================
  server.tool(
    'create_group',
    'Create a layer group to organize layers together.',
    {
      name: z.string().optional().describe('Group name'),
      layerIds: z.array(z.string()).optional().describe('Layer IDs to include in the group'),
    },
    async ({ name, layerIds }) => {
      const pm = getProjectManager();
      const group = pm.createGroup(name, layerIds);

      broadcastStateChange('create_group', { group });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          group: { id: group.id, name: group.name, childLayerIds: group.childLayerIds },
        }) }],
      };
    }
  );

  // ==========================================================================
  // ungroup_layers - Dissolve a group
  // ==========================================================================
  server.tool(
    'ungroup_layers',
    'Dissolve a layer group, keeping the layers.',
    {
      groupId: z.string().describe('Group ID to dissolve'),
    },
    async ({ groupId }) => {
      const pm = getProjectManager();
      const success = pm.ungroupLayers(groupId);

      if (!success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Group not found' }) }],
          isError: true,
        };
      }

      broadcastStateChange('ungroup_layers', { groupId });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, groupId }) }],
      };
    }
  );

  // ==========================================================================
  // set_frame_rate - Set timeline frame rate
  // ==========================================================================
  server.tool(
    'set_frame_rate',
    'Set the timeline frame rate (FPS). Preserves frame count — only changes playback speed.',
    {
      fps: z.number().min(1).max(120).describe('Frames per second'),
    },
    async ({ fps }) => {
      const pm = getProjectManager();
      pm.setFrameRate(fps);

      broadcastStateChange('set_frame_rate', { fps });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          frameRate: fps,
          durationFrames: pm.getState().timelineConfig.durationFrames,
        }) }],
      };
    }
  );

  // ==========================================================================
  // set_timeline_duration - Set total timeline length
  // ==========================================================================
  server.tool(
    'set_timeline_duration',
    'Set the total timeline duration in frames.',
    {
      durationFrames: z.number().int().min(1).describe('Total frames in timeline'),
    },
    async ({ durationFrames }) => {
      const pm = getProjectManager();
      pm.setTimelineDuration(durationFrames);

      broadcastStateChange('set_timeline_duration', { durationFrames });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          durationFrames,
          frameRate: pm.getState().timelineConfig.frameRate,
        }) }],
      };
    }
  );
}
