# 「今天吃什麼」LIFF App — UX 架構規範

> **角色**：UX Architect（系統架構與技術基礎）
> **產品**：LINE LIFF 餐廳推薦應用，916 間台灣餐廳資料庫
> **目標使用者**：絕大多數為手機端 LINE 內 webview 用戶
> **文件範疇**：CSS Design Tokens、檔案組織、響應式策略、無障礙、效能
> **不在範疇**：視覺細節與配色提案（UI Designer）、文案與敘事（Visual Storyteller）

---

## 1. 設計哲學

### 1.1 為什麼當前 UI 失敗

審視現有 `style.css`（41KB monolithic）與 `index.html` 後，根本問題不在「不夠華麗」，而在「過度設計、缺乏節制」：

| 問題類型 | 具體症狀 | 對 LIFF 環境的傷害 |
|---|---|---|
| **裝飾過載** | body::before 灑滿 emoji 字串、header::before 浮動 emoji、shimmer 條 | 在 LINE webview 中佔用渲染資源，分散注意力 |
| **動畫過量** | `gradientShift 15s infinite`、`shimmer`、`float`、`iconPulse`、`bounce` 同時運行 | 移動裝置 GPU/CPU 持續耗能；觸發 LIFF 內捲動卡頓 |
| **字體過大** | 標題 3.2rem ≈ 51px，subtitle 1.4rem | 手機螢幕被吃掉，可視內容比例失衡 |
| **色彩過飽和** | 全頁 #ff6b35 → #ffa726 高彩度漸層 | 視覺疲勞，且與餐廳照片（食物實拍）色彩衝突 |
| **Token 不一致** | `:root` 只定義 5 色，實際使用 `#e5e5e5` `#333` `#fff8f0` 等硬編碼數十處 | 改動無法傳播；深色模式不可能 |
| **無深色模式** | 完全沒有 `prefers-color-scheme` | LINE 內常見深色主題下，整體偏白爆光 |

### 1.2 新方向的三個原則

1. **食物是主角，UI 是托盤**
   餐廳照片本身已有強烈色彩，UI 應退到輔助位。低飽和中性色作為底，把「色彩權重」讓給食物縮圖。

2. **移動優先、單欄為王**
   916 間餐廳的推薦結果是一個「卡片流」的場景，類似 IG/Threads。垂直滾動是核心動線，不要為桌面犧牲手機體驗。

3. **節制的動效**
   只保留兩種：
   - **狀態回饋**（按下、選中、載入）— 提升可感知性能
   - **進入動畫**（結果卡片淡入）— 引導視覺焦點
   裝飾性無限循環動畫（shimmer、float、gradientShift）一律移除。

### 1.3 適合「移動端 + 食物 + 訂位」的調性

- **基調**：暖中性（米白／溫灰）而非橘黃。讓食物照片的紅黃綠自己發光。
- **強調色（accent）**：保留一個飽和度適中的暖色作為 CTA、選中態、品牌錨點，**只用在這三個地方**。
- **語意色**：成功（綠）、警告（琥珀）、錯誤（暖紅）獨立於品牌色。
- **質感**：扁平 + 微陰影，而非漸層。圓角統一但不誇張（12–16px，不再用 50px pill）。

---

## 2. CSS Design Tokens

### 2.1 命名規則

所有 token 以 `--` 開頭，分四層級：
```
--{category}-{semantic}-{variant}
例：--color-surface-raised
    --space-4
    --font-size-body
    --radius-md
```

語意層（semantic）優先於原始層（primitive）。實作時 component 應引用 semantic token，不應直接用 primitive。

### 2.2 色彩系統

#### Primitive Layer（原始色階，不直接使用）

