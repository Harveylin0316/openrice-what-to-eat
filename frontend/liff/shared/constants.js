// 前端只顯示的7個料理風格分類
export const FRONTEND_CUISINE_CATEGORIES = [
    '台式料理',
    '中式/港粵',
    '日式料理',
    '韓式料理',
    '美式料理',
    '東南亞料理',
    '多國料理'
];

// 前端只顯示的5個餐廳類型分類
export const FRONTEND_TYPE_CATEGORIES = [
    '燒肉',
    '火鍋',
    '吃到飽',
    '餐酒館',
    '咖啡廳'
];

// 料理風格與餐廳類型的 icon map 已移除（新版 UI 改用純文字選項）
// 如需重新加入 icon，請於 frontend/liff/index.html 內 svg <defs> 區新增 symbol
// 並在 pages/home.js 渲染時 inline 引用

// API 基礎 URL 配置
export function getApiBaseUrl() {
    return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3000/api'
        : '/api';
}
