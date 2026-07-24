// 抽獎頁面
// 包含抽獎功能的所有邏輯

import { getLiff } from '../app.js';

// 頁面狀態
let userData = null;
let isDrawing = false;

// 顯示初始化進度
function showInitProgress(message) {
    const initLoading = document.getElementById('initLoading');
    const initLoadingText = document.getElementById('initLoadingText');
    if (initLoading) initLoading.style.display = 'block';
    if (initLoadingText) initLoadingText.textContent = message;
}

// 隱藏初始化進度
function hideInitProgress() {
    const initLoading = document.getElementById('initLoading');
    const mainContent = document.getElementById('mainContent');
    if (initLoading) initLoading.style.display = 'none';
    if (mainContent) mainContent.style.display = 'block';
}

// 渲染抽獎頁面
function renderLotteryPage() {
    const mainContent = document.getElementById('mainContent');
    if (!mainContent) return;
    
    // 更新標題
    document.title = '🎁 抽獎活動 - OpenRice 好康地圖';
    
    const header = document.querySelector('.header h1');
    if (header) header.textContent = '🎁 抽獎活動';
    
    const subtitle = document.querySelector('.header .subtitle');
    if (subtitle) subtitle.textContent = '邀請好友獲得更多抽獎機會！';
    
    // 清空並創建抽獎頁面內容
    mainContent.innerHTML = `
        <!-- 野餐籃區域 -->
        <section class="lottery-section">
            <div class="basket-container">
                <div class="basket">
                    <div class="basket-handle"></div>
                    <div class="food-items">
                        <div class="food-item ${userData && userData.remainingChances >= 1 ? 'active' : 'inactive'}" data-index="0">
                            <div class="food-icon">🍎</div>
                            <div class="food-glow"></div>
                        </div>
                        <div class="food-item ${userData && userData.remainingChances >= 2 ? 'active' : 'inactive'}" data-index="1">
                            <div class="food-icon">🍞</div>
                            <div class="food-glow"></div>
                        </div>
                        <div class="food-item ${userData && userData.remainingChances >= 3 ? 'active' : 'inactive'}" data-index="2">
                            <div class="food-icon">🧀</div>
                            <div class="food-glow"></div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- 抽獎次數顯示 -->
            <div class="chances-info">
                <p class="chances-text">
                    剩餘抽獎次數：<span class="chances-count">${userData ? userData.remainingChances : 0}</span>
                </p>
                <p class="chances-hint">
                    ${userData && userData.invitedCount < 2 ? '邀請好友可獲得更多抽獎機會！' : '已達到最大邀請次數'}
                </p>
            </div>
            
            <!-- 抽獎按鈕 -->
            <button id="drawBtn" class="draw-btn" ${userData && userData.remainingChances > 0 && !isDrawing ? '' : 'disabled'}>
                ${isDrawing ? '抽獎中...' : '開始抽獎'}
            </button>
            
            <!-- 邀請好友按鈕 -->
            <button id="inviteBtn" class="invite-btn">
                <span>📤</span> 邀請好友
            </button>
        </section>
        
        <!-- 抽獎結果彈窗 -->
        <div id="resultModal" class="modal" style="display: none;">
            <div class="modal-content">
                <div class="modal-header">
                    <h2>🎉 抽獎結果</h2>
                    <button class="modal-close" id="closeModal">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="prize-result">
                        <div class="prize-icon">🎁</div>
                        <h3 id="prizeName"></h3>
                        <p id="prizeDescription"></p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="confirmBtn" class="confirm-btn">確定</button>
                </div>
            </div>
        </div>
        
        <!-- 抽獎記錄 -->
        <section class="records-section">
            <h2 class="records-title">📋 我的抽獎記錄</h2>
            <div id="recordsList" class="records-list">
                <!-- 動態載入記錄 -->
            </div>
        </section>
    `;
    
    // 設置事件監聽器
    setupEventHandlers();
    
    // 載入抽獎記錄
    loadRecords();
}

