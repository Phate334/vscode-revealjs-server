# RevealJS Collaboration (M0 PoC)

Minimal VS Code extension: bind workspace `slide.md` to the compose server at
`ws://127.0.0.1:8000/api/projects/poc/collaboration` via Yjs.

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

published compose port (`localhost:8000`), not host `uv run uvicorn`.

## Load in VS Code 1.139+

Two Extension Development Host windows (after compose is up):

```bash
code --extensionDevelopmentPath=$PWD \
  ../fixtures/alice
code --extensionDevelopmentPath=$PWD \
  ../fixtures/bob
```

Or open `extension/` and press F5 (`.vscode/launch.json` → Alice fixture).

Each window auto-connects when `.presentation/workspace.json` is present, or run
**RevealJS Collab: Connect**. Edit `slide.md` on either side; the other should converge.

## Protocol (matches server)

- First text frame: `{"type":"hello","client_id":"...","protocol_version":1}`
- Server: `ready` JSON, then optional binary Yjs snapshot
- Further binary frames: Yjs updates (`Y.Doc` text key `content`)
