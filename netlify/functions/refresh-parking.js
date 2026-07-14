// 排程函式（netlify.toml: schedule = "* * * * *" 每分鐘）：背景抓台北 + 新北即時空位 →
// 寫入同一份 Netlify Blobs map。parking function 讀 Blobs（同區、快）→ 每個使用者（含冷啟
// 第一次）都不用等跨太平洋抓，且資料 ≤1 分新鮮（＝來源更新頻率）。
// 抓失敗只記 log、不擋（parking 端仍有 live fetch fallback，不影響正確性）。
const AVAIL_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json';
// 新北即時空位（同建置端 dataset，取 id→剩餘車位）。未設環境變數則乾淨略過。
const NTPC_URL = process.env.NTPC_PARKING_URL || '';

function pick(o, keys) {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return null;
}
function rowsOf(json) {
  if (Array.isArray(json)) return json;
  return (json && (json.data || (json.result && json.result.records) || json.records)) || [];
}

// 抓新北即時空位 → { 'ntp:<id>': availableCount }。失敗回空物件（隔離，不擋台北）。
async function fetchNtpcAvail() {
  if (!NTPC_URL) return {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let json;
  try {
    const res = await fetch(NTPC_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    json = await res.json();
  } finally { clearTimeout(t); }
  const map = {};
  for (const r of rowsOf(json)) {
    const id = pick(r, ['id', 'ID', 'PARKINGID', 'PARKID', 'StationID', 'stationid', 'ParkId', 'CarParkID', '站點代碼', '停車場代碼']);
    if (id == null) continue;
    const a = Number(pick(r, ['availablecar', 'AVAILABLESPACE', 'availablespace', 'AvailableSpace', 'FREEQUANTITY', '剩餘車位', '空位數', '汽車剩餘位數']));
    map['ntp:' + String(id)] = isFinite(a) ? a : -9; // -9＝無即時（沿用台北慣例）
  }
  return map;
}

exports.handler = async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    let json;
    try {
      const res = await fetch(AVAIL_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      json = await res.json();
    } finally {
      clearTimeout(t);
    }
    const parks = (json.data && json.data.park) || [];
    const map = {};
    for (const p of parks) map[String(p.id)] = Number(p.availablecar);
    if (!Object.keys(map).length) throw new Error('台北 avail 0 筆，放棄寫入（保留上一版）');

    // 新北併入同一 map（隔離失敗：新北掛掉仍寫台北，不回歸）
    let ntpcN = 0;
    try {
      const ntpc = await fetchNtpcAvail();
      Object.assign(map, ntpc);
      ntpcN = Object.keys(ntpc).length;
    } catch (e) { console.error('refresh-parking 新北略過:', e && e.message || e); }

    const { getStore } = await import('@netlify/blobs');
    await getStore('parking').setJSON('avail', { at: Date.now(), map, count: Object.keys(map).length });
    return { statusCode: 200, body: `ok ${Object.keys(map).length}（新北 ${ntpcN}）` };
  } catch (e) {
    console.error('refresh-parking failed:', e && e.message || e);
    return { statusCode: 200, body: 'skip: ' + (e && e.message || e) }; // 不讓排程 retry 風暴
  }
};
