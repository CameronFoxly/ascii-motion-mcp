# ASCII Motion MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that enables AI assistants to create, animate, and export ASCII art through natural language.

![npm version](https://img.shields.io/npm/v/ascii-motion-mcp)
![license](https://img.shields.io/npm/l/ascii-motion-mcp)

## What is this?

The ASCII Motion MCP allows you to use AI assistants like Claude, GitHub Copilot, and Cursor to operate [ascii-motion.app](https://ascii-motion.app). You can ask the LLM to:

- 🎨 **Draw ASCII art** - Create pixel art and text graphics with characters
- 🎬 **Animate** - Build frame-by-frame animations with onion skinning
- 📥 **Import** - Convert images to ASCII art with full control
- 📤 **Export** - Save as PNG, GIF, MP4, HTML, React, or CLI components
- 🌈 **Apply effects** - Add digital rain, noise, color shifts, and more

All through natural language prompt in a live session of [ascii-motion.app](https://ascii-motion.app)!

## Quick Start

### Prerequisites

- Node.js 18+
- An MCP-compatible AI client (Claude Desktop, VS Code + Copilot, Cursor, etc.)

### Installation

```bash
npm install -g ascii-motion-mcp
```

Verify installation:
```bash
ascii-motion-mcp --help
```

## Client Setup

> **Important:** The `--live` flag is required for all setups. Without it, the MCP tools have no visual output. After configuring your client, you must also connect the browser to see your AI's work.

### Claude Desktop

Add to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ascii-motion": {
      "command": "ascii-motion-mcp",
      "args": ["--live", "--project-dir", "/path/to/your/projects"]
    }
  }
}
```

Restart Claude Desktop after saving.

### VS Code with GitHub Copilot

1. Install the [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension
2. Open VS Code Settings (JSON) and add:

```json
{
  "github.copilot.chat.mcpServers": {
    "ascii-motion": {
      "command": "ascii-motion-mcp",
      "args": ["--live", "--project-dir", "${workspaceFolder}"]
    }
  }
}
```

3. Restart VS Code
4. Open Copilot Chat and start creating!

### GitHub Copilot CLI

1. Install GitHub CLI and Copilot extension:

```bash
# Install GitHub CLI
brew install gh  # macOS
# or: winget install GitHub.cli  # Windows

# Install Copilot extension
gh extension install github/gh-copilot

# Login
gh auth login
```

2. Create/edit `~/.config/gh-copilot/config.yml`:

```yaml
mcpServers:
  ascii-motion:
    command: ascii-motion-mcp
    args:
      - --live
      - --project-dir
      - ~/ascii-art-projects
```

3. Use in terminal:

```bash
gh copilot chat "Create an 8-frame animation of a bouncing ball"
```

### Cursor

1. Open Cursor Settings (`Cmd+,` / `Ctrl+,`)
2. Search for "MCP" in settings
3. Click "Edit in settings.json" and add:

```json
{
  "mcp.servers": {
    "ascii-motion": {
      "command": "ascii-motion-mcp",
      "args": ["--live", "--project-dir", "/path/to/projects"]
    }
  }
}
```

4. Restart Cursor

### Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "ascii-motion": {
      "command": "ascii-motion-mcp", 
      "args": ["--live", "--project-dir", "/path/to/projects"]
    }
  }
}
```

## Connect the Browser

After configuring your AI client, you must connect the ASCII Motion browser app to see visual output:

1. **Get the auth token** - Ask your AI: "What is the MCP auth token?"
2. **Open ASCII Motion** - Go to [ascii-motion.app](https://ascii-motion.app)
3. **Open MCP Connection** - Click the hamburger menu (☰) → **MCP Connection**
4. **Paste the token** - Enter the auth token and click **Connect**

You should see a green "Connected" status. Now your AI's edits appear in real-time!

## CLI Options

```
ascii-motion-mcp [options]

Options:
  -d, --project-dir PATH  Project directory for file operations (default: cwd)
  -l, --live              Enable live browser sync via WebSocket (REQUIRED)
  -p, --port PORT         WebSocket port for live mode (default: 9876)
  -h, --help              Show help
  -v, --version           Show version
```

## Example Prompts

Once configured, try these prompts with your AI assistant:

**Create Art:**
> "Create a 40x20 canvas with a pixel art heart in red"

**Import & Convert:**
> "Import the image at ./photo.jpg and convert it to ASCII using block characters"

**Animate:**
> "Create an 8-frame animation of a walking stick figure"

**Apply Effects:**
> "Add a digital rain effect with green characters"

**Export:**
> "Export this animation as a GIF with 2x size"

**CLI Components:**
> "Export as an Ink component for my Node.js CLI app"

## Available Tools (69 total)

### Canvas Tools
`set_cell`, `get_cell`, `clear_cell`, `set_cells_batch`, `paste_ascii_block`, `fill_region`, `resize_canvas`, `clear_canvas`

### Frame Tools
`add_frame`, `delete_frame`, `duplicate_frame`, `go_to_frame`, `list_frames`, `set_frame_duration`, `set_frame_name`

### Animation Tools
`copy_frame_and_modify`, `shift_frame_content`, `flip_region`, `copy_region_to_frame`, `interpolate_frames`

### Project Tools
`new_project`, `save_project`, `load_project`, `get_project_info`, `list_project_files`, `set_project_name`

### Preview Tools
`get_canvas_summary`, `get_canvas_preview`, `get_canvas_ascii`, `get_frame_diff`, `describe_animation`

### Selection Tools
`select_rectangle`, `select_by_color`, `get_selection`, `clear_selection`, `apply_to_selection`, `delete_selection_content`

### Palette Tools
`list_character_palettes`, `get_character_palette`, `list_color_palettes`, `get_color_palette`, `get_active_colors`, `set_foreground_color`, `set_background_color`, `set_selected_character`, `suggest_palette_for_style`

### Import Tools
`import_image`, `import_video`, `import_ascii_text`

### Effects Tools
`apply_effect`, `get_color_stats`, `batch_recolor`, `batch_replace_char`

### Generator Tools
`run_generator`, `preview_generator`

### Export Tools
`export_text`, `export_json`, `export_session`, `export_html`, `export_react`, `export_ansi`, `export_ink`, `export_bubbletea`, `export_opentui`, `export_image`, `export_video`

### History Tools
`undo`, `redo`, `get_history_status`

## MCP Resources

The server exposes these resources for state introspection:

- `project://state` - Full project state snapshot
- `project://canvas` - Current frame canvas data
- `project://frames` - Frame list with metadata
- `project://selection` - Current selection state
- `project://history` - Undo/redo history
- `project://ascii` - Plain text ASCII preview

## Requirements

- **Node.js 18+** - Required
- **sharp** (optional) - For image import: `npm install sharp`
- **ffmpeg** (optional) - For video export: `brew install ffmpeg`

## Troubleshooting

### "Command not found"
Make sure npm global bin is in your PATH:
```bash
npm bin -g
# Add the output to your PATH if needed
```

### Tools not appearing
Restart your AI client after configuration changes. Check that the config file is valid JSON.

### Live mode not connecting
- Ensure port 9876 is available
- Check that you're connecting from localhost
- Verify the auth token is correct

### No visual output
Make sure you're using the `--live` flag AND have connected the Ascii Motion app, via MCP Connection in the hamburger menu in the upper left. You'll know the connection is live if a green indicator dot is present on the hamburger menu.

## Links

- [ASCII Motion Web App](https://ascii.motion.dev)
- [Documentation](https://docs.ascii.motion.dev/mcp)
- [GitHub Issues](https://github.com/CameronFoxly/ascii-motion-mcp/issues)
- [Discord Community](https://discord.gg/PVbpGgKQMy)

## License

MIT License - see [LICENSE](LICENSE) for details.
