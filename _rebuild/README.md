# 餐廳資料庫更新工具集 (2026-05-13)

## 已完成
- `restaurants_database.json` 已更新為 916 間 enabled 餐廳（基於 RestaurantQuery 260513.csv）
- `restaurants_database_archive.json` 保存 143 間下架餐廳的歷史紀錄
- `netlify/functions/restaurants_database.json` 已同步

## 目前狀態
- 743 間：交集（沿用舊資料）
- 173 間：新店，cuisine/type/budget/images/opening_hours 等暫時空白，`needs_scrape=true`
- 143 間：歸檔（從推薦池移除）

## 之後要跑（按順序）

### Step 1：等 OpenRice Captcha 解除（1-2 小時後再開始）
```bash
# 測試是否已解除
python3 -c "import requests; r=requests.get('https://tw.openrice.com/zh/taiwan'); print('captcha' in r.url.lower() and '還被擋' or '可以了')"
```

### Step 2：為 173 間新店找完整 URL
```bash
pip install playwright
python -m playwright install chromium

# 第一次建議用 headed 模式（看到瀏覽器，方便解 captcha）
python3 _rebuild/find_urls.py --headed --limit 20    # 先試 20 筆

# 順利的話跑全部
python3 _rebuild/find_urls.py
```
產出 `_rebuild/find_urls.progress.json`

### Step 3：把找到的 URL 寫回主 DB
```bash
# 修改 06_merge_scraped.py 適配 find_urls 的格式，或手動處理
# 簡單做法：把 find_urls.progress.json 內的 url 欄位 merge 到主 DB
```

### Step 4：重爬全部 916 間最新資料
```bash
# 慢速、單線程，每筆 3-5 秒
python3 _rebuild/05_rescrape.py
# 約 1 小時，遇 captcha 會自動停下存進度
```

### Step 5：把爬到的最新資料 merge 回主 DB
```bash
python3 _rebuild/06_merge_scraped.py
```

## 檔案說明

```
_rebuild/
├── 01_test_openrice_id.py        測試用，可刪
├── 02_expand_old_urls.py         展開舊 DB 短網址（已跑完）
├── 03_scrape_one.py              測試用單筆爬取
├── 04_assemble_new_db.py         組裝新 DB（已跑完）
├── 05_rescrape.py                ★ 慢速重爬腳本（之後用）
├── 06_merge_scraped.py           ★ 合併爬到的資料回主 DB
├── 07_diff_report.py             印 diff 報告
├── 08_split_and_deploy.py        拆 active/archive + 覆蓋主檔（已跑完）
├── 09_sanity_check.js            Node sanity check（已通過）
├── scraper.py                    OpenRice parser 共用模組
├── find_urls.py                  ★ Playwright 找 URL（173 間新店）
├── old_db_with_or_id.json        舊 DB + OpenRice ID（中繼）
├── new_restaurants_database.json 完整版（含 disabled）
└── backups/                      備份目錄
    ├── restaurants_database.20260513_1923.json         舊主檔備份
    └── restaurants_database.netlify.20260513_1923.json 舊 netlify 備份
```

## 還原方法
如要還原為舊版本：
```bash
cp _rebuild/backups/restaurants_database.20260513_1923.json restaurants_database.json
cp _rebuild/backups/restaurants_database.netlify.20260513_1923.json netlify/functions/restaurants_database.json
```
