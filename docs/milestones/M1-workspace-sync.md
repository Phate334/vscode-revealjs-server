# M1 — Workspace Sync

> Spec: §43 Phase 1 — Workspace Sync  
> Status: `not_started`

## 目標

在 M0 已證明單檔 text CRDT 可穩定 converge 之後，把 Local Workspace 與 Server Collaborative Workspace 擴成完整專案同步：含 initial snapshot、檔案拓撲操作、binary assets、workspace revisions、reconciliation，以及 project create/open。

## 前置條件

- [ ] **M0 DoD 通過**（雙 workspace 單檔 `slide.md` 協作穩定）
- [ ] Open Decisions 中與 text sync 相關項目已有實測結論（至少 #1–#4、#6–#7）
- [ ] 可擴充 Server 模組：`workspace/`、`assets/`、`projects/`（對齊 §6）
- [ ] Extension 已有 Sync Controller / Collaboration Client 骨架可擴充

## 執行順序

依 §43 加入範圍，建議實作順序：

### Server — Project & Snapshot

1. Project Service 最小版：`POST /api/projects`、`GET /api/projects`、`GET /api/projects/{project_id}`（auth 可先 stub；正式權限留 M3）。
2. Workspace snapshot：`GET /api/projects/{project_id}/snapshot` — 新 client 可下載當前 collaborative workspace 拓撲與 text/binary 參考（§13）。
3. Workspace revision 模型：每次成功的 fs / asset / text-affecting topology 變更遞增 revision；WS 廣播 `workspace.revision`（§12）。

### Server — File Operations & Assets

4. File operations 協定：`fs.operation` / `fs.operation_ack`，支援 create、delete、rename、move、mkdir（§11）。
5. Path validation（§40）：禁止跳脫專案根目錄、arbitrary nested 超出版本約束者拒絕。
6. Asset Service：`PUT/GET/DELETE /api/projects/{project_id}/assets/{path}`；binary 不以 CRDT 合併，採 replacement（§14、§8.2）。
7. WS 通知 `asset.changed`；儲存可先用本機目錄，正式 Object Storage 可後補。

### Server — Reconciliation

8. `workspace.reconcile_required` 與 reconciliation API／流程：client 帶 `last_known_revision`；gap 過大或 snapshot + revision 合流不完整時強制 reconcile（§15）。
9. 規則：reconcile 以 Server collaborative state 為準；勿用單一 client 的 local 覆蓋 Server（§15.1）。

### Extension — Sync 擴充

10. `snapshotClient.ts`：Open / Create Project 時下載 snapshot，寫入 local workspace。
11. FileWatcher + Sync Controller：偵測 create/delete/rename/move/mkdir，排隊送 `fs.operation`；套用 remote ops 時標記 origin，避免回聲。
12. `assetSync.ts`：本機 binary 變更 → upload；收到 `asset.changed` → download replacement。
13. `reconciliation.ts`：revision gap、Git checkout / merge 造成的 bulk filesystem change → 觸發 reconciliation（§37）。
14. Commands：`Presentation: Create Project`、`Presentation: Open Project`（§25、§27、§28）；寫入 local project metadata（§26）。
15. 驗證清單：新 client 從 snapshot 加入、snapshot + revision gap 不漏事件、rename converge、binary replacement、Git checkout reconciliation（§43）。

## 範圍外

- Preview / Publish / public slug（M2 / M3）
- 正式 authentication、members、permissions、sharing UI（M3；本階段可用 stub token）
- presence cursor UI
- binary CRDT 或精細 binary conflict merge（Non-Goals）
- Sidebar「PRESENTATIONS」完整 UI（§25：Sidebar 不是 PoC blocker，M1 亦可後做）
- local reveal preview（Non-Goals）

## 驗收目標

### Phase 驗證（§43）

- [ ] 新 client 能從 snapshot 正確加入
- [ ] snapshot + revision gap 不漏事件
- [ ] rename 在所有 client converge
- [ ] binary replacement 能同步
- [ ] Git checkout 可以 reconciliation

### Filesystem 驗收（§47）

- [ ] create 同步
- [ ] delete 同步
- [ ] rename 同步
- [ ] move 同步
- [ ] mkdir 同步
- [ ] binary asset replacement 同步
- [ ] Git bulk change 可以 reconciliation

### Project 流程

- [ ] Create Project 後得到可同步的 local workspace + Server collaborative workspace
- [ ] Open Existing / Shared Project（共享連結的完整權限可待 M3）可 snapshot 加入並持續 sync

## PoC 驗證點（延續）

M1 應補齊 Part VIII 中與 workspace 相關的決策證據：

- [ ] #5 Git checkout / merge 的 bulk-change detection threshold
- [ ] #9 binary concurrent replacement 的 UX（last-write / 提示策略）
- [ ] #10 snapshot archive format 與大型 asset 下載策略

## 完成定義 (DoD)

兩位使用者可 Create / Open 同一專案，從 snapshot 進入後持續同步：文字仍走 CRDT，檔案拓撲（create/delete/rename/move/mkdir）與 binary replacement 皆 converge，workspace revision 不漏事件；Git 等 bulk change 可走 reconciliation 對齊 Server collaborative state。§43 驗證項與 §47 Filesystem 全部勾選通過。尚未要求 Preview 畫面或正式 Publish。
