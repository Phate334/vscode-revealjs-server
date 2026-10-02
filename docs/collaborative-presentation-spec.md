> Synchronization, onboarding, preview security and protocol updates for 0.1.2 are defined in [workspace-architecture.md](workspace-architecture.md). Older examples below are historical design context.

# Collaborative Presentation Platform — Architecture & MVP Specification

> Status: Architecture baseline / MVP specification  
> Primary editor: VS Code  
> Server stack baseline: Python + uv + FastAPI  
> Collaboration model: Local Workspace replica + Server Collaborative Workspace  
> Presentation runtime: reveal.js  
> Collaboration transport: WebSocket + HTTP

---

## 1. Product Definition

本產品定義為：

> **以 VS Code 為主要編輯介面的 Local Workspace 協作簡報系統。Server 負責專案、權限、即時協作、Preview 與 Publish；VS Code Extension 負責把本機工作目錄與 Server collaborative workspace 同步。**

核心原則：

1. 不自行開發 Web Editor。
2. 不使用 Remote VS Code Server。
3. 不使用 Virtual FileSystem 作為主要工作區。
4. 使用者直接編輯 OS 上真實存在的檔案與目錄。
5. Server 上的 collaborative workspace 是團隊「目前正在編輯的版本」。
6. 每位使用者的 Local Workspace 是 collaborative workspace 的 replica。
7. Release 是由 Server collaborative state 建立的 immutable artifact。
8. VS Code、Git、Shell、Copilot、Codex、Claude Code 等工具都只需要操作普通 filesystem，不需要理解 Presentation Server。

---

## 2. High-Level Architecture

```text
                        Presentation Server
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Auth Service                                               │
│                                                             │
│  Project Service                                            │
│  ├─ projects                                                │
│  ├─ members / permissions                                   │
│  ├─ templates                                               │
│  └─ sharing                                                 │
│                                                             │
│  Collaboration Service                                      │
│  ├─ Yjs-compatible text documents                           │
│  ├─ workspace revisions                                     │
│  ├─ file operations                                         │
│  ├─ presence                                                │
│  └─ reconnect / reconciliation                              │
│                                                             │
│  Asset Service                                              │
│  └─ images / videos / binary files                          │
│                                                             │
│  Preview Service                                            │
│  └─ /preview/{project_id}/                                  │
│                                                             │
│  Publish Service                                            │
│  ├─ snapshot                                                │
│  ├─ build                                                   │
│  └─ immutable releases                                      │
│                                                             │
└───────────────────────────┬─────────────────────────────────┘
                            │
                         HTTP + WS
                            │
             ┌──────────────┼──────────────┐
             │              │              │
             ▼              ▼              ▼
           Alice           Bob           Carol
          VS Code         VS Code        VS Code
             │              │              │
          Extension      Extension      Extension
             │              │              │
             ▼              ▼              ▼
          Local FS       Local FS       Local FS
```

---

## 3. Presentation Project Format

每份簡報是一個普通資料夾。

建議結構：

```text
product-strategy/
│
├─ index.html
├─ theme.css
├─ AGENTS.md
│
├─ 01-introduction/
│  ├─ slide.md
│  ├─ hero.png
│  └─ demo.mp4
│
├─ 02-market/
│  ├─ slide.md
│  └─ chart.svg
│
└─ 03-roadmap/
   └─ slide.md
```

### 3.1 Directory constraint

MVP 維持兩層結構：

```text
project/
├─ root files
└─ chapter/
   └─ chapter files
```

不支援任意深度 nested directory。

原因：

- asset path 較簡單
- rename / move 較容易處理
- workspace snapshot 較容易產生
- Publish build 較單純
- Git export 較直觀
- reconciliation 範圍較容易定義

### 3.2 `index.html`

`index.html`：

- 可由使用者直接編輯；專案是靜態網站。
- 建立新 project 時由 Server default template 產生完整可顯示的 Reveal.js deck（含專案內 `runtime/` 腳本／樣式、`Reveal.initialize`、章節 `<section data-markdown>`）。
- Reveal 設定（transition、controls、plugins 等）寫在 HTML 內，不另用設定檔。
- 章節順序由 `index.html` 的 section 列表決定，不依賴 directory name 排序。
- Preview 與 Publish 都直接提供這份 `index.html`（不做 deck 組裝／injection）。

### 3.3 `AGENTS.md`（預設範本）

新建專案預設含 `AGENTS.md`：提醒以章節 Markdown 編輯內容、用 CSS 處理版面、避免在內容裡寫 HTML 標籤。

---

## 4. VS Code as the Primary Editor

不實作：

```text
Web Markdown Editor
CodeMirror
Web File Explorer
Web Tabs
Web Search
Custom Code Editor
Virtual FileSystem
Remote VS Code Server
```

