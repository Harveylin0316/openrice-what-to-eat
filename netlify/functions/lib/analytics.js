'use strict';
const crypto = require('crypto');

const DISCOVERY_EVENTS = new Set([
  'map_pin_click', 'map_star_pin_click', 'map_ext_pin_click', 'map_sheet_item_click',
  'map_search', 'map_search_select', 'map_filter_toggle', 'map_filter_budget',
  'map_cat_chip', 'map_decide_click', 'map_decide_result',
]);
const VIEW_EVENTS = new Set(['map_restaurant_view', 'map_pin_click', 'map_star_pin_click', 'map_sheet_item_click', 'map_decide_result']);
const BOOKING_EVENTS = new Set(['map_booking_click', 'restaurant_click']);

function props(e) { return e && e.properties && typeof e.properties === 'object' ? e.properties : {}; }
function sid(e) { return String(e.session_id || 'unknown'); }
function visitor(e) {
  if (props(e).visitor_id) return String(props(e).visitor_id);
  const legacy = String(e.line_id || e.session_id || 'unknown');
  return `anon_${crypto.createHash('sha256').update(legacy).digest('hex').slice(0, 16)}`;
}
function pct(n, d) { return d ? n / d : 0; }
function dayKey(value) { return String(value || '').slice(0, 10); }
function delta(current, previous) { return previous ? (current - previous) / previous : null; }
function isBooking(e) { return BOOKING_EVENTS.has(e.event_name); }

function periodSummary(events) {
  const sessions = new Map();
  const visitors = new Set();
  let views = 0, bookings = 0, shares = 0, favoriteAdds = 0, durationTotal = 0, durationCount = 0;
  for (const e of events) {
    const s = sid(e);
    if (!sessions.has(s)) sessions.set(s, { opened: false, discovered: false, viewed: false, booked: false, events: [] });
    const state = sessions.get(s);
    state.events.push(e);
    visitors.add(visitor(e));
    if (e.event_name === 'app_open' || e.event_name === 'map_open' || e.event_name === 'analytics_session_start') state.opened = true;
    if (DISCOVERY_EVENTS.has(e.event_name)) state.discovered = true;
    if (VIEW_EVENTS.has(e.event_name)) state.viewed = true;
    if (isBooking(e)) state.booked = true;
    if (e.event_name === 'map_restaurant_view') views += 1;
    if (isBooking(e)) bookings += 1;
    if (e.event_name === 'map_share_click') shares += 1;
    if (e.event_name === 'map_favorite_toggle' && props(e).favorite === true) favoriteAdds += 1;
    if (e.event_name === 'analytics_session_end' && Number.isFinite(Number(props(e).duration_ms))) {
      durationTotal += Number(props(e).duration_ms); durationCount += 1;
    }
  }
  const values = [...sessions.values()];
  const bookingSessions = values.filter(x => x.booked).length;
  const engagedSessions = values.filter(x => x.events.length >= 3 || x.viewed || x.booked).length;
  return {
    visitors: visitors.size, sessions: sessions.size, engagedSessions, restaurantViews: views,
    bookingClicks: bookings, bookingSessions, sessionConversionRate: pct(bookingSessions, sessions.size),
    shareClicks: shares, favoriteAdds, avgSessionSeconds: durationCount ? Math.round(durationTotal / durationCount / 1000) : null,
    funnel: [
      { key: 'opened', label: '開啟地圖', sessions: values.filter(x => x.opened).length },
      { key: 'discovered', label: '探索餐廳', sessions: values.filter(x => x.discovered).length },
      { key: 'viewed', label: '查看餐廳', sessions: values.filter(x => x.viewed).length },
      { key: 'booked', label: '前往訂位', sessions: bookingSessions },
    ],
    sessionMap: sessions,
  };
}