// 設置事件處理器
function setupEventHandlers() {
    // 抽獎按鈕
    const drawBtn = document.getElementById('drawBtn');
    if (drawBtn) {
        drawBtn.addEventListener('click', handleDraw);
    }
    
    // 邀請好友按鈕
    const inviteBtn = document.getElementById('inviteBtn');
    if (inviteBtn) {
        inviteBtn.addEventListener('click', handleInvite);
    }
    
    // 關閉彈窗
    const closeModal = document.getElementById('closeModal');
    const confirmBtn = document.getElementById('confirmBtn');
    const resultModal = document.getElementById('resultModal');
    
    if (closeModal) {
        closeModal.addEventListener('click', () => {
            if (resultModal) resultModal.style.display = 'none';
        });
    }
    
    if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
            if (resultModal) resultModal.style.display = 'none';
            // 重新載入用戶資料
            loadUserData();
        });
    }
    
    // 點擊彈窗外部關閉
    if (resultModal) {
        resultModal.addEventListener('click', (e) => {
            if (e.target === resultModal) {
                resultModal.style.display = 'none';
            }
        });
    }
}

// 載入用戶資料
async function loadUserData() {
    try {
        const liff = getLiff();
        if (!liff || !liff.isLoggedIn()) {
            throw new Error('請先登入 LINE');
        }
        
        const profile = await liff.getProfile();
        const lineId = profile.userId;
        
        // 調用 API 獲取用戶資料
        const response = await fetch(`/api/lottery/user?lineId=${encodeURIComponent(lineId)}`);
        const data = await response.json();
        
        if (data.success) {
            userData = data.user;
            // 更新 UI
            updateUI();
        } else {
            throw new Error(data.error || '獲取用戶資料失敗');
        }
    } catch (error) {
        console.error('載入用戶資料失敗:', error);
        showError(error.message || '載入用戶資料失敗');
    }
}

// 更新 UI
function updateUI() {
    if (!userData) return;
    
    // 更新食物圖示狀態
    const foodItems = document.querySelectorAll('.food-item');
    foodItems.forEach((item, index) => {
        const shouldBeActive = userData.remainingChances >= (index + 1);
        if (shouldBeActive) {
            item.classList.add('active');
            item.classList.remove('inactive');
        } else {
            item.classList.add('inactive');
            item.classList.remove('active');
        }
    });
    
    // 更新抽獎次數顯示
    const chancesCount = document.querySelector('.chances-count');
    if (chancesCount) {
        chancesCount.textContent = userData.remainingChances;
    }
    
    // 更新抽獎按鈕
    const drawBtn = document.getElementById('drawBtn');
    if (drawBtn) {
        if (userData.remainingChances > 0 && !isDrawing) {
            drawBtn.disabled = false;
            drawBtn.textContent = '開始抽獎';
        } else {
            drawBtn.disabled = true;
            drawBtn.textContent = isDrawing ? '抽獎中...' : '沒有剩餘次數';
        }
    }
    
    // 更新提示文字
    const chancesHint = document.querySelector('.chances-hint');
    if (chancesHint) {
        if (userData.invitedCount < 2) {
            chancesHint.textContent = '邀請好友可獲得更多抽獎機會！';
        } else {
            chancesHint.textContent = '已達到最大邀請次數';
        }
    }
}

// 處理抽獎
async function handleDraw() {
    if (isDrawing || !userData || userData.remainingChances <= 0) {
        return;
    }
    
    try {
        isDrawing = true;
        updateUI();
        
        const liff = getLiff();
        if (!liff || !liff.isLoggedIn()) {
            throw new Error('請先登入 LINE');
        }
        
        const profile = await liff.getProfile();
        const lineId = profile.userId;
        
        // 調用抽獎 API
        const response = await fetch('/api/lottery/draw', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ lineId }),
        });
        
        const data = await response.json();
        
        if (data.success) {
            // 更新用戶資料
            userData = data.user;
            
            // 顯示抽獎結果
            showResult(data.prize);
            
            // 更新 UI
            updateUI();
            
            // 重新載入記錄
            loadRecords();
        } else {
            throw new Error(data.error || '抽獎失敗');
        }
    } catch (error) {
        console.error('抽獎失敗:', error);
        showError(error.message || '抽獎失敗，請稍後再試');
    } finally {
        isDrawing = false;
        updateUI();
    }
}

// 顯示抽獎結果
function showResult(prize) {
    const resultModal = document.getElementById('resultModal');
    const prizeName = document.getElementById('prizeName');
    const prizeDescription = document.getElementById('prizeDescription');
    
    if (resultModal) resultModal.style.display = 'block';
    if (prizeName) prizeName.textContent = prize.name;
    if (prizeDescription) prizeDescription.textContent = prize.description || '';
}

