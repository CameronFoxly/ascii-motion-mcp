/**
 * WebSocket Transport for MCP Server
 * 
 * Implements the MCP Transport interface over WebSocket connections.
 * Used for --live mode to enable real-time browser synchronization.
 */

import { WebSocket, WebSocketServer } from 'ws';
import * as http from 'http';
import * as crypto from 'crypto';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface WebSocketTransportOptions {
  port: number;
  host?: string;
  authToken?: string;
}

/**
 * Server transport for WebSocket: enables real-time bidirectional communication
 * with browser clients for live ASCII Motion synchronization.
 */
export interface ExportRequest {
  requestId: string;
  exportType: 'image' | 'video';
  format: string;
  settings: Record<string, unknown>;
  filename: string;
}

export interface ExportResult {
  requestId: string;
  success: boolean;
  data?: string;       // base64-encoded file data
  mimeType?: string;
  filename?: string;
  error?: string;
  bytes?: number;
}

export interface BrowserCommand {
  type: string;
  [key: string]: unknown;
}

export interface BrowserCommandRequest {
  type: 'command_request';
  requestId: string;
  command: BrowserCommand;
}

export interface BrowserCommandApplied {
  currentFrameIndex?: number;
  cellsChanged?: number;
  frameRate?: number;
  durationMs?: number;
}

export interface BrowserCommandResult {
  type: 'command_result';
  requestId: string;
  success: boolean;
  error?: string;
  applied?: BrowserCommandApplied;
}

export type BrowserCommandFinalizer = (
  result: BrowserCommandResult,
) => void | Promise<void>;

interface PendingBrowserCommand {
  request: BrowserCommandRequest;
  timeoutMs: number;
  resolve: (result: BrowserCommandResult) => void;
  reject: (error: Error) => void;
  client?: WebSocket;
  timeout?: NodeJS.Timeout;
  afterAcknowledged?: BrowserCommandFinalizer;
  acknowledged?: boolean;
}

