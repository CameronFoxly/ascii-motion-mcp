# Live browser bridge v3

The app is authoritative. `src/contract/bridge-contract.json` is generated in
the app from `src/mcp/contract/operations.ts`, then bundled here using
`npm run sync:bridge-contract`. Both sides validate against the same schemas.
Do not hand-maintain a second command union or effect/property catalog.

## Connection and ownership

The MCP host owns one stdio server process and its loopback WebSocket listener.
Use that process's `get_auth_token` and `get_connection_status` to connect the
browser. Authentication is required; never put the token in a fixture or commit.

The first authenticated browser connection owns the document. A second tab
cannot inject snapshots or acknowledgements. When the owner disconnects, other
tabs must reconnect rather than silently becoming authoritative.

After authentication the browser sends `hello`, containing protocol/version and
contract hash, app version, document identity/revision and supported operations.
The MCP rejects a different contract hash before dispatch. Install matching
builds instead of retrying an edit against an incompatible response schema.
The MCP must not infer capabilities from an old snapshot. A legacy app without
v3 negotiation receives an actionable upgrade error for live tools.

## Requests and results

Canonical operations use the existing acknowledged channel:

```ts
// MCP -> app
{
  type: "command_request",
  protocolVersion: 3,
  requestId: "<unique request ID>",
  expectedRevision: 12, // optional optimistic concurrency guard
  command: { type: "update_layer", layerId: "<stable ID>", name: "Title" }
}

// app -> MCP
{
  type: "command_result",
  requestId: "<same request ID>",
  success: true,
  applied: { ids: { layerId: "<stable ID>" }, revision: 13, documentId: "<ID>" },
  revision: 13,
  documentId: "<ID>"
}
```

On failure, `success` is false and `error` remains a string for compatibility;
`errorCode` and optional `errorDetails` carry structured diagnostics.

The app also accepts `op_request {requestId, op, input, expectedRevision?}` and
returns `op_result`. These are alternate wire envelopes over the same registry,
not separate implementations.

Canonical requests always set `protocolVersion: 3`; overlapping legacy names
must not accidentally take an older adapter route. Public canonical MCP tools
accept `expectedRevision` as a transport guard, not an operation input field.
Their result envelope retains `revision` and `documentId`, including for reads
whose domain-specific result omits those fields.

Read results are operation-specific:

- `get_document`: `{document, documentId, revision}`, with the complete native
  session, not a composited frame cache.
- `get_document_summary`: compact identity, canvas, typography, timeline,
  layers/groups, content-frame metadata, effects/shaders, selection and history.
- `read_cells`: a scoped timeline sample with `region`, `format`, `cellCount`
  and text rows or absolute-coordinate cells.
- `export`: `{artifact:{filename,mimeType,encoding,bytes,data}, result}`.
  Artifact bytes cross loopback but are saved on the MCP side, not echoed into
  the model or downloaded by the browser.

`tools/list` exposes schema-derived canonical tools. Existing names are adapted
explicitly; an `app_` prefix resolves name collisions with old input shapes.

## Time and targets

Every new `frame`, `startFrame` and `durationFrames` is an absolute zero-based
integer timeline position/span. Content-frame IDs address editable holds;
content-frame array positions are never timeline positions.

Cell edits default to the active layer and the content frame covering the
playhead. A missing hold returns `NOT_FOUND`; callers must explicitly request
`createIfMissing` where supported. Locked/generated-layer restrictions are
enforced by the app. Erasure uses `{x,y,clear:true}`.

Cell reads can sample the compositor, including transforms, procedural effects
and generators, or inspect a specific layer/content frame. Raster shaders do
not become character-cell data.

Compatibility frame-index tools retain their declared ordinal semantics and
translate them to stable IDs before applying edits. Preview/playhead frame
indices are timeline positions. Do not forward one kind of index into another.

## Ordering, history and conflicts

One FIFO queue serves correlated commands. A mutation succeeds only after its
acknowledgement and result validation. Each successful mutation produces one
undo entry; failed operations roll back document and history. Undo/redo execute
the actual editor action, not just a history cursor change.

Dependent read-modify-write tools carry the revision they read. An intervening
edit returns `CONFLICT` without applying stale work. Independent operations can
use `apply_operations` for one atomic mutation: at most 100 validated steps,
with rollback on any failure. Nested batches, undo/redo, new/load project and
read/view/IO operations are excluded.

Timeouts are indeterminate: the app may have applied the request before its
reply was lost. The MCP rejects queued work and quarantines/closes the channel.
Reconnect and obtain a validated current snapshot before retrying. It never
replays an uncertain mutation automatically or falls back to headless state.

Cancellation before dispatch removes queued work. Cancellation after dispatch
closes/quarantines the channel and reports that the browser may have applied the
operation; it does not promise to undo an already-running app action. Inspect
the refreshed document before retrying. The bridge does not advertise resumable
MCP tasks or app-side operation cancellation.

## Snapshots and UI changes

`state_request {requestId}` is answered by `state_snapshot` with the same ID,
native `document`, `documentId`, `revision`, `activeLayerId` and timeline
`currentFrame`. The app also accepts the `request_state` spelling.

Snapshot requests have independent resolvers/timeouts; they do not replace a
shared callback. Late/unmatched v3 snapshots cannot satisfy a new request.
Validation and stale-revision checks happen before reconciliation is accepted.
Legacy canvas/animation fields are compatibility projections and never
overwrite a native document.

The browser sends debounced `doc_changed {documentId,revision,source}` for UI,
bridge, history and load changes. This invalidates mirrors; callers use
`get_document` or a scoped read to obtain authoritative data. A gallery's
composited animation cache is not an editable content-frame array.

## Output and file boundaries

Default tool replies are bounded to 16 KiB including both text and structured
content. Larger complete results are artifacts, with a short handle and useful
IDs retained when possible. `read_artifact` returns bounded UTF-8 or base64
pages and an exact `nextOffset`. Saved files stay under the configured project
root, including through symlinks.

Headless tools can edit compatible document data but do not implement the app's
compositor/media/cloud engines. Live-disconnected tools do not masquerade as
successful headless edits.
