import {
  ensureFreshBrowserState,
  getProjectManager,
  type ProjectStateManager,
} from './state.js';
import type { Cell } from './types.js';
import type {
  BrowserCommand,
  BrowserCommandFactory,
  BrowserCommandFinalizer,
  BrowserCommandResult,
} from './transport/websocket.js';

export type BrowserCommandCallback = (
  command: BrowserCommand,
  timeoutMs?: number,
  afterAcknowledged?: BrowserCommandFinalizer,
  prepareCommand?: BrowserCommandFactory,
) => Promise<BrowserCommandResult>;

export interface ExactCellChange {
  x: number;
  y: number;
  cell: Cell;
}

export interface ApplyExactCellChangesOptions {
  cells: ExactCellChange[] | (() => ExactCellChange[]);
  frameIndex?: number;
  timeoutMs?: number;
  projectManager?: ProjectStateManager;
  beforePrepare?: () => unknown | Promise<unknown>;
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
  prepareCommand?: BrowserCommandFactory,
): Promise<BrowserCommandResult | null> {
  if (!browserCommandCallback) return null;
  const result = await browserCommandCallback(
    command,
    timeoutMs,
    afterAcknowledged,
    prepareCommand,
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
  beforePrepare,
}: ApplyExactCellChangesOptions): Promise<ApplyExactCellChangesResult> {
  if (frameIndex !== undefined && !projectManager.hasCellFrame(frameIndex)) {
    throw new Error(`Frame index ${frameIndex} out of range`);
  }

  const cellFactory = typeof cells === 'function' ? cells : undefined;
  let resolvedCells: ExactCellChange[] | undefined = Array.isArray(cells)
    ? cells
    : undefined;
  let prepared = false;
  const resolveCells = (): ExactCellChange[] => {
    resolvedCells ??= cellFactory!();
    return resolvedCells;
  };
  const command: BrowserCommand = {
    type: 'set_cells_batch',
    cells: resolvedCells ?? [],
    ...(frameIndex === undefined ? {} : { frameIndex }),
  };
  let resolvedFrameIndex = frameIndex ?? projectManager.getState().currentFrameIndex;
  let localCount = 0;
  let reconciled = false;

  if (!browserCommandCallback) {
    localCount = frameIndex === undefined
      ? projectManager.setCellsAtTimelineFrame(resolvedFrameIndex, resolveCells())
      : projectManager.setCellsOnFrame(frameIndex, resolveCells());
    return {
      browserSynced: false,
      frameIndex: resolvedFrameIndex,
      cellsChanged: localCount,
    };
  }

  const reconcile = (acknowledgement: BrowserCommandResult): void => {
    if (reconciled) return;

    if (frameIndex !== undefined) {
      resolvedFrameIndex = frameIndex;
      localCount = projectManager.setCellsOnFrame(frameIndex, resolveCells());
    } else {
      const appliedFrameIndex = acknowledgement.applied?.currentFrameIndex;
      if (
        typeof appliedFrameIndex !== 'number'
        || !Number.isInteger(appliedFrameIndex)
        || !projectManager.hasTimelineCellFrame(appliedFrameIndex)
      ) {
        throw new Error(
          'Browser did not confirm a valid applied frame index for set_cells_batch',
        );
      }
      resolvedFrameIndex = appliedFrameIndex;
      localCount = projectManager.setCellsAtTimelineFrame(
        appliedFrameIndex,
        resolveCells(),
      );
    }

    reconciled = true;
  };

  const prepareCommand = cellFactory || beforePrepare
    ? async () => {
        if (!prepared) {
          await beforePrepare?.();
          prepared = true;
        }
        return {
          type: 'set_cells_batch',
          cells: resolveCells(),
          ...(frameIndex === undefined ? {} : { frameIndex }),
        };
      }
    : undefined;
  const result = await requestBrowserCommand(
    command,
    timeoutMs,
    reconcile,
    prepareCommand,
  );
  if (result === null) {
    throw new Error('Browser command callback was removed while applying cell changes');
  }
  if (!reconciled) {
    // Test and alternate callback implementations may not run the transport finalizer.
    if (!prepared) {
      await beforePrepare?.();
      prepared = true;
    }
    reconcile(result);
  }

  return {
    browserSynced: true,
    frameIndex: resolvedFrameIndex,
    cellsChanged: result?.applied?.cellsChanged ?? localCount,
    result,
  };
}