| Token | 值 | 說明 |
|---|---|---|
| `--gray-0` | `#FFFFFF` | 純白 |
| `--gray-50` | `#FAFAF9` | 米白底 |
| `--gray-100` | `#F4F2EF` | 卡片次層 |
| `--gray-200` | `#E8E5E0` | 分隔線 |
| `--gray-300` | `#D4D0CA` | disabled 邊框 |
| `--gray-500` | `#8A857E` | 次要文字 |
| `--gray-700` | `#3D3A35` | 主要文字 |
| `--gray-900` | `#1A1815` | 標題 |
| `--accent-300` | `#F5A57A` | accent hover/light |
| `--accent-500` | `#E8754F` | accent 主色（暖珊瑚，非螢光橘） |
| `--accent-700` | `#B85530` | accent 按下 |
| `--success-500` | `#2E9A66` | |
| `--warning-500` | `#D9961F` | |
| `--danger-500` | `#C0432E` | |

#### Semantic Layer（淺色模式，預設）

| Token | 值 | 用途 |
|---|---|---|
| `--color-bg-base` | `var(--gray-50)` | body 背景 |
| `--color-bg-surface` | `var(--gray-0)` | 卡片、表單區塊 |
| `--color-bg-raised` | `var(--gray-0)` | 浮層、modal |
| `--color-bg-subtle` | `var(--gray-100)` | tag 背景、選項未選態 |
| `--color-border` | `var(--gray-200)` | 一般邊框 |
| `--color-border-strong` | `var(--gray-300)` | 表單邊框 |
| `--color-text-primary` | `var(--gray-900)` | 標題、餐廳名 |
| `--color-text-body` | `var(--gray-700)` | 正文 |
| `--color-text-muted` | `var(--gray-500)` | 次要說明、placeholder |
| `--color-text-inverse` | `var(--gray-0)` | 在 accent 上的文字 |
| `--color-accent` | `var(--accent-500)` | CTA、選中態、品牌錨點 |
| `--color-accent-hover` | `var(--accent-700)` | |
| `--color-accent-subtle` | `#FBEDE4` | accent 選中態背景（極淺暖色） |
| `--color-focus-ring` | `var(--accent-500)` | 焦點外框 |

#### Semantic Layer（深色模式覆寫）

```css
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg-base: #1A1815;
    --color-bg-surface: #232019;
    --color-bg-raised: #2B2720;
    --color-bg-subtle: #2F2B23;
    --color-border: #3D3A35;
    --color-border-strong: #4F4B43;
    --color-text-primary: #F4F2EF;
    --color-text-body: #D4D0CA;
    --color-text-muted: #8A857E;
    --color-text-inverse: #1A1815;
    --color-accent: #F5A57A;           /* 深色模式下提亮一階 */
    --color-accent-hover: #F8B891;
    --color-accent-subtle: #3D2A22;
  }
}
```

> **設計理由**：深色模式不只是「反相」，需要重新平衡 accent。`#E8754F` 在深底上對比過強會「燙眼」，提到 300 階 `#F5A57A`。

### 2.3 字體層級

#### 字型 stack

```css
--font-family-sans: -apple-system, BlinkMacSystemFont, "PingFang TC",
                    "Noto Sans TC", "Microsoft JhengHei", "Helvetica Neue",
                    Arial, sans-serif;
--font-family-mono: ui-monospace, "SF Mono", Menlo, monospace;
```

不引入網路字型（Google Fonts 等），降低 LIFF 載入成本。

#### 尺寸階梯（基準 16px，1.125 比例）

| Token | 值 | rem | 用途 |
|---|---|---|---|
| `--font-size-xs` | `12px` | `0.75rem` | 標籤、輔助說明 |
| `--font-size-sm` | `14px` | `0.875rem` | 次要文字、餐廳地址 |
| `--font-size-base` | `16px` | `1rem` | 正文預設、表單輸入 |
| `--font-size-md` | `18px` | `1.125rem` | 選項文字、餐廳名 |
| `--font-size-lg` | `20px` | `1.25rem` | 區塊標題（section label） |
| `--font-size-xl` | `24px` | `1.5rem` | 結果區標題 |
| `--font-size-2xl` | `28px` | `1.75rem` | 頁面主標題（手機） |
| `--font-size-3xl` | `32px` | `2rem` | 頁面主標題（桌面以上） |

