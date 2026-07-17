// Supabase 客戶端
// 用於 Netlify Functions

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

console.log('Supabase 客戶端初始化:');
console.log('  SUPABASE_URL:', SUPABASE_URL ? '已設定' : '未設定');
console.log('  SUPABASE_KEY:', SUPABASE_KEY ? '已設定' : '未設定');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('Supabase 環境變數未設定，將使用文件系統後備方案');
}

/**
 * 執行 Supabase REST API 請求
 */
async function supabaseRequest(endpoint, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Supabase 環境變數檢查:');
    console.error('  SUPABASE_URL:', SUPABASE_URL ? '已設定' : '未設定');
    console.error('  SUPABASE_KEY:', SUPABASE_KEY ? '已設定' : '未設定');
    throw new Error('Supabase 環境變數未設定');
  }

  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  console.log('Supabase 請求方法:', options.method || 'GET');
  
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation', // 返回插入/更新的資料
    ...options.headers,
  };

  console.log('發送 Supabase 請求...');
  const response = await fetch(url, {
    ...options,
    headers,
  });

  console.log('Supabase 響應狀態:', response.status, response.statusText);

  if (!response.ok) {
    const error = await response.text();
    console.error('Supabase API 錯誤:', response.status, error);
    throw new Error(`Supabase API 錯誤: ${response.status} - ${error}`);
  }

  // 如果沒有內容，返回 null
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    console.log('Supabase 響應為空');
    return null;
  }

  const result = await response.json();
  console.log('響應類型:', Array.isArray(result) ? '數組' : typeof result);
  console.log('響應長度:', Array.isArray(result) ? result.length : 'N/A');
  
  // 如果結果不是數組，記錄警告
  if (!Array.isArray(result)) {
    console.warn('警告：Supabase 響應不是數組，類型為:', typeof result);
  }
  
  return result;
}

/**
 * 用戶相關操作
 */
