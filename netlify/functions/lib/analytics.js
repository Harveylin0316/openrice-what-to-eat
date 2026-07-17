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
function lineUserId(lineId) {
  const raw = String(lineId);
  const digest = raw.startsWith('sha256:') ? raw.slice(7) : crypto.createHash('sha256').update(raw).digest('hex');
  return `line_${digest.slice(0, 24)}`;
}
function visitor(e) {
  if (e._user_id) return e._user_id;
  // LINE ID 跨 session 較穩定，優先作為匿名 user key；舊 raw ID 與新版 sha256:ID 正規化成同一值。
  if (e.line_id) return lineUserId(e.line_id);
  if (props(e).visitor_id) return `visitor_${String(props(e).visitor_id)}`;
  return `session_${crypto.createHash('sha256').update(String(e.session_id || 'unknown')).digest('hex').slice(0, 16)}`;
}

function resolveUsers(events) {
  const visitorToLine = new Map();
  for (const e of events) {
    const deviceId = props(e).visitor_id;
    if (deviceId && e.line_id) visitorToLine.set(String(deviceId), lineUserId(e.line_id));
  }
  return events.map(e => {
    const deviceId = props(e).visitor_id;
    const userId = e.line_id ? lineUserId(e.line_id)
      : deviceId && visitorToLine.get(String(deviceId))
        ? visitorToLine.get(String(deviceId))
        : visitor(e);
    return { ...e, _user_id: userId };
  });
}
function pct(n, d) { return d ? n / d : 0; }
function dayKey(value) { return String(value || '').slice(0, 10); }
function delta(current, previous) { return previous ? (current - previous) / previous : null; }
function isBooking(e) { return BOOKING_EVENTS.has(e.event_name); }

