import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// State request callback - will be set by index.ts
let requestBrowserStateCallback: (() => Promise<boolean>) | null = null;

// Auth TOken callback - will be set by index.ts
// State request callback - will be set by index.ts
let requestRequestAuthTokenCallback: (() => Promise<string|undefined>) | null = null;

export function setRequestBrowserStateCallback(callback: () => Promise<boolean>): void {
  requestBrowserStateCallback = callback;
}

export function setRequestRequestAuthTokenCallback(callback: () => Promise<string|undefined>): void {
  requestRequestAuthTokenCallback = callback;
}

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    'get_connection_status',
    'Check browser connection status. Returns whether browser is connected and client count',
    {},
    async () => {
      if (!requestBrowserStateCallback) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Live mode not enabled. Start server with --live flag.',
              }),
            },
          ],
        };
      }

      try {
        const success = await requestBrowserStateCallback();
        if (success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Browser connected',
                }),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'No browser connected or request timed out',
                }),
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_auth_token',
    'Get the authentication token for browser connection.',
    {},
    async () => {
      if (!requestRequestAuthTokenCallback) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'Live mode not enabled. Start server with --live flag.',
              }),
            },
          ],
        };
      }

      try {
        const token = await requestRequestAuthTokenCallback();
        if (!token) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: 'Live mode not enabled. Start server with --live flag.',
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                token: token,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
