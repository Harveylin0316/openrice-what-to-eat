#!/usr/bin/env python3
"""
把外部爬蟲產出的 restaurants_for_app.xlsx merge 進主 DB。

外部檔來源：openrice-crawler/exports/restaurants_for_app.xlsx（928 餐廳）
比我們 DB 多 rating / review_count / smile_count / bookmark_count / photo_count
/ landmark_names / business_hours_json / today_status / open_late / open_early
等高價值欄位。

策略：
- poi_id == 我們的 or_id（已驗證 EZO=565470 對齊）
- 用新檔覆蓋大部分欄位，保留我們之前的 images 陣列（新檔只有 door_photo_url 單張）
- 不在新檔的店：標 enabled=false（從推薦池移除）
- 移除 slogans 欄位（omikuji 已棄用，改 evidence）
"""
import openpyxl
import json
import os
import re
from datetime import datetime

XLSX = '/Users/harveylin/Desktop/Claude-workspace/projects/openrice-crawler/exports/restaurants_for_app.xlsx'
MAIN_DB = 'restaurants_database.json'
NETLIFY_DB = 'netlify/functions/restaurants_database.json'

DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
DAY_CH = {'一': 'monday', '二': 'tuesday', '三': 'wednesday',
          '四': 'thursday', '五': 'friday', '六': 'saturday', '日': 'sunday'}


def parse_day_range(date_txt: str):
    """『星期一至二』『星期三、五』『星期日』 → day_key list"""
    txt = (date_txt or '').replace('星期', '').strip()
    if '至' in txt:
        parts = [p.strip() for p in txt.split('至')]
        if len(parts) == 2 and parts[0] in DAY_CH and parts[1] in DAY_CH:
            si = DAYS.index(DAY_CH[parts[0]])
            ei = DAYS.index(DAY_CH[parts[1]])
            if si <= ei:
                return DAYS[si:ei + 1]
            return [DAYS[si], DAYS[ei]]
    if any(sep in txt for sep in ['、', ',', '，']):
        days = []
        for ch in re.split(r'[、,，]', txt):
            ch = ch.strip()
            if ch in DAY_CH: days.append(DAY_CH[ch])
        if days: return days
    if txt in DAY_CH: return [DAY_CH[txt]]
    for ch, en in DAY_CH.items():
        if ch in txt: return [en]
    return []


