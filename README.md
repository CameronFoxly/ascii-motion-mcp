# ASCII Motion MCP

Create, animate and export ASCII art from an MCP-compatible assistant, using
[ASCII Motion](https://ascii-motion.app) as the authoritative editor.

> **Version 3 requires bridge v3.** `ascii-motion-mcp@3` pairs with
> [ascii-motion.app](https://ascii-motion.app) 2.2.6 or later (bridge contract
> `e76f9c34204f`). Check `get_capabilities` after connecting. Use
> `ascii-motion-mcp@2.3.0` only with older app builds that lack v3 negotiation.

## Install and connect

Use Node.js 22 or 24. An MCP host starts the server; the browser connects to
**that same process**. Do not start a second terminal instance to obtain a token.

For a published release:

```sh
npm install -g ascii-motion-mcp
```

From a source checkout (for development):

```sh
npm ci
npm run build
node dist/index.js --help
```

Configure the host with `command: "node"` and arguments
`["/absolute/path/to/ascii-motion-mcp/dist/index.js", "--live", "--project-dir",
"/absolute/path/to/projects"]`. A source build must match the app's bridge contract.

### GitHub Copilot app

Open **Customize > MCP**, add a custom stdio server, and enter the command and
arguments above. Manage it under **Installed**. For a published installation,
the command can instead be `ascii-motion-mcp` with `--live --project-dir ...`.

In the same Copilot conversation, call `get_auth_token` and
`get_connection_status`. Open the app's **MCP Connection** dialog, enter that
instance's token and port, and connect. Treat the token as a secret.

The Copilot app starts a separate server for every conversation that has the
MCP enabled. A server binds its live port only when a tool is first used, so
idle conversations do not hold it. If another conversation already owns the
port, live tools return `PORT_IN_USE` instead of crashing; close that
conversation (or stop its server) and retry, and the server binds on the next
tool call.

### GitHub Copilot CLI

Use the standalone `copilot` CLI, not the retired `gh copilot` extension:

```sh
copilot mcp add ascii-motion -- node /absolute/path/to/ascii-motion-mcp/dist/index.js --live --project-dir /absolute/path/to/projects --port 9876
```

The CLI's configuration is `~/.copilot/mcp-config.json`. Its `mcpServers` entries
are not the same schema as VS Code's `servers` entries.

### VS Code with Copilot

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "ascii-motion": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/ascii-motion-mcp/dist/index.js",
        "--live",
        "--project-dir",
        "${workspaceFolder}"
      ]
    }
  }
}
```

For Claude Desktop, Cursor or Windsurf, add an equivalent stdio entry using the
host's MCP settings. Claude Desktop and Windsurf use a top-level `mcpServers`
object; Cursor uses its MCP configuration, not `mcp.servers` in generic editor
settings. Restart or reload the server after changing its command.

## Live and headless behavior

In live mode, inputs and acknowledged results are validated against the
app-owned contract. Reads sample the actual compositor at an absolute timeline
frame, including transforms, generators and procedural effects. Raster shaders
apply to rendered image/video exports, not character-cell reads.

Mutations are ordered, revision-checked and applied by the app. A timeout,
disconnect, invalid target or locked layer is an error, not a successful edit to
a private server copy. Only one browser tab owns a connection. Reconnect and
refresh after an indeterminate timeout before retrying a destructive action.

Without `--live`, compatible document tools edit and save a local document.
Headless mode does not recreate the app's compositor, shader renderer, media
pipeline or cloud authentication. Native saves preserve layers, groups,
typography, palettes, effects, shaders, generators and additive native fields.

Compatibility corrections include integer frame rates of 1..60 (the app's
actual range), motion-trails in the effect-block enum, and bounded preview/diff
pagination. Existing names are retained, but obsolete ranges are not advertised
as working against the current editor.

Some old inputs cannot be represented by the current app. Connected groups
require two distinct, ungrouped layers. OpenTUI exports **TypeScript/TSX**, not
Python; use `componentName`, not `className`. The connected Bubble Tea exporter
uses `modelName: "Model"`. HTML always includes controls and loops indefinitely,
and JSON exports are sparse. Unsupported requests fail explicitly rather than
silently dropping options.

Connected legacy image/video imports use the app conversion pipeline, with
top-left placement and the legacy dark-to-bright charset order preserved.
Exact source-color backgrounds and the old brightness-dither
options are not supported by this adapter. Use `import_media` and
`get_catalog {family:"tools"}` for native palette mapping, conversion settings
and video sampling windows. Legacy image import overlays non-empty cells,
preserving unrelated artwork. Canonical `mode:"new_layer"`, `"replace"` and
image-only `"overlay"` make the placement policy explicit.

## Discover and work efficiently

Start with `get_capabilities` and `get_document_summary`. Use `get_catalog` for
current effect, shader, generator, palette, font, drawing and export options.
`tools/list` is authoritative; there is no manually maintained tool-count table.
Full typed discovery is larger than the old partial toolset. Use host-side
progressive/tool-search discovery where available; response paging reduces
result tokens, not the size of the initial tool schemas.

Existing tool names remain compatibility entrypoints. Where a canonical app
operation has the same name but different inputs, it is exposed with an `app_`
prefix: for example, `load_project` reads a local file, while `app_load_project`
accepts a session object. Prefer the stable-ID, explicit-target operation for
new workflows.

- All new `frame`, `startFrame` and `durationFrames` fields are zero-based
  **timeline frames**, not milliseconds or array indices.
- Address layers, content frames, effects, shaders and keyframes by their
  returned IDs. Compatibility content-frame indices are ordinals.
- Pass the revision returned by an authoritative read as `expectedRevision`
  when a later canonical tool must not overwrite intervening UI edits.
- Use scoped `read_cells`, `get_canvas_ascii` or `get_canvas_preview` before
  editing. Use `get_canvas_render` for a bounded ANSI terminal preview.
- Batch cells or independent mutations. `apply_operations` is atomic and
  produces one undo entry; it rejects nested batches, history/project resets
  and IO/cloud operations.
- Default responses are bounded to 16 KiB. Full results and exports are saved
  as artifacts instead of dumping large documents or base64 into the model.
  Follow `nextOffset` with `read_artifact`; explicit artifact pages allow up to
  8192 bytes and remain below the 64 KiB page-response ceiling.

Artifacts are saved under the project directory, by default in
`.ascii-motion/artifacts/`. Resource handles belong to the current server
session; saved file paths remain usable after restarting.

## Supported workflows

The app contract covers drawing/brush/vector/Bezier/gradient/text/FIGlet/ASCII
boxes; selection/clipboard/transforms; layer/group/content-frame editing;
transform animation; effects and shaders; procedural generators; palettes;
image/video import and trace overlays; native project files; and authenticated
cloud project management.

Use live export catalogs for options and availability. Formats include PNG,
JPG, SVG, WebM, MP4, image sequences, native sessions, text, JSON, ANSI, HTML,
React, Ink, OpenTUI and Bubbletea. **There is no GIF exporter.** MP4 and other
media codecs depend on the browser. Cloud operations use the browser's signed-in
account and enforce its actual entitlements; account/billing/admin actions are
not MCP authoring tools.

Examples:

> Create a small project, inspect the active layer and content-frame IDs, and
> draw a character graphic using one cell batch.

> Add an Animated Text generator with a typewriter reveal, preview timeline
> frame 12, then undo and redo the change.

> Export a WebM artifact without triggering a browser download, and save the
> complete native project in my project directory.

## CLI

```text
ascii-motion-mcp [--live] [--project-dir PATH] [--port PORT]
  --live                Enable the loopback browser bridge
  --project-dir PATH    File-operation root (default: current directory)
  --port PORT           Bridge port, 1..65535 (default: 9876)
  --help                Show help
  --version             Show the installed package version
```

`ASCII_MOTION_PROJECT_DIR` also sets the file root. Files must stay within it,
including through symlinks. A remote/cloud-hosted MCP process cannot reach your
local browser merely because both use a loopback address.

## Development

See [Contributing](CONTRIBUTING.md), [bridge protocol](docs/LIVE_SYNC_PROTOCOL.md),
[updating](docs/UPDATING.md) and [release coordination](docs/PUBLISHING.md).
The SDK serves both legacy initialization and modern MCP discovery over stdio.
MCP Apps, resumable tasks and remote hosting are not required by this bridge and
are not advertised as supported integrations.

[Published app documentation](https://docs.ascii-motion.com/mcp) lives in
`Ascii-Motion-Web/docs-site`, mounted at `packages/web` in the app repository.

MIT License. See [LICENSE](LICENSE).
