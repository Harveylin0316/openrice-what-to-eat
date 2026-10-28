const test = require('node:test');
const assert = require('node:assert/strict');
process.env.CLOUDFLARE_MIGRATION = '1';
const loaded = import('../cloudflare/worker.mjs');
const cache = { match: async () => null, put: async () => {} };
const env = {
  MIGRATION_MODE: 'validation',
  ASSETS: { fetch: async req => new URL(req.url).pathname === '/liff/index.html'
    ? new Response('<html>map</html>') : new Response('', { status: 404 }) }
};
const call = async (path, options, bindings = env) => (await loaded).handle(new Request('https://map.example' + path, options), bindings, {}, cache);

test('Workers canonical entry preserves campaign query', async () => {
  const r = await call('/?utm_source=line');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://map.example/liff/?utm_source=line');
});
test('Workers API routes never fall through to HTML', async () => {
  assert.equal((await call('/api/missing')).status, 404);
  assert.equal((await call('/.netlify/functions/admin')).status, 404);
  assert.equal((await call('/liff/missing.js')).status, 404);
  assert.equal((await call('/liff/map')).status, 200);
});
test('Workers validation blocks real writes and legacy mutating GET', async () => {
  for (const path of ['/api/track', '/api/admin/prizes']) {
    assert.equal((await call(path, { method: 'POST', body: '{}' })).status, 503);
  }
  assert.equal((await call('/api/lottery/user?lineId=Ufake')).status, 503);
});
test('Workers rejects cross-origin writes even when live', async () => {
  const r = await call('/api/track', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }, { ...env, MIGRATION_MODE: 'live' });
  assert.equal(r.status, 403);
});
test('Workers restaurant routes read bundled canonical catalog', async () => {
  for (const path of ['filter-options', 'location-options', 'all', 'with-booking-offers', 'sponsored', 'recommend?limit=2']) {
    const r = await call('/api/restaurants/' + path);
    assert.equal(r.status, 200, path);
    const j = await r.json();
    assert.equal(j.success, true, path);
    if (j.restaurants) assert.ok(j.restaurants.every(x => ['台北市', '新北市', '基隆市'].includes(x.city)));
  }
});
test('Workers cache keeps original timestamps and rejects empty parking snapshots', async () => {
  const { parkingStore, refreshParking } = await import('../cloudflare/parking-store.mjs');
  let value;
  const kv = { get: async () => value, put: async (_key, text) => { value = JSON.parse(text); } };
  const store = parkingStore({ PARKING_CACHE: kv }, cache);
  await assert.rejects(store.write({}));
  await refreshParking(store, async () => Response.json({ data: { park: [{ id: '1', availablecar: 4 }] } }));
  assert.equal((await store.read()).map['1'], 4);
  value.at = Date.now() - 301000;
  assert.equal(await store.read(), null);
  await assert.rejects(refreshParking(store, async () => new Response('', { status: 500 })));
});
