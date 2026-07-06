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
import { navigateTo } from './router.js';

// ---- 常數 ----

// 好康層級：半徑階梯讓好康 pin 在地圖上大聲、一般店安靜
// coupon 用 teal 與「營業中」的綠（--lm-success）區分，一色一義
const TIER = {
    sponsored:     { color: '#E44E25', label: '精選推薦', radius: 12 },   // OR 紅橘
    booking_offer: { color: '#E5A000', label: '訂位獨家優惠', radius: 10 }, // OR 黃系（地圖上加深保對比）
    coupon:        { color: '#0E8C7F', label: '有優惠券', radius: 9 },
    none:          { color: '#8A857E', label: '', radius: 6 },
};

const ONBOARD_KEY = 'rr_map_onboarded_v1';

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
let pinMarkers = new Map();     // pin.id -> L.CircleMarker
let userLocation = null;
let userMarker = null;
let activeFilters = { deals: false, open: false, bookable: false, budget: null };
let sheetOpen = false;
let savedSheetView = null;      // 清單→店家卡後保留的視角/捲動位置，重開清單時還原
let programmaticMove = false;   // 區分程式 flyTo 與使用者拖動（拖動會清掉 savedSheetView）

const BUDGET_CATEGORIES = ['200元內', '200-500元', '500-1000元', '1000-1500元', '1500以上'];
const TIER_WEIGHT = { sponsored: 3, booking_offer: 2, coupon: 1, none: 0 };
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
        <div class="map-chips" role="toolbar" aria-label="地圖篩選">
            <button type="button" class="map-chip" id="chipDeals" aria-pressed="false">🎫 只看好康</button>
            <button type="button" class="map-chip" id="chipOpen" aria-pressed="false">🕐 營業中</button>
            <button type="button" class="map-chip" id="chipBookable" aria-pressed="false">📅 可訂位</button>
        </div>
        <div class="map-side-nav">
            <button type="button" class="map-side-btn" id="chipHome" aria-label="條件找店">
                <span aria-hidden="true">📝</span><small>找店</small>
            </button>
            <button type="button" class="map-side-btn" id="chipLottery" aria-label="抽獎活動">
                <span aria-hidden="true">🎁</span><small>抽獎</small>
            </button>
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
        <button type="button" class="map-fab" id="mapDecideBtn">🎲 幫我決定</button>

        <div class="map-sheet" id="mapSheet">
            <button type="button" class="map-sheet__handle" id="sheetHandle"
                    aria-expanded="false" aria-controls="sheetBody">
                <span class="map-sheet__grip" aria-hidden="true"></span>
                <span class="map-sheet__summary" id="mapCountPill" role="status" aria-live="polite">載入地圖中…</span>
            </button>
            <div class="map-sheet__body" id="sheetBody">
                <div class="map-sheet__legend" aria-label="圖例">
                    <span><i class="map-dot" style="background:#E44E25"></i>精選</span>
                    <span><i class="map-dot" style="background:#E5A000"></i>訂位優惠</span>
                    <span><i class="map-dot" style="background:#0E8C7F"></i>優惠券</span>
                    <span><i class="map-dot" style="background:#8A857E"></i>一般</span>
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
                <button type="button" class="map-btn map-btn--ghost" id="spotlightRedraw">🎲 換一個</button>
                <span id="spotlightActionLinks"></span>
            </div>
        </div>
    `;
    document.body.appendChild(root);
    return root;
}

// ---- Pin 與篩選 ----

function pinPassesFilters(pin, now) {
    if (activeFilters.deals && pin.t === 'none') return false;
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
        direction: 'right',
        offset: [8, 0],
        className: `map-pin-label${pin.t !== 'none' ? ' map-pin-label--deal' : ''}`,
    });
    marker.on('click', () => {
        track('map_pin_click', { or_id: pin.id, name: pin.n, tier: pin.t });
        showMiniCard(pin);
    });
    return marker;
}

function applyFilters() {
    if (!clusterGroup) return;
    savedSheetView = null; // 篩選變了，舊的清單脈絡不再成立
    const now = new Date();
    const visible = [];
    clusterGroup.clearLayers();
    for (const pin of allPins) {
        if (pinPassesFilters(pin, now)) {
            visible.push(pinMarkers.get(pin.id));
        }
    }
    clusterGroup.addLayers(visible);
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
            if (pin.t !== 'none') deals++;
        }
    }
    if (inView === 0) {
        const filtered = activeFilters.deals || activeFilters.open || activeFilters.bookable || activeFilters.budget;
        pill.textContent = filtered
            ? '沒有符合篩選的店家，試試放寬篩選'
            : '這一帶還沒有店家，拖動地圖看看別區';
    } else {
        pill.textContent = `畫面內 ${inView} 間 · ${deals} 間有好康`;
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
    // 有定位 → 由近到遠；沒定位 → 好康優先、再依評分
    if (userLocation) {
        rows.sort((a, b) =>
            calculateDistance(userLocation.lat, userLocation.lng, a.lat, a.lng) -
            calculateDistance(userLocation.lat, userLocation.lng, b.lat, b.lng));
    } else {
        rows.sort((a, b) =>
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
        list.innerHTML = '<li class="map-sheet__empty">這個範圍沒有符合的店，拖動地圖或放寬篩選</li>';
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
    return `<span class="map-badge map-badge--${tier}">${t.label}</span>`;
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

    const hours = expandHours(pin.h);
    const opening = hours ? getOpeningStatus(hours) : null;
    const dist = distanceLabel(pin.lat, pin.lng);
    const tags = filterGeneralTags(pin.tg || []);
    const offers = pin.of || [];

    // 有券但沒有券內容資料 → 通用說明（誠實：不假裝知道折扣內容）
    const offerLines = offers.length
        ? offers.map(o => `<li>🎁 ${escapeHtml(o)}</li>`)
        : (pin.t === 'coupon' ? ['<li>🎁 OpenRice 優惠券 — 詳情見餐廳頁</li>'] : []);

    body.innerHTML = `
        ${pin.img ? `<img class="map-minicard__img" src="${escapeHtml(pin.img)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">` : ''}
        <div class="map-minicard__info">
            <div class="map-minicard__badges">${tierBadgeHtml(pin.t)}</div>
            <h3 class="map-minicard__name">${pin.url
                ? `<a href="${escapeHtml(pin.url)}" data-liff-internal target="_blank" rel="noopener">${escapeHtml(pin.n)}<span class="map-minicard__more"> ›</span></a>`
                : escapeHtml(pin.n)}</h3>
            <p class="map-minicard__meta">
                ${pin.r ? `⭐ ${formatRating(pin.r)}　` : ''}${escapeHtml(pin.d || '')}${dist ? `　·　${dist}` : ''}${pin.bud ? `　·　💰 ${escapeHtml(pin.bud)}` : ''}
            </p>
            ${opening && opening.label ? `<p class="map-minicard__meta ${opening.openNow ? 'is-open' : ''} ${opening.status === 'closed-today' ? 'is-closed' : ''}">${escapeHtml(opening.label)}</p>` : ''}
            ${tags.length ? `<p class="map-minicard__tags">${tags.map(t => `<span class="map-tag">${escapeHtml(t)}</span>`).join('')}</p>` : ''}
            ${offerLines.length ? `<ul class="map-minicard__offers">${offerLines.join('')}</ul>` : ''}
            <div class="map-minicard__actions">
                ${pin.url ? `<a class="map-btn map-btn--primary" data-track="booking" href="${escapeHtml(pin.url)}" target="_blank" rel="noopener">${pin.b ? '線上訂位' : '查看餐廳'}</a>` : ''}
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

