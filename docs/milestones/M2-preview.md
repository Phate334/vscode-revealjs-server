# M2 — Preview

> Spec: §44 Phase 2 — Preview  
> Status: `not_started`

## 目標

在 Server collaborative workspace 已可同步的前提下，提供 **Server Preview**：Preview Resolver 從 collaborative state 解析內容，搭配與專案一致的 reveal.js runtime；Extension 以 `Presentation: Open Preview` 開啟瀏覽器，讓所有人看到相同、且含未 save 文字 edit 的即時預覽。

## 前置條件

- [ ] **M1 DoD 通過**（snapshot、拓撲、assets、revision、reconciliation 可用）
- [ ] Collaborative text / assets 可從 Server 讀取（非依賴任一 client local FS）
- [ ] 專案格式約束已知：`index.html`、`deck.yaml`、目錄結構（§3）

## 執行順序

依 §44 加入範圍：

### Server — Preview Service

1. Preview Service 模組（§19）：路由 `GET /p/{project_id}/preview` 與 `GET /p/{project_id}/preview/{path}`。
2. Preview Resolver（§19.1）：
   - 從 Server collaborative workspace 讀 text CRDT 當前內容（含尚未落到 disk snapshot 的 edit）
   - 解析 asset path，指向 Asset Service / collaborative binary state
   - **禁止**讀取任一 client 的 local filesystem
3. 掛載 reveal.js runtime（§20）：Preview 使用的 runtime 必須與後續 Publish 相同（同一套專案 runtime 約定）。
4. 確保 Preview HTML / 靜態資源路徑在 `/p/{project_id}/preview/...` 下可解析；多使用者開同一 URL 見到同一 collaborative state。
5. 整合測試：Alice 未 save 的 Markdown 變更出現在 Bob 開啟的 Preview。

### Extension

6. Command：`Presentation: Open Preview`（§25）— 開啟瀏覽器指向 Server Preview URL。
7. （可選）Status Bar 顯示 Preview 連線／專案 context；不阻擋本 milestone。
8. 確認 Open Preview 使用的 `project_id` 來自 local project metadata（§26），而非掃描本機任意資料夾當作真相來源。

## 範圍外

- Publish、immutable releases、public slug、release history（M3）
- 正式 Auth / members / permissions（M3；Preview URL 可暫以專案級 stub 保護）
- **local reveal preview**（Explicit Non-Goal）
- 自製 Web code editor / browser IDE（Non-Goals）
- presence cursor、Sidebar 完整 UI

## 驗收目標

### Phase 驗證（§44）

- [ ] Preview 讀 collaborative state
- [ ] 未 save 的文字 edit 能出現在 Preview
- [ ] asset path 正確
- [ ] Preview runtime 與 project runtime 一致

### Preview 驗收（§48）

- [ ] 所有使用者看到相同 Preview
- [ ] Preview 不是讀任一 client local filesystem
- [ ] Preview 直接反映 collaborative state
- [ ] Preview 與 Publish 使用相同 reveal runtime  
  > 註：Publish 本體在 M3；本項在 M2 先確保 Preview 已接入「將與 Publish 共用」的 runtime 模組，M3 Publish 時不得另起第二套 runtime。

### Extension

- [ ] `Presentation: Open Preview` 可開啟正確的 Server Preview URL

## PoC 驗證點

- [ ] Resolver 在僅有 CRDT text + asset metadata 時即可渲染（不依賴 client disk save）
- [ ] 確認 Preview 與未來 Publish 共用 `presentation/runtime`（或同等模組），避免雙 runtime 漂移

## 完成定義 (DoD)

使用者在任一已同步專案執行 Open Preview 後，瀏覽器顯示的內容來自 Server collaborative state（含未 save 的 text edit 與正確 asset path），所有成員看到相同畫面；Preview 使用與專案約定一致、且將與 Publish 共用的 reveal.js runtime。§44 與 §48 勾選通過。尚未要求 Publish 或公開 slug。