直接使用 VS Code 已有能力：

```text
Explorer
Text Editor
Markdown
HTML
CSS
YAML
Search
Git
Terminal
Extensions
Copilot
Codex
Claude Code
```

產品只需要提供：

```text
Presentation VS Code Extension
```

---

# Part I — Server

## 5. Server Technology Baseline

這一節屬於目前架構的「建議落地實作」，用來把已定案的 Server 責任具體化。

### 5.1 Runtime

```text
Python 3.12+
uv
FastAPI
Uvicorn
WebSocket
PostgreSQL
Object Storage
```

套件管理與虛擬環境統一由 `uv` 管理。

建議初始化：

```bash
uv init --package presentation-server
uv add fastapi uvicorn[standard] pydantic-settings
uv add sqlalchemy asyncpg alembic
uv add python-multipart
uv add pyjwt cryptography
uv add --dev pytest pytest-asyncio httpx ruff mypy
```

Yjs-compatible Python library 在 PoC 階段驗證後鎖定。Server protocol 不應與特定 Python CRDT library 耦合。

### 5.2 Run

Development：

```bash
uv run uvicorn presentation_server.main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --reload
```

Production：

```bash
uv run uvicorn presentation_server.main:app \
  --host 0.0.0.0 \
  --port 8000
```

---

## 6. Server Repository Layout

建議：

```text
server/
├─ pyproject.toml
├─ uv.lock
├─ alembic.ini
├─ migrations/
│
├─ src/
│  └─ presentation_server/
│     ├─ main.py
│     ├─ config.py
│     ├─ dependencies.py
│     │
│     ├─ api/
│     │  ├─ auth.py
│     │  ├─ projects.py
│     │  ├─ snapshots.py
│     │  ├─ assets.py
│     │  ├─ preview.py
│     │  ├─ publish.py
│     │  └─ websocket.py
│     │
│     ├─ auth/
│     │  ├─ service.py
│     │  └─ models.py
│     │
│     ├─ projects/
│     │  ├─ service.py
│     │  ├─ repository.py
│     │  └─ models.py
│     │
│     ├─ collaboration/
│     │  ├─ manager.py
│     │  ├─ document.py
│     │  ├─ persistence.py
│     │  ├─ protocol.py
│     │  └─ presence.py
│     │
│     ├─ workspace/
│     │  ├─ service.py
│     │  ├─ snapshot.py
│     │  ├─ revision.py
│     │  ├─ operations.py
│     │  └─ reconciliation.py
│     │
│     ├─ assets/
│     │  ├─ service.py
│     │  └─ storage.py
│     │
│     ├─ presentation/
│     │  ├─ preview.py
│     │  ├─ runtime.py
│     │  ├─ publish.py
│     │  └─ release.py
│     │
│     └─ db/
│        ├─ session.py
│        └─ models.py
│
└─ tests/
   ├─ integration/
   └─ unit/
```

原則：

- FastAPI route 不放核心商業邏輯。
- collaboration / workspace / assets 分開。
- WebSocket protocol 定義集中在 `collaboration/protocol.py`。
- Preview 不直接依賴 Server filesystem。
- Publish 不直接讀某個 client 的 local workspace。

---

## 7. Server Modules

### 7.1 Auth Service

責任：

```text
login
token issue
token refresh
current user
WebSocket authentication
```

MVP 可以先使用簡單 JWT access token。

API：

```http
POST /api/auth/login
POST /api/auth/refresh
GET  /api/auth/me
```

---

### 7.2 Project Service

責任：

```text
create project
list own projects
list shared projects
project metadata
members
permissions
default template
share settings
```

API baseline：

```http
POST   /api/projects
GET    /api/projects
GET    /api/projects/{project_id}
PATCH  /api/projects/{project_id}
DELETE /api/projects/{project_id}

GET    /api/projects/{project_id}/members
POST   /api/projects/{project_id}/members
DELETE /api/projects/{project_id}/members/{user_id}
```

建立 project 時：

```text
POST /api/projects
        ↓
create project record
        ↓
instantiate default template
        ↓
initialize collaborative workspace
        ↓
create revision
        ↓
return project metadata
```

---

## 8. Collaborative Workspace Model

Server 上的 collaborative workspace 是 authoritative collaborative state。

但它不是單一 directory copy。

邏輯上：

```text
CollaborativeWorkspace
├─ Text Documents
│  └─ Yjs-compatible CRDT state
│
├─ File Tree
│  └─ logical paths / metadata
│
├─ Binary Assets
│  └─ object storage references
│
└─ Revision
   └─ monotonic workspace revision
```

### 8.1 Text state

