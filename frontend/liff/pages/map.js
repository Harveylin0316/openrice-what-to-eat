// 生活地圖：全螢幕餐飲好康地圖（新首頁）
// 三種姿態：逛（地圖探索）、省（只看好康）、決（🎲 幫我決定 → 聚光燈單卡）
// 依 _redesign/lifestyle-map-architecture.md

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

const DEFAULT_CENTER = [25.0478, 121.5170]; // 台北車站（無定位時的起點）
const DEFAULT_ZOOM = 14;
const SPOTLIGHT_ZOOM = 16;
const SPONSOR_EVERY = 4; // 每第 N 次「幫我決定」給贊助店保底曝光（沿用首頁廣告節奏）
const SPO_ROTATION_KEY = 'rr_map_spo_rotation_idx';

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// ---- 頁面狀態 ----

let map = null;
let clusterGroup = null;
let allPins = [];               // map_pins.json 的原始資料
let allPlaces = [];             // 搜尋用地點索引（行政區/地標，含質心座標）
let allCats = [];               // 品類詞彙表（火鍋店/燒肉店/居酒屋…，pin.ct 為索引）
let catFilter = null;           // 品類篩選 {label, set:Set<catIdx>}，搜尋或快捷 chip 設定
let pinMarkers = new Map();     // pin.id -> L.CircleMarker（一般 pin，走 cluster）
let sponsorMarkers = new Map(); // pin.id -> L.Marker（贊助店專屬圖釘，永不聚合）
let starPin = null;             // 今日之星（日期種子每日輪換，金冠圖釘）
let starMarker = null;
let userLocation = null;
let userMarker = null;
let activeFilters = { deals: false, open: false, bookable: false, budget: null };
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
    if (pin.b) html += '<span class="map-badge map-badge--cashback">出席回饋 $3</span>'; // 基本盤，與加碼優惠並存
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
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_id=&travelmode=walking&dir_action=navigate&query=${encodeURIComponent(name)}`;
}

// ---- Leaflet 動態載入（只有地圖頁需要，不拖慢其他頁）----

let leafletReady = null;

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
        await Promise.all([
            loadCss(new URL('leaflet.css', base).href),
            loadCss(new URL('MarkerCluster.css', base).href),
            loadCss(new URL('MarkerCluster.Default.css', base).href),
        ]);
        await loadScript(new URL('leaflet.js', base).href);
        await loadScript(new URL('leaflet.markercluster.js', base).href);
        return window.L;
    })();
    return leafletReady;
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
            <button type="button" class="map-chip" id="chipDeals" aria-pressed="false">🔥 加碼優惠</button>
            <button type="button" class="map-chip" id="chipOpen" aria-pressed="false">🕐 現在有開</button>
            <button type="button" class="map-chip" id="chipBookable" aria-pressed="false">📅 可訂位</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="火鍋" aria-pressed="false">🍲 火鍋</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="燒肉" aria-pressed="false">🥩 燒肉</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="吃到飽" aria-pressed="false">🍱 吃到飽</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="餐酒館" aria-pressed="false">🍷 餐酒館</button>
            <button type="button" class="map-chip map-chip--cat" data-cat="咖啡" aria-pressed="false">☕ 咖啡廳</button>
        </div>
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
                    <span><i class="map-dot" style="background:#B4AFA8"></i>一般</span>
                </div>
                <div class="map-sheet__budget" id="sheetBudget" role="group" aria-label="預算篩選"></div>
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

function buildMarker(L, pin) {
    const t = TIER[pin.t] || TIER.none;
    const marker = L.circleMarker([pin.lat, pin.lng], {
        radius: t.radius,
        color: '#fff',
        weight: 2,
        fillColor: t.color,
        fillOpacity: 0.95,
    });
    // 高 zoom（cluster 散開後）顯示店名標籤：掃視地圖不用逐顆點
    marker.bindTooltip(pin.n, {
        permanent: true,
        interactive: true, // 標籤本身可點（否則點文字會穿透到地圖）
        direction: 'right',
        offset: [8, 0],
        className: `map-pin-label${(pin.t === 'menu' || pin.t === 'offer') ? ' map-pin-label--deal' : ''}`,
    });
    const trackProps = { or_id: pin.id, name: pin.n, tier: pin.t };
    marker.on('click', () => {
        track('map_pin_click', trackProps);
        showMiniCard(pin);
    });
    makeLabelClickable(marker, pin, trackProps);
    return marker;
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
    updateCountPill();
}

function updateCountPill() {
    const pill = document.getElementById('mapCountPill');
    if (!pill || !map) return;
    const bounds = map.getBounds();
    const now = new Date();
    let inView = 0;
    let deals = 0;
    for (const pin of allPins) {
        if (!pinPassesFilters(pin, now)) continue;
        if (bounds.contains([pin.lat, pin.lng])) {
            inView++;
            if (pin.t === 'menu' || pin.t === 'offer') deals++;
        }
    }
    if (inView === 0) {
        const filtered = activeFilters.deals || activeFilters.open || activeFilters.bookable || activeFilters.budget;
        pill.textContent = filtered
            ? '篩選有點嚴格，鬆開一個條件再看看'
            : '這一帶還沒有合作店家，滑去鬧區看看';
    } else {
        // 窄屏用短版，避免被 FAB 保留區截斷
        pill.textContent = window.matchMedia('(max-width: 360px)').matches
            ? `${inView} 間 · ${deals} 加碼`
            : `畫面內 ${inView} 間 · ${deals} 間加碼優惠`;
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
    // 贊助店置頂（付費曝光，清單同樣給位）；其後有定位由近到遠、沒定位好康+評分
    const spo = (p) => (p.sp ? 1 : 0);
    if (userLocation) {
        rows.sort((a, b) =>
            (spo(b) - spo(a)) ||
            (calculateDistance(userLocation.lat, userLocation.lng, a.lat, a.lng) -
             calculateDistance(userLocation.lat, userLocation.lng, b.lat, b.lng)));
    } else {
        rows.sort((a, b) =>
            (spo(b) - spo(a)) ||
            (TIER_WEIGHT[b.t] - TIER_WEIGHT[a.t]) || ((b.r || 0) - (a.r || 0)));
    }
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

    list.innerHTML = shown.map(pin => {
        const hours = expandHours(pin.h);
        const opening = hours ? getOpeningStatus(hours) : null;
        const dist = distanceLabel(pin.lat, pin.lng);
        return `
        <li>
            <button type="button" class="map-sheet__item" data-pin-id="${pin.id}">
                ${pin.img
                    ? `<img class="map-sheet__thumb" src="${escapeHtml(pin.img)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`
                    : '<span class="map-sheet__thumb map-sheet__thumb--empty">🍽️</span>'}
                <span class="map-sheet__item-info">
                    <span class="map-sheet__item-top">
                        <span class="map-sheet__item-name">${escapeHtml(pin.n)}</span>
                        ${tierBadgeHtml(pin.t)}
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
    setSelectedRing(pin.lat, pin.lng);

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
            <div class="map-minicard__actions">
                ${pin.url ? `<a class="map-btn map-btn--primary" data-track="booking" href="${escapeHtml(pin.url)}" target="_blank" rel="noopener">${pin.b ? '立即訂位' : '看餐廳頁'}</a>` : ''}
                <a class="map-btn map-btn--ghost" data-track="navigation" href="${navigationUrl(pin.lat, pin.lng, pin.n)}" target="_blank" rel="noopener">🧭 導航</a>
            </div>
        </div>
    `;

    body.querySelectorAll('a[data-track]').forEach(a => {
        a.addEventListener('click', () => {
            track(a.dataset.track === 'booking' ? 'map_booking_click' : 'map_navigation_click',
                { or_id: pin.id, name: pin.n, tier: pin.t, source: 'minicard' });
        });
    });

    card.hidden = false;
    updateCardOpenState();
}

function closeMiniCard() {
    const card = document.getElementById('mapMiniCard');
    if (card) card.hidden = true;
    clearSelectedRing();
    updateCardOpenState();
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
        // 抽選結果與「畫面內 N 間」的心智模型一致
        if (!restaurant) {
            const candidates = viewportCandidates();
            if (candidates.length) {
                const pick = candidates[Math.floor(Math.random() * candidates.length)];
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
    if (bookable) dealBadges += '<span class="map-badge map-badge--cashback">出席回饋 $3</span>'; // 基本盤，與加碼優惠並存
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
    `;

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
    return [...catRows, ...placeHits, ...pinHits];
}

