#!/usr/bin/env python3
"""
方案 D：組裝新資料庫
- 743 間交集 → 從舊 DB 拿詳細資料，enabled=true
- 133 間舊有新無 → 保留資料但 enabled=false（下架）
- 173 間新有舊無 → 用新檔基本資料建骨架，needs_scrape=true
- 10 間舊 DB url 解不出 → 不在新檔的話也標 enabled=false

額外處理：
- 把新檔的 region/district/phone/openrice_id/services/bookable 補進每筆
- bookable = 服務裡有 TableMap 或 ThirdPartyBookingService
"""
import json
import xlrd
from collections import Counter

# === 1. 載入舊 DB（含已展開 OpenRice ID）===
with open('_rebuild/old_db_with_or_id.json', encoding='utf-8') as f:
    old_db = json.load(f)['restaurants']
print(f"舊 DB: {len(old_db)} 間")

# 建 OpenRice ID → 舊資料 索引
old_by_or = {}
for r in old_db:
    if r.get('or_id'):
        old_by_or[r['or_id']] = r

# === 2. 讀新檔 Excel ===
wb = xlrd.open_workbook('/Users/harveylin/Downloads/RestaurantQuery 260513.csv')
sh = wb.sheet_by_index(0)
new_rows = [sh.row_values(r) for r in range(1, sh.nrows)]
active = [r for r in new_rows if r[10] == 'Normal' and r[14] == 'No']
print(f"新檔有效: {len(active)} 間")

# === 3. 處理新檔的每一筆 ===
new_db = []
stats = Counter()

def parse_services(s):
    return [x.strip() for x in (s or '').split(',') if x.strip()]

def is_bookable(services):
    return any(s in services for s in ['TableMap', 'ThirdPartyBookingService'])

for row in active:
    or_id = int(row[1])
    name = row[2]
    address = row[3]
    phone = row[4]
    services = parse_services(row[7])
    region = row[8]
    district = row[9]

    base = {
        'or_id': or_id,
        'name': name,
        'address': address,
        'phone': phone,
        'region': region,
        'district': district,
        'services': services,
        'bookable': is_bookable(services),
        'enabled': True,
    }

    # 看舊 DB 有沒有
    if or_id in old_by_or:
        # 交集：用舊資料補
        old = old_by_or[or_id]
        merged = {
            **base,
            # 從舊資料補的欄位
            'cuisine_style': old.get('cuisine_style', []),
            'type': old.get('type', []),
            'budget': old.get('budget'),
            'images': old.get('images', []),
            'url': old.get('full_url') or old.get('url'),
            'coordinates': old.get('coordinates'),
            'city': old.get('city') or region,
            'dish': old.get('dish', []),
            'is_buffet': old.get('is_buffet', False),
            'opening_hours': old.get('opening_hours', {}),
            'place_id': old.get('place_id'),
        }
        # 用舊 DB 的 name 如果不一樣，留下新名（合作方資料更權威）
        # 但保留舊地址（已經標準化過）
        if old.get('address'):
            merged['address_legacy'] = old.get('address')
        new_db.append(merged)
        stats['intersect (舊資料+新範圍)'] += 1
    else:
        # 新有舊無：骨架，標 needs_scrape
        skeleton = {
            **base,
            'cuisine_style': [],
            'type': [],
            'budget': None,
            'images': [],
            'url': None,  # 沒有 URL，需要爬蟲時自己找
            'coordinates': None,
            'city': region,
            'dish': [],
            'is_buffet': False,
            'opening_hours': {},
            'place_id': None,
            'needs_scrape': True,  # 標記
        }
        new_db.append(skeleton)
        stats['new only (需爬蟲補)'] += 1

# === 4. 處理舊有新無的（標下架）===
new_or_ids = {r['or_id'] for r in new_db}
for r in old_db:
    or_id = r.get('or_id')
    if or_id and or_id in new_or_ids:
        continue  # 已經在交集處理過
    # 不在新檔的，搬過來標下架
    legacy = {
        'or_id': or_id,
        'name': r['name'],
        'address': r.get('address'),
        'phone': None,
        'region': None,
        'district': r.get('district'),
        'services': [],
        'bookable': False,
        'enabled': False,  # ★ 下架
        'cuisine_style': r.get('cuisine_style', []),
        'type': r.get('type', []),
        'budget': r.get('budget'),
        'images': r.get('images', []),
        'url': r.get('full_url') or r.get('url'),
        'coordinates': r.get('coordinates'),
        'city': r.get('city'),
        'dish': r.get('dish', []),
        'is_buffet': r.get('is_buffet', False),
        'opening_hours': r.get('opening_hours', {}),
        'place_id': r.get('place_id'),
        'disabled_reason': 'not in active CSV 2026-05-13',
    }
    new_db.append(legacy)
    if or_id is None:
        stats['legacy (or_id 解不出)'] += 1
    else:
        stats['legacy (新檔已無)'] += 1

# === 5. 統計 ===
print(f"\n=== 組裝結果 ===")
for k, v in stats.most_common():
    print(f"  {k}: {v}")
print(f"  TOTAL: {len(new_db)}")

# enabled / bookable
enabled_count = sum(1 for r in new_db if r.get('enabled'))
bookable_count = sum(1 for r in new_db if r.get('bookable'))
needs_scrape = sum(1 for r in new_db if r.get('needs_scrape'))
print(f"\n  enabled=true: {enabled_count}")
print(f"  bookable=true: {bookable_count}")
print(f"  needs_scrape=true: {needs_scrape}")

# 欄位完整度（只看 enabled=true 的）
active_db = [r for r in new_db if r.get('enabled')]
fields = ['cuisine_style', 'type', 'budget', 'images', 'opening_hours', 'coordinates', 'dish']
print(f"\n  enabled=true 餐廳的欄位完整度（共 {len(active_db)} 間）:")
for fld in fields:
    has = sum(1 for r in active_db if r.get(fld))
    print(f"    {fld:20s}: {has}/{len(active_db)} ({has*100//len(active_db)}%)")

# === 6. 寫入中繼檔（不直接覆蓋 restaurants_database.json）===
output = '_rebuild/new_restaurants_database.json'
with open(output, 'w', encoding='utf-8') as f:
    json.dump({'restaurants': new_db, '_metadata': {
        'source': 'RestaurantQuery 260513.csv (916 active) + 舊 restaurants_database.json (888)',
        'generated_at': '2026-05-13',
        'note': 'D 方案：交集用舊資料補，新店標 needs_scrape，下架店標 enabled=false',
        'stats': dict(stats),
        'enabled_count': enabled_count,
        'bookable_count': bookable_count,
        'needs_scrape': needs_scrape,
    }}, f, ensure_ascii=False, indent=2)
print(f"\n寫入 {output}")
import os
print(f"檔案大小: {os.path.getsize(output)//1024} KB")