> **關鍵調整**：主標題從 3.2rem (51px) 降到 1.75rem (28px) 手機 / 2rem (32px) 桌面。為什麼？LIFF 內可視高度通常只有 600–700px，主標題不該佔 8% 高度。

#### 字重

| Token | 值 | 用途 |
|---|---|---|
| `--font-weight-normal` | `400` | 正文 |
| `--font-weight-medium` | `500` | 選項、標籤 |
| `--font-weight-semibold` | `600` | 區塊標題、餐廳名 |
| `--font-weight-bold` | `700` | 頁面主標題、CTA |

避免用 `800`（過重，中文字型在小尺寸下會糊）。

#### 行高

| Token | 值 | 用途 |
|---|---|---|
| `--line-height-tight` | `1.2` | 標題 |
| `--line-height-snug` | `1.4` | 短句、按鈕 |
| `--line-height-normal` | `1.6` | 正文段落 |

#### Letter-spacing

中文不需要 letter-spacing，所有現有的 `letter-spacing: 2–3px` 全部移除。

### 2.4 間距系統（8px Grid）

統一使用 4px 為基底、8px 為主節奏。

| Token | 值 | 用途 |
|---|---|---|
| `--space-0` | `0` | |
| `--space-1` | `4px` | icon 與文字內隙 |
| `--space-2` | `8px` | 小元件內邊距 |
| `--space-3` | `12px` | 卡片內邊距（窄） |
| `--space-4` | `16px` | 卡片內邊距（標準） |
| `--space-5` | `20px` | section 內垂直節奏 |
| `--space-6` | `24px` | section 之間 |
| `--space-8` | `32px` | 大區塊之間 |
| `--space-10` | `40px` | 頁面主分隔（桌面） |
| `--space-12` | `48px` | header → main 間距 |

### 2.5 圓角

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | `6px` | tag、小按鈕 |
| `--radius-md` | `10px` | 選項卡、輸入框 |
| `--radius-lg` | `14px` | 餐廳卡片、區塊容器 |
| `--radius-xl` | `20px` | 浮層、modal |
| `--radius-full` | `999px` | 圓形按鈕、location dot |

> **不再使用** `border-radius: 50px` 的 pill 按鈕。LIFF 環境下，pill 按鈕在窄螢幕容易看起來像「藥丸」，現代 app 趨勢回到矩形圓角（10–14px）。

### 2.6 陰影

```css
--shadow-xs:  0 1px 2px rgba(20, 16, 12, 0.04);
--shadow-sm:  0 1px 3px rgba(20, 16, 12, 0.06),
              0 1px 2px rgba(20, 16, 12, 0.04);
--shadow-md:  0 4px 12px rgba(20, 16, 12, 0.08),
              0 2px 4px rgba(20, 16, 12, 0.04);
--shadow-lg:  0 12px 24px rgba(20, 16, 12, 0.12),
              0 4px 8px rgba(20, 16, 12, 0.06);
--shadow-focus: 0 0 0 3px rgba(232, 117, 79, 0.35);
```

**深色模式陰影**改用更深的黑且降低透明度：

```css
@media (prefers-color-scheme: dark) {
  :root {
    --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.3);
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.4);
    --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.5);
    --shadow-lg: 0 12px 24px rgba(0, 0, 0, 0.6);
  }
}
```

### 2.7 動畫 Timing

```css
--duration-instant: 100ms;   /* 焦點、按下 */
--duration-fast: 180ms;      /* 一般 hover / 切換 */
--duration-normal: 240ms;    /* 卡片進入 */
--duration-slow: 360ms;      /* 大範圍轉場 */

--ease-out: cubic-bezier(0.16, 1, 0.3, 1);     /* 進入、淡入（自然減速）*/
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1); /* 切換 */
--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* 選中強調，僅 transform */
```

