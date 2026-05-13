#!/usr/bin/env python3
"""
OpenRice 整合 parser：一次抓 cuisine/type/budget/images/opening_hours/dish/coordinates
模組形式提供，供 rescrape_all.py / find_urls.py 使用
"""
import re
import json
import time
import random
import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
DAY_CH = {'一': 'monday', '二': 'tuesday', '三': 'wednesday',
          '四': 'thursday', '五': 'friday', '六': 'saturday', '日': 'sunday'}


def make_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(total=3, backoff_factor=1.5, status_forcelist=[429, 500, 502, 503, 504])
    s.mount('https://', HTTPAdapter(max_retries=retry))
    s.headers.update({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        'Referer': 'https://tw.openrice.com/',
    })
    return s


def is_captcha(html: str, final_url: str = '') -> bool:
    return 'captcha' in final_url.lower() or 'OpenRice Captcha' in html or '/fragments/captcha' in html


def parse_openrice_page(html: str) -> dict:
    """從 OpenRice 餐廳頁 HTML 解出所有欄位"""
    soup = BeautifulSoup(html, 'html.parser')
    out = {}

    # 結業偵測
    text_all = soup.get_text()
    out['closed'] = any(k in text_all for k in ['已結業', '已歇業', '已停業'])

    # cuisine_style + type
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
    out['cuisine_style'] = list(dict.fromkeys(cuisines))
    out['type'] = list(dict.fromkeys(types))

    # budget
    budget = None
    m = re.search(r'NT\$(\d+)\s*[-~至]\s*(?:NT\$)?(\d+)', text_all)
    if m:
        budget = f"NT${m.group(1)}-{m.group(2)}"
    else:
        m = re.search(r'NT\$(\d+)以上', text_all)
        if m:
            budget = f"NT${m.group(1)}以上"
        else:
            m = re.search(r'NT\$(\d+)(?!\d)', text_all)
            if m:
                budget = f"NT${m.group(1)}"
    out['budget'] = budget

    # opening_hours
    hours = {d: [] for d in DAYS}
    oh = soup.select_one('.opening-hours-list')
    if oh:
        for de in oh.select('.opening-hours-day'):
            date_e = de.select_one('.opening-hours-date')
            time_e = de.select_one('.opening-hours-time')
            if not (date_e and time_e):
                continue
            date_txt = date_e.get_text(strip=True)
            day_key = next((en for ch, en in DAY_CH.items() if ch in date_txt), None)
            if not day_key:
                continue
            divs = time_e.find_all('div')
            slots = []
            if len(divs) > 1:
                for d in divs:
                    t = d.get_text(strip=True)
                    if t: slots.append(t)
            else:
                for ln in time_e.get_text(strip=True).split('\n'):
                    ln = ln.strip()
                    if ln: slots.append(ln)
            hours[day_key] = slots
    out['opening_hours'] = hours

    # images
    images = []
    for img in soup.find_all('img'):
        src = img.get('src') or img.get('data-src') or img.get('data-lazy-src') or ''
        if 'orstatic.com' in src and 'userphoto' in src:
            images.append(src)
    out['images'] = list(dict.fromkeys(images))[:20]

    # dish
    dish = []
    for sel in ['.recommend-dish', '.signature-dish', '.dish-name']:
        for el in soup.select(sel):
            t = el.get_text(strip=True)
            if t: dish.append(t)
    out['dish'] = list(dict.fromkeys(dish))

    # coordinates - 從 JSON-LD
    coords = None
    for ld in soup.find_all('script', type='application/ld+json'):
        try:
            data = json.loads(ld.string or '{}')
            if isinstance(data, dict):
                geo = data.get('geo') or {}
                if geo.get('latitude'):
                    coords = {'lat': float(geo['latitude']), 'lng': float(geo['longitude'])}
                    break
        except Exception:
            pass
    if not coords:
        m = re.search(r'latitude["\']?\s*[:=]\s*["\']?(-?\d+\.\d+)["\']?[,\s]+longitude["\']?\s*[:=]\s*["\']?(-?\d+\.\d+)',
                      html, re.IGNORECASE)
        if m:
            coords = {'lat': float(m.group(1)), 'lng': float(m.group(2))}
    out['coordinates'] = coords

    # is_buffet
    out['is_buffet'] = any(k in (cuisines + types) for k in ['吃到飽', '放題', 'Buffet'])

    return out


def fetch_and_parse(session: requests.Session, url: str, retries: int = 2) -> dict:
    """打 URL → 偵測 captcha → parse；遇 captcha 拋例外停下"""
    for attempt in range(retries + 1):
        try:
            r = session.get(url, timeout=20)
            r.raise_for_status()
            if is_captcha(r.text, r.url):
                raise CaptchaError(f"被 Captcha 擋: {r.url}")
            return {**parse_openrice_page(r.text), 'final_url': r.url, 'ok': True}
        except CaptchaError:
            raise
        except requests.RequestException as e:
            if attempt < retries:
                time.sleep(5 * (attempt + 1))
                continue
            return {'ok': False, 'error': str(e)}
    return {'ok': False, 'error': 'unknown'}


class CaptchaError(Exception):
    """被 OpenRice Captcha 擋下時拋出"""
    pass


def sleep_jitter(base: float = 3.0, jitter: float = 2.0):
    """隨機延遲，避免被反爬蟲"""
    time.sleep(base + random.random() * jitter)