function featureFor(e) {
  const source = props(e).source;
  if (source === 'dice' || e.event_name.startsWith('map_decide')) return '骰子決定';
  if (source === 'search' || e.event_name.startsWith('map_search')) return '搜尋';
  if (source === 'sheet' || e.event_name.startsWith('map_sheet')) return '餐廳列表';
  if (source === 'map_pin' || source === 'pin_label' || e.event_name.includes('pin_click')) return '地圖餐廳點';
  if (e.event_name.startsWith('map_filter') || e.event_name === 'map_cat_chip') return '篩選';
  if (e.event_name.startsWith('map_favorite')) return '收藏';
  if (e.event_name.startsWith('map_share')) return '分享';
  if (e.event_name.startsWith('map_parking')) return '停車資訊';
  return null;
}

function featurePerformance(events, allSessions) {
  const map = new Map();
  for (const e of events) {
    const feature = featureFor(e);
    if (!feature) continue;
    if (!map.has(feature)) map.set(feature, new Set());
    map.get(feature).add(sid(e));
  }
  const baseBookingSessions = [...allSessions.values()].filter(x => x.booked).length;
  const baseRate = pct(baseBookingSessions, allSessions.size);
  return [...map.entries()].map(([name, ids]) => {
    const bookings = [...ids].filter(id => allSessions.get(id)?.booked).length;
    const conversionRate = pct(bookings, ids.size);
    return { name, sessions: ids.size, bookings, conversionRate, lift: baseRate ? conversionRate / baseRate - 1 : null };
  }).sort((a, b) => b.sessions - a.sessions);
}

function restaurantPerformance(events) {
  const map = new Map();
  for (const e of events) {
    if (!VIEW_EVENTS.has(e.event_name) && !isBooking(e) && e.event_name !== 'map_share_click' && e.event_name !== 'map_favorite_toggle') continue;
    const p = props(e); const id = p.or_id; const name = p.name;
    if (id == null && !name) continue;
    const key = String(id ?? name);
    if (!map.has(key)) map.set(key, { orId: id ?? null, name: name || `餐廳 ${id}`, viewSessions: new Set(), bookingSessions: new Set(), shares: 0, favorites: 0, sources: {} });
    const row = map.get(key);
    if (VIEW_EVENTS.has(e.event_name)) {
      row.viewSessions.add(sid(e));
      const source = p.source || featureFor(e) || 'unknown';
      row.sources[source] = (row.sources[source] || 0) + 1;
    }
    if (isBooking(e)) row.bookingSessions.add(sid(e));
    if (e.event_name === 'map_share_click') row.shares += 1;
    if (e.event_name === 'map_favorite_toggle' && p.favorite === true) row.favorites += 1;
  }
  return [...map.values()].map(row => ({
    orId: row.orId, name: row.name, views: row.viewSessions.size, bookings: row.bookingSessions.size,
    shares: row.shares, favorites: row.favorites, bookingRate: pct(row.bookingSessions.size, row.viewSessions.size),
    mainSource: Object.entries(row.sources).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown',
  })).sort((a, b) => b.bookings - a.bookings || b.views - a.views).slice(0, 100);
}

function sourcePerformance(events, sessionMap) {
  const sessions = new Map();
  const sorted = [...events].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const e of sorted) {
    const id = sid(e); if (sessions.has(id)) continue;
    sessions.set(id, { source: props(e).entry_source || 'unknown', visitor: visitor(e) });
  }
  const grouped = new Map();
  for (const [id, s] of sessions) {
    if (!grouped.has(s.source)) grouped.set(s.source, { sessions: 0, visitors: new Set(), bookings: 0 });
    const row = grouped.get(s.source); row.sessions += 1; row.visitors.add(s.visitor); if (sessionMap.get(id)?.booked) row.bookings += 1;
  }
  return [...grouped.entries()].map(([source, row]) => ({ source, sessions: row.sessions, visitors: row.visitors.size, bookings: row.bookings, conversionRate: pct(row.bookings, row.sessions) })).sort((a, b) => b.sessions - a.sessions);
}