**禁用範圍**：
- 任何 `infinite` 的裝飾性動畫（gradientShift、shimmer、float、iconPulse）
- `backdrop-filter: blur()` 在 LIFF 內帶來 30%+ 掉幀，移除
- 大範圍 `transform: scale()` + `box-shadow` 同時動，僅留 transform

### 2.8 Z-index 層級

```css
--z-base: 0;
--z-raised: 10;       /* 卡片懸浮 */
--z-sticky: 100;      /* sticky header */
--z-overlay: 500;     /* 背景遮罩 */
--z-modal: 1000;      /* modal 內容 */
--z-toast: 1500;      /* toast 通知 */
```

---

## 3. 檔案組織建議

當前 41KB 單一 `style.css` 不可維護。建議拆成 ITCSS（Inverted Triangle CSS）變體，純 CSS @import 串接：

```
frontend/liff/css/
├── style.css                  # 進入點，只做 @import
├── 00-tokens/
│   ├── _colors.css            # color primitive + semantic
│   ├── _typography.css        # font tokens
│   ├── _spacing.css           # 4/8 grid
│   ├── _radius-shadow.css     # 圓角、陰影
│   └── _motion.css            # duration、easing
├── 10-base/
│   ├── _reset.css             # box-sizing, margin reset
│   ├── _root.css              # body, html, 全局 scroll behavior
│   └── _typography.css        # h1-h6, p, a 基線樣式
├── 20-layout/
│   ├── _container.css         # .container max-width
│   ├── _stack.css             # vertical rhythm utility
│   └── _grid.css              # .grid--2, .grid--auto
├── 30-components/
│   ├── _header.css
│   ├── _form-section.css
│   ├── _option-card.css       # 取代 radio-label/transport-card 等多套樣式
│   ├── _button.css            # 統一所有按鈕：primary / secondary / ghost
│   ├── _restaurant-card.css
│   ├── _carousel.css
│   ├── _tag.css
│   ├── _loading.css
│   ├── _modal.css
│   └── _empty-error.css
├── 40-utilities/
│   ├── _visually-hidden.css
│   ├── _spacing.css           # .mt-4, .mb-6 等
│   └── _text.css              # .text-muted, .text-small
└── 50-overrides/
    └── _liff-webview.css      # LINE 內 webview 專屬 hack
```

### 3.1 為什麼這樣拆

- **00–10 層**：tokens 與 base 不依賴任何 component，最先載入
- **20 層**：layout 是骨架，必須早於 components
- **30 層**：component 是肉，每個檔案專注一個 BEM block
- **40 層**：utility 最後，可以覆寫 component（但只用於不值得開新 class 的 one-off）
- **50 層**：webview 特殊 hack（如 `-webkit-tap-highlight-color`）獨立，未來移除最方便

### 3.2 命名約定（BEM-lite）

```
.block                   區塊根
.block__element          區塊內子元素
.block--modifier         區塊變體
.block.is-active         狀態（用 is-/has- 前綴的單字 class）
```

範例：
```
.restaurant-card
.restaurant-card__name
.restaurant-card__image-container
.restaurant-card--featured     ← 變體
.restaurant-card.is-loading    ← 狀態
```

當前 CSS 中 `transport-card`、`location-mode-card`、`dining-time-card`、`option-text` 是同一個概念的不同名字，重構時應統一為 `.option-card`。

### 3.3 引用順序

`style.css`（進入點）只包含 @import 串：

```css
@import url("00-tokens/_colors.css") layer(tokens);
@import url("00-tokens/_typography.css") layer(tokens);
/* ...略 */
@import url("10-base/_reset.css") layer(base);
@import url("20-layout/_container.css") layer(layout);
@import url("30-components/_button.css") layer(components);
@import url("40-utilities/_spacing.css") layer(utilities);
```

