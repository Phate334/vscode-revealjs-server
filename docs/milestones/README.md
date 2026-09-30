# Milestones Index

執行順序嚴格為：

```text
M0 Technical PoC → M1 Workspace Sync → M2 Preview → M3 Product MVP
```

## 為什麼必須依序

| 順序 | 原因 |
|---|---|
| M0 先於一切 | 最危險假設是 Document Binding + Sync Controller + CRDT + FastAPI WebSocket 能否讓兩個真實 VS Code workspace 長時間 converge。未證明前不應擴充 UI / Preview / Publish。 |
| M1 依賴 M0 | Preview 與 Publish 都以 Server collaborative state 為真相來源；需先有可靠的 workspace sync（snapshot、拓撲、binary、revision、reconciliation）。 |
| M2 依賴 M1 | Server Preview 讀的是 collaborative workspace（含未 save 的 text CRDT 與 asset path），不是任一 client 的 local filesystem。 |
| M3 依賴 M0–M2 | Publish 從 Server collaborative state 建 immutable release；auth / members / permissions / sharing 保護協作與公開路徑，需在 sync + preview 已可用後接入產品流程。 |

## Dependency Notes

| Capability | 依賴 |
|---|---|
| Text collaboration（單一 `slide.md`） | M0：CRDT + WS + Document Binding |
| Full directory / file ops / binary | M1：workspace operations + Asset Service |
| Preview | M1 collaborative state + M2 Preview Resolver / reveal.js runtime |
| Publish / public slug / release history | M1 snapshot + M2 同 runtime + M3 Auth / Publish Service |
| Auth / members / permissions / sharing | M3（PoC 與 M1/M2 可不做正式權限） |

## Immediate Implementation Target（§50）

第一個可執行 layout 建議：

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

> **註：** 本 repo 目前已有 FastAPI + uv scaffold（`src/vscode_revealjs_server/` + `/health`）。M0 應在現有 server 上擴充 `collaboration/` 與 WebSocket，並新增 `extension/` 與 `fixtures/`；scaffold 本身不代表 M0 完成。

## Milestone Files

| File | Phase | Spec |
|---|---|---|
| [M0-technical-poc.md](./M0-technical-poc.md) | Phase 0 — Technical PoC | §42 + §50 |
| [M1-workspace-sync.md](./M1-workspace-sync.md) | Phase 1 — Workspace Sync | §43 |
| [M2-preview.md](./M2-preview.md) | Phase 2 — Preview | §44 |
| [M3-product-mvp.md](./M3-product-mvp.md) | Phase 3 — Product MVP | §45 |

上層儀表板：[`../README.md`](../README.md)

版本控制：變更依 Git 追蹤；見 [`../README.md`](../README.md) 的 Version control。驗收／DoD 勾選應與對應 commit 可對應。
