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

```bash
npm install -g ascii-motion-mcp@0.2.0
```

## After Updating

1. **Restart your AI client** (Claude Desktop, VS Code, Cursor, etc.)
2. **Reconnect the browser** if using live mode - get a new auth token

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

On macOS/Linux, you may need sudo:
```bash
sudo npm install -g ascii-motion-mcp@latest
```

Or better, fix npm permissions:
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
