#!/usr/bin/env python3
"""抓取地圖「知名地標錨點」資料 → frontend/liff/data/landmarks.json

為什麼需要這支：OpenRice checker 資料只涵蓋在 OpenRice 上架的餐廳，
連鎖速食幾乎不在上面（全台北只有 1 家麥當勞）——但用戶認路靠的正是
「麥當勞、星巴克、新光三越」這種招牌（Google Maps 的定位錨點一半是它們）。
本腳本從 OpenStreetMap Overpass API 抓台北盆地的連鎖品牌與零售錨點，
配上內建的策展地標（夜市/廟宇/公園/景點，OSM 不用抓也不會變）。

輸出 landmarks.json：
  spots:  知名地標（策展 + OSM 百貨/賣場），地圖 z≥14 顯示（棕色區域錨點）
  brands: 連鎖品牌分店（麥當勞/星巴克…），z≥16 顯示（灰藍小字）

執行環境：GitHub Actions（refresh-landmarks.yml，每月+手動）或任何有網路的機器。
沙箱/離線跑到 Overpass 不通時：已有舊檔就保留不動，沒有就寫出策展種子。
零相依（純標準庫 urllib）。
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT_PATH = Path(__file__).parent / 'frontend/liff/data/landmarks.json'
BBOX = (24.95, 121.40, 25.15, 121.65)  # 台北市 + 板橋/永和/中和核心（南,西,北,東）

# ---- 策展地標種子：夜市/廟宇/公園/景點（座標穩定，不靠 OSM）----
SEED_SPOTS = [
    ('士林夜市', 25.0878, 121.5241), ('饒河街夜市', 25.0509, 121.5772),
    ('寧夏夜市', 25.0563, 121.5153), ('通化夜市', 25.0302, 121.5540),
    ('南機場夜市', 25.0316, 121.5049), ('華西街夜市', 25.0387, 121.5006),
    ('師大夜市', 25.0245, 121.5290), ('景美夜市', 24.9926, 121.5410),
    ('龍山寺', 25.0372, 121.4999), ('大龍峒保安宮', 25.0730, 121.5155),
    ('台北孔廟', 25.0727, 121.5166),
    ('中正紀念堂', 25.0347, 121.5218), ('國立故宮博物院', 25.1024, 121.5485),
    ('台北101', 25.0340, 121.5645), ('西門紅樓', 25.0421, 121.5069),
    ('華山1914', 25.0442, 121.5294), ('松山文創園區', 25.0439, 121.5605),
    ('大安森林公園', 25.0296, 121.5357), ('二二八和平公園', 25.0400, 121.5150),
    ('榮星花園', 25.0625, 121.5385), ('花博公園', 25.0699, 121.5205),
    ('美麗華百樂園', 25.0836, 121.5573), ('京站時尚廣場', 25.0490, 121.5175),
    ('光華商場', 25.0450, 121.5310), ('台北小巨蛋', 25.0512, 121.5510),
    ('松山機場', 25.0632, 121.5523), ('圓山大飯店', 25.0794, 121.5262),
    ('板橋車站', 25.0140, 121.4640),
]

# ---- 連鎖品牌（→ brands，z≥16 灰藍小字）：canonical 顯示名 → OSM name 關鍵字 ----
FOOD_BRANDS = {
    '麥當勞': ['麥當勞', "mcdonald"], '肯德基': ['肯德基', 'kfc'],
    '星巴克': ['星巴克', 'starbucks'], '摩斯漢堡': ['摩斯', 'mos burger'],
    '吉野家': ['吉野家', 'yoshinoya'], '必勝客': ['必勝客', 'pizza hut'],
    '達美樂': ['達美樂', "domino"], '漢堡王': ['漢堡王', 'burger king'],
    '頂呱呱': ['頂呱呱'], '三商巧福': ['三商巧福'], '鬍鬚張': ['鬍鬚張'],
    '路易莎': ['路易莎', 'louisa'], '八方雲集': ['八方雲集'],
    '85度C': ['85度c', '85°c'], 'SUBWAY': ['subway'],
    '爭鮮': ['爭鮮'], '藏壽司': ['藏壽司', 'kura sushi'], '壽司郎': ['壽司郎', 'sushiro'],
    '春水堂': ['春水堂'], '鼎泰豐': ['鼎泰豐', 'din tai fung'],
    '大戶屋': ['大戶屋'], '丹堤咖啡': ['丹堤'], '麥味登': ['麥味登'],
    'cama咖啡': ['cama'], '伯朗咖啡': ['伯朗咖啡'], '拿坡里': ['拿坡里'],
    # 家樂福放品牌層（z16）不放地標層：OSM 會匹配到上百家小型「便利購」，
    # 當 z14 棕字是雜訊、當街區招牌剛好
    '家樂福': ['家樂福', 'carrefour'],
}
# ---- 零售錨點（→ spots，z≥14 棕色）：百貨/賣場是比商圈更具體的認路點 ----
RETAIL_ANCHORS = {
    '新光三越': ['新光三越'], 'SOGO': ['sogo'], '微風': ['微風廣場', '微風南山', '微風松高', '微風信義'],
    '遠東百貨': ['遠東百貨', '大遠百'], '誠品生活': ['誠品生活', '誠品書店'],
    '三創生活': ['三創'], 'IKEA': ['ikea'], '好市多': ['好市多', 'costco'],
    '統一時代百貨': ['統一時代'],
    '環球購物中心': ['環球購物'], 'ATT 4 FUN': ['att 4 fun'], 'CITYLINK': ['citylink'],
}

OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]


def dist_m(a, b):
    dy = (a[0] - b[0]) * 111320
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(25.05))
    return math.hypot(dx, dy)


def overpass_fetch():
    """一次抓回所有品牌/零售關鍵字命中的 node/way（way 取中心點）。"""
    kws = sorted({k for alts in list(FOOD_BRANDS.values()) + list(RETAIL_ANCHORS.values()) for k in alts})
    regex = '|'.join(kws)
    s, w, n, e = BBOX
    q = (f'[out:json][timeout:90];('
         f'node["name"~"{regex}",i]({s},{w},{n},{e});'
         f'way["name"~"{regex}",i]({s},{w},{n},{e});'
         f');out center 4000;')
    body = urllib.parse.urlencode({'data': q}).encode()
    for url in OVERPASS_MIRRORS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=body, headers={'User-Agent': 'openrice-what-to-eat/1.0'})
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.load(r)['elements']
            except Exception as exc:  # noqa: BLE001 — 換鏡站重試
                print(f'  {url} 第 {attempt + 1} 次失敗：{exc}', file=sys.stderr)
                time.sleep(3)
    return None


def canonical_of(name, table):
    low = name.lower()
    for canon, alts in table.items():
        if any(a in low for a in alts):
            return canon
    return None


def collect(elements):
    """OSM elements → (brands, retail_spots)，每品牌 350m 間距去重（錨點不是店鋪目錄）。"""
    by_brand, by_retail = {}, {}
    for el in elements:
        name = (el.get('tags') or {}).get('name', '')
        if not name:
            continue
        lat = el.get('lat') or (el.get('center') or {}).get('lat')
        lng = el.get('lon') or (el.get('center') or {}).get('lon')
        if lat is None or lng is None:
            continue
        canon = canonical_of(name, FOOD_BRANDS)
        bucket = by_brand
        if not canon:
            canon = canonical_of(name, RETAIL_ANCHORS)
            bucket = by_retail
        if not canon:
            continue
        pts = bucket.setdefault(canon, [])
        if all(dist_m((lat, lng), (p[0], p[1])) >= 350 for p in pts):
            pts.append((round(lat, 6), round(lng, 6)))
    brands = [{'n': c, 'lat': lat, 'lng': lng} for c, pts in by_brand.items() for lat, lng in pts]
    retail = [{'n': c, 'lat': lat, 'lng': lng} for c, pts in by_retail.items() for lat, lng in pts]
    return brands, retail


def main():
    seed = [{'n': n, 'lat': lat, 'lng': lng} for n, lat, lng in SEED_SPOTS]
    elements = overpass_fetch()
    if elements is None:
        if OUT_PATH.exists():
            print('Overpass 全鏡站失敗：保留現有 landmarks.json 不動')
            return
        print('Overpass 失敗且無舊檔：寫出策展種子（brands 留待下次補）')
        brands, retail = [], []
    else:
        brands, retail = collect(elements)
        print(f'OSM 命中：品牌分店 {len(brands)}、零售錨點 {len(retail)}')
    # 零售錨點併入 spots，與種子 300m 去重（新光三越信義多館留 1-2 個即可）
    spots = list(seed)
    for r in retail:
        if all(dist_m((r['lat'], r['lng']), (s['lat'], s['lng'])) >= 300 for s in spots):
            spots.append(r)
    spots.sort(key=lambda p: (p['n'], p['lat']))
    brands.sort(key=lambda p: (p['n'], p['lat']))
    OUT_PATH.write_text(
        json.dumps({'spots': spots, 'brands': brands}, ensure_ascii=False, separators=(',', ':')) + '\n',
        encoding='utf-8')
    print(f'寫出 {OUT_PATH}：spots {len(spots)}、brands {len(brands)}')


if __name__ == '__main__':
    main()
