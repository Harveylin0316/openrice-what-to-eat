const fs = require('fs');
const path = require('path');

// 全域城市白名單：只服務北北基（改這裡 = 全站生效）
const CITY_ALLOWLIST = new Set(['台北市', '新北市', '基隆市']);

/**
 * 套用城市白名單，過濾掉其他縣市
 */
function applyCityAllowlist(data) {
  if (!data || !Array.isArray(data.restaurants)) return data;
  const before = data.restaurants.length;
  data.restaurants = data.restaurants.filter(r => CITY_ALLOWLIST.has(r.city));
  console.log(`CityAllowlist: kept ${data.restaurants.length}/${before} (北北基 only)`);
  return data;
}

/**
 * 載入餐廳資料庫
 */
function loadRestaurantDatabase() {
  // 如果設置了環境變數，優先使用它（Netlify Functions）
  if (process.env.RESTAURANT_DB_PATH && fs.existsSync(process.env.RESTAURANT_DB_PATH)) {
    console.log(`Found database via env var: ${process.env.RESTAURANT_DB_PATH}`);
    const data = fs.readFileSync(process.env.RESTAURANT_DB_PATH, 'utf-8');
    return applyCityAllowlist(JSON.parse(data));
  }
  
  // 嘗試多個可能的路徑（支持本地開發和 Netlify Functions）
  const possiblePaths = [
    path.join(__dirname, '../../restaurants_database.json'), // 本地開發
    path.join(__dirname, '../../../restaurants_database.json'), // Netlify Functions (從函數目錄向上)
    path.join(__dirname, '../../../../restaurants_database.json'), // Netlify Functions (更深層)
    path.join(process.cwd(), 'restaurants_database.json'), // 當前工作目錄
    path.resolve('./restaurants_database.json'), // 絕對路徑
    path.join('/opt/build/repo', 'restaurants_database.json'), // Netlify 構建目錄
    path.join(process.cwd(), '..', 'restaurants_database.json'), // 上一級目錄
    path.join(process.cwd(), '..', '..', 'restaurants_database.json') // 上兩級目錄
  ];
  
  const errors = [];
  for (const dbPath of possiblePaths) {
    try {
      if (fs.existsSync(dbPath)) {
        console.log(`Found database at: ${dbPath}`);
        const data = fs.readFileSync(dbPath, 'utf-8');
        return applyCityAllowlist(JSON.parse(data));
      } else {
        errors.push(`Path does not exist: ${dbPath}`);
      }
    } catch (err) {
      errors.push(`Error reading ${dbPath}: ${err.message}`);
      // 繼續嘗試下一個路徑
      continue;
    }
  }
  
  // 如果所有路徑都失敗，拋出詳細錯誤
  const errorMsg = `Database file not found.\n__dirname: ${__dirname}\nprocess.cwd(): ${process.cwd()}\nTried paths:\n${errors.join('\n')}`;
  console.error(errorMsg);
  throw new Error(errorMsg);
}

/**
 * 計算兩點之間的距離（使用 Haversine 公式）
 * @param {number} lat1 - 起點緯度
 * @param {number} lng1 - 起點經度
 * @param {number} lat2 - 終點緯度
 * @param {number} lng2 - 終點經度
 * @returns {number} 距離（公里）
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // 地球半徑（公里）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 解析預算區間字串為數字範圍
 * @param {string} budgetStr - 預算字串，例如 "500-800", "2000以上"
 * @returns {Object} { min: number, max: number } 或 null
 */
function parseBudgetRange(budgetStr) {
  if (!budgetStr) return null;
  
  // 處理 "XXX-XXX" 格式
  const rangeMatch = budgetStr.match(/(\d+)-(\d+)/);
  if (rangeMatch) {
    return {
      min: parseInt(rangeMatch[1]),
      max: parseInt(rangeMatch[2])
    };
  }
  
  // 處理 "XXX以上" 格式
  const aboveMatch = budgetStr.match(/(\d+)以上/);
  if (aboveMatch) {
    return {
      min: parseInt(aboveMatch[1]),
      max: Infinity
    };
  }
  
  // 處理 "XXX以下" 格式
  const belowMatch = budgetStr.match(/(\d+)以下/);
  if (belowMatch) {
    return {
      min: 0,
      max: parseInt(belowMatch[1])
    };
  }
  
  return null;
}

/**
 * 將資料庫的預算格式映射到前端的分類
 * @param {string} dbBudget - 資料庫中的預算格式
 * @returns {string|null} 前端預算分類
 */
