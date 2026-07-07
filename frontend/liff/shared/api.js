import { getApiBaseUrl } from './constants.js';

const API_BASE_URL = getApiBaseUrl();

/**
 * 載入付費贊助餐廳（給廣告位輪播用）
 * fire-and-forget 失敗時靜默
 */
export async function loadSponsoredRestaurants() {
    try {
        const response = await fetch(`${API_BASE_URL}/restaurants/sponsored`);
        if (!response.ok) return [];
        const data = await response.json();
        return data.success ? (data.restaurants || []) : [];
    } catch (err) {
        console.warn('[sponsored] load failed:', err);
        return [];
    }
}

/**
 * 載入有訂位獨家優惠的餐廳（給廣告位輪播用）
 */
export async function loadBookingOfferRestaurants() {
    try {
        const response = await fetch(`${API_BASE_URL}/restaurants/with-booking-offers`);
        if (!response.ok) return [];
        const data = await response.json();
        return data.success ? (data.restaurants || []) : [];
    } catch (err) {
        console.warn('[booking-offers] load failed:', err);
        return [];
    }
}

/**
 * 查餐廳附近的即時停車位（台北市停管處）。失敗/無資料回空陣列（呼叫端自行隱藏）。
 * @param {number} lat @param {number} lng @param {AbortSignal} [signal]
 * @returns {Promise<Array<{name,available,total,walkMin,dist,lat,lng}>>}
 */
export async function fetchNearbyParking(lat, lng, signal) {
    // 錯誤往上丟（含 HTTP 狀態），讓呼叫端能顯示原因診斷；只有「成功但無資料」回空陣列。
    const res = await fetch(`${API_BASE_URL}/parking/nearby?lat=${lat}&lng=${lng}`, { signal });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    const data = await res.json();
    if (data.success) return data.lots || [];
    // 後端可回報失敗原因（desc逾時 / desc HTTPxxx…）→ 往上丟讓卡片顯示診斷
    const e = new Error(data.error || '停車服務異常'); e.backend = data.error || 'unknown'; throw e;
}

/**
 * 載入篩選選項
 */
export async function loadFilterOptions() {
    try {
        const response = await fetch(`${API_BASE_URL}/restaurants/filter-options`);
        if (!response.ok) {
            throw new Error('無法載入篩選選項');
        }
        const data = await response.json();
        if (data.success) {
            return data.options;
        } else {
            throw new Error('篩選選項資料格式錯誤');
        }
    } catch (err) {
        console.error('載入篩選選項錯誤:', err);
        throw err;
    }
}

/**
 * 載入地區選項
 */
export async function loadLocationOptions() {
    try {
        const response = await fetch(`${API_BASE_URL}/restaurants/location-options`);
        if (!response.ok) {
            // 嘗試解析錯誤響應以獲取調試信息
            let errorData = null;
            try {
                errorData = await response.json();
            } catch (e) {
                // 如果無法解析 JSON，使用默認錯誤
            }
            
            console.error('載入地區選項錯誤 - 響應狀態:', response.status);
            console.error('載入地區選項錯誤 - 響應數據:', errorData);
            
            // 如果有調試信息，顯示它
            if (errorData && errorData.debug) {
                console.error('調試信息:', errorData.debug);
                console.error('__dirname:', errorData.debug.__dirname);
                console.error('process.cwd():', errorData.debug.processCwd);
                console.error('目錄文件:', errorData.debug.dirFiles);
                console.error('數據庫路徑:', errorData.debug.dbPath);
                console.error('數據庫存在?', errorData.debug.dbExists);
            }
            
            throw new Error('無法載入地區選項');
        }
        const data = await response.json();
        if (data.success) {
            return data.options;
        } else {
            throw new Error('地區選項資料格式錯誤');
        }
    } catch (err) {
        console.error('載入地區選項錯誤:', err);
        throw err;
    }
}

/**
 * 獲取推薦餐廳
 * @param {Object} formData - 表單數據
 * @param {Array<string>} excludeNames - 要排除的餐廳名稱列表
 * @returns {Promise<Array>} 推薦的餐廳列表
 */