const users = {
  // 獲取或創建用戶
  async getOrCreate(lineId, profile = null) {
    try {
      // 嘗試獲取用戶
      const existing = await supabaseRequest(`users?line_id=eq.${encodeURIComponent(lineId)}&select=*`);
      
      if (existing && existing.length > 0) {
        // 如果存在，更新資料（如果有提供）
        if (profile) {
          return await users.update(lineId, {
            display_name: profile.displayName,
            picture_url: profile.pictureUrl,
          });
        }
        return existing[0];
      }

      // 創建新用戶
      const newUser = {
        line_id: lineId,
        display_name: profile?.displayName || '用戶',
        picture_url: profile?.pictureUrl || '',
        total_chances: 1,
        used_chances: 0,
        remaining_chances: 1,
        invited_count: 0,
      };

      const result = await supabaseRequest('users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });

      return Array.isArray(result) ? result[0] : result;
    } catch (error) {
      console.error('獲取或創建用戶失敗:', error);
      throw error;
    }
  },

  // 更新用戶
  async update(lineId, updates) {
    const result = await supabaseRequest(`users?line_id=eq.${encodeURIComponent(lineId)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });

    return Array.isArray(result) ? result[0] : result;
  },

  // 獲取用戶
  async get(lineId) {
    const result = await supabaseRequest(`users?line_id=eq.${encodeURIComponent(lineId)}&select=*`);
    return result && result.length > 0 ? result[0] : null;
  },

  // 獲取所有用戶（分頁）
  async getAll(page = 1, limit = 50) {
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    
    const result = await supabaseRequest(`users?select=*&order=created_at.desc&range=${from}-${to}`);
    
    // 獲取總數（查詢所有用戶的 ID 來計算總數）
    const allUsers = await supabaseRequest('users?select=line_id');
    const total = allUsers ? allUsers.length : 0;

    return {
      users: result || [],
      total: total,
    };
  },
};

/**
 * 獎品相關操作
 */
const prizes = {
  // 獲取所有獎品
  async getAll() {
    try {
      // 注意：如果表沒有 created_at 欄位，不要使用 order 參數
      // 先嘗試不帶 order 的查詢
      console.log('執行 Supabase 查詢: prizes?select=*');
      let result = await supabaseRequest('prizes?select=*');
      console.log('Supabase 查詢結果:', result);
      console.log('結果類型:', Array.isArray(result) ? '數組' : typeof result);
      console.log('結果長度:', Array.isArray(result) ? result.length : 'N/A');
      
      // 如果結果是數組，嘗試按 id 排序（客戶端排序）
      if (Array.isArray(result) && result.length > 0) {
        result = result.sort((a, b) => {
          // 如果有 created_at，按時間排序
          if (a.created_at && b.created_at) {
            return new Date(a.created_at) - new Date(b.created_at);
          }
          // 否則按 id 排序
          return (a.id || '').localeCompare(b.id || '');
        });
      }
      
      return result;
    } catch (error) {
      console.error('Supabase prizes.getAll() 錯誤:', error);
      throw error;
    }
  },

  // 獲取啟用的獎品
  async getEnabled() {
    try {
      console.log('執行 Supabase 查詢: prizes?select=*&enabled=eq.true');
      // 不使用 order 參數，避免 created_at 欄位問題
      let result = await supabaseRequest('prizes?select=*&enabled=eq.true');
      console.log('獲取到的啟用獎品數量:', result ? result.length : 0);
      
      // 如果結果是數組，過濾出啟用的獎品（雙重檢查）
      if (Array.isArray(result)) {
        result = result.filter(p => p.enabled === true);
        // 按 id 排序（客戶端排序）
        result = result.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
      }
      
      return result;
    } catch (error) {
      console.error('Supabase prizes.getEnabled() 錯誤:', error);
      throw error;
    }
  },

  // 獲取單個獎品
  async get(id) {
    const result = await supabaseRequest(`prizes?id=eq.${encodeURIComponent(id)}&select=*`);
    return result && result.length > 0 ? result[0] : null;
  },

  // 創建獎品
  async create(prize) {
    try {
      console.log('Supabase prizes.create 被調用，獎品數據:', JSON.stringify(prize, null, 2));
      
      // 確保 total_quantity 為 null 時不發送（或者發送 null）
      const prizeData = { ...prize };
      if (prizeData.total_quantity === null || prizeData.total_quantity === undefined) {
        // 如果為 null，可以選擇不發送這個欄位，或者明確發送 null
        // Supabase 通常接受 null 值
        prizeData.total_quantity = null;
      }
      
      const result = await supabaseRequest('prizes', {
        method: 'POST',
        body: JSON.stringify(prizeData),
      });
      
      console.log('Supabase 創建結果:', result);
      
      // Supabase 使用 Prefer: return=representation 時，會返回數組
      // 但我們需要返回單個對象
      if (Array.isArray(result)) {
        return result.length > 0 ? result[0] : null;
      }
      return result;
    } catch (error) {
      console.error('Supabase prizes.create 錯誤:', error);
      throw error;
    }
  },

  // 更新獎品
  async update(id, updates) {
    const result = await supabaseRequest(`prizes?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    return Array.isArray(result) ? result[0] : result;
  },

  // 刪除獎品
  async delete(id) {
    await supabaseRequest(`prizes?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return true;
  },
};

/**
 * 抽獎記錄相關操作
 */
const records = {
  // 創建記錄
  async create(record) {
    const result = await supabaseRequest('lottery_records', {
      method: 'POST',
      body: JSON.stringify(record),
    });
    return Array.isArray(result) ? result[0] : result;
  },

  // 獲取用戶的抽獎記錄
  async getByUser(lineId) {
    return await supabaseRequest(
      `lottery_records?line_id=eq.${encodeURIComponent(lineId)}&type=eq.draw&select=*&order=created_at.desc`
    );
  },

  // 獲取統計資料
  async getStatistics() {
    // 查詢所有抽獎記錄來計算統計
    const allDrawRecords = await supabaseRequest('lottery_records?type=eq.draw&select=prize_id,prize_name');
    const allInviteRecords = await supabaseRequest('lottery_records?type=eq.invite&select=id');
    
    const totalDraws = allDrawRecords ? allDrawRecords.length : 0;
    const totalInvites = allInviteRecords ? allInviteRecords.length : 0;

    // 獎品統計
    const prizeStats = {};
    if (allDrawRecords) {
      allDrawRecords.forEach(record => {
        if (record.prize_id) {
          prizeStats[record.prize_id] = (prizeStats[record.prize_id] || 0) + 1;
        }
      });
    }

    return {
      totalDraws,
      totalInvites,
      prizeStats: Object.entries(prizeStats).map(([prizeId, count]) => ({
        prizeId,
        count,
      })),
    };
  },

  // 檢查是否已邀請過
  async checkInvite(newUserLineId, inviterLineId) {
    try {
      const records = await supabaseRequest(
        `lottery_records?line_id=eq.${encodeURIComponent(newUserLineId)}&inviter_line_id=eq.${encodeURIComponent(inviterLineId)}&type=eq.invite&select=id`
      );
      return records && records.length > 0;
    } catch (error) {
      console.error('檢查邀請記錄失敗:', error);
      return false;
    }
  },
};

module.exports = {
  users,
  prizes,
  records,
  supabaseRequest,
};