例如：

```text
01-introduction/slide.md
theme.css
index.html
AGENTS.md
```

Server 持有：

```text
path → CRDT document
```

### 8.2 Binary state

例如：

```text
hero.png
demo.mp4
chart.svg
font.woff2
```

Server 持有：

```text
path
content hash
size
mime type
object storage key
revision
```

Binary 不放進 Y.Doc。

---

## 9. Text Collaboration

Text 類型：

```text
*.md
*.css
*.html
*.yaml
*.yml
*.json
*.txt
*.js
```

主要同步方式：

```text
VS Code TextDocument
        ↕
Document Binding
        ↕
local CRDT document
        ↕
WebSocket
        ↕
Server CRDT document
```

### 9.1 Desired behavior

Alice：

```text
typing
  ↓
onDidChangeTextDocument
  ↓
local CRDT update
  ↓
WebSocket
  ↓
Server
  ↓
broadcast
  ↓
Bob CRDT
  ↓
WorkspaceEdit
  ↓
Bob editor
```

不需要：

```text
Ctrl+S
upload whole file
reload
```

---

## 10. Collaboration WebSocket

建議 endpoint：

```text
WS /api/projects/{project_id}/collaboration
```

連線時需攜帶：

```text
access token
client_id
workspace_id / project_id
last_known_revision
protocol_version
```

### 10.1 Logical message classes

WebSocket protocol 至少需要：

```text
hello
ready

text.sync
text.update

fs.operation
fs.operation_ack

asset.changed

workspace.revision
workspace.reconcile_required

presence.update

ping
pong

error
```

實際 Yjs update payload 可使用 binary frame；控制訊息可使用 JSON。

### 10.2 Example control message

```json
{
  "type": "fs.operation",
  "operation_id": "op_123",
  "base_revision": 42,
  "operation": {
    "kind": "rename",
    "from": "01-introduction",
    "to": "01-overview"
  }
}
```

Server 成功後：

```json
{
  "type": "fs.operation_ack",
  "operation_id": "op_123",
  "revision": 43
}
```

---

## 11. File Operations

CRDT 只解決文字內容，不處理 filesystem topology。

必須額外同步：

```text
create
delete
rename
move
mkdir
```

所有結構性操作由 Server 產生新的 workspace revision。

### 11.1 Example

```text
Alice:
01-introduction/
    ↓ rename
01-overview/
```

Extension：

```text
fs.operation
from = 01-introduction
to   = 01-overview
```

Server：

```text
validate permission
        ↓
validate path
        ↓
apply operation
        ↓
revision 42 → 43
        ↓
broadcast operation
```

其他 client：

```text
receive operation
      ↓
apply to local filesystem
      ↓
suppress local echo
```

---

## 12. Workspace Revision

Workspace revision 用來追蹤「非 CRDT 結構變更」與 snapshot 邊界。

範例：

```text
revision 100
revision 101
revision 102
```

revision 適用於：

- file create
- file delete
- directory create
- rename
- move
- binary asset replacement
- snapshot generation
- reconciliation boundary

文字內部每一個 keystroke 不需要建立 workspace revision。

---

## 13. Snapshot

用途：

1. 新 client 首次開啟 project。
2. client 與 Server 差距過大。
3. reconciliation。
4. Publish。
5. 備份 / restore。

API：

```http
GET /api/projects/{project_id}/snapshot
```

snapshot 必須是一致視圖：

```text
snapshot_revision = N

snapshot
├─ file tree @ N
├─ text state @ N
└─ asset references @ N
```

下載流程：

```text
request snapshot
      ↓
Server captures revision N
      ↓
download archive / manifest
      ↓
extract local workspace
      ↓
connect WebSocket with revision N
      ↓
receive N+1 changes onward
```

因此不會出現：

```text
snapshot 一半是 revision 100
另一半已經是 revision 104
```

---

## 14. Binary Asset Service

Binary：

```text
png
jpg
jpeg
gif
webp
svg
mp4
webm
pdf
woff
woff2
```

同步策略：

```text
HTTP upload/download
+
WebSocket change notification
```

API baseline：

```http
PUT    /api/projects/{project_id}/assets/{path}
GET    /api/projects/{project_id}/assets/{path}
DELETE /api/projects/{project_id}/assets/{path}
```

建議上傳流程：

```text
local filesystem change
      ↓
hash file
      ↓
HTTP upload
      ↓
Server stores object
      ↓
workspace revision++
      ↓
WS asset.changed
      ↓
other clients download
```

Binary concurrent replacement：**optimistic concurrency**（path + content_hash + revision；PUT `base_revision`；不符 → 409 AssetConflict）。Extension 提示「使用我的／保留遠端」。不再 silent LWW（決策 #9，2026-10-01）。

