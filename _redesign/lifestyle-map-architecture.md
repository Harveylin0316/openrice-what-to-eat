# 生活地圖（餐飲好康地圖）— 產品與技術架構藍圖

> **產品定位**：從「今天吃什麼」單次工具，轉型為「你周圍的餐飲好康地圖」每日入口
> **參考對象**：LINE Pay 好康地圖（map-first、好康即庫存、贊助即廣告位）
> **既有資產**：928 間餐廳（857 間有座標）、536 間有 Coupon、551 間可線上訂位、
> 4 間贊助店（`is_paid_account`）、訂位獨家優惠、營業時間、評分、現有推薦引擎
> **已確認的方向決策**（2026-07-06，與 Owner 確認）：
> 1. **地圖為主、吃什麼為輔** — 首頁 = 全螢幕地圖，「今天吃什麼」變成地圖上的「幫我決定」聚光燈
> 2. **先只做餐飲好康** — 用現有 928 間餐廳資料把體驗做扎實，資料模型預留 `category` 欄位供未來擴品類

---

## 1. 為什麼轉（一句話）

抽餐廳是**低頻工具**（餓了才開）；好康地圖是**高頻環境**（在外面晃、想省錢、做計畫都會開）。
而地圖把每一間店變成**可販售的廣告位**：贊助置頂、好康加亮、訂位抽成 ——
`is_paid_account` / `Coupon` / booking offer 三個既有欄位，本質就是三種可販售的曝光庫存。

## 2. 核心設計洞察：不要讓兩個心智打架

| 使用者當下心理 | 他要的 | 對的 UI |
|---|---|---|
| 「我在附近晃 / 在計畫」 | 探索、比較 | **地圖**（選擇越多越爽） |
| 「我懶得想，直接跟我說」 | 一個答案 | **聚光燈單卡**（選擇越少越爽） |
| 「我想省錢」 | 過濾出有好康的 | **好康圖層**（只留有券的點） |

「今天吃什麼」的爽點是**減少選擇**；地圖的本質是**放大選擇**。
**正確的合成不是把吃什麼塞進地圖，而是：地圖是常駐的世界，「幫我決定」是把地圖收合成單一答案的聚光燈。**

## 3. 三種進入姿態（決定所有 UI）

| 姿態 | 觸發 | 畫面 |
|---|---|---|
| **逛**（探索） | 打開即是 | 全螢幕地圖 + 底部清單 sheet |
| **省**（找好康） | 「只看好康」toggle | 地圖只留 deal_tier ≠ none 的 pin |
| **決**（吃什麼） | 「🎲 幫我決定」FAB | 地圖鏡頭飛向一間店 + 聚光燈單卡 |

## 4. 畫面結構

```
┌─────────────────────────────┐
│ [🎫只看好康] [🕐營業中] [📅可訂位]  📍定位 │ ← sticky chips bar
│                                       │
│            全螢幕地圖                    │
│    · pin 依 deal_tier 上色/分級          │
│    · clustering（低 zoom 聚合）          │
│    · 點 pin → 底部迷你資訊卡              │
│                                       │
│                        [🎲 幫我決定]    │ ← FAB（核心功能入口）
│ ╭───────────────────────────╮        │
│ │ ▂▂  附近 N 間好康餐廳    ↑拖曳 │        │ ← bottom sheet
│ │ 〔店卡〕〔店卡〕依距離排序…     │        │   收起/半開/全開(=篩選)
│ ╰───────────────────────────╯        │
└─────────────────────────────┘
```

「幫我決定」點下去：
1. 沿用現有推薦引擎（篩選條件 + 贊助輪替，一行邏輯不改）
2. 地圖鏡頭 flyTo 那間店、其他 pin 淡出（聚光燈）
3. 單卡顯示：照片 / 名字 / 距離 / 好康 badge / 「換一個」 / 「訂位」
4. 「換一個」重抽（贊助輪替邏輯照舊生效）

## 5. 資料模型

### 5.1 不動原資料庫，加一層衍生欄位