export async function fetchRecommendations(formData, excludeNames = [], limitOverride = null) {
    // 建立查詢參數
    const params = new URLSearchParams();
    
    if (formData.cuisine_style && formData.cuisine_style.length > 0) {
        params.append('cuisine_style', formData.cuisine_style.join(','));
    }
    
    if (formData.type && formData.type.length > 0) {
        params.append('type', formData.type.join(','));
    }
    
    if (formData.budget) {
        params.append('budget', formData.budget);
    }
    
    // 用餐時段篩選參數（只有不是「不限」時才傳遞）
    if (formData.diningTime && formData.diningTime !== 'all') {
        params.append('diningTime', formData.diningTime);
    }
    
    // 距離篩選參數（附近餐廳模式）
    if (formData.userLocation && formData.maxDistance) {
        params.append('locationMode', 'nearby');
        params.append('userLat', formData.userLocation.lat);
        params.append('userLng', formData.userLocation.lng);
        params.append('maxDistance', formData.maxDistance);
    }
    
    // 地區篩選參數（選擇地區模式）
    if (formData.city) {
        params.append('locationMode', 'area');
        params.append('city', formData.city);
        if (formData.district) {
            params.append('district', formData.district);
        }
    }
    
    // 排除已顯示的餐廳
    if (excludeNames && excludeNames.length > 0) {
        params.append('exclude', excludeNames.join(','));
    }
    
    params.append('limit', limitOverride ?? formData.limit ?? 5);
    
    // 發送請求
    const url = `${API_BASE_URL}/restaurants/recommend?${params.toString()}`;
    console.log('API 請求 URL:', url);
    console.log('API 請求參數 - diningTime:', formData.diningTime);
    console.log('API 請求參數 - 完整 params:', params.toString());
    
    const response = await fetch(url);
    
    if (!response.ok) {
        throw new Error(`API 請求失敗: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('API 響應:', data);
    
    if (!data.success) {
        throw new Error(data.error || '獲取推薦餐廳失敗');
    }
    
    return data.restaurants || [];
}

/**
 * 抽獎相關 API
 */

/**
 * 獲取用戶資料
 * @param {string} lineId - LINE 用戶 ID
 * @returns {Promise<Object>} 用戶資料
 */
export async function getLotteryUser(lineId) {
    try {
        const response = await fetch(`${API_BASE_URL}/lottery/user?lineId=${encodeURIComponent(lineId)}`);
        if (!response.ok) {
            throw new Error('無法載入用戶資料');
        }
        const data = await response.json();
        if (data.success) {
            return data.user;
        } else {
            throw new Error(data.error || '獲取用戶資料失敗');
        }
    } catch (err) {
        console.error('獲取用戶資料錯誤:', err);
        throw err;
    }
}

/**
 * 執行抽獎
 * @param {string} lineId - LINE 用戶 ID
 * @returns {Promise<Object>} 抽獎結果
 */
export async function drawLottery(lineId) {
    try {
        const response = await fetch(`${API_BASE_URL}/lottery/draw`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ lineId }),
        });
        if (!response.ok) {
            throw new Error('抽獎請求失敗');
        }
        const data = await response.json();
        if (data.success) {
            return data;
        } else {
            throw new Error(data.error || '抽獎失敗');
        }
    } catch (err) {
        console.error('抽獎錯誤:', err);
        throw err;
    }
}

/**
 * 獲取抽獎記錄
 * @param {string} lineId - LINE 用戶 ID
 * @returns {Promise<Array>} 抽獎記錄列表
 */
export async function getLotteryRecords(lineId) {
    try {
        const response = await fetch(`${API_BASE_URL}/lottery/records?lineId=${encodeURIComponent(lineId)}`);
        if (!response.ok) {
            throw new Error('無法載入抽獎記錄');
        }
        const data = await response.json();
        if (data.success) {
            return data.records || [];
        } else {
            throw new Error(data.error || '獲取抽獎記錄失敗');
        }
    } catch (err) {
        console.error('獲取抽獎記錄錯誤:', err);
        throw err;
    }
}

/**
 * 記錄邀請
 * @param {string} inviterLineId - 邀請者 LINE ID
 * @param {string} newUserLineId - 新用戶 LINE ID
 * @returns {Promise<Object>} 邀請結果
 */
export async function recordInvite(inviterLineId, newUserLineId) {
    try {
        const response = await fetch(`${API_BASE_URL}/lottery/invite`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                inviterLineId,
                newUserLineId,
            }),
        });
        if (!response.ok) {
            throw new Error('邀請請求失敗');
        }
        const data = await response.json();
        if (data.success) {
            return data;
        } else {
            throw new Error(data.error || '記錄邀請失敗');
        }
    } catch (err) {
        console.error('記錄邀請錯誤:', err);
        throw err;
    }
}
