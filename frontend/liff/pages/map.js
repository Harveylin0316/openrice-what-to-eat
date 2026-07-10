// 生活地圖：全螢幕餐飲好康地圖（新首頁）
// 三種姿態：逛（地圖探索）、省（只看好康）、決（🎲 幫我決定 → 聚光燈單卡）
// 依 _redesign/lifestyle-map-architecture.md

// 注意：只靜態 import「一直都存在」的舊有 exports（穩定、不會 link 失敗）。
// 停車查詢不走 api.js（避免任何 import 失敗拖垮整個 map.js）→ 在 fillParking 內直接 fetch。
import { fetchRecommendations, loadSponsoredRestaurants } from '../shared/api.js';
import {
    calculateDistance,
    formatDistance,
    getOpeningStatus,
    generateEvidence,
    filterGeneralTags
} from '../shared/utils.js';
import { track } from '../shared/tracker.js';

// ---- 常數 ----

// 優惠層級（pin 顏色）：套餐=訂位（加碼優惠，強色大點）> 回饋現金（基本盤，淡點）> 一般
//   menu 套餐優惠 紅橘 / offer 訂位優惠 金黃（1,2 同強度、不同色）
//   cashback 回饋現金（所有可訂位的店：出席每人回饋 3 元，收斂色不搶戲）
//   none 不可訂位（無回饋）
// 贊助另用 pin.sp 旗標畫星星釘（廣告位，與優惠正交）
const TIER = {
    menu:     { color: '#E44E25', label: '套餐優惠', radius: 11 },  // OR 紅橘
    offer:    { color: '#E5A000', label: '訂位優惠', radius: 11 },  // OR 金黃
    cashback: { color: '#68A9A0', label: '出席回饋', radius: 7 },   // 淡青（基本盤）
    none:     { color: '#B4AFA8', label: '',       radius: 6 },
};

const ONBOARD_KEY = 'rr_map_onboarded_v1';

// ---- 遊戲化（八角框架黑帽，詳見 _redesign/gamification-octalysis.md）----
const DICE_BASE_QUOTA = 10;    // 每日抽選額度（CD6 稀缺：籌碼經濟）
const DICE_STREAK_BONUS = 2;   // 連續 ≥3 天 → 每日 +2（CD8 損失：斷了就沒）
const STREAK_BONUS_DAYS = 3;
const DAIKICHI_RATE = 0.12;    // 大吉機率（CD7 變動獎勵），觸發奉還 1 次
const DICE_KEY = 'rr_map_dice';
const STREAK_KEY = 'rr_map_streak';

function localDateKey(d = new Date()) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function getStreak() {
    try {
        const s = JSON.parse(localStorage.getItem(STREAK_KEY) || 'null');
        if (s && typeof s.days === 'number') return s;
    } catch (e) { /* ignore */ }
    return { last: '', days: 0 };
}

// 每日開啟計數：連續天數 +1 或歸零重來
function bumpStreak() {
    const today = localDateKey();
    const s = getStreak();
    if (s.last === today) return s;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    s.days = (s.last === localDateKey(yesterday)) ? s.days + 1 : 1;
    s.last = today;
    try { localStorage.setItem(STREAK_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
    track('map_streak', { days: s.days });
    return s;
}

function getDice() {
    try {
        const o = JSON.parse(localStorage.getItem(DICE_KEY) || 'null');
        if (o && o.date === localDateKey()) return o;
    } catch (e) { /* ignore */ }
    return { date: localDateKey(), used: 0 }; // 跨日自動重置
}

function diceQuota() {
    return DICE_BASE_QUOTA + (getStreak().days >= STREAK_BONUS_DAYS ? DICE_STREAK_BONUS : 0);
}

function diceRemaining() {
    return Math.max(0, diceQuota() - getDice().used);
}

function consumeDice(n = 1) {
    const o = getDice();
    o.used = Math.max(0, o.used + n);
    try { localStorage.setItem(DICE_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
    updateFabBadge();
}

function updateFabBadge() {
    const el = document.getElementById('fabDiceCount');
    if (el) el.textContent = diceRemaining();
}

// ---- 收藏 / 想去清單（localStorage，無後端；地圖標金心、可一鍵篩選）----
const FAV_KEY = 'rr_map_favs';
let favSet = null;
function getFavs() {
    if (favSet) return favSet;
    favSet = new Set();
    try {
        const arr = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
        if (Array.isArray(arr)) arr.forEach(id => favSet.add(id));
    } catch (e) { /* private mode：本次 session 記憶體暫存 */ }
    return favSet;
}
function isFav(id) { return getFavs().has(id); }
function favCount() { return getFavs().size; }
function toggleFav(id) {
    const s = getFavs();
    const nowFav = !s.has(id);
    if (nowFav) s.add(id); else s.delete(id);
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...s])); } catch (e) { /* ignore */ }
    track('map_favorite_toggle', { or_id: id, favorite: nowFav });
    return nowFav;
}

// ---- 分享到 LINE（Flex 泡泡卡）：LINE app 的成長引擎，午餐揪團一鍵丟群組 ----
function dealSummaryText(pin) {
    const parts = [];
    if (pin.hm) parts.push('套餐優惠');
    if (pin.ho) parts.push('訂位優惠');
    if (pin.b) parts.push('出席回饋 $3/人');
    return parts.join('・');
}

function shareDeepLink(pin) {
    const id = window.__LIFF_ID || '';
    return `https://liff.line.me/${id}?r=${pin.id}`;
}

// 組 LINE Flex Message（好友在聊天室看到的餐廳卡）
function buildFlexMessage(pin, url) {
    const deal = dealSummaryText(pin);
    const meta = [pin.d, pin.bud].filter(Boolean).join('・');
    const body = [
        { type: 'text', text: pin.n, weight: 'bold', size: 'lg', wrap: true },
    ];
    if (pin.r) {
        body.push({ type: 'box', layout: 'baseline', margin: 'xs', contents: [
            { type: 'text', text: '★', color: '#E5A000', size: 'sm', flex: 0 },
            { type: 'text', text: String(pin.r), size: 'sm', color: '#8A8178', margin: 'sm', flex: 0 },
        ]});
    }
    if (deal) body.push({ type: 'text', text: deal, size: 'sm', color: '#E44E25', wrap: true, margin: 'sm' });
    if (meta) body.push({ type: 'text', text: meta, size: 'xs', color: '#A8A29A', wrap: true, margin: 'xs' });
    const bubble = {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', spacing: 'none', contents: body },
        footer: { type: 'box', layout: 'vertical', contents: [
            { type: 'button', style: 'primary', color: '#E44E25', height: 'sm',
              action: { type: 'uri', label: pin.b ? '看好康・訂位' : '看餐廳好康', uri: url } },
        ]},
    };
    // LINE Flex hero 只吃 https 圖；非 https 就不放大圖，避免整張卡被拒收
    if (pin.img && /^https:\/\//.test(pin.img)) {
        bubble.hero = { type: 'image', url: pin.img, size: 'full', aspectRatio: '20:13', aspectMode: 'cover',
            action: { type: 'uri', uri: url } };
    }
    return { type: 'flex', altText: `${pin.n}｜${deal || '好康地圖'}`, contents: bubble };
}

async function shareRestaurant(pin) {
    track('map_share_click', { or_id: pin.id, name: pin.n, tier: pin.t });
    const url = shareDeepLink(pin);
    const liff = window.liff;
    // 在 LINE 內且支援 → shareTargetPicker 選好友/群組送出 Flex 卡
    // （用 try 包住：LIFF 若未初始化成功，isApiAvailable 可能丟錯，直接走退路）
    let canPicker = false;
    try { canPicker = !!(liff && liff.isApiAvailable && liff.isApiAvailable('shareTargetPicker')); } catch (e) { canPicker = false; }
    if (canPicker) {
        try {
            const res = await liff.shareTargetPicker([buildFlexMessage(pin, url)]);
            showPillMessage(res ? '已分享給 LINE 好友 🎉' : '已取消分享', 2500);
            return;
        } catch (e) {
            console.warn('shareTargetPicker 失敗，退回原生分享', e);
        }
    }
    // 退路（LINE 外 / 不支援）：Web Share → 複製連結
    const summary = dealSummaryText(pin);
    if (navigator.share) {
        try { await navigator.share({ title: pin.n, text: summary || pin.n, url }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try {
        await navigator.clipboard.writeText(`${pin.n}｜${summary}\n${url}`);
        showPillMessage('已複製連結，貼給好友吧 📋', 2500);
    } catch (e) {
        showPillMessage('分享連結：' + url, 5000);
    }
}

const DEFAULT_CENTER = [25.0478, 121.5170]; // 台北車站（無定位時的起點）
const DEFAULT_ZOOM = 14;
const SPOTLIGHT_ZOOM = 16;
const SPONSOR_EVERY = 4; // 每第 N 次「幫我決定」給贊助店保底曝光（沿用首頁廣告節奏）
const SPO_ROTATION_KEY = 'rr_map_spo_rotation_idx';

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// ---- 頁面狀態 ----

let map = null;
let clusterGroup = null;
let controlsWired = false;      // wireControls 只接一次線（初次 init 失敗重試時避免重複綁 listener）
let allPins = [];               // map_pins.json 的原始資料
let allPlaces = [];             // 搜尋用地點索引（行政區/地標，含質心座標）
let allCats = [];               // 品類詞彙表（火鍋店/燒肉店/居酒屋…，pin.ct 為索引）
let catFilter = null;           // 品類篩選 {label, set:Set<catIdx>}，搜尋或快捷 chip 設定
let extPois = [];               // 無優惠餐廳 POI（closure-checker 台北市）：對照出「有優惠」的價值
let extLayer = null;
let extMarkers = [];            // 所有灰點 marker（含 ._poi），品類篩選時決定哪些進 extLayer
let extLayerCatKey = undefined; // extLayer 目前成員反映的 catFilter label（undefined=尚未建立）
// 灰點（未合作店）品類比對關鍵字：資料只有「國別菜系」(cu) 太粗，改比對「店名 + cu」是否含關鍵字。
// 盡力而為（店名多半含菜式，如「22:02火鍋」「柒息地串燒居酒屋」），寧可精準少漏、避免明顯誤判。
const EXT_CAT_KEYWORDS = {
    '火鍋': ['火鍋', '鍋物', '涮涮', '麻辣鍋', '薑母鴨', '羊肉爐', '鴛鴦鍋', '石頭火鍋', '小火鍋', '酸菜白肉'],
    '燒肉': ['燒肉', '燒烤', '炭火', '和牛', '串燒', '串烤', 'yakiniku'],
    '吃到飽': ['吃到飽', 'buffet', '自助餐', '放題'],
    '餐酒館': ['餐酒', 'bistro', '酒館', '居酒屋', 'tapas', '小酒館', 'wine bar'],
    '咖啡': ['咖啡', 'café', 'cafe', 'coffee'],
};
let parkLayer = null;           // 停車圖層（🅿️ 停車 chip 開啟）：可視範圍內的停車場
let parkOn = false;
let parkAbort = null;
let parkDebounce = null;
let tileLayer = null;           // 底圖圖磚層（深色模式切 dark_matter / 淺色 voyager）
let searchFocus = null;         // 搜尋地點錨 {name,lat,lng}：清單改以此排序（Google 式）
let searchMarker = null;        // 搜尋落點 pin
let pinMarkers = new Map();     // pin.id -> L.CircleMarker（一般 pin，走 cluster）
let sponsorMarkers = new Map(); // pin.id -> L.Marker（贊助店專屬圖釘，永不聚合）
let starPin = null;             // 今日之星（日期種子每日輪換，金冠圖釘）
let starMarker = null;
let userLocation = null;
let userMarker = null;
let activeFilters = { deals: false, open: false, bookable: false, budget: null, favOnly: false };
let sheetSort = 'smart';         // 清單排序：smart(綜合) | distance(距離) | rating(評分) | deal(優惠)
let favLayer = null;             // 收藏店的金色 ♥ 標記層
let sheetOpen = false;
let savedSheetView = null;      // 清單→店家卡後保留的視角/捲動位置，重開清單時還原
let programmaticMove = false;   // 區分程式 flyTo 與使用者拖動（拖動會清掉 savedSheetView）

const BUDGET_CATEGORIES = ['200元內', '200-500元', '500-1000元', '1000-1500元', '1500以上'];
const TIER_WEIGHT = { offer: 3, menu: 3, cashback: 1, none: 0 };

// 一間店可能同時有套餐+訂位優惠：卡片/清單把所有適用的 badge 都秀（pin 顏色只取一種）
function dealBadgesHtml(pin) {
    let html = '';
    if (pin.hm) html += '<span class="map-badge map-badge--menu">套餐優惠</span>';
    if (pin.ho) html += '<span class="map-badge map-badge--offer">訂位優惠</span>';
    if (pin.b) html += '<span class="map-badge map-badge--cashback">出席回饋 $3/人</span>'; // 基本盤，與加碼優惠並存
    return html;
}

// 優惠明細行（迷你卡/聚光燈共用）：套餐款數 + 訂位優惠文字 + 回饋現金基本盤
function dealDetailLines({ hm, mc, offers, bookable }) {
    const lines = [];
    if (hm) lines.push(`🍽️ ${mc ? mc + ' 款' : ''}優惠套餐，訂位即享`);
    for (const o of (offers || []).slice(0, 3)) lines.push(`🎁 ${escapeHtml(o)}`);
    if (bookable) lines.push('💵 線上訂位＋出席，每人回饋 $3');
    return lines;
}
let sponsoredRestaurants = [];

// 聚光燈（幫我決定）狀態
let spotlightMarker = null;
let spotlightExcludes = [];     // 已抽過的店名（API 以名稱排除）
let decideCount = 0;
let decideInProgress = false;

// ---- 小工具 ----

// pins 的壓縮營業時間（[週一..週日] 陣列）還原成 getOpeningStatus 吃的物件格式
function expandHours(h) {
    if (!Array.isArray(h)) return null;
    const out = {};
    DAY_KEYS.forEach((d, i) => { out[d] = h[i] || []; });
    return out;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// 評分顯示：資料庫有 3.342857 這種原始浮點數，一律取一位小數
function formatRating(r) {
    if (r == null) return '';
    return String(Math.round(Number(r) * 10) / 10);
}

function distanceLabel(lat, lng) {
    if (!userLocation) return '';
    const d = calculateDistance(userLocation.lat, userLocation.lng, lat, lng);
    return formatDistance(d);
}

function navigationUrl(lat, lng, name) {
    // 開 Google Maps「路線」畫面即可（不指定 travelmode、不 dir_action=navigate）：
    // 用戶自己選開車 / 大眾運輸 / 步行，看各自路線與時間，不被強制丟進步行導航模式。
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

// ---- Leaflet 動態載入（只有地圖頁需要，不拖慢其他頁）----

let leafletReady = null;

// 逾時保護：手機/LINE 內嵌瀏覽器在爛網路下，請求可能「不回應也不報錯」永遠 hang，
// 注入的 <script>/<link> 的 onerror 也不會觸發 → await 卡死。用 race 強制在 N 秒後失敗，
// 讓 initMapPage 的 catch 能顯示「地圖載入失敗・重新載入」而不是無限空白。
function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`${label} 逾時（${ms}ms）`)), ms);
    });
    // 贏家出爐就清掉計時器（否則每次呼叫留一顆最長 ms 的 dangling timer + closure）
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`載入失敗: ${url}`));
        document.head.appendChild(s);
    });
}