function mapBudgetToCategory(dbBudget) {
  if (!dbBudget) return null;
  
  const range = parseBudgetRange(dbBudget);
  if (!range) return null;
  
  // 使用範圍的中心點來判斷分類
  const center = range.max === Infinity 
    ? range.min + 500  // 如果是「XXX以上」，假設範圍較大
    : (range.min + range.max) / 2;
  
  // 新的預算分類映射
  // 200元內：0-200（包含200）
  if (center <= 200) {
    return '200元內';
  }
  
  // 200-500元：200-500（包含200和500）
  if (center <= 500) {
    return '200-500元';
  }
  
  // 500-1000元：500-1000（包含500和1000）
  if (center <= 1000) {
    return '500-1000元';
  }
  
  // 1000-1500元：1000-1500（包含1000和1500）
  if (center <= 1500) {
    return '1000-1500元';
  }
  
  // 1500以上：1500以上
  return '1500以上';
}

/**
 * 檢查餐廳是否符合預算條件
 * @param {Object} restaurant - 餐廳物件
 * @param {string} userBudget - 使用者選擇的預算區間（前端分類）
 * @returns {boolean}
 */
function matchesBudget(restaurant, userBudget) {
  const restaurantBudget = restaurant.budget;
  
  // 如果餐廳沒有預算資料，跳過預算篩選
  if (!restaurantBudget) return true;
  
  // 如果使用者沒有選擇預算，不篩選
  if (!userBudget || userBudget === 'all') return true;
  
  // 將資料庫的預算格式映射到前端分類
  const restaurantCategory = mapBudgetToCategory(restaurantBudget);
  
  // 如果無法映射，跳過篩選
  if (!restaurantCategory) return true;
  
  // 檢查是否匹配用戶選擇的分類
  return restaurantCategory === userBudget;
}

/**
 * 前端分類到資料庫料理風格的映射
 */
const CUISINE_CATEGORY_MAP = {
  '台式料理': ['taiwanese', '台灣原住民料理', '台灣料理', '客家料理'],
  '中式/港粵': ['上海菜', '四川菜', '廣東菜-港式', '東北菜', '江浙菜', '湖南菜-湖北菜'],
  '日式料理': ['日式料理'],
  '韓式料理': ['韓式料理'],
  '美式料理': ['美國料理'],
  '東南亞料理': ['印尼料理', '星馬料理', '泰式料理'],
  '多國料理': ['多國料理']
};

/**
 * 檢查餐廳是否符合料理風格條件
 * @param {Object} restaurant - 餐廳物件
 * @param {Array<string>} userCuisines - 使用者選擇的料理風格分類陣列（前端7個分類）
 * @returns {boolean}
 */
function matchesCuisineStyle(restaurant, userCuisines) {
  if (!userCuisines || userCuisines.length === 0) return true;
  
  const restaurantCuisines = restaurant.cuisine_style || [];
  
  // 如果餐廳只有「一般」，只匹配「不限」（即沒有選擇料理風格）
  // 如果用戶選擇了特定的料理風格，則不匹配
  if (restaurantCuisines.length === 1 && restaurantCuisines[0] === '一般') {
    return false; // 不匹配任何特定的料理風格選擇
  }
  
  // 檢查用戶選擇的分類是否匹配餐廳的料理風格
  return userCuisines.some(category => {
    // 獲取該分類對應的所有資料庫料理風格
    const mappedStyles = CUISINE_CATEGORY_MAP[category] || [];
    // 檢查餐廳的料理風格是否包含該分類對應的任何一個風格
    return mappedStyles.some(style => restaurantCuisines.includes(style));
  });
}

/**
 * 前端分類到資料庫餐廳類型的映射
 */
const TYPE_CATEGORY_MAP = {
  '燒肉': ['燒肉店'],
  '火鍋': ['火鍋店'],
  '吃到飽': ['燒肉店', '火鍋店'], // 吃到飽可能同時是燒肉或火鍋
  '餐酒館': ['餐酒館'],
  '咖啡廳': ['咖啡廳(店)']
};

/**
 * 檢查餐廳是否符合類型條件
 * @param {Object} restaurant - 餐廳物件
 * @param {Array<string>} userTypes - 使用者選擇的餐廳類型陣列（前端5個分類）
 * @returns {boolean}
 */
