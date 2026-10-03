# 帳號與邀請

登入、註冊、貼上邀請都用 VS Code 指令和視窗上方的快速輸入框（`showInputBox`）。沒有側邊欄，沒有 webview。

## 帳號

使用者存在 `users.json`（與專案資料同一層，預設 `.data/users.json`）。密碼只存 PBKDF2-HMAC-SHA256，不存明文。

沒有內建帳號。Compose 不設定 `AUTH_DEMO_USER` 也能啟動，啟動後沒有任何使用者。

第一個使用者執行 **Presentation: Register**。尚未登入時 **Presentation: Sign In** 會先快速選擇 **Sign in** 或 **Register**。兩邊填資料的方式相同：上方輸入框使用者名稱，然後遮罩密碼（`password: true`）。取消任一格就停止。

**Register** 呼叫 `POST /api/auth/register`。名稱已存在回 409，不覆蓋密碼。**Sign in** 呼叫 `POST /api/auth/login`。沒有這個使用者或密碼錯誤都是 401。

`AUTH_DEMO_USER` 可省略。若設定，格式是逗號分隔的 `username:password`。啟動時只補上還沒有的使用者，密碼雜湊後即丟棄；已存在的使用者不改密碼。格式錯誤時伺服器拒絕啟動。

`presentation.serverUrl`（預設 `http://127.0.0.1:8000`）是新動作的 origin。已開啟的簡報用自己的 origin。登入狀態依 origin 分開。

## 邀請連結

只有 owner 可以建立。在已開啟的簡報執行 **Presentation: Share Presentation**，快速選擇 `viewer` 或 `editor`。

`POST /api/projects/{project_id}/invites` 回 `token` 與 `url`：

```text
{origin}/join#{token}
```

指令複製 `url`。撤銷前可重複使用，沒有到期。新成員的角色等於連結上的角色。已經是成員的人再接受一次，角色不變。

`GET /join` 只是說明。Token 在 `#` 後面，瀏覽器不會把它送到伺服器。

## 接受邀請

**Presentation: Accept Invitation**，或 **Open Presentation** 裡的 **Accept invitation…**，先在上方輸入框貼上連結：

| 貼上的內容 | 結果 |
|---|---|
| `http://host/join#{token}` | 用連結的 origin 與 token |
| `http://host/join?token={token}` | 同上 |
| `{"server":"http://host","token":"…"}` | 舊的 JSON |
| 只有 token | 用這個指令目前的伺服器 |

這個 origin 還沒登入時，接著使用者名稱與遮罩密碼兩個輸入框。`POST /api/auth/session`：

- 名稱是新的：建立帳號並登入。
- 名稱已存在且密碼正確：登入。
- 已存在但密碼錯誤：401，不建立、不改密碼。

已經登入就略過這兩格。

`GET /api/invites/{token}` 預覽名稱與角色。快速選擇 **Accept and Open** 後，`POST /api/invites/{token}/accept` 才加入並開啟。取消就不會加入。

`editor` 可寫，`viewer` 只讀。非成員讀取專案是 403。

## 撤銷

`DELETE /api/projects/{project_id}/invites/{share_id}` 讓連結不能再被接受。已加入的人留著。擴充功能沒有撤銷指令。**Presentation: Project Members** 列出成員（`GET /api/projects/{project_id}/members`）。
