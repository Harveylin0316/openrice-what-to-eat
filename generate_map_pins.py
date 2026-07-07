#!/usr/bin/env python3
"""
生成生活地圖用的精簡 pin 資料 map_pins.json

從 restaurants_database.json 衍生，不修改原資料庫。
在 netlify-build.sh 中執行，輸出到 frontend/liff/data/map_pins.json。

deal_tier 推導（好康強度，決定 pin 樣式與排序）：
  sponsored      is_paid_account == True（付費合作，最高）
  booking_offer  有訂位獨家優惠（has_booking_offer / booking_offers）
  coupon         services 含 "Coupon"
  none           其他
"""

import json
import os
import sys
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(BASE_DIR, 'restaurants_database.json')
OUTPUT = os.path.join(BASE_DIR, 'frontend', 'liff', 'data', 'map_pins.json')

# 與 netlify/functions/restaurants.js 的 applyCityAllowlist 保持一致：
# API（含「幫我決定」推薦引擎）只服務北北基，地圖 pin 必須套同一個白名單，
# 否則地圖上會出現推薦引擎永遠抽不到的店。
CITY_ALLOWLIST = {'台北市', '新北市', '基隆市'}

# 優惠層級（決定 pin 顏色）：三種 Owner 實際優惠，強度 套餐=訂位 > 回饋現金
#   menu     套餐優惠（booking_menus，有實際套餐折扣價）
#   offer    訂位優惠（booking_offers，如壽星優惠、訂套餐招待）
#   cashback 訂位出席回饋現金（所有可訂位的店的基本盤：出席每人回饋 3 元）
#   none     不可訂位（拿不到回饋）
# 贊助（is_paid_account）是「廣告位」，與優惠正交 → 另用 sp 旗標畫星星釘，不佔顏色層。
# tie 規則：同時有套餐+訂位 → pin 顯示「訂位優惠」色（它稀有、才 14 間，讓它全部可見；
#          套餐仍有 36 間紅點），卡片兩個 badge 都秀。要改成套餐優先，翻 has_offer/has_menu 順序即可。
TIER_MENU = 'menu'
TIER_OFFER = 'offer'
TIER_CASHBACK = 'cashback'
TIER_NONE = 'none'


def has_menu(r):
    return bool(r.get('has_booking_menu') or r.get('booking_menus'))


def has_offer(r):
    return bool(r.get('has_booking_offer') or r.get('booking_offers'))


def derive_deal_tier(r):
    if has_offer(r):
        return TIER_OFFER
    if has_menu(r):
        return TIER_MENU
    if r.get('bookable'):
        return TIER_CASHBACK
    return TIER_NONE


def map_budget_to_category(db_budget):
    """把資料庫預算字串映射到前端 5 分類。
    與 backend/utils/recommendation.js 的 parseBudgetRange + mapBudgetToCategory
    保持一致（中心點判斷法），前端篩選結果才會與推薦引擎一致。"""
    import re
    if not db_budget:
        return None
    m = re.search(r'(\d+)-(\d+)', db_budget)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        center = (lo + hi) / 2
    else:
        m = re.search(r'(\d+)以上', db_budget)
        if m:
            center = int(m.group(1)) + 500  # 「XXX以上」假設範圍較大
        else:
            m = re.search(r'(\d+)以下', db_budget)
            if m:
                center = int(m.group(1)) / 2
            else:
                return None
    if center <= 200:
        return '200元內'
    if center <= 500:
        return '200-500元'
    if center <= 1000:
        return '500-1000元'
    if center <= 1500:
        return '1000-1500元'
    return '1500以上'


def compact_hours(opening_hours):
    """壓縮營業時間：{monday:["11:00-21:00"],...} -> [["11:00-21:00"],...] 週一到週日"""
    if not isinstance(opening_hours, dict):
        return None
    days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    out = [opening_hours.get(d) or [] for d in days]
    if not any(out):
        return None
    return out


