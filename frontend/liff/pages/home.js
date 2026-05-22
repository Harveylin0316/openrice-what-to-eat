// 首頁：今天吃什麼（餐廳推薦功能）
// 這個文件包含餐廳推薦頁面的所有邏輯

import {
    FRONTEND_CUISINE_CATEGORIES,
    FRONTEND_TYPE_CATEGORIES
} from '../shared/constants.js';
import {
    loadFilterOptions as apiLoadFilterOptions,
    loadLocationOptions as apiLoadLocationOptions,
    loadSponsoredRestaurants,
    fetchRecommendations
} from '../shared/api.js';
import { filterGeneralTags, initImageCarousels, calculateDistance, formatDistance, getOpeningStatus, generateOmikuji, generateEvidence } from '../shared/utils.js';
import { getLiff, getLiffProfile } from '../app.js';
import { track } from '../shared/tracker.js';

// 頁面狀態
let filterOptions = {
    cuisine_style: [],
    type: [],
    budget: []
};

let locationOptions = {
    cities: [],
    districts: {}
};

let userLocation = null;
let displayedRestaurants = [];
let locationRequestInProgress = false;

// 廣告插入：每抽 N 次插一個（OpenRice 小知識 + 贊助餐廳合併池）
const AD_EVERY = 4;
let drawCount = 0;
let sponsoredRestaurants = []; // init 時從 /api/restaurants/sponsored 載入

// 合併廣告池：tips（固定 4 條）+ sponsored 餐廳（動態，is_paid_account=true 的）
function buildAdPool() {
    return [
        ...ADS.map(a => ({ kind: 'tip', data: a })),
        ...sponsoredRestaurants.map(s => ({ kind: 'sponsored', data: s })),
    ];
}

let adQueue = []; // 已洗牌的 entries
let lastAdSig = null;

function adSig(entry) {
    return entry.kind === 'tip' ? `tip:${entry.data.title}` : `spo:${entry.data.or_id}`;
}

function pickNextAd() {
    const pool = buildAdPool();
    if (pool.length === 0) return null;
    if (adQueue.length === 0) {
        adQueue = pool.slice();
        for (let i = adQueue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [adQueue[i], adQueue[j]] = [adQueue[j], adQueue[i]];
        }
        // 防接縫處撞同一個
        if (pool.length > 1 && lastAdSig && adSig(adQueue[adQueue.length - 1]) === lastAdSig) {
            const last = adQueue.length - 1;
            [adQueue[last], adQueue[last - 1]] = [adQueue[last - 1], adQueue[last]];
        }
    }
    const entry = adQueue.pop();
    lastAdSig = adSig(entry);
    return entry;
}
const ADS = [
    {
        icon: 'icon-gift',
        title: '獨家優惠',
        body: '很多餐廳在 OpenRice 都有獨家優惠，訂位前不妨先看看餐廳頁面有沒有驚喜。',
    },
    {
        icon: 'icon-wallet',
        title: '訂位現金回饋',
        body: '每次透過 OpenRice 訂位，都能拿到現金或航空里程回饋，吃飯也能存錢。',
    },
    {
        icon: 'icon-clock',
        title: '冷門時段折扣',
        body: '想省一點？很多餐廳在午茶、下午、宵夜這種冷門時段有大幅度折扣。',
    },
    {
        icon: 'icon-instagram',
        title: '追蹤 OpenRice IG',
        body: '探店短影片每週更新，找下一頓飯的靈感就在這。',
        url: 'https://www.instagram.com/openricetw/',
        ctaText: '立即追蹤',
    },
];

// 更新「使用我的位置」按鈕內的文字（保留旁邊的 SVG icon）
function setLocationBtnText(text) {
    const el = document.getElementById('getLocationBtnText');
    if (el) el.textContent = text;
}

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

// 初始化首頁
export async function initHomePage() {
    console.log('初始化首頁：今天吃什麼');
    
    try {
        // 顯示初始化進度（確保 mainContent 隱藏）
        const mainContent = document.getElementById('mainContent');
        if (mainContent) mainContent.style.display = 'none';
        
        showInitProgress('正在載入篩選選項...');
        
        // 並行載入兩個 API，減少總等待時間
        // 使用 Promise.all 同時發起兩個請求，總時間 = max(API1時間, API2時間)
        const loadPromises = [
            loadFilterOptions(),
            loadLocationOptions()
        ];
        
        // 監控載入進度
        let filterLoaded = false;
        let locationLoaded = false;
        
        const filterPromise = loadPromises[0].then(result => {
            filterLoaded = true;
            if (!locationLoaded) {
                showInitProgress('正在載入地區選項...');
            }
            return result;
        });
        
        const locationPromise = loadPromises[1].then(result => {
            locationLoaded = true;
            if (!filterLoaded) {
                showInitProgress('正在載入篩選選項...');
            }
            return result;
        });
        
        // 等待兩個 API 都完成
        await Promise.all([filterPromise, locationPromise]);
        
        showInitProgress('正在初始化表單...');
        
        // 渲染表單
        renderForm();
        setupLocationModeHandlers();
        
        // 初始化顯示「選擇地區」選項（預設選項，避免自動獲取位置導致的錯誤）
        const areaOptions = document.getElementById('areaOptions');
        const nearbyOptions = document.getElementById('nearbyOptions');
        if (areaOptions) areaOptions.style.display = 'block';
        if (nearbyOptions) nearbyOptions.style.display = 'none';
        
        // 設置表單提交事件
        setupFormSubmit();

        // 設置重新選擇按鈕
        setupResetButton();

        // 設置「更多設定」收合區的摘要更新
        setupAdvancedOptionsSummary();

        // 背景載入贊助餐廳列表（給廣告位輪播用），失敗不影響主流程
        loadSponsoredRestaurants().then(list => {
            sponsoredRestaurants = list || [];
            console.log(`[sponsored] loaded ${sponsoredRestaurants.length} 間付費餐廳`);
        });
        
        // 隱藏載入進度，顯示主要內容
        hideInitProgress();
        
        // 不再自動獲取用戶位置，讓用戶主動選擇
        // 這樣可以避免間歇性的地理位置錯誤，提升用戶體驗
        // autoGetUserLocation(); // 已移除自動獲取
        
    } catch (err) {
        hideInitProgress();
        console.error('初始化首頁錯誤:', err);
        throw err;
    }
}

