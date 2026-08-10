import { describe, expect, it } from 'vitest';
import type { CanvasData, Frame } from '../types.js';
import {
  ANSI_RESET,
  frameToAnsi,
} from './ansi-renderer.js';
import {
  getCanvasRender,
  MAX_CANVAS_RENDER_FRAMES,
  MAX_CANVAS_RENDER_OUTPUT_BYTES,
  type CanvasRenderState,
} from './preview.js';

const ESC = '\x1b';
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function makeFrame(name: string, data: CanvasData): Frame {
  return {
    id: name,
    name,
    duration: 100,
    data,
  };
}

function makeState(frames: Frame[], currentFrameIndex = 0): CanvasRenderState {
  return {
    width: 1,
    height: 1,
    backgroundColor: '#000000',
    frames,
    currentFrameIndex,
  };
}

function textOf(result: Awaited<ReturnType<typeof getCanvasRender>>): string {
  return result.content[0]?.text ?? '';
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

describe('frameToAnsi', () => {
  it('emits exact truecolor foreground and cell background sequences', () => {
    const rendered = frameToAnsi(
      {
        '0,0': { char: 'X', color: '#112233', bgColor: '#445566' },
      },
      1,
      1,
      { colorMode: 'truecolor', canvasBackground: '#000000' }
    );

    expect(rendered.ansi).toBe(
      `${ANSI_RESET}${ESC}[38;2;17;34;51m${ESC}[48;2;68;85;102mX${ANSI_RESET}`
    );
  });

  it('emits exact 256-color foreground and background sequences', () => {
    const rendered = frameToAnsi(
      {
        '0,0': { char: 'X', color: '#FF0000', bgColor: '#0000FF' },
      },
      1,
      1,
      { colorMode: '256', canvasBackground: '#000000' }
    );

    expect(rendered.ansi).toBe(
      `${ANSI_RESET}${ESC}[38;5;196m${ESC}[48;5;21mX${ANSI_RESET}`
    );
  });

  it('emits exact 16-color foreground and background sequences', () => {
    const rendered = frameToAnsi(
      {
        '0,0': { char: 'X', color: '#FF0000', bgColor: '#0000FF' },
      },
      1,
      1,
      { colorMode: '16', canvasBackground: '#000000' }
    );

    expect(rendered.ansi).toBe(`${ANSI_RESET}${ESC}[31m${ESC}[44mX${ANSI_RESET}`);
  });

  it('uses the project background for transparent and missing cells', () => {
    const rendered = frameToAnsi(
      {
        '0,0': { char: 'A', color: '#00FF00', bgColor: 'transparent' },
      },
      2,
      1,
      { colorMode: 'truecolor', canvasBackground: '#112233' }
    );

    expect(rendered.ansi).toBe(
      `${ANSI_RESET}${ESC}[38;2;0;255;0m${ESC}[48;2;17;34;51mA`
      + `${ESC}[38;2;255;255;255m${ESC}[48;2;17;34;51m ${ANSI_RESET}`
    );
  });

  it('resets SGR state at every row boundary and at the end', () => {
    const data: CanvasData = {};
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        data[`${x},${y}`] = {
          char: String.fromCharCode(65 + y * 2 + x),
          color: '#FFFFFF',
          bgColor: '#000000',
        };
      }
    }

    const rendered = frameToAnsi(data, 2, 2, {
      colorMode: '16',
      canvasBackground: '#000000',
    });
    const style = `${ESC}[97m${ESC}[40m`;

    expect(rendered.ansi).toBe(
      `${ANSI_RESET}${style}AB${ANSI_RESET}\n${style}CD${ANSI_RESET}`
    );
    expect(rendered.ansi.endsWith(ANSI_RESET)).toBe(true);
  });

  it('returns only a final reset for an empty trimmed canvas', () => {
    const trimmed = frameToAnsi({}, 3, 2, {
      colorMode: 'truecolor',
      canvasBackground: '#000000',
      trimEmpty: true,
    });
    const full = frameToAnsi({}, 3, 2, {
      colorMode: 'truecolor',
      canvasBackground: '#000000',
      trimEmpty: false,
    });

    expect(trimmed).toMatchObject({
      ansi: ANSI_RESET,
      width: 0,
      height: 0,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    });
    expect(full.width).toBe(3);
    expect(full.height).toBe(2);
    expect(stripAnsi(full.ansi)).toBe('   \n   ');
  });

  it('trims to the stored-cell bounds when requested', () => {
    const rendered = frameToAnsi(
      {
        '0,0': { char: ' ', color: '#FF0000', bgColor: 'transparent' },
        '2,1': { char: 'X', color: '#FFFFFF', bgColor: 'transparent' },
      },
      5,
      4,
      {
        colorMode: 'truecolor',
        canvasBackground: '#000000',
        trimEmpty: true,
      }
    );

    expect(rendered.bounds).toEqual({ x: 2, y: 1, width: 1, height: 1 });
    expect(rendered.width).toBe(1);
    expect(rendered.height).toBe(1);
    expect(stripAnsi(rendered.ansi)).toBe('X');
  });

  it('downsamples both grid dimensions with deterministic nearest-neighbor sampling', () => {
    const data: CanvasData = {};
    const chars = 'abcdefghijklmnop';
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        data[`${x},${y}`] = {
          char: chars[y * 4 + x],
          color: '#FFFFFF',
          bgColor: 'transparent',
        };
      }
    }

    const rendered = frameToAnsi(data, 4, 4, {
      colorMode: 'truecolor',
      canvasBackground: '#000000',
      maxWidth: 2,
    });

    expect(rendered.width).toBe(2);
    expect(rendered.height).toBe(2);
    expect(stripAnsi(rendered.ansi)).toBe('fh\nnp');
  });

  it('replaces C0, DEL, C1, and escape characters in cells', () => {
    const rendered = frameToAnsi(
      {
        '0,0': { char: '\x1b', color: '#FFFFFF', bgColor: '#000000' },
        '1,0': { char: '\n', color: '#FFFFFF', bgColor: '#000000' },
        '2,0': { char: '\x7f', color: '#FFFFFF', bgColor: '#000000' },
        '3,0': { char: '\u009b', color: '#FFFFFF', bgColor: '#000000' },
      },
      4,
      1,
      { colorMode: '16', canvasBackground: '#000000' }
    );

    const plainText = stripAnsi(rendered.ansi);
    expect(plainText).toBe('????');
    for (const char of plainText) {
      const codePoint = char.codePointAt(0) ?? 0;
      expect(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)).toBe(false);
    }
  });
});

