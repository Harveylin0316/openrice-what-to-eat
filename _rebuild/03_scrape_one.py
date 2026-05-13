#!/usr/bin/env python3
"""
單筆 OpenRice 整合 parser：cuisine, type, budget, images, opening_hours, dish, coordinates, is_buffet
先試 1 筆驗證能不能一次抓完所有欄位
"""
import requests, re, json, sys
from bs4 import BeautifulSoup

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-TW,zh;q=0.9',
    'Referer': 'https://tw.openrice.com/',
}

DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

def scrape_openrice(url: str) -> dict:
    r = requests.get(url, headers=HEADERS, timeout=20)
    r.raise_for_status()
    html = r.text
    soup = BeautifulSoup(html, 'html.parser')

    out = {'url': url, 'final_url': r.url}

    # 1. 標題
    t = soup.find('title')
    out['_title'] = t.text.strip() if t else None

    # 2. 是否已結業
    text_all = soup.get_text()
    out['_closed'] = any(k in text_all for k in ['已結業', '已歇業', '已停業'])

    # 3. cuisine_style + type （從 pdhs-filter-tags-section）
    sec = re.search(r'<div[^>]*class=["\']pdhs-filter-tags-section["\'][^>]*>(.*?)</div>',
                    html, re.DOTALL | re.IGNORECASE)
    cuisines, types = [], []
    if sec:
        sh = sec.group(1)
        for m in re.finditer(r'<a[^>]*href=["\'][^"\']*cuisine[^"\']*["\'][^>]*>(.*?)</a>',
                             sh, re.IGNORECASE | re.DOTALL):
            txt = re.sub(r'<!--.*?-->', '', m.group(1), flags=re.DOTALL)
            txt = re.sub(r'<[^>]+>', '', txt).strip()
            if txt: cuisines.append(txt)
        for m in re.finditer(r'<a[^>]*href=["\'][^"\']*type[^"\']*["\'][^>]*>(.*?)</a>',
                             sh, re.IGNORECASE | re.DOTALL):
            txt = re.sub(r'<!--.*?-->', '', m.group(1), flags=re.DOTALL)
            txt = re.sub(r'<[^>]+>', '', txt).strip()
            if txt: types.append(txt)
    out['cuisine_style'] = list(dict.fromkeys(cuisines))  # 保序去重
    out['type'] = list(dict.fromkeys(types))

    # 4. budget
    budget = None
    nt_range = re.search(r'NT\$(\d+)\s*[-~至]\s*(?:NT\$)?(\d+)', text_all)
    if nt_range:
        budget = f"NT${nt_range.group(1)}-{nt_range.group(2)}"
    else:
        nt_above = re.search(r'NT\$(\d+)以上', text_all)
        if nt_above:
            budget = f"NT${nt_above.group(1)}以上"
        else:
            nt_single = re.search(r'NT\$(\d+)(?!\d)', text_all)
            if nt_single:
                budget = f"NT${nt_single.group(1)}"
    out['budget_raw'] = budget

    # 5. opening_hours
    oh = soup.select_one('.opening-hours-list')
    hours = {d: [] for d in DAYS}
    day_map_ch = {'一': 'monday', '二': 'tuesday', '三': 'wednesday',
                  '四': 'thursday', '五': 'friday', '六': 'saturday', '日': 'sunday'}
    if oh:
        for de in oh.select('.opening-hours-day'):
            date_e = de.select_one('.opening-hours-date')
            time_e = de.select_one('.opening-hours-time')
            if not (date_e and time_e): continue
            date_txt = date_e.get_text(strip=True)
            # 找對應星期
            day_key = None
            for ch, en in day_map_ch.items():
                if ch in date_txt:
                    day_key = en
                    break
            if not day_key: continue
            # 多時段
            divs = time_e.find_all('div')
            slots = []
            if len(divs) > 1:
                for d in divs:
                    txt = d.get_text(strip=True)
                    if txt: slots.append(txt)
            else:
                txt = time_e.get_text(strip=True)
                # 切多時段（換行）
                for ln in txt.split('\n'):
                    ln = ln.strip()
                    if ln: slots.append(ln)
            hours[day_key] = slots
    out['opening_hours'] = hours

    # 6. images
    images = []
    # OpenRice 圖片網址通常含 orstatic.com
    for img in soup.find_all('img'):
        src = img.get('src') or img.get('data-src') or ''
        if 'orstatic.com' in src and 'userphoto' in src:
            # 升級成大圖（mx 是 medium）
            images.append(src)
    # data-lazy-src/srcset
    for img in soup.find_all(attrs={'data-lazy-src': True}):
        src = img.get('data-lazy-src', '')
        if 'orstatic.com' in src:
            images.append(src)
    out['images'] = list(dict.fromkeys(images))[:20]

    # 7. dish / 招牌菜
    dish = []
    # 通常在 recommend-dish 或 signature dish 區塊
    for sel in ['.recommend-dish', '.signature-dish', '.dish-name']:
        for el in soup.select(sel):
            txt = el.get_text(strip=True)
            if txt: dish.append(txt)
    out['dish'] = list(dict.fromkeys(dish))

    # 8. coordinates - 找頁面內的 lat/lng
    coords = None
    # 找 JSON-LD with geo
    for ld_tag in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(ld_tag.string or '{}')
            if isinstance(data, dict):
                geo = data.get('geo') or {}
                if geo.get('latitude'):
                    coords = {'lat': float(geo['latitude']), 'lng': float(geo['longitude'])}
                    break
        except Exception:
            pass
    # fallback: 找 google maps embed
    if not coords:
        m = re.search(r'[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)', html)
        if not m:
            m = re.search(r'latitude["\']?\s*[:=]\s*["\']?(-?\d+\.\d+)["\']?[,\s]+longitude["\']?\s*[:=]\s*["\']?(-?\d+\.\d+)', html, re.IGNORECASE)
        if m:
            coords = {'lat': float(m.group(1)), 'lng': float(m.group(2))}
    out['coordinates'] = coords

    # 9. is_buffet
    out['is_buffet'] = any(k in (cuisines + types) for k in ['吃到飽', '放題', 'Buffet'])

    # 10. address - 從頁面拿
    addr = soup.find(class_=lambda x: x and 'address' in str(x).lower())
    if addr:
        out['address'] = addr.get_text(strip=True)

    return out


if __name__ == '__main__':
    # 用「猴吃鍋」（舊 DB 已知存在）驗證
    url = 'https://tw.openrice.com/zh/taichung/r-monkey-eats-pot-nantun-district-taiwanese-other-hot-pot-r456807'
    print(f"爬: {url}\n")
    result = scrape_openrice(url)
    print(json.dumps(result, ensure_ascii=False, indent=2))