function loadCss(url) {
    return new Promise((resolve, reject) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = url;
        l.onload = resolve;
        l.onerror = () => reject(new Error(`載入失敗: ${url}`));
        document.head.appendChild(l);
    });
}

function loadLeaflet() {
    if (leafletReady) return leafletReady;
    const base = new URL('../vendor/leaflet/', import.meta.url);
    leafletReady = (async () => {
        await withTimeout(Promise.all([
            loadCss(new URL('leaflet.css', base).href),
            loadCss(new URL('MarkerCluster.css', base).href),
            loadCss(new URL('MarkerCluster.Default.css', base).href),
        ]), 12000, 'Leaflet 樣式');
        await withTimeout(loadScript(new URL('leaflet.js', base).href), 12000, 'Leaflet');
        await withTimeout(loadScript(new URL('leaflet.markercluster.js', base).href), 12000, 'MarkerCluster');
        return window.L;
    })().catch(err => {
        leafletReady = null; // 別把「卡住/失敗的 promise」快取起來 → 重進地圖能重試
        throw err;
    });
    return leafletReady;
}

// ---- 深色模式 ----
// 生效主題：localStorage 覆寫優先，否則跟系統（prefers-color-scheme）。data-theme 設在 <html>，
// CSS 用 :root[data-theme="dark"] 套深色變數；index.html 內聯開機也會先設一次避免閃白。
const TILE_LIGHT = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const TILE_DARK = 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png';
function isDarkTheme() { return document.documentElement.dataset.theme === 'dark'; }
function tileUrl() { return isDarkTheme() ? TILE_DARK : TILE_LIGHT; }
function resolveTheme() {
    let pref = null;
    try { pref = localStorage.getItem('rr_theme'); } catch (e) { /* private mode */ }
    if (pref === 'dark' || pref === 'light') return pref;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function applyTheme(mode, persist) {
    document.documentElement.dataset.theme = mode;
    if (persist) { try { localStorage.setItem('rr_theme', mode); } catch (e) { /* private mode */ } }
    if (tileLayer) tileLayer.setUrl(tileUrl()); // 換底圖圖磚（Leaflet 原地刷新，不用重建）
    const btn = document.getElementById('themeToggle');
    if (btn) {
        const dark = mode === 'dark';
        btn.textContent = dark ? '☀️' : '🌙'; // 顯示「點下去會變成的樣子」
        btn.setAttribute('aria-pressed', String(dark));
        btn.setAttribute('aria-label', dark ? '切換為淺色外觀' : '切換為深色外觀');
    }
}
function toggleTheme() {
    const next = isDarkTheme() ? 'light' : 'dark';
    applyTheme(next, true);
    track('map_theme_toggle', { theme: next });
}
// 系統主題變動時（且使用者沒手動覆寫）跟著變
if (window.matchMedia) {
    try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            let pref = null; try { pref = localStorage.getItem('rr_theme'); } catch (e) {}
            if (pref !== 'dark' && pref !== 'light') applyTheme(resolveTheme(), false);
        });
    } catch (e) { /* older webview */ }
}

// ---- 頁面骨架 ----

function ensureMapRoot() {
    let root = document.getElementById('mapRoot');
    if (root) return root;

    root = document.createElement('div');
    root.id = 'mapRoot';
    root.className = 'map-root';
    root.innerHTML = `
        <div class="map-search" role="search">
            <input type="search" id="mapSearchInput" class="map-search__input"
                   placeholder="想吃哪一帶？搜地區、捷運站、店名" autocomplete="off"
                   aria-label="搜尋地區、捷運站或餐廳" enterkeyhint="search">
            <button type="button" class="map-search__clear" id="mapSearchClear" aria-label="清除搜尋" hidden>✕</button>
            <ul class="map-search__results" id="mapSearchResults" hidden></ul>
        </div>
        <div class="map-chips" role="toolbar" aria-label="地圖篩選">
            <button type="button" class="map-chip" id="chipParking" aria-pressed="false">🅿️ 停車</button>
            <button type="button" class="map-chip" id="chipOpen" aria-pressed="false">🕐 現在有開</button>
            <button type="button" class="map-chip" id="chipBookable" aria-pressed="false">📅 可訂位</button>
            <button type="button" class="map-chip" id="chipFav" aria-pressed="false">❤️ 收藏</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="火鍋" aria-pressed="false">🍲 火鍋</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="燒肉" aria-pressed="false">🥩 燒肉</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="吃到飽" aria-pressed="false">🍱 吃到飽</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="餐酒館" aria-pressed="false">🍷 餐酒館</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="咖啡" aria-pressed="false">☕ 咖啡廳</button>
        </div>
        <button type="button" class="map-theme-btn" id="themeToggle" aria-label="切換深色／淺色外觀" aria-pressed="false">🌙</button>
        <button type="button" class="map-locate-btn" id="chipLocate" aria-label="定位到我的位置">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
                <line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>
                <line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>
            </svg>
        </button>
        <div class="map-toast" id="mapToast" role="status" aria-live="polite" hidden></div>
        <div id="liffMap" class="map-canvas" role="application" aria-label="餐廳好康地圖"></div>
        <button type="button" class="map-fab" id="mapDecideBtn" aria-label="幫我決定，隨機推薦一間">
            <span class="map-fab__dice" aria-hidden="true">🎲</span>
            <span class="map-fab__count" id="fabDiceCount" aria-hidden="true"></span>
        </button>

        <div class="map-sheet" id="mapSheet">
            <button type="button" class="map-sheet__handle" id="sheetHandle"
                    aria-expanded="false" aria-controls="sheetBody">
                <span class="map-sheet__grip" aria-hidden="true"></span>
                <span class="map-sheet__summary" id="mapCountPill" role="status" aria-live="polite">載入地圖中…</span>
            </button>
            <div class="map-sheet__body" id="sheetBody">
                <div class="map-sheet__legend" aria-label="圖例">
                    <span><i class="map-dot" style="background:#E44E25"></i>套餐優惠</span>
                    <span><i class="map-dot" style="background:#E5A000"></i>訂位優惠</span>
                    <span><i class="map-dot" style="background:#68A9A0"></i>出席回饋</span>
                    <span><i class="map-dot map-dot--hollow"></i>暫無優惠</span>
                </div>
                <div class="map-sheet__budget" id="sheetBudget" role="group" aria-label="預算篩選"></div>
                <div class="map-sheet__sort" id="sheetSort" role="group" aria-label="排序方式">
                    <span class="map-sheet__sort-label">排序</span>
                    <button type="button" class="map-sort-chip is-active" data-sort="smart" aria-pressed="true">綜合</button>
                    <button type="button" class="map-sort-chip" data-sort="distance" aria-pressed="false">距離</button>
                    <button type="button" class="map-sort-chip" data-sort="rating" aria-pressed="false">評分</button>
                    <button type="button" class="map-sort-chip" data-sort="deal" aria-pressed="false">優惠</button>
                </div>
                <ul class="map-sheet__list" id="sheetList"></ul>
            </div>
        </div>

        <div class="map-minicard" id="mapMiniCard" hidden>
            <button type="button" class="map-card-close" id="miniCardClose" aria-label="關閉">✕</button>
            <div class="map-minicard__body" id="miniCardBody"></div>
        </div>

        <div class="map-spotlight" id="mapSpotlight" hidden>
            <button type="button" class="map-card-close" id="spotlightClose" aria-label="關閉">✕</button>
            <div class="map-spotlight__body" id="spotlightBody"></div>
            <div class="map-spotlight__actions">
                <button type="button" class="map-btn map-btn--ghost" id="spotlightRedraw">🎲 再抽一家</button>
                <span id="spotlightActionLinks"></span>
            </div>
        </div>
    `;

    document.body.appendChild(root);
    return root;
}

// ---- Pin 與篩選 ----

function pinPassesFilters(pin, now) {
    // 「加碼優惠」篩選：只留套餐/訂位（回饋現金是基本盤，人人有，不算加碼）
    if (activeFilters.deals && pin.t !== 'menu' && pin.t !== 'offer') return false;
    // 品類篩選（搜尋「火鍋」或快捷 chip）：pin 品類與命中集合有交集才留
    if (catFilter && !(pin.ct || []).some(i => catFilter.set.has(i))) return false;
    if (activeFilters.bookable && !pin.b) return false;
    if (activeFilters.favOnly && !isFav(pin.id)) return false;
    // 預算：無預算資料的店不被篩掉（與後端 matchesBudget 規則一致）
    if (activeFilters.budget && pin.bc && pin.bc !== activeFilters.budget) return false;
    if (activeFilters.open) {
        const hours = expandHours(pin.h);
        if (!hours) return false;
        if (!getOpeningStatus(hours, now).openNow) return false;
    }
    return true;
}

// 讓常駐店名標籤本身可點（Leaflet 的 interactive tooltip 不會把 click
// 轉發到 circleMarker，所以在 tooltipopen 時直接綁 DOM click 到標籤元素）
function makeLabelClickable(marker, pin, trackProps) {
    marker.on('tooltipopen', (e) => {
        const el = e.tooltip && e.tooltip.getElement();
        if (el && !el.dataset.clickBound) {
            el.dataset.clickBound = '1';
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                track('map_pin_click', trackProps);
                showMiniCard(pin);
            });
        }
    });
}

// 餐廳 icon（Google 風格）：合作店（有優惠/可回饋）用它，一眼跟灰點未合作店區隔。
// 底色＝優惠等級（紅套餐/金訂位/青回饋），內嵌「分類圖示」＝這是什麼店（火鍋/燒肉/咖啡…）
// → 同時傳達「有什麼優惠 + 是什麼店」，更接近 Google Maps 的分類化圖釘。
// 分類白色單色圖示（Google 式：依「用餐型態」分桶，非細分菜系）。都不中→預設刀叉(restaurant)。
const GLYPHS = {
    // 刀叉：一般餐廳（日式/中式/義式/海鮮…都歸這，跟 Google 一樣）
    restaurant: '<path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/>',
    // 咖啡杯（Material local_cafe）
    cafe: '<path d="M18.5 3H6c-1.1 0-2 .9-2 2v5.71c0 3.83 2.95 7.18 6.78 7.29 3.96.12 7.22-3.06 7.22-7v-1h.5c1.93 0 3.5-1.57 3.5-3.5S20.43 3 18.5 3zM16 5v3H6V5h10zm2.5 3H18V5h.5c.83 0 1.5.67 1.5 1.5S19.33 8 18.5 8zM4 19h16v2H4z"/>',
    // 馬丁尼杯（Material local_bar）：酒吧/餐酒/居酒屋
    bar: '<path d="M21 5V3H3v2l8 9v5H6v2h12v-2h-5v-5l8-9zM7.43 7L5.66 5h12.69l-1.78 2H7.43z"/>',
    // 杯子蛋糕：甜點/烘焙
    dessert: '<path d="M5.5 11a6.5 6.5 0 0 1 13 0z"/><path d="M6.7 12.6h10.6l-1.05 6.6a1 1 0 0 1-1 .8H8.75a1 1 0 0 1-1-.8z"/><circle cx="12" cy="6" r="1.5"/>',
    // 鍋＋蒸氣：火鍋
    hotpot: '<rect x="3.4" y="10.2" width="17.2" height="2.3" rx="1.1"/><path d="M5 13.2h14v.8a5.5 5.5 0 0 1-5.5 5.5h-3A5.5 5.5 0 0 1 5 14z"/><rect x="1.2" y="13.4" width="3.3" height="1.9" rx="0.95"/><rect x="19.5" y="13.4" width="3.3" height="1.9" rx="0.95"/><path d="M9 8.4c0-1 1-1.3 1-2.4s-1-1.4-1-2.4M14 8.4c0-1 1-1.3 1-2.4s-1-1.4-1-2.4" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>',
    // 烤肉串（三塊肉串在竹籤上）：燒肉/串燒
    grill: '<path d="M3.8 20.2 20.2 3.8" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/><rect x="6.6" y="13.6" width="4.2" height="4.2" rx="1.3" transform="rotate(-45 8.7 15.7)"/><rect x="9.9" y="9.9" width="4.2" height="4.2" rx="1.3" transform="rotate(-45 12 12)"/><rect x="13.2" y="6.2" width="4.2" height="4.2" rx="1.3" transform="rotate(-45 15.3 8.3)"/>',
    // 麵碗＋筷子：拉麵/烏龍麵
    noodles: '<path d="M3.5 11.2h17a8.5 8.5 0 0 1-8.5 8 8.5 8.5 0 0 1-8.5-8z"/><path d="M13.4 3.2 17 9.8M16.8 3 18.2 9.8" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>',
};
// 關鍵字 → 圖示 key（優先序：specific 在前）。比對 pin 的 tg 標籤 + ct 分類名。
const CATEGORY_RULES = [
    [/火鍋|麻辣鍋|涮涮鍋|鍋物|薑母鴨|羊肉爐/, 'hotpot'],
    [/燒肉|烤肉|鐵板燒|燒烤|串燒|串焼|串揚/, 'grill'],
    [/拉麵|烏龍麵|沾麵|蕎麥|麵線/, 'noodles'],
    [/咖啡|café|cafe/i, 'cafe'],
    [/酒吧|餐酒|酒類|清酒|啤酒|調酒|居酒屋|bar|lounge|wine|whisky|sake/i, 'bar'],
    [/甜點|蛋糕|麵包|西點|布丁|鬆餅|甜品|冰淇淋|可麗餅|下午茶|烘焙|甜甜圈/, 'dessert'],
];
function pinGlyphSvg(pin) {
    const cats = (pin.tg || []).join(' ') + ' '
        + (pin.ct || []).map(i => (allCats && allCats[i]) || '').join(' ');
    let key = 'restaurant';
    for (const [re, k] of CATEGORY_RULES) if (re.test(cats)) { key = k; break; }
    return `<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true">${GLYPHS[key]}</svg>`;
}

