#!/usr/bin/env python3
"""
把 rescrape.progress.json 內爬到的最新資料 merge 回主 DB
（DB 預設指向 restaurants_database.json，可用 --target 切換）

opening_hours 標準化：
- 「12:00 - 15:30」（含空格）→「12:00-15:30」
- 「全日休息」/「公休」 等字串 → 移除
- budget「NT$201-500」→「201-500」（去 NT$ 前綴，符合舊資料慣例）
"""
import json
import os
import argparse


def normalize_slot(s: str):
    """標準化單一營業時段字串，無效則回傳 None"""
    if not s:
        return None
    s = str(s).strip()
    # 「全日休息」「公休」「休息」「未營業」等都視為無時段
    if any(k in s for k in ['休息', '公休', '未營業', 'closed', 'Closed']):
        return None
    # 去空格
    s = s.replace(' ', '')
    if '-' not in s:
        return None
    # 確認兩端都像時間
    parts = s.split('-')
    if len(parts) != 2:
        return None
    return s


def normalize_opening_hours(oh: dict) -> dict:
    out = {}
    for day, slots in (oh or {}).items():
        if day == 'is_24h':
            out[day] = bool(slots)
            continue
        if not isinstance(slots, list):
            out[day] = []
            continue
        cleaned = [normalize_slot(x) for x in slots]
        out[day] = [x for x in cleaned if x]
    return out


def normalize_budget(b: str):
    if not b:
        return b
    return str(b).replace('NT$', '').strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', default='restaurants_database.json',
                    help='要 merge 進去的 DB 檔案')
    ap.add_argument('--progress', default='_rebuild/rescrape.progress.json',
                    help='爬蟲結果檔')
    ap.add_argument('--also-update', nargs='*', default=['netlify/functions/restaurants_database.json'],
                    help='同步寫入的其他位置')
    args = ap.parse_args()

    with open(args.target, encoding='utf-8') as f:
        data = json.load(f)
    with open(args.progress, encoding='utf-8') as f:
        scraped = json.load(f)
    print(f"目標 DB: {args.target}（{len(data['restaurants'])} 筆）")
    print(f"爬蟲結果: {len(scraped)} 筆")

    updated = 0
    fields_updated = {'cuisine_style': 0, 'type': 0, 'budget': 0,
                      'opening_hours': 0, 'images': 0, 'dish': 0, 'coordinates': 0}
    for r in data['restaurants']:
        or_id = str(r.get('or_id'))
        if or_id not in scraped or not scraped[or_id].get('ok'):
            continue
        s = scraped[or_id]
        if s.get('cuisine_style'):
            r['cuisine_style'] = s['cuisine_style']
            fields_updated['cuisine_style'] += 1
        if s.get('type'):
            r['type'] = s['type']
            fields_updated['type'] += 1
        if s.get('budget'):
            r['budget'] = normalize_budget(s['budget'])
            fields_updated['budget'] += 1
        if s.get('opening_hours'):
            r['opening_hours'] = normalize_opening_hours(s['opening_hours'])
            fields_updated['opening_hours'] += 1
        if s.get('images'):
            r['images'] = s['images']
            fields_updated['images'] += 1
        if s.get('dish'):
            r['dish'] = s['dish']
            fields_updated['dish'] += 1
        if s.get('coordinates'):
            r['coordinates'] = s['coordinates']
            fields_updated['coordinates'] += 1
        r['is_buffet'] = s.get('is_buffet', r.get('is_buffet', False))
        if s.get('final_url') and not r.get('url'):
            r['url'] = s['final_url']
        if s.get('closed'):
            r['enabled'] = False
            r['disabled_reason'] = 'OpenRice marked closed'
        r.pop('needs_scrape', None)
        updated += 1

    print(f"\n已 merge {updated} 筆")
    print("各欄位更新筆數:")
    for k, v in fields_updated.items():
        print(f"  {k}: {v}")

    with open(args.target, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\n寫回 {args.target}")
    for p in args.also_update:
        if os.path.exists(p):
            with open(p, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"同步寫入 {p}")


if __name__ == '__main__':
    main()