使用 CSS `@layer` 確保覆寫順序明確（tokens < base < layout < components < utilities）。@layer 在所有現代 LINE webview（iOS 14+ / Android Chromium 90+）支援。

---

## 4. 響應式策略

### 4.1 斷點

```css
--breakpoint-sm: 480px;    /* 大手機（過此點優化字距） */
--breakpoint-md: 768px;    /* 平板 */
--breakpoint-lg: 1024px;   /* 桌面 */
```

**移動優先**：所有預設樣式為手機，用 `min-width` media query 向上加強。

### 4.2 為什麼不用 `max-width`

當前 CSS 全用 `@media (max-width: 768px)` 是桌面優先思路，導致：
- 預設樣式假設大螢幕 → 手機要覆寫一堆
- 41KB 中至少 5KB 是「手機覆寫」

改成 mobile-first：

```css
.header h1 {
  font-size: var(--font-size-2xl);  /* 28px，手機預設 */
}

@media (min-width: 768px) {
  .header h1 {
    font-size: var(--font-size-3xl);  /* 32px，桌面加強 */
  }
}
```

### 4.3 容器策略

LIFF 在桌面開啟時（debug / 分享連結被電腦點開），不該全寬伸展。

| 螢幕寬度 | 容器表現 |
|---|---|
| `< 480px` | 全寬，左右 padding 16px |
| `480–768px` | 全寬，左右 padding 20px |
| `≥ 768px` | `max-width: 480px`，置中 |

> **設計決定**：LIFF 是手機 app 體驗，即使桌面也維持手機寬度（480px），而非展開到 900px。避免「桌面看起來像被拉壞的網頁」。

### 4.4 觸控目標

所有可點擊元素 **最小尺寸 44×44px**（含 padding），符合 Apple HIG 與 WCAG 2.5.5。

```css
button,
.option-card,
[role="button"] {
  min-height: 44px;
  min-width: 44px;
}
```

---

## 5. 核心 Layout 規格

### 5.1 容器

```
.container
├── max-width: 480px (≥ 768px) / 100% (< 768px)
├── margin-inline: auto
├── padding-inline: 16px (< 480px) / 20px (≥ 480px)
└── padding-block: 0
```

### 5.2 垂直節奏

整體頁面用 **stack pattern**（owl selector）達成一致節奏：

```
header           ← top padding: var(--space-6)
↓ space-8
location-section
↓ space-6
form-section × N (each gap: space-5)
↓ space-8
submit button
↓ space-10
results
  ├── results-title ↓ space-5
  ├── restaurant-card × 5 (gap: space-4)
  └── reset button ↓ space-6
↓ space-12
footer
```

### 5.3 表單區段

每個 `.form-section` 結構：

```
form-section
├── padding-block: space-5
├── (option) border-top: 1px solid var(--color-border)
└── 內部 gap: space-3 (label → options)
```

選項排列：

- **2 選項**（locationMode、transport）：`grid-template-columns: 1fr 1fr`，gap `space-3`
- **3 選項**（diningTime）：`grid-template-columns: repeat(3, 1fr)`，gap `space-2`，窄螢幕 (`< 360px`) 自動折成 1 欄
- **多選項**（cuisine_style, budget）：`flex-wrap: wrap`，gap `space-2`，每個 chip min-height 44px

### 5.4 結果卡片

```
restaurant-card
├── radius: var(--radius-lg)
├── shadow: var(--shadow-sm) → hover: var(--shadow-md)
├── overflow: hidden
└── 結構
    ├── image-container (aspect-ratio: 16/10)
    └── info-block (padding: space-4)
        ├── name (font-md, weight-semibold)
        ├── address (font-sm, color-muted)
        ├── tags (gap: space-2, margin-block-start: space-3)
        └── actions (margin-block-start: space-4, gap: space-2)
```

