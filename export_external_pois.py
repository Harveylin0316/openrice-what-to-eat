#!/usr/bin/env python3
"""
從 openrice-closure-checker 的 SQLite 匯出「未合作餐廳」POI 快照
（取代原 OSM 方案：資料更全、含 OpenRice 評分/菜系/連結 + Google 歇業比對）

範圍：台北市全區（Owner 2026-07-06）
條件：非合作（不在 partners）、OR 營業中(status=10)、有座標、
      Google 比對非歇業（closed/closed_moved/closed_unverified/temp_closed 剔除）

用法：python3 export_external_pois.py [--db /path/to/openrice.db]
資料更新：closure-checker 每日 GitHub Action 更新 db 後，重跑本腳本再 commit。
"""

import argparse
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

# 防禦：OpenRice 少數店名登記成「編號+公司全名+門市名」，
# 與 closure-checker 的 clean_corp_names.py 同規則（那邊清源頭，這邊保底）
CORP_PREFIX = re.compile(r'^\d*[一-鿿（）()A-Za-z]*?(?:股份有限公司|有限公司)[-－·]?')


def clean_name(name):
    if not name or ('有限公司' not in name):
        return name
    stripped = CORP_PREFIX.sub('', name).strip()
    return stripped if stripped else name

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = '/workspace/openrice-closure-checker/data/openrice.db'
OUTPUT = os.path.join(BASE_DIR, 'frontend', 'liff', 'data', 'external_pois.json')

TAIPEI_DISTRICTS = {
    '中山區', '大安區', '中正區', '信義區', '松山區', '大同區',
    '士林區', '北投區', '內湖區', '南港區', '文山區', '萬華區',
}
# district 缺漏時的台北市粗略邊界
BBOX = {'lat_min': 24.96, 'lat_max': 25.22, 'lng_min': 121.45, 'lng_max': 121.67}

GOOGLE_CLOSED = {'closed', 'closed_moved', 'closed_unverified', 'temp_closed'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DEFAULT_DB)
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT r.poi_id, r.name_tc, r.lat, r.lng, r.district_name, r.cuisines,
               r.overall_rating, r.price_range_label, r.short_url, r.google_status
        FROM restaurants r
        WHERE r.poi_id NOT IN (SELECT poi_id FROM partners)
          AND r.status = 10
          AND r.lat IS NOT NULL AND r.lng IS NOT NULL
          AND r.name_tc IS NOT NULL
    """).fetchall()

    pois = []
    skipped_geo = skipped_closed = 0
    for r in rows:
        if (r['google_status'] or '') in GOOGLE_CLOSED:
            skipped_closed += 1
            continue
        d = r['district_name']
        lat, lng = r['lat'], r['lng']
        in_taipei = (d in TAIPEI_DISTRICTS) or (
            d is None
            and BBOX['lat_min'] <= lat <= BBOX['lat_max']
            and BBOX['lng_min'] <= lng <= BBOX['lng_max'])
        if not in_taipei:
            skipped_geo += 1
            continue
        poi = {'n': clean_name(r['name_tc']), 'lat': round(lat, 6), 'lng': round(lng, 6)}
        if d:
            poi['d'] = d
        try:
            cuisines = json.loads(r['cuisines'] or '[]')
            if cuisines:
                poi['cu'] = cuisines[0]
        except (ValueError, TypeError):
            pass
        if r['overall_rating']:
            poi['r'] = r['overall_rating']
        if r['price_range_label']:
            poi['bud'] = r['price_range_label']
        if r['short_url']:
            poi['u'] = r['short_url']
        pois.append(poi)

    pois.sort(key=lambda p: p['n'])
    payload = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'openrice-closure-checker/openrice.db',
        'area': '台北市全區',
        'count': len(pois),
        'pois': pois,
    }
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"✅ external_pois.json：{len(pois)} 間未合作餐廳（台北市，{size_kb:.0f} KB）")
    print(f"   剔除：Google 歇業 {skipped_closed}、非台北市 {skipped_geo}")
    from collections import Counter
    dist = Counter(p.get('d', '（無區）') for p in pois)
    print('   分布：', dict(dist.most_common(13)))


if __name__ == '__main__':
    main()
