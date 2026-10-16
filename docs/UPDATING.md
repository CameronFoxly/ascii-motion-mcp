# Updating ascii-motion-mcp

This guide is for end users who have already installed the package and want to update to the latest version.

## Check Your Current Version

```bash
ascii-motion-mcp --version
```

## Check Latest Available Version

```bash
npm view ascii-motion-mcp version
```

## Update to Latest Version

### Option 1: npm update (Recommended)

```bash
npm update -g ascii-motion-mcp
```

### Option 2: Reinstall Latest

If `npm update` doesn't work, force install the latest:

```bash
npm install -g ascii-motion-mcp@latest
```

### Option 3: Install Specific Version

For example, to pin the published legacy release:

```bash
npm install -g ascii-motion-mcp@2.3.0
```

For bridge v3, use the exact version from the compatible release notes once
published, or run the matching local development build. Do not substitute
`@latest` for an unreleased app/MCP pair.

## After Updating

1. **Restart your AI client** (Claude Desktop, VS Code, Cursor, etc.)
2. **Reconnect the browser** if using live mode - get a new auth token

Use `get_auth_token` and `get_connection_status` from the instance started by
your AI host. Do not start a second terminal process to get its token.

Bridge v3 development builds require Node 22 or 24 and a matching app build.
The published 2.3.0 package does not gain unreleased features simply by
reconnecting. Check `get_capabilities` after connecting and update the app/MCP
as a compatible pair. Legacy apps without v3 negotiation cannot safely use the
new live operation path.

## View Changelog

Check what changed between versions:

```bash
# See all available versions
npm view ascii-motion-mcp versions

# Visit GitHub releases for detailed changelogs
open https://github.com/CameronFoxly/ascii-motion-mcp/releases
```

## Troubleshooting

### "Permission denied" errors

Avoid installing with `sudo`. Use a Node version manager or a user-owned npm
prefix, or configure the host to use a pinned `npx -y` installation.
For a user-owned prefix:
```bash
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc
npm install -g ascii-motion-mcp@latest
```

### Still seeing old version after update

1. Check which version is installed:
   ```bash
   npm list -g ascii-motion-mcp
   ```

2. Find where the command resolves:
   ```bash
   which ascii-motion-mcp
   ```

3. Clear npm cache and reinstall:
   ```bash
   npm cache clean --force
   npm install -g ascii-motion-mcp@latest
   ```

### AI client still shows old tools

Completely restart your AI client (not just reload):
- **Claude Desktop**: Cmd+Q (macOS) or fully exit (Windows)
- **VS Code**: Close all windows and reopen
- **Cursor**: Cmd+Q and reopen

## Automatic Updates

npm doesn't auto-update global packages. You can set a reminder or use a tool like `npm-check`:

```bash
npm install -g npm-check
npm-check -g -u  # Interactive update for all global packages
```
