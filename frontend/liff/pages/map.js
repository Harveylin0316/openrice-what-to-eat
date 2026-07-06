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

const TIER = {
    sponsored:     { color: '#E8754F', label: '精選推薦', radius: 10 },
    booking_offer: { color: '#D9961F', label: '訂位獨家優惠', radius: 8 },
    coupon:        { color: '#2E9A66', label: '有優惠券', radius: 7 },
    none:          { color: '#8A857E', label: '', radius: 6 },
};

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
let activeFilters = { deals: false, open: false, bookable: false };
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
            <button type="button" class="map-chip map-chip--locate" id="chipLocate" aria-label="定位到我的位置">📍</button>
        </div>
        <div id="liffMap" class="map-canvas" role="application" aria-label="餐廳好康地圖"></div>
        <div class="map-count-pill" id="mapCountPill" role="status" aria-live="polite"></div>
        <button type="button" class="map-fab" id="mapDecideBtn">🎲 幫我決定</button>

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
    marker.on('click', () => {
        track('map_pin_click', { or_id: pin.id, name: pin.n, tier: pin.t });
        showMiniCard(pin);
    });
    return marker;
}

function applyFilters() {
    if (!clusterGroup) return;
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
    pill.textContent = inView === 0
        ? '這一帶還沒有店家，拖動地圖看看別區'
        : `畫面內 ${inView} 間餐廳 · ${deals} 個好康`;
}

// ---- 迷你資訊卡（點 pin）----

function tierBadgeHtml(tier) {
    if (!tier || tier === 'none') return '';
    const t = TIER[tier];
    return `<span class="map-badge map-badge--${tier}">${t.label}</span>`;
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

    body.innerHTML = `
        ${pin.img ? `<img class="map-minicard__img" src="${escapeHtml(pin.img)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">` : ''}
        <div class="map-minicard__info">
            <div class="map-minicard__badges">${tierBadgeHtml(pin.t)}</div>
            <h3 class="map-minicard__name">${escapeHtml(pin.n)}</h3>
            <p class="map-minicard__meta">
                ${pin.r ? `⭐ ${pin.r}　` : ''}${escapeHtml(pin.d || '')}${dist ? `　·　${dist}` : ''}
            </p>
            ${opening && opening.label ? `<p class="map-minicard__meta ${opening.openNow ? 'is-open' : ''}">${escapeHtml(opening.label)}</p>` : ''}
            ${tags.length ? `<p class="map-minicard__tags">${tags.map(t => `<span class="map-tag">${escapeHtml(t)}</span>`).join('')}</p>` : ''}
            ${offers.length ? `<ul class="map-minicard__offers">${offers.map(o => `<li>🎁 ${escapeHtml(o)}</li>`).join('')}</ul>` : ''}
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
}

function closeMiniCard() {
    const card = document.getElementById('mapMiniCard');
    if (card) card.hidden = true;
}

// ---- 聚光燈：幫我決定 ----

function nextSponsoredPick() {
    if (!sponsoredRestaurants.length) return null;
    let idx = 0;
    try {
        idx = parseInt(localStorage.getItem(SPO_ROTATION_KEY) || '0', 10) || 0;
    } catch (e) { /* private mode：退化為固定第一家 */ }
    const pick = sponsoredRestaurants[idx % sponsoredRestaurants.length];
    try {
        localStorage.setItem(SPO_ROTATION_KEY, String((idx + 1) % sponsoredRestaurants.length));
    } catch (e) { /* ignore */ }
    return pick;
}

function buildDecideFormData() {
    const formData = { limit: 1 };
    if (userLocation) {
        formData.userLocation = userLocation;
        formData.maxDistance = 5.0; // 交通方式不限 = 5km（沿用首頁規則）
    }
    // 無定位：不帶位置參數，後端在北北基白名單內隨機推薦
    return formData;
}

async function drawSpotlight() {
    if (decideInProgress) return;
    decideInProgress = true;
    decideCount++;

    const panel = document.getElementById('mapSpotlight');
    const body = document.getElementById('spotlightBody');
    const links = document.getElementById('spotlightActionLinks');
    closeMiniCard();
    panel.hidden = false;
    body.innerHTML = '<p class="map-spotlight__loading">🎲 正在為你挑選…</p>';
    links.innerHTML = '';

    try {
        let restaurant = null;
        let isSponsoredPick = false;

        // 每第 N 抽：贊助店保底曝光（輪替），維持廣告庫存價值
        if (decideCount % SPONSOR_EVERY === 0) {
            restaurant = nextSponsoredPick();
            isSponsoredPick = !!restaurant;
        }
        if (!restaurant) {
            const results = await fetchRecommendations(buildDecideFormData(), spotlightExcludes, 1);
            if (!results.length) {
                // 全抽過了 → 重置排除清單再抽一次
                spotlightExcludes = [];
                const retry = await fetchRecommendations(buildDecideFormData(), [], 1);
                restaurant = retry[0] || null;
            } else {
                restaurant = results[0];
            }
        }

        if (!restaurant) {
            body.innerHTML = '<p class="map-spotlight__loading">附近找不到合適的店，拖動地圖換一帶試試</p>';
            decideInProgress = false;
            return;
        }

        if (!isSponsoredPick) spotlightExcludes.push(restaurant.name);
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
    if (hasCoords && map) {
        setSpotlightPin(coords.lat, coords.lng);
        map.flyTo([coords.lat, coords.lng], SPOTLIGHT_ZOOM, { duration: 0.9 });
    }

    const dist = hasCoords ? distanceLabel(coords.lat, coords.lng) : '';
    const distanceKm = (hasCoords && userLocation)
        ? calculateDistance(userLocation.lat, userLocation.lng, coords.lat, coords.lng)
        : null;
    const evidence = generateEvidence(r, distanceKm != null ? { distance: distanceKm } : {});
    const opening = getOpeningStatus(r.opening_hours);
    const tags = filterGeneralTags([...(r.cuisine_style || []), ...(r.type || [])]).slice(0, 3);
    const offers = r.booking_offers || [];
    const heroImage = r.door_photo_url || (r.images && r.images[0]) || '';
    const pin = allPins.find(p => p.id === r.or_id);
    const tier = isSponsoredPick ? 'sponsored' : (pin ? pin.t : 'none');

    body.innerHTML = `
        ${heroImage ? `<img class="map-spotlight__img" src="${escapeHtml(heroImage)}" alt="" decoding="async" onerror="this.style.display='none'">` : ''}
        <div class="map-spotlight__info">
            <div class="map-minicard__badges">
                ${isSponsoredPick ? '<span class="map-badge map-badge--sponsored">精選推薦</span>' : tierBadgeHtml(tier)}
            </div>
            ${evidence && evidence.length ? `<p class="map-spotlight__evidence">${escapeHtml(Array.isArray(evidence) ? evidence[0] : evidence)}</p>` : ''}
            <h3 class="map-spotlight__name">${escapeHtml(r.name)}</h3>
            <p class="map-minicard__meta">
                ${r.rating ? `⭐ ${r.rating}　` : ''}${escapeHtml(r.district || '')}${dist ? `　·　${dist}` : ''}
            </p>
            ${opening.label ? `<p class="map-minicard__meta ${opening.openNow ? 'is-open' : ''}">${escapeHtml(opening.label)}</p>` : ''}
            ${tags.length ? `<p class="map-minicard__tags">${tags.map(t => `<span class="map-tag">${escapeHtml(t)}</span>`).join('')}</p>` : ''}
            ${offers.length ? `<ul class="map-minicard__offers">${offers.slice(0, 3).map(o => `<li>🎁 ${escapeHtml(o)}</li>`).join('')}</ul>` : ''}
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
}