const SEARCH_ICON = { category: '🍴', district: '🏙️', landmark: '📍', restaurant: '🍽️', recent: '🕘' };

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
    }
    if (list) { list.hidden = true; list.innerHTML = ''; }
    if (input) input.blur();
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
        // 品類 → 地圖篩選（Google 式）：只留命中店家 + 視野框住結果
        setCatFilter(m.name, m.set);
        const pts = allPins.filter(p => (p.ct || []).some(i => m.set.has(i)))
            .map(p => [p.lat, p.lng]);
        if (pts.length) {
            map.fitBounds(pts, { padding: [48, 48], maxZoom: 16 });
        }
        // 保留搜尋字在框內（清除 ✕ = 解除篩選）
        const input = document.getElementById('mapSearchInput');
        input.value = m.name;
        document.getElementById('mapSearchClear').hidden = false;
        showPillMessage(`已篩出「${m.name}」相關 ${m.sub}，按 ✕ 解除`, 4000);
    } else if (m.kind === 'restaurant') {
        map.flyTo([m.pin.lat, m.pin.lng], 17, { duration: 0.8 });
        showMiniCard(m.pin);
    } else {
        // 行政區看全貌、地標看街區
        map.flyTo([m.lat, m.lng], m.kind === 'district' ? 15 : 16, { duration: 0.8 });
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
    const chipMap = { chipDeals: 'deals', chipOpen: 'open', chipBookable: 'bookable' };
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

    document.getElementById('chipLocate').addEventListener('click', () => locateUser({ silent: false }));

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

    wireControls();

    try {
        // 贊助店名單只有「幫我決定」第 4 抽才用得到：
        // 背景載入，不擋首屏（serverless 冷啟可能秒級延遲）
        loadSponsoredRestaurants().then(list => { sponsoredRestaurants = list; });

        // Leaflet 與 pin 資料平行載入
        const pinsUrl = new URL('../data/map_pins.json', import.meta.url);
        const [L, pinsRes] = await Promise.all([
            loadLeaflet(),
            fetch(pinsUrl).then(r => {
                if (!r.ok) throw new Error(`pin 資料載入失敗: ${r.status}`);
                return r.json();
            }),
        ]);
        allPins = pinsRes.pins || [];
        allPlaces = pinsRes.places || [];
        allCats = pinsRes.cats || [];

        map = L.map('liffMap', {
            preferCanvas: true,
            zoomControl: false,
            attributionControl: true,
        }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
        map.attributionControl.setPrefix(false);

        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
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

        // 店名標籤只在高 zoom 顯示（cluster 散開後）；低 zoom 的孤立 pin 不顯示避免雜訊
        const syncLabels = () => {
            document.getElementById('liffMap').classList.toggle('show-labels', map.getZoom() >= 16);
        };
        map.on('zoomend', syncLabels);
        syncLabels();

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
            openPin(id) {
                const pin = allPins.find(p => p.id === id);
                if (pin) showMiniCard(pin);
            },
        };

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
