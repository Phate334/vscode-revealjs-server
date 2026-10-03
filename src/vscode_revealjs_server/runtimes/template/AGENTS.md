# 簡報編輯指引

- 在各章節的 `slide.md`（Markdown）裡編輯內容；章節順序以 `index.html` 的 `<section data-markdown="...">` 為準。
- 版面與樣式請用 CSS（例如根目錄 `theme.css`），不要在內容裡寫 HTML 標籤。
- Reveal.js 設定（transition、controls、plugins 等）請直接改 `index.html` 裡的 `Reveal.initialize({...})`。
- 預覽與發布把專案當靜態網站提供；Reveal 執行期在專案內的 `runtime/`，章節 markdown 與素材請用相對路徑。
