// LINE LIFF App - 主入口文件
// 負責 LIFF 初始化和路由管理

// 註：不再 import router（地圖開機已由 index.html 內聯負責）；app.js 只做背景 LIFF。
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

// 地圖開機已由 index.html 的內聯模組負責（那段永遠隨 index.html 更新，不受 app.js
// 被 webview 快取住的影響）。app.js 這裡只補「LINE 背景初始化」——拿 profile / 供分享用，
// 與地圖是否顯示完全無關。用獨立旗標 __liffStarted（不與開機旗標 __rrBooted 綁一起，
// 否則內聯開機設了 __rrBooted 會把這段也擋掉）。
function startLiffBackground() {
    if (window.__liffStarted) return;
    window.__liffStarted = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('dev') === '1') {
        setUserContext({ is_in_line: false, os: 'dev', language: navigator.language });
        track('app_open', { dev: true });
        return;
    }
    initLiffBackground();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startLiffBackground);
} else {
    startLiffBackground();
}
