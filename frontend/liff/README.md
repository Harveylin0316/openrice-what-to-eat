# OpenRice 好康地圖（LIFF 前端）

LINE LIFF 網頁：使用者在 LINE 裡打開，用地圖找 OpenRice 合作餐廳、看訂位回饋與優惠、
導航、分享。純 Vanilla JS + Leaflet，沒有 build step，改完直接是上線的樣子。

專案整體說明（部署、資料來源、環境變數）看 repo 根目錄的 `README.md`，這裡只講前端。

## 目錄結構

| 路徑 | 用途 |
|---|---|
| `index.html` | 入口。LIFF ID、破快取版本 `__V`、開機腳本、登入閘門都在這 |
| `pages/map.js` | 地圖主程式（3,300+ 行，核心） |
| `pages/router.js` | 頁面路由（預設 `map`） |
| `pages/home.js` / `pages/lottery.js` | 舊版推薦首頁 / 抽獎頁（皆已不是對外入口） |
| `pages/components/liff-features.js` | 分享、關閉等 LINE 專屬功能 |
| `map.css` | 地圖樣式 |
| `shared/` | 與 `frontend/web` 共用的 api / utils / constants |
| `data/` | build 時產生的 JSON：map_pins、partner_overlay、external_pois、photos、mrt_stations、landmarks |
| `vendor/leaflet/` | Leaflet 本體（版本釘死，不走 CDN） |

> ⚠️ **`shared/` 是建置時會被覆蓋的副本。**`netlify-build.sh` 會用 `frontend/shared/*`
> 覆蓋發布目錄的 `/liff/shared/*`，所以只改這裡的檔案**不會上線**（r35 的「高評價需 ≥5 則評論」
> 就這樣躺了兩個月）。改 shared 模組時兩份都要改，`tests/smoke.test.js` 有測試會擋住分歧。

## 改 LIFF ID（換 channel）

**唯一正確的位置是 `index.html` `<head>` 裡的這一行：**

```html
<script>window.LIFF_ID = '2007974193-JJfJNq2h';</script>
```

目前是 2026-07 換到新 provider 的 Login channel；舊的 `2008944358-649rLhGj` 已停用。

為什麼放在 `index.html` 而不是 `app.js`：`app.js` 會被 LINE WebView 硬快取，改了不一定下發；
`index.html` 屬 `/liff/*`（`Cache-Control: must-revalidate`），每次都會重新驗證。

`app.js` 的 `getLiffId()` 取值順序：

1. `?liffId=` 網址參數 —— **只在 localhost 生效**（線上允許覆寫等於讓人指向自己的 LIFF app 通過登入閘門）
2. `window.LIFF_ID` ← 正式環境走這條
3. `app.js` 內建預設（保底，與上面那行保持一致）

## 破快取：改 map.js / map.css 一定要 bump 版本

`/liff/pages/*` 與 `map.css` 的快取是 **immutable 一年**，靠網址上的 `?v=` 破快取。
改動這兩類檔案時，`index.html` 裡這兩處必須同時改成同一個值：

```html
<link rel="stylesheet" href="map.css?v=r63">
...
window.__V = 'r63';
```

漏改的話用戶會拿到舊 JS/CSS 配新資料。`tests/smoke.test.js` 有一條
`critical LIFF cache-buster versions stay aligned` 會擋住兩處不一致。

`data/*.json` 是 `max-age=300`，會自己更新，不需要 bump。

## 本機開發

```bash
cd backend && npm install && npm start   # 同時 serve 靜態檔與 /api
```

然後開 `http://localhost:3000/liff/?dev=1&page=map`：

- `?dev=1` —— 跳過 LIFF init，非 LINE 環境也能開地圖
- `?page=map` —— 指定頁面（預設就是 map）

注意 `/api/track`、`/api/parking` 只有 Netlify Functions 有實作，本機會 404，屬正常。

## 在 LINE 內測試

```
https://liff.line.me/2007974193-JJfJNq2h
```

要驗證某個 pin 的深連結：`https://liff.line.me/2007974193-JJfJNq2h?r=<or_id>`。

## 地圖圖層與顯示層級

| 圖層 | 來源 | 顯示條件 |
|---|---|---|
| 彩色合作店 pin | `map_pins.json` | 全程；顏色依優惠層級（套餐紅橘 / 訂位金黃 / 回饋淡點） |
| 灰點（未合作餐廳） | `external_pois.json` | z≥16，且未被「可訂位/優惠/現在有開/預算/收藏」等篩選排除 |
| 捷運站 | `mrt_stations.json` | z≥14 起**不設上限**（放大時最需要對方位） |
| 商圈地標 | `map_pins.json` 的 `places` | z14–16（z≥17 讓位給街道字） |
| 連鎖品牌招牌 | `landmarks.json` | z≥16 |

灰點用 `preferCanvas` 畫在單一 canvas（不是 DOM 節點），所以一千多顆不影響效能。

## 注意事項

- LINE WebView 的快取很頑固，測不出改動時先確認 `__V` 有沒有 bump、再完全關掉頁面重開
- 地圖刻意設計成**不依賴 LINE 也能開**：登入閘門在 `index.html` 內聯，不經過 `app.js`，
  所以 `app.js` 載入失敗時地圖照常運作（但分享等 LINE 功能會退化）
- 深色模式、大字模式在首繪前就套用（`index.html` 內聯腳本讀 localStorage），避免閃動
- 新增樣式時，**淺色寫死的顏色要同時補深色覆寫**，否則深色模式會出現白底白字
  （`--lm-surface` / `--lm-bg` / `--lm-text-body` 這些 token 已經處理好兩種模式，優先用它們）
- 用 `[hidden]` 控制顯示的元素，CSS 若有 `display: flex/block`，必須另外補
  `.xxx[hidden] { display: none; }`——作者樣式會蓋過瀏覽器預設
