#!/usr/bin/env python3
"""
從 openrice-google-sync-checker 的 SQLite 匯出「未合作餐廳」POI 快照
（取代原 OSM 方案：資料更全、含 OpenRice 評分/菜系/連結 + Google 歇業比對）

範圍：台北市全區（Owner 2026-07-06）
條件：非合作（不在 partners）、OR 營業中(status=10)、有座標、
      Google 比對非歇業（closed/closed_moved/closed_unverified/temp_closed 剔除）、
      **收藏數 >= MIN_BOOKMARKS**（Owner 2026-08-06）

為什麼要收藏門檻：checker db 2026-07-20 起併入 OpenRice 全站 catalog（3,099 → 49,148 家），
沒有品質門檻的話台北市符合條件的會有 24,404 家，灰點灌爆地圖、拖慢 LINE WebView 載入。
灰點是「認路用的背景參考」不是內容，取有一定人氣的即可。實測（2026-08-06）：
  >=0: 24,404 家 ／ >=20: 3,253 ／ **>=50: 1,684（現行）** ／ >=100: 935

用法：python3 export_external_pois.py [--db /path/to/openrice.db] [--min-bookmarks N]
資料更新：checker 每日更新 db 後，由 .github/workflows/nightly-refresh.yml 重跑本腳本再 commit。
"""

import argparse
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

# 防禦：OpenRice 少數店名登記成「編號+公司全名+門市名」，
# 與 google-sync-checker 的 clean_corp_names.py 同規則（那邊清源頭，這邊保底）
CORP_PREFIX = re.compile(r'^\d*[一-鿿（）()A-Za-z]*?(?:股份有限公司|有限公司)[-－·]?')


def clean_name(name):
    if not name or ('有限公司' not in name):
        return name
    stripped = CORP_PREFIX.sub('', name).strip()
    return stripped if stripped else name

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 同 export_checker_overlay.py：正式流程由 workflow 指定 --db，這裡只是手動補跑的方便值。
DEFAULT_DB = os.environ.get('CHECKER_DB', os.path.expanduser('~/openrice-checker/data/openrice.db'))
OUTPUT = os.path.join(BASE_DIR, 'frontend', 'liff', 'data', 'external_pois.json')

TAIPEI_DISTRICTS = {
    '中山區', '大安區', '中正區', '信義區', '松山區', '大同區',
    '士林區', '北投區', '內湖區', '南港區', '文山區', '萬華區',
}
# district 缺漏時的台北市粗略邊界
BBOX = {'lat_min': 24.96, 'lat_max': 25.22, 'lng_min': 121.45, 'lng_max': 121.67}

GOOGLE_CLOSED = {'closed', 'closed_moved', 'closed_unverified', 'temp_closed'}

# 灰點品質門檻（見檔頭說明）。改這個數字前先看一次各門檻的家數，別讓地圖爆量。
MIN_BOOKMARKS = 50


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DEFAULT_DB)
    ap.add_argument('--min-bookmarks', type=int, default=MIN_BOOKMARKS,
                    help=f'收藏數門檻，低於此不上圖（預設 {MIN_BOOKMARKS}）')
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
          AND COALESCE(r.bookmark_count, 0) >= ?
    """, (args.min_bookmarks,)).fetchall()

    pois = []
    skipped_geo = skipped_closed = 0
    for r in rows:
        if (r['google_status'] or '') in GOOGLE_CLOSED:
            skipped_closed += 1
            continue
        d = r['district_name']
        lat, lng = r['lat'], r['lng']
        # 座標必須落在台北盆地：OR 來源偶有「行政區寫台北、座標卻在外縣市」的髒資料
        # （例：單眼皮双眼皮早餐輕食 掛萬華區、座標在新竹），只信 district 會在地圖上
        # 畫出一顆位置完全錯誤的灰點。BBOX 對所有點都檢查，不只 district 缺漏時。
        in_bbox = (BBOX['lat_min'] <= lat <= BBOX['lat_max']
                   and BBOX['lng_min'] <= lng <= BBOX['lng_max'])
        in_taipei = in_bbox and (d in TAIPEI_DISTRICTS or d is None)
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
        'source': 'openrice-google-sync-checker/openrice.db',
        'area': '台北市全區',
        'min_bookmarks': args.min_bookmarks,
        'count': len(pois),
        'pois': pois,
    }
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"✅ external_pois.json：{len(pois)} 間未合作餐廳"
          f"（台北市，收藏>={args.min_bookmarks}，{size_kb:.0f} KB）")
    print(f"   剔除：Google 歇業 {skipped_closed}、非台北市 {skipped_geo}")
    # 爆量護欄：門檻設太低會讓灰點灌爆地圖、拖慢 LINE WebView（見檔頭）
    if len(pois) > 4000:
        print(f"   ⚠️ 灰點 {len(pois)} 家偏多（>4000），確認 --min-bookmarks 是否設太低")
    from collections import Counter
    dist = Counter(p.get('d', '（無區）') for p in pois)
    print('   分布：', dict(dist.most_common(13)))


if __name__ == '__main__':
    main()
