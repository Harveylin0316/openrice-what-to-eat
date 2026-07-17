const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAnalytics, eventsToCsv } = require('../netlify/functions/lib/analytics');
const { handler: trackHandler } = require('../netlify/functions/track');

function event(event_name, session_id, created_at, properties = {}, extra = {}) {
  return { event_name, session_id, created_at, properties: { visitor_id: `v-${session_id}`, entry_source: 'direct', ...properties }, is_in_line: true, os: 'ios', ...extra };
}

test('buildAnalytics produces user funnel, conversion and restaurant performance', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const events = [
    event('map_open', 's1', '2026-07-16T01:00:00Z'),
    event('map_search', 's1', '2026-07-16T01:01:00Z', { hits: 3, zero_result: false }),
    event('map_restaurant_view', 's1', '2026-07-16T01:02:00Z', { or_id: 10, name: '好店', source: 'search' }),
    event('map_booking_click', 's1', '2026-07-16T01:03:00Z', { or_id: 10, name: '好店', source: 'search' }),
    event('map_open', 's2', '2026-07-16T02:00:00Z'),
    event('map_decide_click', 's2', '2026-07-16T02:01:00Z'),
    event('map_restaurant_view', 's2', '2026-07-16T02:02:00Z', { or_id: 10, name: '好店', source: 'dice' }),
  ];
  const data = buildAnalytics(events, { days: 7, now });
  assert.equal(data.overview.sessions, 2);
  assert.equal(data.overview.users, 2);
  assert.equal(data.overview.bookingUsers, 1);
  assert.equal(data.overview.userConversionRate, 0.5);
  assert.equal(data.overview.bookingSessions, 1);
  assert.deepEqual(data.overview.funnel.map(x => x.users), [2, 2, 2, 1]);
  assert.equal(data.restaurants[0].name, '好店');
  assert.equal(data.restaurants[0].views, 2);
  assert.equal(data.restaurants[0].bookings, 1);
  assert.ok(data.features.some(x => x.name === '搜尋' && x.bookingUsers === 1));
});

test('same LINE user across sessions is counted once and marked returning', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const events = [
    event('map_open', 's1', '2026-07-16T01:00:00Z', {}, { line_id: 'U-same' }),
    event('map_open', 's2', '2026-07-16T02:00:00Z', {}, { line_id: 'U-same' }),
    event('map_booking_click', 's2', '2026-07-16T02:01:00Z', { or_id: 10 }, { line_id: 'U-same' }),
  ];
  const data = buildAnalytics(events, { days: 7, now });
  assert.equal(data.overview.users, 1);
  assert.equal(data.overview.sessions, 2);
  assert.equal(data.overview.returningUsers, 1);
  assert.equal(data.overview.returnRate, 1);
  assert.equal(data.overview.bookingUsers, 1);
});

test('pre-LIFF device event is merged into later LINE identity for the same visitor', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const events = [
    event('map_open', 's1', '2026-07-16T01:00:00Z', { visitor_id: 'device-a' }),
    event('app_open', 's1', '2026-07-16T01:00:01Z', { visitor_id: 'device-a' }, { line_id: 'U-later' }),
  ];
  const data = buildAnalytics(events, { days: 7, now });
  assert.equal(data.overview.users, 1);
});

test('search quality uses completed intent and calibrates legacy typing events by final session result', () => {
  const now = new Date('2026-07-17T12:00:00Z');
  const completed = buildAnalytics([
    event('map_search_complete', 's1', '2026-07-16T01:00:00Z', { hits: 0, zero_result: true, had_zero_result: true, outcome: 'selected', used_fallback: true }),
  ], { days: 7, now });
  assert.equal(completed.searchQuality.intents, 1);
  assert.equal(completed.searchQuality.zeroRate, 1);
  assert.equal(completed.searchQuality.recoveryRate, 1);

  const legacy = buildAnalytics([
    event('map_search', 's1', '2026-07-16T01:00:00Z', { hits: 0, zero_result: true }),
    event('map_search', 's1', '2026-07-16T01:00:01Z', { hits: 8, zero_result: false }),
  ], { days: 7, now });
  assert.equal(legacy.searchQuality.intents, 1);
  assert.equal(legacy.searchQuality.zeroRate, 0);
  assert.equal(legacy.searchQuality.method, 'legacy_session_final');
});

test('CSV export is anonymous and omits raw LINE id and search query', () => {
  const rows = [event('map_search', 'session-secret', '2026-07-16T01:00:00Z', { query: '私人搜尋內容', hits: 0 }, { line_id: 'U-raw-line-id' })];
  const csv = eventsToCsv(rows);
  assert.match(csv, /anonymous_visitor/);
  assert.doesNotMatch(csv, /U-raw-line-id/);
  assert.doesNotMatch(csv, /私人搜尋內容/);
});

test('old events without visitor id remain countable', () => {
  const data = buildAnalytics([{ event_name: 'map_open', session_id: 'legacy', line_id: 'sha256:x', properties: {}, created_at: '2026-07-16T00:00:00Z' }], { days: 7, now: new Date('2026-07-17T00:00:00Z') });
  assert.equal(data.overview.visitors, 1);
  assert.equal(data.overview.sessions, 1);
});

test('tracking endpoint validates method, payload size and identifiers before storage', async () => {
  assert.equal((await trackHandler({ httpMethod: 'OPTIONS' })).statusCode, 204);
  assert.equal((await trackHandler({ httpMethod: 'POST', body: '{' })).statusCode, 400);
  assert.equal((await trackHandler({ httpMethod: 'POST', body: 'x'.repeat(16385) })).statusCode, 413);
  assert.equal((await trackHandler({ httpMethod: 'POST', body: JSON.stringify({ event_name: 'bad event', session_id: 's1' }) })).statusCode, 400);
});
