#!/usr/bin/env python3
"""
驗證：能不能用 OpenRice Restaurant ID 直接打到餐廳頁面
測試 3 種 URL 格式 × 3 筆樣本
"""
import requests
from bs4 import BeautifulSoup
import time

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.openrice.com/',
}

# 從新檔取的樣本
SAMPLES = [
    (555198, '咖央 潮境店 Cafejiasong'),
    (752241, '小隱茶庵 潮境店'),
    (532804, '金炭火燒肉餐廳 新店'),
]

URL_PATTERNS = [
    'https://www.openrice.com/zh/taiwan/r{id}',
    'https://www.openrice.com/zh/taiwan/restaurant/r-r{id}',
    'https://www.openrice.com/zh/taiwan/restaurant/{id}',
]

for or_id, name in SAMPLES:
    print(f"\n=== {name} (OR ID: {or_id}) ===")
    for pattern in URL_PATTERNS:
        url = pattern.format(id=or_id)
        try:
            r = requests.get(url, headers=HEADERS, timeout=15, allow_redirects=True)
            final_url = r.url
            title = ''
            if r.status_code == 200:
                soup = BeautifulSoup(r.text, 'html.parser')
                t = soup.find('title')
                title = t.text.strip()[:60] if t else ''
            print(f"  [{r.status_code}] {pattern}")
            print(f"      → final: {final_url[:80]}")
            print(f"      → title: {title}")
            if r.status_code == 200 and 'OpenRice' in title:
                # 找到就停（這個 pattern 能用）
                break
        except Exception as e:
            print(f"  [ERR] {pattern}: {e}")
        time.sleep(1)
    time.sleep(1)
