#!/bin/bash
# Netlify 構建腳本
# 將數據庫文件複製到函數目錄，並確保共享模組被複製到 web 目錄

echo "開始 Netlify 構建..."

# 生成生活地圖 pin 資料（失敗時使用已提交的 frontend/liff/data/map_pins.json）
if command -v python3 >/dev/null 2>&1 && [ -f "generate_map_pins.py" ]; then
  echo "生成地圖 pin 資料..."
  if python3 generate_map_pins.py; then
    echo "✅ map_pins.json 生成成功"
  else
    echo "⚠️ map_pins.json 生成失敗，使用已提交版本"
  fi
fi

# 檢查數據庫文件是否存在
if [ -f "restaurants_database.json" ]; then
  echo "找到數據庫文件，複製到函數目錄..."
  cp restaurants_database.json netlify/functions/restaurants_database.json
  if [ $? -eq 0 ]; then
    echo "✅ 數據庫文件複製成功"
    ls -lh netlify/functions/restaurants_database.json
  else
    echo "❌ 數據庫文件複製失敗"
    exit 1
  fi
else
  echo "❌ 找不到數據庫文件 restaurants_database.json"
  exit 1
fi

# 確保共享模組被複製到 web 目錄
if [ -d "frontend/shared" ]; then
  echo "複製共享模組到 web 目錄..."
  cp -r frontend/shared frontend/web/shared
  if [ $? -eq 0 ]; then
    echo "✅ Web 共享模組複製成功"
  else
    echo "❌ Web 共享模組複製失敗"
    exit 1
  fi
fi

# 確保共享模組被複製到 liff 目錄（在複製 LIFF App 之前）
if [ -d "frontend/shared" ]; then
  echo "複製共享模組到 liff 目錄..."
  cp -r frontend/shared frontend/liff/shared
  if [ $? -eq 0 ]; then
    echo "✅ LIFF 共享模組複製成功"
  else
    echo "❌ LIFF 共享模組複製失敗"
    exit 1
  fi
fi

# 將 LIFF App 複製到 web 目錄，以便部署到 Netlify
if [ -d "frontend/liff" ]; then
  echo "複製 LIFF App 到 web 目錄..."
  mkdir -p frontend/web/liff
  cp -r frontend/liff/* frontend/web/liff/
  if [ $? -eq 0 ]; then
    echo "✅ LIFF App 複製成功"
    echo "LIFF App 將可通過 /liff 路徑訪問"
  else
    echo "❌ LIFF App 複製失敗"
    exit 1
  fi
fi

# 確保 web/liff/shared 也是最新的（覆蓋確保）
if [ -d "frontend/shared" ] && [ -d "frontend/web/liff/shared" ]; then
  echo "確保 web/liff/shared 是最新的..."
  cp -r frontend/shared/* frontend/web/liff/shared/
  if [ $? -eq 0 ]; then
    echo "✅ web/liff/shared 更新成功"
  fi
fi

# 複製抽獎系統資料庫到函數目錄（後備方案，如果使用 Supabase 則不需要）
if [ -d "data" ]; then
  echo "複製抽獎系統資料庫到函數目錄..."
  mkdir -p netlify/functions/data
  cp -r data/* netlify/functions/data/
  if [ $? -eq 0 ]; then
    echo "✅ 抽獎系統資料庫複製成功"
  else
    echo "❌ 抽獎系統資料庫複製失敗"
  fi
fi

# 複製 Supabase 客戶端到函數目錄
if [ -d "supabase" ]; then
  echo "複製 Supabase 客戶端到函數目錄..."
  mkdir -p netlify/functions/supabase
  cp -r supabase/* netlify/functions/supabase/
  if [ $? -eq 0 ]; then
    echo "✅ Supabase 客戶端複製成功"
  else
    echo "❌ Supabase 客戶端複製失敗"
  fi
fi

# 複製後台管理頁面到 web 目錄
if [ -d "frontend/admin" ]; then
  echo "複製後台管理頁面到 web 目錄..."
  mkdir -p frontend/web/admin
  cp -r frontend/admin/* frontend/web/admin/
  if [ $? -eq 0 ]; then
    echo "✅ 後台管理頁面複製成功"
  else
    echo "❌ 後台管理頁面複製失敗"
  fi
fi

echo "構建完成"