function platformPerformance(events, sessionMap) {
  const first = new Map();
  for (const e of events) if (!first.has(sid(e))) first.set(sid(e), e);
  const map = new Map();
  for (const [id, e] of first) {
    const label = `${e.is_in_line ? 'LINE 內' : '瀏覽器'} · ${e.os || 'unknown'}`;
    if (!map.has(label)) map.set(label, { label, sessions: 0, bookings: 0 });
    const row = map.get(label); row.sessions += 1; if (sessionMap.get(id)?.booked) row.bookings += 1;
  }
  return [...map.values()].map(x => ({ ...x, conversionRate: pct(x.bookings, x.sessions) })).sort((a, b) => b.sessions - a.sessions);
}

function dailyTrend(events, start, days) {
  const rows = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    rows.set(d, { date: d, visitors: new Set(), sessions: new Set(), bookingSessions: new Set(), views: 0 });
  }
  for (const e of events) {
    const row = rows.get(dayKey(e.created_at)); if (!row) continue;
    row.visitors.add(visitor(e)); row.sessions.add(sid(e));
    if (isBooking(e)) row.bookingSessions.add(sid(e));
    if (e.event_name === 'map_restaurant_view') row.views += 1;
  }
  return [...rows.values()].map(x => ({ date: x.date, visitors: x.visitors.size, sessions: x.sessions.size, bookingSessions: x.bookingSessions.size, views: x.views }));
}

function recentJourneys(events) {
  const map = new Map();
  for (const e of [...events].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    const id = sid(e), p = props(e);
    if (!map.has(id)) map.set(id, { sessionId: id.slice(-8), visitor: visitor(e).slice(-8), startedAt: e.created_at, endedAt: e.created_at, source: p.entry_source || 'unknown', platform: `${e.is_in_line ? 'LINE' : 'Web'} / ${e.os || 'unknown'}`, steps: [], restaurants: new Set(), booked: false });
    const row = map.get(id); row.endedAt = e.created_at;
    const labels = {
      map_open: '開地圖', map_search: '搜尋', map_filter_toggle: '篩選', map_sheet_open: '開列表',
      map_decide_click: '擲骰子', map_restaurant_view: '看餐廳', map_favorite_toggle: '收藏', map_share_click: '分享', map_booking_click: '訂位',
    };
    if (labels[e.event_name] && row.steps[row.steps.length - 1] !== labels[e.event_name]) row.steps.push(labels[e.event_name]);
    if (p.name && (e.event_name === 'map_restaurant_view' || isBooking(e))) row.restaurants.add(p.name);
    if (isBooking(e)) row.booked = true;
  }
  return [...map.values()].map(x => ({ ...x, restaurants: [...x.restaurants].slice(0, 3), steps: x.steps.slice(0, 12), durationSeconds: Math.max(0, Math.round((new Date(x.endedAt) - new Date(x.startedAt)) / 1000)) })).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 30);
}