function bindPinCommon(marker, pin, offsetX, isDeal) {
    // 高 zoom（cluster 散開後）顯示店名標籤：掃視地圖不用逐顆點
    // z16 先亮「有加碼優惠」的店名，z17 全亮（密集區標籤分層，見 syncLabels）
    marker.bindTooltip(pin.n, {
        permanent: true,
        interactive: true, // 標籤本身可點（否則點文字會穿透到地圖）
        direction: 'right',
        offset: [offsetX, 0],
        className: `map-pin-label${isDeal ? ' map-pin-label--deal' : ''}`,
    });
    const trackProps = { or_id: pin.id, name: pin.n, tier: pin.t };
    marker.on('click', () => {
        track('map_pin_click', trackProps);
        showMiniCard(pin);
    });
    makeLabelClickable(marker, pin, trackProps);
    return marker;
}

// 「暫無優惠」(none)：與無優惠 POI 同款空心灰點——用戶眼中兩者等價（不能訂、沒優惠）。灰點不動。
function buildDotMarker(L, pin, t) {
    const marker = L.circleMarker([pin.lat, pin.lng], {
        radius: t.radius,
        color: t.color,
        weight: 1.5,
        fillColor: '#FFFFFF',
        fillOpacity: 0.9,
        // 關掉冒泡（否則點擊冒泡到地圖 click→closeMiniCard，卡瞬間被關，像「點沒反應」）
        bubblingMouseEvents: false,
    });
    marker._baseRadius = t.radius;
    return bindPinCommon(marker, pin, 8, false);
}

