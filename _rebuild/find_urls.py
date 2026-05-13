#!/usr/bin/env python3
"""
為 173 間沒 URL 的新店找 OpenRice 完整 URL

OpenRice 搜尋頁是 JS 渲染的，靜態爬不到。用 Playwright headless 跑。
遇 Captcha 會停下來給人類處理（headless=False 才看得到）。

依賴:
    pip install playwright
    python -m playwright install chromium

跑法:
    python3 _rebuild/find_urls.py [--headed] [--limit N]
      --headed  顯示瀏覽器（手動解 Captcha 用）
      --limit N 只跑前 N 筆

產出: _rebuild/find_urls.progress.json
完成後跑 06_merge_scraped.py 把 URL 寫回新 DB

註：OpenRice 對自動化偵測強，連跑可能再次被 Captcha 擋。
建議：每 20 筆隨機停 30-60 秒、整體配速每筆 5-10 秒。
"""
import json
import os
import sys
import time
import random
import argparse

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("缺套件，請執行:")
    print("  pip install playwright && python -m playwright install chromium")
    sys.exit(1)

DB_FILE = '_rebuild/new_restaurants_database.json'
PROGRESS = '_rebuild/find_urls.progress.json'


def load_progress() -> dict:
    if os.path.exists(PROGRESS):
        with open(PROGRESS, encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_progress(data: dict):
    with open(PROGRESS, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def find_url_for_restaurant(page, name: str, target_or_id: int, region: str = '') -> dict:
    """
    用 OpenRice 搜尋找到 target_or_id 對應的 URL
    回傳 {ok, url, error}
    """
    # OpenRice 各區域 path
    region_map = {
        '台北': 'taipei',
        '新北/基隆': 'newtaipei-keelung',
        '桃園': 'taoyuan',
        '台中': 'taichung',
        '台南': 'tainan',
        '高雄/屏東': 'kaohsiung-pingtung',
        '新竹/苗栗': 'hsinchu-miaoli',
        '彰化/南投': 'changhua-nantou',
        '雲林/嘉義': 'yunlin-chiayi',
        '宜花東暨離島': 'eastern',
    }
    region_path = region_map.get(region, 'taiwan')

    from urllib.parse import quote
    search_url = f'https://tw.openrice.com/zh/{region_path}/restaurants?what={quote(name)}'

    try:
        page.goto(search_url, wait_until='networkidle', timeout=20000)

        # 偵測 captcha
        if 'captcha' in page.url.lower():
            return {'ok': False, 'error': 'captcha'}

        # 等搜尋結果出現
        try:
            page.wait_for_selector('a[href*="-r"]', timeout=8000)
        except Exception:
            return {'ok': False, 'error': 'no_results_loaded'}

        # 找到含 target ID 的 link
        target_marker = f'-r{target_or_id}'
        links = page.eval_on_selector_all(
            'a[href*="-r"]',
            'els => els.map(e => e.href).filter(h => /-r\\d+/.test(h))'
        )

        # 優先：精確 ID match
        for href in links:
            if target_marker in href:
                return {'ok': True, 'url': href.split('?')[0]}

        # 次佳：取第一個結果
        if links:
            return {'ok': True, 'url': links[0].split('?')[0], 'note': 'first_match_not_exact_id'}

        return {'ok': False, 'error': 'no_links'}
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--headed', action='store_true', help='顯示瀏覽器（解 captcha 用）')
    ap.add_argument('--limit', type=int)
    args = ap.parse_args()

    with open(DB_FILE, encoding='utf-8') as f:
        data = json.load(f)
    restaurants = data['restaurants']

    targets = [r for r in restaurants if r.get('needs_scrape') and not r.get('url')]
    progress = load_progress()
    done = set(progress.keys())
    todo = [r for r in targets if str(r['or_id']) not in done]

    print(f"需要找 URL: {len(targets)} 間")
    print(f"已完成: {len(done)}")
    print(f"剩餘: {len(todo)}")

    if args.limit:
        todo = todo[:args.limit]

    if not todo:
        print("沒有要跑的，結束")
        return

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            locale='zh-TW',
        )
        page = context.new_page()

        print(f"\n暖機：訪問首頁...")
        page.goto('https://tw.openrice.com/zh/taiwan', wait_until='networkidle')
        if 'captcha' in page.url.lower():
            print(f"❌ 首頁就被 Captcha 擋。")
            if args.headed:
                print("   請在彈出的瀏覽器手動解 Captcha，然後按 Enter 繼續")
                input()
            else:
                print("   加 --headed 跑可以手動解 captcha")
                return

        for i, r in enumerate(todo, 1):
            print(f"[{i}/{len(todo)}] or_id={r['or_id']}  {r['name'][:35]}", end='  ')
            result = find_url_for_restaurant(page, r['name'], r['or_id'], r.get('region', ''))
            if result.get('ok'):
                note = result.get('note', '')
                print(f"✓ {result['url'][:80]}{' ['+note+']' if note else ''}")
            else:
                print(f"✗ {result.get('error')}")
                if result.get('error') == 'captcha':
                    save_progress(progress)
                    if args.headed:
                        print("\n   請手動解 Captcha，然後按 Enter 繼續")
                        input()
                    else:
                        print("\n❌ 停下，加 --headed 跑可以手動解")
                        return
            progress[str(r['or_id'])] = result

            if i % 20 == 0:
                save_progress(progress)
                # 隨機長休息
                pause = random.uniform(30, 60)
                print(f"  --- 已存進度，休息 {pause:.0f}s ---")
                time.sleep(pause)
            else:
                time.sleep(random.uniform(5, 9))

        save_progress(progress)
        browser.close()
    print(f"\n完成。存在 {PROGRESS}")
    print(f"接著跑 _rebuild/06_merge_scraped.py 把 URL 寫回主 DB")


if __name__ == '__main__':
    main()