// 處理邀請好友
async function handleInvite() {
    try {
        const liff = getLiff();
        if (!liff || !liff.isLoggedIn()) {
            throw new Error('請先登入 LINE');
        }
        
        const profile = await liff.getProfile();
        const lineId = profile.userId;
        
        // 生成邀請連結
        const inviteUrl = `${window.location.origin}/liff/lottery?inviter=${encodeURIComponent(lineId)}`;
        
        // 使用 LINE 分享功能
        if (liff.isApiAvailable('shareTargetPicker')) {
            await liff.shareTargetPicker([
                {
                    type: 'text',
                    text: `🎁 邀請你參加抽獎活動！\n\n點擊連結加入並獲得抽獎機會：\n${inviteUrl}`
                }
            ]);
        } else {
            // 如果不支援分享，複製連結到剪貼板
            await navigator.clipboard.writeText(inviteUrl);
            alert('邀請連結已複製到剪貼板！');
        }
    } catch (error) {
        console.error('邀請失敗:', error);
        showError(error.message || '邀請失敗，請稍後再試');
    }
}

// 載入抽獎記錄
async function loadRecords() {
    try {
        const liff = getLiff();
        if (!liff || !liff.isLoggedIn()) {
            return;
        }
        
        const profile = await liff.getProfile();
        const lineId = profile.userId;
        
        // 調用 API 獲取記錄
        const response = await fetch(`/api/lottery/records?lineId=${encodeURIComponent(lineId)}`);
        const data = await response.json();
        
        if (data.success) {
            renderRecords(data.records);
        }
    } catch (error) {
        console.error('載入記錄失敗:', error);
    }
}

// 渲染抽獎記錄
function renderRecords(records) {
    const recordsList = document.getElementById('recordsList');
    if (!recordsList) return;
    
    if (records.length === 0) {
        recordsList.innerHTML = '<p class="no-records">還沒有抽獎記錄</p>';
        return;
    }
    
    recordsList.innerHTML = records.map(record => `
        <div class="record-item">
            <div class="record-icon">🎁</div>
            <div class="record-info">
                <div class="record-prize">${record.prizeName}</div>
                <div class="record-time">${formatDate(record.drawnAt)}</div>
            </div>
        </div>
    `).join('');
}

// 格式化日期
function formatDate(dateString) {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// 顯示錯誤訊息
function showError(message) {
    alert(message);
}

// 檢查邀請者參數
async function checkInviter() {
    const urlParams = new URLSearchParams(window.location.search);
    const inviterLineId = urlParams.get('inviter');
    
    if (inviterLineId) {
        try {
            const liff = getLiff();
            if (!liff || !liff.isLoggedIn()) {
                return;
            }
            
            const profile = await liff.getProfile();
            const newUserLineId = profile.userId;
            
            // 調用邀請 API
            const response = await fetch('/api/lottery/invite', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    inviterLineId: inviterLineId,
                    newUserLineId: newUserLineId,
                }),
            });
            
            const data = await response.json();
            if (data.success) {
                // 移除 URL 參數
                const newUrl = new URL(window.location);
                newUrl.searchParams.delete('inviter');
                window.history.replaceState({}, '', newUrl);
                
                // 重新載入用戶資料
                await loadUserData();
            }
        } catch (error) {
            console.error('處理邀請失敗:', error);
        }
    }
}

// 初始化抽獎頁面
export async function initLotteryPage() {
    console.log('初始化抽獎頁面');
    
    try {
        // 顯示初始化進度
        const mainContent = document.getElementById('mainContent');
        if (mainContent) mainContent.style.display = 'none';
        
        showInitProgress('正在載入抽獎頁面...');
        
        // 檢查 LIFF 登入狀態
        const liff = getLiff();
        if (!liff) {
            throw new Error('LIFF 未初始化');
        }
        
        // 如果未登入，嘗試登入
        if (!liff.isLoggedIn()) {
            showInitProgress('正在登入...');
            liff.login();
            return;
        }
        
        // 載入用戶資料
        showInitProgress('正在載入用戶資料...');
        await loadUserData();
        
        // 檢查邀請者參數
        await checkInviter();
        
        // 渲染頁面
        showInitProgress('正在初始化頁面...');
        renderLotteryPage();
        
        // 隱藏載入畫面
        hideInitProgress();
        
    } catch (error) {
        console.error('初始化抽獎頁面失敗:', error);
        showError(error.message || '初始化失敗，請重新整理頁面');
        hideInitProgress();
    }
}
