# margins-sync-action

Sync a repository's markdown documentation (and referenced images) to a
[Margins](https://github.com/alvistar/ai-review) workspace on every merge to
the default branch — **with zero long-lived credentials in either direction**.

- Margins never holds GitHub credentials: content is *pushed* by your CI via a
  content-addressable sync protocol.
- Your repos never hold Margins credentials: each workflow run proves its
  identity with a short-lived GitHub-signed OIDC token, and the Margins server
  authorizes the push only if the token's immutable repository identity
  (`repository_id` + `repository_owner_id` + name) matches the workspace's
  trust binding, created explicitly at install time by an authenticated
  workspace member. There is no trust-on-first-use.

## Quick start

The easy path — one command per repo (or `--org` for many):

```bash
npm install -g margins-cli
margins install owner/repo --server-url https://margins.example.com
```

`install` creates the workspace, writes the trust binding (repo IDs sourced
from the GitHub API), and opens a PR adding
`.github/workflows/margins-sync.yml` to the repo. Merge the PR; the next md
change on the default branch appears in Margins.

Manual setup: copy `templates/margins-sync.yml`, fill in the placeholders,
and have a workspace member enable the trust binding for the workspace.

## How updates reach you

- **Floating tag (`@v1`)**: logic updates ship when the `v1` tag moves —
  zero PRs in your repo. The action's pinned `margins-cli` version moves with
  the action release.
- **SHA-pinned consumers**: you don't get tag moves. Two detection channels:
  the action emits a `::warning` when your stamped workflow file's
  `schema-version` is older than it expects, and `margins audit` reports
  repos on stale action pins (and binding drift after renames/transfers).

## Operator requirements

`margins install` / `margins audit` run on the **operator's** machine with
their own `gh` auth (repo write access; PR review coordination is yours).
The Margins server never receives that credential. Binding control is gated
to the workspace creator or an instance admin — see `SECURITY.md` for the
operator-succession story. Recommended cadence: run `margins audit --org`
monthly and after any repo rename/transfer.

## Inputs

| Input | Required | Description |
|---|---|---|
| `server-url` | yes | Margins origin (scheme + host, no trailing slash). Doubles as the OIDC audience. |
| `workspace-id` | yes | Workspace bound to this repo (stamped by `margins install`). |
| `schema-version` | no | Caller workflow-file schema version (default `1`). |
| `directory` | no | Directory to sync (default repo root). |

## Limits

- Server-enforced manifest cap (default 1000 files) and 2 MB per-blob cap —
  `margins install`/`margins audit` pre-check and flag offenders.
- One workspace per repository (the sync protocol pushes the full file tree;
  sharing a workspace across repos would cross-delete content).
- Sync runs on `push` to the default branch only. Pull-request events are
  deliberately rejected server-side.

See `SECURITY.md` for the threat model and incident playbook, and
`RELEASING.md` for the release/pinning process.
