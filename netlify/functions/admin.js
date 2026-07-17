// Netlify Function for admin API
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildAnalytics, eventsToCsv } = require('./lib/analytics');

// 嘗試導入 Supabase 客戶端
// 注意：Netlify Functions 在打包時會分析所有 require，所以只使用構建後的正確路徑
let supabase = null;
try {
  // 構建腳本會將 supabase 複製到 netlify/functions/supabase/
  // 所以這裡使用相對路徑 ./supabase/client
  const supabaseModule = require('./supabase/client');
  console.log('Supabase 模組已載入:', typeof supabaseModule);
  console.log('Supabase 模組內容:', Object.keys(supabaseModule || {}));
  
  // 檢查模組導出的內容
  if (supabaseModule && typeof supabaseModule === 'object') {
    // 如果導出的是對象，檢查是否有 prizes 屬性
    if (supabaseModule.prizes) {
      supabase = supabaseModule;
      console.log('Supabase 客戶端已正確初始化');
    } else {
      console.warn('Supabase 模組沒有 prizes 屬性，模組內容:', Object.keys(supabaseModule));
      // 嘗試直接使用模組
      supabase = supabaseModule;
    }
  } else {
    console.warn('Supabase 模組格式不正確:', typeof supabaseModule);
  }
  
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? '已設定' : '未設定');
  console.log('SUPABASE_KEY:', process.env.SUPABASE_KEY ? '已設定' : '未設定');
  console.log('Supabase 客戶端狀態:', supabase ? '已初始化' : '未初始化');
} catch (err) {
  // 如果導入失敗，使用文件系統後備方案
  console.log('Supabase 客戶端未找到，將使用文件系統後備方案:', err.message);
}

// 資料庫文件路徑（與 lottery.js 相同邏輯）
function getDatabasePath(filename) {
  const possiblePaths = [
    path.join(__dirname, filename),
    path.join(__dirname, '../../data', filename),
    path.join(process.cwd(), 'data', filename),
    path.join('/opt/build/repo', 'data', filename),
  ];
  
  for (const dbPath of possiblePaths) {
    if (fs.existsSync(dbPath)) {
      return dbPath;
    }
  }
  
  return path.join(__dirname, '../../data', filename);
}

// 載入資料庫
function loadDatabase(filename) {
  // 嘗試多個可能的路徑（包括保存路徑）
  const possiblePaths = [
    path.join(__dirname, 'data', filename), // Functions 目錄下的 data 子目錄
    path.join(__dirname, filename), // Functions 目錄
    path.join(process.cwd(), 'data', filename), // 當前工作目錄
    path.join('/tmp', filename), // Netlify Functions 的臨時目錄
    getDatabasePath(filename), // 原始路徑
  ];
  
  for (const dbPath of possiblePaths) {
    try {
      if (fs.existsSync(dbPath)) {
        const data = fs.readFileSync(dbPath, 'utf-8');
        const parsed = JSON.parse(data);
        console.log(`資料庫已從 ${dbPath} 載入`);
        return parsed;
      }
    } catch (err) {
      console.log(`嘗試從 ${dbPath} 載入失敗:`, err.message);
      continue;
    }
  }
  
  // 如果都找不到，返回空資料結構
  console.log(`找不到 ${filename}，使用空資料結構`);
  if (filename === 'users_database.json') {
    return { users: [] };
  } else if (filename === 'prizes_database.json') {
    return { prizes: [] };
  } else if (filename === 'lottery_records.json') {
    return { records: [] };
  }
  return {};
}

