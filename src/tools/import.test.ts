import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExactCellChange } from '../live-sync.js';
import { setBrowserCommandCallback } from '../live-sync.js';
import {
  ensureFreshBrowserState,
  getProjectManager,
  resetProjectManager,
  setEnsureFreshStateCallback,
} from '../state.js';
import type {
  BrowserCommand,
  BrowserCommandApplied,
  BrowserCommandResult,
} from '../transport/websocket.js';
import { registerImportTools } from './import.js';

const imageMocks = vi.hoisted(() => ({
  sharp: vi.fn(),
  jimpRead: vi.fn(),
  jimpIntToRGBA: vi.fn(),
}));

vi.mock('sharp', () => ({
  default: imageMocks.sharp,
}));

vi.mock('jimp', () => ({
  default: {
    read: imageMocks.jimpRead,
    intToRGBA: imageMocks.jimpIntToRGBA,
  },
}));

type ImageBackend = 'sharp' | 'jimp';
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

const PIXELS: Pixel[] = [
  { r: 0, g: 0, b: 0, a: 255 },
  { r: 255, g: 255, b: 255, a: 255 },
  { r: 0, g: 255, b: 0, a: 127 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 0, b: 255, a: 255 },
  { r: 128, g: 128, b: 128, a: 255 },
];

const EXPECTED_CELLS: ExactCellChange[] = [
  {
    x: 0,
    y: 0,
    cell: { char: 'A', color: '#000000', bgColor: '#000000' },
  },
  {
    x: 1,
    y: 0,
    cell: { char: 'B', color: '#ffffff', bgColor: '#ffffff' },
  },
  {
    x: 0,
    y: 1,
    cell: { char: 'A', color: '#ff0000', bgColor: '#ff0000' },
  },
  {
    x: 1,
    y: 1,
    cell: { char: 'A', color: '#0000ff', bgColor: '#0000ff' },
  },
  {
    x: 2,
    y: 1,
    cell: { char: 'A', color: '#808080', bgColor: '#808080' },
  },
];

const V2_PROJECT = {
  version: '2.0.0' as const,
  name: 'Timeline Project',
  canvas: {
    width: 8,
    height: 4,
    canvasBackgroundColor: '#000000',
    showGrid: true,
  },
  timeline: {
    frameRate: 10,
    durationFrames: 2,
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
        durationFrames: 1,
        data: {},
      },
      {
        id: 'content-2',
        name: 'Two',
        startFrame: 1,
        durationFrames: 1,
        data: {},
      },
    ],
    propertyTracks: [],
  }],
};

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

function successResult(applied?: BrowserCommandApplied): BrowserCommandResult {
  return {
    type: 'command_result',
    requestId: 'image-test',
    success: true,
    applied,
  };
}

function imageArguments(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filePath: 'image.png',
    targetWidth: 3,
    targetHeight: 2,
    charset: 'AB',
    colorMode: 'both',
    dithering: 'none',
    offsetX: 0,
    offsetY: 0,
    ...overrides,
  };
}

function configureBackend(
  backend: ImageBackend,
  pixels: Pixel[] = PIXELS,
  width = 3,
  height = 2,
): void {
  imageMocks.sharp.mockReset();
  imageMocks.jimpRead.mockReset();
  imageMocks.jimpIntToRGBA.mockReset();

  if (backend === 'sharp') {
    const image = {
      metadata: vi.fn().mockResolvedValue({ width: 30, height: 20 }),
      resize: vi.fn(),
      raw: vi.fn(),
      toBuffer: vi.fn().mockResolvedValue({
        data: Uint8Array.from(pixels.flatMap(pixel => [
          pixel.r,
          pixel.g,
          pixel.b,
          pixel.a,
        ])),
        info: { width, height, channels: 4 },
      }),
    };
    image.resize.mockReturnValue(image);
    image.raw.mockReturnValue(image);
    imageMocks.sharp.mockReturnValue(image);
    return;
  }

  imageMocks.sharp.mockImplementation(() => {
    throw new Error('sharp unavailable');
  });
  let renderedWidth = 30;
  let renderedHeight = 20;
  const image = {
    getWidth: vi.fn(() => renderedWidth),
    getHeight: vi.fn(() => renderedHeight),
    resize: vi.fn((nextWidth: number, nextHeight: number) => {
      renderedWidth = nextWidth;
      renderedHeight = nextHeight;
      return image;
    }),
    getPixelColor: vi.fn((x: number, y: number) => y * width + x),
  };
  imageMocks.jimpRead.mockResolvedValue(image);
  imageMocks.jimpIntToRGBA.mockImplementation((index: number) => pixels[index]);
}