describe('getCanvasRender', () => {
  it('returns actual ESC bytes in a raw MCP text item', async () => {
    const state = makeState([
      makeFrame('Current', {
        '0,0': { char: 'X', color: '#FFFFFF', bgColor: 'transparent' },
      }),
    ]);
    const result = await getCanvasRender(
      { colorMode: 'truecolor', trimEmpty: true },
      {
        ensureFreshState: async () => {},
        getState: () => state,
      }
    );
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(text).toContain('\x1b[');
    expect(text).not.toContain('\\u001b');
  });

  it('refreshes browser state before selecting and rendering the frame', async () => {
    let state = makeState([
      makeFrame('Stale', {
        '0,0': { char: 'S', color: '#FFFFFF', bgColor: 'transparent' },
      }),
    ]);
    let refreshCalls = 0;

    const result = await getCanvasRender(
      { trimEmpty: true },
      {
        ensureFreshState: async () => {
          refreshCalls++;
          state = makeState([
            makeFrame('Fresh', {
              '0,0': { char: 'F', color: '#FFFFFF', bgColor: 'transparent' },
            }),
          ]);
        },
        getState: () => state,
      }
    );

    expect(refreshCalls).toBe(1);
    expect(stripAnsi(textOf(result))).toBe('F');
  });

  it('selects a requested frame and separates all-frame renders with resets', async () => {
    const state = makeState([
      makeFrame('First', {
        '0,0': { char: 'A', color: '#FFFFFF', bgColor: 'transparent' },
      }),
      makeFrame('Second\x1b', {
        '0,0': { char: 'B', color: '#FFFFFF', bgColor: 'transparent' },
      }),
    ], 1);
    const dependencies = {
      ensureFreshState: async () => {},
      getState: () => state,
    };

    const selected = await getCanvasRender(
      { frameIndex: 0, trimEmpty: true },
      dependencies
    );
    const all = await getCanvasRender(
      { allFrames: true, trimEmpty: true },
      dependencies
    );
    const style = `${ESC}[38;2;255;255;255m${ESC}[48;2;0;0;0m`;

    expect(stripAnsi(textOf(selected))).toBe('A');
    expect(textOf(all)).toBe(
      `${ANSI_RESET}=== Frame 1: First ===${ANSI_RESET}\n${ANSI_RESET}${style}A${ANSI_RESET}\n`
      + `${ANSI_RESET}=== Frame 2: Second? ===${ANSI_RESET}\n${ANSI_RESET}${style}B${ANSI_RESET}`
    );
    expect(textOf(all).endsWith(ANSI_RESET)).toBe(true);
  });

  it('enforces mutual exclusion, frame, and output limits', async () => {
    const state = makeState([
      makeFrame('One', {
        '0,0': { char: '1', color: '#FFFFFF', bgColor: 'transparent' },
      }),
      makeFrame('Two', {
        '0,0': { char: '2', color: '#FFFFFF', bgColor: 'transparent' },
      }),
    ]);
    const dependencies = {
      ensureFreshState: async () => {},
      getState: () => state,
    };

    const conflicting = await getCanvasRender(
      { frameIndex: 0, allFrames: true },
      dependencies
    );
    const tooMany = await getCanvasRender(
      { allFrames: true },
      dependencies,
      { maxFrames: 1, maxOutputBytes: MAX_CANVAS_RENDER_OUTPUT_BYTES }
    );
    const tooLarge = await getCanvasRender(
      { frameIndex: 0 },
      dependencies,
      { maxFrames: MAX_CANVAS_RENDER_FRAMES, maxOutputBytes: 1 }
    );

    expect(conflicting.isError).toBe(true);
    expect(textOf(conflicting)).toContain('cannot be combined');
    expect(tooMany.isError).toBe(true);
    expect(textOf(tooMany)).toContain('limited to 1 frames');
    expect(tooLarge.isError).toBe(true);
    expect(textOf(tooLarge)).toContain('1-byte output limit');
    expect(MAX_CANVAS_RENDER_FRAMES).toBe(24);
    expect(MAX_CANVAS_RENDER_OUTPUT_BYTES).toBe(1024 * 1024);
  });
});
