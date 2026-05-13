#!/usr/bin/env python3
"""
展開舊 DB 的 888 個 OpenRice 短網址 → 拿到完整 URL → 解出 OpenRice Restaurant ID
產出 _rebuild/old_db_with_or_id.json
"""
import json
import re
import requests
import time
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-TW,zh;q=0.9',
}

OUT_FILE = '_rebuild/old_db_with_or_id.json'
PROGRESS_FILE = '_rebuild/old_db_with_or_id.progress.json'

def expand_one(idx, restaurant):
    short_url = restaurant.get('url', '')
    if not short_url:
        return idx, None, None, 'no_url'
    try:
        # 用 HEAD 比較快；如果 HEAD 不支援就 GET
        r = requests.head(short_url, headers=HEADERS, timeout=10, allow_redirects=True)
        if r.status_code >= 400:
            r = requests.get(short_url, headers=HEADERS, timeout=15, allow_redirects=True)
        final_url = r.url
        # 解出 r{id}
        m = re.search(r'-r(\d+)(?:[?/#]|$)', final_url)
        or_id = int(m.group(1)) if m else None
        return idx, or_id, final_url, 'ok' if or_id else 'no_id'
    except Exception as e:
        return idx, None, None, f'err:{type(e).__name__}'

def main():
    with open('restaurants_database.json', encoding='utf-8') as f:
        db = json.load(f)['restaurants']
    print(f"舊 DB 總數: {len(db)}")

    # resume：如果已有 progress 檔，繼續
    results = {}
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, encoding='utf-8') as f:
            results = {int(k): v for k, v in json.load(f).items()}
        print(f"從 progress 載入 {len(results)} 筆已展開的結果")

    todo_idxs = [i for i in range(len(db)) if i not in results]
    print(f"還要展開: {len(todo_idxs)} 筆")

    if todo_idxs:
        completed = 0
        with ThreadPoolExecutor(max_workers=8) as ex:
            futures = {ex.submit(expand_one, i, db[i]): i for i in todo_idxs}
            for fut in as_completed(futures):
                idx, or_id, final_url, status = fut.result()
                results[idx] = {'or_id': or_id, 'final_url': final_url, 'status': status}
                completed += 1
                if completed % 50 == 0:
                    print(f"  進度 {completed}/{len(todo_idxs)}  最新: idx={idx} or_id={or_id} status={status}")
                    # flush progress
                    with open(PROGRESS_FILE, 'w', encoding='utf-8') as f:
                        json.dump({str(k): v for k, v in results.items()}, f, ensure_ascii=False, indent=2)

        with open(PROGRESS_FILE, 'w', encoding='utf-8') as f:
            json.dump({str(k): v for k, v in results.items()}, f, ensure_ascii=False, indent=2)

    # 統計
    statuses = {}
    for v in results.values():
        statuses[v['status']] = statuses.get(v['status'], 0) + 1
    print(f"\n=== 結果統計 ===")
    for k, v in sorted(statuses.items(), key=lambda x: -x[1]):
        print(f"  {k}: {v}")

    # 整合到 DB
    enriched = []
    for i, r in enumerate(db):
        rr = dict(r)
        info = results.get(i, {})
        rr['or_id'] = info.get('or_id')
        rr['full_url'] = info.get('final_url')
        enriched.append(rr)

    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump({'restaurants': enriched}, f, ensure_ascii=False, indent=2)
    print(f"\n寫入 {OUT_FILE}")

    # 跟新檔交集
    import xlrd
    wb = xlrd.open_workbook('/Users/harveylin/Downloads/RestaurantQuery 260513.csv')
    sh = wb.sheet_by_index(0)
    new_rows = [sh.row_values(r) for r in range(1, sh.nrows)]
    active = [r for r in new_rows if r[10] == 'Normal' and r[14] == 'No']
    new_ids = {int(r[1]) for r in active if r[1]}

    old_ids = {r['or_id'] for r in enriched if r['or_id']}
    intersect = old_ids & new_ids
    new_only = new_ids - old_ids
    old_only = old_ids - new_ids

    print(f"\n=== 新舊交集 ===")
    print(f"舊 DB 解出 OpenRice ID: {len(old_ids)}")
    print(f"新檔 OpenRice ID: {len(new_ids)}")
    print(f"兩邊都有（要重新爬）: {len(intersect)}")
    print(f"新有舊無（要找 URL）: {len(new_only)}")
    print(f"舊有新無（要標 enabled=false）: {len(old_only)}")

if __name__ == '__main__':
    main()
