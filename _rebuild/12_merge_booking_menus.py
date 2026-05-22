#!/usr/bin/env python3
"""
把 booking_menus.xlsx「餐廳彙總」merge 進主 DB。
49 家有 OpenRice 線上訂位套餐（會員獨家優惠）的餐廳。
"""
import openpyxl
import json
import os
import re

SRC = '/Users/harveylin/Desktop/Claude-workspace/projects/openrice-crawler/exports/booking_menus.xlsx'
MAIN_DB = 'restaurants_database.json'
NETLIFY_DB = 'netlify/functions/restaurants_database.json'


def clean_menu_title(title):
    """去除標題內已被結構化欄位涵蓋的冗詞：「原價$X 特價$Y」「優惠價$Y」等"""
    if not title:
        return ''
    t = str(title)
    # 把「原價$X」「原價 $X」「原價X」等去掉
    t = re.sub(r'\s*原價\s*\$?[\d,]+\s*', ' ', t)
    t = re.sub(r'\s*特價\s*\$?[\d,]+\s*', ' ', t)
    t = re.sub(r'\s*優惠價\s*\$?[\d,]+\s*', ' ', t)
    # 多空白合併
    t = re.sub(r'\s+', ' ', t).strip()
    return t


def load_menu_details():
    """讀「套餐明細」sheet → { poi_id: [menu dict, ...] }"""
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb['套餐明細']
    rows = list(ws.iter_rows(values_only=True))
    header = rows[1]
    idx = {h: i for i, h in enumerate(header) if h}
    out = {}
    for r in rows[2:]:
        if not r[0]:
            continue
        poi_id = int(r[idx['POI ID']])
        m = {
            'title': clean_menu_title(r[idx['套餐標題']]),
            'current_price': int(r[idx['現價']]) if r[idx['現價']] else None,
            'original_price': int(r[idx['原價']]) if r[idx['原價']] else None,
            'has_discount': r[idx['有折扣']] == '是',
            'discount_pct': r[idx['折扣%']],  # "33.7%" or None
        }
        out.setdefault(poi_id, []).append(m)
    # 同店排序：折扣% 高 → 低（吸引力優先）
    def disc_val(m):
        try:
            return float(str(m.get('discount_pct') or '0').replace('%', ''))
        except ValueError:
            return 0
    for poi_id in out:
        out[poi_id].sort(key=disc_val, reverse=True)
    return out


def load_menus():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    ws = wb['餐廳彙總']
    rows = list(ws.iter_rows(values_only=True))
    header = rows[1]  # row 0 是 super-header，row 1 是真實 header
    idx = {h: i for i, h in enumerate(header) if h}
    records = []
    for r in rows[2:]:
        if not r[0]: continue
        poi_id = int(r[idx['POI ID']])
        records.append({
            'or_id': poi_id,
            'name': r[idx['餐廳']],
            'menu_count': int(r[idx['套餐數']]) if r[idx['套餐數']] else 0,
            'discounted_count': int(r[idx['折扣套餐數']]) if r[idx['折扣套餐數']] else 0,
            'min_price': int(r[idx['最低價']]) if r[idx['最低價']] else None,
            'max_price': int(r[idx['最高價']]) if r[idx['最高價']] else None,
            'avg_discount_pct': r[idx['平均折扣%']],  # string like "9.3%"
        })
    return records


def parse_pct(s):
    if not s: return None
    try:
        return float(str(s).replace('%', '').strip())
    except ValueError:
        return None


def main():
    menus = load_menus()
    print(f'讀到 {len(menus)} 家有線上套餐的餐廳')
    by_id = {m['or_id']: m for m in menus}
    menu_details = load_menu_details()
    print(f'  + {sum(len(v) for v in menu_details.values())} 套套餐明細 covering {len(menu_details)} 家')

    with open(MAIN_DB, encoding='utf-8') as f:
        data = json.load(f)
    restaurants = data['restaurants']

    matched = 0
    for r in restaurants:
        oid = r.get('or_id')
        if oid in by_id:
            m = by_id[oid]
            r['has_booking_menu'] = True
            r['booking_menu_count'] = m['menu_count']
            r['booking_menu_discounted_count'] = m['discounted_count']
            r['booking_menu_min_price'] = m['min_price']
            r['booking_menu_max_price'] = m['max_price']
            r['booking_menu_avg_discount_pct'] = parse_pct(m['avg_discount_pct'])
            # 套餐明細列表（已按折扣%排好）
            details = menu_details.get(oid, [])
            r['booking_menus'] = details
            matched += 1
        else:
            r.pop('has_booking_menu', None)
            r.pop('booking_menu_count', None)
            r.pop('booking_menu_discounted_count', None)
            r.pop('booking_menu_min_price', None)
            r.pop('booking_menu_max_price', None)
            r.pop('booking_menu_avg_discount_pct', None)
            r.pop('booking_menus', None)

    not_found = [m for m in menus if m['or_id'] not in {r.get('or_id') for r in restaurants}]
    print(f'  matched: {matched}/{len(menus)}')
    if not_found:
        print(f'  NOT FOUND in DB:')
        for m in not_found[:5]:
            print(f'    [{m["or_id"]}] {m["name"]}')

    with open(MAIN_DB, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    with open(NETLIFY_DB, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'\n寫入 {MAIN_DB}  ({os.path.getsize(MAIN_DB)//1024} KB)')

    # 樣本
    print(f'\n樣本：')
    shown = 0
    for r in restaurants:
        if r.get('has_booking_menu'):
            print(f"  [{r['or_id']}] {r['name']}: {r['booking_menu_count']} 套，平均折 {r.get('booking_menu_avg_discount_pct')}%")
            shown += 1
            if shown >= 5: break


if __name__ == '__main__':
    main()
