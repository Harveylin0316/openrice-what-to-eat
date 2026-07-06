// 路由管理器
// 負責根據 URL pathname 或查詢參數切換不同的頁面
// 支援子目錄路由：/liff/home, /liff/favorites 等
// 同時向後兼容查詢參數：/liff?page=home

import { initHomePage } from './home.js';
import { initLotteryPage } from './lottery.js';
import { initMapPage } from './map.js';
import { initLiffFeatures } from './components/liff-features.js';

// 頁面路由映射
// 'map'（生活地圖）是新的預設首頁；'home' 保留為傳統表單推薦頁（/liff/home）
const routes = {
    'map': initMapPage,
    'home': initHomePage,
    'lottery': initLotteryPage,
    // 未來可以添加更多頁面：
    // 'favorites': initFavoritesPage,
    // 'history': initHistoryPage,
    // 'settings': initSettingsPage,
};

// 預設頁面（生活地圖）
const DEFAULT_PAGE = 'map';

// 當前頁面
let currentPage = null;

/**
 * 從 URL 解析頁面名稱
 * 優先順序：1. pathname (/liff/home) 2. 查詢參數 (?page=home) 3. 默認 (home)
 * @returns {string} 頁面名稱
 */
function parsePageFromUrl() {
    const pathname = window.location.pathname;
    const urlParams = new URLSearchParams(window.location.search);
    
    // 優先從 pathname 解析（子目錄路由）
    // 例如：/liff/home -> home, /liff/favorites -> favorites
    if (pathname.startsWith('/liff/')) {
        const pageFromPath = pathname.replace('/liff/', '').split('/')[0];
        if (pageFromPath && routes[pageFromPath]) {
            console.log('從 pathname 解析頁面:', pageFromPath);
            return pageFromPath;
        }
    }
    // 注意：/liff 根路徑不在此提前 return，讓 ?page=home 等舊查詢參數
    // （文件與 Rich Menu 使用的網址格式）仍然有效，最後才 fallback 到地圖

    // 向後兼容：從查詢參數解析
    const pageFromQuery = urlParams.get('page');
    if (pageFromQuery && routes[pageFromQuery]) {
        console.log('從查詢參數解析頁面:', pageFromQuery);
        return pageFromQuery;
    }

    // 默認返回首頁（生活地圖）
    console.log('使用默認頁面:', DEFAULT_PAGE);
    return DEFAULT_PAGE;
}

/**
 * 初始化路由系統
 */
export function initRouter() {
    console.log('初始化路由系統');
    console.log('當前 URL:', window.location.href);
    console.log('Pathname:', window.location.pathname);
    console.log('Search:', window.location.search);
    
    // 初始化 LINE 特定功能（分享、關閉等）
    initLiffFeatures();
    
    // 從 URL 解析頁面
    const page = parsePageFromUrl();
    
    console.log('當前頁面:', page);
    
    // 載入對應的頁面
    loadPage(page);
}

/**
 * 載入指定頁面
 * @param {string} pageName - 頁面名稱
 */
async function loadPage(pageName) {
    // 如果頁面不存在，使用首頁（生活地圖）
    if (!routes[pageName]) {
        console.warn(`頁面 "${pageName}" 不存在，使用預設頁面`);
        pageName = DEFAULT_PAGE;
    }

    // 如果已經載入相同頁面，不需要重新載入
    if (currentPage === pageName) {
        console.log(`頁面 "${pageName}" 已經載入`);
        return;
    }

    console.log(`載入頁面: ${pageName}`);

    // 地圖頁全螢幕顯示、隱藏一般頁面容器（map.css 依此 class 切換）
    document.body.classList.toggle('is-map-page', pageName === 'map');

    try {
        // 調用對應頁面的初始化函數
        const initFunction = routes[pageName];
        if (typeof initFunction === 'function') {
            await initFunction();
            currentPage = pageName;
            console.log(`頁面 "${pageName}" 載入成功`);
        } else {
            throw new Error(`頁面 "${pageName}" 的初始化函數無效`);
        }
    } catch (error) {
        console.error(`載入頁面 "${pageName}" 失敗:`, error);
        // 如果載入失敗，嘗試載入傳統首頁作為備用（地圖失敗也能退回表單推薦）
        if (pageName !== 'home') {
            console.log('嘗試載入首頁作為備用');
            document.body.classList.remove('is-map-page');
            await loadPage('home');
        }
    }
}

/**
 * 導航到指定頁面
 * 使用 pathname 路由（/liff/home, /liff/favorites 等）
 * @param {string} pageName - 頁面名稱
 */
export function navigateTo(pageName) {
    if (!routes[pageName]) {
        console.warn(`頁面 "${pageName}" 不存在`);
        return;
    }
    
    // 構建新的 pathname URL
    // 例如：/liff（地圖首頁）, /liff/home, /liff/lottery
    const basePath = '/liff';
    const newPath = pageName === DEFAULT_PAGE ? basePath : `${basePath}/${pageName}`;
    
    // 更新 URL（不刷新頁面）
    const newUrl = new URL(window.location.origin + newPath);
    // 保留其他查詢參數（如果有），但排除 page 參數
    const urlParams = new URLSearchParams(window.location.search);
    urlParams.forEach((value, key) => {
        if (key !== 'page') {
            newUrl.searchParams.set(key, value);
        }
    });
    
    window.history.pushState({ page: pageName }, '', newUrl);
    
    // 載入新頁面
    loadPage(pageName);
}

/**
 * 獲取當前頁面名稱
 */
export function getCurrentPage() {
    return currentPage || DEFAULT_PAGE;
}

// 監聽瀏覽器前進/後退按鈕
window.addEventListener('popstate', (event) => {
    const page = parsePageFromUrl();
    loadPage(page);
});