// 載入篩選選項
async function loadFilterOptions() {
    try {
        const options = await apiLoadFilterOptions();
        filterOptions = options;
        filterOptions.cuisine_style = filterOptions.cuisine_style.filter(
            cuisine => FRONTEND_CUISINE_CATEGORIES.includes(cuisine)
        );
        if (filterOptions.cuisine_style.length !== FRONTEND_CUISINE_CATEGORIES.length) {
            filterOptions.cuisine_style = [...FRONTEND_CUISINE_CATEGORIES];
        }
        filterOptions.type = filterOptions.type.filter(
            type => FRONTEND_TYPE_CATEGORIES.includes(type)
        );
        if (filterOptions.type.length !== FRONTEND_TYPE_CATEGORIES.length) {
            filterOptions.type = [...FRONTEND_TYPE_CATEGORIES];
        }
    } catch (err) {
        console.error('載入篩選選項錯誤:', err);
        filterOptions.cuisine_style = [...FRONTEND_CUISINE_CATEGORIES];
        filterOptions.type = [...FRONTEND_TYPE_CATEGORIES];
        throw err;
    }
}

// 載入地區選項
async function loadLocationOptions() {
    try {
        locationOptions = await apiLoadLocationOptions();
        renderCityOptions();
    } catch (err) {
        console.error('載入地區選項錯誤:', err);
        throw err;
    }
}

// 渲染縣市選項
function renderCityOptions() {
    const citySelect = document.getElementById('citySelect');
    if (!citySelect) return;
    
    citySelect.innerHTML = '<option value="">不限</option>';
    locationOptions.cities.forEach(city => {
        const option = document.createElement('option');
        option.value = city;
        option.textContent = city;
        citySelect.appendChild(option);
    });
}

// 渲染行政區選項
function renderDistrictOptions(city) {
    const districtSelect = document.getElementById('districtSelect');
    if (!districtSelect) return;
    
    districtSelect.innerHTML = '<option value="">不限</option>';
    
    if (!city || !locationOptions.districts[city]) {
        districtSelect.disabled = true;
        return;
    }
    
    districtSelect.disabled = false;
    locationOptions.districts[city].forEach(district => {
        const option = document.createElement('option');
        option.value = district;
        option.textContent = district;
        districtSelect.appendChild(option);
    });
}

// 設置地區模式處理器
function setupLocationModeHandlers() {
    const locationModeRadios = document.querySelectorAll('input[name="locationMode"]');
    const nearbyOptions = document.getElementById('nearbyOptions');
    const areaOptions = document.getElementById('areaOptions');
    const citySelect = document.getElementById('citySelect');
    const districtSelect = document.getElementById('districtSelect');
    const getLocationBtn = document.getElementById('getLocationBtn');
    const locationStatus = document.getElementById('locationStatus');
    
    locationModeRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            const mode = radio.value;
            
            if (nearbyOptions) nearbyOptions.style.display = 'none';
            if (areaOptions) areaOptions.style.display = 'none';
            
            if (mode === 'nearby' && nearbyOptions) {
                nearbyOptions.style.display = 'block';
                if (areaOptions) areaOptions.style.display = 'none';
                
                // 用戶選擇「附近餐廳」時，自動請求位置權限
                // 如果還沒有位置，自動獲取
                if (!userLocation && !locationRequestInProgress) {
                    getUserLocation();
                }
            } else if (mode === 'area' && areaOptions) {
                areaOptions.style.display = 'block';
                if (nearbyOptions) nearbyOptions.style.display = 'none';
            }
            
            if (mode !== 'nearby') {
                userLocation = null;
                if (getLocationBtn) {
                    setLocationBtnText('使用我的位置');
                    getLocationBtn.style.background = '';
                }
                if (locationStatus) {
                    locationStatus.style.display = 'none';
                }
                // 切離 nearby 模式時，重設交通方式為預設「不限」
                const transportRadios = document.querySelectorAll('input[name="transport"]');
                transportRadios.forEach(r => r.checked = (r.value === 'any'));
            }
            
            if (mode !== 'area') {
                if (citySelect) citySelect.value = '';
                if (districtSelect) {
                    districtSelect.value = '';
                    districtSelect.disabled = true;
                }
            }
        });
    });
    
    if (citySelect) {
        citySelect.addEventListener('change', (e) => {
            renderDistrictOptions(e.target.value);
        });
    }
}

