#!/usr/bin/env python3
"""
從 openrice-closure-checker 的 SQLite 匯出「合作店對照層」快照 partner_overlay.json。

合作店主檔(restaurants_database.json)是 openrice-crawler 每次匯出的（含 enabled / 城市白名單 /
landmarks 等 app 規則），但欄位會過時。checker 的 openrice.db 每天在住宅 IP 重爬，
name/座標/評分/照片/優惠/歇業都是最新 → 本層把這些「會變的欄位」疊上去。

對照層做兩件事（generate_map_pins.py 端套用）：
1. closed：Google 確認永久歇業/搬遷的合作店 → 產 pin 時直接下架
   （只取 closed / closed_moved；temp_closed、closed_unverified 不下架，避免誤殺）
2. partners[poi]：逐店最新欄位——
   n 店名、lat/lng 座標、r 評分、img 門面照、menu 套餐數、offer 有無訂位優惠、offers 明細
   套用原則：座標/名稱/評分/照片 → 直接以最新覆蓋；優惠 → 只加不減（缺漏不降級）。

用法：python3 export_checker_overlay.py [--db /path/to/openrice.db]
更新：checker 每日重爬並 commit db 後，（雲端 nightly workflow）自動重跑本腳本再 commit。
"""

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = '/workspace/openrice-closure-checker/data/openrice.db'
OUTPUT = os.path.join(BASE_DIR, 'frontend', 'liff', 'data', 'partner_overlay.json')

# 只下架「確定永久歇業/搬遷」；temp_closed / closed_unverified 不動（checker 自述會誤判）
CLOSED_STATUS = ('closed', 'closed_moved')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DEFAULT_DB)
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row

    # 合作店最新欄位（限 partners 這 928 間）
    rows = con.execute("""
        SELECT r.poi_id, r.name_tc, r.lat, r.lng, r.overall_rating, r.door_photo_url,
               r.is_bookable, r.has_menu, r.has_offer, r.booking_menu_count, r.google_status
        FROM restaurants r
        WHERE r.poi_id IN (SELECT poi_id FROM partners)
    """).fetchall()

    # 昨日 booking 明細（升級用）
    offer_titles = {}
    for r in con.execute("""
        SELECT poi_id, title FROM booking_offers
        WHERE poi_id IN (SELECT poi_id FROM partners) AND title IS NOT NULL AND title != ''
    """):
        offer_titles.setdefault(r['poi_id'], []).append(r['title'])

    closed = []
    partners = {}
    for r in rows:
        pid = r['poi_id']
        if (r['google_status'] or '') in CLOSED_STATUS:
            closed.append(pid)
            continue  # 要下架的店不必再帶欄位

        entry = {}
        if r['name_tc']:
            entry['n'] = r['name_tc']
        if r['lat'] is not None and r['lng'] is not None:
            entry['lat'] = round(r['lat'], 6)
            entry['lng'] = round(r['lng'], 6)
        if r['overall_rating']:
            entry['r'] = r['overall_rating']
        if r['door_photo_url']:
            entry['img'] = r['door_photo_url']
        # 優惠（加法升級）：has_menu/has_offer 或 booking 表有資料就算
        titles = offer_titles.get(pid) or []
        menu_n = r['booking_menu_count'] or 0
        if r['has_menu'] or menu_n:
            entry['menu'] = menu_n or 1
        if r['has_offer'] or titles:
            entry['offer'] = True
            if titles:
                entry['offers'] = titles[:3]
        if entry:
            partners[str(pid)] = entry  # JSON key 必為字串

    payload = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'openrice-closure-checker/openrice.db',
        'note': ('closed=永久歇業下架；partners[poi]=最新 name/座標/評分/照片/優惠。'
                 '座標名稱評分照片直接覆蓋、優惠只加不減。主檔仍為 restaurants_database.json'),
        'closed_count': len(closed),
        'partner_count': len(partners),
        'closed': sorted(closed),
        'partners': partners,
    }
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(OUTPUT) / 1024
    deal_n = sum(1 for e in partners.values() if e.get('menu') or e.get('offer'))
    print(f"✅ partner_overlay.json：{len(partners)} 間最新欄位（含 {deal_n} 間有優惠）、"
          f"下架 {len(closed)} 間歇業（{size_kb:.0f} KB）")
    for pid in closed:
        nm = con.execute("SELECT name_tc FROM restaurants WHERE poi_id=?", (pid,)).fetchone()
        print(f"   下架：{pid} {nm['name_tc'] if nm else ''}")


if __name__ == '__main__':
    main()
