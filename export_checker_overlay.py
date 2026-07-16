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
# OpenRice 頁面自己的狀態文字＝永久關閉 → 一併下架（原本只看 Google，漏掉 OR 已標結業的店，
# 2026-07-13 實測有 53 家 partner OpenRice 已結業/搬遷卻仍在地圖上）。
# 保守：只認「已結業/已搬遷」，不下架「裝修中(temp)/已易手(仍營業)」避免誤殺。
CLOSED_STATUS_TEXT = ('已結業', '已搬遷')

# 手動下架名單（stopgap）：OpenRice 頁面尚未更新狀態(status=10 仍顯示營業)、Google 也沒掃到，
# 但已確認實際結業。來源端（checker 重掃）補上後可移除對應項。
FORCE_CLOSED = {
    652565,  # 天菜咖哩（大安區）：已結業，OpenRice 頁面仍顯示營業（用戶 2026-07-13 回報）
}


def is_permanently_closed(r):
    return (r['poi_id'] in FORCE_CLOSED
            or (r['google_status'] or '') in CLOSED_STATUS
            or (r['status_text'] or '') in CLOSED_STATUS_TEXT)

# 已確認過期的優惠壓制名單（stopgap）：checker db 的 booking_offers 只加不減，店家撤下的
# 優惠會殘留、每晚重生又流回地圖（2026-07-09 實際發生：551013 鹽牛舌被重生加回）。
# 在來源端（checker 跑 refresh_offers.py 重驗全站優惠）修好之前，這裡按 poi_id+標題關鍵字
# 過濾；來源修好後對應項目可移除。
SUPPRESSED_OFFERS = {
    551013: ('鹽牛舌',),  # 燒肉擔當 本店：官網已無此優惠（用戶 2026-07-09 回報）
}


def offer_suppressed(pid, title):
    kws = SUPPRESSED_OFFERS.get(pid)
    return bool(kws) and any(k in (title or '') for k in kws)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DEFAULT_DB)
    args = ap.parse_args()

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row

    # 合作店最新欄位（限 partners 這 928 間）
    rows = con.execute("""
        SELECT r.poi_id, r.name_tc, r.lat, r.lng, r.overall_rating, r.door_photo_url,
               r.is_bookable, r.has_menu, r.has_offer, r.booking_menu_count, r.google_status,
               r.short_url, r.status_text
        FROM restaurants r
        WHERE r.poi_id IN (SELECT poi_id FROM partners)
    """).fetchall()

    # 昨日 booking 明細（升級用）
    offer_titles = {}
    for r in con.execute("""
        SELECT poi_id, title FROM booking_offers
        WHERE poi_id IN (SELECT poi_id FROM partners) AND title IS NOT NULL AND title != ''
    """):
        if offer_suppressed(r['poi_id'], r['title']):
            continue  # 已確認過期，見 SUPPRESSED_OFFERS
        offer_titles.setdefault(r['poi_id'], []).append(r['title'])

    # 照片牆（poi_photos 表，refresh_photos.py 產）：{poi_id: [url,...]}。表未建時安靜略過。
    photos_by_poi = {}
    try:
        for pr in con.execute('SELECT poi_id, urls FROM poi_photos'):
            try:
                u = json.loads(pr['urls'] if isinstance(pr, sqlite3.Row) else pr[1])
                if isinstance(u, list) and u:
                    photos_by_poi[pr['poi_id'] if isinstance(pr, sqlite3.Row) else pr[0]] = u[:8]
            except (TypeError, ValueError):
                continue
    except sqlite3.OperationalError:
        pass  # 老 db 還沒跑過 refresh_photos.py

    # 優惠餐點照（booking_menus/booking_offers 的 photo_url）：本來就在 db 卻沒人用——
    # 對「好康地圖」比一般照片更對題（用戶想看的就是優惠那道菜）。附加在照片牆後面。
    for table in ('booking_menus', 'booking_offers'):
        try:
            for pr in con.execute(
                    f"SELECT poi_id, photo_url FROM {table} "
                    f"WHERE photo_url IS NOT NULL AND photo_url != '' ORDER BY poi_id"):
                pid, u = pr['poi_id'], pr['photo_url']
                cur = photos_by_poi.setdefault(pid, [])
                if u not in cur and len(cur) < 8:
                    cur.append(u)
        except sqlite3.OperationalError:
            continue

    closed = []
    partners = {}
    for r in rows:
        pid = r['poi_id']
        if is_permanently_closed(r):
            closed.append(pid)
            continue  # 要下架的店不必再帶欄位

        entry = {}
        # is_bookable 是 OpenRice 頁面的直接欄位（每列都有，非依賴 booking 子表），
        # 比主檔(6/10)衍生的 bookable 可靠 → 權威覆蓋（可訂位＝出席回饋的前提）
        entry['b'] = 1 if r['is_bookable'] else 0
        if r['name_tc']:
            entry['n'] = r['name_tc']
        if r['lat'] is not None and r['lng'] is not None:
            entry['lat'] = round(r['lat'], 6)
            entry['lng'] = round(r['lng'], 6)
        if r['overall_rating']:
            entry['r'] = r['overall_rating']
        if r['door_photo_url']:
            entry['img'] = r['door_photo_url']
        if photos_by_poi.get(pid):
            entry['phs'] = photos_by_poi[pid]  # 照片牆（最新、最多 6 張），photos.json 優先用它
        # OpenRice 短網址 deeplink（帶推薦碼、可追蹤）；缺則前端退回主檔長網址
        if r['short_url'] and r['short_url'].startswith('https://s.openrice.com/'):
            entry['dl'] = r['short_url']
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
        'note': ('closed=永久歇業下架；partners[poi]=最新 name/座標/評分/照片/優惠/dl(短網址deeplink)。'
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
