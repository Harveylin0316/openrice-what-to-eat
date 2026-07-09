// 排程函式（netlify.toml: schedule = "* * * * *" 每分鐘）：背景抓台北即時空位 →
// 寫入 Netlify Blobs。parking function 讀 Blobs（同區、快）→ 每個使用者（含冷啟第一次）
// 都不用等跨太平洋抓 461KB，且資料 ≤1 分新鮮（＝台北來源更新頻率）。
// 抓失敗只記 log、不擋（parking 端仍有 live fetch fallback，不影響正確性）。
const AVAIL_URL = 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json';

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
    if (!Object.keys(map).length) throw new Error('avail 0 筆，放棄寫入（保留上一版）');

    const { getStore } = await import('@netlify/blobs');
    await getStore('parking').setJSON('avail', { at: Date.now(), map, count: Object.keys(map).length });
    return { statusCode: 200, body: `ok ${Object.keys(map).length}` };
  } catch (e) {
    console.error('refresh-parking failed:', e && e.message || e);
    return { statusCode: 200, body: 'skip: ' + (e && e.message || e) }; // 不讓排程 retry 風暴
  }
};
