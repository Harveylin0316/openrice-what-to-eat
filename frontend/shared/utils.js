/**
 * 計算兩點之間的距離（公里）
 * @param {number} lat1 - 起點緯度
 * @param {number} lng1 - 起點經度
 * @param {number} lat2 - 終點緯度
 * @param {number} lng2 - 終點經度
 * @returns {number} 距離（公里）
 */
export function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // 地球半徑（公里）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * 格式化距離顯示
 * @param {number} distance - 距離（公里）
 * @returns {string} 格式化後的距離字符串
 */
export function formatDistance(distance) {
    if (distance < 1) {
        return `${Math.round(distance * 1000)} 公尺`;
    }
    return `${distance.toFixed(1)} 公里`;
}

/**
 * 過濾餐廳標籤（移除「一般」標籤）
 * @param {Array<string>} tags - 標籤列表
 * @returns {Array<string>} 過濾後的標籤列表
 */
export function filterGeneralTags(tags) {
    return (tags || []).filter(tag => tag !== '一般');
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseTimeToMinutes(str) {
    // 接受 "11:30" / "17:00" 等；跨日的 "26:00" 解為 02:00 隔日
    const m = str?.trim().match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    return h * 60 + min;
}

/**
 * 判斷餐廳當前營業狀態
 * @param {Object} openingHours - 七天的營業時間 map (monday..sunday)，每個 value 是 ["11:30-14:00", "17:00-22:00"]
 * @param {Date} now - 當前時間（測試用，預設為現在）
 * @returns {Object} { status: 'open' | 'closing-soon' | 'closed-today' | 'opens-later' | 'unknown',
 *                     label: '營業中 · 22:00 打烊' / '17:30 開始' / '今日休息',
 *                     openNow: bool }
 */
export function getOpeningStatus(openingHours, now = new Date()) {
    if (!openingHours || typeof openingHours !== 'object') {
        return { status: 'unknown', label: '', openNow: false };
    }
    const todayKey = DAY_KEYS[now.getDay()];
    const todaySlots = openingHours[todayKey];
    if (!Array.isArray(todaySlots) || todaySlots.length === 0) {
        return { status: 'closed-today', label: '今日休息', openNow: false };
    }

    const nowMin = now.getHours() * 60 + now.getMinutes();
    let nextOpen = null;
    let currentClose = null;

    for (const slot of todaySlots) {
        const [openStr, closeStr] = (slot || '').split('-');
        const open = parseTimeToMinutes(openStr);
        let close = parseTimeToMinutes(closeStr);
        if (open == null || close == null) continue;
        // 跨日：close <= open 表示跨日，補 +24h
        if (close <= open) close += 24 * 60;

        if (nowMin >= open && nowMin < close) {
            currentClose = close;
            break;
        } else if (nowMin < open) {
            if (nextOpen == null || open < nextOpen) nextOpen = open;
        }
    }

    if (currentClose != null) {
        const closeH = Math.floor(currentClose / 60) % 24;
        const closeM = currentClose % 60;
        const closeStr = `${String(closeH).padStart(2, '0')}:${String(closeM).padStart(2, '0')}`;
        // 30 分鐘內打烊 → closing-soon
        if (currentClose - nowMin <= 30) {
            return { status: 'closing-soon', label: `${closeStr} 打烊`, openNow: true };
        }
        return { status: 'open', label: `營業中 · ${closeStr} 打烊`, openNow: true };
    }
    if (nextOpen != null) {
        const h = Math.floor(nextOpen / 60);
        const m = nextOpen % 60;
        return {
            status: 'opens-later',
            label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} 開始`,
            openNow: false,
        };
    }
    // 過了今天所有營業時段：可能是真的打烊，也可能是 OpenRice 資料只給了部分時段。
    // 為避免誤導，顯示營業時段列表讓使用者自己判斷，而不是絕對地說「已打烊」。
    const formattedSlots = todaySlots
        .map(s => {
            const [o, c] = (s || '').split('-').map(x => x?.trim());
            return o && c ? `${o}-${c}` : null;
        })
        .filter(Boolean);
    if (formattedSlots.length > 0) {
        return {
            status: 'closed-today',
            label: `今日 ${formattedSlots.join('、')}`,
            openNow: false,
        };
    }
    return { status: 'closed-today', label: '今日已打烊', openNow: false };
}

/**
 * 為餐廳產生一句呼應「隨機抽到」的籤詩短語
 * 規則式：依料理 / 類型 / 預算 / 招牌菜 / 時段 / 訂位 拼出最合適的一句
 * @param {Object} restaurant - 餐廳物件
 * @param {Object} context - { diningTime, openNow }
 * @returns {string} 短語
 */
export function generateOmikuji(restaurant, context = {}) {
    const cuisines = restaurant.cuisine_style || [];
    const types = restaurant.type || [];
    const bookable = restaurant.bookable;
    const budget = restaurant.budget || '';
    const { diningTime, exclude } = context;
    const excludeSet = exclude instanceof Set ? exclude : new Set(exclude || []);

    const has = (arr, ...needles) => needles.some(n => arr.some(x => x && x.includes(n)));

    const pool = [];

    // 料理 / 類型導向（每組多個變體，避免 5 張卡都同一句）
    if (has(types, '燒肉', '烤肉') || has(cuisines, '燒肉')) {
        pool.push('肉食控的命運抽選', '今天就是想吃肉', '碳烤香氣等你', '一份油花替今天打氣', '無肉不歡的選擇');
    }
    if (has(types, '火鍋', '鍋物') || has(cuisines, '火鍋')) {
        pool.push('一鍋熱湯解決今天', '抽到鍋物的命運', '湯頭一喝就懂', '今晚就涮一波', '熱呼呼填飽自己');
    }
    if (has(types, '居酒屋', '餐酒', '酒吧', 'Lounge', 'Bar')) {
        if (diningTime !== 'lunch') {
            pool.push('下班想喝兩杯就這家', '小酌一下吧', '抽到微醺的命運', '夜晚的避風港', '一杯放鬆模式啟動', '今天容許自己晚點回家');
        }
    }
    if (has(types, '咖啡', 'Cafe', '甜點')) {
        pool.push('來點甜的解壓', '咖啡因補給站', '甜點救援啟動', '坐下來緩一緩', '今天值得一杯好的', '下午茶就這家');
    }
    if (has(cuisines, '日式', '日本')) {
        pool.push('精緻日式給今天加分', '一份和食的療癒', '抽到島國味道', '今晚走日式路線');
    }
    if (has(cuisines, '韓式', '韓國')) {
        pool.push('來點韓國風味', '辛香解膩的選擇', '抽到泡菜的命運', '今晚走韓系路線');
    }
    if (has(cuisines, '泰式', '東南亞')) {
        pool.push('辛香料的命運安排', '酸辣補一波', '南洋風情等你', '今天就是要吃辛香');
    }
    if (has(cuisines, '義式', '義大利', 'Italian')) {
        pool.push('來盤義式經典', '今天吃 Pasta 的日子', '抽到地中海風', '義式輕鬆系');
    }
    if (has(cuisines, '美式', 'American')) {
        pool.push('來點美式份量', '吃飽吃滿的命運', '今天就是要爽吃');
    }
    if (has(cuisines, '港式', '廣東', '粵', 'Hong Kong')) {
        pool.push('港式風味在這家', '抽到港點的命運', '今天走港式路線');
    }
    if (has(cuisines, '中式', '中華', '川菜', '湘菜')) {
        pool.push('家常滋味來這家', '抽到媽媽味', '中式飯香的命運');
    }
    if (has(types, '吃到飽', '放題', 'Buffet')) {
        pool.push('放開吃就對了', '熱量帳明天再算', '今天就是要吃飽飽');
    }
    if (has(types, '牛排', 'Steak')) {
        pool.push('想吃牛排就這家', '一份肋眼壓壓驚');
    }
    if (has(types, '鐵板燒')) {
        pool.push('來看師傅現場露一手', '鐵板火光的命運');
    }

    // 預算導向
    if (/200/.test(budget) && !/500/.test(budget)) {
        pool.push('銅板價的好選擇', '荷包友善區', '便宜又能吃到');
    } else if (/1500|1000-1500/.test(budget)) {
        pool.push('值得犒賞自己一頓', '今天就吃高一階', '抽到輕奢等級');
    }

    // 訂位
    if (bookable) pool.push('記得先訂位');

    // 兜底（避免空陣列 / 過度同質）
    if (pool.length === 0) {
        pool.push('命運就是這家了', '機率讓你來這', '不選白不選', '就試試看吧',
                  '抽到就是緣分', '相信骰子', '隨機推你一把');
    }

    // 本批已用的句子先排除（避免 5 張卡撞句）
    const filtered = pool.filter(p => !excludeSet.has(p));
    const finalPool = filtered.length > 0 ? filtered : pool;
    return finalPool[Math.floor(Math.random() * finalPool.length)];
}

/**
 * 初始化照片輪播功能
 */
export function initImageCarousels() {
    const carousels = document.querySelectorAll('.image-carousel');
    
    carousels.forEach(carousel => {
        const carouselId = carousel.getAttribute('data-carousel');
        const slides = carousel.querySelectorAll('.carousel-slide');
        const prevBtn = document.querySelector(`.carousel-prev[data-carousel="${carouselId}"]`);
        const nextBtn = document.querySelector(`.carousel-next[data-carousel="${carouselId}"]`);
        const indicators = document.querySelectorAll(`.carousel-indicators[data-carousel="${carouselId}"] .indicator`);
        
        if (slides.length === 0) return;
        
        let currentSlide = 0;
        const totalSlides = slides.length;
        
        function showSlide(index) {
            if (index < 0) {
                currentSlide = 0;
                return;
            } else if (index >= totalSlides) {
                currentSlide = totalSlides - 1;
                return;
            } else {
                currentSlide = index;
            }
            
            slides.forEach((slide, i) => {
                slide.classList.toggle('active', i === currentSlide);
            });
            
            indicators.forEach((indicator, i) => {
                indicator.classList.toggle('active', i === currentSlide);
            });
            
            if (prevBtn) {
                prevBtn.style.opacity = currentSlide === 0 ? '0.5' : '1';
                prevBtn.style.pointerEvents = currentSlide === 0 ? 'none' : 'all';
            }
            if (nextBtn) {
                nextBtn.style.opacity = currentSlide === totalSlides - 1 ? '0.5' : '1';
                nextBtn.style.pointerEvents = currentSlide === totalSlides - 1 ? 'none' : 'all';
            }
        }
        
        if (prevBtn) {
            prevBtn.addEventListener('click', () => showSlide(currentSlide - 1));
        }
        
        if (nextBtn) {
            nextBtn.addEventListener('click', () => showSlide(currentSlide + 1));
        }
        
        indicators.forEach((indicator, index) => {
            indicator.addEventListener('click', () => showSlide(index));
        });
        
        if (prevBtn && totalSlides > 1) {
            prevBtn.style.opacity = '0.5';
            prevBtn.style.pointerEvents = 'none';
        }
        
        // 觸摸滑動支持
        let touchStartX = 0;
        let touchEndX = 0;
        
        carousel.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });
        
        carousel.addEventListener('touchend', (e) => {
            touchEndX = e.changedTouches[0].screenX;
            const diff = touchStartX - touchEndX;
            const swipeThreshold = 50;
            
            if (Math.abs(diff) > swipeThreshold) {
                if (diff > 0 && currentSlide < totalSlides - 1) {
                    showSlide(currentSlide + 1);
                } else if (diff < 0 && currentSlide > 0) {
                    showSlide(currentSlide - 1);
                }
            }
        }, { passive: true });
    });
}
