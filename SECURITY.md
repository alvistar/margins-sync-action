# Security model — margins-sync-action

One page for the security review. Every claim here traces to shipped,
tested behavior; nothing is aspirational.

## Credential model

**Zero long-lived credentials in either direction.**

| Direction | Credential | Lifetime |
|---|---|---|
| Margins → GitHub | none — Margins never holds GitHub tokens, apps, or deploy keys | — |
| Repo → Margins | none stored — each workflow run requests a GitHub-signed OIDC JWT | ~5 minutes |
| Operator → GitHub | the operator's own `gh` auth, used locally by `margins install`/`audit`; never transmitted to or stored by Margins | operator-managed |
| Humans → Margins | personal `mrgn_` API keys (CLI/desktop use); **rejected** on workspaces with armed bindings (see single-writer below) | user-managed |

## How a push is authorized

1. The workflow (with `permissions: id-token: write`) requests an OIDC token
   from GitHub's token service with `audience` = the Margins server origin.
2. Margins verifies the JWT: signature via GitHub's published JWKS,
   `RS256` pinned, issuer `https://token.actions.githubusercontent.com`
   pinned, audience exact-string match (single value; GitHub's default
   audience and multi-audience arrays are rejected), `exp`/`nbf` enforced.
3. Claims gate (per event):
   - **Push sync** (`workspace push`): `event_name` must be `push` or
     `workflow_dispatch` (`pull_request`/`pull_request_target` are rejected —
     the fork confused-deputy path), `ref_type` must be `branch`, and `ref`
     must be a `refs/heads/*` ref. The manifest write is then bound to the
     token's **own** ref: a token minted for `feat/x` may write only the
     `feat/x` workspace branch, never another branch's tree (a tag named like a
     branch does not pass the `ref_type` check).
   - **Branch archive** (`workspace archive-branch`, on `delete`): `event_name`
     must be `delete`. The branch to archive comes from the request body
     (a delete event has no checkout) and is guarded against the workspace
     default branch server-side. This path is identity-bound (the repo trust
     binding), not ref-bound — a bounded, reversible action (a re-push revives).
4. Identity gate: the token's `repository` name, `repository_id`, and
   `repository_owner_id` must **all** equal the workspace's trust binding.

## Trust bindings: install-only, never trust-on-first-use

Bindings (immutable repo ID + owner ID + name) are written **only** by an
authenticated workspace member — `margins install` sources the IDs from the
GitHub API. The OIDC path never writes a binding. TOFU was rejected
deliberately: any repository on the internet can mint a valid-audience
token, so "first pusher wins" would let an attacker bind an unbound
workspace before the legitimate repo's first push. Immutable IDs (not
names) anchor the binding because repo/org renames free the old name for
re-registration (resurrection attacks).

Binding mutations (enable / reset / override) are gated to the workspace
creator **or an instance admin**, require workspace membership before any
binding state is disclosed, and every mutation — including each *use* of
the override (one audit entry per push, written at manifest commit) — is
recorded in a dedicated audit table with actor and before/after state.

> **Honesty note (current release):** Margins has no instance-admin role
> modeling yet; the creator-or-admin gate is implemented but resolves to
> creator-only until admin modeling lands. Operator succession therefore
> currently requires the workspace creator's account to remain active —
> track this before multi-operator deployments.

## Single-writer enforcement

Once a bound workspace receives its first successful OIDC push, the server
rejects non-action pushes ("managed by repo X") — git is the source of
truth and mixed-writer clobbering is structurally impossible, not merely
documented. The emergency **override is one-shot**: a `mrgn_`-key push under
override is audit-logged (`override-used`), and the next successful OIDC
push self-clears the flag. Override-window edits must be committed to the
repository to survive the next merge (full-tree sync overwrites by design).

## Known, accepted risks

- **Token replay within validity (~5 min).** One token legitimately covers
  the whole push sequence (manifest GET + blob PUTs + manifest POST), so a
  one-time-use check is not possible. The token is masked in run logs
  immediately after minting; `jti` + `run_id` are logged server-side on
  every accept/reject for forensics. Logs are forensic, not preventive.
- **Any workflow in the bound repo can mint a valid token** — the binding
  is per-repository, not per-workflow-file. Pinning `workflow_ref` is a
  documented hardening option, feasible with the composite action, deferred
  until required.
- **npm registry availability** is a runtime dependency of every consumer
  sync (`npx` resolves the exact-pinned, dependency-free CLI at run time).

## Supply chain

- The action is a composite pinning an **exact** margins-cli version;
  consumers are encouraged to SHA-pin the action itself.
- The pinned CLI release is **hermetic**: all runtime dependencies bundled,
  published with an empty `dependencies` field via npm Trusted Publishing
  (OIDC, no npm tokens). CI fails if the pinned version declares any
  runtime dependency.
- Action inputs reach shell steps only via `env:` indirection.
- This repo's own CI uses SHA-pinned actions and explicit `permissions:`.

## Incident playbook

| Scenario | Action |
|---|---|
| Suspected token leak | Nothing to rotate — tokens expire in ~5 min. Check server logs for the `jti`/`run_id`; verify the manifest history for that window. |
| Repo compromise (malicious pushes) | Reset the workspace trust binding (one place, creator/admin). Pushes stop immediately — there is no other credential to revoke. |
| Malicious full-tree deletion | Deletion is **soft** server-side: the manifest's auto-delete marks documents deleted without touching content, and re-pushing the path revives them — so a malicious empty-tree push destroys nothing; recover by re-pushing from git (the source of truth). Malicious *overwrites* are recoverable from per-document version history (last 10 snapshots per document; markdown only — image bytes persist on disk regardless). There is no one-click restore endpoint: recovery is re-push from git, or manual copy from a stored version. Ten successive malicious overwrites of one file can roll good content out of its version window — git remains the recovery source in that case. |
| Repo renamed/transferred | Pushes fail closed (identity mismatch, opaque 403). `margins audit` reports "binding drift"; creator/admin runs reset + re-bind. |
| Operator offboarding | Instance admin retains binding control (creator-or-admin gate); no per-repo secrets to rotate. |

## Operator requirements

`margins install`/`audit` need: local `gh` auth with repo write (and PR
review coordination), plus a Margins account that is the workspace creator
or instance admin. Recommended cadence: `margins audit --org` monthly and
after any repo rename or transfer.
