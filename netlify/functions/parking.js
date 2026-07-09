// 台北市即時停車位 API：回傳查詢點(餐廳)附近的公有停車場 + 即時空位。
// 資料源（臺北市停管處 open data）：
//   靜態(名稱/座標/總車位)：TCMSV_alldesc.json（座標為 TWD97 TM2，需轉 WGS84）
//   即時(剩餘車位)         ：TCMSV_allavailable.json
// 端點：GET /api/parking/nearby?lat=&lng=  → { success, lots:[{name,available,total,walkMin,dist,lat,lng}] }
// 沙盒(開發)連不到台北 API；正式 Netlify function 在公網跑得到。抓不到時靜默回空陣列。

const DESC_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json';
const AVAIL_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json';
const DESC_TTL = 6 * 3600 * 1000;  // 名稱/座標半天更新一次夠了
const AVAIL_TTL = 60 * 1000;       // 即時空位「記憶體」快取 60 秒（分鐘級來源，記憶體命中即回）
const BLOB_AVAIL_TTL = 5 * 60 * 1000; // Blobs 超過 5 分沒更新（排程異常）→ 不採用，退回即時抓
const NEAR_RADIUS_M = 700;         // 只回步行約 10 分內的停車場
const MAX_LOTS = 5;                 // 回最近 5 場，讓前端「優先挑有即時車位數的場」有更多候選（減少「即時不明」）
const WALK_DETOUR = 1.25;          // 直線 → 實際步行的繞路係數（街廓）

// TWD97 TM2 (EPSG:3826) → WGS84。已用往返測試驗證誤差 0.000m。
function twd97ToWGS84(x, y) {
  const a = 6378137.0, b = 6356752.314245;
  const lon0 = 121 * Math.PI / 180, k0 = 0.9999, dx = 250000;
  const e = Math.sqrt(1 - (b * b) / (a * a)), e2 = e * e / (1 - e * e);
  x -= dx;
  const M = y / k0, mu = M / (a * (1 - e * e / 4 - 3 * e ** 4 / 64 - 5 * e ** 6 / 256));
  const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));
  const J1 = 3 * e1 / 2 - 27 * e1 ** 3 / 32, J2 = 21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32;
  const J3 = 151 * e1 ** 3 / 96, J4 = 1097 * e1 ** 4 / 512;
  const fp = mu + J1 * Math.sin(2 * mu) + J2 * Math.sin(4 * mu) + J3 * Math.sin(6 * mu) + J4 * Math.sin(8 * mu);
  const C1 = e2 * Math.cos(fp) ** 2, T1 = Math.tan(fp) ** 2;
  const R1 = a * (1 - e * e) / Math.pow(1 - e * e * Math.sin(fp) ** 2, 1.5);
  const N1 = a / Math.sqrt(1 - e * e * Math.sin(fp) ** 2), D = x / (N1 * k0);
  const lat = fp - (N1 * Math.tan(fp) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 3 * C1 * C1 - 252 * e2) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(fp);
  return { lat: lat * 180 / Math.PI, lng: lon * 180 / Math.PI };
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 逾時保護：台北 API 慢/掛時快速失敗，別讓餐廳卡的「查停車…」轉圈到 function timeout。
// 標記失敗階段（label）+ HTTP 狀態，讓前端能顯示真正原因。
async function fetchJson(url, ms, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) { const e = new Error(`${label} HTTP ${res.status}`); e.stage = label; e.status = res.status; throw e; }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') { const x = new Error(`${label} 逾時`); x.stage = label; x.timeout = true; throw x; }
    if (!e.stage) e.stage = label;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

let descCache = { at: 0, lots: null };
let availCache = { at: 0, map: null };

// 建置時預烤的靜態停車場資料（名稱/座標/總車位）。有內容就用它 → 免在 runtime 抓 2.4MB
// desc（省 ~3.4s/次，尤其 cold start）。缺檔/空檔 → fallback 成即時抓取（正確性不受影響）。
// require 靜態解析：已提交 placeholder 保證檔案永遠存在，bundler 一定打包、絕不 build 失敗。
let bakedLots; // undefined=未載入, null=無, array=可用
function getBakedLots() {
  if (bakedLots !== undefined) return bakedLots;
  try {
    const j = require('./parking-lots.json');
    bakedLots = (j && Array.isArray(j.lots) && j.lots.length) ? j.lots : null;
  } catch (e) { bakedLots = null; }
  return bakedLots;
}

