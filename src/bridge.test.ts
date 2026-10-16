import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { configureBrowserBridge, executeBridgeOperation } from './bridge.js';
import { bridgeContract } from './contract.js';
import { DEFAULT_RESPONSE_BYTES, MAX_PAGE_BYTES } from './artifacts.js';
import { McpServer } from './mcp.js';
import {
  registerCanvasTools, registerProjectTools, registerPreviewTools, registerLayerTools,
  registerSelectionTools, registerProceduralGeneratorTools, registerExportTools,
  registerAdditionalExportTools, registerBrowserExportTools, registerImportTools,
} from './tools/index.js';
import { registerGeneratedOperationTools } from './tools/generated-operations.js';
import { WebSocketServerTransport, type BrowserCommandRequest } from './transport/websocket.js';

const cell = { x: 2, y: 1, char: 'A', color: '#FFFFFF', bgColor: 'transparent' };
const summary = {
  documentId: 'document', revision: 0, name: 'Fixture',
  canvas: { width: 8, height: 4, backgroundColor: '#000000' },
  typography: { fontId: 'monospace', fontSize: 16, characterSpacing: 1, lineSpacing: 1 },
  timeline: { frameRate: 12, durationFrames: 12, currentFrame: 1, workArea: null },
  activeLayerId: 'layer', layers: [], groups: [], effects: [], shaders: [],
  selection: { active: false, count: 0, bounds: null }, history: { canUndo: false, canRedo: false },
};

