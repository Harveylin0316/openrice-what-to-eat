#!/usr/bin/env python3
"""
把 rescrape.progress.json 內爬到的最新資料 merge 回 new_restaurants_database.json
"""
import json
import os

DB_FILE = '_rebuild/new_restaurants_database.json'
PROGRESS = '_rebuild/rescrape.progress.json'

with open(DB_FILE, encoding='utf-8') as f:
    data = json.load(f)

with open(PROGRESS, encoding='utf-8') as f:
    scraped = json.load(f)

print(f"爬到 {len(scraped)} 筆新資料")

updated = 0
for r in data['restaurants']:
    or_id = str(r.get('or_id'))
    if or_id in scraped and scraped[or_id].get('ok'):
        s = scraped[or_id]
        # 用新爬的覆蓋
        if s.get('cuisine_style'): r['cuisine_style'] = s['cuisine_style']
        if s.get('type'): r['type'] = s['type']
        if s.get('budget'): r['budget'] = s['budget']
        if s.get('opening_hours'): r['opening_hours'] = s['opening_hours']
        if s.get('images'): r['images'] = s['images']
        if s.get('dish'): r['dish'] = s['dish']
        if s.get('coordinates'): r['coordinates'] = s['coordinates']
        r['is_buffet'] = s.get('is_buffet', r.get('is_buffet', False))
        if s.get('final_url') and not r.get('url'): r['url'] = s['final_url']
        if s.get('closed'):
            r['enabled'] = False
            r['disabled_reason'] = 'OpenRice marked closed'
        # 移除 needs_scrape
        r.pop('needs_scrape', None)
        updated += 1

print(f"已 merge {updated} 筆")

with open(DB_FILE, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print(f"寫回 {DB_FILE}")