async function getLots() {
  if (descCache.lots && Date.now() - descCache.at < DESC_TTL) return descCache.lots;
  // 優先用預烤靜態檔（座標/名稱幾乎不變，用它即可，免 runtime 下載）
  const baked = getBakedLots();
  if (baked) { descCache = { at: Date.now(), lots: baked }; return baked; }
  // fallback：台北 alldesc.json 較大（跨太平洋抓 Azure blob），給到 8s
  const json = await fetchJson(DESC_URL, 8000, 'desc');
  const parks = (json.data && json.data.park) || [];
  const lots = [];
  for (const p of parks) {
    const x = Number(p.tw97x), y = Number(p.tw97y);
    if (!x || !y) continue;
    const { lat, lng } = twd97ToWGS84(x, y);
    lots.push({ id: String(p.id), name: p.name, total: Number(p.totalcar) || 0, lat, lng });
  }
  descCache = { at: Date.now(), lots };
  return lots;
}

// 讀「排程每分鐘背景寫入 Blobs」的即時空位（跨 instance、us-east-2 同區、快）。
// 這是讓「每個使用者（含冷啟第一次）都快」的關鍵：使用者不必等跨太平洋抓 461KB。
async function readAvailBlob() {
  try {
    const { getStore } = await import('@netlify/blobs');
    const c = await getStore('parking').get('avail', { type: 'json' });
    if (c && c.map && (Date.now() - c.at) < BLOB_AVAIL_TTL) return c; // {at, map}
  } catch (e) { /* Blobs 不可用/空/過期 → 交由呼叫端 live fetch */ }
  return null;
}
async function writeAvailBlob(map) {
  try {
    const { getStore } = await import('@netlify/blobs');
    await getStore('parking').setJSON('avail', { at: Date.now(), map, count: Object.keys(map).length });
  } catch (e) { /* 寫失敗無妨：排程才是主要寫入者 */ }
}

async function getAvail() {
  if (availCache.map && Date.now() - availCache.at < AVAIL_TTL) return availCache.map;
  // 1) 優先讀排程寫入的 Blobs（快 + ≤1 分新鮮）。以 blob 的資料時戳當快取時戳 → AVAIL_TTL 直接界定資料年齡。
  const blob = await readAvailBlob();
  if (blob) { availCache = { at: blob.at, map: blob.map }; return blob.map; }
  // 2) fallback（Blobs 尚未暖機/排程異常）：即時抓一次，順手寫回 Blobs 自我修復（不 await，不擋回應）。
  const json = await fetchJson(AVAIL_URL, 6000, 'avail');
  const parks = (json.data && json.data.park) || [];
  const map = {};
  for (const p of parks) map[String(p.id)] = Number(p.availablecar);
  availCache = { at: Date.now(), map };
  writeAvailBlob(map);
  return map;
}

