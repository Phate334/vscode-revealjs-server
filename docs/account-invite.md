# 帳號與邀請

登入、註冊、貼上連結都用 VS Code 指令和視窗上方的輸入框（`showInputBox`）。沒有側邊欄。

## 帳號

使用者存在 `users.json`（預設 `.data/users.json`）。密碼只存 PBKDF2-HMAC-SHA256。

沒有內建帳號。第一個使用者執行 **Presentation: Register**。尚未登入時 **Presentation: Sign In** 會先選 **Sign in** 或 **Register**，再依序填使用者名稱與遮罩密碼。

**Register** 是 `POST /api/auth/register`（名稱已存在回 409）。**Sign in** 是 `POST /api/auth/login`（未知使用者或密碼錯誤都是 401）。

`AUTH_DEMO_USER` 可省略。若設定，格式是逗號分隔的 `username:password`，啟動時只補上還沒有的使用者。

`presentation.serverUrl`（預設 `http://127.0.0.1:8000`）是新動作的 origin。已開啟的簡報用自己的 origin。登入狀態依 origin 分開。

**Presentation: Sign Out** 先選 Yes／No，確認後清除這個 origin 存在 Secret Storage 的 session，並中斷協作連線。

## 帳號邀請連結

邀請只用來建立帳號，不加入簡報，也沒有 editor／viewer。

已登入即可建立，不必開啟簡報。**Presentation: Create Account Invite**（尚未登入會先用同一組輸入框登入或註冊）呼叫 `POST /api/account-invites`，剪貼簿得到：

```text
{origin}/join#{token}
```

撤銷前可重複使用，沒有到期。同一條連結可以註冊多個新帳號。`GET /join` 只是說明。Token 在 `#` 後面，瀏覽器不會把它送到伺服器。

## 接受邀請

**Presentation: Accept Invitation** 在上方輸入框貼上連結（`{origin}/join#{token}`、`?token=`、舊的 JSON，或只有 token）。

`GET /api/account-invites/{token}` 確認連結還在。這個 origin 已經登入就停在這裡，不建立第二個帳號。

還沒登入就接著使用者名稱與遮罩密碼。`POST /api/account-invites/{token}/register` 建立帳號並登入。名稱已存在回 409，不改密碼。不會加入任何簡報。

## 簡報連結

編輯不需要先被加進成員。任何已登入、知道這份簡報的人都可以讀寫。

在已開啟的簡報執行 **Presentation: Copy Presentation Link**，得到 `{origin}/open#{project_id}`。

對方先有帳號，再 **Presentation: Open Presentation** → **Open from link…**，貼上連結。還沒登入會先要帳密。然後下載並開啟，之後的協作與寫入都允許。

**Open Presentation** 的清單仍只列出自己擁有的，以及以前就在成員名單裡的簡報。沒被列進去不代表不能編輯。

**Presentation: Project Members** 只列出 `meta.json` 裡的成員，不決定能不能寫。