async function drawSpotlight() {
    if (decideInProgress) return;
    decideInProgress = true;

    const panel = document.getElementById('mapSpotlight');
    const body = document.getElementById('spotlightBody');
    const links = document.getElementById('spotlightActionLinks');
    closeMiniCard();
    clearSpotlightPin(); // 清掉上一抽的 🎯，避免載入/失敗時殘留指向舊店
    panel.hidden = false;
    updateCardOpenState();
    body.innerHTML = '<p class="map-spotlight__loading">🎲 正在為你挑選…</p>';
    links.innerHTML = '';

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
            if (!results.length) {
                spotlightExcludes = []; // 全抽過了 → 重置排除清單再抽一次
                results = await fetchRecommendations(buildDecideFormData(), [], 1);
            }
            restaurant = results[0] || null;
            // API 不會過濾今日休息：抽到就換一次（只換一次，避免迴圈）
            if (restaurant && getOpeningStatus(restaurant.opening_hours).status === 'closed-today') {
                spotlightExcludes.push(restaurant.name);
                const retry = await fetchRecommendations(buildDecideFormData(), spotlightExcludes, 1);
                if (retry[0]) restaurant = retry[0];
            }
        }

        if (!restaurant) {
            body.innerHTML = '<p class="map-spotlight__loading">這一帶沒有符合條件的店，拖動地圖或放寬篩選再試</p>';
            return;
        }

        decideCount++; // 只計成功展示的抽數，網路失敗不消耗贊助保底節奏
        spotlightExcludes.push(restaurant.name);
        renderSpotlight(restaurant, isSponsoredPick);
        track('map_decide_result', {
            or_id: restaurant.or_id, name: restaurant.name,
            sponsored: isSponsoredPick, draw_count: decideCount,
        });
    } catch (err) {
        console.error('幫我決定失敗:', err);
        body.innerHTML = '<p class="map-spotlight__loading">哎呀，抽籤失敗了，再試一次！</p>';
    } finally {
        decideInProgress = false;
    }
}

