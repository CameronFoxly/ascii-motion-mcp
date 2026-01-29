#!/usr/bin/env node
/**
 * ASCII Motion MCP Server
 * 
 * A Model Context Protocol server for creating and animating ASCII art.
 * 
 * Usage:
 *   npx ascii-motion-mcp                    # Start in stdio mode
 *   npx ascii-motion-mcp --project-dir ./   # Specify project directory
 *   npx ascii-motion-mcp --help             # Show help
 * 
 * For MCP Inspector testing:
 *   npx @modelcontextprotocol/inspector ./dist/index.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getProjectManager } from './state.js';
import {
  registerCanvasTools,
  registerFrameTools,
  registerProjectTools,
  registerPreviewTools,
  registerHistoryTools,
  registerAnimationTools,
  registerSelectionTools,
} from './tools/index.js';

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface CLIOptions {
  projectDir: string;
  help: boolean;
  version: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    projectDir: process.cwd(),
    help: false,
    version: false,
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--project-dir' || arg === '-d') {
      const nextArg = args[++i];
      if (nextArg) {
        options.projectDir = nextArg;
      }
    }
  }
  
  return options;
}

function showHelp(): void {
  console.log(`
ASCII Motion MCP Server

A Model Context Protocol server for creating and animating ASCII art.

USAGE:
  ascii-motion-mcp [options]

OPTIONS:
  -h, --help              Show this help message
  -v, --version           Show version number
  -d, --project-dir PATH  Set the project directory for file operations
                          (default: current working directory)

ENVIRONMENT VARIABLES:
  ASCII_MOTION_PROJECT_DIR  Alternative way to set project directory

EXAMPLES:
  # Start server in current directory
  ascii-motion-mcp

  # Start server with specific project directory
  ascii-motion-mcp --project-dir ./my-projects

  # Test with MCP Inspector
  npx @modelcontextprotocol/inspector ./dist/index.js

MCP CLIENT CONFIGURATION:

  For Claude Desktop (claude_desktop_config.json):
  {
    "mcpServers": {
      "ascii-motion": {
        "command": "npx",
        "args": ["ascii-motion-mcp", "--project-dir", "/path/to/projects"]
      }
    }
  }

  For VS Code Copilot (settings.json):
  {
    "mcp": {
      "servers": {
        "ascii-motion": {
          "command": "npx",
          "args": ["ascii-motion-mcp", "--project-dir", "/path/to/projects"]
        }
      }
    }
  }

AVAILABLE TOOLS:
  Canvas Operations:
    - get_cell, set_cell, clear_cell, set_cells_batch
    - paste_ascii_block, fill_region, resize_canvas, clear_canvas
  
  Frame Management:
    - list_frames, add_frame, delete_frame, duplicate_frame
    - go_to_frame, set_frame_duration, set_frame_name
  
  Project Management:
    - new_project, save_project, load_project
    - get_project_info, set_project_name, list_project_files
  
  Preview (Token-Efficient):
    - get_canvas_summary, get_canvas_preview, get_canvas_ascii
    - get_frame_diff, describe_animation
  
  Animation Workflows:
    - copy_frame_and_modify, shift_frame_content, flip_region
    - copy_region_to_frame, interpolate_frames
  
  Selection:
    - select_rectangle, select_by_color, get_selection
    - clear_selection, apply_to_selection, delete_selection_content
  
  History:
    - undo, redo, get_history_status

For detailed documentation, visit:
  https://github.com/CameronFoxly/ascii-motion-mcp
`);
}

function showVersion(): void {
  console.log('ascii-motion-mcp v0.1.0-alpha.1');
}

// =============================================================================
// Server Setup
// =============================================================================

async function main(): Promise<void> {
  const options = parseArgs();
  
  if (options.help) {
    showHelp();
    process.exit(0);
  }
  
  if (options.version) {
    showVersion();
    process.exit(0);
  }
  
  // Set project directory in environment for tools to use
  process.env.ASCII_MOTION_PROJECT_DIR = options.projectDir;
  
  // Create the MCP server
  const server = new McpServer({
    name: 'ascii-motion-mcp',
    version: '0.1.0-alpha.1',
  });
  
  // Register all tools
  registerCanvasTools(server);
  registerFrameTools(server);
  registerProjectTools(server);
  registerPreviewTools(server);
  registerHistoryTools(server);
  registerAnimationTools(server);
  registerSelectionTools(server);
  
  // Initialize project manager
  getProjectManager();
  
  // Log startup (to stderr so it doesn't interfere with MCP protocol)
  console.error(`[ascii-motion-mcp] Starting server...`);
  console.error(`[ascii-motion-mcp] Project directory: ${options.projectDir}`);
  
  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error(`[ascii-motion-mcp] Server connected and ready`);
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[ascii-motion-mcp] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ascii-motion-mcp] Unhandled rejection:', reason);
  process.exit(1);
});

// Run
main().catch((error) => {
  console.error('[ascii-motion-mcp] Fatal error:', error);
  process.exit(1);
});