function buildMarker(L, pin) {
    const t = TIER[pin.t] || TIER.none;
    if (pin.t === 'none') return buildDotMarker(L, pin, t);

    // 合作店（menu/offer/cashback）：改用餐廳 icon。優惠店(menu/offer)大一號、上層，回饋店(cashback)略小。
    const isDeal = pin.t === 'menu' || pin.t === 'offer';
    const size = isDeal ? 30 : 24;
    const inner = pinGlyphSvg(pin); // 分類白色圖示（都不中→刀叉）
    const marker = L.marker([pin.lat, pin.lng], {
        icon: L.divIcon({
            className: 'map-food-wrap',
            html: `<div class="map-food-pin${isDeal ? ' map-food-pin--lg' : ''}" style="background:${t.color}">${inner}</div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
        }),
        zIndexOffset: isDeal ? 500 : 400,
        // L.marker 預設 bubblingMouseEvents:false，不會冒泡關卡
    });
    return bindPinCommon(marker, pin, size / 2 + 2, isDeal);
}

// 今日之星：日期種子每日輪換一間好康店（CD6+CD7：每日新鮮感 + 過期不候）
function pickStarPin() {
    const pool = allPins.filter(p => p.t === 'menu' || p.t === 'offer');
    if (!pool.length) return null;
    const d = new Date();
    const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    return pool[seed % pool.length];
}

function buildStarMarker(L, pin) {
    const marker = L.marker([pin.lat, pin.lng], {
        icon: L.divIcon({
            className: 'map-sponsor-wrap',
            html: '<div class="map-star-pin"><span aria-hidden="true">👑</span></div>',
            iconSize: [36, 44],
            iconAnchor: [18, 42],
        }),
        zIndexOffset: 700,
    });
    marker.bindTooltip(`今日之星 · ${pin.n}`, {
        permanent: true,
        interactive: true,
        direction: 'right',
        offset: [14, -24],
        className: 'map-pin-label map-pin-label--star',
    });
    const trackProps = { or_id: pin.id, name: pin.n, star: true };
    marker.on('click', () => {
        track('map_star_pin_click', { or_id: pin.id, name: pin.n });
        showMiniCard(pin);
    });
    makeLabelClickable(marker, pin, trackProps);
    return marker;
}

// ---- 無優惠餐廳（灰空心點）：對照出「有優惠店」的價值 ----
// 對用戶只講價值（有無優惠/訂位），不講內部視角的「合作」

function showExtCard(poi) {
    closeSpotlight();
    // 若上一張餐廳卡的「查附近停車」還在飛，先取消：否則它會寫進已被本卡 innerHTML 換掉的節點（浪費請求）
    if (parkingAbort) parkingAbort.abort();
    const card = document.getElementById('mapMiniCard');
    const body = document.getElementById('miniCardBody');
    if (!card || !body) return;
    setSelectedRing(poi.lat, poi.lng);
    body.innerHTML = `
        <div class="map-minicard__info">
            <div class="map-minicard__badges"><span class="map-badge map-badge--ext">暫無優惠</span></div>
            <h3 class="map-minicard__name">${poi.u
                ? `<a href="${escapeHtml(poi.u)}" data-liff-internal target="_blank" rel="noopener">${escapeHtml(poi.n)}<span class="map-minicard__more"> ›</span></a>`
                : escapeHtml(poi.n)}</h3>
            <p class="map-minicard__meta">
                ${poi.r ? `⭐ ${formatRating(poi.r)}　` : ''}${escapeHtml(poi.d || '')}${poi.cu ? `　·　${escapeHtml(poi.cu)}` : ''}${poi.bud ? `　·　💰 ${escapeHtml(poi.bud)}` : ''}
            </p>
            <p class="map-minicard__ext-note">這間目前沒有優惠、也不能線上訂位 😢<br>找有色點的店，訂位出席每人回饋 $3</p>
            <div class="map-minicard__actions">
                <a class="map-btn map-btn--ghost" data-track="navigation" href="${navigationUrl(poi.lat, poi.lng, poi.n)}" target="_blank" rel="noopener">🧭 導航</a>
            </div>
        </div>
    `;
    card.hidden = false;
    updateCardOpenState();
}

function buildExtLayer(L) {
    if (!extPois.length || !map) return;
    extLayer = L.layerGroup();
    extMarkers = [];
    for (const poi of extPois) {
        const m = L.circleMarker([poi.lat, poi.lng], {
            radius: 5,
            color: '#9A948C',
            weight: 1.5,
            fillColor: '#FFFFFF',
            fillOpacity: 0.9,
            bubblingMouseEvents: false, // 同 buildMarker：不讓點擊冒泡到地圖 click 把卡關掉
        });
        m._poi = poi;
        m.on('click', () => {
            track('map_ext_pin_click', { name: poi.n });
            showExtCard(poi);
        });
        extMarkers.push(m);
    }
    rebuildExtMembership(); // 依目前 catFilter 決定哪些灰點進 extLayer
    map.on('zoomend', syncExtLayer);
    map.on('moveend', syncExtLabels);
    syncExtLayer();
}

// 灰點是否符合目前品類（火鍋/燒肉…或搜尋字）：無品類篩選時全數符合。
// 比對「店名 + 國別菜系(cu)」；chip 用關鍵字表、自由搜尋則以搜尋字本身當關鍵字。
function extMatchesCat(poi) {
    if (!catFilter) return true;
    const hay = (poi.n + ' ' + (poi.cu || '')).toLowerCase();
    const kws = EXT_CAT_KEYWORDS[catFilter.label] || [catFilter.label];
    return kws.some(k => hay.includes(k.toLowerCase()));
}

// 依目前 catFilter 重算 extLayer 成員（品類切換時才需要，避免每次 zoom 重建）
function rebuildExtMembership() {
    if (!extLayer) return;
    extLayer.clearLayers();
    for (const m of extMarkers) {
        if (extMatchesCat(m._poi)) extLayer.addLayer(m);
    }
    extLayerCatKey = catFilter ? catFilter.label : null;
}

// 灰點（未合作餐廳）只在「沒套用會排除它們的篩選」時顯示。原則：篩選代表某個條件，
// 灰點資料無法證明它符合，就不該顯示（否則等於假裝它符合）。
// - 可訂位/加碼優惠/預算/收藏：合作條件，未合作店本就不符合 → 隱藏。
// - 現在有開：灰點的 external_pois 沒有營業時間資料 → 無法證明「現在有開」。全部留著＝
//   假裝 1261 家都開著，早上 7 點幾乎全關時特別離譜（用戶回報）→ 一律隱藏，只留「確定有開」的合作店。
function extFilteredOut() {
    return activeFilters.deals || activeFilters.open || activeFilters.bookable
        || !!activeFilters.budget || activeFilters.favOnly;
}
function syncExtLayer() {
    if (!extLayer || !map) return;
    const catKey = catFilter ? catFilter.label : null;
    if (catKey !== extLayerCatKey) rebuildExtMembership(); // 品類變了 → 灰點跟著只留符合的
    const show = map.getZoom() >= 16 && !extFilteredOut(); // 街區層級 + 未被篩選排除
    if (show && !map.hasLayer(extLayer)) map.addLayer(extLayer);
    else if (!show && map.hasLayer(extLayer)) map.removeLayer(extLayer);
    syncExtLabels();
}

// 灰點店名：拉很近（z≥17）時顯示灰色標籤（用戶回報：zoom 很近應該要看得到名字）。
// 1,262 點不能全掛常駐 tooltip（DOM 太重）→ 只幫「視窗內」的動態綁定，離開視窗即解綁
function syncExtLabels() {
    if (!extLayer || !map) return;
    const show = map.getZoom() >= 17 && map.hasLayer(extLayer);
    const bounds = show ? map.getBounds().pad(0.15) : null;
    extLayer.eachLayer(m => {
        const inView = show && bounds.contains(m.getLatLng());
        if (inView && !m.getTooltip()) {
            m.bindTooltip(m._poi.n, {
                permanent: true,
                interactive: true,
                direction: 'right',
                offset: [7, 0],
                className: 'map-pin-label map-pin-label--ext',
            });
            // tooltipopen 只綁一次：marker 反覆進出視窗會重綁 tooltip，但 Leaflet 層級的 on()
            // 不會被 unbindTooltip 移除 → 沒 guard 會每次進視窗多累積一個 handler（記憶體只增不減）。
            if (!m._extLabelBound) {
                m._extLabelBound = true;
                m.on('tooltipopen', (e) => {
                    const el = e.tooltip && e.tooltip.getElement();
                    if (el && !el.dataset.clickBound) {
                        el.dataset.clickBound = '1';
                        el.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            track('map_ext_pin_click', { name: m._poi.n, via: 'label' });
                            showExtCard(m._poi);
                        });
                    }
                });
            }
            m.openTooltip();
        } else if (!inView && m.getTooltip()) {
            m.unbindTooltip();
        }
    });
    scheduleLabelCollision();
}

// ---- 標籤碰撞隱藏（Google Maps 式）----
// 密集區店名互疊很擠 → 依優先序放置，重疊到高優先者的次要店名就藏起來（點還在）。
// 優先序：搜尋落點 > 贊助(付費) > 今日之星 > 加碼優惠 > 合作店 > 暫無優惠(灰)。
function labelPriority(el) {
    const c = el.classList;
    if (c.contains('map-pin-label--search')) return 100;
    if (c.contains('map-pin-label--sponsor')) return 90;
    if (c.contains('map-pin-label--star')) return 80;
    if (c.contains('map-pin-label--deal')) return 70;
    if (c.contains('map-pin-label--ext')) return 10;
    return 40; // 合作店（出席回饋 cashback）
}

let collisionRAF = null;
function scheduleLabelCollision() {
    if (collisionRAF) return;
    collisionRAF = requestAnimationFrame(() => {
        collisionRAF = null;
        runLabelCollision();
    });
}

function runLabelCollision() {
    const all = document.querySelectorAll('.map-pin-label');
    if (!all.length) return;
    for (const el of all) el.classList.remove('is-collided'); // 先全放出來重算
    const vw = window.innerWidth, vh = window.innerHeight;
    const labels = [];
    for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;                       // 被分層規則隱藏
        if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue; // 視窗外
        labels.push({ el, r, p: labelPriority(el) });
    }
    // 高優先先放；同優先照由上到下（結果穩定、不閃動）
    labels.sort((a, b) => b.p - a.p || a.r.top - b.r.top);
    const placed = [];
    const PAD = 2;
    for (const { el, r, p } of labels) {
        if (p >= 90) { placed.push(r); continue; } // 搜尋/贊助永遠留（付費曝光不能被吃）
        let hit = false;
        for (const q of placed) {
            if (r.left < q.right + PAD && r.right > q.left - PAD &&
                r.top < q.bottom + PAD && r.bottom > q.top - PAD) { hit = true; break; }
        }
        if (hit) el.classList.add('is-collided');
        else placed.push(r);
    }
}

// 贊助店專屬圖釘：醒目、永不被 cluster 聚合、任何 zoom 都看得到、店名常駐
// （付費曝光的核心價值：不能被聚合圈吃掉）
function buildSponsorMarker(L, pin) {
    const marker = L.marker([pin.lat, pin.lng], {
        icon: L.divIcon({
            className: 'map-sponsor-wrap',
            html: '<div class="map-sponsor-pin"><span aria-hidden="true">⭐</span></div>',
            iconSize: [36, 44],
            iconAnchor: [18, 42],
        }),
        zIndexOffset: 800,
    });
    marker.bindTooltip(pin.n, {
        permanent: true,
        interactive: true,
        direction: 'right',
        offset: [14, -24],
        className: 'map-pin-label map-pin-label--sponsor',
    });
    const trackProps = { or_id: pin.id, name: pin.n, tier: pin.t, sponsor_pin: true };
    marker.on('click', () => {
        track('map_pin_click', trackProps);
        showMiniCard(pin);
    });
    makeLabelClickable(marker, pin, trackProps);
    return marker;
}

function applyFilters() {
    if (!clusterGroup) return;
    savedSheetView = null; // 篩選變了，舊的清單脈絡不再成立
    const now = new Date();
    const visible = [];
    clusterGroup.clearLayers();
    for (const pin of allPins) {
        if (!pinPassesFilters(pin, now)) continue;
        if (sponsorMarkers.has(pin.id)) continue; // 贊助圖釘獨立管理，不進 cluster
        if (starPin && pin.id === starPin.id) continue; // 今日之星有專屬金冠釘
        visible.push(pinMarkers.get(pin.id));
    }
    clusterGroup.addLayers(visible);
    // 贊助圖釘：通過篩選才顯示（例如「營業中」時已打烊的贊助店也要誠實隱藏）
    for (const pin of allPins) {
        const m = sponsorMarkers.get(pin.id);
        if (!m) continue;
        const pass = pinPassesFilters(pin, now);
        if (pass && !map.hasLayer(m)) m.addTo(map);
        else if (!pass && map.hasLayer(m)) map.removeLayer(m);
    }
    refreshFavLayer();
    if (extLayer) syncExtLayer(); // 篩選改變 → 灰點跟著顯示/隱藏（可訂位等 qualifying 篩選會排除未合作店）
    updateCountPill();
}

// 收藏店的金色 ♥ 標記：釘在通過篩選的收藏 pin 右上，掃視就找得到「我存的店」
function refreshFavLayer() {
    if (!map || !window.L) return;
    const L = window.L;
    if (!favLayer) favLayer = L.layerGroup().addTo(map);
    favLayer.clearLayers();
    const favs = getFavs();
    if (!favs.size) return;
    const now = new Date();
    for (const pin of allPins) {
        if (!favs.has(pin.id)) continue;
        if (!pinPassesFilters(pin, now)) continue; // 被篩掉的收藏店不要留孤零零的心
        const icon = L.divIcon({
            className: 'map-fav-marker',
            html: '<span aria-hidden="true">♥</span>',
            iconSize: [16, 16],
            iconAnchor: [-3, 18], // 錨在點的右下方，不遮住 pin 本體
        });
        L.marker([pin.lat, pin.lng], { icon, interactive: false, keyboard: false, zIndexOffset: 600 })
            .addTo(favLayer);
    }
}

function updateFavChip() {
    const chip = document.getElementById('chipFav');
    if (!chip) return;
    const n = favCount();
    chip.textContent = n ? `❤️ 收藏 ${n}` : '❤️ 收藏';
    chip.classList.toggle('is-active', activeFilters.favOnly);
    chip.setAttribute('aria-pressed', String(activeFilters.favOnly));
}

// 收藏切換後的統一刷新（地圖心標、chip 數字、清單、若正在只看收藏則重新篩選）
function afterFavChange() {
    updateFavChip();
    if (activeFilters.favOnly) applyFilters();
    else { refreshFavLayer(); if (sheetOpen) renderSheetList(); }
}

function updateCountPill() {
    const pill = document.getElementById('mapCountPill');
    if (!pill || !map) return;
    const bounds = map.getBounds();
    const now = new Date();
    let partnerInView = 0; // 合作店（有座標、走篩選）
    let cashback = 0;      // 可訂位＝出席回饋現金（基本盤）
    let deals = 0;         // 套餐/訂位優惠（加碼）
    for (const pin of allPins) {
        if (!pinPassesFilters(pin, now)) continue;
        if (!bounds.contains([pin.lat, pin.lng])) continue;
        partnerInView++;
        if (pin.b) cashback++;
        if (pin.t === 'menu' || pin.t === 'offer') deals++;
    }
    // 總數要含「暫無優惠」的未合作店（用戶眼中都是餐廳）：
    // 僅在灰點真的顯示（z≥16）、且未套用會排除它們的篩選時併入
    let extInView = 0;
    const extShown = extLayer && map.hasLayer(extLayer);
    if (extShown && !extFilteredOut()) {
        for (const poi of extPois) {
            if (!extMatchesCat(poi)) continue; // 有品類篩選時只算符合的灰點（與地圖顯示一致）
            if (bounds.contains([poi.lat, poi.lng])) extInView++;
        }
    }
    const total = partnerInView + extInView;
    if (total === 0) {
        const filtered = activeFilters.deals || activeFilters.open || activeFilters.bookable
            || activeFilters.budget || activeFilters.favOnly;
        pill.textContent = activeFilters.favOnly
            ? '這個範圍內沒有收藏的店，滑動地圖看看'
            : filtered
                ? '篩選有點嚴格，鬆開一個條件再看看'
                : '這一帶還沒有店家，滑去鬧區看看';
    } else {
        // 窄屏用短版，避免被 FAB 保留區截斷
        pill.textContent = window.matchMedia('(max-width: 360px)').matches
            ? `${total} 間 · 回饋 ${cashback} · 加碼 ${deals}`
            : `畫面內 ${total} 間 · ${cashback} 間出席回饋 · ${deals} 間加碼優惠`;
    }
    if (sheetOpen) renderSheetList();
}

// ---- Bottom sheet：與地圖視窗連動的清單 ----

const SHEET_MAX_ROWS = 60;

function setSheetOpen(open) {
    sheetOpen = open;
    const root = document.getElementById('mapRoot');
    const handle = document.getElementById('sheetHandle');
    root.classList.toggle('is-sheet-open', open);
    handle.setAttribute('aria-expanded', String(open));
    if (open) {
        closeMiniCard();
        closeSpotlight();
        // 從清單點過店家 → 回來時還原當時的視角與捲動位置，逛到一半不歸零
        if (savedSheetView && map) {
            programmaticMove = true;
            map.setView(savedSheetView.center, savedSheetView.zoom, { animate: false });
            renderSheetList();
            document.getElementById('sheetList').scrollTop = savedSheetView.scrollTop;
            savedSheetView = null;
        } else {
            renderSheetList();
            if (selectedPinId != null) highlightSheetRow(selectedPinId, true); // 捲到剛看過的那家
        }
    }
    track(open ? 'map_sheet_open' : 'map_sheet_close', {});
}

function renderBudgetChips() {
    const wrap = document.getElementById('sheetBudget');
    wrap.innerHTML = BUDGET_CATEGORIES.map(c =>
        `<button type="button" class="map-chip map-chip--sm${activeFilters.budget === c ? ' is-active' : ''}"
                 data-budget="${c}" aria-pressed="${activeFilters.budget === c}">${c}</button>`
    ).join('');
    wrap.querySelectorAll('[data-budget]').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.budget;
            activeFilters.budget = activeFilters.budget === val ? null : val; // 再點一次取消
            track('map_filter_budget', { budget: activeFilters.budget });
            renderBudgetChips();
            applyFilters();
        });
    });
}

function sheetRowsInView() {
    if (!map) return [];
    const bounds = map.getBounds();
    const now = new Date();
    const rows = [];
    for (const pin of allPins) {
        if (!pinPassesFilters(pin, now)) continue;
        if (!bounds.contains([pin.lat, pin.lng])) continue;
        rows.push(pin);
    }
    // 贊助店永遠置頂（付費曝光，清單同樣給位）；其餘依使用者選的排序
    const spo = (p) => (p.sp ? 1 : 0);
    // 距離錨：搜尋落點 > 使用者定位 > 地圖中心（保證「距離」永遠可排）
    const c = map.getCenter();
    const anchor = searchFocus || userLocation || { lat: c.lat, lng: c.lng };
    const byDist = (a, b) =>
        calculateDistance(anchor.lat, anchor.lng, a.lat, a.lng) -
        calculateDistance(anchor.lat, anchor.lng, b.lat, b.lng);
    const byRating = (a, b) => (b.r || 0) - (a.r || 0);
    const byDeal = (a, b) => (TIER_WEIGHT[b.t] - TIER_WEIGHT[a.t]) || ((b.r || 0) - (a.r || 0));
    let cmp;
    if (sheetSort === 'distance') cmp = byDist;
    else if (sheetSort === 'rating') cmp = byRating;
    else if (sheetSort === 'deal') cmp = byDeal;
    else cmp = (searchFocus || userLocation) ? byDist : byDeal; // smart：有錨點看距離，否則看好康
    rows.sort((a, b) => (spo(b) - spo(a)) || cmp(a, b));
    return rows;
}

function renderSheetList() {
    const list = document.getElementById('sheetList');
    if (!list) return;
    const rows = sheetRowsInView();
    const shown = rows.slice(0, SHEET_MAX_ROWS);

    if (!shown.length) {
        list.innerHTML = '<li class="map-sheet__empty">這附近沒有符合的店，滑動地圖或放寬條件</li>';
        return;
    }

    // 距離顯示與排序同錨：有搜尋落點時顯示「距該點」的距離
    const anchor = searchFocus || userLocation;
    list.innerHTML = shown.map(pin => {
        const hours = expandHours(pin.h);
        const opening = hours ? getOpeningStatus(hours) : null;
        const dist = anchor
            ? formatDistance(calculateDistance(anchor.lat, anchor.lng, pin.lat, pin.lng))
            : '';
        return `
        <li>
            <button type="button" class="map-sheet__item${pin.id === selectedPinId ? ' is-active' : ''}" data-pin-id="${pin.id}">
                ${pin.img
                    ? `<img class="map-sheet__thumb" src="${escapeHtml(pin.img)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
                    : '<span class="map-sheet__thumb map-sheet__thumb--empty">🍽️</span>'}
                <span class="map-sheet__item-info">
                    <span class="map-sheet__item-top">
                        <span class="map-sheet__item-name">${isFav(pin.id) ? '<span class="map-sheet__fav" aria-label="已收藏">❤️</span>' : ''}${escapeHtml(pin.n)}</span>
                        ${dealBadgesHtml(pin)}
                    </span>
                    <span class="map-sheet__item-meta">
                        ${pin.r ? `⭐ ${formatRating(pin.r)}` : ''}${dist ? `　${dist}` : ''}${pin.bud ? `　💰 ${escapeHtml(pin.bud)}` : ''}
                    </span>
                    ${opening && opening.label
                        ? `<span class="map-sheet__item-meta ${opening.openNow ? 'is-open' : ''}">${escapeHtml(opening.label)}</span>`
                        : ''}
                </span>
            </button>
        </li>`;
    }).join('') + (rows.length > SHEET_MAX_ROWS
        ? `<li class="map-sheet__empty">還有 ${rows.length - SHEET_MAX_ROWS} 間，拉近地圖看更多</li>`
        : '') + (extPois.length
        ? '<li class="map-sheet__footnote">地圖上的灰色小點＝暫無優惠的餐廳</li>'
        : '');

    list.querySelectorAll('.map-sheet__item').forEach(btn => {
        btn.addEventListener('click', () => {
            const pin = allPins.find(p => p.id === Number(btn.dataset.pinId));
            if (!pin) return;
            track('map_sheet_item_click', { or_id: pin.id, name: pin.n, tier: pin.t });
            // 記住清單當下的視角/捲動位置，關卡片重開清單時還原
            savedSheetView = {
                center: map.getCenter(),
                zoom: map.getZoom(),
                scrollTop: document.getElementById('sheetList').scrollTop,
            };
            setSheetOpen(false);
            programmaticMove = true;
            map.flyTo([pin.lat, pin.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
            showMiniCard(pin);
        });
    });
}

// 暫時性提示 toast（定位失敗、首次教學等）：獨立元素可換行，
// 不塞進統計 pill（窄屏會截斷到看不懂）
let toastTimer = null;
function showPillMessage(text, ms = 4000) {
    const toast = document.getElementById('mapToast');
    if (!toast) return;
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
}

// ---- 迷你資訊卡（點 pin）----

function tierBadgeHtml(tier) {
    if (!tier || tier === 'none') return '';
    const t = TIER[tier];
    if (!t || !t.label) return '';
    return `<span class="map-badge map-badge--${tier}">${t.label}</span>`;
}

// 選中店家高亮圈（Google Maps 慣例：卡片開著時，地圖上看得出對應哪個點）
let selectedRing = null;
function setSelectedRing(lat, lng) {
    clearSelectedRing();
    if (!map || !window.L) return;
    selectedRing = window.L.circleMarker([lat, lng], {
        radius: 16, color: '#E44E25', weight: 3, fill: false, opacity: 0.9,
        interactive: false,
    }).addTo(map);
}
function clearSelectedRing() {
    if (selectedRing && map) { map.removeLayer(selectedRing); selectedRing = null; }
}

// 選中強調（Google 式）：點到的合作店 icon 放大浮起、拉到最上層。灰點/外部點沿用選中圈即可。
let selectedPinEl = null;
let selectedPinId = null;       // 目前選中的店（清單↔地圖雙向高亮共用）
function setSelectedPin(pin) {
    clearSelectedPin();
    selectedPinId = pin.id;
    const marker = pinMarkers.get(pin.id) || sponsorMarkers.get(pin.id);
    const el = marker && marker.getElement && marker.getElement(); // divIcon 的 DOM（circleMarker 無）
    if (el) {
        el.classList.add('is-selected');
        // 一次性彈跳回饋：先移除再於下一幀加上，讓動畫每次選取都重播
        el.classList.remove('is-bounce');
        requestAnimationFrame(() => el.classList.add('is-bounce'));
        selectedPinEl = el;
    }
    if (sheetOpen) highlightSheetRow(pin.id); // 清單開著時同步高亮對應列
}
function clearSelectedPin() {
    if (selectedPinEl) { selectedPinEl.classList.remove('is-selected', 'is-bounce'); selectedPinEl = null; }
}
// 清單列高亮 + 捲到可視（地圖→清單）
function highlightSheetRow(pinId, scroll = false) {
    const list = document.getElementById('sheetList');
    if (!list) return;
    let active = null;
    list.querySelectorAll('.map-sheet__item').forEach(btn => {
        const on = Number(btn.dataset.pinId) === pinId;
        btn.classList.toggle('is-active', on);
        if (on) active = btn;
    });
    if (active && scroll) active.scrollIntoView({ block: 'nearest' });
}

// Google 式：選了店若該 pin 被底部卡片蓋住/太貼近卡片，把地圖上移讓 pin 露在卡片上方。
// 只在 pin 真的被遮時才動（純垂直），避免與 flyTo 類路徑打架、也不無謂晃動。
function panPinAboveCard(lat, lng) {
    if (!map) return;
    requestAnimationFrame(() => {
        const card = document.getElementById('mapMiniCard');
        if (!card || card.hidden) return;
        const size = map.getSize();
        const cardTop = size.y - (card.offsetHeight || 0);
        const target = map.latLngToContainerPoint([lat, lng]);
        if (target.y <= cardTop - 24) return;                 // 已在卡片上方安全區 → 不動
        const desiredY = Math.max(72, cardTop * 0.45);        // 移到卡片上方區域、偏上一點
        programmaticMove = true;
        map.panBy([0, target.y - desiredY], { animate: true, duration: 0.35 });
    });
}

// 迷你卡/聚光燈任一開啟時，FAB 與定位鈕讓位（換一個/關閉就在卡上）
function updateCardOpenState() {
    const spotlight = document.getElementById('mapSpotlight');
    const minicard = document.getElementById('mapMiniCard');
    const anyOpen = (spotlight && !spotlight.hidden) || (minicard && !minicard.hidden);
    document.getElementById('mapRoot').classList.toggle('is-card-open', anyOpen);
}

function showMiniCard(pin) {
    closeSpotlight();
    const card = document.getElementById('mapMiniCard');
    const body = document.getElementById('miniCardBody');
    if (!card || !body) return;
    // flyTo 類路徑（清單/搜尋/深連結/骰子）會自行把 pin 帶到視野中央，別再補平移；
    // 直接點 pin（無 programmaticMove）才做「上移露出卡片上方」的校正。
    const skipRecenter = programmaticMove;
    setSelectedRing(pin.lat, pin.lng);
    setSelectedPin(pin);

    const hours = expandHours(pin.h);
    const opening = hours ? getOpeningStatus(hours) : null;
    const dist = distanceLabel(pin.lat, pin.lng);
    const tags = filterGeneralTags(pin.tg || []);

    const detailLines = dealDetailLines({ hm: pin.hm, mc: pin.mc, offers: pin.of, bookable: pin.b });

    const isStar = starPin && pin.id === starPin.id;
    body.innerHTML = `
        ${pin.img ? `<img class="map-minicard__img" src="${escapeHtml(pin.img)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">` : ''}
        <div class="map-minicard__info">
            <div class="map-minicard__badges">
                ${isStar ? '<span class="map-badge map-badge--star">🌟 今日之星</span>' : ''}${pin.sp ? '<span class="map-badge map-badge--sponsored">精選推薦</span>' : ''}${dealBadgesHtml(pin)}
            </div>
            <h3 class="map-minicard__name">${pin.url
                ? `<a href="${escapeHtml(pin.url)}" data-liff-internal target="_blank" rel="noopener">${escapeHtml(pin.n)}<span class="map-minicard__more"> ›</span></a>`
                : escapeHtml(pin.n)}</h3>
            <p class="map-minicard__meta">
                ${pin.r ? `⭐ ${formatRating(pin.r)}　` : ''}${escapeHtml(pin.d || '')}${dist ? `　·　${dist}` : ''}${pin.bud ? `　·　💰 ${escapeHtml(pin.bud)}` : ''}
            </p>
            ${opening && opening.label ? `<p class="map-minicard__meta ${opening.openNow ? 'is-open' : ''} ${opening.status === 'closed-today' ? 'is-closed' : ''}">${escapeHtml(opening.label)}</p>` : ''}
            ${tags.length ? `<p class="map-minicard__tags">${tags.map(t => `<span class="map-tag">${escapeHtml(t)}</span>`).join('')}</p>` : ''}
            ${detailLines.length ? `<ul class="map-minicard__offers">${detailLines.map(l => `<li>${l}</li>`).join('')}</ul>` : ''}
            ${isStar ? '<p class="map-minicard__star-note">每天換一間，明天就不是它了</p>' : ''}
            <div class="map-minicard__parking" id="miniCardParking" hidden></div>
            <div class="map-minicard__actions">
                ${pin.url ? `<a class="map-btn map-btn--primary" data-track="booking" href="${escapeHtml(pin.url)}" target="_blank" rel="noopener">${pin.b ? '立即訂位' : '看餐廳頁'}</a>` : ''}
                <a class="map-btn map-btn--ghost map-btn--icon" data-track="navigation" href="${navigationUrl(pin.lat, pin.lng, pin.n)}" target="_blank" rel="noopener" aria-label="導航">🧭</a>
                <button type="button" class="map-btn map-btn--ghost map-btn--icon map-btn--fav ${isFav(pin.id) ? 'is-fav' : ''}" data-fav aria-pressed="${isFav(pin.id)}" aria-label="收藏">${isFav(pin.id) ? '❤️' : '🤍'}</button>
                <button type="button" class="map-btn map-btn--ghost map-btn--icon" data-share aria-label="分享給 LINE 好友">↗</button>
            </div>
        </div>
    `;

    body.querySelectorAll('a[data-track]').forEach(a => {
        a.addEventListener('click', () => {
            track(a.dataset.track === 'booking' ? 'map_booking_click' : 'map_navigation_click',
                { or_id: pin.id, name: pin.n, tier: pin.t, source: 'minicard' });
        });
    });

    const favBtn = body.querySelector('[data-fav]');
    if (favBtn) favBtn.addEventListener('click', () => {
        const nowFav = toggleFav(pin.id);
        favBtn.classList.toggle('is-fav', nowFav);
        favBtn.setAttribute('aria-pressed', String(nowFav));
        favBtn.textContent = nowFav ? '❤️' : '🤍';
        showPillMessage(nowFav ? '已加入收藏 ❤️' : '已移除收藏', 1800);
        afterFavChange();
    });
    const shareBtn = body.querySelector('[data-share]');
    if (shareBtn) shareBtn.addEventListener('click', () => shareRestaurant(pin));

    card.hidden = false;
    updateCardOpenState();
    if (!skipRecenter) panPinAboveCard(pin.lat, pin.lng); // 直接點 pin 時把它移到卡片上方
    fillParking(pin); // 非同步補「附近停車」一行，不擋卡片顯示
}

function closeMiniCard() {
    const card = document.getElementById('mapMiniCard');
    if (card) card.hidden = true;
    if (parkingAbort) parkingAbort.abort(); // 取消進行中的停車查詢
    clearSelectedRing();
    clearSelectedPin();
    updateCardOpenState();
}

// ---- 停車圖層（🅿️ 停車 chip：一鍵在地圖上看可視範圍內所有停車場）----
const MIN_PARK_ZOOM = 15; // 街區層級才顯示，避免整個台北的停車場蓋滿畫面

// 無即時感測器的場 → 不用灰色「即時不明」，改成中性藍「size」+ 顯示總車位「共 N 格」（一定知道，實用）。
function parkAvailClass(a, total) {
    if (a == null) return (total > 0) ? 'size' : 'unknown';
    if (a <= 0) return 'full';
    return a < 15 ? 'low' : 'ok';
}
function parkAvailText(a, total) {
    if (a == null) return (total > 0) ? `共 ${total} 格` : '車位即時不明';
    if (a <= 0) return '目前額滿';
    return `剩 ${a} 位`;
}

function toggleParkingLayer() {
    parkOn = !parkOn;
    const chip = document.getElementById('chipParking');
    if (chip) { chip.classList.toggle('is-active', parkOn); chip.setAttribute('aria-pressed', String(parkOn)); }
    track('map_parking_layer', { on: parkOn });
    if (parkOn) {
        refreshParkingLayer();
        map.on('moveend', scheduleParkingRefresh);
        map.on('zoomend', scheduleParkingRefresh);
    } else {
        map.off('moveend', scheduleParkingRefresh);
        map.off('zoomend', scheduleParkingRefresh);
        if (parkAbort) parkAbort.abort();
        setParkingChipLoading(false);
        if (parkLayer) { map.removeLayer(parkLayer); parkLayer = null; }
    }
}

function scheduleParkingRefresh() {
    if (parkDebounce) clearTimeout(parkDebounce);
    parkDebounce = setTimeout(refreshParkingLayer, 350); // 拖動停下才抓，不每幀打
}

// 停車 chip 讀取中狀態：第一次抓車位要等後端，沒有回饋用戶會以為 chip 壞了 → 轉圈動畫
function setParkingChipLoading(on) {
    const chip = document.getElementById('chipParking');
    if (chip) chip.classList.toggle('is-loading', on);
}

async function refreshParkingLayer() {
    if (!parkOn || !map) return;
    if (map.getZoom() < MIN_PARK_ZOOM) {
        if (parkLayer) { map.removeLayer(parkLayer); parkLayer = null; }
        showPillMessage('放大一點看停車場 🅿️', 2000);
        return;
    }
    if (parkAbort) parkAbort.abort();
    parkAbort = new AbortController();
    const thisAbort = parkAbort;
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => v.toFixed(5)).join(',');
    const apiBase = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? 'http://localhost:3000/api' : '/api';
    let lots;
    setParkingChipLoading(true);
    try {
        const res = await withTimeout(fetch(`${apiBase}/parking/nearby?bbox=${bbox}`, { signal: thisAbort.signal }), 10000, '停車圖層');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '停車服務異常');
        lots = data.lots || [];
    } catch (err) {
        if (err && err.name === 'AbortError') return; // 被新的抓取取代：讓新的那次負責關 loading
        return; // 靜默：圖層抓不到不干擾地圖
    } finally {
        // 只有「還是自己這次抓取」才關 loading：被 abort 換掉時交給接手的那次，避免提前熄燈
        if (parkAbort === thisAbort) setParkingChipLoading(false);
    }
    if (!parkOn) return; // 抓的途中被關掉
    renderParkingMarkers(window.L, lots);
}

function renderParkingMarkers(L, lots) {
    if (parkLayer) { map.removeLayer(parkLayer); parkLayer = null; }
    parkLayer = L.layerGroup();
    for (const lot of lots) {
        const cls = parkAvailClass(lot.available, lot.total);
        const m = L.marker([lot.lat, lot.lng], {
            icon: L.divIcon({
                className: 'map-park-wrap',
                html: `<div class="map-park-pin map-park-pin--${cls}">P</div>`,
                iconSize: [22, 22],
                iconAnchor: [11, 11],
            }),
            zIndexOffset: 300,
        });
        const avail = parkAvailText(lot.available, lot.total);
        m.bindPopup(
            `<div class="map-park-popup"><strong>${escapeHtml(lot.name)}</strong>`
            + `<span class="map-park-popup__avail map-park-popup__avail--${cls}">${avail}</span>`
            + `<a href="${navigationUrl(lot.lat, lot.lng, lot.name)}" target="_blank" rel="noopener">導航 ›</a></div>`,
            { closeButton: false, offset: [0, -4] }
        );
        m.on('click', () => track('map_parking_layer_pin', { lot: lot.name, available: lot.available }));
        parkLayer.addLayer(m);
    }
    map.addLayer(parkLayer);
}

// ---- 附近停車（第一刀：餐廳卡「附近停車」一行）----
// 開車族的決策點：正在看這間店時，直接告訴他「最近停車場・步行幾分・剩幾位」。
let parkingAbort = null;

async function fillParking(pin, elId = 'miniCardParking') {
    const el = document.getElementById(elId);
    if (!el) return;
    if (parkingAbort) parkingAbort.abort();
    parkingAbort = new AbortController();
    const signal = parkingAbort.signal;
    el.hidden = false;
    // 停車資訊目前只涵蓋台北市：非台北市的店直接不顯示這行（誠實不清單噪音）
    const inTaipei = /台北市/.test(pin.d || '');
    const ver = (typeof window !== 'undefined' && window.__V) ? window.__V : '?';
    el.innerHTML = `<span class="map-parking__loading">🅿️ 查附近停車…</span>`;
    const parkMsg = (t) => { el.innerHTML = `<span class="map-parking__icon" aria-hidden="true">🅿️</span><span class="map-parking__text map-parking__loading">${escapeHtml(t)}</span>`; };
    // 停車查詢「就地」fetch，不 import api.js（靜態會拖垮 map.js、動態在 webview 會卡）。
    const apiBase = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? 'http://localhost:3000/api' : '/api';
    const base = `${apiBase}/parking/nearby?lat=${pin.lat}&lng=${pin.lng}`;

    // 沒有即時感測器的場（台北約 1/3）→ 不顯示無用的「即時不明」，改給「一定知道」的總車位「共 N 格」。
    const availHtml = (a, total) => {
        if (a == null) {
            return total > 0
                ? `<span class="map-parking__avail map-parking__avail--size">共 ${total} 格</span>`
                : '<span class="map-parking__avail map-parking__avail--unknown">車位即時不明</span>';
        }
        if (a <= 0) return '<span class="map-parking__avail map-parking__avail--full">目前額滿</span>';
        const level = a < 15 ? 'low' : 'ok';
        return `<span class="map-parking__avail map-parking__avail--${level}">剩 ${a} 位</span>`;
    };
    const renderRow = (lot, availInner) => {
        el.innerHTML =
            '<span class="map-parking__icon" aria-hidden="true">🅿️</span>' +
            `<span class="map-parking__text">${escapeHtml(lot.name)}・步行 ${lot.walkMin} 分・${availInner}</span>` +
            `<a class="map-parking__nav" href="${navigationUrl(lot.lat, lot.lng, lot.name)}" target="_blank" rel="noopener" data-park-nav>導航</a>`;
        const nav = el.querySelector('[data-park-nav]');
        if (nav) nav.addEventListener('click', () => track('map_parking_nav_click', { or_id: pin.id, lot: lot.name }));
    };
    const failMsg = (err) => {
        if (err && err.name === 'AbortError') return; // 換卡/關卡：靜默
        const msg = (err && err.message) || '';
        const reason = err && err.status ? `HTTP ${err.status}` : (msg ? msg.slice(0, 20) : '未知');
        if (inTaipei) parkMsg(`停車暫時無法取得（${reason}·${ver}）`); else el.hidden = true;
    };

    // ── 第一階段（快）：只用預烤座標算最近場，不抓即時空位 → 秒顯示「場名・步行N分」 ──
    let lot;
    try {
        const res = await withTimeout(fetch(base + '&fast=1', { signal }), 8000, '查詢');
        if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '停車服務異常');
        const lots = data.lots || [];
        if (!lots.length) { if (inTaipei) parkMsg('附近查無停車場'); else el.hidden = true; return; }
        lot = lots[0]; // 最近的一顆
        renderRow(lot, '<span class="map-parking__avail map-parking__avail--unknown">空位查詢中…</span>');
    } catch (err) { failMsg(err); return; }

    // ── 第二階段：抓即時空位，補上「剩 N 位」。失敗就維持「即時不明」 ──
    // 很多路邊/私人停車場沒感測器（available=null）→ 若只認「最近那顆」常常變「即時不明」。
    // 改成優先挑「附近有即時車位數的最近場」，整片都沒感測器才退回最近場顯示「即時不明」。
    try {
        const res2 = await withTimeout(fetch(base, { signal }), 12000, '空位');
        if (!res2.ok) throw new Error('HTTP ' + res2.status);
        const data2 = await res2.json();
        if (data2.success) {
            const lots2 = data2.lots || [];
            const best = lots2.find(l => l.available != null)   // 最近的「有即時車位數」場
                || lots2.find(l => l.name === lot.name)          // 都沒有→維持第一階段那顆
                || lots2[0] || lot;
            renderRow(best, availHtml(best.available, best.total));
            track('map_parking_shown', { or_id: pin.id, lot: best.name, available: best.available });
        }
    } catch (err) {
        if (err && err.name === 'AbortError') return; // 換卡：別覆寫新卡內容
        renderRow(lot, availHtml(null, lot.total)); // 空位拿不到 → 至少顯示「共 N 格」，場名/步行已在
    }
}

// ---- 聚光燈：幫我決定 ----

function nextSponsoredPick() {
    if (!sponsoredRestaurants.length) return null;
    let idx = 0;
    try {
        idx = parseInt(localStorage.getItem(SPO_ROTATION_KEY) || '0', 10) || 0;
    } catch (e) { /* private mode：退化為固定第一家 */ }
    // 跳過本輪已抽過的店（避免「換一個」又換到同一家），全被抽過則放棄保底
    let pick = null;
    let steps = 0;
    for (; steps < sponsoredRestaurants.length; steps++) {
        const candidate = sponsoredRestaurants[(idx + steps) % sponsoredRestaurants.length];
        if (!spotlightExcludes.includes(candidate.name)) {
            pick = candidate;
            break;
        }
    }
    if (pick) {
        try {
            localStorage.setItem(SPO_ROTATION_KEY, String((idx + steps + 1) % sponsoredRestaurants.length));
        } catch (e) { /* ignore */ }
    }
    return pick;
}

function buildDecideFormData() {
    const formData = { limit: 1 };
    if (userLocation) {
        formData.userLocation = userLocation;
        formData.maxDistance = 5.0; // 交通方式不限 = 5km（沿用首頁規則）
    }
    if (activeFilters.budget) {
        formData.budget = activeFilters.budget; // 尊重使用者設定的預算篩選
    }
    // 無定位：不帶位置參數，後端在北北基白名單內隨機推薦
    return formData;
}

// pin（精簡格式）→ renderSpotlight 吃的餐廳物件格式
function pinToRestaurant(pin) {
    return {
        or_id: pin.id,
        name: pin.n,
        coordinates: { lat: pin.lat, lng: pin.lng },
        rating: pin.r,
        district: pin.d,
        budget: pin.bud,
        opening_hours: expandHours(pin.h),
        cuisine_style: pin.tg || [],
        type: [],
        booking_offers: pin.of || [],
        door_photo_url: pin.img,
        url: pin.url,
        bookable: pin.b,
        _tier: pin.t,
        _hm: pin.hm, _ho: pin.ho, _mc: pin.mc, _sp: pin.sp,
    };
}

// 「幫我決定」候選池 = 使用者眼前的世界：畫面內 + 通過目前篩選 + 今天有開
function viewportCandidates() {
    if (!map) return [];
    const bounds = map.getBounds();
    const now = new Date();
    return allPins.filter(pin => {
        if (!pinPassesFilters(pin, now)) return false;
        if (!bounds.contains([pin.lat, pin.lng])) return false;
        if (spotlightExcludes.includes(pin.n)) return false;
        // 今日休息的店不推（'opens-later' 稍後開門仍可推薦；沒有時間資料不懲罰）
        const hours = expandHours(pin.h);
        if (hours && getOpeningStatus(hours, now).status === 'closed-today') return false;
        return true;
    });
}

// 輪盤動畫：🎯 在候選店之間跳動、店名快速輪替、逐步減速 → 落在贏家
// （隨機感的儀式：讓「抽」被看見，而不是畫面直接跳答案）
async function rouletteReveal(decoyPins, body, isCancelled) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!decoyPins.length) return;
    const delays = [80, 90, 100, 120, 150, 190, 240, 300];
    const steps = Math.min(decoyPins.length, delays.length);
    for (let i = 0; i < steps; i++) {
        if (isCancelled && isCancelled()) return; // 使用者中途關閉 → 停止跳動
        const p = decoyPins[i];
        setSpotlightPin(p.lat, p.lng);
        body.innerHTML = `<p class="map-spotlight__loading map-spotlight__roulette">🎲 ${escapeHtml(p.n)}</p>`;
        await new Promise(r => setTimeout(r, delays[i]));
    }
}

