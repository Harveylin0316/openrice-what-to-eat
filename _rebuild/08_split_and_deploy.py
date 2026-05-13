#!/usr/bin/env python3
"""
最終步驟：
1. 把 new_restaurants_database.json 拆成 active (916 enabled) + archive (143 disabled)
2. 備份舊檔到 _rebuild/restaurants_database_backup_pre_d.json
3. 覆蓋 restaurants_database.json (active 916 間)
4. 同步 netlify/functions/restaurants_database.json
5. 額外存 restaurants_database_archive.json (143 間歷史紀錄)

跑這支會實際覆蓋檔案，跑之前先 dry-run 確認
"""
import json
import shutil
import os
from datetime import datetime

NEW_DB = '_rebuild/new_restaurants_database.json'
TARGET_MAIN = 'restaurants_database.json'
TARGET_NETLIFY = 'netlify/functions/restaurants_database.json'
ARCHIVE = 'restaurants_database_archive.json'
BACKUP_DIR = '_rebuild/backups'

DRY_RUN = '--apply' not in os.sys.argv

print(f"{'='*60}")
print(f"模式: {'APPLY (實際覆蓋)' if not DRY_RUN else 'DRY-RUN (預覽，加 --apply 才會真的寫)'}")
print(f"{'='*60}\n")

# 載入新 DB
with open(NEW_DB, encoding='utf-8') as f:
    data = json.load(f)
restaurants = data['restaurants']

active = [r for r in restaurants if r.get('enabled')]
disabled = [r for r in restaurants if not r.get('enabled')]
print(f"  active (enabled=true): {len(active)}")
print(f"  disabled (歸檔): {len(disabled)}")

# 把多餘的內部欄位清掉，讓主檔乾淨
def clean_active(r):
    rr = {k: v for k, v in r.items()
          if k not in ('disabled_reason',)}
    # 保留 needs_scrape 因為之後爬蟲會用
    return rr

active_clean = [clean_active(r) for r in active]

active_payload = {
    'restaurants': active_clean,
    '_metadata': {
        'updated_at': datetime.now().isoformat(),
        'source': 'RestaurantQuery 260513.csv',
        'total': len(active_clean),
        'needs_scrape_count': sum(1 for r in active_clean if r.get('needs_scrape')),
        'notes': '173 間新店 needs_scrape=true，待爬蟲補資料',
    },
}

archive_payload = {
    'restaurants': disabled,
    '_metadata': {
        'archived_at': datetime.now().isoformat(),
        'reason': 'not in active CSV 2026-05-13',
        'total': len(disabled),
    },
}

# 寫入位置與大小
print(f"\n預定動作:")
print(f"  📦 備份目前 {TARGET_MAIN} → {BACKUP_DIR}/restaurants_database.{datetime.now().strftime('%Y%m%d_%H%M')}.json")
print(f"  ✏️  覆蓋 {TARGET_MAIN}  (active 916 間)")
print(f"  ✏️  覆蓋 {TARGET_NETLIFY}  (active 916 間)")
print(f"  📝 新增 {ARCHIVE}  ({len(disabled)} 間歷史紀錄)")

if DRY_RUN:
    print(f"\n⚠ DRY-RUN，沒有真的寫檔。加 --apply 才會執行")
    print(f"   python3 _rebuild/08_split_and_deploy.py --apply")
    import sys; sys.exit(0)

# 實際執行 -----
os.makedirs(BACKUP_DIR, exist_ok=True)
ts = datetime.now().strftime('%Y%m%d_%H%M')

# 備份
backup_main = f'{BACKUP_DIR}/restaurants_database.{ts}.json'
if os.path.exists(TARGET_MAIN):
    shutil.copy(TARGET_MAIN, backup_main)
    print(f"\n✓ 備份: {backup_main}")

backup_netlify = f'{BACKUP_DIR}/restaurants_database.netlify.{ts}.json'
if os.path.exists(TARGET_NETLIFY):
    shutil.copy(TARGET_NETLIFY, backup_netlify)
    print(f"✓ 備份: {backup_netlify}")

# 覆蓋主檔
with open(TARGET_MAIN, 'w', encoding='utf-8') as f:
    json.dump(active_payload, f, ensure_ascii=False, indent=2)
print(f"✓ 寫入: {TARGET_MAIN}  ({os.path.getsize(TARGET_MAIN)//1024} KB)")

# 覆蓋 netlify
with open(TARGET_NETLIFY, 'w', encoding='utf-8') as f:
    json.dump(active_payload, f, ensure_ascii=False, indent=2)
print(f"✓ 寫入: {TARGET_NETLIFY}  ({os.path.getsize(TARGET_NETLIFY)//1024} KB)")

# 歸檔
with open(ARCHIVE, 'w', encoding='utf-8') as f:
    json.dump(archive_payload, f, ensure_ascii=False, indent=2)
print(f"✓ 寫入: {ARCHIVE}  ({os.path.getsize(ARCHIVE)//1024} KB)")

print(f"\n完成！")
