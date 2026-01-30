/**
 * LLM Best Practices Guide Resources
 * 
 * Provides learned patterns and best practices for LLMs using ASCII Motion MCP tools.
 * LLMs can read these resources before starting complex animation tasks.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const LLM_BEST_PRACTICES_GUIDE = `# ASCII Motion MCP - LLM Best Practices

## Critical Rule: Always Inspect Before Animating

Before placing ANY animated elements (circles, indicators, data flow particles), you MUST:
1. Use get_canvas_ascii to see the full layout
2. Use get_canvas_preview with a region to get exact coordinates
3. Place elements EXACTLY on connection line characters, not near them

### Why This Matters
ASCII diagrams use box-drawing characters at specific x,y coordinates. 
Animated elements like data flow particles must be placed EXACTLY on these coordinates.

### Coordinate Discovery Workflow
1. Call get_canvas_ascii(frameIndex=0) for overview
2. Call get_canvas_preview(region={x,y,width,height}, maxCells=200) for exact cell data
3. Find cells with connection characters
4. Use those exact x,y values for animation elements

## Frame Insertion Order (CRITICAL)

copy_frame_and_modify inserts at index 1, so frames end up in REVERSE order!

If you create frames for steps 1 through 5:
- Index 0: Base
- Index 1: Step 5 (last created)
- Index 2: Step 4
- Index 3: Step 3
- Index 4: Step 2  
- Index 5: Step 1 (first created)

Solutions:
- Create frames in reverse order (step 5 first, step 1 last)
- Or accept reverse order - animation loops anyway

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
3. Forgetting frame order reversal - Animation plays backwards
4. Wrong braille sequence - Spinner looks jerky
5. Placing indicators in empty space - Put inside/adjacent to boxes
6. Not checking cell contents - May overwrite important characters

## Recommended Workflow

1. new_project(name, width, height)
2. paste_ascii_block(text, x, y, color)
3. get_canvas_ascii() - review layout
4. get_canvas_preview(region) - get exact coordinates
5. set_cell() for base indicators using EXACT coords
6. copy_frame_and_modify() for each animation step (reverse order!)
7. describe_animation() to verify
`;

const TOOL_CATEGORIES_GUIDE = `# ASCII Motion MCP Tool Categories

## Canvas Editing
- set_cell - Set character and colors at position
- get_cell - Read cell at position
- clear_cell - Clear a cell
- get_canvas_ascii - Get ASCII text preview
- get_canvas_preview - Get cell data for region with exact coordinates
- paste_ascii_block - Paste multi-line ASCII art
- fill_region - Fill area with character
- clear_canvas - Clear all cells

## Animation and Frames
- add_frame - Add new frame
- copy_frame_and_modify - Duplicate and modify in one call (inserts at index 1!)
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
- apply_effect - Apply visual effects

## Selection Tools
- select_rectangle - Select rectangular area
- select_by_color - Magic wand selection
- get_selection - Get current selection
- clear_selection - Deselect all

## Canvas Management
- resize_canvas - Change canvas dimensions
- get_canvas_summary - Get canvas overview
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
