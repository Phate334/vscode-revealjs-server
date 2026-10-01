# RevealJS Collaboration (M0/M1 PoC)

Minimal VS Code extension: bind workspace `slide.md` (root or nested chapter path) to the
compose collaboration server via Yjs. The WebSocket URL is built **only** from
`.presentation/workspace.json` (`server` + `projectId`) — there is no `/poc` fallback.

## Build

```bash
cd extension
npm install
npm run compile
```

## Server (Docker Compose — required for live checks)

From repo root:

```bash
docker compose up -d --build
./scripts/compose-smoke.sh    # curl http://127.0.0.1:8000/health
```

Use the published compose port (`localhost:8000`), not host `uv run uvicorn`.

## Load in VS Code 1.139+

Two Extension Development Host windows (after compose is up):

```bash
code --extensionDevelopmentPath=$PWD \
  ../fixtures/alice
code --extensionDevelopmentPath=$PWD \
  ../fixtures/bob
```

Or open `extension/` and press F5 (`.vscode/launch.json` → Alice fixture).

Run **Presentation: Sign In** first (`demo` / `demo` or `alice` / `alice` against compose).
The access token is stored in VS Code SecretStorage and attached to project HTTP calls and the
collaboration WebSocket (`?access_token=`). A window auto-connects only when both
`.presentation/workspace.json` and a saved token are present.

**Presentation: Share Project** copies an invite token. **Presentation: Open Shared Project**
accepts that token, then extracts the snapshot. **Presentation: Publish** returns the public
slug URL (copied) and the immutable `/releases/{id}` URL.

Edit `slide.md` on either side; the other should converge.

## Protocol (matches server)

- First text frame: `{"type":"hello","client_id":"...","protocol_version":1,"last_known_revision":N}`
- Server: `ready` JSON (`revision`, `has_snapshot`), then optional binary Yjs snapshot when `has_snapshot`
- Optional: `workspace.reconcile_required` when revision gap / stale base
- Further binary frames: Yjs updates (`Y.Doc` text key `content`)

## Sync notes

- **Init order:** connect → ready/snapshot barrier → Document Binding → SyncController local watchers.
- **External rewrite:** `FileSystemWatcher` on bound `**/slide.md` reads disk, prefix/suffix-diffs into Y.Text (`FS_RECONCILE`).
- **Reconnect:** WS drop → backoff → hello again → barrier → merge (apply server snapshot + push full local Yjs state).
- **Reconciliation:** revision gap / bulk local topology / stale base → snapshot pull (`FS_RECONCILE`, not UndoManager).

## Undo (Yjs UndoManager)

- Local typing uses origin `LOCAL_EDITOR` → tracked by per-doc `Y.UndoManager`.
- Remote applies use `REMOTE_SYNC`; FileSystemWatcher / reconcile diffs use `FS_RECONCILE` (not undo-tracked).
- Keybindings: Ctrl/Cmd+Z / redo → `presentation.undo` / `presentation.redo` when `presentation.collaborativeEditor && editorTextFocus`.

## Preview

**Presentation: Open Preview** opens `{server}/preview/{projectId}/` using
`.presentation/workspace.json` (same metadata as Connect). The browser shows Server
collaborative state (including unsaved CRDT text edits).

