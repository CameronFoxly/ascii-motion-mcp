import {
  ensureFreshBrowserState,
  getProjectManager,
  type ProjectStateManager,
} from './state.js';
import type { Cell } from './types.js';
import type {
  BrowserCommand,
  BrowserCommandFinalizer,
  BrowserCommandResult,
} from './transport/websocket.js';

export type BrowserCommandCallback = (
  command: BrowserCommand,
  timeoutMs?: number,
  afterAcknowledged?: BrowserCommandFinalizer,
) => Promise<BrowserCommandResult>;

export interface ExactCellChange {
  x: number;
  y: number;
  cell: Cell;
}

export interface ApplyExactCellChangesOptions {
  cells: ExactCellChange[];
  frameIndex?: number;
  timeoutMs?: number;
  projectManager?: ProjectStateManager;
}

export interface ApplyExactCellChangesResult {
  browserSynced: boolean;
  frameIndex: number;
  cellsChanged: number;
  result?: BrowserCommandResult;
}

let browserCommandCallback: BrowserCommandCallback | null = null;

export function setBrowserCommandCallback(callback: BrowserCommandCallback | null): void {
  browserCommandCallback = callback;
}

export function hasBrowserCommandCallback(): boolean {
  return browserCommandCallback !== null;
}

/**
 * Returns null only when the server is running locally without live mode.
 * Once live mode is configured, transport failures reject rather than falling
 * back to a success-shaped local result.
 */
export async function requestBrowserCommand(
  command: BrowserCommand,
  timeoutMs?: number,
  afterAcknowledged?: BrowserCommandFinalizer,
): Promise<BrowserCommandResult | null> {
  if (!browserCommandCallback) return null;
  const result = await browserCommandCallback(
    command,
    timeoutMs,
    afterAcknowledged,
  );
  if (!result.success) {
    throw new Error(result.error || `Browser rejected command "${command.type}"`);
  }
  return result;
}

export async function requireFreshBrowserState(): Promise<boolean> {
  if (!browserCommandCallback) return false;
  const refreshed = await ensureFreshBrowserState();
  if (!refreshed) {
    throw new Error('No browser connected or state refresh timed out');
  }
  return true;
}

/**
 * Apply a clipped batch of exact cell values. Live mode sends one browser
 * command and mutates the MCP mirror only after acknowledgement. Omitting
 * frameIndex intentionally leaves current-frame resolution to FIFO execution
 * in the browser.
 */
export async function applyExactCellChanges({
  cells,
  frameIndex,
  timeoutMs,
  projectManager = getProjectManager(),
}: ApplyExactCellChangesOptions): Promise<ApplyExactCellChangesResult> {
  if (frameIndex !== undefined && !projectManager.hasCellFrame(frameIndex)) {
    throw new Error(`Frame index ${frameIndex} out of range`);
  }

  const command: BrowserCommand = {
    type: 'set_cells_batch',
    cells,
    ...(frameIndex === undefined ? {} : { frameIndex }),
  };
  const result = await requestBrowserCommand(command, timeoutMs);
  const resolvedFrameIndex = frameIndex
    ?? result?.applied?.currentFrameIndex
    ?? projectManager.getState().currentFrameIndex;

  let localCount: number;
  if (frameIndex !== undefined) {
    localCount = projectManager.setCellsOnFrame(frameIndex, cells);
  } else if (result?.applied?.currentFrameIndex !== undefined) {
    localCount = projectManager.setCellsAtTimelineFrame(result.applied.currentFrameIndex, cells);
  } else {
    localCount = projectManager.setCells(cells);
  }

  return {
    browserSynced: result !== null,
    frameIndex: resolvedFrameIndex,
    cellsChanged: result?.applied?.cellsChanged ?? localCount,
    result: result ?? undefined,
  };
}
