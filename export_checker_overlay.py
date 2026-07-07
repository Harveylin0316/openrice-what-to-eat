#!/usr/bin/env python3
"""
從 openrice-closure-checker 的 SQLite 匯出「合作店對照層」快照 partner_overlay.json
（合作店主檔仍是 openrice-crawler 的 restaurants_database.json；這層只做兩件事的疊加）：

1. closed：Google 已確認「永久歇業/搬遷」的合作店 poi_id → 產 pin 時直接下架
   （只取 closed / closed_moved 這兩個確定值；temp_closed 依 checker 自述偵測不可靠、
     closed_unverified 未證實，皆不下架，避免誤殺。）
2. deals：checker 昨日重抓的 booking_offers / booking_menus，比主檔(6/10 匯出)更新
   → 只做「加法升級」（generate_map_pins 端：checker 說有優惠就升級，不因缺漏而降級）

範圍：與 map pin 一致（北北基），但這裡不篩城市，交給 generate_map_pins 對齊。
用法：python3 export_checker_overlay.py [--db /path/to/openrice.db]
資料更新：closure-checker 每日更新 db 後，重跑本腳本再 commit（同 external_pois 流程）。
"""

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = '/workspace/openrice-closure-checker/data/openrice.db'
OUTPUT = os.path.join(BASE_DIR, 'frontend', 'liff', 'data', 'partner_overlay.json')

# 只下架「確定永久歇業/搬遷」；temp_closed/closed_unverified 不動（checker 自述會誤判）
CLOSED_STATUS = {'closed', 'closed_moved'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DEFAULT_DB)
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row

    # 1. 歇業合作店（限 partners，主檔就是這 928 間合作店）
    closed = []
    rows = con.execute("""
        SELECT r.poi_id, r.name_tc, r.google_status
        FROM restaurants r
        WHERE r.poi_id IN (SELECT poi_id FROM partners)
          AND r.google_status IN ('closed', 'closed_moved')
    """).fetchall()
    for r in rows:
        closed.append(r['poi_id'])

    # 2. 昨日 booking 資料（只給 partners）
    menu_rows = con.execute("""
        SELECT poi_id, COUNT(*) AS cnt
        FROM booking_menus
        WHERE poi_id IN (SELECT poi_id FROM partners)
        GROUP BY poi_id
    """).fetchall()
    menu_count = {r['poi_id']: r['cnt'] for r in menu_rows}

    offer_titles = {}
    for r in con.execute("""
        SELECT poi_id, title FROM booking_offers
        WHERE poi_id IN (SELECT poi_id FROM partners) AND title IS NOT NULL AND title != ''
    """):
        offer_titles.setdefault(r['poi_id'], []).append(r['title'])

    deals = {}
    for poi_id in set(menu_count) | set(offer_titles):
        entry = {}
        if menu_count.get(poi_id):
            entry['menu'] = menu_count[poi_id]
        if offer_titles.get(poi_id):
            entry['offer'] = True
            entry['offers'] = offer_titles[poi_id][:3]
        if entry:
            deals[str(poi_id)] = entry  # JSON key 必為字串

    payload = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'openrice-closure-checker/openrice.db',
        'note': 'closed=永久歇業下架；deals=昨日 booking 加法升級。主檔仍為 restaurants_database.json',
        'closed_count': len(closed),
        'deal_count': len(deals),
        'closed': sorted(closed),
        'deals': deals,
    }
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"✅ partner_overlay.json：下架 {len(closed)} 間歇業、優惠升級 {len(deals)} 間（{size_kb:.0f} KB）")
    for pid in closed:
        nm = con.execute("SELECT name_tc FROM restaurants WHERE poi_id=?", (pid,)).fetchone()
        print(f"   下架：{pid} {nm['name_tc'] if nm else ''}")


if __name__ == '__main__':
    main()
