#!/usr/bin/env python3
"""產出 diff 報告，給用戶確認後再覆蓋 restaurants_database.json"""
import json
from collections import Counter

with open('restaurants_database.json', encoding='utf-8') as f:
    old = json.load(f)['restaurants']

with open('_rebuild/new_restaurants_database.json', encoding='utf-8') as f:
    new_data = json.load(f)
new = new_data['restaurants']

print('=' * 70)
print('資料庫更新 diff 報告  (2026-05-13)')
print('=' * 70)

print(f'\n📊 總筆數變化')
print(f'  舊 DB: {len(old)} 間')
print(f'  新 DB: {len(new)} 間 (其中 enabled={sum(1 for r in new if r.get("enabled"))})')

# 分類統計
buckets = Counter()
for r in new:
    if not r.get('enabled'):
        buckets['❌ 下架（不在新合作清單）'] += 1
    elif r.get('needs_scrape'):
        buckets['🆕 新店（資料待補爬蟲）'] += 1
    else:
        buckets['✅ 沿用舊資料'] += 1

print(f'\n📂 餐廳分類')
for k, v in buckets.most_common():
    print(f'  {k}: {v}')

# bookable 統計
bookable = sum(1 for r in new if r.get('enabled') and r.get('bookable'))
not_bookable = sum(1 for r in new if r.get('enabled') and not r.get('bookable'))
print(f'\n🔖 enabled 餐廳的訂位狀態')
print(f'  可線上訂位 (bookable=true): {bookable}')
print(f'  無訂位服務 (bookable=false): {not_bookable}')

# 地區分佈
print(f'\n🗺️  enabled 餐廳的地區分佈')
region_count = Counter(r.get('region') for r in new if r.get('enabled'))
for k, v in region_count.most_common():
    print(f'  {k or "(空白)":15s}: {v}')

# 欄位完整度
print(f'\n📋 enabled 餐廳的欄位完整度')
active = [r for r in new if r.get('enabled')]
for fld in ['cuisine_style', 'type', 'budget', 'images', 'opening_hours', 'coordinates', 'dish']:
    has = sum(1 for r in active if r.get(fld))
    print(f'  {fld:20s}: {has}/{len(active)} ({has*100//len(active)}%)')

# 下架名單樣本
disabled = [r for r in new if not r.get('enabled')]
print(f'\n📌 下架名單樣本（共 {len(disabled)} 間，列前 10 間）')
for r in disabled[:10]:
    print(f'  - {r["name"]}  / {r.get("address","")[:40]}')

# 新店樣本
new_only = [r for r in new if r.get('needs_scrape')]
print(f'\n🆕 新店樣本（共 {len(new_only)} 間，列前 10 間）')
for r in new_only[:10]:
    print(f'  - [{r.get("region")}/{r.get("district")}] {r["name"]}  / bookable={r["bookable"]}')

# 新資料庫結構樣本
print(f'\n📄 新資料庫單筆結構樣本')
sample = next(r for r in active if not r.get('needs_scrape'))
print(json.dumps({k: (v[:3] if isinstance(v, list) else v) for k, v in sample.items()},
                 ensure_ascii=False, indent=2)[:800])

print('\n' + '=' * 70)
print('檔案位置:')
print('  新 DB: _rebuild/new_restaurants_database.json')
print('  舊 DB: restaurants_database.json (尚未覆蓋)')
print('=' * 70)