// 從畫面內抽 n 個過場候選（排除贏家本人）
function sampleDecoys(winnerName, n) {
    if (!map) return [];
    const bounds = map.getBounds();
    const pool = allPins.filter(p => p.n !== winnerName && bounds.contains([p.lat, p.lng]));
    // Fisher–Yates 部分洗牌取前 n 個
    for (let i = pool.length - 1; i > Math.max(0, pool.length - n - 1); i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(-n).reverse();
}

async function drawSpotlight() {
    if (decideInProgress) return;
    decideInProgress = true;

    const panel = document.getElementById('mapSpotlight');
    const body = document.getElementById('spotlightBody');
    const links = document.getElementById('spotlightActionLinks');
    closeMiniCard();
    clearSpotlightPin(); // 清掉上一抽的 🎯，避免載入/失敗時殘留指向舊店
    panel.hidden = false;
    panel.classList.remove('is-daikichi');
    updateCardOpenState();

    // 額度用完：鎖老虎機、不鎖工具（清單/搜尋/迷你卡照常）
    if (diceRemaining() <= 0) {
        const streakDays = getStreak().days;
        body.innerHTML = `<p class="map-spotlight__loading">🎲 今日 ${diceQuota()} 次手氣用完啦！<br>
            明天 0 點自動補滿${streakDays < STREAK_BONUS_DAYS ? '，連續來 3 天、每天多送 2 次 🔥' : ''}</p>`;
        links.innerHTML = '<button type="button" class="map-btn map-btn--primary" id="quotaBrowseBtn">先看看附近有哪些優惠</button>';
        document.getElementById('quotaBrowseBtn').addEventListener('click', () => {
            closeSpotlight();
            setSheetOpen(true);
        });
        track('map_dice_quota_exhausted', { quota: diceQuota() });
        decideInProgress = false;
        return;
    }

    body.innerHTML = '<p class="map-spotlight__loading">🎲 骰子轉動中…</p>';
    links.innerHTML = '';

    // 取消守衛：使用者可能在輪盤/請求進行中按 ✕，之後不得再渲染、飛鏡頭或留 🎯
    const cancelled = () => panel.hidden;

    try {
        let restaurant = null;
        let isSponsoredPick = false;

        // 每第 N 次成功展示：贊助店保底曝光（輪替、跳過已抽過的），維持廣告庫存價值
        if ((decideCount + 1) % SPONSOR_EVERY === 0) {
            restaurant = nextSponsoredPick();
            isSponsoredPick = !!restaurant;
        }

        // 主要路徑：從使用者眼前的地圖抽（畫面內 + 通過篩選 + 今天有開），
        // 抽選結果與「畫面內 N 間」的心智模型一致。
        // 「現在有開」的優先：中午抽選不該落在 17:00 才開的店（有開的沒了才退而求其次）
        if (!restaurant) {
            const candidates = viewportCandidates();
            if (candidates.length) {
                const now = new Date();
                const openNow = candidates.filter(p => {
                    const h = expandHours(p.h);
                    return h && getOpeningStatus(h, now).openNow;
                });
                const pool = openNow.length ? openNow : candidates;
                const pick = pool[Math.floor(Math.random() * pool.length)];
                restaurant = pinToRestaurant(pick);
            }
        }

        // 後備路徑：畫面內沒有合適的店 → 用推薦 API 在附近 5km / 北北基抽
        if (!restaurant) {
            let results = await fetchRecommendations(buildDecideFormData(), spotlightExcludes, 1);
            if (cancelled()) return;
            if (!results.length) {
                spotlightExcludes = []; // 全抽過了 → 重置排除清單再抽一次
                results = await fetchRecommendations(buildDecideFormData(), [], 1);
                if (cancelled()) return;
            }
            restaurant = results[0] || null;
            // API 不會過濾今日休息：抽到就換一次（只換一次，避免迴圈）
            if (restaurant && getOpeningStatus(restaurant.opening_hours).status === 'closed-today') {
                spotlightExcludes.push(restaurant.name);
                const retry = await fetchRecommendations(buildDecideFormData(), spotlightExcludes, 1);
                if (cancelled()) return;
                if (retry[0]) restaurant = retry[0];
            }
        }

        if (!restaurant) {
            body.innerHTML = '<p class="map-spotlight__loading">這一帶沒有符合的店，滑動地圖或放寬篩選再擲</p>';
            return;
        }

        decideCount++; // 只計成功展示的抽數，網路失敗不消耗贊助保底節奏
        consumeDice(1);
        spotlightExcludes.push(restaurant.name);
        await rouletteReveal(sampleDecoys(restaurant.name, 7), body, cancelled);
        if (cancelled()) {
            // 中途取消：退籌碼、清 🎯，本抽不算數（名字也退出排除清單）
            consumeDice(-1);
            clearSpotlightPin();
            spotlightExcludes.pop();
            decideCount--;
            return;
        }

        // ✨ 大吉時刻（變動獎勵）：金色特效 + 奉還 1 次抽選
        const isDaikichi = Math.random() < DAIKICHI_RATE;
        renderSpotlight(restaurant, isSponsoredPick, isDaikichi);
        if (isDaikichi) {
            panel.classList.add('is-daikichi');
            consumeDice(-1);
            showPillMessage('✨ 大吉！這把不算，送你再抽一次', 4000);
            track('map_daikichi', { or_id: restaurant.or_id, draw_count: decideCount });
        }
        track('map_decide_result', {
            or_id: restaurant.or_id, name: restaurant.name,
            sponsored: isSponsoredPick, daikichi: isDaikichi, draw_count: decideCount,
        });
    } catch (err) {
        console.error('幫我決定失敗:', err);
        body.innerHTML = '<p class="map-spotlight__loading">哎呀，骰子卡住了，再擲一次！</p>';
    } finally {
        decideInProgress = false;
    }
}

function renderSpotlight(r, isSponsoredPick, isDaikichi = false) {
    const body = document.getElementById('spotlightBody');
    const links = document.getElementById('spotlightActionLinks');
    const coords = r.coordinates || {};
    const hasCoords = coords.lat != null && coords.lng != null;

    // 聚光燈效果：鏡頭飛過去 + 其他 pin 淡出 + 專屬大頭針
    // 卡片蓋住下半屏，鏡頭中心往下偏移，讓 🎯 落在可見的上半部（短屏也不被卡片吃掉）
    if (hasCoords && map) {
        setSpotlightPin(coords.lat, coords.lng);
        const cardHeight = Math.min(window.innerHeight * 0.45, 420);
        const target = map.project([coords.lat, coords.lng], SPOTLIGHT_ZOOM)
            .add([0, cardHeight / 2]);
        programmaticMove = true;
        map.flyTo(map.unproject(target, SPOTLIGHT_ZOOM), SPOTLIGHT_ZOOM, { duration: 0.9 });
    } else {
        clearSpotlightPin(); // 沒座標的店：不留上一抽的 🎯 與淡出狀態
    }

    const dist = hasCoords ? distanceLabel(coords.lat, coords.lng) : '';
    const distanceKm = (hasCoords && userLocation)
        ? calculateDistance(userLocation.lat, userLocation.lng, coords.lat, coords.lng)
        : null;
    const evidence = generateEvidence(r, distanceKm != null ? { distance: distanceKm } : {});
    const opening = getOpeningStatus(r.opening_hours);
    const tags = [...new Set(filterGeneralTags([...(r.cuisine_style || []), ...(r.type || [])]))].slice(0, 3);
    const offers = r.booking_offers || [];
    const heroImage = r.door_photo_url || (r.images && r.images[0]) || '';
    const pin = allPins.find(p => p.id === r.or_id);
    // 優惠旗標：相容 API 完整記錄與 pin 精簡格式
    const hm = r._hm || r.has_booking_menu || (r.booking_menus && r.booking_menus.length) || (pin && pin.hm);
    const ho = r._ho || r.has_booking_offer || offers.length || (pin && pin.ho);
    const mc = r._mc || r.booking_menu_count || (pin && pin.mc);
    const bookable = (r.bookable != null ? r.bookable : (pin && pin.b));
    let dealBadges = '';
    if (hm) dealBadges += '<span class="map-badge map-badge--menu">套餐優惠</span>';
    if (ho) dealBadges += '<span class="map-badge map-badge--offer">訂位優惠</span>';
    if (bookable) dealBadges += '<span class="map-badge map-badge--cashback">出席回饋 $3/人</span>'; // 基本盤，與加碼優惠並存
    const detailLines = dealDetailLines({ hm, mc, offers, bookable });

    body.innerHTML = `
        ${heroImage ? `<img class="map-spotlight__img" src="${escapeHtml(heroImage)}" alt="" decoding="async" onerror="this.style.display='none'">` : ''}
        <div class="map-spotlight__info">
            <div class="map-minicard__badges">
                ${isDaikichi ? '<span class="map-badge map-badge--daikichi">✨ 大吉</span>' : ''}
                ${isSponsoredPick ? '<span class="map-badge map-badge--sponsored">精選推薦</span>' : ''}${dealBadges}
            </div>
            ${evidence && evidence.length ? `<p class="map-spotlight__evidence">${escapeHtml(Array.isArray(evidence) ? evidence[0] : evidence)}</p>` : ''}
            <h3 class="map-spotlight__name">${r.url
                ? `<a href="${escapeHtml(r.url)}" data-liff-internal target="_blank" rel="noopener">${escapeHtml(r.name)}<span class="map-minicard__more"> ›</span></a>`
                : escapeHtml(r.name)}</h3>
            <p class="map-minicard__meta">
                ${r.rating ? `⭐ ${formatRating(r.rating)}　` : ''}${escapeHtml(r.district || '')}${dist ? `　·　${dist}` : ''}${r.budget ? `　·　💰 ${escapeHtml(r.budget)}` : ''}
            </p>
            ${opening.label ? `<p class="map-minicard__meta ${opening.openNow ? 'is-open' : ''} ${opening.status === 'closed-today' ? 'is-closed' : ''}">${escapeHtml(opening.label)}</p>` : ''}
            ${tags.length ? `<p class="map-minicard__tags">${tags.map(t => `<span class="map-tag">${escapeHtml(t)}</span>`).join('')}</p>` : ''}
            ${detailLines.length ? `<ul class="map-minicard__offers">${detailLines.map(l => `<li>${l}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="map-spotlight__parking map-minicard__parking" id="spotlightParking" hidden></div>
    `;

    // 「幫我決定」的卡也要有停車資訊（與餐廳小卡一致）。有 pin 用 pin（已含 d/座標），否則用 r 組出來。
    const parkSrc = (pin && pin.lat != null) ? pin
        : (hasCoords ? { id: r.or_id, lat: coords.lat, lng: coords.lng, d: [r.city, r.district].filter(Boolean).join('·') } : null);
    if (parkSrc && parkSrc.lat != null) fillParking(parkSrc, 'spotlightParking');

    links.innerHTML = `
        ${r.url ? `<a class="map-btn map-btn--primary" data-track="booking" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${r.bookable ? '立即訂位' : '看餐廳頁'}</a>` : ''}
        ${hasCoords ? `<a class="map-btn map-btn--ghost" data-track="navigation" href="${navigationUrl(coords.lat, coords.lng, r.name)}" target="_blank" rel="noopener">🧭 導航</a>` : ''}
    `;
    links.querySelectorAll('a[data-track]').forEach(a => {
        a.addEventListener('click', () => {
            track(a.dataset.track === 'booking' ? 'map_booking_click' : 'map_navigation_click',
                { or_id: r.or_id, name: r.name, sponsored: isSponsoredPick, source: 'spotlight' });
        });
    });
}

function setSpotlightPin(lat, lng) {
    const L = window.L;
    clearSpotlightPin();
    spotlightMarker = L.marker([lat, lng], {
        icon: L.divIcon({
            className: 'map-spotlight-pin',
            html: '<div class="map-spotlight-pin__dot">🎯</div>',
            iconSize: [44, 44],
            iconAnchor: [22, 22],
        }),
        zIndexOffset: 1000,
    }).addTo(map);
    document.getElementById('liffMap').classList.add('is-spotlight');
}

function clearSpotlightPin() {
    if (spotlightMarker && map) {
        map.removeLayer(spotlightMarker);
        spotlightMarker = null;
    }
    const el = document.getElementById('liffMap');
    if (el) el.classList.remove('is-spotlight');
}

function closeSpotlight() {
    const panel = document.getElementById('mapSpotlight');
    if (panel) panel.hidden = true;
    clearSpotlightPin();
    updateCardOpenState();
}

// ---- 定位 ----

function locateUser({ silent = false } = {}) {
    return new Promise(resolve => {
        if (!navigator.geolocation) {
            if (!silent) showPillMessage('這台裝置不支援定位，直接滑地圖逛吧');
            resolve(false);
            return;
        }
        navigator.geolocation.getCurrentPosition(
            pos => {
                userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                showUserMarker();
                // zoom 16：店名標籤開啟、cluster 部分散開，落地即可掃視
                if (map) map.flyTo([userLocation.lat, userLocation.lng], 16, { duration: 0.8 });
                track('map_locate', { success: true });
                resolve(true);
            },
            err => {
                console.warn('定位失敗:', err && err.message);
                track('map_locate', { success: false, code: err && err.code });
                if (!silent) {
                    // 定位被拒是最大流失點：不用 alert 擋路，地圖照樣能逛
                    showPillMessage(err && err.code === 1
                        ? '定位被封鎖了，可到 LINE/系統設定開啟，或直接滑地圖逛'
                        : '拿不到定位，滑動地圖逛逛，或用 🎲 手氣決定', 5000);
                }
                resolve(false);
            },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
        );
    });
}

// 進場即請求定位（Owner 決策 2026-07-06：好康地圖以「你附近」為核心，
// 開門見山要位置；拒絕也不擋路，地圖照樣能逛、能搜尋、能抽）

function showUserMarker() {
    const L = window.L;
    if (!map || !userLocation) return;
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([userLocation.lat, userLocation.lng], {
        icon: L.divIcon({
            className: 'map-user-pin',
            html: '<div class="map-user-pin__dot"></div>',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
        }),
        interactive: false,
        zIndexOffset: 900,
    }).addTo(map);
}

// ---- 搜尋（像 Google Maps：輸入地區/捷運站/餐廳 → 跳轉） ----

// 品類 substring 命中：query「火鍋」→ {set: 火鍋店/麻辣鍋/火鍋吃到飽…的索引, count: 聯集店數}
function catHitForQuery(q) {
    const set = new Set();
    allCats.forEach((c, i) => { if (c.toLowerCase().includes(q)) set.add(i); });
    if (!set.size) return null;
    let count = 0;
    for (const pin of allPins) {
        if ((pin.ct || []).some(i => set.has(i))) count++;
    }
    return count ? { set, count } : null;
}

function searchMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // 品類（Google 式：搜「火鍋」「吃到飽」→ 一列彙總，選了就是地圖篩選）
    const catHit = catHitForQuery(q);
    const catRows = catHit
        ? [{ kind: 'category', name: query.trim(), sub: `${catHit.count} 間餐廳`, set: catHit.set }]
        : [];
    const placeHits = allPlaces
        .filter(p => p.n.toLowerCase().includes(q))
        .slice(0, 4)
        .map(p => ({ kind: p.t, name: p.n, sub: p.t === 'district' ? p.d : `${p.c} 間餐廳`, lat: p.lat, lng: p.lng }));
    const pinHits = allPins
        .filter(p => p.n.toLowerCase().includes(q))
        .slice(0, Math.max(3, 8 - placeHits.length - catRows.length))
        .map(p => ({ kind: 'restaurant', name: p.n, sub: p.d, pin: p }));
    // 無優惠店（最多 2 筆、排最後）：搜得到 → 點開卡片看見「有優惠店」的對照
    const extHits = extPois
        .filter(p => p.n.toLowerCase().includes(q))
        .slice(0, 2)
        .map(p => ({ kind: 'ext', name: p.n, sub: `${p.d || ''}·暫無優惠`, poi: p }));
    return [...catRows, ...placeHits, ...pinHits, ...extHits];
}

const SEARCH_ICON = { category: '🍴', district: '🏙️', landmark: '📍', restaurant: '🍽️', recent: '🕘', ext: '⚪' };

// ---- 最近搜尋（Google 式：聚焦空白搜尋框時出現）----
const RECENT_KEY = 'rr_map_recent';
function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 5); } catch (e) { return []; }
}
function pushRecent(q) {
    try {
        const list = [q, ...getRecent().filter(x => x !== q)].slice(0, 5);
        localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch (e) { /* ignore */ }
}

// 套用/清除品類篩選（搜尋與快捷 chips 共用；chips 依 label 同步 active 態）
function setCatFilter(label, set) {
    catFilter = set && set.size ? { label, set } : null;
    document.querySelectorAll('.map-chip--cat').forEach(chip => {
        chip.classList.toggle('is-active', !!catFilter && chip.dataset.cat === catFilter.label);
        chip.setAttribute('aria-pressed', String(!!catFilter && chip.dataset.cat === catFilter.label));
    });
    applyFilters();
}

function renderSearchResults(matches, query = '') {
    const list = document.getElementById('mapSearchResults');
    if (!matches.length) {
        // 有輸入但沒結果 → 給回饋而不是無聲消失
        if (query.trim()) {
            list.innerHTML = `<li class="map-search__empty">找不到「${escapeHtml(query.trim())}」，試試地區或捷運站名</li>`;
            list.hidden = false;
        } else {
            list.hidden = true;
            list.innerHTML = '';
        }
        return;
    }
    list.innerHTML = matches.map((m, i) => `
        <li><button type="button" class="map-search__item" data-idx="${i}">
            <span aria-hidden="true">${SEARCH_ICON[m.kind]}</span>
            <span class="map-search__item-name">${escapeHtml(m.name)}</span>
            <span class="map-search__item-sub">${escapeHtml(m.sub || '')}</span>
        </button></li>`).join('');
    list.hidden = false;
    list.querySelectorAll('.map-search__item').forEach(btn => {
        btn.addEventListener('click', () => selectSearchResult(matches[Number(btn.dataset.idx)]));
    });
}

function closeSearch({ clear = false } = {}) {
    const input = document.getElementById('mapSearchInput');
    const list = document.getElementById('mapSearchResults');
    if (clear && input) {
        input.value = '';
        document.getElementById('mapSearchClear').hidden = true;
        if (catFilter) setCatFilter(null, null); // 清搜尋 = 一併解除品類篩選
        clearSearchFocus(); // 移除搜尋落點 pin 與排序錨
    }
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (input) input.blur();
}

// 搜尋落點（Google 式）：地點選中後放一支 pin + 清單以此為錨排序
function setSearchFocus(name, lat, lng) {
    clearSearchFocus();
    searchFocus = { name, lat, lng };
    const L = window.L;
    if (!L || !map) return;
    const base = new URL('../vendor/leaflet/images/', import.meta.url);
    searchMarker = L.marker([lat, lng], {
        icon: L.icon({
            iconUrl: new URL('marker-icon.png', base).href,
            iconRetinaUrl: new URL('marker-icon-2x.png', base).href,
            shadowUrl: new URL('marker-shadow.png', base).href,
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            tooltipAnchor: [8, -30],
        }),
        zIndexOffset: 900,
        interactive: false,
    }).addTo(map);
    searchMarker.bindTooltip(name, {
        permanent: true,
        direction: 'right',
        className: 'map-pin-label map-pin-label--search',
    }).openTooltip();
}

function clearSearchFocus() {
    searchFocus = null;
    if (searchMarker && map) {
        map.removeLayer(searchMarker);
        searchMarker = null;
    }
    if (sheetOpen) renderSheetList();
}

function selectSearchResult(m) {
    track('map_search_select', { kind: m.kind, name: m.name });
    if (m.kind === 'recent') { // 最近搜尋：回填文字重新搜
        const input = document.getElementById('mapSearchInput');
        input.value = m.name;
        document.getElementById('mapSearchClear').hidden = false;
        renderSearchResults(searchMatches(m.name), m.name);
        return;
    }
    pushRecent(m.name);
    closeSearch();
    savedSheetView = null;
    programmaticMove = true;
    if (m.kind === 'category') {
        // 品類 → 地圖篩選（Google 式）：原地篩選、不 fitBounds 到整個北北基（會縮到看不清、體驗差）。
        setCatFilter(m.name, m.set);
        const matchPins = allPins.filter(p => (p.ct || []).some(i => m.set.has(i)));
        const bounds = map.getBounds();
        const inView = matchPins.some(p => bounds.contains([p.lat, p.lng]));
        if (!inView && matchPins.length) {
            // 目前畫面內沒有命中店 → 平移到「離中心最近的一間」，維持街區級 zoom（不整片縮小）
            const c = (userLocation && bounds.contains([userLocation.lat, userLocation.lng])) ? userLocation : map.getCenter();
            let nearest = matchPins[0], best = Infinity;
            for (const p of matchPins) {
                const d = (p.lat - c.lat) ** 2 + (p.lng - c.lng) ** 2;
                if (d < best) { best = d; nearest = p; }
            }
            map.flyTo([nearest.lat, nearest.lng], Math.min(16, Math.max(15, map.getZoom())), { duration: 0.8 });
        }
        // else：畫面內已有命中店 → 停在原地只篩選（跟品類 chip 一致，不跳走）
        // 保留搜尋字在框內（清除 ✕ = 解除篩選）
        const input = document.getElementById('mapSearchInput');
        input.value = m.name;
        document.getElementById('mapSearchClear').hidden = false;
        showPillMessage(`已篩出「${m.name}」相關 ${m.sub}，按 ✕ 解除`, 4000);
    } else if (m.kind === 'restaurant') {
        map.flyTo([m.pin.lat, m.pin.lng], 17, { duration: 0.8 });
        showMiniCard(m.pin);
    } else if (m.kind === 'ext') {
        map.flyTo([m.poi.lat, m.poi.lng], 17, { duration: 0.8 });
        showExtCard(m.poi);
    } else {
        // 地點（行政區/地標）＝ Google 式落點體驗：
        // 放 pin 標記該點 → 飛過去 → 自動彈出「附近有什麼」清單（以落點為錨排序）
        const zoom = m.kind === 'district' ? 15 : 16;
        setSearchFocus(m.name, m.lat, m.lng);
        // 清單即將彈出蓋住下半屏 → 鏡頭中心往南偏，讓落點 pin 停在上半可視區（Google 式）
        const pt = map.project([m.lat, m.lng], zoom);
        pt.y += map.getSize().y * 0.22;
        map.flyTo(map.unproject(pt, zoom), zoom, { duration: 0.8 });
        // 保留搜尋字（✕ = 清除落點與錨）
        const input = document.getElementById('mapSearchInput');
        input.value = m.name;
        document.getElementById('mapSearchClear').hidden = false;
        setTimeout(() => {
            if (searchFocus && !sheetOpen) setSheetOpen(true);
        }, 950); // 等 flyTo 落定再彈清單，不搶鏡頭
    }
}

function wireSearch() {
    const input = document.getElementById('mapSearchInput');
    const clearBtn = document.getElementById('mapSearchClear');
    let debounceTimer = null;

    input.addEventListener('input', () => {
        clearBtn.hidden = !input.value;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const matches = searchMatches(input.value);
            renderSearchResults(matches, input.value);
            if (input.value.trim()) track('map_search', { query: input.value.trim(), hits: matches.length });
        }, 180);
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const first = searchMatches(input.value)[0];
            if (first) selectSearchResult(first);
        } else if (e.key === 'Escape') {
            closeSearch({ clear: true });
        }
    });
    clearBtn.addEventListener('click', () => { closeSearch({ clear: true }); input.focus(); });

    // Google 式：聚焦空白搜尋框 → 顯示最近搜尋
    input.addEventListener('focus', () => {
        if (input.value.trim()) return;
        const recent = getRecent().map(q => ({ kind: 'recent', name: q, sub: '' }));
        if (recent.length) renderSearchResults(recent);
    });
}