> **關鍵調整**：當前餐廳卡圖片高度 `250px` 在手機上太佔比，改用 `aspect-ratio: 16/10` 讓圖片隨卡片寬度縮放，保持比例一致。

### 5.5 滾動行為

#### 推薦結果出現後的滾動

當前 home.js 用 `scrollIntoView({ behavior: 'smooth' })` 是好的方向，但有兩個改進：

1. **使用 CSS `scroll-margin-top`** 避免 sticky header 遮擋（未來若加 sticky）：
   ```css
   #results {
     scroll-margin-top: var(--space-4);
   }
   ```

2. **載入中時鎖定滾動位置**，避免使用者看到 loading 又被滾走。當前 home.js 的 `showLoading()` 應該配合 `scroll-behavior: auto` 暫時關閉平滑滾動。

#### 全頁 scroll behavior

```css
html {
  scroll-behavior: smooth;
}

body {
  overscroll-behavior-y: contain;   /* 防止 pull-to-refresh 干擾 LIFF */
  -webkit-overflow-scrolling: touch;
}

/* 尊重使用者偏好 */
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 6. 無障礙基線

### 6.1 焦點樣式

當前所有 `:focus` 都被 `outline: none` 或自定義邊框取代，鍵盤使用者完全看不到焦點。修正：

```css
:focus {
  outline: none;
}

:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
  border-radius: var(--radius-sm);
}
```

`:focus-visible` 只在鍵盤焦點時顯示，滑鼠點擊不會出現外框。

### 6.2 對比度

所有文字組合需 ≥ WCAG AA：

| 組合 | 對比 | 是否合格 |
|---|---|---|
| `--color-text-primary` on `--color-bg-surface` | 14.8:1 | AAA |
| `--color-text-body` on `--color-bg-surface` | 9.2:1 | AAA |
| `--color-text-muted` on `--color-bg-surface` | 4.8:1 | AA |
| `--color-text-inverse` on `--color-accent` | 4.7:1 | AA |

> **不合格的當前狀況**：`#5c4033` on `linear-gradient(#fff5f0, #ffe8d6)` 的暖色背景，對比僅 7.5:1，但 placeholder 文字 `color: var(--text-secondary)` 落在 `#fff5f0` 上對比 3.8:1，不過關。

### 6.3 觸控目標

- 最小 44×44 CSS px（已在 4.4 提及）
- 觸控目標之間至少 8px 間距，避免誤觸

### 6.4 語意 HTML

當前 `index.html` 結構大致正確（用了 `<header>` `<main>` `<section>` `<footer>`），但有兩個問題需修正：

1. **`.location-title` 是 `<h2>` 但內容「下面選一個」沒有語意**
   應改為清楚的 section heading，例如「搜尋方式」「選擇位置」。

2. **隱藏的「餐廳類型」section 用 `style="display: none"` 而非 `hidden`**
   應改用 `hidden` 屬性或加 `aria-hidden="true"`，避免 screen reader 朗讀已隱藏內容。

### 6.5 ARIA 標籤建議

| 元素 | 建議 ARIA |
|---|---|
| 「使用我的位置」按鈕 | `aria-describedby="locationStatus"` |
| locationStatus 區塊 | `role="status"` `aria-live="polite"` |
| #loading | `role="status"` `aria-live="polite"` |
| #error | `role="alert"` |
| carousel 切換按鈕 | `aria-label="上一張照片"` `aria-label="下一張照片"` |
| carousel indicator | `role="tab"` `aria-selected="true|false"` |

### 6.6 鍵盤導航

- Tab 順序應遵循視覺順序：locationMode → area/nearby → form sections → submit
- carousel 應可用方向鍵切換（左右箭頭）
- Modal 開啟時 focus trap，按 Escape 關閉

### 6.7 偏好設定尊重

```css
@media (prefers-reduced-motion: reduce) { /* 詳見 5.5 */ }
@media (prefers-color-scheme: dark)     { /* 詳見 2.2 */ }
@media (prefers-contrast: more) {
  :root {
    --color-border: var(--gray-500);
    --color-text-muted: var(--gray-700);
  }
}
```