// 渲染表單
function renderForm() {
    const cuisineContainer = document.getElementById('cuisineStyleOptions');
    if (cuisineContainer) {
        cuisineContainer.innerHTML = `
            <label class="radio-label">
                <input type="radio" name="cuisine_style" value="none" checked>
                <span>不限</span>
            </label>
            ${filterOptions.cuisine_style.map(cuisine => `
                <label class="radio-label">
                    <input type="radio" name="cuisine_style" value="${cuisine}">
                    <span>${cuisine}</span>
                </label>
            `).join('')}
        `;
    }

    const typeContainer = document.getElementById('restaurantTypeOptions');
    if (typeContainer) {
        typeContainer.innerHTML = `
            <label class="radio-label">
                <input type="radio" name="type" value="none" checked>
                <span>不限</span>
            </label>
            ${filterOptions.type.map(type => `
                <label class="radio-label">
                    <input type="radio" name="type" value="${type}">
                    <span>${type}</span>
                </label>
            `).join('')}
        `;
    }

    const budgetContainer = document.getElementById('budgetOptions');
    if (budgetContainer) {
        budgetContainer.innerHTML = `
            <label class="radio-label">
                <input type="radio" name="budget" value="all" checked>
                <span>不限</span>
            </label>
            ${filterOptions.budget.map(budget => {
                const hasSuffix = budget.includes('元') || budget.includes('以上') || budget.includes('以下');
                const displayText = hasSuffix ? budget : `${budget}元`;
                return `
                <label class="radio-label">
                    <input type="radio" name="budget" value="${budget}">
                    <span>${displayText}</span>
                </label>
            `;
            }).join('')}
        `;
    }
}

// 更新「更多設定」收合區的摘要文字
function setupAdvancedOptionsSummary() {
    const form = document.getElementById('recommendationForm');
    const hint = document.getElementById('advancedSummary');
    if (!form || !hint) return;

    const diningTimeLabels = { all: '不限時段', lunch: '午餐', dinner: '晚餐' };

    function update() {
        const cuisine = form.querySelector('input[name="cuisine_style"]:checked')?.value || 'none';
        const budget = form.querySelector('input[name="budget"]:checked')?.value || 'all';
        const dining = form.querySelector('input[name="diningTime"]:checked')?.value || 'all';

        const parts = [];
        parts.push(cuisine === 'none' ? '不限料理' : cuisine);
        parts.push(budget === 'all' ? '不限預算' : budget.replace(/\s+/g, ''));
        parts.push(diningTimeLabels[dining] || '不限時段');
        hint.textContent = parts.join(' · ');
    }

    form.addEventListener('change', (e) => {
        if (['cuisine_style', 'budget', 'diningTime'].includes(e.target?.name)) update();
    });
    update();
}