// ---- 定位 ----

function locateUser({ silent = false } = {}) {
    return new Promise(resolve => {
        if (!navigator.geolocation) {
            if (!silent) alert('這台裝置不支援定位，改用拖動地圖探索吧');
            resolve(false);
            return;
        }
        navigator.geolocation.getCurrentPosition(
            pos => {
                userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                showUserMarker();
                if (map) map.flyTo([userLocation.lat, userLocation.lng], 15, { duration: 0.8 });
                track('map_locate', { success: true });
                resolve(true);
            },
            err => {
                console.warn('定位失敗:', err && err.message);
                track('map_locate', { success: false, code: err && err.code });
                if (!silent) {
                    // 定位被拒是最大流失點：不擋路，地圖照樣能逛
                    alert('拿不到定位沒關係，直接拖動地圖探索，或用「幫我決定」隨機抽一間！');
                }
                resolve(false);
            },
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
        );
    });
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
        });
    }

    document.getElementById('chipLocate').addEventListener('click', () => locateUser({ silent: false }));

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
        // Leaflet、pin 資料、贊助店平行載入
        const pinsUrl = new URL('../data/map_pins.json', import.meta.url);
        const [L, pinsRes] = await Promise.all([
            loadLeaflet(),
            fetch(pinsUrl).then(r => {
                if (!r.ok) throw new Error(`pin 資料載入失敗: ${r.status}`);
                return r.json();
            }),
            loadSponsoredRestaurants().then(list => { sponsoredRestaurants = list; }),
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

        map.on('moveend', updateCountPill);
        map.on('click', () => { closeMiniCard(); });

        track('map_open', { pins: allPins.length });

        // 除錯/自動化測試掛鉤
        window.__lifeMap = {
            get map() { return map; },
            get pins() { return allPins; },
            openPin(id) {
                const pin = allPins.find(p => p.id === id);
                if (pin) showMiniCard(pin);
            },
        };

        // 靜默嘗試定位（失敗不打擾：地圖照樣能逛）
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
