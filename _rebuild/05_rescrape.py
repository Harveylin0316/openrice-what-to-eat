#!/usr/bin/env python3
"""
重爬全部 916 間有效餐廳的詳細資料（更新到最新）

策略：
- 慢速：每筆 3-5 秒（隨機 jitter）
- 單線程：避免再次觸發反爬蟲
- 進度可 resume：每 30 筆 flush 一次到 .progress.json
- 遇 Captcha 立刻停下，等用戶解除後再 resume

用法:
  python3 _rebuild/05_rescrape.py [--only-needs-scrape] [--limit N]

  --only-needs-scrape : 只重爬 needs_scrape=true 的（即 173 間新店）
  --limit N           : 只爬前 N 筆（測試用）

對於 needs_scrape=true 但沒 URL 的店，會 skip（需要先用 find_urls.py 補 URL）
"""
import json
import os
import sys
import argparse
from scraper import make_session, fetch_and_parse, sleep_jitter, CaptchaError

DB_FILE = '_rebuild/new_restaurants_database.json'
PROGRESS = '_rebuild/rescrape.progress.json'

def load_progress() -> dict:
    if os.path.exists(PROGRESS):
        with open(PROGRESS, encoding='utf-8') as f:
            return json.load(f)
    return {}

def save_progress(data: dict):
    with open(PROGRESS, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only-needs-scrape', action='store_true')
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--base-delay', type=float, default=3.0)
    args = ap.parse_args()

    with open(DB_FILE, encoding='utf-8') as f:
        data = json.load(f)
    restaurants = data['restaurants']

    targets = [r for r in restaurants if r.get('enabled')]
    if args.only_needs_scrape:
        targets = [r for r in targets if r.get('needs_scrape')]

    progress = load_progress()
    done = set(progress.keys())

    todo = [r for r in targets if str(r['or_id']) not in done and r.get('url')]
    skipped_no_url = [r for r in targets if not r.get('url')]

    print(f"目標總數: {len(targets)}")
    print(f"已完成: {len(done & {str(r['or_id']) for r in targets})}")
    print(f"待爬: {len(todo)}")
    print(f"跳過（無 URL，待 find_urls.py 補）: {len(skipped_no_url)}")

    if args.limit:
        todo = todo[:args.limit]

    if not todo:
        print("沒有要爬的，結束")
        return

    session = make_session()
    # 暖機：先訪問首頁
    print("\n暖機：訪問首頁...")
    try:
        r = session.get('https://tw.openrice.com/zh/taiwan', timeout=15)
        if 'captcha' in r.url.lower():
            print(f"❌ 首頁就被 Captcha 擋: {r.url}")
            print("   IP 還在冷卻中，等 1-2 小時再試")
            return
        print(f"  [{r.status_code}] OK, cookies: {len(session.cookies)}")
    except Exception as e:
        print(f"暖機失敗: {e}")
        return

    sleep_jitter(2, 1)

    print(f"\n開始爬 {len(todo)} 筆，每筆延遲 {args.base_delay}-{args.base_delay+2}s")
    for i, r in enumerate(todo, 1):
        url = r['url']
        print(f"[{i}/{len(todo)}] or_id={r['or_id']}  {r['name'][:30]}", end='  ')
        try:
            result = fetch_and_parse(session, url)
            if result.get('ok'):
                if result.get('closed'):
                    print(f"⚠ 已結業")
                else:
                    print(f"✓ cuisine={len(result.get('cuisine_style',[]))}, "
                          f"type={len(result.get('type',[]))}, "
                          f"budget={result.get('budget')}, "
                          f"hours={sum(1 for v in result.get('opening_hours',{}).values() if v)}d, "
                          f"img={len(result.get('images',[]))}")
            else:
                print(f"✗ {result.get('error','?')}")
            progress[str(r['or_id'])] = result
        except CaptchaError as e:
            print(f"\n\n❌ 被 Captcha 擋住: {e}")
            print(f"   已存進度到 {PROGRESS}")
            print(f"   等 1-2 小時後再 resume：python3 _rebuild/05_rescrape.py")
            save_progress(progress)
            sys.exit(1)
        except KeyboardInterrupt:
            print("\n中斷，存進度")
            save_progress(progress)
            sys.exit(0)

        if i % 30 == 0:
            save_progress(progress)
            print(f"  --- 已存進度 ({len(progress)}/{len(targets)}) ---")

        sleep_jitter(args.base_delay, 2.0)

    save_progress(progress)
    print(f"\n完成！結果存在 {PROGRESS}")
    print(f"接下來執行 06_merge_scraped.py 將爬到的資料 merge 回 new_restaurants_database.json")


if __name__ == '__main__':
    main()
