# Publishing a compatible release

Publishing requires explicit maintainer authorization. Do not combine a version
bump, push and publish into an unchecked one-liner.

## Verify the pair

1. Land the matching app implementation and generated bridge contract.
2. Run the **App contract parity** workflow against its immutable commit.
3. Confirm contract/catalog hashes and real stdio-to-mounted-editor behavior.
   Exercise every registered compatibility adapter and each new capability
   family. Success-shaped responses alone are not a passing test.
4. Verify native save/load round trips, composited previews, one-step undo/redo,
   rollback, invalid input, stale revisions, reconnect and multiple clients.
5. Exercise exports without browser downloads. Record browser codec limits and
   authenticated/entitlement checks using a disposable account/project.

Do not claim untested authenticated cloud operations or MP4 support. Document
remaining blockers explicitly.

## Validate this package

```sh
npm ci
npm run check:bridge-contract
npm run build
npm run lint
npm run test:protocol:types
npm run test:run
npm pack --dry-run
```

CI runs Node 22 and 24. Protocol tests cover legacy initialization, modern
discovery, actual stdio calls, cancellation, resource/prompt access, EOF and
installed-package startup. Check the packed files include the bundled contract.

Measure serialized discovery and representative dense result sizes. Default
results must remain within 16 KiB; explicit pages must remain within 64 KiB.
Check continuation counts/cursors and artifact bytes, not merely a character
preview or reported file size.

## Version, publish and document

Choose a semver version appropriate to the compatibility change. Requiring
Node 22 and a v3 app bridge is a breaking deployment requirement; do not call it
an invisible patch to existing live clients.

After versioning, rerun package smoke checks and verify `--version` matches the
manifest. Publish to an appropriate prerelease tag first when validation is
still in progress. Publish to `latest` only after release approval and acceptance.

Update host installation commands to the actual tested release. Test a fresh
GitHub Copilot app/CLI installation against the same process's browser token.
Do not advertise an unreleased npm version as installable.

The published docs live in `CameronFoxly/Ascii-Motion-Web`, under `docs-site/`.
Regenerate their tool reference from the final discovery/connected-status
manifest and run their docs checks, lint and build. Publish that web commit
before updating the app's `packages/web` gitlink. Keep app, MCP and docs release
references linked so a future contributor can reproduce the compatibility pair.
