const express = require('express');
const router = express.Router();
const { recommendRestaurants, getFilterOptions } = require('../utils/recommendation');

/**
 * GET /api/restaurants/recommend
 * 推薦餐廳
 * 
 * Query Parameters:
 * - cuisine_style: 料理風格（可多選，用逗號分隔）
 * - type: 餐廳類型（可多選，用逗號分隔）
 * - budget: 預算區間
 * - limit: 返回數量（預設5）
 * 
 * Example:
 * GET /api/restaurants/recommend?cuisine_style=韓式,日式&type=燒肉&budget=500-800&limit=5
 */
router.get('/recommend', (req, res) => {
  try {
    console.log('API 請求 - 原始查詢參數:', req.query);
    
    const filters = {};
    
    // 解析料理風格（可多選）
    if (req.query.cuisine_style) {
      filters.cuisine_style = req.query.cuisine_style.split(',').map(s => s.trim());
      console.log('解析後的 cuisine_style:', filters.cuisine_style);
    }
    
    // 解析餐廳類型（可多選）
    if (req.query.type) {
      filters.type = req.query.type.split(',').map(s => s.trim());
    }
    
    // 預算
    if (req.query.budget) {
      filters.budget = req.query.budget;
    }
    
    // 用餐時段篩選
    if (req.query.diningTime) {
      filters.diningTime = req.query.diningTime;
      console.log('解析後的 diningTime:', filters.diningTime);
    }
    
    // 距離篩選（需要使用者位置和最大距離）- 附近餐廳模式
    if (req.query.userLat && req.query.userLng && req.query.maxDistance) {
      filters.userLocation = {
        lat: parseFloat(req.query.userLat),
        lng: parseFloat(req.query.userLng)
      };
      filters.maxDistance = parseFloat(req.query.maxDistance);
      console.log('解析後的距離篩選:', filters.userLocation, 'maxDistance:', filters.maxDistance);
    }
    
    // 地區篩選（縣市和行政區）- 選擇地區模式
    if (req.query.city) {
      filters.city = req.query.city;
      if (req.query.district) {
        filters.district = req.query.district;
      }
    }
    
    // 排除已顯示的餐廳
    if (req.query.exclude) {
      filters.exclude = req.query.exclude.split(',').map(s => s.trim());
    }
    
    // 返回數量
    const limit = parseInt(req.query.limit) || 5;
    
    console.log('最終 filters:', filters);
    console.log('limit:', limit);
    
    // 獲取推薦餐廳
    const recommendations = recommendRestaurants(filters, limit);
    
    console.log('API 返回的餐廳數量:', recommendations.length);
    
    res.json({
      success: true,
      count: recommendations.length,
      filters: filters,
      restaurants: recommendations
    });
  } catch (error) {
    console.error('推薦餐廳時發生錯誤:', error);
    res.status(500).json({
      success: false,
      error: '獲取推薦餐廳時發生錯誤',
      message: error.message
    });
  }
});

/**
 * GET /api/restaurants/filter-options
 * 獲取所有可用的篩選選項
 */
router.get('/filter-options', (req, res) => {
  try {
    const options = getFilterOptions();
    res.json({
      success: true,
      options: options
    });
  } catch (error) {
    console.error('獲取篩選選項時發生錯誤:', error);
    res.status(500).json({
      success: false,
      error: '獲取篩選選項時發生錯誤',
      message: error.message
    });
  }
});

/**
 * GET /api/restaurants/location-options
 * 獲取所有可用的地區選項（縣市和行政區）
 */
router.get('/location-options', (req, res) => {
  try {
    const { getLocationOptions } = require('../utils/recommendation');
    const options = getLocationOptions();
    res.json({
      success: true,
      options: options
    });
  } catch (error) {
    console.error('獲取地區選項時發生錯誤:', error);
    res.status(500).json({
      success: false,
      error: '獲取地區選項時發生錯誤',
      message: error.message
    });
  }
});

/**
 * GET /api/restaurants/all
 * 獲取所有餐廳（用於測試或管理）
 */
router.get('/all', (req, res) => {
  try {
    const { loadRestaurantDatabase } = require('../utils/recommendation');
    const data = loadRestaurantDatabase();
    
    res.json({
      success: true,
      count: data.restaurants.length,
      restaurants: data.restaurants
    });
  } catch (error) {
    console.error('獲取所有餐廳時發生錯誤:', error);
    res.status(500).json({
      success: false,
      error: '獲取餐廳資料時發生錯誤',
      message: error.message
    });
  }
});

/**
 * GET /api/restaurants/with-booking-offers
 * 有 OpenRice 訂位獨家優惠的餐廳列表（給廣告位輪播用）
 */
router.get('/with-booking-offers', (req, res) => {
  try {
    const { loadRestaurantDatabase } = require('../utils/recommendation');
    const data = loadRestaurantDatabase();
    const list = (data.restaurants || [])
      .filter(r => r.enabled && r.has_booking_offer && (r.booking_offers || []).length > 0);
    res.json({ success: true, count: list.length, restaurants: list });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/restaurants/sponsored
 * 拿付費合作餐廳（is_paid_account=true）的精簡列表，給廣告位輪播用
 */
router.get('/sponsored', (req, res) => {
  try {
    const { loadRestaurantDatabase } = require('../utils/recommendation');
    const data = loadRestaurantDatabase();
    const sponsored = (data.restaurants || [])
      .filter(r => r.enabled && r.is_paid_account);
    res.json({ success: true, count: sponsored.length, restaurants: sponsored });
  } catch (error) {
    console.error('獲取贊助餐廳時發生錯誤:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