// ---- 事件接線 ----

function wireControls() {
    const chipMap = { chipOpen: 'open', chipBookable: 'bookable' }; // 加碼優惠 chip 已移除（Owner 決定）
    for (const [id, key] of Object.entries(chipMap)) {
        const chip = document.getElementById(id);
        chip.addEventListener('click', () => {
            activeFilters[key] = !activeFilters[key];
            chip.classList.toggle('is-active', activeFilters[key]);
            chip.setAttribute('aria-pressed', String(activeFilters[key]));
            track('map_filter_toggle', { filter: key, active: activeFilters[key] });
            applyFilters();
            // 第一次開「只看好康」提示清單入口（不自動展開：使用者此刻想看的是地圖）
            if (key === 'deals' && activeFilters.deals) {
                try {
                    if (!sessionStorage.getItem('rr_map_deals_hint_shown')) {
                        sessionStorage.setItem('rr_map_deals_hint_shown', '1');
                        showPillMessage('👆 上拉底部清單，加碼優惠一次看完', 5000);
                    }
                } catch (e) { /* ignore */ }
            }
        });
    }

    // 收藏篩選 chip：只看我存的店（沒收藏時給引導，不空篩）
    const chipFav = document.getElementById('chipFav');
    chipFav.addEventListener('click', () => {
        if (!activeFilters.favOnly && favCount() === 0) {
            showPillMessage('還沒有收藏～點店家卡片的 🤍 就能存起來', 3500);
            return;
        }
        activeFilters.favOnly = !activeFilters.favOnly;
        track('map_filter_toggle', { filter: 'favOnly', active: activeFilters.favOnly });
        updateFavChip();
        applyFilters();
    });
    updateFavChip();

    // 清單排序切換：綜合 / 距離 / 評分 / 優惠
    document.querySelectorAll('.map-sort-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            if (sheetSort === chip.dataset.sort) return;
            sheetSort = chip.dataset.sort;
            document.querySelectorAll('.map-sort-chip').forEach(c => {
                const on = c === chip;
                c.classList.toggle('is-active', on);
                c.setAttribute('aria-pressed', String(on));
            });
            track('map_sheet_sort', { sort: sheetSort });
            renderSheetList();
        });
    });

    document.getElementById('chipLocate').addEventListener('click', () => locateUser({ silent: false }));

    // 🅿️ 停車圖層開關：一鍵在地圖顯示可視範圍內的停車場（含即時空位）
    const chipParking = document.getElementById('chipParking');
    if (chipParking) chipParking.addEventListener('click', toggleParkingLayer);

    // 深色模式切換（初始 icon 反映目前主題；主題已由 index.html 內聯開機設好 data-theme）
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
        const dark = isDarkTheme();
        themeToggle.textContent = dark ? '☀️' : '🌙';
        themeToggle.setAttribute('aria-pressed', String(dark));
        themeToggle.setAttribute('aria-label', dark ? '切換為淺色外觀' : '切換為深色外觀');
    }

    // 品類快捷 chips（Google Maps 的「餐廳/咖啡」列）：單選切換，與搜尋共用 catFilter
    document.querySelectorAll('.map-chip--cat').forEach(chip => {
        chip.addEventListener('click', () => {
            const label = chip.dataset.cat;
            if (catFilter && catFilter.label === label) {
                setCatFilter(null, null); // 再點一次解除
                track('map_cat_chip', { cat: label, active: false });
                return;
            }
            const hit = catHitForQuery(label.toLowerCase());
            if (!hit) return;
            // 快捷 chip 與搜尋字互斥：清掉輸入框避免兩個來源打架
            const input = document.getElementById('mapSearchInput');
            input.value = '';
            document.getElementById('mapSearchClear').hidden = true;
            setCatFilter(label, hit.set);
            track('map_cat_chip', { cat: label, active: true, count: hit.count });
        });
    });

    // 抽獎模組已下架（Owner 2026-07-06）：/liff/lottery 路由保留供直接連結，
    // 地圖上不再有入口

    wireSearch();

    document.getElementById('mapDecideBtn').addEventListener('click', () => {
        track('map_decide_click', { draw_count: decideCount + 1 });
        drawSpotlight();
    });
    document.getElementById('spotlightRedraw').addEventListener('click', () => {
        track('map_decide_redraw', { draw_count: decideCount + 1 });
        drawSpotlight();
    });

    document.getElementById('miniCardClose').addEventListener('click', closeMiniCard);
    document.getElementById('spotlightClose').addEventListener('click', closeSpotlight);

    // bottom sheet：點擊切換 + 手勢上下滑
    const handle = document.getElementById('sheetHandle');
    let dragStartY = null;
    let dragToggled = false; // 手勢已切換過 → 抑制隨後的 click 再切回來
    handle.addEventListener('click', () => {
        if (dragToggled) { dragToggled = false; return; }
        setSheetOpen(!sheetOpen);
    });
    handle.addEventListener('pointerdown', e => { dragStartY = e.clientY; dragToggled = false; });
    handle.addEventListener('pointermove', e => {
        if (dragStartY == null) return;
        const dy = e.clientY - dragStartY;
        if (dy < -30 && !sheetOpen) { setSheetOpen(true); dragToggled = true; dragStartY = null; }
        else if (dy > 30 && sheetOpen) { setSheetOpen(false); dragToggled = true; dragStartY = null; }
    });
    handle.addEventListener('pointerup', () => { dragStartY = null; });

    // 清單展開時的下拉手勢：頂端下拉 = 收合清單，
    // 並 preventDefault 擋住 LINE「下拉縮小 LIFF」的原生手勢（用戶回報：往下滑會退出縮小）
    const sheetEl = document.getElementById('mapSheet');
    const listEl = document.getElementById('sheetList');
    let sheetTouchY = null;
    let sheetGestureDone = false;
    sheetEl.addEventListener('touchstart', e => {
        sheetTouchY = e.touches[0].clientY;
        sheetGestureDone = false;
    }, { passive: true });
    sheetEl.addEventListener('touchmove', e => {
        if (sheetTouchY == null || !sheetOpen) return;
        const dy = e.touches[0].clientY - sheetTouchY;
        const inList = listEl.contains(e.target);
        const atTop = !inList || listEl.scrollTop <= 0;
        const atBottom = !inList || (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 1);
        if (dy > 0 && atTop) {
            e.preventDefault(); // 不讓 LINE 把整個 LIFF 拉下去
            if (dy > 55 && !sheetGestureDone) {
                sheetGestureDone = true;
                setSheetOpen(false); // 頂端下拉超過門檻 = 使用者想關清單
            }
        } else if (dy < 0 && atBottom) {
            e.preventDefault(); // 底端上拉的橡皮筋也不外漏
        }
    }, { passive: false });
    sheetEl.addEventListener('touchend', () => { sheetTouchY = null; }, { passive: true });

    renderBudgetChips();

    // Escape 依序關閉最上層的浮層
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const searchResults = document.getElementById('mapSearchResults');
        const spotlight = document.getElementById('mapSpotlight');
        const minicard = document.getElementById('mapMiniCard');
        if (searchResults && !searchResults.hidden) closeSearch();
        else if (spotlight && !spotlight.hidden) closeSpotlight();
        else if (minicard && !minicard.hidden) closeMiniCard();
        else if (sheetOpen) setSheetOpen(false);
    });
}

