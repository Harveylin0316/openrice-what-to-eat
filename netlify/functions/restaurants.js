// Netlify Function for restaurant API
const fs = require('fs');
const path = require('path');

// 先導入 recommendation 模組
const recommendationModule = require('../../backend/utils/recommendation');

// 覆蓋 loadRestaurantDatabase 函數以使用正確的路徑
// 在 Netlify Functions 中，嘗試從模組導入數據庫
function loadRestaurantDatabase() {
  console.log('loadRestaurantDatabase called');
  console.log('__dirname:', __dirname);
  console.log('process.cwd():', process.cwd());
  
  // 首先嘗試從模組導入（如果 database.js 存在）
  try {
    const database = require('./database');
    console.log('Database loaded from module, restaurants count:', database.restaurants?.length || 0);
    return database;
  } catch (err) {
    console.log('Failed to load from module, trying file system...', err.message);
  }
  
  // 列出 __dirname 目錄中的所有文件（用於調試）
  try {
    const dirFiles = fs.readdirSync(__dirname);
    console.log('Files in __dirname:', dirFiles);
  } catch (err) {
    console.error('Error reading __dirname:', err);
  }
  
  // 優先查找函數目錄中的數據庫文件（構建時複製的）
  const functionDbPath = path.join(__dirname, 'restaurants_database.json');
  console.log('Checking function directory path:', functionDbPath);
  console.log('File exists?', fs.existsSync(functionDbPath));
  
  if (fs.existsSync(functionDbPath)) {
    console.log(`Found database at function directory: ${functionDbPath}`);
    try {
      const stats = fs.statSync(functionDbPath);
      console.log('File size:', stats.size, 'bytes');
      const data = fs.readFileSync(functionDbPath, 'utf-8');
      const parsed = JSON.parse(data);
      console.log('Database loaded successfully, restaurants count:', parsed.restaurants?.length || 0);
      return parsed;
    } catch (err) {
      console.error('Error reading database file:', err);
      console.error('Error stack:', err.stack);
      throw new Error(`Failed to read database file: ${err.message}`);
    }
  }
  
  // 如果函數目錄中沒有，嘗試其他路徑
  const possiblePaths = [
    path.join(__dirname, '../restaurants_database.json'), // 上一級目錄
    path.join(__dirname, '../../restaurants_database.json'), // 上兩級目錄
    path.join(__dirname, '../../../restaurants_database.json'), // 項目根目錄
    path.join(process.cwd(), 'restaurants_database.json'), // 當前工作目錄
    path.join(process.cwd(), 'netlify/functions/restaurants_database.json'), // 從工作目錄的函數目錄
    path.join('/opt/build/repo', 'restaurants_database.json'), // Netlify 構建目錄
    path.join('/opt/build/repo', 'netlify/functions/restaurants_database.json'), // Netlify 構建目錄的函數目錄
  ];
  
  console.log('Trying alternative paths...');
  for (const dbPath of possiblePaths) {
    console.log('Checking:', dbPath, 'exists?', fs.existsSync(dbPath));
    if (fs.existsSync(dbPath)) {
      console.log(`Found database at: ${dbPath}`);
      try {
        const stats = fs.statSync(dbPath);
        console.log('File size:', stats.size, 'bytes');
        const data = fs.readFileSync(dbPath, 'utf-8');
        const parsed = JSON.parse(data);
        console.log('Database loaded successfully, restaurants count:', parsed.restaurants?.length || 0);
        return parsed;
      } catch (err) {
        console.error('Error reading database file:', err);
        console.error('Error stack:', err.stack);
        throw new Error(`Failed to read database file: ${err.message}`);
      }
    }
  }
  
  const errorMsg = `Database file not found. Tried: ${functionDbPath}, ${possiblePaths.join(', ')}`;
  console.error(errorMsg);
  throw new Error(errorMsg);
}

