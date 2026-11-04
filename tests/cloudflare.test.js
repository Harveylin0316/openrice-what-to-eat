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
  const edgeCache = {
    match: async () => value ? value.clone() : undefined,
    put: async (_key, response) => { value = response.clone(); }
  };
  const store = parkingStore(edgeCache);
  await assert.rejects(store.write({}));
  await refreshParking(store, async () => Response.json({ data: { park: [{ id: '1', availablecar: 4 }] } }));
  assert.equal((await store.read()).map['1'], 4);
  assert.equal(value.headers.get('Cache-Control'), 'public, max-age=60');
  const stale = await value.json();
  stale.at = Date.now() - 301000;
  value = Response.json(stale);
  assert.equal(await store.read(), null);
  await assert.rejects(refreshParking(store, async () => new Response('', { status: 500 })));
});

test('Cloudflare standby has no shared KV bindings or background parking writes', async () => {
  const fs = require('node:fs');
  const config = JSON.parse(fs.readFileSync(require.resolve('../wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(config.kv_namespaces, []);
  assert.deepEqual(config.triggers.crons, []);
  assert.equal((await loaded).default.scheduled, undefined);
  const health = await call('/healthz', {}, { ...env, get PARKING_CACHE() { throw new Error('KV must not be accessed'); } });
  assert.equal((await health.json()).parkingCache, 'edge-on-demand');
});

test('Cold edge parking cache is a miss and a warm cache preserves its source timestamp', async () => {
  const { parkingStore } = await import('../cloudflare/parking-store.mjs');
  let value;
  const store = parkingStore({
    match: async () => value?.clone(),
    put: async (_key, response) => { value = response.clone(); }
  });
  assert.equal(await store.read(), null);
  await store.write({ '42': 7 });
  const first = await store.read();
  const second = await store.read();
  assert.equal(second.at, first.at);
  assert.equal(second.map['42'], 7);
});