---

## 15. Reconciliation

Sync Controller 偵測以下情境時，需要進 reconciliation：

```text
Git checkout
Git merge
Git pull
mass formatter change
AI agent batch edit
shell script rewrite
offline reconnect
missed file events
unknown local/server revision
```

流程：

```text
pause normal file-operation emission
        ↓
scan local tree
        ↓
obtain Server manifest
        ↓
compare
        ↓
classify changes
        ↓
CRDT text merge
binary/file topology resolve
        ↓
resume normal sync
```

### 15.1 Important rule

Git 操作造成的大量變更不能被視為數十個互不相關的人工 edit。

Sync Controller 需要 debounce / bulk-change detection。

---

## 16. Offline Behavior

離線時：

```text
Local editing       ✓
VS Code             ✓
Git                 ✓
local filesystem    ✓

Realtime sync       ✗
Server Preview      ✗
Publish             ✗
```

Extension 必須：

- 不阻止 local edit。
- 保存本機尚未送出的 CRDT update。
- 保存必要的 local change metadata。
- 顯示 connection state。
- reconnect 後進行 CRDT merge + workspace reconciliation。

重新連線：

```text
local CRDT changes
        +
server CRDT changes
        ↓
CRDT merge
        ↓
filesystem reconciliation
        ↓
clients converge
```

---

## 17. Presence

Presence 不屬於持久內容。

可同步：

```text
user id
display name
currently open file
cursor / selection
connection state
```

MVP 第一個 PoC 不要求 presence UI。

---

## 18. Storage

### 18.1 PostgreSQL

建議資料：

```text
users
projects
project_members
workspace_revisions
workspace_operations
text_document_persistence
assets
releases
release_aliases
```

概念 schema：

```text
projects
- id
- name
- slug
- owner_id
- runtime
- current_revision
- published_release_id
- created_at
- updated_at
```

```text
project_members
- project_id
- user_id
- role
```

```text
workspace_operations
- id
- project_id
- revision
- operation_type
- payload
- actor_id
- created_at
```

### 18.2 Object Storage

```text
assets/
  {project_id}/{content_hash}

releases/
  {release_id}/...
```

Development 可以先使用 local filesystem implementation，介面維持 object storage abstraction。

---

## 19. Preview Service

不做 local Reveal preview。

VS Code command：

```text
Presentation: Open Preview
```

開啟：

```text
https://server/preview/{project_id}/
```

Preview 的 source of truth：

```text
Server Collaborative Workspace
```

不是：

```text
Alice local filesystem
Bob local filesystem
Server mirrored directory
```

### 19.1 Resolver

```text
Collaborative Workspace
      │
      ├─ text → current CRDT state
      │
      └─ asset → asset storage
              ↓
       Preview Resolver
              ↓
          reveal.js
```

例如：

```http
GET /preview/{project_id}/01-market/slide.md
```

resolver 直接取得：

```text
current text state("01-market/slide.md")
```

所以 Preview 可以看到尚未 `Ctrl+S` 的即時 collaborative state。

---

## 20. reveal.js Runtime

每個 project 自帶 `runtime/`（建立時從 server package seed 複製）。沒有 shared HTTP `/runtimes` registry。

Project workspace：

```text
workspace/
├─ index.html          # relative href/src → runtime/...
├─ runtime/
│  ├─ reveal.js
│  ├─ reveal.css
│  ├─ markdown/
│  ├─ highlight/
│  ├─ notes/
│  └─ theme/
└─ …
```

Preview：直接提供 collaborative workspace（含 `runtime/`）。

Publish：把當下 snapshot（含 `runtime/` 與 binaries）完整複製到 `releases/{id}/`。

必要條件：

> Preview 與 Publish 使用相同 runtime。

避免：

- CDN runtime 漂移
- Preview / Release 版本不一致
- 外部 dependency 突然改版

---

## 21. Publish

VS Code command：

```text
Presentation: Publish
```

Publish source：

```text
Server Collaborative Workspace
```

不是 Alice 的 local directory。

流程：

```text
Collaborative Workspace
        ↓
consistent snapshot
        ↓
build
        ↓
immutable release
        ↓
static hosting
```

API：

```http
POST /api/projects/{project_id}/publish
GET  /api/projects/{project_id}/releases
GET  /api/projects/{project_id}/releases/{release_id}
GET  /api/releases/{release_id}
```

---

## 22. Immutable Release

Server 產生：

```text
releases/
├─ rel_abc123/
│  ├─ index.html          # relative runtime/ URLs
│  ├─ theme.css
│  ├─ runtime/            # vendored Reveal (copied from project)
│  ├─ 01-introduction/    # text + binaries inline
│  └─ ...
│
└─ rel_def456/
```

