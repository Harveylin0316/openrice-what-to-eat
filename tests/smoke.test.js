const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function netlifyRedirects() {
  const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
  return toml.split('[[redirects]]').slice(1).map(block => ({
    from: block.match(/\bfrom\s*=\s*"([^"]+)"/)?.[1],
    to: block.match(/\bto\s*=\s*"([^"]+)"/)?.[1],
    status: Number(block.match(/\bstatus\s*=\s*(\d+)/)?.[1]),
    force: block.match(/\bforce\s*=\s*(true|false)/)?.[1] === 'true',
  }));
}

test('public entry points redirect to LIFF while API and LIFF routes win first', () => {
  const redirects = netlifyRedirects();
  const rootRedirect = redirects.find(rule => rule.from === '/');
  const indexRedirect = redirects.find(rule => rule.from === '/index.html');
  const catchAllIndex = redirects.findIndex(rule => rule.from === '/*');

  assert.deepEqual(rootRedirect, { from: '/', to: '/liff/', status: 301, force: true });
  assert.deepEqual(indexRedirect, { from: '/index.html', to: '/liff/', status: 301, force: true });
  assert.ok(catchAllIndex >= 0);
  assert.equal(redirects[catchAllIndex].to, '/liff/');
  assert.equal(redirects[catchAllIndex].status, 301);

  for (const pathPrefix of ['/api/restaurants/*', '/api/parking/*', '/api/lottery/*', '/api/admin/*', '/api/webhook', '/api/track', '/liff/*']) {
    const routeIndex = redirects.findIndex(rule => rule.from === pathPrefix);
    assert.ok(routeIndex >= 0, `missing preserved route: ${pathPrefix}`);
    assert.ok(routeIndex < catchAllIndex, `${pathPrefix} must precede the public catch-all`);
  }
});

test('legacy root HTML is a redirect shell and no longer contains the old recommender UI', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/web/index.html'), 'utf8');
  assert.match(html, /location\.replace\('\/liff\/'/);
  assert.match(html, /http-equiv="refresh" content="0; url=\/liff\/"/);
  assert.doesNotMatch(html, /推薦我|附近餐廳|restaurantList/);
});

test('critical LIFF cache-buster versions stay aligned', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/liff/index.html'), 'utf8');
  const cssVersion = html.match(/map\.css\?v=(r\d+)/)?.[1];
  const jsVersion = html.match(/window\.__V\s*=\s*'(r\d+)'/)?.[1];

  assert.ok(cssVersion, 'map.css version is missing');
  assert.ok(jsVersion, 'window.__V is missing');
  assert.equal(cssVersion, jsVersion);
  assert.match(html, /router\.js\?v=' \+ window\.__V/);
});