function buildInsights(current, previous, features, events) {
  const insights = [];
  const convDelta = delta(current.sessionConversionRate, previous.sessionConversionRate);
  insights.push({
    level: convDelta != null && convDelta < -0.1 ? 'warning' : 'info',
    title: `訂位轉換率 ${Math.round(current.sessionConversionRate * 1000) / 10}%`,
    body: convDelta == null ? '目前尚無完整前期基準；累積一個週期後可判斷成長。' : `較前期${convDelta >= 0 ? '上升' : '下降'} ${Math.abs(Math.round(convDelta * 1000) / 10)}%。`,
    action: convDelta != null && convDelta < 0 ? '先檢查曝光高、訂位率低的餐廳與主要流量來源。' : '持續放大高轉換來源與功能。',
  });
  const funnel = current.funnel;
  let biggest = null;
  for (let i = 1; i < funnel.length; i++) {
    const drop = 1 - pct(funnel[i].sessions, funnel[i - 1].sessions);
    if (!biggest || drop > biggest.drop) biggest = { from: funnel[i - 1].label, to: funnel[i].label, drop };
  }
  if (biggest) insights.push({ level: biggest.drop > 0.6 ? 'warning' : 'info', title: `最大流失：${biggest.from} → ${biggest.to}`, body: `流失 ${Math.round(biggest.drop * 1000) / 10}% 的 session。`, action: biggest.to === '前往訂位' ? '優先檢查 CTA、優惠資格文案與可訂位店比例。' : '檢查入口是否清楚提示下一步。' });
  const winner = features.filter(x => x.sessions >= 5 && x.lift != null).sort((a, b) => b.lift - a.lift)[0];
  if (winner) insights.push({ level: 'opportunity', title: `使用「${winner.name}」的 session 轉換率最高`, body: `訂位率 ${Math.round(winner.conversionRate * 1000) / 10}%，較整體高 ${Math.round(winner.lift * 100)}%；目前是相關性，不代表因果。`, action: `把部分新訪客導向「${winner.name}」做入口測試，驗證是否真的提升訂位。` });
  const searches = events.filter(e => e.event_name === 'map_search');
  const zeros = searches.filter(e => props(e).zero_result === true || Number(props(e).hits) === 0).length;
  if (searches.length) insights.push({ level: pct(zeros, searches.length) > 0.2 ? 'warning' : 'info', title: `搜尋無結果率 ${Math.round(pct(zeros, searches.length) * 1000) / 10}%`, body: `${zeros} / ${searches.length} 次搜尋沒有結果。`, action: '查看搜尋分類與資料涵蓋，補同義詞或熱門缺口；為保護隱私，後台不保存原始搜尋詞。' });
  return insights;
}

function stripInternal(summary) {
  const { sessionMap, ...rest } = summary; return rest;
}

function buildAnalytics(events, { days = 30, now = new Date() } = {}) {
  const end = new Date(now); const currentStart = new Date(end.getTime() - days * 86400000); const previousStart = new Date(end.getTime() - days * 2 * 86400000);
  const currentEvents = events.filter(e => new Date(e.created_at) >= currentStart && new Date(e.created_at) <= end);
  const previousEvents = events.filter(e => new Date(e.created_at) >= previousStart && new Date(e.created_at) < currentStart);
  const current = periodSummary(currentEvents), previous = periodSummary(previousEvents);
  const features = featurePerformance(currentEvents, current.sessionMap);
  const visitorCoverage = pct(currentEvents.filter(e => props(e).visitor_id).length, currentEvents.length);
  return {
    generatedAt: new Date().toISOString(), days,
    overview: { ...stripInternal(current), changes: {
      visitors: delta(current.visitors, previous.visitors), sessions: delta(current.sessions, previous.sessions),
      bookingSessions: delta(current.bookingSessions, previous.bookingSessions), conversionRate: delta(current.sessionConversionRate, previous.sessionConversionRate),
    } },
    previous: stripInternal(previous), daily: dailyTrend(currentEvents, currentStart, days),
    features, restaurants: restaurantPerformance(currentEvents), sources: sourcePerformance(currentEvents, current.sessionMap), platforms: platformPerformance(currentEvents, current.sessionMap),
    insights: buildInsights(current, previous, features, currentEvents), journeys: recentJourneys(currentEvents),
    dataQuality: { eventCount: currentEvents.length, lastEventAt: currentEvents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]?.created_at || null, visitorCoverage, note: '匿名彙總；不保存精準位置與原始搜尋詞。' },
  };
}

function csvEscape(value) { const s = String(value ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function eventsToCsv(events) {
  const headers = ['time', 'anonymous_visitor', 'session', 'event', 'entry_source', 'restaurant', 'or_id', 'feature_source', 'hits'];
  const rows = events.map(e => { const p = props(e); return [e.created_at, visitor(e).slice(-12), sid(e), e.event_name, p.entry_source, p.name, p.or_id, p.source, p.hits]; });
  return [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
}

module.exports = { buildAnalytics, eventsToCsv, periodSummary };