# OpenRice region 字串 → 台灣縣市對應（前端 city 篩選用「台北市/新北市」這種正式名稱）
REGION_TO_CITY = {
    '台北': '台北市',
    '桃園': '桃園市',
    '台中': '台中市',
    '台南': '台南市',
}
# 含歧義的 region（要看 district 細分）
KEELUNG_DISTRICTS = {'中正區', '七堵區', '暖暖區', '仁愛區', '信義區', '中山區', '安樂區'}
PINGTUNG_DISTRICTS = {'屏東市', '潮州鎮', '東港鎮', '恆春鎮', '萬丹鄉', '長治鄉', '麟洛鄉', '九如鄉', '里港鄉', '鹽埔鄉', '高樹鄉', '萬巒鄉', '內埔鄉', '竹田鄉', '新埤鄉', '枋寮鄉', '新園鄉', '崁頂鄉', '林邊鄉', '佳冬鄉', '琉球鄉', '車城鄉', '滿州鄉', '枋山鄉', '三地門鄉', '霧台鄉', '瑪家鄉', '泰武鄉', '來義鄉', '春日鄉', '獅子鄉', '牡丹鄉'}
MIAOLI_DISTRICTS = {'苗栗市', '苑裡鎮', '通霄鎮', '竹南鎮', '頭份市', '後龍鎮', '卓蘭鎮', '大湖鄉', '公館鄉', '銅鑼鄉', '南庄鄉', '頭屋鄉', '三義鄉', '西湖鄉', '造橋鄉', '三灣鄉', '獅潭鄉', '泰安鄉'}
HSINCHU_COUNTY_DISTRICTS = {'竹北市', '竹東鎮', '新埔鎮', '關西鎮', '湖口鄉', '新豐鄉', '芎林鄉', '橫山鄉', '北埔鄉', '寶山鄉', '峨眉鄉', '尖石鄉', '五峰鄉'}
NANTOU_DISTRICTS = {'南投市', '埔里鎮', '草屯鎮', '竹山鎮', '集集鎮', '名間鄉', '鹿谷鄉', '中寮鄉', '魚池鄉', '國姓鄉', '水里鄉', '信義鄉', '仁愛鄉'}
YUNLIN_DISTRICTS = {'斗六市', '斗南鎮', '虎尾鎮', '西螺鎮', '土庫鎮', '北港鎮', '林內鄉', '古坑鄉', '大埤鄉', '莿桐鄉', '褒忠鄉', '臺西鄉', '台西鄉', '元長鄉', '四湖鄉', '口湖鄉', '水林鄉'}
EAST_REGIONS = {
    '宜蘭縣': {'宜蘭市', '羅東鎮', '蘇澳鎮', '頭城鎮', '礁溪鄉', '壯圍鄉', '員山鄉', '冬山鄉', '五結鄉', '三星鄉', '大同鄉', '南澳鄉'},
    '花蓮縣': {'花蓮市', '鳳林鎮', '玉里鎮', '新城鄉', '吉安鄉', '壽豐鄉', '光復鄉', '豐濱鄉', '瑞穗鄉', '富里鄉', '秀林鄉', '萬榮鄉', '卓溪鄉'},
    '台東縣': {'臺東市', '台東市', '成功鎮', '關山鎮', '卑南鄉', '鹿野鄉', '池上鄉', '東河鄉', '長濱鄉', '太麻里鄉', '大武鄉', '綠島鄉', '蘭嶼鄉', '延平鄉', '海端鄉', '達仁鄉', '金峰鄉'},
    '澎湖縣': {'馬公市', '湖西鄉', '白沙鄉', '西嶼鄉', '望安鄉', '七美鄉'},
    '金門縣': {'金城鎮', '金湖鎮', '金沙鎮', '金寧鄉', '烈嶼鄉', '烏坵鄉'},
    '連江縣': {'南竿鄉', '北竿鄉', '莒光鄉', '東引鄉'},
}


def region_district_to_city(region, district):
    """OpenRice region + district → 台灣正式縣市名"""
    if not region:
        return ''
    # 單一直轄市
    if region in REGION_TO_CITY:
        return REGION_TO_CITY[region]
    # 新北/基隆
    if region == '新北/基隆':
        return '基隆市' if district in KEELUNG_DISTRICTS else '新北市'
    # 高雄/屏東
    if region == '高雄/屏東':
        return '屏東縣' if district in PINGTUNG_DISTRICTS else '高雄市'
    # 新竹/苗栗
    if region == '新竹/苗栗':
        if district in MIAOLI_DISTRICTS: return '苗栗縣'
        if district in HSINCHU_COUNTY_DISTRICTS: return '新竹縣'
        return '新竹市'
    # 彰化/南投
    if region == '彰化/南投':
        return '南投縣' if district in NANTOU_DISTRICTS else '彰化縣'
    # 雲林/嘉義
    if region == '雲林/嘉義':
        if district in YUNLIN_DISTRICTS: return '雲林縣'
        return '嘉義市'
    # 宜花東暨離島
    if region == '宜花東暨離島':
        for city, dists in EAST_REGIONS.items():
            if district in dists: return city
        return ''
    return region  # fallback 原值


