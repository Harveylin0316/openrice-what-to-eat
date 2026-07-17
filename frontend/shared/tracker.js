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
    const body = JSON.stringify({
        event_name: eventName,
        properties: { ...commonProperties(), ...properties, event_index: session.eventCount },
        session_id: session.id,
        ...userContext,
    });
    try {
        if (navigator.sendBeacon) navigator.sendBeacon(TRACK_ENDPOINT, new Blob([body], { type: 'application/json' }));
        else fetch(TRACK_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch (err) { console.debug('[track] fail:', err); }
}

function ensureLifecycle() {
    if (lifecycleStarted) return;
    lifecycleStarted = true;
    send('analytics_session_start', {});
    addEventListener('pagehide', () => send('analytics_session_end', {
        duration_ms: Math.max(0, Date.now() - session.startedAt),
        event_count: session.eventCount,
    }), { once: true });
}

export function setUserContext(ctx) { userContext = { ...userContext, ...ctx }; }
export function getSessionId() { return session.id; }
export function getVisitorId() { return visitorId; }
export function track(eventName, properties = {}) { ensureLifecycle(); send(eventName, properties); }
