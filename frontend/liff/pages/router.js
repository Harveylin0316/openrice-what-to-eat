// 路由管理器
// 負責根據 URL pathname 或查詢參數切換不同的頁面
// 支援子目錄路由：/liff/home, /liff/favorites 等
// 同時向後兼容查詢參數：/liff?page=home

// 動態載入各頁（不再靜態 import）：任一頁或其相依（例如 app.js）壞掉/載入失敗，
// 都只影響那一頁，不會拖垮整個模組圖 → 地圖頁能獨立載入，開機更穩、也順便 lazy-load。
// map 頁本身不相依 app.js，所以就算 app.js 被 webview 快取住舊版/壞掉，地圖照常開。
// 沿用 index.html 內聯開機設的破快取版本 → 各頁也用 ?v 抓新版（新 URL＝一定重抓）
const V = (typeof window !== 'undefined' && window.__V) ? ('?v=' + window.__V) : '';
const routes = {
    'map': () => import('./map.js' + V).then(m => m.initMapPage),
    'home': () => import('./home.js' + V).then(m => m.initHomePage),
    'lottery': () => import('./lottery.js' + V).then(m => m.initLotteryPage),
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
    
    // 初始化 LINE 特定功能（分享、關閉等）——動態載入且不阻塞：
    // 它相依 app.js，萬一壞掉也不能擋住地圖開機。
    import('./components/liff-features.js' + V)
        .then(m => { try { m.initLiffFeatures(); } catch (e) { console.warn('initLiffFeatures 失敗', e); } })
        .catch(e => console.warn('liff-features 載入失敗（不影響地圖）', e));

    // 回地圖浮動鈕（非地圖頁顯示，樣式由 map.css 的 body.is-map-page 控制）
    const backToMapBtn = document.getElementById('backToMapBtn');
    if (backToMapBtn) {
        backToMapBtn.addEventListener('click', () => navigateTo(DEFAULT_PAGE));
    }
    
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
    // 標記當前頁面：回地圖浮動鈕只在「已載入的非地圖頁」顯示（避免初始化時閃現）
    document.body.dataset.page = pageName;
    // LINE header 以 title 顯示 app 身分（全站統一為「OpenRice 好康地圖」，抽獎頁另加前綴）
    document.title = pageName === 'lottery' ? '抽獎活動 - OpenRice 好康地圖' : 'OpenRice 好康地圖';
    // 首繪防閃現的 data-boot 由 router 接手後移除（否則 map 開場 fallback 到 home 時外殼會被卡住隱藏）
    document.documentElement.removeAttribute('data-boot');

    try {
        // 動態載入頁面模組 → 取得其初始化函數 → 執行
        const loader = routes[pageName];
        const initFunction = await loader();
        if (typeof initFunction === 'function') {
            await initFunction();
            currentPage = pageName;
            console.log(`頁面 "${pageName}" 載入成功`);
        } else {
            throw new Error(`頁面 "${pageName}" 的初始化函數無效`);
        }
    } catch (error) {
        console.error(`載入頁面 "${pageName}" 失敗:`, error);
        // 地圖是預設首頁：失敗時「不要」退回舊版「今天吃什麼」表單（Owner 要求不讓用戶再看到）。
        // 保留 is-map-page，讓 initMapPage 已渲染在 #liffMap 內的「地圖載入失敗・重新載入」卡可見，
        // 使用者留在地圖情境重試即可。只有「非地圖、非首頁」的其他頁才退回首頁。
        if (pageName === 'map') {
            const canvas = document.getElementById('liffMap');
            if (canvas && !canvas.querySelector('.map-error')) {
                canvas.innerHTML = '<div class="map-error"><p>😥 地圖載入失敗</p>'
                    + '<button type="button" class="map-btn map-btn--primary" onclick="location.reload()">重新載入</button></div>';
            }
            currentPage = null; // 沒真正載成功 → 允許再次點「好康地圖」重試
        } else if (pageName !== 'home') {
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
