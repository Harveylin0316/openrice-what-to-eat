#!/usr/bin/env python3
"""
用 Gemini 為餐廳生成個性化 slogan（替代 OpenRice 標籤雜訊太多的規則式生成）

用法:
  python3 _rebuild/generate_slogans.py --spike     # 只跑 spike 2-3 家看效果
  python3 _rebuild/generate_slogans.py --all       # 跑全部 enabled 餐廳並寫入 DB

依賴：環境變數 GEMINI_API_KEY（沿用 line-menu-photo-bot 的 key + CF Worker proxy）
"""
import os
import json
import argparse
import time
import requests
from pathlib import Path

# 從 line-menu-photo-bot 的 .env 借用設定
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
if not GEMINI_API_KEY:
    env_file = Path.home() / 'Desktop/Claude-workspace/projects/line-menu-photo-bot/.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith('GEMINI_API_KEY='):
                GEMINI_API_KEY = line.split('=', 1)[1].strip()
                break

# 本機跑直接打 Google API；如要在 Render Singapore 跑改回 worker proxy
GEMINI_BASE = os.environ.get('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com')
MODEL = 'gemini-2.5-flash'

SYSTEM_PROMPT = """你是台灣餐廳行銷文案專家，為「隨機抽餐廳」App 卡片頂部寫趣味 slogan。

【最重要】根據餐廳「名稱」判斷實際類型（OpenRice 標籤常常錯，例：「犇鐵板燒」要看出是鐵板燒、「Butcher 一極肉舖」要看出是肉舖／餐酒館）。

風格要求：
- 長度嚴格 8-13 字（含標點），繁體中文
- 像跟朋友隨口說的話，不是廣告詞
- 不要寫「歡迎光臨」「美食推薦」「天選之人」「運氣爆棚」「人品大爆發」這種誇張腔
- 不要每條都用「命運」「骰子」開頭
- 可以提餐廳特色（鐵板燒、肉舖、酒吧、南洋、義式...）但不要提具體菜名
- 五條句型要有變化（不要都同結構）

風格範例（口吻參考）：
- 想吃肉肉？來這就對了
- 鐵板秀今晚就看你
- 下班想喝兩杯就這家
- 銅板價的好選擇
- 今天讓南洋療癒你

輸出格式：嚴格五行，每行一句，無編號、無引號、無解釋、無 markdown。"""

USER_PROMPT_TEMPLATE = """餐廳資料：
- 名稱：{name}
- 地址：{address}
- 區域：{region} / {district}
- 預算：{budget}
- OpenRice 標籤（僅參考、可能不準）：料理={cuisines}，類型={types}

請生五條 slogan。"""


def generate_for_restaurant(r):
    name = r.get('name', '')
    address = r.get('address', '')
    region = r.get('region', '')
    district = r.get('district', '')
    budget = r.get('budget') or '未標示'
    cuisines = ', '.join(r.get('cuisine_style') or []) or '無'
    types = ', '.join(r.get('type') or []) or '無'

    user_prompt = USER_PROMPT_TEMPLATE.format(
        name=name, address=address, region=region, district=district,
        budget=budget, cuisines=cuisines, types=types,
    )

    payload = {
        'systemInstruction': {'parts': [{'text': SYSTEM_PROMPT}]},
        'contents': [{'role': 'user', 'parts': [{'text': user_prompt}]}],
        'generationConfig': {'temperature': 0.9, 'maxOutputTokens': 600, 'thinkingConfig': {'thinkingBudget': 0}},
    }
    url = f'{GEMINI_BASE}/v1beta/models/{MODEL}:generateContent?key={GEMINI_API_KEY}'
    r = requests.post(url, json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()
    text = data['candidates'][0]['content']['parts'][0]['text']
    # parse 5 行，去 emoji / 編號 / 過長
    import re as _re
    lines = []
    for l in text.strip().splitlines():
        l = l.strip().lstrip('-•').strip()
        # 去掉開頭數字編號 「1.」「1、」「1)」
        l = _re.sub(r'^\d+[.、。\):、]\s*', '', l)
        # 去引號
        l = l.strip('「」"\'""''')
        if not l or l.startswith('#'):
            continue
        # 長度過濾（保守一點：4-16 字）
        if len(l) < 4 or len(l) > 16:
            continue
        lines.append(l)
    return lines[:5]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--spike', action='store_true', help='只跑 2-3 家看效果，不寫 DB')
    ap.add_argument('--all', action='store_true', help='跑全部 enabled 餐廳並寫入 DB')
    ap.add_argument('--target', default='restaurants_database.json')
    ap.add_argument('--limit', type=int)
    args = ap.parse_args()

    if not GEMINI_API_KEY:
        print('❌ 找不到 GEMINI_API_KEY')
        return

    with open(args.target, encoding='utf-8') as f:
        data = json.load(f)
    db = data['restaurants']

    if args.spike:
        # spike 兩家用戶提到的問題店
        targets = [r for r in db if r.get('or_id') in {553995, 226660}]  # placeholder
        # 改：找用戶提到的兩家
        targets = []
        for r in db:
            if '犇鐵板燒' in r.get('name', '') and '安和' in r.get('name', ''):
                targets.append(r)
            if 'Butcher' in r.get('name', '') and 'EZ-MEAT' in r.get('name', ''):
                targets.append(r)
        # 再加一兩家對照
        for r in db:
            if r.get('name') == '椰糖 Coconut Sugar 南洋餐事':
                targets.append(r); break
        for r in db:
            if 'EZO' in r.get('name','').upper():
                targets.append(r); break
        print(f'Spike: {len(targets)} 家')
        for r in targets:
            print(f'\n--- {r["name"]} ---')
            print(f'  region={r.get("region")} budget={r.get("budget")}')
            print(f'  OR cuisines={r.get("cuisine_style")} types={r.get("type")}')
            try:
                slogans = generate_for_restaurant(r)
                print(f'  Gemini 生成 {len(slogans)} 條 slogan:')
                for s in slogans:
                    print(f'    - {s}')
            except Exception as e:
                print(f'  ❌ {e}')
            time.sleep(0.5)
        return

    if args.all:
        targets = [r for r in db if r.get('enabled') and not r.get('slogans')]
        if args.limit:
            targets = targets[:args.limit]
        print(f'全量目標: {len(targets)} 家')
        ok, fail = 0, 0
        for i, r in enumerate(targets, 1):
            try:
                slogans = generate_for_restaurant(r)
                if slogans:
                    r['slogans'] = slogans
                    ok += 1
                    if i % 30 == 0 or i == 1:
                        print(f'  [{i}/{len(targets)}] {r["name"][:25]} → {len(slogans)} 條')
                        print(f'    範例: {slogans[0]}')
                else:
                    fail += 1
            except Exception as e:
                fail += 1
                print(f'  [{i}] ❌ {r["name"]}: {e}')
            # 每 30 筆暫存
            if i % 30 == 0:
                with open(args.target, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f'    --- 已存 {i}/{len(targets)}（ok={ok} fail={fail}）---')
            time.sleep(0.3)  # 0.3s 間隔避免被 rate limit

        # 最終寫入
        with open(args.target, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # 同步 netlify
        netlify_path = 'netlify/functions/restaurants_database.json'
        if os.path.exists(netlify_path):
            with open(netlify_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        print(f'\n完成：ok={ok} fail={fail}')
        return

    ap.print_help()


if __name__ == '__main__':
    main()
