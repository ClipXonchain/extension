// ClipX Tipping Assistant - Content Script
const CLIPX_PRODUCTION_API = 'https://clipx.app';
const CLIPX_DEV_API = 'http://localhost:3000';
let API_BASE = CLIPX_PRODUCTION_API;
let _clipxDevMode = false;

function clipxNormalizeApiBase(v, devMode) {
    const fallback = devMode ? CLIPX_DEV_API : CLIPX_PRODUCTION_API;
    if (typeof v !== 'string' || !v.trim()) return fallback;
    try {
        const u = new URL(v);
        if (!devMode && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return CLIPX_PRODUCTION_API;
        return v.replace(/\/$/, '') || fallback;
    } catch {
        return fallback;
    }
}

function clipxStoredApiLooksLocal(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return true;
    try {
        const u = new URL(raw.trim());
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
        return false;
    }
}

chrome.storage.local.get(['apiBase', 'clipxDevMode', 'clipxProdApiDefaultApplied'], (result) => {
    let dev = result.clipxDevMode === true;
    let raw = typeof result.apiBase === 'string' ? result.apiBase.trim() : '';

    let didMigrateLocalDefault = false;
    if (!result.clipxProdApiDefaultApplied && clipxStoredApiLooksLocal(raw)) {
        dev = false;
        raw = CLIPX_PRODUCTION_API;
        didMigrateLocalDefault = true;
        chrome.storage.local.set({
            apiBase: CLIPX_PRODUCTION_API,
            clipxDevMode: false,
            clipxProdApiDefaultApplied: true,
        });
    } else if (!result.clipxProdApiDefaultApplied) {
        chrome.storage.local.set({ clipxProdApiDefaultApplied: true });
    }

    _clipxDevMode = dev;
    const next = clipxNormalizeApiBase(raw || (dev ? CLIPX_DEV_API : CLIPX_PRODUCTION_API), dev);
    API_BASE = next;

    if (!didMigrateLocalDefault) {
        const patch = {};
        if (result.apiBase !== next) patch.apiBase = next;
        if (result.clipxDevMode !== dev) patch.clipxDevMode = dev;
        if (Object.keys(patch).length) chrome.storage.local.set(patch);
    }

    console.log('[ClipX Content] API_BASE initialized to:', API_BASE, _clipxDevMode ? '(dev)' : '');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.clipxDevMode) _clipxDevMode = changes.clipxDevMode.newValue === true;
    if (!changes.apiBase && !changes.clipxDevMode) return;
    const v = changes.apiBase ? changes.apiBase.newValue : API_BASE;
    API_BASE = clipxNormalizeApiBase(typeof v === 'string' ? v : '', _clipxDevMode);
    console.log('[ClipX Content] API_BASE updated to:', API_BASE);
});

let processedTweets = new Set();
window.clipxTokenMap = {};

const CLIPX_NATIVE_SOL_TOKEN = {
    address: 'So11111111111111111111111111111111111111112',
    chain: 'sol',
    decimals: 9,
    name: 'Solana',
    logoURI: '',
    isVerified: true,
    source: 'priority'
};

function clipxEnsureNativeSolTokenMap() {
    window.clipxTokenMap = window.clipxTokenMap || {};
    window.clipxTokenMap.SOL = { ...CLIPX_NATIVE_SOL_TOKEN };
}

/** Single-post permalink (Post view), not timeline or profile home */
function clipxIsSingleStatusPermalinkPage() {
    return /^\/[^/]+\/status\/\d+/.test(window.location.pathname || '');
}

function clipxSyncPostPageContextAttribute() {
    const root = document.documentElement;
    if (clipxIsSingleStatusPermalinkPage()) {
        root.setAttribute('data-clipx-page', 'status');
    } else {
        root.removeAttribute('data-clipx-page');
    }
    try {
        injectClipxSorsaScoresOnPage();
    } catch (e) {
        /* ignore */
    }
    try {
        if (clipxProfileHandleFromPathname(window.location.pathname)) {
            ProfileScanner.init();
        }
    } catch (e) {
        /* ignore */
    }
    try {
        clipxSyncXAppearanceAttribute();
    } catch (e) {
        /* ignore */
    }
}

/** Parse computed background-color / rgb() string into RGBA. */
function clipxParseRgbColor(value) {
    if (!value || typeof value !== 'string') return null;
    const m = value.trim().match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!m) return null;
    return {
        r: +m[1],
        g: +m[2],
        b: +m[3],
        a: m[4] !== undefined ? +m[4] : 1,
    };
}

/** Walk up until a non-transparent background; return perceptual luminance 0–255 or null. */
function clipxSurfaceLuminanceFromEl(startEl) {
    let node = startEl;
    for (let i = 0; i < 14 && node; i++) {
        let c;
        try {
            c = getComputedStyle(node).backgroundColor;
        } catch {
            return null;
        }
        const p = clipxParseRgbColor(c);
        if (p && p.a >= 0.06) {
            return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
        }
        node = node.parentElement;
    }
    return null;
}

/**
 * Light vs dark X timeline: html[data-theme] / data-color-theme are often missing or inconsistent.
 * Prefer data-color-mode, else first opaque surface (tweet card / column), else prefers-color-scheme.
 */
function clipxInferXUiAppearance() {
    const root = document.documentElement;
    const raw = (
        root.getAttribute('data-color-mode') ||
        root.getAttribute('data-theme') ||
        root.getAttribute('data-color-theme') ||
        ''
    ).toLowerCase();
    if (raw === 'dark' || raw === 'dim') return 'dark';
    if (raw === 'light') return 'light';

    const probes = [
        document.querySelector('article[data-testid="tweet"]'),
        document.querySelector('[data-testid="primaryColumn"]'),
        document.querySelector('main[role="main"]'),
        document.getElementById('react-root'),
        document.body,
    ];
    for (const el of probes) {
        if (!el) continue;
        const lum = clipxSurfaceLuminanceFromEl(el);
        if (lum != null) return lum < 90 ? 'dark' : 'light';
    }

    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
}

let _clipxLastXAppearance = '';

function clipxSyncXAppearanceAttribute() {
    const next = clipxInferXUiAppearance();
    if (next === _clipxLastXAppearance) return;
    _clipxLastXAppearance = next;
    document.documentElement.setAttribute('data-clipx-x-appearance', next);
}

// Inject CSS for verification badge
if (!document.getElementById('clipx-verification-badge-styles')) {
    const style = document.createElement('style');
    style.id = 'clipx-verification-badge-styles';
    style.textContent = `
        .clipx-verified-badge {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: rgba(59, 130, 246, 0.15) !important;
            color: #3b82f6 !important;
            border-radius: 50% !important;
            width: 13px !important;
            height: 13px !important;
            font-size: 9px !important;
            font-weight: bold !important;
            margin-left: 3px !important;
            border: 1px solid rgba(59, 130, 246, 0.4) !important;
            cursor: help !important;
            flex-shrink: 0 !important;
        }

        /* SPOTLIGHT STYLE */
        @keyframes clipx-spotlight {
            0% { transform: translateX(-100%) skewX(-25deg); }
            50%, 100% { transform: translateX(200%) skewX(-25deg); }
        }

        @keyframes clipx-pulse-border {
            0%, 100% { border-color: rgba(168, 85, 247, 0.8); }
            50% { border-color: rgba(236, 72, 153, 1); }
        }

        .clipx-label-spotlight {
            position: relative !important;
            overflow: hidden !important;
            border-radius: 0 !important;
            color: #fff !important;
            background: linear-gradient(135deg, rgba(88, 28, 135, 0.92), rgba(147, 51, 234, 0.82), rgba(236, 72, 153, 0.72)) !important;
            border: 2px solid rgba(168, 85, 247, 0.8) !important;
            animation: clipx-pulse-border 2s infinite ease-in-out !important;
            box-shadow: 0 0 12px rgba(168, 85, 247, 0.5), inset 0 0 8px rgba(168, 85, 247, 0.2) !important;
            text-shadow: 0 0 6px rgba(255, 255, 255, 0.5) !important;
            line-height: 1 !important;
            font-size: 11px !important;
            font-weight: 760 !important;
            padding: 2px 4px !important;
        }

        .clipx-label-spotlight::after {
            content: '' !important;
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 50% !important;
            height: 100% !important;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.4), transparent) !important;
            animation: clipx-spotlight 2.5s infinite !important;
            pointer-events: none !important;
        }

        /*
         * GLOW option: masked stroke (::before) in green tones; deeper green fill (~1.5× prior opacity).
         */
        .clipx-label-glow {
            position: relative !important;
            overflow: visible !important;
            border-radius: 0 !important;
            background: linear-gradient(90deg, rgba(4, 120, 87, 0.50) 0%, rgba(5, 150, 105, 0.44) 45%, rgba(16, 185, 129, 0.38) 100%) !important;
            box-shadow: none !important;
            text-shadow: none !important;
            font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif !important;
            font-weight: 760 !important;
            font-size: 11px !important;
            line-height: 1 !important;
            padding: 2px 4px !important;
            color: #0f172a !important;
            --glow-color: rgba(5, 120, 90, 0.45);
        }
        .clipx-label-glow::before {
            content: '' !important;
            position: absolute !important;
            inset: -1.2px !important;
            border-radius: 0 !important;
            padding: 1.2px !important;
            background: linear-gradient(90deg, #064e3b 0%, #0f766e 22%, #0d9488 44%,rgb(23, 120, 140) 62%,rgba(78, 127, 234, 0.76) 82%,rgb(84, 77, 209) 100%) !important;
            -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important;
            -webkit-mask-composite: xor !important;
            mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important;
            mask-composite: exclude !important;
            pointer-events: none !important;
            z-index: -1 !important;
        }

    
        /* Box fill (bg) - edit only the fill below */
        .clipx-label-gradient {
            position: relative !important;
            overflow: visible !important;
            background: linear-gradient(90deg, rgba(0, 4, 242, 0.31) 20%, rgba(100, 9, 160, 0.27) 60%, rgba(153, 29, 224, 0.22) 100%) !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            text-shadow: none !important;
            font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif !important;
            font-weight: 760 !important;
            font-size: 11px !important;
            line-height: 1 !important;
            padding: 2px 4px !important;
            /* Default when X omits data-theme: avoid white/washed text on translucent fill (see ClipX Extension). */
            color: #0f172a !important;
        }
        /* Box stroke (border) - 40% thinner (1.2px vs 2px) */
        .clipx-label-gradient::before {
            content: '' !important;
            position: absolute !important;
            inset: -1.2px !important;
            border-radius: 0 !important;
            padding: 1.2px !important;
            background: linear-gradient(90deg, #ff00b2 0%, #f72585 20%, #b5179e 44%, #6366f1 68%, #38bdf8 90%, #0ea5e9 100%) !important;
            -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important;
            -webkit-mask-composite: xor !important;
            mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important;
            mask-composite: exclude !important;
            pointer-events: none !important;
            z-index: -1 !important;
        }

        /* Binance Square button pulse */
        @keyframes clipx-bs-pulse {
            0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(240, 185, 11, 0.25); }
            50% { transform: scale(1.06); box-shadow: 0 0 8px 2px rgba(240, 185, 11, 0.35); }
        }
        .clipx-crosspost-btn > div:first-child {
            animation: clipx-bs-pulse 2.2s ease-in-out infinite !important;
        }

        /* Inner inset = padding on .clipx-label-* only; badge margin 0 so we do not fake inset with outer margin */
        .clipx-feed-label,
        .clipx-profile-label-badge {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            box-sizing: border-box !important;
            margin: 0 !important;
            font-weight: 760 !important;
        }
        .clipx-user-list-label {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            box-sizing: border-box !important;
            margin: 0 0 0 4px !important;
            font-weight: 760 !important;
        }

        /* Post permalink only (/handle/status/id): same tight horizontal inset as feed; gap after timestamp below */
        html[data-clipx-page="status"] .clipx-feed-label.clipx-label-gradient,
        html[data-clipx-page="status"] .clipx-feed-label.clipx-label-glow,
        html[data-clipx-page="status"] .clipx-feed-label.clipx-label-spotlight {
            padding: 2px 4px !important;
            font-weight: 760 !important;
        }
        html[data-clipx-page="status"] .clipx-inline-tweet-meta {
            margin-left: 2px !important;
            gap: 3px !important;
        }

        /*
         * Permalink post view: X uses flex-column on User-Name (name row, then @handle/time, then our Tip),
         * which stacks them vertically. Use a horizontal wrapping row so @handle and Tip stay on one band with the name.
         */
        html[data-clipx-page="status"] article[data-testid="tweet"] div[data-testid="User-Name"] {
            display: flex !important;
            flex-direction: row !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            align-content: center !important;
            column-gap: 10px !important;
            row-gap: 2px !important;
        }
        /* Do not set min-width:0 on User-Name > div — that shrinks the name row and ellipsizes the display name. */
        html[data-clipx-page="status"] article[data-testid="tweet"] div[data-testid="User-Name"] > div {
            flex: 0 1 auto !important;
        }
        html[data-clipx-page="status"] article[data-testid="tweet"] .clipx-tip-badge {
            flex-shrink: 0 !important;
            align-self: center !important;
        }

        /* Prefer truncating @handle over display name when the header row is crowded */
        article[data-testid="tweet"] div[data-testid="User-Name"] .clipx-tweet-display-name-wrap {
            flex-shrink: 0 !important;
            min-width: min-content !important;
            max-width: none !important;
            overflow: visible !important;
        }
        article[data-testid="tweet"] div[data-testid="User-Name"] a.clipx-tweet-display-name-preserve {
            flex-shrink: 0 !important;
            min-width: min-content !important;
            max-width: none !important;
            overflow: visible !important;
            text-overflow: clip !important;
        }
        article[data-testid="tweet"] div[data-testid="User-Name"] a.clipx-tweet-display-name-preserve span {
            overflow: visible !important;
            text-overflow: clip !important;
            max-width: none !important;
        }
        article[data-testid="tweet"] div[data-testid="User-Name"] a.clipx-tweet-handle-shrink {
            min-width: 0 !important;
            max-width: min(20vw, 92px) !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
            flex-shrink: 1 !important;
        }

        /* Post time sits after handle — don’t let it compress under Tip / overflow */
        article[data-testid="tweet"] div[data-testid="User-Name"] a[href*="/status/"] {
            flex-shrink: 0 !important;
            white-space: nowrap !important;
        }
        article[data-testid="tweet"] div[data-testid="User-Name"] a[href*="/status/"] time {
            white-space: nowrap !important;
        }

        /* Label text color: light mode = black, dark mode = white */
        html[data-color-theme="light"] .clipx-feed-label,
        html[data-color-theme="light"] .clipx-profile-label-badge,
        html[data-color-theme="light"] .clipx-user-list-label,
        html[data-theme="light"] .clipx-feed-label,
        html[data-theme="light"] .clipx-profile-label-badge,
        html[data-theme="light"] .clipx-user-list-label,
        html[data-color-theme="light"] .clipx-label-gradient,
        html[data-theme="light"] .clipx-label-gradient,
        html[data-color-theme="light"] .clipx-label-glow,
        html[data-theme="light"] .clipx-label-glow {
            color: #000 !important;
        }
        html[data-color-theme="dark"] .clipx-feed-label,
        html[data-color-theme="dark"] .clipx-profile-label-badge,
        html[data-color-theme="dark"] .clipx-user-list-label,
        html[data-theme="dark"] .clipx-feed-label,
        html[data-theme="dark"] .clipx-profile-label-badge,
        html[data-theme="dark"] .clipx-user-list-label,
        body.LightsOut .clipx-feed-label,
        body.LightsOut .clipx-profile-label-badge,
        body.LightsOut .clipx-user-list-label,
        html[data-color-theme="dark"] .clipx-label-gradient,
        html[data-theme="dark"] .clipx-label-gradient,
        html[data-color-theme="dark"] .clipx-label-glow,
        html[data-theme="dark"] .clipx-label-glow,
        body.LightsOut .clipx-label-gradient,
        body.LightsOut .clipx-label-glow {
            color: #fff !important;
        }
        /* Spotlight: white text on saturated purple fill */
        .clipx-label-spotlight,
        html[data-color-theme="light"] .clipx-label-spotlight,
        html[data-theme="light"] .clipx-label-spotlight,
        html[data-color-theme="dark"] .clipx-label-spotlight,
        html[data-theme="dark"] .clipx-label-spotlight,
        body.LightsOut .clipx-label-spotlight {
            color: #fff !important;
        }

        /*
         * ClipX-inferred timeline (see clipxSyncXAppearanceAttribute). Overrides html[data-theme]
         * for gradient + green pill text so light timelines get dark type and dark timelines get light type.
         */
        html[data-clipx-x-appearance="light"] .clipx-label-gradient,
        html[data-clipx-x-appearance="light"] .clipx-label-glow {
            color: #0a0a0a !important;
        }
        html[data-clipx-x-appearance="light"] .clipx-label-glow {
            text-shadow: none !important;
        }
        html[data-clipx-x-appearance="dark"] .clipx-label-gradient {
            color:rgb(255, 255, 255) !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35) !important;
        }
        html[data-clipx-x-appearance="dark"] .clipx-label-glow {
            color:rgb(255, 255, 255) !important;
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4) !important;
        }
    `;
    document.head.appendChild(style);
    queueMicrotask(() => {
        try {
            clipxSyncXAppearanceAttribute();
        } catch (e) {
            /* ignore */
        }
    });
}

// -- Label Effect Style Application --
let currentLabelStyle = 'gradient'; // default
chrome.storage.local.get(['labelEffectStyle'], (r) => {
    currentLabelStyle = r.labelEffectStyle || 'gradient';
});

let currentTokenPillStyle = 'market';
chrome.storage.local.get(['tokenPillStyle'], (r) => {
    currentTokenPillStyle = clipxNormalizeTokenPillStyle(r.tokenPillStyle);
    clipxApplyTokenPillStyleToExisting();
});

function clipxNormalizeTokenPillStyle(style) {
    if (style === 'classic' || style === 'clean') return 'market';
    if (style === 'neon') return 'chain';
    if (style === 'compact') return 'micro';
    return ['market', 'chain', 'micro'].includes(style) ? style : 'market';
}

function clipxTokenPillStyleClass() {
    return `clipx-token-pill-style-${currentTokenPillStyle}`;
}

function clipxApplyTokenPillStyleToElement(el) {
    if (!el || !el.classList) return;
    el.classList.remove(
        'clipx-token-pill-style-classic',
        'clipx-token-pill-style-compact',
        'clipx-token-pill-style-clean',
        'clipx-token-pill-style-neon',
        'clipx-token-pill-style-market',
        'clipx-token-pill-style-chain',
        'clipx-token-pill-style-micro'
    );
    el.classList.add(clipxTokenPillStyleClass());
}

function clipxApplyTokenPillStyleToExisting() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.clipx-token-pill-main, .clipx-cashtag-pill-row').forEach(clipxApplyTokenPillStyleToElement);
}

function applyLabelStyle(element) {
    element.classList.remove('clipx-label-spotlight', 'clipx-label-glow', 'clipx-label-gradient');
    if (currentLabelStyle === 'glow') {
        element.classList.add('clipx-label-glow');
    } else if (currentLabelStyle === 'gradient') {
        element.classList.add('clipx-label-gradient');
    } else {
        element.classList.add('clipx-label-spotlight');
    }
}

// Listen for messages from popup (e.g., toggle changes)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'refreshTipsButtons') {
        // Remove all existing Tips buttons
        document.querySelectorAll('.clipx-tip-badge').forEach(btn => btn.remove());
        // Clear processed tweets
        document.querySelectorAll('article[data-clipx-processed]').forEach(article => {
            article.removeAttribute('data-clipx-processed');
        });
        // Re-add Tips buttons if enabled
        if (request.showTipsButtons) {
            addTipButtons();
        }

        // Update label effect style if provided
        if (request.labelEffectStyle) {
            currentLabelStyle = request.labelEffectStyle;
            document.querySelectorAll('.clipx-feed-label, .clipx-profile-label-badge, .clipx-user-list-label').forEach(el => {
                applyLabelStyle(el);
            });
        }

        if (request.tokenPillStyle) {
            currentTokenPillStyle = clipxNormalizeTokenPillStyle(request.tokenPillStyle);
            clipxApplyTokenPillStyleToExisting();
        }
    }
});

// Create tip button
function createTipButton(username) {
    const btn = document.createElement('div');
    btn.className = 'clipx-tip-badge';
    btn.setAttribute('data-username', username);
    // Use an SVG icon for a cleaner look, or just text if preferred. 
    // Using a simple money bag icon + "Tip" text.
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="margin-right: 2px;">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.31-8.86c-1.77-.45-2.34-.94-2.34-1.67 0-.84.79-1.43 2.1-1.43 1.38 0 1.9.66 1.94 1.64h1.71c-.05-1.34-.87-2.57-2.49-2.95V5h-2.93v1.74c-1.81.42-3.21 1.77-3.21 3.11 0 1.71 1.41 2.64 3.55 3.15 1.78.43 2.39 1.01 2.39 1.76 0 .91-.89 1.52-2.19 1.52-1.6 0-2.21-.72-2.26-1.69h-1.71c.05 1.63 1.01 2.71 2.56 3.04V19h2.93v-1.72c1.77-.39 3.24-1.72 3.24-3.19 0-1.8-1.46-2.7-3.49-3.23z"/>
        </svg>
        <span>Tip</span>
    `;

    // Badge style
    btn.style.cssText = `
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        background-color: rgba(29, 155, 240, 0.1) !important; /* Twitter Blue tint */
        color: #1d9bf0 !important; /* Twitter Blue */
        border: 1px solid rgba(29, 155, 240, 0.3) !important;
        border-radius: 9999px !important;
        padding: 1px 6px !important;
        margin-left: 8px !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        line-height: 14px !important;
        height: 18px !important;
        cursor: pointer !important;
        user-select: none !important;
        transition: background-color 0.2s ease !important;
        pointer-events: auto !important;
        position: relative !important;
        z-index: 1 !important;
    `;

    btn.onmouseenter = function () {
        this.style.backgroundColor = 'rgba(29, 155, 240, 0.2) !important';
    };

    btn.onmouseleave = function () {
        this.style.backgroundColor = 'rgba(29, 155, 240, 0.1) !important';
    };

    const openTip = function (e) {
        clipxOpenTipBadgeModal(btn, e);
    };
    btn.addEventListener('pointerdown', openTip, true);
    btn.addEventListener('mousedown', openTip, true);
    btn.addEventListener('touchstart', openTip, true);
    btn.addEventListener('click', openTip, true);

    return btn;
}

// Show Risk Modal
const showRiskModal = (address, symbol, chain = 'bnb') => {
    const _urls = clipxChainUrls(chain, address);
    const existing = document.getElementById('clipx-risk-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'clipx-risk-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.6);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 2147483648;
        backdrop-filter: blur(2px);
        animation: fadeIn 0.2s ease;
    `;

    // Container for both panels
    const container = document.createElement('div');
    container.id = 'clipx-modal-container';
    container.style.cssText = `
        display: flex;
        background: #09090b;
        border: 1px solid #27272a;
        border-radius: 16px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.05);
        overflow: hidden;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        max-width: 90vw;
        max-height: 90vh;
        animation: slideUpFade 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    // Inject Custom CSS Animations and Scrollbar styling specifically for this modal
    const styleId = 'clipx-risk-modal-styles';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            @keyframes slideUpFade {
                from { opacity: 0; transform: translateY(20px) scale(0.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            #clipx-risk-modal * {
                box-sizing: border-box;
            }
            #clipx-kol-holders > div::-webkit-scrollbar {
                width: 6px;
            }
            #clipx-kol-holders > div::-webkit-scrollbar-track {
                background: rgba(0,0,0,0.2); 
                border-radius: 4px;
            }
            #clipx-kol-holders > div::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.1); 
                border-radius: 4px;
            }
            #clipx-kol-holders > div::-webkit-scrollbar-thumb:hover {
                background: rgba(255,255,255,0.2); 
            }
        `;
        document.head.appendChild(style);
    }

    // Main Content Panel (Risk Data)
    const content = document.createElement('div');
    content.style.cssText = `
        padding: 24px;
        width: 420px;
        color: #fff;
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        flex-shrink: 0;
        border-right: 1px solid transparent;
        transition: border-color 0.3s;
        background: linear-gradient(145deg, rgba(24, 24, 27, 0.95) 0%, rgba(9, 9, 11, 0.98) 100%);
    `;

    // Side Panel (Visualizations) - Hidden by default
    const sidePanel = document.createElement('div');
    sidePanel.id = 'clipx-side-panel';
    sidePanel.style.cssText = `
        width: 0;
        opacity: 0;
        background: #000;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        overflow: hidden;
        position: relative;
    `;

    // Fix symbol display
    const displaySymbol = (symbol && symbol !== 'Null' && symbol !== 'null') ? '$' + symbol : 'Contract';

    content.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <div style="width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #8b5cf6, #3b82f6); display: flex; align-items: center; justify-content: center; font-size: 16px; box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);">
                    🛡️
                </div>
                <div>
                    <h3 style="margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.5px;">Risk Check</h3>
                    <div style="font-size: 12px; color: #a1a1aa; font-weight: 500;">${displaySymbol}</div>
                </div>
                <button id="clipx-toggle-feature" style="background:none; border:none; cursor:pointer; font-size:18px; color:#a1a1aa; margin-left:8px; line-height:1; padding:0; transition: transform 0.2s;" title="Add/Remove from Featured">☆</button>
            </div>
            <button id="clipx-risk-close" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 50%; width: 28px; height: 28px; color: #a1a1aa; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; transition: all 0.2s;">&times;</button>
        </div>

        <!-- Portfolio View -->
        <div id="clipx-portfolio" style="margin-bottom: 20px; padding: 12px 16px; background: linear-gradient(135deg, rgba(59, 130, 246, 0.1) 0%, rgba(37, 99, 235, 0.05) 100%); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 12px; display: none; box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);">
             <div style="font-size: 12px; color: #93c5fd; margin-bottom: 6px; font-weight: 500; display: flex; align-items: center; gap: 6px;">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><rect x="7" y="7" width="3" height="9"></rect><rect x="14" y="7" width="3" height="5"></rect></svg>
                 Your Position
             </div>
             <div style="font-size: 16px; font-weight: 700; color: #fff; display: flex; justify-content: space-between; align-items: flex-end;">
                 <span id="clipx-portfolio-bal">Loading...</span>
                 <span id="clipx-portfolio-val" style="font-size: 13px; color: #bfdbfe; font-weight: 600; background: rgba(59, 130, 246, 0.2); padding: 2px 8px; border-radius: 6px;"></span>
             </div>
        </div>


        <!-- Quick Trade Section (Wrapped for proper positioning) -->
        <div style="margin-bottom: 16px; position: relative;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div style="font-size: 11px; color: #a1a1aa; font-weight: 600;">⚡ Quick Trade</div>
                    <div id="clipx-quick-bal" style="font-size: 10px; color: #fbbf24; font-weight: 500; background: rgba(251, 191, 36, 0.1); padding: 1px 4px; border-radius: 3px; display: none;"></div>
                    <button id="clipx-quick-refresh" style="background: none; border: none; cursor: pointer; color: #a1a1aa; font-size: 10px; padding: 0; transition: transform 0.3s;" title="Refresh Balance">🔄</button>
                </div>
                <button id="clipx-trade-settings-btn" style="background: none; border: none; cursor: pointer; color: #a1a1aa; font-size: 12px; padding: 2px; transition: color 0.2s;">
                    ⚙️
                </button>
            </div>

            <!-- Settings Panel (Compact) -->
            <div id="clipx-settings-panel" style="display: none; position: absolute; top: 22px; left: 0; right: 0; background: rgba(9, 9, 11, 0.95); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 10px; z-index: 50; box-shadow: 0 10px 25px rgba(0,0,0,0.8);">
                <div style="font-size: 10px; font-weight: 700; color: #fff; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px;">
                    <span>⚙️ Settings</span>
                </div>
                
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <div style="flex: 1;">
                        <div style="font-size: 9px; color: #a1a1aa; margin-bottom: 2px; font-weight: 600;">Slippage %</div>
                        <input type="number" id="clipx-set-slip" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 4px 6px; border-radius: 4px; font-size: 10px; outline: none; transition: border-color 0.2s;" onfocusin="this.style.borderColor='rgba(139, 92, 246, 0.5)'" onfocusout="this.style.borderColor='rgba(255,255,255,0.1)'">
                    </div>
                    <div style="flex: 1;">
                        <div style="font-size: 9px; color: #a1a1aa; margin-bottom: 2px; font-weight: 600;">Gas (Gwei)</div>
                        <input type="number" id="clipx-set-gas" style="width: 100%; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 4px 6px; border-radius: 4px; font-size: 10px; outline: none; transition: border-color 0.2s;" onfocusin="this.style.borderColor='rgba(139, 92, 246, 0.5)'" onfocusout="this.style.borderColor='rgba(255,255,255,0.1)'">
                    </div>
                </div>

                <div style="font-size: 9px; color: #a1a1aa; margin-bottom: 4px; font-weight: 600;">Buy Presets (${_urls.nativeSymbol})</div>
                <div style="display: flex; gap: 6px; margin-bottom: 10px;">
                    <input type="number" id="clipx-set-buy1" step="0.01" style="flex: 1; width: 0; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 4px; border-radius: 4px; font-size: 10px; outline: none; text-align: center; transition: border-color 0.2s;" onfocusin="this.style.borderColor='rgba(139, 92, 246, 0.5)'" onfocusout="this.style.borderColor='rgba(255,255,255,0.1)'">
                    <input type="number" id="clipx-set-buy2" step="0.01" style="flex: 1; width: 0; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 4px; border-radius: 4px; font-size: 10px; outline: none; text-align: center; transition: border-color 0.2s;" onfocusin="this.style.borderColor='rgba(139, 92, 246, 0.5)'" onfocusout="this.style.borderColor='rgba(255,255,255,0.1)'">
                    <input type="number" id="clipx-set-buy3" step="0.01" style="flex: 1; width: 0; box-sizing: border-box; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 4px; border-radius: 4px; font-size: 10px; outline: none; text-align: center; transition: border-color 0.2s;" onfocusin="this.style.borderColor='rgba(139, 92, 246, 0.5)'" onfocusout="this.style.borderColor='rgba(255,255,255,0.1)'">
                </div>

                <div style="display: flex; gap: 6px;">
                    <button id="clipx-save-settings" style="flex: 2; background: #8b5cf6; color: #fff; border: none; padding: 6px; border-radius: 6px; font-size: 10px; cursor: pointer; font-weight: 700; box-shadow: 0 2px 4px rgba(139, 92, 246, 0.2); transition: background 0.2s;" onmouseover="this.style.background='#7c3aed'" onmouseout="this.style.background='#8b5cf6'">Save Settings</button>
                    <button id="clipx-cancel-settings" style="flex: 1; background: transparent; border: 1px solid #3f3f46; color: #a1a1aa; padding: 6px; border-radius: 6px; font-size: 10px; cursor: pointer; transition: all 0.2s; font-weight: 600;" onmouseover="this.style.background='rgba(255,255,255,0.05)'; this.style.color='#fff';" onmouseout="this.style.background='transparent'; this.style.color='#a1a1aa';">Close</button>
                </div>
            </div>
            
            <div id="clipx-trade-buttons-container" style="display: flex; flex-direction: column; gap: 6px;">
                <!-- Buttons injected by JS -->
                <div style="text-align: center; color: #a1a1aa; font-size: 10px;">Loading presets...</div>
            </div>
        </div>


        <div id="clipx-risk-loading" style="text-align: center; padding: 20px; color: #a1a1aa;">
            Scanning contract...
        </div>
        <div id="clipx-risk-result" style="display: none;"></div>
    `;

    container.appendChild(content);
    container.appendChild(sidePanel);
    modal.appendChild(container);
    document.body.appendChild(modal);

    modal.querySelector('#clipx-risk-close').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    // --- Feature Ticker Logic ---
    const toggleBtn = modal.querySelector('#clipx-toggle-feature');
    if (toggleBtn && symbol && symbol !== 'Null' && symbol !== 'null') {
        const updateStar = (isFeatured) => {
            toggleBtn.innerHTML = isFeatured ? '★' : '☆';
            toggleBtn.style.color = isFeatured ? '#fbbf24' : '#a1a1aa'; // Yellow vs Gray
        };

        // Initial check
        chrome.storage.local.get(['featuredTickers'], (res) => {
            const list = res.featuredTickers || [];
            updateStar(list.includes(symbol));
        });

        toggleBtn.onclick = (e) => {
            e.stopPropagation(); // Prevent modal close
            chrome.storage.local.get(['featuredTickers'], (res) => {
                let list = res.featuredTickers || [];
                if (list.includes(symbol)) {
                    list = list.filter(s => s !== symbol);
                    updateStar(false);
                } else {
                    list.push(symbol);
                    updateStar(true);
                }
                chrome.storage.local.set({ featuredTickers: list });
            });
        };
    } else if (toggleBtn) {
        toggleBtn.style.display = 'none';
    }

    // Function to toggle side panel
    const toggleSidePanel = (type, url) => {
        const isClosed = sidePanel.style.width === '0px' || sidePanel.style.width === '';

        // Reset buttons
        const bubbleBtn = modal.querySelector('#clipx-view-bubble');
        const dexBtn = modal.querySelector('#clipx-view-dex');
        const gmgnBtn = modal.querySelector('#clipx-view-gmgn');
        if (bubbleBtn) bubbleBtn.style.border = 'none';
        if (dexBtn) dexBtn.style.border = 'none';
        if (gmgnBtn) gmgnBtn.style.border = 'none';

        if (!isClosed && sidePanel.dataset.activeType === type) {
            // Close if clicking same type
            sidePanel.style.width = '0px';
            sidePanel.style.opacity = '0';
            content.style.borderRight = '1px solid transparent';
            sidePanel.dataset.activeType = '';
            setTimeout(() => { sidePanel.innerHTML = ''; }, 300); // Clear after transition
            return;
        }

        // Open or Switch
        sidePanel.style.width = '800px';
        sidePanel.style.opacity = '1';
        content.style.borderRight = '1px solid #27272a';
        sidePanel.dataset.activeType = type;

        // Highlight active button
        if (type === 'bubble' && bubbleBtn) bubbleBtn.style.border = '1px solid #fff';
        if (type === 'dex' && dexBtn) dexBtn.style.border = '1px solid #fff';
        if (type === 'gmgn' && gmgnBtn) gmgnBtn.style.border = '1px solid #fff';

        // Content Generation
        let panelContent = '';
        let title = '';
        let externalLink = '';

        if (type === 'dex') {
            title = 'DexScreener';
            externalLink = _urls.dex;
        } else if (type === 'gmgn') {
            title = 'GMGN.ai (KOLs)';
            externalLink = _urls.gmgn;
        } else {
            title = 'Bubblemaps';
            externalLink = _urls.bubble;
        }

        panelContent = `
            <div style="height: 100%; display: flex; flex-direction: column;">
                <div style="padding: 12px; border-bottom: 1px solid #27272a; display: flex; justify-content: space-between; align-items: center; background: #09090b;">
                    <span style="font-size: 12px; font-weight: 600; color: #fff;">${title}</span>
                    <div style="display: flex; gap: 8px;">
                            <a href="${externalLink}" target="_blank" style="font-size: 10px; color: #a1a1aa; text-decoration: none;">Open New Tab ↗</a>
                            <button id="clipx-side-close" style="background: none; border: none; color: #a1a1aa; cursor: pointer; font-size: 14px;">✕</button>
                    </div>
                </div>
                <div style="flex: 1; position: relative; background: #000;">
                    <iframe src="${url}" style="width: 100%; height: 100%; border: none;" allow="clipboard-write; fullscreen"></iframe>
                </div>
            </div>
        `;

        sidePanel.innerHTML = panelContent;

        // Event Listeners for Panel Actions
        const closeBtn = sidePanel.querySelector('#clipx-side-close');
        if (closeBtn) {
            closeBtn.onclick = () => {
                sidePanel.style.width = '0px';
                sidePanel.style.opacity = '0';
                content.style.borderRight = '1px solid transparent';
                sidePanel.dataset.activeType = '';
            };
        }
    };

    // --- Settings & Presets Logic ---
    let currentSettings = {
        slippage: 1,
        gas: 1,
        buyPresets: [0.05, 0.1, 0.2]
    };

    const loadSettings = () => {
        chrome.storage.local.get(['clipx_slip', 'clipx_gas', 'clipx_buy_presets'], (res) => {
            if (res.clipx_slip) currentSettings.slippage = parseFloat(res.clipx_slip);
            if (res.clipx_gas) currentSettings.gas = parseFloat(res.clipx_gas);
            if (res.clipx_buy_presets) currentSettings.buyPresets = res.clipx_buy_presets;
            renderTradeButtons();
        });
    };

    const renderTradeButtons = () => {
        const container = modal.querySelector('#clipx-trade-buttons-container');
        if (!container) return;

        let isUnbonded = false;
        let isXMode = false;

        try {
            if (modal.dataset.bondingInfo) {
                const data = JSON.parse(modal.dataset.bondingInfo);
                isUnbonded = !data.liquidityAdded;
                isXMode = data.isXMode;
            }
        } catch (e) { console.error('Error parsing bonding info:', e); }

        if (isXMode) {
            container.innerHTML = `
                <div style="padding: 12px; background: rgba(236, 72, 153, 0.1); border: 1px solid rgba(236, 72, 153, 0.3); border-radius: 6px; text-align: center;">
                    <div style="font-size: 12px; font-weight: 700; color: #f472b6; margin-bottom: 4px;">X Mode Restricted</div>
                    <div style="font-size: 10px; color: #fbcfe8;">This token is in X Mode and can only be traded via Binance MPC Wallet.</div>
                </div>
            `;
            return;
        }

        const buyColor = isUnbonded ? '#c084fc' : '#34d399';
        const buyBg = isUnbonded ? 'rgba(192, 132, 252, 0.1)' : 'rgba(16, 185, 129, 0.1)';
        const buyBorder = isUnbonded ? 'rgba(192, 132, 252, 0.2)' : 'rgba(16, 185, 129, 0.2)';
        const buyLabel = isUnbonded ? 'Buy (AMAP)' : 'Buy';

        container.innerHTML = `
            <!-- Buy Row -->
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
                ${currentSettings.buyPresets.map(amt => `
                    <button class="clipx-trade-btn" data-type="buy" data-amount="${amt}" style="background: ${buyBg}; border: 1px solid ${buyBorder}; color: ${buyColor}; padding: 8px; border-radius: 8px; font-size: 11px; cursor: pointer; transition: all 0.2s; font-weight: 700; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                        ${buyLabel} ${amt} ${_urls.nativeSymbol}
                    </button>
                `).join('')}
            </div>
            <!-- Sell Row (Fixed) -->
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 4px;">
                ${[25, 50, 100].map(pct => `
                    <button class="clipx-trade-btn" data-type="sell" data-amount="${pct}" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: #f87171; padding: 8px; border-radius: 8px; font-size: 11px; cursor: pointer; transition: all 0.2s; font-weight: 700; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                        Sell ${pct}%
                    </button>
                `).join('')}
            </div>
            ${isUnbonded ? '<div style="font-size: 9px; color: #a1a1aa; text-align: center; margin-top: 4px;">Four.Meme Unbonded • Standard Fees Apply</div>' : ''}
        `;

        attachTradeListeners();
    };

    const attachTradeListeners = () => {
        const tradeBtns = modal.querySelectorAll('.clipx-trade-btn');
        tradeBtns.forEach(btn => {
            btn.onclick = async () => {
                const type = btn.dataset.type;
                const amt = btn.dataset.amount;
                // Use currentSettings
                const slip = currentSettings.slippage;
                const gas = currentSettings.gas;

                const originalText = btn.innerText;
                btn.innerText = '⏳';
                btn.disabled = true;

                // For sell operations, we need to get the token balance first and calculate the actual amount
                let actualAmount = amt;
                let isPercentage = false;

                if (type === 'sell') {
                    try {
                        const storage = await chrome.storage.local.get(['userAddress', 'nativeWallet', 'solWallet']);
                        const walletAddress = chain === 'sol'
                            ? (storage.solWallet && storage.solWallet.address)
                            : (storage.userAddress || (storage.nativeWallet && storage.nativeWallet.address));

                        if (walletAddress) {
                            const tokBalAction = chain === 'sol' ? 'getSolTokenBalance' : 'getTokenBalance';
                            const balanceResponse = await new Promise((resolve) => {
                                chrome.runtime.sendMessage({
                                    action: tokBalAction,
                                    walletAddress: walletAddress,
                                    tokenAddress: address
                                }, resolve);
                            });

                            if (balanceResponse && balanceResponse.success && balanceResponse.balance) {
                                // Calculate actual amount based on percentage
                                const percentage = parseFloat(amt);
                                const tokenBalance = parseFloat(balanceResponse.balance);
                                actualAmount = (tokenBalance * percentage / 100).toString();
                                console.log(`[ClipX] Selling ${percentage}% of ${tokenBalance} = ${actualAmount}`);
                            } else {
                                console.warn('[ClipX] Could not fetch token balance, sending percentage to server');
                                isPercentage = true;
                            }
                        } else {
                            console.warn('[ClipX] No wallet address found, sending percentage to server');
                            isPercentage = true;
                        }
                    } catch (error) {
                        console.error('[ClipX] Error calculating sell amount:', error);
                        isPercentage = true; // Fallback to percentage mode
                    }
                }

                const swapAction = chain === 'sol' ? 'solSwap' : 'swap';
                chrome.runtime.sendMessage({
                    action: swapAction,
                    tokenAddress: address,
                    amount: actualAmount,
                    type: type,
                    slippage: slip,
                    gasPrice: gas,
                    isPercentage: isPercentage
                }, (response) => {
                    if (response && response.success) {
                        playSuccessSound(); // Play sound on success
                        btn.innerText = '✅';
                        btn.style.borderColor = '#10b981';
                        setTimeout(() => {
                            btn.innerText = originalText;
                            btn.disabled = false;
                            btn.style.borderColor = (type === 'buy') ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)';
                        }, 2000);
                        updateBnbBalance(); // Refresh BNB balance after trade
                        updateTokenBalance(); // Refresh token balance after trade
                    } else {
                        btn.innerText = '❌';
                        btn.title = response.error || 'Failed';
                        btn.style.borderColor = '#ef4444';
                        setTimeout(() => {
                            btn.innerText = originalText;
                            btn.disabled = false;
                            btn.style.borderColor = (type === 'buy') ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)';
                        }, 2000);
                    }
                });
            };
        });
    };

    // Settings Toggle Logic
    const settingsBtn = modal.querySelector('#clipx-trade-settings-btn');
    const settingsPanel = modal.querySelector('#clipx-settings-panel');
    const saveSettingsdBtn = modal.querySelector('#clipx-save-settings');
    const cancelSettingsBtn = modal.querySelector('#clipx-cancel-settings');

    if (settingsBtn) {
        settingsBtn.onclick = () => {
            // Populate inputs
            modal.querySelector('#clipx-set-slip').value = currentSettings.slippage;
            modal.querySelector('#clipx-set-gas').value = currentSettings.gas;
            // Handle potentially undefined presets gracefully
            const presets = currentSettings.buyPresets || [0.1, 0.5, 1.0];
            modal.querySelector('#clipx-set-buy1').value = presets[0];
            modal.querySelector('#clipx-set-buy2').value = presets[1];
            modal.querySelector('#clipx-set-buy3').value = presets[2];
            settingsPanel.style.display = 'block';
        };
    }

    if (cancelSettingsBtn) {
        cancelSettingsBtn.onclick = () => {
            settingsPanel.style.display = 'none';
        };
    }

    if (saveSettingsdBtn) {
        saveSettingsdBtn.onclick = () => {
            const newSlip = parseFloat(modal.querySelector('#clipx-set-slip').value) || 1;
            const newGas = parseFloat(modal.querySelector('#clipx-set-gas').value) || 1;
            const b1 = parseFloat(modal.querySelector('#clipx-set-buy1').value) || 0.1;
            const b2 = parseFloat(modal.querySelector('#clipx-set-buy2').value) || 0.5;
            const b3 = parseFloat(modal.querySelector('#clipx-set-buy3').value) || 1.0;

            const newSettings = {
                clipx_slip: newSlip,
                clipx_gas: newGas,
                clipx_buy_presets: [b1, b2, b3]
            };

            chrome.storage.local.set(newSettings, () => {
                currentSettings.slippage = newSlip;
                currentSettings.gas = newGas;
                currentSettings.buyPresets = [b1, b2, b3];
                renderTradeButtons();
                settingsPanel.style.display = 'none';
            });
        };
    }

    // Initialize
    loadSettings();

    // --- Helpers ---

    const updateBnbBalance = () => {
        console.log('[ClipX] Attempting to fetch BNB balance...');
        chrome.storage.local.get(['userAddress', 'nativeWallet', 'cachedBalance', 'authToken'], (res) => {
            // Use the same logic as portfolio section (line 606)
            const walletAddress = res.userAddress ||
                (res.nativeWallet && res.nativeWallet.address) ||
                (res.cachedBalance && res.cachedBalance.wallet && res.cachedBalance.wallet.address);

            console.log('[ClipX] Wallet address:', walletAddress);
            console.log('[ClipX] Auth token:', res.authToken);
            console.log('[ClipX] Storage data:', res);

            if (walletAddress) {
                chrome.runtime.sendMessage({ action: 'getBnbBalance', walletAddress: walletAddress }, (resp) => {
                    console.log('[ClipX] BNB Balance response:', resp);
                    const balEl = modal.querySelector('#clipx-quick-bal');
                    console.log('[ClipX] Balance element found:', !!balEl);

                    if (balEl && resp && resp.success) {
                        const bal = parseFloat(resp.balance);
                        balEl.textContent = `${bal.toFixed(3)} BNB`;
                        balEl.style.display = 'block';
                        balEl.style.color = '#fbbf24';
                        console.log('[ClipX] Balance displayed:', bal);
                    } else {
                        console.log('[ClipX] Failed to display balance. Element:', !!balEl, 'Response:', resp);
                        if (balEl) {
                            balEl.textContent = 'Bal: --';
                            balEl.style.display = 'block';
                            balEl.style.color = '#ef4444';
                        }
                    }
                });
            } else {
                console.log('[ClipX] No wallet address found in storage');
                const balEl = modal.querySelector('#clipx-quick-bal');
                if (balEl) {
                    balEl.textContent = 'No Wallet';
                    balEl.style.display = 'block';
                    balEl.style.color = '#ef4444';
                }
            }
        });
    };


    const updateTokenBalance = () => {
        console.log('[ClipX] Attempting to fetch token balance...');
        chrome.storage.local.get(['userAddress', 'nativeWallet', 'cachedBalance', 'authToken'], (res) => {
            const walletAddress = res.userAddress ||
                (res.nativeWallet && res.nativeWallet.address) ||
                (res.cachedBalance && res.cachedBalance.wallet && res.cachedBalance.wallet.address);

            const portDiv = modal.querySelector('#clipx-portfolio');
            const portBal = modal.querySelector('#clipx-portfolio-bal');

            if (walletAddress && portDiv && portBal) {
                // Show loading state
                portBal.textContent = 'Updating...';
                portDiv.style.display = 'block';

                chrome.runtime.sendMessage({
                    action: 'getTokenBalance',
                    tokenAddress: address,
                    walletAddress: walletAddress
                }, (resp) => {
                    if (resp && resp.success) {
                        const bal = parseFloat(resp.balance);
                        if (bal > 0) {
                            // Format balance
                            let fmtBal = bal < 0.001 ? bal.toFixed(6) : bal.toFixed(2);
                            if (bal > 1000000) fmtBal = (bal / 1000000).toFixed(2) + 'M';

                            // Use symbol if available
                            const currentSym = (displaySymbol.replace('$', '') !== 'Contract') ? displaySymbol.replace('$', '') : 'TOKENS';
                            portBal.textContent = fmtBal + ' ' + currentSym;

                            modal.dataset.balance = bal;
                            updatePortfolioValue();
                            portDiv.style.display = 'block';
                        } else {
                            // If balance is 0, hide
                            portDiv.style.display = 'none';
                        }
                    } else {
                        portDiv.style.display = 'none';
                    }
                });
            }
        });
    };


    // Initial balance fetch
    updateBnbBalance();

    // Refresh balance button handler
    const quickRefreshBtn = modal.querySelector('#clipx-quick-refresh');
    if (quickRefreshBtn) {
        quickRefreshBtn.onclick = () => {
            quickRefreshBtn.style.transform = 'rotate(360deg)';
            setTimeout(() => { quickRefreshBtn.style.transform = ''; }, 300);
            updateBnbBalance();
        };
    }

    const playSuccessSound = () => {
        try {
            // Use custom kaching.mp3 sound file
            const soundUrl = chrome.runtime.getURL('src/kaching.mp3');
            const audio = new Audio(soundUrl);
            audio.volume = 1.0; // Max volume
            audio.play().catch(e => console.log('[ClipX] Audio play failed:', e));
        } catch (e) {
            console.log('[ClipX] Sound error:', e);
        }
    };

    // Helper to update portfolio value
    const updatePortfolioValue = () => {
        const bal = parseFloat(modal.dataset.balance || 0);
        const price = parseFloat(modal.dataset.price || 0);
        const valEl = modal.querySelector('#clipx-portfolio-val');
        if (bal > 0 && price > 0 && valEl) {
            const val = bal * price;
            valEl.textContent = '≈ $' + val.toFixed(2);
        }
    };

    // Fetch Token Info (MC, Symbol fix)
    chrome.runtime.sendMessage({ action: 'fetchTokenInfo', address: address }, (info) => {
        if (info && info.success) {
            // Update Header with MC
            const headerTitle = modal.querySelector('h3');
            if (headerTitle) {
                const sym = info.symbol || symbol || 'Contract';
                let mcHtml = '';
                if (info.marketCapUsd) {
                    const mc = parseFloat(info.marketCapUsd);
                    let fmtMc = '$' + mc.toFixed(0);
                    if (mc >= 1e9) fmtMc = '$' + (mc / 1e9).toFixed(2) + 'B';
                    else if (mc >= 1e6) fmtMc = '$' + (mc / 1e6).toFixed(2) + 'M';
                    else if (mc >= 1e3) fmtMc = '$' + (mc / 1e3).toFixed(2) + 'K';

                    mcHtml += `<span style="font-size: 11px; color: #a1a1aa; font-weight: 400; background: #27272a; padding: 2px 6px; border-radius: 4px;">MC: ${fmtMc}</span>`;
                }

                if (info.liquidityUsd) {
                    const liq = parseFloat(info.liquidityUsd);
                    let fmtLiq = '$' + liq.toFixed(0);
                    if (liq >= 1e9) fmtLiq = '$' + (liq / 1e9).toFixed(2) + 'B';
                    else if (liq >= 1e6) fmtLiq = '$' + (liq / 1e6).toFixed(2) + 'M';
                    else if (liq >= 1e3) fmtLiq = '$' + (liq / 1e3).toFixed(2) + 'K';

                    mcHtml += `<span style="font-size: 11px; color: #a1a1aa; font-weight: 400; background: #27272a; padding: 2px 6px; border-radius: 4px; margin-left: 4px;">Liq: ${fmtLiq}</span>`;
                }

                if (info.pairCreatedAt) {
                    const ageMs = Date.now() - info.pairCreatedAt;
                    const ageMins = Math.floor(ageMs / 60000);
                    let ageText = ageMins + 'm ago';
                    let ageColor = '#4ade80'; // Green for very new? Or maybe warning? Usually new = risky but exciting. 
                    // Let's stick to neutral/info colors but highlight "NEW" if very fresh.

                    if (ageMins >= 1440) { // > 24h
                        ageText = Math.floor(ageMins / 1440) + 'd ago';
                        ageColor = '#a1a1aa';
                    } else if (ageMins >= 60) {
                        ageText = Math.floor(ageMins / 60) + 'h ago';
                        ageColor = '#fbbf24'; // Yellow < 24h
                    } else {
                        ageColor = '#f472b6'; // Pink < 1h
                    }

                    mcHtml += `<span style="font-size: 11px; color: ${ageColor}; font-weight: 600; background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); margin-left: 4px; display: inline-flex; align-items: center; gap: 4px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>${ageText}</span>`;
                }

                headerTitle.innerHTML = `<h3 style="margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.5px;">Risk Check</h3><div style="font-size: 12px; color: #a1a1aa; font-weight: 500; display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-top: 4px;">$${sym} <span style="opacity: 0.5;">•</span> ${mcHtml}</div>`;

            }

            // Store price for portfolio value
            if (info.priceUsd) {
                modal.dataset.price = info.priceUsd;
                updatePortfolioValue();
            }
        }
    });

    // Fetch User Balance - Check all possible wallet sources
    chrome.storage.local.get(['userAddress', 'nativeWallet', 'cachedBalance', 'authToken'], (res) => {
        // Try multiple sources for wallet address
        const walletAddress = res.userAddress ||
            (res.nativeWallet && res.nativeWallet.address) ||
            (res.cachedBalance && res.cachedBalance.wallet && res.cachedBalance.wallet.address);

        const isLoggedIn = !!res.authToken;
        const portDiv = modal.querySelector('#clipx-portfolio');
        const portBal = modal.querySelector('#clipx-portfolio-bal');

        console.log('[ClipX] Portfolio check - Logged in:', isLoggedIn, 'Wallet:', walletAddress);

        if (walletAddress) {
            // Show loading state
            portDiv.style.display = 'block';
            portBal.textContent = 'Scanning...';

            chrome.runtime.sendMessage({
                action: 'getTokenBalance',
                tokenAddress: address,
                walletAddress: walletAddress
            }, (resp) => {
                if (resp && resp.success) {
                    const bal = parseFloat(resp.balance);
                    if (bal > 0) {
                        // Format balance
                        let fmtBal = bal < 0.001 ? bal.toFixed(6) : bal.toFixed(2);
                        if (bal > 1000000) fmtBal = (bal / 1000000).toFixed(2) + 'M';

                        // Use symbol if available
                        const currentSym = (displaySymbol.replace('$', '') !== 'Contract') ? displaySymbol.replace('$', '') : 'TOKENS';
                        portBal.textContent = fmtBal + ' ' + currentSym;

                        modal.dataset.balance = bal;
                        updatePortfolioValue();
                    } else {
                        // If balance is 0, hide or show 0
                        portDiv.style.display = 'none';
                    }
                } else {
                    portDiv.style.display = 'none';
                }
            });
        } else if (isLoggedIn) {
            // Logged in but no cached wallet - try fetching from dashboard
            portDiv.style.display = 'block';
            portBal.textContent = 'Fetching wallet...';

            chrome.runtime.sendMessage({ action: 'getDashboard' }, (dashResp) => {
                if (dashResp && dashResp.success && dashResp.wallet && dashResp.wallet.address) {
                    const fetchedAddress = dashResp.wallet.address;
                    // Now fetch balance with the fetched address
                    chrome.runtime.sendMessage({
                        action: 'getTokenBalance',
                        tokenAddress: address,
                        walletAddress: fetchedAddress
                    }, (resp) => {
                        if (resp && resp.success) {
                            const bal = parseFloat(resp.balance);
                            if (bal > 0) {
                                let fmtBal = bal < 0.001 ? bal.toFixed(6) : bal.toFixed(2);
                                if (bal > 1000000) fmtBal = (bal / 1000000).toFixed(2) + 'M';
                                const currentSym = (displaySymbol.replace('$', '') !== 'Contract') ? displaySymbol.replace('$', '') : 'TOKENS';
                                portBal.textContent = fmtBal + ' ' + currentSym;
                                modal.dataset.balance = bal;
                                updatePortfolioValue();
                            } else {
                                portDiv.style.display = 'none';
                            }
                        } else {
                            portDiv.style.display = 'none';
                        }
                    });
                } else {
                    portDiv.style.display = 'none';
                }
            });
        } else {
            // Not logged in - Show Connect Message but keep it subtle
            portDiv.style.display = 'block';
            portDiv.innerHTML = `
                <div style="font-size: 12px; color: #a1a1aa; display: flex; align-items: center; justify-content: space-between;">
                    <span style="display: flex; align-items: center; gap: 6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Connect wallet to view balance</span>
                    <button id="clipx-connect-link" style="background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.3); color: #c4b5fd; border-radius: 6px; cursor: pointer; padding: 4px 10px; font-weight: 600; font-size: 11px; transition: all 0.2s;">Link Wallet</button>
                </div>
            `;
            const connBtn = portDiv.querySelector('#clipx-connect-link');
            if (connBtn) {
                connBtn.onclick = () => {
                    // Open ClipX login popup
                    const width = 500;
                    const height = 700;
                    const left = (screen.width - width) / 2;
                    const top = (screen.height - height) / 2;
                    window.open(`${API_BASE.replace(/\/$/, '')}/?autoLogin=true`, 'ClipX Login', `width=${width},height=${height},left=${left},top=${top}`);
                };
            }
        }
    });

    // Fetch Risk — dispatch to SOL or BNB handler
    const riskAction = chain === 'sol' ? 'getSolRisk' : 'checkTokenRisk';
    const riskPayload = chain === 'sol' ? { action: riskAction, mint: address } : { action: riskAction, address };
    chrome.runtime.sendMessage(riskPayload, (response) => {
        const loading = modal.querySelector('#clipx-risk-loading');
        const resultDiv = modal.querySelector('#clipx-risk-result');

        if (loading) loading.style.display = 'none';
        if (!resultDiv) return;
        resultDiv.style.display = 'block';

        // Fetch Social Metrics concurrently
        chrome.runtime.sendMessage({ action: 'fetchSocialMetrics', address, symbol }, (soc) => {
            const socLoad = modal.querySelector('#clipx-social-loading');
            const socCont = modal.querySelector('#clipx-social-content');
            if (socLoad) socLoad.style.display = 'none';
            if (!socCont) return;
            if (soc && soc.success && soc.metrics) {
                const m = soc.metrics;
                const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n;
                const ta = Math.floor((Date.now() - m.lastUpdated) / 60000);
                const tt = ta < 1 ? 'just now' : ta + ' min ago';
                let sc = '#a1a1aa', sl = 'Neutral', sb = '#52525b';
                if (m.sentiment > 20) { sc = '#10b981'; sl = 'Bullish'; sb = 'linear-gradient(90deg, #10b981, #34d399)'; }
                else if (m.sentiment < -20) { sc = '#ef4444'; sl = 'Bearish'; sb = 'linear-gradient(90deg, #ef4444, #f87171)'; }
                const sw = Math.abs(m.sentiment);
                socCont.innerHTML = ('\u003cdiv style="display:flex;justify-content:space-between;margin-bottom:8px"\u003e\u003cspan style="color:#a1a1aa;font-size:12px"\u003e🐦 Mentions (24h)\u003c/span\u003e\u003cspan style="color:#1d9bf0;font-weight:600;font-size:12px"\u003e' + fmt(m.twitterMentions24h) + '\u003c/span\u003e\u003c/div\u003e' +
                    (m.trendingRank && m.trendingRank <= 100 ? '\u003cdiv style="margin-bottom:8px"\u003e\u003cspan style="background:linear-gradient(135deg,#ff6b6b,#ff8e53);color:white;padding:4px 8px;border-radius:12px;font-size:10px;font-weight:700"\u003e🔥 #' + m.trendingRank + ' Trending\u003c/span\u003e\u003c/div\u003e' : '') +
                    '\u003cdiv style="margin-bottom:8px"\u003e\u003cdiv style="display:flex;justify-content:space-between;margin-bottom:4px"\u003e\u003cspan style="color:#a1a1aa;font-size:11px"\u003eSentiment\u003c/span\u003e\u003cspan style="color:' + sc + ';font-size:11px;font-weight:600"\u003e' + (m.sentiment > 0 ? '+' : '') + m.sentiment + ' ' + sl + '\u003c/span\u003e\u003c/div\u003e\u003cdiv style="height:4px;background:#27272a;border-radius:2px;overflow:hidden"\u003e\u003cdiv style="height:100%;width:' + sw + '%;background:' + sb + '"\u003e\u003c/div\u003e\u003c/div\u003e\u003c/div\u003e' +
                    (m.socialVolume > 0 ? '\u003cdiv style="display:flex;justify-content:space-between;margin-bottom:8px"\u003e\u003cspan style="color:#a1a1aa;font-size:11px"\u003eSocial Volume\u003c/span\u003e\u003cspan style="color:#8b5cf6;font-size:11px;font-weight:600"\u003e' + fmt(m.socialVolume) + '\u003c/span\u003e\u003c/div\u003e' : '') +
                    '\u003cdiv style="font-size:9px;color:#52525b;text-align:center;margin-top:8px"\u003eUpdated ' + tt + ' • Powered by ' + m.source + '\u003c/div\u003e');
                socCont.style.display = 'block';
            } else { socCont.innerHTML = '\u003cdiv style="text-align:center;padding:12px;color:#52525b;font-size:11px"\u003eNo social data available\u003c/div\u003e'; socCont.style.display = 'block'; }
        });

        if (response && response.success && response.data) {
            const data = response.data;
            const isSafe = !data.is_honeypot && parseFloat(data.buy_tax) < 10 && parseFloat(data.sell_tax) < 10;

            resultDiv.innerHTML = `
                <div style="margin-bottom: 20px; padding: 12px 16px; background: ${isSafe ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}; border: 1px solid ${isSafe ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}; border-radius: 12px; display: flex; align-items: center; justify-content: start; gap: 12px; box-shadow: 0 4px 12px ${isSafe ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)'};">
                    <div style="font-weight: 800; color: ${isSafe ? '#34d399' : '#f87171'}; font-size: 15px; display: flex; align-items: center; gap: 6px;">
                        ${isSafe ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Likely Safe' : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> Caution'}
                    </div>
                    <div style="width: 1px; height: 20px; background: ${isSafe ? '#34d399' : '#f87171'}; opacity: 0.2;"></div>
                    <div style="font-size: 12px; color: ${isSafe ? '#6ee7b7' : '#fca5a5'}; font-weight: 500;">
                        ${isSafe ? 'Contract looks clean.' : 'Potential risks found in contract.'}
                    </div>
                </div>
                
                <div style="margin-top: 20px; padding-top: 16px; position: relative;">
                    <div style="position: absolute; top: 0; left: -24px; right: -24px; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);"></div>
                    <div style="display: none; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                        <div style="font-size: 14px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 6px;">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                            Holders <span id="clipx-holder-count" style="font-size: 11px; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 10px; font-weight: 500;">${data.holder_count ? (!isNaN(Number(data.holder_count)) ? Number(data.holder_count).toLocaleString() : data.holder_count) : 'Loading...'}</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <div id="clipx-holder-source" style="display: none; font-size: 10px; color: #52525b; background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">Loading...</div>
                        </div>
                    </div>
                    
                    <div style="display: none; margin-bottom: 12px; background: rgba(0,0,0,0.2); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.03); justify-content: space-between; align-items: center;">
                        <span style="font-size: 11px; color: #a1a1aa; font-weight: 500;">Top 10 Concentration</span>
                        <div id="clipx-top10-percent" style="font-size: 13px; font-weight: 700; color: #fbbf24;">Loading...</div>
                    </div>

                    <div id="clipx-holder-tabs" style="display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;">
                        <div style="color: #a1a1aa; font-size: 11px; text-align: center; width: 100%;">Loading filters...</div>
                    </div>

                    <div id="clipx-kol-holders" style="margin-bottom: 16px; min-height: 200px; background: rgba(0,0,0,0.2); border-radius: 12px; border: 1px solid rgba(255,255,255,0.03); padding: 8px;">
                        <div style="color: #a1a1aa; font-size: 11px; text-align: center; padding-top: 40px;">Loading holder data...</div>
                    </div>
                </div>

                <div style="margin-top: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                    <button id="clipx-view-binance" style="display: block; text-align: center; background: linear-gradient(135deg, #F0B90B 0%, #D4A50A 100%); color: #000; padding: 6px 8px; border-radius: 6px; border: none; font-weight: 600; font-size: 10px; cursor: pointer;">
                        Binance Web3 ↗
                    </button>
                    <button id="clipx-view-bubble" style="display: block; text-align: center; background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); color: white; padding: 6px 8px; border-radius: 6px; border: none; font-weight: 600; font-size: 10px; cursor: pointer;">
                        Bubblemaps ❐
                    </button>
                    <button id="clipx-view-dex" style="display: block; text-align: center; background: linear-gradient(135deg, #00d395 0%, #00b37d 100%); color: #000; padding: 6px 8px; border-radius: 6px; border: none; font-weight: 600; font-size: 10px; cursor: pointer;">
                        DexScreener ❐
                    </button>
                    <button id="clipx-view-gmgn" style="display: block; text-align: center; background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); color: white; padding: 6px 8px; border-radius: 6px; border: none; font-weight: 600; font-size: 10px; cursor: pointer;">
                        GMGN / KOLs ❐
                    </button>
                </div>

                <!-- Quick Actions -->
                <div style="margin-top: 10px; display: flex; gap: 6px;">
                    <button id="clipx-copy-ca" style="flex: 1; background: #18181b; border: 1px solid #27272a; color: #a1a1aa; padding: 6px; border-radius: 6px; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; transition: all 0.2s;">
                        📋 Copy CA
                    </button>
                    <a id="clipx-search-btn" href="https://twitter.com/search?q=${address}&src=typed_query" target="_blank" style="flex: 1; background: #18181b; border: 1px solid #27272a; color: #a1a1aa; padding: 6px; border-radius: 6px; font-size: 10px; cursor: pointer; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 4px; transition: all 0.2s;">
                        🐦 Search CA
                    </a>
                </div>

                <!-- Social Metrics Section (at bottom) -->
                <div id="clipx-social-metrics" style="margin-top: 16px; border-top: 1px solid #27272a; padding-top: 12px;">
                    <div style="font-size: 13px; font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
                        📊 Social Metrics
                        <div id="clipx-social-loading" style="width: 12px; height: 12px; border: 2px solid #27272a; border-top-color: #8b5cf6; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                    </div>
                    <div id="clipx-social-content" style="display: none;"></div>
                </div>

                <div style="margin-top: 12px; font-size: 10px; color: #52525b; text-align: center;">
                    Powered by Bubblemaps & Faster100x
                </div>
            `;

            // Update holder data source indicator
            const updateHolderSourceIndicator = (source) => {
                const sourceEl = modal.querySelector('#clipx-holder-source');
                if (sourceEl && source) {
                    const isGmgn = source === 'GMGN';
                    const isUnavailable = source === 'Unavailable';
                    sourceEl.textContent = source;
                    sourceEl.style.color = isGmgn ? '#10b981' : (isUnavailable ? '#ef4444' : '#fbbf24');
                    sourceEl.style.borderColor = isGmgn ? '#10b981' : (isUnavailable ? '#ef4444' : '#fbbf24');
                }
            };


            // Set initial data source from response
            if (data.holder_data_source) {
                updateHolderSourceIndicator(data.holder_data_source);
            }

            // Event Listeners for Embed Buttons
            const bubbleBtn = modal.querySelector('#clipx-view-bubble');
            const dexBtn = modal.querySelector('#clipx-view-dex');
            const binanceBtn = modal.querySelector('#clipx-view-binance');
            const gmgnBtn = modal.querySelector('#clipx-view-gmgn');
            const copyCaBtn = modal.querySelector('#clipx-copy-ca');

            if (copyCaBtn) {
                copyCaBtn.onclick = () => {
                    navigator.clipboard.writeText(address).then(() => {
                        const originalText = copyCaBtn.innerHTML;
                        copyCaBtn.innerHTML = '✅ Copied!';
                        copyCaBtn.style.color = '#4ade80';
                        copyCaBtn.style.borderColor = '#4ade80';
                        setTimeout(() => {
                            copyCaBtn.innerHTML = originalText;
                            copyCaBtn.style.color = '#a1a1aa';
                            copyCaBtn.style.borderColor = '#27272a';
                        }, 1500);
                    });
                };
            }

            if (bubbleBtn) {
                bubbleBtn.onclick = () => {
                    toggleSidePanel('bubble', chrome.runtime.getURL(`src/bubble_embed.html?address=${address}&chain=${chain}`));
                };
            }

            if (dexBtn) {
                dexBtn.onclick = () => {
                    toggleSidePanel('dex', _urls.dexEmbed);
                };
            }

            if (gmgnBtn) {
                gmgnBtn.onclick = () => {
                    toggleSidePanel('gmgn', _urls.gmgn);
                };
            }

            if (binanceBtn) {
                if (_urls.binanceToken) {
                    binanceBtn.onclick = () => {
                        const width = 980;
                        const height = 820;
                        const left = window.screen.width - width - 50;
                        const top = (window.screen.height - height) / 2;
                        window.open(
                            _urls.binanceToken,
                            'BinanceWeb3',
                            `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`
                        );
                    };
                } else {
                    binanceBtn.style.display = 'none';
                }
            }

            // FETCH HOLDERS LOGIC - OPTIMIZED
            const kolDiv = modal.querySelector('#clipx-kol-holders');
            const tabsDiv = modal.querySelector('#clipx-holder-tabs');

            let holders = [];
            let dataSource = 'GoPlus';
            let debugState = { loaded: 0 };
            let customLabels = {};

            // Load custom labels
            chrome.storage.local.get(['customLabels'], (result) => {
                if (result.customLabels) {
                    customLabels = result.customLabels;
                }
            });

            // Define render function
            const renderHolderSection = () => {
                if (!kolDiv) return;

                if (holders.length > 0) {
                    // Update holders with custom labels
                    holders.forEach(h => {
                        if (customLabels[h.address.toLowerCase()]) {
                            h.custom_label = customLabels[h.address.toLowerCase()];
                        }
                    });

                    // Calculate Top 10
                    const nonContractHolders = holders.filter(h => !h.is_contract);
                    const top10Percent = nonContractHolders.slice(0, 10).reduce((sum, h) => sum + (parseFloat(h.percent) * 100), 0);
                    const top10Display = modal.querySelector('#clipx-top10-percent');
                    if (top10Display) {
                        top10Display.innerHTML = `Top 10: <span style="color: #fbbf24;">${top10Percent.toFixed(2)}%</span>`;
                    }

                    // Categorize
                    console.log('[ClipX Debug] Content rendering holders:', holders.length);
                    const myKolsDebug = holders.filter(h => h.is_my_kol);
                    console.log('[ClipX Debug] My KOLs found in content:', myKolsDebug.length, myKolsDebug);

                    const myKolHolders = holders.filter(h => h.is_my_kol);
                    const smartHolders = holders.filter(h => h.tag === 'smart_money' || (h.is_kol && !h.twitter_username && h.name));
                    const contractHolders = holders.filter(h => h.is_contract);
                    const whaleHolders = holders.filter(h => !h.is_kol && !h.is_contract && parseFloat(h.percent) * 100 >= 1);

                    // Build Tabs
                    if (tabsDiv) {
                        const tabStyle = 'padding: 6px 12px; border-radius: 20px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.2s; border: 1px solid transparent; display: flex; align-items: center; gap: 4px;';
                        const activeStyle = 'background: rgba(255,255,255,0.1); color: #fff; border-color: rgba(255,255,255,0.2); box-shadow: 0 2px 4px rgba(0,0,0,0.1);';
                        const inactiveStyle = 'background: transparent; color: #a1a1aa;';

                        const myKolCount = myKolHolders.length;
                        const myKolTab = `<div style="${tabStyle} ${activeStyle} color: #f472b6;" data-filter="mykol"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg> My KOL <span style="background: rgba(244,114,182,0.2); padding: 1px 4px; border-radius: 6px; font-size: 9px;">${myKolCount}</span></div>`;

                        tabsDiv.innerHTML =
                            `<div style="${tabStyle} ${inactiveStyle}" data-filter="all">All</div>` +
                            myKolTab +
                            (smartHolders.length > 0 ? `<div style="${tabStyle} ${inactiveStyle}" data-filter="smart"><span style="color: #22d3ee;">🔷 Smart</span> <span style="background: rgba(34,211,238,0.1); color: #a1a1aa; padding: 1px 4px; border-radius: 6px; font-size: 9px;">${smartHolders.length}</span></div>` : '') +
                            (whaleHolders.length > 0 ? `<div style="${tabStyle} ${inactiveStyle}" data-filter="whale"><span style="color: #3b82f6;">🐋 Whale</span> <span style="background: rgba(59,130,246,0.1); color: #a1a1aa; padding: 1px 4px; border-radius: 6px; font-size: 9px;">${whaleHolders.length}</span></div>` : '') +
                            (contractHolders.length > 0 ? `<div style="${tabStyle} ${inactiveStyle}" data-filter="contract"><span style="color: #fbbf24;">📝 Contract</span> <span style="background: rgba(251,191,36,0.1); color: #a1a1aa; padding: 1px 4px; border-radius: 6px; font-size: 9px;">${contractHolders.length}</span></div>` : '');
                    }

                    // Helper to build list
                    const buildHolderList = (list) => {
                        return list.map((h, idx) => {
                            const percent = (parseFloat(h.percent) * 100).toFixed(2);
                            // Use Custom Label if available
                            const displayName = h.custom_label
                                ? `<span style="color: #facc15;">${h.custom_label}</span>`
                                : (h.twitter_name || h.name || h.twitter_username || (h.address.substring(0, 6) + '...' + h.address.substring(38)));

                            const twitterLink = h.twitter_username ? 'https://twitter.com/' + h.twitter_username : null;

                            let badges = '';
                            if (h.is_my_kol) badges += '<span style="color: #f472b6; font-size: 10px; font-weight: bold;" title="My KOL">⭐</span>';
                            if (h.twitter_username) badges += '<span style="color: #22c55e; font-size: 10px;" title="KOL">🟢</span>';
                            if (h.tag === 'smart_money') badges += '<span style="color: #22d3ee; font-size: 10px;" title="Smart Money">🔷</span>';
                            if (h.is_contract) badges += '<span style="color: #fbbf24; font-size: 10px;" title="Contract">📝</span>';
                            if (h.is_locked) badges += '<span style="color: #10b981; font-size: 10px;" title="Locked">🔒</span>';

                            let valueText = '';
                            if (h.balance_derived) {
                                // Show balance for deep scan results
                                const bal = parseFloat(h.balance_derived);
                                if (bal >= 1e6) valueText = (bal / 1e6).toFixed(1) + 'M';
                                else if (bal >= 1e3) valueText = (bal / 1e3).toFixed(1) + 'K';
                                else valueText = bal.toFixed(bal < 1 ? 4 : 0);
                                valueText += ' (Bal)';
                            } else if (h.usd_value > 0) {
                                const val = parseFloat(h.usd_value);
                                if (val >= 1e6) valueText = '$' + (val / 1e6).toFixed(1) + 'M';
                                else if (val >= 1e3) valueText = '$' + (val / 1e3).toFixed(1) + 'K';
                                else valueText = '$' + val.toFixed(0);
                            }

                            const avatarHtml = h.avatar ?
                                `<img src="${h.avatar}" referrerpolicy="no-referrer" style="width: 24px; height: 24px; border-radius: 50%; object-fit: cover; border: 1px solid #27272a;" onerror="this.src='https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'">` :
                                `<div style="width: 24px; height: 24px; border-radius: 50%; background: #27272a; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #a1a1aa;">${idx + 1}</div>`;

                            const profileLink = h.profile_link || twitterLink;
                            const nameStyle = h.is_my_kol ? 'color: #f472b6; text-decoration: none; font-weight: 600; font-size: 11px; display: flex; align-items: center; gap: 3px;' : 'color: #fff; text-decoration: none; font-weight: 500; font-size: 11px; display: flex; align-items: center; gap: 3px;';

                            const nameHtml = profileLink ?
                                `<a href="${profileLink}" target="_blank" style="${nameStyle}">${displayName} ${badges}</a>` :
                                `<span style="color: #fff; font-weight: 400; font-size: 11px; display: flex; align-items: center; gap: 3px;">${displayName} ${badges}</span>`;

                            const rowStyle = h.is_my_kol
                                ? 'display: flex; align-items: center; padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.02); gap: 10px; background: rgba(244, 114, 182, 0.08); border-radius: 8px; margin-bottom: 4px; transition: background 0.2s;'
                                : 'display: flex; align-items: center; padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.02); gap: 10px; transition: background 0.2s; border-radius: 8px; margin-bottom: 2px;';

                            return `<div style="${rowStyle}" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='${h.is_my_kol ? 'rgba(244, 114, 182, 0.08)' : 'transparent'}'">
                                <div style="color: #52525b; font-size: 12px; width: 16px; display: flex; justify-content: center;">${h.is_my_kol ? '⭐' : (h.is_kol ? '🟢' : '')}</div>
                                ${avatarHtml}
                                <div style="flex: 1; min-width: 0;">${nameHtml}</div>
                                <div style="text-align: right; min-width: 60px;">
                                    <div style="font-size: 11px; font-weight: 600; color: #e4e4e7;">${valueText || percent + '%'}</div>
                                    ${valueText ? `<div style="font-size: 9px; color: #a1a1aa; margin-top: 2px;">${percent}%</div>` : ''}
                                </div>
                                <div style="display: flex; gap: 4px; border-left: 1px solid rgba(255,255,255,0.1); padding-left: 8px; margin-left: 4px;">
                                    <button class="clipx-gmgn-btn" data-address="${h.address}" style="cursor: pointer; background: rgba(255,255,255,0.05); border: 1px solid transparent; color: #a1a1aa; font-size: 12px; padding: 4px; border-radius: 6px; transition: all 0.2s; display: flex; align-items: center; justify-content: center;" title="View on GMGN" onmouseover="this.style.background='rgba(59,130,246,0.1)'; this.style.color='#60a5fa'" onmouseout="this.style.background='rgba(255,255,255,0.05)'; this.style.color='#a1a1aa'">⚡</button>
                                    <button class="clipx-tag-btn" data-address="${h.address}" style="cursor: pointer; background: rgba(255,255,255,0.05); border: 1px solid transparent; color: #a1a1aa; font-size: 12px; padding: 4px; border-radius: 6px; transition: all 0.2s; display: flex; align-items: center; justify-content: center;" title="Add Custom Label" onmouseover="this.style.background='rgba(251,191,36,0.1)'; this.style.color='#facc15'" onmouseout="this.style.background='rgba(255,255,255,0.05)'; this.style.color='#a1a1aa'">🏷️</button>
                                </div>
                             </div>`;
                        }).join('');
                    };

                    const footerHtml = `<div style="margin-top: 12px; font-size: 10px; color: #52525b; text-align: center; display: flex; align-items: center; justify-content: center; gap: 4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> Powered by ${dataSource}</div>`;

                    // Custom Label Modal
                    const showLabelModal = (address, currentLabel, onSave) => {
                        const overlay = document.createElement('div');
                        overlay.style.cssText = `
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            background: rgba(0,0,0,0.6);
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            z-index: 100;
                            backdrop-filter: blur(2px);
                        `;

                        const box = document.createElement('div');
                        box.style.cssText = `
                            background: #18181b;
                            border: 1px solid #27272a;
                            border-radius: 8px;
                            padding: 16px;
                            width: 260px;
                            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
                            font-family: 'Inter', sans-serif;
                        `;

                        box.innerHTML = `
                            <h4 style="margin: 0 0 12px 0; font-size: 13px; font-weight: 600; color: #fff;">Edit Label</h4>
                            <div style="font-size: 10px; color: #71717a; margin-bottom: 8px; font-family: monospace;">${address.substring(0, 8)}...${address.substring(36)}</div>
                            <input type="text" id="clipx-label-input" value="${currentLabel}" placeholder="Enter label name..." style="width: 100%; background: #27272a; border: 1px solid #3f3f46; color: #fff; padding: 6px 10px; border-radius: 4px; font-size: 12px; margin-bottom: 12px; box-sizing: border-box; outline: none; transition: border-color 0.2s;">
                            <div style="display: flex; justify-content: flex-end; gap: 8px;">
                                <button id="clipx-label-cancel" style="background: transparent; border: 1px solid #3f3f46; color: #a1a1aa; padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; transition: all 0.2s;">Cancel</button>
                                <button id="clipx-label-save" style="background: #3b82f6; border: none; color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: 500; transition: background 0.2s;">Save</button>
                            </div>
                        `;

                        overlay.appendChild(box);
                        // Append to container to be inside the rounded window
                        const container = modal.querySelector('#clipx-modal-container');
                        if (container) {
                            container.style.position = 'relative'; // Ensure positioning context
                            container.appendChild(overlay);
                        }

                        const input = box.querySelector('#clipx-label-input');
                        const close = () => overlay.remove();

                        input.onfocus = () => input.style.borderColor = '#3b82f6';
                        input.onblur = () => input.style.borderColor = '#3f3f46';

                        box.querySelector('#clipx-label-cancel').onclick = close;
                        box.querySelector('#clipx-label-save').onclick = () => {
                            onSave(input.value.trim());
                            close();
                        };

                        input.onkeydown = (e) => {
                            if (e.key === 'Enter') {
                                onSave(input.value.trim());
                                close();
                            }
                            if (e.key === 'Escape') close();
                        };

                        overlay.onclick = (e) => {
                            if (e.target === overlay) close();
                        };

                        setTimeout(() => input.focus(), 50);
                    };

                    const attachListeners = () => {
                        kolDiv.querySelectorAll('.clipx-gmgn-btn').forEach(btn => {
                            btn.onclick = (e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                const addr = btn.dataset.address;
                                toggleSidePanel('gmgn', _urls.gmgnAddress(addr));
                            };
                        });
                        kolDiv.querySelectorAll('.clipx-tag-btn').forEach(btn => {
                            btn.onclick = (e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                const addr = btn.dataset.address;
                                const currentLabel = customLabels[addr.toLowerCase()] || '';

                                showLabelModal(addr, currentLabel, (newLabel) => {
                                    if (newLabel) {
                                        customLabels[addr.toLowerCase()] = newLabel;
                                    } else {
                                        delete customLabels[addr.toLowerCase()];
                                    }
                                    chrome.storage.local.set({ customLabels }, () => {
                                        renderHolderSection();
                                    });
                                });
                            };
                        });
                    };

                    kolDiv.innerHTML = `<div style="max-height: 200px; overflow-y: auto;">${buildHolderList(holders.slice(0, 50))}</div>${footerHtml}`;
                    attachListeners();

                    // Click handlers
                    if (tabsDiv) {
                        tabsDiv.querySelectorAll('[data-filter]').forEach(tab => {
                            tab.onclick = function () {
                                tabsDiv.querySelectorAll('[data-filter]').forEach(t => {
                                    t.style.background = 'transparent';
                                    t.style.borderColor = 'transparent';
                                    t.style.boxShadow = 'none';
                                    t.style.color = '#a1a1aa';
                                });
                                this.style.background = 'rgba(255,255,255,0.1)';
                                this.style.borderColor = 'rgba(255,255,255,0.2)';
                                this.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
                                this.style.color = this.dataset.filter === 'mykol' ? '#f472b6' : '#fff';

                                let filtered = holders;
                                const filter = this.dataset.filter;
                                if (filter === 'mykol') filtered = myKolHolders;
                                else if (filter === 'smart') filtered = smartHolders;
                                else if (filter === 'whale') filtered = whaleHolders;
                                else if (filter === 'contract') filtered = contractHolders;

                                // Show all My KOLs, limit others to 50
                                const sliceLimit = filter === 'mykol' ? 500 : 50;
                                kolDiv.innerHTML = `<div style="max-height: 200px; overflow-y: auto;">${filtered.length > 0 ? buildHolderList(filtered.slice(0, sliceLimit)) : '<div style="color: #a1a1aa; font-size: 11px; text-align: center; padding: 20px;">No holders in this category</div>'}</div>${footerHtml}`;
                                attachListeners();
                            }
                        });
                    }

                } else {
                    // Empty state
                    kolDiv.innerHTML = '<div style="text-align: center; padding: 20px; color: #a1a1aa; font-size: 11px;">No holder data available</div>';
                }
            };

            // OPTIMIZATION: Initial Render with GoPlus data (if available)
            if (data.holders && data.holders.length > 0) {
                dataSource = 'GoPlus (Preview)';
                holders = data.holders.slice(0, 20).map(h => ({
                    address: h.address || '',
                    percent: h.percent || 0,
                    is_contract: h.is_contract === 1,
                    is_locked: h.is_locked === 1,
                    tag: h.tag || null,
                    name: null,
                    twitter_username: null,
                    twitter_name: null,
                    avatar: null,
                    is_kol: false,
                    usd_value: 0,
                    is_my_kol: false,
                    my_kol_data: null,
                    profile_link: null
                }));
                renderHolderSection();

                // Check local KOLs immediately
                const addresses = holders.map(h => h.address);
                chrome.runtime.sendMessage({ action: 'checkLocalKols', addresses }, (response) => {
                    if (response && response.matches) {
                        let updated = false;
                        holders.forEach(h => {
                            const match = response.matches[h.address.toLowerCase()];
                            if (match) {
                                h.is_my_kol = true;
                                h.my_kol_data = match;
                                h.name = match.kolName || h.name;
                                h.avatar = match.logoUrl || h.avatar;
                                h.profile_link = match.profileLink;
                                updated = true;
                            }
                        });
                        if (updated) {
                            if (response.totalLoaded !== undefined) debugState.loaded = response.totalLoaded;
                            renderHolderSection();
                        }
                    }
                });
            }

            // Fetch holder data — dispatch to SOL or BNB handler
            const holderAction = chain === 'sol' ? 'getSolTopHolders' : 'fetchTopHolders';
            const holderPayload = chain === 'sol' ? { action: holderAction, mint: address } : { action: holderAction, address };
            chrome.runtime.sendMessage(holderPayload, (holderResponse) => {
                if (holderResponse && holderResponse.success && holderResponse.holders && holderResponse.holders.length > 0) {
                    holders = holderResponse.holders;
                    dataSource = 'GMGN.ai';
                    debugState.loaded = holderResponse.debug?.totalKolsLoaded || 0;
                    renderHolderSection();
                }
            });

            // NEW: Fetch Four.Meme Token Info
            chrome.runtime.sendMessage({ action: 'getFourMemeTokenInfo', tokenAddress: address }, (fourMemeResponse) => {
                if (fourMemeResponse && fourMemeResponse.success && fourMemeResponse.isFourMeme) {
                    const data = fourMemeResponse.bondingData;
                    // Store data for other functions (like renderTradeButtons)
                    modal.dataset.bondingInfo = JSON.stringify(data);
                    renderTradeButtons(); // Re-render buttons
                    const headerTitle = modal.querySelector('h3');
                    const riskResultDiv = modal.querySelector('#clipx-risk-result');

                    // Update Header with Bonding Status
                    if (headerTitle) {
                        const existingContent = headerTitle.innerHTML;
                        let badgeColor = data.liquidityAdded ? '#10b981' : '#8b5cf6'; // Green if bonded, Purple if bonding
                        let badgeText = data.liquidityAdded ? 'Bonded (PancakeSwap)' : 'Bonding Curve (Four.Meme)';

                        if (data.isXMode) {
                            badgeColor = '#ec4899'; // Pink for X Mode
                            badgeText = 'X Mode (Exclusive)';
                        }

                        const badgeHtml = `<span style="font-size: 11px; color: #fff; font-weight: 600; background: ${badgeColor}; padding: 2px 6px; border-radius: 4px; margin-left: 4px;">${badgeText}</span>`;

                        // Append to existing header content if not already there
                        if (!headerTitle.innerHTML.includes('Bonded') && !headerTitle.innerHTML.includes('Bonding Curve')) {
                            headerTitle.innerHTML = headerTitle.innerHTML.replace('</div>', ` ${badgeHtml}</div>`);
                        }
                    }

                    // Display Bonding Curve Progress if Unbonded
                    if (!data.liquidityAdded && riskResultDiv) {
                        const progress = data.bondingProgress * 100;
                        const funds = parseFloat(data.funds).toFixed(2);
                        const maxFunds = parseFloat(data.maxFunds).toFixed(2);

                        const curveHtml = `
                            <div style="margin-top: 12px; padding: 10px; background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 8px;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                                    <span style="font-size: 11px; color: #d8b4fe; font-weight: 600;">Bonding Curve Progress</span>
                                    <span style="font-size: 11px; color: #fff; font-weight: 700;">${progress.toFixed(1)}%</span>
                                </div>
                                <div style="height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: 6px;">
                                    <div style="width: ${progress}%; height: 100%; background: linear-gradient(90deg, #8b5cf6, #d8b4fe); transition: width 0.5s ease;"></div>
                                </div>
                                <div style="display: flex; justify-content: space-between; font-size: 10px; color: #a1a1aa;">
                                    <span>Raised: ${funds} BNB</span>
                                    <span>Target: ${maxFunds} BNB</span>
                                </div>
                                ${data.isXMode ? '<div style="margin-top: 8px; font-size: 10px; color: #f472b6; text-align: center;">⚠️ X Mode: Trading restricted to specific wallets</div>' : ''}
                            </div>
                        `;

                        // Insert after the risk status box (first child of riskResultDiv)
                        const firstChild = riskResultDiv.firstElementChild;
                        if (firstChild) {
                            firstChild.insertAdjacentHTML('afterend', curveHtml);
                        } else {
                            riskResultDiv.innerHTML = curveHtml + riskResultDiv.innerHTML;
                        }
                    }

                    // Update Quick Trade Title
                    const quickTradeTitle = modal.querySelector('div[style*="⚡ Quick Trade"]');
                    if (quickTradeTitle && !data.liquidityAdded && !data.isXMode) {
                        quickTradeTitle.textContent = '⚡ Quick Trade (Four.Meme)';
                        quickTradeTitle.style.color = '#c084fc';
                    }
                }
            });

            // NEW: Scan ALL Local KOLs (Background) - Deep check
            chrome.runtime.sendMessage({ action: 'scanAllLocalKols', tokenAddress: address }, (scanResponse) => {
                if (scanResponse && scanResponse.success && scanResponse.holders && scanResponse.holders.length > 0) {
                    const newHolders = scanResponse.holders;
                    const existingAddresses = new Set(holders.map(h => h.address.toLowerCase()));
                    const uniqueNewHolders = newHolders.filter(h => !existingAddresses.has(h.address.toLowerCase()));

                    if (uniqueNewHolders.length > 0) {
                        // Add newly found KOLs to the list
                        holders = [...holders, ...uniqueNewHolders];
                        renderHolderSection();
                    } else {
                        // Update existing entries if they were missed as KOLs
                        let updated = false;
                        holders.forEach(h => {
                            if (!h.is_my_kol) {
                                const match = newHolders.find(nh => nh.address.toLowerCase() === h.address.toLowerCase());
                                if (match) {
                                    h.is_my_kol = true;
                                    h.my_kol_data = match.my_kol_data;
                                    h.name = match.name;
                                    h.avatar = match.avatar;
                                    h.profile_link = match.profile_link;
                                    updated = true;
                                }
                            }
                        });
                        if (updated) renderHolderSection();
                    }
                }
            });
        } else {
            resultDiv.innerHTML = `
                <div style="color: #ef4444; text-align: center;">
                    Failed to fetch risk data.<br>
                    <small>${response?.error || 'Unknown error'}</small>
                </div>
            `;
        }
    });
};

function clipxPlaySwapSuccessSound() {
    try {
        const soundUrl = chrome.runtime.getURL('src/kaching.mp3');
        const audio = new Audio(soundUrl);
        audio.volume = 1.0;
        audio.play().catch(() => {});
    } catch (e) { /* ignore */ }
}

function clipxWalletAddressFromStorage(res) {
    return (res.nativeWallet && res.nativeWallet.address) ||
        res.userAddress ||
        (res.cachedBalance && res.cachedBalance.wallet && res.cachedBalance.wallet.address);
}

function clipxShowTradeButtonError(btn, originalText, message, fallback = 'Swap failed') {
    const errorText = message || fallback;
    btn.title = errorText;
    btn.textContent = 'Error';
    setTimeout(() => {
        if (btn.textContent === 'Error') btn.textContent = originalText;
    }, 1800);
}

function ensureClipxTokenPillStyles() {
    if (document.getElementById('clipx-token-pill-styles')) return;
    const st = document.createElement('style');
    st.id = 'clipx-token-pill-styles';
    st.textContent = `
.clipx-cashtag-pill-row{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin:0 0 4px 0;padding:0;line-height:1.15;max-width:100%;position:relative;z-index:2;}
.clipx-cashtag-pill-row .clipx-token-pill-wrap{margin:0!important;}
.clipx-token-pill-wrap{display:inline-flex;flex-direction:column;align-items:stretch;width:fit-content;max-width:min(100%,320px);min-width:0;vertical-align:baseline;margin:4px 0.08em;box-sizing:border-box;position:relative;}
.clipx-token-pill-main{--clipx-pill-bg:#F0B90B;--clipx-pill-fg:#181A20;display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border-radius:5px;font-size:9px;font-weight:700;letter-spacing:0;line-height:1.25;cursor:pointer;user-select:none;flex:0 0 auto;width:max-content;max-width:min(100%,230px);border:1px solid rgba(0,0,0,0.10);background:var(--clipx-pill-bg);color:var(--clipx-pill-fg);box-shadow:none;transition:filter .15s ease,transform .15s ease,background .15s ease;pointer-events:auto!important;position:relative;z-index:1;overflow:hidden;}
.clipx-token-pill-main:hover{filter:brightness(1.06);}
.clipx-token-pill-main .clipx-ticker{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;font-weight:800;}
.clipx-token-pill-main .clipx-pill-price,.clipx-token-pill-main .clipx-pill-change,.clipx-token-pill-main .clipx-pill-chain-badge{display:none;}
.clipx-token-pill-main .clipx-pill-chain-badge{font-size:8px;font-weight:800;letter-spacing:0.05em;padding:2px 6px;text-transform:uppercase;line-height:1.25;align-items:center;}
.clipx-token-pill-main .clipx-verified-badge{width:9px!important;height:9px!important;font-size:6px!important;margin-left:1px!important;}
.clipx-token-pill-main .clipx-unverified-badge{display:inline-flex;align-items:center;justify-content:center;width:9px;height:9px;font-size:7px;font-weight:900;margin-left:1px;border-radius:9999px;background:rgba(0,0,0,0.18);color:rgba(0,0,0,0.65);line-height:1;cursor:help;}
.clipx-token-pill-main--unlisted{box-shadow:inset 0 0 0 1px rgba(0,0,0,0.18);}
/* Style: Market — compact ticker + price chip. No % change in this style. */
.clipx-token-pill-style-market.clipx-cashtag-pill-row{gap:4px;margin-bottom:4px;}
.clipx-token-pill-main.clipx-token-pill-style-market{background:#0B1220!important;color:#F1F5F9!important;padding:3px 6px 3px 9px;border-radius:5px;border:1px solid rgba(148,163,184,0.18)!important;font-size:9.5px;line-height:1.25;gap:4px;box-shadow:none;}
.clipx-token-pill-main.clipx-token-pill-style-market::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--clipx-pill-bg);}
.clipx-token-pill-main.clipx-token-pill-style-market .clipx-ticker{color:#F8FAFC;font-weight:800;font-size:9.5px;letter-spacing:0;}
.clipx-token-pill-main.clipx-token-pill-style-market .clipx-pill-price:not([data-empty="1"]){display:inline-flex;align-items:center;color:#DDE7F3;font-weight:700;font-size:9px;font-variant-numeric:tabular-nums;padding-left:5px;border-left:1px solid rgba(148,163,184,0.22);}
.clipx-token-pill-main.clipx-token-pill-style-market .clipx-pill-change{display:none!important;}
.clipx-token-pill-main.clipx-token-pill-style-market .clipx-pill-chain-badge{font-size:7.5px;font-weight:800;letter-spacing:0.05em;padding:1px 4px;border-radius:3px;background:rgba(148,163,184,0.14);color:#CBD5E1;}
.clipx-token-pill-main.clipx-token-pill-style-market .clipx-verified-badge{width:9px!important;height:9px!important;font-size:6px!important;background:rgba(16,185,129,0.20)!important;color:#10B981!important;border:1px solid rgba(16,185,129,0.35)!important;}
.clipx-token-pill-main.clipx-token-pill-style-market .clipx-unverified-badge{width:9px;height:9px;font-size:7px;background:rgba(245,158,11,0.18);color:#F59E0B;border:1px solid rgba(245,158,11,0.35);}
/* Style: Chain — two-tone split tag */
.clipx-token-pill-style-chain.clipx-cashtag-pill-row{gap:4px;margin-bottom:4px;}
.clipx-token-pill-main.clipx-token-pill-style-chain{background:#1E293B!important;color:#F8FAFC!important;padding:0!important;border-radius:4px;border:1px solid rgba(248,250,252,0.10)!important;gap:0;font-size:9.5px;line-height:1.2;}
.clipx-token-pill-main.clipx-token-pill-style-chain .clipx-ticker{padding:2px 6px;color:#F8FAFC;font-weight:800;}
.clipx-token-pill-main.clipx-token-pill-style-chain .clipx-pill-chain-badge{display:inline-flex;background:var(--clipx-pill-bg);color:var(--clipx-pill-fg);border-radius:0;padding:2px 6px;font-size:8px;border-left:1px solid rgba(0,0,0,0.20);}
.clipx-token-pill-main.clipx-token-pill-style-chain .clipx-verified-badge{display:none!important;}
/* Style: Micro — solid filled mini pill, ticker only */
.clipx-token-pill-style-micro.clipx-cashtag-pill-row{gap:3px;margin-bottom:2px;}
.clipx-token-pill-main.clipx-token-pill-style-micro{background:var(--clipx-pill-bg)!important;color:var(--clipx-pill-fg)!important;border:1px solid rgba(0,0,0,0.10)!important;padding:1px 5px;font-size:8.5px;font-weight:700;line-height:1.2;border-radius:9999px;box-shadow:none;gap:2px;letter-spacing:0;}
.clipx-token-pill-main.clipx-token-pill-style-micro:hover{filter:brightness(1.08);transform:none;}
.clipx-token-pill-main.clipx-token-pill-style-micro .clipx-ticker::before{content:'\\2022';margin-right:3px;opacity:0.6;}
.clipx-token-pill-main.clipx-token-pill-style-micro .clipx-pill-price,.clipx-token-pill-main.clipx-token-pill-style-micro .clipx-pill-change,.clipx-token-pill-main.clipx-token-pill-style-micro .clipx-pill-chain-badge,.clipx-token-pill-main.clipx-token-pill-style-micro .clipx-verified-badge{display:none!important;}
/* xStocks variant — tokenized US equities on BNB Chain.
   Uses sky-blue accent and forces the xSTOCK badge to always be visible so
   the user can distinguish a tokenized stock from a regular crypto pill. */
.clipx-token-pill-main--xstock .clipx-pill-chain-badge{display:inline-flex!important;background:rgba(14,165,233,0.18);color:#0EA5E9;padding:1px 4px;border-radius:3px;font-size:7.5px;font-weight:800;letter-spacing:0.06em;}
.clipx-token-pill-main--xstock.clipx-token-pill-style-market::before{background:#0EA5E9;}
.clipx-token-pill-main--xstock.clipx-token-pill-style-chain .clipx-pill-chain-badge{background:#0EA5E9!important;color:#fff!important;border-radius:0;padding:2px 6px;font-size:8px;}
.clipx-token-pill-main--xstock.clipx-token-pill-style-micro{background:#0EA5E9!important;color:#FFFFFF!important;border-color:rgba(14,165,233,0.40)!important;}
.clipx-token-pill-main--xstock.clipx-token-pill-style-micro .clipx-pill-chain-badge{display:inline-flex!important;background:rgba(255,255,255,0.16);color:#FFFFFF;padding:0 3px;border-radius:9999px;font-size:7px;letter-spacing:0.04em;margin-left:1px;}
.clipx-token-pill-main--xstock.clipx-token-pill-style-micro .clipx-ticker::before{display:none;}
.clipx-token-pill-expand{width:100%;min-width:0;max-height:0;opacity:0;overflow:hidden;transition:max-height .45s cubic-bezier(0.4,0,0.2,1),opacity .3s ease,margin-top .3s ease,margin-left .3s ease,width .2s ease;flex:0 0 auto;box-sizing:border-box;}
.clipx-token-pill-wrap[data-expanded="0"] .clipx-token-pill-expand{width:0!important;min-width:0!important;margin:0!important;padding:0!important;}
.clipx-token-pill-wrap[data-expanded="1"] .clipx-token-pill-expand{width:100%!important;max-height:420px;opacity:1;margin-top:6px;}
.clipx-token-pill-expand-inner{font-size:11px;font-weight:600;line-height:1.35;padding:12px 12px 10px;border-radius:12px;background:linear-gradient(180deg,#fffbeb 0%,#fef3c7 100%);color:#1a1500;border:1px solid rgba(234,179,8,0.55);word-break:break-all;box-shadow:0 4px 14px rgba(0,0,0,0.12),inset 0 1px 0 rgba(255,255,255,0.5);}
.clipx-token-pill-bal-row{display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(234,179,8,0.35);font-size:10px;font-weight:700;color:#422006;}
.clipx-pill-bal-left{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;flex:1;}
.clipx-pill-bal-right{display:flex;align-items:center;flex-wrap:wrap;gap:6px;flex-shrink:0;margin-left:auto;}
.clipx-pill-bal-bnb,.clipx-pill-bal-tok,.clipx-pill-bal-mc,.clipx-pill-bal-age{background:rgba(242,208,15,0.35);padding:3px 8px;border-radius:9999px;border:1px solid rgba(180,83,9,0.25);font-size:9px;font-weight:700;white-space:nowrap;}
.clipx-pill-bal-refresh{background:transparent;border:none;cursor:pointer;font-size:12px;padding:0 4px;line-height:1;opacity:0.75;flex-shrink:0;}
.clipx-pill-bal-refresh:hover{opacity:1;}
.clipx-token-full-line{font-family:ui-monospace,monospace;font-size:9px;color:#713f12;margin-bottom:8px;}
.clipx-token-pill-trade-grid{display:flex;flex-direction:column;gap:6px;}
.clipx-token-pill-tr-row{display:flex;align-items:flex-start;gap:6px;}
.clipx-pill-row-lbl{flex:0 0 34px;font-size:9px;font-weight:800;text-transform:uppercase;color:#854d0e;padding-top:5px;}
.clipx-pill-btn-group{display:flex;flex-wrap:wrap;gap:4px;flex:1;}
.clipx-pill-buy{font-size:9px;font-weight:800;padding:5px 6px;border-radius:5px;cursor:pointer;border:1px solid rgba(21,128,61,0.35);background:rgba(34,197,94,0.15);color:#14532d;transition:filter .12s;}
.clipx-pill-buy:hover:not(:disabled){filter:brightness(1.05);}
.clipx-pill-sell{font-size:9px;font-weight:800;padding:5px 8px;border-radius:5px;cursor:pointer;border:1px solid rgba(185,28,28,0.35);background:rgba(239,68,68,0.12);color:#991b1b;transition:filter .12s;}
.clipx-pill-sell:hover:not(:disabled){filter:brightness(1.05);}
.clipx-pill-buy:disabled,.clipx-pill-sell:disabled{opacity:0.65;cursor:wait;}
.clipx-token-pill-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;padding-top:6px;border-top:1px solid rgba(234,179,8,0.35);}
.clipx-pill-settings-hint{font-size:8px;font-weight:600;color:#92400e;opacity:0.9;}
.clipx-token-pill-foot .clipx-token-risk{font-size:10px;font-weight:700;padding:5px 10px;border-radius:5px;cursor:pointer;border:1px solid rgba(26,21,0,0.2);background:#f2d00f;color:#1a1500;}
.clipx-token-pill-foot .clipx-token-risk:hover{filter:brightness(1.05);}
.clipx-pill-inline-ca{font-weight:700;opacity:0.82;font-size:0.9em;letter-spacing:-0.015em;}
`;
    document.head.appendChild(st);
}

function clipxFormatShortCa(addr) {
    if (!addr || typeof addr !== 'string' || addr.length < 14) return addr || '';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function clipxFormatMcUsdCompact(mc) {
    if (mc == null || mc === '') return null;
    const n = Number(mc);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
    return `$${n.toFixed(0)}`;
}

/** DexScreener pairCreatedAt: seconds or ms since epoch */
function clipxFormatPairAgeFromDexTs(raw) {
    if (raw == null) return null;
    let ms = Number(raw);
    if (!Number.isFinite(ms)) return null;
    if (ms < 1e12) ms *= 1000;
    const age = Date.now() - ms;
    if (age < 0) return null;
    const minutes = Math.floor(age / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days >= 365) return `${Math.floor(days / 365)}y`;
    if (days >= 30) return `${Math.floor(days / 30)}mo`;
    if (days >= 7) return `${Math.floor(days / 7)}w`;
    if (days >= 1) return `${days}d`;
    if (hours >= 1) return `${hours}h`;
    if (minutes >= 1) return `${minutes}m`;
    return '<1m';
}

function clipxApplyTokenPillBuyLabels(expand) {
    const pillChain = (expand.closest('[data-chain]') || {}).dataset?.chain || 'bnb';
    const sym = pillChain === 'sol' ? 'SOL' : 'BNB';
    chrome.storage.local.get(['clipx_buy_presets'], (res) => {
        const presets = Array.isArray(res.clipx_buy_presets) && res.clipx_buy_presets.length
            ? res.clipx_buy_presets
            : [0.05, 0.1, 0.2];
        expand.querySelectorAll('.clipx-pill-buy').forEach((btn, i) => {
            const amt = presets[i];
            if (amt != null && Number.isFinite(amt) && amt > 0) {
                btn.textContent = `${amt} ${sym}`;
                btn.title = `Buy ${amt} ${sym} (preset ${i + 1} — edit in Risk → Quick Trade → ⚙️)`;
            } else {
                btn.textContent = '—';
                btn.title = 'Set buy presets in Risk analysis → Quick Trade → ⚙️';
            }
        });
    });
}

function clipxRefreshTokenPillBalances(expand, tokenAddress) {
    const pillChain = (expand.closest('[data-chain]') || {}).dataset?.chain || 'bnb';
    const nativeSym = pillChain === 'sol' ? 'SOL' : 'BNB';
    const bnbEl = expand.querySelector('.clipx-pill-bal-bnb');
    const tokEl = expand.querySelector('.clipx-pill-bal-tok');
    if (!bnbEl || !tokEl) return;
    const lab = expand.dataset.clipxTokenLabel || 'Token';
    bnbEl.textContent = `${nativeSym}: …`;
    tokEl.textContent = `${lab}: …`;
    chrome.storage.local.get(['userAddress', 'nativeWallet', 'cachedBalance', 'solWallet'], (res) => {
        const w = pillChain === 'sol'
            ? (res.solWallet && res.solWallet.address)
            : clipxWalletAddressFromStorage(res);
        if (!w) {
            bnbEl.textContent = `${nativeSym}: —`;
            tokEl.textContent = `${lab}: —`;
            return;
        }
        const balAction = pillChain === 'sol' ? 'getSolBalance' : 'getBnbBalance';
        chrome.runtime.sendMessage({ action: balAction, walletAddress: w }, (resp) => {
            if (resp && resp.success) {
                bnbEl.textContent = `${nativeSym}: ${parseFloat(resp.balance).toFixed(4)}`;
            } else {
                bnbEl.textContent = `${nativeSym}: —`;
            }
        });
        const tokAction = pillChain === 'sol' ? 'getSolTokenBalance' : 'getTokenBalance';
        chrome.runtime.sendMessage({
            action: tokAction,
            walletAddress: w,
            tokenAddress: tokenAddress
        }, (resp) => {
            if (resp && resp.success && resp.balance != null) {
                const b = parseFloat(resp.balance);
                const fmt = !Number.isFinite(b) || b === 0 ? '0'
                    : (b >= 1e9 ? b.toExponential(2) : b.toFixed(b < 0.0001 ? 8 : 4));
                tokEl.textContent = `${lab}: ${fmt}`;
            } else {
                tokEl.textContent = `${lab}: 0`;
            }
        });
    });
}

/**
 * Buy / sell using same clipx_slip, clipx_gas, clipx_buy_presets and sell % as Risk modal Quick Trade.
 */
function clipxAttachTokenPillTradeHandlers(expand, tokenAddress) {
    const pillChain = (expand.closest('[data-chain]') || {}).dataset?.chain || 'bnb';

    expand.querySelectorAll('.clipx-pill-sell').forEach((btn) => {
        btn.dataset.origLabel = `${btn.dataset.pct}%`;
    });

    expand.querySelectorAll('.clipx-pill-buy').forEach((btn) => {
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(btn.getAttribute('data-preset-idx'), 10);
            chrome.storage.local.get(['clipx_slip', 'clipx_gas', 'clipx_buy_presets'], (res) => {
                const slip = res.clipx_slip != null ? parseFloat(res.clipx_slip) : 1;
                const gas = res.clipx_gas != null ? parseFloat(res.clipx_gas) : 1;
                const presets = Array.isArray(res.clipx_buy_presets) && res.clipx_buy_presets.length
                    ? res.clipx_buy_presets
                    : [0.05, 0.1, 0.2];
                const amount = presets[idx];
                if (amount == null || !Number.isFinite(amount) || amount <= 0) return;
                const orig = btn.textContent;
                btn.disabled = true;
                btn.textContent = '…';
                const swapAction = pillChain === 'sol' ? 'solSwap' : 'swap';
                chrome.runtime.sendMessage({
                    action: swapAction,
                    tokenAddress: tokenAddress,
                    amount: String(amount),
                    type: 'buy',
                    slippage: slip,
                    gasPrice: gas,
                    isPercentage: false
                }, (response) => {
                    const ok = !!(response && response.success);
                    btn.disabled = false;
                    if (!ok) {
                        clipxShowTradeButtonError(btn, orig, response?.error, 'Swap failed');
                        return;
                    }
                    clipxPlaySwapSuccessSound();
                    btn.textContent = '✓';
                    setTimeout(() => {
                        btn.textContent = orig;
                        clipxRefreshTokenPillBalances(expand, tokenAddress);
                    }, 1600);
                });
            });
        };
    });

    expand.querySelectorAll('.clipx-pill-sell').forEach((btn) => {
        btn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const pct = btn.dataset.pct;
            const orig = `${pct}%`;
            chrome.storage.local.get(['clipx_slip', 'clipx_gas'], async (res) => {
                const slip = res.clipx_slip != null ? parseFloat(res.clipx_slip) : 1;
                const gas = res.clipx_gas != null ? parseFloat(res.clipx_gas) : 1;
                let actualAmount = pct;
                let isPercentage = false;
                try {
                    const storage = await chrome.storage.local.get(['userAddress', 'nativeWallet', 'cachedBalance']);
                    const walletAddress = clipxWalletAddressFromStorage(storage);
                    if (walletAddress) {
                        const balanceResponse = await new Promise((resolve) => {
                            chrome.runtime.sendMessage({
                                action: 'getTokenBalance',
                                walletAddress: walletAddress,
                                tokenAddress: tokenAddress
                            }, resolve);
                        });
                        if (balanceResponse && balanceResponse.success && balanceResponse.balance) {
                            const percentage = parseFloat(pct);
                            const tokenBalance = parseFloat(balanceResponse.balance);
                            actualAmount = (tokenBalance * percentage / 100).toString();
                        } else {
                            isPercentage = true;
                        }
                    } else {
                        isPercentage = true;
                    }
                } catch (err) {
                    isPercentage = true;
                }
                btn.disabled = true;
                btn.textContent = '…';
                const sellAction = pillChain === 'sol' ? 'solSwap' : 'swap';
                chrome.runtime.sendMessage({
                    action: sellAction,
                    tokenAddress: tokenAddress,
                    amount: actualAmount,
                    type: 'sell',
                    slippage: slip,
                    gasPrice: gas,
                    isPercentage: isPercentage
                }, (response) => {
                    const ok = !!(response && response.success);
                    btn.disabled = false;
                    if (!ok) {
                        clipxShowTradeButtonError(btn, orig, response?.error, 'Sell failed');
                        return;
                    }
                    clipxPlaySwapSuccessSound();
                    btn.textContent = '✓';
                    setTimeout(() => {
                        btn.textContent = orig;
                        clipxRefreshTokenPillBalances(expand, tokenAddress);
                    }, 1600);
                });
            });
        };
    });

    const refreshBtn = expand.querySelector('.clipx-pill-bal-refresh');
    if (refreshBtn) {
        refreshBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            refreshBtn.style.transform = 'rotate(360deg)';
            setTimeout(() => { refreshBtn.style.transform = ''; }, 350);
            clipxRefreshTokenPillBalances(expand, tokenAddress);
        };
    }
}

/**
 * Token / CA pill: gold (#f2d00f) = PancakeSwap / priority; orange (#f24b0f / white text) = off-list,
 * same palette as Surf 7d sentiment orange tier (clipxSurfSentimentTierStyle, score below 0.45).
 */
function clipxPositionFloatingCard(anchorEl, card, options = {}) {
    if (!anchorEl || !card || !document.body.contains(anchorEl)) return;
    const gap = options.gap == null ? 8 : options.gap;
    const pad = options.pad == null ? 8 : options.pad;
    const rect = anchorEl.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardW = cardRect.width || options.width || 320;
    const cardH = cardRect.height || options.height || 440;

    let left = rect.right + gap;
    let top = rect.bottom + gap;

    if (left + cardW > window.innerWidth - pad) left = rect.left - cardW - gap;
    if (left < pad) left = Math.min(Math.max(rect.left, pad), window.innerWidth - cardW - pad);
    if (top + cardH > window.innerHeight - pad) top = Math.max(pad, rect.top - cardH - gap);
    if (top < pad) top = pad;

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.right = 'auto';
    card.style.bottom = 'auto';
}

function clipxBindFloatingAnchor(overlay, card, anchorEl, options = {}) {
    if (!overlay || !card || !anchorEl) return;
    const reposition = () => clipxPositionFloatingCard(anchorEl, card, options);
    const close = () => {
        if (typeof overlay._clipxFloatingDispose === 'function') overlay._clipxFloatingDispose();
        overlay.remove();
    };
    const onScroll = () => close();
    const onResize = () => reposition();
    overlay._clipxFloatingDispose = () => {
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('pointerdown', overlay._clipxOutsidePointerDown, true);
    };
    reposition();
    requestAnimationFrame(() => requestAnimationFrame(reposition));

    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    overlay._clipxOutsidePointerDown = (e) => {
        const target = e.target;
        if (!target || card.contains(target) || anchorEl.contains(target)) return;
        close();
    };
    setTimeout(() => {
        if (document.body.contains(overlay)) {
            document.addEventListener('pointerdown', overlay._clipxOutsidePointerDown, true);
        }
    }, 0);
}

function clipxOpenDexSidePanel(url, title = 'DexScreener', externalUrl = url) {
    let panel = document.getElementById('clipx-dex-side-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'clipx-dex-side-panel';
        panel.style.cssText = `
            position:fixed;top:0;right:0;width:min(800px,60vw);height:100vh;z-index:2147483646;
            background:#000;border-left:1px solid rgba(255,255,255,0.12);
            box-shadow:-18px 0 50px rgba(0,0,0,0.45);font-family:Inter,system-ui,-apple-system,sans-serif;
            opacity:1;transition:width .3s cubic-bezier(0.4,0,0.2,1),opacity .3s cubic-bezier(0.4,0,0.2,1);
            overflow:hidden;
        `;
        document.body.appendChild(panel);
    }

    panel.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;">
            <div style="height:44px;padding:0 12px;border-bottom:1px solid #27272a;display:flex;align-items:center;justify-content:space-between;background:#09090b;color:#fff;">
                <span style="font-size:13px;font-weight:700;">${title}</span>
                <div style="display:flex;gap:10px;align-items:center;">
                    <a href="${externalUrl}" target="_blank" style="font-size:11px;color:#a1a1aa;text-decoration:none;">Open New Tab ↗</a>
                    <button id="clipx-dex-side-close" style="background:none;border:none;color:#a1a1aa;cursor:pointer;font-size:18px;line-height:1;">×</button>
                </div>
            </div>
            <iframe src="${url}" style="flex:1;width:100%;border:0;background:#000;" allow="clipboard-write; fullscreen"></iframe>
        </div>
    `;

    const close = panel.querySelector('#clipx-dex-side-close');
    if (close) {
        close.onclick = () => {
            panel.style.width = '0px';
            panel.style.opacity = '0';
            setTimeout(() => panel.remove(), 300);
        };
    }
}

function clipxFormatUsdPrice(raw) {
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) return null;
    if (price < 0.000001) return `$${price.toExponential(2)}`;
    if (price < 0.01) return `$${price.toFixed(8)}`;
    if (price < 1) return `$${price.toFixed(6)}`;
    if (price < 1000) return `$${price.toFixed(4).replace(/\.?0+$/, '')}`;
    return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function showTradeModal(address, knownSymbol, chain, tokenInfoCache, anchorEl = null) {
    const existing = document.getElementById('clipx-trade-modal');
    if (existing) {
        if (typeof existing._clipxFloatingDispose === 'function') existing._clipxFloatingDispose();
        existing.remove();
    }

    const isSol = chain === 'sol';
    const nativeSym = isSol ? 'SOL' : 'BNB';
    const _urls = clipxChainUrls(chain, address);
    const displaySymbol = (knownSymbol && knownSymbol !== 'Null') ? `$${knownSymbol}` : clipxFormatShortCa(address);

    const info = tokenInfoCache || {};
    let priceFmt = clipxFormatUsdPrice(info.priceUsd);
    let changePct = null;
    if (typeof info.priceChange === 'number') changePct = info.priceChange;
    const mcStr = clipxFormatMcUsdCompact(info.marketCapUsd);
    const ageStr = clipxFormatPairAgeFromDexTs(info.pairCreatedAt);
    const liqStr = info.liquidityUsd ? clipxFormatMcUsdCompact(info.liquidityUsd) : null;

    // Inject trade modal styles (once)
    const tmStyleId = 'clipx-trade-modal-styles';
    if (!document.getElementById(tmStyleId)) {
        const st = document.createElement('style');
        st.id = tmStyleId;
        st.textContent = `
@keyframes clipx-tm-overlay-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes clipx-tm-card-in {
    from { opacity: 0; transform: translateY(8px) scale(0.96); filter: blur(4px); }
    to   { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}
@keyframes clipx-tm-shimmer {
    0%   { background-position: 0% 50%; }
    100% { background-position: 200% 50%; }
}
#clipx-trade-modal { position:fixed;top:0;left:0;width:100%;height:100%;background:transparent;z-index:2147483647;pointer-events:none;opacity:0;animation:clipx-tm-overlay-in .16s ease forwards; }
#clipx-trade-modal * { box-sizing:border-box; }
.clipx-tm-card {
    width:260px;max-width:90vw;max-height:90vh;overflow-y:auto;position:fixed;pointer-events:auto;
    background:linear-gradient(165deg,rgb(18,18,22) 0%,rgb(10,10,12) 100%);
    border-radius:14px;
    border:1px solid rgba(255,255,255,0.09);
    color:#fff;
    font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    animation:clipx-tm-card-in .3s cubic-bezier(0.22,1,0.36,1) forwards;
    box-shadow:0 0 0 1px rgba(139,92,246,0.24),0 18px 54px -8px rgba(0,0,0,0.86),inset 0 1px 0 rgba(255,255,255,0.1);
    backdrop-filter:none;-webkit-backdrop-filter:none;
}
.clipx-tm-accent { height:2px;width:100%;background:linear-gradient(90deg,#6366f1,#22d3ee,#a78bfa,#34d399,#6366f1);background-size:220% 100%;animation:clipx-tm-shimmer 6s linear infinite;opacity:0.95;border-radius:14px 14px 0 0; }
.clipx-tm-body { padding:8px 10px 10px; }
.clipx-tm-icon { width:24px;height:24px;min-width:24px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;border:1px solid rgba(255,255,255,0.12);box-shadow:0 2px 12px rgba(99,102,241,0.25),inset 0 1px 0 rgba(255,255,255,0.12); }
.clipx-tm-close { background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:50%;width:22px;height:22px;color:#a1a1aa;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:all .15s; }
.clipx-tm-close:hover { background:rgba(255,255,255,0.12);color:#fff; }
.clipx-tm-meta { font-size:9px;color:#a1a1aa;font-weight:600;background:rgba(255,255,255,0.05);padding:2px 5px;border-radius:4px; }
.clipx-tm-addr { font-family:ui-monospace,monospace;font-size:9px;color:#71717a;padding:4px 6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:7px;display:flex;align-items:center;gap:5px;margin-bottom:6px; }
.clipx-tm-addr span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.clipx-tm-addr button { background:none;border:none;color:#a1a1aa;cursor:pointer;font-size:10px;flex-shrink:0;padding:1px;transition:color .15s; }
.clipx-tm-addr button:hover { color:#fff; }
.clipx-tm-bal-row { display:flex;gap:5px;margin-bottom:6px;padding:5px 7px;background:linear-gradient(135deg,rgba(99,102,241,0.08) 0%,rgba(34,211,238,0.05) 100%);border:1px solid rgba(99,102,241,0.15);border-radius:9px; }
.clipx-tm-bal-cell { flex:1;text-align:center; }
.clipx-tm-bal-label { font-size:8px;color:#a5b4fc;font-weight:600;letter-spacing:0.03em; }
.clipx-tm-bal-value { font-size:12px;font-weight:700;color:#fff;margin-top:0; }
.clipx-tm-section { font-size:8px;font-weight:700;color:#a1a1aa;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px; }
.clipx-tm-btn-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:6px; }
.clipx-tm-buy-btn {
    background:linear-gradient(135deg,rgba(16,185,129,0.12) 0%,rgba(34,197,94,0.08) 100%);
    border:1px solid rgba(34,197,94,0.25);color:#34d399;padding:5px 3px;border-radius:7px;
    font-size:10px;font-weight:700;cursor:pointer;transition:all .15s;
}
.clipx-tm-buy-btn:hover:not(:disabled) { background:rgba(34,197,94,0.2);border-color:rgba(34,197,94,0.4); }
.clipx-tm-buy-btn:disabled { opacity:0.6;cursor:wait; }
.clipx-tm-sell-btn {
    background:linear-gradient(135deg,rgba(239,68,68,0.1) 0%,rgba(220,38,38,0.06) 100%);
    border:1px solid rgba(239,68,68,0.2);color:#f87171;padding:5px 3px;border-radius:7px;
    font-size:10px;font-weight:700;cursor:pointer;transition:all .15s;
}
.clipx-tm-sell-btn:hover:not(:disabled) { background:rgba(239,68,68,0.18);border-color:rgba(239,68,68,0.35); }
.clipx-tm-sell-btn:disabled { opacity:0.6;cursor:wait; }
.clipx-tm-links { display:flex;gap:5px;flex-wrap:wrap; }
.clipx-tm-link-btn {
    flex:1;min-width:0;display:flex;align-items:center;justify-content:center;
    background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
    color:#a1a1aa;text-decoration:none;padding:5px 4px;border-radius:7px;
    font-size:10px;font-weight:600;transition:all .15s;white-space:nowrap;
}
.clipx-tm-link-btn:hover { background:rgba(255,255,255,0.08);color:#fff;border-color:rgba(255,255,255,0.15); }
`;
        document.head.appendChild(st);
    }

    const chainGradient = isSol
        ? 'linear-gradient(145deg,rgba(153,69,255,0.35) 0%,rgba(20,241,149,0.12) 100%)'
        : 'linear-gradient(145deg,rgba(240,185,11,0.35) 0%,rgba(242,208,15,0.12) 100%)';
    const chainBadge = isSol
        ? '<span style="background:rgba(153,69,255,0.25);color:#c4b5fd;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid rgba(153,69,255,0.3);">SOL</span>'
        : '<span style="background:rgba(240,185,11,0.2);color:#fbbf24;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid rgba(240,185,11,0.3);">BSC</span>';
    const changeHtml = changePct != null
        ? `<span style="color:${changePct >= 0 ? '#34d399' : '#f87171'};font-size:10px;font-weight:600;">${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%</span>`
        : '';

    const overlay = document.createElement('div');
    overlay.id = 'clipx-trade-modal';

    const card = document.createElement('div');
    card.className = 'clipx-tm-card';
    card.setAttribute('data-chain', chain);

    card.innerHTML = `
        <div class="clipx-tm-accent"></div>
        <div class="clipx-tm-body">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;">
                    ${info.iconUrl
                        ? `<img src="${info.iconUrl}" style="width:24px;height:24px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);" onerror="this.style.display='none'">`
                        : `<div class="clipx-tm-icon" style="background:${chainGradient};">⚡</div>`}
                    <div style="min-width:0;">
                        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                            <span style="font-size:14px;font-weight:800;letter-spacing:-0.02em;background:linear-gradient(120deg,#c4b5fd 0%,#a5b4fc 40%,#67e8f9 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${displaySymbol}</span>
                            ${chainBadge}
                        </div>
                        <div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
                            <span id="clipx-tm-price" style="font-size:11px;font-weight:700;color:#fff;">${priceFmt ? `Price ${priceFmt} USD` : 'Price loading…'}</span>
                            <span id="clipx-tm-change">${changeHtml}</span>
                        </div>
                    </div>
                </div>
                <button class="clipx-tm-close" id="clipx-trade-close">&times;</button>
            </div>

            <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;">
                <span class="clipx-tm-meta" id="clipx-tm-mcap">MC ${mcStr || 'loading…'}</span>
                ${ageStr ? `<span class="clipx-tm-meta" id="clipx-tm-age">Age ${ageStr}</span>` : `<span class="clipx-tm-meta" id="clipx-tm-age" style="display:none;"></span>`}
                ${liqStr ? `<span class="clipx-tm-meta" id="clipx-tm-liq">Liq ${liqStr}</span>` : `<span class="clipx-tm-meta" id="clipx-tm-liq" style="display:none;"></span>`}
            </div>
            <div style="margin-bottom:6px;line-height:1.35;">
                <span class="clipx-tm-meta" id="clipx-tm-tax" style="display:inline-block;max-width:100%;word-break:break-word;">${isSol ? 'Tax: N/A' : 'Tax: …'}</span>
            </div>

            <div class="clipx-tm-addr">
                <span style="flex:1;min-width:0;">${address}</span>
                <button id="clipx-trade-copy" title="Copy address">📋</button>
            </div>

            <div class="clipx-tm-bal-row">
                <div class="clipx-tm-bal-cell">
                    <div class="clipx-tm-bal-label">${nativeSym}</div>
                    <div class="clipx-tm-bal-value" id="clipx-tm-native-bal">—</div>
                </div>
                <div style="width:1px;background:rgba(99,102,241,0.15);"></div>
                <div class="clipx-tm-bal-cell">
                    <div class="clipx-tm-bal-label">${knownSymbol || 'Token'}</div>
                    <div class="clipx-tm-bal-value" id="clipx-tm-token-bal">—</div>
                </div>
                <button id="clipx-tm-refresh" style="background:none;border:none;cursor:pointer;color:#a5b4fc;font-size:12px;padding:0 4px;transition:transform .3s;" title="Refresh">🔄</button>
            </div>

            <div class="clipx-tm-section">Buy</div>
            <div class="clipx-tm-btn-grid">
                <button class="clipx-tm-buy-btn" data-preset-idx="0">…</button>
                <button class="clipx-tm-buy-btn" data-preset-idx="1">…</button>
                <button class="clipx-tm-buy-btn" data-preset-idx="2">…</button>
            </div>

            <div class="clipx-tm-section">Sell</div>
            <div class="clipx-tm-btn-grid" style="margin-bottom:7px;">
                <button class="clipx-tm-sell-btn" data-pct="25">25%</button>
                <button class="clipx-tm-sell-btn" data-pct="50">50%</button>
                <button class="clipx-tm-sell-btn" data-pct="100">100%</button>
            </div>

            <div class="clipx-tm-links">
                <button id="clipx-tm-risk" class="clipx-tm-link-btn" style="background:linear-gradient(135deg,rgba(139,92,246,0.15) 0%,rgba(59,130,246,0.1) 100%);border-color:rgba(139,92,246,0.25);color:#c4b5fd;">🛡️ Risk</button>
            </div>
        </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const closeTradeOverlay = () => {
        if (typeof overlay._clipxFloatingDispose === 'function') overlay._clipxFloatingDispose();
        overlay.remove();
    };
    if (anchorEl) {
        clipxBindFloatingAnchor(overlay, card, anchorEl, { width: 260, height: 332 });
    } else {
        card.style.left = '50%';
        card.style.top = '50%';
        card.style.transform = 'translate(-50%, -50%)';
        const onScroll = () => closeTradeOverlay();
        const onPointerDown = (e) => {
            if (card.contains(e.target)) return;
            closeTradeOverlay();
        };
        overlay._clipxFloatingDispose = () => {
            window.removeEventListener('scroll', onScroll, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
        };
        setTimeout(() => {
            window.addEventListener('scroll', onScroll, true);
            document.addEventListener('pointerdown', onPointerDown, true);
        }, 0);
    }

    // Close
    card.querySelector('#clipx-trade-close').onclick = () => closeTradeOverlay();

    // Copy
    card.querySelector('#clipx-trade-copy').onclick = (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        navigator.clipboard.writeText(address).then(() => {
            btn.textContent = '✓';
            setTimeout(() => { btn.textContent = '📋'; }, 1200);
        });
    };

    // Risk
    card.querySelector('#clipx-tm-risk').onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeTradeOverlay();
        showRiskModal(address, knownSymbol, chain);
    };

    const applyTradeInfo = (nextInfo) => {
        if (!nextInfo || !document.body.contains(card)) return;
        const nextPrice = clipxFormatUsdPrice(nextInfo.priceUsd);
        const priceEl = card.querySelector('#clipx-tm-price');
        if (priceEl) priceEl.textContent = nextPrice ? `Price ${nextPrice} USD` : 'Price N/A';

        const changeEl = card.querySelector('#clipx-tm-change');
        if (changeEl) {
            const pct = typeof nextInfo.priceChange === 'number' ? nextInfo.priceChange : null;
            changeEl.innerHTML = pct != null
                ? `<span style="color:${pct >= 0 ? '#34d399' : '#f87171'};font-size:10px;font-weight:600;">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</span>`
                : '';
        }

        const nextMc = clipxFormatMcUsdCompact(nextInfo.marketCapUsd);
        const mcEl = card.querySelector('#clipx-tm-mcap');
        if (mcEl) mcEl.textContent = `MC ${nextMc || 'N/A'}`;

        const nextAge = clipxFormatPairAgeFromDexTs(nextInfo.pairCreatedAt);
        const ageEl = card.querySelector('#clipx-tm-age');
        if (ageEl && nextAge) {
            ageEl.textContent = `Age ${nextAge}`;
            ageEl.style.display = '';
        }

        const nextLiq = nextInfo.liquidityUsd ? clipxFormatMcUsdCompact(nextInfo.liquidityUsd) : null;
        const liqEl = card.querySelector('#clipx-tm-liq');
        if (liqEl && nextLiq) {
            liqEl.textContent = `Liq ${nextLiq}`;
            liqEl.style.display = '';
        }
    };

    if (!priceFmt || !mcStr) {
        chrome.runtime.sendMessage({ action: 'fetchTokenInfo', address, chain, symbol: knownSymbol }, (response) => {
            if (response && response.success) {
                applyTradeInfo(response);
                return;
            }

            if (knownSymbol) {
                chrome.runtime.sendMessage({ action: 'resolveTickerDexScreener', symbol: knownSymbol }, (resolved) => {
                    const hasResolvedMarketData = !!(resolved && resolved.success && (resolved.priceUsd || resolved.marketCapUsd || resolved.liquidityUsd));
                    if (hasResolvedMarketData) {
                        applyTradeInfo(resolved);
                    }
                    if (resolved && resolved.success && resolved.address && resolved.address !== address) {
                        const nextChain = resolved.chain || chain;
                        chrome.runtime.sendMessage({ action: 'fetchTokenInfo', address: resolved.address, chain: nextChain, symbol: knownSymbol }, (nextInfo) => {
                            if (nextInfo && nextInfo.success) applyTradeInfo(nextInfo);
                            else if (!hasResolvedMarketData) applyTradeInfo({ priceUsd: null, marketCapUsd: null });
                        });
                    } else if (!hasResolvedMarketData) {
                        applyTradeInfo({ priceUsd: null, marketCapUsd: null });
                    }
                });
            } else {
                applyTradeInfo({ priceUsd: null, marketCapUsd: null });
            }
        });
    }

    // Load balances
    const loadTradeModalBalances = () => {
        const nativeEl = card.querySelector('#clipx-tm-native-bal');
        const tokenEl = card.querySelector('#clipx-tm-token-bal');
        if (nativeEl) nativeEl.textContent = '…';
        if (tokenEl) tokenEl.textContent = '…';
        chrome.storage.local.get(['userAddress', 'nativeWallet', 'cachedBalance', 'solWallet'], (res) => {
            const w = isSol
                ? (res.solWallet && res.solWallet.address)
                : clipxWalletAddressFromStorage(res);
            if (!w) {
                if (nativeEl) nativeEl.textContent = '—';
                if (tokenEl) tokenEl.textContent = '—';
                return;
            }
            const balAction = isSol ? 'getSolBalance' : 'getBnbBalance';
            chrome.runtime.sendMessage({ action: balAction, walletAddress: w }, (resp) => {
                if (nativeEl) nativeEl.textContent = (resp && resp.success) ? parseFloat(resp.balance).toFixed(4) : '—';
            });
            const tokAction = isSol ? 'getSolTokenBalance' : 'getTokenBalance';
            chrome.runtime.sendMessage({ action: tokAction, walletAddress: w, tokenAddress: address }, (resp) => {
                if (!tokenEl) return;
                if (resp && resp.success && resp.balance != null) {
                    const b = parseFloat(resp.balance);
                    tokenEl.textContent = !Number.isFinite(b) || b === 0 ? '0' : (b >= 1e9 ? b.toExponential(2) : b.toFixed(b < 0.0001 ? 8 : 4));
                } else {
                    tokenEl.textContent = '0';
                }
            });
        });
    };
    loadTradeModalBalances();

    const taxEl = card.querySelector('#clipx-tm-tax');
    const setTradeModalTax = (text) => {
        if (taxEl && document.body.contains(card)) taxEl.textContent = text;
    };
    if (!isSol) {
        chrome.runtime.sendMessage({ action: 'checkTokenRisk', address }, (response) => {
            if (chrome.runtime.lastError) {
                setTradeModalTax('Tax: unavailable');
                return;
            }
            if (!document.body.contains(card)) return;
            if (response && response.success && response.data) {
                const d = response.data;
                const buy = parseFloat(d.buy_tax);
                const sell = parseFloat(d.sell_tax);
                const buyS = Number.isFinite(buy) ? `${buy}%` : '—';
                const sellS = Number.isFinite(sell) ? `${sell}%` : '—';
                setTradeModalTax(`Tax: buy ${buyS} · sell ${sellS}`);
            } else {
                setTradeModalTax('Tax: unavailable');
            }
        });
    }

    // Refresh
    card.querySelector('#clipx-tm-refresh').onclick = (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.style.transform = 'rotate(360deg)';
        setTimeout(() => { btn.style.transform = ''; }, 350);
        loadTradeModalBalances();
    };

    // Buy labels
    chrome.storage.local.get(['clipx_buy_presets'], (res) => {
        const presets = Array.isArray(res.clipx_buy_presets) && res.clipx_buy_presets.length ? res.clipx_buy_presets : [0.05, 0.1, 0.2];
        card.querySelectorAll('.clipx-tm-buy-btn').forEach((btn, i) => {
            const amt = presets[i];
            btn.textContent = (amt != null && Number.isFinite(amt) && amt > 0) ? `${amt} ${nativeSym}` : '—';
        });
    });

    // Buy handlers
    card.querySelectorAll('.clipx-tm-buy-btn').forEach((btn) => {
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(btn.getAttribute('data-preset-idx'), 10);
            chrome.storage.local.get(['clipx_slip', 'clipx_gas', 'clipx_buy_presets'], (res) => {
                const slip = res.clipx_slip != null ? parseFloat(res.clipx_slip) : 1;
                const gas = res.clipx_gas != null ? parseFloat(res.clipx_gas) : 1;
                const presets = Array.isArray(res.clipx_buy_presets) && res.clipx_buy_presets.length ? res.clipx_buy_presets : [0.05, 0.1, 0.2];
                const amount = presets[idx];
                if (amount == null || !Number.isFinite(amount) || amount <= 0) return;
                const orig = btn.textContent;
                btn.disabled = true;
                btn.textContent = '⏳';
                const swapAction = isSol ? 'solSwap' : 'swap';
                chrome.runtime.sendMessage({ action: swapAction, tokenAddress: address, amount: String(amount), type: 'buy', slippage: slip, gasPrice: gas, isPercentage: false }, (response) => {
                    btn.disabled = false;
                    if (response && response.success) {
                        clipxPlaySwapSuccessSound();
                        btn.textContent = '✓';
                        setTimeout(() => { btn.textContent = orig; loadTradeModalBalances(); }, 1600);
                    } else {
                        clipxShowTradeButtonError(btn, orig, response?.error, 'Swap failed');
                    }
                });
            });
        };
    });

    // Sell handlers
    card.querySelectorAll('.clipx-tm-sell-btn').forEach((btn) => {
        btn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const pct = btn.dataset.pct;
            const orig = `${pct}%`;
            chrome.storage.local.get(['clipx_slip', 'clipx_gas'], async (res) => {
                const slip = res.clipx_slip != null ? parseFloat(res.clipx_slip) : 1;
                const gas = res.clipx_gas != null ? parseFloat(res.clipx_gas) : 1;
                let actualAmount = pct;
                let isPercentage = false;
                try {
                    const storage = await chrome.storage.local.get(['userAddress', 'nativeWallet', 'cachedBalance', 'solWallet']);
                    const walletAddress = isSol
                        ? (storage.solWallet && storage.solWallet.address)
                        : clipxWalletAddressFromStorage(storage);
                    if (walletAddress) {
                        const tokAction = isSol ? 'getSolTokenBalance' : 'getTokenBalance';
                        const balanceResponse = await new Promise((resolve) => {
                            chrome.runtime.sendMessage({ action: tokAction, walletAddress, tokenAddress: address }, resolve);
                        });
                        if (balanceResponse && balanceResponse.success && balanceResponse.balance) {
                            actualAmount = (parseFloat(balanceResponse.balance) * parseFloat(pct) / 100).toString();
                        } else { isPercentage = true; }
                    } else { isPercentage = true; }
                } catch { isPercentage = true; }
                btn.disabled = true;
                btn.textContent = '⏳';
                const sellAction = isSol ? 'solSwap' : 'swap';
                chrome.runtime.sendMessage({ action: sellAction, tokenAddress: address, amount: actualAmount, type: 'sell', slippage: slip, gasPrice: gas, isPercentage }, (response) => {
                    btn.disabled = false;
                    if (response && response.success) {
                        clipxPlaySwapSuccessSound();
                        btn.textContent = '✓';
                        setTimeout(() => { btn.textContent = orig; loadTradeModalBalances(); }, 1600);
                    } else {
                        clipxShowTradeButtonError(btn, orig, response?.error, 'Sell failed');
                    }
                });
            });
        };
    });
}

function createBuyButton(username, address, knownSymbol = null, isVerified = false, chain = 'bnb', extra = null) {
    ensureClipxTokenPillStyles();
    const isXStock = !!(extra && extra.isXStock);
    if (isXStock) chain = 'bnb';
    const isSol = chain === 'sol';
    const xStockIssuer = (extra && extra.issuer) || null; // 'backed' | 'ondo'
    const xStockVenue = isXStock ? 'pancakeswap' : ((extra && extra.venue) || (isSol ? 'jupiter' : 'pancakeswap'));
    const onPancakeSwapList = !!isVerified;
    // Pill color is purely chain-driven so users can tell at a glance which
    // network a token trades on. Verification status is conveyed separately
    // via the ✓ badge and the tooltip — NOT via the background color.
    //   • BSC      → BNB-yellow   (#F0B90B)  — verified or unverified
    //   • Solana   → Solana-purple (#9945FF) — verified or unverified
    //   • xStocks  → sky-blue on BNB Chain / PancakeSwap
    const pillColors = isXStock
        ? { bg: '#0284C7', fg: '#FFFFFF' }
        : isSol
            ? { bg: '#9945FF', fg: '#FFFFFF' }
            : { bg: '#F0B90B', fg: '#181A20' };

    const container = document.createElement('span');
    container.style.cssText = 'display: inline; vertical-align: baseline; margin: 0 0.12em;';

    const wrap = document.createElement('span');
    wrap.className = 'clipx-token-pill-wrap';
    wrap.setAttribute('data-expanded', '0');
    wrap.setAttribute('data-username', username);
    wrap.setAttribute('data-chain', chain);
    wrap.dataset.clipxAddress = address;
    wrap.dataset.clipxSymbol = knownSymbol || '';
    if (isXStock) wrap.dataset.clipxIsXstock = '1';
    wrap.setAttribute(
        'data-clipx-pill-source',
        isXStock ? 'xstocks' : (isSol ? 'solana' : (onPancakeSwapList ? 'pancakeswap' : 'other'))
    );

    const main = document.createElement('span');
    let mainClass = 'clipx-token-pill-main';
    // Unverified BSC tokens keep the BNB-yellow background but get a thin dashed
    // outline + warning glyph (rendered after the chain badge) so the trust
    // signal survives without hijacking the chain color.
    const showUnverifiedHint = !isXStock && !isSol && !onPancakeSwapList;
    if (showUnverifiedHint) mainClass += ' clipx-token-pill-main--unlisted';
    if (isXStock) mainClass += ' clipx-token-pill-main--xstock';
    main.className = mainClass;
    clipxApplyTokenPillStyleToElement(main);
    main.dataset.clipxAddress = address;
    main.dataset.clipxSymbol = knownSymbol || '';
    main.dataset.clipxChain = chain;
    main.dataset.clipxUsername = username || '';
    if (isXStock) main.dataset.clipxIsXstock = '1';
    main.style.setProperty('--clipx-pill-bg', pillColors.bg);
    main.style.setProperty('--clipx-pill-fg', pillColors.fg);
    if (isXStock) {
        const issuerLabel = xStockIssuer === 'ondo' ? 'Ondo Finance' : 'Backed Finance';
        const chainLabel = isSol ? 'Solana' : 'BNB Chain';
        const venueLabel = xStockVenue === 'pancakeswap' ? 'PancakeSwap' : 'Jupiter';
        const onChainSymbol = (extra && extra.displaySymbol) ||
            (xStockIssuer === 'ondo' ? `${knownSymbol}on` : `${knownSymbol}x`);
        main.title = `Tokenized stock (${onChainSymbol} on ${chainLabel}, by ${issuerLabel}) — click to trade via ${venueLabel}`;
    } else if (!onPancakeSwapList && !isSol) {
        main.title = 'Not on PancakeSwap token list — verify contract before trading.';
    } else if (isSol) {
        main.title = 'Solana token — click to trade';
    }

    if (address && knownSymbol && (isVerified || isXStock)) {
        const caLine = `Contract: ${address}`;
        main.title = main.title ? `${main.title} — ${caLine}` : caLine;
    }

    const trustBadge = isVerified
        ? '<span class="clipx-verified-badge" title="Verified Token">✓</span>'
        : (showUnverifiedHint
            ? '<span class="clipx-unverified-badge" title="Not on PancakeSwap token list — verify the contract before trading.">!</span>'
            : '');

    let collapsedLabelInner;
    if (knownSymbol && address && (isVerified || isXStock)) {
        const sca = clipxFormatShortCa(address);
        collapsedLabelInner = isXStock
            ? `$${knownSymbol}`
            : `$${knownSymbol}<span class="clipx-pill-inline-ca" title="${address}">·${sca}</span>`;
    } else if (knownSymbol) {
        collapsedLabelInner = `$${knownSymbol}`;
    } else {
        collapsedLabelInner = clipxFormatShortCa(address);
    }
    // Chain-aware xSTOCK badge — tells the user which network the trade settles on.
    const chainBadgeText = isXStock
        ? 'xSTOCK · BSC'
        : (isSol ? 'SOL' : 'BSC');

    main.innerHTML = `<span class="clipx-ticker">${collapsedLabelInner}</span><span class="clipx-pill-price" data-empty="1"></span><span class="clipx-pill-change" data-empty="1"></span><span class="clipx-pill-chain-badge">${chainBadgeText}</span>${trustBadge}`;

    // Store token info so the trade modal can show it immediately
    let _tokenInfoCache = {};
    if (extra && (extra.priceUsd != null || extra.marketCapUsd != null || extra.liquidityUsd != null)) {
        _tokenInfoCache = {
            success: true,
            chain,
            symbol: (extra.displaySymbol || knownSymbol || '').replace(/(x|on)$/i, '') || knownSymbol || null,
            name: (extra.name || knownSymbol || ''),
            priceUsd: extra.priceUsd != null ? String(extra.priceUsd) : null,
            priceChange: typeof extra.priceChange === 'number' ? extra.priceChange : 0,
            marketCapUsd: extra.marketCapUsd || null,
            pairCreatedAt: extra.pairCreatedAt || null,
            liquidityUsd: extra.liquidityUsd || null,
            iconUrl: extra.logoURI || null,
            source: extra.source || 'resolver'
        };
        const priceEl = main.querySelector('.clipx-pill-price');
        if (priceEl && _tokenInfoCache.priceUsd) {
            const price = parseFloat(_tokenInfoCache.priceUsd);
            priceEl.textContent = price < 0.01 ? `$${price.toFixed(6)}` : (price < 1 ? `$${price.toFixed(4)}` : `$${price.toFixed(2)}`);
            priceEl.removeAttribute('data-empty');
        }
        const changeEl = main.querySelector('.clipx-pill-change');
        if (changeEl && typeof _tokenInfoCache.priceChange === 'number') {
            const pct = _tokenInfoCache.priceChange;
            const sign = pct > 0 ? '+' : '';
            changeEl.textContent = `${sign}${pct.toFixed(1)}%`;
            changeEl.dataset.dir = pct >= 0 ? 'up' : 'down';
            changeEl.removeAttribute('data-empty');
        }
    }
    wrap._clipxTokenInfoCache = _tokenInfoCache;
    main._clipxOpenTradeModal = () => showTradeModal(address, knownSymbol || main.dataset.clipxSymbol || null, chain, _tokenInfoCache, main);

    main.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        try { main._clipxOpenTradeModal(); } catch (err) { console.error('[ClipX] showTradeModal error:', err); }
    }, true);

    wrap.appendChild(main);
    container.appendChild(wrap);

    chrome.runtime.sendMessage({ action: 'fetchTokenInfo', address: address, chain: chain, symbol: knownSymbol }, (response) => {
        if (response && response.success) {
            _tokenInfoCache = response;
            wrap._clipxTokenInfoCache = response;
            const tickerEl = main.querySelector('.clipx-ticker');
            if (!tickerEl) return;

            const symbol = isXStock ? (knownSymbol || response.symbol || '???') : (response.symbol || knownSymbol || '???');
            main.dataset.clipxSymbol = symbol;

            let priceText = '';
            if (response.priceUsd) {
                const price = parseFloat(response.priceUsd);
                if (price < 0.01) {
                    priceText = `$${price.toFixed(6)}`;
                } else if (price < 1) {
                    priceText = `$${price.toFixed(4)}`;
                } else {
                    priceText = `$${price.toFixed(2)}`;
                }
            }

            let changeLine = '24h: N/A';
            let changeText = '';
            let changeDir = null;
            if (typeof response.priceChange === 'number') {
                const pct = response.priceChange;
                const sign = pct > 0 ? '+' : '';
                changeLine = `24h: ${sign}${pct.toFixed(2)}%`;
                changeText = `${sign}${pct.toFixed(1)}%`;
                changeDir = pct >= 0 ? 'up' : 'down';
            }

            tickerEl.textContent = `$${symbol}`;

            const priceEl = main.querySelector('.clipx-pill-price');
            if (priceEl) {
                if (priceText) {
                    priceEl.textContent = priceText;
                    priceEl.removeAttribute('data-empty');
                } else {
                    priceEl.textContent = '';
                    priceEl.setAttribute('data-empty', '1');
                }
            }

            const changeEl = main.querySelector('.clipx-pill-change');
            if (changeEl) {
                if (changeText) {
                    changeEl.textContent = changeText;
                    changeEl.dataset.dir = changeDir || 'up';
                    changeEl.removeAttribute('data-empty');
                } else {
                    changeEl.textContent = '';
                    changeEl.removeAttribute('data-dir');
                    changeEl.setAttribute('data-empty', '1');
                }
            }

            const titleParts = [];
            if (isSol) {
                titleParts.push('Solana token — click to trade');
            } else if (!onPancakeSwapList) {
                titleParts.push('Not on PancakeSwap list — verify contract before trading.');
            }
            titleParts.push(`Price: ${priceText || 'N/A'}`, changeLine);
            const mcStr = clipxFormatMcUsdCompact(response.marketCapUsd);
            if (mcStr) titleParts.push(`MC: ${mcStr}`);
            const ageStr = clipxFormatPairAgeFromDexTs(response.pairCreatedAt);
            if (ageStr) titleParts.push(`Age: ${ageStr}`);
            main.title = titleParts.join('\n');
        }
    });

    return container;
}

/** Close tip modal overlay and detach scroll/resize anchor listeners. */
function clipxCloseTipModalOverlay(overlay) {
    if (!overlay) return;
    try {
        if (typeof overlay._clipxAnchorDispose === 'function') {
            overlay._clipxAnchorDispose();
            overlay._clipxAnchorDispose = null;
        }
        if (overlay._clipxBalanceRefreshInterval) {
            clearInterval(overlay._clipxBalanceRefreshInterval);
            overlay._clipxBalanceRefreshInterval = null;
        }
    } catch (_) { /* ignore */ }
    overlay.remove();
}

/**
 * Position the tip panel below / beside the Tip badge (same idea as timeline token pill expand).
 * Returns { dispose, reposition }.
 */
function clipxBindTipModalAnchor(overlay, modal, anchorEl) {
    if (!anchorEl || !modal) {
        return { dispose: () => { }, reposition: () => { } };
    }
    const gap = 8;
    const pad = 8;
    const panelMaxW = 300;

    const reposition = () => {
        if (!document.body.contains(anchorEl)) return;
        const rect = anchorEl.getBoundingClientRect();
        const mw = Math.min(panelMaxW, window.innerWidth - 2 * pad);
        modal.style.width = `${mw}px`;
        let left = rect.right - mw;
        let top = rect.bottom + gap;
        if (left < pad) left = pad;
        if (left + mw > window.innerWidth - pad) left = window.innerWidth - pad - mw;
        const h = modal.getBoundingClientRect().height || 400;
        if (top + h > window.innerHeight - pad) {
            top = rect.top - h - gap;
            if (top < pad) top = pad;
        }
        modal.style.left = `${left}px`;
        modal.style.top = `${top}px`;
        modal.style.right = 'auto';
        modal.style.bottom = 'auto';
    };

    const onScrollOrResize = () => reposition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    reposition();
    requestAnimationFrame(() => requestAnimationFrame(reposition));

    return {
        dispose: () => {
            window.removeEventListener('scroll', onScrollOrResize, true);
            window.removeEventListener('resize', onScrollOrResize);
        },
        reposition
    };
}

// Create and show modal
async function createModal(username, initialView = 'tip', initialAddress = '', anchorEl = null, chain = 'bnb') {
    const tipAnchorEl = anchorEl;
    const _modalUrls = clipxChainUrls(chain, initialAddress);
    // Remove existing modal if any
    const existing = document.getElementById('clipx-modal-overlay');
    if (existing) clipxCloseTipModalOverlay(existing);

    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'clipx-modal-overlay';
    // Create style element
    const existingStyle = document.getElementById('clipx-modal-style');
    if (existingStyle) existingStyle.remove();

    const style = document.createElement('style');
    style.id = 'clipx-modal-style';
    style.textContent = `
        :root {
            --bg-body: #000000;
            --bg-card: #09090b;
            --bg-input: #18181b;
            --text-main: #ffffff;
            --text-muted: #a1a1aa;
            --primary: #8b5cf6;
            --primary-hover: #7c3aed;
            --accent: #c084fc;
            --border: #27272a;
            --success: #10b981;
            --error: #ef4444;
            --gradient: linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%);
            --radius-sm: 8px;
            --radius-md: 12px;
            --radius-lg: 16px;
            --radius-full: 9999px;
        }

        #clipx-modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.58);
            z-index: 2147483647;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            animation: clipx-modal-overlay-in 0.22s ease forwards;
        }
        #clipx-modal-overlay.clipx-modal-overlay--anchored {
            display: block;
            background: rgba(0, 0, 0, 0.28);
        }
        @keyframes clipx-modal-overlay-in {
            to { opacity: 1; }
        }
        @keyframes clipx-fade-in {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes clipx-slide-up-fade {
            from { opacity: 0; transform: translateY(8px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes clipx-tip-anchor-expand {
            from { opacity: 0; transform: scale(0.88) translateY(-4px); filter: blur(4px); }
            to { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
        }
        @keyframes clipx-accent-shimmer {
            0% { background-position: 0% 50%; }
            100% { background-position: 200% 50%; }
        }
        @keyframes clipx-success-pop {
            0% { transform: scale(0.6); opacity: 0; }
            70% { transform: scale(1.08); opacity: 1; }
            100% { transform: scale(1); opacity: 1; }
        }
        .clipx-modal-accent {
            height: 2px;
            width: 100%;
            background: linear-gradient(90deg, #6366f1, #22d3ee, #a78bfa, #34d399, #6366f1);
            background-size: 220% 100%;
            animation: clipx-accent-shimmer 6s linear infinite;
            opacity: 0.95;
        }
        .clipx-tip-icon {
            width: 32px;
            height: 32px;
            min-width: 32px;
            border-radius: 10px;
            background: linear-gradient(145deg, rgba(99, 102, 241, 0.35) 0%, rgba(34, 211, 238, 0.12) 100%);
            border: 1px solid rgba(255, 255, 255, 0.12);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            line-height: 1;
            box-shadow: 0 2px 12px rgba(99, 102, 241, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.12);
        }
        .clipx-modal {
            background: linear-gradient(165deg, rgba(18, 18, 22, 0.78) 0%, rgba(10, 10, 12, 0.9) 100%);
            width: 300px;
            border-radius: 14px;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden;
            animation: clipx-slide-up-fade 0.3s cubic-bezier(0.22, 1, 0.36, 1) forwards;
            position: relative;
            border: 1px solid rgba(255, 255, 255, 0.09);
            color: var(--text-main);
            box-shadow:
                0 0 0 1px rgba(139, 92, 246, 0.12),
                0 16px 48px -8px rgba(0, 0, 0, 0.55),
                inset 0 1px 0 rgba(255, 255, 255, 0.06);
            backdrop-filter: blur(18px);
            -webkit-backdrop-filter: blur(18px);
        }
        #clipx-modal-overlay.clipx-modal-overlay--anchored .clipx-modal.clipx-modal--anchored {
            position: fixed;
            left: 0;
            top: 0;
            margin: 0;
            max-width: calc(100vw - 16px);
            max-height: calc(100vh - 16px);
            overflow-x: hidden;
            overflow-y: auto;
            animation: clipx-tip-anchor-expand 0.38s cubic-bezier(0.34, 1.15, 0.4, 1) forwards;
            transform-origin: top right;
            box-shadow:
                0 0 0 1px rgba(99, 102, 241, 0.18),
                0 12px 36px -6px rgba(0, 0, 0, 0.5),
                inset 0 1px 0 rgba(255, 255, 255, 0.07);
        }
        .clipx-header {
            padding: 10px 12px 0;
            position: relative;
            background: transparent;
        }
        .clipx-header--tip .clipx-header-content {
            align-items: flex-start;
        }
        .clipx-header-content {
            position: relative;
            z-index: 1;
            padding-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .clipx-title {
            font-size: 15px;
            font-weight: 800;
            margin: 0;
            letter-spacing: -0.02em;
            background: linear-gradient(120deg, #c4b5fd 0%, #a5b4fc 40%, #67e8f9 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .clipx-subtitle {
            font-size: 10px;
            color: var(--text-muted);
            margin-top: 2px;
            font-weight: 500;
            letter-spacing: 0.02em;
        }
        .clipx-tabs {
            display: flex;
            background: var(--bg-input);
            padding: 4px;
            border-radius: var(--radius-full);
            margin: 0 16px 16px;
            border: 1px solid var(--border);
        }
        .clipx-tab {
            flex: 1;
            text-align: center;
            padding: 8px;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-muted);
            cursor: pointer;
            transition: all 0.2s;
            border-radius: var(--radius-full);
        }
        .clipx-tab:hover {
            color: var(--text-main);
        }
        .clipx-tab.active {
            color: var(--text-main);
            background: var(--bg-card);
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .clipx-body {
            padding: 0 12px 12px;
        }
        .clipx-view {
            display: none;
            animation: clipx-fade-in 0.2s ease-out;
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .clipx-view.active {
            display: block;
        }
        .clipx-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 5px;
            margin-bottom: 10px;
        }
        .clipx-token-card {
            border: 1px solid transparent;
            border-radius: 10px;
            padding: 5px 2px;
            text-align: center;
            cursor: pointer;
            transition: border-color 0.2s, background 0.2s, box-shadow 0.2s, transform 0.15s;
            background: rgba(24, 24, 27, 0.65);
        }
        .clipx-token-card:hover {
            border-color: rgba(139, 92, 246, 0.45);
            background: rgba(39, 39, 42, 0.85);
            transform: translateY(-1px);
        }
        .clipx-token-card.selected {
            background: var(--bg-card);
            border-color: var(--primary);
            box-shadow: 0 0 0 1px var(--primary), 0 0 14px rgba(139, 92, 246, 0.28);
            animation: clipx-token-selected-pulse 3s ease-in-out infinite;
        }
        @keyframes clipx-token-selected-pulse {
            0%, 100% { box-shadow: 0 0 0 1px var(--primary), 0 0 8px rgba(139, 92, 246, 0.2); }
            50% { box-shadow: 0 0 0 1px var(--primary), 0 0 14px rgba(34, 211, 238, 0.15); }
        }
        .clipx-token-icon {
            font-size: 14px;
            margin-bottom: 2px;
            display: block;
        }
        .clipx-token-name {
            font-size: 8px;
            font-weight: 700;
            color: var(--text-muted);
        }
        .clipx-token-card.selected .clipx-token-name {
            color: var(--text-main);
        }
        .clipx-input-group {
            margin-bottom: 10px;
        }
        .clipx-label {
            display: block;
            font-size: 10px;
            font-weight: 600;
            color: var(--text-muted);
            margin-bottom: 4px;
            margin-left: 2px;
        }
        .clipx-amount-input, .clipx-text-input {
            width: 100%;
            padding: 8px 11px;
            font-size: 14px;
            font-weight: 600;
            border: 1px solid transparent;
            border-radius: 9999px;
            box-sizing: border-box;
            outline: none;
            transition: all 0.2s;
            color: var(--text-main);
            background: var(--bg-input);
            font-family: inherit;
        }
        .clipx-amount-input:focus, .clipx-text-input:focus {
            border-color: var(--primary);
            background: var(--bg-card);
        }
        .clipx-quick-amounts {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 5px;
            margin-top: 6px;
        }
        .clipx-chip {
            padding: 5px 4px;
            background: rgba(24, 24, 27, 0.7);
            border: 1px solid transparent;
            border-radius: 9999px;
            font-size: 10px;
            font-weight: 600;
            color: var(--text-muted);
            cursor: pointer;
            text-align: center;
            transition: background 0.2s, color 0.2s, border-color 0.2s, transform 0.2s;
        }
        .clipx-chip:hover {
            background: var(--bg-card);
            color: var(--text-main);
            border-color: var(--primary);
            transform: translateY(-1px);
        }
        .clipx-private-toggle {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 0;
            margin-bottom: 16px;
            cursor: pointer;
        }
        .clipx-switch {
            width: 40px;
            height: 22px;
            background: var(--bg-input);
            border-radius: 999px;
            position: relative;
            transition: background 0.2s;
            border: 1px solid var(--border);
        }
        .clipx-switch.checked {
            background: var(--primary);
            border-color: var(--primary);
        }
        .clipx-switch-knob {
            width: 16px;
            height: 16px;
            background: white;
            border-radius: 50%;
            position: absolute;
            top: 2px;
            left: 2px;
            transition: transform 0.2s;
        }
        .clipx-switch.checked .clipx-switch-knob {
            transform: translateX(18px);
        }
        .clipx-btn {
            width: 100%;
            padding: 9px 10px;
            border: none;
            border-radius: 9999px;
            font-weight: 600;
            font-size: 12px;
            cursor: pointer;
            transition: transform 0.18s, box-shadow 0.2s, background 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .clipx-btn-primary {
            background: linear-gradient(135deg, #7c3aed 0%, #6366f1 55%, #4f46e5 100%);
            color: white;
            box-shadow: 0 2px 12px rgba(99, 102, 241, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.12);
        }
        .clipx-btn-primary:hover {
            background: linear-gradient(135deg, #6d28d9 0%, #4f46e5 100%);
            transform: translateY(-1px);
            box-shadow: 0 4px 18px rgba(99, 102, 241, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.15);
        }
        .clipx-btn-primary:active {
            transform: translateY(0);
        }
        .clipx-btn-gmgn {
            background: linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%);
            color: white;
        }
        .clipx-btn-secondary {
            background: var(--bg-input);
            color: var(--text-muted);
            margin-top: 12px;
        }
        .clipx-btn-secondary:hover {
            color: var(--text-main);
            background: #27272a;
        }
        .clipx-badge {
            display: inline-flex;
            align-items: center;
            padding: 1px 6px;
            border-radius: var(--radius-full);
            font-size: 9px;
            font-weight: 600;
            margin-left: 6px;
            vertical-align: middle;
        }
        .clipx-badge-success {
            background: rgba(16, 185, 129, 0.1);
            color: #34d399;
        }
        .clipx-badge-warning {
            background: rgba(251, 191, 36, 0.1);
            color: #fbbf24;
        }
        .clipx-escrow-notice {
            background: rgba(139, 92, 246, 0.1);
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: var(--radius-md);
            padding: 12px;
            margin-bottom: 16px;
            font-size: 12px;
            color: #c4b5fd;
            display: flex;
            gap: 8px;
            align-items: flex-start;
        }
        .clipx-settings-btn {
            background: var(--bg-input);
            border: 1px solid var(--border);
            border-radius: var(--radius-full);
            padding: 6px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .clipx-settings-btn:hover {
            background: var(--bg-card);
            border-color: var(--primary);
        }
        .clipx-settings-modal {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 2147483648;
        }
        .clipx-settings-content {
            background: var(--bg-body);
            border-radius: var(--radius-lg);
            padding: 20px;
            width: 90%;
            max-width: 400px;
            border: 1px solid var(--border);
        }
        .clipx-settings-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .clipx-settings-title {
            font-size: 16px;
            font-weight: 700;
            color: var(--text-main);
        }
        .clipx-settings-close {
            background: none;
            border: none;
            color: var(--text-muted);
            cursor: pointer;
            font-size: 24px;
            padding: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .clipx-settings-close:hover {
            color: var(--text-main);
        }
    `;
    document.head.appendChild(style);

    // Create modal container
    const modal = document.createElement('div');
    modal.className = 'clipx-modal';
    overlay._clipxTipAnchorEl = anchorEl || null;
    if (anchorEl) {
        overlay.classList.add('clipx-modal-overlay--anchored');
        modal.classList.add('clipx-modal--anchored');
    }

    modal.innerHTML = `
        <div class="clipx-modal-accent" aria-hidden="true"></div>
        <div class="clipx-header clipx-header--tip">
            <div class="clipx-header-content">
                <div style="display:flex;align-items:center;gap:8px;">
                    <div class="clipx-tip-icon" aria-hidden="true">💸</div>
                    <div>
                        <h2 class="clipx-title" style="margin:0;">ClipX Assistant</h2>
                        <p class="clipx-subtitle" style="margin:2px 0 0;">Opening tip panel…</p>
                    </div>
                </div>
            </div>
        </div>
        <div class="clipx-body">
            <div style="padding:14px 0 4px;color:var(--text-muted);font-size:12px;text-align:center;">Loading…</div>
        </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    if (anchorEl) {
        requestAnimationFrame(() => clipxPositionFloatingCard(anchorEl, modal, { width: 300, height: 160 }));
    }
    const loadingFallbackTimer = setTimeout(() => {
        if (!document.body.contains(overlay)) return;
        if (!modal.textContent || !modal.textContent.includes('Opening tip panel')) return;
        modal.innerHTML = `
            <div class="clipx-modal-accent" aria-hidden="true"></div>
            <div class="clipx-header clipx-header--tip">
                <div class="clipx-header-content">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div class="clipx-tip-icon" aria-hidden="true">💸</div>
                        <div>
                            <h2 class="clipx-title" style="margin:0;">ClipX Assistant</h2>
                            <p class="clipx-subtitle" style="margin:2px 0 0;">Could not load tip data</p>
                        </div>
                    </div>
                </div>
            </div>
            <div class="clipx-body">
                <div style="font-size:12px;color:var(--text-muted);line-height:1.45;margin-bottom:12px;">
                    The tip panel is waiting on extension storage or API data. Reload ClipX, then try again.
                </div>
                <button class="clipx-btn clipx-btn-secondary" id="clipx-close-btn">Close</button>
            </div>
        `;
        const closeBtn = modal.querySelector('#clipx-close-btn');
        if (closeBtn) closeBtn.onclick = () => clipxCloseTipModalOverlay(overlay);
        if (overlay._clipxAnchorReposition) requestAnimationFrame(() => overlay._clipxAnchorReposition());
    }, 2500);

    // Token configurations
    const tokens = {
        BNB: { color: '#f59e0b', gradient: 'linear-gradient(135deg, #f6d365 0%, #fda085 100%)', icon: '🟡' },
        CLIPX: { color: '#3b82f6', gradient: 'linear-gradient(135deg, #60a5fa 0%, #a855f7 100%)', icon: '⚡' },
        ASTER: { color: '#10b981', gradient: 'linear-gradient(135deg, #34d399 0%, #10b981 100%)', icon: '✨' },
        USDT: { color: '#14b8a6', gradient: 'linear-gradient(135deg, #2dd4bf 0%, #0d9488 100%)', icon: '💵' },
        GIGGLE: { color: '#ec4899', gradient: 'linear-gradient(135deg, #f472b6 0%, #db2777 100%)', icon: '🎭' }
    };

    // Check auth and balance
    let isAuthenticated = false;
    let balances = {};
    try {
        const stored = await chrome.storage.local.get(['authToken', 'webAuthToken', 'cachedBalance']);
        isAuthenticated = !!(stored.authToken || stored.webAuthToken);
        balances = stored.cachedBalance || {};
    } catch (e) {
        console.log('[ClipX] Auth check failed:', e);
    }
    clearTimeout(loadingFallbackTimer);

    if (!isAuthenticated) {
        // Login UI
        modal.innerHTML = `
    <div class="clipx-modal-accent" aria-hidden="true"></div>
    <div class="clipx-header" style="background: linear-gradient(135deg, rgba(130, 29, 240, 0.14) 0%, rgba(13, 18, 20, 0.45) 100%); padding-bottom: 16px;">
        <div class="clipx-header-content">
            <h2 class="clipx-title">Sign in to ClipX</h2>
            <p class="clipx-subtitle">Connect your wallet to start tipping</p>
        </div>
    </div>
    <div class="clipx-body">
        <button class="clipx-btn clipx-btn-primary" id="clipx-twitter-login-btn" style="margin-bottom: 16px;">
            Sign in with Twitter
        </button>
        /* <button class="clipx-btn clipx-btn-secondary" id="clipx-create-wallet-btn" style="margin-bottom: 16px; background: transparent; border: 1px solid var(--border); color: var(--text-main);">
            Create New Wallet
        </button>
        <button class="clipx-btn clipx-btn-secondary" id="clipx-import-wallet-btn" style="margin-bottom: 16px; background: transparent; border: 1px solid var(--border); color: var(--text-main);">
            Import Wallet
        </button> */
        <div style="text-align: center; margin-bottom: 16px; color: #536471; font-size: 13px;">
            or
        </div>
        <div style="text-align: center; color: #536471; font-size: 13px;">
            Already logged in? <a href="#" id="clipx-refresh-btn" style="color: #1d9bf0; text-decoration: none; font-weight: bold;">Refresh</a>
        </div>
        <button class="clipx-btn clipx-btn-secondary" id="clipx-close-btn">Cancel</button>
    </div>
`;
    } else {
        // Check recipient status
        let isRecipientRegistered = false;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1200);
            const checkResponse = await fetch(`${API_BASE}/api/user-check/${username}`, { signal: controller.signal });
            clearTimeout(timeoutId);
            const checkData = await checkResponse.json();
            isRecipientRegistered = checkData.isRegistered;
        } catch (error) {
            console.log('[ClipX] Recipient check failed:', error);
        }

        const statusBadge = isRecipientRegistered
            ? `<span class="clipx-badge clipx-badge-success">✓ Registered</span>`
            : `<span class="clipx-badge clipx-badge-warning">⏳ Escrow</span>`;

        // Main UI with Tabs
        modal.innerHTML = `
            <div class="clipx-modal-accent" aria-hidden="true"></div>
            <div class="clipx-header clipx-header--tip">
                <div class="clipx-header-content">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div class="clipx-tip-icon" aria-hidden="true">💸</div>
                        <div>
                            <h2 class="clipx-title" style="margin: 0;">ClipX Assistant</h2>
                            <p class="clipx-subtitle" style="margin: 2px 0 0;">⚡ Quick tip</p>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="clipx-body">
                <!-- TIP VIEW (always active - no tabs) -->
                <div id="clipx-view-tip" class="clipx-view active">
                    <div style="margin-bottom: 8px; font-size: 11px; font-weight: 600; color: var(--text-muted); line-height: 1.35;">
                        Send to @${username} ${statusBadge}
                    </div>

                    <div class="clipx-input-group">
                        <label class="clipx-label">Select Token</label>
                        <div class="clipx-grid">
                            ${Object.entries(tokens).map(([key, conf]) => `
                                <div class="clipx-token-card ${key === 'BNB' ? 'selected' : ''}" 
                                     data-token="${key}">
                                    <span class="clipx-token-icon">${conf.icon}</span>
                                    <div class="clipx-token-name">${key}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <div class="clipx-input-group">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <label class="clipx-label" style="margin-bottom: 0;">Amount</label>
                            <span id="clipx-balance" style="font-size: 9px; color: var(--text-muted); font-weight: 600; cursor: pointer;" title="Click to use max">
                                Available: ...
                            </span>
                        </div>
                        <input type="number" class="clipx-amount-input" id="clipx-amount" placeholder="0.00" step="0.000001">
                        <div class="clipx-quick-amounts">
                            ${[0.01, 0.1, 0.5, 1.0].map(amt => `
                                <div class="clipx-chip" data-amount="${amt}">${amt}</div>
                            `).join('')}
                        </div>
                    </div>

                    <div id="clipx-status" style="margin-bottom: 16px; font-size: 11px; color: var(--error); display: none;"></div>

                    <button class="clipx-btn clipx-btn-primary" id="clipx-send-btn">
                        <span>Send Tip</span>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                    </button>
                </div>

                <!-- TRADE VIEW -->
                <div id="clipx-view-trade" class="clipx-view ${initialView === 'trade' ? 'active' : ''}">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-main);">📈 Trade Token</div>
                            <div style="display: flex; align-items: center; gap: 4px; background: rgba(74, 222, 128, 0.1); padding: 2px 6px; border-radius: 8px; border: 1px solid rgba(74, 222, 128, 0.2);">
                                <span style="font-size: 10px;">🛡️</span>
                                <span style="font-size: 9px; color: #4ade80; font-weight: 600;">Flashbots Protect</span>
                            </div>
                        </div>
                        <button class="clipx-settings-btn" id="clipx-trade-settings-btn" title="Settings">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                        </button>
                    </div>
                    <div style="margin-bottom: 16px; border-radius: 12px; overflow: hidden; border: 1px solid var(--border); height: 200px; background: #000;">
                         <iframe 
                            src="${_modalUrls.gmgnKline}"
                            style="width: 100%; height: 100%; border: none;"
                        ></iframe>
                    </div>

                    <!-- Buy/Sell Toggle -->
                    <div style="display: flex; gap: 8px; margin-bottom: 16px; position: relative; z-index: 100;">
                        <button class="clipx-chip" id="clipx-buy-btn" style="flex: 1; background: var(--primary); color: white; border-color: var(--primary); cursor: pointer !important; pointer-events: auto !important; position: relative;">Buy</button>
                        <button class="clipx-chip" id="clipx-sell-btn" style="flex: 1; cursor: pointer !important; pointer-events: auto !important; position: relative;">Sell</button>
                    </div>

                    <div class="clipx-input-group">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <label class="clipx-label" style="margin-bottom: 0;" id="clipx-amount-label">Amount (BNB)</label>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span id="clipx-trade-balance" style="font-size: 10px; color: var(--text-muted); font-weight: 600; cursor: pointer;" title="Click to use max">
                                    Bal: ...
                                </span>
                                <button id="clipx-refresh-balance" style="background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px; font-size: 14px;" title="Refresh balance">
                                    🔄
                                </button>
                            </div>
                        </div>
                        <input type="number" class="clipx-amount-input" id="clipx-trade-amount" placeholder="0.00" step="0.000001">
                        <div class="clipx-quick-amounts" id="clipx-quick-amounts-container">
                            ${[0.1, 0.5, 1.0].map(amt => `
                                <div class="clipx-chip trade-quick-buy" data-amount="${amt}" data-type="bnb">${amt} BNB</div>
                            `).join('')}
                        </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px;">
                        <div>
                            <label class="clipx-label">Slippage %</label>
                            <input type="number" class="clipx-text-input" id="clipx-slippage" value="1" style="font-size: 14px; padding: 8px;">
                        </div>
                        <div>
                            <label class="clipx-label">Gas (Gwei)</label>
                            <input type="number" class="clipx-text-input" id="clipx-gas" value="3" style="font-size: 14px; padding: 8px;">
                        </div>
                    </div>

                    <div style="display: flex; gap: 8px;">
                        <button class="clipx-btn clipx-btn-primary" id="clipx-swap-btn" style="flex: 2;">
                            <span id="clipx-swap-text">Swap</span>
                        </button>
                        <button class="clipx-btn" id="clipx-gmgn-btn" style="flex: 1; background: linear-gradient(135deg, #00d4aa 0%, #00b894 100%); color: white;">
                            GMGN ⚡
                        </button>
                    </div>
                </div>
            </div>
            <button class="clipx-btn clipx-btn-secondary" id="clipx-close-btn" style="margin: 0 16px 16px; width: calc(100% - 32px);">Close</button>
        </div>
        
        <!-- Settings Modal -->
        <div class="clipx-settings-modal" id="clipx-settings-modal">
            <div class="clipx-settings-content">
                <div class="clipx-settings-header">
                    <div class="clipx-settings-title">Trade Settings</div>
                    <button class="clipx-settings-close" id="clipx-close-settings">×</button>
                </div>
                <div style="display: flex; flex-direction: column; gap: 16px;">
                    <!-- Preset Selector -->
                    <div>
                        <label class="clipx-label">Preset</label>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 8px;">
                            <button class="clipx-chip" id="clipx-preset-1" style="cursor: pointer !important; pointer-events: auto !important; position: relative; z-index: 100;">Preset 1</button>
                            <button class="clipx-chip" id="clipx-preset-2" style="cursor: pointer !important; pointer-events: auto !important; position: relative; z-index: 100;">Preset 2</button>
                            <button class="clipx-chip" id="clipx-preset-3" style="cursor: pointer !important; pointer-events: auto !important; position: relative; z-index: 100;">Preset 3</button>
                        </div>
                    </div>
                    <div>
                        <label class="clipx-label">Gas (Gwei)</label>
                        <input type="number" class="clipx-text-input" id="clipx-setting-gas" placeholder="Auto" style="font-size: 14px; padding: 8px;">
                    </div>
                    <div>
                        <label class="clipx-label">Slippage (%)</label>
                        <input type="number" class="clipx-text-input" id="clipx-setting-slippage" value="1" style="font-size: 14px; padding: 8px;">
                    </div>
                    <div>
                        <label class="clipx-label">Quick Buy Amounts (${_modalUrls.nativeSymbol})</label>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
                            <input type="number" class="clipx-text-input" id="clipx-setting-amt1" value="0.1" step="0.1" style="font-size: 14px; padding: 8px;">
                            <input type="number" class="clipx-text-input" id="clipx-setting-amt2" value="0.5" step="0.1" style="font-size: 14px; padding: 8px;">
                            <input type="number" class="clipx-text-input" id="clipx-setting-amt3" value="1.0" step="0.1" style="font-size: 14px; padding: 8px;">
                        </div>
                    </div>
                    <button class="clipx-btn clipx-btn-primary" id="clipx-save-settings">Save to Current Preset</button>
                </div>
            </div>
        </div>
        `;

        // Store state
        let selectedToken = 'BNB';
        const isPrivate = true;
        modal.dataset.registered = isRecipientRegistered;

        // --- SETTINGS LOGIC ---
        const settingsModal = modal.querySelector('#clipx-settings-modal');
        const settingsBtn = modal.querySelector('#clipx-trade-settings-btn');
        const closeSettingsBtn = modal.querySelector('#clipx-close-settings');
        const saveSettingsBtn = modal.querySelector('#clipx-save-settings');
        const settingGasInput = modal.querySelector('#clipx-setting-gas');
        const settingSlippageInput = modal.querySelector('#clipx-setting-slippage');
        const settingAmt1 = modal.querySelector('#clipx-setting-amt1');
        const settingAmt2 = modal.querySelector('#clipx-setting-amt2');
        const settingAmt3 = modal.querySelector('#clipx-setting-amt3');
        const preset1Btn = modal.querySelector('#clipx-preset-1');
        const preset2Btn = modal.querySelector('#clipx-preset-2');
        const preset3Btn = modal.querySelector('#clipx-preset-3');
        const tradeGasInput = modal.querySelector('#clipx-gas');
        const tradeSlippageInput = modal.querySelector('#clipx-slippage');
        const quickBuyBtns = modal.querySelectorAll('.trade-quick-buy');

        let currentPreset = 1; // Track active preset
        let currentSettings = null; // Cache current settings

        // Load and apply settings
        function loadTradeSettings(presetNum = currentPreset) {
            chrome.storage.local.get(['tradePresets'], (result) => {
                const presets = result.tradePresets || {
                    1: { gas: '3', slippage: '1', amounts: [0.1, 0.5, 1.0] },
                    2: { gas: '5', slippage: '2', amounts: [0.01, 0.05, 0.1] },
                    3: { gas: '3', slippage: '5', amounts: [0.5, 1.0, 2.0] }
                };

                currentPreset = presetNum;
                currentSettings = presets[currentPreset];

                // Apply to main inputs
                if (tradeGasInput) tradeGasInput.value = currentSettings.gas;
                if (tradeSlippageInput) tradeSlippageInput.value = currentSettings.slippage;

                // Update quick buy buttons (only in buy mode)
                if (tradeMode === 'buy') {
                    updateQuickBuyButtons(currentSettings.amounts);
                }
            });
        }

        // Update quick buy button display
        function updateQuickBuyButtons(amounts) {
            const quickAmountsContainer = modal.querySelector('#clipx-quick-amounts-container');
            if (!quickAmountsContainer) return;

            quickAmountsContainer.innerHTML = amounts.map(amt => `
                <div class="clipx-chip trade-quick-buy" data-amount="${amt}" data-type="bnb">${amt} BNB</div>
            `).join('');

            // Re-attach click handlers
            quickAmountsContainer.querySelectorAll('.trade-quick-buy').forEach(btn => {
                btn.onclick = () => {
                    const amount = btn.getAttribute('data-amount');
                    const tradeAmountInput = modal.querySelector('#clipx-trade-amount');
                    if (amount && tradeAmountInput) {
                        tradeAmountInput.value = amount;
                    }
                };
            });
        }

        // Preset button handlers
        const updatePresetUI = (activePreset) => {
            [preset1Btn, preset2Btn, preset3Btn].forEach((btn, idx) => {
                if (btn) {
                    if (idx + 1 === activePreset) {
                        btn.style.background = 'var(--primary)';
                        btn.style.color = 'white';
                        btn.style.borderColor = 'var(--primary)';
                    } else {
                        btn.style.background = 'var(--bg-input)';
                        btn.style.color = 'var(--text-muted)';
                        btn.style.borderColor = 'transparent';
                    }
                }
            });
        };

        console.log('[ClipX] Preset buttons found:', {
            preset1: !!preset1Btn,
            preset2: !!preset2Btn,
            preset3: !!preset3Btn
        });

        if (preset1Btn) {
            preset1Btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[ClipX] Preset 1 clicked');
                loadPreset(1);
                updatePresetUI(1);
            });
        }

        if (preset2Btn) {
            preset2Btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[ClipX] Preset 2 clicked');
                loadPreset(2);
                updatePresetUI(2);
            });
        }

        if (preset3Btn) {
            preset3Btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[ClipX] Preset 3 clicked');
                loadPreset(3);
                updatePresetUI(3);
            });
        }

        function loadPreset(presetNum) {
            console.log('[ClipX] Loading preset:', presetNum);
            chrome.storage.local.get(['tradePresets'], (result) => {
                const presets = result.tradePresets || {
                    1: { gas: '3', slippage: '1', amounts: [0.1, 0.5, 1.0] },
                    2: { gas: '5', slippage: '2', amounts: [0.01, 0.05, 0.1] },
                    3: { gas: '3', slippage: '5', amounts: [0.5, 1.0, 2.0] }
                };
                const preset = presets[presetNum];
                currentPreset = presetNum;
                settingGasInput.value = preset.gas;
                settingSlippageInput.value = preset.slippage;
                settingAmt1.value = preset.amounts[0];
                settingAmt2.value = preset.amounts[1];
                settingAmt3.value = preset.amounts[2];
                console.log('[ClipX] Preset loaded:', preset);
            });
        }

        // Open settings modal
        if (settingsBtn) {
            settingsBtn.onclick = () => {
                settingsModal.style.display = 'flex';
                updatePresetUI(currentPreset);
                loadPreset(currentPreset);
            };
        }

        // Close settings modal
        if (closeSettingsBtn) {
            closeSettingsBtn.onclick = () => {
                settingsModal.style.display = 'none';
            };
        }

        // Save settings to current preset
        if (saveSettingsBtn) {
            saveSettingsBtn.onclick = () => {
                chrome.storage.local.get(['tradePresets'], (result) => {
                    const presets = result.tradePresets || {
                        1: { gas: '3', slippage: '1', amounts: [0.1, 0.5, 1.0] },
                        2: { gas: '5', slippage: '2', amounts: [0.01, 0.05, 0.1] },
                        3: { gas: '3', slippage: '5', amounts: [0.5, 1.0, 2.0] }
                    };

                    presets[currentPreset] = {
                        gas: settingGasInput.value,
                        slippage: settingSlippageInput.value,
                        amounts: [
                            parseFloat(settingAmt1.value) || 0.1,
                            parseFloat(settingAmt2.value) || 0.5,
                            parseFloat(settingAmt3.value) || 1.0
                        ]
                    };

                    chrome.storage.local.set({ tradePresets: presets }, () => {
                        loadTradeSettings(currentPreset); // Re-apply settings
                        settingsModal.style.display = 'none';
                    });
                });
            };
        }

        // Quick buy button click handlers
        quickBuyBtns.forEach((btn, index) => {
            btn.onclick = () => {
                const amount = btn.getAttribute('data-amount');
                const tradeAmountInput = modal.querySelector('#clipx-trade-amount');
                console.log('[ClipX] Quick buy clicked:', amount, 'Input found:', !!tradeAmountInput);
                if (amount && tradeAmountInput) {
                    tradeAmountInput.value = amount;
                    console.log('[ClipX] Set amount to:', tradeAmountInput.value);
                }
            };
        });

        console.log('[ClipX] Quick buy buttons initialized:', quickBuyBtns.length);

        // Load settings on modal creation
        loadTradeSettings();

        // --- BUY/SELL TOGGLE LOGIC ---
        let tradeMode = 'buy'; // 'buy' or 'sell'
        const buyBtn = modal.querySelector('#clipx-buy-btn');
        const sellBtn = modal.querySelector('#clipx-sell-btn');
        const swapText = modal.querySelector('#clipx-swap-text');
        const amountLabel = modal.querySelector('#clipx-amount-label');

        let tokenBalance = 0; // Store token balance for sell mode
        let balanceRefreshInterval = null; // Store interval ID for cleanup
        let authWarningShown = false; // Prevent spam warnings

        // Function to refresh BNB balance from backend
        const refreshBnbBalance = async () => {
            try {
                // Get fresh auth token and address
                const storage = await chrome.storage.local.get(['authToken', 'cachedBalance', 'userAddress']);
                const currentAuthToken = storage.authToken;
                const walletAddress = storage.userAddress || balances.wallet?.address;

                // Helper to fetch via RPC
                const fetchViaRpc = async () => {
                    if (!walletAddress) return false;
                    return new Promise((resolve) => {
                        chrome.runtime.sendMessage({
                            action: 'getBnbBalance',
                            walletAddress: walletAddress
                        }, (response) => {
                            if (response && response.success) {
                                balances.balance = response.balance;
                                if (tradeMode === 'buy') {
                                    const tradeBalanceEl = modal.querySelector('#clipx-trade-balance');
                                    if (tradeBalanceEl) {
                                        const formatted = parseFloat(balances.balance || 0).toFixed(4);
                                        tradeBalanceEl.textContent = `Bal: ${formatted} BNB`;
                                        tradeBalanceEl.style.color = '#3b82f6'; // Blue for RPC live data
                                        tradeBalanceEl.title = 'Live balance via RPC (login to refresh full dashboard)';
                                    }
                                }
                                resolve(true);
                            } else {
                                resolve(false);
                            }
                        });
                    });
                };

                // Helper to use cache
                const useCache = () => {
                    if (storage.cachedBalance?.balance) {
                        balances.balance = storage.cachedBalance.balance;
                        if (tradeMode === 'buy') {
                            const tradeBalanceEl = modal.querySelector('#clipx-trade-balance');
                            if (tradeBalanceEl) {
                                const formatted = parseFloat(balances.balance || 0).toFixed(4);
                                tradeBalanceEl.textContent = `Bal: ${formatted} BNB`;
                                tradeBalanceEl.style.color = '#fbbf24'; // Yellow for cached
                                tradeBalanceEl.title = 'Using cached balance (login to refresh)';
                            }
                        }
                    }
                };

                if (!currentAuthToken) {
                    if (!authWarningShown) {
                        console.warn('[ClipX] No auth token, trying RPC fallback');
                        authWarningShown = true;
                    }
                    // Try RPC first
                    const rpcSuccess = await fetchViaRpc();
                    if (!rpcSuccess) useCache();
                    return;
                }

                // Native Wallet Support: Skip backend API, use RPC directly
                if (currentAuthToken === 'native-wallet') {
                    const rpcSuccess = await fetchViaRpc();
                    if (!rpcSuccess) useCache();
                    return;
                }

                const response = await fetch(`${API_BASE}/api/dashboard`, {
                    headers: { 'Authorization': `Bearer ${currentAuthToken}` }
                });

                if (response.status === 401) {
                    if (!authWarningShown) {
                        console.warn('[ClipX] Auth token expired, trying RPC fallback');
                        authWarningShown = true;
                    }
                    // Try RPC first
                    const rpcSuccess = await fetchViaRpc();
                    if (!rpcSuccess) useCache();
                    return;
                }

                if (response.ok) {
                    const data = await response.json();
                    balances.balance = data.balance;
                    authWarningShown = false; // Reset warning flag on success

                    // Update cached balance
                    chrome.storage.local.set({ cachedBalance: data });

                    console.log('[ClipX] BNB balance refreshed:', balances.balance);

                    // Update UI if in buy mode
                    if (tradeMode === 'buy') {
                        const tradeBalanceEl = modal.querySelector('#clipx-trade-balance');
                        if (tradeBalanceEl) {
                            const formatted = parseFloat(balances.balance || 0).toFixed(4);
                            tradeBalanceEl.textContent = `Bal: ${formatted} BNB`;
                            tradeBalanceEl.style.color = 'var(--text-muted)'; // Normal color
                            tradeBalanceEl.title = 'Click to use max';
                        }
                    }
                }
            } catch (error) {
                console.error('[ClipX] Failed to refresh BNB balance:', error);
                // Try RPC then cache on error
                const storage = await chrome.storage.local.get(['cachedBalance', 'userAddress']);
                const walletAddress = storage.userAddress || balances.wallet?.address;

                const fetchViaRpc = async () => {
                    if (!walletAddress) return false;
                    return new Promise((resolve) => {
                        chrome.runtime.sendMessage({
                            action: 'getBnbBalance',
                            walletAddress: walletAddress
                        }, (response) => {
                            if (response && response.success) {
                                balances.balance = response.balance;
                                if (tradeMode === 'buy') {
                                    const tradeBalanceEl = modal.querySelector('#clipx-trade-balance');
                                    if (tradeBalanceEl) {
                                        const formatted = parseFloat(balances.balance || 0).toFixed(4);
                                        tradeBalanceEl.textContent = `Bal: ${formatted} BNB`;
                                        tradeBalanceEl.style.color = '#3b82f6'; // Blue for RPC
                                        tradeBalanceEl.title = 'Live balance via RPC';
                                    }
                                }
                                resolve(true);
                            } else {
                                resolve(false);
                            }
                        });
                    });
                };

                const rpcSuccess = await fetchViaRpc();
                if (!rpcSuccess && storage.cachedBalance?.balance) {
                    balances.balance = storage.cachedBalance.balance;
                    if (tradeMode === 'buy') {
                        const tradeBalanceEl = modal.querySelector('#clipx-trade-balance');
                        if (tradeBalanceEl) {
                            const formatted = parseFloat(balances.balance || 0).toFixed(4);
                            tradeBalanceEl.textContent = `Bal: ${formatted} BNB`;
                            tradeBalanceEl.style.color = '#fbbf24'; // Yellow for cached
                            tradeBalanceEl.title = 'Using cached balance (error occurred)';
                        }
                    }
                }
            }
        };

        // Function to refresh token balance
        const refreshTokenBalance = async () => {
            if (tradeMode === 'sell' && initialAddress) {
                try {
                    const balance = await fetchTokenBalance(initialAddress);
                    tokenBalance = balance;
                    const tradeBalanceEl = modal.querySelector('#clipx-trade-balance');
                    if (tradeBalanceEl) {
                        const formatted = parseFloat(balance).toFixed(2);
                        tradeBalanceEl.textContent = `Bal: ${formatted} Tokens`;
                    }
                    console.log('[ClipX] Token balance refreshed:', tokenBalance);
                } catch (error) {
                    console.error('[ClipX] Failed to refresh token balance:', error);
                }
            }
        };

        // Combined refresh function
        const refreshCurrentBalance = async () => {
            const refreshBtn = modal.querySelector('#clipx-refresh-balance');
            if (refreshBtn) {
                refreshBtn.style.animation = 'spin 0.5s linear';
                setTimeout(() => { refreshBtn.style.animation = ''; }, 500);
            }

            if (tradeMode === 'buy') {
                await refreshBnbBalance();
            } else {
                await refreshTokenBalance();
            }
        };

        // Manual refresh button handler
        const refreshBalanceBtn = modal.querySelector('#clipx-refresh-balance');
        if (refreshBalanceBtn) {
            refreshBalanceBtn.onclick = (e) => {
                e.stopPropagation();
                refreshCurrentBalance();
            };
        }

        // Start auto-refresh interval (every 15 seconds)
        balanceRefreshInterval = setInterval(() => {
            refreshCurrentBalance();
        }, 15000);
        overlay._clipxBalanceRefreshInterval = balanceRefreshInterval;

        // Initial balance load
        refreshCurrentBalance();

        const updateTradeMode = (mode) => {
            tradeMode = mode;
            const quickAmountsContainer = modal.querySelector('#clipx-quick-amounts-container');
            const tradeBalanceEl = modal.querySelector('#clipx-trade-balance');

            if (mode === 'buy') {
                buyBtn.style.background = 'var(--primary)';
                buyBtn.style.color = 'white';
                buyBtn.style.borderColor = 'var(--primary)';
                sellBtn.style.background = 'var(--bg-input)';
                sellBtn.style.color = 'var(--text-muted)';
                sellBtn.style.borderColor = 'transparent';
                swapText.textContent = 'Swap';
                amountLabel.textContent = 'Amount (BNB)';

                // Update balance to show BNB
                refreshBnbBalance();

                // Change buttons to BNB amounts from saved settings
                if (quickAmountsContainer && currentSettings) {
                    updateQuickBuyButtons(currentSettings.amounts);
                }
            } else {
                sellBtn.style.background = '#ef4444';
                sellBtn.style.color = 'white';
                sellBtn.style.borderColor = '#ef4444';
                buyBtn.style.background = 'var(--bg-input)';
                buyBtn.style.color = 'var(--text-muted)';
                buyBtn.style.borderColor = 'transparent';
                swapText.textContent = 'Swap';
                amountLabel.textContent = 'Amount (Tokens)';

                // Fetch token balance
                refreshTokenBalance();

                // Change buttons to percentages
                if (quickAmountsContainer) {
                    quickAmountsContainer.innerHTML = [20, 50, 100].map(pct => `
                        <div class="clipx-chip trade-quick-buy" data-percent="${pct}" data-type="percent">${pct}%</div>
                    `).join('');

                    // Re-attach click handlers for percentages
                    quickAmountsContainer.querySelectorAll('.trade-quick-buy').forEach(btn => {
                        btn.onclick = () => {
                            const percent = parseFloat(btn.getAttribute('data-percent'));
                            const tradeAmountInput = modal.querySelector('#clipx-trade-amount');
                            if (percent && tradeAmountInput && tokenBalance > 0) {
                                const amount = (tokenBalance * percent / 100).toFixed(6);
                                tradeAmountInput.value = amount;
                            }
                        };
                    });
                }
            }
        };

        // Function to fetch token balance using Web3 directly
        const fetchTokenBalance = async (tokenAddress) => {
            try {
                console.log('[ClipX] Fetching token balance for:', tokenAddress);

                // Get wallet address from storage or balances
                const storage = await chrome.storage.local.get(['userAddress']);
                const walletAddress = storage.userAddress || balances.wallet?.address;

                console.log('[ClipX] Wallet address:', walletAddress);

                if (!walletAddress) {
                    console.warn('[ClipX] No wallet address found');
                    return 0;
                }

                // Send message to background script to get token balance
                return new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        action: 'getTokenBalance',
                        tokenAddress: tokenAddress,
                        walletAddress: walletAddress
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            console.error('[ClipX] Error getting token balance:', chrome.runtime.lastError);
                            resolve(0);
                            return;
                        }

                        if (response && response.success) {
                            console.log('[ClipX] Token balance:', response.balance);
                            resolve(response.balance);
                        } else {
                            console.error('[ClipX] Failed to get token balance:', response?.error);
                            resolve(0);
                        }
                    });
                });
            } catch (error) {
                console.error('[ClipX] Error fetching token balance:', error);
                return 0;
            }
        };

        console.log('[ClipX] Buy button:', buyBtn, 'Sell button:', sellBtn);

        if (buyBtn) {
            buyBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[ClipX] Buy button clicked');
                updateTradeMode('buy');
            }, true);
        }

        if (sellBtn) {
            sellBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[ClipX] Sell button clicked');
                updateTradeMode('sell');
            }, true);
        }
        // Initialize to buy mode
        updateTradeMode('buy');

        // Get references to elements that will be used multiple times
        const tradeBalanceEl = modal.querySelector('#clipx-trade-balance');
        const tradeAmountInput = modal.querySelector('#clipx-trade-amount');

        // Click balance to use max
        if (tradeBalanceEl && tradeAmountInput) {
            tradeBalanceEl.addEventListener('click', () => {
                if (tradeMode === 'buy') {
                    // For buy mode, use BNB balance minus gas
                    const bnbBal = balances.balance || 0;
                    const maxBuy = Math.max(0, parseFloat(bnbBal) - 0.001).toFixed(6);
                    tradeAmountInput.value = maxBuy;
                } else {
                    // For sell mode, use 100% of token balance
                    if (tokenBalance > 0) {
                        tradeAmountInput.value = tokenBalance.toFixed(6);
                    }
                }
            });
        }

        // --- TAB LOGIC ---
        const tabs = modal.querySelectorAll('.clipx-tab');
        const views = modal.querySelectorAll('.clipx-view');
        const headerBg = modal.querySelector('#clipx-header-bg');

        tabs.forEach(tab => {
            tab.onclick = () => {
                tabs.forEach(t => t.classList.remove('active'));
                views.forEach(v => v.classList.remove('active'));

                tab.classList.add('active');
                const viewId = `clipx-view-${tab.dataset.tab}`;
                const view = modal.querySelector(`#${viewId}`);
                if (view) view.classList.add('active');

                // Adjust header for Trade tab
                if (tab.dataset.tab === 'trade') {
                    if (headerBg) headerBg.style.background = 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)';
                } else {
                    // Restore Tip gradient (based on selected token)
                    if (headerBg) headerBg.style.background = tokens[selectedToken].gradient;
                }
            };
        });

        // --- TRADE LOGIC ---
        const tradeBtn = modal.querySelector('#clipx-trade-btn'); // Keep old one just in case
        const tradePopupBtn = modal.querySelector('#clipx-trade-popup-btn'); // New button
        const fourMemeBtn = modal.querySelector('#clipx-fourmeme-btn'); // FourMeme button
        const tradeInput = modal.querySelector('#clipx-trade-address');

        const openTradeWindow = (address) => {
            if (!address) return;
            const width = 375;
            const height = 600;
            const left = (screen.width - width) / 2;
            const top = (screen.height - height) / 2;
            const swapUrls = clipxChainUrls(chain, address);
            window.open(swapUrls.gmgnSwap, 'gmgn_swap', `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`);
        };

        const openGMGNWindow = (address) => {
            if (!address) return;
            const width = 450;
            const height = 750;
            const left = (screen.width - width) / 2;
            const top = (screen.height - height) / 2;
            const gmgnUrls = clipxChainUrls(chain, address);
            window.open(gmgnUrls.gmgn + '?r=captain', 'gmgn_trade', `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`);
        };

        const nativeSwapBtn = modal.querySelector('#clipx-native-swap-btn');
        const swapAmountInput = modal.querySelector('#clipx-swap-amount');
        const slippageInput = modal.querySelector('#clipx-slippage');
        const gasPriceInput = modal.querySelector('#clipx-gas-price');
        const swapStatus = modal.querySelector('#clipx-swap-status');

        if (nativeSwapBtn && swapAmountInput) {
            nativeSwapBtn.onclick = async () => {
                const amount = swapAmountInput.value;
                if (!amount || parseFloat(amount) <= 0) {
                    swapStatus.textContent = 'Please enter a valid amount';
                    swapStatus.style.color = '#f4212e';
                    return;
                }

                const slippage = slippageInput?.value || 10;
                const gasPrice = gasPriceInput?.value || null;

                swapStatus.textContent = 'Swapping...';
                swapStatus.style.color = '#536471';
                nativeSwapBtn.disabled = true;
                nativeSwapBtn.style.opacity = '0.7';

                const nativeSwapAction = chain === 'sol' ? 'solSwap' : 'swap';
                chrome.runtime.sendMessage({
                    action: nativeSwapAction,
                    tokenAddress: initialAddress,
                    amount: amount,
                    type: 'buy',
                    slippage: slippage,
                    gasPrice: gasPrice
                }, (response) => {
                    nativeSwapBtn.disabled = false;
                    nativeSwapBtn.style.opacity = '1';

                    if (response && response.success) {
                        swapStatus.innerHTML = `✅ Success! <a href="${_modalUrls.explorerTx(response.txHash)}" target="_blank" style="color: #1d9bf0;">View TX</a>`;
                        swapStatus.style.color = '#00ba7c';
                    } else {
                        const errorMsg = response.error || 'Failed';
                        if (errorMsg.includes('revert') || errorMsg.includes('liquidity') || errorMsg.includes('INSUFFICIENT')) {
                            const dexName = chain === 'sol' ? 'Jupiter' : 'PancakeSwap';
                            swapStatus.innerHTML = `⚠️ No liquidity on ${dexName}.<br><small style="color: #536471;">Use "Trade on GMGN" button below ⬇️</small>`;
                            swapStatus.style.color = '#f4212e';
                        } else {
                            swapStatus.textContent = `❌ ${errorMsg}`;
                            swapStatus.style.color = '#f4212e';
                        }
                    }
                });
            };
        }

        if (tradePopupBtn && tradeInput) {
            tradePopupBtn.onclick = () => {
                const address = tradeInput.value.trim();
                openTradeWindow(address);
            };
        }

        const gmgnBtn = modal.querySelector('#clipx-gmgn-btn');

        if (gmgnBtn) {
            gmgnBtn.onclick = () => {
                window.open(_modalUrls.gmgn + '?ref=captain', '_blank');
            };
        }

        // Success Sound using AudioContext (Reliable & No external files)
        const playSuccessSound = () => {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!AudioContext) return;

                const ctx = new AudioContext();
                const oscillator = ctx.createOscillator();
                const gainNode = ctx.createGain();

                oscillator.connect(gainNode);
                gainNode.connect(ctx.destination);

                // "Coin" sound effect: High pitch, quick decay
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(1200, ctx.currentTime);
                oscillator.frequency.exponentialRampToValueAtTime(2000, ctx.currentTime + 0.1);

                gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);

                oscillator.start(ctx.currentTime);
                oscillator.stop(ctx.currentTime + 0.3);
            } catch (e) {
                console.warn('AudioContext error:', e);
            }
        };
        // New Swap Button Handler (Buy/Sell)
        const swapBtn = modal.querySelector('#clipx-swap-btn');
        // swapText is already defined in outer scope

        // Error Modal
        const showErrorModal = (message) => {
            const errorModal = document.createElement('div');
            errorModal.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.8);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 2000;
                backdrop-filter: blur(4px);
                animation: fadeIn 0.3s ease;
            `;

            errorModal.innerHTML = `
                <div style="background: var(--bg-card); padding: 24px; border-radius: 16px; text-align: center; width: 80%; border: 1px solid rgba(239, 68, 68, 0.3); box-shadow: 0 10px 40px rgba(0,0,0,0.5); transform: scale(0.9); animation: popIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;">
                    <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
                    <h3 style="margin: 0 0 8px 0; color: #ef4444; font-size: 20px;">Transaction Failed</h3>
                    <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 13px;">
                        ${message}
                    </p>
                    <button id="clipx-error-close" style="width: 100%; padding: 10px; background: var(--bg-input); color: var(--text-main); border: 1px solid var(--border); border-radius: 8px; font-weight: 600; cursor: pointer;">
                        Close
                    </button>
                </div>
            `;

            modal.appendChild(errorModal);

            errorModal.querySelector('#clipx-error-close').onclick = () => {
                errorModal.remove();
            };
        };

        if (swapBtn && tradeAmountInput) {
            // Set initial button text
            if (swapText) swapText.textContent = 'Swap';
            else swapBtn.textContent = 'Swap';

            swapBtn.onclick = async () => {
                const amount = parseFloat(tradeAmountInput.value);
                if (!amount || amount <= 0) {
                    showErrorModal('Please enter a valid amount');
                    return;
                }

                const isBuy = tradeMode === 'buy';

                // Client-side balance validation
                if (isBuy) {
                    const bnbBal = parseFloat(balances.balance || 0);
                    if (amount > bnbBal) {
                        showErrorModal(`Insufficient BNB balance. You have ${bnbBal.toFixed(4)} BNB but are trying to spend ${amount} BNB.`);
                        return;
                    }
                    // Gas buffer check (leave 0.002 BNB for gas)
                    if (amount > bnbBal - 0.002) {
                        showErrorModal(`Insufficient BNB for gas. Please leave at least 0.002 BNB for transaction fees.`);
                        return;
                    }
                } else {
                    // Sell mode validation
                    if (tokenBalance > 0 && amount > tokenBalance) {
                        showErrorModal(`Insufficient token balance. You have ${tokenBalance.toFixed(2)} tokens.`);
                        return;
                    }
                }

                const tokenAddress = initialAddress; // The token we are viewing
                const slippage = modal.querySelector('#clipx-slippage')?.value || 1;
                const gasPrice = modal.querySelector('#clipx-gas')?.value || 5;

                // Show loading state
                const originalText = swapText ? swapText.textContent : swapBtn.textContent;
                if (swapText) swapText.textContent = 'Swapping...';
                else swapBtn.textContent = 'Swapping...';

                swapBtn.disabled = true;
                swapBtn.style.opacity = '0.7';

                console.log(`[ClipX] Swap button clicked. Mode: ${tradeMode}, Amount: ${amount}, Token: ${tokenAddress}`);

                const advSwapAction = chain === 'sol' ? 'solSwap' : 'swap';
                chrome.runtime.sendMessage({
                    action: advSwapAction,
                    type: isBuy ? 'buy' : 'sell',
                    amount: amount.toString(),
                    tokenAddress: tokenAddress,
                    slippage: slippage,
                    gasPrice: gasPrice
                }, (response) => {
                    // Reset button state
                    if (swapText) swapText.textContent = 'Swap';
                    else swapBtn.textContent = 'Swap';

                    swapBtn.disabled = false;
                    swapBtn.style.opacity = '1';

                    if (chrome.runtime.lastError) {
                        console.error('[ClipX] Runtime error:', chrome.runtime.lastError);
                        showErrorModal('Extension Error: ' + chrome.runtime.lastError.message);
                        return;
                    }

                    if (response && response.success) {
                        console.log('[ClipX] Swap successful:', response);

                        // Play sound
                        playSuccessSound();

                        // Show success modal
                        const successModal = document.createElement('div');
                        successModal.style.cssText = `
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 100%;
                            height: 100%;
                            background: rgba(0,0,0,0.8);
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            z-index: 2000;
                            backdrop-filter: blur(4px);
                            animation: fadeIn 0.3s ease;
                        `;

                        successModal.innerHTML = `
                            <div style="background: var(--bg-card); padding: 24px; border-radius: 16px; text-align: center; width: 80%; border: 1px solid var(--border); box-shadow: 0 10px 40px rgba(0,0,0,0.5); transform: scale(0.9); animation: popIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;">
                                <div style="font-size: 48px; margin-bottom: 16px;">🎉</div>
                                <h3 style="margin: 0 0 8px 0; color: #4ade80; font-size: 20px;">Swap Successful!</h3>
                                <p style="margin: 0 0 16px 0; color: var(--text-muted); font-size: 13px;">
                                    Successfully ${isBuy ? 'bought' : 'sold'} ${amount} ${isBuy ? _modalUrls.nativeSymbol : 'Tokens'}
                                </p>
                                <a href="${_modalUrls.explorerTx(response.txHash)}" target="_blank" style="display: block; margin-bottom: 16px; color: var(--primary); text-decoration: none; font-size: 12px; background: rgba(29, 155, 240, 0.1); padding: 8px; border-radius: 8px;">
                                    View on ${chain === 'sol' ? 'Solscan' : 'BscScan'} ↗
                                </a>
                                <button id="clipx-success-close" style="width: 100%; padding: 10px; background: var(--primary); color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer;">
                                    Continue Trading
                                </button>
                            </div>
                            <style>
                                @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
                                @keyframes popIn { from { transform: scale(0.9); } to { transform: scale(1); } }
                            </style>
                        `;

                        modal.appendChild(successModal);

                        successModal.querySelector('#clipx-success-close').onclick = () => {
                            successModal.remove();
                            // Refresh balance after successful swap
                            refreshCurrentBalance();
                        };

                    } else {
                        console.error('[ClipX] Swap failed:', response?.error);
                        showErrorModal(response?.error || 'Unknown error occurred');
                    }
                });
            };
        }

        if (tradeBtn && tradeInput) {
            tradeBtn.onclick = () => {
                const address = tradeInput.value.trim();
                openTradeWindow(address);
            };
        }

        // --- TIP LOGIC (Existing) ---
        const CLIPX_TOKEN_ADDR = '0xc269d59a0d608ea0bd672f2f4616c372d8554444';

        const refreshTipBalancesFromServer = async () => {
            const authStore = await chrome.storage.local.get(['authToken', 'webAuthToken', 'nativeWallet']);
            const sessionToken = authStore.authToken || authStore.webAuthToken;
            if (!sessionToken) return;

            if (sessionToken === 'native-wallet') {
                const addr = authStore.nativeWallet?.address;
                if (!addr) return;
                const [bnbRes, clipxRes] = await Promise.all([
                    new Promise((resolve) => {
                        chrome.runtime.sendMessage({ action: 'getBnbBalance', walletAddress: addr }, resolve);
                    }),
                    new Promise((resolve) => {
                        chrome.runtime.sendMessage({
                            action: 'getTokenBalance',
                            tokenAddress: CLIPX_TOKEN_ADDR,
                            walletAddress: addr
                        }, resolve);
                    })
                ]);
                if (bnbRes && bnbRes.success) balances.balance = bnbRes.balance;
                if (clipxRes && clipxRes.success) balances.clipxBalance = clipxRes.balance;
                await chrome.storage.local.set({
                    cachedBalance: {
                        ...balances,
                        wallet: { address: addr }
                    }
                });
                return;
            }

            try {
                const res = await fetch(`${API_BASE}/api/dashboard`, {
                    headers: { Authorization: `Bearer ${sessionToken}` }
                });
                if (!res.ok) return;
                const data = await res.json();
                Object.assign(balances, data);
                await chrome.storage.local.set({ cachedBalance: data });
            } catch (e) {
                console.warn('[ClipX] Tip modal: dashboard balance refresh failed', e);
            }
        };

        // Balance helper
        const updateBalanceDisplay = (token) => {
            const el = modal.querySelector('#clipx-balance');
            if (!el) return;

            let bal = 0;
            if (token === 'BNB') bal = balances.balance;
            else if (token === 'CLIPX') bal = balances.clipxBalance;
            else if (token === 'ASTER') bal = balances.asterBalance;
            else if (token === 'USDT') bal = balances.usdtBalance;
            else if (token === 'GIGGLE') bal = balances.giggleBalance;

            const formatted = parseFloat(bal || 0).toFixed(4);
            el.textContent = `Available: ${formatted} ${token}`;
            el.dataset.max = bal || 0;
        };

        // Update Trade Token balance
        const updateTradeBalance = () => {
            const tradeBalEl = modal.querySelector('#clipx-trade-balance');
            if (!tradeBalEl) return;

            const bnbBal = balances.balance || 0;
            const formatted = parseFloat(bnbBal).toFixed(4);
            tradeBalEl.textContent = `Bal: ${formatted} BNB`;
        };

        // Initial balance — fetch fresh dashboard so linked ClipX / crosspost wallet matches the app
        (async () => {
            await refreshTipBalancesFromServer();
            updateBalanceDisplay(selectedToken);
            updateTradeBalance();
            if (overlay._clipxAnchorReposition) {
                requestAnimationFrame(() => overlay._clipxAnchorReposition());
            }
        })();

        // Max balance click
        const balanceEl = modal.querySelector('#clipx-balance');
        const amountInput = modal.querySelector('#clipx-amount');
        if (balanceEl && amountInput) {
            balanceEl.onclick = () => {
                const max = parseFloat(balanceEl.dataset.max || 0);
                if (selectedToken === 'BNB') {
                    amountInput.value = Math.max(0, max - 0.0005).toFixed(4);
                } else {
                    amountInput.value = max;
                }
                amountInput.dispatchEvent(new Event('input'));
            };
        }

        // Token selection logic
        const tokenCards = modal.querySelectorAll('.clipx-token-card');

        // Set initial header gradient
        if (headerBg) {
            if (initialView === 'trade') {
                headerBg.style.background = 'linear-gradient(135deg, #00ff88 0%, #00cc6a 100%)';
            } else {
                headerBg.style.background = tokens['BNB'].gradient;
            }
        }

        tokenCards.forEach(card => {
            card.onclick = () => {
                // Update UI
                tokenCards.forEach(c => {
                    c.classList.remove('selected');
                    c.style.borderColor = '';
                    c.style.boxShadow = '';
                });

                const token = card.dataset.token;
                selectedToken = token;

                card.classList.add('selected');
                card.style.borderColor = tokens[token].color;
                card.style.boxShadow = `0 2px 4px ${tokens[token].color}20`;

                // Update header gradient
                if (headerBg) headerBg.style.background = tokens[token].gradient;

                // Update balance
                updateBalanceDisplay(token);

                // Trigger input update for USD calc
                if (amountInput) amountInput.dispatchEvent(new Event('input'));
            };
        });

        // Quick amounts logic
        modal.querySelectorAll('.clipx-chip').forEach(chip => {
            chip.onclick = () => {
                if (amountInput) {
                    amountInput.value = chip.dataset.amount;
                }
            };
        });

        // Send handler
        const sendBtn = modal.querySelector('#clipx-send-btn');
        if (sendBtn) {
            sendBtn.onclick = async () => {
                const amount = amountInput ? amountInput.value : 0;
                const statusDiv = modal.querySelector('#clipx-status');

                const parsedAmount = parseFloat(amount);

                if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
                    if (statusDiv) {
                        statusDiv.style.display = 'block';
                        statusDiv.textContent = 'Please enter a valid amount';
                    }
                    return;
                }

                sendBtn.disabled = true;
                sendBtn.innerHTML = '<span>Sending...</span>';
                if (statusDiv) statusDiv.style.display = 'none';

                const isEscrow = !isRecipientRegistered;

                try {
                    const response = await chrome.runtime.sendMessage({
                        action: 'sendTip',
                        recipient: username,
                        amount: amount,
                        token: selectedToken,
                        gasTier: 'standard',
                        isPrivate: isPrivate,
                        isEscrow: isEscrow
                    });

                    if (response.success) {
                        const statusMessage = isEscrow
                            ? `📦 Sent to escrow - @${username} has 3 days to claim`
                            : isPrivate
                                ? `🔒 Private tip sent to @${username}`
                                : `🎉 Public tip sent to @${username}`;

                        modal.innerHTML = `
                            <div class="clipx-modal-accent" aria-hidden="true"></div>
                            <div style="text-align: center; padding: 32px 22px 28px;">
                                <div style="font-size: 52px; margin-bottom: 12px; line-height: 1; animation: clipx-success-pop 0.55s cubic-bezier(0.34, 1.45, 0.64, 1);">✅</div>
                                <h2 style="margin: 0 0 10px; color: var(--text-main); font-size: 22px; font-weight: 800; letter-spacing: -0.02em;">Tip Sent!</h2>
                                <p style="color: var(--text-muted); margin-bottom: 20px; font-size: 13px; line-height: 1.5;">
                                    ${statusMessage}
                                </p>
                                <div style="background: rgba(24, 24, 27, 0.9); border: 1px solid var(--border); padding: 10px 12px; border-radius: 10px; font-family: ui-monospace, monospace; font-size: 11px; color: var(--text-muted); margin-bottom: 22px;">
                                    TX: ${response.txHash.slice(0, 10)}...${response.txHash.slice(-8)}
                                </div>
                                <button class="clipx-btn clipx-btn-primary" id="clipx-close-success">
                                    Close
                                </button>
                            </div>
                        `;
                        const closeSuccess = modal.querySelector('#clipx-close-success');
                        if (closeSuccess) closeSuccess.onclick = () => clipxCloseTipModalOverlay(overlay);
                        if (overlay._clipxAnchorReposition) {
                            requestAnimationFrame(() => overlay._clipxAnchorReposition());
                        }
                    } else {
                        throw new Error(response.error);
                    }
                } catch (err) {
                    if (statusDiv) {
                        statusDiv.style.display = 'block';
                        statusDiv.textContent = err.message || 'Failed to send tip';
                    }
                    sendBtn.disabled = false;
                    sendBtn.innerHTML = '<span>Send Tip</span><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
                }
            };
        }
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    if (anchorEl) {
        const bind = clipxBindTipModalAnchor(overlay, modal, anchorEl);
        overlay._clipxAnchorDispose = bind.dispose;
        overlay._clipxAnchorReposition = bind.reposition;
        setTimeout(() => bind.reposition(), 0);
    }

    // Event Listeners
    const closeBtn = document.getElementById('clipx-close-btn');
    if (closeBtn) closeBtn.onclick = () => clipxCloseTipModalOverlay(overlay);

    overlay.onclick = (e) => {
        if (e.target === overlay) clipxCloseTipModalOverlay(overlay);
    };

    // Add login logic if needed (reusing previous logic)
    if (!isAuthenticated) {
        const twitterLoginBtn = document.getElementById('clipx-twitter-login-btn');
        if (twitterLoginBtn) {
            twitterLoginBtn.onclick = () => {
                const width = 500;
                const height = 700;
                const left = (screen.width - width) / 2;
                const top = (screen.height - height) / 2;
                const loginWindow = window.open(`${API_BASE.replace(/\/$/, '')}/?autoLogin=true`, 'ClipX Login', `width=${width},height=${height},left=${left},top=${top}`);

                let retryCount = 0;
                const checkInterval = setInterval(async () => {
                    retryCount++;
                    if (retryCount > 60) { // Timeout after ~2 minutes
                        clearInterval(checkInterval);
                        console.log('[ClipX] Auth polling timed out');
                        return;
                    }

                    try {
                        const storage = await chrome.storage.local.get(['authToken']);
                        const headers = storage.authToken ? { 'Authorization': `Bearer ${storage.authToken}` } : {};
                        const authCheck = await fetch(`${API_BASE}/api/auth/user`, {
                            credentials: 'include',
                            headers: headers
                        });

                        // Also check if we got a 401, which means token is invalid or missing
                        if (authCheck.ok) {
                            clearInterval(checkInterval);
                            if (loginWindow && !loginWindow.closed) loginWindow.close();
                            clipxCloseTipModalOverlay(overlay);
                            createModal(username, 'tip', '', tipAnchorEl);
                        } else if (authCheck.status === 401 && retryCount > 5) {
                            // If we consistently get 401s, user probably needs to re-login manually in the popup
                            // Don't kill the loop immediately in case they are just slow to type password,
                            // but if they are idle, we stop eventually (via max retryCount)
                        }
                    } catch (e) { }
                }, 2000);
            };
        }

        const refreshBtn = document.getElementById('clipx-refresh-btn');
        if (refreshBtn) {
            refreshBtn.onclick = async (e) => {
                e.preventDefault();
                try {
                    const storage = await chrome.storage.local.get(['authToken']);
                    const headers = storage.authToken ? { 'Authorization': `Bearer ${storage.authToken}` } : {};
                    const authCheck = await fetch(`${API_BASE}/api/auth/user`, {
                        credentials: 'include',
                        headers: headers
                    });
                    if (authCheck.ok) {
                        clipxCloseTipModalOverlay(overlay);
                        createModal(username, 'tip', '', tipAnchorEl);
                    } else {
                        refreshBtn.textContent = 'Not logged in yet';
                        setTimeout(() => refreshBtn.textContent = 'Refresh', 2000);
                    }
                } catch (e) { }
            };
        }

        /* const createWalletBtn = document.getElementById('clipx-create-wallet-btn');
        if (createWalletBtn) {
            createWalletBtn.onclick = () => {
                createWalletView(modal, overlay, username);
            };
        }

        const importWalletBtn = modal.querySelector('#clipx-import-wallet-btn');
        if (importWalletBtn) {
            importWalletBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Open the wallet management page (options.html) where import is available
                chrome.runtime.sendMessage({ action: 'openOptionsPage' });
                overlay.remove();
            };
        } */
    }
}

// Create Wallet View
function createWalletView(modal, overlay, username) {
    modal.innerHTML = `
        <div class="clipx-header">
            <div class="clipx-header-content">
                <h2 class="clipx-title">Create Wallet</h2>
                <p class="clipx-subtitle">Generate a new native wallet</p>
            </div>
        </div>
        <div class="clipx-body">
            <div style="margin-bottom: 16px; padding: 12px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; font-size: 12px; color: #fca5a5;">
                <strong>⚠️ IMPORTANT:</strong> This wallet is stored locally. You MUST save your Secret Phrase. We cannot recover it for you.
            </div>
            
            <div id="clipx-wallet-step-1">
                <button class="clipx-btn clipx-btn-primary" id="clipx-generate-btn">
                    Generate New Wallet
                </button>
            </div>

            <div id="clipx-wallet-step-2" style="display: none;">
                <label class="clipx-label">Your Secret Recovery Phrase</label>
                <div id="clipx-mnemonic" style="background: var(--bg-input); padding: 12px; border-radius: 8px; font-family: monospace; margin-bottom: 12px; word-spacing: 4px; line-height: 1.5; border: 1px solid var(--border); user-select: text;"></div>
                <button class="clipx-btn clipx-btn-secondary" id="clipx-copy-mnemonic" style="margin-bottom: 16px;">
                    Copy Phrase
                </button>
                
                <div style="margin-bottom: 16px;">
                    <label class="clipx-label">Set a Password (Required)</label>
                    <input type="password" class="clipx-text-input" id="clipx-wallet-password" placeholder="Password" style="margin-bottom: 8px;">
                    <input type="password" class="clipx-text-input" id="clipx-wallet-password-confirm" placeholder="Confirm Password">
                    <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">This password encrypts your wallet. Don't forget it!</div>
                </div>

                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
                    <input type="checkbox" id="clipx-saved-check" style="width: 16px; height: 16px;">
                    <label for="clipx-saved-check" style="font-size: 12px; color: var(--text-muted);">I have saved my secret phrase securely</label>
                </div>

                <div id="clipx-create-error" style="color: #ef4444; font-size: 12px; margin-bottom: 12px; display: none;"></div>

                <button class="clipx-btn clipx-btn-primary" id="clipx-confirm-wallet" disabled>
                    Encrypt & Save Wallet
                </button>
            </div>

            <button class="clipx-btn clipx-btn-secondary" id="clipx-back-btn" style="margin-top: 12px;">Back</button>
        </div>
    `;

    const generateBtn = modal.querySelector('#clipx-generate-btn');
    const step1 = modal.querySelector('#clipx-wallet-step-1');
    const step2 = modal.querySelector('#clipx-wallet-step-2');
    const mnemonicEl = modal.querySelector('#clipx-mnemonic');
    const copyBtn = modal.querySelector('#clipx-copy-mnemonic');
    const savedCheck = modal.querySelector('#clipx-saved-check');
    const confirmBtn = modal.querySelector('#clipx-confirm-wallet');
    const backBtn = modal.querySelector('#clipx-back-btn');
    const passwordInput = modal.querySelector('#clipx-wallet-password');
    const confirmInput = modal.querySelector('#clipx-wallet-password-confirm');
    const errorDiv = modal.querySelector('#clipx-create-error');

    let walletSessionId = null;
    let walletPhrase = '';

    backBtn.onclick = () => {
        const reopenAnchor = overlay._clipxTipAnchorEl || null;
        createModal(username, 'tip', '', reopenAnchor); // Go back to main login
    };

    generateBtn.onclick = async () => {
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating…';
        try {
            const res = await chrome.runtime.sendMessage({ action: 'clipxGenerateNativeWallet' });
            if (!res || !res.success) {
                throw new Error((res && res.error) || 'Generation failed');
            }
            walletSessionId = res.sessionId;
            walletPhrase = res.phrase;
            mnemonicEl.textContent = walletPhrase;

            step1.style.display = 'none';
            step2.style.display = 'block';
            backBtn.style.display = 'none'; // Prevent going back without saving or cancelling properly
        } catch (e) {
            console.error('Wallet generation failed:', e);
            alert('Failed to generate wallet. Please try again.');
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate New Wallet';
        }
    };

    copyBtn.onclick = () => {
        if (walletPhrase) {
            navigator.clipboard.writeText(walletPhrase);
            copyBtn.textContent = 'Copied!';
            setTimeout(() => copyBtn.textContent = 'Copy Phrase', 2000);
        }
    };

    const validateForm = () => {
        const pass = passwordInput.value;
        const conf = confirmInput.value;
        const isSaved = savedCheck.checked;

        if (isSaved && pass.length >= 6 && pass === conf) {
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '1';
        } else {
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.5';
        }
    };

    savedCheck.onchange = validateForm;
    passwordInput.oninput = validateForm;
    confirmInput.oninput = validateForm;

    confirmBtn.onclick = async () => {
        if (!walletSessionId || !savedCheck.checked) return;

        const password = passwordInput.value;
        if (password !== confirmInput.value) {
            errorDiv.textContent = 'Passwords do not match';
            errorDiv.style.display = 'block';
            return;
        }

        try {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Encrypting... (this may take a moment)';
            errorDiv.style.display = 'none';

            const fin = await chrome.runtime.sendMessage({
                action: 'clipxFinalizeNativeWallet',
                sessionId: walletSessionId,
                password,
            });
            if (!fin || !fin.success) {
                throw new Error((fin && fin.error) || 'Save failed');
            }

            // Success!
            const reopenAnchor = overlay._clipxTipAnchorEl || null;
            clipxCloseTipModalOverlay(overlay);
            createModal(username, 'tip', '', reopenAnchor);

        } catch (e) {
            console.error('Encryption/Save failed:', e);
            errorDiv.textContent = 'Failed to encrypt wallet: ' + e.message;
            errorDiv.style.display = 'block';
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Encrypt & Save Wallet';
        }
    };
}

// --- ClipX Intelligence Scanner ---
/**
 * Resolve @handle for X profile views: /handle, /handle/media, /handle/with_replies, …
 * Not tweet permalinks (/handle/status/…) or app roots (/home, /i/…).
 */
function clipxProfileHandleFromPathname(pathname) {
    const parts = String(pathname || '')
        .split('/')
        .filter(Boolean);
    if (parts.length === 0) return null;
    const first = parts[0];
    if (!/^[a-zA-Z0-9_]{1,30}$/.test(first)) return null;
    const low = first.toLowerCase();
    if (
        ['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'compose', 'i'].includes(
            low,
        )
    ) {
        return null;
    }
    if (parts.length >= 2 && parts[1] === 'status') return null;
    return first;
}

/** Profile owner name row in the main column — not a tweet or quote author row. */
function clipxProfileIdentityUserNameEl() {
    const col = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main');
    if (!col) return null;
    // X uses UserName and/or User-Name on div or span; do not require tag name.
    const sel = '[data-testid="UserName"], [data-testid="User-Name"]';
    const candidates = col.querySelectorAll(sel);
    for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        if (el.closest('article[data-testid="tweet"]')) continue;
        return el;
    }
    return null;
}

/** True when Surf upstream has no entity for this handle (detail 404 NOT_FOUND). */
function clipxSurfDetailIsNotFound(body) {
    if (!body || typeof body !== 'object') return false;
    const e = body.error;
    return !!(e && typeof e === 'object' && e.code === 'NOT_FOUND');
}

/**
 * Parse Surf `GET .../proxy/social/detail` JSON (same shape when proxied by ClipX).
 * Sentiment is usually `data.sentiment.score` (0–1) or `data.sentiment` as a number.
 * Pills display this as 0–100 via `clipxSurfSentimentFormatDisplay`.
 * @returns {{ score: number|null, notFound: boolean, apiError: boolean }}
 */
function clipxSurfSentimentFromDetailBody(body) {
    if (body == null || typeof body !== 'object') {
        return { score: null, notFound: false, apiError: false };
    }
    if (clipxSurfDetailIsNotFound(body)) {
        return { score: null, notFound: true, apiError: false };
    }
    const topErr = body.error;
    if (topErr && typeof topErr === 'object' && topErr.code && topErr.code !== 'NOT_FOUND') {
        return { score: null, notFound: false, apiError: true };
    }
    const d = body.data !== undefined ? body.data : body;
    if (!d || typeof d !== 'object') {
        return { score: null, notFound: false, apiError: !!topErr };
    }
    const sent = d.sentiment;
    let score = null;
    if (typeof sent === 'number' && Number.isFinite(sent)) {
        score = sent;
    } else if (sent && typeof sent === 'object') {
        if (typeof sent.score === 'number' && Number.isFinite(sent.score)) {
            score = sent.score;
        } else if (typeof sent.value === 'number' && Number.isFinite(sent.value)) {
            score = sent.value;
        }
    } else if (typeof sent === 'string') {
        const n = parseFloat(sent);
        if (Number.isFinite(n)) score = n;
    }
    return { score, notFound: false, apiError: false };
}

/**
 * Surf API returns normalized 0–1; show on pills as 0–100 (integer). Values already in 1–100 pass through.
 */
function clipxSurfSentimentFormatDisplay(score) {
    if (score == null || !Number.isFinite(score)) return '';
    const n = Number(score);
    if (n < 0) return '0';
    if (n <= 1) return String(Math.round(n * 100));
    if (n <= 100) return String(Math.round(n));
    return String(Math.min(100, Math.round(n)));
}

/** Stable string so we skip DOM tear-down when Surf state unchanged (stops pill flicker). */
function clipxComputeSurfPillSignature(ss) {
    if (!ss) return 'none';
    if (ss.loading) return 'loading';
    if (ss.error) return 'error';
    const surfSent = clipxSurfSentimentFromDetailBody(ss.detail);
    if (surfSent.score != null && Number.isFinite(surfSent.score)) {
        return `score:${surfSent.score.toFixed(4)}`;
    }
    if (surfSent.notFound) return 'notfound';
    if (surfSent.apiError) return 'apierror';
    if (ss.detail) return 'unknown';
    return 'empty';
}

/** Client cache for Surf detail JSON (server already caches upstream). */
const CLIPX_SURF_TIMELINE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const clipxSurfTimelineCache = new Map();

function clipxSurfTimelineCacheGet(h) {
    const k = String(h || '').toLowerCase();
    const o = clipxSurfTimelineCache.get(k);
    if (!o) return undefined;
    if (Date.now() - o.t > CLIPX_SURF_TIMELINE_CACHE_TTL_MS) {
        clipxSurfTimelineCache.delete(k);
        return undefined;
    }
    return o.payload;
}

function clipxSurfTimelineCacheSet(h, payload) {
    clipxSurfTimelineCache.set(String(h || '').toLowerCase(), { payload, t: Date.now() });
}

/**
 * Skip only the profile owner header row on profile routes — not followers/following lists.
 */
function clipxIsProfileOwnerHeaderUserNameForTimeline(userNameDiv) {
    if (userNameDiv.closest('article[data-testid="tweet"]')) return false;
    const path = window.location.pathname;
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return false;
    const first = parts[0];
    if (!/^[a-zA-Z0-9_]{1,30}$/.test(first)) return false;
    if (['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i', 'compose'].includes(first.toLowerCase())) {
        return false;
    }
    if (parts.length >= 2 && parts[1] === 'status') return false;
    if (
        parts.length >= 2 &&
        (parts[1] === 'followers' ||
            parts[1] === 'following' ||
            parts[1] === 'verified_followers')
    ) {
        return false;
    }
    const profileEl = clipxProfileIdentityUserNameEl();
    return !!(profileEl && userNameDiv === profileEl);
}

function clipxCollectSurfTimelineTargets() {
    const out = [];
    const seen = new WeakSet();
    document.querySelectorAll('[data-testid="UserName"], [data-testid="User-Name"]').forEach((userNameDiv) => {
        if (seen.has(userNameDiv)) return;
        seen.add(userNameDiv);
        if (clipxIsProfileOwnerHeaderUserNameForTimeline(userNameDiv)) return;
        const handle = clipxExtractHandleFromUserNameDiv(userNameDiv);
        if (!handle) return;
        out.push({ userNameDiv, handle: handle.toLowerCase() });
    });
    return out;
}

/** Remove timeline Surf UI (non-project / no score must show nothing). */
function clipxClearTimelineSurfPillsInCell(userNameDiv) {
    if (!userNameDiv) return;
    userNameDiv.querySelectorAll('.clipx-timeline-surf-sentiment').forEach((el) => el.remove());
}

function clipxClearProfileSurfSentimentDom(un) {
    if (!un) return;
    un.querySelectorAll('.clipx-profile-surf-sentiment').forEach((el) => el.remove());
    un.querySelectorAll('[data-clipx-surf-slot="profile"]').forEach((slot) => slot.remove());
}

/** Inline Surf pill for timeline / lists — only when Surf has a project + numeric 7d sentiment. */
function clipxApplyTimelineSurfPillToCell(userNameDiv, detailJson) {
    if (!userNameDiv || !userNameDiv.isConnected) return;

    const surfSent = clipxSurfSentimentFromDetailBody(detailJson);
    const hasScore = surfSent.score != null && Number.isFinite(surfSent.score);

    if (!hasScore) {
        clipxClearTimelineSurfPillsInCell(userNameDiv);
        return;
    }

    const ss = { detail: detailJson, loading: false, error: false };
    const sig = clipxComputeSurfPillSignature(ss);
    const existing = userNameDiv.querySelector('.clipx-timeline-surf-sentiment[data-clipx-surf-sig]');
    if (
        existing &&
        existing.isConnected &&
        userNameDiv.contains(existing) &&
        existing.getAttribute('data-clipx-surf-sig') === sig
    ) {
        return;
    }

    clipxClearTimelineSurfPillsInCell(userNameDiv);

    const slot = clipxEnsureInlineMetaSlot(userNameDiv);
    if (!slot) return;

    const miniCls = 'clipx-timeline-surf-sentiment clipx-surf-mini-pill';
    const miniBase =
        'display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;flex-shrink:0;border:none;';

    const pill = document.createElement('span');
    pill.className = miniCls;
    const s = surfSent.score;
    const { bg, fg } = clipxSurfSentimentTierStyle(s);
    pill.style.cssText = `${miniBase}padding:2px 7px;border-radius:5px;font-size:10px;font-weight:800;letter-spacing:0.02em;line-height:1.25;`;
    pill.style.background = bg;
    pill.style.color = fg;
    pill.style.boxShadow = '0 1px 2px rgba(0,0,0,0.35)';
    pill.textContent = clipxSurfSentimentFormatDisplay(s);
    pill.title = '7-day sentiment score (0–100) for indexed projects';
    pill.setAttribute('data-clipx-surf-sig', sig);
    slot.appendChild(pill);
    try {
        clipxReorderHandleBeforeClipxMeta(userNameDiv);
    } catch (e) {
        /* ignore */
    }
    try {
        clipxApplyTweetNameHandleShrinkClasses(userNameDiv);
    } catch (e) {
        /* ignore */
    }
}

let clipxSurfTimelineInjectTimer = null;
let clipxSurfTimelineInflight = false;
let clipxSurfTimelinePending = false;

function injectClipxSurfSentimentOnPage() {
    if (clipxSurfTimelineInjectTimer) clearTimeout(clipxSurfTimelineInjectTimer);
    clipxSurfTimelineInjectTimer = setTimeout(() => {
        clipxSurfTimelineInjectTimer = null;
        clipxInjectSurfTimelineInner();
    }, 280);
}

function clipxInjectSurfTimelineInner() {
    chrome.storage.local.get(['showSurfSocial'], (r) => {
        if (r.showSurfSocial === false) {
            document.querySelectorAll('.clipx-timeline-surf-sentiment').forEach((el) => el.remove());
            return;
        }

        if (clipxSurfTimelineInflight) {
            clipxSurfTimelinePending = true;
            return;
        }

        const targets = clipxCollectSurfTimelineTargets();
        if (targets.length === 0) return;

        const need = [];
        const seenH = new Set();
        for (const { handle } of targets) {
            if (seenH.has(handle)) continue;
            seenH.add(handle);
            if (clipxSurfTimelineCacheGet(handle) === undefined) need.push(handle);
        }

        const applyAll = () => {
            for (const { userNameDiv, handle } of targets) {
                const payload = clipxSurfTimelineCacheGet(handle);
                if (payload === undefined) continue;
                clipxApplyTimelineSurfPillToCell(userNameDiv, payload);
            }
        };

        if (need.length === 0) {
            applyAll();
            return;
        }

        clipxSurfTimelineInflight = true;
        const chunks = [];
        for (let i = 0; i < need.length; i += 8) {
            chunks.push(need.slice(i, i + 8));
        }

        let idx = 0;
        const runNext = () => {
            if (idx >= chunks.length) {
                clipxSurfTimelineInflight = false;
                applyAll();
                if (clipxSurfTimelinePending) {
                    clipxSurfTimelinePending = false;
                    setTimeout(() => clipxInjectSurfTimelineInner(), 0);
                }
                return;
            }
            const batch = chunks[idx];
            idx += 1;
            chrome.runtime.sendMessage({ action: 'socialIntelBatchTimeline', handles: batch }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.success) {
                    for (const h of batch) {
                        clipxSurfTimelineCacheSet(h, { error: { code: 'BATCH_FAIL' } });
                    }
                } else {
                    const bh = resp.byHandle || {};
                    for (const h of batch) {
                        const entry = bh[h];
                        const j = entry && entry.detail ? entry.detail.j : null;
                        clipxSurfTimelineCacheSet(h, j !== undefined && j !== null ? j : {});
                    }
                }
                runNext();
            });
        };
        runNext();
    });
}

const ProfileScanner = {
    // Utility for conditional class names (adopted from Frontrun demo)
    cn(...args) {
        const classes = [];
        for (const arg of args) {
            if (!arg) continue;
            const type = typeof arg;
            if (type === 'string' || type === 'number') {
                classes.push(arg);
            } else if (Array.isArray(arg)) {
                if (arg.length) {
                    const inner = this.cn(...arg);
                    if (inner) classes.push(inner);
                }
            } else if (type === 'object') {
                if (arg.toString !== Object.prototype.toString && !arg.toString.toString().includes('[native code]')) {
                    classes.push(arg.toString());
                    continue;
                }
                for (const key in arg) {
                    if (Object.prototype.hasOwnProperty.call(arg, key) && arg[key]) {
                        classes.push(key);
                    }
                }
            }
        }
        return classes.join(' ');
    },

    state: {
        handle: null,
        tickers: new Map(), // Map<ticker, { count, tweetId }>
        addresses: new Map(), // Map<address, tweetId>
        mentions: new Map(), // Map<handle, { count, tweetId }>
        bio: '',
        joinedDate: null,
        followers: 0,
        isVerified: false,
        engagement: { avgLikes: 0, avgRetweets: 0 },
        scannedTweets: new WeakSet(), // Use WeakSet for DOM elements
        isInitialized: false,
        isLoading: false,
        apiFetched: false,
        totalTweetsFetched: 0,
        labelCache: {}, // Cache for profile labels
        pendingFetches: new Map(), // Map<handle, Promise> for deduplication
        // TweetScout Smart Followers
        tweetScoutInfo: null, // { score, topFollowers, categories }
        tweetScoutFetched: false,
        smartFollowersExpanded: true, // Expanded by default
        // Premium features (200k CLIPX required)
        isPremiumUser: false,
        premiumChecked: false,
        /** Surf index strip: { loading, user, detail, error } — raw JSON bodies */
        surfSocial: null,
        /** Sorsa TweetScout score (GET /api/sorsa/score/:handle) — profile Intel card + hero avatar */
        sorsaTweetScoutScore: null,
        sorsaTweetScoutScoreLoading: false,
        sorsaTweetScoutScoreError: null,
        sorsaTweetScoutFetched: false,
        sorsaTweetScoutHidden: false,
    },




    // Initialize or Reset for a new profile
    init() {
        const currentHandle = clipxProfileHandleFromPathname(window.location.pathname);

        if (!currentHandle) {
            this.state.handle = null; // Reset handle to stop intervals
            this.removeDashboard();
            return;
        }

        if (this.state.handle !== currentHandle) {
            console.log('[ClipX Intel] New profile active:', currentHandle);
            // Preserve labelCache, pendingFetches, and premium status across profile changes
            const preservedLabelCache = this.state.labelCache || {};
            const preservedPendingFetches = this.state.pendingFetches || new Map();
            const preservedIsPremiumUser = this.state.isPremiumUser || false;
            const preservedPremiumChecked = this.state.premiumChecked || false;
            this.state = {
                handle: currentHandle,
                tickers: new Map(),
                addresses: new Map(),
                mentions: new Map(), // Map<handle, { count, tweetId }>
                bio: '',
                joinedDate: null,
                followers: 0,
                isVerified: false,
                engagement: { avgLikes: 0, avgRetweets: 0 },
                scannedTweets: new WeakSet(),
                isInitialized: true,
                isLoading: false,
                apiFetched: false,
                apiRetried: false,
                totalTweetsFetched: 0,
                labelCache: preservedLabelCache,
                pendingFetches: preservedPendingFetches,
                // TweetScout Smart Followers
                tweetScoutInfo: null,
                tweetScoutFetched: false,
                smartFollowersExpanded: true, // Expanded by default
                // Premium features (preserved across profile changes)
                isPremiumUser: preservedIsPremiumUser,
                premiumChecked: preservedPremiumChecked,
                surfSocial: null,
                sorsaTweetScoutScore: null,
                sorsaTweetScoutScoreLoading: false,
                sorsaTweetScoutScoreError: null,
                sorsaTweetScoutFetched: false,
                sorsaTweetScoutHidden: false,
            };

            this._lastRenderedSmartFollowersHtml = null; // Clear HTML cache for new profile
            this._lastMentionsCount = -1; // Reset mentions count
            this._lastSmartFollowersCount = -1; // Reset follower count tracker

            this.removeDashboard();

            // Check premium status first
            const runProfileIntel = () => {
                setTimeout(() => {
                    this.scanBio(); // Initial bio scan
                    this.checkBioHistory(); // Check for history diffs
                    this.fetchTweetsViaAPI(true); // Force fetch new tweets
                    this.fetchTweetScoutInfo(); // Fetch smart follower data (premium only)
                    this.fetchSurfSocialIntel(); // Surf index strip on profile
                    this.fetchSorsaTweetScoutScore(); // TweetScout Score (Sorsa) — do not block on premium check

                    setTimeout(() => {
                        if (this.state.followers === 0 || !this.state.joinedDate) {
                            console.log('[ClipX Intel] Retrying bio scan for missing data...');
                            this.scanBio();
                        }
                    }, 2000);
                }, 500);
            };
            this.checkPremiumStatus().then(runProfileIntel).catch(() => runProfileIntel());
        }

        // Always try to ensure dashboard key elements exist
        this.injectDashboard();
        this.injectUsernameHistoryButton(); // Remove legacy username history button from profile header

        // Fetch global profile label if exists
        this.fetchProfileLabel();

        // Start dashboard watcher (keep it alive even if Twitter removes it)
        this.startDashboardWatcher();


    },


    // Watch for dashboard removal and re-inject
    startDashboardWatcher() {
        // Clear any existing watcher
        if (this.dashboardWatcher) clearInterval(this.dashboardWatcher);
        this.dashboardWatcher = null;

        // Check every 2 seconds if dashboard is still attached
        this.dashboardWatcher = setInterval(() => {
            if (!this.state.handle) return; // Not on a profile

            const card = document.getElementById('clipx-intel-card');
            const profileHeader = document.querySelector('[data-testid="UserProfileHeader_Items"]');

            // Re-inject if: card missing OR card detached OR header exists but no card
            if (profileHeader && (!card || !card.isConnected)) {
                console.log('[ClipX Intel] Dashboard removed by React, re-injecting...');
                this.injectDashboard();
            }
            // Surf sentiment: name row may mount after socialIntelProfile returns — retry until pill exists or no data.
            if (
                profileHeader &&
                this.state.surfSocial &&
                !this.state.surfSocial.loading &&
                !document.querySelector('.clipx-profile-surf-sentiment')
            ) {
                try {
                    this.injectProfileSurfSentimentPill();
                } catch (e) { /* ignore */ }
            }
            // TweetScout hero pill: re-apply after tab switches / React remounts (same handle, badge detached).
            if (
                profileHeader &&
                this.state.handle &&
                this.state.sorsaTweetScoutFetched &&
                !profileHeader.querySelector('.clipx-sorsa-below-avatar, .clipx-sorsa-avatar-shell')
            ) {
                try {
                    clipxInjectProfileHeroSorsaIfNeeded(this.state.handle, this.state.sorsaTweetScoutScore);
                } catch (e) { /* ignore */ }
            }
        }, 2000);
    },

    // Fetch tweets via background script API (no scrolling needed)
    async fetchTweetsViaAPI(force = false) {
        // Strong duplicate prevention
        if (this.state.apiFetched && !force) {
            console.log('[ClipX Intel] API already fetched, skipping');
            return;
        }
        if (this.state.isLoading) {
            console.log('[ClipX Intel] API fetch already in progress, skipping');
            return;
        }

        // Set flags immediately to prevent race conditions
        this.state.isLoading = true;
        if (!force) this.state.apiFetched = true; // Set early to prevent duplicate calls
        this.updateDashboard();

        console.log('[ClipX Intel] Fetching tweets via API for:', this.state.handle);

        try {
            const response = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'fetchUserTweets',
                    username: this.state.handle,
                    count: 50
                }, resolve);
            });

            if (response && response.success) {
                console.log('[ClipX Intel] API returned', response.totalFetched, 'tweets');

                // Merge API tickers with existing
                (response.tickers || []).forEach(([ticker, data]) => {
                    const existing = this.state.tickers.get(ticker) || { count: 0, tweetId: null };
                    existing.count += data.count;
                    if (!existing.tweetId && data.tweetId) existing.tweetId = data.tweetId;
                    this.state.tickers.set(ticker, existing);
                });

                // Merge API addresses with existing
                (response.addresses || []).forEach(([addr, tweetId]) => {
                    // Only add if not already present or if we want to overwrite (prefer API or preserve?)
                    // Let's preserve existing if present, or update. 
                    // Since API is likely fresher/more comprehensive for history, but DOM is realtime.
                    if (!this.state.addresses.has(addr)) {
                        this.state.addresses.set(addr, tweetId);
                    }
                });

                this.state.totalTweetsFetched = response.totalFetched || 0;
                this.state.apiFetched = true;
                this.state.error = null;

                // Update engagement metrics - ONLY if API has data, don't overwrite DOM metrics
                if (response.metrics && (response.metrics.avgLikes > 0 || response.metrics.avgRetweets > 0)) {
                    // API has engagement data, use it
                    this.state.engagement = response.metrics;
                    console.log('[ClipX Intel] Updated engagement from API:', response.metrics);
                } else {
                    // API has no metrics, keep the DOM-extracted ones
                    console.log('[ClipX Intel] API has no metrics, keeping DOM engagement:', this.state.engagement);
                }

                // Auto-retry if we got too few tweets (less than 10)
                if (response.totalFetched < 10 && !this.state.apiRetried) {
                    console.log('[ClipX Intel] Got few tweets, scheduling retry...');
                    this.state.apiRetried = true;
                    this.state.apiFetched = false;
                    setTimeout(() => {
                        this.fetchTweetsViaAPI(true);
                    }, 2000);
                }
            } else {
                console.log('[ClipX Intel] API fetch failed:', response?.error);
                this.state.error = response?.error || 'Failed to fetch tweets';
                this.state.apiFetched = false; // Allow retry on failure

                // Auto-retry once on failure
                if (!this.state.apiRetried) {
                    console.log('[ClipX Intel] Scheduling retry after failure...');
                    this.state.apiRetried = true;
                    setTimeout(() => {
                        this.fetchTweetsViaAPI(true);
                    }, 2000);
                }
            }
        } catch (e) {
            console.error('[ClipX Intel] API fetch error:', e);
            this.state.error = 'Network error during fetch';
            this.state.apiFetched = false; // Allow retry on failure

            // Auto-retry once on error
            if (!this.state.apiRetried) {
                this.state.apiRetried = true;
                setTimeout(() => {
                    this.fetchTweetsViaAPI(true);
                }, 2000);
            }
        }

        this.state.isLoading = false;
        this.updateDashboard();
    },

    // Scan the user bio
    scanBio() {
        const bioDiv = document.querySelector('div[data-testid="UserDescription"]');
        if (bioDiv) {
            const text = bioDiv.textContent;
            this.state.bio = text;
            this.extractIntel(text);
        }

        // Also get Joined Date
        const header = document.querySelector('div[data-testid="UserProfileHeader_Items"]');
        if (header) {
            const joined = Array.from(header.querySelectorAll('span')).find(s => s.textContent.includes('Joined'));
            if (joined) this.state.joinedDate = joined.textContent.replace('Joined ', '');
        }

        // Scrape Verified Status - multiple selector strategies
        const userNameDiv = document.querySelector('div[data-testid="UserName"]');
        if (userNameDiv) {
            // Check for verified badge (blue checkmark, gold checkmark, etc.)
            const verifiedBadge = userNameDiv.querySelector('svg[aria-label*="Verified"], svg[aria-label*="verified"], [data-testid="icon-verified"]');
            this.state.isVerified = !!verifiedBadge;
            console.log('[ClipX Intel] Verified status:', this.state.isVerified);
        }

        // Scrape Followers Count - multiple strategies
        this.scrapeFollowersCount();

        this.updateDashboard();
    },

    // Dedicated followers scraping with multiple fallback strategies
    scrapeFollowersCount() {
        // Strategy 1: Direct link selector
        let followersLink = document.querySelector(`a[href="/${this.state.handle}/verified_followers"]`);
        if (!followersLink) {
            followersLink = document.querySelector(`a[href="/${this.state.handle}/followers"]`);
        }

        if (followersLink) {
            // Try to find the count - it's usually in a nested span
            const spans = followersLink.querySelectorAll('span');
            for (const span of spans) {
                const text = span.textContent.trim();
                // Look for numeric patterns like "10.5K", "1M", "5,000", "123"
                if (/^[\d.,]+[KMB]?$/i.test(text)) {
                    this.state.followers = this.parseCount(text);
                    console.log('[ClipX Intel] Followers (Strategy 1):', this.state.followers, 'from:', text);
                    return;
                }
            }
        }

        // Strategy 2: Look for text containing "Followers" nearby
        const allLinks = document.querySelectorAll('a[href*="/followers"]');
        for (const link of allLinks) {
            const text = link.textContent;
            // Pattern: "123 Followers" or "10.5K Followers"
            const match = text.match(/([\d.,]+[KMB]?)\s*Followers/i);
            if (match) {
                this.state.followers = this.parseCount(match[1]);
                console.log('[ClipX Intel] Followers (Strategy 2):', this.state.followers, 'from:', match[1]);
                return;
            }
        }

        // Strategy 3: Scan the header items area for follower count
        const headerItems = document.querySelector('div[data-testid="UserProfileHeader_Items"]');
        if (headerItems) {
            const parent = headerItems.parentElement;
            if (parent) {
                // Look for links in parent and siblings
                const links = parent.parentElement?.querySelectorAll('a') || [];
                for (const link of links) {
                    const href = link.getAttribute('href') || '';
                    if (href.includes('/followers')) {
                        const spans = link.querySelectorAll('span');
                        for (const span of spans) {
                            const text = span.textContent.trim();
                            if (/^[\d.,]+[KMB]?$/i.test(text)) {
                                this.state.followers = this.parseCount(text);
                                console.log('[ClipX Intel] Followers (Strategy 3):', this.state.followers, 'from:', text);
                                return;
                            }
                        }
                    }
                }
            }
        }

        console.log('[ClipX Intel] Could not find followers count');
    },

    parseCount(str) {
        if (!str) return 0;
        str = str.toUpperCase().replace(/,/g, '');
        let multi = 1;
        if (str.includes('K')) multi = 1000;
        if (str.includes('M')) multi = 1000000;
        if (str.includes('B')) multi = 1000000000;
        return parseFloat(str) * multi;
    },

    // Scan a single tweet article
    scanTweet(article) {
        if (this.state.scannedTweets.has(article)) return;

        const tweetTextDiv = article.querySelector('div[data-testid="tweetText"]');
        if (!tweetTextDiv) return;

        // Mark as scanned
        this.state.scannedTweets.add(article);

        // Try to get tweet ID for linking
        let tweetId = null;
        const timeLink = article.querySelector('a[href*="/status/"]');
        if (timeLink) {
            const match = timeLink.getAttribute('href').match(/\/status\/(\d+)/);
            if (match) tweetId = match[1];
        }

        // Extract text and analyze
        const text = tweetTextDiv.textContent;
        this.extractIntel(text, tweetId);

        // Check if this is a repost/retweet (NOT an original tweet)
        const isRepost = this.isRepostedTweet(article);

        // Only extract engagement from ORIGINAL tweets by this user
        if (!isRepost) {
            this.extractEngagement(article);
        } else {
            console.log('[ClipX Intel] Skipped repost for engagement');
        }

        // Debounced update
        if (this.updateTimer) clearTimeout(this.updateTimer);
        this.updateTimer = setTimeout(() => {
            this.updateDashboard();
        }, 500);
    },

    // Detect if tweet is a repost/retweet (not original content)
    isRepostedTweet(article) {
        // Strategy 1: Check for "Reposted" text indicator
        const repostIndicator = article.querySelector('[data-testid="socialContext"]');
        if (repostIndicator && repostIndicator.textContent.includes('Reposted')) {
            console.log('[ClipX Intel] Repost detected: socialContext');
            return true;
        }

        // Strategy 2: Check for retweet icon/text near username
        const retweetText = Array.from(article.querySelectorAll('span')).find(s =>
            s.textContent === 'Reposted' || s.textContent === 'Retweeted'
        );
        if (retweetText) {
            console.log('[ClipX Intel] Repost detected: span text');
            return true;
        }

        // Strategy 3: Check if the tweet author is different from profile handle
        const tweetAuthorLink = article.querySelector('a[href^="/"]');
        if (tweetAuthorLink) {
            const href = tweetAuthorLink.getAttribute('href');
            const match = href.match(/^\/([a-zA-Z0-9_]+)/);
            if (match && match[1] && match[1].toLowerCase() !== this.state.handle.toLowerCase()) {
                // Tweet is from a different user = it's a repost
                console.log('[ClipX Intel] Repost detected: different author', match[1], 'vs', this.state.handle);
                return true;
            }
        }

        console.log('[ClipX Intel] Original tweet detected');
        return false; // Assume original tweet if no repost indicators found
    },

    // Extract Tickers, Addresses, and Mentions from text
    extractIntel(text, tweetId = null) {
        const tickerRegex = /\$[a-zA-Z]{2,10}\b/g;
        const addressRegex = /0x[a-fA-F0-9]{40}\b/g;
        const solAddressRegex = /(?<![a-zA-Z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?=[\s,;:!?)}\]<]|$)/g;
        const mentionRegex = /@[a-zA-Z0-9_]{1,15}\b/g;

        const tickers = text.match(tickerRegex) || [];
        const evmAddresses = text.match(addressRegex) || [];
        const solAddresses = (text.match(solAddressRegex) || []).filter(s => clipxIsValidBase58Address(s));
        const addresses = [...evmAddresses, ...solAddresses];
        const mentions = text.match(mentionRegex) || [];

        tickers.forEach(t => {
            const ticker = t.toUpperCase();
            const existing = this.state.tickers.get(ticker) || { count: 0, tweetId: null };
            existing.count++;
            if (!existing.tweetId && tweetId) existing.tweetId = tweetId;
            this.state.tickers.set(ticker, existing);
        });

        addresses.forEach(a => {
            if (!this.state.addresses.has(a)) {
                this.state.addresses.set(a, tweetId);
            }
        });

        mentions.forEach(m => {
            const handle = m.substring(1); // Remove @
            // Skip own handle
            if (handle.toLowerCase() === this.state.handle.toLowerCase()) return;

            const existing = this.state.mentions.get(handle) || { count: 0, tweetId: null };
            existing.count++;
            if (!existing.tweetId && tweetId) existing.tweetId = tweetId;
            this.state.mentions.set(handle, existing);
        });
    },


    // Extract engagement metrics from tweet article
    extractEngagement(article) {
        // Always extract from DOM (don't skip if API fetched, use both sources)
        // Initialize engagement counters if needed
        if (!this.state.engagementData) {
            this.state.engagementData = { totalLikes: 0, totalRetweets: 0, totalReplies: 0, count: 0 };
        }

        // X uses specific test IDs for engagement buttons
        const likeButton = article.querySelector('[data-testid="like"]');
        const retweetButton = article.querySelector('[data-testid="retweet"]');
        const replyButton = article.querySelector('[data-testid="reply"]');

        // Extract counts from aria-label with improved parsing
        const parseEngagementCount = (button, type) => {
            if (!button) return 0;

            const ariaLabel = button.getAttribute('aria-label') || '';
            console.log(`[ClipX Intel] Parsing ${type}:`, ariaLabel);

            // Match patterns like: "569 Likes", "5.2K Retweets", "120 Replies", "174 reposts"
            // Also handle: "Like", "Retweet" (0 count), "1 Like" (singular)
            // Twitter now uses "reposts" instead of "Retweets"
            const match = ariaLabel.match(/([\d,.]+[KMB]?)\s*(Like|Retweet|Repost|Repl|Reply)/i);
            if (match) {
                const count = this.parseCount(match[1]);
                console.log(`[ClipX Intel] ${type} count:`, count);
                return count;
            }

            // If no number found, it means 0
            return 0;
        };

        const likes = parseEngagementCount(likeButton, 'Likes');
        const retweets = parseEngagementCount(retweetButton, 'Retweets');
        const replies = parseEngagementCount(replyButton, 'Replies');

        // Update running totals (only count non-zero tweets)
        if (likes > 0 || retweets > 0 || replies > 0) {
            this.state.engagementData.totalLikes += likes;
            this.state.engagementData.totalRetweets += retweets;
            this.state.engagementData.totalReplies += replies;
            this.state.engagementData.count++;

            // Calculate averages
            const count = this.state.engagementData.count;
            if (count > 0) {
                this.state.engagement.avgLikes = Math.round(this.state.engagementData.totalLikes / count);
                this.state.engagement.avgRetweets = Math.round(this.state.engagementData.totalRetweets / count);
                this.state.engagement.avgReplies = Math.round(this.state.engagementData.totalReplies / count);

                console.log('[ClipX Intel] Updated engagement:', this.state.engagement);
            }
        }
    },

    // Check Bio History (Local Storage)
    async checkBioHistory() {
        if (!this.state.handle || !this.state.bio) return;

        const key = `bio_history_${this.state.handle}`;
        const stored = await chrome.storage.local.get([key]);
        const oldBio = stored[key];

        if (oldBio && oldBio !== this.state.bio) {
            console.log('[ClipX Intel] Bio changed!');
            this.state.bioChanged = true;
            this.state.oldBio = oldBio;
            this.updateDashboard();
        } else if (!oldBio) {
            // First visit, save it
            chrome.storage.local.set({ [key]: this.state.bio });
        }

        // Always update to current (after check)
        chrome.storage.local.set({ [key]: this.state.bio });
    },

    async fetchProfileLabel() {
        if (!this.state.handle) return;

        // Already fetched or fetch in progress for this handle — just re-inject badge
        if (this.state.lastFetchedHandle === this.state.handle || this.state.labelFetchInProgress) {
            this.injectLabelBadge();
            return;
        }

        this.state.labelFetchInProgress = true;

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getProfileLabel',
                handle: this.state.handle
            });

            this.state.lastFetchedHandle = this.state.handle;

            if (response) {
                // If response is null/undefined or empty object, treating as no label
                // If it has label_text or label, use it
                const labelText = response.label_text || response.label;
                const labelColor = response.color || 'purple';

                if (labelText) {
                    this.state.profileLabel = { label: labelText, color: labelColor };
                } else {
                    this.state.profileLabel = { label: null, color: null }; // No label
                }

                this.injectLabelBadge();
                console.log('[ClipX Intel] Fetched label:', this.state.profileLabel);
            }
        } catch (e) {
            console.error('[ClipX Intel] Failed to fetch label:', e);
        } finally {
            this.state.labelFetchInProgress = false;
        }
    },

    async saveProfileLabel(text, color) {
        if (!this.state.handle) return;
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'saveProfileLabel',
                handle: this.state.handle,
                label: text,
                color: color
            });

            if (response && (response.success || response.label_text)) {
                // Update local state immediately
                this.state.profileLabel = { label: text, color: color };
                this.injectLabelBadge(); // Re-inject to show update
                return true;
            } else {
                console.warn('[ClipX Intel] Save failed. Response:', response);
            }
        } catch (e) {
            console.error('[ClipX Intel] Failed to save label (Exception):', e);
            alert('Failed to save label. Check console.');
        }
        return false;
    },

    /** TweetScout Score (Sorsa) — single profile; same metric as avatar batch badges. Verified accounts only (saves API calls). */
    fetchSorsaTweetScoutScore(forceRefresh = false) {
        if (!this.state.handle || (this.state.sorsaTweetScoutFetched && !forceRefresh)) return;

        chrome.storage.local.get(['showSorsaScores'], (r) => {
            if (r.showSorsaScores === false) {
                this.state.sorsaTweetScoutHidden = true;
                this.state.sorsaTweetScoutFetched = true;
                this.state.sorsaTweetScoutScoreLoading = false;
                this.updateDashboard();
                try {
                    this.injectLabelBadge();
                } catch (e) {
                    /* ignore */
                }
                return;
            }

            const finishSkipUnverifiedNoApi = () => {
                this.state.sorsaTweetScoutFetched = true;
                this.state.sorsaTweetScoutHidden = true;
                this.state.sorsaTweetScoutScoreLoading = false;
                this.state.sorsaTweetScoutScore = null;
                this.state.sorsaTweetScoutScoreError = null;
                this.updateDashboard();
                try {
                    this.injectLabelBadge();
                } catch (e) {
                    /* ignore */
                }
            };

            const startSorsaFetch = (h) => {
                this.state.sorsaTweetScoutFetched = true;
                this.state.sorsaTweetScoutHidden = false;
                this.state.sorsaTweetScoutScoreLoading = true;
                this.state.sorsaTweetScoutScoreError = null;
                this.updateDashboard();
                try {
                    this.injectLabelBadge();
                } catch (e) {
                    /* ignore */
                }

                try {
                    clipxInjectProfileHeroSorsaIfNeeded(h, this.state.sorsaTweetScoutScore);
                } catch (e) {
                    console.warn('[ClipX Intel] profile hero Sorsa (loading):', e);
                }
                chrome.runtime.sendMessage(
                    { action: 'getSorsaProfileScore', handle: h },
                    (resp) => {
                        this.state.sorsaTweetScoutScoreLoading = false;
                        if (chrome.runtime.lastError) {
                            console.warn('[ClipX Intel] TweetScout score:', chrome.runtime.lastError.message);
                            this.state.sorsaTweetScoutScoreError = chrome.runtime.lastError.message;
                            this.updateDashboard();
                            try {
                                this.injectLabelBadge();
                            } catch (e) {
                                /* ignore */
                            }
                            try {
                                clipxInjectProfileHeroSorsaIfNeeded(h, this.state.sorsaTweetScoutScore);
                            } catch (e) {
                                console.warn('[ClipX Intel] profile hero Sorsa badge:', e);
                            }
                            return;
                        }
                        if (resp && resp.success) {
                            const raw = resp.score;
                            this.state.sorsaTweetScoutScore =
                                raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
                            this.state.sorsaTweetScoutScoreError = null;
                            clipxApplySorsaScoreCacheFromProfileFetch(
                                h,
                                true,
                                this.state.sorsaTweetScoutScore,
                            );
                        } else {
                            this.state.sorsaTweetScoutScore = null;
                            this.state.sorsaTweetScoutScoreError = resp?.error || 'Unavailable';
                        }
                        this.updateDashboard();
                        try {
                            this.injectLabelBadge();
                        } catch (e) {
                            /* ignore */
                        }
                        try {
                            clipxInjectProfileHeroSorsaIfNeeded(h, this.state.sorsaTweetScoutScore);
                        } catch (e) {
                            console.warn('[ClipX Intel] profile hero Sorsa badge:', e);
                        }
                    }
                );
            };

            /** Match batch Sorsa: only call API when X shows a verified badge. Retry if UserName row not mounted yet. */
            const tryVerifiedThenFetch = (attempt) => {
                const h = this.state.handle;
                if (!h) return;
                if (clipxSorsaProfileHeaderHasVerifiedBadge()) {
                    startSorsaFetch(h);
                    return;
                }
                const un = document.querySelector('div[data-testid="UserName"]');
                if (!un && attempt < 3) {
                    setTimeout(() => tryVerifiedThenFetch(attempt + 1), 650);
                    return;
                }
                finishSkipUnverifiedNoApi();
            };

            tryVerifiedThenFetch(0);
        });
    },

    // --- TweetScout Smart Followers ---
    async fetchTweetScoutInfo(forceRefresh = false) {
        if (!this.state.handle || (this.state.tweetScoutFetched && !forceRefresh)) return;

        if (forceRefresh) {
            this.state.tweetScoutFetched = false;
        }

        // Smart Followers is now FREE for all users - always fetch fresh data
        const onlyCache = false;

        console.log('[ClipX Intel] Fetching TweetScout info for:', this.state.handle);

        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getTweetScoutInfo',
                handle: this.state.handle,
                forceRefresh: forceRefresh,
                onlyCache: onlyCache
            });

            if (response && response.success) {
                this.state.tweetScoutInfo = response;
                console.log('[ClipX Intel] TweetScout data:', response);
            } else {
                this.state.tweetScoutInfo = null;
                console.log('[ClipX Intel] TweetScout not available:', response?.error);
            }
        } catch (e) {
            console.error('[ClipX Intel] TweetScout fetch error:', e);
            this.state.tweetScoutInfo = null;
        } finally {
            this.state.tweetScoutFetched = true;
            this.updateDashboard();
        }
    },

    /** Load 7d sentiment for profile inline pill (server proxy). */
    fetchSurfSocialIntel() {
        if (!this.state.handle) return;
        chrome.storage.local.get(['showSurfSocial'], (r) => {
            if (r.showSurfSocial === false) {
                this.state.surfSocial = null;
                this.updateDashboard();
                return;
            }
            this.state.surfSocial = { loading: true, user: null, detail: null, error: false };
            this.updateDashboard();
            chrome.runtime.sendMessage(
                { action: 'socialIntelProfile', handle: this.state.handle },
                (resp) => {
                    if (chrome.runtime.lastError) {
                        console.warn('[ClipX Intel] Surf social:', chrome.runtime.lastError.message);
                        this.state.surfSocial = { loading: false, user: null, detail: null, error: true };
                        this.updateDashboard();
                        return;
                    }
                    if (resp && resp.success) {
                        const raw = resp.detail && resp.detail.j !== undefined ? resp.detail.j : null;
                        this.state.surfSocial = {
                            loading: false,
                            user: null,
                            detail: raw,
                            error: false,
                        };
                    } else {
                        this.state.surfSocial = { loading: false, user: null, detail: null, error: true };
                    }
                    this.updateDashboard();
                    // X often mounts the name row after our fetch returns — retry injection briefly.
                    const retries = [0, 400, 1200, 2500];
                    retries.forEach((ms) => {
                        setTimeout(() => {
                            try {
                                this.injectProfileSurfSentimentPill();
                            } catch (e) {
                                /* ignore */
                            }
                        }, ms);
                    });
                },
            );
        });
    },

    /** TweetScout score is shown only as the yellow pill centered under the profile/timeline avatar — not in this card. */
    renderTweetScoutScoreHtml() {
        return '';
    },

    /** Surf follower / following rows removed — sentiment shows inline via injectProfileSurfSentimentPill() only. */
    renderSurfSocialStripHtml() {
        return '';
    },

    /**
     * 7d sentiment pill beside the profile display name (primary column), tier-colored.
     * Does not show Surf follower/following counts.
     */
    injectProfileSurfSentimentPill() {
        const pathHandle = clipxProfileHandleFromPathname(window.location.pathname);
        const clear = () => {
            document.querySelectorAll('.clipx-profile-surf-sentiment').forEach((el) => el.remove());
            document.querySelectorAll('[data-clipx-surf-slot="profile"]').forEach((el) => el.remove());
        };
        if (!pathHandle || !this.state.handle || pathHandle.toLowerCase() !== this.state.handle.toLowerCase()) {
            clear();
            return;
        }

        const userNameDiv = clipxProfileIdentityUserNameEl();
        if (!userNameDiv) return;

        // Do NOT remove pills synchronously — storage callback is async and that caused visible blinking.

        chrome.storage.local.get(['showSurfSocial'], (r) => {
            if (r.showSurfSocial === false) {
                clear();
                return;
            }
            const ss = this.state.surfSocial;
            if (!ss) return;

            const un = clipxProfileIdentityUserNameEl();
            if (!un || !un.isConnected) return;

            if (ss.loading || ss.error) {
                clipxClearProfileSurfSentimentDom(un);
                return;
            }

            const surfSent = clipxSurfSentimentFromDetailBody(ss.detail);
            const hasScore = surfSent.score != null && Number.isFinite(surfSent.score);
            const sig = clipxComputeSurfPillSignature(ss);

            if (hasScore) {
                const existingPill = un.querySelector('.clipx-profile-surf-sentiment[data-clipx-surf-sig]');
                if (
                    existingPill &&
                    existingPill.isConnected &&
                    un.contains(existingPill) &&
                    existingPill.getAttribute('data-clipx-surf-sig') === sig
                ) {
                    return;
                }
            }

            un.querySelectorAll('.clipx-profile-surf-sentiment').forEach((el) => el.remove());

            if (!hasScore) {
                clipxClearProfileSurfSentimentDom(un);
                return;
            }

            const slot = clipxEnsureProfileSurfSentimentSlot(un);
            if (!slot) return;

            const pill = document.createElement('span');
            pill.className = 'clipx-profile-surf-sentiment';
            pill.style.cssText =
                'display:inline-flex;align-items:center;justify-content:center;padding:2px 9px;border-radius:6px;font-size:11px;font-weight:800;letter-spacing:0.02em;line-height:1.35;vertical-align:middle;flex-shrink:0;border:none;';
            pill.title = '7-day sentiment score (0–100) for indexed projects';
            const s = surfSent.score;
            const { bg, fg } = clipxSurfSentimentTierStyle(s);
            pill.style.background = bg;
            pill.style.color = fg;
            pill.style.boxShadow = '0 1px 2px rgba(0,0,0,0.35)';
            pill.textContent = clipxSurfSentimentFormatDisplay(s);
            pill.setAttribute('data-clipx-surf-sig', sig);
            slot.appendChild(pill);
        });
    },

    // Check if user holds 200k CLIPX for premium features
    async checkPremiumStatus() {
        if (this.state.premiumChecked) return this.state.isPremiumUser;

        this.state.premiumChecked = true;
        const PREMIUM_THRESHOLD = 200000; // 200k CLIPX
        const CLIPX_ADDRESS = '0xc269d59a0d608ea0bd672f2f4616c372d8554444';

        try {
            // Check native wallet first
            const stored = await chrome.storage.local.get(['authToken', 'nativeWallet']);
            let walletAddress = null;

            if (stored.authToken === 'native-wallet' && stored.nativeWallet?.address) {
                walletAddress = stored.nativeWallet.address;
            }

            if (walletAddress) {
                // Get CLIPX balance for native wallet
                const response = await chrome.runtime.sendMessage({
                    action: 'getTokenBalance',
                    tokenAddress: CLIPX_ADDRESS,
                    walletAddress: walletAddress
                });

                if (response && response.success) {
                    const balance = parseFloat(response.balance || 0);
                    this.state.isPremiumUser = balance >= PREMIUM_THRESHOLD;
                    console.log('[ClipX Intel] Premium check - CLIPX balance:', balance, 'Premium:', this.state.isPremiumUser);
                    return this.state.isPremiumUser;
                }
            }

            // Check ClipX.app wallet balance via API
            if (stored.authToken && stored.authToken !== 'native-wallet') {
                try {
                    const dashResponse = await fetch(`${API_BASE}/api/dashboard`, {
                        headers: { 'Authorization': `Bearer ${stored.authToken}` }
                    });
                    if (dashResponse.ok) {
                        const data = await dashResponse.json();
                        const balance = parseFloat(data.clipxBalance || 0);
                        this.state.isPremiumUser = balance >= PREMIUM_THRESHOLD;
                        console.log('[ClipX Intel] Premium check (ClipX.app) - CLIPX balance:', balance, 'Premium:', this.state.isPremiumUser);
                        return this.state.isPremiumUser;
                    }
                } catch (e) {
                    console.log('[ClipX Intel] Could not check ClipX.app balance:', e);
                }
            }

            return false;
        } catch (e) {
            console.error('[ClipX Intel] Premium check error:', e);
            return false;
        }
    },


    // Render Smart Followers HTML — Sleek 'Social Proof' Design
    renderSmartFollowersHtml() {
        const info = this.state.tweetScoutInfo;
        if (!info || !info.topFollowers || info.topFollowers.length === 0) {
            const loadingOrNA = this.state.tweetScoutFetched ? 'No data available' : '⏳ Loading...';
            return `
                <div style="display:flex;align-items:center;gap:8px;padding:8px 0;color:#c4b5fd;font-size:12px;opacity:0.8;">
                    <span style="font-weight:600;">Smart Followers</span>
                    <span style="color:#a78bfa80;font-style:italic;margin-left:auto;font-size:11px;">${loadingOrNA}</span>
                </div>
            `;
        }

        // Deduplicate by username (safety net for cached/API duplicates)
        const seen = new Set();
        const topFollowers = [...info.topFollowers]
            .filter(f => { const u = (f.username || '').toLowerCase(); if (!u || seen.has(u)) return false; seen.add(u); return true; })
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, 100);
        const categories = info.categories || {};
        const vcCount = categories.vcs || 0;
        const kolCount = categories.kols || 0;
        const projectCount = categories.projects || 0;

        // Categorized badges - Floating style using cn() utility
        const categoryBadges = [];
        if (vcCount > 0) {
            const cls = this.cn('clipx-cat-badge', { active: this.state.smartFollowersFilter === 'vc' });
            categoryBadges.push(`<span class="${cls}" data-type="vc" style="display:inline-flex;align-items:center;gap:3px;padding:1px 5px;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.22);border-radius:3%;font-size:9px;color:#d8b4fe;font-weight:700;">🏛 ${vcCount} VCs</span>`);
        }
        if (kolCount > 0) {
            const cls = this.cn('clipx-cat-badge', { active: this.state.smartFollowersFilter === 'kol' });
            categoryBadges.push(`<span class="${cls}" data-type="kol" style="display:inline-flex;align-items:center;gap:3px;padding:1px 5px;background:rgba(236,72,153,0.1);border:1px solid rgba(236,72,153,0.22);border-radius:3%;font-size:9px;color:#f9a8d4;font-weight:700;">🎯 ${kolCount} KOLs</span>`);
        }
        if (projectCount > 0) {
            const cls = this.cn('clipx-cat-badge', { active: this.state.smartFollowersFilter === 'project' });
            categoryBadges.push(`<span class="${cls}" data-type="project" style="display:inline-flex;align-items:center;gap:3px;padding:1px 5px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.22);border-radius:3%;font-size:9px;color:#93c5fd;font-weight:700;">🔧 ${projectCount} Projects</span>`);
        }

        const isExpandedNow = this.state.smartFollowersExpanded !== false;

        // Overlapping Avatars Header (Social Proof Row)
        const previewAvatars = topFollowers.slice(0, 5).map((f, i) => `
            <img src="${f.avatar || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'}" 
                 style="width:16px;height:16px;border-radius:50%;border:1px solid #15202b;margin-left:${i === 0 ? 0 : -5}px;z-index:${10 - i};object-fit:cover;" />
        `).join('');

        const followersListHtml = topFollowers.map(f => {
            const followerType = f.type || 'kol';
            const isVisible = !this.state.smartFollowersFilter || this.state.smartFollowersFilter === followerType;
            return `<div data-href="https://x.com/${f.username}" 
                class="clipx-sf-pill" data-type="${followerType}"
                style="
                    display:${isVisible ? 'inline-flex' : 'none'};
                    align-items:center;gap:4px;
                    padding:2px 6px 2px 2px;
                    background:linear-gradient(135deg, rgba(20,127,112,0.09), rgba(168,85,247,0.06));
                    border:1px solid rgba(20,127,112,0.28);
                    border-radius:3%;
                    box-shadow:0 0 0 1px rgba(20,127,112,0.04) inset, 0 0 8px rgba(20,127,112,0.12);
                    cursor:pointer;
                    transition: all 0.2s ease;
                "
            >
                <img src="${f.avatar || 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'}" 
                     style="width:18px;height:18px;border-radius:50%;border:1px solid rgba(255,255,255,0.12);" />
                <span style="font-size:10px;font-weight:600;color:inherit;max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;">
                    ${f.name || f.username}
                </span>
            </div>`;
        }).join('');

        return `
            <div id="clipx-smart-followers-header" style="
                display:flex; 
                align-items:center; 
                gap:6px; 
                width:100%;
                max-width:100%;
                box-sizing:border-box;
                cursor:pointer; 
                padding:5px 8px; 
                user-select:none;
                background: linear-gradient(135deg, rgba(20, 127, 112, 0.08), rgba(15, 23, 42, 0.04));
                border: 1px solid rgba(20, 127, 112, 0.18);
                border-radius: 8px;
                margin: 2px 0;
                box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
                transition: all 0.2s ease;
            ">
                <div style="
                    display: inline-flex;
                    align-items: center;
                    padding: 2px 6px;
                    background: rgba(20, 127, 112, 0.08);
                    border: 1px solid rgba(20, 127, 112, 0.22);
                    border-radius: 3%;
                    box-shadow: 0 0 8px rgba(20, 127, 112, 0.08);
                ">
                    <span style="
                        font-weight:900; 
                        font-size:10px; 
                        white-space: nowrap;
                        background: linear-gradient(135deg, #147F70 0%, #20b2aa 100%);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                        text-transform: uppercase;
                        letter-spacing: 0.7px;
                    ">Smart Followers</span>
                </div>

                <div style="display:flex; align-items:center;">
                    <div style="display:flex; align-items:center; margin-right: 3px;">
                        ${previewAvatars}
                    </div>
                    ${topFollowers.length > 5 ? `<span style="font-size:9px; color:#147F70; font-weight:800; background:rgba(20, 127, 112, 0.1); padding:1px 4px; border-radius:3%;">+${topFollowers.length - 5}</span>` : ''}
                </div>

                <!-- Categories (Scrolling if needed) -->
                <div style="display:flex; align-items:center; gap:5px; flex:0 1 auto; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;">
                    <div style="display:flex; gap:4px;">
                        ${categoryBadges.join('')}
                    </div>
                </div>

                <span id="clipx-smart-followers-toggle" style="color:rgba(20, 127, 112, 0.6); font-size:9px; margin-left: 1px;">
                    ${isExpandedNow ? '▲' : '▼'}
                </span>
            </div>

            <div id="clipx-smart-followers-content" style="
                display:${isExpandedNow ? 'flex' : 'none'};
                flex-wrap:wrap;
                align-items:flex-start;
                gap:4px 5px;
                padding:5px 0 3px;
                max-height:156px;overflow-y:auto;
            ">
                ${followersListHtml}
            </div>
        `;
    },

    // --- Username History Button (in profile header area) ---
    injectUsernameHistoryButton() {
        document.getElementById('clipx-username-history-btn')?.remove();
        document.getElementById('clipx-username-btn-style')?.remove();
    },

    async fetchUsernameHistory() {
        if (!this.state.handle) return [];

        try {
            // Use dedicated handle-history API only (separate from Smart Followers / TweetScout)
            console.log('[ClipX Intel] Fetching username history for:', this.state.handle);

            // Create a timeout promise
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Request timed out')), 10000)
            );

            // Use the NEW dedicated handle-history endpoint (more efficient)
            const response = await Promise.race([
                chrome.runtime.sendMessage({
                    action: 'getHandleHistory',
                    handle: this.state.handle
                }),
                timeoutPromise
            ]);

            console.log('[ClipX Intel] Handle History response:', response);

            if (response && response.success && response.handle_history && response.handle_history.length > 0) {
                return response.handle_history;
            }

            // Fallback: check local storage for any cached history
            const cached = await chrome.storage.local.get([`username_history_${this.state.handle}`]);
            if (cached[`username_history_${this.state.handle}`]) {
                return cached[`username_history_${this.state.handle}`];
            }

            return [];
        } catch (e) {
            console.error('[ClipX Intel] Failed to fetch username history:', e);
            return [];
        }
    },


    async showUsernameHistoryModal() {
        // Remove existing modal
        const existing = document.getElementById('clipx-username-history-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'clipx-username-history-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(2px);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        `;

        // Inner container — Premium Glassmorphism
        const container = document.createElement('div');
        container.style.cssText = `
            background: #09090b;
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: 20px;
            padding: 24px;
            width: 420px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 20px rgba(139, 92, 246, 0.1);
            color: #fff;
            position: relative;
            overflow: hidden;
        `;

        // Background glow
        const glow = document.createElement('div');
        glow.style.cssText = `
            position: absolute;
            top: -50px;
            right: -50px;
            width: 150px;
            height: 150px;
            background: radial-gradient(circle, rgba(139, 92, 246, 0.15) 0%, transparent 70%);
            pointer-events: none;
        `;
        container.appendChild(glow);

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        `;

        const titleGroup = document.createElement('div');
        titleGroup.style.cssText = 'display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 500; color: #d4d4d8;';
        titleGroup.innerHTML = `
            <div style="background: rgba(139, 92, 246, 0.1); padding: 8px; border-radius: 10px; margin-right: 4px;">
                <svg viewBox="0 0 24 24" style="width:20px; height:20px; fill:#a78bfa;">
                    <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
                </svg>
            </div>
            Profile Identity History
        `;

        // Close button
        const closeBtn = document.createElement('div');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = `
            cursor: pointer; 
            font-size: 24px; 
            color: #71717a; 
            line-height: 1;
        `;
        closeBtn.onclick = () => modal.remove();

        header.appendChild(titleGroup);
        header.appendChild(closeBtn);
        container.appendChild(header);

        // Loading state initially
        const loadingDiv = document.createElement('div');
        loadingDiv.style.textAlign = 'center';
        loadingDiv.style.padding = '20px';
        loadingDiv.innerHTML = '<span style="color:#71717a;">Loading...</span>';
        container.appendChild(loadingDiv);

        modal.appendChild(container);
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

        // Increment usage count BEFORE fetching


        // Fetch Data
        let history = [];
        try {
            history = await this.fetchUsernameHistory();
        } catch (e) {
            console.error('Failed to fetch history:', e);
        }

        // Remove loading
        loadingDiv.remove();

        // Header for history section (no tabs needed - only Name history)
        const historyHeader = document.createElement('div');
        historyHeader.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
            padding: 8px 12px;
            background: #111;
            border-radius: 8px;
            border: 1px solid #27272a;
        `;
        historyHeader.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="color: #a78bfa; font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Username History</span>
                <span style="background:rgba(167,139,250,0.1); color:#a78bfa; padding:1px 6px; border-radius:4px; font-size:10px;">${history.length}</span>
            </div>
            <span id="clipx-history-refresh" style="cursor: pointer; font-size: 14px; opacity: 0.6; transition: 0.2s;" title="Refresh Data">🔄</span>
        `;
        container.appendChild(historyHeader);

        // Content List
        const listContainer = document.createElement('div');
        listContainer.style.cssText = `
            max-height: 300px; 
            overflow-y: auto;
            display: flex;
            flex-direction: column;
        `;

        const renderListFromHistory = (items) => {
            listContainer.innerHTML = '';
            if (items.length === 0) {
                listContainer.innerHTML = `<div style="text-align:center; color:#555; font-size:13px; padding:20px;">No username history found</div>`;
            } else {
                items.forEach(item => {
                    // TwitterScore API format: { date, new, old }
                    const handleName = typeof item === 'object' ? (item.new || item.handle || item.username || item.name || 'Unknown') : item;
                    const rawDate = typeof item === 'object' ? item.date : null;

                    let dateDisplay = rawDate || '—';
                    if (rawDate) {
                        try {
                            const d = new Date(rawDate);
                            if (!isNaN(d.getTime())) {
                                dateDisplay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                            }
                        } catch (e) { }
                    }

                    const row = document.createElement('div');
                    row.style.cssText = `
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-size: 14px;
                        padding: 12px 4px;
                        border-bottom: 1px solid #18181b;
                    `;

                    row.innerHTML = `
                        <div style="display:flex; flex-direction:column; gap:2px;">
                            <div style="font-weight: 700; color: #f4f4f5; font-size: 14px;">@${handleName}</div>
                            <div style="color: #52525b; font-size: 10px; text-transform: uppercase;">Handle</div>
                        </div>
                        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
                            <div style="color: #a1a1aa; font-size: 12px; font-weight: 500;">${dateDisplay}</div>
                            <div style="color: #52525b; font-size: 10px; text-transform: uppercase;">Detected</div>
                        </div>
                    `;
                    listContainer.appendChild(row);
                });
            }
        };

        renderListFromHistory(history);
        container.appendChild(listContainer);

        // Refresh Handler - uses dedicated handle-history API only (no Smart Followers)
        const refreshIcon = document.getElementById('clipx-history-refresh');
        if (refreshIcon) {
            refreshIcon.onclick = async () => {
                refreshIcon.style.opacity = '0.5';
                listContainer.style.opacity = '0.5';

                history = await this.fetchUsernameHistory();

                listContainer.style.opacity = '1';
                refreshIcon.style.opacity = '1';

                renderListFromHistory(history);

                // Update header with new count
                const headerSpan = historyHeader.querySelector('span');
                if (headerSpan) {
                    headerSpan.innerHTML = `📝 Username History (${history.length})`;
                }
            };
        }
    },


    async showUsernameHistoryModal_OLD() {
        // Remove existing modal
        const existing = document.getElementById('clipx-username-history-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'clipx-username-history-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            backdrop-filter: blur(4px);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        `;

        // Inner container
        const container = document.createElement('div');
        container.style.cssText = `
            background: #000;
            border: 1px solid #333;
            border-radius: 16px;
            padding: 24px;
            width: 380px;
            box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            color: #fff;
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        `;

        const titleGroup = document.createElement('div');
        titleGroup.style.cssText = 'display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 500; color: #a1a1aa;';
        titleGroup.innerHTML = `
            Profile History 
            <span id="clipx-history-refresh" style="cursor: pointer; font-size: 14px; opacity: 0.7; transition: opacity 0.2s;" title="Refresh Data">🔄</span>
        `;

        // Close button
        const closeBtn = document.createElement('div');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = `
            cursor: pointer; 
            font-size: 24px; 
            color: #71717a; 
            line-height: 1;
        `;
        closeBtn.onclick = () => modal.remove();

        header.appendChild(titleGroup);
        header.appendChild(closeBtn);
        container.appendChild(header);

        // Loading state initially
        const loadingDiv = document.createElement('div');
        loadingDiv.style.textAlign = 'center';
        loadingDiv.style.padding = '20px';
        loadingDiv.innerHTML = '<span style="color:#71717a;">Loading...</span>';
        container.appendChild(loadingDiv);

        modal.appendChild(container);
        document.body.appendChild(modal);
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

        // Fetch Data
        let history = [];
        try {
            history = await this.fetchUsernameHistory();
        } catch (e) {
            console.error('Failed to fetch history:', e);
        }

        // Remove loading
        loadingDiv.remove();

        // Tabs
        const tabsContainer = document.createElement('div');
        tabsContainer.style.cssText = `
            display: flex;
            background: #111;
            border-radius: 12px;
            padding: 4px;
            margin-bottom: 20px;
        `;

        const createTab = (text, active) => {
            const tab = document.createElement('div');
            tab.innerText = text;
            tab.style.cssText = `
                flex: 1;
                text-align: center;
                padding: 8px;
                border-radius: 8px;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
                ${active ? 'background: #222; color: #fbbf24; font-weight: 500;' : 'color: #71717a;'}
            `;
            return tab;
        };

        const nameTab = createTab(`Name Change ${history.length}`, true);
        const bioTab = createTab(`Bio Change (0)`, false);

        tabsContainer.appendChild(nameTab);
        tabsContainer.appendChild(bioTab);
        container.appendChild(tabsContainer);

        // Content List
        const listContainer = document.createElement('div');
        listContainer.style.cssText = `
            max-height: 300px; 
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 16px;
        `;

        const renderListFromHistory = (items) => {
            if (items.length === 0) {
                listContainer.innerHTML = '<div style="text-align:center; color:#555; font-size:13px; padding:20px;">No history data available</div>';
            } else {
                items.forEach(item => {
                    const handleName = typeof item === 'object' ? (item.handle || item.username || item.name || 'Unknown') : item;
                    const rawDate = typeof item === 'object' ? item.date : null;

                    let dateDisplay = rawDate || '—';
                    if (rawDate) {
                        try {
                            const d = new Date(rawDate);
                            if (!isNaN(d.getTime())) {
                                dateDisplay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                            }
                        } catch (e) { }
                    }

                    const row = document.createElement('div');
                    row.style.cssText = `
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-size: 14px;
                    `;

                    row.innerHTML = `
                        <div style="font-weight: 500; color: #fff;">@${handleName}</div>
                        <div style="color: #71717a; font-size: 13px;">${dateDisplay}</div>
                    `;
                    listContainer.appendChild(row);
                });
            }
        };

        renderListFromHistory(history);
        container.appendChild(listContainer);

        // Tab Switching Logic
        const switchTab = (isName) => {
            listContainer.innerHTML = '';
            if (isName) {
                nameTab.style.background = '#222';
                nameTab.style.color = '#fbbf24';
                bioTab.style.background = 'transparent';
                bioTab.style.color = '#71717a';
                renderListFromHistory(history);
            } else {
                bioTab.style.background = '#222';
                bioTab.style.color = '#fbbf24';
                nameTab.style.background = 'transparent';
                nameTab.style.color = '#71717a';
                listContainer.innerHTML = '<div style="text-align:center; color:#555; font-size:13px; padding:20px;">No bio changes recorded</div>';
            }
        };

        nameTab.onclick = () => switchTab(true);
        bioTab.onclick = () => switchTab(false);

        // Refresh Handler - uses dedicated handle-history API only (no Smart Followers)
        const refreshIcon = document.getElementById('clipx-history-refresh');
        if (refreshIcon) {
            refreshIcon.onclick = async () => {
                refreshIcon.style.transform = 'rotate(360deg)';
                refreshIcon.style.opacity = '1';
                setTimeout(() => { refreshIcon.style.transform = ''; }, 300);

                listContainer.style.opacity = '0.5';
                history = await this.fetchUsernameHistory();
                listContainer.style.opacity = '1';

                if (nameTab.style.color === 'rgb(251, 191, 36)' || nameTab.style.color === '#fbbf24') {
                    switchTab(true);
                } else {
                    switchTab(false);
                }
                nameTab.innerText = `Name Change ${history.length}`;
            };
        }
    },




    async fetchLabelForHandle(handle) {
        if (!handle) return null;


        // Return cached result if available
        if (this.state.labelCache && this.state.labelCache[handle]) {
            return this.state.labelCache[handle];
        }

        // If already fetching this handle, wait for the existing promise
        if (this.state.pendingFetches && this.state.pendingFetches.has(handle)) {
            try {
                return await this.state.pendingFetches.get(handle);
            } catch (e) {
                return null;
            }
        }

        // Ensure pendingFetches exists as a Map
        if (!this.state.pendingFetches) this.state.pendingFetches = new Map();

        // Create the fetch promise
        const fetchPromise = (async () => {
            try {
                // In background.js, getProfileLabel is just a fetch.
                // We reuse the existing message action.
                const response = await chrome.runtime.sendMessage({
                    action: 'getProfileLabel',
                    handle: handle
                });

                if (response && (response.label_text || response.label)) {
                    const data = {
                        label: response.label_text || response.label,
                        color: response.color || 'purple'
                    };
                    if (!this.state.labelCache) this.state.labelCache = {};
                    this.state.labelCache[handle] = data;
                    return data;
                }
                // Cache empty result to avoid re-fetching 404s
                if (!this.state.labelCache) this.state.labelCache = {};
                this.state.labelCache[handle] = { label: null };
                return null;
            } catch (e) {
                console.error('Fetch label error:', e);
                return null;
            } finally {
                this.state.pendingFetches.delete(handle);
            }
        })();

        // Store the promise for deduplication
        this.state.pendingFetches.set(handle, fetchPromise);

        return fetchPromise;
    },

    async injectFeedLabels() {
        // Find all tweets (includes main tweets and nested quoted tweets)
        const tweets = document.querySelectorAll('article[data-testid="tweet"]');
        for (const tweet of tweets) {
            // Find ALL User Name containers (main author + quoted post author)
            const userNameDivs = tweet.querySelectorAll('div[data-testid="User-Name"]');
            for (const userNameDiv of userNameDivs) {
                // Find Handle Link (last anchor usually? or check href)
                const links = userNameDiv.querySelectorAll('a[href^="/"]');
                let handle = null;

                for (const link of links) {
                    const href = link.getAttribute('href');
                    if (href && href !== '/' && !href.includes('/status/')) {
                        handle = href.replace('/', '').toLowerCase();
                        break;
                    }
                }

                if (!handle) continue;

                // Check if injection already exists for this user in this container
                if (userNameDiv.querySelector(`.clipx-feed-label-${handle}`)) continue;

                // Check cache or fetch
                if (!this.state.labelCache) this.state.labelCache = {};

                let labelData = this.state.labelCache[handle];
                if (!labelData && (!this.state.pendingFetches || !this.state.pendingFetches.has(handle))) {
                    // Trigger async fetch and re-draw later
                    this.fetchLabelForHandle(handle).then(data => {
                        // Only re-trigger if we got data (to avoid infinite loops)
                        if (data && data.label) ProfileScanner.injectFeedLabels();
                    });
                }

                if (labelData && labelData.label) {
                    this.renderFeedBadge(userNameDiv, labelData, handle);
                }
            }
        }
    },

    renderFeedBadge(container, data, handle) {
        // Avoid duplicates (double check)
        if (container.querySelector(`.clipx-feed-label-${handle}`)) return;

        const badge = document.createElement('span');
        badge.className = `clipx-feed-label-${handle} clipx-feed-label`;

        // Layout only — fill, stroke, and text color come from .clipx-label-* (ClipX Extension gradient style).
        badge.style.cssText = `
            display: inline-flex;
            align-items: center;
            margin: 0;
            padding: 0;
            border-radius: 0;
            font-size: 11px;
            font-weight: 760;
            vertical-align: middle;
            line-height: 1.25;
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        `;
        badge.textContent = data.label;
        badge.title = data.label; // Tooltip for full text on hover

        const slot = clipxEnsureInlineMetaSlot(container);
        if (slot) {
            const firstPill = slot.querySelector('.clipx-surf-mini-pill');
            if (firstPill) slot.insertBefore(badge, firstPill);
            else slot.appendChild(badge);
            applyLabelStyle(badge);
            badge.style.removeProperty('color');
            badge.style.removeProperty('background');
            badge.style.removeProperty('border');
            badge.style.removeProperty('box-shadow');
        }
    },


    injectLabelBadge() {
        if (!this.state.profileLabel || (!this.state.profileLabel.label && !this.state.profileLabel.showAddDetail)) {
            // Proceed
        }

        const label = this.state.profileLabel?.label;
        const color = this.state.profileLabel?.color || 'purple';

        // Find user name element in header [data-testid="UserName"]
        const userNameElement = document.querySelector('[data-testid="UserName"]');

        if (userNameElement) {
            let container = document.getElementById('clipx-profile-label');
            let needsAppend = false;

            const isEditing = !!this.state.isEditingLabel;
            const currentLabel = label || '';
            const stSorsa = this.state;
            const sorsaHeaderSig = `${stSorsa.sorsaTweetScoutHidden}|${stSorsa.sorsaTweetScoutScoreLoading}|${stSorsa.sorsaTweetScoutFetched}|${stSorsa.sorsaTweetScoutScore ?? ''}`;

            // STABILITY CHECK: Prevents blinking/thrashing
            if (container) {
                // If exists and state matches, do nothing
                if (container.dataset.label === currentLabel &&
                    container.dataset.editing === String(isEditing) &&
                    container.dataset.sorsaHeaderSig === sorsaHeaderSig) {
                    return;
                }
                container.innerHTML = ''; // Clear for re-render
            } else {
                // Create new
                container = document.createElement('span');
                container.id = 'clipx-profile-label';
                container.style.display = 'inline-flex';
                container.style.alignItems = 'center';
                container.style.marginLeft = '8px';
                container.style.verticalAlign = 'middle';
                needsAppend = true;
            }

            // Update Metadata
            container.dataset.label = currentLabel;
            container.dataset.editing = String(isEditing);
            container.dataset.sorsaHeaderSig = sorsaHeaderSig;

            // --- RENDER CONTENT ---

            if (isEditing) {
                container.style.transform = 'translateY(-1px)';

                // LOCAL STATE FOR COLOR
                let tempColor = color; // Default to current

                const input = document.createElement('input');
                input.type = 'text';
                input.value = currentLabel;
                input.placeholder = 'Label...';
                input.style.cssText = `
                    background: rgba(0,0,0,0.5);
                    color: white;
                    border: 1px solid #a855f7;
                    border-radius: 6px;
                    padding: 4px 8px;
                    font-size: 12px;
                    outline: none;
                    width: 140px;
                    margin-right: 6px;
                    font-family: inherit;
                 `;

                setTimeout(() => input.focus(), 50);

                // Save Helpers
                const save = async () => {
                    const text = input.value.trim();
                    if (text) {
                        this.state.profileLabel.label = text;
                        this.state.profileLabel.color = tempColor; // Update color
                        this.state.isEditingLabel = false;
                        this.injectLabelBadge();
                        await this.saveProfileLabel(text, tempColor);
                    } else {
                        cancel();
                    }
                };
                const cancel = () => {
                    this.state.isEditingLabel = false;
                    this.injectLabelBadge();
                };

                input.onkeydown = (e) => {
                    if (e.key === 'Enter') { e.stopPropagation(); save(); }
                    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
                };

                // Color Selection Container
                const colorContainer = document.createElement('span');
                colorContainer.style.marginRight = '8px';
                colorContainer.style.display = 'inline-flex';
                colorContainer.style.gap = '4px';

                ['purple', 'red', 'green', 'blue'].forEach(c => {
                    const dot = document.createElement('span');
                    dot.style.cssText = `
                        width: 12px; height: 12px; border-radius: 50%;
                        background: ${c}; cursor: pointer;
                        border: 1px solid ${c === tempColor ? 'white' : 'transparent'};
                        opacity: ${c === tempColor ? 1 : 0.4};
                        transition: all 0.2s;
                     `;
                    dot.onclick = (e) => {
                        e.stopPropagation();
                        tempColor = c;
                        // Update UI of dots
                        Array.from(colorContainer.children).forEach(child => {
                            child.style.border = '1px solid transparent';
                            child.style.opacity = '0.4';
                        });
                        dot.style.border = '1px solid white';
                        dot.style.opacity = '1';
                        // Update input border color too?
                    };
                    colorContainer.appendChild(dot);
                });

                const saveBtn = document.createElement('button');
                saveBtn.innerHTML = '✔';
                saveBtn.style.cssText = `
                    background: rgba(168, 85, 247, 0.2);
                    color: #a855f7;
                    border: 1px solid #a855f7;
                    border-radius: 4px;
                    padding: 3px 6px;
                    font-size: 10px;
                    cursor: pointer;
                    margin-right: 4px;
                 `;
                saveBtn.onclick = (e) => { e.stopPropagation(); save(); };

                const cancelBtn = document.createElement('button');
                cancelBtn.innerHTML = '✕';
                cancelBtn.style.cssText = `
                    background: transparent;
                    color: #ef4444; 
                    border: 1px solid #ef4444;
                    border-radius: 4px;
                    padding: 3px 6px;
                    font-size: 10px;
                    cursor: pointer;
                 `;
                cancelBtn.onclick = (e) => { e.stopPropagation(); cancel(); };

                container.appendChild(input);
                container.appendChild(colorContainer);
                container.appendChild(saveBtn);
                container.appendChild(cancelBtn);

            } else {
                // --- VIEW MODE ---
                const badge = document.createElement('span');

                // Glow colors for visibility (--glow-color used when label effect is "glow")
                const glowColors = {
                    purple: 'rgba(168, 85, 247, 0.4)',
                    red: 'rgba(239, 68, 68, 0.4)',
                    green: 'rgba(16, 185, 129, 0.4)',
                    blue: 'rgba(59, 130, 246, 0.4)'
                };
                const glow = glowColors[color] || glowColors.purple;

                // Layout only — avoid pale inline fill + white text (low contrast in X light mode). Gradient from injected CSS (ClipX Extension).
                const neonStyle = `
                    display: inline-flex;
                    align-items: center;
                    margin: 0;
                    padding: 0;
                    border-radius: 0;
                    font-size: 12px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    font-weight: 760;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    letter-spacing: 0.2px;
                    line-height: normal;
                    --glow-color: ${glow};
                `;

                if (label) {
                    badge.className = 'clipx-profile-label-badge';
                    badge.style.cssText = neonStyle;
                    badge.innerHTML = label;
                    applyLabelStyle(badge);
                } else {
                    badge.className = 'clipx-profile-label-badge';
                    badge.style.cssText = neonStyle;
                    badge.innerHTML = `Add Label`;
                    applyLabelStyle(badge);
                }
                badge.style.removeProperty('color');
                badge.style.removeProperty('background');
                badge.style.removeProperty('border');
                badge.style.removeProperty('box-shadow');

                badge.onmouseenter = () => {
                    badge.style.transform = 'translateY(-1px)';
                    badge.style.boxShadow = '0 4px 12px rgba(168, 85, 247, 0.25)';
                };
                badge.onmouseleave = () => {
                    badge.style.transform = 'translateY(0)';
                    badge.style.boxShadow = 'none';
                };

                badge.onclick = async (e) => {
                    e.stopPropagation();
                    // Check if user is logged in before allowing edit
                    const authResponse = await chrome.runtime.sendMessage({ action: 'checkAuthStatus' });
                    if (!authResponse || !authResponse.isLoggedIn) {
                        // Show "Login Required" message with click to login
                        badge.innerHTML = '🔒 Click to Login';
                        badge.style.background = 'rgba(168, 85, 247, 0.2)';
                        badge.style.borderColor = 'rgba(168, 85, 247, 0.5)';
                        badge.style.color = '#c084fc';
                        badge.style.cursor = 'pointer';

                        // Replace onclick to open the active ClipX app for login on next click
                        badge.onclick = (e2) => {
                            e2.stopPropagation();
                            window.open(API_BASE.replace(/\/$/, ''), '_blank');
                            // Reset badge after 1s
                            setTimeout(() => {
                                this.injectLabelBadge();
                            }, 1000);
                        };
                        return;
                    }
                    this.state.isEditingLabel = true;
                    this.injectLabelBadge();
                };

                container.appendChild(badge);

                // Add separated Pencil for "Add Label" state
                if (!label) {
                    const pencil = document.createElement('span');
                    pencil.innerHTML = '✏️';
                    pencil.style.cssText = `
                        margin-left: 6px;
                        font-size: 12px;
                        cursor: pointer;
                        opacity: 0.7;
                        transition: opacity 0.2s;
                    `;
                    pencil.onclick = badge.onclick;
                    pencil.onmouseenter = () => pencil.style.opacity = '1';
                    pencil.onmouseleave = () => pencil.style.opacity = '0.7';
                    container.appendChild(pencil);
                }

                // TweetScout profile score beside label (same metric as Intel / avatar pill)
                if (!this.state.sorsaTweetScoutHidden) {
                    ensureClipxSorsaVisualStyles();
                    const scoreWrap = document.createElement('span');
                    scoreWrap.id = 'clipx-profile-header-sorsa-score';
                    scoreWrap.className = 'clipx-sorsa-pill-fallback';
                    scoreWrap.style.marginLeft = '8px';
                    const num = document.createElement('span');
                    num.className = 'clipx-sorsa-badge-num';
                    let scoreText = '—';
                    if (this.state.sorsaTweetScoutScoreLoading) {
                        scoreText = '…';
                    } else if (
                        this.state.sorsaTweetScoutScore != null &&
                        Number.isFinite(Number(this.state.sorsaTweetScoutScore))
                    ) {
                        scoreText = clipxFormatSorsaScore(this.state.sorsaTweetScoutScore) || '—';
                    }
                    num.textContent = scoreText;
                    scoreWrap.appendChild(num);
                    const err = this.state.sorsaTweetScoutScoreError;
                    scoreWrap.title =
                        err && !this.state.sorsaTweetScoutScoreLoading
                            ? `TweetScout: ${err}`
                            : 'TweetScout profile score';
                    container.appendChild(scoreWrap);
                }
            }

            // --- INJECTION (Only if new) ---
            if (needsAppend) {
                let targetRow = null;
                const anchorIcon = userNameElement.querySelector('svg[data-testid="icon-verified"]') ||
                    userNameElement.querySelector('svg[aria-label*="Verified"]');

                if (anchorIcon) {
                    let p = anchorIcon.parentNode;
                    while (p && p !== userNameElement) {
                        const style = window.getComputedStyle(p);
                        if (style.display === 'flex' && style.flexDirection === 'row') {
                            targetRow = p;
                            break;
                        }
                        p = p.parentNode;
                    }
                } else {
                    const nameSpan = Array.from(userNameElement.querySelectorAll('span')).find(s =>
                        s.innerText && s.innerText.length > 0 && !s.querySelector('*')
                    );
                    if (nameSpan) {
                        let p = nameSpan.parentNode;
                        while (p && p !== userNameElement) {
                            const style = window.getComputedStyle(p);
                            if (style.display === 'flex' && style.flexDirection === 'row') {
                                targetRow = p;
                                break;
                            }
                            p = p.parentNode;
                        }
                    }
                }

                if (targetRow) {
                    targetRow.appendChild(container);
                } else {
                    const fallback = userNameElement.querySelector('div[dir="ltr"]') || userNameElement;
                    fallback.appendChild(container);
                }
            }

            try {
                this.injectProfileSurfSentimentPill();
            } catch (e) {
                /* sentiment may run before Surf fetch completes */
            }
        }
    },

    showAddLabelModal() {
        // Remove existing
        const existing = document.getElementById('clipx-label-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'clipx-label-modal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 10000;
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(4px);
        `;

        const currentLabel = this.state.profileLabel?.label || '';
        const currentColor = this.state.profileLabel?.color || 'purple';

        modal.innerHTML = `
            <div style="background:#18181b; width:320px; border-radius:16px; border:1px solid #27272a; overflow:hidden; box-shadow:0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);">
                <div style="padding:16px; border-bottom:1px solid #27272a; display:flex; justify-content:space-between; items-center;">
                    <h3 style="margin:0; font-size:16px; font-weight:600; color:#f4f4f5;">Add Profile Label</h3>
                    <button id="clipx-label-close" style="background:none; border:none; color:#71717a; cursor:pointer; font-size:18px;">&times;</button>
                </div>
                <div style="padding:16px;">
                    <div style="margin-bottom:12px;">
                        <label style="display:block; font-size:12px; color:#a1a1aa; margin-bottom:6px;">Label Text</label>
                        <input type="text" id="clipx-label-input" value="${currentLabel}" placeholder="e.g. Whale, Scammer, KOL" style="width:100%; box-sizing:border-box; background:#27272a; border:1px solid #3f3f46; color:white; padding:8px 12px; border-radius:8px; outline:none; font-size:14px;">
                    </div>
                    <div style="margin-bottom:20px;">
                        <label style="display:block; font-size:12px; color:#a1a1aa; margin-bottom:6px;">Color</label>
                        <div style="display:flex; gap:8px;">
                            ${['purple', 'red', 'green', 'blue'].map(c => `
                                <div class="clipx-color-opt" data-color="${c}" style="width:24px; height:24px; border-radius:50%; background:${c}; cursor:pointer; border:2px solid ${currentColor === c ? 'white' : 'transparent'}; opacity:${currentColor === c ? 1 : 0.6}; transition:all 0.2s;"></div>
                            `).join('')}
                        </div>
                    </div>
                    <button id="clipx-label-save" style="width:100%; background:#8b5cf6; color:white; border:none; padding:10px; border-radius:8px; font-weight:600; cursor:pointer; transition:background 0.2s;">
                        Save Label
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Handlers
        const close = () => modal.remove();
        modal.querySelector('#clipx-label-close').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };

        // Color selection
        let selectedColor = currentColor;
        modal.querySelectorAll('.clipx-color-opt').forEach(opt => {
            opt.onclick = () => {
                selectedColor = opt.dataset.color;
                modal.querySelectorAll('.clipx-color-opt').forEach(o => {
                    o.style.borderColor = 'transparent';
                    o.style.opacity = '0.6';
                });
                opt.style.borderColor = 'white';
                opt.style.opacity = '1';
            };
        });

        // Save
        const saveBtn = modal.querySelector('#clipx-label-save');
        saveBtn.onclick = async () => {
            const text = modal.querySelector('#clipx-label-input').value.trim();
            if (!text) return;

            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;

            const success = await this.saveProfileLabel(text, selectedColor);
            if (success) {
                close();
            } else {
                saveBtn.textContent = 'Save Failed';
                saveBtn.disabled = false;
            }
        };
    },

    // Inject the Dashboard UI

    injectDashboard() {
        const profileHeader = document.querySelector('[data-testid="UserProfileHeader_Items"]');
        if (!profileHeader) return;

        // Check if card exists AND is still in the DOM (not detached by React)
        const existingCard = document.getElementById('clipx-intel-card');
        if (existingCard && existingCard.isConnected) {
            // Card exists and is attached, just update it
            this.renderContent(existingCard);
            return;
        }

        // Remove detached card if it exists
        if (existingCard) existingCard.remove();

        // Create card container — transparent, no background, blends with X's native theme
        const card = document.createElement('div');
        card.id = 'clipx-intel-card';
        card.style.cssText = `
            margin-top: 8px;
            margin-bottom: 4px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 12px;
            animation: clipxFadeIn 0.3s ease;
        `;

        // Inject styles if not already present
        if (!document.getElementById('clipx-sf-styles')) {
            const styleEl = document.createElement('style');
            styleEl.id = 'clipx-sf-styles';
            styleEl.textContent = `
                @keyframes clipxFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                #clipx-smart-followers-header:hover {
                    border-color: rgba(20, 127, 112, 0.28) !important;
                    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 12px rgba(20, 127, 112, 0.08) !important;
                }
                #clipx-smart-followers-content::-webkit-scrollbar { display: none; }
                #clipx-smart-followers-content { scrollbar-width: none; -ms-overflow-style: none; }
                .clipx-cat-badge { cursor: pointer; transition: all 0.2s ease; }
                .clipx-cat-badge:hover { box-shadow: 0 0 8px rgba(168, 85, 247, 0.18); transform: translateY(-1px); }
                .clipx-cat-badge.active { box-shadow: 0 0 10px rgba(168, 85, 247, 0.32); transform: translateY(-1px); }
                .clipx-sf-pill { transition: all 0.15s ease; }
                .clipx-sf-pill:hover {
                    background: linear-gradient(135deg, rgba(20,127,112,0.15), rgba(168,85,247,0.12)) !important;
                    border-color: rgba(20,127,112,0.48) !important;
                    box-shadow: 0 0 0 1px rgba(20,127,112,0.1) inset, 0 0 12px rgba(20,127,112,0.24) !important;
                    transform: translateY(-1px);
                }
            `;
            document.head.appendChild(styleEl);
        }

        // Insert smart followers card after header
        profileHeader.parentNode.insertBefore(card, profileHeader.nextSibling);
        this.renderContent(card);

        // Inject Interaction Circle OUTSIDE the card, as a separate element
        const existingMentions = document.getElementById('clipx-mentions-section');
        if (existingMentions) existingMentions.remove();
        const mentionsHtml = this.renderMentionsHtml();
        if (mentionsHtml) {
            const mentionsDiv = document.createElement('div');
            mentionsDiv.id = 'clipx-mentions-section';
            mentionsDiv.innerHTML = mentionsHtml;
            card.parentNode.insertBefore(mentionsDiv, card.nextSibling);
        }
    },

    removeDashboard() {
        document.querySelectorAll('.clipx-profile-surf-sentiment').forEach((el) => el.remove());
        document.querySelectorAll('[data-clipx-surf-slot="profile"]').forEach((el) => el.remove());
        const profileHeader = document.querySelector('[data-testid="UserProfileHeader_Items"]');
        if (profileHeader) {
            profileHeader.querySelectorAll('.clipx-sorsa-avatar-shell').forEach((shell) => {
                const innerA = shell.querySelector(':scope > a');
                if (innerA && shell.parentNode) {
                    shell.parentNode.insertBefore(innerA, shell);
                    shell.remove();
                }
            });
            profileHeader.querySelectorAll('.clipx-sorsa-below-avatar').forEach((el) => el.remove());
            profileHeader.querySelectorAll('img[data-clipx-sorsa-done="1"]').forEach((img) => {
                delete img.dataset.clipxSorsaDone;
            });
        }
        const card = document.getElementById('clipx-intel-card');
        if (card) card.remove();
        const mentions = document.getElementById('clipx-mentions-section');
        if (mentions) mentions.remove();
        if (this.dashboardWatcher) {
            clearInterval(this.dashboardWatcher);
            this.dashboardWatcher = null;
        }
    },

    updateDashboard() {
        const card = document.getElementById('clipx-intel-card');
        if (card) {
            this.renderContent(card);
        } else {
            try {
                this.injectProfileSurfSentimentPill();
            } catch (e) {
                console.warn('[ClipX Intel] profile sentiment pill:', e);
            }
            // Intel card not mounted yet — still show profile hero TweetScout pill (bottom-center under avatar).
            try {
                if (this.state.handle && this.state.sorsaTweetScoutFetched) {
                    clipxInjectProfileHeroSorsaIfNeeded(this.state.handle, this.state.sorsaTweetScoutScore);
                }
            } catch (e) {
                console.warn('[ClipX Intel] profile hero Sorsa badge:', e);
            }
        }
    },

    renderContent(card) {
        if (!card) return;

        const tweetScoutScoreHtml = this.renderTweetScoutScoreHtml();
        const surfStripHtml = this.renderSurfSocialStripHtml();
        const smartFollowersHtml = this.renderSmartFollowersHtml();
        const dashboardSig = tweetScoutScoreHtml + surfStripHtml + smartFollowersHtml;

        // ONLY update innerHTML if the HTML actually changed
        if (this._lastRenderedSmartFollowersHtml !== dashboardSig) {
            this._lastRenderedSmartFollowersHtml = dashboardSig;
            card.innerHTML = `
                <div id="clipx-premium-toast-container" style="display: none;"></div>
                ${tweetScoutScoreHtml}
                ${surfStripHtml}
                ${smartFollowersHtml}
            `;

            const self = this;

            // Delegated click handler for the whole card
            card.onclick = (e) => {
                // Toggle
                const header = e.target.closest('#clipx-smart-followers-header');
                if (header) {
                    self.state.smartFollowersExpanded = self.state.smartFollowersExpanded === false;
                    self._lastRenderedSmartFollowersHtml = null; // Force re-render on next update
                    self.updateDashboard();
                    return;
                }

                // Profile links (delegated)
                const pill = e.target.closest('.clipx-sf-pill');
                if (pill && pill.dataset.href) {
                    window.open(pill.dataset.href, '_blank');
                    return;
                }

                // Badges
                const badge = e.target.closest('.clipx-cat-badge');
                if (badge) {
                    e.stopPropagation();
                    const type = badge.dataset.type;
                    self.state.smartFollowersFilter = (self.state.smartFollowersFilter === type) ? null : type;
                    self._lastRenderedSmartFollowersHtml = null; // Force re-render
                    self.updateDashboard();
                    return;
                }
            };
        }

        // Update Interaction Circle separately
        const mentionsCount = this.state.mentions?.size || 0;
        if (this._lastMentionsCount !== mentionsCount) {
            this._lastMentionsCount = mentionsCount;
            const existingMentions = document.getElementById('clipx-mentions-section');
            if (existingMentions) existingMentions.remove();
            const mentionsHtml = this.renderMentionsHtml();
            if (mentionsHtml && card.parentNode) {
                const div = document.createElement('div');
                div.id = 'clipx-mentions-section';
                div.innerHTML = mentionsHtml;
                card.parentNode.insertBefore(div, card.nextSibling);
            }
        }

        try {
            this.injectProfileSurfSentimentPill();
        } catch (e) {
            console.warn('[ClipX Intel] profile sentiment pill:', e);
        }

        try {
            if (this.state.handle && this.state.sorsaTweetScoutFetched) {
                clipxInjectProfileHeroSorsaIfNeeded(this.state.handle, this.state.sorsaTweetScoutScore);
            }
        } catch (e) {
            console.warn('[ClipX Intel] profile hero Sorsa badge:', e);
        }
    },

    // Show premium upgrade modal
    showPremiumModal(featureName) {
        // Remove existing modal if any
        const existing = document.getElementById('clipx-premium-modal');
        if (existing) existing.remove();

        // Create modal container
        const modal = document.createElement('div');
        modal.id = 'clipx-premium-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            backdrop-filter: blur(5px);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;

        // Create modal content
        modal.innerHTML = `
            <div style="
                background: linear-gradient(135deg, #1e1e24 0%, #1a1b23 100%);
                border: 1px solid rgba(139, 92, 246, 0.3);
                border-radius: 16px;
                padding: 24px;
                width: 380px;
                max-width: 90%;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
                transform: scale(0.9);
                transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                position: relative;
                text-align: center;
            ">
                <button id="clipx-premium-close" style="
                    position: absolute;
                    top: 12px;
                    right: 12px;
                    background: none;
                    border: none;
                    color: #71717a;
                    font-size: 20px;
                    cursor: pointer;
                    padding: 4px;
                    line-height: 1;
                    border-radius: 50%;
                    width: 30px;
                    height: 30px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.2s;
                ">✕</button>
                
                <div style="font-size: 32px; margin-bottom: 12px;">🔒</div>
                
                <h3 style="
                    color: white; 
                    margin: 0 0 8px 0; 
                    font-size: 20px; 
                    font-weight: 700;
                ">Premium Feature Locked</h3>
                
                <p style="
                    color: #a1a1aa; 
                    font-size: 14px; 
                    line-height: 1.5; 
                    margin: 0 0 20px 0;
                ">
                    <span style="color: #c084fc; font-weight: 600;">${featureName}</span> is available exclusively for Premium users.
                </p>
                
                <div style="
                    background: rgba(139, 92, 246, 0.1); 
                    border: 1px dashed rgba(139, 92, 246, 0.3); 
                    border-radius: 12px; 
                    padding: 12px; 
                    margin-bottom: 20px;
                ">
                    <div style="font-size: 11px; text-transform: uppercase; color: #71717a; font-weight: 600; margin-bottom: 4px;">Requirement</div>
                    <div style="font-size: 16px; font-weight: 700; color: #f59e0b;">1,000,000 CLIPX</div>
                    <div style="font-size: 11px; color: #71717a; margin-top: 2px;">Hold in ClipX.app or linked wallet</div>
                </div>
                
                <button id="clipx-premium-action" style="
                    background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
                    color: white;
                    border: none;
                    border-radius: 10px;
                    padding: 10px 24px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    width: 100%;
                    transition: opacity 0.2s;
                    box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
                ">Get CLIPX Now</button>
            </div>
        `;

        document.body.appendChild(modal);

        // Animate in
        requestAnimationFrame(() => {
            modal.style.opacity = '1';
            const content = modal.querySelector('div');
            content.style.transform = 'scale(1)';
        });

        // Close handlers
        const closeModal = () => {
            modal.style.opacity = '0';
            const content = modal.querySelector('div');
            content.style.transform = 'scale(0.9)';
            setTimeout(() => modal.remove(), 300);
        };

        modal.onclick = (e) => {
            if (e.target === modal) closeModal();
        };

        const closeBtn = modal.querySelector('#clipx-premium-close');
        closeBtn.onmouseenter = () => closeBtn.style.background = 'rgba(255,255,255,0.1)';
        closeBtn.onmouseleave = () => closeBtn.style.background = 'none';
        closeBtn.onclick = closeModal;

        // Action button
        const actionBtn = modal.querySelector('#clipx-premium-action');
        actionBtn.onclick = () => {
            window.open(API_BASE.replace(/\/$/, ''), '_blank');
            closeModal();
        };
    },


    // Show modal with all Tickers and their source tweets
    showTickerModal() {
        // Remove existing modal if any
        const existing = document.getElementById('clipx-ticker-modal');
        if (existing) existing.remove();

        const tickers = Array.from(this.state.tickers.entries()).sort((a, b) => b[1].count - a[1].count);
        const handle = this.state.handle;

        // Build ticker list HTML
        const tickerListHtml = tickers.map(([ticker, data]) => {
            const tweetUrl = data.tweetId ? `https://x.com/${handle}/status/${data.tweetId}` : null;
            const searchUrl = `https://x.com/search?q=${encodeURIComponent(`from:${handle} ${ticker}`)}&src=typed_query&f=live`;

            return `
                <div style="background:#18181b; border:1px solid #27272a; border-radius:8px; padding:12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="color:#4ade80; font-size:14px; font-weight:600;">${ticker}</span>
                            <span style="background:#27272a; padding:2px 6px; border-radius:4px; font-size:10px; color:#a1a1aa;">x${data.count}</span>
                            <button class="clipx-copy-ticker" data-ticker="${ticker}" style="background:none; border:none; cursor:pointer; color:#a1a1aa; font-size:10px; padding:2px 4px;" title="Copy ticker">📋</button>
                        </div>
                        <div style="display:flex; gap:4px;">
                             ${tweetUrl
                    ? `<a href="${tweetUrl}" target="_blank" style="background:#27272a; padding:2px 6px; border-radius:4px; font-size:10px; color:#60a5fa; text-decoration:none;">View Tweet</a>`
                    : `<a href="${searchUrl}" target="_blank" style="background:#27272a; padding:2px 6px; border-radius:4px; font-size:10px; color:#a1a1aa; text-decoration:none;">Find Post</a>`
                }
                        </div>
                    </div>
                    ${!tweetUrl ? `
                        <div style="font-size:10px; color:#71717a; font-style:italic; margin-top:4px;">Exact tweet not linked - click Find Post to search</div>
                    ` : ''}
                </div>
            `;
        }).join('');

        // Create modal
        const modal = document.createElement('div');
        modal.id = 'clipx-ticker-modal';
        modal.innerHTML = `
            <div style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.7); z-index:99999; display:flex; justify-content:center; align-items:center;">
                <div style="background:#0f0f0f; border:1px solid #27272a; border-radius:12px; width:90%; max-width:500px; max-height:80vh; overflow:hidden; display:flex; flex-direction:column;">
                    <div style="padding:16px; border-bottom:1px solid #27272a; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-weight:700; color:#e5e5e5; font-size:14px;">Tickers mentioned by @${handle}</div>
                            <div style="font-size:11px; color:#71717a; margin-top:2px;">📊 ${tickers.length} Ticker(s) found</div>
                        </div>
                        <button id="clipx-ticker-modal-close" style="background:none; border:none; cursor:pointer; color:#a1a1aa; font-size:18px; padding:4px;">✕</button>
                    </div>
                    <div style="padding:16px; overflow-y:auto; flex:1;">
                        ${tickerListHtml || '<div style="color:#71717a; text-align:center;">No tickers found</div>'}
                    </div>
                    <div style="padding:12px 16px; border-top:1px solid #27272a; text-align:center;">
                        <span style="font-size:10px; color:#71717a;">Powered by ClipX Intel 🕵️</span>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Close button handler
        modal.querySelector('#clipx-ticker-modal-close').onclick = () => modal.remove();

        // Click outside to close
        modal.firstElementChild.onclick = (e) => {
            if (e.target === modal.firstElementChild) modal.remove();
        };

        // Copy button handlers
        modal.querySelectorAll('.clipx-copy-ticker').forEach(btn => {
            btn.onclick = () => {
                navigator.clipboard.writeText(btn.dataset.ticker);
                btn.textContent = '✓';
                setTimeout(() => { btn.textContent = '📋'; }, 1000);
            };
        });
    },

    // Show modal with all CAs and their source tweets
    showCAModal() {
        // Remove existing modal if any
        const existing = document.getElementById('clipx-ca-modal');
        if (existing) existing.remove();

        const addresses = Array.from(this.state.addresses.entries());
        const handle = this.state.handle;

        // Build CA list HTML
        const caListHtml = addresses.map(([addr, tweetId]) => {
            const shortAddr = `${addr.substring(0, 6)}...${addr.substring(38)}`;
            const tweetUrl = tweetId ? `https://x.com/${handle}/status/${tweetId}` : null;
            const searchUrl = `https://x.com/search?q=${encodeURIComponent(`from:${handle} "${addr}"`)}&src=typed_query&f=live`;

            return `
                <div style="background:#18181b; border:1px solid #27272a; border-radius:8px; padding:12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-family:monospace; color:#60a5fa; font-size:12px;">${shortAddr}</span>
                            <button class="clipx-copy-ca" data-addr="${addr}" style="background:none; border:none; cursor:pointer; color:#a1a1aa; font-size:10px; padding:2px 4px;" title="Copy full address">📋</button>
                        </div>
                        <div style="display:flex; gap:4px;">
                            ${(() => { const _c = addr.startsWith('0x') ? 'bnb' : 'sol'; const _u = clipxChainUrls(_c, addr); return `
                            <a href="${_u.dex}" target="_blank" style="background:#27272a; padding:2px 6px; border-radius:4px; font-size:10px; color:#4ade80; text-decoration:none;">DEX</a>
                            <a href="${_u.explorer}" target="_blank" style="background:#27272a; padding:2px 6px; border-radius:4px; font-size:10px; color:#fbbf24; text-decoration:none;">${_c === 'sol' ? 'SOL' : 'BSC'}</a>`; })()}
                            ${tweetUrl
                    ? `<a href="${tweetUrl}" target="_blank" style="background:#27272a; padding:2px 6px; border-radius:4px; font-size:10px; color:#60a5fa; text-decoration:none;">View Tweet</a>`
                    : `<a href="${searchUrl}" target="_blank" style="background:#27272a; padding:2px 6px; border-radius:4px; font-size:10px; color:#a1a1aa; text-decoration:none;">Find Post</a>`
                }
                        </div>
                    </div>
                    ${!tweetUrl ? `
                        <div style="font-size:10px; color:#71717a; font-style:italic; margin-top:4px;">Exact tweet not linked - click Find Post to search</div>
                    ` : ''}
                </div>
            `;
        }).join('');

        // Create modal
        const modal = document.createElement('div');
        modal.id = 'clipx-ca-modal';
        modal.innerHTML = `
            <div style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.7); z-index:99999; display:flex; justify-content:center; align-items:center;">
                <div style="background:#0f0f0f; border:1px solid #27272a; border-radius:12px; width:90%; max-width:500px; max-height:80vh; overflow:hidden; display:flex; flex-direction:column;">
                    <div style="padding:16px; border-bottom:1px solid #27272a; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-weight:700; color:#e5e5e5; font-size:14px;">CA mentioned by @${handle}</div>
                            <div style="font-size:11px; color:#71717a; margin-top:2px;">🟢 ${addresses.length} CA(s) found</div>
                        </div>
                        <button id="clipx-ca-modal-close" style="background:none; border:none; cursor:pointer; color:#a1a1aa; font-size:18px; padding:4px;">✕</button>
                    </div>
                    <div style="padding:16px; overflow-y:auto; flex:1;">
                        ${caListHtml || '<div style="color:#71717a; text-align:center;">No CAs found</div>'}
                    </div>
                    <div style="padding:12px 16px; border-top:1px solid #27272a; text-align:center;">
                        <span style="font-size:10px; color:#71717a;">Powered by ClipX Intel 🕵️</span>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Close button handler
        modal.querySelector('#clipx-ca-modal-close').onclick = () => modal.remove();

        // Click outside to close
        modal.firstElementChild.onclick = (e) => {
            if (e.target === modal.firstElementChild) modal.remove();
        };

        // Copy button handlers
        modal.querySelectorAll('.clipx-copy-ca').forEach(btn => {
            btn.onclick = () => {
                navigator.clipboard.writeText(btn.dataset.addr);
                btn.textContent = '✓';
                setTimeout(() => { btn.textContent = '📋'; }, 1000);
            };
        });
    }, // Added comma here

    // Render Mentions HTML
    renderMentionsHtml() {
        const sortedMentions = Array.from(this.state.mentions.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 5); // Top 5

        if (sortedMentions.length === 0) return '';

        const mentionsHtml = sortedMentions.map(([handle, data]) => {
            const url = `https://x.com/${handle}`;
            return `
                <a href="${url}" target="_blank" style="display:flex; flex-direction:column; align-items:center; text-decoration:none; margin-right:8px; min-width:40px;">
                    <img src="https://unavatar.io/twitter/${handle}" onerror="this.src='https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'" style="width:24px; height:24px; border-radius:50%; border:1px solid #3f3f46; margin-bottom:2px;">
                    <span style="font-size:9px; color:#a1a1aa;">@${handle.length > 8 ? handle.substring(0, 6) + '..' : handle}</span>
                    <span style="font-size:9px; color:#3b82f6; background:rgba(59, 130, 246, 0.1); padding:0 4px; border-radius:4px;">x${data.count}</span>
                </a>
            `;
        }).join('');

        return `
            <div style="margin-top:4px; padding-top:4px; border-top:1px dashed rgba(255,255,255,0.1);">
                <div style="margin-bottom:2px; font-size:11px; color:#a1a1aa; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">Interaction Circle</div>
                <div style="display:flex; overflow-x:auto; padding-bottom:2px; scrollbar-width:none;">
                    ${mentionsHtml}
                </div>
            </div>
        `;
    }
};

// Inject labels on "Who to follow" / "Relevant people" sections (sidebar, inline suggestions, etc.)
async function injectWhoToFollowLabels() {
    // Find "Who to follow" / "You might like" / "Relevant people" / "People you may know" sections
    // These typically use UserCell or similar structures outside of main user list pages

    // Look for sidebar sections: Who to follow, Relevant people, Timeline suggestions
    const sidebarSections = document.querySelectorAll(
        'aside [data-testid="UserCell"], ' +
        '[aria-label*="Timeline: "] [data-testid="UserCell"], ' +
        '[aria-label*="Relevant"] [data-testid="UserCell"]'
    );

    // Also look for inline "Who to follow" cards in the feed
    const inlineUserCards = document.querySelectorAll('[data-testid="cellInnerDiv"]:not([data-clipx-wtf-processed])');

    for (const cell of sidebarSections) {
        if (cell.dataset.clipxWtfProcessed) continue;
        cell.dataset.clipxWtfProcessed = 'true';

        const userNameDiv = cell.querySelector('[data-testid="User-Name"]');
        if (userNameDiv) {
            await processUserNameDiv(userNameDiv);
        }
    }

    for (const cell of inlineUserCards) {
        // Check if this cell contains user info (not a tweet)
        const hasUserCell = cell.querySelector('[data-testid="UserCell"]');
        const hasUserName = cell.querySelector('[data-testid="User-Name"]');
        const isNotTweet = !cell.querySelector('article[data-testid="tweet"]');

        if ((hasUserCell || hasUserName) && isNotTweet) {
            cell.dataset.clipxWtfProcessed = 'true';

            const userNameDiv = hasUserName || (hasUserCell ? hasUserCell.querySelector('[data-testid="User-Name"]') : null);
            if (userNameDiv) {
                await processUserNameDiv(userNameDiv);
            }
        }
    }

    console.log('[ClipX Labels] Processed Who to follow sections');
}

// Inject labels on user list pages (Following, Followers, People You May Know, etc.)
async function injectUserListLabels() {
    const path = window.location.pathname || '';
    if (path.startsWith('/compose/')) return;

    // Debug: Check what selectors exist on the page
    const userNameDivs = document.querySelectorAll('[data-testid="User-Name"]');
    const userCells = document.querySelectorAll('[data-testid="UserCell"]');
    const cellInnerDivs = document.querySelectorAll('[data-testid="cellInnerDiv"]');
    const typeaheadUsers = document.querySelectorAll('[data-testid="typeaheadResult"]');

    // Look for user links (profile links like /@username or /username)
    const allProfileLinks = document.querySelectorAll('a[role="link"][href^="/"]');
    const userProfileLinks = Array.from(allProfileLinks).filter(link => {
        const href = link.getAttribute('href');
        return href && /^\/[a-zA-Z0-9_]+$/.test(href) &&
            !['/', '/home', '/explore', '/search', '/notifications', '/messages', '/i', '/settings', '/compose'].includes(href);
    });

    console.log('[ClipX Labels] DOM scan:', {
        'User-Name': userNameDivs.length,
        'UserCell': userCells.length,
        'cellInnerDiv': cellInnerDivs.length,
        'typeaheadResult': typeaheadUsers.length,
        'profileLinks': userProfileLinks.length,
        'url': path
    });

    // Strategy 1: Use User-Name divs (works on some pages)
    let allUserNames = userNameDivs;

    // Strategy 2: If no User-Name, try to find user cells and extract info
    if (allUserNames.length === 0 && userCells.length > 0) {
        console.log('[ClipX Labels] Using UserCell strategy');
        for (const cell of userCells) {
            if (cell.dataset.clipxUserListProcessed) continue;
            cell.dataset.clipxUserListProcessed = 'true';

            // Find any link that looks like a profile link
            const links = cell.querySelectorAll('a[href^="/"]');
            for (const link of links) {
                const href = link.getAttribute('href');
                const match = href && href.match(/^\/([a-zA-Z0-9_]+)$/);
                if (match && match[1] && !['i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose'].includes(match[1].toLowerCase())) {
                    const handle = match[1].toLowerCase();
                    await injectLabelForUserCell(cell, handle);
                    break;
                }
            }
        }
        return;
    }

    // Strategy 3: If no User-Name and no UserCell, try cellInnerDiv
    if (allUserNames.length === 0 && cellInnerDivs.length > 0) {
        console.log('[ClipX Labels] Using cellInnerDiv strategy');
        for (const cell of cellInnerDivs) {
            if (cell.dataset.clipxUserListProcessed) continue;

            // Check if this looks like a user cell (has profile link, not a tweet)
            if (cell.querySelector('article')) continue; // Skip tweets

            const links = cell.querySelectorAll('a[href^="/"]');
            for (const link of links) {
                const href = link.getAttribute('href');
                const match = href && href.match(/^\/([a-zA-Z0-9_]+)$/);
                if (match && match[1] && !['i', 'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose'].includes(match[1].toLowerCase())) {
                    cell.dataset.clipxUserListProcessed = 'true';
                    const handle = match[1].toLowerCase();
                    await injectLabelForUserCell(cell, handle);
                    break;
                }
            }
        }
        return;
    }

    console.log('[ClipX Labels] Using User-Name strategy, found:', allUserNames.length);

    const userNamePromises = [];

    for (const userNameDiv of allUserNames) {
        // Skip if inside a tweet (those are handled by injectFeedLabels)
        if (userNameDiv.closest('article[data-testid="tweet"]')) {
            continue;
        }

        // Process in parallel using the helper
        userNamePromises.push(processUserNameDiv(userNameDiv));
    }

    // Wait for all to complete (or fail) without blocking
    await Promise.allSettled(userNamePromises);
    console.log('[ClipX Labels] Finished processing User-Name strategy batch. Items:', userNamePromises.length);
}

// Helper to inject label into a user cell (for followers/following pages)
async function injectLabelForUserCell(cell, handle) {
    if (!handle) return;

    // Check if already has label
    if (cell.querySelector(`.clipx-list-label-${handle}`)) return;

    console.log('[ClipX Labels] Fetching label for cell user:', handle);

    try {
        const labelData = await ProfileScanner.fetchLabelForHandle(handle);

        if (!labelData || !labelData.label) return;

        // Create label badge - use existing Gradient style (clipx-label-gradient) as default
        const badge = document.createElement('span');
        badge.className = `clipx-list-label-${handle} clipx-user-list-label`;

        badge.style.cssText = `
            display: inline-flex;
            align-items: center;
            margin: 0;
            vertical-align: middle;
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex-shrink: 0;
        `;
        badge.textContent = labelData.label;
        badge.title = labelData.label;

        applyLabelStyle(badge);

        // Find the best place to append - next to verified badge (after display name row)
        // Look for the row that contains the display name and verified badge
        let targetRow = null;

        // Strategy 1: Find the div containing the display name link (first link in cell)
        const displayNameLink = cell.querySelector('a[href^="/"][role="link"]');
        if (displayNameLink) {
            // The display name is usually in a structure like: div > div > span (name)
            // We want to find the flex row that contains name + badges
            let parent = displayNameLink.parentElement;
            // Go up to find the row container (usually has display:flex)
            for (let i = 0; i < 3 && parent; i++) {
                if (parent.querySelector('svg[aria-label*="Verified"], svg[data-testid*="icon-verified"]')) {
                    targetRow = parent;
                    break;
                }
                parent = parent.parentElement;
            }
        }

        // Strategy 2: Look for verified icon and append to its parent row
        if (!targetRow) {
            const verifiedIcon = cell.querySelector('svg[aria-label*="Verified"], svg[aria-label*="verified"], [data-testid*="icon-verified"]');
            if (verifiedIcon) {
                targetRow = verifiedIcon.closest('div[dir="ltr"]')?.parentElement || verifiedIcon.parentElement?.parentElement;
            }
        }

        // Strategy 3: Find the row with the display name text
        if (!targetRow) {
            const allDivs = cell.querySelectorAll('div[dir="ltr"]');
            for (const div of allDivs) {
                // The name row usually has text and possibly a verified icon
                if (div.querySelector('span') && !div.textContent.includes('@')) {
                    targetRow = div.parentElement;
                    break;
                }
            }
        }

        // Strategy 4: Fallback - find any row with spans (likely name area)
        if (!targetRow) {
            const spans = cell.querySelectorAll('span');
            for (const span of spans) {
                const text = span.textContent || '';
                // Find display name (not handle, not bio)
                if (text.length > 0 && text.length < 50 && !text.includes('@') && !text.includes('http')) {
                    targetRow = span.parentElement;
                    break;
                }
            }
        }

        if (targetRow) {
            targetRow.appendChild(badge);
        } else {
            // Last resort: append to cell
            cell.appendChild(badge);
        }

        console.log('[ClipX Labels] ✓ Injected label for cell user', handle, ':', labelData.label);
    } catch (e) {
        console.error('[ClipX Labels] Error fetching label for cell user', handle, ':', e);
    }
}

// Helper to process a User-Name div and inject label
async function processUserNameDiv(userNameDiv, handleOverride = null) {
    // Skip if already processed
    if (userNameDiv.dataset.clipxListLabelProcessed) return;
    userNameDiv.dataset.clipxListLabelProcessed = 'true';

    // Use override or find handle from links
    let handle = handleOverride ? handleOverride.toLowerCase() : null;

    if (!handle) {
        const links = userNameDiv.querySelectorAll('a[href^="/"]');
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href !== '/' && !href.includes('/status/')) {
                const match = href.match(/^\/([a-zA-Z0-9_]+)$/);
                if (match && match[1]) {
                    handle = match[1].toLowerCase();
                    break;
                }
            }
        }
    }

    if (!handle) return;
    // Debounce/limit logging to avoid console spam
    // console.log('[ClipX Labels] Processing user:', handle);

    // Check if label already injected
    if (userNameDiv.querySelector(`.clipx-list-label-${handle}`)) return;

    // Fetch label using ProfileScanner's method (same as feed labels)
    try {
        const labelData = await ProfileScanner.fetchLabelForHandle(handle);
        // console.log('[ClipX Labels] Label data for', handle, ':', labelData);

        if (!labelData || !labelData.label) return;

        // Create label badge
        const badge = document.createElement('span');
        badge.className = `clipx-list-label-${handle} clipx-user-list-label`;
        badge.style.cssText = `
            display: inline-flex;
            align-items: center;
            margin: 0;
            padding: 2px 4px;
            border-radius: 0;
            font-size: 10px;
            font-weight: 760;
            background: ${labelData.color === 'red' ? 'rgba(239, 68, 68, 0.15)' :
                labelData.color === 'green' ? 'rgba(34, 197, 94, 0.15)' :
                    labelData.color === 'blue' ? 'rgba(59, 130, 246, 0.15)' :
                        'rgba(168, 85, 247, 0.15)'};
            color: ${labelData.color === 'red' ? '#ef4444' :
                labelData.color === 'green' ? '#22c55e' :
                    labelData.color === 'blue' ? '#3b82f6' :
                        '#a855f7'};
            border: 1px solid ${labelData.color === 'red' ? 'rgba(239, 68, 68, 0.3)' :
                labelData.color === 'green' ? 'rgba(34, 197, 94, 0.3)' :
                    labelData.color === 'blue' ? 'rgba(59, 130, 246, 0.3)' :
                        'rgba(168, 85, 247, 0.3)'};
            vertical-align: middle;
            flex-shrink: 0;
            white-space: nowrap;
        `;
        badge.textContent = labelData.label;

        // Find the best place to append - after the username/handle text
        // Look for the last text container in the User-Name div
        const textContainers = userNameDiv.querySelectorAll('span, div');
        let appendTarget = userNameDiv;
        let foundHandleRow = false;

        // Try to find the row that contains the handle (@username) or the name
        // Prioritize the row with the handle (@...)
        for (const container of textContainers) {
            if (container.textContent && container.textContent.includes('@')) {
                appendTarget = container.parentElement || userNameDiv;
                foundHandleRow = true;
                break;
            }
        }

        // If no handle row found, try to find the row with the display name
        if (!foundHandleRow) {
            for (const container of textContainers) {
                // Heuristic: looks like a name if it's bold or has specific class? 
                // X structure varies. Just appending to userNameDiv is safest fallback.
            }
        }

        appendTarget.appendChild(badge);
        console.log('[ClipX Labels] ✓ Injected label for', handle, ':', labelData.label);
    } catch (e) {
        console.error('[ClipX Labels] Error fetching label for', handle, ':', e);
    }
}


// ============================================================
// CLIPX INTEL COMMENT ANALYSIS
// ============================================================

// Create analyze button for tweet action bar
function createAnalyzeButton(tweetLink) {
    const btn = document.createElement('div');
    btn.className = 'clipx-analyze-btn';
    btn.setAttribute('data-tweet-link', tweetLink);

    btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            <path d="M10 7v6m-3-3h6"/>
        </svg>
    `;

    btn.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        cursor: pointer;
        transition: all 0.2s;
        color: #71767b;
    `;

    btn.onmouseenter = () => {
        btn.style.backgroundColor = 'rgba(29, 155, 240, 0.1)';
        btn.style.color = '#1d9bf0';
    };

    btn.onmouseleave = () => {
        btn.style.backgroundColor = 'transparent';
        btn.style.color = '#71767b';
    };

    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showAnalysisModal(tweetLink);
    };

    return btn;
}

// Show analysis modal
async function showAnalysisModal(tweetLink) {
    // Remove existing modal
    document.querySelector('#clipx-analysis-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'clipx-analysis-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        backdrop-filter: blur(8px);
    `;

    modal.innerHTML = `
        <div style="background: linear-gradient(180deg, #0c0c0e 0%, #141418 100%); border-radius: 20px; width: 500px; max-width: 92vw; max-height: 85vh; overflow: hidden; border: 1px solid rgba(168, 85, 247, 0.15); box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 32px 64px -20px rgba(0,0,0,0.7);">
            <div style="padding: 22px 26px; display: flex; justify-content: space-between; align-items: center; background: rgba(168, 85, 247, 0.04); border-bottom: 1px solid rgba(255,255,255,0.04);">
                <div style="display: flex; align-items: center; gap: 16px;">
                    <div style="width: 44px; height: 44px; background: linear-gradient(135deg, #7c3aed 0%, #6366f1 100%); border-radius: 14px; display: flex; align-items: center; justify-content: center;">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                            <circle cx="9" cy="7" r="4"/>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
                        </svg>
                    </div>
                    <div>
                        <div style="font-weight: 700; font-size: 18px; color: #f8fafc; letter-spacing: -0.03em;">ClipX Comment Analyzer</div>
                        <div style="font-size: 12px; color: #64748b; margin-top: 3px; font-weight: 500;">Smart followers & KOLs</div>
                    </div>
                </div>
                <button id="clipx-analysis-close" style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); color: #94a3b8; font-size: 20px; width: 38px; height: 38px; cursor: pointer; border-radius: 12px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; font-weight: 300;">×</button>
            </div>
            <div id="clipx-analysis-content" style="padding: 24px 26px; overflow-y: auto; max-height: calc(85vh - 100px);">
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 56px 28px;">
                    <div style="position: relative; width: 56px; height: 56px;">
                        <div style="position: absolute; inset: 0; border-radius: 50%; border: 2px solid rgba(168, 85, 247, 0.2); animation: clipx-pulse 1.5s ease-in-out infinite;"></div>
                        <div style="position: absolute; inset: 0; border-radius: 50%; border: 2px solid transparent; border-top-color: #7c3aed; border-right-color: #6366f1; animation: clipx-spin 0.9s linear infinite;"></div>
                        <div style="position: absolute; inset: 4px; border-radius: 50%; background: linear-gradient(135deg, rgba(124, 58, 237, 0.15), rgba(99, 102, 241, 0.1)); animation: clipx-glow 2s ease-in-out infinite;"></div>
                    </div>
                    <div style="margin-top: 24px; font-size: 15px; font-weight: 500; color: #94a3b8;">Scanning comments</div>
                    <div style="display: flex; gap: 4px; margin-top: 12px;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: #7c3aed; animation: clipx-dot 1.4s ease-in-out infinite;"></span>
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: #6366f1; animation: clipx-dot 1.4s ease-in-out 0.2s infinite;"></span>
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: #a855f7; animation: clipx-dot 1.4s ease-in-out 0.4s infinite;"></span>
                    </div>
                </div>
                <style>
                    @keyframes clipx-spin { to { transform: rotate(360deg); } }
                    @keyframes clipx-pulse { 0%, 100% { transform: scale(1); opacity: 0.6; } 50% { transform: scale(1.08); opacity: 1; } }
                    @keyframes clipx-glow { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
                    @keyframes clipx-dot { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }
                </style>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close button
    const closeBtn = modal.querySelector('#clipx-analysis-close');
    closeBtn.onclick = () => modal.remove();
    closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(255,255,255,0.08)'; closeBtn.style.color = '#f8fafc'; };
    closeBtn.onmouseleave = () => { closeBtn.style.background = 'rgba(255,255,255,0.04)'; closeBtn.style.color = '#94a3b8'; };
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    // Fetch analysis (no login required)
    try {
        const response = await fetch(`${API_BASE}/api/intel/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tweetLink })
        });

        if (response.status === 429) {
            const errorData = await response.json();
            modal.querySelector('#clipx-analysis-content').innerHTML = `
                <div style="text-align: center; padding: 48px 28px;">
                    <div style="font-size: 36px; margin-bottom: 16px; opacity: 0.7;">⏳</div>
                    <div style="font-size: 16px; font-weight: 600; color: #f8fafc;">Daily Limit Reached</div>
                    <div style="font-size: 14px; color: #64748b; margin-top: 10px;">
                        ${errorData.used}/${errorData.limit} used today · Resets midnight UTC
                    </div>
                </div>
            `;
            return;
        }

        if (!response.ok) throw new Error('API error');

        const data = await response.json();
        renderAnalysisResults(modal, data);
    } catch (error) {
        console.error('[ClipX Intel] Analysis error:', error);
        modal.querySelector('#clipx-analysis-content').innerHTML = `
            <div style="text-align: center; padding: 48px 28px;">
                <div style="font-size: 36px; margin-bottom: 16px; opacity: 0.7;">⚠️</div>
                <div style="font-size: 16px; font-weight: 600; color: #f8fafc;">Failed to analyze</div>
                <div style="font-size: 14px; color: #64748b; margin-top: 10px;">Please try again later</div>
            </div>
        `;
    }
}

// Strip parent @handle from comment text (case-insensitive)
function stripParentHandle(text, parentHandle) {
    if (!text || !parentHandle) return text || '';
    const re = new RegExp('@' + parentHandle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    return text.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

// Render analysis results
function renderAnalysisResults(modal, data) {
    const contentEl = modal.querySelector('#clipx-analysis-content');
    const parentHandle = (data?.parentHandle || '').toLowerCase();

    if (!data || data.totalComments === 0) {
        contentEl.innerHTML = `
            <div style="text-align: center; padding: 48px 24px;">
                <div style="font-size: 36px; margin-bottom: 16px; opacity: 0.5;">💬</div>
                <div style="font-size: 15px; font-weight: 500; color: #94a3b8;">No comments to analyze</div>
                <div style="font-size: 13px; color: #64748b; margin-top: 8px;">Try another tweet</div>
            </div>
        `;
        return;
    }

    // Stats header - professional typography
    const statsHtml = `
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-bottom: 22px;">
            <div style="background: rgba(168, 85, 247, 0.08); border-radius: 14px; padding: 18px; text-align: center; border: 1px solid rgba(168, 85, 247, 0.2);">
                <div style="font-size: 28px; font-weight: 700; color: #e9d5ff; letter-spacing: -0.02em;">${data.influencerComments?.length || 0}</div>
                <div style="font-size: 11px; color: #94a3b8; font-weight: 500; letter-spacing: 0.06em; margin-top: 6px;">SMART FOLLOWERS</div>
            </div>
            <div style="background: rgba(255,255,255,0.02); border-radius: 14px; padding: 18px; text-align: center; border: 1px solid rgba(255,255,255,0.06);">
                <div style="font-size: 28px; font-weight: 700; color: #cbd5e1; letter-spacing: -0.02em;">${data.totalComments}</div>
                <div style="font-size: 11px; color: #64748b; font-weight: 500; letter-spacing: 0.06em; margin-top: 6px;">COMMENTS SCANNED</div>
            </div>
        </div>
    `;

    // Influencers list - exclude parent @handle from comment display
    const influencersHtml = data.influencerComments?.length > 0 ? data.influencerComments.slice(0, 30).map((inf, index) => {
        const verifiedBadge = inf.verified ? '<svg viewBox="0 0 22 22" width="14" height="14" fill="#1d9bf0" style="margin-left: 4px;"><path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>' : '';
        const formatFollowers = (count) => count >= 1000000 ? (count / 1000000).toFixed(1) + 'M' : count >= 1000 ? (count / 1000).toFixed(1) + 'K' : count;

        const avatarUrl = (inf.avatar && inf.avatar.length > 0) ? inf.avatar : `https://unavatar.io/twitter/${inf.username}`;
        const avatarHtml = `<img src="${avatarUrl}" referrerpolicy="no-referrer" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(168, 85, 247, 0.35); flex-shrink: 0;" onerror="this.src='https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png';" />`;

        const commentText = stripParentHandle(inf.comment, parentHandle);

        return `
            <div style="padding: 16px 18px; background: rgba(255,255,255,0.02); border-radius: 14px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="display: flex; align-items: flex-start; gap: 16px;">
                    <div style="flex-shrink: 0;">${avatarHtml}</div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; align-items: center; gap: 4px; margin-bottom: 6px;">
                            <a href="https://x.com/${inf.username}" target="_blank" style="font-size: 15px; font-weight: 600; color: #f8fafc; text-decoration: none;">${inf.name || inf.username}</a>
                            ${verifiedBadge}
                        </div>
                        <div style="font-size: 12px; color: #64748b; margin-bottom: 12px;">@${inf.username} · <span style="color: #c084fc; font-weight: 600;">${formatFollowers(inf.followersCount)}</span></div>
                        <a href="${inf.replyUrl || `https://x.com/${inf.username}`}" target="_blank" style="font-size: 14px; color: #94a3b8; line-height: 1.55; text-decoration: none; display: block; padding: 8px 0; border-radius: 8px; transition: all 0.2s;" onmouseover="this.style.background='rgba(168,85,247,0.08)'; this.style.color='#e9d5ff';" onmouseout="this.style.background='transparent'; this.style.color='#94a3b8';">"${(commentText || '').replace(/"/g, '&quot;')}"</a>
                    </div>
                </div>
            </div>
        `;
    }).join('') : '<div style="color: #64748b; text-align: center; padding: 24px; font-size: 14px;">No smart followers found</div>';

    // DP avatars row at top with small connecting lines
    const influencers = data.influencerComments || [];
    const dpRowHtml = influencers.length > 0 ? `
        <div style="margin-bottom: 20px;">
            <div style="font-size: 10px; color: #64748b; font-weight: 600; letter-spacing: 0.1em; margin-bottom: 12px;">SMART FOLLOWERS</div>
            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 0;">
                ${influencers.map((inf, i) => {
                    const av = (inf.avatar && inf.avatar.length > 0) ? inf.avatar : `https://unavatar.io/twitter/${inf.username}`;
                    const link = inf.replyUrl || `https://x.com/${inf.username}`;
                    const isLast = i === influencers.length - 1;
                    return `
                        <a href="${link}" target="_blank" style="display: flex; align-items: center; text-decoration: none;">
                            <img src="${av}" referrerpolicy="no-referrer" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(168, 85, 247, 0.35);" onerror="this.src='https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png';" title="@${inf.username}" />
                            ${!isLast ? '<div style="width: 6px; height: 1px; background: rgba(168, 85, 247, 0.25); margin: 0 1px;"></div>' : ''}
                        </a>
                    `;
                }).join('')}
            </div>
        </div>
    ` : '';

    contentEl.innerHTML = `
        ${statsHtml}
        ${dpRowHtml}
        <div style="margin-bottom: 12px;">
            <div style="font-size: 10px; color: #64748b; font-weight: 600; letter-spacing: 0.1em;">COMMENTS</div>
        </div>
        <div id="clipx-panel-influencers" style="max-height: 340px; overflow-y: auto; margin: 0 -4px;">
            ${influencersHtml}
        </div>
        
        <div style="margin-top: 18px; padding: 12px 14px; background: rgba(255,255,255,0.02); border-radius: 12px; border: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="font-size: 12px; color: #64748b;">
                ${data.usage?.fromCache ? '⚡ Served from cache' : '4h cache'}
            </div>
            ${data.usage ? `
                <div style="font-size: 12px; color: #94a3b8; font-weight: 500;">
                    ${data.usage.remaining}/${data.usage.limit} left today
                </div>
            ` : ''}
        </div>
    `;
}

/** Action bar that contains Reply / RT / Like (used by Intel analyze button). */
function clipxFindTweetActionBar(article) {
    const closestBar = (el) => {
        if (!el) return null;
        return el.closest('[role="group"]') || el.closest('[role="toolbar"]');
    };
    const reply = article.querySelector('[data-testid="reply"]');
    if (reply) {
        const g = closestBar(reply);
        if (g) return g;
    }
    const rt = article.querySelector('[data-testid="retweet"]');
    if (rt) {
        const g = closestBar(rt);
        if (g) return g;
    }
    const like = article.querySelector('[data-testid="like"]');
    if (like) {
        const g = closestBar(like);
        if (g) return g;
    }
    return article.querySelector('[role="toolbar"]') || article.querySelector('[role="group"]');
}

// Inject analyze buttons into tweet action bars
function injectAnalyzeButtons() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    articles.forEach(article => {
        if (article.hasAttribute('data-clipx-analyze')) return;
        article.setAttribute('data-clipx-analyze', 'true');

        const statusA = article.querySelector('a[href*="/status/"]');
        if (!statusA) return;

        const href = statusA.getAttribute('href') || '';
        const path = href.split('?')[0];
        const tweetLink = path.startsWith('http') ? path : 'https://x.com' + path;

        const actionBar = clipxFindTweetActionBar(article);
        if (!actionBar) return;

        const firstAction = actionBar.firstElementChild;
        if (!firstAction) return;

        const analyzeBtn = createAnalyzeButton(tweetLink);
        analyzeBtn.style.marginRight = '-8px';

        actionBar.insertBefore(analyzeBtn, firstAction);
    });
}

// --- Sorsa TweetScout score — gradient ring + score pill (timeline, compose, profile hero) ---
const CLIPX_RESERVED_HANDLES = new Set(['home', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose', 'i']);
/** Filled only on profile visit (`getSorsaProfileScore`). Timeline pills read this — no Sorsa batch API. */
const CLIPX_SORSA_SCORE_CACHE_KEY = 'clipxSorsaScoresByHandle';

function clipxApplySorsaScoreCacheFromProfileFetch(handle, apiSucceeded, scoreFromApi) {
    if (!apiSucceeded) return;
    const hl = String(handle || '').toLowerCase();
    if (!hl) return;
    chrome.storage.local.get([CLIPX_SORSA_SCORE_CACHE_KEY], (r) => {
        const map = { ...(r[CLIPX_SORSA_SCORE_CACHE_KEY] || {}) };
        if (scoreFromApi != null && Number.isFinite(Number(scoreFromApi))) {
            map[hl] = Number(scoreFromApi);
        } else {
            delete map[hl];
        }
        chrome.storage.local.set({ [CLIPX_SORSA_SCORE_CACHE_KEY]: map });
    });
}

function clipxNormalizeProfileHref(href) {
    if (!href || href === '/') return null;
    let path = String(href).trim();
    if (path.startsWith('http://') || path.startsWith('https://')) {
        try {
            path = new URL(path).pathname;
        } catch (e) {
            return null;
        }
    }
    path = path.split('?')[0].replace(/\/+$/, '');
    const m = path.match(/^\/@?([a-zA-Z0-9_]{1,30})$/);
    if (!m) return null;
    const h = m[1].toLowerCase();
    if (CLIPX_RESERVED_HANDLES.has(h)) return null;
    return h;
}

function clipxExtractHandleFromUserNameDiv(userNameDiv) {
    if (!userNameDiv) return null;
    const links = userNameDiv.querySelectorAll('a[href^="/"]');
    for (const link of links) {
        const href = link.getAttribute('href');
        if (!href || href.includes('/status/')) continue;
        const h = clipxNormalizeProfileHref(href);
        if (h) return h;
    }
    return null;
}

/** Following/Followers rows often omit User-Name — derive handle from profile links in the cell. */
function clipxExtractHandleFromUserCell(cell) {
    if (!cell) return null;
    const anchors = cell.querySelectorAll('a[href^="/"]');
    for (const link of anchors) {
        const href = link.getAttribute('href');
        if (!href || href.includes('/status/')) continue;
        const h = clipxNormalizeProfileHref(href);
        if (h && link.querySelector('img')) return h;
    }
    for (const link of anchors) {
        const href = link.getAttribute('href');
        if (!href || href.includes('/status/')) continue;
        const h = clipxNormalizeProfileHref(href);
        if (h) return h;
    }
    return null;
}

function clipxFindAvatarImgInRoot(root, handle) {
    if (!root || !handle) return null;
    const h = handle.toLowerCase();
    const hrefExact = [`/${h}`, `/@${h}`];

    for (const path of hrefExact) {
        const anchors = root.querySelectorAll(`a[href="${path}"], a[href^="${path}?"]`);
        for (const a of anchors) {
            const img = a.querySelector('img');
            if (img) return img;
        }
    }

    const allA = root.querySelectorAll('a[href^="/"]');
    for (const a of allA) {
        const href = (a.getAttribute('href') || '').split('?')[0];
        if (clipxNormalizeProfileHref(href) !== h) continue;
        const img = a.querySelector(':scope img');
        if (img) return img;
    }

    const imgs = root.querySelectorAll('img[src*="profile_images"], img[src*="profile_"], img[src*="twimg.com/profile"]');
    for (const im of imgs) {
        const a = im.closest('a[href^="/"]');
        if (!a) continue;
        const href = (a.getAttribute('href') || '').split('?')[0];
        if (clipxNormalizeProfileHref(href) !== h) continue;
        const w = im.getBoundingClientRect().width;
        if (w >= 16 && w <= 120) return im;
    }
    return null;
}

function clipxFindAvatarImgForUserName(userNameDiv, handle) {
    if (!userNameDiv || !handle) return null;
    const root = userNameDiv.closest('article[data-testid="tweet"]')
        || userNameDiv.closest('[data-testid="UserCell"]')
        || userNameDiv.closest('[data-testid="cellInnerDiv"]')
        || userNameDiv.closest('[data-testid="primaryColumn"]')
        || document;
    return clipxFindAvatarImgInRoot(root, handle);
}

/** After X virtualizes / re-renders a row, img may still have clipxSorsaDone but our UI is gone — allow re-inject. */
function clipxSorsaClearStaleDoneInListRow(img) {
    if (!img || img.dataset.clipxSorsaDone !== '1') return;
    const cell = img.closest('[data-testid="UserCell"]') || img.closest('[data-testid="cellInnerDiv"]');
    if (!cell) return;
    const hasUi =
        cell.querySelector('.clipx-sorsa-pill-fallback') ||
        cell.querySelector('.clipx-sorsa-below-avatar') ||
        cell.querySelector('.clipx-sorsa-avatar-shell');
    if (!hasUi || !img.isConnected) {
        delete img.dataset.clipxSorsaDone;
    }
}

/**
 * Tweet/post User-Name is usually a column: row1 = display name + icons, row2 = @handle · time.
 * If we anchor after the time or handle link, ClipX slots land on row 2 or as a new column child
 * between rows (broken layout on permalink / focused post). Prefer the first horizontal flex row.
 */
function clipxFindUserNameDisplayNameRow(userNameDiv) {
    if (!userNameDiv) return null;
    const verified = userNameDiv.querySelector(
        'svg[data-testid="icon-verified"], svg[aria-label*="Verified"], svg[aria-label*="verified"]',
    );
    if (verified) {
        let p = verified.parentElement;
        while (p && p !== userNameDiv) {
            try {
                const st = window.getComputedStyle(p);
                if (st.display === 'flex' && (st.flexDirection === 'row' || st.flexDirection === 'row-reverse')) {
                    return p;
                }
            } catch (e) {
                /* ignore */
            }
            p = p.parentElement;
        }
    }
    const firstDir = userNameDiv.querySelector(':scope > div[dir="ltr"]');
    if (firstDir) {
        try {
            const st = window.getComputedStyle(firstDir);
            if (st.display === 'flex' && (st.flexDirection === 'row' || st.flexDirection === 'row-reverse')) {
                return firstDir;
            }
        } catch (e) {
            /* ignore */
        }
    }
    let child = userNameDiv.firstElementChild;
    while (child) {
        try {
            const st = window.getComputedStyle(child);
            if (st.display === 'flex' && (st.flexDirection === 'row' || st.flexDirection === 'row-reverse')) {
                return child;
            }
        } catch (e) {
            /* ignore */
        }
        child = child.nextElementSibling;
    }
    return null;
}

/**
 * X order is usually: display name, then @handle on the next row, then time — we append ClipX meta on the name row,
 * which looks like: Name | Label | Sentiment | @handle. Move @handle (and · time) before the inline meta slot.
 */
function clipxReorderHandleBeforeClipxMeta(userNameDiv) {
    const slot = userNameDiv.querySelector('.clipx-inline-tweet-meta:not([data-clipx-surf-slot])');
    const nameRow = clipxFindUserNameDisplayNameRow(userNameDiv);
    if (!slot || !nameRow || slot.parentNode !== nameRow) return;

    const handle = clipxExtractHandleFromUserNameDiv(userNameDiv);
    if (!handle) return;

    const profileAs = [...userNameDiv.querySelectorAll('a[href^="/"]')].filter((a) => {
        const h = clipxNormalizeProfileHref((a.getAttribute('href') || '').split('?')[0]);
        return h === handle;
    });

    if (profileAs.length < 2) return;

    const handleRe = new RegExp(`^@?${handle}$`, 'i');
    let handleLink = profileAs.find((a) => handleRe.test(String(a.textContent || '').trim().replace(/\s/g, '')));
    if (!handleLink) handleLink = profileAs[1];
    if (!handleLink || slot.contains(handleLink)) return;

    const rowChildren = [...nameRow.children];
    const slotIdx = rowChildren.indexOf(slot);
    const handleIdx = rowChildren.indexOf(handleLink);
    if (handleIdx !== -1 && slotIdx !== -1 && handleIdx < slotIdx) return;

    const siblingsAfter = [];
    let cur = handleLink.nextSibling;
    let guard = 0;
    while (cur && guard < 14) {
        const next = cur.nextSibling;
        siblingsAfter.push(cur);
        if (
            cur.nodeType === Node.ELEMENT_NODE &&
            cur.tagName === 'A' &&
            (cur.getAttribute('href') || '').includes('/status/')
        ) {
            break;
        }
        cur = next;
        guard++;
    }

    nameRow.insertBefore(handleLink, slot);
    for (const node of siblingsAfter) {
        if (node && node.parentNode) nameRow.insertBefore(node, slot);
    }
}

/** Mark display-name vs @handle links so crowded rows ellipsize the handle, not the main name. */
function clipxApplyTweetNameHandleShrinkClasses(userNameDiv) {
    if (!userNameDiv || !userNameDiv.closest('article[data-testid="tweet"]')) return;

    userNameDiv
        .querySelectorAll(
            'a.clipx-tweet-handle-shrink, a.clipx-tweet-display-name-preserve, .clipx-tweet-display-name-wrap',
        )
        .forEach((el) => {
            el.classList.remove(
                'clipx-tweet-handle-shrink',
                'clipx-tweet-display-name-preserve',
                'clipx-tweet-display-name-wrap',
            );
        });

    const handle = clipxExtractHandleFromUserNameDiv(userNameDiv);
    if (!handle) return;

    const profileAs = [...userNameDiv.querySelectorAll('a[href^="/"]')].filter((a) => {
        const h = clipxNormalizeProfileHref((a.getAttribute('href') || '').split('?')[0]);
        return h === handle;
    });

    if (profileAs.length < 2) return;

    const textLooksLikeHandle = (a) => /^@/.test(String(a.textContent || '').trim());

    let handleLink = profileAs.find((a) => textLooksLikeHandle(a));
    if (!handleLink) {
        const handleRe = new RegExp(`^@?${handle}$`, 'i');
        handleLink = profileAs.find((a) => handleRe.test(String(a.textContent || '').trim().replace(/\s/g, '')));
    }
    if (!handleLink) handleLink = profileAs[1];

    let displayLink = profileAs.find((a) => !textLooksLikeHandle(a));
    if (!displayLink) displayLink = profileAs[0];

    if (handleLink && displayLink && handleLink === displayLink) return;

    const nameRow = clipxFindUserNameDisplayNameRow(userNameDiv);
    if (displayLink && handleLink && displayLink !== handleLink) {
        displayLink.classList.add('clipx-tweet-display-name-preserve');
        let p = displayLink.parentElement;
        while (p && p !== nameRow && p !== userNameDiv) {
            if (p.tagName === 'DIV') {
                p.classList.add('clipx-tweet-display-name-wrap');
            }
            p = p.parentElement;
        }
    }
    if (handleLink) {
        handleLink.classList.add('clipx-tweet-handle-shrink');
    }
}

/**
 * Fallback anchor when the display-name row cannot be found: after time link, else first profile link.
 * Avoid appending to User-Name root — that adds a new column row.
 */
function clipxFindInlineMetaInsertAfter(userNameDiv) {
    if (!userNameDiv) return null;
    const timeLink = userNameDiv.querySelector('a[href*="/status/"]');
    if (timeLink) return timeLink;
    const links = userNameDiv.querySelectorAll('a[href^="/"]');
    for (const link of links) {
        const href = (link.getAttribute('href') || '').split('?')[0];
        if (!href || href === '/') continue;
        if (href.includes('/status/')) continue;
        if (href.startsWith('/i/')) continue;
        return link;
    }
    return null;
}

/** When X sets User-Name as a column via inline styles, reinforce one horizontal wrapping row on post permalinks. */
function clipxReinforcePostViewUserNameRow(userNameDiv) {
    if (!userNameDiv || !clipxIsSingleStatusPermalinkPage()) return;
    if (!userNameDiv.closest('article[data-testid="tweet"]')) return;
    userNameDiv.style.setProperty('display', 'flex', 'important');
    userNameDiv.style.setProperty('flex-direction', 'row', 'important');
    userNameDiv.style.setProperty('flex-wrap', 'wrap', 'important');
    userNameDiv.style.setProperty('align-items', 'center', 'important');
    userNameDiv.style.setProperty('column-gap', '10px', 'important');
    userNameDiv.style.setProperty('row-gap', '2px', 'important');
}

function clipxMountInlineMetaSlot(userNameDiv, slot) {
    if (!userNameDiv || !slot) return;
    const nameRow = clipxFindUserNameDisplayNameRow(userNameDiv);
    if (nameRow) {
        if (nameRow.lastElementChild !== slot) {
            nameRow.appendChild(slot);
        }
        clipxReinforcePostViewUserNameRow(userNameDiv);
        return;
    }
    const anchor = clipxFindInlineMetaInsertAfter(userNameDiv);
    if (anchor) {
        if (anchor.nextSibling !== slot) {
            anchor.insertAdjacentElement('afterend', slot);
        }
    } else {
        userNameDiv.style.flexWrap = 'nowrap';
        userNameDiv.style.alignItems = 'center';
        if (userNameDiv.lastElementChild !== slot) {
            userNameDiv.appendChild(slot);
        }
    }
    clipxReinforcePostViewUserNameRow(userNameDiv);
}

/** Inline slot after the tweet timestamp / handle (feed labels + sentiment). Repositioned if the DOM updates (post/reply). */
function clipxEnsureInlineMetaSlot(userNameDiv) {
    if (!userNameDiv) return null;
    let slot = userNameDiv.querySelector('.clipx-inline-tweet-meta:not([data-clipx-surf-slot])');
    if (!slot) {
        slot = document.createElement('span');
        slot.className = 'clipx-inline-tweet-meta';
        slot.style.cssText =
            'display:inline-flex;align-items:center;gap:5px;margin-left:6px;flex-wrap:nowrap;flex-shrink:0;min-width:0;vertical-align:middle;max-width:min(100%,320px);';
    }
    clipxMountInlineMetaSlot(userNameDiv, slot);
    try {
        clipxReorderHandleBeforeClipxMeta(userNameDiv);
    } catch (e) {
        /* ignore */
    }
    try {
        clipxApplyTweetNameHandleShrinkClasses(userNameDiv);
    } catch (e) {
        /* ignore */
    }
    return slot;
}

/**
 * Profile Surf sentiment: place beside the ClipX label pill when present (same row as name/label),
 * otherwise fall back to the generic inline meta slot (often end of header — easy to miss).
 */
function clipxEnsureProfileSurfSentimentSlot(userNameDiv) {
    if (!userNameDiv) return null;
    const label = document.getElementById('clipx-profile-label');
    const labelInHeader = label && label.isConnected && userNameDiv.contains(label);

    let slot = userNameDiv.querySelector('[data-clipx-surf-slot="profile"]');

    if (labelInHeader) {
        if (!slot) {
            slot = document.createElement('span');
            slot.setAttribute('data-clipx-surf-slot', 'profile');
            slot.className = 'clipx-profile-sentiment-slot';
            slot.style.cssText =
                'display:inline-flex;align-items:center;gap:4px;margin-left:8px;vertical-align:middle;flex-shrink:0;';
            label.insertAdjacentElement('afterend', slot);
            return slot;
        }
        if (label.nextElementSibling !== slot) {
            label.insertAdjacentElement('afterend', slot);
        }
        return slot;
    }

    if (!slot) {
        slot = document.createElement('span');
        slot.setAttribute('data-clipx-surf-slot', 'profile');
        slot.className = 'clipx-inline-tweet-meta';
        slot.style.cssText =
            'display:inline-flex;align-items:center;gap:5px;margin-left:6px;flex-wrap:nowrap;flex-shrink:0;min-width:0;vertical-align:middle;max-width:min(100%,320px);';
    }
    clipxMountInlineMetaSlot(userNameDiv, slot);
    return slot;
}

/** Sentiment score 0–1: green / gold / orange-red (user-specified hex). */
function clipxSurfSentimentTierStyle(score) {
    if (score >= 0.55) return { bg: '#0ff23c', fg: '#0a1a0f' };
    if (score >= 0.45) return { bg: '#f2d00f', fg: '#1a1500' };
    return { bg: '#f24b0f', fg: '#fff' };
}

function clipxFormatSorsaScore(score) {
    if (score == null || Number.isNaN(Number(score))) return null;
    const n = Number(score);
    if (!Number.isFinite(n)) return null;
    if (Math.abs(n) >= 100) return Math.round(n).toLocaleString('en-US');
    if (Math.abs(n) >= 10) return (n % 1 === 0) ? String(Math.round(n)) : n.toFixed(1);
    return n.toFixed(2);
}

function ensureClipxSorsaVisualStyles() {
    if (document.getElementById('clipx-sorsa-visual-css')) return;
    const st = document.createElement('style');
    st.id = 'clipx-sorsa-visual-css';
    st.textContent = `
/* Shell wraps the native <a><img></a> — do NOT set img width/height 100% (collapses avatar) */
.clipx-sorsa-avatar-shell{position:relative;display:inline-block;line-height:0;vertical-align:middle;border-radius:50%;
  padding:2px;
  background:linear-gradient(135deg,#5eb3ff 0%,#9187f2 50%,#ec4899 100%);
  box-shadow:0 0 12px rgba(145,135,242,0.35);}
.clipx-sorsa-avatar-shell>a{display:inline-block;line-height:0;border-radius:50%;overflow:hidden;
  box-shadow:inset 0 0 0 2px #1c2838;}
.clipx-sorsa-avatar-shell>a img{display:block;border-radius:50%;object-fit:cover;max-width:none;width:auto;height:auto;}
/* Profile hero: no gradient ring — pill only, bottom-center on avatar (matches X red-box target). */
.clipx-sorsa-avatar-shell.clipx-sorsa-avatar-shell--plain{
  padding:0;background:transparent;box-shadow:none;border-radius:50%;
}
.clipx-sorsa-avatar-shell.clipx-sorsa-avatar-shell--plain>a{
  box-shadow:none;
}
.clipx-sorsa-avatar-shell.clipx-sorsa-avatar-shell--plain .clipx-sorsa-badge-wrap{z-index:20;}
.clipx-sorsa-badge-wrap{position:absolute;left:50%;bottom:0;transform:translate(-50%,50%);z-index:6;pointer-events:none;white-space:nowrap;}
.clipx-sorsa-badge-inner{display:inline-flex;align-items:center;justify-content:center;gap:0;padding:2px 7px 3px;border-radius:999px;
  background:#fff930;
  box-shadow:0 1px 4px rgba(15,23,42,0.14),inset 0 1px 0 rgba(0,0,0,0.5);
  border:1px solid rgba(0,0,0,0.5);}
.clipx-sorsa-badge-num{color:#1c1917;font-weight:800;font-size:11px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:-0.02em;line-height:1.15;}
.clipx-sorsa-pill-fallback{display:inline-flex;align-items:center;justify-content:center;margin-left:6px;padding:2px 9px;border-radius:999px;
  vertical-align:middle;flex-shrink:0;
  background:#fff930;
  box-shadow:0 1px 4px rgba(15,23,42,0.12);border:1px solid rgba(0,0,0,0.5);}
.clipx-sorsa-pill-fallback .clipx-sorsa-badge-num{color:#1c1917;}
/* Timeline: score row — width matched to avatar block in JS; pill centered under profile image */
.clipx-sorsa-below-avatar{
  box-sizing:border-box;flex-shrink:0;
  display:flex;justify-content:center;align-items:center;line-height:1;pointer-events:none;
  position:relative;z-index:2;transform:none;
  align-self:center;
}
.clipx-sorsa-below-avatar .clipx-sorsa-badge-inner{
  padding:1px 6px 2px !important;justify-content:center !important;transform:none;
}
.clipx-sorsa-below-avatar .clipx-sorsa-badge-num{
  font-size:9px !important;color:#1c1917 !important;font-variant-numeric:tabular-nums;
}
`;
    document.head.appendChild(st);
}

/**
 * User name row for Sorsa pill (profile + lists). Following/Followers often omit UserName testids;
 * runtime logs showed hasUn:false → overlay_fallback → broken avatars — so we also match ltr rows with profile links.
 */
function clipxFindSorsaUserNameInRoot(root) {
    if (!root) return null;
    let u = root.querySelector('[data-testid="User-Name"], [data-testid="UserName"]');
    if (u) return u;
    const inner = root.querySelector('[data-testid="cellInnerDiv"]');
    if (inner) {
        u = inner.querySelector('[data-testid="User-Name"], [data-testid="UserName"]');
        if (u) return u;
    }
    const scope = inner || root;
    const rows = scope.querySelectorAll('div[dir="ltr"]');
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const links = row.querySelectorAll('a[href^="/"]');
        for (let j = 0; j < links.length; j++) {
            const href = (links[j].getAttribute('href') || '').split('?')[0];
            if (href && !href.includes('/status/') && clipxNormalizeProfileHref(href)) {
                return row;
            }
        }
    }
    return null;
}

/** True when this avatar link points at the profile owner on a /handle page (hero or header). */
function clipxIsProfilePageHeroAvatar(img, anchor) {
    const pathHandle = clipxProfileHandleFromPathname(window.location.pathname);
    if (!pathHandle) return false;
    const h = clipxNormalizeProfileHref(anchor.getAttribute('href') || '');
    return !!(h && h.toLowerCase() === pathHandle.toLowerCase() && !img.closest('article[data-testid="tweet"]'));
}

/** Closest layout root for below-avatar Sorsa pill: tweet, user list row, or profile header. */
function clipxGetSorsaLayoutRoot(img) {
    const anchor = img && img.closest('a');
    if (!anchor) return null;
    const article = img.closest('article[data-testid="tweet"]');
    if (article && article.contains(anchor)) return article;
    const cell = img.closest('[data-testid="UserCell"]');
    if (cell && cell.contains(anchor)) return cell;
    const cellInner = img.closest('[data-testid="cellInnerDiv"]');
    if (
        cellInner &&
        cellInner.contains(anchor) &&
        !img.closest('[data-testid="UserProfileHeader_Items"]')
    ) {
        return cellInner;
    }
    const header = img.closest('[data-testid="UserProfileHeader_Items"]');
    if (header && header.contains(anchor)) return header;
    const pc = img.closest('[data-testid="primaryColumn"]');
    if (pc && pc.contains(anchor) && clipxIsProfilePageHeroAvatar(img, anchor)) {
        return pc;
    }
    return null;
}

/**
 * Flex column that holds the avatar (left rail) inside root — tweet article, UserCell, or profile header.
 */
function clipxFindAvatarColumnInRoot(img, root) {
    if (!root) return null;
    const anchor = img.closest('a');
    if (!anchor || !root.contains(anchor)) return null;

    let node = anchor;
    for (let depth = 0; depth < 14 && node && node !== root; depth++) {
        const par = node.parentElement;
        if (!par) break;
        if (!root.contains(par)) break;
        try {
            const cs = window.getComputedStyle(par);
            const isFlexRow =
                (cs.display === 'flex' || cs.display === 'inline-flex') &&
                (cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse' || cs.flexDirection === '');
            if (isFlexRow) {
                for (let i = 0; i < par.children.length; i++) {
                    const ch = par.children[i];
                    if (ch.contains(anchor)) return ch;
                }
            }
        } catch (e) {
            /* ignore */
        }
        node = par;
    }
    return anchor.parentElement;
}

/** Flex column that holds the tweet avatar (left rail). */
function clipxFindTweetAvatarColumn(img) {
    const article = img.closest('article[data-testid="tweet"]');
    if (!article) return null;
    return clipxFindAvatarColumnInRoot(img, article);
}

/** Match score row width to avatar; pull pill up ~20% of avatar height over bottom of circle. List rows: cap ~40px like timeline. */
function clipxApplySorsaBelowAvatarOverlap(scoreWrap, img, block, inListRow) {
    const apply = () => {
        const h = img.getBoundingClientRect().height || img.offsetHeight || img.naturalHeight || 0;
        if (h > 0) {
            const overlap = Math.max(4, Math.round(h * 0.2));
            scoreWrap.style.marginTop = `-${overlap}px`;
        }
        let w = 0;
        if (inListRow) {
            const iw = img.getBoundingClientRect().width || img.offsetWidth || 0;
            w = Math.round(Math.min(Math.max(iw || 40, 32), 48));
        } else if (block && block.isConnected) {
            const bw = block.getBoundingClientRect().width || block.offsetWidth || 0;
            if (bw > 0) w = Math.round(bw);
        }
        if (w > 0) scoreWrap.style.width = `${w}px`;
    };
    apply();
    requestAnimationFrame(apply);
}

/** Direct child of avatar column that contains the profile link (stack score below this block). */
function clipxFindAvatarBlockInColumn(column, anchor) {
    if (!column || !anchor || !column.contains(anchor)) return null;
    let n = anchor;
    while (n.parentElement !== column) {
        n = n.parentElement;
        if (!n || n === column) return anchor;
    }
    return n;
}

/**
 * Score row under avatar (timeline tweets, Followers/Following/Who to follow UserCells, profile hero).
 */
function clipxInjectSorsaScoreBelowTimelineAvatar(img, scoreStr, rawScore) {
    if (!img || img.dataset.clipxSorsaDone === '1') return;
    const anchor = img.closest('a');
    if (!anchor) return;

    const inTweet = !!img.closest('article[data-testid="tweet"]');
    const inListRow =
        !inTweet &&
        !!(img.closest('[data-testid="UserCell"]') || img.closest('[data-testid="cellInnerDiv"]'));

    const root = clipxGetSorsaLayoutRoot(img);
    if (!root) return;

    const column = clipxFindAvatarColumnInRoot(img, root);
    if (!column) {
        const un = clipxFindSorsaUserNameInRoot(root);
        if (un) {
            clipxInjectSorsaPillBesideUserName(un, scoreStr, rawScore);
            img.dataset.clipxSorsaDone = '1';
        }
        return;
    }

    if (column.querySelector('.clipx-sorsa-below-avatar')) {
        img.dataset.clipxSorsaDone = '1';
        return;
    }

    const block = clipxFindAvatarBlockInColumn(column, anchor);
    if (!block) {
        const un = clipxFindSorsaUserNameInRoot(root);
        if (un) {
            clipxInjectSorsaPillBesideUserName(un, scoreStr, rawScore);
            img.dataset.clipxSorsaDone = '1';
        }
        return;
    }

    ensureClipxSorsaVisualStyles();
    img.dataset.clipxSorsaDone = '1';

    /** Following/Followers: do not mutate the outer row flex (breaks avatars). Tweet/profile: column + center. */
    if (!inListRow) {
        try {
            const cs = window.getComputedStyle(column);
            if (cs.display === 'flex' || cs.display === 'inline-flex') {
                if (cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse' || cs.flexDirection === '') {
                    column.style.setProperty('flex-direction', 'column', 'important');
                }
                column.style.setProperty('align-items', 'center', 'important');
            }
        } catch (e) {
            /* ignore */
        }
    }

    const scoreWrap = document.createElement('div');
    scoreWrap.className = 'clipx-sorsa-below-avatar';
    scoreWrap.title = 'TweetScout score (Sorsa)';
    const inner = document.createElement('span');
    inner.className = 'clipx-sorsa-badge-inner';
    const num = document.createElement('span');
    num.className = 'clipx-sorsa-badge-num';
    num.textContent = scoreStr;
    inner.appendChild(num);
    scoreWrap.appendChild(inner);

    /**
     * List rows: never reparent the avatar block (wrapping in a stack breaks X/React and shows black avatars).
     * Insert the score as the next sibling of the avatar block — same as timeline, without column flex hacks.
     */
    if (typeof block.after === 'function') {
        block.after(scoreWrap);
    } else {
        column.insertBefore(scoreWrap, block.nextSibling);
    }

    try {
        column.style.setProperty('overflow', 'visible', 'important');
    } catch (e) {
        /* ignore */
    }
    clipxApplySorsaBelowAvatarOverlap(scoreWrap, img, block, inListRow);
}

/**
 * Profile hero only: same `.clipx-sorsa-below-avatar` stack as timeline (bottom-center under photo),
 * with extra column candidates when X’s layout doesn’t expose a flex row to clipxFindAvatarColumnInRoot.
 * Avoids the gradient-ring overlay on profiles so design matches other pages.
 */
function clipxInjectProfileHeroSorsaBelowAvatar(img, scoreStr, rawScore) {
    if (!img || img.dataset.clipxSorsaDone === '1') return;
    const anchor = img.closest('a');
    if (!anchor) return;
    const header = document.querySelector('[data-testid="UserProfileHeader_Items"]');
    if (!header || !header.contains(anchor)) return;
    if (!clipxIsProfilePageHeroAvatar(img, anchor)) return;

    const candidates = [];
    let n = anchor;
    for (let d = 0; d < 22 && n && header.contains(n); d++) {
        if (n === header) break;
        try {
            const cs = window.getComputedStyle(n);
            if (
                (cs.display === 'flex' || cs.display === 'inline-flex') &&
                (cs.flexDirection === 'column' || cs.flexDirection === 'column-reverse')
            ) {
                candidates.push(n);
            }
        } catch (e) {
            /* ignore */
        }
        n = n.parentElement;
    }
    if (anchor.parentElement) candidates.push(anchor.parentElement);
    if (anchor.parentElement && anchor.parentElement.parentElement) {
        candidates.push(anchor.parentElement.parentElement);
    }

    ensureClipxSorsaVisualStyles();

    for (let ci = 0; ci < candidates.length; ci++) {
        const column = candidates[ci];
        if (!column || !column.contains(anchor)) continue;
        if (column.querySelector('.clipx-sorsa-below-avatar')) {
            img.dataset.clipxSorsaDone = '1';
            return;
        }
        const block = clipxFindAvatarBlockInColumn(column, anchor);
        if (!block) continue;

        img.dataset.clipxSorsaDone = '1';

        try {
            const cs = window.getComputedStyle(column);
            if (cs.display === 'flex' || cs.display === 'inline-flex') {
                if (cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse' || cs.flexDirection === '') {
                    column.style.setProperty('flex-direction', 'column', 'important');
                }
                column.style.setProperty('align-items', 'center', 'important');
            }
        } catch (e) {
            /* ignore */
        }

        const scoreWrap = document.createElement('div');
        scoreWrap.className = 'clipx-sorsa-below-avatar';
        scoreWrap.title = 'TweetScout score (Sorsa)';
        const inner = document.createElement('span');
        inner.className = 'clipx-sorsa-badge-inner';
        const num = document.createElement('span');
        num.className = 'clipx-sorsa-badge-num';
        num.textContent = scoreStr;
        inner.appendChild(num);
        scoreWrap.appendChild(inner);

        if (typeof block.after === 'function') {
            block.after(scoreWrap);
        } else {
            column.insertBefore(scoreWrap, block.nextSibling);
        }

        try {
            column.style.setProperty('overflow', 'visible', 'important');
        } catch (e) {
            /* ignore */
        }
        clipxApplySorsaBelowAvatarOverlap(scoreWrap, img, block, false);
        return;
    }
}

/** Profile hero: yellow pill only, bottom-center on avatar (same geometry as gradient overlay, no ring). */
function clipxApplySorsaProfileHeroPillOverlay(img, scoreStr, rawScore) {
    if (!img || img.dataset.clipxSorsaDone === '1') return;
    const anchor = img.closest('a');
    if (!anchor) return;
    const heroMatch =
        clipxIsProfilePageHeroAvatar(img, anchor) ||
        (clipxIsProfileHeroImage(img) && img === clipxFindProfileHeroAvatarImgHeuristic());
    if (!heroMatch) return;
    ensureClipxSorsaVisualStyles();
    img.dataset.clipxSorsaDone = '1';

    const shell = document.createElement('span');
    shell.className = 'clipx-sorsa-avatar-shell clipx-sorsa-avatar-shell--plain';
    anchor.parentNode.insertBefore(shell, anchor);
    shell.appendChild(anchor);

    const badgeWrap = document.createElement('span');
    badgeWrap.className = 'clipx-sorsa-badge-wrap';
    const badgeInner = document.createElement('span');
    badgeInner.className = 'clipx-sorsa-badge-inner';
    const num = document.createElement('span');
    num.className = 'clipx-sorsa-badge-num';
    num.textContent = scoreStr;
    badgeInner.appendChild(num);
    badgeWrap.appendChild(badgeInner);
    shell.appendChild(badgeWrap);
    shell.title = 'TweetScout score (Sorsa)';

    let n = shell;
    for (let d = 0; d < 14 && n; d++) {
        try {
            n.style.setProperty('overflow', 'visible', 'important');
        } catch (e) {
            /* ignore */
        }
        if (n.getAttribute && n.getAttribute('data-testid') === 'UserProfileHeader_Items') break;
        n = n.parentElement;
    }
}

/** Profile hero when avatar is not wrapped in `<a>` (wrap img + pill). */
function clipxApplySorsaProfileHeroPillOnImg(img, scoreStr) {
    if (!img || img.dataset.clipxSorsaDone === '1') return;
    if (!clipxIsProfileHeroImage(img)) return;
    if (img !== clipxFindProfileHeroAvatarImgHeuristic()) return;
    const p = img.parentNode;
    if (!p) return;
    ensureClipxSorsaVisualStyles();
    img.dataset.clipxSorsaDone = '1';

    const shell = document.createElement('span');
    shell.className = 'clipx-sorsa-avatar-shell clipx-sorsa-avatar-shell--plain';
    p.insertBefore(shell, img);
    shell.appendChild(img);

    const badgeWrap = document.createElement('span');
    badgeWrap.className = 'clipx-sorsa-badge-wrap';
    const badgeInner = document.createElement('span');
    badgeInner.className = 'clipx-sorsa-badge-inner';
    const num = document.createElement('span');
    num.className = 'clipx-sorsa-badge-num';
    num.textContent = scoreStr;
    badgeInner.appendChild(num);
    badgeWrap.appendChild(badgeInner);
    shell.appendChild(badgeWrap);
    shell.title = 'TweetScout score (Sorsa)';

    let n = shell;
    for (let d = 0; d < 14 && n; d++) {
        try {
            n.style.setProperty('overflow', 'visible', 'important');
        } catch (e) {
            /* ignore */
        }
        if (n.getAttribute && n.getAttribute('data-testid') === 'UserProfileHeader_Items') break;
        n = n.parentElement;
    }
}

/** Shared overlay: gradient ring + score pill (compose; fallback when below-avatar cannot attach). */
function clipxApplySorsaAvatarOverlay(img, scoreStr, rawScore) {
    if (!img || img.dataset.clipxSorsaDone === '1') return;
    const anchor = img.closest('a');
    if (!anchor) return;
    ensureClipxSorsaVisualStyles();
    img.dataset.clipxSorsaDone = '1';

    const shell = document.createElement('span');
    shell.className = 'clipx-sorsa-avatar-shell';
    anchor.parentNode.insertBefore(shell, anchor);
    shell.appendChild(anchor);

    const badgeWrap = document.createElement('span');
    badgeWrap.className = 'clipx-sorsa-badge-wrap';
    const badgeInner = document.createElement('span');
    badgeInner.className = 'clipx-sorsa-badge-inner';
    const num = document.createElement('span');
    num.className = 'clipx-sorsa-badge-num';
    num.textContent = scoreStr;
    badgeInner.appendChild(num);
    badgeWrap.appendChild(badgeInner);
    shell.appendChild(badgeWrap);
    shell.title = 'TweetScout score (Sorsa)';
}

/** Update score text when profile score loads after initial … placeholder. */
function clipxUpdateSorsaAvatarOverlay(img, scoreStr, rawScore) {
    const root = img && clipxGetSorsaLayoutRoot(img);
    if (root) {
        const below = root.querySelector('.clipx-sorsa-below-avatar .clipx-sorsa-badge-num');
        if (below) {
            below.textContent = scoreStr;
            return;
        }
    }
    const cell = img && (img.closest('[data-testid="UserCell"]') || img.closest('[data-testid="cellInnerDiv"]'));
    if (cell) {
        const pillNum = cell.querySelector('.clipx-sorsa-pill-fallback .clipx-sorsa-badge-num');
        if (pillNum) {
            pillNum.textContent = scoreStr;
            return;
        }
    }
    const shell = img && img.closest('.clipx-sorsa-avatar-shell');
    if (shell) {
        const num = shell.querySelector('.clipx-sorsa-badge-num');
        if (num) num.textContent = scoreStr;
        return;
    }
    clipxInjectSorsaBadgeOnAvatar(img, scoreStr, rawScore);
}

function clipxInjectSorsaBadgeOnAvatar(img, scoreStr, rawScore) {
    clipxSorsaClearStaleDoneInListRow(img);
    if (img.dataset.clipxSorsaDone === '1') return;

    const inTweet = !!img.closest('article[data-testid="tweet"]');
    const anchorPh = img.closest('a');

    /** Profile owner hero: absolute pill on bottom-center of avatar (red-box area). */
    if (!inTweet && clipxIsProfileHeroImage(img)) {
        if (anchorPh) {
            clipxApplySorsaProfileHeroPillOverlay(img, scoreStr, rawScore);
        } else {
            clipxApplySorsaProfileHeroPillOnImg(img, scoreStr);
        }
        if (img.dataset.clipxSorsaDone === '1') return;
    }

    const inUserCell = !!img.closest('[data-testid="UserCell"]');
    const inCellInnerList =
        !!img.closest('[data-testid="cellInnerDiv"]') && !inTweet;

    /** Following / Who to follow: same below-avatar badge as timeline (narrow stack under photo; no outer row flex hacks). */
    if ((inUserCell || inCellInnerList) && !inTweet) {
        clipxInjectSorsaScoreBelowTimelineAvatar(img, scoreStr, rawScore);
        return;
    }

    const layoutRoot = clipxGetSorsaLayoutRoot(img);
    if (layoutRoot) {
        clipxInjectSorsaScoreBelowTimelineAvatar(img, scoreStr, rawScore);
        if (img.dataset.clipxSorsaDone === '1') return;
    }
    if (!inTweet && anchorPh && clipxIsProfilePageHeroAvatar(img, anchorPh)) {
        clipxInjectProfileHeroSorsaBelowAvatar(img, scoreStr, rawScore);
        if (img.dataset.clipxSorsaDone === '1') return;
    }
    clipxApplySorsaAvatarOverlay(img, scoreStr, rawScore);
}


function clipxInjectSorsaPillBesideUserName(userNameDiv, scoreStr, rawScore) {
    if (!userNameDiv || userNameDiv.querySelector('.clipx-sorsa-pill-fallback')) return;
    ensureClipxSorsaVisualStyles();
    userNameDiv.dataset.clipxSorsaPill = '1';
    const pill = document.createElement('span');
    pill.className = 'clipx-sorsa-pill-fallback clipx-sorsa-pill';
    const num = document.createElement('span');
    num.className = 'clipx-sorsa-badge-num';
    num.textContent = scoreStr;
    pill.appendChild(num);
    pill.title = 'TweetScout score (Sorsa)';
    userNameDiv.appendChild(pill);
}

/** Largest twimg/profile image in header when link-based match fails (X layout / href quirks). */
function clipxFindProfileHeroAvatarImgHeuristic() {
    const header = document.querySelector('[data-testid="UserProfileHeader_Items"]');
    if (!header) return null;
    let best = null;
    header.querySelectorAll('img').forEach((img) => {
        if (img.closest('article[data-testid="tweet"]')) return;
        if (img.dataset.clipxSorsaDone === '1') return;
        const src = (img.currentSrc || img.src || img.getAttribute('src') || '').toLowerCase();
        if (
            !src.includes('twimg.com') &&
            !src.includes('profile_images') &&
            !src.includes('pbs.twimg.com')
        ) {
            return;
        }
        const w = img.getBoundingClientRect().width || img.offsetWidth || 0;
        if (w < 32) return;
        if (!best || w > best.w) best = { img, w };
    });
    return best ? best.img : null;
}

/** Largest profile hero avatar on /handle (used when UserProfileHeader is present; not batch). */
function clipxFindProfileHeroAvatarImg(h) {
    if (!h) return null;
    const hNorm = h.toLowerCase();
    if (CLIPX_RESERVED_HANDLES.has(hNorm)) return null;
    const scope =
        document.querySelector('[data-testid="UserProfileHeader_Items"]') ||
        document.querySelector('[data-testid="primaryColumn"]') ||
        document;
    let best = null;
    scope.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (href.includes('/status/')) return;
        if (clipxNormalizeProfileHref(href) !== hNorm) return;
        const img = a.querySelector('img');
        if (!img || img.dataset.clipxSorsaDone === '1') return;
        const r = img.getBoundingClientRect();
        const w = r.width || img.offsetWidth || img.naturalWidth || 0;
        if (w < 40) return;
        if (!best || w > best.w) best = { img, w };
    });
    if (best) return best.img;
    return clipxFindProfileHeroAvatarImgHeuristic();
}

/** Profile header image not inside a tweet — for no-<a> avatars. */
function clipxIsProfileHeroImage(img) {
    if (!img || img.closest('article[data-testid="tweet"]')) return false;
    if (!clipxProfileHandleFromPathname(window.location.pathname)) return false;
    const header = document.querySelector('[data-testid="UserProfileHeader_Items"]');
    return !!(header && header.contains(img));
}

/** Apply score badge to profile hero using the same score as the Intel card (no extra API call). */
function clipxInjectProfileHeroSorsaIfNeeded(handle, rawScore) {
    if (!handle) return;
    chrome.storage.local.get(['showSorsaScores'], (r) => {
        if (r.showSorsaScores === false) return;
        const st = ProfileScanner.state;
        if (st.sorsaTweetScoutHidden) return;
        if (!st.sorsaTweetScoutFetched && !st.sorsaTweetScoutScoreLoading) return;

        let scoreStr;
        if (rawScore != null && Number.isFinite(Number(rawScore))) {
            const f = clipxFormatSorsaScore(rawScore);
            scoreStr = f || '—';
        } else if (st.sorsaTweetScoutScoreLoading) {
            scoreStr = '…';
        } else {
            scoreStr = '—';
        }

        const tryInject = () => {
            const img = clipxFindProfileHeroAvatarImg(handle);
            if (!img) return false;
            clipxInjectSorsaBadgeOnAvatar(img, scoreStr, rawScore);
            return img.dataset.clipxSorsaDone === '1';
        };

        if (tryInject()) return;
        requestAnimationFrame(() => {
            if (tryInject()) return;
            setTimeout(() => {
                tryInject();
            }, 120);
            setTimeout(() => {
                tryInject();
            }, 450);
            setTimeout(() => {
                tryInject();
            }, 900);
            setTimeout(() => {
                tryInject();
            }, 2000);
            setTimeout(() => {
                tryInject();
            }, 3500);
        });
    });
}

function clipxCollectComposeAvatarTargets() {
    const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!ta) return [];
    let el = ta.parentElement;
    for (let d = 0; d < 16 && el; d++) {
        const imgs = el.querySelectorAll('img[src*="profile"], img[src*="twimg"]');
        for (const img of imgs) {
            if (img.dataset.clipxSorsaDone === '1') continue;
            const a = img.closest('a[href^="/"]');
            if (!a) continue;
            const href = (a.getAttribute('href') || '').split('?')[0];
            const h = clipxNormalizeProfileHref(href);
            if (!h) continue;
            const w = img.getBoundingClientRect().width;
            if (w >= 24 && w <= 80) {
                return [{ img, userNameDiv: null, handle: h, source: 'compose' }];
            }
        }
        el = el.parentElement;
    }
    return [];
}

function clipxCollectProfileHeroTargets() {
    /** Any profile route: /handle, /handle/media, /handle/with_replies, … (not /handle/status/…). */
    const pathHandle = clipxProfileHandleFromPathname(window.location.pathname);
    const h = pathHandle ? String(pathHandle).toLowerCase() : null;
    if (!h || CLIPX_RESERVED_HANDLES.has(h)) return [];
    const img = clipxFindProfileHeroAvatarImg(h);
    if (!img) return [];
    return [{ img, userNameDiv: null, handle: h, source: 'profile' }];
}

function clipxCollectAllSorsaTargets() {
    const pending = [];
    const seen = new Set();
    const seenImgs = new WeakSet();

    document.querySelectorAll('[data-testid="User-Name"], [data-testid="UserName"]').forEach((userNameDiv) => {
        const handle = clipxExtractHandleFromUserNameDiv(userNameDiv);
        if (!handle) return;
        if (userNameDiv.dataset.clipxSorsaNoScore === '1') return;
        if (userNameDiv.querySelector('.clipx-sorsa-pill-fallback')) return;
        const img = clipxFindAvatarImgForUserName(userNameDiv, handle);
        if (img) {
            clipxSorsaClearStaleDoneInListRow(img);
            if (img.dataset.clipxSorsaDone === '1' || seenImgs.has(img)) return;
            seenImgs.add(img);
        }
        const k = `n:${handle}:${img ? img.src : userNameDiv.textContent?.slice(0, 40)}`;
        if (seen.has(k)) return;
        seen.add(k);
        pending.push({ img: img || null, userNameDiv, handle, source: 'feed' });
    });

    document.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
        if (cell.closest('article[data-testid="tweet"]')) return;
        let userNameDiv = cell.querySelector('[data-testid="User-Name"], [data-testid="UserName"]');
        let handle = userNameDiv ? clipxExtractHandleFromUserNameDiv(userNameDiv) : null;
        if (!handle) handle = clipxExtractHandleFromUserCell(cell);
        if (!handle) return;
        if (userNameDiv) {
            if (userNameDiv.dataset.clipxSorsaNoScore === '1') return;
            if (userNameDiv.querySelector('.clipx-sorsa-pill-fallback')) return;
        }
        const img = userNameDiv
            ? clipxFindAvatarImgForUserName(userNameDiv, handle)
            : clipxFindAvatarImgInRoot(cell, handle);
        if (img) {
            clipxSorsaClearStaleDoneInListRow(img);
            if (img.dataset.clipxSorsaDone === '1' || seenImgs.has(img)) return;
            seenImgs.add(img);
        }
        const k = `uc:${handle}:${img ? img.src : cell.textContent?.slice(0, 24)}`;
        if (seen.has(k)) return;
        seen.add(k);
        pending.push({ img: img || null, userNameDiv: userNameDiv || null, handle, source: 'usercell' });
    });

    document.querySelectorAll('[data-testid="cellInnerDiv"]').forEach((cell) => {
        if (cell.closest('article[data-testid="tweet"]')) return;
        if (cell.querySelector('[data-testid="UserCell"]')) return;
        let userNameDiv = cell.querySelector('[data-testid="User-Name"], [data-testid="UserName"]');
        let handle = userNameDiv ? clipxExtractHandleFromUserNameDiv(userNameDiv) : null;
        if (!handle) handle = clipxExtractHandleFromUserCell(cell);
        if (!handle) return;
        if (userNameDiv) {
            if (userNameDiv.dataset.clipxSorsaNoScore === '1') return;
            if (userNameDiv.querySelector('.clipx-sorsa-pill-fallback')) return;
        }
        const img = userNameDiv
            ? clipxFindAvatarImgForUserName(userNameDiv, handle)
            : clipxFindAvatarImgInRoot(cell, handle);
        if (img) {
            clipxSorsaClearStaleDoneInListRow(img);
            if (img.dataset.clipxSorsaDone === '1' || seenImgs.has(img)) return;
            seenImgs.add(img);
        }
        const k = `cid:${handle}:${img ? img.src : cell.textContent?.slice(0, 24)}`;
        if (seen.has(k)) return;
        seen.add(k);
        pending.push({ img: img || null, userNameDiv: userNameDiv || null, handle, source: 'cellinner' });
    });

    clipxCollectComposeAvatarTargets().forEach((t) => {
        const k = `c:${t.handle}:${t.img.src}`;
        if (seen.has(k)) return;
        seen.add(k);
        pending.push(t);
    });

    clipxCollectProfileHeroTargets().forEach((t) => {
        const k = `p:${t.handle}:${t.img.src}`;
        if (seen.has(k)) return;
        seen.add(k);
        pending.push(t);
    });

    return pending;
}

/** X verified / org / gov badge near display name (cheap spam filter before Sorsa API). */
function clipxSorsaUserNameHasVerifiedBadge(userNameDiv) {
    if (!userNameDiv) return false;
    return !!userNameDiv.querySelector(
        'svg[aria-label*="Verified"], svg[aria-label*="verified"], [data-testid="icon-verified"]',
    );
}

/** Verified badge for the profile page header (hero batch has no userNameDiv on the target). */
function clipxSorsaProfileHeaderHasVerifiedBadge() {
    const un = document.querySelector('div[data-testid="UserName"]');
    return clipxSorsaUserNameHasVerifiedBadge(un);
}

/** Compose box: walk up from the textarea to find a UserName row (optional). */
function clipxSorsaComposeFindUserNameDiv() {
    const ta = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (!ta) return null;
    let el = ta.parentElement;
    for (let d = 0; d < 22 && el; d++) {
        const un = el.querySelector('[data-testid="User-Name"], [data-testid="UserName"]');
        if (un) return un;
        el = el.parentElement;
    }
    return null;
}

function clipxIsLikelyDefaultProfileAvatar(img) {
    if (!img || !img.src) return false;
    return /default_profile_images|default_profile_normal|default_profile_bigger/i.test(img.src);
}

/**
 * TweetScout (Sorsa) scores only when X shows a verified badge on that row/header.
 * Optional: skip default-avatar timeline rows (extra API savings).
 */
function clipxSorsaPassesCostFilter(p, opts) {
    const src = p.source || 'feed';
    if (src === 'profile') {
        return clipxSorsaProfileHeaderHasVerifiedBadge();
    }
    if (src === 'compose') {
        const un = clipxSorsaComposeFindUserNameDiv();
        if (!un) return false;
        return clipxSorsaUserNameHasVerifiedBadge(un);
    }
    if (opts.skipDefaultAvatar && clipxIsLikelyDefaultProfileAvatar(p.img)) return false;

    const timeline = ['feed', 'usercell', 'cellinner'].includes(src);
    if (timeline && !clipxSorsaUserNameHasVerifiedBadge(p.userNameDiv)) return false;
    return true;
}

function clipxSorsaMarkSkippedCostFilter(p) {
    if (p.img) p.img.dataset.clipxSorsaDone = '1';
    if (p.userNameDiv) p.userNameDiv.dataset.clipxSorsaNoScore = '1';
}

/**
 * Timeline / lists / compose: show Sorsa pills only from client cache (populated on profile visits).
 * No `getSorsaScoresBatch` — Sorsa HTTP only runs in `getSorsaProfileScore` when you open a profile.
 */
function injectClipxSorsaScoresOnPage() {
    chrome.storage.local.get(['showSorsaScores', 'sorsaSkipDefaultAvatarTimeline', CLIPX_SORSA_SCORE_CACHE_KEY], (r) => {
        if (r.showSorsaScores === false) return;

        const pending = clipxCollectAllSorsaTargets();
        if (pending.length === 0) return;

        const costOpts = {
            skipDefaultAvatar: r.sorsaSkipDefaultAvatarTimeline !== false,
        };

        const scores = r[CLIPX_SORSA_SCORE_CACHE_KEY] || {};

        for (const p of pending) {
            if (!clipxSorsaPassesCostFilter(p, costOpts)) {
                clipxSorsaMarkSkippedCostFilter(p);
                continue;
            }
            const hl = String(p.handle || '').toLowerCase();
            if (!hl || !Object.prototype.hasOwnProperty.call(scores, hl)) {
                continue;
            }
            const raw = scores[hl];
            if (raw == null || !Number.isFinite(Number(raw))) {
                continue;
            }
            const formatted = clipxFormatSorsaScore(raw);
            if (!formatted) {
                continue;
            }
            if (p.img) {
                clipxInjectSorsaBadgeOnAvatar(p.img, formatted, raw);
            } else if (p.userNameDiv) {
                clipxInjectSorsaPillBesideUserName(p.userNameDiv, formatted, raw);
            }
        }
    });
}

// ============================================================

/** In-flight ticker lookups via background (CoinGecko list + cache; dedupe per symbol). */
window.clipxTickerResolveInFlight = window.clipxTickerResolveInFlight || new Map();
window.clipxRejectedTickers = window.clipxRejectedTickers || new Set();

/**
 * xStocks (tokenized US equities on BNB Chain). When a $TICKER
 * matches, we treat it as crypto-tradable rather than blocking it as a stock.
 * Mirror of the backend's allowlist in server/routes/xstocks-routes.ts.
 */
const CLIPX_XSTOCKS_TICKERS = new Set([
    'ABT', 'ABBV', 'ACN', 'ADBE', 'GOOGL', 'AMZN', 'AMBR', 'AMD', 'AAPL',
    'APLD', 'AMAT', 'APP', 'ANET', 'ASML', 'ASTS', 'AZN', 'BAC', 'BRK.B',
    'BTBT', 'BTGO', 'BMNR', 'AVGO', 'CVX', 'CRCL', 'CSCO', 'CLSK', 'KO',
    'COIN', 'CMCSA', 'CEG', 'CORZ', 'CRWD', 'DHR', 'DELL', 'DFDV', 'ETN',
    'LLY', 'UUUU', 'XOM', 'VCX', 'GLXY', 'GME', 'GEV', 'GS', 'HD', 'HON',
    'HUT', 'INTC', 'IBM', 'JNJ', 'JPM', 'KLAC', 'KRAQ', 'LRCX', 'LIN',
    'LITE', 'MARA', 'MRVL', 'MA', 'MCD', 'MDT', 'MRK', 'META', 'MU',
    'MSFT', 'MSTR', 'NFLX', 'NVO', 'SMR', 'NVDA', 'OKLO', 'OPEN', 'ORCL',
    'PLTR', 'PANW', 'PYPL', 'PEP', 'PFE', 'PM', 'PL', 'PG', 'PWR', 'RIOT',
    'HOOD', 'RBLX', 'CRM', 'SNDK', 'SBET', 'SMCI', 'TMUS', 'TER', 'WULF',
    'TSLA', 'TMO', 'TONX', 'TSM', 'UBER', 'UNH', 'USAR', 'VRT', 'SPCE',
    'V', 'WMT', 'WBD', 'STRC',
    'PALL', 'PPLT', 'IEMG', 'XLE', 'FGDL', 'COPX', 'URA', 'GLD', 'SGOV',
    'SLV', 'ITA', 'QQQ', 'IWM', 'IJR', 'SPY', 'XOP', 'TBLL', 'TQQQ',
    'MOO', 'SMH', 'VGK', 'VUG', 'VXUS', 'VT', 'VTI', 'SCHF'
]);

/**
 * Dynamic xStocks catalog populated from chrome.storage.local (filled by the
 * background script's hourly Jupiter sync). Merged with the static seed so we
 * pick up new Backed Finance listings without an extension update.
 */
window.clipxDynamicXStocks = window.clipxDynamicXStocks || new Set();

function clipxIsXStockTicker(ticker) {
    const t = String(ticker || '').toUpperCase();
    return CLIPX_XSTOCKS_TICKERS.has(t) || window.clipxDynamicXStocks.has(t);
}

function clipxLoadDynamicXStocksFromStorage() {
    try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.get('xStocksCatalog', (stored) => {
            if (chrome.runtime.lastError) return;
            const cat = stored && stored.xStocksCatalog;
            if (!cat || !Array.isArray(cat.tickers)) return;
            window.clipxDynamicXStocks = new Set(cat.tickers.map((t) => String(t).toUpperCase()));
        });
    } catch (e) {
        // ignore — we'll just fall back to the static seed
    }
}

clipxLoadDynamicXStocksFromStorage();

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.xStocksCatalog) return;
        const next = changes.xStocksCatalog.newValue;
        if (next && Array.isArray(next.tickers)) {
            window.clipxDynamicXStocks = new Set(next.tickers.map((t) => String(t).toUpperCase()));
            // Re-evaluate any rejections that may have been added before the
            // catalog arrived (so newly-supported xStocks appear without reload).
            if (window.clipxRejectedTickers) {
                for (const t of [...window.clipxRejectedTickers]) {
                    if (window.clipxDynamicXStocks.has(t)) {
                        window.clipxRejectedTickers.delete(t);
                    }
                }
            }
        }
    });
}

/**
 * Hard-coded blocklist of US stocks / ETFs / common non-crypto tickers.
 * X cashtags use $TICKER for both stocks and crypto; without filtering, $GOOGL,
 * $NVDA, etc. were resolving to unrelated low-cap memecoins on BSC/Solana.
 *
 * Note: xStocks tickers (CLIPX_XSTOCKS_TICKERS) are NOT blocked even though many
 * appear here historically — the xStocks check below short-circuits.
 */
const CLIPX_NON_CRYPTO_BLOCKLIST = new Set([
    // Mega-cap US equities
    'AAPL', 'MSFT', 'GOOG', 'GOOGL', 'AMZN', 'META', 'TSLA', 'NVDA', 'NFLX', 'ORCL', 'CRM', 'ADBE',
    'CSCO', 'INTC', 'AMD', 'QCOM', 'MU', 'AVGO', 'ASML', 'TSM', 'IBM', 'TXN', 'ANET', 'NOW',
    // Financials
    'BRK', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'AXP', 'BLK', 'SCHW', 'V', 'MA',
    // Consumer / retail / healthcare / industrials
    'WMT', 'TGT', 'COST', 'HD', 'LOW', 'NKE', 'SBUX', 'MCD', 'KO', 'PEP', 'PG', 'JNJ', 'UNH', 'PFE',
    'MRK', 'LLY', 'ABBV', 'TMO', 'ABT', 'DIS', 'CMCSA', 'T', 'VZ', 'XOM', 'CVX', 'BA', 'CAT', 'GE',
    'F', 'GM', 'UBER', 'LYFT', 'ABNB', 'DASH',
    // China ADRs
    'BABA', 'JD', 'PDD', 'BIDU', 'NIO', 'XPEV', 'LI', 'BILI', 'TME',
    // Crypto-adjacent equities (NOT crypto tokens themselves)
    'COIN', 'HOOD', 'MSTR', 'RIOT', 'MARA', 'CLSK', 'WULF', 'BITF', 'HUT', 'CIFR',
    // SaaS / cloud / new tech equities
    'PLTR', 'SNOW', 'SHOP', 'SQ', 'PYPL', 'RBLX', 'ZM', 'DOCU', 'TWLO', 'OKTA', 'CRWD',
    'PANW', 'NET', 'DDOG', 'MDB', 'ZS', 'TEAM', 'WDAY', 'INTU', 'ADP', 'LRCX', 'KLAC', 'AMAT',
    // Meme stocks
    'GME', 'AMC', 'BB', 'NOK', 'BBBY', 'CHWY', 'WISH',
    // ETFs / indices / leveraged products
    'SPY', 'QQQ', 'VOO', 'VTI', 'IWM', 'DIA', 'GLD', 'SLV', 'TLT', 'HYG', 'LQD', 'XLK', 'XLF', 'XLE',
    'XLV', 'XLY', 'XLP', 'XLU', 'XLI', 'XLB', 'XLRE', 'XLC', 'TQQQ', 'SQQQ', 'SOXL', 'SOXS', 'TNA',
    'TZA', 'UVXY', 'VIX', 'VXX', 'UPRO', 'SPXU',
    // Currencies / commodities (ambiguous with crypto symbols)
    'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'INR', 'KRW', 'TRY', 'BRL',
    // Non-crypto common words people preface with $
    'CASH', 'HOME', 'AUTO', 'WORK', 'SHOP'
]);

function clipxIsBlocklistedNonCryptoTicker(ticker) {
    const t = String(ticker || '').toUpperCase();
    // Tokenized stocks (xStocks/Ondo on BNB Chain) override the blocklist.
    if (clipxIsXStockTicker(t)) return false;
    return CLIPX_NON_CRYPTO_BLOCKLIST.has(t);
}

function clipxResolveTickerViaDexScreener(symbol) {
    const sym = (symbol || '').toUpperCase();
    if (sym === 'SOL') {
        clipxEnsureNativeSolTokenMap();
        return Promise.resolve();
    }
    if (!sym) return Promise.resolve();
    const existingToken = window.clipxTokenMap[sym];
    if (existingToken) {
        const staleXStock =
            existingToken.isXStock &&
            (existingToken.chain !== 'bnb' || existingToken.issuer !== 'backed' || /on$/i.test(String(existingToken.displaySymbol || existingToken.symbol || '')));
        if (staleXStock) delete window.clipxTokenMap[sym];
        else return Promise.resolve();
    }
    if (window.clipxRejectedTickers.has(sym)) {
        if (clipxIsXStockTicker(sym)) window.clipxRejectedTickers.delete(sym);
        else return Promise.resolve();
    }
    if (clipxIsBlocklistedNonCryptoTicker(sym)) {
        window.clipxRejectedTickers.add(sym);
        return Promise.resolve();
    }
    if (window.clipxTickerResolveInFlight.has(sym)) {
        return window.clipxTickerResolveInFlight.get(sym);
    }
    const p = new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'resolveTickerDexScreener', symbol: sym }, (r) => {
            if (chrome.runtime.lastError) {
                resolve();
                return;
            }
            if (r && r.success && r.address) {
                window.clipxTokenMap[sym] = {
                    address: r.address,
                    chain: r.chain || 'bnb',
                    decimals: r.decimals != null ? r.decimals : (r.chain === 'sol' ? 9 : 18),
                    name: r.name || sym,
                    logoURI: r.logoURI || '',
                    isVerified: r.isVerified === true,
                    isXStock: r.isXStock === true,
                    issuer: r.issuer || null,
                    venue: r.venue || null,
                    deployments: Array.isArray(r.deployments) ? r.deployments : null,
                    baseSymbol: r.baseSymbol || null,
                    displaySymbol: r.symbol || sym,
                    priceUsd: r.priceUsd != null ? r.priceUsd : null,
                    priceChange: typeof r.priceChange === 'number' ? r.priceChange : null,
                    marketCapUsd: r.marketCapUsd != null ? r.marketCapUsd : null,
                    liquidityUsd: r.liquidityUsd != null ? r.liquidityUsd : null,
                    pairCreatedAt: r.pairCreatedAt || null,
                    source: r.source || 'coingecko'
                };
            } else if (r && r.notCrypto) {
                window.clipxRejectedTickers.add(sym);
            } else if (r && r.xStockPending) {
                // Backend isn't ready yet — leave it un-rejected so we retry on
                // the next pass (the cache TTL on the background side is short).
            }
            resolve();
        });
    }).finally(() => {
        window.clipxTickerResolveInFlight.delete(sym);
    });
    window.clipxTickerResolveInFlight.set(sym, p);
    return p;
}

function clipxTextNodeIsInClipxNode(node) {
    const parent = node && node.parentElement;
    return !!(parent && parent.closest('.clipx-cashtag-pill-row, .clipx-token-pill-wrap, .clipx-token-pill-main'));
}

function clipxCollectCashtagsFromTweetText(tweetTextDiv) {
    const out = [];
    const seen = new Set();
    const regex = /(^|[^\w$])\$([a-zA-Z][a-zA-Z0-9]{1,14})\b/g;
    const walker = document.createTreeWalker(tweetTextDiv, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
        if (clipxTextNodeIsInClipxNode(node)) continue;
        const text = node.nodeValue;
        regex.lastIndex = 0;
        let m;
        while ((m = regex.exec(text)) !== null) {
            const ticker = m[2].toUpperCase();
            if (seen.has(ticker)) continue;
            if (clipxIsBlocklistedNonCryptoTicker(ticker)) continue;
            seen.add(ticker);
            out.push(ticker);
        }
    }
    return out;
}

function clipxCollectUnknownTickersFromTweetText(tweetTextDiv) {
    const need = new Set();
    for (const t of clipxCollectCashtagsFromTweetText(tweetTextDiv)) {
        if (!window.clipxTokenMap[t]) need.add(t);
    }
    return [...need];
}

function clipxResolveUnknownTickersForTweetText(tweetTextDiv) {
    const unknown = clipxCollectUnknownTickersFromTweetText(tweetTextDiv);
    if (unknown.length === 0) return Promise.resolve();
    return Promise.all(unknown.map((t) => clipxResolveTickerViaDexScreener(t)));
}

function clipxIsValidBase58Address(s) {
    if (s.length < 32 || s.length > 44) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function clipxCollectTokenDetectionsFromTweetText(tweetTextDiv) {
    const detections = [];
    const seen = new Set();
    const walker = document.createTreeWalker(tweetTextDiv, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
        if (clipxTextNodeIsInClipxNode(node)) continue;
        const text = node.nodeValue || '';
        const nodeMatches = [];

        const evmRegex = /0x[a-fA-F0-9]{40}/g;
        let match;
        while ((match = evmRegex.exec(text)) !== null) {
            nodeMatches.push({ index: match.index, type: 'address', address: match[0], chain: 'bnb' });
        }

        const solRegex = /(^|[\s,;:!?({\[])([1-9A-HJ-NP-Za-km-z]{32,44})(?=[\s,;:!?)}\]<]|$)/g;
        while ((match = solRegex.exec(text)) !== null) {
            const address = match[2];
            if (clipxIsValidBase58Address(address)) {
                nodeMatches.push({ index: match.index + match[1].length, type: 'address', address, chain: 'sol' });
            }
        }

        const cashtagRegex = /(^|[^\w$])\$([a-zA-Z][a-zA-Z0-9]{1,14})\b/g;
        while ((match = cashtagRegex.exec(text)) !== null) {
            const ticker = match[2].toUpperCase();
            if (clipxIsBlocklistedNonCryptoTicker(ticker)) continue;
            nodeMatches.push({ index: match.index + match[1].length, type: 'cashtag', ticker });
        }

        nodeMatches.sort((a, b) => a.index - b.index);
        for (const item of nodeMatches) {
            const key = item.type === 'cashtag'
                ? `ticker:${item.ticker}`
                : `address:${item.chain}:${String(item.address).toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            detections.push(item);
        }
    }
    return detections.slice(0, 8);
}

function clipxFindCashtagPillRow(tweetTextDiv) {
    return Array.from(tweetTextDiv.children || []).find((child) => child.classList && child.classList.contains('clipx-cashtag-pill-row')) || null;
}

function clipxCreatePillForDetection(detection, username) {
    if (detection.type === 'address') {
        return createBuyButton(username, detection.address, null, false, detection.chain || 'bnb');
    }

    const ticker = detection.ticker;
    if (ticker === 'SOL') clipxEnsureNativeSolTokenMap();
    if (clipxIsBlocklistedNonCryptoTicker(ticker)) return null;
    if (window.clipxRejectedTickers && window.clipxRejectedTickers.has(ticker)) {
        if (clipxIsXStockTicker(ticker)) window.clipxRejectedTickers.delete(ticker);
        else return null;
    }

    const token = window.clipxTokenMap && window.clipxTokenMap[ticker];
    if (token && token.address) {
        // Stock/xStock cashtags are BNB Chain Backed xStocks only. Drop stale
        // Solana or Ondo entries from older builds so the background resolver
        // can fetch the official xStocks API deployment instead.
        const staleXStock =
            token.isXStock &&
            (token.chain !== 'bnb' || token.issuer !== 'backed' || /on$/i.test(String(token.displaySymbol || token.symbol || '')));
        if (staleXStock) {
            delete window.clipxTokenMap[ticker];
            return createCashtagLookupPill(ticker, username);
        }
        return createBuyButton(
            username,
            token.address,
            ticker,
            token.isVerified || false,
            token.chain || 'bnb',
            {
                isXStock: !!token.isXStock,
                issuer: token.issuer || null,
                venue: token.venue || null,
                displaySymbol: token.displaySymbol || null,
                deployments: token.deployments || null,
                priceUsd: token.priceUsd != null ? token.priceUsd : null,
                priceChange: typeof token.priceChange === 'number' ? token.priceChange : null,
                marketCapUsd: token.marketCapUsd != null ? token.marketCapUsd : null,
                liquidityUsd: token.liquidityUsd != null ? token.liquidityUsd : null,
                pairCreatedAt: token.pairCreatedAt || null,
                logoURI: token.logoURI || null,
                source: token.source || null
            }
        );
    }
    return createCashtagLookupPill(ticker, username);
}

function clipxRenderCashtagPillRow(tweetTextDiv, username) {
    ensureClipxTokenPillStyles();
    const detections = clipxCollectTokenDetectionsFromTweetText(tweetTextDiv);
    const existing = clipxFindCashtagPillRow(tweetTextDiv);
    if (!detections.length) {
        if (existing) existing.remove();
        return;
    }

    const row = existing || document.createElement('span');
    row.className = 'clipx-cashtag-pill-row';
    row.dataset.clipxCashtagRow = '1';
    clipxApplyTokenPillStyleToElement(row);
    row.innerHTML = '';

    detections.forEach((detection) => {
        const pill = clipxCreatePillForDetection(detection, username);
        if (pill) row.appendChild(pill);
    });

    if (row.children.length === 0) {
        if (existing) existing.remove();
        return;
    }

    if (!existing) {
        tweetTextDiv.insertBefore(row, tweetTextDiv.firstChild);
    }
}

function clipxChainUrls(chain, address) {
    const isSol = chain === 'sol';
    const dexChain = isSol ? 'solana' : 'bsc';
    const gmgnChain = isSol ? 'sol' : 'bsc';
    return {
        dex: `https://dexscreener.com/${dexChain}/${address}`,
        dexEmbed: `https://dexscreener.com/${dexChain}/${address}?embed=1&theme=dark`,
        gmgn: `https://gmgn.ai/${gmgnChain}/token/${address}`,
        gmgnAddress: (addr) => `https://gmgn.ai/${gmgnChain}/address/${addr}`,
        gmgnSwap: `https://gmgn.ai/swap?theme=light&chain=${gmgnChain}&token_in=${isSol ? 'SOL' : 'BNB'}&token_out=${address}`,
        gmgnKline: `https://www.gmgn.cc/kline/${gmgnChain}/${address}?theme=dark`,
        bubble: `https://app.bubblemaps.io/${gmgnChain}/token/${address}`,
        explorer: isSol ? `https://solscan.io/token/${address}` : `https://bscscan.com/token/${address}`,
        explorerTx: (hash) => isSol ? `https://solscan.io/tx/${hash}` : `https://bscscan.com/tx/${hash}`,
        binanceToken: isSol ? null : `https://web3.binance.com/en/token/bsc/${address}`,
        nativeSymbol: isSol ? 'SOL' : 'BNB',
    };
}

function createCashtagLookupPill(ticker, username) {
    ensureClipxTokenPillStyles();
    const container = document.createElement('span');
    container.style.cssText = 'display:inline;vertical-align:baseline;margin:0 0.12em;';

    const isXStock = clipxIsXStockTicker(ticker);
    const pill = document.createElement('span');
    pill.className = isXStock
        ? 'clipx-token-pill-main clipx-token-pill-main--xstock'
        : 'clipx-token-pill-main';
    clipxApplyTokenPillStyleToElement(pill);
    pill.dataset.clipxTicker = ticker;
    pill.dataset.clipxUsername = username || '';
    if (isXStock) pill.dataset.clipxIsXstock = '1';
    if (isXStock) {
        pill.style.setProperty('--clipx-pill-bg', '#0EA5E9');
        pill.style.setProperty('--clipx-pill-fg', '#FFFFFF');
    } else {
        pill.style.setProperty('--clipx-pill-bg', '#475569');
        pill.style.setProperty('--clipx-pill-fg', '#F8FAFC');
    }
    pill.style.cursor = 'pointer';
    const lookupBadge = isXStock
        ? '<span class="clipx-pill-chain-badge">xSTOCK</span>'
        : '';
    pill.innerHTML = `<span class="clipx-ticker">$${ticker}</span><span class="clipx-pill-price" data-empty="1"></span><span class="clipx-pill-change" data-empty="1"></span>${lookupBadge}`;
    pill.title = isXStock
        ? `Tokenized stock ($${ticker}x on BNB Chain, by Backed Finance) — click to trade via PancakeSwap`
        : `Click to look up $${ticker} price & details`;

    pill.addEventListener('click', (e) => {
        clipxHandleCashtagLookupPillClick(pill, e);
    }, true);

    container.appendChild(pill);

    return container;
}

function clipxStopOwnClick(e) {
    if (!e) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
}

function clipxOpenTipBadgeModal(badge, e) {
    if (!badge) return false;
    clipxStopOwnClick(e);
    const username = badge.dataset.username;
    if (!username) return true;
    const now = Date.now();
    if (badge._clipxTipOpeningAt && now - badge._clipxTipOpeningAt < 900) return true;
    badge._clipxTipOpeningAt = now;
    console.log('[ClipX] Opening modal for:', username);
    Promise.resolve(createModal(username, 'tip', '', badge))
        .catch((err) => {
            console.error('[ClipX] createModal error:', err);
            const overlay = document.getElementById('clipx-modal-overlay');
            const modal = overlay && overlay.querySelector('.clipx-modal');
            if (modal) {
                modal.innerHTML = `
                    <div class="clipx-modal-accent" aria-hidden="true"></div>
                    <div class="clipx-body" style="padding:16px;">
                        <div style="font-size:13px;font-weight:700;color:#fff;margin-bottom:6px;">Tip panel failed to load</div>
                        <div style="font-size:11px;color:#a1a1aa;">${err && err.message ? err.message : 'Unknown error'}</div>
                    </div>
                `;
            }
        })
        .finally(() => {
            setTimeout(() => { badge._clipxTipOpeningAt = 0; }, 900);
        });
    return true;
}

function clipxOpenTokenPillModal(pill, e) {
    if (!pill) return false;
    const ticker = pill.dataset.clipxTicker;
    if (ticker && !pill.dataset.clipxAddress) {
        return clipxHandleCashtagLookupPillClick(pill, e);
    }

    const wrap = pill.closest('.clipx-token-pill-wrap');
    const address = pill.dataset.clipxAddress || (wrap && wrap.dataset.clipxAddress);
    if (!address) return false;

    clipxStopOwnClick(e);
    const symbol = pill.dataset.clipxSymbol || null;
    const chain = pill.dataset.clipxChain || (wrap && wrap.dataset.chain) || 'bnb';
    const cachedInfo = (wrap && wrap._clipxTokenInfoCache) || {};

    try {
        showTradeModal(address, symbol, chain, cachedInfo, pill);
    } catch (err) {
        console.error('[ClipX] showTradeModal error:', err);
    }
    return true;
}

function clipxHandleCashtagLookupPillClick(pill, e) {
    if (!pill) return false;
    clipxStopOwnClick(e);
    if (pill.dataset.clipxLookingUp === '1') return true;

    const ticker = (pill.dataset.clipxTicker || '').toUpperCase();
    const username = pill.dataset.clipxUsername || '';
    if (!ticker) return true;

    pill.dataset.clipxLookingUp = '1';
    pill.innerHTML = `<span class="clipx-ticker">$${ticker} …</span>`;
    pill.style.opacity = '0.7';

    chrome.runtime.sendMessage({ action: 'resolveTickerDexScreener', symbol: ticker }, (r) => {
        pill.dataset.clipxLookingUp = '0';
        if (r && r.success && r.address) {
            const chain = r.chain || 'bnb';
            window.clipxTokenMap[ticker] = {
                address: r.address,
                chain,
                decimals: r.decimals != null ? r.decimals : (chain === 'sol' ? 9 : 18),
                name: r.name || ticker,
                logoURI: r.logoURI || '',
                isVerified: r.isVerified === true,
                isXStock: r.isXStock === true,
                issuer: r.issuer || null,
                venue: r.venue || null,
                deployments: Array.isArray(r.deployments) ? r.deployments : null,
                displaySymbol: r.symbol || ticker,
                priceUsd: r.priceUsd != null ? r.priceUsd : null,
                priceChange: typeof r.priceChange === 'number' ? r.priceChange : null,
                marketCapUsd: r.marketCapUsd != null ? r.marketCapUsd : null,
                liquidityUsd: r.liquidityUsd != null ? r.liquidityUsd : null,
                pairCreatedAt: r.pairCreatedAt || null,
                source: r.source || 'dexscreener'
            };

            const btn = createBuyButton(username, r.address, ticker, r.isVerified === true, chain, {
                isXStock: r.isXStock === true,
                issuer: r.issuer || null,
                venue: r.venue || null,
                displaySymbol: r.symbol || ticker,
                deployments: Array.isArray(r.deployments) ? r.deployments : null,
                priceUsd: r.priceUsd != null ? r.priceUsd : null,
                priceChange: typeof r.priceChange === 'number' ? r.priceChange : null,
                marketCapUsd: r.marketCapUsd != null ? r.marketCapUsd : null,
                liquidityUsd: r.liquidityUsd != null ? r.liquidityUsd : null,
                pairCreatedAt: r.pairCreatedAt || null,
                logoURI: r.logoURI || null,
                source: r.source || 'ticker'
            });
            const container = pill.parentElement;
            if (container) container.replaceChild(btn, pill);
            const anchor = btn.querySelector('.clipx-token-pill-main') || btn;

            showTradeModal(r.address, ticker, chain, {
                success: true,
                chain,
                symbol: r.symbol || ticker,
                name: r.name || ticker,
                priceUsd: r.priceUsd != null ? String(r.priceUsd) : null,
                priceChange: typeof r.priceChange === 'number' ? r.priceChange : 0,
                marketCapUsd: r.marketCapUsd || null,
                pairCreatedAt: r.pairCreatedAt || null,
                liquidityUsd: r.liquidityUsd || null,
                iconUrl: r.logoURI || null,
                source: r.source || 'ticker'
            }, anchor);
        } else {
            pill.style.opacity = '1';
            pill.style.setProperty('--clipx-pill-bg', '#334155');
            pill.style.setProperty('--clipx-pill-fg', '#F8FAFC');
            pill.innerHTML = `<span class="clipx-ticker">$${ticker} — not found</span>`;
            pill.title = `$${ticker} not found on BSC or Solana`;
            pill.style.cursor = 'default';
        }
    });
    return true;
}

function clipxInstallGlobalClickCatcher() {
    if (window.__clipxGlobalClickCatcherInstalled) return;
    window.__clipxGlobalClickCatcherInstalled = true;

    const handler = (e) => {
        const target = e.target && e.target.nodeType === Node.ELEMENT_NODE ? e.target : null;
        if (!target) return;

        const tipBadge = target.closest('.clipx-tip-badge');
        if (tipBadge) {
            if (Date.now() - (window.__clipxLastModalTriggerAt || 0) < 650) {
                clipxStopOwnClick(e);
                return;
            }
            const handled = clipxOpenTipBadgeModal(tipBadge, e);
            if (handled) window.__clipxLastModalTriggerAt = Date.now();
            return;
        }

        const pill = target.closest('.clipx-token-pill-main');
        if (pill) {
            if (Date.now() - (window.__clipxLastModalTriggerAt || 0) < 650) {
                clipxStopOwnClick(e);
                return;
            }
            const handled = clipxOpenTokenPillModal(pill, e);
            if (handled) window.__clipxLastModalTriggerAt = Date.now();
        }
    };

    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('mousedown', handler, true);
    window.addEventListener('touchstart', handler, true);
    window.addEventListener('click', handler, true);
}

clipxInstallGlobalClickCatcher();

function clipxInjectTokenPillsInTweetText(tweetTextDiv, username) {
    clipxRenderCashtagPillRow(tweetTextDiv, username);
}

// Add buttons to timeline
function addTipButtons() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    articles.forEach((article) => {
        if (article.hasAttribute('data-clipx-processed')) return;
        if (article.hasAttribute('data-clipx-processing')) return;

        try { ProfileScanner.scanTweet(article); } catch (e) { /* ignore */ }

        const userNameDiv = article.querySelector('div[data-testid="User-Name"]');
        if (!userNameDiv) {
            article.setAttribute('data-clipx-processed', 'true');
            return;
        }

        const links = userNameDiv.querySelectorAll('a[href^="/"]');
        let username = null;

        for (const link of links) {
            const href = link.getAttribute('href');
            const match = href.match(/^\/([a-zA-Z0-9_]+)$/);
            if (match && match[1]) {
                username = match[1];
                break;
            }
        }

        if (!username) {
            article.setAttribute('data-clipx-processed', 'true');
            return;
        }

        article.setAttribute('data-clipx-processing', '1');

        const finishArticle = () => {
            article.removeAttribute('data-clipx-processing');
            article.setAttribute('data-clipx-processed', 'true');
        };

        const tweetTextDiv = article.querySelector('div[data-testid="tweetText"]');

        const runTips = () => {
            chrome.storage.local.get(['showTipsButtons'], (result) => {
                const showTipsButtons = result.showTipsButtons !== false;
                if (showTipsButtons && !userNameDiv.querySelector('.clipx-tip-badge')) {
                    const btn = createTipButton(username);
                    userNameDiv.appendChild(btn);
                    clipxReinforcePostViewUserNameRow(userNameDiv);
                    console.log('[ClipX] Added tip button for:', username);
                }
            });
        };

        const runTweetInjectAndFinish = () => {
            if (tweetTextDiv && !tweetTextDiv.dataset.clipxScanned) {
                tweetTextDiv.dataset.clipxScanned = 'true';
                clipxInjectTokenPillsInTweetText(tweetTextDiv, username);
            }
            runTips();
            finishArticle();
        };

        if (tweetTextDiv && !tweetTextDiv.dataset.clipxScanned) {
            (async () => {
                try {
                    await clipxResolveUnknownTickersForTweetText(tweetTextDiv);
                } catch (e) {
                    console.warn('[ClipX] CoinGecko ticker resolve:', e);
                }
                runTweetInjectAndFinish();
            })();
        } else {
            runTweetInjectAndFinish();
        }
    });

    try {
        ProfileScanner.init();
    } catch (e) {
        console.warn('[ClipX] ProfileScanner init failed:', e);
    }
}



// Setup observer
const observer = new MutationObserver(() => {
    if (window.clipxTimer) clearTimeout(window.clipxTimer);
    window.clipxTimer = setTimeout(() => {
        try {
            clipxSyncPostPageContextAttribute();
        } catch (e) { /* ignore */ }
        try {
            clipxSyncXAppearanceAttribute();
        } catch (e) { /* ignore */ }
        addTipButtons();
        // Inject analyze buttons for Intel feature
        try { injectAnalyzeButtons(); } catch (e) { console.error('[ClipX] injectAnalyzeButtons error:', e); }
        // Inject labels on user list pages (followers, following, connect, sidebar, etc.)
        injectUserListLabels().catch(e => console.error('[ClipX] injectUserListLabels error:', e));
        // Inject labels on Who to follow / Relevant people sidebar sections
        injectWhoToFollowLabels().catch(e => console.error('[ClipX] injectWhoToFollowLabels error:', e));
        // Also scan for feed labels (tweets, including quoted post authors)
        ProfileScanner.injectFeedLabels().catch(() => { });

        // Sorsa v3 scores on circular avatars (timeline + inline feed / user cells)
        try { injectClipxSorsaScoresOnPage(); } catch (e) { console.error('[ClipX] injectClipxSorsaScoresOnPage error:', e); }

        // Surf 7d sentiment on timeline, lists, sidebar user rows (batched)
        try { injectClipxSurfSentimentOnPage(); } catch (e) { console.error('[ClipX] injectClipxSurfSentimentOnPage error:', e); }

        try { injectCrossPostButtons(); } catch (e) { console.error('[ClipX] injectCrossPostButtons error:', e); }

    }, 100);
});

// -------------------------------------------
// CROSS-POST TO BINANCE SQUARE (restored from v1.18.x — API-only via clipx.app)
// -------------------------------------------
function injectCrossPostButtons() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    articles.forEach((article) => {
        if (article.dataset.clipxCrossPost) return;

        const actionBar = clipxFindTweetActionBar(article) || article.querySelector('div[role="group"]');
        if (!actionBar) return;

        const btn = document.createElement('div');
        btn.className = 'clipx-crosspost-btn';
        btn.style.cssText = 'display:flex; align-items:center; justify-content:center; cursor:pointer; margin-left:12px; transition:0.2s;';

        const tweetLink = article.querySelector('a[href*="/status/"]');
        const thisTweetUrl = tweetLink ? tweetLink.href.split('?')[0] : null;

        btn.title = 'Share to Binance Square';
        const _bsIcon = chrome.runtime.getURL('public/bs.png');
        btn.innerHTML = `
            <div style="width:20px; height:20px; border-radius:50%; background:#181A20; display:flex; align-items:center; justify-content:center; border:1.5px solid #F0B90B;">
                <img src="${_bsIcon}" width="13" height="13" style="display:block;" alt="" />
            </div>
        `;

        if (thisTweetUrl) {
            chrome.storage.local.get(['crossPostHistory'], (histResult) => {
                const history = histResult.crossPostHistory || [];
                const norm = (u) => (u || '').split('?')[0];
                const alreadyPosted = history.find((h) => norm(h.tweetUrl) === norm(thisTweetUrl));
                if (alreadyPosted) {
                    btn.innerHTML = `
                        <div style="width:18px; height:18px; border-radius:50%; background:#22c55e; display:flex; align-items:center; justify-content:center;">
                            <span style="font-size:10px; font-weight:bold; color:#fff;">✓</span>
                        </div>
                    `;
                    btn.title = 'Already shared to Binance Square (click to share again)';
                }
            });
        }

        btn.onmouseenter = () => { btn.style.opacity = '0.8'; };
        btn.onmouseleave = () => { btn.style.opacity = '1'; };

        btn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();

            const textDiv = article.querySelector('div[data-testid="tweetText"]');

            function extractTextWithEmojis(element) {
                if (!element) return '';
                let result = '';
                element.childNodes.forEach((node) => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        result += node.textContent;
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.tagName === 'IMG' && node.alt) {
                            result += node.alt;
                        } else if (node.tagName === 'BR') {
                            result += '\n';
                        } else if (node.tagName === 'A') {
                            const href = node.getAttribute('href') || '';
                            if (href.startsWith('/') ||
                                href.includes('twitter.com') ||
                                href.includes('x.com')) {
                                result += extractTextWithEmojis(node);
                            }
                        } else {
                            result += extractTextWithEmojis(node);
                        }
                    }
                });
                return result;
            }

            let text = extractTextWithEmojis(textDiv);

            text = text
                .replace(/https?:\/\/(?!twitter\.com|x\.com|t\.co)\S+/gi, '')
                .replace(/\bt\.co\/\S+/gi, '')
                .replace(/\bpic\.twitter\.com\/\S+/gi, '')
                .replace(/[ \t]+$/gm, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            const imgDivs = article.querySelectorAll('div[data-testid="tweetPhoto"] img');
            const imageUrls = [];
            imgDivs.forEach((img) => {
                if (img.src && !img.src.includes('emoji')) {
                    imageUrls.push(img.src);
                }
            });
            const imageUrl = imageUrls.length > 0 ? imageUrls[0] : null;

            let videoUrl = null;
            let hasVideo = false;
            const videoEl = article.querySelector('video');
            if (videoEl) {
                hasVideo = true;
                videoUrl = videoEl.src || null;
                if (!videoUrl || videoUrl.startsWith('blob:')) {
                    const sourceEl = videoEl.querySelector('source');
                    if (sourceEl && sourceEl.src && !sourceEl.src.startsWith('blob:')) {
                        videoUrl = sourceEl.src;
                    } else {
                        videoUrl = null;
                    }
                }
            }

            let tweetUrl = null;
            const tl = article.querySelector('a[href*="/status/"]');
            if (tl) tweetUrl = tl.href.split('?')[0];

            if (!text && !imageUrl && !videoUrl && !hasVideo) {
                alert('No content to share!');
                return;
            }

            const postText = text;

            btn.innerHTML = `
                <div style="width:20px; height:20px; border-radius:50%; background:#181A20; display:flex; align-items:center; justify-content:center; border:1.5px solid #F0B90B;">
                    <span style="font-size:8px; font-weight:bold; color:#F0B90B;">···</span>
                </div>
            `;
            btn.title = 'Posting to Binance Square…';

            chrome.runtime.sendMessage({ action: 'squarePost', text: postText }, (response) => {
                if (response?.success) {
                    btn.innerHTML = `
                        <div style="width:18px; height:18px; border-radius:50%; background:#22c55e; display:flex; align-items:center; justify-content:center;">
                            <span style="font-size:10px; font-weight:bold; color:#fff;">✓</span>
                        </div>
                    `;
                    btn.title = `Posted to Binance Square!${response.count ? ' (' + response.count + ' posts today)' : ''}`;

                    chrome.storage.local.get(['crossPostHistory'], (histResult) => {
                        const history = histResult.crossPostHistory || [];
                        history.unshift({
                            tweetUrl,
                            tweetText: text ? text.substring(0, 50) + (text.length > 50 ? '...' : '') : '[No text]',
                            timestamp: Date.now(),
                            imageCount: imageUrls.length
                        });
                        if (history.length > 50) history.pop();
                        chrome.storage.local.set({ crossPostHistory: history });
                    });
                } else if (response?.error === 'no_key') {
                    btn.innerHTML = `
                        <div style="width:20px; height:20px; border-radius:50%; background:#181A20; display:flex; align-items:center; justify-content:center; border:1.5px solid #F0B90B;">
                            <img src="${_bsIcon}" width="13" height="13" style="display:block;" alt="" />
                        </div>
                    `;
                    btn.title = 'Share to Binance Square';
                    const hint = document.createElement('div');
                    hint.textContent = '⚡ Set your Square API key in the ClipX popup → Square tab';
                    hint.style.cssText = 'position:fixed;bottom:80px;right:20px;background:#1a1a1a;color:#F0B90B;' +
                        'border:1px solid #F0B90B44;border-radius:8px;padding:10px 14px;font-size:12px;' +
                        'z-index:99999;max-width:260px;box-shadow:0 4px 12px #0008;';
                    document.body.appendChild(hint);
                    setTimeout(() => hint.remove(), 4000);
                } else {
                    btn.innerHTML = `
                        <div style="width:20px; height:20px; border-radius:50%; background:#ef4444; display:flex; align-items:center; justify-content:center;">
                            <span style="font-size:10px; font-weight:bold; color:#fff;">✗</span>
                        </div>
                    `;
                    btn.title = `Post failed: ${response?.error || 'unknown error'}`;
                    setTimeout(() => {
                        btn.innerHTML = `
                            <div style="width:20px; height:20px; border-radius:50%; background:#181A20; display:flex; align-items:center; justify-content:center; border:1.5px solid #F0B90B;">
                                <img src="${_bsIcon}" width="13" height="13" style="display:block;" alt="" />
                            </div>
                        `;
                        btn.title = 'Share to Binance Square';
                    }, 3000);
                }
            });
        };

        actionBar.appendChild(btn);
        article.dataset.clipxCrossPost = 'true';
    });
}

// -------------------------------------------

// Initialize
function init() {
    console.log('[ClipX] Initializing...');
    try {
        clipxSyncPostPageContextAttribute();
    } catch (e) { /* ignore */ }
    try {
        clipxSyncXAppearanceAttribute();
    } catch (e) { /* ignore */ }
    if (!window.__clipxAppearanceHooked) {
        window.__clipxAppearanceHooked = true;
        const appearanceMo = new MutationObserver(() => {
            try {
                clipxSyncXAppearanceAttribute();
            } catch (e) { /* ignore */ }
        });
        appearanceMo.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-color-mode', 'data-theme', 'data-color-theme'],
        });
        let appearanceTicks = 0;
        const appearanceIv = setInterval(() => {
            try {
                clipxSyncXAppearanceAttribute();
            } catch (e) { /* ignore */ }
            if (++appearanceTicks >= 24) clearInterval(appearanceIv);
        }, 1250);
    }
    window.addEventListener('popstate', clipxSyncPostPageContextAttribute);
    if (!window.__clipxHistoryPatched) {
        window.__clipxHistoryPatched = true;
        const _ps = history.pushState;
        const _rs = history.replaceState;
        history.pushState = function (...args) {
            const r = _ps.apply(this, args);
            queueMicrotask(() => {
                try {
                    clipxSyncPostPageContextAttribute();
                } catch (e) { /* ignore */ }
            });
            return r;
        };
        history.replaceState = function (...args) {
            const r = _rs.apply(this, args);
            queueMicrotask(() => {
                try {
                    clipxSyncPostPageContextAttribute();
                } catch (e) { /* ignore */ }
            });
            return r;
        };
    }

    if (!window.__clipxSorsaCacheListener) {
        window.__clipxSorsaCacheListener = true;
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'local' || !changes[CLIPX_SORSA_SCORE_CACHE_KEY]) return;
            try {
                injectClipxSorsaScoresOnPage();
            } catch (e) {
                /* ignore */
            }
        });
    }

    // Fetch token list first, then add buttons
    chrome.runtime.sendMessage({ action: 'fetchTokenList' }, (response) => {
        if (response && response.success) {
            window.clipxTokenMap = response.tokens;
            // Force native Solana routing for $SOL even if storage served an
            // old cached BSC token list before the background cache refreshes.
            clipxEnsureNativeSolTokenMap();
            console.log('[ClipX] Token list loaded:', Object.keys(window.clipxTokenMap).length);
            console.log('[ClipX] CLIPX in map?', window.clipxTokenMap['CLIPX'] ? 'YES' : 'NO');

            // Now that tokens are loaded, add tip buttons
            addTipButtons();
            try { injectClipxSurfSentimentOnPage(); } catch (e) { console.error('[ClipX] injectClipxSurfSentimentOnPage error:', e); }
            // Inject analyze buttons for Intel feature
            try { injectAnalyzeButtons(); } catch (e) { console.error('[ClipX] injectAnalyzeButtons error:', e); }
            try { injectCrossPostButtons(); } catch (e) { console.error('[ClipX] injectCrossPostButtons error:', e); }
            // Inject labels on user list pages (followers, following, connect, sidebar, etc.)
            injectUserListLabels().catch(e => console.error('[ClipX] injectUserListLabels error:', e));
            try { injectClipxSorsaScoresOnPage(); } catch (e) { console.error('[ClipX] injectClipxSorsaScoresOnPage error:', e); }
        } else {
            console.error('[ClipX] Failed to load token list');
            // Still try to add buttons (for addresses)
            addTipButtons();
            try { injectClipxSurfSentimentOnPage(); } catch (e) { console.error('[ClipX] injectClipxSurfSentimentOnPage error:', e); }
            // And inject analyze buttons
            try { injectAnalyzeButtons(); } catch (e) { console.error('[ClipX] injectAnalyzeButtons error:', e); }
            try { injectCrossPostButtons(); } catch (e) { console.error('[ClipX] injectCrossPostButtons error:', e); }
            // And inject user list labels
            injectUserListLabels().catch(e => console.error('[ClipX] injectUserListLabels error:', e));
            try { injectClipxSorsaScoresOnPage(); } catch (e) { console.error('[ClipX] injectClipxSorsaScoresOnPage error:', e); }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


// ============================================================

console.log('[ClipX Content] Ready');

// ============================================================

// ====================
// CRYPTO MARKET INSIGHT WIDGET
// ====================

let marketInsightEnabled = true;
chrome.storage.local.get(['showMarketInsight'], (r) => {
    marketInsightEnabled = r.showMarketInsight !== false;
    if (marketInsightEnabled) injectCryptoInsightWidget();
});

// Message handler for settings refresh
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'refreshSettings') {
        // Handle Tips buttons
        document.querySelectorAll('.clipx-tip-badge').forEach(btn => btn.remove());
        document.querySelectorAll('article[data-clipx-processed]').forEach(article => {
            article.removeAttribute('data-clipx-processed');
        });
        if (request.showTipsButtons) addTipButtons();

        // Handle Label Effect Style
        if (request.labelEffectStyle) {
            currentLabelStyle = request.labelEffectStyle;
            document.querySelectorAll('.clipx-feed-label, .clipx-profile-label-badge, .clipx-user-list-label').forEach(el => {
                applyLabelStyle(el);
            });
        }

        if (request.tokenPillStyle) {
            currentTokenPillStyle = clipxNormalizeTokenPillStyle(request.tokenPillStyle);
            clipxApplyTokenPillStyleToExisting();
        }

        // Handle Market Insight
        marketInsightEnabled = request.showMarketInsight;
        const existing = document.getElementById('clipx-market-insight');
        if (marketInsightEnabled && !existing) {
            injectCryptoInsightWidget();
        } else if (!marketInsightEnabled && existing) {
            existing.remove();
        }

        if (request.showSurfSocial === false) {
            document.querySelectorAll('.clipx-timeline-surf-sentiment').forEach((el) => el.remove());
        } else if (request.showSurfSocial === true) {
            clipxSurfTimelineCache.clear();
            try {
                injectClipxSurfSentimentOnPage();
            } catch (e) {
                /* ignore */
            }
        }
    }
});

async function injectCryptoInsightWidget() {
    // Only inject on home page
    if (!window.location.pathname.includes('/home')) return;

    // Check if already injected
    if (document.getElementById('clipx-market-insight')) return;

    // Check for saved size & position
    const saved = await new Promise(resolve => chrome.storage.local.get(['clipxWidgetSize', 'clipxWidgetPos'], r => resolve(r)));
    const size = saved.clipxWidgetSize || {};
    const pos = saved.clipxWidgetPos || {};

    const savedWidth = size.width || 360;
    const savedHeight = size.height || 'auto';
    const savedTop = pos.top !== undefined ? pos.top : 60;
    const savedRight = pos.right !== undefined ? pos.right : 20;

    // Create the widget container
    const widget = document.createElement('div');
    widget.id = 'clipx-market-insight';
    widget.style.cssText = `
        position: fixed;
        top: ${savedTop}px;
        right: ${savedRight}px;
        width: ${savedWidth}px;
        height: ${typeof savedHeight === 'number' ? savedHeight + 'px' : 'auto'};
        min-width: 280px;
        max-width: 800px;
        min-height: 200px;
        max-height: calc(100vh - 80px);
        overflow: visible; /* Changed to visible to allow handles outside if needed, or stick to auto */
        display: flex;
        flex-direction: column;
        resize: none; /* Custom handles used */
        z-index: 99999;
        background: #16181c;
        border-radius: 16px;
        padding: 14px;
        border: 1px solid #2f3336;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;

    // Inject Resize Handles & Styles
    const handles = `
        <style>
            #clipx-resize-left:hover, #clipx-resize-right:hover, #clipx-resize-bottom:hover, #clipx-resize-sw:hover, #clipx-resize-se:hover { background: rgba(56, 189, 248, 0.5); transition: background 0.2s; }
        </style>
        <div id="clipx-resize-left" style="position: absolute; left: -4px; top: 0; bottom: 0; width: 10px; cursor: ew-resize; z-index: 100001;"></div>
        <div id="clipx-resize-right" style="position: absolute; right: -4px; top: 0; bottom: 0; width: 10px; cursor: ew-resize; z-index: 100001;"></div>
        <div id="clipx-resize-bottom" style="position: absolute; left: 0; right: 0; bottom: -4px; height: 10px; cursor: ns-resize; z-index: 100001;"></div>
        <div id="clipx-resize-sw" style="position: absolute; left: -4px; bottom: -4px; width: 15px; height: 15px; cursor: nesw-resize; z-index: 100002;"></div>
        <div id="clipx-resize-se" style="position: absolute; right: -4px; bottom: -4px; width: 15px; height: 15px; cursor: nwse-resize; z-index: 100002;"></div>
    `;

    widget.innerHTML = handles + `
        <div id="clipx-widget-header" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; cursor: move; user-select: none; padding: 0 4px;">
            <div style="display: flex; gap: 4px; background: #1a1d21; padding: 3px; border-radius: 8px;">
                <button id="clipx-mode-market" class="clipx-mode-btn" style="background: #8b5cf6; color: white; border: none; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.2s;">📊 Market</button>
                <button id="clipx-mode-hype" class="clipx-mode-btn" style="background: transparent; color: #71767b; border: none; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.2s;">🔥 Social Hype</button>
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
                <span id="clipx-live-indicator" style="font-size: 10px; color: #22c55e; animation: pulse 2s infinite;">● LIVE</span>
                <span id="clipx-ws-status" style="font-size: 9px; color: #71767b;">WS</span>
                <span id="clipx-alert-manager-btn" style="cursor: pointer; font-size: 14px; color: #f3ba2f;" title="Alerts & History">🔔</span>
                <span id="clipx-market-refresh" style="cursor: pointer; font-size: 14px; color: #71767b;" title="Refresh">🔄</span>
                <span id="clipx-market-close" style="cursor: pointer; font-size: 14px; color: #71767b;" title="Close">✕</span>
            </div>
        </div>

        <div id="clipx-widget-scroll-area" style="flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 4px;">
            <!-- ALERT MANAGER OVERLAY -->
            <div id="clipx-alert-manager" style="display:none; flex-direction:column; gap:8px; height:auto;">
                <div style="display:flex; gap:10px; border-bottom:1px solid #2f3336; padding-bottom:4px;">
                    <div id="clipx-tab-active" style="font-size:11px; font-weight:600; color:#fff; cursor:pointer;">Active</div>
                    <div id="clipx-tab-history" style="font-size:11px; font-weight:600; color:#71767b; cursor:pointer;">History</div>
                </div>
                <div id="clipx-alert-content" style="flex:1; overflow-y:auto; font-size:10px; color:#e7e9ea; max-height: 250px;">
                    <!-- Dynamic Content -->
                </div>
                <button id="clipx-close-manager" style="align-self: flex-end; background:#2f3336; color:#fff; border:none; padding:4px 8px; border-radius:4px; font-size:10px; cursor:pointer;">Back</button>
            </div>

            <!-- ===== CRYPTO MARKET CONTENT ===== -->
            <div id="clipx-market-content">
                <!-- FEAR & GREED INDEX -->
                <div style="margin-bottom: 12px; background: #1a1d21; border-radius: 10px; padding: 10px;">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div>
                            <div style="font-weight: 600; font-size: 11px; color: #e7e9ea; margin-bottom: 4px;">😨 Fear & Greed Index</div>
                            <div id="clipx-fear-greed-value" style="font-size: 28px; font-weight: 700; color: #f3ba2f;">--</div>
                            <div id="clipx-fear-greed-label" style="font-size: 12px; color: #71767b;">Loading...</div>
                            <div id="clipx-fear-greed-gauge" style="width: 80px; height: 40px;"></div>
                        </div>
                    </div>
                </div>
                
                <!-- FEATURED TICKERS -->
                <div style="margin-bottom: 12px;">
                     <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                         <div style="font-weight: 600; font-size: 12px; color: #a855f7;">★ Featured</div>
                         <button id="clipx-add-feature-btn" style="background: none; border: none; color: #a855f7; cursor: pointer; font-size: 16px; line-height: 1;">+</button>
                     </div>
                     <div id="clipx-add-feature-input-container" style="display: none; margin-bottom: 6px; gap: 4px;">
                         <input id="clipx-feature-input" type="text" placeholder="Symbol (e.g. SOL)" style="background: #27272a; border: 1px solid #3f3f46; color: #fff; padding: 4px 6px; border-radius: 4px; font-size: 11px; width: 100%; outline: none; text-transform: uppercase;">
                         <button id="clipx-feature-save" style="background: #a855f7; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: 600;">Add</button>
                     </div>
                     <div id="clipx-featured-tickers" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;">
                         <div style="grid-column: span 3; color: #71767b; font-size: 10px; text-align: center; padding: 4px;">No featured tickers. Click + to add.</div>
                     </div>
                </div>

                <!-- BINANCE LIVE PRICES WITH SPARKLINES -->
                <div style="margin-bottom: 12px;">
                    <div style="font-weight: 600; font-size: 12px; color: #f3ba2f; margin-bottom: 6px;">⚡ Binance Real-Time</div>
                    <div id="clipx-binance-prices" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;"></div>
                </div>
                
                <!-- 24H HEATMAP FROM BINANCE -->
                <div style="margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <div style="font-weight: 600; font-size: 12px; color: #e7e9ea;">🗺️ Binance Heatmap (24H)</div>
                        <button id="clipx-heatmap-export" style="background: linear-gradient(135deg, #a855f7, #6366f1); border: none; color: white; font-size: 10px; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 3px;" title="Export as 3840x2160 PNG">
                            📸 Export
                        </button>
                    </div>
                    <div id="clipx-market-heatmap" style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px;"></div>
                </div>
                
                <!-- VOLUME LEADERS -->
                <div style="border-top: 1px solid #2f3336; padding-top: 10px; margin-bottom: 10px;">
                    <div style="font-weight: 600; font-size: 12px; color: #38bdf8; margin-bottom: 6px;">💰 Volume Leaders (24H)</div>
                    <div id="clipx-volume-leaders" style="display: flex; flex-wrap: wrap; gap: 5px;"></div>
                </div>
                
                <!-- TOP GAINERS & LOSERS -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; border-top: 1px solid #2f3336; padding-top: 10px;">
                    <div>
                        <div style="font-weight: 600; font-size: 12px; color: #22c55e; margin-bottom: 6px;">📈 Gainers</div>
                        <div id="clipx-market-gainers"></div>
                    </div>
                    <div>
                        <div style="font-weight: 600; font-size: 12px; color: #ef4444; margin-bottom: 6px;">📉 Losers</div>
                        <div id="clipx-market-losers"></div>
                    </div>
                </div>
                
                <!-- TRENDING -->
                <div style="border-top: 1px solid #2f3336; padding-top: 10px; margin-top: 10px;">
                    <div style="font-weight: 600; font-size: 12px; color: #1d9bf0; margin-bottom: 6px;">🔥 Trending</div>
                    <div id="clipx-market-trending" style="display: flex; flex-wrap: wrap; gap: 4px;"></div>
                </div>
            </div>

            <!-- ===== SOCIAL HYPE CONTENT (Hidden by default) ===== -->
            <div id="clipx-hype-content" style="display: none;">
                <!-- FILTERS -->
                <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap;">
                    <div style="display: flex; gap: 4px; background: #1a1d21; padding: 3px; border-radius: 6px;">
                        <button class="clipx-hype-time" data-time="1" style="background: transparent; color: #71767b; border: none; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer;">1H</button>
                        <button class="clipx-hype-time" data-time="4" style="background: transparent; color: #71767b; border: none; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer;">4H</button>
                        <button class="clipx-hype-time" data-time="24" style="background: #f97316; color: white; border: none; padding: 3px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer;">24H</button>
                    </div>
                    <label style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: #71767b; cursor: pointer;">
                        <input type="checkbox" id="clipx-new-tokens-only" checked style="width: 12px; height: 12px; cursor: pointer;">
                        <span>30D New Only</span>
                    </label>
                </div>

                <!-- HYPE TABS -->
                <div style="display: flex; gap: 4px; margin-bottom: 12px; background: #1a1d21; padding: 3px; border-radius: 6px;">
                    <button class="clipx-hype-tab" data-tab="trending" style="flex: 1; background: #f97316; color: white; border: none; padding: 6px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer;">🔥 Trending</button>
                    <button class="clipx-hype-tab" data-tab="rising" style="flex: 1; background: transparent; color: #71767b; border: none; padding: 6px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer;">📈 Rising</button>
                    <button class="clipx-hype-tab" data-tab="mindshare" style="flex: 1; background: transparent; color: #71767b; border: none; padding: 6px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer;">🧠 Mindshare</button>
                </div>

                <!-- HYPE TRENDING TAB -->
                <div id="clipx-hype-trending-tab" class="clipx-hype-tab-content">
                    <div id="clipx-hype-leaderboard" style="display: flex; flex-direction: column; gap: 8px;">
                        <div style="text-align: center; color: #71767b; font-size: 11px; padding: 20px;">Loading...</div>
                    </div>
                </div>

                <!-- HYPE RISING TAB -->
                <div id="clipx-hype-rising-tab" class="clipx-hype-tab-content" style="display: none;">
                    <div id="clipx-hype-rising-list" style="display: flex; flex-direction: column; gap: 8px;">
                        <div style="text-align: center; color: #71767b; font-size: 11px; padding: 20px;">Loading...</div>
                    </div>
                </div>

                <!-- HYPE MINDSHARE TAB -->
                <div id="clipx-hype-mindshare-tab" class="clipx-hype-tab-content" style="display: none;">
                        <div style="font-weight: 600; font-size: 12px; color: #a855f7;">🧠 Mindshare Distribution</div>
                    <div id="clipx-mindshare-treemap" style="margin-bottom: 12px;">
                        <div style="grid-column: span 4; text-align: center; color: #71767b; font-size: 11px; padding: 20px;">Loading...</div>
                    </div>
                    
                    <!-- HYPE RISING SECTION IN MINDSHARE -->
                    <div style="border-top: 1px solid #2f3336; padding-top: 12px; margin-top: 15px; background: rgba(26, 29, 33, 0.6); border-radius: 12px; padding: 12px; border: 1px solid rgba(249, 115, 22, 0.2);">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="font-size: 16px;">🚀</span>
                                <div style="font-weight: 800; font-size: 13px; color: #f97316; letter-spacing: 0.5px; text-transform: uppercase;">Hype Rising</div>
                            </div>
                            <div style="font-size: 9px; color: #71767b; font-weight: 500;">Top 10 Fast Movers</div>
                        </div>
                        <div id="clipx-mindshare-rising-preview" style="display: flex; flex-direction: column; gap: 8px;">
                            <div style="text-align: center; color: #71767b; font-size: 10px; padding: 10px;">Loading rising tokens...</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #2f3336; text-align: center;">
            <span style="font-size: 12px; color: #e8eb34ff;">Powered by ClipX </span>
        </div>
        
        <style>
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
            #clipx-market-insight::-webkit-scrollbar { width: 4px; height: 4px; }
            #clipx-market-insight::-webkit-scrollbar-thumb { background: #2f3336; border-radius: 4px; }
            #clipx-market-insight::-webkit-resizer { 
                background: linear-gradient(135deg, transparent 60%, #1d9bf0 60%, #1d9bf0 75%, transparent 75%);
                border-radius: 0 0 16px 0;
            }
            .clipx-mode-btn:hover { opacity: 0.8; }
            .clipx-hype-time:hover, .clipx-hype-tab:hover { background: rgba(249, 115, 22, 0.2) !important; color: #f97316 !important; }
        </style>

    `;

    document.body.appendChild(widget);

    // Initialize Resize Drag Logic
    initResizeDrag(widget);
    initDragMove(widget);

    // Close button logic — persist to storage so widget stays hidden on reload
    const closeBtn = document.getElementById('clipx-market-close');
    if (closeBtn) closeBtn.onclick = () => {
        widget.remove();
        marketInsightEnabled = false;
        chrome.storage.local.set({ showMarketInsight: false });
        if (window.clipxBinanceWs) window.clipxBinanceWs.close();
        if (window.clipxMarketRefreshInterval) clearInterval(window.clipxMarketRefreshInterval);
    };

    // Refresh Logic
    const refreshBtn = document.getElementById('clipx-market-refresh');
    if (refreshBtn) refreshBtn.onclick = () => loadBinanceMarketData();

    // Heatmap Export Button Logic
    // ... (rest of binding code)

    // Helper: Move Logic
    function initDragMove(widget) {
        const header = widget.querySelector('#clipx-widget-header');
        if (!header) return;

        let startX, startY, startRight, startTop;

        header.onmousedown = (e) => {
            // Ignore if clicking interactive elements (buttons, clickable spans)
            const target = e.target;
            const tag = target.tagName.toLowerCase();
            // Skip if it's a button or has pointer cursor (interactive element)
            if (tag === 'button' || target.closest('button')) return;
            if (tag === 'span' && (target.style.cursor === 'pointer' || target.id)) return;

            e.preventDefault();
            startX = e.clientX;
            startY = e.clientY;

            // Get computed style for current Right/Top
            const style = window.getComputedStyle(widget);
            startRight = parseInt(style.right, 10) || 20;
            startTop = parseInt(style.top, 10) || 60;

            const onMouseMove = (ev) => {
                const deltaX = startX - ev.clientX; // Moving left (smaller X) increases Right value
                const deltaY = ev.clientY - startY; // Moving down (larger Y) increases Top value

                widget.style.right = (startRight + deltaX) + 'px';
                widget.style.top = (startTop + deltaY) + 'px';
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);

                // Save Position
                const finalRight = parseInt(widget.style.right, 10);
                const finalTop = parseInt(widget.style.top, 10);
                chrome.storage.local.set({
                    clipxWidgetPos: { top: finalTop, right: finalRight }
                });
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };
    }
    // ... (rest of binding code)

    // Helper: Resize Logic
    function initResizeDrag(widget) {
        const minW = 280, maxW = 800;
        const minH = 200;

        const handleLeft = widget.querySelector('#clipx-resize-left');
        const handleRight = widget.querySelector('#clipx-resize-right');
        const handleBottom = widget.querySelector('#clipx-resize-bottom');
        const handleSW = widget.querySelector('#clipx-resize-sw');
        const handleSE = widget.querySelector('#clipx-resize-se');

        let startX, startY, startW, startH, startRight;

        function onMouseDown(e, direction) {
            e.preventDefault();
            startX = e.clientX;
            startY = e.clientY;
            startW = widget.getBoundingClientRect().width;
            startH = widget.getBoundingClientRect().height;
            startRight = parseInt(window.getComputedStyle(widget).right, 10) || 20;

            const onMouseMove = (ev) => {
                // Left resize: dragging left edge
                if (direction === 'left' || direction === 'sw') {
                    const delta = startX - ev.clientX;
                    let newW = startW + delta;
                    if (newW < minW) newW = minW;
                    if (newW > maxW) newW = maxW;
                    widget.style.width = newW + 'px';
                }

                // Right resize: dragging right edge (widget is positioned by 'right', so we adjust 'right' and 'width')
                if (direction === 'right' || direction === 'se') {
                    const delta = startX - ev.clientX; // Moving left decreases width, moving right increases
                    let newW = startW - delta;
                    if (newW < minW) newW = minW;
                    if (newW > maxW) newW = maxW;
                    // Also need to adjust 'right' position when resizing from right
                    const newRight = startRight + delta;
                    widget.style.right = Math.max(0, newRight) + 'px';
                    widget.style.width = newW + 'px';
                }

                // Bottom resize
                if (direction === 'bottom' || direction === 'sw' || direction === 'se') {
                    const delta = ev.clientY - startY;
                    let newH = startH + delta;
                    if (newH < minH) newH = minH;
                    widget.style.height = newH + 'px';
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                // Save Persistence
                const finalW = widget.getBoundingClientRect().width;
                const finalH = widget.getBoundingClientRect().height;
                const finalRight = parseInt(widget.style.right, 10) || 20;
                chrome.storage.local.set({
                    clipxWidgetSize: { width: finalW, height: finalH },
                    clipxWidgetPos: { top: parseInt(widget.style.top, 10) || 60, right: finalRight }
                });
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }

        if (handleLeft) handleLeft.onmousedown = (e) => onMouseDown(e, 'left');
        if (handleRight) handleRight.onmousedown = (e) => onMouseDown(e, 'right');
        if (handleBottom) handleBottom.onmousedown = (e) => onMouseDown(e, 'bottom');
        if (handleSW) handleSW.onmousedown = (e) => onMouseDown(e, 'sw');
        if (handleSE) handleSE.onmousedown = (e) => onMouseDown(e, 'se');
    }
    const heatmapExportBtn = document.getElementById('clipx-heatmap-export');
    if (heatmapExportBtn) {
        heatmapExportBtn.onclick = async () => {
            const coins = window.clipxHeatmapData || [];
            if (coins.length === 0) {
                alert('No heatmap data available. Please wait for data to load.');
                return;
            }

            // Show loading state
            heatmapExportBtn.disabled = true;
            heatmapExportBtn.textContent = '⏳ Generating...';

            try {
                await generateHeatmapImage(coins);
            } catch (e) {
                console.error('[ClipX] Heatmap export error:', e);
                alert('Failed to generate heatmap image');
            } finally {
                heatmapExportBtn.disabled = false;
                heatmapExportBtn.innerHTML = '📸 Export';
            }
        };
    }

    // Heatmap Image Generation Function (1920x1080) - Professional Treemap Style
    // Box SIZE = Volume (market dominance), COLOR = 24H change
    async function generateHeatmapImage(coins) {
        const canvas = document.createElement('canvas');
        // 4K resolution for high quality exports
        canvas.width = 3840;
        canvas.height = 2160;
        const ctx = canvas.getContext('2d');

        // Dark background
        ctx.fillStyle = '#0f0f0f';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Title (scaled for 4K)
        ctx.font = 'bold 64px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText('Live Crypto Market Heatmap (Top 50 by Volume, 24h Change)', canvas.width / 2, 90);

        // Subtitle
        ctx.font = '32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#888888';
        ctx.fillText('Rectangle size reflects market dominance across assets', canvas.width / 2, 144);

        // Treemap area - leave space for vertical legend on right (scaled for 4K)
        const treemapLeft = 80;
        const treemapTop = 190;
        const treemapWidth = canvas.width - 400; // Leave space for legend
        const treemapHeight = canvas.height - 260;
        const legendLeft = canvas.width - 280;

        // Filter out stablecoins
        const stablecoins = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'FDUSD', 'USD1', 'USDD', 'FRAX', 'LUSD', 'USDJ', 'GUSD', 'PAX', 'SUSD', 'HUSD', 'CUSD', 'RSR', 'FEI', 'MIM', 'UST', 'USTC'];
        const filteredCoins = coins.filter(coin => {
            const symbol = coin.symbol.replace('USDT', '').toUpperCase();
            return !stablecoins.includes(symbol) && !symbol.includes('USD');
        });

        // Sort coins by volume (largest first for treemap)
        const sortedCoins = [...filteredCoins].sort((a, b) => b.volume - a.volume).slice(0, 50);
        const totalVolume = sortedCoins.reduce((sum, c) => sum + c.volume, 0);

        // Color function based on % change (green to gray to red gradient)
        function getColorForChange(change) {
            if (change >= 10) return '#1a7d3f';      // Dark green
            if (change >= 5) return '#2d9a4e';       // Green
            if (change >= 2) return '#5ab872';       // Light green
            if (change >= 0) return '#8ccca0';       // Very light green
            if (change >= -0.5) return '#d9d9d9';    // Gray (neutral)
            if (change >= -2) return '#f0a0a0';      // Light red
            if (change >= -5) return '#e06060';      // Red
            if (change >= -10) return '#c03030';     // Dark red
            return '#8b0000';                         // Very dark red
        }

        // Squarified Treemap Algorithm - Properly fills entire area
        function squarify(items, container) {
            const rects = [];
            if (items.length === 0) return rects;
            if (items.length === 1) {
                // Single item fills entire container
                rects.push({
                    item: items[0].coin,
                    x: container.x,
                    y: container.y,
                    w: container.w,
                    h: container.h
                });
                return rects;
            }

            // Calculate total value of remaining items
            const totalValue = items.reduce((sum, item) => sum + item.value, 0);

            // Determine layout direction
            const isWide = container.w >= container.h;

            // Find optimal split point using squarify heuristic
            let bestSplit = 1;
            let bestAspect = Infinity;

            for (let split = 1; split < items.length; split++) {
                const leftItems = items.slice(0, split);
                const leftValue = leftItems.reduce((sum, item) => sum + item.value, 0);
                const leftRatio = leftValue / totalValue;

                // Calculate sizes for left partition
                const leftSize = isWide ? container.w * leftRatio : container.h * leftRatio;
                const crossSize = isWide ? container.h : container.w;

                // Calculate worst aspect ratio for left items
                let worstAspect = 0;
                leftItems.forEach(item => {
                    const itemRatio = item.value / leftValue;
                    const itemSize = crossSize * itemRatio;
                    const aspect = Math.max(leftSize / itemSize, itemSize / leftSize);
                    worstAspect = Math.max(worstAspect, aspect);
                });

                if (worstAspect < bestAspect) {
                    bestAspect = worstAspect;
                    bestSplit = split;
                } else if (worstAspect > bestAspect * 1.5) {
                    // Stop if aspect ratio gets significantly worse
                    break;
                }
            }

            // Split items
            const leftItems = items.slice(0, bestSplit);
            const rightItems = items.slice(bestSplit);
            const leftValue = leftItems.reduce((sum, item) => sum + item.value, 0);
            const leftRatio = leftValue / totalValue;

            // Calculate left container
            let leftContainer, rightContainer;
            if (isWide) {
                const leftWidth = container.w * leftRatio;
                leftContainer = { x: container.x, y: container.y, w: leftWidth, h: container.h };
                rightContainer = { x: container.x + leftWidth, y: container.y, w: container.w - leftWidth, h: container.h };
            } else {
                const leftHeight = container.h * leftRatio;
                leftContainer = { x: container.x, y: container.y, w: container.w, h: leftHeight };
                rightContainer = { x: container.x, y: container.y + leftHeight, w: container.w, h: container.h - leftHeight };
            }

            // Layout left items in a row/column
            const crossSize = isWide ? leftContainer.h : leftContainer.w;
            let offset = 0;
            leftItems.forEach(item => {
                const itemRatio = item.value / leftValue;
                const itemSize = crossSize * itemRatio;
                const rect = {
                    item: item.coin,
                    x: isWide ? leftContainer.x : leftContainer.x + offset,
                    y: isWide ? leftContainer.y + offset : leftContainer.y,
                    w: isWide ? leftContainer.w : itemSize,
                    h: isWide ? itemSize : leftContainer.h
                };
                rects.push(rect);
                offset += itemSize;
            });

            // Recursively process right items
            if (rightItems.length > 0) {
                const rightRects = squarify(rightItems, rightContainer);
                rects.push(...rightRects);
            }

            return rects;
        }

        // Prepare items for treemap
        const treemapItems = sortedCoins.map(coin => ({
            coin,
            value: coin.volume
        }));

        // Generate treemap rectangles
        const rects = squarify(treemapItems, {
            x: treemapLeft,
            y: treemapTop,
            w: treemapWidth,
            h: treemapHeight
        });

        // Draw treemap cells
        rects.forEach(rect => {
            const coin = rect.item;
            const x = rect.x + 1;
            const y = rect.y + 1;
            const w = rect.w - 2;
            const h = rect.h - 2;

            if (w < 2 || h < 2) return; // Skip tiny cells

            // Background color based on change
            const bgColor = getColorForChange(coin.change);
            ctx.fillStyle = bgColor;
            ctx.fillRect(x, y, w, h);

            // Border
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);

            // Calculate font sizes based on cell size
            const minDim = Math.min(w, h);
            const area = w * h;

            // Only show text if cell is big enough
            if (minDim < 25) return;

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const centerX = x + w / 2;
            const centerY = y + h / 2;

            // Determine if we need light or dark text
            const textColor = coin.change >= -0.5 && coin.change < 2 ? '#333333' : '#ffffff';
            ctx.fillStyle = textColor;

            // Format price helper - show full price like $91300
            const formatPrice = (price) => {
                if (price >= 1000) return `$${Math.round(price).toLocaleString()}`;
                if (price >= 1) return `$${price.toFixed(2)}`;
                if (price >= 0.01) return `$${price.toFixed(4)}`;
                if (price >= 0.0001) return `$${price.toFixed(6)}`;
                return `$${price.toPrecision(3)}`;
            };

            if (area > 320000) {
                // Very large cell (BTC, ETH) - show name, price, change (scaled for 4K)
                const nameSize = Math.min(84, Math.max(40, minDim * 0.22));
                const priceSize = Math.min(48, Math.max(28, minDim * 0.12));
                const changeSize = Math.min(56, Math.max(32, minDim * 0.14));

                // Coin name
                ctx.font = `bold ${nameSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                ctx.fillText(coin.symbol.replace('USDT', ''), centerX, centerY - h * 0.18);

                // Price
                ctx.font = `${priceSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                ctx.fillText(formatPrice(coin.price), centerX, centerY + h * 0.02);

                // Change %
                ctx.font = `${changeSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                const changeStr = `${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(2)}%`;
                ctx.fillText(changeStr, centerX, centerY + h * 0.2);

            } else if (area > 80000) {
                // Large cell - show name, price, change (scaled for 4K)
                const nameSize = Math.min(48, Math.max(28, minDim * 0.2));
                const priceSize = Math.min(28, Math.max(20, minDim * 0.1));
                const changeSize = Math.min(36, Math.max(24, minDim * 0.12));

                // Coin name
                ctx.font = `bold ${nameSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                ctx.fillText(coin.symbol.replace('USDT', ''), centerX, centerY - h * 0.15);

                // Price
                ctx.font = `${priceSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                ctx.fillText(formatPrice(coin.price), centerX, centerY + h * 0.02);

                // Change %
                ctx.font = `${changeSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                const changeStr = `${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(2)}%`;
                ctx.fillText(changeStr, centerX, centerY + h * 0.18);

            } else if (area > 24000) {
                // Medium cell - show name and change (scaled for 4K)
                const nameSize = Math.min(32, Math.max(20, minDim * 0.22));
                const changeSize = Math.min(28, Math.max(18, minDim * 0.16));

                ctx.font = `bold ${nameSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                ctx.fillText(coin.symbol.replace('USDT', ''), centerX, centerY - 12);

                ctx.font = `${changeSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                const changeStr = `${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(1)}%`;
                ctx.fillText(changeStr, centerX, centerY + 20);

            } else if (area > 8000) {
                // Small cell - just symbol and change (scaled for 4K)
                const fontSize = Math.min(24, Math.max(16, minDim * 0.25));
                ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                ctx.fillText(coin.symbol.replace('USDT', ''), centerX, centerY - 8);

                ctx.font = `${fontSize - 4}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                ctx.fillText(`${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(1)}%`, centerX, centerY + 16);
            } else {
                // Very small - just abbreviated symbol (scaled for 4K)
                const fontSize = Math.min(20, Math.max(14, minDim * 0.3));
                ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
                const abbrev = coin.symbol.replace('USDT', '').slice(0, 3);
                ctx.fillText(abbrev, centerX, centerY);
            }
        });

        // Draw vertical gradient legend on the right (scaled for 4K)
        const legendTop = treemapTop + 40;
        const legendHeight = treemapHeight - 80;
        const legendWidth = 50;

        // Create gradient
        const gradient = ctx.createLinearGradient(legendLeft, legendTop, legendLeft, legendTop + legendHeight);
        gradient.addColorStop(0, '#1a7d3f');
        gradient.addColorStop(0.25, '#5ab872');
        gradient.addColorStop(0.45, '#d9d9d9');
        gradient.addColorStop(0.55, '#d9d9d9');
        gradient.addColorStop(0.75, '#e06060');
        gradient.addColorStop(1, '#8b0000');

        ctx.fillStyle = gradient;
        ctx.fillRect(legendLeft, legendTop, legendWidth, legendHeight);

        // Legend border
        ctx.strokeStyle = '#444444';
        ctx.lineWidth = 2;
        ctx.strokeRect(legendLeft, legendTop, legendWidth, legendHeight);

        // Legend title
        ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText('24h Change %', legendLeft - 10, legendTop - 20);

        // Legend labels
        ctx.font = '24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#aaaaaa';
        ctx.textAlign = 'left';

        const labels = ['+10%', '+5%', '0%', '-5%', '-10%'];
        const labelPositions = [0, 0.25, 0.5, 0.75, 1];
        labels.forEach((label, i) => {
            const yPos = legendTop + labelPositions[i] * legendHeight;
            ctx.fillText(label, legendLeft + legendWidth + 16, yPos + 8);
        });

        // Footer (scaled for 4K)
        const now = new Date();
        ctx.font = '28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#999999';
        ctx.textAlign = 'left';
        ctx.fillText(`Generated: ${now.toLocaleString()} | Data: Binance`, 80, canvas.height - 50);

        ctx.font = 'bold 32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#a855f7';
        ctx.textAlign = 'right';
        ctx.fillText('Powered by ClipX 🫧', canvas.width - 80, canvas.height - 50);

        // Download the image
        const link = document.createElement('a');
        const dateForFilename = now.toISOString().split('T')[0];
        link.download = `crypto-heatmap-${dateForFilename}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();

        console.log('[ClipX] Heatmap image exported successfully');
    }

    // ---------------- ALERT MANAGER LOGIC ----------------
    // Note: clipx-alert-manager-btn is not in the current HTML, assuming it will be added elsewhere or is a future feature.
    const managerBtn = document.getElementById('clipx-alert-manager-btn');
    const managerOverlay = document.getElementById('clipx-alert-manager');
    const marketContent = document.getElementById('clipx-market-content');
    const closeManagerBtn = document.getElementById('clipx-close-manager');
    const tabActive = document.getElementById('clipx-tab-active');
    const tabHistory = document.getElementById('clipx-tab-history');

    let currentTab = 'active';

    if (managerBtn) managerBtn.onclick = () => {
        marketContent.style.display = 'none';
        managerOverlay.style.display = 'flex';
        renderAlertManager();
    };

    if (closeManagerBtn) closeManagerBtn.onclick = () => {
        managerOverlay.style.display = 'none';
        marketContent.style.display = 'block';
    };

    if (tabActive) tabActive.onclick = () => {
        currentTab = 'active';
        tabActive.style.color = '#fff';
        tabHistory.style.color = '#71767b';
        renderAlertManager();
    };

    if (tabHistory) tabHistory.onclick = () => {
        currentTab = 'history';
        tabHistory.style.color = '#fff';
        tabActive.style.color = '#71767b';
        renderAlertManager();
    };

    function renderAlertManager() {
        const container = document.getElementById('clipx-alert-content');
        container.innerHTML = 'Loading...';

        if (currentTab === 'active') {
            chrome.storage.local.get(['priceAlerts'], (res) => {
                const alerts = res.priceAlerts || {};
                let html = '';
                let hasItems = false;

                for (let sym in alerts) {
                    if (alerts[sym].length > 0) {
                        hasItems = true;
                        alerts[sym].forEach(a => {
                            html += `
                                <div style="display:flex; justify-content:space-between; align-items:center; background:#1a1d21; padding:6px; border-radius:4px; margin-bottom:4px;">
                                    <div>
                                        <span style="color:#a855f7; font-weight:600;">${sym}</span> 
                                        <span style="color:#e7e9ea;">$${a.target}</span>
                                        <span style="color:#71767b; font-size:9px;">(${a.direction})</span>
                                    </div>
                                    <button class="clipx-delete-alert" data-symbol="${sym}" data-id="${a.id}" style="background:none; border:none; color:#ef4444; cursor:pointer;">&times;</button>
                                </div>
                            `;
                        });
                    }
                }

                if (!hasItems) html = '<div style="text-align:center; color:#71767b; padding:20px;">No active alerts.</div>';
                container.innerHTML = html;

                container.querySelectorAll('.clipx-delete-alert').forEach(btn => {
                    btn.onclick = () => {
                        const sym = btn.dataset.symbol;
                        const id = parseInt(btn.dataset.id); // Stored as number

                        chrome.storage.local.get(['priceAlerts'], (r) => {
                            const list = r.priceAlerts || {};
                            if (list[sym]) {
                                // Filter by ID or properties if ID missing logic for old versions? 
                                // We added ID in previous step.
                                list[sym] = list[sym].filter(x => x.id !== id);
                                chrome.storage.local.set({ priceAlerts: list }, () => {
                                    renderAlertManager(); // Refresh list
                                    // Also update bell icon in main view if needed?
                                    // It will update next time main view loads
                                    window.clipxAlertsCache = list;
                                });
                            }
                        });
                    };
                });
            });
        } else {
            chrome.storage.local.get(['alertHistory'], (res) => {
                const history = res.alertHistory || [];
                let html = '';

                if (history.length === 0) {
                    html = '<div style="text-align:center; color:#71767b; padding:20px;">No recent triggers.</div>';
                } else {
                    history.forEach(h => {
                        const time = new Date(h.time).toLocaleTimeString();
                        html += `
                            <div style="display:flex; justify-content:space-between; align-items:center; background:#1a1d21; padding:6px; border-radius:4px; margin-bottom:4px; opacity:0.8;">
                                <div>
                                    <span style="color:#22c55e; font-weight:600;">✔ ${h.symbol}</span> 
                                    <span style="color:#e7e9ea;">$${h.target}</span>
                                </div>
                                <span style="color:#71767b; font-size:9px;">${time}</span>
                            </div>
                        `;
                    });
                }
                container.innerHTML = html;
            });
        }
    }
    // -----------------------------------------------------

    // Add Feature Logic
    const addBtn = document.getElementById('clipx-add-feature-btn');
    const inputContainer = document.getElementById('clipx-add-feature-input-container');
    const input = document.getElementById('clipx-feature-input');
    const saveBtn = document.getElementById('clipx-feature-save');

    if (addBtn) {
        addBtn.onclick = () => {
            const isHidden = inputContainer.style.display === 'none';
            inputContainer.style.display = isHidden ? 'flex' : 'none';
            if (isHidden) input.focus();
            else input.value = '';
        };
    }

    if (saveBtn) {
        saveBtn.onclick = () => {
            const symbol = input.value.trim().toUpperCase();
            if (symbol) {
                chrome.storage.local.get(['featuredTickers'], (res) => {
                    const list = res.featuredTickers || [];
                    if (!list.includes(symbol)) {
                        list.push(symbol);
                        chrome.storage.local.set({ featuredTickers: list }, () => {
                            loadBinanceMarketData(); // Reload to show new ticker
                            input.value = '';
                            inputContainer.style.display = 'none';
                        });
                    }
                });
            }
        };
    }

    // Enter key support
    if (input) {
        input.onkeydown = (e) => {
            if (e.key === 'Enter') saveBtn.click();
            if (e.key === 'Escape') {
                input.value = '';
                inputContainer.style.display = 'none';
            }
        };
    }


    // Make widget draggable by header
    const header = widget.querySelector('div');
    if (header) {
        header.style.cursor = 'move';

        let isDragging = false;
        let startX, startY, startLeft, startTop;

        header.addEventListener('mousedown', (e) => {
            // Don't drag if clicking on buttons
            if (e.target.id === 'clipx-market-close' ||
                e.target.id === 'clipx-market-refresh' ||
                e.target.id === 'clipx-ws-status' ||
                e.target.closest('#clipx-add-feature-btn') || // Don't drag on + button
                e.target.closest('#clipx-add-feature-input-container')) return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;

            // Get current position (convert from right to left positioning)
            const rect = widget.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            // Switch from right to left positioning for dragging
            widget.style.left = startLeft + 'px';
            widget.style.top = startTop + 'px';
            widget.style.right = 'auto';

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;

            // Keep widget within viewport
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - widget.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - 100));

            widget.style.left = newLeft + 'px';
            widget.style.top = newTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }


    // Load initial data
    await loadBinanceMarketData();

    // Connect WebSocket for real-time updates
    connectBinanceWebSocket();

    // Fallback refresh every 60s for non-WS data
    window.clipxMarketRefreshInterval = setInterval(() => {
        if (document.getElementById('clipx-market-insight')?.style.display !== 'none') {
            // Only refresh if in market mode
            if (window.clipxWidgetMode === 'market') {
                loadBinanceMarketData();
            } else {
                loadSocialHypeData();
            }
        }
    }, 60000);

    // ============================================
    // MODE SWITCHING LOGIC
    // ============================================
    window.clipxWidgetMode = 'market'; // Default mode
    window.clipxHypeTimeRange = 24; // Default 24H
    window.clipxHypeNewTokensOnly = true; // Default to 30D new tokens
    window.clipxHypeActiveTab = 'trending'; // Default tab

    const modeMarketBtn = document.getElementById('clipx-mode-market');
    const modeHypeBtn = document.getElementById('clipx-mode-hype');
    const marketContentEl = document.getElementById('clipx-market-content');
    const hypeContentEl = document.getElementById('clipx-hype-content');

    if (modeMarketBtn && modeHypeBtn) {
        modeMarketBtn.onclick = () => {
            if (window.clipxWidgetMode === 'market') return;
            window.clipxWidgetMode = 'market';
            modeMarketBtn.style.background = '#8b5cf6';
            modeMarketBtn.style.color = 'white';
            modeHypeBtn.style.background = 'transparent';
            modeHypeBtn.style.color = '#71767b';

            const mEl = document.getElementById('clipx-market-content');
            const hEl = document.getElementById('clipx-hype-content');
            if (mEl) mEl.style.display = 'block';
            if (hEl) hEl.style.display = 'none';
        };

        modeHypeBtn.onclick = () => {
            if (window.clipxWidgetMode === 'hype') return;
            window.clipxWidgetMode = 'hype';
            modeHypeBtn.style.background = '#f97316';
            modeHypeBtn.style.color = 'white';
            modeMarketBtn.style.background = 'transparent';
            modeMarketBtn.style.color = '#71767b';

            const mEl = document.getElementById('clipx-market-content');
            const hEl = document.getElementById('clipx-hype-content');
            if (mEl) mEl.style.display = 'none';
            if (hEl) {
                hEl.style.display = 'block';
                hEl.style.minHeight = '200px'; // Force height to ensure visibility
            } else {
                console.error('[ClipX] Social Hype container not found!');
                alert('Error: Social Hype view container missing.');
            }

            // Load Social Hype data
            loadSocialHypeData().catch(e => {
                const hEl = document.getElementById('clipx-hype-content');
                if (hEl) hEl.innerHTML += `<div style="color:red; padding:10px;">Load Error: ${e.message}</div>`;
            });
        };
    }

    // Time range buttons
    document.querySelectorAll('.clipx-hype-time').forEach(btn => {
        btn.onclick = () => {
            const time = parseInt(btn.dataset.time);
            window.clipxHypeTimeRange = time;
            document.querySelectorAll('.clipx-hype-time').forEach(b => {
                b.style.background = 'transparent';
                b.style.color = '#71767b';
            });
            btn.style.background = '#f97316';
            btn.style.color = 'white';
            loadSocialHypeData();
        };
    });

    // 30D New Tokens checkbox
    const newTokensCheckbox = document.getElementById('clipx-new-tokens-only');
    if (newTokensCheckbox) {
        newTokensCheckbox.onchange = () => {
            window.clipxHypeNewTokensOnly = newTokensCheckbox.checked;
            loadSocialHypeData();
        };
    }

    // Tab switching
    document.querySelectorAll('.clipx-hype-tab').forEach(btn => {
        btn.onclick = () => {
            const tab = btn.dataset.tab;
            window.clipxHypeActiveTab = tab;
            document.querySelectorAll('.clipx-hype-tab').forEach(b => {
                b.style.background = 'transparent';
                b.style.color = '#71767b';
            });
            btn.style.background = '#f97316';
            btn.style.color = 'white';
            document.querySelectorAll('.clipx-hype-tab-content').forEach(c => c.style.display = 'none');
            const tabContent = document.getElementById(`clipx-hype-${tab}-tab`);
            if (tabContent) tabContent.style.display = 'block';
            loadSocialHypeData();
        };
    });


}

// ============================================
// SOCIAL HYPE DATA FUNCTIONS
// ============================================

// Helper to load images via background proxy (bypass CSP)
function loadProxyImages(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Find all images with data-proxy-src attribute
    const images = container.querySelectorAll('img[data-proxy-src]');
    if (images.length === 0) return;

    console.log(`[ClipX] Loading ${images.length} proxy images for ${containerId}`);

    images.forEach(img => {
        const url = img.getAttribute('data-proxy-src');
        if (!url) return;

        // Remove attribute so we don't try again
        img.removeAttribute('data-proxy-src');

        // Request blob from background
        chrome.runtime.sendMessage({ action: 'fetchImageBlob', url }, (response) => {
            if (response && response.success && response.dataUrl) {
                img.src = response.dataUrl;
                img.style.display = 'block';
            } else {
                console.warn('[ClipX] Failed to load proxy image:', url, response?.error);
                // Keep default placeholder/hidden state
            }
        });
    });
}

async function loadSocialHypeData() {
    const tab = window.clipxHypeActiveTab || 'trending';
    const timeRange = window.clipxHypeTimeRange || 24;
    const newTokensOnly = window.clipxHypeNewTokensOnly !== false;

    if (tab === 'trending') {
        await loadHypeLeaderboard(timeRange, newTokensOnly);
    } else if (tab === 'rising') {
        await loadHypeRising(timeRange, newTokensOnly);
    } else if (tab === 'mindshare') {
        await loadHypeMindshare(newTokensOnly);
    }
}

async function loadHypeLeaderboard(timeRange, newTokensOnly) {
    const container = document.getElementById('clipx-hype-leaderboard');
    if (!container) {
        console.error('[ClipX] Hype leaderboard container not found');
        return;
    }
    container.innerHTML = '<div style="text-align: center; color: #71767b; font-size: 11px; padding: 20px;">Loading trending tokens...</div>';

    try {
        console.log('[ClipX] Requesting leaderboard data with timeRange:', timeRange, 'newTokensOnly:', newTokensOnly);

        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                action: 'fetchSocialHypeLeaderboard',
                timeRange,
                newTokensOnly
            }, (res) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(res);
                }
            });
        });

        console.log('[ClipX] Leaderboard response:', response);

        if (response && response.success && response.tokens && response.tokens.length > 0) {
            container.innerHTML = response.tokens.slice(0, 15).map(token => renderHypeTokenCard(token)).join('');
            loadProxyImages('clipx-hype-leaderboard');
        } else {
            const errorMsg = response ? (response.error || 'Empty response') : 'No response from background';
            console.error('[ClipX] Leaderboard failed:', errorMsg);
            container.innerHTML = `<div style="text-align: center; color: #ef4444; font-size: 11px; padding: 20px;">No trending tokens found<br><small style="color:#71767b">(${errorMsg})</small></div>`;
        }
    } catch (e) {
        console.error('[ClipX] Hype leaderboard error:', e);
        container.innerHTML = `<div style="text-align: center; color: #ef4444; font-size: 11px; padding: 20px;">Failed to load data<br><small style="color:#71767b">${e.message}</small></div>`;
    }
}

async function loadHypeRising(timeRange, newTokensOnly) {
    const container = document.getElementById('clipx-hype-rising-list');
    if (!container) return;
    container.innerHTML = '<div style="text-align: center; color: #71767b; font-size: 11px; padding: 20px;">Loading rising tokens...</div>';

    try {
        const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'fetchSocialHypeRising',
                timeRange,
                newTokensOnly
            }, resolve);
        });

        if (response && response.success && response.tokens && response.tokens.length > 0) {
            container.innerHTML = response.tokens.slice(0, 15).map(token => renderHypeTokenCard(token, true)).join('');
            loadProxyImages('clipx-hype-rising-list');
        } else {
            container.innerHTML = '<div style="text-align: center; color: #ef4444; font-size: 11px; padding: 20px;">No rising tokens found</div>';
        }
    } catch (e) {
        console.error('[ClipX] Hype rising error:', e);
        container.innerHTML = '<div style="text-align: center; color: #ef4444; font-size: 11px; padding: 20px;">Failed to load data</div>';
    }
}

async function loadHypeMindshare(newTokensOnly) {
    const container = document.getElementById('clipx-mindshare-treemap');
    if (!container) return;
    container.innerHTML = '<div style="grid-column: span 5; text-align: center; color: #71767b; font-size: 11px; padding: 20px;">Loading mindshare...</div>';

    // === ENSURE PRICE CACHE IS READY ===
    if (!window.clipxPriceCache || Object.keys(window.clipxPriceCache).length === 0) {
        console.log('[ClipX] Price cache empty, forcing fetch for Mindshare...');
        try {
            await loadBinanceMarketData();
        } catch (e) {
            console.warn('[ClipX] Failed to pre-load market data:', e);
        }
    }

    try {
        const now = Date.now();
        const candidates = [
            1767628800000,
            now - 30 * 24 * 60 * 60 * 1000,
            now - 14 * 24 * 60 * 60 * 1000,
            now
        ];

        let gatheredTokens = [];

        // Loop candidates to find ONE valid timestamp
        for (const ts of candidates) {
            console.log('[ClipX] Trying Mindshare timestamp:', ts);

            // Try Page 1 first
            const p1 = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    action: 'fetchSocialHypeMindshare',
                    lookbackTime: ts,
                    newTokensOnly,
                    page: 1
                }, resolve);
            });

            if (p1 && p1.success && p1.mindshare && p1.mindshare.length > 0) {
                console.log('[ClipX] Found valid timestamp:', ts);
                gatheredTokens = [...p1.mindshare];

                // Found valid TS. Now fetch more pages to get enough tokens for 8x8 grid (need ~64)
                // Fetch up to page 10
                for (let page = 2; page <= 10; page++) {
                    const next = await new Promise((resolve) => {
                        chrome.runtime.sendMessage({
                            action: 'fetchSocialHypeMindshare',
                            lookbackTime: ts,
                            newTokensOnly,
                            page: page
                        }, resolve);
                    });

                    if (next && next.success && next.mindshare && next.mindshare.length > 0) {
                        gatheredTokens = [...gatheredTokens, ...next.mindshare];
                    } else {
                        break; // No more data
                    }
                }

                break; // Stop checking other candidates since we found data
            }
        }

        if (gatheredTokens.length > 0) {
            console.log('[ClipX] Mindshare GATHERED tokens before dedup:', gatheredTokens.length);

            // Deduplicate by symbol (Robust)
            const uniqueTokens = [];
            const seenSymbols = new Set();

            for (const t of gatheredTokens) {
                const rawSym = t.metaInfo?.symbol;
                if (!rawSym) continue;

                const sym = rawSym.trim().toUpperCase();
                if (!seenSymbols.has(sym)) {
                    seenSymbols.add(sym);

                    // === DATA ENRICHMENT ===
                    // Backfill Price Change from Real-Time Cache if available
                    // This fixes "Dynamic color according to last day comparison"
                    if (window.clipxPriceCache) {
                        const cacheKey = sym + 'USDT';
                        const cached = window.clipxPriceCache[cacheKey];
                        if (cached) {
                            if (!t.marketInfo) t.marketInfo = {};
                            // Prefer cached 24h change as it's real-time
                            t.marketInfo.priceChange = cached.change;
                            t.marketInfo.currentPrice = cached.price;
                        }
                    }

                    uniqueTokens.push(t);
                }
            }

            console.log('[ClipX] Mindshare UNIQUE tokens after dedup:', uniqueTokens.length);
            window.clipxMindshareData = uniqueTokens;
            renderMindshareTreemap(uniqueTokens);
        } else {
            container.innerHTML = `<div style="text-align: center; color: #ef4444; font-size: 11px; padding: 20px;">No mindshare data found<br><small style="color:#71767b">(Tried multiple time windows)</small></div>`;
        }

        // --- FETCH RISING FOR MINI-SECTION ---
        const risingContainer = document.getElementById('clipx-mindshare-rising-preview');
        if (risingContainer) {
            try {
                // Use same time range as page or default 24h
                chrome.runtime.sendMessage({
                    action: 'fetchSocialHypeRising',
                    timeRange: 24,
                    newTokensOnly // Pass the filter!
                }, (res) => {
                    if (res && res.success && res.tokens && res.tokens.length > 0) {
                        // Show top 10 rising
                        risingContainer.innerHTML = res.tokens.slice(0, 10).map(token => renderHypeTokenCard(token, true)).join('');
                        loadProxyImages('clipx-mindshare-rising-preview');
                    } else {
                        risingContainer.innerHTML = '<div style="color:#71767b; font-size:10px; text-align:center;">No rising data</div>';
                    }
                });
            } catch (err) { console.error(err); }
        }
    } catch (e) {
        console.error('[ClipX] Mindshare error:', e);
        container.innerHTML = '<div style="grid-column: span 4; text-align: center; color: #ef4444; font-size: 11px; padding: 20px;">Failed to load data</div>';
    }
}

function renderHypeTokenCard(token, isRising = false) {
    const meta = token.metaInfo || {};
    const hype = token.socialHypeInfo || {};
    const market = token.marketInfo || {};

    const symbol = meta.symbol || 'Unknown';
    // Logo URLs from Binance start with /images/ and need the static asset host
    const logoPath = meta.logo || '';
    const logoHost = 'https://bin.bnbstatic.com';
    let logo = '';

    if (logoPath) {
        if (logoPath.startsWith('http')) {
            logo = logoPath;
        } else if (logoPath.startsWith('/')) {
            logo = `${logoHost}${logoPath}`;
        } else {
            logo = `${logoHost}/${logoPath}`;
        }
    }
    const address = meta.contractAddress || '';

    const hypeScore = hype.socialHype || 0;
    const hypeFormatted = hypeScore >= 1000000 ? (hypeScore / 1000000).toFixed(1) + 'M' :
        hypeScore >= 1000 ? (hypeScore / 1000).toFixed(1) + 'K' : hypeScore;

    const sentiment = hype.sentiment || 'Neutral';
    const sentimentColor = sentiment === 'Positive' ? '#22c55e' : sentiment === 'Negative' ? '#ef4444' : '#71767b';
    const sentimentEmoji = sentiment === 'Positive' ? '😊' : sentiment === 'Negative' ? '😟' : '😐';

    const kolCount = hype.kolCount || 0;
    const aiSummary = hype.socialSummaryBrief || '';

    const mcap = market.marketCap || 0;
    const mcapFormatted = mcap >= 1000000000 ? '$' + (mcap / 1000000000).toFixed(1) + 'B' :
        mcap >= 1000000 ? '$' + (mcap / 1000000).toFixed(1) + 'M' :
            mcap >= 1000 ? '$' + (mcap / 1000).toFixed(1) + 'K' : '$' + mcap.toFixed(0);

    const priceChange = market.priceChange || 0;
    const changeColor = priceChange >= 0 ? '#22c55e' : '#ef4444';

    const hypeChange = isRising ? (token.hypeChange1h || token.hypeChange || 0) : 0;
    const hypeChangeFormatted = hypeChange >= 0 ? `+${hypeChange.toFixed(0)}%` : `${hypeChange.toFixed(0)}%`;

    return `
        <div style="background: #1a1d21; border-radius: 8px; padding: 10px; cursor: pointer; transition: all 0.2s; border: 1px solid transparent;" 
             onmouseenter="this.style.borderColor='#f97316'" onmouseleave="this.style.borderColor='transparent'"
             onclick="window.open('${address.startsWith('0x') ? `https://web3.binance.com/en/token/bsc/${address}` : `https://solscan.io/token/${address}`}', '_blank')">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                ${logo ? `<img src="" data-proxy-src="${logo}" style="width: 24px; height: 24px; border-radius: 50%; display: none;" onerror="this.style.display='none'">` : '<div style="width: 24px; height: 24px; border-radius: 50%; background: #2f3336; display: flex; align-items: center; justify-content: center; font-size: 10px;">?</div>'}
                <div style="font-weight: 700; font-size: 13px; color: #e7e9ea;">${symbol}</div>
                <div style="font-size: 10px; color: ${changeColor}; margin-left: auto;">${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(1)}%</div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <div style="font-size: 10px; color: #71767b;">Hype: <span style="color: #f97316; font-weight: 600;">${hypeFormatted}</span></div>
                ${isRising ? `<div style="font-size: 10px; color: #22c55e;">📈 ${hypeChangeFormatted}</div>` : ''}
                <div style="font-size: 10px; color: #71767b;">MCap: ${mcapFormatted}</div>
            </div>
            <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 4px;">
                <span style="font-size: 10px; color: ${sentimentColor};">${sentimentEmoji} ${sentiment}</span>
                <span style="font-size: 10px; color: #71767b;">👥 ${kolCount} KOLs</span>
            </div>
            ${aiSummary ? `<div style="font-size: 9px; color: #a1a1aa; margin-top: 4px; line-height: 1.3; border-top: 1px solid #2f3336; padding-top: 4px;">💡 ${aiSummary.slice(0, 80)}${aiSummary.length > 80 ? '...' : ''}</div>` : ''}
        </div>
    `;
}

function renderMindshareTreemap(tokens) {
    const container = document.getElementById('clipx-mindshare-treemap');
    if (!container) return;

    // Use dense grid for "Heatmap" style treemap
    container.style.display = 'grid';
    container.style.gridTemplateColumns = 'repeat(6, 1fr)';
    container.style.gridAutoRows = '60px'; // Slightly shorter rows for tall items
    container.style.gap = '4px';
    container.style.gridAutoFlow = 'dense';

    const totalHype = tokens.reduce((sum, t) => sum + (t.socialHypeInfo?.socialHype || 0), 0);

    // Render top 50
    container.innerHTML = tokens.slice(0, 50).map((token, index) => {
        const meta = token.metaInfo || {};
        const hype = token.socialHypeInfo || {};
        const market = token.marketInfo || {};

        const symbol = meta.symbol || '?';
        const hypeScore = hype.socialHype || 0;
        const share = totalHype > 0 ? ((hypeScore / totalHype) * 100).toFixed(1) : 0;
        const priceChange = market.priceChange || 0;

        // Market Cap Logic
        const mcap = market.marketCap || 0;
        const mcapFormatted = mcap >= 1000000000 ? '$' + (mcap / 1000000000).toFixed(2) + 'B' :
            mcap >= 1000000 ? '$' + (mcap / 1000000).toFixed(2) + 'M' :
                mcap >= 1000 ? '$' + (mcap / 1000).toFixed(2) + 'K' : '$' + mcap.toFixed(0);

        // Dynamic Sizing - Vertical Bias for "Columns" look
        let spanClass = '';
        let fontSize = '14px';
        const pct = parseFloat(share);

        if (pct >= 20) {
            spanClass = 'grid-column: span 2; grid-row: span 4;'; // Tall Tower
            fontSize = '24px';
        } else if (pct >= 10) {
            spanClass = 'grid-column: span 2; grid-row: span 3;'; // Tall Block
            fontSize = '20px';
        } else if (pct >= 5) {
            spanClass = 'grid-column: span 2; grid-row: span 2;'; // Square
            fontSize = '16px';
        } else if (pct >= 2) {
            spanClass = 'grid-column: span 1; grid-row: span 2;'; // Vertical sliver
            fontSize = '12px';
        } else {
            spanClass = 'grid-column: span 1; grid-row: span 1;'; // Small
            fontSize = '11px';
        }

        const bgColor = priceChange >= 5 ? '#166534' : priceChange >= 0 ? '#15803d' : priceChange >= -5 ? '#dc2626' : '#991b1b';

        // Logo Logic
        const logoPath = meta.logo || '';
        const logoHost = 'https://bin.bnbstatic.com';
        let logo = '';
        if (logoPath) {
            if (logoPath.startsWith('http')) logo = logoPath;
            else logo = `${logoHost}${logoPath.startsWith('/') ? '' : '/'}${logoPath}`;
        }

        // Inner Content Styling: Top-Left Text, Bottom-Right Logo
        return `
            <div style="background: ${bgColor}; border-radius: 6px; padding: 10px; position: relative; cursor: pointer; transition: all 0.2s; ${spanClass} overflow: hidden; display: flex; flex-direction: column; justify-content: flex-start; align-items: flex-start;"
                 onclick="window.open('${(meta.contractAddress || '').startsWith('0x') ? `https://web3.binance.com/en/token/bsc/${meta.contractAddress}` : `https://solscan.io/token/${meta.contractAddress}`}', '_blank')"
                 onmouseenter="this.style.opacity='0.9'" onmouseleave="this.style.opacity='1'">
                
                <!-- Watermark Logo -->
                ${logo ? `<img src="" data-proxy-src="${logo}" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 70%; opacity: 0.15; pointer-events: none; border-radius: 50%; display: none;" onerror="this.remove()">` : ''}

                <!-- Text Top Left -->
                <div style="font-size: ${fontSize}; font-weight: 800; color: white; line-height: 1.1; z-index:2; text-shadow: 0 1px 2px rgba(0,0,0,0.5);">${symbol}</div>
                <div style="font-size: ${parseInt(fontSize) * 0.6}px; color: rgba(255,255,255,0.9); margin-top: 4px; font-weight: 600; z-index:2; text-shadow: 0 1px 1px rgba(0,0,0,0.5);">${mcapFormatted}</div>
                <div style="font-size: ${parseInt(fontSize) * 0.55}px; color: rgba(255,255,255,0.7); margin-top: 2px; font-weight: 500; z-index:2;">${share}%</div>
                
                <!-- Tiny Logo Bottom Right -->
                ${logo ? `<img src="" data-proxy-src="${logo}" style="position: absolute; bottom: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; z-index:2; box-shadow: 0 2px 4px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); display: none;" onerror="this.remove()">` : ''}
            </div>
        `;
    }).join('');

    // Trigger image loading
    loadProxyImages('clipx-mindshare-treemap');
}

async function generateMindshareImage(tokens) {
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0f0f0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Title
    ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('Social Hype Mindshare - BSC 30D New Tokens', canvas.width / 2, 60);

    const totalHype = tokens.reduce((sum, t) => sum + (t.socialHypeInfo?.socialHype || 0), 0);

    // Sort logic & Deduplicate again just in case
    let uniqueList = [];
    const seen = new Set();
    // Sort descending by hype first
    const rawSorted = [...tokens].sort((a, b) => (b.socialHypeInfo?.socialHype || 0) - (a.socialHypeInfo?.socialHype || 0));

    // Enrich again just to be sure (in case cache updated since render)
    tokens.forEach(t => {
        const rawSym = t.metaInfo?.symbol;
        if (rawSym && window.clipxPriceCache) {
            const sym = rawSym.trim().toUpperCase();
            const cached = window.clipxPriceCache[sym + 'USDT'];
            if (cached && t.marketInfo) {
                t.marketInfo.priceChange = cached.change;
            }
        }
    });

    for (const t of rawSorted) {
        const s = t.metaInfo?.symbol;
        if (s) {
            const cleanS = s.trim().toUpperCase();
            if (!seen.has(cleanS)) {
                seen.add(cleanS);
                uniqueList.push(t);
            }
        }
    }

    // Take Top 64 for 8x8 grid
    const sortedTokens = uniqueList.slice(0, 64);

    // Grid Setup (8x8 Grid = 64 slots)
    const cols = 8;
    const rows = 8;
    const startX = 50, startY = 100;
    const gridW = canvas.width - 100;
    const gridH = canvas.height - 180;
    const cellW = gridW / cols;
    const cellH = gridH / rows;

    // Occupancy Map [col][row]
    const gridMap = Array(cols).fill(0).map(() => Array(rows).fill(false));

    function findSlot(w, h) {
        for (let r = 0; r <= rows - h; r++) { // Row first or Col first? Row first (scanline)
            for (let c = 0; c <= cols - w; c++) {
                // Check if slot free
                let fits = true;
                for (let i = 0; i < w; i++) {
                    for (let j = 0; j < h; j++) {
                        if (gridMap[c + i][r + j]) {
                            fits = false;
                            break;
                        }
                    }
                    if (!fits) break;
                }
                if (fits) return { c, r };
            }
        }
        return null;
    }

    function markSlot(c, r, w, h) {
        for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) {
                gridMap[c + i][r + j] = true;
            }
        }
    }

    sortedTokens.forEach((token) => {
        const hype = token.socialHypeInfo || {};
        const market = token.marketInfo || {};
        const priceChange = market.priceChange || 0;
        const hypeScore = hype.socialHype || 0;
        const share = totalHype > 0 ? ((hypeScore / totalHype) * 100).toFixed(1) : 0;
        const pct = parseFloat(share);

        // Determine Size - Match Widget Logic
        let w = 1, h = 1;
        let fontSizeTitle = 24;
        let fontSizeData = 16;

        if (pct >= 20) { w = 2; h = 4; fontSizeTitle = 48; fontSizeData = 28; } // Tall Tower
        else if (pct >= 10) { w = 2; h = 3; fontSizeTitle = 40; fontSizeData = 24; } // Tall Block
        else if (pct >= 5) { w = 2; h = 2; fontSizeTitle = 32; fontSizeData = 18; } // Square
        else if (pct >= 2) { w = 1; h = 2; fontSizeTitle = 24; fontSizeData = 14; } // Vertical Sliver
        else { w = 1; h = 1; fontSizeTitle = 20; fontSizeData = 12; }

        // Find placement
        let pos = findSlot(w, h);
        // If big doesn't fit, degrade gracefully
        if (!pos && h > 1) {
            h = Math.max(1, h - 1);
            pos = findSlot(w, h);
            if (!pos) { w = 1; h = 1; pos = findSlot(w, h); }
        }

        if (pos) {
            markSlot(pos.c, pos.r, w, h);

            const px = startX + pos.c * cellW + 4;
            const py = startY + pos.r * cellH + 4;
            const pw = w * cellW - 8;
            const ph = h * cellH - 8;

            // Draw Box
            ctx.fillStyle = priceChange >= 5 ? '#166534' : priceChange >= 0 ? '#15803d' : priceChange >= -5 ? '#dc2626' : '#991b1b';
            ctx.beginPath();
            ctx.roundRect(px, py, pw, ph, 8);
            ctx.fill();

            // Calculate Market Cap String
            const mcap = market.marketCap || 0;
            const mcapFormatted = mcap >= 1000000000 ? '$' + (mcap / 1000000000).toFixed(2) + 'B' :
                mcap >= 1000000 ? '$' + (mcap / 1000000).toFixed(2) + 'M' :
                    mcap >= 1000 ? '$' + (mcap / 1000).toFixed(2) + 'K' : '$' + mcap.toFixed(0);

            // Styled Text (Top Left)
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            // Symbol
            ctx.font = `bold ${fontSizeTitle}px sans-serif`;
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 4;
            ctx.fillText(token.metaInfo?.symbol || '?', px + 15, py + 15);
            ctx.shadowBlur = 0;

            // MCap
            ctx.font = `bold ${fontSizeData}px sans-serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillText(mcapFormatted, px + 15, py + 15 + fontSizeTitle + 8);

            // Hype %
            ctx.font = `500 ${Math.floor(fontSizeData * 0.9)}px sans-serif`;
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.fillText(`${share}%`, px + 15, py + 15 + fontSizeTitle + 8 + fontSizeData + 4);
        }
    });

    // Footer
    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('Powered by ClipX 🫧', canvas.width / 2, canvas.height - 40);

    // Download
    const link = document.createElement('a');
    link.download = `clipx_mindshare_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
}

function exportMindshareCSV(tokens) {
    const headers = ['Symbol', 'Address', 'Hype Score', 'Sentiment', 'KOL Count', 'Market Cap', 'Price Change %'];
    const rows = tokens.map(token => {
        const meta = token.metaInfo || {};
        const hype = token.socialHypeInfo || {};
        const market = token.marketInfo || {};
        return [
            meta.symbol || '',
            meta.contractAddress || '',
            hype.socialHype || 0,
            hype.sentiment || 'Neutral',
            hype.kolCount || 0,
            market.marketCap || 0,
            market.priceChange || 0
        ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const link = document.createElement('a');
    link.download = `clipx_mindshare_${Date.now()}.csv`;
    link.href = URL.createObjectURL(blob);
    link.click();
}

// Stablecoins to exclude
const EXCLUDED_BINANCE = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'FDUSD', 'USDD'];

// Connect to Binance WebSocket for real-time updates
function connectBinanceWebSocket() {
    if (window.clipxBinanceWs) window.clipxBinanceWs.close();

    const wsStatus = document.getElementById('clipx-ws-status');

    try {
        // Subscribe to mini ticker stream for all symbols
        window.clipxBinanceWs = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');

        window.clipxBinanceWs.onopen = () => {
            console.log('[ClipX] Binance WebSocket connected');
            if (wsStatus) {
                wsStatus.style.color = '#22c55e';
                wsStatus.textContent = 'WS●';
            }
        };

        window.clipxBinanceWs.onmessage = (event) => {
            const data = JSON.parse(event.data);
            updateRealTimePrices(data);
        };

        window.clipxBinanceWs.onerror = () => {
            if (wsStatus) {
                wsStatus.style.color = '#ef4444';
                wsStatus.textContent = 'WS✕';
            }
        };

        window.clipxBinanceWs.onclose = () => {
            if (wsStatus) {
                wsStatus.style.color = '#71767b';
                wsStatus.textContent = 'WS○';
            }
            // Reconnect after 5s
            setTimeout(connectBinanceWebSocket, 5000);
        };
    } catch (e) {
        console.error('[ClipX] WebSocket error:', e);
    }
}

// Update prices in real-time from WebSocket
function updateRealTimePrices(tickers) {
    const mainSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
    const pricesEl = document.getElementById('clipx-binance-prices');

    // Also update featured tickers
    let featuredList = [];
    chrome.storage.local.get(['featuredTickers'], (res) => {
        featuredList = res.featuredTickers || [];
    });

    if ((!pricesEl) || !window.clipxPriceCache) return;

    tickers.forEach(t => {
        // Update main symbols
        if (mainSymbols.includes(t.s)) {
            updatePriceUI(t);
        }

        // Update featured symbols (check if t.s matches featured + USDT)
        // We need the symbol from the ticker (e.g., SOLUSDT) to match featured (SOL)
        // Optimized:
        const cleanSym = t.s.replace('USDT', '');
        // We can't easily sync check storage inside here efficiently for every tick.
        // Rely on window.clipxPriceCache which should be populated by loadBinanceMarketData
        if (window.clipxPriceCache[t.s]) {
            updatePriceUI(t);
            checkPriceAlert(t);
        }
    });
}

function checkPriceAlert(t) {
    const symbol = t.s.replace('USDT', '');
    const price = parseFloat(t.c);
    const alerts = window.clipxAlertsCache?.[symbol];

    if (alerts && alerts.length > 0) {
        const triggeredIndices = [];
        alerts.forEach((alert, index) => {
            let triggered = false;
            if (alert.direction === 'up' && price >= alert.target) triggered = true;
            else if (alert.direction === 'down' && price <= alert.target) triggered = true;

            if (triggered) {
                if (window.showClipXToast) window.showClipXToast(`🔔 ${symbol} hit target $${alert.target}!`);

                // KACHING SOUND
                try {
                    const audio = new Audio(chrome.runtime.getURL('src/kaching.mp3'));
                    audio.volume = 0.5;
                    audio.play().catch(e => console.log('Audio play block:', e));
                } catch (e) { }

                triggeredIndices.push(index);

                // Save to History
                chrome.storage.local.get(['alertHistory'], (h) => {
                    const history = h.alertHistory || [];
                    history.unshift({ symbol, target: alert.target, price, time: Date.now() });
                    // Keep last 20
                    if (history.length > 20) history.pop();
                    chrome.storage.local.set({ alertHistory: history });
                });
            }
        });

        if (triggeredIndices.length > 0) {
            // Remove triggered alerts
            // We need to fetch fresh from storage to avoid race conditions? 
            // For simplicity, just read global, filter, save.
            chrome.storage.local.get(['priceAlerts'], (r) => {
                const current = r.priceAlerts || {};
                if (current[symbol]) {
                    // Filter out by ID if possible, or just by value
                    // We stored ID, so let's use it. 
                    const idsToRemove = triggeredIndices.map(i => alerts[i].id);
                    current[symbol] = current[symbol].filter(a => !idsToRemove.includes(a.id));
                    chrome.storage.local.set({ priceAlerts: current }, () => {
                        window.clipxAlertsCache = current; // Update local cache
                        loadBinanceMarketData(); // Refresh UI to remove bell color
                    });
                }
            });
        }
    }
}

function updatePriceUI(t) {
    const price = parseFloat(t.c);
    const cached = window.clipxPriceCache[t.s];
    if (cached) {
        cached.price = price;
        // Update UI
        const el = document.getElementById(`clipx-price-${t.s}`);
        if (el) {
            // Check if it's a featured small card or main card
            if (el.dataset.type === 'featured') {
                // For featured, maybe just update price?
                // Structure: <div>Sym</div> <div>Price</div> <div>Change</div>
                // No, in my main code I set ID on the price div: id="clipx-price-${ticker.symbol}"
                el.textContent = `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                el.style.color = price > cached.lastPrice ? '#22c55e' : price < cached.lastPrice ? '#ef4444' : '#e7e9ea';
            } else {
                el.textContent = `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                el.style.color = price > cached.lastPrice ? '#22c55e' : price < cached.lastPrice ? '#ef4444' : '#e7e9ea';
            }
            cached.lastPrice = price;
        }
    }
}

// Store for price cache
window.clipxPriceCache = {};

async function loadBinanceMarketData() {
    const binancePricesEl = document.getElementById('clipx-binance-prices');
    const featuredEl = document.getElementById('clipx-featured-tickers');
    const heatmapEl = document.getElementById('clipx-market-heatmap');
    const volumeEl = document.getElementById('clipx-volume-leaders');
    const gainersEl = document.getElementById('clipx-market-gainers');
    const losersEl = document.getElementById('clipx-market-losers');
    const trendingEl = document.getElementById('clipx-market-trending');
    const fearGreedValueEl = document.getElementById('clipx-fear-greed-value');
    const fearGreedLabelEl = document.getElementById('clipx-fear-greed-label');
    const fearGreedGaugeEl = document.getElementById('clipx-fear-greed-gauge');

    try {
        // Fetch Fear & Greed Index
        try {
            const fgRes = await fetch('https://api.alternative.me/fng/?limit=1');
            const fgData = await fgRes.json();
            if (fgData.data && fgData.data[0]) {
                const fg = fgData.data[0];
                const value = parseInt(fg.value);
                fearGreedValueEl.textContent = value;
                fearGreedLabelEl.textContent = fg.value_classification;

                // Color based on value
                let color;
                if (value <= 25) color = '#ef4444'; // Extreme Fear
                else if (value <= 45) color = '#f97316'; // Fear
                else if (value <= 55) color = '#eab308'; // Neutral
                else if (value <= 75) color = '#84cc16'; // Greed
                else color = '#22c55e'; // Extreme Greed

                fearGreedValueEl.style.color = color;
                fearGreedLabelEl.style.color = color;

                // Simple gauge visualization
                fearGreedGaugeEl.innerHTML = `
                    <svg width="80" height="40" viewBox="0 0 80 40">
                        <defs>
                            <linearGradient id="fgGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                                <stop offset="0%" style="stop-color:#ef4444"/>
                                <stop offset="25%" style="stop-color:#f97316"/>
                                <stop offset="50%" style="stop-color:#eab308"/>
                                <stop offset="75%" style="stop-color:#84cc16"/>
                                <stop offset="100%" style="stop-color:#22c55e"/>
                            </linearGradient>
                        </defs>
                        <rect x="0" y="30" width="80" height="6" rx="3" fill="#2f3336"/>
                        <rect x="0" y="30" width="${value * 0.8}" height="6" rx="3" fill="url(#fgGrad)"/>
                        <circle cx="${value * 0.8}" cy="33" r="5" fill="${color}" stroke="#fff" stroke-width="1"/>
                    </svg>
                `;
            }
        } catch (e) {
            fearGreedLabelEl.textContent = 'N/A';
        }

        // Fetch ALL Binance tickers
        const binanceRes = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        const allTickers = await binanceRes.json();

        // ---------------- FEATURED TICKERS ----------------
        chrome.storage.local.get(['featuredTickers', 'priceAlerts'], async (res) => {
            const featured = res.featuredTickers || [];
            // Alerts format: { "SOL": [ { target: 150, direction: 'up'|'down', id: 123 } ] }
            const alerts = res.priceAlerts || {};
            window.clipxAlertsCache = alerts;

            if (featured.length === 0) {
                if (featuredEl) featuredEl.innerHTML = '<div style="grid-column: span 3; color: #71767b; font-size: 10px; text-align: center; padding: 4px;">No featured tickers. Click + to add.</div>';
            } else {
                const featuredTickers = allTickers.filter(t => featured.includes(t.symbol.replace('USDT', '')));

                const orderedFeatured = [];
                featured.forEach(f => {
                    const found = featuredTickers.find(t => t.symbol === f + 'USDT');
                    if (found) orderedFeatured.push(found);
                    else orderedFeatured.push({ symbol: f + 'USDT', lastPrice: 0, priceChangePercent: 0, isMissing: true });
                });

                const featuredHtml = await Promise.all(orderedFeatured.map(async ticker => {
                    const symbol = ticker.symbol.replace('USDT', '');
                    if (ticker.isMissing) {
                        return `
                            <div style="background: #1a1d21; padding: 6px; border-radius: 6px; text-align: center; position:relative; border: 1px dashed #2f3336;">
                                <div style="font-size: 9px; color: #71767b; font-weight: 600;">${symbol}</div>
                                <div style="font-size: 10px; color: #ef4444;">Not Found</div>
                                <button class="clipx-remove-feature" data-symbol="${symbol}" style="position:absolute; top:2px; right:2px; background:none; border:none; color:#71767b; cursor:pointer; font-size:10px; padding:0; line-height:1;">&times;</button>
                            </div>
                         `;
                    }

                    const price = parseFloat(ticker.lastPrice);
                    const change = parseFloat(ticker.priceChangePercent);

                    window.clipxPriceCache[ticker.symbol] = { price, lastPrice: price, change };

                    // Sparkline
                    let sparklineSvg = '';
                    try {
                        const klineRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${ticker.symbol}&interval=1h&limit=12`);
                        const klines = await klineRes.json();
                        const closes = klines.map(k => parseFloat(k[4]));
                        const min = Math.min(...closes);
                        const max = Math.max(...closes);
                        const range = (max - min) || 1;
                        const points = closes.map((c, i) => `${i * 4},${20 - ((c - min) / range) * 18}`).join(' ');
                        const sparkColor = change >= 0 ? '#22c55e' : '#ef4444';
                        sparklineSvg = `<svg width="48" height="20" style="display:block;margin:2px auto;"><polyline points="${points}" fill="none" stroke="${sparkColor}" stroke-width="1.5"/></svg>`;
                    } catch (e) { }

                    const hasAlert = alerts[symbol] && alerts[symbol].length > 0;
                    const bellColor = hasAlert ? '#f3ba2f' : '#71767b';

                    return `
                        <div class="clipx-ticker-card" style="background: #1a1d21; padding: 6px; border-radius: 6px; text-align: center; position:relative;" data-symbol="${symbol}">
                            <div style="display:flex; justify-content:center; align-items:center; gap:4px;">
                                <div style="font-size: 9px; color: #a855f7; font-weight: 600;">${symbol}</div>
                                <span class="clipx-alert-btn" data-symbol="${symbol}" style="cursor:pointer; font-size:10px; color:${bellColor};" title="Set Price Alert">🔔</span>
                            </div>
                            <!-- Alert Input Overlay -->
                            <div id="clipx-alert-input-${symbol}" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; background:#1a1d21; border-radius:6px; z-index:10; flex-direction:column; justify-content:center; align-items:center; gap:2px;">
                                <input type="number" placeholder="Target $" style="width: 80%; background:#000; color:#fff; border:1px solid #3f3f46; font-size:10px; padding:2px; border-radius:3px; outline:none;" step="any">
                                <div style="display:flex; gap:4px;">
                                    <button class="clipx-save-alert" data-symbol="${symbol}" style="background:#22c55e; border:none; color:#fff; font-size:9px; padding:2px 6px; border-radius:2px; cursor:pointer;">Set</button>
                                    <button class="clipx-cancel-alert" data-symbol="${symbol}" style="background:#ef4444; border:none; color:#fff; font-size:9px; padding:2px 6px; border-radius:2px; cursor:pointer;">✕</button>
                                </div>
                            </div>
                            
                            <div id="clipx-price-${ticker.symbol}" data-type="featured" style="font-size: 12px; color: #e7e9ea; font-weight: 700;">$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                            ${sparklineSvg}
                            <div style="font-size: 9px; color: ${change >= 0 ? '#22c55e' : '#ef4444'};">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</div>
                            <button class="clipx-remove-feature" data-symbol="${symbol}" style="position:absolute; top:2px; right:2px; background:none; border:none; color:#71767b; cursor:pointer; font-size:10px; padding:0; line-height:1; display:none;">&times;</button>
                        </div>
                     `;
                }));

                if (featuredEl) {
                    featuredEl.innerHTML = featuredHtml.join('');

                    // Hover logic
                    featuredEl.querySelectorAll('.clipx-ticker-card').forEach(div => {
                        div.onmouseenter = () => div.querySelector('.clipx-remove-feature').style.display = 'block';
                        div.onmouseleave = () => div.querySelector('.clipx-remove-feature').style.display = 'none';
                    });

                    // Remove logic
                    featuredEl.querySelectorAll('.clipx-remove-feature').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const sym = btn.dataset.symbol;
                            chrome.storage.local.get(['featuredTickers'], (r) => {
                                let list = r.featuredTickers || [];
                                list = list.filter(item => item !== sym);
                                chrome.storage.local.set({ featuredTickers: list }, () => loadBinanceMarketData());
                            });
                        };
                    });

                    // Alert Logic
                    featuredEl.querySelectorAll('.clipx-alert-btn').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const sym = btn.dataset.symbol;
                            const overlay = document.getElementById(`clipx-alert-input-${sym}`);
                            const input = overlay.querySelector('input');
                            const currentPrice = window.clipxPriceCache[sym + 'USDT']?.price;
                            if (currentPrice) input.placeholder = currentPrice;

                            overlay.style.display = 'flex';
                            input.focus();
                        };
                    });

                    featuredEl.querySelectorAll('.clipx-cancel-alert').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const sym = btn.dataset.symbol;
                            document.getElementById(`clipx-alert-input-${sym}`).style.display = 'none';
                        };
                    });

                    featuredEl.querySelectorAll('.clipx-save-alert').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const sym = btn.dataset.symbol;
                            const overlay = document.getElementById(`clipx-alert-input-${sym}`);
                            const input = overlay.querySelector('input');
                            const target = parseFloat(input.value);

                            if (!isNaN(target)) {
                                const currentPrice = window.clipxPriceCache[sym + 'USDT']?.price || 0;
                                const direction = target > currentPrice ? 'up' : 'down';

                                chrome.storage.local.get(['priceAlerts'], (r) => {
                                    const allAlerts = r.priceAlerts || {};
                                    if (!allAlerts[sym]) allAlerts[sym] = [];
                                    allAlerts[sym].push({ target, direction, id: Date.now() });

                                    chrome.storage.local.set({ priceAlerts: allAlerts }, () => {
                                        if (window.showClipXToast) window.showClipXToast(`Alert set for ${sym} at $${target}`);
                                        overlay.style.display = 'none';
                                        loadBinanceMarketData(); // Redraw to update bell icon
                                    });
                                });
                            }
                        };
                    });
                }
            }
        });


        // Filter USDT pairs and exclude stablecoins
        const usdtPairs = allTickers
            .filter(t => t.symbol.endsWith('USDT') && !EXCLUDED_BINANCE.some(s => t.symbol.startsWith(s)))
            .map(t => ({
                symbol: t.symbol.replace('USDT', ''),
                price: parseFloat(t.lastPrice),
                change: parseFloat(t.priceChangePercent),
                volume: parseFloat(t.quoteVolume),
                raw: t
            }));

        // Main prices with sparklines
        const mainSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
        const mainTickers = allTickers.filter(t => mainSymbols.includes(t.symbol));

        // Fetch klines for sparklines
        const sparklineHtml = await Promise.all(mainTickers.map(async ticker => {
            const info = { BTCUSDT: { name: 'BTC', color: '#f7931a' }, ETHUSDT: { name: 'ETH', color: '#627eea' }, BNBUSDT: { name: 'BNB', color: '#f3ba2f' } };
            const price = parseFloat(ticker.lastPrice);
            const change = parseFloat(ticker.priceChangePercent);

            // Cache for WebSocket updates
            window.clipxPriceCache[ticker.symbol] = { price, lastPrice: price, change };

            // Get mini sparkline
            let sparklineSvg = '';
            try {
                const klineRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${ticker.symbol}&interval=1h&limit=12`);
                const klines = await klineRes.json();
                const closes = klines.map(k => parseFloat(k[4]));
                const min = Math.min(...closes);
                const max = Math.max(...closes);
                const range = max - min || 1;
                const points = closes.map((c, i) => `${i * 4},${20 - ((c - min) / range) * 18}`).join(' ');
                const sparkColor = change >= 0 ? '#22c55e' : '#ef4444';
                sparklineSvg = `<svg width="48" height="20" style="display:block;margin:2px auto;"><polyline points="${points}" fill="none" stroke="${sparkColor}" stroke-width="1.5"/></svg>`;
            } catch (e) { }

            return `
                <div style="background: #1a1d21; padding: 6px; border-radius: 6px; text-align: center;">
                    <div style="font-size: 9px; color: ${info[ticker.symbol]?.color || '#e7e9ea'}; font-weight: 600;">${info[ticker.symbol]?.name}</div>
                    <div id="clipx-price-${ticker.symbol}" style="font-size: 12px; color: #e7e9ea; font-weight: 700;">$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    ${sparklineSvg}
                    <div style="font-size: 9px; color: ${change >= 0 ? '#22c55e' : '#ef4444'};">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</div>
                </div>
            `;
        }));
        if (binancePricesEl) binancePricesEl.innerHTML = sparklineHtml.join('');

        // Heatmap from Binance (top 100 by volume for export, but display top 20 in UI)
        const heatmapCoins = usdtPairs.sort((a, b) => b.volume - a.volume).slice(0, 100);
        // Store globally for export feature
        window.clipxHeatmapData = heatmapCoins;
        const topCoins = heatmapCoins.slice(0, 20);
        if (heatmapEl) {
            heatmapEl.innerHTML = topCoins.map(coin => {
                let bgColor;
                if (coin.change >= 5) bgColor = '#07461f';
                else if (coin.change >= 2) bgColor = '#338350';
                else if (coin.change >= 0) bgColor = '#5e806a';
                else if (coin.change >= -2) bgColor = '#b36c6c';
                else if (coin.change >= -5) bgColor = '#ef4444';
                else bgColor = '#991b1b';

                return `
                    <div style="background: ${bgColor}; padding: 5px 3px; border-radius: 4px; text-align: center;" title="${coin.symbol}: ${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(2)}%">
                        <div style="font-size: 10px; font-weight: 600; color: #fff; text-shadow: 0 1px 1px rgba(0,0,0,0.5);">${coin.symbol}</div>
                        <div style="font-size: 9px; color: #fff;">${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(1)}%</div>
                    </div>
                `;
            }).join('');
        }

        // Volume leaders
        const volumeLeaders = usdtPairs.sort((a, b) => b.volume - a.volume).slice(0, 6);
        if (volumeEl) {
            volumeEl.innerHTML = volumeLeaders.map(c => {
                const volM = c.volume / 1000000;
                const volDisplay = volM >= 1000 ? `$${(volM / 1000).toFixed(1)}B` : `$${volM.toFixed(0)}M`;
                return `<span style="background: #2f3336; padding: 3px 8px; border-radius: 10px; font-size: 11px; color: #38bdf8;">${c.symbol} ${volDisplay}</span>`;
            }).join('');
        }


        // Filter coins with minimum $1M volume for gainers/losers (to exclude low-liquidity manipulation)
        const liquidCoins = usdtPairs.filter(c => c.volume >= 1000000);

        // Top Gainers - properly copy array before sorting
        const gainers = [...liquidCoins].sort((a, b) => b.change - a.change).slice(0, 4);
        if (gainersEl) {
            gainersEl.innerHTML = gainers.map(c => {
                const priceStr = c.price >= 1 ? `$${c.price.toFixed(2)}` : `$${c.price.toPrecision(3)}`;
                return `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 11px;">
                    <div>
                        <div style="color: #e7e9ea; font-weight: 500;">${c.symbol}</div>
                        <div style="color: #71767b; font-size: 10px;">${priceStr}</div>
                    </div>
                    <span style="color: #22c55e; font-weight: 600;">+${c.change.toFixed(1)}%</span>
                </div>
            `}).join('');
        }

        // Top Losers - properly copy array before sorting
        const losers = [...liquidCoins].sort((a, b) => a.change - b.change).slice(0, 4);
        if (losersEl) {
            losersEl.innerHTML = losers.map(c => {
                const priceStr = c.price >= 1 ? `$${c.price.toFixed(2)}` : `$${c.price.toPrecision(3)}`;
                return `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 11px;">
                    <div>
                        <div style="color: #e7e9ea; font-weight: 500;">${c.symbol}</div>
                        <div style="color: #71767b; font-size: 10px;">${priceStr}</div>
                    </div>
                    <span style="color: #ef4444; font-weight: 600;">${c.change.toFixed(1)}%</span>
                </div>
            `}).join('');
        }

        // Trending from CoinGecko
        if (trendingEl) {
            try {
                const trendRes = await fetch('https://api.coingecko.com/api/v3/search/trending');
                const trendData = await trendRes.json();
                const trends = trendData.coins.slice(0, 4);

                trendingEl.innerHTML = trends.map(item => {
                    const c = item.item;
                    return `
                        <div style="background: #2f3336; padding: 4px 8px; border-radius: 12px; display: flex; align-items: center; gap: 4px;">
                            <img src="${c.small}" style="width: 14px; height: 14px; border-radius: 50%;">
                            <span style="font-size: 11px; color: #e7e9ea; font-weight: 500;">${c.symbol}</span>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                trendingEl.innerHTML = '<span style="color: #71767b; font-size: 10px;">Unavailable</span>';
            }
        }

    } catch (error) {
        console.error('[ClipX] Binance data fetch error:', error);
        const liveIndicator = document.getElementById('clipx-live-indicator');
        if (liveIndicator) {
            liveIndicator.style.color = '#ef4444';
            liveIndicator.textContent = '● ERROR';
        }
    }
}

// Navigation observer — re-check storage before re-injecting
const marketObserver = new MutationObserver(() => {
    if (window.location.pathname.includes('/home') && marketInsightEnabled && !document.getElementById('clipx-market-insight')) {
        // Re-verify storage before injecting (prevents re-injection after toggle off)
        chrome.storage.local.get(['showMarketInsight'], (r) => {
            marketInsightEnabled = r.showMarketInsight !== false;
            if (marketInsightEnabled) {
                setTimeout(injectCryptoInsightWidget, 500);
            }
        });
    }
});
marketObserver.observe(document.body, { childList: true, subtree: true });

console.log('[ClipX] Crypto Market Insight widget with WebSocket ready');

// Toast Notification Helper
window.showClipXToast = (msg) => {
    let container = document.getElementById('clipx-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'clipx-toast-container';
        container.style.cssText = 'position:fixed; top:20px; right:20px; z-index:10000; display:flex; flex-direction:column; gap:10px; pointer-events:none;';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.cssText = `
        background: #1d9bf0; 
        color: white; 
        padding: 10px 16px; 
        border-radius: 8px; 
        box-shadow: 0 4px 12px rgba(0,0,0,0.3); 
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 13px;
        font-weight: 600;
        opacity: 0;
        transform: translateY(-20px);
        transition: all 0.3s ease;
        pointer-events: auto;
    `;

    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    // Remove after 3s
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
};

// ==========================================
// Timeline Miner & Daily Tasks Integration (Disabled per user request)
// ==========================================

(function () {
    return; // Disabled
    // Fallback API Base if not accessible
    const MINING_API_BASE = (typeof API_BASE !== 'undefined') ? API_BASE : 'https://clipx.app';

    let miningState = {
        dailyGems: [],
        remainingGems: [],
        pendingClaims: new Set()
    };

    // Initialize
    async function initMining() {
        console.log('[ClipX Miner] Initializing...');
        const storage = await chrome.storage.local.get(['authToken']);
        if (!storage.authToken) {
            console.log('[ClipX Miner] No auth token found');
            return;
        }

        // Fetch daily gems
        try {
            // First ensure we generate gems for the day
            await fetch(`${MINING_API_BASE}/api/mine/generate-daily`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${storage.authToken}` }
            });

            // Then get them
            const response = await fetch(`${MINING_API_BASE}/api/mine/daily-gems`, {
                headers: { 'Authorization': `Bearer ${storage.authToken}` }
            });
            const data = await response.json();
            if (data.success) {
                miningState.dailyGems = data.gems;
                miningState.remainingGems = data.gems.filter(g => !g.claimed);
                console.log(`[ClipX Miner] Loaded ${miningState.dailyGems.length} gems (${miningState.remainingGems.length} remaining)`);
            }
        } catch (e) {
            console.error('[ClipX Miner] Failed to load gems', e);
        }

        // Start Observer
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) {
                        if (node.tagName === 'ARTICLE' && node.getAttribute('data-testid') === 'tweet') {
                            processTweet(node);
                        } else if (node.querySelectorAll) {
                            const articles = node.querySelectorAll('article[data-testid="tweet"]');
                            articles.forEach(processTweet);
                        }
                    }
                });
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Initial scan
        document.querySelectorAll('article[data-testid="tweet"]').forEach(processTweet);

        // Setup Social Task Listeners
        setupTaskListeners();
    }

    // Process Tweet for Gem Injection
    function processTweet(article) {
        if (article.dataset.clipxGemProcessed) return;
        article.dataset.clipxGemProcessed = 'true';

        // Check if on ClipX profile
        const isClipXProfile = window.location.pathname.toLowerCase().includes('/clipx0_');

        // 15% chance normally, 100% chance on ClipX profile (if gems remaining)
        const chance = isClipXProfile ? 1.0 : 0.15;

        if (miningState.remainingGems.length > 0 && Math.random() < chance) {
            injectGem(article);
        }
    }

    function injectGem(article) {
        const gem = miningState.remainingGems[0];
        if (!gem) return;

        miningState.remainingGems.shift();

        const actionBar = article.querySelector('[role="group"]');
        if (!actionBar) return;

        const gemBtn = document.createElement('div');
        gemBtn.className = 'clipx-gem-button';
        // BIGGER SIZE + ANIMATION
        gemBtn.style.cssText = `
            display: flex; 
            align-items: center; 
            cursor: pointer; 
            margin-left: 12px;
            transition: transform 0.2s;
            opacity: 1;
            animation: clipx-pulse 2s infinite ease-in-out;
        `;
        gemBtn.title = `Tap to mine CLIPX!`;
        // Increased font size from 18px to 24px
        gemBtn.innerHTML = `<div style="font-size: 24px; filter: drop_shadow(0 0 8px rgba(59, 130, 246, 0.6));">💎</div>`;

        gemBtn.onmouseenter = () => {
            gemBtn.style.transform = 'scale(1.3) rotate(10deg)';
            gemBtn.style.animation = 'none'; // Stop pulse on hover
        };
        gemBtn.onmouseleave = () => {
            gemBtn.style.transform = 'scale(1) rotate(0deg)';
            gemBtn.style.animation = 'clipx-pulse 2s infinite ease-in-out';
        };

        gemBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            claimGem(gem, gemBtn);
        };

        // If on ClipX profile, limit to 1 gem per session to avoid spamming
        if (window.location.pathname.toLowerCase().includes('/clipx0_')) {
            if (window.hasInjectedClipXProfileGem) return;
            window.hasInjectedClipXProfileGem = true;
        }

        actionBar.appendChild(gemBtn);
    }

    async function claimGem(gem, btn) {
        if (btn.dataset.claiming) return;
        btn.dataset.claiming = 'true';
        btn.style.animation = 'none'; // Stop pulse when clicking

        // Add CSS for animations if not exists
        if (!document.getElementById('clipx-miner-styles')) {
            const s = document.createElement('style');
            s.id = 'clipx-miner-styles';
            s.textContent = `
                @keyframes spin { 100% { transform: rotate(360deg); } }
                @keyframes clipx-pulse {
                    0% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(59, 130, 246, 0)); }
                    50% { transform: scale(1.15); filter: drop-shadow(0 0 10px rgba(59, 130, 246, 0.6)); }
                    100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(59, 130, 246, 0)); }
                }
            `;
            document.head.appendChild(s);
        }

        btn.innerHTML = `<div style="font-size: 24px; animation: spin 1s infinite;">⏳</div>`;

        try {
            const storage = await chrome.storage.local.get(['authToken']);

            let realTweetId = 'unknown_' + Date.now();
            try {
                const timeLink = btn.closest('article').querySelector('time').closest('a');
                if (timeLink) {
                    const parts = timeLink.href.split('/status/');
                    if (parts.length > 1) {
                        realTweetId = parts[1].split('?')[0].split('/')[0];
                    }
                }
            } catch (e) { }

            const response = await fetch(`${MINING_API_BASE}/api/mine/claim`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${storage.authToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    tweetId: realTweetId,
                    gemPosition: gem.position
                })
            });

            const data = await response.json();
            if (data.success) {
                btn.innerHTML = `<span style="font-size: 16px; font-weight: 800; color: #10b981; text-shadow: 0 0 10px rgba(16,185,129,0.3);">+${Math.floor(data.amount)}</span>`;
                btn.style.cursor = 'default';
                btn.onclick = null;

                if (window.showClipXToast) {
                    window.showClipXToast(`Mined ${Math.floor(data.amount)} CLIPX!`);
                }
            } else {
                btn.innerHTML = `<span style="font-size: 24px;">❌</span>`;
                setTimeout(() => {
                    btn.innerHTML = `<div style="font-size: 24px;">💎</div>`;
                    btn.dataset.claiming = '';
                    btn.style.animation = 'clipx-pulse 2s infinite ease-in-out';
                }, 2000);
            }
        } catch (e) {
            console.error('Claim failed', e);
            btn.innerHTML = `❌`;
        }
    }

    // Social Task Auto-Detection
    let lastCapturedText = '';

    // Continuously capture text from any visible composer
    function captureComposerText() {
        const editors = document.querySelectorAll('[data-testid="tweetTextarea_0"], [role="textbox"][data-testid]');
        editors.forEach(ed => {
            if (ed.offsetParent !== null) {
                const txt = ed.innerText || ed.textContent || '';
                if (txt.trim().length > 0) {
                    lastCapturedText = txt;
                }
            }
        });
    }

    // Capture text frequently to catch it before submit clears it
    setInterval(captureComposerText, 500);

    function setupTaskListeners() {
        document.addEventListener('click', (e) => {
            const target = e.target;

            // Capture text immediately on click (before submit clears it)
            captureComposerText();
            const capturedText = lastCapturedText;
            console.log('[ClipX Tasks] Click detected, captured text:', capturedText);

            if (target.getAttribute && (target.getAttribute('data-testid') === 'tweetButtonInline' ||
                (target.closest && target.closest('[data-testid="tweetButtonInline"]')))) {
                console.log('[ClipX Tasks] Reply/inline tweet button clicked');
                checkPostContent('comment', capturedText);
            }

            if (target.getAttribute && (target.getAttribute('data-testid') === 'tweetButton' ||
                (target.closest && target.closest('[data-testid="tweetButton"]')))) {
                console.log('[ClipX Tasks] Main tweet button clicked');
                checkPostContent('post', capturedText);
            }

            if (target.getAttribute && (target.getAttribute('data-testid') === 'retweetConfirm' ||
                (target.closest && target.closest('[data-testid="retweetConfirm"]')))) {
                console.log('[ClipX Tasks] Retweet confirm clicked');
                handleTaskAction('repost_clipx');
            }
        }, true);
    }

    async function checkPostContent(type, preCapture) {
        // Use pre-captured text first
        let text = preCapture || '';

        // Also try to get current text as backup
        const editors = document.querySelectorAll('[data-testid="tweetTextarea_0"], [role="textbox"][data-testid]');
        editors.forEach(ed => {
            if (ed.offsetParent !== null) {
                text += ' ' + (ed.innerText || ed.textContent || '');
            }
        });

        const lowerText = text.toLowerCase();

        // Relaxed Detection Logic:
        // Check if we are "under" the ClipX handle (e.g. on their profile or replying to their tweet)
        const isClipXContext = window.location.href.toLowerCase().includes('clipx0_');

        console.log(`[ClipX Tasks] Checking ${type} content: "${text.trim().substring(0, 50)}..." (Context: ${isClipXContext})`);

        let taskType = null;
        if (type === 'post') {
            // New Post: Must explicitly mention ClipX
            if (text.includes('$CLIPX') || text.includes('@ClipX0_') || lowerText.includes('clipx')) {
                taskType = 'post_about_clipx';
            }
        } else if (type === 'comment') {
            // Reply: If context is ClipX, ANY text is valid. Otherwise need explicit mention.
            if (isClipXContext || text.includes('$CLIPX') || lowerText.includes('clipx')) {
                taskType = 'comment_with_clipx';
            }
        }

        if (taskType) {
            console.log('[ClipX Tasks] Task detected:', taskType);
            handleTaskAction(taskType);
        } else {
            console.log('[ClipX Tasks] No ClipX mention found in text (and not in ClipX context)');
        }
    }

    async function handleTaskAction(taskType) {
        const storage = await chrome.storage.local.get(['authToken']);
        if (!storage.authToken) return;

        try {
            console.log(`[ClipX Tasks] Attempting claim for ${taskType}`);
            const response = await fetch(`${MINING_API_BASE}/api/tasks/claim`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${storage.authToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    taskType,
                    tweetId: 'auto_' + Date.now().toString(36) + Math.random().toString(36).substr(2)
                })
            });

            const data = await response.json();
            if (data.success) {
                if (window.showClipXToast) {
                    window.showClipXToast(`Task Complete! +${data.reward} CLIPX`);
                }
            }
        } catch (e) {
            console.error('Task claim error', e);
        }
    }

    // Initialize after short delay
    setTimeout(initMining, 3000);

})();


// ==========================================
// Autonomous AI Profile Labeling
// ==========================================

(function () {
    console.log('[ClipX AI] Module Initialized');

    // Check Server Connection
    fetch((typeof API_BASE !== 'undefined') ? API_BASE.replace(/\/$/, '') : 'https://clipx.app')
        .then(() => console.log('[ClipX AI Debug] Server is reachable!'))
        .catch(e => console.error('[ClipX AI Debug] Server unreachable. Make sure "npm run dev" is running!', e));

    let lastScannedHandle = null;
    let isScanning = false;

    // Helper to get text content safely
    const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.innerText.trim() : '';
    };

    // Helper to parse follower count (e.g. "1.2M" -> 1200000)
    const parseCount = (str) => {
        if (!str) return 0;
        const n = parseFloat(str.replace(/,/g, ''));
        if (str.includes('M')) return n * 1000000;
        if (str.includes('K')) return n * 1000;
        return n;
    };

    async function scanProfile() {
        console.log('[ClipX AI Debug] scanProfile called. Path:', window.location.pathname);
        // Basic check for profile page (not home, explore, etc.)
        const checkPath = window.location.pathname;
        if (checkPath === '/home' || checkPath === '/explore' || checkPath === '/notifications' || checkPath.includes('/status/')) {
            // console.log('[ClipX AI Debug] Skipping path:', checkPath);
            return;
        }

        const handleFromUrl = checkPath.split('/')[1]; // e.g. /elonmusk -> elonmusk

        if (!handleFromUrl) return;

        if (handleFromUrl === lastScannedHandle) {
            console.log('[ClipX AI Debug] Already scanned:', handleFromUrl);
            return;
        }

        // Check availability of elements (wait a bit if needed)
        const nameEl = document.querySelector('div[data-testid="UserName"] span span:first-child');
        const bioEl = document.querySelector('div[data-testid="UserDescription"]');

        console.log('[ClipX AI Debug] Attempting scan for:', handleFromUrl, 'NameEl:', !!nameEl, 'BioEl:', !!bioEl);

        // If critical elements aren't there, maybe not loaded yet
        if (!nameEl && !bioEl) {
            console.log('[ClipX AI Debug] Waiting for profile elements...');
            return;
        }

        if (isScanning) return;
        isScanning = true;

        console.log('[ClipX AI] Scanning profile:', handleFromUrl);

        try {
            // Extract Data
            const name = nameEl ? nameEl.innerText : '';
            const bio = bioEl ? bioEl.innerText : '';
            const location = getText('[data-testid="UserLocation"]');

            console.log('[ClipX AI Debug] Extracted - Name:', name, 'Bio:', bio, 'Location:', location);

            // Followers
            // X DOM structure varies, but usually link to followers has the count
            const followersLink = document.querySelector(`a[href="/${handleFromUrl}/verified_followers"]`) || document.querySelector(`a[href="/${handleFromUrl}/followers"]`);
            let followersCount = 0;
            if (followersLink) {
                const countSpan = followersLink.querySelector('span'); // usually the number is in a span inside
                if (countSpan) followersCount = parseCount(countSpan.innerText);
                else followersCount = parseCount(followersLink.innerText); // fallback
            }

            // Verified
            const isVerified = !!document.querySelector('svg[data-testid="icon-verified"]');

            const payload = {
                handle: handleFromUrl,
                name,
                bio,
                description: bio, // alias
                location,
                followersCount,
                verified: isVerified
            };

            // Send to Background Script
            // We use chrome.runtime to pass to background, or we could fetch directly if CORS allows.
            // Since we are adding an API endpoint, let's try direct fetch first, if it fails we might need background proxy.
            // But content script usually can't make cross-origin requests unless listed in permissions (which localhost/clipx.app might not be for content script specifically).
            // However, the existing code uses `chrome.runtime.sendMessage` for token stuff.
            // Let's use `chrome.runtime.sendMessage` and handle the actual API call in background.js IF `content.js` doesn't support it.
            // Wait, lines 10335 above use `fetch` directly to `MINING_API_BASE`. So I can use fetch.

            // Get Auth Token (Optional for public AI)
            const storage = await chrome.storage.local.get(['authToken']);
            // if (!storage.authToken) { ... } // REMOVED to allow public access

            // Use global API_BASE from outer scope
            const targetApi = (typeof API_BASE !== 'undefined') ? API_BASE : 'https://clipx.app';

            const headers = { 'Content-Type': 'application/json' };
            if (storage.authToken) {
                headers['Authorization'] = `Bearer ${storage.authToken}`;
            }

            const res = await fetch(`${targetApi}/api/ai/analyze-profile`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            console.log('[ClipX AI] Analysis Result:', data);

            if (data.success && data.label) {
                // If success, we update our local cache so the label appears immediately
                // Or we rely on the extension's existing label fetching loop to pick it up eventually.
                // For better UX, let's force a refetch or optimistic update if possible.
                // chrome.runtime.sendMessage({ action: 'refreshLabels' }); // Hypothetical

                // Set last scanned to prevent loop
                lastScannedHandle = handleFromUrl;
            } else {
                if (data.reason === 'Label already exists' || data.reason === 'Request pending') {
                    lastScannedHandle = handleFromUrl; // Don't retry
                }
            }

        } catch (e) {
            console.error('[ClipX AI] Scan failed:', e);
        } finally {
            isScanning = false;
            // Debounce slightly to allow navigation to settle
            setTimeout(() => { if (lastScannedHandle !== handleFromUrl) lastScannedHandle = null; }, 10000);
        }
    }

    // Observer for navigation/loading
    // Replaced bodyObserver with robust URL polling for SPA
    let lastUrl = window.location.href;

    // Robust URL and State Checker
    setInterval(() => {
        const currentUrl = window.location.href;

        // 1. Detect URL Change
        if (currentUrl !== lastUrl) {
            console.log('[ClipX AI] URL Changed:', currentUrl);
            lastUrl = currentUrl;
            lastScannedHandle = null; // Force reset
            isScanning = false; // Safety reset
            // Delay scan slightly to allow DOM to settle
            setTimeout(scanProfile, 1500);
        }

        // 2. Retry Scan if on profile but not scanned
        const path = window.location.pathname;
        if (path.length > 2 && !path.includes('/home') && !lastScannedHandle) {
            // If we are on a profile page and haven't successfully scanned it yet
            // And we are not currently scanning (or isScanning is true but seemingly stuck?)
            // We'll let the debounce logic in scanProfile handle the frequency, so we can just call it here.
            // But to avoid spam, we'll check validity.

            // Check if we have Name/Bio elements
            if (document.querySelector('div[data-testid="UserName"]') && !isScanning) {
                scanProfile();
            }
        }
    }, 1000);

    // Initial Scan on Load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(scanProfile, 2000));
    } else {
        setTimeout(scanProfile, 2000);
    }

})();

// ==========================================
// User Categories Side Panel
// ==========================================

(function () {
    console.log('[ClipX Categories] Module Initialized');

    // Create Side Panel
    function createCategorySidePanel() {
        if (document.getElementById('clipx-category-panel')) return document.getElementById('clipx-category-panel');

        const panel = document.createElement('div');
        panel.id = 'clipx-category-panel';
        panel.style.cssText = `
            position: fixed;
            top: 0;
            right: -350px;
            width: 320px;
            height: 100vh;
            background: #000;
            border-left: 1px solid #333;
            z-index: 9999;
            transition: right 0.3s ease;
            box-shadow: -5px 0 15px rgba(0,0,0,0.5);
            display: flex;
            flex-direction: column;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        `;

        // Wrapper to isolate styles
        const content = document.createElement('div');
        content.style.cssText = `
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            background: #000;
            color: #fff;
        `;

        panel.appendChild(content);
        document.body.appendChild(panel);

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            padding: 16px;
            border-bottom: 1px solid #333;
            display: flex;
            flex-direction: column; /* Changed to column to accommodate back button */
            background: #111;
        `;

        const headerTop = document.createElement('div');
        headerTop.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
        `;

        headerTop.innerHTML = `
            <h2 style="margin:0; font-size: 18px; font-weight: 700; color: #fff;">Categories</h2>
            <button id="clipx-close-categories" style="background:none; border:none; color:#fff; font-size:20px; cursor:pointer;">×</button>
        `;
        header.appendChild(headerTop);

        // Back Button (Hidden by default)
        const backBtn = document.createElement('button');
        backBtn.id = 'clipx-category-back';
        backBtn.style.cssText = `
            display: none;
            margin-top: 10px;
            background: #333;
            border: none;
            color: #fff;
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            align-self: flex-start;
        `;
        backBtn.innerText = '← Back';
        header.appendChild(backBtn);

        content.appendChild(header);

        // Content Area
        const listArea = document.createElement('div');
        listArea.id = 'clipx-category-list';
        listArea.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 16px;
        `;
        content.appendChild(listArea);

        // Close Handler
        const closeBtn = panel.querySelector('#clipx-close-categories');
        if (closeBtn) {
            closeBtn.onclick = () => {
                panel.style.right = '-350px';
            };
        }

        // Back Handler
        backBtn.onclick = () => {
            renderCategories();
            backBtn.style.display = 'none';
            // Reset title
            const title = header.querySelector('h2');
            if (title) title.innerText = 'Categories';
        };

        return panel;
    }

    // Render Categories
    function renderCategories() {
        const listArea = document.getElementById('clipx-category-list');
        const backBtn = document.getElementById('clipx-category-back');
        if (!listArea) return;

        // Reset view
        listArea.innerHTML = '<div style="text-align:center; padding:20px; color: #888;">Loading...</div>';
        if (backBtn) backBtn.style.display = 'none';

        // Reset title
        const panel = document.getElementById('clipx-category-panel');
        if (panel) {
            const title = panel.querySelector('h2');
            if (title) title.innerText = 'Categories';
        }

        try {
            chrome.runtime.sendMessage({ action: 'getLabeledUsers' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Runtime error:', chrome.runtime.lastError);
                    listArea.innerHTML = '<div style="color:red; text-align:center;">Failed to connect to extension.</div>';
                    return;
                }

                if (!response || !response.success) {
                    listArea.innerHTML = `<div style="color:#ef4444; text-align:center;">Failed to load data.<br><small>${response?.error || 'Unknown error'}</small></div>`;
                    return;
                }

                const categories = response.categories || [];

                if (categories.length === 0) {
                    listArea.innerHTML = '<div style="text-align:center; padding:20px; color:#777;">No categories found.</div>';
                    return;
                }

                listArea.innerHTML = '';

                // Sort categories alphabetically
                categories.sort((a, b) => a.name.localeCompare(b.name));

                categories.forEach(cat => {
                    const item = document.createElement('div');
                    item.style.cssText = `
                        padding: 12px;
                        margin-bottom: 8px;
                        background: #16181c;
                        border: 1px solid #333;
                        border-radius: 8px;
                        cursor: pointer;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        transition: all 0.2s;
                    `;
                    item.onmouseover = () => {
                        item.style.background = '#1d1f23';
                        item.style.borderColor = '#1d9bf0';
                    };
                    item.onmouseout = () => {
                        item.style.background = '#16181c';
                        item.style.borderColor = '#333';
                    };

                    item.innerHTML = `
                        <span style="font-weight:600; font-size:15px; color: #e7e9ea;">${cat.name}</span>
                        <span style="background:#1d9bf0; color: white; padding:2px 8px; border-radius:12px; font-size:11px; font-weight: 700;">${cat.users.length}</span>
                    `;

                    item.onclick = () => renderUsers(cat.users, cat.name);
                    listArea.appendChild(item);
                });
            });
        } catch (e) {
            console.error('[ClipX Categories] Error:', e);
            listArea.innerHTML = '<div style="color:red; text-align:center;">Error loading data.</div>';
        }
    }

    // Render Users in a Category
    function renderUsers(users, categoryName) {
        const listArea = document.getElementById('clipx-category-list');
        const backBtn = document.getElementById('clipx-category-back');
        const panel = document.getElementById('clipx-category-panel');

        if (!listArea) return;

        if (backBtn) backBtn.style.display = 'block';

        // Update title
        if (panel) {
            const title = panel.querySelector('h2');
            if (title) title.innerText = categoryName;
        }

        listArea.innerHTML = '';

        if (!users || users.length === 0) {
            listArea.innerHTML = '<div style="padding:10px; color:#777; text-align: center;">No users in this category.</div>';
            return;
        }

        // Sort users by name
        users.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        users.forEach(user => {
            const userEl = document.createElement('a');
            userEl.href = `https://x.com/${user.handle}`;
            userEl.style.cssText = `
                display: flex;
                align-items: center;
                padding: 12px;
                margin-bottom: 8px;
                background: #16181c;
                border-radius: 8px;
                text-decoration: none;
                color: #fff;
                transition: background 0.2s;
            `;
            userEl.onmouseover = () => userEl.style.background = '#1d1f23';
            userEl.onmouseout = () => userEl.style.background = '#16181c';

            const avatar = user.avatar ?
                `<img src="${user.avatar}" style="width:40px; height:40px; border-radius:50%; margin-right:12px; object-fit: cover;">` :
                `<div style="width:40px; height:40px; border-radius:50%; background:#333; margin-right:12px; display:flex; align-items:center; justify-content:center; font-size: 16px;">?</div>`;

            userEl.innerHTML = `
                ${avatar}
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight:700; font-size:14px; color: #e7e9ea; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.name}</div>
                    <div style="color:#71767b; font-size:13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">@${user.handle}</div>
                </div>
                <div style="color: #1d9bf0; font-size: 14px;">›</div>
            `;
            listArea.appendChild(userEl);
        });
    }

    // Wait for body and inject
    const init = () => {
        // Category button removed as per user request (redundant with popup)
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