// 設置表單提交
function setupFormSubmit() {
    const form = document.getElementById('recommendationForm');
    const submitBtn = document.getElementById('submitBtn');
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    const error = document.getElementById('error');
    const errorMessage = document.getElementById('errorMessage');
    
    if (!form) return;
    
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        hideError();
        hideResults();
        
        const locationModeRadio = document.querySelector('input[name="locationMode"]:checked');
        if (!locationModeRadio) {
            showError('請選擇搜尋方式（附近餐廳或選擇地區）');
            return;
        }
        
        if (locationModeRadio.value === 'nearby') {
            const transportRadio = document.querySelector('input[name="transport"]:checked');
            if (!transportRadio) {
                showError('請選擇交通方式（走路或開車）');
                return;
            }
            if (!userLocation) {
                if (locationRequestInProgress) {
                    showError('正在獲取位置資訊，請稍候...');
                    showLocationStatus('正在獲取位置，請稍候', 'info');
                } else {
                    showError('無法取得位置資訊，請點擊「使用我的位置」重試，或改為「選擇地區」模式');
                    showLocationStatus('請獲取位置才能使用距離篩選', 'error');
                }
                return;
            }
        }
        
        if (locationModeRadio.value === 'area') {
            const citySelect = document.getElementById('citySelect');
            if (!citySelect || !citySelect.value) {
                showError('請選擇縣市');
                return;
            }
        }
        
        showLoading();
        if (submitBtn) submitBtn.disabled = true;

        try {
            const formData = collectFormData();
            console.log('表單資料:', formData);

            // 重置整個 session（新表單提交視為新一輪）
            displayedRestaurants = [];
            drawCount = 0;

            track('submit_draw', {
                cuisine_style: formData.cuisine_style || null,
                budget: formData.budget || null,
                diningTime: formData.diningTime || null,
                city: formData.city || null,
                district: formData.district || null,
                location_mode: formData.userLocation ? 'nearby' : 'area',
                transport: formData.transportMode || null,
            });

            // 擲骰動畫至少跑 1 秒（即使 API 更快回來）
            // 一次只抽 1 間，強化「抽獎」感
            const minDelay = new Promise(r => setTimeout(r, 500));
            const [restaurants] = await Promise.all([
                fetchRecommendations(formData, [], 1),
                minDelay,
            ]);
            console.log('API 返回的餐廳數量:', restaurants.length);

            drawCount = 1;
            displayedRestaurants = restaurants.map(r => r.name);
            displayResults(restaurants);

        } catch (err) {
            showError(err.message || '抽選失敗，請稍後再試');
            console.error('推薦餐廳錯誤:', err);
        } finally {
            hideLoading();
            if (submitBtn) submitBtn.disabled = false;
        }
    });
    
    function showError(message) {
        if (errorMessage) errorMessage.textContent = message;
        if (error) {
            error.style.display = 'block';
            error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
    
    function hideError() {
        if (error) error.style.display = 'none';
    }
    
    function showLoading() {
        if (loading) loading.style.display = 'block';
        document.body.classList.add('is-loading');
    }

    function hideLoading() {
        if (loading) loading.style.display = 'none';
        document.body.classList.remove('is-loading');
    }
    
    function hideResults() {
        if (results) results.style.display = 'none';
    }
}

// 收集表單資料
function collectFormData() {
    const form = document.getElementById('recommendationForm');
    const formData = {
        cuisine_style: [],
        type: [],
        budget: null,
        diningTime: 'all', // 預設為「不限」
        userLocation: null,
        transportMode: null,
        maxDistance: null,
        limit: 5
    };
    
    const cuisineRadio = form.querySelector('input[name="cuisine_style"]:checked');
    if (cuisineRadio && cuisineRadio.value !== 'none') {
        formData.cuisine_style.push(cuisineRadio.value);
    }
    
    const typeRadio = form.querySelector('input[name="type"]:checked');
    if (typeRadio && typeRadio.value !== 'none') {
        formData.type.push(typeRadio.value);
    }
    
    const budgetRadio = form.querySelector('input[name="budget"]:checked');
    if (budgetRadio && budgetRadio.value !== 'all') {
        formData.budget = budgetRadio.value;
    }
    
    const diningTimeRadio = form.querySelector('input[name="diningTime"]:checked');
    if (diningTimeRadio) {
        formData.diningTime = diningTimeRadio.value;
        console.log('收集到的 diningTime:', formData.diningTime, '選中的 radio value:', diningTimeRadio.value);
    } else {
        console.warn('未找到選中的 diningTime radio，使用預設值:', formData.diningTime);
    }
    
    const locationModeRadio = document.querySelector('input[name="locationMode"]:checked');
    if (!locationModeRadio) {
        throw new Error('請選擇搜尋方式（附近餐廳或選擇地區）');
    }
    
    const locationMode = locationModeRadio.value;
    
    if (locationMode === 'nearby') {
        const transportRadio = document.querySelector('input[name="transport"]:checked');
        if (!transportRadio) {
            throw new Error('請選擇交通方式（走路或開車）');
        }
        if (!userLocation) {
            throw new Error('請先點擊「使用我的位置」取得您的位置');
        }
        
        formData.userLocation = userLocation;
        formData.transportMode = transportRadio.value;
        
        if (transportRadio.value === 'walking') {
            formData.maxDistance = 0.5;
        } else if (transportRadio.value === 'driving') {
            formData.maxDistance = 3.0;
        } else {
            // 'any' / 不限：5km 同城附近（再大就脫離「附近」語意）
            formData.maxDistance = 5.0;
        }
    } else if (locationMode === 'area') {
        const citySelect = document.getElementById('citySelect');
        const city = citySelect ? citySelect.value : '';
        if (!city) {
            throw new Error('請選擇縣市');
        }
        
        formData.city = city;
        const districtSelect = document.getElementById('districtSelect');
        const district = districtSelect ? districtSelect.value : '';
        if (district) {
            formData.district = district;
        }
    }
    
    return formData;
}

// 建立單張餐廳卡 HTML
function buildCardHTML(restaurant, cardIndex, opts = {}) {
    const images = (restaurant.images || []).slice(0, 8);
    const hasImages = images.length > 0;
    const canSlide = images.length > 1;

    // 距離（nearby mode 才有 userLocation）
    let distance = null;
    if (userLocation && restaurant.coordinates?.lat && restaurant.coordinates?.lng) {
        distance = calculateDistance(
            userLocation.lat, userLocation.lng,
            restaurant.coordinates.lat, restaurant.coordinates.lng
        );
    }

    // 真實事實證據（取代之前情緒型 LLM slogan）
    const evidenceList = generateEvidence(restaurant, { distance });
    const evidenceHtml = evidenceList.length
        ? `<p class="restaurant-evidence">${evidenceList.join('・')}</p>`
        : '';

    // meta chips：營業狀態 + 訂位（新版 opening_hours 資料可信，重新開啟營業 chip）
    const metaParts = [];
    const oh = getOpeningStatus(restaurant.opening_hours);
    if (oh.label) {
        const cls = oh.status === 'open' ? 'is-open'
                  : oh.status === 'closing-soon' ? 'is-closing'
                  : 'is-closed';
        metaParts.push(`<span class="meta-chip ${cls}"><span class="meta-dot"></span>${oh.label}</span>`);
    }
    if (restaurant.bookable) {
        metaParts.push(`<span class="meta-chip is-accent">線上可訂位</span>`);
    }
    const metaHtml = metaParts.length ? `<div class="restaurant-meta">${metaParts.join('')}</div>` : '';

    const dishList = filterGeneralTags(restaurant.dish || []).slice(0, 4);
    const dishHtml = dishList.length
        ? `<p class="restaurant-dish"><span class="restaurant-dish__label">招牌</span>${dishList.join('、')}</p>`
        : '';

    const cuisineTags = filterGeneralTags(restaurant.cuisine_style || [])
        .map(c => `<span class="tag cuisine">${c}</span>`).join('');
    const typeTags = filterGeneralTags(restaurant.type || [])
        .map(t => `<span class="tag type">${t}</span>`).join('');
    const budgetTag = restaurant.budget
        ? `<span class="tag budget">${restaurant.budget} 元</span>`
        : '<span class="tag">預算未標示</span>';

    const bookingBtn = restaurant.url
        ? `<a href="${restaurant.url}" target="_blank" rel="noopener" class="restaurant-btn booking-btn">查看 / 訂位</a>`
        : '';
    const navBtn = restaurant.coordinates?.lat && restaurant.coordinates?.lng
        ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${restaurant.coordinates.lat},${restaurant.coordinates.lng}" target="_blank" rel="noopener" class="restaurant-btn navigation-btn">導航</a>`
        : restaurant.address
        ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(restaurant.address)}" target="_blank" rel="noopener" class="restaurant-btn navigation-btn">導航</a>`
        : '';

    // 暫存當前餐廳資料給分享按鈕用（單卡模式只有一張，安全）
    window.__currentRestaurant = restaurant;

    return `
        <button type="button" class="card-share" aria-label="分享給朋友">
            <svg aria-hidden="true"><use href="#icon-share"></use></svg>
        </button>
        ${hasImages ? `
            <div class="restaurant-image-container" data-card-index="${cardIndex}">
                <div class="image-carousel" data-carousel="${cardIndex}">
                    ${images.map((img, i) => `
                        <div class="carousel-slide ${i === 0 ? 'active' : ''}" data-slide="${i}">
                            <img src="${img}" alt="${restaurant.name}" class="carousel-image" onerror="this.style.display='none';">
                        </div>
                    `).join('')}
                </div>
                ${canSlide ? `
                    <div class="carousel-controls">
                        <button class="carousel-btn carousel-prev" data-carousel="${cardIndex}"><span>‹</span></button>
                        <button class="carousel-btn carousel-next" data-carousel="${cardIndex}"><span>›</span></button>
                    </div>
                    <div class="carousel-indicators" data-carousel="${cardIndex}">
                        ${images.map((_, i) => `<span class="indicator ${i === 0 ? 'active' : ''}" data-slide="${i}"></span>`).join('')}
                    </div>
                ` : ''}
            </div>
        ` : `
            <div class="restaurant-image-placeholder"><span>無照片</span></div>
        `}
        <div class="restaurant-info">
            ${evidenceHtml}
            <h3 class="restaurant-name">${restaurant.name}</h3>
            <p class="restaurant-address">${restaurant.address}</p>
            ${metaHtml}
            ${dishHtml}
            <div class="restaurant-tags">${cuisineTags}${typeTags}${budgetTag}</div>
            <div class="restaurant-actions">${bookingBtn}${navBtn}</div>
        </div>
    `;
}

