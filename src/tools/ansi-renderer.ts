import type { CanvasData, Frame } from '../types.js';
import { parseCellKey } from '../types.js';

export const ANSI_RESET = '\x1b[0m';

export type AnsiColorMode = '16' | '256' | 'truecolor';

export interface AnsiRenderOptions {
  colorMode: AnsiColorMode;
  canvasBackground: string;
  maxWidth?: number;
  trimEmpty?: boolean;
}

export interface AnsiFrameRender {
  ansi: string;
  width: number;
  height: number;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface AnsiFrameSelection {
  index: number;
  frame: Pick<Frame, 'name' | 'data'>;
}

interface RenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function frameToAnsi(
  data: CanvasData,
  width: number,
  height: number,
  options: AnsiRenderOptions
): AnsiFrameRender {
  const bounds = getRenderBounds(data, width, height, options.trimEmpty ?? false);
  if (bounds.width === 0 || bounds.height === 0) {
    return { ansi: ANSI_RESET, width: 0, height: 0, bounds };
  }

  const outputWidth = options.maxWidth !== undefined && bounds.width > options.maxWidth
    ? Math.max(1, Math.floor(options.maxWidth))
    : bounds.width;
  const scale = outputWidth / bounds.width;
  const outputHeight = outputWidth < bounds.width
    ? Math.max(1, Math.round(bounds.height * scale))
    : bounds.height;

  const lines: string[] = [];
  for (let outputY = 0; outputY < outputHeight; outputY++) {
    const sourceY = bounds.y + nearestNeighborIndex(outputY, outputHeight, bounds.height);
    let line = '';
    let activeStyle = '';

    for (let outputX = 0; outputX < outputWidth; outputX++) {
      const sourceX = bounds.x + nearestNeighborIndex(outputX, outputWidth, bounds.width);
      const cell = data[`${sourceX},${sourceY}`];
      const foreground = cell?.color ?? '#FFFFFF';
      const background = cell?.bgColor === 'transparent' || !cell
        ? options.canvasBackground
        : cell.bgColor;
      const style = ansiStyle(foreground, background, options.colorMode);

      if (style !== activeStyle) {
        line += style;
        activeStyle = style;
      }
      line += sanitizeCellChar(cell?.char);
    }

    lines.push(line + ANSI_RESET);
  }

  return {
    ansi: ANSI_RESET + lines.join('\n'),
    width: outputWidth,
    height: outputHeight,
    bounds,
  };
}

export function framesToAnsi(
  frames: readonly AnsiFrameSelection[],
  width: number,
  height: number,
  options: AnsiRenderOptions,
  includeSeparators: boolean
): string {
  if (frames.length === 0) return ANSI_RESET;

  return frames.map(({ frame, index }) => {
    const rendered = frameToAnsi(frame.data, width, height, options).ansi;
    if (!includeSeparators) return rendered;

    const name = sanitizeTerminalText(frame.name);
    return `${ANSI_RESET}=== Frame ${index + 1}: ${name} ===${ANSI_RESET}\n${rendered}`;
  }).join('\n');
}

export function sanitizeTerminalText(value: string): string {
  return Array.from(value, char => isTerminalControl(char) ? '?' : char).join('');
}

function sanitizeCellChar(value: string | undefined): string {
  const char = Array.from(value ?? ' ')[0] ?? ' ';
  return isTerminalControl(char) ? '?' : char;
}

function isTerminalControl(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined
    && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
}

function getRenderBounds(
  data: CanvasData,
  width: number,
  height: number,
  trimEmpty: boolean
): RenderBounds {
  if (!trimEmpty) {
    return { x: 0, y: 0, width, height };
  }

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (const [key, cell] of Object.entries(data)) {
    if (sanitizeCellChar(cell.char) === ' ' && cell.bgColor === 'transparent') {
      continue;
    }
    const { x, y } = parseCellKey(key);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height) {
      continue;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function nearestNeighborIndex(outputIndex: number, outputSize: number, sourceSize: number): number {
  return Math.min(
    sourceSize - 1,
    Math.floor(((outputIndex + 0.5) * sourceSize) / outputSize)
  );
}

function ansiStyle(foreground: string, background: string, colorMode: AnsiColorMode): string {
  if (colorMode === 'truecolor') {
    const fg = hexToRgb(foreground);
    const bg = hexToRgb(background);
    return `\x1b[38;2;${fg.r};${fg.g};${fg.b}m\x1b[48;2;${bg.r};${bg.g};${bg.b}m`;
  }

  if (colorMode === '256') {
    return `\x1b[38;5;${hexTo256(foreground)}m\x1b[48;5;${hexTo256(background)}m`;
  }

  return `\x1b[${hexTo16Fg(foreground)}m\x1b[${hexTo16Bg(background)}m`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : { r: 255, g: 255, b: 255 };
}

function hexTo256(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

function hexTo16Fg(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const brightness = (r + g + b) / 3;
  const isBright = brightness > 127;

  if (r > 200 && g < 100 && b < 100) return isBright ? 91 : 31;
  if (r < 100 && g > 200 && b < 100) return isBright ? 92 : 32;
  if (r > 200 && g > 200 && b < 100) return isBright ? 93 : 33;
  if (r < 100 && g < 100 && b > 200) return isBright ? 94 : 34;
  if (r > 200 && g < 100 && b > 200) return isBright ? 95 : 35;
  if (r < 100 && g > 200 && b > 200) return isBright ? 96 : 36;
  if (brightness > 200) return 97;
  if (brightness < 50) return 30;
  return isBright ? 37 : 90;
}

function hexTo16Bg(hex: string): number {
  return hexTo16Fg(hex) + 10;
}