function getCommandCells(command: BrowserCommand | undefined): ExactCellChange[] {
  if (!command || command.type !== 'set_cells_batch' || !Array.isArray(command.cells)) {
    throw new Error('Expected a set_cells_batch command');
  }
  return command.cells as ExactCellChange[];
}

describe.each<ImageBackend>(['sharp', 'jimp'])('import_image with %s', backend => {
  let projectDir: string;
  let previousProjectDir: string | undefined;
  let handler: ToolHandler;

  beforeEach(async () => {
    resetProjectManager();
    setBrowserCommandCallback(null);
    setEnsureFreshStateCallback(null);
    previousProjectDir = process.env.ASCII_MOTION_PROJECT_DIR;
    projectDir = await mkdtemp(join(tmpdir(), 'ascii-motion-image-test-'));
    process.env.ASCII_MOTION_PROJECT_DIR = projectDir;
    await writeFile(join(projectDir, 'image.png'), 'fixture', 'utf8');
    configureBackend(backend);
    handler = captureTools(registerImportTools).get('import_image')!;
  });

  afterEach(async () => {
    setBrowserCommandCallback(null);
    setEnsureFreshStateCallback(null);
    if (previousProjectDir === undefined) {
      delete process.env.ASCII_MOTION_PROJECT_DIR;
    } else {
      process.env.ASCII_MOTION_PROJECT_DIR = previousProjectDir;
    }
    await rm(projectDir, { recursive: true, force: true });
  });

  it('targets the browser-current frame with one exact acknowledged batch', async () => {
    const pm = getProjectManager();
    pm.addFrame();
    pm.goToFrame(1);
    let command: BrowserCommand | undefined;
    setEnsureFreshStateCallback(async () => true);
    setBrowserCommandCallback(async nextCommand => {
      command = nextCommand;
      return successResult({ currentFrameIndex: 1, cellsChanged: EXPECTED_CELLS.length });
    });

    const response = await handler(imageArguments());

    expect(command).toEqual({
      type: 'set_cells_batch',
      cells: EXPECTED_CELLS,
    });
    expect(pm.getState().currentFrameIndex).toBe(1);
    expect(pm.getState().frames[0].data).toEqual({});
    expect(pm.getState().frames[1].data).toMatchObject({
      '0,0': EXPECTED_CELLS[0].cell,
      '1,0': EXPECTED_CELLS[1].cell,
      '0,1': EXPECTED_CELLS[2].cell,
      '1,1': EXPECTED_CELLS[3].cell,
      '2,1': EXPECTED_CELLS[4].cell,
    });
    expect(responseBody(response)).toMatchObject({
      success: true,
      browserSynced: true,
      frameIndex: 1,
      cellsCreated: EXPECTED_CELLS.length,
    });
    expect(imageMocks.sharp).toHaveBeenCalledOnce();
    expect(imageMocks.jimpRead).toHaveBeenCalledTimes(backend === 'jimp' ? 1 : 0);
  });

  it('targets an explicit inactive layer frame without navigating', async () => {
    const pm = getProjectManager();
    pm.loadFromUnknownSessionData(V2_PROJECT);
    let command: BrowserCommand | undefined;
    setEnsureFreshStateCallback(async () => true);
    setBrowserCommandCallback(async nextCommand => {
      command = nextCommand;
      expect(pm.getState().currentFrameIndex).toBe(0);
      return successResult({ currentFrameIndex: 1, cellsChanged: EXPECTED_CELLS.length });
    });

    const response = await handler(imageArguments({ frameIndex: 1 }));

    expect(command).toEqual({
      type: 'set_cells_batch',
      frameIndex: 1,
      cells: EXPECTED_CELLS,
    });
    expect(pm.getState().currentFrameIndex).toBe(0);
    expect(pm.getState().layers[0].contentFrames[0].data).toEqual({});
    expect(pm.getState().layers[0].contentFrames[1].data).toMatchObject({
      '0,0': EXPECTED_CELLS[0].cell,
      '1,0': EXPECTED_CELLS[1].cell,
    });
    expect(responseBody(response)).toMatchObject({
      success: true,
      frameIndex: 1,
      cellsCreated: EXPECTED_CELLS.length,
    });
  });

  it.each([
    {
      name: 'negative top-left offsets',
      offsetX: -1,
      offsetY: -1,
      expected: [
        {
          x: 0,
          y: 0,
          cell: { char: 'A', color: '#0000ff', bgColor: '#0000ff' },
        },
        {
          x: 1,
          y: 0,
          cell: { char: 'A', color: '#808080', bgColor: '#808080' },
        },
      ],
    },
    {
      name: 'positive bottom-right offsets',
      offsetX: 3,
      offsetY: 3,
      expected: [{
        x: 3,
        y: 3,
        cell: { char: 'A', color: '#000000', bgColor: '#000000' },
      }],
    },
  ])('clips $name before submitting the batch', async ({ offsetX, offsetY, expected }) => {
    const pm = getProjectManager();
    pm.resizeCanvas(4, 4);
    let command: BrowserCommand | undefined;
    setEnsureFreshStateCallback(async () => true);
    setBrowserCommandCallback(async nextCommand => {
      command = nextCommand;
      return successResult({ currentFrameIndex: 0, cellsChanged: expected.length });
    });

    const response = await handler(imageArguments({ offsetX, offsetY }));

    expect(command).toEqual({
      type: 'set_cells_batch',
      cells: expected,
    });
    expect(responseBody(response)).toMatchObject({
      success: true,
      cellsCreated: expected.length,
    });
  });

  it('returns an error and leaves local state unchanged on browser rejection', async () => {
    setEnsureFreshStateCallback(async () => true);
    setBrowserCommandCallback(async () => ({
      type: 'command_result',
      requestId: 'image-rejected',
      success: false,
      error: 'Browser rejected image batch',
    }));

    const response = await handler(imageArguments());

    expect(response.isError).toBe(true);
    expect(responseBody(response)).toMatchObject({
      success: false,
      error: 'Browser rejected image batch',
    });
    expect(getProjectManager().getState().frames[0].data).toEqual({});
    expect(imageMocks.jimpRead).toHaveBeenCalledTimes(backend === 'jimp' ? 1 : 0);
  });

  it('returns an error and does not retry decoding on acknowledgement timeout', async () => {
    setEnsureFreshStateCallback(async () => true);
    setBrowserCommandCallback(async () => {
      throw new Error('Browser command "set_cells_batch" timed out after 5000ms');
    });

    const response = await handler(imageArguments());

    expect(response.isError).toBe(true);
    expect(responseBody(response)).toMatchObject({
      success: false,
      error: 'Browser command "set_cells_batch" timed out after 5000ms',
    });
    expect(getProjectManager().getState().frames[0].data).toEqual({});
    expect(imageMocks.sharp).toHaveBeenCalledOnce();
    expect(imageMocks.jimpRead).toHaveBeenCalledTimes(backend === 'jimp' ? 1 : 0);
  });

  it('persists the acknowledged batch after refreshing browser state', async () => {
    const pm = getProjectManager();
    let browserData: Record<string, ExactCellChange['cell']> = {};
    let refreshCount = 0;
    setEnsureFreshStateCallback(async () => {
      refreshCount++;
      if (refreshCount > 1) {
        pm.loadFromBrowserSnapshot({
          canvas: { width: 80, height: 24 },
          animation: {
            frames: [{
              id: 'browser-frame',
              name: 'Frame 1',
              duration: 100,
              data: browserData,
            }],
            currentFrameIndex: 0,
          },
        });
      }
      return true;
    });
    setBrowserCommandCallback(async command => {
      browserData = Object.fromEntries(
        getCommandCells(command).map(({ x, y, cell }) => [`${x},${y}`, cell]),
      );
      return successResult({ currentFrameIndex: 0, cellsChanged: EXPECTED_CELLS.length });
    });

    const response = await handler(imageArguments());
    expect(response.isError).not.toBe(true);
    pm.clearCanvas(false);
    expect(pm.getState().frames[0].data).toEqual({});

    await ensureFreshBrowserState();

    expect(pm.getState().frames[0].data).toEqual(browserData);
    expect(Object.keys(browserData)).toHaveLength(EXPECTED_CELLS.length);
  });

  it('submits an acknowledged empty batch for a fully transparent image', async () => {
    configureBackend(
      backend,
      PIXELS.map(pixel => ({ ...pixel, a: 0 })),
    );
    let command: BrowserCommand | undefined;
    setEnsureFreshStateCallback(async () => true);
    setBrowserCommandCallback(async nextCommand => {
      command = nextCommand;
      return successResult({ currentFrameIndex: 0, cellsChanged: 0 });
    });

    const response = await handler(imageArguments());

    expect(command).toEqual({
      type: 'set_cells_batch',
      cells: [],
    });
    expect(responseBody(response)).toMatchObject({
      success: true,
      cellsCreated: 0,
    });
  });
});
