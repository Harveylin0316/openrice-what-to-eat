# 好康地圖 — 專案狀態接手筆記

> 給下次接手的自己/AI。容器是暫時的,這份 commit 進 repo 才留得住。
> 最後更新:2026-07-07(停車功能收尾)。

## 這是什麼

把 LINE LIFF app「今天吃什麼」改造成全螢幕「**好康地圖**」(OpenRice 台灣餐廳優惠地圖)。
- LIFF ID:`2008944358-649rLhGj`,deep-link:`https://liff.line.me/{LIFF_ID}?r={pin.id}`
- 正式站:`https://random-rice.netlify.app`(Netlify site_id `a5e4c520-e9c2-48b0-b20f-f44d7dbe522b`)
- LIFF 入口:`/liff/`

## 部署工作流(重要)

- **正式環境 = `main` 分支 → Netlify 自動建置部署**。使用者在 LINE 裡測的就是 `main`。
- 開發分支:`claude/lifestyle-map-redesign-fy0qpx`。慣例:commit 到 feature 分支 →
  `git checkout main && git merge --ff-only <feature> && git push origin main` → 回 feature 分支。
- 建置:`netlify.toml` → `bash netlify-build.sh`(publish dir `frontend/web`;
  `netlify-build.sh` 把 `frontend/liff/*` 複製到 `frontend/web/liff/`)。NODE_VERSION=20。
- 確認部署:Netlify MCP `netlify-project-services-reader get-project`(看 currentDeploy.state=ready)。
- **沙盒限制**:proxy 擋掉所有外部 API(台北停車 API、OpenRice、連正式站 URL 都 403)。
  只有 npm/GitHub/Netlify-MCP 通。→ 前端跑不到的驗證要靠使用者在真機開網址回報。

## 破快取機制(踩過最多雷的地方)

LINE webview 對 `must-revalidate` 不可靠,會服務**舊的 JS**。解法是**版本串接**:
`index.html` 內聯開機 `window.__V='rN'` → `import('./pages/router.js?v=rN')` →
router 把 `?v` 串到 `import('./map.js?v=rN')`。新 URL = 一定重抓。
**每次改到開機/router/map 的關鍵路徑,就 bump `index.html` 裡的 `__V` 和 `map.css?v=` 兩處。**
目前版本:**r12**。

開機解耦:`index.html` 內聯模組擁有地圖開機(`__rrBooted` guard);`app.js` 只做背景 LINE
初始化(拿 profile,`__liffStarted` guard)。地圖不依賴 LINE,無條件先開。
→ 這是根治「一直卡在正在連線 LINE」的關鍵。

**教訓**:map.js 對 `api.js` 用「帶 `?v` 的**靜態** import」會在部分 webview 讓 map.js link 失敗 →
整頁空白(動態 import 帶 `?v` 沒事,靜態的踩雷)。所以停車查詢**不 import api.js**,
直接在 `fillParking` 內用原生 `fetch` 打 `/api/parking/nearby`(map.js 自足)。

## 停車功能(已完整收尾)

餐廳小卡「查附近停車」:顯示最近公有停車場・步行分鐘・即時空位 + 導航。**只涵蓋台北市**。
- 後端 `netlify/functions/parking.js`:
  - 資料源(台北停管處 Azure blob):`TCMSV_alldesc.json`(靜態:名稱/座標 TWD97,2.4MB)
    + `TCMSV_allavailable.json`(即時空位,461KB)。
  - **效能**:desc 在 **Netlify 建置時預烤**(`gen-parking-lots.mjs` → `netlify/functions/parking-lots.json`,
    1746 筆,已提交 placeholder 保證 require 不炸),runtime 只抓即時 avail(~2s)。
    getLots() 優先讀預烤檔,缺檔 fallback 成即時抓。
  - desc/avail 用 `Promise.allSettled` 並行;avail 掛掉仍顯示停車場(標「即時不明」)。
  - `?debug=1` 端點:回報 `baked.active/count` + desc/avail 實測狀態/耗時。診斷神器。