（決策 #10 已取代，2026-10-01：每版完整樹複製含 runtime；無 blobs/、無 assets.json、無 shared /runtimes。）

Release 建立後內容不可修改。

Project 只有 pointer：

```text
published_release_id = rel_def456
```

公開 URL：

```text
https://slides.example.com/presentations/product-strategy/
```

resolved to：

```text
rel_def456
```

另外提供 immutable URL：

```text
/releases/rel_def456
```

重新 Publish 只更新 pointer：

```text
rel_abc123
     ↓
rel_def456
```

自然支援：

```text
history
rollback
audit
cache
fixed-version sharing
```

---

# Part II — VS Code Extension

## 23. Extension Responsibilities

Extension 不負責 render editor。

主要責任：

```text
Authentication
Project Manager
Collaboration Client
Document Binding
File Sync
Sync Controller
Preview Command
Publish Command
```

架構：

```text
Presentation Extension
│
├─ Authentication
│
├─ Project Manager
│  ├─ create
│  ├─ open
│  ├─ download snapshot
│  └─ local project metadata
│
├─ Collaboration Client
│  ├─ WebSocket
│  ├─ CRDT
│  └─ reconnect
│
├─ Document Binding
│  ├─ TextDocument → CRDT text
│  └─ CRDT text → WorkspaceEdit
│
├─ File Sync
│  ├─ watcher
│  ├─ assets
│  ├─ create/delete
│  └─ rename/move
│
├─ Sync Controller
│  ├─ origin tracking
│  ├─ conflict handling
│  ├─ debounce
│  ├─ bulk-change detection
│  └─ reconciliation
│
├─ Preview Command
│
└─ Publish Command
```

技術風險最高：

```text
Document Binding
+
Sync Controller
```

---

## 24. Extension Repository Layout

建議：

```text
extension/
├─ package.json
├─ tsconfig.json
├─ esbuild.js
├─ src/
│  ├─ extension.ts
│  │
│  ├─ auth/
│  │  └─ authManager.ts
│  │
│  ├─ projects/
│  │  ├─ projectManager.ts
│  │  ├─ projectMetadata.ts
│  │  └─ snapshotClient.ts
│  │
│  ├─ collaboration/
│  │  ├─ collaborationClient.ts
│  │  ├─ protocol.ts
│  │  ├─ documentStore.ts
│  │  └─ reconnect.ts
│  │
│  ├─ binding/
│  │  ├─ documentBinding.ts
│  │  └─ originTracker.ts
│  │
│  ├─ sync/
│  │  ├─ syncController.ts
│  │  ├─ fileWatcher.ts
│  │  ├─ assetSync.ts
│  │  ├─ operationQueue.ts
│  │  └─ reconciliation.ts
│  │
│  ├─ commands/
│  │  ├─ createProject.ts
│  │  ├─ openProject.ts
│  │  ├─ preview.ts
│  │  └─ publish.ts
│  │
│  └─ ui/
│     └─ statusBar.ts
│
└─ test/
```

---

## 25. Extension Commands

第一版：

```text
Presentation: Sign In

Presentation: Create Project
Presentation: Open Project
Presentation: Open Shared Project

Presentation: Open Preview

Presentation: Share Project
Presentation: Project Members

Presentation: Publish
```

Sidebar 可以後做：

```text
PRESENTATIONS

My Presentations
├─ Product Strategy
├─ Q4 Review
└─ Demo

Shared with Me
├─ Company All Hands
└─ Design Review
```

Sidebar 不是 PoC blocker。

---

## 26. Local Project Metadata

每個 clone 下來的 local workspace 需要知道它對應哪個 Server project。

建議 Extension 維護：

```text
.presentation/
└─ workspace.json
```

例如：

```json
{
  "version": 1,
  "server": "https://slides.example.com",
  "projectId": "prj_123",
  "lastKnownRevision": 42
}
```

`.presentation/`：

- 不屬於簡報內容。
- 不應 Publish。
- 建議加入 `.gitignore`。
- 可以由 Extension 自動重建。

---

## 27. Create Project Flow

```text
Presentation: Create Project
        ↓
input project name
        ↓
select local parent directory
        ↓
POST /api/projects
        ↓
Server creates template workspace
        ↓
GET snapshot
        ↓
extract to local folder
        ↓
write .presentation/workspace.json
        ↓
VS Code openFolder()
        ↓
connect collaboration WebSocket
```

---

## 28. Open Existing / Shared Project

```text
Presentation: Open Shared Project
        ↓
select project
        ↓
select local directory
        ↓
GET consistent snapshot @ revision N
        ↓
extract
        ↓
openFolder()
        ↓
WS connect(lastKnownRevision=N)
        ↓
receive changes after N
```

