// 抓取「未合作餐廳」POI（OpenStreetMap Overpass API）
// 在 Netlify 建置環境執行（本地沙箱無外網時，沿用已提交的快照檔）。
// 試點範圍：松江南京捷運站周邊 600m（Owner 2026-07-06：先做松江南京，
// 讓用戶在地圖上比得出「有出席回饋（合作）vs 沒有（未合作）」）。
//
// 資料授權：OpenStreetMap © 貢獻者，ODbL。地圖 attribution 已含 © OpenStreetMap。
// 未來要換 Google Places：改寫 fetchPois() 即可，輸出格式不變。

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(ROOT, 'frontend', 'liff', 'data', 'external_pois.json');
const PARTNER_PINS = join(ROOT, 'frontend', 'liff', 'data', 'map_pins.json');

// 松江南京捷運站
const CENTER = { lat: 25.05243, lng: 121.53277 };
const RADIUS_M = 600;
const MAX_POIS = 120;

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

const QUERY = `[out:json][timeout:25];
(
  node["amenity"~"restaurant|cafe|fast_food|bar"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  way["amenity"~"restaurant|cafe|fast_food|bar"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
);
out center;`;

function normName(s) {
    return (s || '').toLowerCase().replace(/[\s（）()【】\-·・.。,，'’]/g, '');
}

function distM(a, b) {
    const dLat = (a.lat - b.lat) * 111320;
    const dLng = (a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
    return Math.hypot(dLat, dLng);
}

async function fetchPois() {
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                body: 'data=' + encodeURIComponent(QUERY),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (Array.isArray(data.elements)) return data.elements;
        } catch (e) {
            console.warn(`⚠️ Overpass ${endpoint} 失敗: ${e.message}`);
        }
    }
    return null;
}

const elements = await fetchPois();
if (!elements) {
    console.warn('⚠️ 外部 POI 抓取失敗，沿用已提交的快照檔（不影響建置）');
    process.exit(0);
}

// 合作店名單（去重用：同名或 60m 內同前綴視為同一間，不重複顯示）
let partners = [];
try {
    partners = JSON.parse(readFileSync(PARTNER_PINS, 'utf-8')).pins
        .map(p => ({ n: normName(p.n), lat: p.lat, lng: p.lng }));
} catch (e) { /* pins 尚未生成也可運作 */ }

const seen = new Set();
const pois = [];
for (const el of elements) {
    const tags = el.tags || {};
    const name = tags['name:zh'] || tags.name;
    if (!name) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const key = normName(name);
    if (!key || seen.has(key)) continue;
    // 與合作店去重：名字互含，或 60m 內且前 2 字相同
    const dup = partners.some(p =>
        p.n.includes(key) || key.includes(p.n) ||
        (distM({ lat, lng }, p) < 60 && p.n.slice(0, 2) === key.slice(0, 2)));
    if (dup) continue;
    seen.add(key);
    const poi = { n: name, lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
    if (tags.cuisine) poi.cu = tags.cuisine.split(';')[0];
    pois.push(poi);
    if (pois.length >= MAX_POIS) break;
}

writeFileSync(OUTPUT, JSON.stringify({
    generated_at: new Date().toISOString().slice(0, 19) + 'Z',
    source: 'osm-overpass',
    area: '松江南京站 600m',
    count: pois.length,
    pois,
}, null, 0));
console.log(`✅ external_pois.json：${pois.length} 間未合作餐廳（松江南京 600m）`);