// 單一 URL 診斷：實測從 Netlify function 抓兩支台北端點的狀態/耗時/筆數，一次回全部。
// 用法：在手機瀏覽器開 /api/parking/nearby?debug=1（不吃快取，每次真打）
async function probe(url, ms, label) {
  const start = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let parks = null;
    try { const j = JSON.parse(text); parks = (j.data && j.data.park && j.data.park.length) || 0; } catch (e) { /* 非 JSON */ }
    return { label, ok: res.ok, status: res.status, ms: Date.now() - start, bytes: text.length, parks };
  } catch (e) {
    return { label, ok: false, status: null, ms: Date.now() - start, error: e.name === 'AbortError' ? `逾時(${ms}ms)` : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  // 注意：Number('') === 0 且 isFinite(0) 為真 → 空字串會被當成座標 0 通過驗證。
  // 先擋掉「缺參數/空字串」，避免 ?lat=&lng= 被誤判為 (0,0) 靜默回空清單。
  const latRaw = q.lat, lngRaw = q.lng;
  const lat = Number(latRaw), lng = Number(lngRaw);
  const hasCoords = latRaw != null && latRaw !== '' && lngRaw != null && lngRaw !== '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

  if (q.debug) {
    const baked = getBakedLots();
    const blob = await readAvailBlob();
    // 感測器覆蓋率：全部停車場中，有多少「回報了有效即時車位數」→ 量化「即時不明」的規模。
    let coverage = null;
    if (baked && blob && blob.map) {
      let hasEntry = 0, validLive = 0;
      for (const lot of baked) {
        const a = blob.map[lot.id];
        if (a !== undefined) hasEntry++;
        if (a != null && a >= 0) validLive++;
      }
      coverage = { totalLots: baked.length, hasAvailEntry: hasEntry, validLive, pct: Math.round(validLive / baked.length * 100) };
    }
    const [desc, avail] = await Promise.all([
      probe(DESC_URL, 9000, 'desc'),
      probe(AVAIL_URL, 7000, 'avail'),
    ]);
    return { statusCode: 200, headers, body: JSON.stringify({
      debug: true, node: process.version, region: process.env.AWS_REGION || null,
      baked: { active: !!baked, count: baked ? baked.length : 0 }, // 預烤檔是否生效
      // 即時空位來源：blob=排程暖機中（使用者都快）、null=尚未暖機（暫用 live fallback）
      availStore: blob ? { source: 'blob', ageSec: Math.round((Date.now() - blob.at) / 1000), count: blob.count || Object.keys(blob.map).length } : { source: 'live-fallback', warm: false },
      coverage, // 有效即時車位覆蓋率（validLive/totalLots）：其餘就是「共 N 格」的場
      desc, avail,
    }, null, 2) };
  }

  // 暖機（?warm=1，進 app 時前端 fire）：喚醒此 function instance + 預載 baked 座標與即時空位到
  // 記憶體快取。使用者稍後點餐廳卡的「第一次讀」就不必付 cold start、資料也已在手 → 幾乎瞬間。
  if (q.warm) {
    let lotsN = 0, avail = false;
    try { lotsN = (await getLots()).length; } catch (e) { /* baked 缺→忽略 */ }
    try { await getAvail(); avail = !!(availCache.map); } catch (e) { /* 即時空位失敗→忽略 */ }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, warm: true, lots: lotsN, avail }) };
  }

  // 地圖停車圖層（?bbox=w,s,e,n）：回傳「目前可視範圍」內的停車場（附即時空位）。上限保護避免爆量。
  if (q.bbox) {
    headers['Cache-Control'] = 'public, max-age=30';
    const p = String(q.bbox).split(',').map(Number);
    if (p.length !== 4 || p.some(v => !isFinite(v))) {
      return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'bbox=w,s,e,n required' }) };
    }
    const [w, s, e, n] = p;
    let lots;
    try { lots = await getLots(); } catch (err) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, lots: [], error: 'desc失敗' }) };
    }
    let avail = {};
    try { avail = await getAvail(); } catch (err) { /* 即時空位失敗 → 全標無即時 */ }
    const MAX_LAYER = 300;
    const inb = [];
    for (const lot of lots) {
      if (lot.lng < w || lot.lng > e || lot.lat < s || lot.lat > n) continue;
      const a = avail[lot.id];
      inb.push({ id: lot.id, name: lot.name, lat: lot.lat, lng: lot.lng, total: lot.total, available: (a != null && a >= 0) ? a : null });
      if (inb.length >= MAX_LAYER) break;
    }
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, lots: inb, capped: inb.length >= MAX_LAYER }) };
  }

  if (!hasCoords || !isFinite(lat) || !isFinite(lng)) {
    return { statusCode: 400, headers: { ...headers, 'Cache-Control': 'public, max-age=30' }, body: JSON.stringify({ success: false, error: 'lat/lng required' }) };
  }
  headers['Cache-Control'] = 'public, max-age=30';

  // desc（名稱/座標）是必要的且已預烤（秒回）；desc 失敗才是硬錯誤。
  let lots;
  try {
    lots = await getLots();
  } catch (e) {
    const reason = e.timeout ? 'desc逾時' : e.status ? `desc HTTP${e.status}` : (e.message || 'desc失敗').slice(0, 20);
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, lots: [], error: reason }) };
  }

  // 快路徑（?fast=1）：只用預烤座標算最近停車場，不抓即時空位 → 免跨太平洋抓 461KB，
  // 讓餐廳卡「秒顯示」場名/步行分鐘。前端第二階段再打完整版補上「剩 N 位」。
  if (q.fast) {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, fast: true, lots: nearestLots(lots, lat, lng, {}) }) };
  }

  // 完整版：加抓即時空位（avail 掛了仍以「無即時」顯示停車場，不擋卡片）。
  let avail = {};
  try { avail = await getAvail(); } catch (e) { /* 即時空位失敗 → 全部標為無即時 */ }
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, lots: nearestLots(lots, lat, lng, avail), scanned: lots.length }) };
};

// 從所有停車場挑出查詢點半徑內最近的幾個（附即時空位若有）。desc/avail 共用。
function nearestLots(lots, lat, lng, avail) {
  const near = [];
  for (const lot of lots) {
    const d = haversineM(lat, lng, lot.lat, lot.lng);
    if (d > NEAR_RADIUS_M) continue;
    const a = avail[lot.id];
    near.push({
      name: lot.name,
      lat: lot.lat, lng: lot.lng,
      total: lot.total,
      available: (a != null && a >= 0) ? a : null, // -9 / 缺資料 → null（無即時）
      dist: Math.round(d),
      walkMin: Math.max(1, Math.round(d * WALK_DETOUR / 80)),
    });
  }
  near.sort((x, y) => x.dist - y.dist);
  return near.slice(0, MAX_LOTS);
}