test('LIFF decision UX keeps the five core guidance improvements', () => {
  const mapJs = fs.readFileSync(path.join(root, 'frontend/liff/pages/map.js'), 'utf8');
  const mapCss = fs.readFileSync(path.join(root, 'frontend/liff/map.css'), 'utf8');

  assert.match(mapJs, /查看附近 \$\{total\} 間餐廳/);
  assert.match(mapJs, /開啟定位後，才能顯示附近餐廳、距離與步行時間/);
  assert.match(mapJs, /requestInitialLocation\(\)/);
  assert.match(mapJs, /data-spotlight-fav/);
  assert.match(mapJs, /data-spotlight-share/);
  assert.match(mapJs, /停車場導航/);
  assert.match(mapJs, /餐廳導航/);
  assert.match(mapJs, /<strong>回饋資格<\/strong>/);
  assert.match(mapCss, /transform: translateY\(calc\(100% - 68px/);
  assert.match(mapCss, /\.map-spotlight__actions \{[\s\S]*?grid-template-columns: repeat\(3/);
});

test('generated map data has valid counts, unique ids and coordinates', () => {
  const map = readJson('frontend/liff/data/map_pins.json');
  assert.equal(map.count, map.pins.length);
  assert.ok(map.pins.length > 0);

  const ids = new Set();
  for (const pin of map.pins) {
    assert.ok(pin.id != null, 'pin id is required');
    assert.equal(ids.has(String(pin.id)), false, `duplicate pin id: ${pin.id}`);
    ids.add(String(pin.id));
    assert.ok(Number.isFinite(Number(pin.lat)), `invalid latitude: ${pin.id}`);
    assert.ok(Number.isFinite(Number(pin.lng)), `invalid longitude: ${pin.id}`);
    assert.ok(Number(pin.lat) >= -90 && Number(pin.lat) <= 90);
    assert.ok(Number(pin.lng) >= -180 && Number(pin.lng) <= 180);
  }
});

test('generated overlay and external POI metadata match their payloads', () => {
  const overlay = readJson('frontend/liff/data/partner_overlay.json');
  const external = readJson('frontend/liff/data/external_pois.json');
  const photos = readJson('frontend/liff/data/photos.json');

  assert.equal(overlay.partner_count, Object.keys(overlay.partners).length);
  assert.equal(overlay.closed_count, overlay.closed.length);
  assert.equal(external.count, external.pois.length);
  assert.ok(Object.keys(photos).length > 0);
});

test('admin API fails closed and ignores keys outside X-API-Key header', async () => {
  const originalKey = process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_API_KEY;
  const admin = require('../netlify/functions/admin');

  const base = { httpMethod: 'GET', path: '/api/admin/statistics', headers: {} };
  const noConfig = await admin.handler(base, {});
  assert.equal(noConfig.statusCode, 401);

  process.env.ADMIN_API_KEY = 'smoke-test-secret';
  const queryKey = await admin.handler({ ...base, queryStringParameters: { apiKey: 'smoke-test-secret' } }, {});
  assert.equal(queryKey.statusCode, 401);
  const bodyKey = await admin.handler({ ...base, body: JSON.stringify({ apiKey: 'smoke-test-secret' }) }, {});
  assert.equal(bodyKey.statusCode, 401);
  const wrongHeader = await admin.handler({ ...base, headers: { 'x-api-key': 'wrong' } }, {});
  assert.equal(wrongHeader.statusCode, 401);
  const validHeader = await admin.handler({ ...base, path: '/api/admin/not-a-route', headers: { 'x-api-key': 'smoke-test-secret' } }, {});
  assert.equal(validHeader.statusCode, 404);

  if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = originalKey;
});

test('admin page sends keys in headers, uses session storage and escapes rendered data', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/admin/index.html'), 'utf8');
  assert.match(html, /headers\.set\('X-API-Key', apiKey\)/);
  assert.doesNotMatch(html, /\?apiKey=/);
  assert.doesNotMatch(html, /localStorage\.setItem\('admin_api_key'/);
  assert.match(html, /sessionStorage\.setItem\('admin_api_key'/);
  assert.match(html, /escapeHtml\(user\.displayName/);
  assert.match(html, /escapeHtml\(prize\.name/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const script of scripts) new vm.Script(script[1]);
});

test('server code does not log secret values or authorization headers', () => {
  const files = ['netlify/functions/admin.js', 'supabase/client.js'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /SUPABASE_(?:URL|KEY)\.substring/);
    assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*headers\b/);
  }
});

test('parking API rejects invalid coordinate and bbox requests without network access', async () => {
  const parking = require('../netlify/functions/parking');
  const empty = await parking.handler({ queryStringParameters: { lat: '', lng: '' } });
  assert.equal(empty.statusCode, 400);
  const invalidBbox = await parking.handler({ queryStringParameters: { bbox: 'bad' } });
  assert.equal(invalidBbox.statusCode, 400);
});

test('restaurant filter-options route responds successfully', async () => {
  const restaurants = require('../netlify/functions/restaurants');
  const response = await restaurants.handler({
    httpMethod: 'GET',
    path: '/api/restaurants/filter-options',
    queryStringParameters: {},
  });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.success, true);
  assert.ok(body.options);
});
