# Workspace architecture — 0.1.2rc1

This implementation follows the [architecture correction plan](https://chatgpt.com/s/t_6abeef68735c8191a9183d3544ba8e22). It supersedes the synchronization, onboarding, preview access and protocol sections of `collaborative-presentation-spec.md`.

## State ownership

- A local folder is a real filesystem replica. Git, shell commands and external editors are valid inputs.
- Collaborative Markdown, HTML, CSS, YAML and JSON use path → Y.Text bindings. `runtime/` is a vendored static tree, not collaborative text.
- The Workspace domain owns the CRDT document, topology, assets, operations and snapshots. Auth, Project membership/invites and Presentation releases retain their existing modules.
- `structure_revision` covers topology and binary changes only. Text updates can change `content_hash` without changing this revision. Releases are identified by `release_id` and `content_hash`.
- Snapshot, Preview and Publish resolve the same current CRDT text under the workspace mutation lock. Topology controls which paths exist; orphan CRDT keys cannot create preview/release files.
- JSON snapshots include an encoded Yjs state for clone initialization. Asset downloads carry the snapshot's expected hash and fail if the asset has since changed. Publish captures asset bytes under the same lock.

## Local safety and recovery

`.presentation/` contains workspace metadata, `yjs-state.bin`, saved-disk text baselines, the synchronization baseline and `offline-journal.json`. Yjs updates are written atomically and synchronously before returning from the update callback. Autosave is a user preference; the extension never calls ordinary Save to establish synchronization correctness.

The extension restores Yjs and captures local changes before opening the socket. Disconnect keeps local bindings and persistence active. Local filesystem bursts use a debounced Local → Server rescan. Remote notifications use a separate Server → Local merge.

Topology and binary intent is journaled before advancing the local baseline. A successful HTTP receipt acknowledges only its matching entries. A revision mismatch fetches fresh state and retries non-conflicting operations; conflicting entries remain on disk. Unrelated pending operations can continue.

Remote projection only modifies known, unchanged paths that are not protected by local intent. `.git/`, `.presentation/`, `.vscode/` and `node_modules/` are ignored at every level. Directory deletion is non-recursive, so unknown or ignored children survive. Unsupported paths and symlinks stop synchronization with a diagnostic rather than disappearing during reconciliation.

`Presentation: Resolve Conflict` makes an explicit Keep Local / Use Remote choice. It stores a recovery copy before applying the selection. Binary upload conflicts also offer Use Mine / Keep Remote; Use Mine retries with the displayed asset revision, so a newer concurrent write still conflicts.

Legacy workspaces are read without overwriting their files. Differences from the initial server snapshot are preserved as conflicts and must be explicitly resolved. Legacy journal entries without a safe baseline are retained for recovery.

Single-node PoC ceilings remain: local filesystem storage, process-local locks, full Yjs-state writes, base64 binary journal payloads and retained HTTP operation receipts. These are not a multi-process database transaction or an unlimited large-file synchronization design. Filesystem/metadata failure during a server command requires recovery; the protocol reports the known committed prefix and never claims batch atomicity.

## Onboarding and authentication

Create and Open both select a parent, exclusively reserve a new child directory, download the snapshot and write workspace metadata last. Existing children are refused. Open Presentation groups My Presentations and Shared with Me. Accepting an invite opens the returned project directly.

`presentation.serverUrl` is the server origin for new actions. Existing workspaces use their recorded origin. Sessions and refresh operations are isolated by origin; commands sign in and resume the original action when needed.

Preview requires a ten-minute project-scoped session. The signed URL bootstraps an HttpOnly, path-scoped cookie, then redirects to remove the token from the URL. HTML, assets, runtime files and the preview fingerprint endpoint all require the session and current membership. Responses use `private, no-store`; preview polling stops when authorization expires. Published releases and slug URLs remain public and immutable.

## Protocol v2

Client → WebSocket: `hello`, binary Yjs updates, `ping`.

Server → WebSocket: `ready`, binary Yjs updates, `workspace.operations`, `asset.changed`, `reconcile_required`, `pong`, protocol errors. The ready frame never advances the last-applied topology cursor. A ping/pong barrier can flush text before Publish/Snapshot actions.

Durable filesystem commands use `POST /api/projects/{id}/workspace/operations`:

```json
{
  "base_revision": 42,
  "operations": [
    {"id": "stable-retry-id-1", "kind": "mkdir", "path": "02-market"},
    {"id": "stable-retry-id-2", "kind": "create", "path": "02-market/slide.md", "content": "# Market"}
  ]
}
```

Commands support `mkdir`, `create`, `delete`, `rename`, `move` and `write` (existing non-collaborative text only). Stable operation IDs deduplicate retries; reusing an ID for a different request is rejected. IDs are durable HTTP receipts, not WebSocket acknowledgement waiters.

A successful response contains `structure_revision` and ordered `results`. A rejected batch returns HTTP 409 with `detail.results` containing the committed prefix and `detail.failed` naming the first failed index. The suffix is not applied. Committed operations are broadcast to all connected clients. Binary PUT/GET remains HTTP with asset revisions and `asset.changed` notifications.

Invites use `/api/projects/{id}/invites`, `/api/invites/{token}` and `/api/invites/{token}/accept`. Private preview sessions use `POST /api/projects/{id}/preview-session`.

## RC status

Canonical version: `0.1.2rc1`, updated with `uv version 0.1.2rc1 --no-sync`. Compose uses the same version. VS Code accepts numeric extension versions only: the manifest derives `0.1.2` and RC packaging uses `vsce --pre-release`; the VSIX filename retains `0.1.2rc1`. RC image publication does not update `latest`.

At the user's request, **all validation was skipped**: environment setup, Phase 0 regression execution, compilation, linting, tests, Docker Compose smoke checks, two real VS Code Extension Development Hosts, E2E acceptance and packaging. The existing smoke script was migrated to protocol v2 but was not run. No milestone is claimed to have passed acceptance, and no release tag was created. The branch is an unverified release candidate.

Before a stable release, run the plan's A–L scenarios using the Compose published endpoint and two real Extension Development Hosts, including restart/crash recovery, autosave off/on, bulk changes, concurrent topology and binary conflicts, preview expiry, and release immutability. No PostgreSQL, object storage, presence, web editor or later-phase product features are included.