function periodSummary(events) {
  const sessions = new Map();
  const users = new Map();
  const bookingClicksByUser = new Map();
  let views = 0, bookings = 0, shares = 0, favoriteAdds = 0, durationTotal = 0, durationCount = 0;
  for (const e of events) {
    const s = sid(e);
    if (!sessions.has(s)) sessions.set(s, { opened: false, discovered: false, viewed: false, booked: false, events: [] });
    const state = sessions.get(s);
    state.events.push(e);
    const uid = visitor(e);
    if (!users.has(uid)) users.set(uid, { opened: false, discovered: false, viewed: false, booked: false, sessionIds: new Set(), events: [] });
    const user = users.get(uid); user.sessionIds.add(s); user.events.push(e);
    const opened = e.event_name === 'app_open' || e.event_name === 'map_open' || e.event_name === 'analytics_session_start';
    const discovered = DISCOVERY_EVENTS.has(e.event_name) || e.event_name === 'map_search_start' || e.event_name === 'map_search_complete';
    if (opened) { state.opened = true; user.opened = true; }
    if (discovered) { state.discovered = true; user.discovered = true; }
    if (VIEW_EVENTS.has(e.event_name)) { state.viewed = true; user.viewed = true; }
    if (isBooking(e)) {
      state.booked = true; user.booked = true;
      bookingClicksByUser.set(uid, (bookingClicksByUser.get(uid) || 0) + 1);
    }
    if (VIEW_EVENTS.has(e.event_name)) views += 1;
    if (isBooking(e)) bookings += 1;
    if (e.event_name === 'map_share_click') shares += 1;
    if (e.event_name === 'map_favorite_toggle' && props(e).favorite === true) favoriteAdds += 1;
    if (e.event_name === 'analytics_session_end' && Number.isFinite(Number(props(e).duration_ms))) {
      durationTotal += Number(props(e).duration_ms); durationCount += 1;
    }
  }
  const values = [...sessions.values()];
  const userValues = [...users.values()];
  const bookingSessions = values.filter(x => x.booked).length;
  const bookingUsers = userValues.filter(x => x.booked).length;
  const engagedSessions = values.filter(x => x.events.length >= 3 || x.viewed || x.booked).length;
  const engagedUsers = userValues.filter(x => x.events.length >= 3 || x.viewed || x.booked).length;
  const returningUsers = userValues.filter(x => x.sessionIds.size >= 2).length;
  const clickCounts = [...bookingClicksByUser.values()].sort((a, b) => b - a);
  const topCount = Math.max(1, Math.ceil(clickCounts.length * 0.1));
  const top10Clicks = clickCounts.slice(0, topCount).reduce((sum, n) => sum + n, 0);
  return {
    visitors: users.size, users: users.size, sessions: sessions.size, engagedSessions, engagedUsers, restaurantViews: views,
    bookingClicks: bookings, bookingSessions, sessionConversionRate: pct(bookingSessions, sessions.size),
    bookingUsers, userConversionRate: pct(bookingUsers, users.size), returningUsers,
    returnRate: pct(returningUsers, users.size), sessionsPerUser: pct(sessions.size, users.size),
    avgBookingClicksPerBookingUser: pct(bookings, bookingUsers),
    topBookingUserClickShare: pct(clickCounts[0] || 0, bookings), top10PercentBookingClickShare: pct(top10Clicks, bookings),
    shareClicks: shares, favoriteAdds, avgSessionSeconds: durationCount ? Math.round(durationTotal / durationCount / 1000) : null,
    funnel: [
      { key: 'opened', label: '開啟地圖', users: userValues.filter(x => x.opened).length },
      { key: 'discovered', label: '探索餐廳', users: userValues.filter(x => x.discovered).length },
      { key: 'viewed', label: '查看餐廳', users: userValues.filter(x => x.viewed).length },
      { key: 'booked', label: '前往訂位', users: bookingUsers },
    ],
    sessionMap: sessions, userMap: users,
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

function featurePerformance(events, allUsers) {
  const map = new Map();
  for (const e of events) {
    const feature = featureFor(e);
    if (!feature) continue;
    if (!map.has(feature)) map.set(feature, new Set());
    map.get(feature).add(visitor(e));
  }
  const baseBookingUsers = [...allUsers.values()].filter(x => x.booked).length;
  const baseRate = pct(baseBookingUsers, allUsers.size);
  return [...map.entries()].map(([name, ids]) => {
    const bookings = [...ids].filter(id => allUsers.get(id)?.booked).length;
    const conversionRate = pct(bookings, ids.size);
    return { name, users: ids.size, bookingUsers: bookings, conversionRate, lift: baseRate ? conversionRate / baseRate - 1 : null };
  }).sort((a, b) => b.users - a.users);
}

function restaurantPerformance(events) {
  const map = new Map();
  for (const e of events) {
    if (!VIEW_EVENTS.has(e.event_name) && !isBooking(e) && e.event_name !== 'map_share_click' && e.event_name !== 'map_favorite_toggle') continue;
    const p = props(e); const id = p.or_id; const name = p.name;
    if (id == null && !name) continue;
    const key = String(id ?? name);
    if (!map.has(key)) map.set(key, { orId: id ?? null, name: name || `餐廳 ${id}`, viewUsers: new Set(), bookingUsers: new Set(), shares: 0, favorites: 0, sources: {} });
    const row = map.get(key);
    if (VIEW_EVENTS.has(e.event_name)) {
      row.viewUsers.add(visitor(e));
      const source = p.source || featureFor(e) || 'unknown';
      row.sources[source] = (row.sources[source] || 0) + 1;
    }
    if (isBooking(e)) row.bookingUsers.add(visitor(e));
    if (e.event_name === 'map_share_click') row.shares += 1;
    if (e.event_name === 'map_favorite_toggle' && p.favorite === true) row.favorites += 1;
  }
  return [...map.values()].map(row => ({
    orId: row.orId, name: row.name, viewUsers: row.viewUsers.size, bookingUsers: row.bookingUsers.size,
    views: row.viewUsers.size, bookings: row.bookingUsers.size,
    shares: row.shares, favorites: row.favorites, bookingRate: pct(row.bookingUsers.size, row.viewUsers.size),
    mainSource: Object.entries(row.sources).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown',
  })).sort((a, b) => b.bookings - a.bookings || b.views - a.views).slice(0, 100);
}

function sourcePerformance(events, userMap) {
  const users = new Map();
  const sorted = [...events].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const e of sorted) {
    const id = visitor(e); if (users.has(id)) continue;
    users.set(id, { source: props(e).entry_source || 'unknown' });
  }
  const grouped = new Map();
  for (const [id, user] of users) {
    if (!grouped.has(user.source)) grouped.set(user.source, { users: 0, bookingUsers: 0 });
    const row = grouped.get(user.source); row.users += 1; if (userMap.get(id)?.booked) row.bookingUsers += 1;
  }
  return [...grouped.entries()].map(([source, row]) => ({ source, ...row, conversionRate: pct(row.bookingUsers, row.users) })).sort((a, b) => b.users - a.users);
}

function platformPerformance(events, userMap) {
  const first = new Map();
  for (const e of events) if (!first.has(visitor(e))) first.set(visitor(e), e);
  const map = new Map();
  for (const [id, e] of first) {
    const label = `${e.is_in_line ? 'LINE 內' : '瀏覽器'} · ${e.os || 'unknown'}`;
    if (!map.has(label)) map.set(label, { label, users: 0, bookingUsers: 0 });
    const row = map.get(label); row.users += 1; if (userMap.get(id)?.booked) row.bookingUsers += 1;
  }
  return [...map.values()].map(x => ({ ...x, conversionRate: pct(x.bookingUsers, x.users) })).sort((a, b) => b.users - a.users);
}

function dailyTrend(events, start, days) {
  const rows = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    rows.set(d, { date: d, visitors: new Set(), sessions: new Set(), bookingUsers: new Set(), views: 0 });
  }
  for (const e of events) {
    const row = rows.get(dayKey(e.created_at)); if (!row) continue;
    row.visitors.add(visitor(e)); row.sessions.add(sid(e));
    if (isBooking(e)) row.bookingUsers.add(visitor(e));
    if (e.event_name === 'map_restaurant_view') row.views += 1;
  }
  return [...rows.values()].map(x => ({ date: x.date, users: x.visitors.size, visitors: x.visitors.size, sessions: x.sessions.size, bookingUsers: x.bookingUsers.size, views: x.views }));
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

function searchQuality(events) {
  let intents = events.filter(e => e.event_name === 'map_search_complete');
  let method = 'complete';
  if (!intents.length) {
    // r57 舊事件會隨逐字輸入重複送出；每個 session 只取最後一次，避免把半成品當失敗搜尋。
    const lastBySession = new Map();
    for (const e of events.filter(x => x.event_name === 'map_search').sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) lastBySession.set(sid(e), e);
    intents = [...lastBySession.values()];
    method = 'legacy_session_final';
  }
  const zeroIntents = intents.filter(e => props(e).zero_result === true || Number(props(e).hits) === 0).length;
  const searchUsers = new Set(intents.map(visitor));
  const selectedIntents = intents.filter(e => props(e).outcome === 'selected').length;
  const recovered = intents.filter(e => props(e).had_zero_result === true && (Number(props(e).hits) > 0 || props(e).used_fallback === true)).length;
  const hadZero = intents.filter(e => props(e).had_zero_result === true).length;
  return {
    intents: intents.length, users: searchUsers.size, zeroIntents, zeroRate: pct(zeroIntents, intents.length),
    selectedIntents, selectionRate: pct(selectedIntents, intents.length), recovered, recoveryRate: pct(recovered, hadZero), method,
  };
}

function buildInsights(current, previous, features, quality) {
  const insights = [];
  const convDelta = delta(current.userConversionRate, previous.userConversionRate);
  insights.push({
    level: convDelta != null && convDelta < -0.1 ? 'warning' : 'info',
    title: `使用者訂位轉換率 ${Math.round(current.userConversionRate * 1000) / 10}%`,
    body: convDelta == null ? '目前尚無完整前期基準；累積一個週期後可判斷成長。' : `較前期${convDelta >= 0 ? '上升' : '下降'} ${Math.abs(Math.round(convDelta * 1000) / 10)}%。`,
    action: convDelta != null && convDelta < 0 ? '先檢查曝光高、訂位率低的餐廳與主要流量來源。' : '持續放大高轉換來源與功能。',
  });
  const funnel = current.funnel;
  let biggest = null;
  for (let i = 1; i < funnel.length; i++) {
    const drop = 1 - pct(funnel[i].users, funnel[i - 1].users);
    if (!biggest || drop > biggest.drop) biggest = { from: funnel[i - 1].label, to: funnel[i].label, drop };
  }
  if (biggest) insights.push({ level: biggest.drop > 0.6 ? 'warning' : 'info', title: `最大流失：${biggest.from} → ${biggest.to}`, body: `流失 ${Math.round(biggest.drop * 1000) / 10}% 的使用者。`, action: biggest.to === '前往訂位' ? '優先檢查 CTA、優惠資格文案與可訂位店比例。' : '檢查入口是否清楚提示下一步。' });
  const winner = features.filter(x => x.users >= 5 && x.lift != null).sort((a, b) => b.lift - a.lift)[0];
  if (winner) insights.push({ level: 'opportunity', title: `使用「${winner.name}」的使用者轉換率最高`, body: `訂位率 ${Math.round(winner.conversionRate * 1000) / 10}%，較整體高 ${Math.round(winner.lift * 100)}%；目前是相關性，不代表因果。`, action: `把部分新使用者導向「${winner.name}」做入口測試，驗證是否真的提升訂位。` });
  if (quality.intents) {
    const legacy = quality.method === 'legacy_session_final';
    insights.push({
      level: quality.zeroRate > 0.3 ? 'warning' : 'info',
      title: `搜尋最終無結果率 ${Math.round(quality.zeroRate * 1000) / 10}%${legacy ? '（校正估算）' : ''}`,
      body: `${quality.users} 位使用者、${quality.intents} 次搜尋意圖，最終 ${quality.zeroIntents} 次無結果。${legacy ? '舊版逐字輸入會重複計數，已改以每個 Session 最後結果估算。' : ''}`,
      action: '持續看「最終無結果」與無結果後恢復率，不再把輸入中的半成品當搜尋失敗。',
    });
  }
  if (current.bookingClicks >= 10 && current.topBookingUserClickShare >= 0.3) {
    insights.push({
      level: 'warning',
      title: '訂位點擊集中在少數使用者',
      body: `單一使用者占 ${Math.round(current.topBookingUserClickShare * 1000) / 10}% 訂位點擊；每位訂位使用者平均點 ${Math.round(current.avgBookingClicksPerBookingUser * 10) / 10} 次。`,
      action: '主 KPI 應看「前往訂位使用者」，點擊次數只作意圖強度；後續再與實際完成訂位資料對接。',
    });
  }
  return insights;
}

function stripInternal(summary) {
  const { sessionMap, userMap, ...rest } = summary; return rest;
}

function buildAnalytics(events, { days = 30, now = new Date() } = {}) {
  events = resolveUsers(events);
  const end = new Date(now); const currentStart = new Date(end.getTime() - days * 86400000); const previousStart = new Date(end.getTime() - days * 2 * 86400000);
  const currentEvents = events.filter(e => new Date(e.created_at) >= currentStart && new Date(e.created_at) <= end);
  const previousEvents = events.filter(e => new Date(e.created_at) >= previousStart && new Date(e.created_at) < currentStart);
  const current = periodSummary(currentEvents), previous = periodSummary(previousEvents);
  const features = featurePerformance(currentEvents, current.userMap);
  const quality = searchQuality(currentEvents);
  const visitorCoverage = pct(currentEvents.filter(e => props(e).visitor_id).length, currentEvents.length);
  return {
    generatedAt: new Date().toISOString(), days,
    overview: { ...stripInternal(current), changes: {
      visitors: delta(current.visitors, previous.visitors), sessions: delta(current.sessions, previous.sessions),
      bookingUsers: delta(current.bookingUsers, previous.bookingUsers), bookingSessions: delta(current.bookingSessions, previous.bookingSessions),
      conversionRate: delta(current.userConversionRate, previous.userConversionRate), returnRate: delta(current.returnRate, previous.returnRate),
    } },
    previous: stripInternal(previous), daily: dailyTrend(currentEvents, currentStart, days),
    features, restaurants: restaurantPerformance(currentEvents), sources: sourcePerformance(currentEvents, current.userMap), platforms: platformPerformance(currentEvents, current.userMap),
    searchQuality: quality, insights: buildInsights(current, previous, features, quality), journeys: recentJourneys(currentEvents),
    dataQuality: { eventCount: currentEvents.length, lastEventAt: currentEvents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]?.created_at || null, visitorCoverage, stableLineUserCoverage: pct(currentEvents.filter(e => e.line_id).length, currentEvents.length), note: '優先使用雜湊 LINE ID 辨識跨 Session 使用者；LINE 外以匿名裝置 ID 補足。不保存精準位置與原始搜尋詞。' },
  };
}

function csvEscape(value) { const s = String(value ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function eventsToCsv(events) {
  const headers = ['time', 'anonymous_visitor', 'session', 'event', 'entry_source', 'restaurant', 'or_id', 'feature_source', 'hits'];
  const rows = resolveUsers(events).map(e => { const p = props(e); return [e.created_at, visitor(e).slice(-12), sid(e), e.event_name, p.entry_source, p.name, p.or_id, p.source, p.hits]; });
  return [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n');
}

module.exports = { buildAnalytics, eventsToCsv, periodSummary };