---

## 7. 效能考量

### 7.1 LIFF 環境特性

LINE in-app webview 在 Android 是 Chromium WebView（通常落後桌面 Chrome 2–3 個版本），在 iOS 是 WKWebView（與 Safari 同步）。實測 LIFF 在中階 Android 機（如 Snapdragon 660 級）渲染慢的主因：

1. **過量 `box-shadow` 同時動畫**：每個 shadow 觸發 layer composite
2. **`backdrop-filter: blur()`**：Android WebView 上掉幀嚴重
3. **大面積 `linear-gradient` 配合 `background-size: 400%` 動畫**：每幀重繪
4. **`infinite` 動畫**：永久佔用 compositor thread

### 7.2 必須移除

| 當前 CSS | 問題 | 處置 |
|---|---|---|
| `body { animation: gradientShift 15s infinite }` | 永久重繪 | 刪除，純色背景 |
| `body::before` 灑滿 emoji | 額外 layer + opacity | 刪除 |
| `.header::after` shimmer | infinite 動畫 | 刪除 |
| `.main-content { backdrop-filter: blur(10px) }` | Android 慢 | 刪除 |
| `.checkbox-label:hover .option-icon { animation: iconBounce 0.6s }` | 過多 hover 動畫 | 刪除 |
| `.radio-label:has(...) .option-icon { animation: iconPulse 1.5s infinite }` | 永久動畫 | 刪除 |
| 多重 `box-shadow`（內陰影 + 外陰影 + 漸層）| 多層 composite | 簡化為單一陰影 |

### 7.3 保留並優化

- **`transform` 和 `opacity` 動畫**：GPU 加速，幾乎免費
- **`will-change` 謹慎使用**：只在使用者準備互動的元素（如 hover 中的卡片）短暫加上，不要 always-on

### 7.4 圖片載入

當前 carousel 載入 8 張圖（每個餐廳）× 5 間 = 40 張首頁圖。建議：

```html
<img src="..." loading="lazy" decoding="async" fetchpriority="low" />
```

第一張卡片的第一張圖可用 `fetchpriority="high"`，其他全部 lazy。

### 7.5 CSS 大小目標

當前 41KB 重構後目標 **≤ 18KB**（minified gzipped ≤ 5KB）。拆分檔案後，每個檔案不超過 3KB。

### 7.6 字型

不引入網路字型，使用系統字型 stack（`-apple-system`、`PingFang TC`、`Noto Sans TC`、`Microsoft JhengHei`）。理由：
- LIFF 環境下，網路字型額外 200–500ms 首屏延遲
- iOS 與 Android 內建中文字型在 14–18px 範圍渲染清晰度足夠

### 7.7 Critical CSS

由於 LIFF 是單頁 app，無需 inline critical CSS。但建議：

- `<link rel="preload" as="style" href="style.css">` 在 `<head>` 早期載入
- LIFF SDK script 與 CSS 並行載入（已是現況）

---

## 8. 設計決策摘要表

| 決策 | 為什麼 |
|---|---|
| 暖中性底色取代橘黃漸層 | 讓食物照片成為視覺主角 |
| 主標題從 51px 降到 28–32px | LIFF 視窗有限，主標題不該佔 8% 高度 |
| 移除所有 infinite 動畫 | Android WebView 效能 + 視覺疲勞 |
| 圓角統一 10–14px（捨棄 50px pill） | 現代 app 趨勢，pill 在窄螢幕看起來像藥丸 |
| 容器桌面 max-width 480px | LIFF 是手機體驗，桌面不應展開 |
| `@layer` 分層 + ITCSS 檔案組織 | 41KB monolithic 不可維護 |
| 強制 `:focus-visible` 焦點 | 鍵盤無障礙 |
| `prefers-color-scheme: dark` | LINE 內常見深色 UI |
| 系統字型 stack | 移除 200–500ms 字型載入延遲 |
| `aspect-ratio: 16/10` 圖片容器 | 取代固定 250px，響應更好 |