function matchesType(restaurant, userTypes) {
  if (!userTypes || userTypes.length === 0) return true;
  
  const restaurantTypes = restaurant.type || [];
  
  // 特殊處理「吃到飽」：只匹配 type 中有「吃到飽」的餐廳
  if (userTypes.includes('吃到飽')) {
    const isBuffetMatch = restaurantTypes.includes('吃到飽');
    if (!isBuffetMatch) {
      // 如果用戶選擇了「吃到飽」但餐廳 type 中沒有「吃到飽」，則不匹配
      // 但需要檢查是否同時選擇了其他類型
      const otherTypes = userTypes.filter(t => t !== '吃到飽');
      if (otherTypes.length === 0) {
        return false; // 只選擇了「吃到飽」，但餐廳 type 中沒有
      }
      // 如果還選擇了其他類型，繼續檢查其他類型
      return matchesType(restaurant, otherTypes);
    }
  }
  
  // 如果餐廳只有「一般」，只匹配「不限」（即沒有選擇餐廳類型）
  // 如果用戶選擇了特定的餐廳類型，則不匹配
  if (restaurantTypes.length === 1 && restaurantTypes[0] === '一般') {
    return false; // 不匹配任何特定的餐廳類型選擇
  }
  
  // 檢查用戶選擇的分類是否匹配餐廳的類型
  return userTypes.some(category => {
    // 「吃到飽」已在上面特殊處理
    if (category === '吃到飽') {
      return restaurantTypes.includes('吃到飽');
    }
    
    // 獲取該分類對應的所有資料庫類型
    const mappedTypes = TYPE_CATEGORY_MAP[category] || [];
    // 檢查餐廳的類型是否包含該分類對應的任何一個類型
    return mappedTypes.some(type => restaurantTypes.includes(type));
  });
}

/**
 * 推薦餐廳
 * @param {Object} filters - 篩選條件
 * @param {number} limit - 返回的餐廳數量上限（預設5）
 * @returns {Array} 推薦的餐廳陣列
 */
