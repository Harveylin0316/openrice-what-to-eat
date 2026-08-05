// 好康地圖匿名行為追蹤：不傳精準位置、搜尋原文或 LINE 個資到分析屬性。
const TRACK_ENDPOINT = '/api/track';
const VISITOR_KEY = 'rr_analytics_visitor_v1';
const SESSION_KEY = 'rr_analytics_session_v1';
const SESSION_TIMEOUT = 30 * 60 * 1000;

function uuid(prefix) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readJson(storage, key) {
    try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; }
}

function getOrCreateVisitorId() {
    try {
        let id = localStorage.getItem(VISITOR_KEY);
        if (!id) { id = uuid('visitor'); localStorage.setItem(VISITOR_KEY, id); }
        return id;
    } catch { return uuid('visitor'); }
}

function getOrCreateSession() {
    const now = Date.now();
    try {
        const saved = readJson(sessionStorage, SESSION_KEY);
        if (saved?.id && now - Number(saved.lastAt || 0) < SESSION_TIMEOUT) return saved;
        const fresh = { id: uuid('sess'), startedAt: now, lastAt: now, eventCount: 0 };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(fresh));
        return fresh;
    } catch { return { id: uuid('sess'), startedAt: now, lastAt: now, eventCount: 0 }; }
}

const visitorId = getOrCreateVisitorId();
let session = getOrCreateSession();
let userContext = { line_id: null, is_in_line: null, os: null, language: null };
let lifecycleStarted = false;

function entryContext() {
    const params = new URLSearchParams(location.search);
    let source = params.get('utm_source') || '';
    if (!source && (params.get('r') || params.get('liff.state')?.includes('r='))) source = 'shared_restaurant';
    if (!source) {
        try { source = document.referrer ? new URL(document.referrer).hostname : 'direct'; } catch { source = 'direct'; }
    }
    return {
        entry_source: source || 'direct',
        utm_medium: params.get('utm_medium') || null,
        utm_campaign: params.get('utm_campaign') || null,
        utm_content: params.get('utm_content') || null,
    };
}

const acquisition = typeof location !== 'undefined' ? entryContext() : { entry_source: 'unknown' };

function commonProperties() {
    const width = typeof innerWidth === 'number' ? innerWidth : 0;
    return {
        visitor_id: visitorId,
        event_id: uuid('evt'),
        client_ts: new Date().toISOString(),
        event_index: session.eventCount + 1,
        page: location.pathname,
        app_version: window.__V || null,
        screen: width < 480 ? 'phone' : width < 900 ? 'tablet' : 'desktop',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
        ...acquisition,
    };
}

function send(eventName, properties) {
    session.lastAt = Date.now();
    session.eventCount += 1;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* private mode */ }
    // __ts 是「事件發生的當下」；緩衝過的事件延後送出時要用它，不能用送出當下的時間，
    // 否則時間軸會被壓縮成同一秒。
    const { __ts, ...rest } = properties || {};
    const body = JSON.stringify({
        event_name: eventName,
        properties: { ...commonProperties(), ...rest, event_index: session.eventCount, ...(__ts ? { client_ts: __ts } : {}) },
        session_id: session.id,
        ...userContext,
    });
    try {
        if (navigator.sendBeacon) navigator.sendBeacon(TRACK_ENDPOINT, new Blob([body], { type: 'application/json' }));
        else fetch(TRACK_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch (err) { console.debug('[track] fail:', err); }
}

// ── 身分就緒前先緩衝 ──────────────────────────────────────────────
// 問題：track() 原本直接送出，而 line_id 是 app.js 拿到 LIFF profile 後才 setUserContext。
// 地圖多半從快取秒開、getProfile 卻要跑一趟網路，所以開場那批事件
// （analytics_session_start、map_open、分享連結進來的 map_restaurant_view…）
// 全部帶著 line_id: null 送出去，事後無法回填。
// 實測：30 天內有 71 個 session 是「同一次來訪部分事件有身分、部分沒有」，共 205 筆事件遺失身分。
// 解法：身分確定前先排隊，確定後再依原順序送出（用 __ts 保留原始發生時間）。
// 安全閥：① 逾時仍未就緒就照送（寧可匿名也不要整批遺失）② 使用者離開頁面時立刻清空佇列。
const CTX_WAIT_MAX_MS = 10000;
let ctxReady = false;
let pending = [];
let ctxTimer = null;

function flushPending() {
    ctxReady = true;
    if (ctxTimer) { clearTimeout(ctxTimer); ctxTimer = null; }
    const queued = pending;
    pending = [];
    for (const [name, props] of queued) send(name, props);
}

function enqueueOrSend(eventName, properties) {
    const payload = { ...properties, __ts: new Date().toISOString() };
    if (!ctxReady) {
        pending.push([eventName, payload]);
        if (!ctxTimer) ctxTimer = setTimeout(flushPending, CTX_WAIT_MAX_MS);
        return;
    }
    send(eventName, payload);
}

function ensureLifecycle() {
    if (lifecycleStarted) return;
    lifecycleStarted = true;
    enqueueOrSend('analytics_session_start', {});
    addEventListener('pagehide', () => {
        // 頁面要走了：先把還在排隊的送出（否則整批遺失），再送結束事件。
        flushPending();
        send('analytics_session_end', {
            duration_ms: Math.max(0, Date.now() - session.startedAt),
            event_count: session.eventCount,
        });
    }, { once: true });
}

export function setUserContext(ctx) { userContext = { ...userContext, ...ctx }; }
/** 身分已確定（或確定拿不到）→ 把排隊中的事件依序送出。app.js 成功與失敗路徑都要呼叫。 */
export function markUserContextReady() { flushPending(); }
export function getSessionId() { return session.id; }
export function getVisitorId() { return visitorId; }
export function track(eventName, properties = {}) { ensureLifecycle(); enqueueOrSend(eventName, properties); }