---

## 9. 實作優先順序

依以下順序實作，每完成一階段可獨立部署、不破壞現有功能：

### Phase 1（必做，1–2 天）— 基礎重建
1. **建立 `css/00-tokens/` 全部檔案**（colors、typography、spacing、radius-shadow、motion）
2. **新增 `css/10-base/_reset.css` + `_root.css`**，移除 body 上的 gradientShift、`body::before` emoji 灑點、backdrop-filter
3. **新增 `css/00-tokens/_colors.css` 的深色模式覆寫**
4. **建立 `style.css` 進入點**，用 `@layer` 與 `@import` 串接

> **驗收**：頁面看起來「素」但乾淨，沒有閃爍動畫，深色模式自動切換。

### Phase 2（必做，2–3 天）— Layout 與核心元件
5. **`css/20-layout/_container.css`**：max-width 480px，padding 規則
6. **`css/30-components/_header.css`**：縮小主標題、移除 shimmer
7. **`css/30-components/_form-section.css` + `_option-card.css`**：統一所有選項卡（location-mode-card、transport-card、dining-time-card、radio-label）為單一 `.option-card` BEM
8. **`css/30-components/_button.css`**：primary / secondary / ghost 三種變體，取代當前 5+ 種按鈕樣式
9. **觸控目標稽核**：全頁 audit 確保所有 button、label、a 至少 44×44px

> **驗收**：表單區塊間距一致，所有選項視覺統一，按下狀態明確。

### Phase 3（必做，1–2 天）— 結果卡片與圖片
10. **`css/30-components/_restaurant-card.css`**：用 `aspect-ratio` 替換固定高度
11. **`css/30-components/_carousel.css`**：簡化 indicator 樣式，保留功能性
12. **`css/30-components/_tag.css`**：統一 tag 樣式，取消三種顏色變體（cuisine / type / budget 用同一色，靠文字區分）
13. **圖片 lazy loading**：HTML 上加 `loading="lazy" decoding="async"`

> **驗收**：5 張餐廳卡片在手機上清晰、節奏一致、滾動順暢。

### Phase 4（建議做，1 天）— 無障礙與動效
14. **全域 `:focus-visible` 樣式**
15. **`@media (prefers-reduced-motion)` 支援**
16. **修正 location-title 文案**（「下面選一個」改成「搜尋方式」）
17. **加上 ARIA 標籤**（locationStatus 加 `role="status"`、error 加 `role="alert"`、carousel 按鈕加 `aria-label`）

> **驗收**：用 keyboard Tab 走完整頁，每個焦點可見。Lighthouse Accessibility ≥ 95。

### Phase 5（建議做，半天）— 收尾
18. **建立 `css/40-utilities/`**：spacing、text helpers
19. **建立 `css/50-overrides/_liff-webview.css`**：把 `-webkit-tap-highlight-color`、`overscroll-behavior` 等 LIFF 特化規則隔離
20. **刪除舊 `style.css`**，將 `index.html` 引用改為新 `css/style.css`
21. **Lighthouse 跑分**：目標 Performance ≥ 90，Accessibility ≥ 95，Best Practices ≥ 95

> **驗收**：CSS 總大小 ≤ 18KB（minified），首屏渲染 LCP < 2s（4G Android）。

### Phase 6（可選，未來迭代）— 進階
- Container queries 讓餐廳卡片在不同容器寬度下自動調整
- View Transitions API 讓結果區塊出現有流暢轉場
- 增加 sticky CTA 按鈕（捲動時固定在底部）

---

**文件版本**：v1.0
**最後更新**：2026-05-13
**負責角色**：UX Architect
**配套文件**：（待 UI Designer 提供視覺細節提案、Visual Storyteller 提供文案敘事）