---

## 29. Document Binding

Document Binding 是最關鍵模組之一。

### 29.1 Local → CRDT

監聽：

```ts
vscode.workspace.onDidChangeTextDocument(...)
```

流程：

```text
VS Code change
     ↓
ignore if origin = remote
     ↓
convert VS Code edit to CRDT transaction
     ↓
local CRDT state
     ↓
Collaboration Client
```

### 29.2 CRDT → VS Code

流程：

```text
remote CRDT update
      ↓
calculate TextDocument edits
      ↓
mark origin = remote
      ↓
vscode.WorkspaceEdit
      ↓
TextDocument
```

必須避免：

```text
remote update
   ↓
WorkspaceEdit
   ↓
onDidChangeTextDocument
   ↓
send same update again
   ↓
loop
```

因此需要 `OriginTracker`。

---

## 30. Undo / Redo

PoC 必須驗證：

- VS Code native undo 是否與 remote updates 共存。
- local undo 不應把其他使用者的 edit 一起回復。
- remote update 是否污染 native undo stack。
- CRDT UndoManager 與 VS Code native undo 的取捨。

第一版不要假設行為一定正確，需以 PoC 實測結果決定。

---

## 31. File Watcher

TextDocument event 只能看到 VS Code editor 發生的 edit。

還必須監控 filesystem，因為以下工具可能直接修改檔案：

```text
Copilot
Codex
Claude Code
formatter
shell
Python script
Node script
Git checkout
Git merge
Git pull
other VS Code extension
```

Extension 不需要知道「誰」改檔。

只需要知道：

```text
workspace changed
```

監控來源：

```text
TextDocument Events
+
FileSystemWatcher
```

---

## 32. Sync Controller

核心資料流：

```text
                 Local Workspace
                       │
            ┌──────────┴──────────┐
            │                     │
   TextDocument Events      FileSystem Events
            │                     │
            └──────────┬──────────┘
                       ▼
                Sync Controller
                       │
            ┌──────────┴──────────┐
            │                     │
         Text CRDT          File Operations
            │                     │
          WebSocket             HTTP / WS
            │                     │
            └──────────┬──────────┘
                       ▼
                     Server
```

Sync Controller 必須處理：

```text
origin tracking
debounce
event coalescing
operation queue
connection state
retry
revision tracking
bulk filesystem changes
reconciliation
```

---

## 33. Local Text Changed Outside VS Code Editor

例如 Claude Code 直接重寫：

```text
01-market/slide.md
```

File watcher 看到 change 後：

```text
read new file
      ↓
compare local CRDT text
      ↓
derive text diff
      ↓
apply diff as local CRDT transaction
      ↓
send CRDT update
```

不要直接：

```text
upload entire text file
```

否則會繞過 concurrent merge。

---

## 34. Remote Filesystem Operation

例如 Bob 將：

```text
01-market/
```

rename 成：

```text
02-market/
```

Alice 收到：

```text
fs.operation
```

Extension：

```text
mark operation origin = remote
        ↓
apply fs rename
        ↓
watcher emits event
        ↓
Sync Controller detects remote origin
        ↓
do not echo operation
```

---

## 35. Connection State

建議 Status Bar：

```text
Presentation: Connected
Presentation: Syncing…
Presentation: Offline
Presentation: Conflict
```

PoC 至少需要：

```text
Connected
Offline
Syncing
```

---

## 36. AI Agent Compatibility

架構不直接整合特定 agent。

```text
Alice + Copilot
Bob   + Claude Code
Carol + Codex
```

agent：

```text
AI Agent
   ↓
Local Workspace
   ↓
Sync Controller
   ↓
Server Collaborative Workspace
   ↓
Everyone
```

這是選 Local Workspace 而不是 Virtual Workspace 的主要理由之一。

---

## 37. Git / Worktree Rules

一般 Git：

```text
git checkout
git pull
git merge
```

可能一次改大量檔案。

必須：

```text
bulk filesystem change
        ↓
Sync Controller
        ↓
workspace reconciliation
        ↓
Server
```

### 37.1 Agent worktree

建議規則：

```text
main collaborative workspace
        └─ sync ✓

agent worktree
        └─ sync ✗
```

Agent 在獨立 worktree 工作時不直接加入 collaboration。

merge 回 main collaborative workspace 後才同步。

---

# Part III — Protocol & State Model

## 38. Source of Truth by Data Type

| Data | Source of truth |
|---|---|
| Text content | Server CRDT collaborative state |
| Directory / path topology | Server workspace state + revision |
| Binary assets | Server asset metadata + object storage |
| Current editable project state | Server Collaborative Workspace |
| Local editing copy | Local Workspace replica |
| Preview | Server Collaborative Workspace |
| Published version | Immutable Release |
| Current public version | Project → published_release_id |

