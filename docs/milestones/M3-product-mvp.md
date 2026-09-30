# M3 — Product MVP

> Spec: §45 Phase 3 — Product MVP  
> Status: `not_started`

## 目標

把已驗證的協作、workspace sync 與 Preview 包成可交付產品流程：authentication、members、permissions、sharing、publish、immutable releases、public slug 與 release history，走完「安裝 Extension → 登入 → 建／開專案 → 即時協作 → Preview → Publish → 取得公開 URL」端到端路徑。

## 前置條件

- [ ] **M0–M2 DoD 通過**
- [ ] Snapshot 可從 Server collaborative state 取得（M1）
- [ ] Preview 與 Publish 將共用同一 reveal.js runtime（M2）
- [ ] HTTP API 基線已規劃（§41）

## 執行順序

依 §45 加入範圍：

### Server — Auth & Project 權限

1. Auth Service（§7.1）：`POST /api/auth/login`、`POST /api/auth/refresh`、`GET /api/auth/me`；MVP 可用簡單 JWT。
2. WebSocket 與 HTTP 皆驗證 access token；拒絕未授權的 collaboration / snapshot / asset / publish。
3. Members / permissions：`GET/POST /api/projects/{project_id}/members`、`DELETE .../members/{user_id}`。
4. Sharing：產生／接受分享，對齊 `Presentation: Share Project` / `Open Shared Project`（§25、§28）。

### Server — Publish & Releases

5. Publish Service（§21）：`POST /api/projects/{project_id}/releases` — **一律從 Server collaborative state 建 snapshot**，不讀任一 client local workspace。
6. Build：以與 Preview 相同的 reveal.js runtime 產出靜態 artifact。
7. Immutable Release（§22）：每次 Publish 新 `release_id`；舊 release 內容不可變。
8. 公開路由：`GET /s/{slug}`（可切換指向目前 release）、`GET /release/{release_id}`（永久指向該版本）。
9. Release history：`GET /api/projects/{project_id}/releases`、`GET .../releases/{release_id}`。

### Extension — 產品命令

10. `Presentation: Sign In` + `authManager.ts`。
11. 完善 Create / Open / Open Shared Project（帶真實 token 與權限錯誤處理）。
12. `Presentation: Share Project`、`Presentation: Project Members`。
13. `Presentation: Publish` — 呼叫 Publish API，回傳 public URL / release URL。
14. （可選）Sidebar PRESENTATIONS 列表；非阻塞，但有助於產品完整度。

### 端到端驗證

15. 依 §45 最終使用流程跑通一輪（兩位真實使用者或兩 workspace + 公開瀏覽器）：

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

## 範圍外

依 Part VII（完整列表見 [`../non-goals.md`](../non-goals.md)），MVP 仍不做：

- 自製 Web code editor / browser IDE / VS Code remote server / virtual filesystem
- Git hosting、自建 AI agent、local reveal preview
- binary CRDT、精細 binary conflict merge
- realtime collaborative terminal、realtime Git branch collaboration
- arbitrary nested directory、arbitrary extension sandbox

本 milestone 也不把「完美 presence cursor」當 blocker（open decision #8）。

## 驗收目標

### Publish 驗收（§49）

- [ ] Publish 從 Server collaborative state 建 snapshot
- [ ] 每次 Publish 產生新 release
- [ ] 舊 release 不被修改
- [ ] public slug 可切換到新 release
- [ ] immutable release URL 永久指向同一版本

### 端到端流程（§45）

- [ ] Sign In 成功並取得可用 token
- [ ] Create / Open / Open Shared Project 在權限模型下可用
- [ ] 協作編輯 + Open Preview 仍符合 M0–M2 行為
- [ ] Publish 後取得 `/s/{slug}` 與／或 `/release/{release_id}`
- [ ] Release history 可列出歷史版本

### 迴歸（先前 milestone）

- [ ] §46 Collaboration 仍通過
- [ ] §47 Filesystem 仍通過
- [ ] §48 Preview 仍通過（且 Publish runtime 與 Preview 相同）

## PoC 驗證點

- [ ] #8 presence 是否在 MVP 顯示 cursor — 產品化前做最終取捨並記錄
- [ ] #10 snapshot archive 在 Publish 路徑下的大型 asset 策略已落地或有明確限制說明

## 完成定義 (DoD)

完整產品路徑可演示：使用者安裝 Extension、登入、建立或開啟（含分享）專案、在普通 VS Code workspace 即時協作、Open Preview 看到 collaborative state、Publish 後得到可切換的 public slug 與不可變的 release URL；§49 與 §45 端到端流程勾選通過，且不回退 M0–M2 驗收。MVP Non-Goals 所列能力仍刻意不做。
