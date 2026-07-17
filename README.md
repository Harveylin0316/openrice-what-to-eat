# OpenRice 好康地圖

OpenRice Taiwan 的 LINE LIFF 餐廳探索工具。使用者可在地圖上搜尋合作餐廳、查看訂位回饋與優惠、瀏覽照片、收藏分享，並查詢台北市附近停車場。

- 正式站：<https://random-rice.netlify.app/liff/>
- LIFF ID：`2008944358-649rLhGj`
- 正式環境：`main` 分支由 Netlify 自動建置部署

## 主要功能

- 餐廳地圖、搜尋、分類篩選與排序
- 訂位回饋、加碼優惠及 OpenRice deeplink
- 餐廳照片帶與全螢幕瀏覽
- 收藏、LINE 分享及 Google Maps 導航
- 台北市附近停車場、即時空位及停車圖層
- 隨機餐廳推薦、抽獎、會員與管理後台
- 使用行為追蹤與 LINE webhook

## 技術架構

```text
LINE LIFF / Web
    │
    ├── frontend/liff/          地圖與 LIFF 主程式（Vanilla JS + Leaflet）
    └── frontend/web/           Netlify 發布目錄
              │
              ▼
       Netlify Functions
       restaurants / parking / lottery / admin / track / webhook
              │
              ├── repo 內 JSON 快照
              ├── Supabase（抽獎與會員，設定時使用）
              └── 台北市停車開放資料 + Netlify Blobs 快取
```

餐廳地圖資料由 `openrice-closure-checker` 產生。GitHub Actions 每日讀取最新 SQLite DB，重生地圖 JSON，資料有變化才 commit `main` 並觸發部署。

## 重要目錄

| 路徑 | 用途 |
|---|---|
| `frontend/liff/index.html` | LIFF 入口、啟動流程與快取版本 |
| `frontend/liff/pages/map.js` | 地圖主要邏輯 |
| `frontend/liff/data/` | 地圖 pin、照片、合作店 overlay 與外部 POI |
| `netlify/functions/` | 正式環境 API |
| `backend/` | 本機 Express 開發伺服器 |
| `_rebuild/` | 餐廳資料重建工具 |
| `.github/workflows/` | 每日資料、地標與品牌圖示更新 |

## 本機驗證

需要 Node.js 20 與 Python 3.11。

```bash
npm test
npm run check
```

- `npm test`：執行資料、路由與安全 smoke tests。
- `npm run check`：檢查專案 JavaScript 語法。

若要啟動舊版 Express API：

```bash
cd backend
npm install
npm start
```

## 部署與快取注意事項

Netlify 使用 `netlify.toml` 與 `netlify-build.sh` 建置，並將 `frontend/liff/` 複製至發布目錄的 `/liff/`。

LINE WebView 可能長時間保留舊 JavaScript。只要修改地圖啟動、router、`map.js` 或 `map.css` 關鍵路徑，必須同步更新 `frontend/liff/index.html` 中：

1. `map.css?v=rN`
2. `window.__V = 'rN'`

兩個版本必須完全一致，讓使用者取得新資源。

## 環境變數

正式環境依使用功能設定：

| 變數 | 用途 |
|---|---|
| `ADMIN_API_KEY` | 管理後台認證；未設定時 Admin API 會拒絕所有請求 |
| `SUPABASE_URL` | Supabase 專案 URL |
| `SUPABASE_KEY` | Supabase server-side key |
| `LINE_CHANNEL_SECRET` | 驗證 LINE webhook 簽章 |

密鑰只能存放在 Netlify／GitHub secrets 或本機 `.env`，不可提交。Admin API 僅接受 `X-API-Key` header，不接受 query string 或 request body 中的 key。

## 資料來源

- OpenRice Taiwan 餐廳與優惠資料
- `openrice-closure-checker` 的餐廳狀態資料
- 臺北市停車管理工程處開放資料
- OpenStreetMap 地標資料

## 授權與使用範圍

此 repository 目前未附開源授權。未經專案擁有者明確許可，不代表可複製、修改或再散布程式與資料。