---

## 39. Conflict Strategy

### Text

```text
CRDT merge
```

不使用：

```text
last-write-wins whole text file
```

### Binary

```text
optimistic concurrency
(path + content_hash + revision; base_revision on PUT; 409 AssetConflict)
```

Extension UX：使用我的／保留遠端（決策 #9，2026-10-01）。

### File topology

使用：

```text
Server serialized operation
+
workspace revision
```

若 base revision 無法安全套用：

```text
reconcile_required
```

---

## 40. Security & Path Validation

所有 Server path operation 必須：

- normalize path
- 禁止 `..`
- 禁止 absolute path
- 禁止 escaping project root
- 驗證 project membership
- 驗證 write permission
- 限制 project depth
- 驗證 reserved paths
- 防止 overwrite 不允許的 Server metadata

Server 不應信任 Extension 傳入的 filesystem path。

---

# Part IV — API Baseline

## 41. HTTP API

```text
POST   /api/auth/login
POST   /api/auth/refresh
GET    /api/auth/me

POST   /api/projects
GET    /api/projects
GET    /api/projects/{project_id}
PATCH  /api/projects/{project_id}

GET    /api/projects/{project_id}/members
POST   /api/projects/{project_id}/members
DELETE /api/projects/{project_id}/members/{user_id}

GET    /api/projects/{project_id}/snapshot

PUT    /api/projects/{project_id}/assets/{path}
GET    /api/projects/{project_id}/assets/{path}
DELETE /api/projects/{project_id}/assets/{path}

POST   /api/projects/{project_id}/publish
GET    /api/projects/{project_id}/releases
GET    /api/projects/{project_id}/releases/{release_id}
GET    /api/releases/{release_id}

GET    /preview/{project_id}/
GET    /preview/{project_id}/{path}

GET    /presentations/{slug}/
GET    /releases/{release_id}/
```

WebSocket：

```text
WS /api/projects/{project_id}/collaboration
```

---

# Part V — MVP Execution Plan

## 42. Phase 0 — Technical PoC

先只驗證最危險假設。

環境：

```text
VS Code A               FastAPI Server                VS Code B

folder A                                                folder B
   │                                                       │
slide.md                                                slide.md
   │                                                       │
   └── TextDocument ↔ CRDT ↔ WS ↔ CRDT ↔ TextDocument ────┘
```

驗證項目：

1. Alice 與 Bob 同時輸入同一個 `slide.md`。
2. 雙方即時看到彼此修改。
3. concurrent edit 正確 merge。
4. VS Code undo / redo 行為可接受。
5. save / autosave 不破壞 CRDT。
6. 一方暫時斷線仍可編輯。
7. 雙方斷線期間分別修改，重新連線後可以 converge。
8. Extension restart 後可以恢復同步。
9. Server restart 後 persisted document 可以恢復。
10. Claude Code / Codex / shell 直接改檔後可以轉成 CRDT edit。
11. remote WorkspaceEdit 不產生 echo loop。
12. 大量 file rewrite 不會造成無限同步。

PoC 不做：

```text
Project UI
Sidebar
Permissions
Preview
Publish
Binary asset sync
Full directory sync
```

---

## 43. Phase 1 — Workspace Sync

加入：

```text
initial snapshot
create/delete
rename/move
mkdir
binary assets
workspace revisions
reconciliation
project create/open
```

驗證：

- 新 client 能從 snapshot 正確加入。
- snapshot + revision gap 不漏事件。
- rename 在所有 client converge。
- binary replacement 能同步。
- Git checkout 可以 reconciliation。

---

## 44. Phase 2 — Preview

加入：

```text
Server Preview
Preview Resolver
reveal.js runtime
Open Preview command
```

驗證：

- Preview 讀 collaborative state。
- 未 save 的文字 edit 能出現在 Preview。
- asset path 正確。
- Preview runtime 與 project runtime 一致。

---

## 45. Phase 3 — Product MVP

加入：

```text
authentication
members
permissions
sharing
publish
immutable releases
public slug
release history
```

最終使用流程：

```text
Install Presentation Extension
        ↓
Sign In
        ↓
Create / Open Project
        ↓
normal VS Code workspace
        ↓
edit Markdown / CSS / HTML
        ↓
team sees updates in realtime
        ↓
Open Preview
        ↓
browser shows collaborative state
        ↓
Publish
        ↓
obtain public URL
```

---

# Part VI — Acceptance Criteria

## 46. Collaboration

