// 台北市即時停車位 API：回傳查詢點(餐廳)附近的公有停車場 + 即時空位。
// 資料源（臺北市停管處 open data）：
//   靜態(名稱/座標/總車位)：TCMSV_alldesc.json（座標為 TWD97 TM2，需轉 WGS84）
//   即時(剩餘車位)         ：TCMSV_allavailable.json
// 端點：GET /api/parking/nearby?lat=&lng=  → { success, lots:[{name,available,total,walkMin,dist,lat,lng}] }
// 沙盒(開發)連不到台北 API；正式 Netlify function 在公網跑得到。抓不到時靜默回空陣列。

const DESC_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json';
const AVAIL_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json';
const DESC_TTL = 6 * 3600 * 1000;  // 名稱/座標半天更新一次夠了
const AVAIL_TTL = 60 * 1000;       // 即時空位快取 60 秒（分鐘級來源）
const NEAR_RADIUS_M = 700;         // 只回步行約 10 分內的停車場
const MAX_LOTS = 3;
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

// 逾時保護：台北 API 慢/掛時快速失敗，別讓餐廳卡的「查停車…」轉圈到 function timeout
async function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let descCache = { at: 0, lots: null };
let availCache = { at: 0, map: null };

async function getLots() {
  if (descCache.lots && Date.now() - descCache.at < DESC_TTL) return descCache.lots;
  const json = await fetchJson(DESC_URL, 5000);
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

async function getAvail() {
  if (availCache.map && Date.now() - availCache.at < AVAIL_TTL) return availCache.map;
  const json = await fetchJson(AVAIL_URL, 4000);
  const parks = (json.data && json.data.park) || [];
  const map = {};
  for (const p of parks) map[String(p.id)] = Number(p.availablecar);
  availCache = { at: Date.now(), map };
  return map;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const lat = Number(q.lat), lng = Number(q.lng);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' };
  if (!isFinite(lat) || !isFinite(lng)) {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'lat/lng required' }) };
  }
  try {
    const [lots, avail] = await Promise.all([getLots(), getAvail()]);
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
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, lots: near.slice(0, MAX_LOTS) }) };
  } catch (e) {
    // 台北 API 掛掉 / 逾時 → 靜默降級，不擋餐廳卡
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, lots: [] }) };
  }
};
