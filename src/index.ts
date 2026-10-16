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

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { McpServer } from './mcp.js';
import { getProjectManager, setWebSocketBroadcaster, setEnsureFreshStateCallback } from './state.js';
import { HybridTransport } from './transport/index.js';
import { setBrowserCommandCallback } from './live-sync.js';
import { configureBrowserBridge, setBrowserBridgeUnavailable } from './bridge.js';
import { BrowserOperationError } from './transport/websocket.js';
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
  registerProceduralGeneratorTools,
  registerAdditionalExportTools,
  registerImportTools,
  registerPaletteTools,
  registerSyncTools,
  setSyncToolsBrowserStateCallback,
  setConnectionToolsBrowserStateCallback,
  setRequestAuthTokenCallback,
  registerLayerTools,
  registerConnectionTools,
  registerBrowserExportTools,
  setExportRequestCallback,
} from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { registerGeneratedOperationTools } from './tools/generated-operations.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

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
    projectDir: process.env.ASCII_MOTION_PROJECT_DIR ?? process.cwd(),
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
      if (!nextArg || nextArg.startsWith('-')) throw new Error(`${arg} requires a path`);
      options.projectDir = nextArg;
    } else if (arg === '--live' || arg === '-l') {
      options.live = true;
    } else if (arg === '--port' || arg === '-p') {
      const nextArg = args[++i];
      if (!nextArg || !/^\d+$/.test(nextArg)) throw new Error(`${arg} requires an integer port`);
      options.port = Number(nextArg);
      if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new Error('Port must be an integer between 1 and 65535');
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.version) {
    if (!options.projectDir.trim()) throw new Error('Project directory must not be empty');
    options.projectDir = resolve(options.projectDir);
    if (!statSync(options.projectDir).isDirectory()) {
      throw new Error(`Project directory is not a directory: ${options.projectDir}`);
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
  The host-owned process listens on 127.0.0.1. In the same AI session,
  call get_auth_token and get_connection_status, then connect the app.
  Do not start a second terminal server to obtain its token.
  Bridge v3 requires a matching app build. Node.js 22 or 24 is recommended.

  Connect URL: ws://127.0.0.1:PORT/?token=AUTH_TOKEN

AVAILABLE TOOLS:
  Use tools/list for current schemas and get_capabilities for the connected
  app. Existing tools are retained alongside schema-derived v3 operations.
  Large results and exports use bounded artifact pages.

For detailed documentation, visit:
  https://github.com/CameronFoxly/ascii-motion-mcp
`);
}

function showVersion(): void {
  console.log(`ascii-motion-mcp v${version}`);
}

// =============================================================================
// Server Setup
// =============================================================================

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'ascii-motion-mcp',
    version,
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
  registerProceduralGeneratorTools(server);
  registerAdditionalExportTools(server);
  registerImportTools(server);
  registerPaletteTools(server);
  registerSyncTools(server);
  registerLayerTools(server);
  registerConnectionTools(server);
  registerBrowserExportTools(server);
  registerGeneratedOperationTools(server);

  // Register resources
  registerResources(server);

  // Register prompts
  registerPrompts(server);

  return server;
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (options.help) return showHelp();
  if (options.version) return showVersion();

  process.env.ASCII_MOTION_PROJECT_DIR = options.projectDir;

  // Initialize project manager
  getProjectManager();

  let hybridTransport: HybridTransport | null = null;
  let liveStartup: Promise<HybridTransport | null> | undefined;
  let liveUnavailable: BrowserOperationError | undefined;
  let closing = false;

  function portInUse(): BrowserOperationError {
    return new BrowserOperationError('PORT_IN_USE',
      `Port ${options.port} is in use, usually by the ascii-motion MCP server of another AI session ` +
      'that already used ASCII Motion. Use ASCII Motion from that session, or end it; this server ' +
      'retries the port on its next tool call. To run both, give this server a different --port and ' +
      'set the same port in the app\'s MCP Connection dialog.');
  }

  // Bind the browser port on first real use rather than at initialize: hosts
  // such as the GitHub Copilot app start one server per session, and idle
  // sessions must not hold the port. A busy port is reported, not fatal.
  async function bindLive(): Promise<HybridTransport | null> {
    const candidate = new HybridTransport(options.port, '127.0.0.1');
    try {
      await candidate.startWebSocket();
    } catch (error) {
      await candidate.stopWebSocket().catch(() => undefined);
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error;
      if (!liveUnavailable) {
        console.error(`[ascii-motion-mcp] Port ${options.port} is in use; live tools report PORT_IN_USE until it frees up.`);
      }
      liveUnavailable = portInUse();
      setBrowserBridgeUnavailable(liveUnavailable);
      return null;
    }
    if (closing) {
      await candidate.stopWebSocket().catch(() => undefined);
      return null;
    }
    hybridTransport = candidate;
    liveUnavailable = undefined;
    setBrowserBridgeUnavailable(undefined);
    configureBrowserBridge(candidate.wsServer);
    candidate.wsServer.onStateSnapshot = (snapshot: unknown) => {
      getProjectManager().loadFromBrowserSnapshot(snapshot);
    };

    console.error(`[ascii-motion-mcp] Live mode enabled`);
    console.error(`[ascii-motion-mcp] WebSocket URL: ws://127.0.0.1:${options.port}`);
    console.error('[ascii-motion-mcp] Obtain this instance\'s token with get_auth_token in your MCP host.');
    console.error(`[ascii-motion-mcp] Session ID: ${candidate.sessionId}`);
    console.error('');
    console.error(`[ascii-motion-mcp] Browser connect URL:`);
    console.error(`  ws://127.0.0.1:${options.port}/?token=<token from get_auth_token>`);
    return candidate;
  }

  async function ensureLive(): Promise<HybridTransport | null> {
    if (!options.live || closing) return null;
    if (hybridTransport) return hybridTransport;
    liveStartup ??= bindLive().finally(() => { liveStartup = undefined; });
    return liveStartup;
  }

  async function liveTransport(): Promise<HybridTransport> {
    const live = await ensureLive();
    if (!live) throw liveUnavailable ?? portInUse();
    return live;
  }

  if (options.live) {
    setWebSocketBroadcaster((type, data) => {
      hybridTransport?.broadcastStateChange(type, data);
    });
    setBrowserCommandCallback(async (command, timeoutMs, afterAcknowledged, prepareCommand) => {
      return (await liveTransport()).requestBrowserCommand(
        command,
        timeoutMs,
        afterAcknowledged,
        prepareCommand,
      );
    });
    const browserStateCallback = async (): Promise<boolean> => {
      return (await liveTransport()).requestStateFromBrowser();
    };
    setSyncToolsBrowserStateCallback(browserStateCallback);
    setConnectionToolsBrowserStateCallback(browserStateCallback);
    setRequestAuthTokenCallback(async () => (await liveTransport()).authToken);
    setEnsureFreshStateCallback(browserStateCallback);
    setExportRequestCallback(async (request, timeoutMs) => {
      return (await liveTransport()).requestExportFromBrowser(request, timeoutMs);
    });
  }

  // Log startup (to stderr so it doesn't interfere with MCP protocol)
  console.error(`[ascii-motion-mcp] Starting server...`);
  console.error(`[ascii-motion-mcp] Project directory: ${options.projectDir}`);

  const transport = new StdioServerTransport();
  const handle = serveStdio(buildServer, {
    legacy: 'serve',
    transport,
    onerror: (error) => console.error('[ascii-motion-mcp] Protocol error:', error),
  });

  // Discovery probes and idle sessions never bind. Messages stay ordered while
  // a tool call or resource read waits for the first bind attempt.
  const dispatch = transport.onmessage;
  let inbound = Promise.resolve();
  transport.onmessage = (message) => {
    const binds = options.live && 'method' in message
      && (message.method === 'tools/call' || message.method === 'resources/read');
    inbound = inbound.then(async () => {
      if (binds) {
        await ensureLive().catch((error: unknown) => {
          console.error('[ascii-motion-mcp] Live startup failed:', error);
          void shutdown(1);
        });
      }
      if (!closing) dispatch?.(message);
    });
  };

  const shutdown = async (exitCode = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    console.error('[ascii-motion-mcp] Shutting down...');
    await liveStartup?.catch(() => undefined);
    await handle.close();
    if (hybridTransport) {
      await hybridTransport.stopWebSocket();
    }
    process.exitCode = exitCode;
  };

  const connectionClosed = transport.onclose;
  transport.onclose = () => {
    connectionClosed?.();
    void shutdown();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.stdin.once('end', () => { void shutdown(); });
  process.stdin.once('close', () => { void shutdown(); });
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