// 保存資料庫
function saveDatabase(filename, data) {
  const dbPath = getDatabasePath(filename);
  try {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 在 Netlify Functions 中，嘗試多個可能的路徑
    const possiblePaths = [
      path.join(__dirname, 'data', filename), // Functions 目錄下的 data 子目錄
      path.join(__dirname, filename), // Functions 目錄
      path.join(process.cwd(), 'data', filename), // 當前工作目錄
      path.join('/tmp', filename), // Netlify Functions 的臨時目錄（可寫）
      dbPath, // 原始路徑
    ];
    
    let saved = false;
    let savedPath = null;
    
    for (const savePath of possiblePaths) {
      try {
        const saveDir = path.dirname(savePath);
        if (!fs.existsSync(saveDir)) {
          fs.mkdirSync(saveDir, { recursive: true });
        }
        
        fs.writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf-8');
        saved = true;
        savedPath = savePath;
        console.log(`資料庫已保存到: ${savePath}`);
        break;
      } catch (err) {
        console.log(`嘗試保存到 ${savePath} 失敗:`, err.message);
        continue;
      }
    }
    
    if (!saved) {
      console.error(`無法保存 ${filename} 到任何路徑`);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error(`Error saving ${filename}:`, err);
    return false;
  }
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

// Admin key 只接受 header，避免密鑰進入 URL、瀏覽器歷史與 proxy logs。
// 正式密鑰未設定時 fail closed；不提供可被猜中的 fallback key。
function checkAuth(event) {
  const headers = event.headers || {};
  const apiKey = headers['x-api-key'] || headers['X-API-Key'];
  const validApiKey = process.env.ADMIN_API_KEY;

  if (!apiKey || !validApiKey) return false;

  const provided = Buffer.from(String(apiKey));
  const expected = Buffer.from(String(validApiKey));
  const match = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  
  // 調試日誌（僅在開發環境）
  if (process.env.NETLIFY_DEV) {
    console.log('API Key 檢查:', {
      provided: apiKey ? '已提供' : '未提供',
      validKey: '已設定',
      match
    });
  }
  
  return match;
}

exports.handler = async (event, context) => {
  // 處理 OPTIONS 請求
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  // 檢查認證
  if (!checkAuth(event)) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  try {
    // 從 event.path 提取路徑，處理不同的路徑格式
    let path = event.path || '';
    
    // 移除 Netlify Functions 前綴和查詢參數
    if (path.includes('/.netlify/functions/admin')) {
      path = path.replace('/.netlify/functions/admin', '');
    } else if (path.includes('/api/admin')) {
      path = path.replace('/api/admin', '');
    }
    
    // 移除查詢參數部分
    if (path.includes('?')) {
      path = path.split('?')[0];
    }
    
    // 如果路徑為空，設為根路徑
    if (!path) {
      path = '/';
    }
    
    const method = event.httpMethod;
    
    console.log(`Admin API: ${method} ${path} (原始路徑: ${event.path})`);
    
    // 解析請求體
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        // 忽略解析錯誤
      }
    }
    
    const queryParams = event.queryStringParameters || {};

    // 好康地圖匿名行為分析。讀取兩個期間，才能顯示與前期比較。
    if ((path === '/analytics' || path === '/analytics/export') && method === 'GET') {
      if (!supabase || typeof supabase.supabaseRequest !== 'function') {
        return { statusCode: 503, headers: corsHeaders, body: JSON.stringify({ error: '行為資料庫尚未連線' }) };
      }
      const days = Math.min(90, Math.max(7, Number.parseInt(queryParams.days, 10) || 30));
      const lookbackDays = path.endsWith('/export') ? days : days * 2;
      const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();
      const events = await fetchUserEvents(since);
      if (path.endsWith('/export')) {
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="map-analytics-${days}d.csv"` },
          body: `\uFEFF${eventsToCsv(events)}`,
        };
      }
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=60' },
        body: JSON.stringify({ success: true, analytics: buildAnalytics(events, { days }) }),
      };
    }
    
    // 獎品管理
    if (path.startsWith('/prizes')) {
      if (path === '/prizes' && method === 'GET') {
        // 獲取所有獎品
        try {
          // 檢查 supabase 是否正確初始化
          console.log('檢查 Supabase 客戶端:');
          console.log('  supabase 變數:', supabase ? '存在' : 'null/undefined');
          console.log('  supabase 類型:', typeof supabase);
          if (supabase) {
            console.log('  supabase 屬性:', Object.keys(supabase));
            console.log('  supabase.prizes:', supabase.prizes ? '存在' : '不存在');
          }
          
          if (supabase && supabase.prizes) {
            // 使用 Supabase
            console.log('從 Supabase 獲取所有獎品');
            console.log('Supabase 客戶端狀態:', supabase ? '已初始化' : '未初始化');
            console.log('檢查 Supabase 環境變數:');
            console.log('  SUPABASE_URL:', process.env.SUPABASE_URL ? '已設定' : '未設定');
            console.log('  SUPABASE_KEY:', process.env.SUPABASE_KEY ? '已設定' : '未設定');
            
            try {
              console.log('調用 supabase.prizes.getAll()...');
              const prizes = await supabase.prizes.getAll();
              console.log('獲取到的獎品數量:', prizes ? prizes.length : 0);
              
              // 如果返回空陣列，記錄警告
              if (!prizes || prizes.length === 0) {
                console.warn('警告：Supabase 查詢返回空陣列，可能的原因：');
                console.warn('  1. 資料表中沒有資料');
                console.warn('  2. RLS 策略阻擋了查詢');
                console.warn('  3. 環境變數未正確設定');
                console.warn('  4. 查詢語法有問題');
              }
              
              return {
                statusCode: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  success: true, 
                  prizes: prizes || [],
                  debug: {
                    supabaseConnected: !!supabase,
                    envUrlSet: !!process.env.SUPABASE_URL,
                    envKeySet: !!process.env.SUPABASE_KEY,
                    resultCount: prizes ? prizes.length : 0
                  }
                }),
              };
            } catch (supabaseError) {
              console.error('Supabase 查詢錯誤:', supabaseError);
              console.error('錯誤詳情:', supabaseError.message);
              console.error('錯誤堆疊:', supabaseError.stack);
              
              // 如果 Supabase 查詢失敗，回退到文件系統
              console.log('Supabase 查詢失敗，回退到文件系統');
              const db = loadDatabase('prizes_database.json');
              return {
                statusCode: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  success: true, 
                  prizes: db.prizes || [],
                  warning: 'Supabase 查詢失敗，使用文件系統後備方案',
                  error: supabaseError.message
                }),
              };
            }
          } else {
            // 後備方案：從文件系統或環境變數讀取
            console.log('使用文件系統後備方案（Supabase 未初始化）');
            console.log('Supabase 客戶端狀態:', supabase ? '已初始化' : '未初始化');
            console.log('檢查 Supabase 環境變數:');
            console.log('  SUPABASE_URL:', process.env.SUPABASE_URL ? '已設定' : '未設定');
            console.log('  SUPABASE_KEY:', process.env.SUPABASE_KEY ? '已設定' : '未設定');
            
            let db = null;
            const envPrizes = process.env.PRIZES_DATABASE;
            if (envPrizes) {
              try {
                db = JSON.parse(envPrizes);
                console.log('從環境變數載入獎品資料');
              } catch (err) {
                console.log('環境變數解析失敗，使用文件載入:', err.message);
              }
            }
            
            // 如果環境變數沒有，從文件載入
            if (!db) {
              db = loadDatabase('prizes_database.json');
            }
            
            return {
              statusCode: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                success: true, 
                prizes: db.prizes || [],
                debug: {
                  supabaseConnected: false,
                  envUrlSet: !!process.env.SUPABASE_URL,
                  envKeySet: !!process.env.SUPABASE_KEY,
                  usingFileSystem: true,
                  resultCount: db.prizes ? db.prizes.length : 0
                }
              }),
            };
          }
        } catch (error) {
          console.error('獲取獎品失敗:', error);
          return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: '獲取獎品失敗', message: error.message }),
          };
        }
      }
      
      if (path === '/prizes' && method === 'POST') {
        // 新增獎品
        try {
          const newPrize = {
            id: `prize_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: body.name || '未命名獎品',
            description: body.description || '',
            probability: parseFloat(body.probability) || 0,
            image: body.image || '',
            enabled: body.enabled !== undefined ? body.enabled : true,
            total_quantity: body.total_quantity !== undefined && body.total_quantity !== '' ? parseInt(body.total_quantity) : null,
            used_quantity: 0,
          };

          if (supabase) {
            // 使用 Supabase
            console.log('新增獎品到 Supabase:', JSON.stringify(newPrize, null, 2));
            
            try {
              const prize = await supabase.prizes.create(newPrize);
              console.log('插入後的獎品:', prize);
              
              const allPrizes = await supabase.prizes.getAll();
              console.log('所有獎品數量:', allPrizes ? allPrizes.length : 0);
              
              return {
                statusCode: 200,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                  success: true, 
                  prize,
                  prizes: allPrizes || [],
                }),
              };
            } catch (supabaseError) {
              console.error('Supabase 插入錯誤:', supabaseError);
              console.error('錯誤詳情:', supabaseError.message);
              console.error('錯誤堆疊:', supabaseError.stack);
              
              return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({ 
                  error: '新增獎品失敗', 
                  message: supabaseError.message,
                  details: '請確認 Supabase 資料表結構是否已更新（需要 total_quantity 和 used_quantity 欄位）'
                }),
              };
            }
          } else {
            // 後備方案：使用文件系統
            const db = loadDatabase('prizes_database.json');
            const now = new Date().toISOString();
            newPrize.createdAt = now;
            newPrize.updatedAt = now;
            
            db.prizes.push(newPrize);
            const saved = saveDatabase('prizes_database.json', db);
            
            return {
              statusCode: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                success: true, 
                prize: newPrize,
                prizes: db.prizes,
                warning: saved ? null : '資料庫保存失敗，請配置 Supabase 以持久化資料。',
              }),
            };
          }
        } catch (error) {
          console.error('新增獎品失敗:', error);
          return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: '新增獎品失敗', message: error.message }),
          };
        }
      }
      
      if (path.startsWith('/prizes/') && method === 'PUT') {
        // 更新獎品
        const prizeId = path.replace('/prizes/', '');
        
        try {
          const updates = {};
          if (body.name !== undefined) updates.name = body.name;
          if (body.description !== undefined) updates.description = body.description;
          if (body.probability !== undefined) updates.probability = parseFloat(body.probability);
          if (body.image !== undefined) updates.image = body.image;
          if (body.enabled !== undefined) updates.enabled = body.enabled;

          if (supabase) {
            // 使用 Supabase
            const prize = await supabase.prizes.update(prizeId, updates);
            if (!prize) {
              return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: '獎品不存在' }),
              };
            }
            
            // 返回更新後的完整獎品列表
            const allPrizes = await supabase.prizes.getAll();
            
            return {
              statusCode: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                success: true, 
                prize,
                prizes: allPrizes || [],
              }),
            };
          } else {
            // 後備方案：使用文件系統
            const db = loadDatabase('prizes_database.json');
            const prizeIndex = db.prizes.findIndex(p => p.id === prizeId);
            
            if (prizeIndex === -1) {
              return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: '獎品不存在' }),
              };
            }
            
            const prize = db.prizes[prizeIndex];
            Object.assign(prize, updates);
            prize.updatedAt = new Date().toISOString();
            
            const saved = saveDatabase('prizes_database.json', db);
            
            return {
              statusCode: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                success: true, 
                prize,
                warning: saved ? null : '資料庫保存失敗，請配置 Supabase 以持久化資料。'
              }),
            };
          }
        } catch (error) {
          console.error('更新獎品失敗:', error);
          return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: '更新獎品失敗', message: error.message }),
          };
        }
      }
      
      if (path.startsWith('/prizes/') && method === 'DELETE') {
        // 刪除獎品
        const prizeId = path.replace('/prizes/', '');
        
        try {
          if (supabase) {
            // 使用 Supabase
            await supabase.prizes.delete(prizeId);
            
            // 返回更新後的完整獎品列表
            const allPrizes = await supabase.prizes.getAll();
            
            return {
              statusCode: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                success: true,
                prizes: allPrizes || [],
              }),
            };
          } else {
            // 後備方案：使用文件系統
            const db = loadDatabase('prizes_database.json');
            const prizeIndex = db.prizes.findIndex(p => p.id === prizeId);
            
            if (prizeIndex === -1) {
              return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: '獎品不存在' }),
              };
            }
            
            db.prizes.splice(prizeIndex, 1);
            const saved = saveDatabase('prizes_database.json', db);
            
            return {
              statusCode: 200,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                success: true,
                prizes: db.prizes,
                warning: saved ? null : '資料庫保存失敗，請配置 Supabase 以持久化資料。'
              }),
            };
          }
        } catch (error) {
          console.error('刪除獎品失敗:', error);
          return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: '刪除獎品失敗', message: error.message }),
          };
        }
      }
    }
    
    // 用戶管理
    if (path.startsWith('/users')) {
      if (path === '/users' && method === 'GET') {
        // 獲取所有用戶
        const db = loadDatabase('users_database.json');
        const page = parseInt(queryParams.page) || 1;
        const limit = parseInt(queryParams.limit) || 50;
        const start = (page - 1) * limit;
        const end = start + limit;
        
        const users = db.users.slice(start, end);
        
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            users,
            pagination: {
              page,
              limit,
              total: db.users.length,
              totalPages: Math.ceil(db.users.length / limit),
            },
          }),
        };
      }
    }
    
    // 統計資料
    if (path === '/statistics' && method === 'GET') {
      try {
        if (supabase) {
          // 使用 Supabase
          // 獲取用戶總數
          const usersResult = await supabase.users.getAll(1, 1);
          const totalUsers = usersResult.total || 0;
          
          // 獲取記錄統計
          const recordsStats = await supabase.records.getStatistics();
          
          // 獲取獎品列表以匹配名稱
          const prizes = await supabase.prizes.getAll();
          const prizeStatsWithNames = recordsStats.prizeStats.map(stat => {
            const prize = prizes.find(p => p.id === stat.prizeId);
            return {
              prizeId: stat.prizeId,
              prizeName: prize?.name || '未知',
              count: stat.count,
            };
          });
          
          return {
            statusCode: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: true,
              statistics: {
                totalUsers,
                totalDraws: recordsStats.totalDraws,
                totalInvites: recordsStats.totalInvites,
                prizeStats: prizeStatsWithNames,
              },
            }),
          };
        } else {
          // 後備方案：使用文件系統
          const usersDb = loadDatabase('users_database.json');
          const prizesDb = loadDatabase('prizes_database.json');
          const recordsDb = loadDatabase('lottery_records.json');
          
          const totalUsers = usersDb.users.length;
          const totalDraws = recordsDb.records.filter(r => r.type !== 'invite').length;
          const totalInvites = recordsDb.records.filter(r => r.type === 'invite').length;
          
          const prizeStats = {};
          recordsDb.records
            .filter(r => r.type !== 'invite' && r.prizeId)
            .forEach(r => {
              prizeStats[r.prizeId] = (prizeStats[r.prizeId] || 0) + 1;
            });
          
          const prizeStatsWithNames = Object.entries(prizeStats).map(([prizeId, count]) => {
            const prize = prizesDb.prizes.find(p => p.id === prizeId);
            return {
              prizeId,
              prizeName: prize?.name || '未知',
              count,
            };
          });
          
          return {
            statusCode: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              success: true,
              statistics: {
                totalUsers,
                totalDraws,
                totalInvites,
                prizeStats: prizeStatsWithNames,
              },
            }),
          };
        }
      } catch (error) {
        console.error('獲取統計資料失敗:', error);
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({ error: '獲取統計資料失敗', message: error.message }),
        };
      }
    }
    
    // 404
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Not found' }),
    };
    
  } catch (error) {
    console.error('Admin API Error:', error);
    console.error('Error stack:', error.stack);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message,
        stack: process.env.NETLIFY_DEV ? error.stack : undefined, // 只在開發環境顯示 stack
      }),
    };
  }
};

async function fetchUserEvents(since, maxRows = 50000) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const endpoint = `user_events?select=id,line_id,session_id,event_name,properties,is_in_line,os,language,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc&limit=${pageSize}&offset=${offset}`;
    const page = await supabase.supabaseRequest(endpoint);
    if (!Array.isArray(page)) throw new Error('行為資料格式錯誤');
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
