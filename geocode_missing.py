#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
只為「有地址、但主檔+partner_overlay 都缺座標」的北北基合作店 geocode 補座標，
寫進 frontend/liff/data/coord_overrides.json（generate_map_pins.py 會拿它當座標最後退路）。

為什麼不直接寫回 restaurants_database.json：主檔由 openrice-crawler 每次重匯出，
直接改會被覆蓋掉；寫在 coord_overrides.json 才能跨重生存活，直到 crawler 補到真座標。

用法：
  GOOGLE_API_KEY=xxxx python3 geocode_missing.py           # 補值並寫入
  GOOGLE_API_KEY=xxxx python3 geocode_missing.py --dry-run # 只查、印出、不寫

需求：pip install requests（add_coordinates_google.py 也用它）。Google Geocoding 免費額度足夠。
"""

import json
import os
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, 'restaurants_database.json')
OVERLAY = os.path.join(BASE, 'frontend', 'liff', 'data', 'partner_overlay.json')
OVERRIDES = os.path.join(BASE, 'frontend', 'liff', 'data', 'coord_overrides.json')
CITY_ALLOWLIST = {'台北市', '新北市', '基隆市'}
GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json'


def invisible_partners():
    """回傳 [(or_id, name, address)]：enabled + 北北基 + 未歇業 + 主檔&overlay 都缺座標。"""
    with open(DB, encoding='utf-8') as f:
        restaurants = json.load(f)['restaurants']
    with open(OVERLAY, encoding='utf-8') as f:
        ov = json.load(f)
    partners = {int(k): v for k, v in (ov.get('partners') or {}).items()}
    closed = set(ov.get('closed') or [])

    out = []
    for r in restaurants:
        if not r.get('enabled'):
            continue
        if r.get('city') not in CITY_ALLOWLIST:
            continue
        if r.get('or_id') in closed:
            continue
        o = partners.get(r.get('or_id')) or {}
        c = r.get('coordinates') or {}
        lat = o.get('lat', c.get('lat'))
        lng = o.get('lng', c.get('lng'))
        if lat is None or lng is None:
            # 主檔 address 只有街段（例「南京東路四段75巷20號」），補上市+區提升 geocode 準確度
            addr = r.get('address') or ''
            full = f"{r.get('city') or ''}{r.get('district') or ''}{addr}" if addr else ''
            out.append((r['or_id'], r.get('name', ''), full))
    return out


def geocode(address, api_key):
    import requests
    try:
        resp = requests.get(GEOCODING_URL, timeout=10, params={
            'address': address, 'key': api_key, 'language': 'zh-TW', 'region': 'tw'})
        data = resp.json()
        if data.get('status') == 'OK' and data.get('results'):
            loc = data['results'][0]['geometry']['location']
            return {'lat': round(loc['lat'], 6), 'lng': round(loc['lng'], 6)}, data['results'][0].get('formatted_address', '')
        return None, data.get('status', f'HTTP {resp.status_code}')
    except Exception as e:
        return None, str(e)


def main():
    dry = '--dry-run' in sys.argv
    api_key = os.getenv('GOOGLE_API_KEY')
    if not api_key:
        print('❌ 未設定 GOOGLE_API_KEY。用法：GOOGLE_API_KEY=xxxx python3 geocode_missing.py')
        return 1

    with open(OVERRIDES, encoding='utf-8') as f:
        ovr = json.load(f)
    coords = ovr.setdefault('coords', {})

    targets = invisible_partners()
    print(f"看不到的北北基合作店（缺座標）：{len(targets)} 間"
          + ('　[dry-run]' if dry else ''))

    added = skipped = failed = 0
    for oid, name, addr in targets:
        if str(oid) in coords:
            skipped += 1
            print(f"  ⏭️  {oid} {name}：已在 overrides，跳過")
            continue
        if not addr:
            failed += 1
            print(f"  ⚠️  {oid} {name}：無地址，無法 geocode")
            continue
        loc, info = geocode(addr, api_key)
        if loc:
            print(f"  ✅ {oid} {name} → ({loc['lat']}, {loc['lng']})　{info}")
            if not dry:
                coords[str(oid)] = loc
            added += 1
        else:
            print(f"  ❌ {oid} {name}：{info}（地址：{addr}）")
            failed += 1
        time.sleep(0.1)

    if not dry and added:
        with open(OVERRIDES, 'w', encoding='utf-8') as f:
            json.dump(ovr, f, ensure_ascii=False, indent=2)
        print(f"\n已寫入 {OVERRIDES}")
    print(f"\n結果：新增 {added}、已存在 {skipped}、失敗 {failed}"
          + ('（dry-run，未寫入）' if dry else ''))
    print("下一步：python3 generate_map_pins.py 重生地圖資料，再部署。")
    return 0


if __name__ == '__main__':
    sys.exit(main())