// ---- 進入點 ----

export async function initMapPage() {
    console.log('初始化生活地圖頁面');
    ensureMapRoot(); // 顯示/隱藏由 body.is-map-page（router 切換）控制

    // 已初始化過（返回地圖頁）：地圖實例保留，只需重新整理視圖
    if (map) {
        requestAnimationFrame(() => map.invalidateSize());
        updateCountPill();
        return;
    }

    // 只接一次線：初次 init 失敗（Leaflet/資料載入逾時）後，router 允許重試會再進來一次，
    // 此時 map 仍為 null、ensureMapRoot 回傳既有 DOM → 沒有 guard 會把每個 listener 綁第二遍
    // （filter chip 被 toggle 兩次＝沒反應、Esc 關兩層…）。
    if (!controlsWired) { wireControls(); controlsWired = true; }

    try {
        // 贊助店名單只有「幫我決定」第 4 抽才用得到：
        // 背景載入，不擋首屏（serverless 冷啟可能秒級延遲）
        loadSponsoredRestaurants().then(list => { sponsoredRestaurants = list; });

        // Leaflet 與 pin 資料平行載入。外部 POI（灰點，206K、只在 z≥16 顯示）不放進關鍵路徑：
        // 延到首屏後 idle 才抓（見下方 loadExternalPois），避免與 Leaflet+pins 搶頻寬拖慢第一畫面。
        const pinsUrl = new URL('../data/map_pins.json', import.meta.url);
        const [L, pinsRes] = await withTimeout(Promise.all([
            loadLeaflet(),
            fetch(pinsUrl).then(r => {
                if (!r.ok) throw new Error(`pin 資料載入失敗: ${r.status}`);
                return r.json();
            }),
        ]), 15000, '地圖資料');
        allPins = pinsRes.pins || [];
        allPlaces = pinsRes.places || [];
        allCats = pinsRes.cats || [];

        map = L.map('liffMap', {
            preferCanvas: true,
            // 圓點命中範圍外擴 12px（Leaflet 讀 renderer.options.tolerance）：
            // 原本只有半徑 6–11px，手指常點不到 → 要按好幾次或只能點店名。放大到接近指腹尺寸。
            renderer: L.canvas({ tolerance: 12 }),
            zoomControl: false,
            attributionControl: true,
        }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
        map.attributionControl.setPrefix(false);

        tileLayer = L.tileLayer(tileUrl(), {  // 深色模式→dark_matter，淺色→voyager
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap &copy; CARTO',
        }).addTo(map);

        clusterGroup = L.markerClusterGroup({
            chunkedLoading: true,
            disableClusteringAtZoom: 17,
            maxClusterRadius: 60,
            showCoverageOnHover: false,
        });
        for (const pin of allPins) {
            if (pin.sp) {
                sponsorMarkers.set(pin.id, buildSponsorMarker(L, pin));
            } else {
                pinMarkers.set(pin.id, buildMarker(L, pin));
            }
        }
        // 今日之星：金冠圖釘常駐（不進 cluster、不受篩選——編輯位）
        starPin = pickStarPin();
        if (starPin) {
            starMarker = buildStarMarker(L, starPin).addTo(map);
        }
        map.addLayer(clusterGroup);
        applyFilters();

        // 外部 POI（1,262 顆灰點，只在 z≥16 顯示）延後載入：不與首屏搶頻寬/CPU。
        // 首繪後 idle 再抓 + 建層（含 1262 marker 配置）；失敗不影響地圖（選配資料）。
        const loadExternalPois = () => {
            fetch(new URL('../data/external_pois.json', import.meta.url))
                .then(r => (r.ok ? r.json() : null))
                .then(extRes => {
                    extPois = (extRes && extRes.pois) || [];
                    if (!extPois.length || !map) return;
                    buildExtLayer(L);      // 未合作餐廳（灰空心點，z≥16 顯示）
                    updateCountPill();     // 補上「含未合作」的總數
                })
                .catch(() => { /* 選配資料，靜默失敗 */ });
        };
        if ('requestIdleCallback' in window) requestIdleCallback(loadExternalPois, { timeout: 3000 });
        else setTimeout(loadExternalPois, 800);

        // 停車暖機：進 app 就先叫醒 parking function + 預載即時空位快取（fire-and-forget，一次就好）。
        // → 使用者稍後點餐廳卡的「第一次讀」不必再付 function cold start，幾乎瞬間出現。
        if (!window.__parkingWarmed) {
            window.__parkingWarmed = true;
            const warm = () => {
                const apiBase = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
                    ? 'http://localhost:3000/api' : '/api';
                try { fetch(`${apiBase}/parking/nearby?warm=1`).catch(() => {}); } catch (e) { /* 靜默 */ }
            };
            if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
            else setTimeout(warm, 1200);
        }

        // 遊戲化開場：連續天數 + 抽選額度 badge
        const streak = bumpStreak();
        updateFabBadge();
        if (streak.days >= 2) {
            setTimeout(() => showPillMessage(`🔥 連續 ${streak.days} 天報到！今天有 ${diceQuota()} 次抽選等你用`, 5000), 2200);
        }

        map.on('moveend', () => {
            updateCountPill();
            programmaticMove = false;
        });
        // 使用者自己拖動地圖 → 已離開原本逛的清單脈絡，不再還原
        map.on('movestart', () => {
            if (!programmaticMove) savedSheetView = null;
        });
        map.on('click', () => { closeMiniCard(); closeSearch(); });

        // 店名標籤分層（密集區防標籤互疊）：
        //   z16 先亮「加碼優惠」店名（紅/金 pin），z17 全亮；低 zoom 不顯示避免雜訊
        const syncLabels = () => {
            const z = map.getZoom();
            const el = document.getElementById('liffMap');
            el.classList.toggle('show-labels', z >= 16);
            el.classList.toggle('show-labels-all', z >= 17);
            scheduleLabelCollision(); // 分層改變後重算碰撞
        };
        map.on('zoomend', syncLabels);
        map.on('moveend', scheduleLabelCollision); // 平移後視窗內標籤集合變了
        syncLabels();

        // 拉近時 pin 略放大（手指點得到；z≥17 半徑 +2px）
        let pinBumped = false;
        const syncPinSize = () => {
            const bump = map.getZoom() >= 17;
            if (bump === pinBumped) return;
            pinBumped = bump;
            // 只有灰點(circleMarker)有 setRadius；餐廳 icon(divIcon marker)固定尺寸，跳過。
            pinMarkers.forEach(m => { if (m.setRadius) m.setRadius(m._baseRadius + (bump ? 2 : 0)); });
            if (extLayer) extLayer.eachLayer(m => m.setRadius(bump ? 7 : 5));
        };
        map.on('zoomend', syncPinSize);

        track('map_open', { pins: allPins.length });

        // 首次開啟：一次性身分+圖例提示（之後圖例常駐在清單面板裡）
        try {
            if (!localStorage.getItem(ONBOARD_KEY)) {
                localStorage.setItem(ONBOARD_KEY, '1');
                setTimeout(() => showPillMessage('💵 訂位出席就有現金回饋！紅點＝套餐優惠、金點＝訂位優惠，點店家看詳情', 8000), 1200);
            }
        } catch (e) { /* private mode: 略過 */ }

        // 除錯/自動化測試掛鉤
        window.__lifeMap = {
            get map() { return map; },
            get pins() { return allPins; },
            get extPois() { return extPois; },
            get extLayerShown() { return !!(extLayer && map && map.hasLayer(extLayer)); },
            openPin(id) {
                const pin = allPins.find(p => p.id === id);
                if (pin) showMiniCard(pin);
            },
            openExt(name) {
                const poi = extPois.find(p => p.n === name);
                if (poi) showExtCard(poi);
            },
            isFav, favCount,
            buildFlexMessage,
        };

        // 分享深連結：好友點 liff.line.me/…?r=<id> 進來 → 直接飛到該店開卡
        try {
            const params = new URLSearchParams(window.location.search);
            let rid = params.get('r');
            // LIFF 有時把原始 query 包在 liff.state 裡
            if (!rid && params.get('liff.state')) {
                const inner = new URLSearchParams(params.get('liff.state').replace(/^\?/, ''));
                rid = inner.get('r');
            }
            rid = Number(rid);
            if (rid) {
                const pin = allPins.find(p => p.id === rid);
                if (pin) {
                    programmaticMove = true;
                    map.setView([pin.lat, pin.lng], 17);
                    showMiniCard(pin);
                    track('map_open_shared', { or_id: rid });
                }
            }
        } catch (e) { /* ignore */ }

        // 進場即請求定位（拒絕不擋路：地圖照樣能逛、能搜尋）
        locateUser({ silent: true });
    } catch (err) {
        console.error('地圖初始化失敗:', err);
        const canvas = document.getElementById('liffMap');
        if (canvas) {
            canvas.innerHTML = `
                <div class="map-error">
                    <p>😥 地圖載入失敗</p>
                    <button type="button" class="map-btn map-btn--primary" onclick="location.reload()">重新載入</button>
                </div>`;
        }
        throw err; // 讓 router fallback 到 home
    }
}
