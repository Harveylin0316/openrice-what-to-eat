// 建置時執行（Netlify build server 有公網）：抓台北停管處靜態停車場資料
// （名稱/座標/總車位，TWD97→WGS84），寫成 netlify/functions/parking-lots.json。
// parking function 於 runtime 直接讀這份本地檔，免在每次 cold start 抓 2.4MB desc（省 ~3.4s）。
// 失敗時保留既有 placeholder / 舊檔，function 會 fallback 成 runtime 即時抓取（不影響正確性）。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DESC_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'parking-lots.json');

// 新北市停車場（open data，data.ntpc.gov.tw）。URL 走環境變數 → 未設定則乾淨略過，
// 台北資料不受影響（零回歸）。確認正式 dataset URL 後設 NTPC_PARKING_URL 即啟用。
// 一份 dataset 通常同時含名稱/座標/總車位/即時空位；建置只取靜態欄位（名稱/座標/總位）。
const NTPC_URL = process.env.NTPC_PARKING_URL || '';

// TWD97 TM2 (EPSG:3826) → WGS84。與 parking.js 相同（已用往返測試驗證誤差 0.000m）。
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

// 多命名容錯取值：新北 open data 欄位命名與台北不同，逐一嘗試常見別名。
function pick(o, keys) {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return null;
}

// 座標自動判定：值落在台灣經緯度範圍（經 119~122、緯 21~26）→ 已是 WGS84 直用（含欄位順序顛倒）；
// 否則視為 TWD97 TM2 轉換。免去「新北到底是哪種座標系」的驗證需求。
function toWGS84(a, b) {
  const inLng = (v) => v > 119 && v < 123, inLat = (v) => v > 21 && v < 26.5;
  if (inLng(a) && inLat(b)) return { lat: b, lng: a }; // (lng, lat)
  if (inLng(b) && inLat(a)) return { lat: a, lng: b }; // (lat, lng)
  return twd97ToWGS84(a, b);
}

// 新北 open data 回傳可能是陣列，或包在 data/result.records/records 裡。
function rowsOf(json) {
  if (Array.isArray(json)) return json;
  return (json && (json.data || (json.result && json.result.records) || json.records)) || [];
}

async function fetchNtpcLots() {
  if (!NTPC_URL) { console.log('ℹ️ 未設 NTPC_PARKING_URL，略過新北停車靜態資料'); return []; }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let json;
  try {
    const res = await fetch(NTPC_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    json = await res.json();
  } finally { clearTimeout(t); }
  const rows = rowsOf(json);
  const lots = [];
  for (const r of rows) {
    const id = pick(r, ['id', 'ID', 'PARKINGID', 'PARKID', 'StationID', 'stationid', 'ParkId', 'CarParkID', '站點代碼', '停車場代碼']);
    const name = pick(r, ['name', 'NAME', 'PARKINGNAME', 'ParkName', 'CarParkName', '停車場名稱', '場站名稱', '名稱']);
    const total = Number(pick(r, ['totalcar', 'TOTALSPACE', 'totalspace', 'TotalSpace', 'PARKINGSPACE', '總車位', '汽車格位總數'])) || 0;
    const rawX = Number(pick(r, ['lng', 'LNG', 'longitude', 'Longitude', '經度', 'wgsX', 'GIS_X', 'tw97x', 'X', 'PX']));
    const rawY = Number(pick(r, ['lat', 'LAT', 'latitude', 'Latitude', '緯度', 'wgsY', 'GIS_Y', 'tw97y', 'Y', 'PY']));
    if (id == null || !isFinite(rawX) || !isFinite(rawY) || (!rawX && !rawY)) continue;
    const { lat, lng } = toWGS84(rawX, rawY);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    lots.push({ id: 'ntp:' + String(id), name: name || '新北停車場', total, lat, lng });
  }
  console.log(`✅ 新北停車場：${lots.length} 筆`);
  return lots;
}

async function fetchTaipeiLots() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let json;
  try {
    const res = await fetch(DESC_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    json = await res.json();
  } finally {
    clearTimeout(t);
  }
  const parks = (json.data && json.data.park) || [];
  const lots = [];
  for (const p of parks) {
    const x = Number(p.tw97x), y = Number(p.tw97y);
    if (!x || !y) continue;
    const { lat, lng } = twd97ToWGS84(x, y);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    lots.push({ id: String(p.id), name: p.name, total: Number(p.totalcar) || 0, lat, lng });
  }
  return lots;
}

async function main() {
  const taipei = await fetchTaipeiLots();
  if (!taipei.length) throw new Error('台北轉出 0 筆，放棄覆蓋（保留既有檔）');
  // 新北失敗不擋（隔離）：抓不到就只出台北，功能不回歸。
  let ntpc = [];
  try { ntpc = await fetchNtpcLots(); } catch (e) { console.error('⚠️ 新北停車靜態抓取失敗（略過）：', e.message || e); }
  const lots = taipei.concat(ntpc);
  writeFileSync(OUT, JSON.stringify({ at: Date.now(), count: lots.length, lots }));
  console.log(`✅ parking-lots.json：${lots.length} 筆（台北 ${taipei.length} + 新北 ${ntpc.length}）`);
}

main().catch((e) => {
  console.error('⚠️ 停車靜態資料生成失敗（function 將於 runtime 即時抓）:', e.message || e);
  process.exit(1);
});
