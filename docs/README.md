# Collaborative Presentation Platform — 執行進度

> **以 VS Code 為主要編輯介面的 Local Workspace 協作簡報系統。Server 負責專案、權限、即時協作、Preview 與 Publish；VS Code Extension 負責把本機工作目錄與 Server collaborative workspace 同步。**

## Spec

完整架構與 MVP 規格：[`collaborative-presentation-spec.md`](./collaborative-presentation-spec.md)  
（同源備份：[`_source-spec.md`](./_source-spec.md)）

相關規劃文件：

| 文件 | 說明 |
|---|---|
| [`milestones/README.md`](./milestones/README.md) | Milestone 順序與依賴 |
| [`non-goals.md`](./non-goals.md) | MVP Explicit Non-Goals（Part VII） |
| [`open-decisions.md`](./open-decisions.md) | 需 PoC 驗證後才鎖定的決策（Part VIII） |


## Version control

本專案以 **Git** 做架構與進度的版本控制（規格、milestone、server、extension 同一 repo）。

- 根目錄 `.gitignore` 以 [github/gitignore](https://github.com/github/gitignore) 的 **Python**、**Node**（VS Code 外掛／npm tooling）、以及 **Global/VisualStudioCode** 模板組合而成；專案專用規則放在檔案底部，後續開發視情況增刪。
- 進度狀態以 `docs/README.md` 與各 milestone checkbox 為準；完成一項工作後應留下可審查的 commit（勿把 `.venv`、`node_modules`、`*.vsix`、`.presentation/` 等本地產物納入版本庫）。
- 目前 milestone 狀態見下方 Overall Progress；尚未開始功能實作前，先維持乾淨的初始追蹤。

## Overall Progress

| Milestone | Status | Goal | Acceptance summary |
|---|---|---|---|
| [M0 Technical PoC](./milestones/M0-technical-poc.md) | `not_started` | Document Binding + Sync Controller + CRDT + FastAPI WebSocket，讓兩個真實 VS Code workspace 穩定共同編輯同一個 `slide.md` | 12 項 PoC 驗證 + Collaboration 驗收（§46）部分 |
| [M1 Workspace Sync](./milestones/M1-workspace-sync.md) | `not_started` | snapshot、檔案拓撲、binary assets、revisions、reconciliation、project create/open | Filesystem 驗收（§47） |
| [M2 Preview](./milestones/M2-preview.md) | `not_started` | Server Preview、resolver、reveal.js runtime、Open Preview | Preview 驗收（§48） |
| [M3 Product MVP](./milestones/M3-product-mvp.md) | `not_started` | auth、members、permissions、sharing、publish、immutable releases、public slug | Publish 驗收（§49）+ 端到端流程 |

Status 取值：`not_started` / `in_progress` / `done` / `blocked`

## Current State（repo 現況）

截至目前（agent box）：

- **Server scaffold 已存在**：本 repo 為 FastAPI + uv 專案（`src/vscode_revealjs_server/`、`pyproject.toml`、`uv.lock`），具有 `/health` endpoint。**僅有 scaffold ≠ M0 PoC 完成**，故 M0 標為 `not_started`。
- **VS Code 1.139.1** 已安裝於 agent box，可供 extension 測試使用。
- **Extension package 尚未開始**（尚無 `extension/`、`package.json`、Document Binding）。
- **Collaboration / CRDT / WebSocket sync 尚未開始**（尚無 Yjs-compatible document、collaboration endpoint、Sync Controller）。
- **Preview / Publish / Auth / Project Service 尚未開始**。

## Recommended Next Action

依規格 §50：**立即目標 = M0 Technical PoC**。

第一個成功條件：

> 兩個真正的 VS Code local workspace，可以透過 FastAPI WebSocket + Yjs-compatible CRDT 穩定共同編輯同一個實體 `slide.md`，包含 concurrent edit、offline/reconnect，以及外部程式修改檔案後的 reconciliation。

建議先落地 §50 的最小 repo layout（`server/collaboration/`、`extension/` Document Binding + Collaboration Client、`fixtures/alice|bob/slide.md`），再擴充 Project Service、Assets、Preview、Publish。詳見 [`milestones/M0-technical-poc.md`](./milestones/M0-technical-poc.md) 與 [`milestones/README.md`](./milestones/README.md)。

## 如何更新本檔

工作完成或狀態變更時：

1. 更新上表對應 Milestone 的 **Status**（`not_started` → `in_progress` → `done`；卡住則 `blocked` 並在下方加註原因）。
2. 必要時調整 **Acceptance summary** 以反映已通過的驗收項。
3. 在 **Current State** 補上實際達成的模組／路徑（勿把 scaffold 或半成品標成 `done`）。
4. 完成一個 milestone 的 DoD 後，把 **Recommended Next Action** 改為下一個 milestone 的立即目標。
5. 同步勾選該 milestone 檔案內的驗收 checkboxes。
