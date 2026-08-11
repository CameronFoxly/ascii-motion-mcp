import { once } from 'node:events';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { setBrowserCommandCallback } from '../live-sync.js';
import {
  getProjectManager,
  resetProjectManager,
  setEnsureFreshStateCallback,
} from '../state.js';
import {
  WebSocketServerTransport,
  type BrowserCommandApplied,
  type BrowserCommandRequest,
  type BrowserCommandResult,
} from '../transport/websocket.js';
import { registerCanvasTools } from './canvas.js';
import { registerFrameTools } from './frames.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function captureTools(register: (server: McpServer) => void): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool(name: string, ...args: unknown[]): void {
      handlers.set(name, args.at(-1) as ToolHandler);
    },
  };
  register(server as unknown as McpServer);
  return handlers;
}

function responseBody(response: ToolResponse): Record<string, unknown> {
  return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

function successResult(
  requestId: string,
  applied?: BrowserCommandApplied,
): BrowserCommandResult {
  return {
    type: 'command_result',
    requestId,
    success: true,
    applied,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for test condition');
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function pasteArgs(char: string, x: number): Record<string, unknown> {
  return {
    text: char,
    x,
    y: 0,
    color: '#FFFFFF',
    bgColor: 'transparent',
    preserveSpaces: false,
  };
}

const nonUnitDurationProject = {
  version: '2.0.0' as const,
  name: 'Non-unit Timeline',
  canvas: {
    width: 8,
    height: 4,
    canvasBackgroundColor: '#000000',
    showGrid: true,
  },
  timeline: {
    frameRate: 10,
    durationFrames: 6,
    looping: true,
  },
  layers: [{
    id: 'layer-1',
    name: 'Layer 1',
    visible: true,
    solo: false,
    locked: false,
    opacity: 100,
    contentFrames: [
      {
        id: 'content-1',
        name: 'One',
        startFrame: 0,
        durationFrames: 5,
        data: {
          '0,0': { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
        },
      },
      {
        id: 'content-2',
        name: 'Two',
        startFrame: 5,
        durationFrames: 1,
        data: {},
      },
    ],
    propertyTracks: [],
  }],
  globalEffects: [],
};

describe('acknowledged frame navigation', () => {
  let transport: WebSocketServerTransport | undefined;
  let client: WebSocket | undefined;
  let requests: BrowserCommandRequest[];

  beforeEach(() => {
    resetProjectManager();
    setBrowserCommandCallback(null);
    setEnsureFreshStateCallback(null);
    requests = [];
  });

  afterEach(async () => {
    setBrowserCommandCallback(null);
    setEnsureFreshStateCallback(null);
    if (
      client
      && (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING)
    ) {
      const closed = once(client, 'close');
      client.close();
      await closed;
    }
    await transport?.close();
    client = undefined;
    transport = undefined;
  });

  async function connectBrowser(): Promise<void> {
    transport = new WebSocketServerTransport({
      port: 0,
      host: '127.0.0.1',
      authToken: 'test-token',
    });
    await transport.start();

    client = new WebSocket(`ws://127.0.0.1:${transport.port}/?token=test-token`);
    client.on('message', data => {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === 'command_request') {
        requests.push(message as BrowserCommandRequest);
      }
    });
    await once(client, 'open');

    setBrowserCommandCallback((command, timeoutMs, afterAcknowledged, prepareCommand) => {
      return transport!.requestBrowserCommand(
        command,
        timeoutMs,
        afterAcknowledged,
        prepareCommand,
      );
    });
  }

  function addFrames(total: number): void {
    const pm = getProjectManager();
    while (pm.getState().frames.length < total) {
      pm.addFrame();
    }
  }

  function acknowledge(
    request: BrowserCommandRequest,
    applied?: BrowserCommandApplied,
  ): void {
    client!.send(JSON.stringify(successResult(request.requestId, applied)));
  }

  it('holds an immediately following paste until delayed navigation is confirmed', async () => {
    addFrames(2);
    await connectBrowser();
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;
    const pasteAscii = captureTools(registerCanvasTools).get('paste_ascii_block')!;
    const pm = getProjectManager();

    const navigation = goToFrame({ index: 1 });
    const paste = pasteAscii(pasteArgs('X', 0));

    await waitFor(() => requests.length === 1);
    expect(requests[0].command).toEqual({ type: 'go_to_frame', index: 1 });
    expect(pm.getState().currentFrameIndex).toBe(0);
    expect(pm.getState().frames[1].data).toEqual({});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);

    acknowledge(requests[0], { currentFrameIndex: 1 });
    const navigationResponse = await navigation;
    await waitFor(() => requests.length === 2);
    expect(requests[1].command).toMatchObject({
      type: 'set_cells_batch',
      cells: [{
        x: 0,
        y: 0,
        cell: { char: 'X', color: '#FFFFFF', bgColor: 'transparent' },
      }],
    });
    expect(requests[1].command).not.toHaveProperty('frameIndex');
    expect(pm.getState().frames[1].data).toEqual({});

    acknowledge(requests[1], { currentFrameIndex: 1, cellsChanged: 1 });
    const pasteResponse = await paste;

    expect(responseBody(navigationResponse)).toMatchObject({
      success: true,
      browserSynced: true,
      currentFrame: { index: 1 },
    });
    expect(responseBody(pasteResponse)).toMatchObject({
      success: true,
      browserSynced: true,
      frameIndex: 1,
      charsPasted: 1,
    });
    expect(pm.getState().currentFrameIndex).toBe(1);
    expect(pm.getState().frames[1].data).toMatchObject({
      '0,0': { char: 'X' },
    });
    expect(pm.getState().frames[0].data).toEqual({});
  });

  it('reconciles a targetless batch by timeline position with non-unit frame durations', async () => {
    const pm = getProjectManager();
    pm.loadFromUnknownSessionData(nonUnitDurationProject);
    await connectBrowser();
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;
    const pasteAscii = captureTools(registerCanvasTools).get('paste_ascii_block')!;

    const navigation = goToFrame({ index: 5 });
    const paste = pasteAscii(pasteArgs('X', 1));

    await waitFor(() => requests.length === 1);
    expect(requests[0].command).toEqual({ type: 'go_to_frame', index: 5 });
    acknowledge(requests[0], { currentFrameIndex: 5 });
    await navigation;

    await waitFor(() => requests.length === 2);
    expect(requests[1].command).not.toHaveProperty('frameIndex');
    acknowledge(requests[1], { currentFrameIndex: 5, cellsChanged: 1 });
    const pasteResponse = await paste;

    expect(responseBody(pasteResponse)).toMatchObject({
      success: true,
      browserSynced: true,
      frameIndex: 5,
      charsPasted: 1,
    });
    expect(pm.getState().layers[0].contentFrames[0].data).toMatchObject({
      '0,0': { char: 'A' },
    });
    expect(pm.getState().layers[0].contentFrames[0].data).not.toHaveProperty('1,0');
    expect(pm.getState().layers[0].contentFrames[1].data).toMatchObject({
      '1,0': { char: 'X' },
    });
  });

  it('resolves partial cell values after preceding navigation reconciliation', async () => {
    addFrames(2);
    const pm = getProjectManager();
    pm.setCellsOnFrame(0, [{
      x: 0,
      y: 0,
      cell: { char: 'A', color: '#FF0000', bgColor: '#111111' },
    }]);
    pm.setCellsOnFrame(1, [{
      x: 0,
      y: 0,
      cell: { char: 'B', color: '#00FF00', bgColor: '#222222' },
    }]);
    await connectBrowser();
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;
    const setCell = captureTools(registerCanvasTools).get('set_cell')!;

    const navigation = goToFrame({ index: 1 });
    const mutation = setCell({ x: 0, y: 0, char: 'X' });

    await waitFor(() => requests.length === 1);
    acknowledge(requests[0], { currentFrameIndex: 1 });
    await navigation;
    await waitFor(() => requests.length === 2);
    expect(requests[1].command).toEqual({
      type: 'set_cells_batch',
      cells: [{
        x: 0,
        y: 0,
        cell: { char: 'X', color: '#00FF00', bgColor: '#222222' },
      }],
    });

    acknowledge(requests[1], { currentFrameIndex: 1, cellsChanged: 1 });
    await mutation;

    expect(pm.getState().frames[0].data['0,0']).toEqual({
      char: 'A',
      color: '#FF0000',
      bgColor: '#111111',
    });
    expect(pm.getState().frames[1].data['0,0']).toEqual({
      char: 'X',
      color: '#00FF00',
      bgColor: '#222222',
    });
  });

  it('reserves the FIFO slot before asynchronous clear preparation', async () => {
    addFrames(2);
    const pm = getProjectManager();
    pm.setCellsOnFrame(0, [{
      x: 0,
      y: 0,
      cell: { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
    }]);
    let finishRefresh: (() => void) | undefined;
    const refresh = new Promise<void>(resolve => {
      finishRefresh = resolve;
    });
    setEnsureFreshStateCallback(async () => {
      await refresh;
      return true;
    });
    await connectBrowser();
    const clearCanvas = captureTools(registerCanvasTools).get('clear_canvas')!;
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;

    const clear = clearCanvas({});
    const navigation = goToFrame({ index: 1 });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests).toHaveLength(0);
    finishRefresh!();

    await waitFor(() => requests.length === 1);
    expect(requests[0].command.type).toBe('set_cells_batch');
    acknowledge(requests[0], { currentFrameIndex: 0, cellsChanged: 1 });
    await clear;

    await waitFor(() => requests.length === 2);
    expect(requests[1].command).toEqual({ type: 'go_to_frame', index: 1 });
    acknowledge(requests[1], { currentFrameIndex: 1 });
    await navigation;

    expect(pm.getState().frames[0].data).toEqual({});
    expect(pm.getState().currentFrameIndex).toBe(1);
  });

  it('evaluates mutation bounds after a preceding resize is acknowledged', async () => {
    await connectBrowser();
    const resizeCanvas = captureTools(registerCanvasTools).get('resize_canvas')!;
    const setCell = captureTools(registerCanvasTools).get('set_cell')!;
    const pm = getProjectManager();

    const resize = resizeCanvas({ width: 100, height: 24 });
    const mutation = setCell({ x: 90, y: 0, char: 'X' });

    await waitFor(() => requests.length === 1);
    expect(requests[0].command).toEqual({
      type: 'resize_canvas',
      width: 100,
      height: 24,
    });
    expect(pm.getState().width).toBe(80);
    acknowledge(requests[0]);
    await resize;

    await waitFor(() => requests.length === 2);
    expect(requests[1].command).toEqual({
      type: 'set_cells_batch',
      cells: [{
        x: 90,
        y: 0,
        cell: { char: 'X', color: '#FFFFFF', bgColor: 'transparent' },
      }],
    });
    acknowledge(requests[1], { currentFrameIndex: 0, cellsChanged: 1 });
    const response = await mutation;

    expect(response.isError).toBeUndefined();
    expect(pm.getState().frames[0].data).toMatchObject({
      '90,0': { char: 'X' },
    });
  });

  it('clears the captured frame before later local-only navigation', async () => {
    addFrames(2);
    const pm = getProjectManager();
    pm.setCellsOnFrame(0, [{
      x: 0,
      y: 0,
      cell: { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
    }]);
    pm.setCellsOnFrame(1, [{
      x: 1,
      y: 0,
      cell: { char: 'B', color: '#FFFFFF', bgColor: 'transparent' },
    }]);
    const clearCanvas = captureTools(registerCanvasTools).get('clear_canvas')!;
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;

    const clear = clearCanvas({});
    const navigation = goToFrame({ index: 1 });
    const [clearResponse] = await Promise.all([clear, navigation]);

    expect(clearResponse.isError).toBeUndefined();
    expect(responseBody(clearResponse)).toMatchObject({
      success: true,
      browserSynced: false,
      frameIndex: 0,
      cellsCleared: 1,
    });
    expect(pm.getState().frames[0].data).toEqual({});
    expect(pm.getState().frames[1].data).toMatchObject({
      '1,0': { char: 'B' },
    });
    expect(pm.getState().currentFrameIndex).toBe(1);
  });

  it('applies local-only navigation before a following paste starts', async () => {
    addFrames(2);
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;
    const pasteAscii = captureTools(registerCanvasTools).get('paste_ascii_block')!;

    const navigation = goToFrame({ index: 1 });
    const paste = pasteAscii(pasteArgs('X', 0));
    const [navigationResponse, pasteResponse] = await Promise.all([navigation, paste]);

    expect(navigationResponse.isError).toBeUndefined();
    expect(pasteResponse.isError).toBeUndefined();
    expect(responseBody(pasteResponse)).toMatchObject({
      browserSynced: false,
      frameIndex: 1,
      charsPasted: 1,
    });
    const state = getProjectManager().getState();
    expect(state.frames[0].data).toEqual({});
    expect(state.frames[1].data).toMatchObject({
      '0,0': { char: 'X' },
    });
  });

  it('applies local-only resize before a following bounds check', async () => {
    const resizeCanvas = captureTools(registerCanvasTools).get('resize_canvas')!;
    const setCell = captureTools(registerCanvasTools).get('set_cell')!;

    const resize = resizeCanvas({ width: 100, height: 24 });
    const mutation = setCell({ x: 90, y: 0, char: 'X' });
    const [resizeResponse, mutationResponse] = await Promise.all([resize, mutation]);

    expect(resizeResponse.isError).toBeUndefined();
    expect(mutationResponse.isError).toBeUndefined();
    expect(responseBody(mutationResponse)).toMatchObject({
      browserSynced: false,
      frameIndex: 0,
    });
    const state = getProjectManager().getState();
    expect(state.width).toBe(100);
    expect(state.frames[0].data).toMatchObject({
      '90,0': { char: 'X' },
    });
  });

  it('preserves concurrent arrival order across rapid alternating frames', async () => {
    addFrames(4);
    await connectBrowser();
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;
    const pasteAscii = captureTools(registerCanvasTools).get('paste_ascii_block')!;

    const responses = [
      goToFrame({ index: 1 }),
      pasteAscii(pasteArgs('A', 0)),
      goToFrame({ index: 2 }),
      pasteAscii(pasteArgs('B', 1)),
      goToFrame({ index: 3 }),
      pasteAscii(pasteArgs('C', 2)),
      goToFrame({ index: 1 }),
      pasteAscii(pasteArgs('D', 3)),
    ];
    const expected = [
      { type: 'go_to_frame', frameIndex: 1 },
      { type: 'set_cells_batch', frameIndex: 1 },
      { type: 'go_to_frame', frameIndex: 2 },
      { type: 'set_cells_batch', frameIndex: 2 },
      { type: 'go_to_frame', frameIndex: 3 },
      { type: 'set_cells_batch', frameIndex: 3 },
      { type: 'go_to_frame', frameIndex: 1 },
      { type: 'set_cells_batch', frameIndex: 1 },
    ];

    let browserFrameIndex = 0;
    for (const [requestIndex, expectedCommand] of expected.entries()) {
      await waitFor(() => requests.length === requestIndex + 1);
      const request = requests[requestIndex];
      expect(request.command.type).toBe(expectedCommand.type);

      if (request.command.type === 'go_to_frame') {
        expect(request.command.index).toBe(expectedCommand.frameIndex);
        browserFrameIndex = expectedCommand.frameIndex;
        acknowledge(request, { currentFrameIndex: browserFrameIndex });
      } else {
        expect(request.command).not.toHaveProperty('frameIndex');
        expect(browserFrameIndex).toBe(expectedCommand.frameIndex);
        acknowledge(request, {
          currentFrameIndex: browserFrameIndex,
          cellsChanged: 1,
        });
      }
    }

    await Promise.all(responses);
    const state = getProjectManager().getState();
    expect(state.currentFrameIndex).toBe(1);
    expect(state.frames[1].data).toMatchObject({
      '0,0': { char: 'A' },
      '3,0': { char: 'D' },
    });
    expect(state.frames[2].data).toMatchObject({
      '1,0': { char: 'B' },
    });
    expect(state.frames[3].data).toMatchObject({
      '2,0': { char: 'C' },
    });
  });

  it('reports a wrong applied frame index and reconciles to browser truth', async () => {
    addFrames(3);
    await connectBrowser();
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;

    const responsePromise = goToFrame({ index: 1 });
    await waitFor(() => requests.length === 1);
    acknowledge(requests[0], { currentFrameIndex: 2 });
    const response = await responsePromise;

    expect(response.isError).toBe(true);
    expect(responseBody(response)).toEqual({
      success: false,
      error: 'Browser applied frame index 2 instead of requested index 1',
    });
    expect(getProjectManager().getState().currentFrameIndex).toBe(2);
  });

  it('surfaces browser rejection without optimistic local navigation', async () => {
    addFrames(2);
    setBrowserCommandCallback(async () => ({
      type: 'command_result',
      requestId: 'rejected-navigation',
      success: false,
      error: 'Browser rejected frame navigation',
    }));
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;

    const response = await goToFrame({ index: 1 });

    expect(response.isError).toBe(true);
    expect(responseBody(response)).toEqual({
      success: false,
      error: 'Browser rejected frame navigation',
    });
    expect(getProjectManager().getState().currentFrameIndex).toBe(0);
  });

  it('surfaces navigation timeout without optimistic local navigation', async () => {
    addFrames(2);
    setBrowserCommandCallback(async () => {
      throw new Error('Browser command "go_to_frame" timed out after 5000ms');
    });
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;

    const response = await goToFrame({ index: 1 });

    expect(response.isError).toBe(true);
    expect(responseBody(response)).toEqual({
      success: false,
      error: 'Browser command "go_to_frame" timed out after 5000ms',
    });
    expect(getProjectManager().getState().currentFrameIndex).toBe(0);
  });

  it('preserves local-only navigation behavior without claiming browser sync', async () => {
    addFrames(2);
    const goToFrame = captureTools(registerFrameTools).get('go_to_frame')!;

    const response = await goToFrame({ index: 1 });

    expect(response.isError).toBeUndefined();
    expect(responseBody(response)).toMatchObject({
      success: true,
      browserSynced: false,
      currentFrame: { index: 1 },
    });
    expect(getProjectManager().getState().currentFrameIndex).toBe(1);
  });
});