// 分享當前抽到的餐廳給 LINE 好友 / 外部分享
async function shareRestaurant(restaurant) {
    const profile = getLiffProfile();
    const sharerName = profile?.displayName || '我';
    const altText = `${sharerName}抽到「${restaurant.name}」，一起去吃？`;
    const bookingUrl = restaurant.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(restaurant.name + ' ' + (restaurant.address || ''))}`;
    const heroImage = (restaurant.images || [])[0];

    // 1) LINE 內：用 Flex Message
    const liff = getLiff();
    if (liff && liff.isApiAvailable && liff.isApiAvailable('shareTargetPicker')) {
        const flex = buildShareFlex(restaurant, sharerName, bookingUrl, heroImage);
        try {
            const result = await liff.shareTargetPicker([{ type: 'flex', altText, contents: flex }]);
            if (result && result.status === 'success') {
                console.log('[share] 已分享');
            }
        } catch (err) {
            console.error('[share] LIFF share 失敗:', err);
        }
        return;
    }

    // 2) 外部：Web Share API
    const text = `${altText}\n${bookingUrl}`;
    if (navigator.share) {
        try {
            await navigator.share({ title: restaurant.name, text, url: bookingUrl });
        } catch (e) { /* 用戶取消，靜默 */ }
        return;
    }

    // 3) Fallback：複製連結
    try {
        await navigator.clipboard.writeText(`${altText}\n${bookingUrl}`);
        alert('已複製分享連結，可貼給朋友');
    } catch {
        prompt('複製這段分享給朋友：', `${altText}\n${bookingUrl}`);
    }
}

function buildShareFlex(restaurant, sharerName, bookingUrl, heroImage) {
    const bodyContents = [
        { type: 'text', text: `${sharerName}抽到的店`, size: 'xs', color: '#8B5A00', weight: 'bold' },
        { type: 'text', text: restaurant.name, size: 'xl', weight: 'bold', wrap: true, margin: 'sm' },
    ];
    if (restaurant.address) {
        bodyContents.push({ type: 'text', text: restaurant.address, size: 'sm', color: '#666666', wrap: true, margin: 'sm' });
    }
    const tags = [
        ...filterGeneralTags(restaurant.cuisine_style || []),
        ...filterGeneralTags(restaurant.type || []).slice(0, 2),
        restaurant.budget ? `${restaurant.budget} 元` : null,
    ].filter(Boolean).slice(0, 4);
    if (tags.length > 0) {
        bodyContents.push({
            type: 'text',
            text: tags.join('・'),
            size: 'xs', color: '#999999', wrap: true, margin: 'md',
        });
    }

    const bubble = {
        type: 'bubble',
        body: { type: 'box', layout: 'vertical', contents: bodyContents, paddingAll: 'lg' },
        footer: {
            type: 'box', layout: 'vertical', spacing: 'sm',
            contents: [
                { type: 'button', style: 'primary', color: '#FFCC00',
                  action: { type: 'uri', label: '查看 / 訂位', uri: bookingUrl } },
            ],
            paddingAll: 'lg',
        },
    };
    if (heroImage) {
        bubble.hero = { type: 'image', url: heroImage, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
    }
    return bubble;
}

// 顯示廣告（取代當次的抽店）— 支援 tip / sponsored 兩種類型
function displayAd(entry) {
    const resultCount = document.getElementById('resultCount');
    const restaurantList = document.getElementById('restaurantList');
    const results = document.getElementById('results');

    if (results) results.classList.add('is-ad');
    document.body.classList.add('is-ad-mode');
    if (resultCount) resultCount.textContent = '';

    if (!restaurantList) return;

    if (entry.kind === 'sponsored') {
        renderSponsoredAd(restaurantList, entry.data);
    } else {
        renderTipAd(restaurantList, entry.data);
    }

    if (results) {
        results.style.display = 'block';
        // 滾到卡片容器頂端（手動算位置，比 scrollIntoView 可靠）
        const list = document.getElementById('restaurantList');
        const target = list || results;
        requestAnimationFrame(() => {
            const top = target.getBoundingClientRect().top + window.scrollY - 24;
            window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        });
    }
}

function renderTipAd(container, ad) {
    const ctaHtml = ad.url
        ? `<a href="${ad.url}" target="_blank" rel="noopener" class="ad-card__cta">${ad.ctaText || '前往看看'}</a>`
        : '';
    container.innerHTML = `
        <div class="ad-card">
            <div class="ad-card__badge">OpenRice 小知識</div>
            <div class="ad-card__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><use href="#${ad.icon}"></use></svg>
            </div>
            <h3 class="ad-card__title">${ad.title}</h3>
            <p class="ad-card__body">${ad.body}</p>
            ${ctaHtml}
        </div>
    `;
    track('ad_shown', { kind: 'tip', ad_title: ad.title });
    const cta = container.querySelector('.ad-card__cta');
    if (cta) {
        cta.addEventListener('click', () => track('ad_cta_click', { kind: 'tip', ad_title: ad.title, url: ad.url }));
    }
}

function renderSponsoredAd(container, r) {
    const tags = filterGeneralTags(r.cuisine_style || []).slice(0, 2).map(c => `<span class="tag cuisine">${c}</span>`).join('');
    const ratingHtml = (typeof r.rating === 'number' && r.rating > 0)
        ? `<span class="ad-sponsored__rating">OpenRice ${r.rating.toFixed(1)} 星</span>`
        : '';
    const reviewHtml = r.review_count ? `<span class="ad-sponsored__reviews">${r.review_count} 篇食記</span>` : '';
    const budgetHtml = r.budget ? `<span class="ad-sponsored__budget">人均 ${r.budget}</span>` : '';
    container.innerHTML = `
        <div class="ad-card ad-card--sponsored">
            <div class="ad-card__badge ad-card__badge--sponsored">合作店家</div>
            ${r.image ? `<div class="ad-sponsored__image"><img src="${r.image}" alt="${r.name}" onerror="this.style.display='none'"></div>` : ''}
            <h3 class="ad-card__title">${r.name}</h3>
            ${r.address ? `<p class="ad-sponsored__address">${r.address}</p>` : ''}
            <div class="ad-sponsored__meta">${ratingHtml}${reviewHtml}${budgetHtml}</div>
            ${tags ? `<div class="restaurant-tags ad-sponsored__tags">${tags}</div>` : ''}
            ${r.url ? `<a href="${r.url}" target="_blank" rel="noopener" class="ad-card__cta">查看 / 訂位</a>` : ''}
        </div>
    `;
    track('ad_shown', { kind: 'sponsored', or_id: r.or_id, name: r.name });
    const cta = container.querySelector('.ad-card__cta');
    if (cta) {
        cta.addEventListener('click', () => track('ad_cta_click', { kind: 'sponsored', or_id: r.or_id, name: r.name }));
    }
}

// 顯示結果（一次只 1 間）
function displayResults(restaurants) {
    const resultCount = document.getElementById('resultCount');
    const restaurantList = document.getElementById('restaurantList');
    const results = document.getElementById('results');

    // 取消廣告模式（廣告完還原成餐廳模式）
    if (results) results.classList.remove('is-ad');
    document.body.classList.remove('is-ad-mode');

    console.log('displayResults 被調用，餐廳數量:', restaurants.length);

    if (restaurants.length === 0) {
        showError('沒抽到符合條件的餐廳，要不要放寬條件再抽一次？');
        return;
    }

    // 計數：本回合已看過 N 家（含當前這家）
    const seenCount = displayedRestaurants.length;
    if (resultCount) {
        resultCount.textContent = seenCount > 1 ? `已抽 ${seenCount} 家` : '';
    }

    if (restaurantList) {
        const r = restaurants[0];
        restaurantList.innerHTML = `<div class="restaurant-card">${buildCardHTML(r, 0)}</div>`;
        track('result_shown', {
            or_id: r.or_id, name: r.name, draw_count: displayedRestaurants.length,
        });
        // 綁定分享按鈕
        const shareBtn = restaurantList.querySelector('.card-share');
        if (shareBtn) {
            shareBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.__currentRestaurant) {
                    track('share_click', {
                        or_id: window.__currentRestaurant.or_id,
                        name: window.__currentRestaurant.name,
                    });
                    shareRestaurant(window.__currentRestaurant);
                }
            });
        }
        // 餐廳卡上 a 連結（查看 / 訂位、導航）的點擊也追蹤
        restaurantList.querySelectorAll('.booking-btn').forEach(el => {
            el.addEventListener('click', () => {
                track('restaurant_click', {
                    or_id: r.or_id, name: r.name, url: r.url,
                    draw_count: displayedRestaurants.length,
                });
            });
        });
        restaurantList.querySelectorAll('.navigation-btn').forEach(el => {
            el.addEventListener('click', () => {
                track('navigation_click', { or_id: r.or_id, name: r.name });
            });
        });
    }

    initImageCarousels();

    if (results) {
        results.style.display = 'block';
        // 滾到卡片容器頂端（手動算位置，比 scrollIntoView 可靠）
        const list = document.getElementById('restaurantList');
        const target = list || results;
        requestAnimationFrame(() => {
            const top = target.getBoundingClientRect().top + window.scrollY - 24;
            window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        });
    }
}

// 為每張卡的「換這張」按鈕綁定 handler
function setupCardRefreshButtons(currentList) {
    document.querySelectorAll('.card-refresh').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const idx = parseInt(btn.dataset.cardIndex, 10);
            if (isNaN(idx)) return;
            await refreshSingleCard(idx, currentList);
        });
    });
}

// 重新抽取單張卡片
async function refreshSingleCard(cardIndex, currentList) {
    const cards = document.querySelectorAll('.restaurant-card');
    const card = cards[cardIndex];
    if (!card) return;

    // 防止連點
    if (card.classList.contains('is-refreshing')) return;
    card.classList.add('is-refreshing');

    try {
        const formData = collectFormData();
        // exclude 用當前 list 全部 + displayedRestaurants（避免抽到已顯示過的）
        const excludeSet = new Set([
            ...currentList.map(r => r.name),
            ...displayedRestaurants,
        ]);
        const newResults = await fetchRecommendations(formData, Array.from(excludeSet), 1);

        if (!newResults || newResults.length === 0) {
            card.classList.remove('is-refreshing');
            showError('沒有更多符合條件的餐廳可換了，試試放寬條件');
            return;
        }

        const newRestaurant = newResults[0];
        // 更新列表與已顯示名單
        currentList[cardIndex] = newRestaurant;
        displayedRestaurants.push(newRestaurant.name);

        // 替換卡片內容（保留 .restaurant-card 外殼以維持動畫上下文）
        // 把其他 4 張卡的籤詩當 exclude，避免新卡撞句
        const siblingOmikujis = new Set(
            Array.from(document.querySelectorAll('.restaurant-omikuji'))
                .filter(e => !card.contains(e))
                .map(e => e.textContent.replace(/[「」]/g, '').trim())
        );
        card.innerHTML = buildCardHTML(newRestaurant, cardIndex, { usedOmikujis: siblingOmikujis });
        card.classList.remove('is-refreshing');
        card.classList.add('is-new');
        setTimeout(() => card.classList.remove('is-new'), 600);

        // 重新初始化該張卡的輪播 / 換卡按鈕
        initImageCarousels();
        setupCardRefreshButtons(currentList);
    } catch (err) {
        card.classList.remove('is-refreshing');
        console.error('重抽單張失敗:', err);
        showError(err.message || '重抽失敗，請稍後再試');
    }
}

function showError(message) {
    const errorMessage = document.getElementById('errorMessage');
    const error = document.getElementById('error');
    if (errorMessage) errorMessage.textContent = message;
    if (error) {
        error.style.display = 'block';
        error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// 設置重新選擇按鈕
function setupResetButton() {
    const resetBtn = document.getElementById('resetBtn');
    const loading = document.getElementById('loading');
    const submitBtn = document.getElementById('submitBtn');
    
    if (!resetBtn) return;
    
    resetBtn.addEventListener('click', async () => {
        if (displayedRestaurants.length === 0) return;
        
        hideError();
        showLoading();
        resetBtn.disabled = true;
        
        try {
            track('redraw', { current_draw_count: drawCount });

            // 每抽 AD_EVERY 次插入一個 OpenRice 小知識廣告
            // drawCount 是「上一次完成的抽次數」，這次按下去 +1 後若整除 → 廣告
            const nextDrawNumber = drawCount + 1;
            const showAd = nextDrawNumber % AD_EVERY === 0;

            const minDelay = new Promise(r => setTimeout(r, 500));

            if (showAd) {
                // 廣告不打 API，但保留擲骰動畫節奏一致
                await minDelay;
                const ad = pickNextAd();
                drawCount = nextDrawNumber;
                displayAd(ad);
            } else {
                const formData = collectFormData();
                const [restaurants] = await Promise.all([
                    fetchRecommendations(formData, displayedRestaurants, 1),
                    minDelay,
                ]);

                if (restaurants.length === 0) {
                    showError('沒抽到符合條件的餐廳，要不要放寬條件再抽一次？');
                    return;
                }

                drawCount = nextDrawNumber;
                displayedRestaurants.push(...restaurants.map(r => r.name));
                displayResults(restaurants);
            }
            
        } catch (err) {
            showError(err.message || '抽選失敗，請稍後再試');
            console.error('推薦餐廳錯誤:', err);
        } finally {
            hideLoading();
            resetBtn.disabled = false;
        }
    });
    
    function hideError() {
        const error = document.getElementById('error');
        if (error) error.style.display = 'none';
    }
    
    function showLoading() {
        const loading = document.getElementById('loading');
        if (loading) loading.style.display = 'block';
        document.body.classList.add('is-loading');
    }

    function hideLoading() {
        const loading = document.getElementById('loading');
        if (loading) loading.style.display = 'none';
        document.body.classList.remove('is-loading');
    }
}

// 獲取用戶位置
function getUserLocation() {
    if (locationRequestInProgress) return;
    
    if (!navigator.geolocation) {
        showLocationStatus('您的瀏覽器不支援地理位置功能', 'error');
        return;
    }
    
    locationRequestInProgress = true;
    const getLocationBtn = document.getElementById('getLocationBtn');
    
    if (getLocationBtn) {
        getLocationBtn.disabled = true;
        setLocationBtnText('定位中…');
    }
    showLocationStatus('正在獲取您的位置...', 'loading');
    
    const options = {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000
    };
    
    navigator.geolocation.getCurrentPosition(
        (position) => {
            locationRequestInProgress = false;
            userLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude
            };
            if (getLocationBtn) {
                getLocationBtn.disabled = false;
                setLocationBtnText('已取得位置');
                getLocationBtn.classList.add('is-success');
            }
            showLocationStatus(`已獲取位置`, 'success');
            console.log('位置獲取成功:', userLocation);
        },
        (error) => {
            locationRequestInProgress = false;
            
            if (getLocationBtn) {
                getLocationBtn.disabled = false;
                setLocationBtnText('使用我的位置');
                getLocationBtn.classList.remove('is-success');
            }

            // 友好的錯誤提示（簡短、明確、提供解決方案）
            let errorMsg = '';
            switch(error.code) {
                case error.PERMISSION_DENIED:
                    errorMsg = '需要位置權限才能使用「附近餐廳」功能。請允許位置權限，或選擇「選擇地區」模式';
                    break;
                case error.POSITION_UNAVAILABLE:
                    errorMsg = '無法取得位置資訊。請確認定位服務已開啟，或選擇「選擇地區」模式';
                    break;
                case error.TIMEOUT:
                    errorMsg = '定位請求逾時。請重試或選擇「選擇地區」模式';
                    break;
                default:
                    errorMsg = '無法取得位置。請選擇「選擇地區」模式，或點擊「使用我的位置」重試';
                    break;
            }
            
            // 顯示錯誤提示（但不要讓用戶覺得系統不穩定）
            showLocationStatus(errorMsg, 'error');
            
            // 如果獲取位置失敗，建議用戶切換到「選擇地區」模式
            // 但不強制，讓用戶自己決定
        },
        options
    );
}

// 自動獲取用戶位置（已停用）
// 為了避免間歇性的地理位置錯誤影響用戶體驗，已移除自動獲取功能
// 用戶需要主動點擊「使用我的位置」按鈕才會獲取位置
function autoGetUserLocation() {
    // 已停用自動獲取，避免間歇性錯誤
    // 用戶可以主動選擇「附近餐廳」模式並點擊「使用我的位置」按鈕
    return;
}

// 設置位置按鈕事件
function setupLocationButton() {
    const getLocationBtn = document.getElementById('getLocationBtn');
    if (getLocationBtn) {
        getLocationBtn.addEventListener('click', getUserLocation);
    }
}

// 初始化位置按鈕（需要在頁面載入後調用）
setupLocationButton();

function showLocationStatus(message, type) {
    const locationStatus = document.getElementById('locationStatus');
    if (!locationStatus) return;
    locationStatus.textContent = message;
    locationStatus.style.display = 'block';
    locationStatus.className = `location-status ${type}`;
    
    if (type === 'success') {
        setTimeout(() => {
            locationStatus.style.display = 'none';
        }, 5000);
    }
}