function renderSpotlight(r, isSponsoredPick) {
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
    const tier = isSponsoredPick ? 'sponsored' : (r._tier || (pin ? pin.t : 'none'));
    const offerLines = offers.length
        ? offers.slice(0, 3).map(o => `<li>🎁 ${escapeHtml(o)}</li>`)
        : (tier === 'coupon' ? ['<li>🎁 OpenRice 優惠券 — 詳情見餐廳頁</li>'] : []);

    body.innerHTML = `
        ${heroImage ? `<img class="map-spotlight__img" src="${escapeHtml(heroImage)}" alt="" decoding="async" onerror="this.style.display='none'">` : ''}
        <div class="map-spotlight__info">
            <div class="map-minicard__badges">
                ${isSponsoredPick ? '<span class="map-badge map-badge--sponsored">精選推薦</span>' : tierBadgeHtml(tier)}
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
            ${offerLines.length ? `<ul class="map-minicard__offers">${offerLines.join('')}</ul>` : ''}
        </div>
    `;

    links.innerHTML = `
        ${r.url ? `<a class="map-btn map-btn--primary" data-track="booking" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${r.bookable ? '線上訂位' : '查看餐廳'}</a>` : ''}
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
            if (!silent) showPillMessage('這台裝置不支援定位，拖動地圖探索吧');
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
                        ? '定位被封鎖了，可到 LINE/系統設定開啟，或直接拖地圖逛'
                        : '拿不到定位，拖動地圖探索或用 🎲 幫我決定', 5000);
                }
                resolve(false);
            },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
        );
    });
}

// 只有已授權過定位才靜默自動定位，避免一打開 app 就跳權限彈窗嚇跑用戶
async function autoLocateIfGranted() {
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const st = await navigator.permissions.query({ name: 'geolocation' });
            if (st.state === 'granted') locateUser({ silent: true });
            return;
        }
    } catch (e) { /* permissions API 不支援 → 保守：不自動要權限 */ }
}

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
                        showPillMessage('👆 上拉底部清單，好康一次看完', 5000);
                    }
                } catch (e) { /* ignore */ }
            }
        });
    }

    document.getElementById('chipLocate').addEventListener('click', () => locateUser({ silent: false }));

    // 其他頁面入口（地圖是預設頁，不能變成死路）
    document.getElementById('chipHome').addEventListener('click', () => {
        track('map_nav_click', { to: 'home' });
        navigateTo('home');
    });
    document.getElementById('chipLottery').addEventListener('click', () => {
        track('map_nav_click', { to: 'lottery' });
        navigateTo('lottery');
    });

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
        const spotlight = document.getElementById('mapSpotlight');
        const minicard = document.getElementById('mapMiniCard');
        if (spotlight && !spotlight.hidden) closeSpotlight();
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
            pinMarkers.set(pin.id, buildMarker(L, pin));
        }
        map.addLayer(clusterGroup);
        applyFilters();

        map.on('moveend', () => {
            updateCountPill();
            programmaticMove = false;
        });
        // 使用者自己拖動地圖 → 已離開原本逛的清單脈絡，不再還原
        map.on('movestart', () => {
            if (!programmaticMove) savedSheetView = null;
        });
        map.on('click', () => { closeMiniCard(); });

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
                setTimeout(() => showPillMessage('OpenRice 好康地圖 🔴精選 🟡訂位優惠 🟢有券・點圓點看店家', 8000), 1200);
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

        // 已授權過才靜默定位（不主動跳權限彈窗；失敗不打擾，地圖照樣能逛）
        autoLocateIfGranted();
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