describe('MCP-to-WebSocket contract boundary (fixture, not mounted-app acceptance)', () => {
  let transport: WebSocketServerTransport;
  let socket: WebSocket;
  let client: Client;
  let server: McpServer;
  let requests: BrowserCommandRequest[];
  let respond: (request: BrowserCommandRequest) => Record<string, unknown> | null;
  let directory: string;
  let originalDirectory: string | undefined;

  beforeEach(async () => {
    originalDirectory = process.env.ASCII_MOTION_PROJECT_DIR;
    directory = await fs.mkdtemp(path.join(tmpdir(), 'ascii-motion-bridge-'));
    process.env.ASCII_MOTION_PROJECT_DIR = directory;
    await fs.writeFile(path.join(directory, 'image.png'), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(directory, 'video.webm'), Buffer.from([4, 5, 6]));
    transport = new WebSocketServerTransport({ port: 0, authToken: 'fixture-token' });
    await transport.start();
    configureBrowserBridge(transport);
    requests = [];
    respond = request => {
      if (request.command.type === 'get_document_summary') return summary;
      if (request.command.type === 'read_cells') {
        const frame = z.number().optional().parse(request.command.frame) ?? 1;
        const region = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
          .parse(request.command.region ?? { x: 0, y: 0, width: 8, height: 4 });
        return {
          scope: request.command.scope, frame, region, format: 'cells',
          ...(request.command.scope === 'layer' ? { layerId: 'layer', contentFrameId: 'content' } : {}),
          cells: [frame === 0 ? { ...cell, x: 3, char: 'B' } : cell], cellCount: 1,
        };
      }
      return { ids: { layerId: 'created' }, layerId: 'created', revision: 1, documentId: 'document' };
    };
    socket = new WebSocket(`ws://127.0.0.1:${transport.port}/?token=fixture-token`);
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as BrowserCommandRequest;
      if (message.type !== 'command_request') return;
      requests.push(message);
      const result = respond(message);
      if (!result) return;
      socket.send(JSON.stringify({
        type: 'command_result', requestId: message.requestId, success: true,
        revision: result.revision ?? 0, documentId: 'document', applied: result,
      }));
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({
      type: 'hello', protocol: bridgeContract.protocol, protocolVersion: 3,
      contractVersion: bridgeContract.contractVersion, contractHash: bridgeContract.contractHash,
      app: { version: 'fixture' },
      document: { documentId: 'document', revision: 0 },
      capabilities: {
        operations: bridgeContract.operations.map(operation => operation.name),
      },
    }));
    while (!transport.browserHello) await new Promise(resolve => setTimeout(resolve, 1));
    server = new McpServer({ name: 'bridge-test', version: '1' });
    for (const register of [
      registerCanvasTools, registerProjectTools, registerPreviewTools,
      registerLayerTools, registerSelectionTools, registerProceduralGeneratorTools,
      registerExportTools, registerAdditionalExportTools, registerBrowserExportTools, registerImportTools,
    ]) register(server);
    registerGeneratedOperationTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'bridge-test', version: '1' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    configureBrowserBridge(undefined);
    await client.close();
    await server.close();
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
      await once(socket, 'close');
    }
    await transport.close();
    if (originalDirectory === undefined) delete process.env.ASCII_MOTION_PROJECT_DIR;
    else process.env.ASCII_MOTION_PROJECT_DIR = originalDirectory;
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('discovers unique canonical/compatibility names, schemas and safety annotations', async () => {
    const tools = (await client.listTools()).tools;
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    expect(tools.find(tool => tool.name === 'app_add_layer')).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      outputSchema: { required: ['success'] },
    });
    expect(tools.find(tool => tool.name === 'get_document_summary')).toMatchObject({
      annotations: { readOnlyHint: true },
    });
    const ajv = new Ajv2020({ strict: true });
    for (const operation of bridgeContract.operations) {
      const tool = tools.find(tool => tool.name === `app_${operation.name}`)
        ?? tools.find(tool => tool.name === operation.name);
      expect(tool, operation.name).toBeDefined();
      expect(() => ajv.compile(tool!.inputSchema)).not.toThrow();
      expect(() => ajv.compile(tool!.outputSchema!)).not.toThrow();
    }
    const result = await client.callTool({ name: 'app_add_layer', arguments: { name: 'New' } });
    expect(result).toMatchObject({ structuredContent: { success: true, result: { ids: { layerId: 'created' }, revision: 1 } } });
    expect(requests[0]).toMatchObject({ protocolVersion: 3, command: { type: 'add_layer', name: 'New' }, expectedRevision: 0 });
  });

  it('validates canonical input before sending and never falls back when disconnected', async () => {
    await expect(executeBridgeOperation('update_layer', { layerId: 'layer', unexpected: true }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toHaveLength(0);
    socket.close();
    await once(socket, 'close');
    await expect(executeBridgeOperation('set_cells', { cells: [cell] })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('rejects a mismatched contract before dispatching an edit', async () => {
    socket.send(JSON.stringify({ ...transport.browserHello, contractHash: 'different-contract' }));
    while (transport.browserHello?.contractHash !== 'different-contract') await new Promise(resolve => setTimeout(resolve, 1));
    const result = await client.callTool({ name: 'set_cell', arguments: { x: 0, y: 0, char: 'X' } });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'UNSUPPORTED', details: { appContractHash: 'different-contract' } } },
    });
    expect(requests).toHaveLength(0);
  });

  it('maps legacy media conversion settings and video windows to native keys', async () => {
    await client.callTool({
      name: 'import_image', arguments: { filePath: 'image.png', charset: ' .@', offsetX: 2, offsetY: 1 },
    });
    expect(requests.at(-1)?.command).toMatchObject({
      type: 'import_media', data: 'AQID', mimeType: 'image/png', mode: 'overlay',
      settings: {
        characterSet: [' ', '.', '@'], cropMode: 'top-left', nudgeX: 2, nudgeY: 1,
        enableTextColorMapping: true, enableBackgroundColorMapping: false,
        useOriginalColors: true, colorQuantization: 'none', textColorPaletteId: null,
      },
    });
    await client.callTool({
      name: 'import_video',
      arguments: { filePath: 'video.webm', fps: 12, startTime: 1, duration: 2, maxFrames: 3 },
    });
    expect(requests.at(-1)?.command).toMatchObject({
      type: 'import_media', video: { frameRate: 12, startTime: 1, duration: 2, maxFrames: 3 },
    });
    expect(requests.at(-1)?.command.settings).not.toHaveProperty('fps');
  });

  it('rejects an empty legacy import charset without dispatching a mutation', async () => {
    expect(await client.callTool({
      name: 'import_image', arguments: { filePath: 'image.png', charset: '' },
    })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
    expect(requests).toHaveLength(0);
  });

  it('infers image formats without sending options the app ignores', async () => {
    respond = () => ({
      artifact: { filename: 'fixture.png', mimeType: 'image/png', encoding: 'base64', bytes: 1, data: 'AQ==' },
      result: { format: 'png', width: 8, height: 4 },
    });
    const result = await client.callTool({ name: 'export_image', arguments: { filePath: 'out.png' } });
    expect(result.isError).not.toBe(true);
    expect(requests[0].command).toEqual({
      type: 'export', format: 'png', filename: 'out.png',
      settings: { frame: 'current', sizeMultiplier: 1, includeGrid: false },
    });
    expect(await fs.readFile(path.join(directory, 'out.png'))).toEqual(Buffer.from([1]));
  });

  it('maps single-frame text export and trimming rather than silently exporting the animation', async () => {
    const original = respond;
    respond = request => request.command.type === 'export' ? {
      artifact: { filename: 'fixture.txt', mimeType: 'text/plain', encoding: 'utf8', bytes: 1, data: 'A' },
      result: { format: 'text', frameCount: 1 },
    } : original(request);
    const result = await client.callTool({ name: 'export_text', arguments: { trimEmpty: false } });
    expect(result.isError).not.toBe(true);
    expect(requests.at(-1)?.command.settings).toEqual({
      includeMetadata: false, frameRange: { start: 1, end: 1 },
      removeLeadingSpaces: false, removeTrailingSpaces: false,
      removeLeadingLines: false, removeTrailingLines: false,
    });
  });

  it('does not save a component export if the app changes its public name', async () => {
    respond = () => ({
      artifact: { filename: 'fixture.tsx', mimeType: 'text/plain', encoding: 'utf8', bytes: 1, data: 'A' },
      result: { format: 'react', componentName: 'Unexpected' },
    });

    const result = await client.callTool({
      name: 'export_react', arguments: { filePath: 'out.tsx', componentName: 'Requested' },
    });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL' } } });
    await expect(fs.stat(path.join(directory, 'out.tsx'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('encodes component-name boundaries for the app PascalCase filename conversion', async () => {
    respond = () => ({
      artifact: { filename: 'http-client.tsx', mimeType: 'text/plain', encoding: 'utf8', bytes: 1, data: 'A' },
      result: { format: 'react', componentName: 'HTTPClient' },
    });
    const result = await client.callTool({ name: 'export_react', arguments: { componentName: 'HTTPClient' } });
    expect(result.isError).not.toBe(true);
    expect(requests[0].command.settings).toMatchObject({ fileName: 'H-T-T-P-Client' });
  });

  it('explicitly rejects unrepresentable legacy options without dispatching them', async () => {
    const cases = [
      { name: 'create_group', arguments: {} },
      { name: 'import_image', arguments: { filePath: 'image.png', colorMode: 'both' } },
      { name: 'import_image', arguments: { filePath: 'image.png', dithering: 'ordered' } },
      { name: 'export_opentui', arguments: { className: 'OldPythonClass' } },
      { name: 'export_bubbletea', arguments: { modelName: 'CustomModel' } },
      { name: 'export_html', arguments: { includeControls: false } },
      { name: 'export_json', arguments: { includeEmptyCells: true } },
    ];
    for (const input of cases) {
      expect(await client.callTool(input)).toMatchObject({
        isError: true, structuredContent: { error: { code: 'UNSUPPORTED' } },
      });
    }
    expect(requests).toHaveLength(0);
  });

  it('does not mislabel a headless Python helper as a real OpenTUI export', async () => {
    configureBrowserBridge(undefined);
    expect(await client.callTool({ name: 'export_opentui', arguments: {} })).toMatchObject({
      isError: true, structuredContent: { error: { code: 'UNSUPPORTED' } },
    });
  });

  it('bounds errors too and preserves their complete UTF-8 content in paged artifacts', async () => {
    configureBrowserBridge(undefined);
    const message = 'Failed: ' + '😀"\\'.repeat(3000);
    server.tool('get_oversized_error', 'Error budget fixture', {}, async () => { throw new Error(message); });
    const response = await client.callTool({ name: 'get_oversized_error', arguments: {} });
    expect(response.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(DEFAULT_RESPONSE_BYTES);
    const descriptor = z.object({ inline: z.literal(false), artifact: z.object({ id: z.string() }) })
      .parse(response.structuredContent);
    let offset: number | null = 0;
    let text = '';
    do {
      const response = await client.callTool({
        name: 'read_artifact', arguments: { artifactId: descriptor.artifact.id, offset, length: 8192 },
      });
      expect(response.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      const page = z.object({ data: z.string(), nextOffset: z.number().nullable() }).parse(response.structuredContent);
      text += page.data;
      offset = page.nextOffset;
    } while (offset !== null);
    expect(JSON.parse(text)).toMatchObject({ isError: true, structuredContent: { error: { message } } });
  });

  it('bounds SDK input-validation errors before tool middleware runs', async () => {
    const invalid = 'invalid'.repeat(5000);
    const response = await client.callTool({
      name: 'import_image', arguments: { filePath: 'image.png', colorMode: invalid },
    });
    expect(response.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(DEFAULT_RESPONSE_BYTES);
    const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const id = z.string().parse(text.match(/ascii-motion:\/\/artifacts\/([a-f0-9-]+)/)?.[1]);
    let offset: number | null = 0;
    let recovered = '';
    do {
      const response = await client.callTool({
        name: 'read_artifact', arguments: { artifactId: id, offset, length: 8192 },
      });
      expect(response.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      const page = z.object({ data: z.string(), nextOffset: z.number().nullable() }).parse(response.structuredContent);
      recovered += page.data;
      offset = page.nextOffset;
    } while (offset !== null);
    expect(JSON.parse(recovered)).toMatchObject([{ path: ['colorMode'], message: expect.stringContaining(invalid) }]);
  });

  it('accepts an explicit public revision guard without forwarding it as an operation input', async () => {
    const result = await client.callTool({ name: 'app_add_layer', arguments: { name: 'Guarded', expectedRevision: 7 } });
    expect(result).toMatchObject({ structuredContent: { success: true, revision: 1, documentId: 'document' } });
    expect(requests[0]).toMatchObject({ expectedRevision: 7, command: { type: 'add_layer', name: 'Guarded' } });
    expect(requests[0].command).not.toHaveProperty('expectedRevision');
  });

  it('quarantines a malformed acknowledged success instead of reporting a successful edit', async () => {
    respond = () => ({});
    const result = await client.callTool({ name: 'app_add_layer', arguments: {} });
    expect(result).toMatchObject({
      isError: true, structuredContent: { success: false, error: { code: 'INTERNAL', details: { browserApplied: true } } },
    });
    expect(requests).toHaveLength(1);
    await expect(executeBridgeOperation('add_layer', {})).rejects.toThrow();
  });

  it('keeps the revision of a dependent read even when a UI change arrives before its acknowledgement', async () => {
    const original = respond;
    respond = request => {
      if (request.command.type === 'read_cells') {
        socket.send(JSON.stringify({ type: 'doc_changed', documentId: 'document', revision: 1, source: 'ui' }));
      }
      if (request.command.type === 'set_selection') {
        socket.send(JSON.stringify({
          type: 'command_result', requestId: request.requestId, success: false,
          revision: 1, documentId: 'document', error: 'Stale document', errorCode: 'CONFLICT',
          errorDetails: { expectedRevision: 0, actualRevision: 1 },
        }));
        return null;
      }
      return original(request);
    };
    const result = await client.callTool({ name: 'select_by_color', arguments: { x: 2, y: 1 } });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
    expect(requests[1]).toMatchObject({ command: { type: 'set_selection' }, expectedRevision: 0 });
    expect(transport.browserHello?.document.revision).toBe(1);
  });

  it('normalizes partial ASCII regions and supports trimming and previous-frame overlays', async () => {
    const partial = await client.callTool({
      name: 'get_canvas_ascii', arguments: { region: { x: 1 }, trimEmpty: false },
    });
    expect(partial.isError).not.toBe(true);
    expect(requests.at(-1)?.command.region).toEqual({ x: 1, y: 0, width: 7, height: 4 });
    const trimmed = await client.callTool({ name: 'get_canvas_ascii', arguments: {} });
    expect(trimmed).toMatchObject({ structuredContent: { ascii: 'A', bounds: { x: 2, y: 1, width: 1, height: 1 } } });
    const overlay = await client.callTool({
      name: 'get_canvas_ascii', arguments: { frameIndex: 1, trimEmpty: false, overlayPreviousFrame: true },
    });
    expect(overlay).toMatchObject({ structuredContent: { ascii: '        \n  A\u00b7    \n        \n        ' } });
  });

  it('maps project templates to actual new-project dimensions rather than a document replacement', async () => {
    await client.callTool({ name: 'new_project', arguments: { template: 'square-40x40', name: 'Square' } });
    expect(requests[0].command).toEqual({ type: 'new_project', width: 40, height: 40, name: 'Square' });
  });

  it('keeps generator discovery compact and honors type/category filters', async () => {
    respond = () => ({
      family: 'generators', entries: [{
        type: 'animated-text', name: 'Animated Text', mode: 'cells', defaultSettings: { text: 'Hi' },
        initialSettings: { text: 'Hi', x: 4 },
        properties: [
          { path: 'text', valueType: 'string', category: 'Text' },
          { path: 'speed', valueType: 'number', category: 'Animation' },
        ],
      }],
    });
    const list = await client.callTool({ name: 'list_generator_types', arguments: {} });
    expect(list).toMatchObject({ structuredContent: { generators: [{ type: 'animated-text', propertyCount: 2 }] } });
    expect(JSON.stringify(list)).not.toContain('defaultSettings');
    const detail = await client.callTool({
      name: 'list_generator_types', arguments: { generatorType: 'animated-text', category: 'animation' },
    });
    expect(detail).toMatchObject({
      structuredContent: {
        creationDefaults: { text: 'Hi', x: 4 },
        propertiesByCategory: { Animation: [{ path: 'speed' }] },
      },
    });
    expect(JSON.stringify(detail)).not.toContain('"Text":');
  });

  it('preserves unspecified cell fields and addresses the layer/hold that was read', async () => {
    await client.callTool({ name: 'set_cell', arguments: { x: 2, y: 1, color: '#123456' } });
    expect(requests.at(-1)).toMatchObject({
      expectedRevision: 0,
      command: {
        type: 'set_cells', target: { frame: 1, layerId: 'layer', contentFrameId: 'content' },
        cells: [{ x: 2, y: 1, char: 'A', color: '#123456', bgColor: 'transparent' }],
      },
    });
    await client.callTool({
      name: 'set_cells_batch', arguments: {
        cells: [{ x: 2, y: 1, color: '#123456' }, { x: 2, y: 1, char: 'Z' }],
      },
    });
    expect(requests.at(-1)?.command.cells).toEqual([
      { x: 2, y: 1, char: 'A', color: '#123456', bgColor: 'transparent' },
      { x: 2, y: 1, char: 'Z', color: '#123456', bgColor: 'transparent' },
    ]);
  });
});
