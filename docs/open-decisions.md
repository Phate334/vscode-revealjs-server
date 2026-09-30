# Decisions Still Requiring PoC Validation

> Source: Part VIII of [`collaborative-presentation-spec.md`](./collaborative-presentation-spec.md)

下列項目**不應在實測前鎖死**。M0（及延續至 M1 的項目）應產出實測筆記後再定案；更新本檔時請標註結論與日期，並連結相關 PR／測試紀錄。

## 待驗證決策

| # | 決策 | 建議驗證里程碑 | 狀態 |
|---|---|---|---|
| 1 | Python Server 使用哪一個 Yjs-compatible CRDT binding / websocket implementation | M0 | 未決 |
| 2 | VS Code native undo stack 與 CRDT UndoManager 的整合方式 | M0 | 未決 |
| 3 | local external rewrite 如何轉成最穩定的 CRDT diff | M0 | 未決 |
| 4 | filesystem watcher 在各平台的 debounce 策略 | M0（單檔）→ M1（bulk） | 未決 |
| 5 | Git checkout / merge 的 bulk-change detection threshold | M1 | 未決 |
| 6 | text CRDT persistence 採 update log、snapshot，或兩者混合 | M0 | 未決 |
| 7 | WebSocket binary protocol 的最終 framing | M0 | 未決 |
| 8 | presence 是否在 MVP 顯示 cursor | M0 不做 UI；M3 產品化前取捨 | 未決 |
| 9 | binary concurrent replacement 的 UX | M1 | 未決 |
| 10 | snapshot archive format 與大型 asset 的下載策略 | M1 / M3 Publish | 未決 |

## 原文要點（Part VIII）

1. Python Server 使用哪一個 Yjs-compatible CRDT binding / websocket implementation。
2. VS Code native undo stack 與 CRDT UndoManager 的整合方式。
3. local external rewrite 如何轉成最穩定的 CRDT diff。
4. filesystem watcher 在各平台的 debounce 策略。
5. Git checkout / merge 的 bulk-change detection threshold。
6. text CRDT persistence 採 update log、snapshot，或兩者混合。
7. WebSocket binary protocol 的最終 framing。
8. presence 是否在 MVP 顯示 cursor。
9. binary concurrent replacement 的 UX。
10. snapshot archive format 與大型 asset 的下載策略。

## 如何更新

- 實測後將「狀態」改為 `已決`，並在列下或附註寫入選定方案與簡短理由。
- 未通過 PoC 前，程式碼可試用候選實作，但文件與對外承諾不得寫死單一 library／undo 模型／framing。
