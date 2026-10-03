# 帳號與邀請

登入、註冊、貼上連結都用 VS Code 指令和視窗上方的輸入框（`showInputBox`）。沒有側邊欄。

## 帳號

使用者存在 `users.json`（預設 `.data/users.json`）。密碼只存 PBKDF2-HMAC-SHA256。新密碼至少 8 個字元。

沒有內建帳號。還沒有任何使用者時，第一個帳號用 **Presentation: Register**（`POST /api/auth/register`）。已經有帳號之後，同一個位址回 403，註冊關閉；之後的帳號只能走帳號邀請。指令還在，403 會說明要改用邀請。

尚未登入時 **Presentation: Sign In** 會先選 **Sign in** 或 **Register**，再依序填使用者名稱與遮罩密碼。名稱已存在回 409。**Sign in** 是 `POST /api/auth/login`（未知使用者或密碼錯誤都是 401）。

`AUTH_DEMO_USER` 可省略。若設定，格式是逗號分隔的 `username:password`，啟動時只補上還沒有的使用者。補過之後就已經有帳號，直接 Register 會關閉。

`presentation.serverUrl`（預設 `http://127.0.0.1:8000`）是新動作的 origin。已開啟的簡報用自己的 origin。登入狀態依 origin 分開。沒有 session 時不會開協作 WebSocket。

**Presentation: Sign Out** 先選 Yes／No，確認後清除這個 origin 存在 Secret Storage 的 session，並中斷協作連線。

## 帳號邀請連結

邀請只用來建立帳號，不加入簡報。

已登入即可建立，不必開啟簡報。**Presentation: Create Account Invite**（尚未登入會先用同一組輸入框登入或註冊）呼叫 `POST /api/account-invites`，剪貼簿得到：

```text
{origin}/join#{token}
```

可重複使用，沒有到期。同一條連結可以註冊多個新帳號。`GET /join` 只是說明。Token 在 `#` 後面，瀏覽器不會把它送到伺服器。

## 接受帳號邀請

**Presentation: Accept Invitation** 在上方輸入框貼上連結（`{origin}/join#{token}`、`?token=`、舊的 JSON，或只有 token）。

`GET /api/account-invites/{token}` 確認連結還在。這個 origin 已經登入就停在這裡，不建立第二個帳號。

還沒登入就接著使用者名稱與遮罩密碼（至少 8 個字元）。`POST /api/account-invites/{token}/register` 建立帳號並登入。名稱已存在回 409，不改密碼。不會加入任何簡報。

## 簡報連結

只有成員能讀寫。擁有者可以讀、寫、分享、發佈。Editor 可以讀、寫、預覽。不是成員回 403；簡報不存在仍是 404。

在已開啟的簡報執行 **Presentation: Copy Presentation Link**（只有擁有者）。伺服器發出可重複使用的 editor 邀請，剪貼簿得到：

```text
{origin}/open#{token}
```

連結裡是邀請 token，不是 project id。知道 project id 不能編輯。

對方執行 **Presentation: Open Presentation** → **Open from link…**，貼上同一條連結。還沒登入會先登入或註冊，然後接受邀請（成為 editor），再下載並開啟。已經登入就直接加入再開啟。擁有者再貼一次不會被降成 editor。

**Open Presentation** 列出自己擁有的，以及被分享的簡報（Shared with Me）。

**Presentation: Project Members** 只列出成員。沒有另外的加入或移除成員 API；成員來自建立簡報（擁有者）或接受簡報連結。

協作 WebSocket 仍用 `?access_token=`。沒有 session 不會連線。關閉碼 4401（未登入或 token 無效）與 4403（不是成員）會停止重連。網路中斷仍會重連。