`restaurants_database.json` 保持原樣。建置時（netlify-build.sh）產生 `map_pins.json`：

```jsonc
{
  "generated_at": "...",
  "pins": [
    {
      "id": 937,                  // or_id
      "n": "美琪蒙古烤肉",           // name
      "lat": 25.0833072,
      "lng": 121.5571648,
      "t": "coupon",              // deal_tier: sponsored | booking_offer | coupon | none
      "c": "food",                // category（現在全是 food，預留擴品類）
      "r": 3.5,                   // rating
      "b": true,                  // bookable
      "h": {...},                 // opening_hours（壓縮格式，供「營業中」濾鏡客戶端計算）
      "d": "台北·中山區",           // display 區域
      "img": "https://...",       // door_photo_url（迷你卡用）
      "bud": "500-1000 元"        // budget（迷你卡用）
    }
  ]
}
```

### 5.2 deal_tier 推導規則（P11 改版，對應 Owner 實際三種優惠）

pin 顏色只取一種，優先序 & tie 規則如下（強度 套餐=訂位 > 回饋現金）：

```
offer     ← has_booking_offer（訂位優惠，14 間）   金黃 #E5A000
menu      ← has_booking_menu（套餐優惠，含實際套餐折扣價，36 間） 紅橘 #E44E25
cashback  ← bookable（訂位出席回饋現金：出席每人回饋 3 元，所有可訂位店 464 間） 淡青 #68A9A0
none      ← 不可訂位（無回饋，53 間）             灰 #B4AFA8
```

- **tie（套餐+訂位都有，12 間）→ pin 顯示訂位色**（讓稀有的 14 間訂位全部可見），
  卡片/清單以 `hm`/`ho` 旗標把「套餐優惠 + 訂位優惠」兩個 badge 都秀。要改套餐優先翻順序即可。
- **贊助**（is_paid_account）與優惠正交 → `pin.sp` 旗標畫星星釘，不佔顏色層。
- **「加碼優惠」篩選** = menu ∪ offer（回饋現金是基本盤、人人有，不算加碼）；
  統計 pill = 「畫面內 N 間 · M 間加碼優惠」。

> **誠實原則**：套餐優惠有真實套餐款數、訂位優惠有真實文字、回饋現金是 OpenRice 真實機制；
> 卡片只陳述資料庫有的事實，不虛構折扣。原 OpenRice「Coupon」flag（無內容）已併入回饋現金基本盤。

### 5.3 payload 預算（實測）

**北北基白名單**（與 `netlify/functions/restaurants.js` 的 applyCityAllowlist 一致，
否則地圖會出現推薦引擎抽不到的店）：567 pins，
tiers = coupon 306 / none 245 / booking_offer 12 / sponsored 4。
原始 286KB、gzip 後 49KB，一次載入可接受；
詳細資料（多圖、電話、完整 tags）點 pin 時才經現有 API 拉取。

## 6. 技術選型

### 6.1 地圖庫：Leaflet + markercluster（P0 spike 驗證）

| 候選 | 優 | 劣 | 判定 |
|---|---|---|---|
| **Leaflet + Leaflet.markercluster** | 42KB gzip、DOM/Canvas 渲染、無 WebGL 風險、生態成熟 | 光柵磚、視覺較樸素 | **首選** |
| MapLibre GL JS | 向量磚漂亮、內建 cluster | ~230KB gzip、依賴 WebGL（LINE Android WebView 上有裝置相容風險） | 備選 |

**決策理由**：LIFF 跑在 LINE in-app WebView（Android 常落後桌面 Chrome 2–3 版），
`_redesign/ux-architecture.md` 已記錄此環境對重度渲染的敏感度。857 點對兩者都是小數字，
選型關鍵是**bundle 大小與 WebGL 相容風險**，Leaflet 全贏。P0 spike 以實測數據背書。

**P0 spike 實測結果（2026-07-06，`_redesign/spike/`，Chromium 390×780 + 4x CPU 節流模擬中階 Android）**：

