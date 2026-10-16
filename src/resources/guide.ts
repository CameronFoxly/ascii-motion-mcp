/**
 * LLM Best Practices Guide Resources
 *
 * Provides learned patterns and best practices for LLMs using ASCII Motion MCP tools.
 * LLMs can read these resources before starting complex animation tasks.
 */

import { McpServer } from '../mcp.js';

const LLM_BEST_PRACTICES_GUIDE = `# ASCII Motion MCP - LLM Best Practices

## Critical Rule: Always Inspect Before Animating

Before placing ANY animated elements (circles, indicators, data flow particles), you MUST:
1. Use get_canvas_ascii to see the full layout
2. Use get_canvas_render to review the colored terminal composition
3. Use get_canvas_preview with a region to get exact coordinates
4. Place elements EXACTLY on connection line characters, not near them

### Why This Matters
ASCII diagrams use box-drawing characters at specific x,y coordinates.
Animated elements like data flow particles must be placed EXACTLY on these coordinates.

### Coordinate Discovery Workflow
1. Call get_canvas_ascii(frameIndex=0) for overview
2. Call get_canvas_preview(region={x,y,width,height}, maxCells=200) for exact cell data
3. Find cells with connection characters
4. Use those exact x,y values for animation elements

## Time, Targets and Batches

Use get_capabilities and get_document_summary before editing a connected app.
Canonical operations use stable IDs and absolute zero-based timeline frames.
Content-frame ordinals are not timeline positions: a held content frame may
cover many timeline frames, and a generator layer may have no content frames.

copy_frame_and_modify supports insertAtIndex; choose insertion positions
explicitly instead of relying on repeated insertion to reverse the sequence.
Prefer native content-frame operations and apply_operations for new workflows.
An atomic batch produces one undo entry and rolls back every step on failure.

Keep read scopes small. Follow artifact page cursors for large results rather
than requesting full documents repeatedly. Do not automatically retry a timed-out
mutation: reconnect and inspect the actual document first.

## Braille Spinner Sequence

Use this sequence for smooth rotation (Unicode code points):
U+280B, U+2819, U+2839, U+2838, U+283C, U+2834, U+2826, U+2827, U+2807, U+280F

## Color Conventions

Use consistent colors to convey meaning:
- Cyan #00FFFF = Data in transit
- Green #00FF00 = Active / OK
- Yellow #FFFF00 = Processing
- Orange #FF6600 = Receiving data
- Magenta #FF00FF = Key junction
- Gray #444444 = Inactive/Standby

## Common Mistakes to Avoid

1. Guessing coordinates - ALWAYS inspect with get_canvas_preview first
2. Elements off connection lines - They look disconnected and wrong
3. Confusing content-frame ordinals with absolute timeline frames
4. Wrong braille sequence - Spinner looks jerky
5. Placing indicators in empty space - Put inside/adjacent to boxes
6. Not checking cell contents - May overwrite important characters

## Recommended Workflow

1. new_project(name, width, height)
2. paste_ascii_block(text, x, y, color)
3. get_canvas_ascii() - review layout
4. get_canvas_render(maxWidth=80) - review terminal colors and composition
5. get_canvas_preview(region) - get exact coordinates
6. set_cell() for base indicators using EXACT coords
7. copy_frame_and_modify(insertAtIndex=...) or native content-frame operations
8. describe_animation() to verify
`;

