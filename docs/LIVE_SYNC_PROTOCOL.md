# Live Browser Command Protocol

The acknowledged command channel is the reusable synchronization boundary for
MCP tools that must mutate the connected ASCII Motion browser. Legacy
`notifications/stateChanged` messages remain available for tools that have not
yet moved to this channel, but they do not provide delivery or application
guarantees.

## Wire types

```ts
interface BrowserCommand {
  type: string;
  [key: string]: unknown;
}

interface BrowserCommandRequest {
  type: 'command_request';
  requestId: string;
  command: BrowserCommand;
}

interface BrowserCommandApplied {
  currentFrameIndex?: number;
  cellsChanged?: number;
  frameRate?: number;
  durationMs?: number;
}

interface BrowserCommandResult {
  type: 'command_result';
  requestId: string;
  success: boolean;
  error?: string;
  applied?: BrowserCommandApplied;
}
```

The server generates a unique `requestId`. The browser must copy it exactly
into the final `command_result`. Results for unknown, late, or non-active
request IDs are ignored.

## Ordering and completion

Browser commands use one FIFO queue and permit only one in-flight command.
The next command is not sent until the current command is acknowledged and any
registered server-side reconciliation completes, or until it is rejected,
times out, or fails because the connection closes. This makes the browser's
applied order equal to the server's enqueue order.

The default acknowledgement timeout is 5 seconds and begins when a queued
command reaches the FIFO head, including any dispatch-time command preparation.
A timeout is indeterminate because the browser may still apply that command
after the server stops waiting. The server therefore rejects the entire queue,
closes the browser connection, and does not accept another mutation until a
reconnected browser sends a fresh state snapshot. Browser disconnect during an
in-flight command follows the same quarantine behavior. Transport shutdown
also rejects and removes both the in-flight request and every queued request.

A tool may report live success only after a matching result with
`success: true`. The following conditions are MCP tool errors and do not
optimistically mutate the MCP state mirror:

- no connected browser while live mode is configured;
- browser result with `success: false`;
- acknowledgement timeout;
- WebSocket send error;
- browser disconnect or transport shutdown before acknowledgement.

## Commands used by issue #153

```ts
type ExactCell = {
  x: number;
  y: number;
  cell: { char: string; color: string; bgColor: string };
};

type SetCellsBatchCommand = {
  type: 'set_cells_batch';
  frameIndex?: number;
  cells: ExactCell[];
};

type SetFrameRateCommand = {
  type: 'set_frame_rate';
  fps: number;
  preserveFrameCount: true;
};

type SetFrameDurationCommand = {
  type: 'set_frame_duration';
  index: number;
  duration: number;
};

type LoadProjectCommand = {
  type: 'load_project';
  sessionData: unknown;
};
```

`set_cells_batch` carries every changed coordinate and its final cell value.
Clears use the exact empty cell value:

```ts
{ char: ' ', color: '#FFFFFF', bgColor: 'transparent' }
```

An explicit `frameIndex` targets that active-layer content-frame entry without
navigating. When `frameIndex` is omitted, the browser resolves the current
timeline/playhead position when the command reaches the FIFO queue head. The
browser returns that timeline position in `applied.currentFrameIndex` so the MCP
mirror can update the same target.

`set_frame_rate` preserves the number of timeline frames and changes playback
speed only. `set_frame_duration` may be quantized or cause timeline reflow;
the browser returns the final value in `applied.durationMs`.

`load_project` sends the complete parsed session object. The browser must use
its version-aware v1/v2 loader, wait until all stores contain the loaded
project, then acknowledge. The MCP server requests a final state snapshot
after the acknowledgement to reconcile its mirror with browser-normalized
state.

## Batching and local-only mode

One logical exact-cell mutation is one command, not one command per cell.
Callers should clip cells to canvas bounds before enqueueing and include empty
cells when an operation clears content.

When live mode was never configured, command-backed tools retain headless
operation by updating only the MCP state mirror. Their result includes
`browserSynced: false`. Once live mode is configured, a missing or failed
browser connection is an error; it never falls back silently to local-only
success.
