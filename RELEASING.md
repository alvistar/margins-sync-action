# Releasing margins-sync-action

The action is a thin composite wrapper; all sync logic lives in
[margins-cli](https://github.com/alvistar/margins-cli). A release here is
usually "bump the pinned CLI version and move the tags".

## Invariants

1. **The CLI pin in `action.yml` (`MARGINS_CLI_VERSION`) is always an exact
   version.** Never a range — `npx` would resolve mutable code into every
   consumer run, defeating consumers' SHA-pinning.
2. **The pinned CLI release must be hermetic**: all runtime dependencies
   bundled into `dist`, published with an empty `dependencies` field. CI
   asserts `npx` performs no additional dependency resolution; do not pin a
   CLI version that fails that check.
3. **Strict 3-segment semver tags** (`vX.Y.Z`), plus a floating `v1` major
   tag that always points at the latest `v1.x.y`.

## Release steps

1. PR: bump `MARGINS_CLI_VERSION` in `action.yml` (and `templates/` or
   `EXPECTED_SCHEMA_VERSION` if the workflow-file contract changed — that's
   a schema-version bump; document it in the PR).
2. CI green (the E2E exercises the new pin against the mock server,
   including the hermeticity assertion).
3. Tag the release and move the major tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   git tag -f v1 vX.Y.Z
   git push -f origin v1
   ```

4. If the workflow-file schema changed, bump `EXPECTED_SCHEMA_VERSION` in
   `action.yml` so stamped-file staleness warnings fire for old callers, and
   update `templates/margins-sync.yml`'s `schema-version`.

## Consumer update channels

- `@v1` consumers: get the release when the major tag moves (step 3).
- SHA-pinned consumers: detected via the `schema-version` warning and
  `margins audit`'s stale-pin report; they re-pin on their own schedule.