def build_pin(r):
    coords = r.get('coordinates') or {}
    lat, lng = coords.get('lat'), coords.get('lng')
    if lat is None or lng is None:
        return None

    tier = derive_deal_tier(r)
    offers = r.get('booking_offers') or []

    pin = {
        'id': r['or_id'],
        'n': r.get('name', ''),
        'lat': round(float(lat), 6),
        'lng': round(float(lng), 6),
        't': tier,
        'c': 'food',  # category：目前全為餐飲，預留未來擴品類
        'b': bool(r.get('bookable')),
        'd': f"{r.get('city') or r.get('region') or ''}{('·' + r['district']) if r.get('district') else ''}",
    }
    if r.get('is_paid_account'):
        pin['sp'] = 1  # 贊助（廣告位）→ 星星釘
    # 優惠旗標（卡片 badge 用；pin 顏色只取一種，但卡片全秀）
    if has_menu(r):
        pin['hm'] = 1
        if r.get('booking_menu_count'):
            pin['mc'] = r['booking_menu_count']
    if has_offer(r):
        pin['ho'] = 1
    if r.get('rating'):
        pin['r'] = r['rating']
    if r.get('budget'):
        pin['bud'] = r['budget']
        bc = map_budget_to_category(r['budget'])
        if bc:
            pin['bc'] = bc  # 前端預算分類（bottom sheet 篩選用）
    if r.get('door_photo_url'):
        pin['img'] = r['door_photo_url']
    elif r.get('images'):
        pin['img'] = r['images'][0]
    if r.get('url'):
        pin['url'] = r['url']
    hours = compact_hours(r.get('opening_hours'))
    if hours:
        pin['h'] = hours
    if offers:
        pin['of'] = offers[:3]  # 迷你卡最多顯示 3 條優惠
    # 摘要 tags（迷你卡顯示用，去重後最多 2 個）
    tags = list(dict.fromkeys((r.get('cuisine_style') or []) + (r.get('type') or [])))
    if tags:
        pin['tg'] = tags[:2]
    return pin


def main():
    with open(SOURCE, encoding='utf-8') as f:
        data = json.load(f)
    restaurants = data if isinstance(data, list) else data.get('restaurants', [])

    pins = []
    skipped_disabled = skipped_nocoords = skipped_city = 0
    for r in restaurants:
        if not r.get('enabled', True):
            skipped_disabled += 1
            continue
        if r.get('city') not in CITY_ALLOWLIST:
            skipped_city += 1
            continue
        pin = build_pin(r)
        if pin is None:
            skipped_nocoords += 1
            continue
        pins.append(pin)

    tier_counts = {}
    for p in pins:
        tier_counts[p['t']] = tier_counts.get(p['t'], 0) + 1

    # 搜尋用地點索引：行政區 + 地標（捷運站/商圈），質心取自店家座標
    from collections import defaultdict
    district_pts = defaultdict(list)
    landmark_pts = defaultdict(list)
    for r in restaurants:
        if not r.get('enabled', True) or r.get('city') not in CITY_ALLOWLIST:
            continue
        coords = r.get('coordinates') or {}
        if coords.get('lat') is None:
            continue
        pt = (coords['lat'], coords['lng'])
        if r.get('district'):
            district_pts[(r.get('city'), r['district'])].append(pt)
        for lm in r.get('landmarks') or []:
            landmark_pts[lm].append(pt)

    def centroid(pts):
        return (round(sum(p[0] for p in pts) / len(pts), 6),
                round(sum(p[1] for p in pts) / len(pts), 6))

    places = []
    for (city, district), pts in district_pts.items():
        lat, lng = centroid(pts)
        places.append({'n': district, 'd': city, 't': 'district', 'lat': lat, 'lng': lng, 'c': len(pts)})
    for lm, pts in landmark_pts.items():
        if len(pts) < 2:  # 只有一間店的地標雜訊多，略過
            continue
        lat, lng = centroid(pts)
        places.append({'n': lm, 't': 'landmark', 'lat': lat, 'lng': lng, 'c': len(pts)})
    places.sort(key=lambda p: -p['c'])  # 店多的地點排前，搜尋建議更準

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    payload = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'count': len(pins),
        'pins': pins,
        'places': places,
    }
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"✅ map_pins.json：{len(pins)} pins + {len(places)} places（{size_kb:.0f} KB）")
    print(f"   tiers: {tier_counts}")
    print(f"   skipped: disabled={skipped_disabled}, no-coords={skipped_nocoords}, outside-allowlist={skipped_city}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
