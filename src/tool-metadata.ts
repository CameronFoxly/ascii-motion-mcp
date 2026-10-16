import { operationNamed } from './contract.js';
import type { ToolRegistrationMetadata } from './mcp.js';

const reads = new Set([
  'compare_frames', 'describe_animation', 'get_active_colors', 'get_auth_token',
  'get_canvas_ascii', 'get_canvas_preview', 'get_canvas_render', 'get_canvas_summary',
  'get_cell', 'get_character_palette', 'get_color_palette', 'get_color_stats',
  'get_connection_status', 'get_effect_blocks', 'get_frame_diff', 'get_generator_layers',
  'get_history_status', 'get_layer_properties', 'get_layers', 'get_project_info',
  'get_selection', 'list_character_palettes', 'list_color_palettes', 'list_frames',
  'list_generator_types', 'list_project_files', 'preview_generator',
  'refresh_state_from_browser', 'render_generator_frames', 'suggest_palette_for_style', 'read_artifact',
]);
const views = new Set([
  'go_to_frame', 'select_by_color', 'select_rectangle', 'clear_selection',
  'set_active_layer', 'set_background_color', 'set_foreground_color', 'set_selected_character',
]);
const aliases: Record<string, string> = {
  add_animated_text: 'add_generator_layer', add_effect_block: 'add_effect',
  add_effect_keyframe: 'set_effect_keyframes', add_frame: 'add_content_frame',
  add_keyframe: 'set_keyframes', apply_effect: 'set_cells', apply_to_selection: 'replace_in_cells',
  batch_recolor: 'replace_in_cells', batch_replace_char: 'replace_in_cells',
  clear_canvas: 'clear_cells', clear_cell: 'clear_cells',
  copy_frame_and_modify: 'apply_operations', copy_region_to_frame: 'set_cells',
  delete_frame: 'remove_content_frame', delete_selection_content: 'clear_cells',
  duplicate_frame: 'duplicate_content_frame', flip_region: 'flip_content',
  import_ascii_text: 'import_text', import_image: 'import_media', import_video: 'import_media',
  interpolate_frames: 'apply_operations', paste_ascii_block: 'import_text',
  remove_effect_block: 'remove_effect', remove_effect_keyframe: 'remove_effect_keyframes',
  remove_keyframe: 'remove_keyframes', rename_layer: 'update_layer',
  reorder_layers: 'reorder_layer', run_generator: 'apply_operations',
  set_cell: 'set_cells', set_cells_batch: 'set_cells', set_frame_duration: 'update_content_frame',
  set_frame_name: 'update_content_frame', set_frame_rate: 'set_timeline',
  set_layer_visibility: 'update_layer', set_project_name: 'set_project_metadata',
  set_timeline_duration: 'set_timeline', shift_frame_content: 'shift_content', ungroup_layers: 'ungroup',
  update_effect_block: 'update_effect',
};

export function legacyToolMetadata(name: string): ToolRegistrationMetadata | undefined {
  if (reads.has(name)) return {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  if (views.has(name)) return {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  if (name.startsWith('export_') || name === 'save_project') return {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  };
  const operation = operationNamed(aliases[name] ?? name);
  return operation ? { annotations: {
    readOnlyHint: operation.kind === 'read',
    destructiveHint: operation.destructive,
    idempotentHint: operation.idempotent,
    openWorldHint: operation.requires.includes('auth'),
  } } : undefined;
}
