import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import * as toolRegistrations from './tools/index.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import {
  McpServer,
  setToolExecutionMiddleware,
  setToolMetadataProvider,
  standardSchema,
} from './mcp.js';

afterEach(() => {
  setToolExecutionMiddleware(undefined);
  setToolMetadataProvider(undefined);
});

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'facade-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('v2 typed registration facade', () => {
  for (const modern of [false, true]) {
    it(`serves raw ${modern ? 'modern discovery' : 'legacy initialize'} and cancellation through real stdio codecs`, async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const transport = new StdioServerTransport(input, output);
      let instances = 0;
      let started!: () => void;
      let aborted!: () => void;
      const waitStarted = new Promise<void>((done) => { started = done; });
      const waitAborted = new Promise<void>((done) => { aborted = done; });
      const handle = serveStdio(() => {
        instances++;
        const server = new McpServer({ name: 'raw-fixture', version: '1' });
        server.tool('echo', 'Echo', { value: z.string() }, async ({ value }) => ({
          content: [{ type: 'text', text: value }],
        }));
        server.tool('wait', 'Cancellation', {}, async (_args, context) => {
          started();
          await new Promise<void>((done) => {
            context.mcpReq.signal.addEventListener('abort', () => { aborted(); done(); }, { once: true });
          });
          return { content: [] };
        });
        server.resource('state', 'test://state', {}, async (uri) => ({
          contents: [{ uri: uri.href, text: 'state' }],
        }));
        return server;
      }, { transport, legacy: 'serve' });
      const closed = new Promise<void>((done) => {
        const onclose = transport.onclose;
        transport.onclose = () => { onclose?.(); done(); };
      });
      const replies = new Map<number, (result: Record<string, unknown>) => void>();
      const lines = createInterface({ input: output });
      lines.on('line', (line) => {
        const message = JSON.parse(line) as { id: number; result: Record<string, unknown> };
        replies.get(message.id)?.(message.result);
        replies.delete(message.id);
      });
      const meta = modern ? {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'raw-fixture-client', version: '1' },
        },
      } : {};
      let nextId = 1;
      const send = (method: string, params: Record<string, unknown>, id?: number) => {
        input.write(`${JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params: {
          ...params, ...meta,
        } })}\n`);
      };
      const request = (method: string, params: Record<string, unknown> = {}) => {
        const id = nextId++;
        const result = new Promise<Record<string, unknown>>((done) => { replies.set(id, done); });
        send(method, params, id);
        return result;
      };
      try {
        if (modern) {
          expect(await request('server/discover')).toMatchObject({
            supportedVersions: ['2026-07-28'], resultType: 'complete',
          });
          await request('server/discover');
        } else {
          expect(await request('initialize', {
            protocolVersion: '2025-11-25', capabilities: {},
            clientInfo: { name: 'raw-fixture-client', version: '1' },
          })).toMatchObject({ protocolVersion: '2025-11-25' });
          send('notifications/initialized', {});
        }
        expect((await request('tools/list')).tools).toHaveLength(2);
        expect(await request('tools/call', { name: 'echo', arguments: { value: 'raw' } }))
          .toMatchObject({ content: [{ type: 'text', text: 'raw' }] });
        expect(await request('resources/read', { uri: 'test://state' }))
          .toMatchObject({ contents: [{ text: 'state' }] });
        send('tools/call', { name: 'wait', arguments: {} }, 999);
        await waitStarted;
        send('notifications/cancelled', { requestId: 999, reason: 'test cancellation' });
        await waitAborted;
        expect((await request('tools/list')).tools).toHaveLength(2);
        expect(instances).toBe(1);
        input.end();
        await closed;
      } finally {
        await handle.close();
        lines.close();
        output.end();
      }
    });
  }

  it('registers all 109 legacy tools, nine resources and seven prompts with stable schemas', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    for (const [name, register] of Object.entries(toolRegistrations)) {
      if (name.startsWith('register')) Reflect.apply(register, undefined, [server]);
    }
    registerResources(server);
    registerPrompts(server);
    const client = await connect(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(109);
      expect(server.registeredToolNames.size).toBeGreaterThanOrEqual(109);
      const extendedSchemas = ['get_canvas_preview', 'get_frame_diff', 'set_generator_keyframes', 'add_keyframe', 'compare_frames', 'add_effect_block', 'set_frame_rate', 'export_opentui', 'export_bubbletea'];
      const unchanged = tools.filter(({ name }) => !extendedSchemas.includes(name))
        .map(({ name, inputSchema }) => ({ name, inputSchema }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const canonical = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object') {
          const object = value as Record<string, unknown>;
          return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
        }
        return value;
      };
      expect(createHash('sha256').update(JSON.stringify(canonical(unchanged))).digest('hex'))
        .toBe('68c648957e5b39a0bf89cc77cf4b66fd586aefe96703c1acea6b4133100be3c9');
      expect((await client.listResources()).resources).toHaveLength(9);
      expect((await client.listPrompts()).prompts).toHaveLength(7);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('preserves Zod 3 descriptions, optional/default/record semantics and validation', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    server.tool('typed', 'Typed tool', {
      count: z.number().int().min(1).default(3).describe('How many'),
      labels: z.record(z.string()).optional(),
    }, async (args) => ({
      content: [{ type: 'text', text: JSON.stringify(args) }],
    }));
    const client = await connect(server);
    try {
      const { tools } = await client.listTools();
      expect(tools[0].inputSchema).toMatchObject({
        properties: { count: { type: 'integer', minimum: 1, default: 3, description: 'How many' } },
        additionalProperties: false,
      });
      expect(await client.callTool({ name: 'typed', arguments: {} })).toMatchObject({
        content: [{ type: 'text', text: '{"count":3}' }],
      });
      expect(await client.callTool({ name: 'typed', arguments: { count: -1 } })).toMatchObject({
        isError: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('wraps existing handlers with optional middleware and preserves unset results/errors', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    const result: CallToolResult = {
      content: [{ type: 'text', text: 'original' }],
      isError: true,
    };
    server.tool('original', 'Original result', { count: z.number().default(2) }, async () => result);
    const client = await connect(server);
    try {
      expect(await client.callTool({ name: 'original', arguments: {} })).toMatchObject(result);
      let seen: unknown;
      setToolExecutionMiddleware(async (name, args, next, context) => {
        seen = { name, args, hasContext: Boolean(context) };
        const original = await next();
        return { ...original, content: [{ type: 'text', text: 'wrapped' }] };
      });
      expect(await client.callTool({ name: 'original', arguments: {} })).toMatchObject({
        content: [{ type: 'text', text: 'wrapped' }], isError: true,
      });
      expect(seen).toEqual({ name: 'original', args: { count: 2 }, hasContext: true });
      setToolExecutionMiddleware(undefined);
      expect(await client.callTool({ name: 'original', arguments: {} })).toMatchObject(result);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes annotations/output schemas and validates structured results through the SDK', async () => {
    setToolMetadataProvider(() => ({
      annotations: { readOnlyHint: true },
      outputSchema: standardSchema(z.object({ count: z.number() })),
    }));
    const server = new McpServer({ name: 'test', version: '1' });
    server.tool('structured', 'Structured', {}, async () => ({
      content: [{ type: 'text', text: '1' }], structuredContent: { count: 1 },
    }));
    const client = await connect(server);
    try {
      const { tools } = await client.listTools();
      expect(tools[0]).toMatchObject({
        annotations: { readOnlyHint: true },
        outputSchema: { properties: { count: { type: 'number' } }, required: ['count'] },
      });
      expect(await client.callTool({ name: 'structured', arguments: {} })).toMatchObject({
        structuredContent: { count: 1 },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('preserves contract JSON Schemas and exposes registered names without Zod conversion', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    const inputSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: { value: { type: 'string', enum: ['one', 'two'] } },
      properties: { value: { $ref: '#/$defs/value' } },
      required: ['value'],
      additionalProperties: false,
    };
    const outputSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    };
    const before = server.registeredToolNames;
    server.jsonTool('contract', 'Contract tool', inputSchema, outputSchema, async (args) => ({
      content: [{ type: 'text', text: String(args.value) }],
      structuredContent: { value: args.value },
    }), { readOnlyHint: true });
    expect(before.has('contract')).toBe(false);
    expect(server.registeredToolNames.has('contract')).toBe(true);
    const client = await connect(server);
    try {
      const { tools } = await client.listTools();
      expect(tools[0].inputSchema).toEqual(inputSchema);
      expect(tools[0].outputSchema).toEqual(outputSchema);
      expect(tools[0].annotations).toEqual({ readOnlyHint: true });
      const seen: string[] = [];
      setToolExecutionMiddleware(async (name, _args, next) => {
        seen.push(name);
        return next();
      });
      expect(await client.callTool({ name: 'contract', arguments: { value: 'one' } }))
        .toMatchObject({ structuredContent: { value: 'one' } });
      expect(seen).toEqual(['contract']);
      expect(await client.callTool({ name: 'contract', arguments: { value: 'three' } }))
        .toMatchObject({ isError: true });
      expect(seen).toEqual(['contract']);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('registers typed resources and prompt arguments without legacy SDK methods', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    server.resource('state', 'test://state', { mimeType: 'application/json' }, async (uri) => ({
      contents: [{ uri: uri.href, text: '{"ok":true}', mimeType: 'application/json' }],
    }));
    server.prompt('greet', 'Greeting', { name: z.string().optional() }, async ({ name }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Hi ${name ?? 'world'}` } }],
    }));
    const client = await connect(server);
    try {
      expect((await client.listResources()).resources).toHaveLength(1);
      expect(await client.readResource({ uri: 'test://state' })).toMatchObject({
        contents: [{ text: '{"ok":true}' }],
      });
      expect((await client.listPrompts()).prompts[0].arguments).toEqual([
        { name: 'name', required: false },
      ]);
      expect(await client.getPrompt({ name: 'greet', arguments: { name: 'MCP' } })).toMatchObject({
        messages: [{ content: { text: 'Hi MCP' } }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('propagates request cancellation through the typed handler context', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    let started!: () => void;
    let cancelled!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    server.tool('wait', 'Wait for cancellation', {}, async (_args, context) => {
      started();
      await new Promise<void>((resolve) => {
        context.mcpReq.signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true });
      });
      return { content: [] };
    });
    const client = await connect(server);
    try {
      const controller = new AbortController();
      const call = client.callTool(
        { name: 'wait', arguments: {} }, { signal: controller.signal },
      );
      const rejected = expect(call).rejects.toThrow();
      await start;
      controller.abort();
      await rejected;
      await cancellation;
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// Compiled explicitly by the protocol validation command; never executed.
function registrationTypeChecks(server: McpServer) {
  server.tool('number', 'Number', { count: z.number() }, async ({ count }) => {
    // @ts-expect-error schema output is a number, not an untyped value
    const text: string = count;
    return { content: [{ type: 'text', text }] };
  });
  // @ts-expect-error resource handlers must return resource contents
  server.resource('bad', 'test://bad', {}, async () => ({ messages: [] }));
  server.prompt('number', 'Number', { count: z.number() }, async ({ count }) => {
    // @ts-expect-error prompt input is inferred from its schema too
    const text: string = count;
    return { messages: [{ role: 'user', content: { type: 'text', text } }] };
  });
}
void registrationTypeChecks;
