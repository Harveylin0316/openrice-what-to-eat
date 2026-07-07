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
// SDK 有時比 DOMContentLoaded 晚一點就緒（或載入失敗）→ 短暫輪詢等它，等不到就放棄。
async function waitForLiffSdk(maxMs = 3000) {
    if (window.liff) return window.liff;
    const start = Date.now();
    while (!window.liff && Date.now() - start < maxMs) {
        await new Promise(r => setTimeout(r, 150));
    }
    return window.liff || null;
}

// LIFF 「背景」初始化：只為了拿 profile（追蹤/分享用）。
// 關鍵：這裡完全不碰載入畫面與路由——地圖已經先開好了，所以 LIFF SDK 沒載到、
// init 卡住或失敗，都不會再把用戶卡在「正在連線 LINE」。
async function initLiffBackground() {
    try {
        liff = await waitForLiffSdk();
        if (!liff) throw new Error('LIFF SDK 未載入（window.liff undefined）');
        await Promise.race([
            liff.init({ liffId: LIFF_ID }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('LIFF init 逾時')), 8000)),
        ]);
        if (liff.isLoggedIn()) {
            try {
                liffProfile = await Promise.race([
                    liff.getProfile(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('getProfile 逾時')), 4000)),
                ]);
            } catch (e) {
                console.warn('取用戶資料失敗/逾時，略過:', e);
            }
        }
        setUserContext({
            line_id: liffProfile?.userId || null,
            is_in_line: liff.isInClient(),
            os: liff.getOS(),
            language: liff.getLanguage(),
        });
        track('app_open', { logged_in: liff.isLoggedIn() });
    } catch (error) {
        console.warn('LIFF 背景初始化失敗（不影響地圖）:', error);
        try {
            setUserContext({ is_in_line: false, os: 'liff-unavailable', language: navigator.language });
            track('app_open', { liff_unavailable: true });
        } catch (e) { /* ignore */ }
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

// 頁面載入 → 開機
function boot() {
    // 防重複開機：app.js 若被載入成兩個模組實例（例如帶 ?v 查詢字串 + 其他頁 import '../app.js'）
    // 會註冊兩次 → initRouter 跑兩次 → 地圖重複初始化。用全域旗標確保只開機一次。
    if (window.__rrBooted) return;
    window.__rrBooted = true;

    // 關鍵：地圖不依賴 LINE → 先無條件把 App 開起來，畫面一定進得去。
    // 徹底根治「卡在正在連線 LINE」——過去只要 LIFF SDK 沒載到或 init 卡住就整個卡死。
    try {
        if (liffLoading) liffLoading.style.display = 'none';
        initRouter();
    } catch (e) {
        console.error('initRouter 失敗:', e);
        showError('載入失敗，請重新整理');
    }

    // 之後才在背景初始化 LIFF（拿 profile 供追蹤/分享用），成敗都不影響地圖已顯示
    const params = new URLSearchParams(window.location.search);
    if (params.get('dev') === '1') {
        setUserContext({ is_in_line: false, os: 'dev', language: navigator.language });
        track('app_open', { dev: true });
    } else {
        initLiffBackground();
    }
}

// DOMContentLoaded 可能在此模組執行前就已觸發（模組是 deferred）→ 用 readyState 保險，
// 兩種情況都能開機、且靠 __rrBooted 不會重複。
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