// 重新實現 getFilterOptions - 不需要數據庫，直接返回固定分類
function getFilterOptions() {
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

function getLocationOptions() {
  try {
    console.log('getLocationOptions: Loading database...');
    const data = loadRestaurantDatabase();
    console.log('getLocationOptions: Database loaded, restaurants count:', data.restaurants?.length || 0);
    
    const cities = new Set();
    const districtsByCity = {};
    
    data.restaurants.forEach(restaurant => {
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
    
    console.log('getLocationOptions: Returning options, cities count:', citiesArray.length);
    return {
      cities: citiesArray,
      districts: districtsObject
    };
  } catch (error) {
    console.error('getLocationOptions error:', error);
    console.error('Stack:', error.stack);
    throw error;
  }
}

// 設置環境變數，讓 recommendation.js 知道數據庫文件的位置
process.env.RESTAURANT_DB_PATH = path.join(__dirname, 'restaurants_database.json');

// 使用 recommendation 模組中的函數
const { recommendRestaurants } = recommendationModule;

exports.handler = async (event, context) => {
  // 設置 CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  // 處理 OPTIONS 請求（CORS preflight）
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // 只處理 GET 請求
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'Method not allowed' })
    };
  }

  try {
    // 從 event.path 提取路徑，處理不同的路徑格式
    let apiPath = event.path || '';
    
    // 移除 Netlify Functions 前綴和查詢參數
    if (apiPath.includes('/.netlify/functions/restaurants')) {
      apiPath = apiPath.replace('/.netlify/functions/restaurants', '');
    } else if (apiPath.includes('/api/restaurants')) {
      apiPath = apiPath.replace('/api/restaurants', '');
    }
    
    // 移除查詢參數部分
    if (apiPath.includes('?')) {
      apiPath = apiPath.split('?')[0];
    }
    
    // 如果路徑為空，檢查是否有查詢參數來判斷是推薦請求
    // 或者默認使用 /recommend
    if (!apiPath || apiPath === '/') {
      // 如果有查詢參數，可能是推薦請求
      const queryParams = event.queryStringParameters || {};
      if (Object.keys(queryParams).length > 0) {
        apiPath = '/recommend';
      } else {
        // 根據原始請求路徑判斷
        const rawPath = event.path || '';
        if (rawPath.includes('filter-options')) {
          apiPath = '/filter-options';
        } else if (rawPath.includes('location-options')) {
          apiPath = '/location-options';
        } else if (rawPath.includes('/all')) {
          apiPath = '/all';
        } else if (rawPath.includes('sponsored')) {
          apiPath = '/sponsored';
        } else {
          apiPath = '/recommend';
        }
      }
    }
    
    const queryParams = event.queryStringParameters || {};

    // 路由處理
    if (apiPath === '/recommend' || apiPath === '') {
      // 推薦餐廳
      const filters = {};
      
      if (queryParams.cuisine_style) {
        filters.cuisine_style = queryParams.cuisine_style.split(',').map(s => s.trim());
      }
      
      if (queryParams.type) {
        filters.type = queryParams.type.split(',').map(s => s.trim());
      }
      
      if (queryParams.budget) {
        filters.budget = queryParams.budget;
      }
      
      if (queryParams.diningTime) {
        filters.diningTime = queryParams.diningTime;
      }
      
      if (queryParams.userLat && queryParams.userLng && queryParams.maxDistance) {
        filters.userLocation = {
          lat: parseFloat(queryParams.userLat),
          lng: parseFloat(queryParams.userLng)
        };
        filters.maxDistance = parseFloat(queryParams.maxDistance);
      }
      
      if (queryParams.city) {
        filters.city = queryParams.city;
        if (queryParams.district) {
          filters.district = queryParams.district;
        }
      }
      
      if (queryParams.exclude) {
        filters.exclude = queryParams.exclude.split(',').map(s => s.trim());
      }
      
      const limit = parseInt(queryParams.limit) || 5;
      const recommendations = recommendRestaurants(filters, limit);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          count: recommendations.length,
          filters: filters,
          restaurants: recommendations
        })
      };
    } else if (apiPath === '/filter-options') {
      // 獲取篩選選項 - 不需要數據庫
      const options = getFilterOptions();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          options: options
        })
      };
    } else if (apiPath === '/location-options') {
      // 獲取地區選項
      try {
        console.log('Getting location options...');
        console.log('__dirname:', __dirname);
        console.log('process.cwd():', process.cwd());
        
        // 列出 __dirname 目錄中的所有文件
        try {
          const dirFiles = fs.readdirSync(__dirname);
          console.log('Files in __dirname:', dirFiles);
        } catch (err) {
          console.error('Error reading __dirname:', err);
        }
        
        const options = getLocationOptions();
        console.log('Location options retrieved successfully');
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            options: options
          })
        };
      } catch (error) {
        console.error('Error in getLocationOptions:', error);
        console.error('Stack:', error.stack);
        
        // 收集調試信息
        const debugInfo = {
          __dirname: __dirname,
          processCwd: process.cwd(),
          errorMessage: error.message,
          errorStack: error.stack
        };
        
        // 嘗試列出目錄文件
        try {
          debugInfo.dirFiles = fs.readdirSync(__dirname);
        } catch (err) {
          debugInfo.dirFilesError = err.message;
        }
        
        // 檢查數據庫文件是否存在
        const dbPath = path.join(__dirname, 'restaurants_database.json');
        debugInfo.dbPath = dbPath;
        debugInfo.dbExists = fs.existsSync(dbPath);
        
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'Internal server error',
            message: error.message,
            debug: debugInfo
          })
        };
      }
    } else if (apiPath === '/all') {
      // 獲取所有餐廳
      const data = loadRestaurantDatabase();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          count: data.restaurants.length,
          restaurants: data.restaurants
        })
      };
    } else if (apiPath === '/sponsored') {
      // 付費贊助餐廳（給廣告位輪播用）
      const data = loadRestaurantDatabase();
      const sponsored = (data.restaurants || [])
        .filter(r => r.enabled && r.is_paid_account)
        .map(r => ({
          or_id: r.or_id,
          name: r.name,
          address: r.address,
          url: r.url,
          rating: r.rating,
          review_count: r.review_count,
          budget: r.budget,
          cuisine_style: r.cuisine_style,
          image: (r.images && r.images[0]) || r.door_photo_url || null,
          landmarks: r.landmarks,
        }));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          count: sponsored.length,
          restaurants: sponsored
        })
      };
    } else {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Not found'
        })
      };
    }
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};