- 前端 `fillParking`(map.js):原生 fetch,12s 逾時,失敗訊息帶完整原因+版本(如 `(HTTP500·r9)`)。
- 座標轉換 TWD97 TM2(EPSG:3826)→WGS84,往返誤差 0.000m,已驗證。
- 剩餘速度地板 ~2s = 即時空位必須連線抓(不能預烤,每分鐘在變)。
  若要更快:全站快取 avail 30–60s(取捨:空位數字可能舊 1 分鐘)——使用者目前選維持現狀。

## 其他已完成

- **全面體檢(r12)**:三路稽核(前端載入/map.js正確性/後端資料)後修正,本地 Playwright 真地圖 8/8 驗證。
  載入:外部 POI(206K)移出首屏關鍵路徑改 idle 載入、vendor Leaflet 改 immutable 快取、
  index.html preload/preconnect、後端 /recommend 快取解析過的 2.6MB DB(不再每請求重讀)。
  Bug:推薦洗牌改 Fisher–Yates(原 sort(random) 非均勻)、wireControls 加一次性 guard(修 init 失敗
  重試後篩選失效)、外部 POI tooltip listener 洩漏、withTimeout 計時器不清、showExtCard 未取消停車 fetch、
  parking 空 lat/lng 回 400、restaurants 半靜態路由加 CDN 快取、enabled 預設值對齊 JS。
- **導航改開 Google Maps 路線畫面**(r11):navigationUrl 移除 travelmode/dir_action,讓用戶自選交通方式。
- **合作餐廳 marker = Google 風格餐廳 icon(刀叉)**(r10):`buildMarker` 對 menu/offer/cashback
  改用 `L.marker` divIcon(白刀叉 + tier 色圓底,優惠店 30px/回饋店 24px);none 與未合作維持灰點。
  樣式 `.map-food-pin`(map.css)。注意:icon marker 無 `setRadius`,zoom bump 已 guard。
- 三段式 pill 文案:總數(含未合作)· 訂位反饋現金 · 加碼優惠。
- 第一梯隊功能:分享到 LINE + 收藏 + 排序。
- Google 風格地圖:無框浮動文字標籤 + halo,label 碰撞收合(優先序 search>sponsor>star>deal>partner>ext)。
- POI 圓點點擊修復:`bubblingMouseEvents: false`(原本 click 冒泡到地圖→關卡片,像「沒反應」)。
- 訂位 false-positive 修復:`partner_overlay.json` 的 `is_bookable` 為權威(`eff_bookable`)。
- 資料每日自動更新:`.github/workflows/nightly-refresh.yml`(cron `0 21 * * *`,
  用 `CHECKER_TOKEN` secret 抓 checker db → 重生 map_pins → commit main)。
  來源腳本:`export_checker_overlay.py`、`generate_map_pins.py`。

## Backlog(使用者說「先這樣我累了」,下次接)

1. 地圖上的 **🅿️ 停車圖層**(直接在地圖標停車場,不用點卡片)
2. 依停車便利度排序 / 「找車位」模式
3. 深色模式
4. 小卡分享打磨
5. 9 家無座標店補座標
6. (可選)即時空位全站快取,把查詢再壓到 ~1s

## 關鍵檔案

- `frontend/liff/index.html` — 內聯開機、`__V` 版本、LIFF SDK
- `frontend/liff/pages/map.js` — 地圖核心(~2100 行),`fillParking` 在 ~1065 行
- `frontend/liff/pages/router.js` — 動態載入各頁,map 失敗不退回舊表單
- `frontend/liff/app.js` — 只做背景 LINE 初始化
- `frontend/liff/shared/api.js` — API 呼叫(注意:map 的停車已不走這裡)
- `netlify/functions/parking.js` + `gen-parking-lots.mjs` + `parking-lots.json`
- `netlify.toml`、`netlify-build.sh`
