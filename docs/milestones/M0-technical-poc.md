# M0 — Technical PoC

> Spec: §42 Phase 0 — Technical PoC · §50 Recommended Immediate Implementation Target  
> Status: `not_started`（現有 FastAPI scaffold ≠ PoC 完成）

## 目標

先驗證最危險假設：**Document Binding + Sync Controller + CRDT + FastAPI WebSocket** 能否讓兩個真正的 VS Code local workspace，穩定共同編輯同一個實體 `slide.md`（含 concurrent edit、offline/reconnect、外部改檔後的 reconciliation）。

PoC 環境：

```text
VS Code A               FastAPI Server                VS Code B

folder A                                                folder B
   │                                                       │
slide.md                                                slide.md
   │                                                       │
   └── TextDocument ↔ CRDT ↔ WS ↔ CRDT ↔ TextDocument ────┘
```

## 前置條件

- [x] FastAPI + uv server scaffold 存在（`src/vscode_revealjs_server/`、`/health`）
- [x] Agent box 已安裝 VS Code 1.139.1（供兩個 workspace 實測）
- [ ] 選定並試用一組 Yjs-compatible Python CRDT / WebSocket binding（PoC 後再鎖定，見 [`../open-decisions.md`](../open-decisions.md)）
- [ ] 可啟動兩個獨立 VS Code window，分別開啟 `fixtures/alice` 與 `fixtures/bob`

不需要：正式 Auth、Project UI、PostgreSQL 完整 schema、Object Storage、Preview、Publish。

## 執行順序

### Server

1. 在現有 FastAPI app 上新增 collaboration 模組骨架（對齊 §6 / §50：`collaboration/` — manager、document、persistence、protocol）。
2. 實作 WebSocket endpoint：`WS /api/projects/{project_id}/collaboration`（PoC 可用固定 `project_id` / 免正式 token）。
3. 接入 Yjs-compatible CRDT document：接收 / 廣播 `text.sync` / `text.update`（binary frame 可先簡化；控制訊息 JSON）。
4. 實作最小 document persistence（重啟後可恢復同一 `slide.md` 的 CRDT state；格式待 PoC 驗證，見 open decision #6）。
5. 實作連線生命週期：`hello` / `ready`、`ping` / `pong`、斷線後 client 可重連並同步。
6. 保留 `/health`；補上手動 / 自動化整合測試入口（兩個 client 模擬更新）。

### Extension

7. 建立 `extension/` package（`package.json`、`extension.ts`），可在 VS Code 1.139.1 載入。
8. 實作 `collaborationClient.ts`：連上 Server WS、交換 CRDT updates。
9. 實作 `documentBinding.ts` + `OriginTracker`：
   - Local → CRDT：`onDidChangeTextDocument` → 略過 remote origin → CRDT transaction → Client
   - CRDT → VS Code：remote update → `WorkspaceEdit`（標記 remote）→ 避免 echo loop
10. 實作最小 Sync Controller：origin tracking、連線狀態（至少 Connected / Offline / Syncing）、retry。
11. 實作 FileSystemWatcher 路徑：外部改寫 `slide.md` 時讀檔 → 與 local CRDT 比對 → 以 diff 套用為 local CRDT transaction（勿整檔上傳繞過 merge）。
12. 準備 `fixtures/alice/slide.md` 與 `fixtures/bob/slide.md`，用兩個 VS Code workspace 跑完整 PoC 清單。

### PoC 實測與決策記錄

13. 依下方 12 項驗證逐條實測；結果寫入 [`../open-decisions.md`](../open-decisions.md) 對應項目（undo 策略、外部 rewrite diff、WS framing、persistence 等）。
14. 通過後才進入 M1；未通過則迭代 Binding / Sync / CRDT，不擴充 Preview / Publish。

## 範圍外（PoC 不做）

依 §42：

```text
Project UI
Sidebar
Permissions
Preview
Publish
Binary asset sync
Full directory sync
```

另刻意不做：正式 JWT auth、members、sharing、workspace revisions 完整模型、presence UI（§17：MVP 第一個 PoC 不要求）、PostgreSQL / Object Storage 完整落地。

## 驗收目標

### PoC 驗證項目（§42，12 項）

- [ ] 1. Alice 與 Bob 同時輸入同一個 `slide.md`
- [ ] 2. 雙方即時看到彼此修改
- [ ] 3. concurrent edit 正確 merge
- [ ] 4. VS Code undo / redo 行為可接受
- [ ] 5. save / autosave 不破壞 CRDT
- [ ] 6. 一方暫時斷線仍可編輯
- [ ] 7. 雙方斷線期間分別修改，重新連線後可以 converge
- [ ] 8. Extension restart 後可以恢復同步
- [ ] 9. Server restart 後 persisted document 可以恢復
- [ ] 10. Claude Code / Codex / shell 直接改檔後可以轉成 CRDT edit
- [ ] 11. remote WorkspaceEdit 不產生 echo loop
- [ ] 12. 大量 file rewrite 不會造成無限同步

### Collaboration 驗收（§46，本 milestone 應對齊）

- [ ] 兩個 VS Code local workspace 可同時編輯同一份 text file
- [ ] 不需 save 即可傳播 edit
- [ ] concurrent insert/delete 可以 converge
- [ ] reconnect 後可以 converge
- [ ] 不產生 remote/local echo loop
- [ ] Extension reload 後可恢復
- [ ] Server restart 後 state 可恢復

### Undo / Connection（§30 · §35）

- [ ] 實測並記錄：native undo 與 remote updates 共存情況；local undo 不應還原他人 edit
- [ ] Status 至少可區分 Connected / Offline / Syncing

## PoC 驗證點（解鎖 Open Decisions）

本 milestone 必須產出足夠證據，才能鎖定 Part VIII 決策（見 [`../open-decisions.md`](../open-decisions.md)）：

| # | 決策 | M0 要驗證什麼 |
|---|---|---|
| 1 | Python Yjs-compatible CRDT / WS binding | 選定候選並在真實雙 workspace 下穩定收發 |
| 2 | VS Code native undo vs CRDT UndoManager | 完成 §30 四點實測並記錄取捨 |
| 3 | local external rewrite → CRDT diff | shell / agent 改檔後 converge 且無整檔覆蓋 |
| 4 | filesystem watcher debounce | 單檔大量 rewrite 不迴圈（驗證項 12） |
| 5 | Git bulk-change threshold | M0 可先記錄單檔行為；完整 threshold 可延至 M1 |
| 6 | text CRDT persistence 策略 | Server restart 後可恢復（驗證項 9） |
| 7 | WebSocket binary framing | text update 可穩定傳輸；記錄暫用 framing |
| 8 | presence cursor | **本 PoC 不做**；維持「不顯示」直到另開決策 |
| 9–10 | binary UX / snapshot archive | **屬 M1+**；M0 不驗證 |

## 完成定義 (DoD)

兩個真正的 VS Code local workspace（非 mock-only）透過本 repo 的 FastAPI WebSocket 與 Yjs-compatible CRDT，能長時間穩定共同編輯同一個實體 `slide.md`：concurrent edit 可 merge、單方／雙方 offline 後可 converge、Extension 與 Server restart 可恢復、外部程式改檔可轉成 CRDT edit且無 echo loop／無限同步；§42 十二項與 §46 Collaboration 勾選通過，且 Part VIII 中與 text sync 相關的決策已有實測筆記。僅有 `/health` scaffold 或單側 editor 不算完成。