| 指標 | 實測值 | 判定 |
|---|---|---|
| pins fetch + parse | 137ms | ✅ |
| 地圖初始化 | 64ms | ✅ |
| 851 pins + clustering 建立 | 209ms | ✅ |
| 閒置 FPS | 61 | ✅ |
| 連續 zoom 風暴 FPS | 50 | ✅ |
| 連續平移 FPS | 59 | ✅ |
| flyTo 台北→台南 | 1505ms（動畫時長內） | ✅ |

**結論：Leaflet + markercluster 定案**。重跑方式見 `run-spike.mjs`（需 playwright）。

- 地圖磚：CARTO Voyager（免金鑰、含中文標籤、需 attribution）；OSM 標準磚為備援
- vendor 進 repo（`frontend/liff/vendor/`），不吃 CDN 首屏延遲與離線風險

### 6.2 效能鐵則（LIFF 成敗）

1. **Clustering**：台北 496 點必須聚合，低 zoom 全聚、高 zoom 散開
2. **Canvas renderer**：Leaflet `preferCanvas: true`，避免 857 個 DOM marker
3. **迷你卡/詳細資料 lazy**：pin payload 精簡，點擊才拉全量
4. **無 infinite 動畫**、無 backdrop-filter（沿用 ux-architecture.md 的禁令）

## 7. 既有資產 → 地圖元件對照

| 現有資產 | 在地圖裡變成 |
|---|---|
| `coordinates`（857 間） | pin，零額外資料工作 |
| `Coupon`（536）/ booking offer | 好康圖層 + badge（好康地圖的主角） |
| `is_paid_account` + 贊助輪替邏輯 | 贊助 pin 樣式 + 「幫我決定」保底曝光（**廣告庫存**） |
| `opening_hours` / `today_status` | 「營業中」chip（客戶端即時計算） |
| 推薦引擎 + 篩選（home.js） | 「幫我決定」FAB + bottom sheet 全開態 |
| 抽獎頁 | 後續變成地圖上的活動圖釘（P5） |
| GPS + 區域 fallback | 地圖定位 + 無定位時以區域中心開圖 |

## 8. 分階段落地（每階段可獨立部署）

| 階段 | 內容 | 驗收 | 狀態 |
|---|---|---|---|
| **P0 效能 spike** | 857 座標實測 Leaflet+cluster 幀率/載入 | 選定地圖庫、有數據 | ✅ 2026-07-06 |
| **P1 地圖首頁** | 全螢幕地圖 + pin + 定位（靜默嘗試 + 手動按鈕）；router 加 `map` 頁並設為預設 | 能逛的地圖 | ✅ 2026-07-06 |
| **P2 好康層** | map_pins.json 建置管線、deal_tier pin 樣式、「只看好康/營業中/可訂位」chips、畫面內統計 pill | 真正的好康地圖 | ✅ 2026-07-06 |
| **P3 幫我決定** | FAB → flyTo 聚光燈單卡（接現有推薦引擎）、「換一個」、每第 4 抽贊助保底輪替 | 核心爽點保住 | ✅ 2026-07-06 |
| **P4 bottom sheet** | 與地圖視窗連動的清單（有定位依距離、無定位好康+評分排序）+ 預算篩選 chips（建置時預算分類與後端規則一致）+ 手勢/點擊展開收合 | 完整動線 | ✅ 2026-07-06 |
| **P5 收尾** | OR 品牌色調整合（#E44E25 紅橘 / #FFD300 黃，取自 logo 採樣）、無障礙打磨（Escape/aria/focus-visible）、跨頁導航（地圖↔找店↔抽獎 + 回地圖浮動鈕）、多視口驗證（360/390/820）、無定位動線驗證 | 上線品質 | ✅ 2026-07-06 |

**P6 UX 深度打磨（2026-07-06，多視角批判 5 鏡頭 × 44 agents，30 項確認全修）**：
- **幫我決定與所見一致**：改為「畫面內 + 通過篩選 + 今天有開」客戶端抽選，
  找不到才退回 API（帶預算條件、今日休息換一次）——抽選結果不再與地圖脫節
