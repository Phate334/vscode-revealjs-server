# Explicit Non-Goals for MVP

> Source: Part VII of [`collaborative-presentation-spec.md`](./collaborative-presentation-spec.md)

MVP **刻意不做**下列項目。實作與驗收時勿將其當成缺口補上；若未來要做，需另開 milestone／規格修訂。

## 清單

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

## 對齊架構原則（§1）

這些 non-goals 呼應產品核心原則：不以 Web Editor / Remote VS Code / Virtual FS 取代本機真實目錄；AI agent 與 Git 工具只操作普通 filesystem，由 Sync Controller 同步，而非在 Server 上自建 agent 或 Git hosting。
