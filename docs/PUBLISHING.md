# Publishing Updates to npm

This guide covers how to publish updates to the `ascii-motion-mcp` npm package.

## Prerequisites

- npm account with publish access to `ascii-motion-mcp`
- Logged in via `npm login`

## Publishing Workflow

### 1. Make Your Changes

Edit the source code, then build and test:

```bash
npm run build
npm run test  # if tests exist
```

### 2. Commit Your Changes

```bash
git add -A
git commit -m "Description of changes"
```

### 3. Bump the Version

Use semantic versioning to bump the version:

```bash
# Bug fixes (0.1.0 → 0.1.1)
npm version patch

# New features, backwards compatible (0.1.0 → 0.2.0)
npm version minor

# Breaking changes (0.1.0 → 1.0.0)
npm version major
```

This command:
- Updates `package.json` version
- Creates a git commit
- Creates a git tag (e.g., `v0.1.1`)

### 4. Publish to npm

```bash
npm publish
```

This runs the `prepublishOnly` script (builds the project) and uploads to npm.

### 5. Push to GitHub

```bash
git push && git push --tags
```

## One-Liner for Quick Releases

For a patch release:
```bash
git add -A && git commit -m "Fix: description" && npm version patch && npm publish && git push && git push --tags
```

## Version History

Check the current published version:
```bash
npm view ascii-motion-mcp version
```

See all published versions:
```bash
npm view ascii-motion-mcp versions
```

## Prerelease Versions

For alpha/beta releases:

```bash
# Create prerelease version
npm version prerelease --preid=alpha  # 0.1.1 → 0.1.2-alpha.0

# Publish with tag (won't be installed by default)
npm publish --tag alpha
```

Users install prereleases with:
```bash
npm install -g ascii-motion-mcp@alpha
```

## Deprecating Versions

If a version has a critical bug:

```bash
npm deprecate ascii-motion-mcp@0.1.1 "Critical bug, please upgrade to 0.1.2"
```

## Unpublishing (Use with Caution)

You can only unpublish within 72 hours of publishing:

```bash
npm unpublish ascii-motion-mcp@0.1.1
```

## Troubleshooting

### "You must be logged in to publish"
```bash
npm login
```

### "Cannot publish over existing version"
You must bump the version before publishing. Use `npm version patch/minor/major`.

### "Git working directory not clean"
Commit all changes before running `npm version`.