def normalize_budget(s):
    """OpenRice 原始 price_range_label → 乾淨中文。
    例：NT$1501-2147483647 → 1500 元以上、NT$201-500 → 200-500 元
    """
    if not s:
        return None
    s = str(s).strip()
    # 範圍：NT$1501-2147483647（int max sentinel）→ 「N 元以上」
    m = re.match(r'NT\$(\d+)-(\d+)', s)
    if m:
        low, high = int(m.group(1)), int(m.group(2))
        if high > 100000:
            # 1501 → 1500、2001 → 2000，往下整百
            rounded = ((low - 1) // 100) * 100
            return f'{rounded} 元以上'
        # 一般範圍：201 → 200 整百起點看起來舒服
        low_disp = low if low % 100 == 0 else (low // 100) * 100 or low
        return f'{low_disp}-{high} 元'
    # 「<100」
    m = re.match(r'NT\$<(\d+)', s)
    if m:
        return f'{m.group(1)} 元以內'
    # 單值
    m = re.match(r'NT\$(\d+)$', s)
    if m:
        return f'{m.group(1)} 元'
    return s


def parse_business_hours_json(json_str):
    """OpenRice business_hours_json → {monday:[...], ...}"""
    hours = {d: [] for d in DAYS}
    if not json_str:
        return hours
    try:
        data = json.loads(json_str) if isinstance(json_str, str) else json_str
    except json.JSONDecodeError:
        return hours
    for entry in data.get('normalHours', []):
        date_disp = entry.get('dateDisplayString', '')
        day_keys = parse_day_range(date_disp)
        slots = []
        for t in entry.get('times', []):
            ts = t.get('timeDisplayString', '').strip()
            if ts and '-' in ts:
                slots.append(ts.replace(' ', ''))  # "11:00 - 21:00" → "11:00-21:00"
        for dk in day_keys:
            hours[dk] = slots
    return hours


def split_csv_field(v):
    if not v: return []
    return [s.strip() for s in str(v).split(',') if s.strip()]


def load_xlsx():
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb['restaurants']
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    idx = {h: i for i, h in enumerate(header)}
    records = []
    for r in rows[1:]:
        rec = {h: r[i] for h, i in idx.items()}
        records.append(rec)
    return records


def map_to_db_schema(rec, existing=None):
    """從 xlsx record 轉成我們 DB 的 restaurant 物件
    existing 為現有 DB 內同一 or_id 的舊資料（保留 images 陣列）"""
    poi_id = int(rec['poi_id'])
    is_normal = rec.get('status') == 'Normal' and not rec.get('blacklisted')
    cuisines = split_csv_field(rec.get('cuisines'))
    categories = split_csv_field(rec.get('categories'))
    dishes = split_csv_field(rec.get('dishes'))

    # 從 categories 或 cuisines 推 cuisine_style
    # OpenRice 把料理風格放 cuisines，類型放 categories
    cuisine_style = cuisines or []  # 部分店 cuisines 為 None
    type_list = categories or []

    out = {
        'or_id': poi_id,
        'name': rec.get('name_tc') or rec.get('name_en') or '',
        'address': rec.get('address') or '',
        'phone': rec.get('phone') or '',
        'region': rec.get('region') or '',
        'district': rec.get('district') or '',
        'services': split_csv_field(rec.get('services_type')),
        # 嚴格 bookable：is_bookable=1 且 or_status='Normal'。
        # 「Renovate / Hide / Moved」這類雖然 status=Normal 但 OpenRice 頁面
        # 會顯示「網上訂位即將推出」或無法訂位，不該標「線上可訂位」chip。
        'bookable': bool(rec.get('is_bookable')) and rec.get('or_status') == 'Normal',
        'enabled': bool(is_normal),
        'cuisine_style': cuisine_style,
        'type': type_list,
        'budget': normalize_budget(rec.get('price_range_label')),
        'url': rec.get('or_url') or rec.get('short_url') or None,
        'coordinates': (
            {'lat': float(rec['lat']), 'lng': float(rec['lng'])}
            if rec.get('lat') and rec.get('lng') else None
        ),
        'city': region_district_to_city(rec.get('region'), rec.get('district')),
        'dish': dishes,
        'is_buffet': any('吃到飽' in c or 'Buffet' in c.lower() for c in (categories + dishes)),
        'opening_hours': parse_business_hours_json(rec.get('business_hours_json')),
        # 新加：高價值評分／統計欄位
        'rating': rec.get('overall_rating'),
        'smile_count': rec.get('smile_count'),
        'ok_count': rec.get('ok_count'),
        'cry_count': rec.get('cry_count'),
        'review_count': rec.get('review_count'),
        'bookmark_count': rec.get('bookmark_count'),
        'photo_count': rec.get('photo_count'),
        'today_status': rec.get('today_status'),
        'open_late': bool(rec.get('open_late')),
        'open_early': bool(rec.get('open_early')),
        'landmarks': split_csv_field(rec.get('landmark_names')),
        'is_paid_account': bool(rec.get('is_paid_account')),
        'price_min': rec.get('price_min'),
        'price_max': rec.get('price_max'),
        'door_photo_url': rec.get('door_photo_url') or None,
    }

    # 保留既有 images（新檔只有 door_photo_url 單張，我們的 images 陣列珍貴）
    if existing:
        old_images = existing.get('images', [])
        if old_images:
            out['images'] = old_images
        elif out['door_photo_url']:
            out['images'] = [out['door_photo_url']]
        else:
            out['images'] = []
    else:
        out['images'] = [out['door_photo_url']] if out['door_photo_url'] else []

    if not is_normal:
        out['disabled_reason'] = f"status={rec.get('status')} blacklisted={rec.get('blacklisted')}"

    return out


def main():
    print('讀外部 xlsx...')
    records = load_xlsx()
    print(f'  總筆數: {len(records)}')

    print('讀現有 DB...')
    with open(MAIN_DB, encoding='utf-8') as f:
        old_db = json.load(f)['restaurants']
    old_by_id = {int(r['or_id']): r for r in old_db if r.get('or_id')}
    print(f'  現有總筆數: {len(old_db)}, 有 or_id: {len(old_by_id)}')

    # 建新 DB
    new_db = []
    seen_ids = set()

    for rec in records:
        mapped = map_to_db_schema(rec, existing=old_by_id.get(int(rec['poi_id'])))
        new_db.append(mapped)
        seen_ids.add(mapped['or_id'])

    # 不在新檔的：歸檔 enabled=false
    legacy_count = 0
    for r in old_db:
        oid = r.get('or_id')
        if oid and oid not in seen_ids:
            # 從舊 DB 搬過來，保留 schema 一致
            legacy = dict(r)
            legacy['enabled'] = False
            legacy['disabled_reason'] = legacy.get('disabled_reason') or 'not in external xlsx 2026-05-22'
            # 拿掉 slogans（omikuji 棄用）
            legacy.pop('slogans', None)
            new_db.append(legacy)
            legacy_count += 1

    print(f'  新檔內: {len(records)}, 舊 DB 但不在新檔: {legacy_count}')
    print(f'  新 DB 總筆數: {len(new_db)}')

    enabled = sum(1 for r in new_db if r.get('enabled'))
    bookable = sum(1 for r in new_db if r.get('enabled') and r.get('bookable'))
    has_rating = sum(1 for r in new_db if r.get('enabled') and r.get('rating'))
    has_reviews = sum(1 for r in new_db if r.get('enabled') and r.get('review_count'))
    has_hours = sum(1 for r in new_db if r.get('enabled') and any(r.get('opening_hours', {}).get(d) for d in DAYS))
    print(f'\n=== enabled 統計（{enabled} 間）===')
    print(f'  bookable: {bookable}')
    print(f'  有 rating: {has_rating}')
    print(f'  有 review_count: {has_reviews}')
    print(f'  有 opening_hours: {has_hours}')

    # 寫主 DB
    out = {
        'restaurants': new_db,
        '_metadata': {
            'updated_at': datetime.now().isoformat(),
            'source': 'openrice-crawler/exports/restaurants_for_app.xlsx',
            'total': len(new_db),
            'enabled': enabled,
            'has_rating': has_rating,
            'has_review_count': has_reviews,
        }
    }
    with open(MAIN_DB, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    with open(NETLIFY_DB, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f'\n寫入: {MAIN_DB}  ({os.path.getsize(MAIN_DB)//1024} KB)')
    print(f'寫入: {NETLIFY_DB}  ({os.path.getsize(NETLIFY_DB)//1024} KB)')


if __name__ == '__main__':
    main()