export class WebSocketServerTransport {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private clients: Set<WebSocket> = new Set();
  private _sessionId: string;
  private _authToken: string;
  onStateSnapshot?: (snapshot: unknown) => void;
  private pendingExportResolvers: Map<string, (result: ExportResult) => void> = new Map();
  private commandQueue: PendingBrowserCommand[] = [];
  private activeCommand: PendingBrowserCommand | null = null;
  private requiresStateReconciliation = false;
  private options: WebSocketTransportOptions;
  
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: WebSocketTransportOptions) {
    this.options = {
      host: '127.0.0.1',
      ...options,
    };
    this._sessionId = crypto.randomUUID();
    this._authToken = options.authToken ?? crypto.randomBytes(32).toString('hex');
  }

  /**
   * Get the auth token required to connect to this server.
   */
  get authToken(): string {
    return this._authToken;
  }

  /**
   * Get the session ID for this transport.
   */
  get sessionId(): string {
    return this._sessionId;
  }

  get port(): number {
    const address = this.httpServer?.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  /**
   * Start the WebSocket server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // Health check endpoint
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', sessionId: this._sessionId }));
          return;
        }
        
        // Token info endpoint (for browser clients)
        if (req.url === '/info') {
          res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': 'http://localhost:5173',
            'Access-Control-Allow-Methods': 'GET',
          });
          res.end(JSON.stringify({ 
            sessionId: this._sessionId,
            protocol: 'mcp-websocket',
            version: '0.1.0',
          }));
          return;
        }
        
        // Default response
        res.writeHead(404);
        res.end('Not Found');
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws, req) => {
        // Extract auth token from query string
        const url = new URL(req.url ?? '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');
        
        // Validate auth token
        if (token !== this._authToken) {
          console.error('[ws-transport] Invalid auth token, closing connection');
          ws.close(1008, 'Invalid auth token');
          return;
        }
        
        // Validate origin (localhost and ascii-motion.app)
        const origin = req.headers.origin;
        if (origin && !origin.match(/^https?:\/\/(localhost|127\.0\.0\.1|ascii-motion\.app)(:\d+)?$/)) {
          console.error('[ws-transport] Invalid origin, closing connection:', origin);
          ws.close(1008, 'Invalid origin');
          return;
        }

        console.error('[ws-transport] Client connected');
        this.clients.add(ws);

        ws.on('message', (data) => {
          try {
            const rawMessage = JSON.parse(data.toString());
            // Handle state_snapshot from browser
            if (rawMessage.type === 'state_snapshot') {
              console.error('[ws-transport] Received state snapshot from browser');
              if (ws.readyState === WebSocket.OPEN) {
                this.requiresStateReconciliation = false;
              }
              this.onStateSnapshot?.(rawMessage);
              return;
            }
            // Handle export_result from browser
            if (rawMessage.type === 'export_result') {
              const result = rawMessage as ExportResult;
              const resolver = this.pendingExportResolvers.get(result.requestId);
              if (resolver) {
                this.pendingExportResolvers.delete(result.requestId);
                resolver(result);
              }
              return;
            }
            if (rawMessage.type === 'command_result') {
              this.handleBrowserCommandResult(rawMessage as BrowserCommandResult);
              return;
            }
            const message = rawMessage as JSONRPCMessage;
            this.onmessage?.(message);
          } catch (error) {
            console.error('[ws-transport] Failed to parse message:', error);
            this.onerror?.(error as Error);
          }
        });

        ws.on('close', () => {
          console.error('[ws-transport] Client disconnected');
          this.clients.delete(ws);
          if (this.activeCommand?.client === ws) {
            this.quarantineBrowserCommandChannel(
              'Browser disconnected before command completed',
              'Command acknowledgement interrupted',
            );
          }
        });

        ws.on('error', (error) => {
          console.error('[ws-transport] Client error:', error);
          if (this.activeCommand?.client === ws) {
            this.quarantineBrowserCommandChannel(
              `Browser connection error: ${error.message}`,
              'Command connection error',
            );
          }
          this.clients.delete(ws);
          this.onerror?.(error);
        });

        // Send welcome message
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/connected',
          params: {
            sessionId: this._sessionId,
            protocol: 'mcp-websocket',
          },
        }));
      });

      this.wss.on('error', (error) => {
        console.error('[ws-transport] Server error:', error);
        this.onerror?.(error);
        reject(error);
      });

      this.httpServer.listen(this.options.port, this.options.host, () => {
        console.error(`[ws-transport] WebSocket server listening on ws://${this.options.host}:${this.options.port}`);
        resolve();
      });

      this.httpServer.on('error', (error) => {
        console.error('[ws-transport] HTTP server error:', error);
        this.onerror?.(error);
        reject(error);
      });
    });
  }

  /**
   * Send a message to all connected clients.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Broadcast a state update to all connected clients.
   * This is called by the ProjectStateManager on state changes.
   */
  broadcastStateChange(type: string, data: unknown): void {
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/stateChanged',
      params: { type, data },
    };
    const message = JSON.stringify(notification);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }


  /**
   * Request state from browser.
   * Sends a state_request message and waits for a state_snapshot response.
   */
  async requestStateFromBrowser(timeoutMs = 5000): Promise<boolean> {
    if (this.clients.size === 0) {
      return false;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      const originalCallback = this.onStateSnapshot;
      
      this.onStateSnapshot = (snapshot) => {
        clearTimeout(timeout);
        originalCallback?.(snapshot);
        this.onStateSnapshot = originalCallback;
        resolve(true);
      };

      const message = JSON.stringify({ type: "state_request" });
      for (const client of this.clients) {
        if (client.readyState === 1) {
          client.send(message);
        }
      }
    });
  }

  /**
   * Request an export from the browser.
   * Sends an export_request message and waits for an export_result response.
   */
  async requestExportFromBrowser(request: ExportRequest, timeoutMs = 60000): Promise<ExportResult> {
    if (this.clients.size === 0) {
      return { requestId: request.requestId, success: false, error: 'No browser connected' };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingExportResolvers.delete(request.requestId);
        resolve({ requestId: request.requestId, success: false, error: 'Export timed out' });
      }, timeoutMs);

      this.pendingExportResolvers.set(request.requestId, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      const message = JSON.stringify({ type: 'export_request', ...request });
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
          break; // Only send to one client
        }
      }
    });
  }

  /**
   * Queue a browser mutation and wait for its correlated acknowledgement.
   * Only one command is in flight at a time so browser mutations are applied FIFO.
   */
  async requestBrowserCommand(
    command: BrowserCommand,
    timeoutMs = 5000,
    afterAcknowledged?: BrowserCommandFinalizer,
  ): Promise<BrowserCommandResult> {
    if (this.requiresStateReconciliation) {
      throw new Error('Browser command channel requires reconnect and state reconciliation');
    }
    if (!this.getOpenClient()) {
      throw new Error('No browser connected');
    }

    const request: BrowserCommandRequest = {
      type: 'command_request',
      requestId: crypto.randomUUID(),
      command,
    };

    return new Promise((resolve, reject) => {
      this.commandQueue.push({
        request,
        timeoutMs,
        resolve,
        reject,
        afterAcknowledged,
      });
      this.dispatchNextBrowserCommand();
    });
  }

  private getOpenClient(): WebSocket | undefined {
    return Array.from(this.clients).find(client => client.readyState === WebSocket.OPEN);
  }

  private dispatchNextBrowserCommand(): void {
    if (this.activeCommand || this.commandQueue.length === 0) return;

    const client = this.getOpenClient();
    if (!client) {
      this.rejectPendingBrowserCommands('No browser connected');
      return;
    }

    const pending = this.commandQueue.shift()!;
    pending.client = client;
    pending.timeout = setTimeout(() => {
      if (this.activeCommand !== pending) return;
      this.quarantineBrowserCommandChannel(
        `Browser command "${pending.request.command.type}" timed out after ${pending.timeoutMs}ms`,
        'Command acknowledgement timed out',
      );
    }, pending.timeoutMs);
    this.activeCommand = pending;

    try {
      client.send(JSON.stringify(pending.request), error => {
        if (error && this.activeCommand === pending && !pending.acknowledged) {
          this.quarantineBrowserCommandChannel(
            `Failed to send browser command "${pending.request.command.type}": ${error.message}`,
            'Command send failed',
          );
        }
      });
    } catch (error) {
      this.quarantineBrowserCommandChannel(
        `Failed to send browser command "${pending.request.command.type}": ${
          error instanceof Error ? error.message : String(error)
        }`,
        'Command send failed',
      );
    }
  }

  private handleBrowserCommandResult(result: BrowserCommandResult): void {
    const pending = this.activeCommand;
    if (
      !pending
      || pending.acknowledged
      || pending.request.requestId !== result.requestId
    ) return;

    if (!result.success) {
      this.finishActiveBrowserCommand(
        new Error(result.error || `Browser rejected command "${pending.request.command.type}"`),
      );
      return;
    }

    pending.acknowledged = true;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }

    if (!pending.afterAcknowledged) {
      this.finishActiveBrowserCommand(undefined, result, pending);
      return;
    }

    void Promise.resolve(pending.afterAcknowledged(result)).then(
      () => this.finishActiveBrowserCommand(undefined, result, pending),
      error => this.quarantineBrowserCommandChannel(
        error instanceof Error ? error.message : String(error),
        'Command reconciliation failed',
      ),
    );
  }

  private finishActiveBrowserCommand(
    error?: Error,
    result?: BrowserCommandResult,
    expectedPending?: PendingBrowserCommand,
  ): void {
    const pending = this.activeCommand;
    if (!pending || (expectedPending && pending !== expectedPending)) return;

    if (pending.timeout) clearTimeout(pending.timeout);
    this.activeCommand = null;

    if (error) {
      pending.reject(error);
    } else {
      pending.resolve(result!);
    }

    this.dispatchNextBrowserCommand();
  }

  private rejectPendingBrowserCommands(message: string): void {
    const active = this.activeCommand;
    this.activeCommand = null;
    if (active) {
      if (active.timeout) clearTimeout(active.timeout);
      active.reject(new Error(message));
    }

    const queued = this.commandQueue.splice(0);
    for (const pending of queued) {
      pending.reject(new Error(message));
    }
  }

  private quarantineBrowserCommandChannel(message: string, closeReason: string): void {
    this.requiresStateReconciliation = true;
    this.rejectPendingBrowserCommands(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, closeReason);
      }
    }
  }

  /**
   * Close the WebSocket server.
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.rejectPendingBrowserCommands('WebSocket transport closed before command completed');

      // Close all client connections
      for (const client of this.clients) {
        client.close(1000, 'Server shutting down');
      }
      this.clients.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          // Close HTTP server
          if (this.httpServer) {
            this.httpServer.close(() => {
              this.onclose?.();
              resolve();
            });
          } else {
            this.onclose?.();
            resolve();
          }
        });
      } else {
        this.onclose?.();
        resolve();
      }
    });
  }

  /**
   * Get number of connected clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }
}

/**
 * Combined transport that bridges stdio (for MCP protocol) with WebSocket (for browser sync).
 * 
 * The MCP server communicates via stdio with the AI client.
 * The WebSocket server broadcasts state changes to browser clients.
 */
