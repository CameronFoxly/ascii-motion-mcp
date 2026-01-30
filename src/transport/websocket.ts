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
export class WebSocketServerTransport {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private clients: Set<WebSocket> = new Set();
  private _sessionId: string;
  private _authToken: string;
  onStateSnapshot?: (snapshot: unknown) => void;
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
              this.onStateSnapshot?.(rawMessage);
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
        });

        ws.on('error', (error) => {
          console.error('[ws-transport] Client error:', error);
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
   * Close the WebSocket server.
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
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
}
