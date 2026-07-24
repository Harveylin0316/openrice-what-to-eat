#!/usr/bin/env python3
"""抓取臺北捷運站點 → frontend/liff/data/mrt_stations.json

為什麼需要這支：地圖原本的「捷運站名」是從餐廳的地標 tag 反推、位置取
附近餐廳的重心（見 generate_map_pins.py 的 landmark_pts），既不是真實站點
座標、也只涵蓋 OpenRice 有標到的地方，使用者反映「看不到捷運站就對不到方位」。
本腳本從 OpenStreetMap Overpass 抓臺北捷運全線的真實站點座標與站碼，
站碼前綴（R/BL/G/O/BR/Y）即路線，前端據此上官方路線色。

範圍：network=臺北捷運（含新北市區段：淡水、板橋、新店、蘆洲、土城、環狀線）。
      不含桃園機捷（A，不同營運商）與施工中的三鶯線（LB）。

轉乘站（台北車站 R10+BL12）會有多個 node，本腳本依站名 + 400m 內合併，
lines 收齊所有路線，前端畫成多色點。

執行環境：GitHub Actions（refresh-landmarks.yml）或任何有網路的機器。
Overpass 不通時：已有舊檔就保留不動（站點極少變動，舊檔完全堪用）。
零相依（純標準庫 urllib）。
"""
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT_PATH = Path(__file__).parent / 'frontend/liff/data/mrt_stations.json'
# 涵蓋北捷全線端點：淡水(25.17)/南港展覽館/頂埔(24.96)/新店(24.95)/迴龍
BBOX = (24.90, 121.35, 25.30, 121.75)  # 南, 西, 北, 東

# 只收臺北捷運本體；桃園機捷(A)、三鶯線(LB)、輕軌(K/V)不在此列
WANTED_PREFIXES = {'BR', 'R', 'G', 'O', 'BL', 'Y'}
# 環狀線(Y)的站 OSM 標 network=新北捷運（由新北捷運公司營運），但屬日常北捷路網要收。
# 桃園機捷(A)標桃園捷運、三鶯線(LB)無 network，靠 WANTED_PREFIXES 已排除。
NETWORK_RE = re.compile(r'臺北捷運|台北捷運|新北捷運', re.I)
MERGE_RADIUS_M = 400  # 同名站在此距離內視為同一站（轉乘站多 node）

OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]


def dist_m(a, b):
    dy = (a[0] - b[0]) * 111320
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(25.05))
    return math.hypot(dx, dy)


def overpass_fetch():
    s, w, n, e = BBOX
    q = (f'[out:json][timeout:180];('
         f'node["railway"="station"]["station"="subway"]({s},{w},{n},{e});'
         f'node["railway"="station"]["subway"="yes"]({s},{w},{n},{e});'
         f');out tags center 500;')
    body = urllib.parse.urlencode({'data': q}).encode()
    for url in OVERPASS_MIRRORS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(
                    url, data=body, headers={'User-Agent': 'openrice-what-to-eat/1.0'})
                with urllib.request.urlopen(req, timeout=200) as r:
                    return json.load(r)['elements']
            except Exception as exc:  # noqa: BLE001 — 換鏡站重試
                print(f'  {url} 第 {attempt + 1} 次失敗：{exc}', file=sys.stderr)
                time.sleep(3)
    return None


def codes_of(ref):
    """'R10;BL12' → [('R','R10'), ('BL','BL12')]；只留北捷路線。"""
    out = []
    for raw in re.split(r'[;,\s]+', ref or ''):
        code = raw.strip().upper()
        m = re.match(r'^([A-Z]{1,2})\d+[A-Z]?$', code)
        if not m:
            continue
        prefix = m.group(1)
        if prefix in WANTED_PREFIXES:
            out.append((prefix, code))
    return out


def collect(elements):
    """OSM nodes → 合併後的站點清單（同名 + 400m 內合併，收齊路線）。"""
    merged = []
    for el in elements:
        tags = el.get('tags') or {}
        name = tags.get('name:zh') or tags.get('name') or ''
        name = name.strip()
        if not name or not NETWORK_RE.search(tags.get('network') or ''):
            continue
        pairs = codes_of(tags.get('ref'))
        if not pairs:
            continue
        lat = el.get('lat') or (el.get('center') or {}).get('lat')
        lng = el.get('lon') or (el.get('center') or {}).get('lon')
        if lat is None or lng is None:
            continue
        hit = next(
            (m for m in merged
             if m['n'] == name and dist_m((lat, lng), (m['lat'], m['lng'])) <= MERGE_RADIUS_M),
            None)
        if hit is None:
            merged.append({'n': name, 'lat': lat, 'lng': lng,
                           'lines': [], 'codes': []})
            hit = merged[-1]
        for prefix, code in pairs:
            if prefix not in hit['lines']:
                hit['lines'].append(prefix)
            if code not in hit['codes']:
                hit['codes'].append(code)
    for m in merged:
        m['lat'] = round(m['lat'], 6)
        m['lng'] = round(m['lng'], 6)
        m['lines'].sort()
        m['codes'].sort()
    merged.sort(key=lambda m: (m['codes'][0] if m['codes'] else '', m['n']))
    return merged


def main():
    elements = overpass_fetch()
    if elements is None:
        if OUT_PATH.exists():
            print('Overpass 全鏡站失敗：保留現有 mrt_stations.json 不動')
            return 0
        print('Overpass 失敗且無舊檔，未寫出任何資料', file=sys.stderr)
        return 1

    stations = collect(elements)
    if len(stations) < 100:
        # 北捷至少 100+ 站；抓太少代表查詢或資料異常，寧可不覆蓋既有好檔
        print(f'只抓到 {len(stations)} 站，低於門檻 100，判定異常', file=sys.stderr)
        if OUT_PATH.exists():
            print('保留現有 mrt_stations.json 不動')
            return 0
        return 1

    payload = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'OpenStreetMap Overpass (railway=station, network=臺北捷運)',
        'count': len(stations),
        'stations': stations,
    }
    OUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n',
        encoding='utf-8')
    size_kb = OUT_PATH.stat().st_size / 1024
    from collections import Counter
    dist = Counter(ln for s in stations for ln in s['lines'])
    print(f'寫出 {OUT_PATH}：{len(stations)} 站（{size_kb:.0f} KB）')
    print('  各線站數：', dict(sorted(dist.items())))
    print('  轉乘站：', sum(1 for s in stations if len(s['lines']) > 1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