export class HybridTransport {
  private wsTransport: WebSocketServerTransport;
  
  constructor(wsPort: number, wsHost: string = '127.0.0.1') {
    this.wsTransport = new WebSocketServerTransport({
      port: wsPort,
      host: wsHost,
    });
  }
  
  get authToken(): string {
    return this.wsTransport.authToken;
  }
  
  get sessionId(): string {
    return this.wsTransport.sessionId;
  }
  
  get wsServer(): WebSocketServerTransport {
    return this.wsTransport;
  }
  
  async startWebSocket(): Promise<void> {
    await this.wsTransport.start();
  }
  
  async stopWebSocket(): Promise<void> {
    await this.wsTransport.close();
  }
  
  broadcastStateChange(type: string, data: unknown): void {
    this.wsTransport.broadcastStateChange(type, data);
  }

  async requestStateFromBrowser(timeoutMs = 5000): Promise<boolean> {
    return this.wsTransport.requestStateFromBrowser(timeoutMs);
  }

  async requestExportFromBrowser(request: ExportRequest, timeoutMs = 60000): Promise<ExportResult> {
    return this.wsTransport.requestExportFromBrowser(request, timeoutMs);
  }

  async requestBrowserCommand(
    command: BrowserCommand,
    timeoutMs = 5000,
    afterAcknowledged?: BrowserCommandFinalizer,
  ): Promise<BrowserCommandResult> {
    return this.wsTransport.requestBrowserCommand(command, timeoutMs, afterAcknowledged);
  }
}