- 視覺層級反轉修正：cluster 改中性奶油色（品牌紅只留給精選 pin/FAB/選中態）、
  好康 pin 半徑階梯放大（12/10/9 vs 一般 6）、優惠券改 teal 與「營業中」綠一色一義
- 導航重構：找店/抽獎移出篩選列 → 右側直立快捷鈕；篩選列右緣漸隱提示可捲動
- 資訊誠實：有券但無券內容 → 「OpenRice 優惠券 — 詳情見餐廳頁」通用說明；
  「精選推薦」用詞統一；營業文案「尚未營業 · HH:MM 開店」「即將打烊」
- 幾何修正：把手 FAB 保留區 90→152px（320px 統計不再被 FAB 蓋）、grip 絕對置中、
  預算 chip 44px 觸控、桌面三套對齊系統統一到 480 欄、短屏回地圖鈕改停右上
- 動線：清單→店家卡→回清單保留視角與捲動位置；店名 › 連 OpenRice 頁
  （LINE 內建瀏覽器開啟可返回）；卡片開啟時 FAB/定位鈕讓位
- 提示系統：獨立 toast（可換行）取代 pill 訊息；首次開啟身分+圖例教學；
  document.title = OpenRice 好康地圖；定位鈕改十字準星 SVG
- 驗證：E2E 18 步、6 裝置 × 6 狀態矩陣（320→768）、無定位動線，全綠

**P7 真機回饋修正（2026-07-06，Owner 實機測試回報）**：
- **修「找店/抽獎都變抽獎頁」bug**：根因是抽獎頁整頁覆寫 `#mainContent` 毀掉
  找店頁靜態表單。home.js 於載入時快照自身 DOM，被覆寫後自動復原並重綁事件
- **一切留在地圖內**：移除「找店」側邊鈕（搜尋+篩選+幫我決定已涵蓋其功能，
  `/liff/home` 仍可直達供 Rich Menu 相容）；抽獎保留側邊入口
- **抽選輪盤動畫**：🎯 在畫面內候選店間跳動、店名快速輪替、減速落定（~1.3s，
  尊重 prefers-reduced-motion）——「隨機」成為看得見的儀式
- **開場防閃現**：index.html 首繪前內聯腳本判定目標頁，地圖路由直接隱藏舊版
  外殼（router 接手後移除 data-boot）；LINE header 開場即顯示「OpenRice 好康地圖」
- **進場即請求定位**（Owner 決策：好康地圖以「你附近」為核心；拒絕不擋路）
- **頂部搜尋欄**（Google Maps 式）：行政區（30）/ 地標·捷運站·商圈（80）/
  餐廳名三類建議，選擇即 flyTo 跳轉（餐廳另開迷你卡）；
  地點索引由 generate_map_pins.py 從店家座標算質心，零外部 geocoding 依賴

**P8 表面淨化（2026-07-06，Owner 真機回饋）**：
- 抽獎入口融合進好康清單面板頂部橫幅（OR 黃）——它本來就是好康的一種；
  移除側邊浮動抽獎鈕，地圖表面只剩定位鈕與 FAB
- 浮動控制項陰影改輕薄（--lm-shadow-chip）＋細邊框：大片模糊陰影在
  淺色磚圖上像髒污；FAB 保留重陰影（唯一主 CTA）

**P9 廣告位強化 + 抽獎下架（2026-07-06，Owner 決策）**：
- 抽獎模組下架：地圖上不再有入口（/liff/lottery 路由保留供直接連結，可隨時復活）
- 贊助店專屬圖釘：OR 紅星星釘（白圈+定位尖角）、**永不進 cluster**（任何 zoom
  常駐可見——付費曝光不能被聚合圈吃掉）、店名標籤不受 zoom 門檻常駐顯示、
  好康清單置頂；「營業中」等篩選仍誠實套用（已打烊的贊助店會隱藏）
- 自查修正：搜尋欄 16px 字級（iOS <16px 聚焦會強制放大整頁）、迷你卡 ✕ 改輕量
  白底、搜尋無結果顯示空狀態回饋、320 窄屏統計短文案、Escape 可關搜尋下拉

