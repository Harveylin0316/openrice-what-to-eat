// LINE LIFF App - 主入口文件
// 負責 LIFF 初始化和路由管理

import { initRouter } from './pages/router.js';
import { track, setUserContext } from './shared/tracker.js';

// LINE LIFF ID（需要在 LINE Developers Console 獲取）
// 優先順序：1. URL 參數 2. 環境變數 3. 默認值
function getLiffId() {
    // 從 URL 參數獲取（方便測試）
    const urlParams = new URLSearchParams(window.location.search);
    const urlLiffId = urlParams.get('liffId');
    if (urlLiffId) {
        console.log('從 URL 參數獲取 LIFF ID:', urlLiffId);
        return urlLiffId;
    }
    
    // 從環境變數獲取（如果設置了）
    if (window.LIFF_ID) {
        console.log('從環境變數獲取 LIFF ID');
        return window.LIFF_ID;
    }
    
    // 默認值（已設置 LIFF ID）
    // 目前使用舊版 LIFF Channel ID（穩定可用）
    // Mini App ID（待修好 Development endpoint 後再切）：'2010198695-KNvBANCO'
    const defaultLiffId = '2008944358-649rLhGj';
    
    return defaultLiffId;
}

const LIFF_ID = getLiffId();
// 供地圖分享功能組深連結用（好友點開直接進該店）：dev 模式也會設定
window.__LIFF_ID = LIFF_ID;

// LINE LIFF 實例
let liff = null;
let liffProfile = null;

// DOM 元素
const liffLoading = document.getElementById('liffLoading');
const mainContent = document.getElementById('mainContent');

/**
 * 初始化 LIFF
 */
async function initLiff() {
    try {
        console.log('正在初始化 LINE LIFF...');
        
        // 初始化 LIFF SDK
        liff = window.liff;
        // liff.init 偶爾在某些網路/登入狀態下 hang 住 → 逾時保護，
        // 不讓用戶卡死在「正在連線 LINE」載入畫面（8 秒沒好就走 fallback）。
        await Promise.race([
            liff.init({ liffId: LIFF_ID }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('LIFF init 逾時')), 8000)),
        ]);

        console.log('LIFF 初始化成功');
        console.log('LIFF 環境:', {
            isInClient: liff.isInClient(),
            isLoggedIn: liff.isLoggedIn(),
            os: liff.getOS(),
            version: liff.getVersion(),
            language: liff.getLanguage()
        });
        
        // 檢查是否在 LINE 內
        if (!liff.isInClient()) {
            console.warn('不在 LINE 內，某些功能可能無法使用');
            // 可以選擇提示用戶在 LINE 內打開
        }
        
        // 如果已登入，獲取用戶資料（也加逾時，拿不到就當未登入，不擋進場）
        if (liff.isLoggedIn()) {
            try {
                liffProfile = await Promise.race([
                    liff.getProfile(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('getProfile 逾時')), 4000)),
                ]);
                console.log('用戶資料:', liffProfile);
            } catch (e) {
                console.warn('取用戶資料失敗/逾時，略過:', e);
            }
        } else {
            // 如果未登入，可以選擇登入（如果需要）
            // liff.login();
            console.log('用戶未登入');
        }

        // 設定 tracker 用戶 context + 送 app_open 事件
        setUserContext({
            line_id: liffProfile?.userId || null,
            is_in_line: liff.isInClient(),
            os: liff.getOS(),
            language: liff.getLanguage(),
        });
        track('app_open', { logged_in: liff.isLoggedIn() });

        // 隱藏 LIFF 載入畫面
        if (liffLoading) liffLoading.style.display = 'none';
        
        // 初始化路由系統（路由系統會載入對應的頁面）
        // 注意：mainContent 的顯示會在頁面初始化完成後由頁面自己控制
        initRouter();
        
    } catch (error) {
        // init/getProfile 失敗或逾時 → 不卡在「正在連線 LINE」，改用無登入模式照樣進 App。
        // 地圖核心不需要 LINE profile；分享等需要 LINE 的功能會各自降級處理。
        console.error('LIFF 初始化失敗/逾時，改用無登入模式進場:', error);
        try {
            setUserContext({ is_in_line: false, os: 'liff-fallback', language: navigator.language });
            track('app_open', { liff_fallback: true });
        } catch (e) { /* ignore */ }
        if (liffLoading) liffLoading.style.display = 'none';
        initRouter();
    }
}

/**
 * 顯示錯誤訊息
 */
function showError(message) {
    const error = document.getElementById('error');
    const errorMessage = document.getElementById('errorMessage');
    if (errorMessage) errorMessage.textContent = message;
    if (error) {
        error.style.display = 'block';
        error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/**
 * 導出 LIFF 實例和用戶資料（供其他模組使用）
 */
export function getLiff() {
    return liff;
}

export function getLiffProfile() {
    return liffProfile;
}

// 頁面載入時初始化 LIFF
document.addEventListener('DOMContentLoaded', () => {
    // 防重複開機：app.js 若被載入成兩個模組實例（例如帶 ?v 查詢字串 + 其他頁 import '../app.js'
    // 兩個 URL＝兩份實例），會註冊兩個 DOMContentLoaded → initRouter 跑兩次 → 地圖重複初始化
    // (Map container is already initialized)。用全域旗標確保只開機一次。
    if (window.__rrBooted) return;
    window.__rrBooted = true;

    // Dev bypass: ?dev=1 跳過 LIFF 初始化（本機預覽 / Storybook 用，正式 LIFF 不受影響）
    const params = new URLSearchParams(window.location.search);
    if (params.get('dev') === '1') {
        console.log('[dev] Bypassing LIFF init');
        if (liffLoading) liffLoading.style.display = 'none';
        // dev 模式也送 app_open（line_id 為 null）
        setUserContext({ is_in_line: false, os: 'dev', language: navigator.language });
        track('app_open', { dev: true });
        initRouter();
        return;
    }

    // 檢查 LIFF SDK 是否已載入
    if (window.liff) {
        initLiff();
    } else {
        console.error('LINE LIFF SDK 未載入');
        showError('LINE LIFF SDK 載入失敗，請檢查網路連線');
    }
});