function recommendRestaurants(filters = {}, limit = 5) {
  const data = loadRestaurantDatabase();
  // 第一道濾網：enabled=false 的店絕對不出現在推薦池
  // （空殼餐廳 / 測試店 / status≠Normal / 手動 blocklist 都已標 enabled=false）
  let restaurants = (data.restaurants || []).filter(r => r.enabled);

  // 調試：記錄初始數量
  console.log('推薦餐廳 - 初始數量:', restaurants.length);
  console.log('篩選條件:', filters);
  
  // 篩選：料理風格
  if (filters.cuisine_style) {
    const beforeCount = restaurants.length;
    restaurants = restaurants.filter(r => matchesCuisineStyle(r, filters.cuisine_style));
    console.log(`料理風格篩選: ${beforeCount} -> ${restaurants.length} (條件: ${filters.cuisine_style.join(', ')})`);
  }
  
  // 篩選：餐廳類型
  if (filters.type) {
    const beforeCount = restaurants.length;
    restaurants = restaurants.filter(r => matchesType(r, filters.type));
    console.log(`餐廳類型篩選: ${beforeCount} -> ${restaurants.length} (條件: ${filters.type.join(', ')})`);
  }
  
  // 篩選：預算
  if (filters.budget) {
    const beforeCount = restaurants.length;
    restaurants = restaurants.filter(r => matchesBudget(r, filters.budget));
    console.log(`預算篩選: ${beforeCount} -> ${restaurants.length} (條件: ${filters.budget})`);
  }
  
  // 距離篩選（需要座標資料）- 附近餐廳模式
  if (filters.userLocation && filters.maxDistance) {
    const beforeCount = restaurants.length;
    restaurants = restaurants.filter(r => {
      // 如果餐廳沒有座標，無法計算距離，應該排除
      if (!r.coordinates || !r.coordinates.lat || !r.coordinates.lng) {
        return false;
      }
      const distance = calculateDistance(
        filters.userLocation.lat,
        filters.userLocation.lng,
        r.coordinates.lat,
        r.coordinates.lng
      );
      return distance <= filters.maxDistance;
    });
    console.log(`距離篩選: ${beforeCount} -> ${restaurants.length} (距離: ${filters.maxDistance}km)`);
  }
  
  // 地區篩選（縣市和行政區）- 選擇地區模式
  if (filters.city) {
    const beforeCount = restaurants.length;
    restaurants = restaurants.filter(r => {
      const restaurantCity = r.city;
      const restaurantDistrict = r.district;
      
      // 如果餐廳沒有縣市資料，不匹配任何地區篩選
      if (!restaurantCity) return false;
      
      // 檢查縣市是否匹配
      if (restaurantCity !== filters.city) return false;
      
      // 如果指定了行政區，必須有行政區資料且匹配
      if (filters.district) {
        // 如果餐廳沒有行政區資料，不匹配
        if (!restaurantDistrict) return false;
        return restaurantDistrict === filters.district;
      }
      
      // 只指定縣市，匹配該縣市的所有餐廳（包括沒有行政區的）
      return true;
    });
    console.log(`地區篩選: ${beforeCount} -> ${restaurants.length} (條件: ${filters.city}${filters.district ? ' ' + filters.district : ''})`);
  }
  
  // 排除已顯示的餐廳
  if (filters.exclude && filters.exclude.length > 0) {
    const beforeCount = restaurants.length;
    restaurants = restaurants.filter(r => !filters.exclude.includes(r.name));
    console.log(`排除已顯示: ${beforeCount} -> ${restaurants.length} (排除: ${filters.exclude.length} 間)`);
  }
  
  // 用餐時段篩選
  if (filters.diningTime && filters.diningTime !== 'all') {
    const beforeCount = restaurants.length;
    const now = new Date();
    const currentDay = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour * 60 + currentMinute; // 轉換為分鐘數
    
    const minuteStr = currentMinute < 10 ? '0' + currentMinute : currentMinute.toString();
    console.log(`用餐時段篩選 - 當前時間: ${currentHour}:${minuteStr}, 當前日期: ${currentDay}, 當前時間（分鐘）: ${currentTime}`);
    
    restaurants = restaurants.filter(r => {
      const openingHours = r.opening_hours;
      if (!openingHours) return false; // 沒有營業時間資料，排除
      
      // 根據選擇的時段進行篩選
      if (filters.diningTime === 'now') {
        // 現在：檢查當前時間是否在營業時間內
        
        // 24 小時營業的餐廳，需要檢查是否有實際的營業時間資料
        // 如果 is_24h 為 true，但所有天的列表都是空的，可能是資料錯誤
        if (openingHours.is_24h) {
          // 檢查是否至少有一天的列表不是空的
          const hasAnyTime = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
            .some(day => openingHours[day] && openingHours[day].length > 0);
          
          // 如果至少有一天的列表不是空的，或者所有天的列表都是空的（可能是資料錯誤，但標記為 24 小時）
          // 為了安全起見，如果所有天的列表都是空的，我們不認為它是 24 小時營業
          if (hasAnyTime) {
            return true; // 24 小時營業且有實際時間資料
          } else {
            // 所有天的列表都是空的，可能是資料錯誤，不應該顯示
            return false;
          }
        }
        
        // 非 24 小時營業：檢查當前時間是否在營業時間內
        const dayTimes = openingHours[currentDay] || [];
        if (dayTimes.length === 0) return false; // 今天休息
        
        // 檢查當前時間是否在任何一個營業時段內
        const isOpen = dayTimes.some(timeRange => {
          const [start, end] = timeRange.split('-');
          const [startHour, startMin] = start.split(':').map(Number);
          const [endHour, endMin] = end.split(':').map(Number);
          const startTime = startHour * 60 + startMin;
          let endTime = endHour * 60 + endMin;
          
          // 處理跨日情況（如 17:30-00:00）
          if (endTime < startTime) {
            endTime += 24 * 60; // 加一天
          }
          
          const inRange = currentTime >= startTime && currentTime <= endTime;
          
          // 調試日誌：只記錄 R77餐酒館的情況
          if (r.name && r.name.includes && r.name.includes('R77')) {
            console.log(`  R77餐酒館 - 時段 ${timeRange}: 開始=${startTime}, 結束=${endTime}, 當前=${currentTime}, 在範圍內=${inRange}`);
          }
          
          return inRange;
        });
        
        // 調試日誌：只記錄 R77餐酒館的情況
        if (r.name && r.name.includes && r.name.includes('R77')) {
          console.log(`  R77餐酒館 - 今天營業時段: ${dayTimes.join(', ')}, 是否營業: ${isOpen}`);
        }
        
        return isOpen;
      } else if (filters.diningTime === 'lunch') {
        // 午餐：11:00-14:30
        const dayTimes = openingHours[currentDay] || [];
        if (dayTimes.length === 0) return false;
        
        // 檢查是否有任何營業時段包含 11:00-14:30
        const lunchStart = 11 * 60; // 11:00
        const lunchEnd = 14 * 60 + 30; // 14:30
        
        return dayTimes.some(timeRange => {
          const [start, end] = timeRange.split('-');
          const [startHour, startMin] = start.split(':').map(Number);
          const [endHour, endMin] = end.split(':').map(Number);
          const startTime = startHour * 60 + startMin;
          let endTime = endHour * 60 + endMin;
          
          // 處理跨日情況
          if (endTime < startTime) {
            endTime += 24 * 60;
          }
          
          // 檢查午餐時段是否與營業時段重疊
          return lunchStart < endTime && lunchEnd > startTime;
        });
      } else if (filters.diningTime === 'dinner') {
        // 晚餐：17:30-21:00
        const dayTimes = openingHours[currentDay] || [];
        if (dayTimes.length === 0) return false;
        
        // 檢查是否有任何營業時段包含 17:30-21:00
        const dinnerStart = 17 * 60 + 30; // 17:30
        const dinnerEnd = 21 * 60; // 21:00
        
        return dayTimes.some(timeRange => {
          const [start, end] = timeRange.split('-');
          const [startHour, startMin] = start.split(':').map(Number);
          const [endHour, endMin] = end.split(':').map(Number);
          const startTime = startHour * 60 + startMin;
          let endTime = endHour * 60 + endMin;
          
          // 處理跨日情況
          if (endTime < startTime) {
            endTime += 24 * 60;
          }
          
          // 檢查晚餐時段是否與營業時段重疊
          return dinnerStart < endTime && dinnerEnd > startTime;
        });
      }
      
      return true;
    });
    console.log(`用餐時段篩選: ${beforeCount} -> ${restaurants.length} (時段: ${filters.diningTime})`);
  }
  
  // TODO: 線上訂位篩選（需要訂位資料）
  
  // 隨機排序並返回指定數量
  const shuffled = restaurants.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit);
}