**P10 遊戲化 G1（2026-07-06，八角框架黑帽，設計全文見 `gamification-octalysis.md`）**：
- 每日抽選額度 10 次（FAB badge 顯示剩餘）：鎖老虎機不鎖工具，跨日重置
- 🔥 連續天數 streak：連續 ≥3 天每日額度 +2（有牙齒的損失感）
- ✨ 大吉時刻：12% 機率金效 + 奉還 1 次抽選（變動獎勵）
- 👑 今日之星：日期種子每日輪換好康店，金冠圖釘常駐 +「明天就換」文案
- 全部 localStorage（v1 單機），G2 接 Supabase 跨裝置 + 收藏/成就等白帽留存

**未來迭代（本輪未做）**：
- 深色模式（需連磚圖 dark_matter 與 home/lottery 一起，app 目前全域鎖淺色）
- 抽獎變地圖活動圖釘（抽獎無地理錨點，需產品定義）
- 迷你卡分享按鈕（需按 or_id 拉全量資料的 API）
- 9 間無座標店家補座標（or_id: 69960, 452233, 510440, 512752, 546290, 549410, 556102, 566741, 651331）

**P1–P3 實作備註**：
- 地圖頁 = `frontend/liff/pages/map.js` + `frontend/liff/map.css`，渲染進獨立的 `#mapRoot`
  固定容器（不動 `#mainContent`，避免破壞 home 頁的靜態表單 DOM）；顯示切換靠
  router 在 `loadPage()` 切 `body.is-map-page`
- Leaflet 由 map.js 動態載入（`frontend/liff/vendor/leaflet/`，vendored 不吃 CDN），
  home / lottery 頁完全不受影響
- 傳統表單推薦頁保留在 `/liff/home`；地圖初始化失敗時 router 自動 fallback 到 home
- 磚圖：CARTO Voyager raster（免金鑰、含 OSM/CARTO attribution）
- E2E 驗證：backend Express (`localhost:3000`) + `?dev=1` LIFF bypass + Playwright，
  11 步全過（預設路由、篩選、迷你卡、聚光燈、贊助保底、home fallback）

## 9. 風險與對策

| 風險 | 對策 |
|---|---|
| 地圖在 LINE WebView 卡頓 | P0 spike 先驗證；Leaflet canvas + clustering；pin payload 精簡 |
| 地圖稀釋「幫我決定」的價值 | FAB 聚光燈收合是命門：單卡、其他 pin 淡出、選擇歸一 |
| 定位權限被拒（最大流失點） | 區域選擇 fallback 是第一公民：無定位以區域中心開圖，一樣能逛 |
| 資料密度不均（台南 30、離島個位數） | 稀疏區自動拉遠 zoom + bottom sheet 清單補位 |
| 好康資料只有 flag 沒有內容 | 只標「有優惠」不造假；未來接真實券內容再升級 badge |
| 桌面開啟 LIFF | 沿用 ux-architecture.md：max-width 480px 置中，維持手機體驗 |

## 10. 檔案結構規劃

```
frontend/liff/
├── pages/
│   ├── map.js               # 新：生活地圖頁（P1–P4）
│   ├── home.js              # 保留：推薦引擎逐步抽出為 shared 邏輯
│   └── router.js            # 註冊 'map'；P5 時 default 切為 map
├── vendor/
│   ├── leaflet/             # leaflet.js + leaflet.css + markercluster
├── map.css                  # 地圖頁自包含樣式（tokens 沿用 ux-architecture.md）
└── data/map_pins.json       # 建置時由 netlify-build.sh 產生

_redesign/
├── ux-architecture.md            # 既有：tokens / 效能 / 無障礙規範（沿用）
├── lifestyle-map-architecture.md # 本文件
└── spike/                        # P0 效能驗證頁與結果
```

---

**文件版本**：v1.0
**最後更新**：2026-07-06
**配套文件**：`ux-architecture.md`（design tokens、LIFF 效能規範，本案沿用其約束）
