# Contributing

Use Node.js 22 or 24. Run `npm ci`, `npm run build`, `npm run lint`,
`npm run test:run`, and `npm run check:bridge-contract` before submitting changes.

## App parity is part of every feature

The app owns authoring behavior and the bridge schemas. A tool reporting success
is not evidence that the editor changed. Verify the native document and rendered
output at the requested timeline position, then undo and redo the action.

For changes to authoring, timelines, generators, effects, shaders, palettes,
imports, exports, or project management:

1. Update the app operation and tests in `src/mcp/contract/operations.ts`.
2. In the app checkout, run `npm run mcp:contract` and
   `npm run mcp:contract:check`. Commit the generated JSON with its source.
3. In this checkout, run
   `npm run sync:bridge-contract -- --source /path/to/app/src/mcp/contract/bridge-contract.json`.
   Never hand-edit the bundled contract.
4. Add or repair the MCP adapter. Canonical operations use timeline frames and
   stable IDs; compatibility content-frame indices are ordinals and must be
   translated explicitly. Do not send one-way mutations or substitute a stale
   mirror when the browser is disconnected.
5. Test actual stdio-to-browser application, invalid targets, locked layers,
   revision conflicts, rollback, and one-step history. Include native save/load
   round trips for every affected persisted field.
6. Update the relevant guides, prompts and capability coverage. Record a reason
   for genuinely view-only or out-of-scope features rather than silently omitting
   them. Authenticated/entitlement-gated functionality remains in scope.

Adding a contract operation exposes a schema-derived tool automatically.
An `app_` prefix disambiguates canonical operation inputs from existing tools
with the same name. Keep existing names working through explicit adapters.
Result schemas describe the browser response; public tool results may instead
link to an artifact to enforce output budgets.

## Check both repositories

`npm run check:bridge-contract` validates the bundled hash and all schemas.
To compare with a specific app checkout:

```sh
npm run sync:bridge-contract -- --check --source /path/to/app/src/mcp/contract/bridge-contract.json
```

The **App contract parity** GitHub workflow performs that comparison against an
explicit app commit. It can also receive `ascii-motion-contract-updated`
repository-dispatch events with `client_payload.app_ref`. Dispatching across
repositories requires an appropriately authorized GitHub App or token; a
repository's ordinary `GITHUB_TOKEN` does not grant cross-repository write
access. Do not add a broad personal token to work around this.

## Release as a compatible set

Publish/land the app contract and implementation before advertising the matching
MCP features. Verify the app commit in the parity workflow, then publish the MCP
release and update pinned installation examples. The published documentation is
in `Ascii-Motion-Web/docs-site`, mounted at `packages/web` in the app. Publish the
web commit before moving that submodule gitlink.

Do not claim an authenticated cloud workflow or codec works without exercising
it in an appropriate disposable test environment. Never put real connection
tokens, private projects or credentials in fixtures, logs, commits or screenshots.
