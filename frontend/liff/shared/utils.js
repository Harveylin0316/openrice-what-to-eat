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
    return { status: 'closed-today', label: '今日已打烊', openNow: false };
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