- [ ] 兩個 VS Code local workspace 可同時編輯同一份 text file。
- [ ] 不需 save 即可傳播 edit。
- [ ] concurrent insert/delete 可以 converge。
- [ ] reconnect 後可以 converge。
- [ ] 不產生 remote/local echo loop。
- [ ] Extension reload 後可恢復。
- [ ] Server restart 後 state 可恢復。

## 47. Filesystem

- [ ] create 同步。
- [ ] delete 同步。
- [ ] rename 同步。
- [ ] move 同步。
- [ ] mkdir 同步。
- [ ] binary asset replacement 同步。
- [ ] Git bulk change 可以 reconciliation。

## 48. Preview

- [ ] 所有使用者看到相同 Preview。
- [ ] Preview 不是讀任一 client local filesystem。
- [ ] Preview 直接反映 collaborative state。
- [ ] Preview 與 Publish 使用相同 reveal runtime。

## 49. Publish

- [ ] Publish 從 Server collaborative state 建 snapshot。
- [ ] 每次 Publish 產生新 release。
- [ ] 舊 release 不被修改。
- [ ] public slug 可切換到新 release。
- [ ] immutable release URL 永久指向同一版本。

---

# Part VII — Explicit Non-Goals for MVP

MVP 不需要：

- 自製 Web code editor
- browser IDE
- VS Code remote server
- virtual filesystem
- arbitrary nested directory
- Git hosting
- 自建 AI agent
- local reveal preview
- binary CRDT
- sophisticated binary conflict merge
- realtime collaborative terminal
- realtime Git branch collaboration
- arbitrary extension sandbox

---

# Part VIII — Decisions Still Requiring PoC Validation

狀態追蹤見本機 `docs/open-decisions.md`（gitignored）。截至 2026-10-01：

1. **已決** — pycrdt + FastAPI WS。
2. **已決** — Yjs UndoManager + conditional keybindings。
3. **已決** — prefix/suffix 單次 patch；oldText = last projected known state。
4. **已決** — FILE_SETTLE_MS=150 trailing per-path；無 OS-specific。
5. **已決（heuristic）** — ≥8 unique paths / 1000ms；非正式架構條款。
6. **已決** — merged Y.Doc state blob／project；無 update log；不拆 per-path Docs。
7. **已決（PoC framing）** — JSON control + opaque Yjs binary。
8. **可排除／MVP deferred** — presence cursor UI。
9. **已決** — 409 AssetConflict + 使用我的／保留遠端（停止 silent LWW）。
10. **已取代（superseded）** — 原 shared `/runtimes/{pin}/` + content-addressed blobs + release `assets.json` 已廢止。改為 project 自帶 `runtime/`、Publish 完整樹複製至 `releases/{id}/`；Preview=`/preview/{project_id}/`、Publish=`POST .../publish`、Release=`/releases/{id}/`、alias=`/presentations/{slug}/`。

---

# 50. Recommended Immediate Implementation Target

第一個可執行 repository 建議只有：

```text
presentation/
├─ server/
│  ├─ pyproject.toml
│  ├─ uv.lock
│  └─ src/presentation_server/
│     ├─ main.py
│     └─ collaboration/
│
├─ extension/
│  ├─ package.json
│  └─ src/
│     ├─ extension.ts
│     ├─ collaborationClient.ts
│     └─ documentBinding.ts
│
└─ fixtures/
   ├─ alice/slide.md
   └─ bob/slide.md
```

第一個成功條件只有：

> **兩個真正的 VS Code local workspace，可以透過 FastAPI WebSocket + Yjs-compatible CRDT 穩定共同編輯同一個實體 `slide.md`，包含 concurrent edit、offline/reconnect，以及外部程式修改檔案後的 reconciliation。**

這一關成立後，再往 Project Service、Assets、Preview、Publish 擴充。

---

# 51. Architecture Summary

```text
VS Code
   │
   ▼
Local Workspace
   │
   ├─ TextDocument / FileSystemWatcher
   │
   ▼
Presentation Extension
   │
   ├─ CRDT text sync
   ├─ filesystem operations
   ├─ asset transfer
   └─ reconciliation
   │
   ▼
FastAPI Presentation Server
   │
   ▼
Collaborative Workspace
   │
   ├──────────────→ Live Preview
   │
   └── Snapshot → Build → Immutable Release
```

最重要的架構邊界：

> **Local Workspace 是開發者真正操作的工作區；Server Collaborative Workspace 是多人協作的 authoritative current state；Release 是從 Server state 產生的 immutable artifact。**

最優先的工程工作不是完整 UI，而是先證明：

> **Document Binding + Sync Controller + CRDT + FastAPI WebSocket 可以讓兩個普通 VS Code workspace 長時間穩定 converge。**
