// LINE LIFF App - 主入口文件
// 負責 LIFF 初始化和路由管理

// 註：不再 import router（地圖開機已由 index.html 內聯負責）；app.js 只做背景 LIFF。
import { track, setUserContext, markUserContextReady } from './shared/tracker.js';

// LINE LIFF ID（需要在 LINE Developers Console 獲取）
// 優先順序：1. URL 參數 2. 環境變數 3. 默認值
function getLiffId() {
    // 從 URL 參數獲取（方便測試）— 僅限本機。
    // 線上若允許 ?liffId= 覆寫，等於讓人指向自己的 LIFF app 通過登入閘門，
    // 而且會造成同一頁對兩個不同 LIFF app 各 init 一次。
    const host = window.location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
    const urlParams = new URLSearchParams(window.location.search);
    const urlLiffId = urlParams.get('liffId');
    if (isLocal && urlLiffId) {
        console.log('從 URL 參數獲取 LIFF ID:', urlLiffId);
        return urlLiffId;
    }
    
    // 從環境變數獲取（如果設置了）
    if (window.LIFF_ID) {
        console.log('從環境變數獲取 LIFF ID');
        return window.LIFF_ID;
    }
    
    // 默認值：新 provider 的 Login channel（2026-07 切換）。
    // 正式環境實際靠 index.html <head> 內聯的 window.LIFF_ID 提供（上面那段先命中）；
    // 這個內建預設是 window.LIFF_ID 未設時的保底，兩者保持一致。
    // 舊 channel（已停用）：2008944358-649rLhGj
    const defaultLiffId = '2007974193-JJfJNq2h';

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
// SDK 有時比 DOMContentLoaded 晚一點就緒（或載入失敗）→ 輪詢等它，等不到就放棄。
// 逾時必須 >= index.html 登入閘門的 GATE.SDK_WAIT_MS(10s)：若這裡先放棄，
// 會變成「閘門放行、使用者已登入，但這支拿不到 profile」→ 整場事件 line_id 全是 null。
async function waitForLiffSdk(maxMs = 12000) {
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
        // 共用 index.html 登入閘門建立的那個 init promise。
        // 兩邊各自 init 會同時拿同一個一次性授權碼去換 token，慢的那邊必定失敗——
        // 若失敗的是這裡，使用者明明剛登入成功，事件卻會被記成 liff_unavailable、is_in_line=false。
        if (!window.__liffInitPromise) {
            window.__liffInitPromise = liff.init({ liffId: LIFF_ID });
        }
        await Promise.race([
            window.__liffInitPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('LIFF init 逾時')), 12000)),
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
        // 關掉 LINE「下拉縮小/關閉 LIFF」手勢（r54 Owner：長按往下拉常誤退出）。
        // 地圖是全螢幕手勢應用（拖曳/長按/拉抬清單都是垂直手勢），與這個系統手勢天生打架；
        // 離開走右上角 ✕，跟 Google Maps 一樣不會「滑一滑就不見」。
        try {
            if (liff.isInClient() && typeof liff.setVerticalSwipeEnabled === 'function') {
                liff.setVerticalSwipeEnabled(false);
            }
        } catch (e) { /* 舊版 LINE 不支援：維持原生行為 */ }
        setUserContext({
            line_id: liffProfile?.userId || null,
            is_in_line: liff.isInClient(),
            os: liff.getOS(),
            language: liff.getLanguage(),
        });
        // 身分已確定 → 放行先前排隊的事件（開場那批才不會變匿名）
        markUserContextReady();
        track('app_open', { logged_in: liff.isLoggedIn() });
    } catch (error) {
        console.warn('LIFF 背景初始化失敗（不影響地圖）:', error);
        try {
            setUserContext({ is_in_line: false, os: 'liff-unavailable', language: navigator.language });
            // 確定拿不到身分也要放行，否則排隊的事件會卡到逾時才送、甚至整批遺失
            markUserContextReady();
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
    // ?dev=1 只在本機有效。線上若讓它生效，使用者明明過了登入閘門、追蹤卻記成匿名，
    // 與「擋掉匿名流量」的目的直接矛盾（而且等於留了一個公開的略過參數）。
    const host = window.location.hostname;
    const isLocalDev = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
    if (isLocalDev && params.get('dev') === '1') {
        setUserContext({ is_in_line: false, os: 'dev', language: navigator.language });
        markUserContextReady();
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
