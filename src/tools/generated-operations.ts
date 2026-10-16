import type { McpServer } from '../mcp.js';
import { bridgeContract, withDefinitions } from '../contract.js';
import { markGeneratedTool, operationToolResult } from '../bridge.js';
import { registerArtifactAccess } from '../artifacts.js';
import { z } from 'zod';

export function registerGeneratedOperationTools(server: McpServer): void {
  for (const operation of bridgeContract.operations) {
    const name = server.registeredToolNames.has(operation.name) ? `app_${operation.name}` : operation.name;
    markGeneratedTool(name);
    server.jsonTool(name, operation.description, withDefinitions({
      ...operation.input,
      properties: {
        ...z.record(z.unknown()).parse(operation.input.properties ?? {}),
        expectedRevision: {
          type: 'integer', minimum: 0,
          description: 'Optional revision from an authoritative read; reject if the document changed before execution.',
        },
      },
    }), withDefinitions({
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        operation: { type: 'string' },
        revision: { type: 'integer', minimum: 0 },
        documentId: { type: 'string' },
        result: operation.result,
        artifact: { type: 'object', additionalProperties: true },
        error: { type: 'object', additionalProperties: true },
      },
      required: ['success'],
      additionalProperties: true,
    }), async args => {
      const { expectedRevision, ...input } = args;
      return operationToolResult(operation.name, input, undefined,
        z.number().int().min(0).optional().parse(expectedRevision));
    }, {
      readOnlyHint: operation.kind === 'read',
      destructiveHint: operation.destructive,
      idempotentHint: operation.idempotent,
      openWorldHint: operation.requires.includes('auth'),
    });
  }
  registerArtifactAccess(server);
}
