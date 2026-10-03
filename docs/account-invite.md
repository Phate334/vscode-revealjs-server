# 帳號與邀請

這份文件說明目前的登入與邀請連結。操作都在 VS Code 指令與視窗上方的快速輸入框（`vscode.window.showInputBox`）完成。沒有側邊欄、沒有 webview 表單、也沒有從邀請連結建立帳號。

## 帳號

伺服器沒有內建帳號，也不提供註冊 API。能登入的帳號只來自環境變數 `AUTH_DEMO_USER`：一組或多組 `username:password`，以逗號分隔。沒有設定時 Compose 不會啟動。

密碼留在該環境變數裡，由伺服器在登入時比對。邀請連結不會建立使用者，也不會改密碼。

`presentation.serverUrl`（預設 `http://127.0.0.1:8000`）是新動作使用的伺服器 origin。已經開啟的簡報使用它自己記錄的 origin。登入狀態依 origin 分開存放。

## 登入

**Presentation: Sign In**，以及建立、開啟、分享、接受邀請等需要登入的指令，都使用同一段輸入：

1. 上方輸入框：使用者名稱。
2. 上方輸入框：密碼，`password: true`，輸入時遮罩。

帳號密碼必須是 `AUTH_DEMO_USER` 裡的一組。沒有第二套註冊畫面。取消任一格就停止，不會送出登入。

## 邀請連結

只有該簡報的 owner 可以建立邀請。在已開啟的簡報執行 **Presentation: Share Presentation**，於上方快速選擇選 `viewer` 或 `editor`。

伺服器 `POST /api/projects/{project_id}/invites`，回應包含 `token` 與 `url`。`url` 的形狀是：

```text
{origin}/join#{token}
```

`origin` 來自這次請求的位址（與擴充功能呼叫的伺服器相同）。指令把 `url` 複製到剪貼簿，不是 JSON。

同一個連結在撤銷前可以重複使用，沒有到期時間。用它加入時，新成員的角色等於連結上的角色。已經是成員的人角色不變，不會因為再接受一次而升級或降級。

`GET /join` 只是一段說明。Token 放在 `#` 後面時，瀏覽器不會把 token 送到伺服器。真正加入是在 VS Code 裡完成。

## 接受邀請

對方必須已經有自己的帳號（同一份 `AUTH_DEMO_USER` 裡的另一組），不能靠連結註冊。

**Presentation: Accept Invitation**，或 **Open Presentation** 裡的 **Accept invitation…**，會在上方輸入框請你貼上連結。可接受的文字：

| 貼上的內容 | 結果 |
|---|---|
| `http://host/join#{token}` | 採用連結裡的 origin 與 token |
| `http://host/join?token={token}` | 同上，token 改從 query 讀 |
| `{"server":"http://host","token":"…"}` | 舊的剪貼簿 JSON，仍可接受 |
| 只有 token | 使用這個指令目前的伺服器 |

解析出伺服器之後，若還沒登入，就依序出現使用者名稱與遮罩密碼兩個輸入框（與 Sign In 相同）。登入的是既有帳號。

接著 `GET /api/invites/{token}` 預覽簡報名稱與角色（需要已登入）。上方快速選擇 **Accept and Open** 後，`POST /api/invites/{token}/accept` 才加入，並下載開啟該簡報。取消選擇就不會加入。

`editor` 可寫入，`viewer` 唯讀。非成員讀取專案會得到 403。

## 撤銷

`DELETE /api/projects/{project_id}/invites/{share_id}` 讓該連結不能再被接受。已經加入的人不被移除。擴充功能的指令沒有提供撤銷；列出成員用 **Presentation: Project Members**（`GET /api/projects/{project_id}/members`）。