const TOOL_CATEGORIES_GUIDE = `# ASCII Motion MCP Tool Categories

Use tools/list for exact current schemas and get_capabilities for the connected
app. Canonical operations that collide with compatibility names use app_ prefixes.
Use get_catalog for dynamic drawing, fonts, generators, effects, shaders, palettes
and export options. Full native operations include drawing/gradients/FIGlet,
content-frame timing, group transforms, effect/shader keys, media, palettes and
authenticated cloud projects. Headless mode does not recreate app rendering.

## Canvas Editing
- set_cell - Set character and colors at position
- get_cell - Read cell at position
- clear_cell - Clear a cell
- get_canvas_ascii - Get ASCII text preview
- get_canvas_render - Get raw ANSI-colored terminal preview
- get_canvas_preview - Get cell data for region with exact coordinates
- paste_ascii_block - Paste multi-line ASCII art
- fill_region - Fill area with character
- clear_canvas - Clear all cells

## Layers (v2 — layer-based timeline)
- get_layers - List all layers with metadata
- add_layer - Add a new layer (switches to layer mode)
- remove_layer - Remove a layer
- duplicate_layer - Duplicate a layer with content
- set_active_layer - Set which layer receives drawing
- rename_layer - Rename a layer
- reorder_layers - Change layer z-order
- set_layer_visibility - Toggle visible/solo/lock/opacity
- get_layer_properties - Get transform values and keyframe status

## Content Frames (v2)
- add_content_frame - Add canvas data segment to a layer
- remove_content_frame - Remove a content frame

## Keyframes (v2)
- add_keyframe - Keyframe a layer property (position, scale, rotation, anchor)
- remove_keyframe - Remove a keyframe

## Layer Groups (v2)
- create_group - Group layers together
- ungroup_layers - Dissolve a group

## Timeline (v2)
- set_frame_rate - Set animation FPS within the connected app's supported range
- set_timeline_duration - Set total timeline length

## Animation and Frames (legacy)
- add_frame - Add new frame
- copy_frame_and_modify - Duplicate and modify in one call
- delete_frame - Remove a frame
- list_frames - List all frames with metadata
- set_frame_duration - Set timing
- set_frame_name - Name a frame
- duplicate_frame - Copy a frame
- go_to_frame - Navigate to frame
- describe_animation - Get animation summary

## Project Management
- new_project - Create new project
- save_project - Save to file
- load_project - Load from file
- get_project_info - Get current project info
- set_project_name - Rename project

## Effects and Colors
- batch_recolor - Replace one color with another
- batch_replace_char - Replace one character with another
- get_color_stats - Get color usage statistics
- apply_effect - Apply visual effects (destructive, modifies cells directly)

## Procedural Effects (v2.1 — non-destructive, keyframeable)
- get_effect_blocks - List all procedural effect blocks across layers/groups/global
- add_effect_block - Add a non-destructive effect (levels, hue-saturation, remap-colors, remap-characters, scatter, wave-warp, wiggle, motion-trails)
- update_effect_block - Update effect settings, timing, or enabled state
- remove_effect_block - Remove a procedural effect
- add_effect_keyframe - Keyframe an effect property for animation
- remove_effect_keyframe - Remove an effect keyframe

## Procedural Generator Layers (v2.2 — live, keyframeable)
- list_generator_types - Generator catalog; pass generatorType for every property path, range, options and when it applies
- get_generator_layers - List generator layers, or inspect one (settings, keyframes, resolved values at a frame)
- add_generator_layer - Add radio-waves, turbulent-noise, particle-physics, rain-drops, digital-rain or animated-text
- add_animated_text - Add text with typewriter / blink / wave effects in one call
- update_generator_layer - Static settings, span (startFrame/durationFrames), enabled, name
- set_generator_property - Edit at the playhead (keys the value if the property is animated)
- set_generator_keyframes / remove_generator_keyframes - Keyframe any generator property with easing and looping
- reset_generator, randomize_generator_seed
- render_generator_frames - See generator output as ASCII at chosen frames (live browser only)
- bake_generator_layer - Convert to editable cells (live browser only)

## Selection Tools
- select_rectangle - Select rectangular area
- select_by_color - Magic wand selection
- get_selection - Get current selection
- clear_selection - Deselect all

## Canvas Management
- resize_canvas - Change canvas dimensions
- get_canvas_summary - Get canvas overview

## Browser Connection
- get_connection_status - Check browser connection status
- get_auth_token - Get the auth token needed for the browser connection

## Layer vs Frame Workflow

**Layer mode (v2):** Use add_layer, add_content_frame, add_keyframe for professional
multi-layer animations with transform keyframes (position, scale, rotation).

**Frame mode (legacy):** Use add_frame, copy_frame_and_modify for simple frame-by-frame
animations. Still fully supported.

Projects start in frame mode. Calling add_layer switches to layer mode.

## Procedural Effects Workflow

Procedural effects are non-destructive and live on the timeline as effect tracks.
They are evaluated in real-time during playback and compositing.

### Effect Types
- **levels** - Brightness/contrast via shadows, midtones, highlights, output range
- **hue-saturation** - Hue shift, saturation, lightness adjustments
- **remap-colors** - Map specific colors to new colors
- **remap-characters** - Map specific characters to new characters
- **scatter** - Random cell displacement (strength 0-400)
- **wave-warp** - Sine wave distortion (amplitude, frequency, speed, phase)
- **wiggle** - Global displacement via wave or noise (horizontal-wave, vertical-wave, noise)

### Adding Effects
1. Use add_effect_block with an ownerId (layer ID, group ID, or null for global)
2. Set effect type, start frame, duration, and initial settings
3. Optionally add keyframes with add_effect_keyframe for animated properties

### Key Concepts
- Effects on layers apply in local space before transforms
- Effects on groups apply to all child layers
- Global effects (ownerId=null) apply after full compositing
- wave-warp and wiggle are time-dependent — they animate automatically
- Use get_effect_blocks to inspect current effects before modifying

## Procedural Generator Workflow

Generator layers are a special layer kind: a generator source (type, static settings,
keyframed property tracks, visible span) renders every frame on demand. They have no
content frames — cell-editing tools refuse them; layer transforms, opacity and effects still apply.

1. list_generator_types → pick a type, then list_generator_types { generatorType } for property paths
2. add_generator_layer (or add_animated_text) — canvas-aware defaults, span = whole timeline
3. Animate with set_generator_keyframes (absolute frames, easing presets, loop)
4. Check with get_generator_layers { layerId, frame } and, when live, render_generator_frames

### Key Concepts
- Settings are keyed by property path (e.g. "wave.amplitude", "mapping.characterPaletteId")
- Properties marked "stepped" hold until the next keyframe; "smooth" ones interpolate
- Rate properties (propagationSpeed, evolutionSpeed, wave.speed) integrate over time — keyframing them ramps speed
- A static value is ignored once a property has keyframes; set_generator_property at a frame edits/keys it
- Animated Text: typewriter.start/end are percent by default; switching typewriter.units converts values
- Simulation generators (particles, rain, digital rain) are deterministic per seed
- Headless mode edits and saves generators (session v2.2.0) but cannot render them; open in Ascii-Motion or use live mode
- run_generator is the legacy tool that bakes static frames; prefer generator layers for editable results
`;

export function registerGuideResources(server: McpServer): void {
  server.resource(
    'guide-llm-best-practices',
    'guide://llm-best-practices',
    {
      description: 'Best practices for LLMs using ASCII Motion MCP. Read before complex animation tasks.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{
        uri: 'guide://llm-best-practices',
        mimeType: 'text/markdown',
        text: LLM_BEST_PRACTICES_GUIDE,
      }],
    })
  );

  server.resource(
    'guide-tool-categories',
    'guide://tool-categories',
    {
      description: 'Quick reference of all available tool categories.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{
        uri: 'guide://tool-categories',
        mimeType: 'text/markdown',
        text: TOOL_CATEGORIES_GUIDE,
      }],
    })
  );
}
