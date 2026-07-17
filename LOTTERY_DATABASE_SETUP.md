# 抽獎系統資料庫設置指南

## 問題說明

在 Netlify Functions 中，文件系統是**只讀**的，這意味著無法直接將資料保存到文件。每次請求都是新的實例，內存中的資料不會保留。

## 解決方案

### 方案 1：使用環境變數存儲獎品資料（推薦，適用於少量資料）

#### 步驟 1：導出當前獎品資料

1. 訪問後台管理頁面：`https://your-site.netlify.app/admin`
2. 打開瀏覽器開發者工具（F12）
3. 在 Console 中執行以下代碼來獲取當前獎品資料：

```javascript
fetch('/api/admin/prizes', {
  headers: { 'X-API-Key': 'YOUR_API_KEY' }
})
  .then(r => r.json())
  .then(data => {
    const prizesJson = JSON.stringify(data.prizes || []);
    console.log('獎品資料 JSON:');
    console.log(prizesJson);
    // 複製這個 JSON 字串
  });
```

#### 步驟 2：設置 Netlify 環境變數

1. 進入 Netlify Dashboard → Site settings → Environment variables
2. 新增環境變數：
   - **Key**: `PRIZES_DATABASE`
   - **Value**: 將步驟 1 獲取的 JSON 字串貼上（**必須是單行，沒有換行**）
   - 勾選 "Contains secret values"
   - Scopes: "All scopes"
3. 點擊 "Create variable"

#### 步驟 3：重新部署

環境變數變更後需要重新部署：
- 方法 1：在 Netlify Dashboard 點擊 "Trigger deploy" → "Deploy site"
- 方法 2：推送一個空 commit：
  ```bash
  git commit --allow-empty -m "觸發重新部署以載入環境變數"
  git push origin main
  ```

#### 步驟 4：新增獎品後更新環境變數

每次新增、更新或刪除獎品後，需要：
1. 從後台獲取最新的獎品列表 JSON
2. 更新 Netlify 環境變數 `PRIZES_DATABASE` 的值
3. 重新部署

**注意**：Netlify 環境變數有大小限制（約 64KB），如果獎品資料過大，請使用方案 2。

---

### 方案 2：使用外部資料庫服務（推薦，適用於大量資料）

#### 選項 A：Supabase（免費方案）

1. 註冊 [Supabase](https://supabase.com/)
2. 創建新專案
3. 創建 `prizes` 表：
   ```sql
   CREATE TABLE prizes (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT,
     probability REAL NOT NULL,
     image TEXT,
     enabled BOOLEAN DEFAULT true,
     created_at TIMESTAMP DEFAULT NOW(),
     updated_at TIMESTAMP DEFAULT NOW()
   );
   ```
4. 獲取 API Key 和 URL
5. 在 Netlify 環境變數中設置：
   - `SUPABASE_URL`: 你的 Supabase 專案 URL
   - `SUPABASE_KEY`: 你的 Supabase API Key
6. 修改 `netlify/functions/admin.js` 使用 Supabase API

#### 選項 B：Firebase Firestore（免費方案）

1. 註冊 [Firebase](https://firebase.google.com/)
2. 創建新專案
3. 啟用 Firestore
4. 獲取配置資訊
5. 在 Netlify 環境變數中設置 Firebase 配置
6. 修改 `netlify/functions/admin.js` 使用 Firestore API

#### 選項 C：MongoDB Atlas（免費方案）

1. 註冊 [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. 創建免費集群
3. 獲取連接字串
4. 在 Netlify 環境變數中設置 `MONGODB_URI`
5. 修改 `netlify/functions/admin.js` 使用 MongoDB

---

### 方案 3：使用 GitHub 作為資料庫（簡單但有限制）

1. 創建一個 GitHub Personal Access Token
2. 在 Netlify 環境變數中設置：
   - `GITHUB_TOKEN`: 你的 Personal Access Token
   - `GITHUB_REPO`: 你的倉庫名稱（例如：`Harveylin0316/random-rice`）
3. 修改 `netlify/functions/admin.js` 使用 GitHub API 更新 `data/prizes_database.json` 文件
4. 每次更新會觸發 Git commit，資料會持久化在 GitHub 倉庫中

---

## 當前狀態

目前系統會：
1. ✅ 嘗試保存到文件（可能失敗，因為文件系統只讀）
2. ✅ 嘗試從環境變數 `PRIZES_DATABASE` 讀取（如果設置了）
3. ✅ 如果都失敗，使用空資料結構

**建議**：使用方案 1（環境變數）作為臨時解決方案，長期使用方案 2（外部資料庫）。

---

## 測試

設置完成後，測試步驟：

1. 訪問後台管理頁面
2. 新增一個獎品
3. 檢查獎品列表是否顯示新獎品
4. 重新整理頁面，確認資料是否持久化

如果資料沒有持久化，請檢查：
- Netlify Functions 日誌
- 環境變數是否正確設置
- 環境變數大小是否超過限制