/**
 * 獲取所有可用的篩選選項（用於前端下拉選單）
 * @returns {Object} 包含所有可選項的物件
 */
function getFilterOptions() {
  const data = loadRestaurantDatabase();
  const types = new Set();
  const budgets = new Set();
  
  data.restaurants.forEach(restaurant => {
    (restaurant.type || []).forEach(t => types.add(t));
    if (restaurant.budget) budgets.add(restaurant.budget);
  });
  
  // 前端只顯示7個料理風格分類
  const frontendCuisineCategories = [
    '台式料理',
    '中式/港粵',
    '日式料理',
    '韓式料理',
    '美式料理',
    '東南亞料理',
    '多國料理'
  ];
  
  // 前端只顯示5個餐廳類型分類
  const frontendTypeCategories = [
    '燒肉',
    '火鍋',
    '吃到飽',
    '餐酒館',
    '咖啡廳'
  ];
  
  // 前端只顯示5個預算分類（按價格從低到高）
  const frontendBudgetCategories = [
    '200元內',
    '200-500元',
    '500-1000元',
    '1000-1500元',
    '1500以上'
  ];
  
  return {
    cuisine_style: frontendCuisineCategories,
    type: frontendTypeCategories,
    budget: frontendBudgetCategories
  };
}

/**
 * 獲取所有可用的地區選項（縣市和行政區）
 * @returns {Object} 包含縣市列表和縣市-行政區對應關係的物件
 */
function getLocationOptions() {
  const data = loadRestaurantDatabase();
  const cities = new Set();
  const districtsByCity = {};

  (data.restaurants || []).filter(r => r.enabled).forEach(restaurant => {
    const city = restaurant.city;
    const district = restaurant.district;
    
    if (city) {
      cities.add(city);
      
      if (!districtsByCity[city]) {
        districtsByCity[city] = new Set();
      }
      
      if (district) {
        districtsByCity[city].add(district);
      }
    }
  });
  
  // 台灣縣市從北到南的排序順序
  const cityOrder = [
    '基隆市',
    '台北市',
    '新北市',
    '桃園市',
    '新竹縣',
    '新竹市',
    '苗栗縣',
    '台中市',
    '彰化縣',
    '南投縣',
    '雲林縣',
    '嘉義縣',
    '嘉義市',
    '台南市',
    '高雄市',
    '屏東縣',
    '宜蘭縣',
    '花蓮縣',
    '台東縣',
    '澎湖縣',
    '金門縣',
    '連江縣'
  ];
  
  // 按照從北到南的順序排序
  const citiesArray = Array.from(cities).sort((a, b) => {
    const indexA = cityOrder.indexOf(a);
    const indexB = cityOrder.indexOf(b);
    
    // 如果都在排序列表中，按照列表順序
    if (indexA !== -1 && indexB !== -1) {
      return indexA - indexB;
    }
    
    // 如果只有一個在列表中，在列表中的排在前面
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    
    // 如果都不在列表中，按照字母順序
    return a.localeCompare(b);
  });
  
  const districtsObject = {};
  
  citiesArray.forEach(city => {
    if (districtsByCity[city]) {
      districtsObject[city] = Array.from(districtsByCity[city]).sort();
    } else {
      districtsObject[city] = [];
    }
  });
  
  return {
    cities: citiesArray,
    districts: districtsObject
  };
}

module.exports = {
  recommendRestaurants,
  getFilterOptions,
  getLocationOptions,
  loadRestaurantDatabase
};
