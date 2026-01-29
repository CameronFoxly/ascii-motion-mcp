#!/usr/bin/env node
/**
 * ASCII Motion MCP Server
 * 
 * A Model Context Protocol server for creating and animating ASCII art.
 * 
 * Usage:
 *   npx ascii-motion-mcp                    # Start in stdio mode
 *   npx ascii-motion-mcp --project-dir ./   # Specify project directory
 *   npx ascii-motion-mcp --live             # Enable live browser sync
 *   npx ascii-motion-mcp --help             # Show help
 * 
 * For MCP Inspector testing:
 *   npx @modelcontextprotocol/inspector /path/to/run-server.sh
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getProjectManager, setWebSocketBroadcaster } from './state.js';
import { HybridTransport } from './transport/index.js';
import {
  registerCanvasTools,
  registerFrameTools,
  registerProjectTools,
  registerPreviewTools,
  registerHistoryTools,
  registerAnimationTools,
  registerSelectionTools,
  registerExportTools,
  registerEffectsTools,
  registerGeneratorTools,
  registerAdditionalExportTools,
  registerImportTools,
} from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface CLIOptions {
  projectDir: string;
  help: boolean;
  version: boolean;
  live: boolean;
  port: number;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    projectDir: process.cwd(),
    help: false,
    version: false,
    live: false,
    port: 9876,
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
    } else if (arg === '--live' || arg === '-l') {
      options.live = true;
    } else if (arg === '--port' || arg === '-p') {
      const nextArg = args[++i];
      if (nextArg) {
        options.port = parseInt(nextArg, 10);
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
  -l, --live              Enable live browser sync via WebSocket
  -p, --port PORT         WebSocket port for live mode (default: 9876)

ENVIRONMENT VARIABLES:
  ASCII_MOTION_PROJECT_DIR  Alternative way to set project directory

EXAMPLES:
  # Start server in current directory
  ascii-motion-mcp

  # Start server with specific project directory
  ascii-motion-mcp --project-dir ./my-projects

  # Enable live browser sync
  ascii-motion-mcp --live --port 9876

  # Test with MCP Inspector
  npx @modelcontextprotocol/inspector /path/to/run-server.sh

LIVE MODE:
  When --live is enabled, a WebSocket server starts on 127.0.0.1.
  The auth token is printed to stderr. Use this token to connect
  your browser to the MCP server for real-time synchronization.

  Connect URL: ws://127.0.0.1:PORT/?token=AUTH_TOKEN

AVAILABLE TOOLS (60 total):
  Canvas (8), Frames (7), Project (6), Preview (5), Animation (5),
  Selection (6), History (3), Export (11), Import (3), Effects (4),
  Generators (2)

For detailed documentation, visit:
  https://github.com/CameronFoxly/ascii-motion-mcp
`);
}

function showVersion(): void {
  console.log('ascii-motion-mcp v0.2.0-alpha.1');
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
    version: '0.2.0-alpha.1',
  });
  
  // Register all tools
  registerCanvasTools(server);
  registerFrameTools(server);
  registerProjectTools(server);
  registerPreviewTools(server);
  registerHistoryTools(server);
  registerAnimationTools(server);
  registerSelectionTools(server);
  registerExportTools(server);
  registerEffectsTools(server);
  registerGeneratorTools(server);
  registerAdditionalExportTools(server);
  registerImportTools(server);
  
  // Register resources
  registerResources(server);
  
  // Register prompts
  registerPrompts(server);
  
  // Initialize project manager
  getProjectManager();
  
  // Set up live mode if enabled
  let hybridTransport: HybridTransport | null = null;
  
  if (options.live) {
    hybridTransport = new HybridTransport(options.port, '127.0.0.1');
    
    // Set up WebSocket broadcaster for state changes
    setWebSocketBroadcaster((type, data) => {
      hybridTransport?.broadcastStateChange(type, data);
    });
    
    // Start WebSocket server
    await hybridTransport.startWebSocket();
    
    console.error(`[ascii-motion-mcp] Live mode enabled`);
    console.error(`[ascii-motion-mcp] WebSocket URL: ws://127.0.0.1:${options.port}`);
    console.error(`[ascii-motion-mcp] Auth Token: ${hybridTransport.authToken}`);
    console.error(`[ascii-motion-mcp] Session ID: ${hybridTransport.sessionId}`);
    console.error('');
    console.error(`[ascii-motion-mcp] Browser connect URL:`);
    console.error(`  ws://127.0.0.1:${options.port}/?token=${hybridTransport.authToken}`);
  }
  
  // Log startup (to stderr so it doesn't interfere with MCP protocol)
  console.error(`[ascii-motion-mcp] Starting server...`);
  console.error(`[ascii-motion-mcp] Project directory: ${options.projectDir}`);
  
  // Connect via stdio transport (for MCP protocol)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error(`[ascii-motion-mcp] Server connected and ready`);
  
  // Handle shutdown
  const shutdown = async () => {
    console.error('[ascii-motion-mcp] Shutting down...');
    if (hybridTransport) {
      await hybridTransport.stopWebSocket();
    }
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
