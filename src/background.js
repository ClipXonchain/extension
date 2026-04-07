// ClipX Tipping Assistant - Background Service Worker
importScripts('../lib/ethers.js');

/** Production API only; `apiBase` in storage is normalized to this (no localhost). */
const PRODUCTION_API_BASE = 'https://clipx.app';
let API_BASE = PRODUCTION_API_BASE;

function normalizeApiBase(v) {
    if (typeof v !== 'string' || !v.trim()) return PRODUCTION_API_BASE;
    try {
        const u = new URL(v);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return PRODUCTION_API_BASE;
        return v.replace(/\/$/, '') || PRODUCTION_API_BASE;
    } catch {
        return PRODUCTION_API_BASE;
    }
}

/** Auth sync always targets production (clipx.app). */
function apiBaseFromAuthOrigin(_origin) {
    return PRODUCTION_API_BASE;
}

// Initialize API_BASE from storage; migrate any old localhost dev URL to production
chrome.storage.local.get(['apiBase'], (result) => {
    const next = normalizeApiBase(result.apiBase);
    API_BASE = next;
    if (result.apiBase !== next) {
        chrome.storage.local.set({ apiBase: next });
    }
    console.log('[ClipX Background] API_BASE initialized to:', API_BASE);
});

// Four.Meme Contract Addresses
const FOURMEME_TOKEN_MANAGER2 = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
const FOURMEME_HELPER3 = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034';
const FOURMEME_TOKEN_MANAGER_V1 = '0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC'; // Legacy support

let unlockedWallet = null;

// Cache for KOL data to avoid repeated API calls
let kolCache = null;
let kolCacheTime = 0;
const KOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Surf 7d sentiment: `/api/social-intel/detail` — shared by profile pill + timeline batch (dedup + TTL). */
const SENTIMENT_DETAIL_TTL_MS = 10 * 60 * 1000;
const SENTIMENT_DETAIL_MAX_ENTRIES = 400;
const sentimentDetailCache = new Map(); // key: `${apiBase}::${handleLower}` → { ts, detail }
const sentimentDetailInflight = new Map(); // key → Promise<detail>

function sentimentDetailCacheKey(handleLower) {
    return `${API_BASE}::${String(handleLower).toLowerCase()}`;
}

function sentimentDetailCachePruneIfNeeded() {
    while (sentimentDetailCache.size > SENTIMENT_DETAIL_MAX_ENTRIES) {
        const k = sentimentDetailCache.keys().next().value;
        if (k === undefined) break;
        sentimentDetailCache.delete(k);
    }
}

/**
 * @returns {Promise<{ ok: boolean, status: number, j: any }>}
 */
async function getOrFetchSentimentDetail(handleLower) {
    const key = sentimentDetailCacheKey(handleLower);
    const now = Date.now();
    const cached = sentimentDetailCache.get(key);
    if (cached && now - cached.ts < SENTIMENT_DETAIL_TTL_MS) {
        return cached.detail;
    }
    const inflight = sentimentDetailInflight.get(key);
    if (inflight) return inflight;

    const p = (async () => {
        try {
            const url = `${API_BASE}/api/social-intel/detail?q=${encodeURIComponent(handleLower)}&time_range=7d`;
            const r = await fetch(url, { headers: { Accept: 'application/json' } });
            let j = null;
            try {
                const text = await r.text();
                j = text ? JSON.parse(text) : null;
            } catch (e) {
                console.warn('[ClipX Background] sentiment detail JSON:', e);
                j = { error: { code: 'INVALID_JSON', message: 'response parse failed' } };
            }
            const detail = { ok: r.ok, status: r.status, j };
            sentimentDetailCache.set(key, { ts: Date.now(), detail });
            sentimentDetailCachePruneIfNeeded();
            return detail;
        } finally {
            sentimentDetailInflight.delete(key);
        }
    })();
    sentimentDetailInflight.set(key, p);
    return p;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.apiBase) return;
    const v = changes.apiBase.newValue;
    if (typeof v === 'string' && v) {
        API_BASE = normalizeApiBase(v);
        if (API_BASE !== v) chrome.storage.local.set({ apiBase: API_BASE });
    } else {
        API_BASE = PRODUCTION_API_BASE;
    }
    sentimentDetailCache.clear();
    sentimentDetailInflight.clear();
});

// Helper to clear expired auth tokens
async function clearExpiredAuthToken() {
    console.log('[ClipX Background] Clearing expired auth token from storage');
    await chrome.storage.local.remove(['authToken', 'webAuthToken', 'cachedBalance']);
    // Notify any open tabs that auth is expired
    chrome.runtime.sendMessage({ action: 'authExpired' }).catch(() => { });
}

// Auto-unlock helper - tries session first, then persistent storage
async function ensureWalletUnlocked() {
    if (unlockedWallet) return; // Already unlocked

    try {
        // First try session storage (for current browser session)
        const session = await chrome.storage.session.get(['unlockedPrivateKey', 'walletUnlocked']);
        if (session.walletUnlocked && session.unlockedPrivateKey) {
            unlockedWallet = new ethers.Wallet(session.unlockedPrivateKey);
            console.log('[ClipX Background] Auto-unlocked wallet from session');
            return;
        }

        // Fallback: Check persistent storage for unencrypted wallet (legacy or after first unlock)
        const local = await chrome.storage.local.get(['nativeWallet', 'walletPrivateKey']);

        // If there's a stored private key (user opted for "remember"), use it
        if (local.walletPrivateKey) {
            unlockedWallet = new ethers.Wallet(local.walletPrivateKey);
            // Also store in session for faster future access
            chrome.storage.session.set({
                unlockedPrivateKey: local.walletPrivateKey,
                walletUnlocked: true
            });
            console.log('[ClipX Background] Auto-unlocked wallet from persistent storage');
            return;
        }

        // If there's an unencrypted native wallet (legacy support)
        if (local.nativeWallet && local.nativeWallet.privateKey) {
            unlockedWallet = new ethers.Wallet(local.nativeWallet.privateKey);
            chrome.storage.session.set({
                unlockedPrivateKey: local.nativeWallet.privateKey,
                walletUnlocked: true
            });
            console.log('[ClipX Background] Auto-unlocked wallet from legacy storage');
            return;
        }
    } catch (e) {
        console.error('[ClipX Background] Auto-unlock failed:', e);
    }
}

// ── Binance Square API key encryption helpers (AES-GCM 256, Web Crypto) ──
const _SQ_ENC_SECRET = 'clipx-square-v1';
const _SQ_ENC_SALT = 'clipx-salt';

async function _sqDeriveKey(usage) {
    const enc = new TextEncoder();
    const keyMat = await crypto.subtle.importKey(
        'raw', enc.encode(_SQ_ENC_SECRET), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode(_SQ_ENC_SALT), iterations: 100000, hash: 'SHA-256' },
        keyMat, { name: 'AES-GCM', length: 256 }, false, [usage]
    );
}

async function encryptSquareKey(plaintext) {
    const enc = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await _sqDeriveKey('encrypt');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) };
}

async function decryptSquareKey(stored) {
    const key = await _sqDeriveKey('decrypt');
    const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(stored.iv) },
        key,
        new Uint8Array(stored.ct)
    );
    return new TextDecoder().decode(plain);
}

async function logSquarePost() {
    const { squarePostLog = [] } = await chrome.storage.local.get('squarePostLog');
    const now = Date.now();
    const filtered = squarePostLog.filter(t => now - t < 86400000);
    filtered.push(now);
    await chrome.storage.local.set({ squarePostLog: filtered });
    return filtered.length;
}

// Handle messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getProfileLabel') {
        getProfileLabel(request.handle).then(sendResponse);
        return true;
    }
    if (request.action === 'saveProfileLabel') {
        saveProfileLabel(request.handle, request.label, request.color).then(sendResponse);
        return true;
    }
    if (request.action === 'checkAuthStatus') {
        chrome.storage.local.get(['webAuthToken', 'authToken', 'webUserAddress', 'userAddress'], (result) => {
            // User is logged in if ANY auth token exists
            const hasToken = !!(result.webAuthToken || result.authToken);
            const address = result.webUserAddress || result.userAddress || null;

            console.log('[ClipX] checkAuthStatus:', { hasToken, address, webAuthToken: !!result.webAuthToken, authToken: !!result.authToken });

            sendResponse({
                isLoggedIn: hasToken,
                address: address
            });
        });
        return true; // Keep channel open for async response
    }

    if (request.action === 'sendTip') {
        handleSendTip(request, sendResponse);
        return true;
    }
    if (request.action === 'openPopup') {
        chrome.action.openPopup();
        sendResponse({ success: true });
    }

    // Open Binance Square with auto-focus for cross-posting
    if (request.action === 'openBinanceSquare') {
        chrome.tabs.create({
            url: request.url || 'https://www.binance.com/en/square',
            active: request.active !== false
        }, (tab) => {
            console.log('[ClipX] Opened Binance Square tab:', tab.id);
            sendResponse({ success: true, tabId: tab.id });
        });
        return true;
    }

    // ── Binance Square OpenAPI: Save encrypted API key ──
    if (request.action === 'saveSquareApiKey') {
        encryptSquareKey(request.key).then(enc => {
            chrome.storage.local.set({ squareApiKeyEnc: enc });
            sendResponse({ success: true });
        }).catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // ── Binance Square OpenAPI: Clear API key ──
    if (request.action === 'clearSquareApiKey') {
        chrome.storage.local.remove(['squareApiKeyEnc']);
        sendResponse({ success: true });
        return true;
    }

    // ── Binance Square OpenAPI: Get status (hasKey + 24h counter) ──
    if (request.action === 'getSquareStatus') {
        chrome.storage.local.get(['squareApiKeyEnc', 'squarePostLog'], (r) => {
            const now = Date.now();
            const log = (r.squarePostLog || []).filter(t => now - t < 86400000);
            const oldest = log.length > 0 ? log[0] : null;
            const resetsInMs = oldest ? (oldest + 86400000) - now : null;
            sendResponse({ hasKey: !!r.squareApiKeyEnc, count: log.length, resetsInMs });
        });
        return true;
    }

    // ── Binance Square OpenAPI: 1-click cross-post ──
    if (request.action === 'squarePost') {
        (async () => {
            try {
                const { squareApiKeyEnc } = await chrome.storage.local.get('squareApiKeyEnc');
                if (!squareApiKeyEnc) return sendResponse({ success: false, error: 'no_key' });

                const apiKey = await decryptSquareKey(squareApiKeyEnc);
                const res = await fetch(`${API_BASE}/api/square/post`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: request.text, apiKey })
                });
                const json = await res.json();
                if (json.success) {
                    const count = await logSquarePost();
                    sendResponse({ success: true, count });
                } else {
                    sendResponse({ success: false, error: json.error || 'API error' });
                }
            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    /* if (request.action === 'openOptionsPage') {
        chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
        return true;
    } */
    if (request.action === 'syncAuth') {
        // Don't let web/Twitter auth overwrite an active native wallet session
        chrome.storage.local.get(['authToken'], (current) => {
            const existing = current.authToken;

            // Always save the web auth for switching purposes
            const updates = {
                webAuthToken: request.authToken,
                webUserAddress: request.userAddress
            };

            // Always derive API from the login page origin so a prior dev session (localhost) cannot stick on production.
            API_BASE = apiBaseFromAuthOrigin(request.origin);
            updates.apiBase = API_BASE;
            console.log('[ClipX Background] API_BASE after sync auth:', API_BASE, 'origin:', request.origin);

            // Only overwrite active session if it's NOT a native wallet
            // Or if the user explicitely logged out (not handled here but assumes 'native-wallet' is set manually)
            if (existing !== 'native-wallet') {
                updates.authToken = request.authToken;
                updates.userAddress = request.userAddress;
            } else {
                console.log('[ClipX Background] Native wallet active. Saved web auth in background.');
            }

            chrome.storage.local.set(updates, () => {
                console.log('[ClipX Background] Auth synced');
                sendResponse({ success: true });
            });
        });
        return true;
    }
    if (request.action === 'checkAuth') {
        chrome.storage.local.get(['authToken'], (data) => {
            sendResponse({ isAuthenticated: !!data.authToken });
        });
        return true;
    }
    if (request.action === 'resolveTickerDexScreener') {
        handleResolveTickerDexScreener(request, sendResponse);
        return true;
    }
    if (request.action === 'fetchTokenInfo') {
        fetch(`https://api.dexscreener.com/latest/dex/tokens/${request.address}`)
            .then(res => res.json())
            .then(data => {
                if (data.pairs && data.pairs.length > 0) {
                    const vol = (p) => parseFloat((p.volume && p.volume.h24) || 0) || 0;
                    const bsc = data.pairs.filter((p) => p && p.chainId === 'bsc');
                    const pool = bsc.length ? bsc : data.pairs;
                    pool.sort((a, b) => vol(b) - vol(a));
                    const pair = pool[0];
                    sendResponse({
                        success: true,
                        symbol: pair.baseToken.symbol,
                        name: pair.baseToken.name,
                        priceUsd: pair.priceUsd,
                        priceChange: pair.priceChange ? pair.priceChange.h24 : 0,
                        // Use FDV or marketCap as an approximation for MC in USD
                        marketCapUsd: pair.fdv || pair.marketCap || null,
                        // New fields for Risk/Safety check
                        pairCreatedAt: pair.pairCreatedAt || null,
                        liquidityUsd: pair.liquidity ? pair.liquidity.usd : null,
                        // Optional logo/icon if DexScreener provides one
                        iconUrl: pair.info && pair.info.imageUrl ? pair.info.imageUrl : null
                    });
                } else {
                    sendResponse({ success: false });
                }
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
    if (request.action === 'fetchTrendingTokens') {
        // interval: '1m' | '5m' | '1h'
        const interval = request.interval || '5m';
        // GMGN BSC trending endpoint
        const url = `https://gmgn.ai/defi/quotation/v1/rank/token_trending?chain=bsc&interval=${interval}`;

        fetch(url)
            .then(res => res.json())
            .then(data => {
                if (data && data.data && Array.isArray(data.data.list)) {
                    const tokens = data.data.list.slice(0, 20).map(t => ({
                        name: t.token?.name || 'Unknown',
                        symbol: t.token?.symbol || '???',
                        address: t.token?.address || t.address,
                        priceUsd: t.price_usd || null,
                        change1m: t.change_rate_1m || 0,
                        change5m: t.change_rate_5m || 0,
                        change1h: t.change_rate_1h || 0,
                        volume24h: t.volume_24h || null
                    }));
                    sendResponse({ success: true, tokens });
                } else {
                    sendResponse({ success: false, error: 'No data' });
                }
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
    if (request.action === 'getTokenBalance') {
        handleGetTokenBalance(request, sendResponse);
        return true;
    }

    // TweetScout Smart Followers handler
    if (request.action === 'getTweetScoutInfo') {
        const handle = request.handle;
        if (!handle) {
            sendResponse({ success: false, error: 'Handle required' });
            return true;
        }

        const forceRefresh = request.forceRefresh || false;
        const onlyCache = request.onlyCache || false;

        console.log('[ClipX Background] Fetching TweetScout info for:', handle, 'Force Refresh:', forceRefresh, 'Only Cache:', onlyCache);

        fetch(`${API_BASE}/api/tweetscout/info/${encodeURIComponent(handle)}?force_refresh=${forceRefresh}&only_cache=${onlyCache}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        })
            .then(res => {
                if (!res.ok) throw new Error(`API error: ${res.status}`);
                return res.json();
            })
            .then(data => {
                console.log('[ClipX Background] TweetScout data received:', data);
                sendResponse({
                    success: true,
                    topFollowers: data.top_followers || [],
                    topFollowersCount: data.top_followers_count || 0,
                    categories: {
                        vcs: data.venture_capitals_count || 0,
                        kols: data.influencers_count || 0,
                        projects: data.projects_count || 0
                    },
                    handle_history: data.handle_history || [],
                    recent_follows: data.recent_follows || []
                });
            })
            .catch(err => {
                console.error('[ClipX Background] TweetScout fetch error:', err);
                sendResponse({ success: false, error: err.message });
            });

        return true;
    }

    // Sorsa API v3 — batch scores for timeline / inline feed avatar badges
    if (request.action === 'getSorsaScoresBatch') {
        const handles = request.handles;
        if (!Array.isArray(handles) || handles.length === 0) {
            sendResponse({ success: false, error: 'handles array required' });
            return true;
        }
        fetch(`${API_BASE}/api/sorsa/scores/batch`, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ handles: handles.slice(0, 50) })
        })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const msg = data.error || `API error: ${res.status}`;
                    console.error('[ClipX Background] Sorsa batch HTTP error:', res.status, msg);
                    sendResponse({
                        success: false,
                        error: msg,
                        scores: data.scores || {},
                        sorsaKeyConfigured: data.sorsaKeyConfigured,
                    });
                    return;
                }
                sendResponse({
                    success: true,
                    scores: data.scores || {},
                    sorsaKeyConfigured: data.sorsaKeyConfigured !== false,
                });
            })
            .catch((err) => {
                console.error('[ClipX Background] Sorsa scores batch error:', err);
                sendResponse({ success: false, error: err.message, scores: {} });
            });
        return true;
    }

    // Sorsa TweetScout score — single handle (profile Intel card + hero avatar; server-cached)
    if (request.action === 'getSorsaProfileScore') {
        const handle = request.handle;
        if (!handle) {
            sendResponse({ success: false, error: 'Handle required' });
            return true;
        }
        fetch(`${API_BASE}/api/sorsa/score/${encodeURIComponent(handle)}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
        })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const msg = data.error || `API error: ${res.status}`;
                    sendResponse({
                        success: false,
                        error: msg,
                        score: data.score != null ? data.score : null,
                        sorsaKeyConfigured: data.sorsaKeyConfigured !== false,
                    });
                    return;
                }
                sendResponse({
                    success: true,
                    score: data.score != null ? data.score : null,
                    username: data.username || handle.toLowerCase(),
                    source: data.source,
                    sorsaKeyConfigured: data.sorsaKeyConfigured !== false,
                });
            })
            .catch((err) => {
                console.error('[ClipX Background] Sorsa profile score error:', err);
                sendResponse({ success: false, error: err.message, score: null });
            });
        return true;
    }

    // Handle History - Separate dedicated endpoint (more efficient)
    if (request.action === 'getHandleHistory') {
        const handle = request.handle;
        if (!handle) {
            sendResponse({ success: false, error: 'Handle required' });
            return true;
        }

        console.log('[ClipX Background] Fetching Handle History for:', handle);

        fetch(`${API_BASE}/api/handle-history/${encodeURIComponent(handle)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        })
            .then(res => {
                if (!res.ok) {
                    // Check for rate limit
                    if (res.status === 429) {
                        return res.json().then(data => {
                            throw new Error(`Daily limit reached (${data.limit}/day)`);
                        });
                    }
                    throw new Error(`API error: ${res.status}`);
                }
                return res.json();
            })
            .then(data => {
                console.log('[ClipX Background] Handle History received:', data);
                sendResponse({
                    success: true,
                    handle_history: data.handle_history || [],
                    fromCache: data.fromCache || false
                });
            })
            .catch(err => {
                console.error('[ClipX Background] Handle History fetch error:', err);
                sendResponse({ success: false, error: err.message });
            });

        return true;
    }
    /** Native wallet creation runs in the service worker so X pages do not load ~470KB ethers.js */
    if (request.action === 'clipxGenerateNativeWallet') {
        (async () => {
            try {
                const w = ethers.Wallet.createRandom();
                const sessionId = crypto.randomUUID();
                await chrome.storage.session.set({
                    [`clipx_native_gen_${sessionId}`]: {
                        privateKey: w.privateKey,
                        at: Date.now(),
                    },
                });
                sendResponse({
                    success: true,
                    sessionId,
                    phrase: w.mnemonic.phrase,
                    address: w.address,
                });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }

    if (request.action === 'clipxFinalizeNativeWallet') {
        (async () => {
            try {
                const { sessionId, password } = request;
                if (!sessionId || !password) {
                    sendResponse({ success: false, error: 'Missing session or password' });
                    return;
                }
                const key = `clipx_native_gen_${sessionId}`;
                const data = await chrome.storage.session.get(key);
                const row = data[key];
                if (!row || !row.privateKey) {
                    sendResponse({
                        success: false,
                        error: 'Session expired. Close this and generate a new wallet.',
                    });
                    return;
                }
                const w = new ethers.Wallet(row.privateKey);
                const encryptedJson = await w.encrypt(password);
                await chrome.storage.session.remove(key);

                await chrome.storage.local.set({
                    authToken: 'native-wallet',
                    nativeWallet: {
                        address: w.address,
                        encrypted: encryptedJson,
                    },
                    userAddress: w.address,
                });

                unlockedWallet = new ethers.Wallet(row.privateKey);
                await chrome.storage.session.set({
                    unlockedPrivateKey: row.privateKey,
                    walletUnlocked: true,
                });
                await chrome.storage.local.set({ walletPrivateKey: row.privateKey });

                sendResponse({ success: true });
            } catch (e) {
                sendResponse({ success: false, error: e.message || String(e) });
            }
        })();
        return true;
    }

    if (request.action === 'unlockWallet') {
        try {
            unlockedWallet = new ethers.Wallet(request.privateKey);
            // Store in session for auto-unlock (current session)
            chrome.storage.session.set({
                unlockedPrivateKey: request.privateKey,
                walletUnlocked: true
            });
            // Also store in persistent local storage for auto-unlock across restarts
            // This keeps the wallet "unlocked forever" as user requested
            chrome.storage.local.set({
                walletPrivateKey: request.privateKey
            });
            sendResponse({ success: true });
        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }

    if (request.action === 'lockWallet') {
        unlockedWallet = null;
        // Clear session and persistent storage
        chrome.storage.session.remove(['unlockedPrivateKey', 'walletUnlocked']);
        chrome.storage.local.remove(['walletPrivateKey']);
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'checkWalletStatus') {
        sendResponse({ isUnlocked: !!unlockedWallet });
        return true;
    }

    if (request.action === 'getBnbBalance') {
        handleGetBnbBalance(request, sendResponse);
        return true;
    }
    if (request.action === 'swap') {
        console.log('[ClipX Background] Swap request received:', request);
        handleSwap(request, sendResponse);
        return true;
    }
    if (request.action === 'getWalletAssets') {
        handleGetWalletAssets(request, sendResponse);
        return true;
    }
    if (request.action === 'getTradeHistory') {
        handleGetTradeHistory(request, sendResponse);
        return true;
    }
    if (request.action === 'nativeTransfer') {
        handleNativeTransfer(request, sendResponse);
        return true;
    }
    if (request.action === 'getTokenMetadata') {
        handleGetTokenMetadata(request, sendResponse);
        return true;
    }
    if (request.action === 'fetchTokenList') {
        handleFetchTokenList(request, sendResponse);
        return true;
    }

    if (request.action === 'getWalletAddress') {
        chrome.storage.local.get(['authToken', 'userAddress', 'webUserAddress', 'walletPrivateKey', 'nativeWallet'], (result) => {
            // Case 1: User is authenticated via ClipX.app (web login)
            // In this case, use the web-synced wallet (dashboard wallet)
            if (result.authToken && result.authToken !== 'native-wallet') {
                const webWallet = result.userAddress || result.webUserAddress;
                if (webWallet && webWallet.startsWith('0x')) {
                    sendResponse({ address: webWallet, type: 'web' });
                    return;
                }
            }

            // Case 2: User is using native wallet (extension-managed wallet)
            if (unlockedWallet) {
                sendResponse({ address: unlockedWallet.address, type: 'native' });
                return;
            }

            // Case 3: Native wallet exists but is locked - derive address from private key
            if (result.walletPrivateKey) {
                try {
                    const wallet = new ethers.Wallet(result.walletPrivateKey);
                    sendResponse({ address: wallet.address, type: 'native' });
                    return;
                } catch (e) {
                    console.error('[ClipX] Failed to derive wallet:', e);
                }
            }

            // Case 4: Fallback to any available address
            sendResponse({ address: result.userAddress || result.webUserAddress || null, type: 'unknown' });
        });
        return true;
    }

    if (request.action === 'checkTokenRisk') {
        const address = request.address;
        if (!address) {
            sendResponse({ success: false, error: 'No address provided' });
            return true;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

        // Robust GMGN Fetcher - tries multiple endpoints and configurations
        const fetchGmgnData = async () => {
            const fetchWithTimeout = async (url, options = {}) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                try {
                    const res = await fetch(url, {
                        ...options,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);
                    return res;
                } catch (error) {
                    clearTimeout(timeoutId);
                    throw error;
                }
            };


            // Strategy 0: Axiom API (User Suggested - Highest Priority)
            try {
                console.log('[ClipX] Trying Strategy 0: Axiom API');
                const res = await fetchWithTimeout(`https://api4-bnb.axiom.trade/holders?tokenAddress=${address}`, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Cache-Control': 'no-cache'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    console.log('[ClipX] Strategy 0 Response:', data);
                    // Assuming structure based on standard APIs, check for direct count or data object
                    // Adjust this based on actual response if needed. 
                    // Common patterns: data.count, data.holders, or root property
                    const count = data.count || data.holders || data.totalHolders || (data.data && data.data.count);

                    // If response is just a number or simple object
                    if (typeof data === 'number') {
                        console.log('[ClipX] Strategy 0 Success (Direct Number):', data);
                        return { holder_count: data };
                    }

                    if (count) {
                        console.log('[ClipX] Strategy 0 Success:', count);
                        return { holder_count: count };
                    }
                }
            } catch (e) {
                console.log('[ClipX] Strategy 0 failed:', e.message);
            }

            // Strategy 1: User-provided VAS Endpoint
            try {
                // Using generic IDs similar to the user's sample to mimic a valid client request
                const vasUrl = `https://gmgn.ai/vas/api/v1/token_holders/bsc/${address}?device_id=53c1ee44-7492-48a6-b06e-4dac0f07c2b1&fp_did=315a020dd7d07d61942e9b8ae824c8df&client_id=gmgn_web_20251212-8743-9220237&from_app=gmgn&app_ver=20251212-8743-9220237&tz_name=Asia%2FDhaka&tz_offset=21600&app_lang=en-US&os=web&worker=0&limit=1&cost=20&orderby=last_active_timestamp&direction=desc`;
                console.log('[ClipX] Trying Strategy 1: VAS API');

                const res = await fetchWithTimeout(vasUrl, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Cache-Control': 'no-cache'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    console.log('[ClipX] Strategy 0 Response:', data);

                    // Check for holder_count in various possible locations in VAS response
                    if (data && data.data) {
                        // Sometimes int fields are directly in data, or in a nested property
                        const count = data.data.holder_count || data.data.total || data.data.count;
                        if (count) {
                            console.log('[ClipX] Strategy 0 Success:', count);
                            return { holder_count: count };
                        }
                    }
                }
            } catch (e) {
                console.log('[ClipX] Strategy 0 failed:', e.message);
            }

            // Strategy 1: Token Info Endpoint (No credentials)
            try {
                console.log('[ClipX] Trying GMGN Strategy 1: Token Info (No Creds)');
                const res = await fetchWithTimeout(`https://gmgn.ai/defi/quotation/v1/tokens/bsc/${address}`, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Cache-Control': 'no-cache'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.data && data.data.holder_count) {
                        console.log('[ClipX] Strategy 1 Success:', data.data.holder_count);
                        return data.data;
                    }
                }
            } catch (e) {
                console.log('[ClipX] Strategy 1 failed:', e.message);
            }

            // Strategy 2: Top Holders Endpoint (No credentials)
            try {
                console.log('[ClipX] Trying GMGN Strategy 2: Top Holders (No Creds)');
                const res = await fetchWithTimeout(`https://gmgn.ai/defi/quotation/v1/tokens/top_holders/bsc/${address}?orderby=amount_percentage&direction=desc&limit=1`, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Cache-Control': 'no-cache'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.data) {
                        // Check widely for holder count properties
                        const count = data.data.holder_count || data.data.holderCount;
                        if (count) {
                            console.log('[ClipX] Strategy 2 Success:', count);
                            return { holder_count: count };
                        }
                    }
                }
            } catch (e) {
                console.log('[ClipX] Strategy 2 failed:', e.message);
            }

            // Strategy 3: Try api.gmgn.ai domain
            try {
                console.log('[ClipX] Trying GMGN Strategy 3: api.gmgn.ai');
                const res = await fetchWithTimeout(`https://api.gmgn.ai/defi/quotation/v1/tokens/bsc/${address}`, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Cache-Control': 'no-cache'
                    }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.data && data.data.holder_count) {
                        console.log('[ClipX] Strategy 3 Success:', data.data.holder_count);
                        return data.data;
                    }
                }
            } catch (e) {
                console.log('[ClipX] Strategy 3 failed:', e.message);
            }

            return null;
        };

        // Fetch both GoPlus and GMGN data in parallel with independent error handling
        Promise.all([
            fetch(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${address}`, { signal: controller.signal })
                .then(res => res.json())
                .catch(err => {
                    console.log('[ClipX] GoPlus fetch failed:', err.message);
                    return { code: 0 }; // Return dummy failed response
                }),
            fetchGmgnData()
        ])
            .then(([goPlusData, gmgnTokenData]) => {
                clearTimeout(timeoutId);

                // Process GoPlus data (if successful)
                let result = {};
                let isGoPlusSuccess = false;

                if (goPlusData && goPlusData.code === 1 && goPlusData.result && goPlusData.result[address.toLowerCase()]) {
                    result = goPlusData.result[address.toLowerCase()];
                    isGoPlusSuccess = true;
                }

                // Use GMGN/Axiom holder count if available, otherwise fall back to GoPlus
                let holderCount;
                let dataSource;

                if (gmgnTokenData && gmgnTokenData.holder_count) {
                    holderCount = gmgnTokenData.holder_count;
                    dataSource = 'GMGN'; // Or 'Axiom' if we tracked it better, but GMGN green badge is fine for "Trusted"
                } else {
                    // Fallback to GoPlus, but if it's 0 or we want accuracy, try to ping Honeypot.is directly inside the extension
                    holderCount = result.holder_count || 'N/A';
                    dataSource = result.holder_count ? 'GoPlus' : 'Unavailable';
                }

                // --- Async fallback to get precise holder count from BscScan or honeypot.is if needed ---
                if (holderCount === 'N/A' || holderCount === 0 || holderCount === '0') {
                    console.log('[ClipX] Falling back to BscScan for accurate holders...');
                    return fetch(`https://bscscan.com/token/generic-tokenholders2?m=normal&a=${address}`, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                        signal: controller.signal
                    })
                        .then(res => res.text())
                        .then(html => {
                            const match = html.match(/a total of ([\d,]+) holders/i) || html.match(/>([\d,]+)\s*holders/i);
                            if (match && match[1]) {
                                holderCount = match[1].replace(/,/g, '');
                                dataSource = 'BscScan';
                                return { result, holderCount, dataSource, isGoPlusSuccess, gmgnTokenData };
                            }
                            throw new Error("Holder count not found in BscScan HTML");
                        })
                        .catch(err => {
                            console.log('[ClipX] BscScan fallback failed:', err.message, '- Trying honeypot.is...');
                            return fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${address}`, { signal: controller.signal })
                                .then(res => res.json())
                                .then(hdata => {
                                    if (hdata && hdata.token && hdata.token.totalHolders) {
                                        holderCount = hdata.token.totalHolders;
                                        dataSource = 'Honeypot.is';
                                    }
                                    return { result, holderCount, dataSource, isGoPlusSuccess, gmgnTokenData };
                                })
                                .catch(e => ({ result, holderCount, dataSource, isGoPlusSuccess, gmgnTokenData }));
                        });
                }
                return { result, holderCount, dataSource, isGoPlusSuccess, gmgnTokenData };
            })
            .then(({ result, holderCount, dataSource, isGoPlusSuccess, gmgnTokenData }) => {
                console.log('[ClipX] Final holder count:', holderCount, 'Source:', dataSource);
                console.log('[ClipX] GoPlus holder_count:', result.holder_count);

                if (isGoPlusSuccess) {
                    sendResponse({
                        success: true,
                        data: {
                            is_honeypot: result.is_honeypot === "1",
                            buy_tax: (parseFloat(result.buy_tax || 0) * 100).toFixed(1),
                            sell_tax: (parseFloat(result.sell_tax || 0) * 100).toFixed(1),
                            is_open_source: result.is_open_source === "1",
                            is_proxy: result.is_proxy === "1",
                            is_mintable: result.is_mintable === "1",
                            owner_address: result.owner_address,
                            cannot_sell_all: result.cannot_sell_all === "1",
                            holder_count: holderCount,
                            holder_data_source: dataSource,
                            lp_holder_count: result.lp_holder_count,
                            holders: result.holders, // Array of top holders if available
                            is_bonded: gmgnTokenData ? (gmgnTokenData.is_bonded || false) : false
                        }
                    });
                } else {
                    sendResponse({ success: false, error: 'No risk data found' });
                }
            })
            .catch(err => {
                clearTimeout(timeoutId);
                const errorMsg = err.name === 'AbortError' ? 'Request timed out' : err.message;
                sendResponse({ success: false, error: errorMsg });
            });
        return true;
    }
    if (request.action === 'fetchTopHolders') {
        handleFetchTopHolders(request, sendResponse);
        return true;
    }
    if (request.action === 'fetchSocialMetrics') {
        handleFetchSocialMetrics(request, sendResponse);
        return true;
    }
    if (request.action === 'checkLocalKols') {
        const addresses = request.addresses;
        if (!addresses || !Array.isArray(addresses)) {
            sendResponse({ success: false, error: 'Invalid addresses' });
            return true;
        }

        (async () => {
            // Ensure cache is loaded
            let kolMap = kolCache;
            const now = Date.now();
            if (!kolMap || (now - kolCacheTime) >= KOL_CACHE_TTL) {
                try {
                    const res = await fetch(`${API_BASE}/api/kol/all`);
                    if (res.ok) {
                        const data = await res.json();
                        if (data.success && data.kols) {
                            kolMap = {};
                            data.kols.forEach(k => {
                                kolMap[k.address.toLowerCase()] = k;
                            });
                            kolCache = kolMap;
                            kolCacheTime = now;
                        }
                    } else {
                        console.error('KOL fetch failed with status:', res.status);
                        sendResponse({ success: true, matches: {}, totalLoaded: 0, error: `HTTP ${res.status}` });
                        return;
                    }
                } catch (e) {
                    console.error('Failed to load KOLs for check:', e);
                    sendResponse({ success: true, matches: {}, totalLoaded: 0, error: e.message });
                    return;
                }
            }

            if (!kolMap) {
                sendResponse({ success: true, matches: {}, totalLoaded: 0, error: 'Init failed' });
                return;
            }

            const matches = {};
            addresses.forEach(addr => {
                const lower = addr.toLowerCase();
                if (kolMap[lower]) {
                    matches[lower] = kolMap[lower];
                }
            });

            sendResponse({ success: true, matches, totalLoaded: Object.keys(kolMap).length });
        })();
        return true;
    }
    if (request.action === 'scanAllLocalKols') {
        handleScanAllLocalKols(request, sendResponse);
        return true;
    }

    // --- Wallet RPC Handler for GMGN Integration ---
    if (request.action === 'walletRequest') {
        handleWalletRequest(request, sendResponse);
        return true; // async
    }

    // --- Four.Meme Token Info ---
    if (request.action === 'getFourMemeTokenInfo') {
        handleGetFourMemeTokenInfo(request, sendResponse);
        return true;
    }

    // --- Fetch User Tweets for ClipX Intel ---
    if (request.action === 'fetchUserTweets') {
        handleFetchUserTweets(request, sendResponse);
        return true;
    }

    // --- Social Intelligence (ClipX server → Surf proxy) ---
    if (request.action === 'socialIntelFetch') {
        const map = {
            detail: 'detail',
            posts: 'posts',
            searchPeople: 'search-people',
            mindshare: 'mindshare',
            ranking: 'ranking',
            smartFollowersHistory: 'smart-followers-history',
            tweets: 'tweets',
            user: 'user',
            userPosts: 'user-posts',
            health: 'health',
        };
        const seg = map[request.resource];
        if (!seg) {
            sendResponse({ ok: false, error: 'unknown_social_intel_resource' });
            return true;
        }
        const sp = new URLSearchParams(request.params || {});
        fetch(`${API_BASE}/api/social-intel/${seg}?${sp.toString()}`, {
            headers: { Accept: 'application/json' },
        })
            .then((r) =>
                r.json().then((json) => ({ status: r.status, json })),
            )
            .then(({ status, json }) => {
                sendResponse({
                    ok: status >= 200 && status < 300,
                    status,
                    data: json,
                });
            })
            .catch((err) => {
                console.error('[ClipX Background] socialIntelFetch:', err);
                sendResponse({ ok: false, error: err.message || String(err) });
            });
        return true;
    }

    /**
     * Profile: 7d sentiment from Surf (via ClipX `/api/social-intel/detail` only).
     * Single request — sentiment lives on `social/detail`, not on `social/user`.
     */
    if (request.action === 'socialIntelProfile') {
        const h = (request.handle || '').trim().replace(/^@/, '');
        if (!h) {
            sendResponse({ success: false, error: 'handle_required' });
            return true;
        }
        const handleLower = h.toLowerCase();
        getOrFetchSentimentDetail(handleLower)
            .then((detail) => {
                sendResponse({ success: true, detail });
            })
            .catch((err) => {
                console.error('[ClipX Background] socialIntelProfile:', err);
                sendResponse({ success: false, error: err.message || String(err) });
            });
        return true;
    }

    /** Timeline: detail only (sentiment); max 8 handles per batch */
    if (request.action === 'socialIntelBatchTimeline') {
        const raw = request.handles || [];
        const handles = [...new Set(raw.map((x) => String(x).toLowerCase().replace(/^@/, '')))].filter(Boolean).slice(0, 8);
        if (handles.length === 0) {
            sendResponse({ success: true, byHandle: {} });
            return true;
        }
        Promise.all(
            handles.map((h) =>
                getOrFetchSentimentDetail(h).then(
                    (d) => ({ h, detail: { ok: d.ok, j: d.j } }),
                    () => ({ h, detail: { ok: false, j: {} } }),
                ),
            ),
        )
            .then((rows) => {
                const byHandle = {};
                rows.forEach(({ h, detail }) => {
                    byHandle[h] = { detail };
                });
                sendResponse({ success: true, byHandle });
            })
            .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
        return true;
    }

    // --- Mindshare API ---
    if (false && request.action === 'fetchSocialHypeMindshare') {
        const { lookbackTime, newTokensOnly, page } = request;
        const query = new URLSearchParams({
            lookbackTime: lookbackTime || '',
            newTokensOnly: newTokensOnly || 'true',
            page: page || '1',
            limit: '50'
        }).toString();

        console.log('[ClipX Background] Fetching Mindshare:', query);

        fetch(`${API_BASE}/api/social-hype/mindshare?${query}`, {
            headers: {
                'Accept': 'application/json',
                // Add Auth Token if available
                'Authorization': `Bearer ${request.token || ''}`
            }
        })
            .then(res => res.json())
            .then(data => {
                console.log(`[ClipX Background] Mindshare p${page} items:`, data.mindshare?.length);
                sendResponse(data);
            })
            .catch(err => {
                console.error('[ClipX Background] Mindshare fetch error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    // --- TweetScout Smart Followers ---
    if (request.action === 'getTweetScoutInfo') {
        handleGetTweetScoutInfo(request, sendResponse);
        return true;
    }

    // --- Extract Twitter Video URL ---
    if (request.action === 'extractTwitterVideo') {
        const tweetUrl = request.tweetUrl;
        if (!tweetUrl) {
            sendResponse({ success: false, error: 'No tweet URL' });
            return true;
        }

        (async () => {
            try {
                console.log('[ClipX] Attempting to extract video from:', tweetUrl);

                // Extract tweet ID from URL
                const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
                const tweetId = tweetIdMatch ? tweetIdMatch[1] : null;

                if (!tweetId) {
                    sendResponse({ success: false, error: 'Could not parse tweet ID' });
                    return;
                }

                console.log('[ClipX] Tweet ID:', tweetId);

                // Method 1: Twitter Syndication API (most reliable - official Twitter endpoint)
                try {
                    console.log('[ClipX] Trying Twitter Syndication API...');
                    const synRes = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`, {
                        headers: {
                            'Accept': '*/*',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });

                    if (synRes.ok) {
                        const synData = await synRes.json();
                        console.log('[ClipX] Syndication response:', synData);

                        // Look for video in mediaDetails or video property
                        if (synData.video && synData.video.variants) {
                            // Find highest quality MP4
                            const mp4Variants = synData.video.variants
                                .filter(v => v.type === 'video/mp4' || v.content_type === 'video/mp4')
                                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

                            if (mp4Variants.length > 0) {
                                console.log('[ClipX] Found video via syndication:', mp4Variants[0].src || mp4Variants[0].url);
                                sendResponse({ success: true, videoUrl: mp4Variants[0].src || mp4Variants[0].url });
                                return;
                            }
                        }

                        // Try mediaDetails
                        if (synData.mediaDetails && synData.mediaDetails.length > 0) {
                            for (const media of synData.mediaDetails) {
                                if (media.type === 'video' && media.video_info && media.video_info.variants) {
                                    const mp4Variants = media.video_info.variants
                                        .filter(v => v.content_type === 'video/mp4')
                                        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

                                    if (mp4Variants.length > 0) {
                                        console.log('[ClipX] Found video in mediaDetails:', mp4Variants[0].url);
                                        sendResponse({ success: true, videoUrl: mp4Variants[0].url });
                                        return;
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.log('[ClipX] Syndication API failed:', e.message);
                }

                // Method 2: Twitter Publish/Embed API
                try {
                    console.log('[ClipX] Trying Twitter Publish API...');
                    const publishRes = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`);

                    if (publishRes.ok) {
                        const publishData = await publishRes.json();
                        console.log('[ClipX] Publish API response received');

                        // The HTML might contain video info, but usually it's just embed code
                        // This helps confirm the tweet exists
                        if (publishData.html) {
                            console.log('[ClipX] Tweet confirmed via publish API, checking alternatives...');
                        }
                    }
                } catch (e) {
                    console.log('[ClipX] Publish API failed:', e.message);
                }

                // Method 3: Try fxtwitter/vxtwitter proxy (if available)
                try {
                    console.log('[ClipX] Trying fxtwitter API...');
                    const fxUrl = tweetUrl.replace('twitter.com', 'api.fxtwitter.com').replace('x.com', 'api.fxtwitter.com');
                    const fxRes = await fetch(fxUrl);

                    if (fxRes.ok) {
                        const fxData = await fxRes.json();
                        console.log('[ClipX] fxtwitter response:', fxData);

                        if (fxData.tweet && fxData.tweet.media && fxData.tweet.media.videos) {
                            const videos = fxData.tweet.media.videos;
                            if (videos.length > 0 && videos[0].url) {
                                sendResponse({ success: true, videoUrl: videos[0].url });
                                return;
                            }
                        }
                    }
                } catch (e) {
                    console.log('[ClipX] fxtwitter failed:', e.message);
                }

                // Method 4: Return a download service URL for manual/automated download
                console.log('[ClipX] Direct extraction failed, providing download service URL');
                // These services allow direct download through their UI
                const downloadServiceUrl = `https://twittervideodownloader.com/download?url=${encodeURIComponent(tweetUrl)}`;
                sendResponse({
                    success: false,
                    error: 'Direct video extraction failed. Twitter may have blocked automated access.',
                    downloadServiceUrl: downloadServiceUrl
                });
            } catch (error) {
                console.error('[ClipX] Video extraction error:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    // ============================================
    // BINANCE SOCIAL HYPE API HANDLERS
    // ============================================

    // Social Hype Leaderboard - Top trending tokens by hype score
    if (request.action === 'fetchSocialHypeLeaderboard') {
        const timeRange = request.timeRange || 24;
        const newTokensOnly = request.newTokensOnly !== false;

        const params = new URLSearchParams({
            chainId: '56',
            sentiment: 'All',
            socialLanguage: 'ALL',
            targetLanguage: 'en',
            timeRange: timeRange.toString(),
            isNewTokensOnly: newTokensOnly ? 1 : 0
        });

        const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/leaderboard?${params.toString()}`;

        console.log('[ClipX] Fetching Social Hype Leaderboard (GET):', url);

        fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'client-type': 'web'
            }
        })
            .then(res => {
                if (!res.ok) throw new Error(`API error: ${res.status}`);
                return res.json();
            })
            .then(data => {
                console.log('[ClipX] Social Hype Leaderboard response:', data);
                if (data.code === '000000' && data.data && data.data.leaderBoardList) {
                    sendResponse({
                        success: true,
                        tokens: data.data.leaderBoardList || []
                    });
                } else {
                    sendResponse({ success: false, error: data.message || 'No data returned' });
                }
            })
            .catch(err => {
                console.error('[ClipX] Social Hype Leaderboard error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    // Social Hype Rising/Surge - Tokens with increasing momentum
    if (request.action === 'fetchSocialHypeRising') {
        const timeRange = request.timeRange || 1;
        const newTokensOnly = request.newTokensOnly !== false;

        const params = new URLSearchParams({
            chainId: '56',
            sentiment: 'All',
            socialLanguage: 'ALL',
            timeRange: timeRange.toString(),
            isNewTokensOnly: newTokensOnly ? 1 : 0
        });

        const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/hypeSurge?${params.toString()}`;

        console.log('[ClipX] Fetching Social Hype Rising (GET):', url);

        fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'client-type': 'web'
            }
        })
            .then(res => {
                if (!res.ok) throw new Error(`API error: ${res.status}`);
                return res.json();
            })
            .then(data => {
                console.log('[ClipX] Social Hype Rising response:', data);
                // Rising data is in data.hypeSurgeList
                const tokens = data.data?.hypeSurgeList || [];
                if (data.code === '000000' && tokens.length > 0) {
                    sendResponse({
                        success: true,
                        tokens: tokens
                    });
                } else {
                    sendResponse({ success: false, error: data.message || 'No rising tokens' });
                }
            })
            .catch(err => {
                console.error('[ClipX] Social Hype Rising error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    // Social Hype Mindshare - Market share distribution by hype
    if (request.action === 'fetchSocialHypeMindshare') {
        const lookbackTime = request.lookbackTime || Date.now();
        const newTokensOnly = request.newTokensOnly !== false;

        const params = new URLSearchParams({
            chainId: '56',
            lookbackTime: lookbackTime.toString(),
            sentiment: 'All',
            socialLanguage: 'ALL',
            tradable: '1',
            isNewTokensOnly: newTokensOnly ? 1 : 0,
            page: request.page || 1,
            rows: 100
        });

        const url = `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/mindshare?${params.toString()}`;

        console.log('[ClipX] Fetching Social Hype Mindshare (GET):', url);

        fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'client-type': 'web'
            }
        })
            .then(res => {
                if (!res.ok) throw new Error(`API error: ${res.status}`);
                return res.json();
            })
            .then(data => {
                console.log('[ClipX] Social Hype Mindshare response:', data);
                if (data.code === '000000' && data.data && data.data.mindShareList) {
                    sendResponse({
                        success: true,
                        mindshare: data.data.mindShareList || []
                    });
                } else {
                    sendResponse({ success: false, error: data.message || 'No mindshare data' });
                }
            })
            .catch(err => {
                console.error('[ClipX] Social Hype Mindshare error:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    // Get Labeled Users (Grouped by Category)
    if (request.action === 'getLabeledUsers') {
        handleGetLabeledUsers(request, sendResponse);
        return true;
    }
});


// --- Helper Functions ---

// Fetch local KOL database
async function fetchLocalKols() {
    const now = Date.now();
    if (kolCache && (now - kolCacheTime) < KOL_CACHE_TTL) {
        return kolCache;
    }
    try {
        const res = await fetch(`${API_BASE}/api/kol/all`);
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const data = await res.json();
        if (data.success && data.kols) {
            // Build a map by address for quick lookup
            const kolMap = {};
            data.kols.forEach(k => {
                kolMap[k.address.toLowerCase()] = k;
            });
            kolCache = kolMap;
            kolCacheTime = now;
            console.log('[ClipX] Loaded', Object.keys(kolMap).length, 'KOLs from local database');
            return kolMap;
        }
        return { error: 'Invalid data' };
    } catch (e) {
        console.log('[ClipX] Failed to fetch local KOLs:', e.message);
        return { error: e.message };
    }
}

// Handle Get Labeled Users
async function handleGetLabeledUsers(request, sendResponse) {
    try {
        console.log('[ClipX] handleGetLabeledUsers called');
        console.log('[ClipX] API_BASE is:', API_BASE);

        let categories = [];
        let apiSuccess = false;

        // 1. Try to fetch from the Profile Label API (Ideal Case)
        try {
            const apiUrl = `${API_BASE}/api/labels/all`;
            console.log('[ClipX] Attempting fetch:', apiUrl);

            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });

            console.log('[ClipX] API Response Status:', response.status);

            if (response.ok) {
                const data = await response.json();
                console.log('[ClipX] API Data Success, count:', data.categories?.length);
                if (data.success && data.categories) {
                    sendResponse({ success: true, categories: data.categories });
                    return;
                }
            } else {
                console.warn('[ClipX] Profile Label API fetch failed (Status ' + response.status + '), using local cache of API data');
            }
        } catch (apiError) {
            console.error('[ClipX] API fetch CRITICAL FAILURE:', apiError);
            console.warn('[ClipX] Is the server running? Is SSL required?');
        }

        // 2. Fallback: Aggregate local cache of REAL API data
        // This builds the list from users we've actually verified/fetched from the API one-by-one
        console.log('[ClipX] Falling back to LOCAL DATA Aggregation');
        const result = await chrome.storage.local.get(['labeledUsers']);
        const usersMap = result.labeledUsers || {};
        const users = Object.values(usersMap);
        console.log('[ClipX] Local Users Found:', users.length);

        if (users.length > 0) {
            const catMap = {};
            users.forEach(user => {
                const type = user.category || user.label || 'Identity';
                if (!catMap[type]) catMap[type] = [];
                catMap[type].push({
                    name: user.name || user.handle,
                    handle: user.handle,
                    avatar: user.avatar || null,
                    address: user.address,
                    type: type
                });
            });
            categories = Object.keys(catMap).map(cat => ({
                name: cat,
                users: catMap[cat]
            }));
        }

        sendResponse({ success: true, categories: categories });

    } catch (error) {
        console.error('[ClipX] Error getting labeled users:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Handler for fetching images as blob/base64 to bypass CSP
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchImageBlob') {
        const imageUrl = request.url;
        if (!imageUrl) {
            sendResponse({ success: false, error: 'No URL provided' });
            return true;
        }

        fetch(imageUrl)
            .then(response => response.blob())
            .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    sendResponse({ success: true, dataUrl: reader.result });
                };
                reader.readAsDataURL(blob);
            })
            .catch(error => {
                console.error('[ClipX] Proxy fetch failed:', error);
                sendResponse({ success: false, error: error.toString() });
            });
        return true;
    }

    // Handler for fetching VIDEO as blob/base64 to bypass CORS (Twitter video.twimg.com blocks direct access)
    if (request.action === 'fetchVideoBlob') {
        const videoUrl = request.url;
        if (!videoUrl) {
            sendResponse({ success: false, error: 'No URL provided' });
            return true;
        }

        console.log('[ClipX] Background fetching video:', videoUrl);

        fetch(videoUrl, {
            headers: {
                'Accept': 'video/mp4,video/*,*/*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return response.blob();
            })
            .then(blob => {
                console.log('[ClipX] Video blob fetched, size:', blob.size);
                const reader = new FileReader();
                reader.onloadend = () => {
                    sendResponse({ success: true, dataUrl: reader.result, size: blob.size, type: blob.type });
                };
                reader.readAsDataURL(blob);
            })
            .catch(error => {
                console.error('[ClipX] Video proxy fetch failed:', error);
                sendResponse({ success: false, error: error.toString() });
            });
        return true;
    }

    // Continue with other listeners...
});

// Fetch holders from GMGN
async function fetchGmgnHolders(address, limit = 500) {
    try {
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };

        if (typeof GMGN_API_KEY !== 'undefined' && GMGN_API_KEY) {
            headers['X-API-KEY'] = GMGN_API_KEY;
            headers['Authorization'] = `Bearer ${GMGN_API_KEY}`;
        }

        const res = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/top_holders/bsc/${address}?orderby=amount_percentage&direction=desc&limit=${limit}`, {
            headers: headers,
            credentials: 'include'
        });
        if (!res.ok) return null;
        const data = await res.json();
        console.log('[ClipX] GMGN holders response:', data);

        let holderList = null;
        if (data && data.data) {
            if (Array.isArray(data.data)) {
                holderList = data.data;
            } else if (data.data.holders && Array.isArray(data.data.holders)) {
                holderList = data.data.holders;
            } else if (data.data.list && Array.isArray(data.data.list)) {
                holderList = data.data.list;
            }
        }
        return holderList;
    } catch (e) {
        console.log('[ClipX] GMGN failed:', e.message);
        return null;
    }
}

// Try DeBank API for wallet labels
async function fetchDeBankHolders(address) {
    try {
        const res = await fetch(`https://api.debank.com/token/top_holders?id=bsc:${address}`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) return null;
        const data = await res.json();

        if (data && Array.isArray(data)) {
            return data.map(h => ({
                address: h.id || h.address || '',
                percent: h.percent || 0,
                usd_value: h.usd_value || 0,
                is_contract: h.is_contract || false,
                tag: h.desc || null,
                name: h.name || null,
                twitter_username: null,
                twitter_name: null,
                avatar: h.logo_url || null,
                is_kol: !!(h.name || h.desc),
                tags: []
            }));
        }
        return null;
    } catch (e) {
        console.log('[ClipX] DeBank failed:', e.message);
        return null;
    }
}



// On-Chain Balance Check for Deep Scan
async function handleScanAllLocalKols(request, sendResponse) {
    const { tokenAddress } = request;
    if (!tokenAddress) {
        sendResponse({ success: false, error: 'No token address' });
        return;
    }

    (async () => {
        // 1. Ensure KOLs are loaded
        let kolMap = kolCache;
        const now = Date.now();
        if (!kolMap || (now - kolCacheTime) >= KOL_CACHE_TTL) {
            try {
                const res = await fetch(`${API_BASE}/api/kol/all`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.success && data.kols) {
                        kolMap = {};
                        data.kols.forEach(k => {
                            kolMap[k.address.toLowerCase()] = k;
                        });
                        kolCache = kolMap;
                        kolCacheTime = now;
                    }
                }
            } catch (e) {
                console.error('Scan failed to load KOLs:', e);
            }
        }

        if (!kolMap) {
            sendResponse({ success: false, error: 'Could not load KOL database' });
            return;
        }

        const allKolAddresses = Object.keys(kolMap);
        console.log(`[ClipX] Scanning ${allKolAddresses.length} KOLs for token ${tokenAddress}...`);

        // 2. Batch RPC Calls (BalanceOf)
        const BATCH_SIZE = 500;
        const rpcUrl = 'https://bsc.rpc.blxrbdn.com';
        const foundHolders = [];

        // Helper to create batch request
        const checkBatch = async (addresses) => {
            const batch = addresses.map((addr, idx) => ({
                jsonrpc: '2.0',
                id: idx,
                method: 'eth_call',
                params: [{
                    to: tokenAddress,
                    data: '0x70a08231000000000000000000000000' + addr.substring(2) // balanceOf(addr)
                }, 'latest']
            }));

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

            try {
                const res = await fetch(rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(batch),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                const results = await res.json();

                // Process results
                if (Array.isArray(results)) {
                    results.forEach(r => {
                        if (r.result && r.result !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                            // Balance > 0
                            const balHex = r.result;
                            const balWei = parseInt(balHex, 16); // Safe for checks, use BigInt for precision if needed
                            if (balWei > 0) {
                                const addr = addresses[r.id]; // Map back using ID
                                const kolData = kolMap[addr];

                                // Calculate approx balance (assuming 18 decimals, will refine in UI)
                                const balance = balWei / 1e18;

                                foundHolders.push({
                                    address: addr,
                                    percent: 0, // Unknown without total supply
                                    is_contract: false,
                                    tag: 'kol',
                                    name: kolData.kolName,
                                    twitter_username: null,
                                    avatar: kolData.logoUrl,
                                    is_kol: true,
                                    is_my_kol: true,
                                    my_kol_data: kolData,
                                    profile_link: kolData.profileLink,
                                    balance: balance, // Extra field for sorting
                                    balance_derived: balance // Ensure compatibility with content.js check
                                });
                            }
                        }
                    });
                }
            } catch (e) {
                clearTimeout(timeoutId);
                console.error('Batch scan error:', e.name === 'AbortError' ? 'RPC timed out' : e.message);
            }
        };

        // Execute batches
        for (let i = 0; i < allKolAddresses.length; i += BATCH_SIZE) {
            const batch = allKolAddresses.slice(i, i + BATCH_SIZE);
            await checkBatch(batch);
        }

        console.log(`[ClipX] Scan complete. Found ${foundHolders.length} holders.`);

        // Sort by balance desc
        foundHolders.sort((a, b) => b.balance - a.balance);

        sendResponse({ success: true, holders: foundHolders });
    })();
    return true;
}

// Reusable holder formatting logic
function processHolders(holderList, localKols) {
    if (!holderList || !Array.isArray(holderList)) return [];

    return holderList.map(h => {
        // Handle varying API formats (GMGN vs DeBank)
        const address = (h.address || h.id || '').toLowerCase();
        let percent = parseFloat(h.amount_percentage || h.percent || h.percentage || 0);

        // Ensure percent is in standard format (e.g. 0.05 for 5%)
        // If an API already returns 5.0 for 5%, we should normalize it.
        // Usually GMGN returns 0.05 for 5%. We will assume standard 0-1 scale.
        if (percent > 1 && percent <= 100) {
            percent = percent / 100; // Normalize
        }

        let tag = 'unknown'; // Default tag
        let is_contract = false;

        // Infer contract status
        if (h.maker_token || h.is_contract === true || h.is_contract === 1) {
            is_contract = true;
            tag = 'contract';
        }

        // Tags from GMGN
        if (h.tags && Array.isArray(h.tags)) {
            if (h.tags.includes('contract') || h.tags.includes('dex')) is_contract = true;
            if (h.tags.includes('creator')) tag = 'creator';
            if (h.tags.includes('dex')) tag = 'dex';
            if (h.tags.includes('cex')) tag = 'cex';
            if (h.tags.includes('burn')) tag = 'burn';
        }

        // Check local KOL mapping
        const isMyKol = !!localKols[address];
        const kolData = localKols[address] || null;
        if (isMyKol) {
            tag = 'kol';
        }

        return {
            address: address,
            percent: percent, // Stored as 0.05 = 5%
            is_contract: is_contract,
            is_locked: h.is_locked || false,
            tag: tag,
            name: kolData?.kolName || h.name || h.ens_name || null,
            twitter_username: kolData?.twitterUsername || h.twitter_username || null,
            avatar: kolData?.logoUrl || h.avatar || h.logo_url || null,
            is_my_kol: isMyKol,
            my_kol_data: kolData,
            profile_link: kolData?.profileLink || null
        };
    });
}

// Rewriting handleFetchTopHolders to reuse these helpers
function handleFetchTopHolders(request, sendResponse) { // Note: this isn't async keyword here but implementation is
    const address = request.address;
    (async () => {
        const [localKols, holderList] = await Promise.all([
            fetchLocalKols(),
            fetchGmgnHolders(address, 500).then(res => res || fetchDeBankHolders(address))
        ]);

        if (holderList && holderList.length > 0) {
            const holders = processHolders(holderList, localKols);
            const myKolCount = holders.filter(h => h.is_my_kol).length;

            console.log('[ClipX] Found', myKolCount, 'holders from My KOL list');

            sendResponse({
                success: true,
                holders,
                source: 'gmgn',
                myKolCount,
                debug: {
                    totalKolsLoaded: Object.keys(localKols).length,
                    matchesFound: myKolCount
                }
            });
        } else {
            sendResponse({ success: false, error: 'No holder data available' });
        }
    })();
}



// Helper for Wallet RPC
async function handleWalletRequest(request, sendResponse) {
    const { method, params } = request;

    // Check if wallet is unlocked
    if (!unlockedWallet && method !== 'eth_chainId' && method !== 'net_version') {
        // For requestAccounts, we could try to get the address from storage if available
        // But for signing, we definitely need the unlocked wallet.

        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
            // Try to get public address from storage even if locked
            const stored = await chrome.storage.local.get(['userAddress', 'nativeWallet']);
            const addr = stored.userAddress || (stored.nativeWallet ? stored.nativeWallet.address : null);

            if (addr) {
                sendResponse({ result: [addr] });
            } else {
                sendResponse({ error: { code: 4001, message: 'Please log in to ClipX extension first' } });
            }
            return;
        }

        sendResponse({ error: { code: 4100, message: 'Wallet is locked' } });
        return;
    }

    const address = unlockedWallet ? unlockedWallet.address : null;

    try {
        switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
                sendResponse({ result: [address] });
                break;

            case 'eth_chainId':
                sendResponse({ result: '0x38' }); // BSC
                break;

            case 'net_version':
                sendResponse({ result: '56' });
                break;

            case 'personal_sign':
                // params: [message, address]
                const msg = params[0];
                if (!unlockedWallet) {
                    sendResponse({ error: { code: 4100, message: 'Wallet must be unlocked to sign' } });
                    return;
                }
                const sig = await unlockedWallet.signMessage(ethers.utils.isHexString(msg) ? ethers.utils.arrayify(msg) : msg);
                sendResponse({ result: sig });
                break;

            case 'eth_signTypedData_v4':
                // Not fully implemented yet, but GMGN might need it
                sendResponse({ error: { code: 4200, message: 'Typed data signing not supported yet' } });
                break;

            default:
                sendResponse({ error: { code: 4200, message: 'Method not supported: ' + method } });
        }
    } catch (err) {
        console.error('Wallet RPC Error:', err);
        sendResponse({ error: { code: 5000, message: err.message } });
    }
}

// Priority tokens that should always be available for ticker detection
// BTC/ETH: CoinGecko's BSC index can list multiple contracts per symbol; without priority,
// $BTC may resolve to an unrelated low-cap "BTC" meme token — wrong DexScreener price.
const PRIORITY_TOKENS = {
    'BTC': {
        address: '0x7130d2A12B9BCbfAe4F2634d864A1Ee1Ce3Ead9c', // Binance-Peg BTCB (BSC)
        decimals: 18,
        name: 'Bitcoin (BSC)',
        logoURI: 'https://tokens.pancakeswap.finance/images/symbol/btc.png',
        isVerified: true
    },
    'ETH': {
        address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', // Binance-Peg ETH (BSC)
        decimals: 18,
        name: 'Ethereum (BSC)',
        logoURI: 'https://tokens.pancakeswap.finance/images/symbol/eth.png',
        isVerified: true
    },
    'BNB': {
        address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
        decimals: 18,
        name: 'BNB',
        logoURI: 'https://tokens.pancakeswap.finance/images/symbol/bnb.png',
        isVerified: true
    },
    'CLIPX': {
        address: '0xc269d59a0d608ea0bd672f2f4616c372d8554444',
        decimals: 18,
        name: 'ClipX',
        logoURI: '',
        isVerified: true
    },
    'ASTER': {
        address: '0x000ae314e2a2172a039b26378814c252734f556a',
        decimals: 18,
        name: 'Aster',
        logoURI: '',
        isVerified: true
    },
    'USDT': {
        address: '0x55d398326f99059fF775485246999027B3197955',
        decimals: 18,
        name: 'Tether USD',
        logoURI: 'https://tokens.pancakeswap.finance/images/symbol/usdt.png',
        isVerified: true
    },
    'GIGGLE': {
        address: '0x20d6015660b3fe52e6690a889b5c51f69902ce0e',
        decimals: 18,
        name: 'Giggle',
        logoURI: '',
        isVerified: true
    }
};

/** Bump when merge order / source-of-truth changes (invalidates stale cachedTokenList). */
const TOKEN_LIST_CACHE_VERSION = 3;

async function handleFetchTokenList(request, sendResponse) {
    try {
        const stored = await chrome.storage.local.get([
            'cachedTokenList',
            'tokenListTimestamp',
            'tokenListCacheVersion'
        ]);
        const now = Date.now();
        const ONE_DAY = 24 * 60 * 60 * 1000;

        const hasPriorityTokens = stored.cachedTokenList && stored.cachedTokenList['CLIPX'];
        const cacheOk =
            stored.tokenListCacheVersion === TOKEN_LIST_CACHE_VERSION &&
            stored.cachedTokenList &&
            stored.tokenListTimestamp &&
            (now - stored.tokenListTimestamp < ONE_DAY) &&
            hasPriorityTokens;

        if (cacheOk) {
            console.log('[ClipX Background] Using cached token list');
            sendResponse({ success: true, tokens: stored.cachedTokenList });
            return;
        }

        console.log('[ClipX Background] Fetching new token list (cache v' + TOKEN_LIST_CACHE_VERSION + ')...');

        const tokenMap = { ...PRIORITY_TOKENS };

        await clipxMergeCoinGeckoBscIntoTokenMap(tokenMap);

        try {
            const response = await fetch('https://tokens.pancakeswap.finance/pancakeswap-extended.json');
            const data = await response.json();

            if (data && data.tokens) {
                data.tokens.forEach((token) => {
                    if (token.chainId !== 56) return;
                    const symbol = token.symbol.toUpperCase();
                    if (PRIORITY_TOKENS[symbol]) return;
                    if (tokenMap[symbol]) return;
                    tokenMap[symbol] = {
                        address: token.address,
                        decimals: token.decimals,
                        logoURI: token.logoURI,
                        name: token.name,
                        isVerified: true,
                        source: 'pancakeswap'
                    };
                });
            }
        } catch (fetchError) {
            console.warn('[ClipX Background] Failed to fetch PancakeSwap list:', fetchError);
        }

        console.log('[ClipX Background] Token map loaded with', Object.keys(tokenMap).length, 'tokens');
        console.log('[ClipX Background] Priority tokens included:', Object.keys(PRIORITY_TOKENS).join(', '));

        await chrome.storage.local.remove('tickerResolveCache');

        await chrome.storage.local.set({
            cachedTokenList: tokenMap,
            tokenListTimestamp: now,
            tokenListCacheVersion: TOKEN_LIST_CACHE_VERSION
        });

        sendResponse({ success: true, tokens: tokenMap });
    } catch (error) {
        console.error('[ClipX Background] Error in handleFetchTokenList:', error);
        sendResponse({ success: true, tokens: PRIORITY_TOKENS });
    }
}

const COINGECKO_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list?include_platform=true';
const COINGECKO_LIST_TTL_MS = 24 * 60 * 60 * 1000;

/** In-memory index: UPPER_SYMBOL -> { id, address, name }[] */
let clipxCoinGeckoBscIndex = null;
let clipxCoinGeckoIndexListTimestamp = 0;

function clipxBscAddressFromPlatforms(platforms) {
    if (!platforms || typeof platforms !== 'object') return null;
    const addr = platforms['binance-smart-chain'] || platforms.bsc;
    if (!addr || typeof addr !== 'string' || !addr.startsWith('0x')) return null;
    return addr;
}

function clipxBuildBscSymbolIndex(coinsList) {
    const bySymbol = {};
    for (const c of coinsList) {
        if (!c.id) continue;
        const addr = clipxBscAddressFromPlatforms(c.platforms);
        if (!addr) continue;
        const sym = (c.symbol || '').toUpperCase();
        if (!sym || sym.length < 2) continue;
        if (!bySymbol[sym]) bySymbol[sym] = [];
        if (bySymbol[sym].some((x) => x.id === c.id)) continue;
        bySymbol[sym].push({
            id: c.id,
            address: addr,
            name: c.name || sym
        });
    }
    return bySymbol;
}

async function clipxLoadCoinGeckoBscIndex() {
    const now = Date.now();
    if (
        clipxCoinGeckoBscIndex &&
        clipxCoinGeckoIndexListTimestamp &&
        now - clipxCoinGeckoIndexListTimestamp < COINGECKO_LIST_TTL_MS
    ) {
        return clipxCoinGeckoBscIndex;
    }

    const stored = await chrome.storage.local.get(['coingeckoCoinListRaw', 'coingeckoCoinListTimestamp']);
    let list = stored.coingeckoCoinListRaw;

    if (
        !Array.isArray(list) ||
        !stored.coingeckoCoinListTimestamp ||
        now - stored.coingeckoCoinListTimestamp >= COINGECKO_LIST_TTL_MS
    ) {
        const res = await fetch(COINGECKO_LIST_URL);
        if (!res.ok) throw new Error(`CoinGecko list HTTP ${res.status}`);
        list = await res.json();
        if (!Array.isArray(list)) throw new Error('CoinGecko list invalid');
        await chrome.storage.local.set({
            coingeckoCoinListRaw: list,
            coingeckoCoinListTimestamp: now
        });
    }

    clipxCoinGeckoBscIndex = clipxBuildBscSymbolIndex(list);
    clipxCoinGeckoIndexListTimestamp = now;
    return clipxCoinGeckoBscIndex;
}

/**
 * When multiple CoinGecko entries share the same symbol on BSC, pick the one with highest USD market cap.
 */
async function clipxFetchMarketCapMapForIds(allIds) {
    const map = {};
    const ids = Array.from(new Set(allIds.filter(Boolean)));
    for (let i = 0; i < ids.length; i += 250) {
        const chunk = ids.slice(i, i + 250);
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(chunk.join(','))}&per_page=250`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const markets = await res.json();
        if (!Array.isArray(markets)) continue;
        for (const m of markets) {
            if (m.id) map[m.id] = Number(m.market_cap) || 0;
        }
    }
    return map;
}

async function clipxPickBestCoinGeckoCandidate(candidates) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const ids = Array.from(new Set(candidates.map((c) => c.id))).filter(Boolean);
    if (ids.length === 0) return candidates[0];

    const mcMap = await clipxFetchMarketCapMapForIds(ids);
    let best = candidates[0];
    let bestMc = mcMap[best.id] ?? 0;
    for (let i = 1; i < candidates.length; i++) {
        const c = candidates[i];
        const mc = mcMap[c.id] ?? 0;
        if (mc > bestMc) {
            best = c;
            bestMc = mc;
        }
    }
    return best;
}

/**
 * Merge CoinGecko BSC contracts into tokenMap. Call AFTER PRIORITY_TOKENS only.
 * PancakeSwap should only fill symbols missing here so wrong PS addresses don't override CG.
 */
async function clipxMergeCoinGeckoBscIntoTokenMap(tokenMap) {
    const index = await clipxLoadCoinGeckoBscIndex();
    const symbols = Object.keys(index);
    const multiIds = [];
    for (const sym of symbols) {
        if (PRIORITY_TOKENS[sym]) continue;
        const cands = index[sym];
        if (cands && cands.length > 1) {
            multiIds.push(...cands.map((c) => c.id));
        }
    }
    const mcMap = await clipxFetchMarketCapMapForIds(multiIds);

    for (const sym of symbols) {
        if (PRIORITY_TOKENS[sym]) continue;
        const cands = index[sym];
        if (!cands || cands.length === 0) continue;

        let best = cands[0];
        if (cands.length > 1) {
            let bestMc = mcMap[best.id] ?? 0;
            for (let i = 1; i < cands.length; i++) {
                const c = cands[i];
                const mc = mcMap[c.id] ?? 0;
                if (mc > bestMc) {
                    best = c;
                    bestMc = mc;
                }
            }
        }

        tokenMap[sym] = {
            address: best.address,
            decimals: 18,
            name: best.name || sym,
            logoURI: '',
            isVerified: false,
            source: 'coingecko'
        };
    }
}

/**
 * Resolve $TICKER -> BSC contract using CoinGecko's official coin list (binance-smart-chain),
 * not DexScreener search (which was matching unrelated high-volume pools).
 * Same message action as before: resolveTickerDexScreener.
 */
async function handleResolveTickerDexScreener(request, sendResponse) {
    const symbol = (request.symbol || '').trim().toUpperCase();
    if (!symbol || symbol.length < 2 || symbol.length > 20) {
        sendResponse({ success: false, error: 'invalid symbol' });
        return;
    }

    const priority = PRIORITY_TOKENS[symbol];
    if (priority && priority.address) {
        sendResponse({
            success: true,
            address: priority.address,
            symbol,
            name: priority.name || symbol,
            decimals: priority.decimals != null ? priority.decimals : 18,
            logoURI: priority.logoURI || '',
            isVerified: !!priority.isVerified,
            source: 'priority'
        });
        return;
    }

    const HIT_TTL = 7 * 24 * 60 * 60 * 1000;
    const MISS_TTL = 60 * 60 * 1000;
    const now = Date.now();

    try {
        const stored = await chrome.storage.local.get('tickerResolveCache');
        const tickerResolveCache = { ...(stored.tickerResolveCache || {}) };
        const hit = tickerResolveCache[symbol];

        if (hit && hit.miss && (now - hit.ts < MISS_TTL)) {
            sendResponse({ success: false, error: 'not found (cached)' });
            return;
        }
        if (hit && !hit.miss && hit.address && (now - hit.ts < HIT_TTL)) {
            sendResponse({
                success: true,
                address: hit.address,
                symbol: hit.symbol || symbol,
                name: hit.name || symbol,
                decimals: hit.decimals != null ? hit.decimals : 18,
                logoURI: hit.logoURI || '',
                isVerified: !!hit.isVerified,
                source: hit.source || 'coingecko'
            });
            return;
        }

        const index = await clipxLoadCoinGeckoBscIndex();
        const candidates = index[symbol] || [];

        if (candidates.length === 0) {
            tickerResolveCache[symbol] = { ts: now, miss: true };
            await chrome.storage.local.set({ tickerResolveCache });
            sendResponse({ success: false, error: 'No BSC token in CoinGecko list for symbol' });
            return;
        }

        const best = await clipxPickBestCoinGeckoCandidate(candidates);
        const checksumAddress = best.address;

        const out = {
            address: checksumAddress,
            symbol,
            name: best.name || symbol,
            decimals: 18,
            logoURI: '',
            isVerified: false,
            source: 'coingecko',
            ts: now
        };
        tickerResolveCache[symbol] = { ...out };
        await chrome.storage.local.set({ tickerResolveCache });

        sendResponse({
            success: true,
            address: out.address,
            symbol: out.symbol,
            name: out.name,
            decimals: out.decimals,
            logoURI: out.logoURI,
            isVerified: out.isVerified,
            source: out.source
        });
    } catch (e) {
        console.warn('[ClipX Background] resolveTicker (CoinGecko):', e);
        sendResponse({ success: false, error: e.message || String(e) });
    }
}

async function handleNativeSwap(request, sendResponse) {
    // Auto-unlock from session if possible
    await ensureWalletUnlocked();

    if (!unlockedWallet) {
        sendResponse({ success: false, error: 'Wallet is locked. Please unlock in popup.' });
        return;
    }

    try {
        const { tokenAddress, amount, type, slippage } = request;

        // Step 1: Check if this is a four.meme token
        console.log('[ClipX Native] Checking if token is four.meme...');

        const abis = await loadFourMemeABIs();
        if (abis) {
            try {
                const provider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
                const helper = new ethers.Contract(FOURMEME_HELPER3, abis.helper3ABI, provider);
                const tokenInfo = await helper.getTokenInfo(tokenAddress);

                const isFourMeme = tokenInfo[0] > 0;

                if (isFourMeme) {
                    const liquidityAdded = tokenInfo[11];
                    const isUnbonded = !liquidityAdded;

                    // Check for X Mode exclusive tokens
                    const tokenManager2 = new ethers.Contract(FOURMEME_TOKEN_MANAGER2, abis.tokenManager2ABI, provider);
                    const tokenInfoEx = await tokenManager2._tokenInfos(tokenAddress);
                    const template = Number(tokenInfoEx.template);
                    const isXMode = (template & 0x10000) > 0;

                    if (isXMode) {
                        console.log('[ClipX Native] X Mode exclusive token detected');
                        sendResponse({
                            success: false,
                            error: 'This is an X Mode exclusive token (requires Binance MPC Wallet). Currently not supported.'
                        });
                        return;
                    }

                    if (isUnbonded) {
                        console.log('[ClipX Native] Four.meme unbonded token detected, routing to TokenManager2');

                        // Route to four.meme TokenManager2
                        if (type === 'buy') {
                            const result = await buyFourMemeToken(tokenAddress, parseFloat(amount), slippage || 0.02);
                            sendResponse({
                                success: true,
                                txHash: result.transactionHash,
                                message: 'Swap submitted via Four.Meme'
                            });
                        } else {
                            const result = await sellFourMemeToken(tokenAddress, parseFloat(amount), slippage || 0.02);
                            sendResponse({
                                success: true,
                                txHash: result.transactionHash,
                                message: 'Swap submitted via Four.Meme'
                            });
                        }
                        return;
                    } else {
                        console.log('[ClipX Native] Four.meme bonded token detected, using PancakeSwap');
                        // Continue to PancakeSwap below
                    }
                }
            } catch (e) {
                console.log('[ClipX Native] Four.meme check failed, falling back to PancakeSwap:', e.message);
                // Continue to PancakeSwap below
            }
        }

        // Step 2: Use PancakeSwap for regular tokens or bonded four.meme tokens
        console.log('[ClipX Native] Using PancakeSwap for swap');

        const provider = new ethers.JsonRpcProvider('https://bsc.rpc.blxrbdn.com');
        const wallet = unlockedWallet.connect(provider);
        const routerAddress = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
        const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

        const router = new ethers.Contract(routerAddress, [
            'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
            'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
            'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
        ], wallet);

        const timestamp = Math.floor(Date.now() / 1000) + 1200;
        let tx;

        if (type === 'buy') {
            const amountIn = ethers.parseEther(amount.toString());
            const path = [wbnbAddress, tokenAddress];
            const amounts = await router.getAmountsOut(amountIn, path);
            const amountOutMin = amounts[1] * BigInt(10000 - (slippage * 100 || 50)) / BigInt(10000);

            const overrides = { value: amountIn, gasLimit: 300000 };
            if (request.gasPrice) overrides.gasPrice = ethers.parseUnits(request.gasPrice.toString(), 'gwei');

            tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(amountOutMin, path, wallet.address, timestamp, overrides);
        } else {
            const tokenContract = new ethers.Contract(tokenAddress, [
                'function approve(address spender, uint256 amount) external returns (bool)',
                'function allowance(address owner, address spender) external view returns (uint256)',
                'function decimals() external view returns (uint8)',
                'function balanceOf(address owner) external view returns (uint256)'
            ], wallet);

            const decimals = await tokenContract.decimals();
            let amountIn = ethers.parseUnits(amount.toString(), decimals);

            // IMPORTANT: Check actual on-chain balance to avoid precision issues
            const actualBalance = await tokenContract.balanceOf(wallet.address);
            console.log('[ClipX Native] Sell amount requested:', amountIn.toString());
            console.log('[ClipX Native] Actual on-chain balance:', actualBalance.toString());

            // If amountIn exceeds or nearly equals actual balance, use actual balance to sell all
            // This fixes the "100% sell fails" issue due to floating-point precision
            if (amountIn > actualBalance || amountIn >= actualBalance * BigInt(999) / BigInt(1000)) {
                console.log('[ClipX Native] Using actual balance for 100% sell');
                amountIn = actualBalance;
            }

            const allowance = await tokenContract.allowance(wallet.address, routerAddress);
            if (allowance < amountIn) {
                console.log('[ClipX Native] Approving token...');
                await (await tokenContract.approve(routerAddress, ethers.MaxUint256)).wait();
            }

            const path = [tokenAddress, wbnbAddress];
            console.log('[ClipX Background] Sell: In', amountIn.toString());
            const amounts = await router.getAmountsOut(amountIn, path);
            const amountOutMin = amounts[1] * BigInt(10000 - (slippage * 100 || 50)) / BigInt(10000);
            console.log('[ClipX Background] Sell: Min Out', amountOutMin.toString());

            tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(amountIn, amountOutMin, path, wallet.address, timestamp, { gasLimit: 500000 });
        }
        console.log('[ClipX Native] Swap TX sent:', tx.hash);
        sendResponse({ success: true, txHash: tx.hash, message: 'Swap submitted' });
    } catch (e) {
        console.error('[ClipX Native] Swap failed:', e);
        sendResponse({ success: false, error: e.reason || e.message });
    }
}

async function handleSwap(request, sendResponse) {
    try {
        console.log('[ClipX Background] Starting swap handler');
        const stored = await chrome.storage.local.get(['authToken']);
        const authToken = stored.authToken;

        console.log('[ClipX Background] Auth token:', authToken ? 'Found' : 'Not found');

        if (!authToken) {
            console.error('[ClipX Background] No auth token');
            sendResponse({ success: false, error: 'Please log in to ClipX first' });
            return;
        }

        // Handle Native Wallet Swap
        if (authToken === 'native-wallet') {
            await handleNativeSwap(request, sendResponse);
            return;
        }

        console.log('[ClipX Background] Sending request to:', `${API_BASE}/api/swap`);
        console.log('[ClipX Background] Request body:', {
            tokenAddress: request.tokenAddress,
            amount: request.amount,
            type: request.type || 'buy',
            slippage: request.slippage,
            gasPrice: request.gasPrice,
            isPercentage: request.isPercentage || false
        });

        const response = await fetch(`${API_BASE}/api/swap`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                tokenAddress: request.tokenAddress,
                amount: request.amount,
                type: request.type || 'buy',
                slippage: request.slippage,
                gasPrice: request.gasPrice,
                isPercentage: request.isPercentage || false
            })
        });

        console.log('[ClipX Background] Response status:', response.status);

        if (response.status === 401) {
            // await chrome.storage.local.remove('authToken');
            sendResponse({ success: false, error: 'Session expired. Please reload the ClipX tab.' });
            return;
        }

        const data = await response.json();
        console.log('[ClipX Background] Response data:', data);

        if (data.success) {
            sendResponse({ success: true, txHash: data.txHash, message: data.message });
        } else {
            sendResponse({ success: false, error: data.error || 'Swap failed' });
        }
    } catch (error) {
        console.error('[ClipX Background] Swap error:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/* Get Trade History (BSCTrace/MegaNode API) */
async function handleGetTradeHistory(request, sendResponse) {
    try {
        const { walletAddress } = request;

        if (!walletAddress) {
            sendResponse({ success: false, error: 'Missing walletAddress' });
            return;
        }

        console.log('[ClipX Background] Fetching trade history for:', walletAddress);

        // Using BSCTrace/MegaNode API (free tier available)
        const apiKey = 'be5d3442d49846be92ee143d56521bb8'; // Replace with actual API key
        const baseUrl = `https://bsc-mainnet.nodereal.io/v1/${apiKey}`;

        // Fetch BEP20 token transfers only using nr_getAssetTransfers
        const requestBody = {
            jsonrpc: "2.0",
            method: "nr_getAssetTransfers",
            params: [{
                fromAddress: walletAddress,
                category: ["20"], // Only BEP20/ERC20 tokens
                withMetadata: true,
                excludeZeroValue: false,
                pageSize: 10,
                pageToken: ""
            }],
            id: 1
        };

        console.log('[ClipX Background] Request body:', requestBody);

        const response = await fetch(baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();
        console.log('[ClipX Background] BSCTrace response:', data);

        if (data.error) {
            console.log('[ClipX Background] API Error Details:', {
                code: data.error.code,
                message: data.error.message,
                data: data.error.data
            });
        }

        let events = [];

        if (data.result && data.result.transfers && Array.isArray(data.result.transfers)) {
            events = data.result.transfers.map(tx => {
                // All transactions here are BEP20 tokens since we filtered by category "20"
                let tokenSymbol = 'UNKNOWN';
                let tokenName = 'Unknown Token';
                let decimals = 18;

                // Debug log to see the actual structure
                console.log('[ClipX Background] Transaction structure:', tx);

                // Hardcoded token mappings
                const tokenMap = {
                    '0xc269d59a0d608ea0bd672f2f4616c372d8554444': {
                        symbol: 'CLIPX',
                        name: 'ClipX Token',
                        decimals: 18
                    }
                    // Add more tokens as needed
                };

                // Get contract address from transaction
                const contractAddress = tx.contractAddress || tx.tokenAddress || tx.address;

                // Check if we have a hardcoded mapping for this token
                if (contractAddress && tokenMap[contractAddress.toLowerCase()]) {
                    const tokenInfo = tokenMap[contractAddress.toLowerCase()];
                    tokenSymbol = tokenInfo.symbol;
                    tokenName = tokenInfo.name;
                    decimals = tokenInfo.decimals;
                } else if (tx.asset) {
                    console.log('[ClipX Background] tx.asset:', tx.asset);
                    tokenSymbol = tx.asset.symbol || 'UNKNOWN';
                    tokenName = tx.asset.name || 'Unknown Token';
                    decimals = parseInt(tx.asset.decimals) || 18;
                }

                console.log('[ClipX Background] Raw timestamp:', tx.timeStamp, tx.blockTimestamp);

                return {
                    tokenSymbol,
                    tokenName,
                    timeStamp: tx.timeStamp || tx.blockTimestamp,
                    value: tx.value || tx.amount,
                    decimals,
                    from: tx.from || tx.fromAddress,
                    to: tx.to || tx.toAddress,
                    hash: tx.hash || tx.transactionHash,
                    category: 'BEP20'
                };
            });

            console.log('[ClipX Background] Processed BEP20 events:', events.length);
        } else {
            console.log('[ClipX Background] No transfers found or API error:', data);
            if (data.error) {
                console.error('[ClipX Background] Full error object:', JSON.stringify(data.error, null, 2));
            }
        }

        // Sort by timestamp desc (newest first)
        console.log('[ClipX Background] Sorting transactions to newest first');
        events.sort((a, b) => {
            const timeA = parseInt(a.timeStamp) || 0;
            const timeB = parseInt(b.timeStamp) || 0;
            return timeA - timeB; // Ascending order (oldest first) - then we'll reverse
        });

        // Reverse the array to get newest first
        events.reverse();

        // Return the latest 10 transactions
        const latestTxs = events.slice(0, 10);
        console.log('[ClipX Background] Returning latest transactions:', latestTxs.length);

        sendResponse({ success: true, events: latestTxs });
    } catch (e) {
        console.error('[ClipX Background] History fetch failed:', e);
        sendResponse({ success: false, error: e.message });
    }
}

// Handle get token balance using Web3
async function handleGetTokenBalance(request, sendResponse) {
    try {
        const { tokenAddress, walletAddress } = request;

        console.log('[ClipX Background] Fetching token balance:', { tokenAddress, walletAddress });

        if (!tokenAddress || !walletAddress) {
            sendResponse({ success: false, error: 'Missing tokenAddress or walletAddress' });
            return;
        }

        // Simple ERC20 ABI for balanceOf and decimals
        const tokenABI = [
            {
                "constant": true,
                "inputs": [{ "name": "_owner", "type": "address" }],
                "name": "balanceOf",
                "outputs": [{ "name": "balance", "type": "uint256" }],
                "type": "function"
            },
            {
                "constant": true,
                "inputs": [],
                "name": "decimals",
                "outputs": [{ "name": "", "type": "uint8" }],
                "type": "function"
            }
        ];

        // Use bloXroute anti-MEV RPC for BSC
        const response = await fetch('https://bsc.rpc.blxrbdn.com', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_call',
                params: [{
                    to: tokenAddress,
                    data: '0x70a08231000000000000000000000000' + walletAddress.substring(2)
                }, 'latest']
            })
        });

        const data = await response.json();
        console.log('[ClipX Background] RPC response:', data);

        if (data.result) {
            // Use BigInt for precision with 18-decimal tokens
            const balanceWei = BigInt(data.result);
            // Divide by 10^18 (standard ERC20 decimals)
            const divisor = BigInt(10 ** 18);
            const wholePart = balanceWei / divisor;
            const fractionalPart = balanceWei % divisor;

            // Convert to number with 6 decimal places precision
            const balance = Number(wholePart) + Number(fractionalPart) / Number(divisor);

            console.log('[ClipX Background] Token balance calculated:', balance, 'wei:', balanceWei.toString());
            sendResponse({ success: true, balance: balance });
        } else {
            console.error('[ClipX Background] No result in RPC response:', data);
            sendResponse({ success: false, error: 'Failed to fetch balance' });
        }
    } catch (error) {
        console.error('[ClipX Background] Error fetching token balance:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Handle get BNB balance using Web3
async function handleGetBnbBalance(request, sendResponse) {
    try {
        const { walletAddress } = request;

        if (!walletAddress) {
            sendResponse({ success: false, error: 'Missing walletAddress' });
            return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

        // Use bloXroute anti-MEV RPC for BSC
        const response = await fetch('https://bsc.rpc.blxrbdn.com', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getBalance',
                params: [walletAddress, 'latest']
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = await response.json();

        if (data.result) {
            // Convert hex to decimal
            const balanceWei = parseInt(data.result, 16);
            // 18 decimals for BNB
            const balance = balanceWei / 1e18;

            sendResponse({ success: true, balance: balance });
        } else {
            sendResponse({ success: false, error: 'Failed to fetch BNB balance' });
        }
    } catch (error) {
        console.error('[ClipX Background] Error fetching BNB balance:', error);
        sendResponse({ success: false, error: error.name === 'AbortError' ? 'RPC timed out' : error.message });
    }
}

async function handleSendTip(request, sendResponse) {
    try {
        // Get auth token from storage (web session may only have webAuthToken)
        const stored = await chrome.storage.local.get(['authToken', 'webAuthToken', 'nativeWallet']);
        let authToken = stored.authToken || stored.webAuthToken;

        if (!authToken) {
            sendResponse({
                success: false,
                error: 'Please log in to ClipX first'
            });
            return;
        }

        // Handle Native Wallet Tipping
        if (authToken === 'native-wallet') {
            if (!stored.nativeWallet) {
                sendResponse({ success: false, error: 'Native wallet not found' });
                return;
            }
            await handleNativeTip(request, stored.nativeWallet, sendResponse);
            return;
        }

        // Make API call with token in Authorization header
        const response = await fetch(`${API_BASE}/api/send-tip-x`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                recipient: request.recipient,
                amount: request.amount,
                token: request.token,
                gasTier: request.gasTier,
                isPrivate: request.isPrivate,
                isEscrow: request.isEscrow
            })
        });

        if (response.status === 401) {
            // await chrome.storage.local.remove('authToken');
            sendResponse({
                success: false,
                error: 'Session expired. Please reload the ClipX tab.'
            });
            return;
        }

        const data = await response.json();

        if (data.success) {
            sendResponse({
                success: true,
                txHash: data.txHash
            });
        } else {
            sendResponse({
                success: false,
                error: data.error || 'Failed to send tip'
            });
        }
    } catch (error) {
        sendResponse({
            success: false,
            error: error.message
        });
    }
}

// Handle Native Wallet Tip
// Handle Native Wallet Tip
async function handleNativeTip(request, sendResponse) {
    try {
        console.log('[ClipX Background] Processing native tip...');

        // Auto-unlock from session if possible
        await ensureWalletUnlocked();

        if (!unlockedWallet) {
            sendResponse({ success: false, error: 'Wallet is locked. Please unlock it in the extension popup.' });
            return;
        }

        const amount = request.amount;
        const token = request.token;
        const recipientUsername = request.recipient;

        // 1. Resolve Recipient Address
        let recipientAddress = null;
        try {
            const userRes = await fetch(`${API_BASE}/api/user-check/${recipientUsername}`);
            const userData = await userRes.json();
            if (userData.isRegistered && userData.address) {
                recipientAddress = userData.address;
            } else {
                if (request.isEscrow) {
                    sendResponse({ success: false, error: 'Escrow not fully supported for native wallet yet.' });
                    return;
                }
                sendResponse({ success: false, error: 'Recipient not registered.' });
                return;
            }
        } catch (e) {
            sendResponse({ success: false, error: 'Failed to resolve recipient.' });
            return;
        }

        // 2. Send Transaction
        // Connect wallet to provider
        const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');
        const wallet = unlockedWallet.connect(provider);

        let tx;
        if (token === 'BNB') {
            tx = await wallet.sendTransaction({
                to: recipientAddress,
                value: ethers.parseEther(amount.toString())
            });
        } else {
            // BEP20 Token Logic (Placeholder)
            sendResponse({ success: false, error: 'Token tips not implemented for native wallet yet.' });
            return;
        }

        await tx.wait();
        sendResponse({ success: true, txHash: tx.hash });

    } catch (error) {
        console.error('Native tip failed:', error);
        sendResponse({ success: false, error: error.message });
    }
}


async function getNativeBalances(address) {
    try {
        // Use faster RPC
        const provider = new ethers.JsonRpcProvider('https://bsc.rpc.blxrbdn.com');

        // Token Addresses
        const TOKENS = {
            'CLIPX': '0xc269d59a0d608ea0bd672f2f4616c372d8554444',
            'ASTER': '0x000ae314e2a2172a039b26378814c252734f556a', // Replace
            'USDT': '0x55d398326f99059fF775485246999027B3197955'
        };

        const abi = ["function balanceOf(address owner) view returns (uint256)"];
        const balances = {};

        // Create promise for BNB
        const bnbPromise = provider.getBalance(address)
            .then(bal => {
                balances['BNB'] = ethers.formatEther(bal);
            })
            .catch(e => {
                console.error('Error fetching BNB:', e);
                balances['BNB'] = 'Error';
            });

        // Create promise for USDT (and others if needed)
        const usdtContract = new ethers.Contract(TOKENS['USDT'], abi, provider);
        const usdtPromise = usdtContract.balanceOf(address)
            .then(bal => {
                balances['USDT'] = ethers.formatEther(bal);
            })
            .catch(e => {
                // console.error('Error fetching USDT:', e); // Optional logging
                balances['USDT'] = '0.0'; // Default to 0 if fails (e.g. not deployed on testnet) or 'Error'
            });

        // Run in parallel
        await Promise.all([bnbPromise, usdtPromise]);

        return { success: true, balances };
    } catch (error) {
        console.error('Error fetching balances:', error);
        return { success: false, error: error.message };
    }
}

// --- Native Swap Implementation ---

const PANCAKESWAP_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

const ROUTER_ABI = [
    "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address account) external view returns (uint256)"
];

async function handleNativeSwap(request, sendResponse) {
    try {
        console.log('[ClipX Background] Starting native swap...');

        // Auto-unlock if needed
        await ensureWalletUnlocked();

        if (!unlockedWallet) {
            sendResponse({ success: false, error: 'Wallet is locked. Please unlock it in the extension popup.' });
            return;
        }

        const provider = new ethers.JsonRpcProvider('https://bsc.rpc.blxrbdn.com');
        const wallet = unlockedWallet.connect(provider);
        const router = new ethers.Contract(PANCAKESWAP_ROUTER, ROUTER_ABI, wallet);

        const tokenAddress = request.tokenAddress;
        const amount = request.amount; // String
        const type = request.type || 'buy';
        // Default to 10% slippage if not specified, to handle tax tokens safely
        const slippage = parseFloat(request.slippage || 10);
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

        console.log(`[ClipX Background] Native Swap: ${type} ${amount} for ${tokenAddress}, Slippage: ${slippage}%`);

        let tx;

        if (type === 'buy') {
            // BNB -> Token
            const amountIn = ethers.parseEther(amount.toString());
            const path = [WBNB_ADDRESS, tokenAddress];

            // Calculate min amount out
            const amountsOut = await router.getAmountsOut(amountIn, path);
            const amountOutExpected = amountsOut[1];
            // Calculate min out based on slippage
            const amountOutMin = amountOutExpected - (amountOutExpected * BigInt(Math.floor(slippage * 100)) / 10000n);

            console.log(`[ClipX Background] Buy: In ${amountIn}, Min Out ${amountOutMin}`);

            tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
                amountOutMin,
                path,
                wallet.address,
                deadline,
                {
                    value: amountIn,
                    gasLimit: 3000000 // High gas limit for complex tax tokens
                }
            );

        } else {
            // Token -> BNB
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

            // We need to know decimals to parse amount correctly. 
            // For MVP, assuming 18 decimals or fetching? 
            // Let's try to fetch decimals if possible, or assume 18.
            // A safer way is to fetch decimals.
            const decimalsABI = ["function decimals() view returns (uint8)"];
            const tokenDecimalsContract = new ethers.Contract(tokenAddress, decimalsABI, provider);
            let decimals = 18;
            try {
                decimals = await tokenDecimalsContract.decimals();
            } catch (e) {
                console.warn('Failed to fetch decimals, assuming 18');
            }

            let amountIn = ethers.parseUnits(amount.toString(), decimals);
            const path = [tokenAddress, WBNB_ADDRESS];

            // IMPORTANT: Check actual on-chain balance to avoid precision issues
            const balanceABI = ["function balanceOf(address) view returns (uint256)"];
            const balanceContract = new ethers.Contract(tokenAddress, balanceABI, provider);
            const actualBalance = await balanceContract.balanceOf(wallet.address);
            console.log('[ClipX Background] Sell amount requested:', amountIn.toString());
            console.log('[ClipX Background] Actual on-chain balance:', actualBalance.toString());

            // If amountIn exceeds or nearly equals actual balance (99.9%), use actual balance
            // This fixes the "100% sell fails" issue due to floating-point precision
            if (amountIn > actualBalance || amountIn >= (actualBalance * 999n / 1000n)) {
                console.log('[ClipX Background] Using actual balance for 100% sell');
                amountIn = actualBalance;
            }

            // Check Allowance
            const allowance = await tokenContract.allowance(wallet.address, PANCAKESWAP_ROUTER);
            if (allowance < amountIn) {
                console.log('[ClipX Background] Approving token...');
                const approveTx = await tokenContract.approve(PANCAKESWAP_ROUTER, ethers.MaxUint256);
                await approveTx.wait();
                console.log('[ClipX Background] Approved.');
            }

            // Calculate min amount out
            const amountsOut = await router.getAmountsOut(amountIn, path);
            const amountOutExpected = amountsOut[1];
            const amountOutMin = amountOutExpected - (amountOutExpected * BigInt(Math.floor(slippage * 100)) / 10000n);

            console.log(`[ClipX Background] Sell: In ${amountIn}, Min Out ${amountOutMin}`);

            tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
                amountIn,
                amountOutMin,
                path,
                wallet.address,
                deadline,
                { gasLimit: 3000000 } // High gas limit
            );
        }

        console.log('[ClipX Background] Swap TX sent:', tx.hash);
        await tx.wait();
        console.log('[ClipX Background] Swap confirmed');

        sendResponse({ success: true, txHash: tx.hash, message: 'Swap successful' });

    } catch (error) {
        console.error('[ClipX Background] Native swap failed:', error);
        // Handle specific errors like gas, slippage
        let errorMsg = error.message;
        if (errorMsg.includes('INSUFFICIENT_OUTPUT_AMOUNT')) errorMsg = 'Slippage too low';
        if (errorMsg.includes('insufficient funds')) errorMsg = 'Insufficient BNB for gas';

        sendResponse({ success: false, error: errorMsg });
    }
}

// Handle Get Wallet Assets via BSCScan API
async function handleGetWalletAssets(request, sendResponse) {
    try {
        const { walletAddress } = request;

        if (!walletAddress) {
            sendResponse({ success: false, error: 'Missing walletAddress' });
            return;
        }

        // BSCScan API endpoint for BEP-20 token transfers
        // Note: Using free API, may have rate limits
        const apiKey = '7X3W6GJFB9TMNG29J4TNAWJSBA8WDWPSHB'; // User should replace with their BSCScan API key
        const url = `https://api.bscscan.com/api?module=account&action=tokentx&address=${walletAddress}&startblock=0&endblock=99999999&sort=asc&apikey=${apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status === '1' && data.result) {
            // Extract unique token addresses
            const tokenAddresses = [...new Set(data.result.map(tx => tx.contractAddress))];

            sendResponse({
                success: true,
                tokens: tokenAddresses.slice(0, 50) // Limit to 50 tokens
            });
        } else {
            sendResponse({ success: false, error: 'No tokens found or API error' });
        }
    } catch (error) {
        console.error('[ClipX Background] Error fetching wallet assets:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Handle Get Token Metadata via GMGN API
async function handleGetTokenMetadata(request, sendResponse) {
    try {
        const { tokenAddress } = request;

        if (!tokenAddress) {
            sendResponse({ success: false, error: 'Missing tokenAddress' });
            return;
        }

        // Try GMGN API first
        try {
            const gmgnUrl = `https://gmgn.ai/defi/quotation/v1/tokens/bsc/${tokenAddress}`;
            const gmgnResponse = await fetch(gmgnUrl);
            const gmgnData = await gmgnResponse.json();

            if (gmgnData && gmgnData.data && gmgnData.data.token) {
                const token = gmgnData.data.token;
                sendResponse({
                    success: true,
                    name: token.name || 'Unknown',
                    symbol: token.symbol || '???',
                    decimals: token.decimals || 18,
                    source: 'gmgn'
                });
                return;
            }
        } catch (gmgnError) {
            console.log('[ClipX Background] GMGN API failed, trying DexScreener:', gmgnError);
        }

        // Fallback to DexScreener
        const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
        const dexResponse = await fetch(dexUrl);
        const dexData = await dexResponse.json();

        if (dexData.pairs && dexData.pairs.length > 0) {
            const pair = dexData.pairs[0];
            const token = pair.baseToken.address.toLowerCase() === tokenAddress.toLowerCase()
                ? pair.baseToken
                : pair.quoteToken;

            sendResponse({
                success: true,
                name: token.name || 'Unknown',
                symbol: token.symbol || '???',
                decimals: 18, // DexScreener doesn't provide decimals
                source: 'dexscreener'
            });
        } else {
            sendResponse({ success: false, error: 'Token not found' });
        }
    } catch (error) {
        console.error('[ClipX Background] Error fetching token metadata:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Social Metrics Cache (5 minute cache)
const socialMetricsCache = new Map();
const SOCIAL_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Handle Social Metrics Fetching
async function handleFetchSocialMetrics(request, sendResponse) {
    try {
        const { address, symbol } = request;

        if (!address && !symbol) {
            sendResponse({ success: false, error: 'No address or symbol provided' });
            return;
        }

        // Check cache first
        const cacheKey = address || symbol;
        const cached = socialMetricsCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < SOCIAL_CACHE_DURATION) {
            console.log('[ClipX Background] Using cached social metrics for:', cacheKey);
            sendResponse(cached.data);
            return;
        }

        console.log('[ClipX Background] Fetching social metrics for:', cacheKey);

        // Try LunarCrush first (preferred for crypto social data)
        let metrics = await tryLunarCrush(symbol || address);

        // Fallback to CoinGecko if LunarCrush fails
        if (!metrics) {
            console.log('[ClipX Background] LunarCrush failed, trying CoinGecko...');
            metrics = await tryCoinGecko(symbol || address, address);
        }

        if (metrics) {
            const response = {
                success: true,
                metrics: metrics,
                source: metrics.source
            };

            // Cache the result
            socialMetricsCache.set(cacheKey, {
                data: response,
                timestamp: Date.now()
            });

            sendResponse(response);
        } else {
            sendResponse({
                success: false,
                error: 'No social metrics available',
                metrics: null
            });
        }
    } catch (error) {
        console.error('[ClipX Background] Error fetching social metrics:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Try LunarCrush API for Social Metrics
async function tryLunarCrush(symbolOrAddress) {
    try {
        // LunarCrush uses symbols, not addresses
        // For BSC tokens, we need to map common symbols
        let searchSymbol = symbolOrAddress;

        // If it looks like an address, try to get symbol from our token map
        if (symbolOrAddress.startsWith('0x')) {
            // Try to find symbol in our priority tokens
            const priorityToken = Object.entries(PRIORITY_TOKENS).find(
                ([, token]) => token.address.toLowerCase() === symbolOrAddress.toLowerCase()
            );
            if (priorityToken) {
                searchSymbol = priorityToken[0];
            } else {
                // Can't search LunarCrush by address
                return null;
            }
        }

        // LunarCrush Free API endpoint (v3)
        // Note: Free tier has limited access, may need API key for full access
        const url = `https://lunarcrush.com/api4/public/coins/${searchSymbol}/v1`;

        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            console.log('[ClipX Background] LunarCrush API error:', response.status);
            return null;
        }

        const data = await response.json();

        if (data && data.data) {
            const coinData = data.data;

            return {
                twitterMentions24h: coinData.tweets_24h || 0,
                twitterMentions1h: coinData.tweets_1h || 0,
                socialVolume: coinData.social_volume || 0,
                sentiment: coinData.social_score || 0, // -100 to +100
                trendingRank: coinData.galaxy_score_rank || null,
                socialScore: coinData.galaxy_score || 0,
                socialContributors: coinData.social_contributors || 0,
                lastUpdated: Date.now(),
                source: 'LunarCrush'
            };
        }

        return null;
    } catch (error) {
        console.log('[ClipX Background] LunarCrush error:', error.message);
        return null;
    }
}

// Try CoinGecko API for Social Metrics (fallback)
async function tryCoinGecko(symbol, address) {
    try {
        // CoinGecko requires coin ID, not symbol or address
        // First, try to find the coin ID by searching

        let coinId = null;

        // Try to search by symbol first
        const searchUrl = `https://api.coingecko.com/api/v3/search?query=${symbol}`;
        const searchResponse = await fetch(searchUrl);

        if (searchResponse.ok) {
            const searchData = await searchResponse.json();

            // Try to find BSC token by matching address if provided
            if (address && searchData.coins) {
                const match = searchData.coins.find(coin => {
                    return coin.platforms &&
                        coin.platforms['binance-smart-chain'] &&
                        coin.platforms['binance-smart-chain'].toLowerCase() === address.toLowerCase();
                });

                if (match) {
                    coinId = match.id;
                }
            }

            // Fallback to first result if no address match
            if (!coinId && searchData.coins && searchData.coins.length > 0) {
                coinId = searchData.coins[0].id;
            }
        }

        if (!coinId) {
            console.log('[ClipX Background] Could not find CoinGecko coin ID');
            return null;
        }

        // Fetch coin data including social metrics
        const coinUrl = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false&sparkline=false`;
        const coinResponse = await fetch(coinUrl);

        if (!coinResponse.ok) {
            console.log('[ClipX Background] CoinGecko coin API error:', coinResponse.status);
            return null;
        }

        const coinData = await coinResponse.json();

        if (coinData) {
            // CoinGecko provides community data and market data
            const community = coinData.community_data || {};
            const sentiment = coinData.sentiment_votes_up_percentage || 50;

            // Calculate a sentiment score from -100 to +100
            const sentimentScore = (sentiment - 50) * 2; // Convert 0-100 to -100 to +100

            return {
                twitterMentions24h: community.twitter_followers || 0,
                twitterMentions1h: 0, // CoinGecko doesn't provide 1h data
                socialVolume: (community.twitter_followers || 0) + (community.telegram_channel_user_count || 0),
                sentiment: Math.round(sentimentScore),
                trendingRank: coinData.market_cap_rank || null,
                socialScore: community.twitter_followers || 0,
                socialContributors: (community.twitter_followers || 0) + (community.reddit_subscribers || 0),
                lastUpdated: Date.now(),
                source: 'CoinGecko'
            };
        }

        return null;
    } catch (error) {
        console.log('[ClipX Background] CoinGecko error:', error.message);
        return null;
    }

}

/* Native Transfer (BNB or Token) */

async function handleNativeTransfer(request, sendResponse) {
    // Auto-unlock if needed
    await ensureWalletUnlocked();

    if (!unlockedWallet) {
        sendResponse({ success: false, error: 'Wallet locked' });
        return;
    }
    try {
        const { to, amount, tokenAddress } = request;
        const provider = new ethers.JsonRpcProvider('https://bsc.rpc.blxrbdn.com');
        const wallet = unlockedWallet.connect(provider);

        // Basic validation
        if (!ethers.isAddress(to)) throw new Error('Invalid recipient address');

        let tx;
        if (!tokenAddress || tokenAddress === 'BNB') {
            // Send BNB
            const amountWei = ethers.parseEther(amount.toString());
            tx = await wallet.sendTransaction({
                to: to,
                value: amountWei,
                // gasLimit, gasPrice auto-estimated
            });
        } else {
            // Send Token
            const abi = [
                'function transfer(address to, uint256 amount) external returns (bool)',
                'function decimals() external view returns (uint8)'
            ];
            const contract = new ethers.Contract(tokenAddress, abi, wallet);
            const decimals = await contract.decimals();
            const amountWei = ethers.parseUnits(amount.toString(), decimals);
            tx = await contract.transfer(to, amountWei);
        }

        await tx.wait(); // Wait for 1 block confirm if desired, or just return hash
        sendResponse({ success: true, txHash: tx.hash });
    } catch (e) {
        console.error('Transfer failed:', e);
        sendResponse({ success: false, error: e.message || e.reason });
    }
}

// --- Fetch User Tweets for ClipX Intel ---
async function handleFetchUserTweets(request, sendResponse) {
    const { username, count = 50 } = request;

    if (!username) {
        sendResponse({ success: false, error: 'Username required' });
        return;
    }

    console.log(`[ClipX Intel] Fetching tweets for @${username}...`);

    try {
        // Strategy 1: Try multiple Nitter instances first (more reliable for 100+ tweets)
        let tweets = [];
        const seenIds = new Set();

        // Helper to add tweet without duplicates
        const addTweet = (tweet) => {
            if (tweet.id && seenIds.has(tweet.id)) return false;
            if (tweet.id) seenIds.add(tweet.id);
            tweets.push(tweet);
            return true;
        };

        // Helper to extract tweets from syndication HTML
        const extractFromSyndication = (html) => {
            const extracted = [];

            // Strategy 1: Try to find embedded JSON in script tags (Twitter embeds data this way)
            // Look for __NEXT_DATA__ or similar patterns
            const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
            if (nextDataMatch) {
                try {
                    const data = JSON.parse(nextDataMatch[1]);
                    // Navigate through Next.js data structure
                    const timeline = data?.props?.pageProps?.timeline?.entries || [];
                    timeline.forEach(entry => {
                        const tweet = entry?.content?.tweet || entry?.tweet;
                        if (tweet && (tweet.full_text || tweet.text)) {
                            extracted.push({
                                id: tweet.id_str || tweet.id,
                                text: tweet.full_text || tweet.text,
                                metrics: {
                                    likes: tweet.favorite_count || tweet.public_metrics?.like_count || 0,
                                    retweets: tweet.retweet_count || tweet.public_metrics?.retweet_count || 0
                                }
                            });
                        }
                    });
                    if (extracted.length > 0) {
                        console.log(`[ClipX Intel] Extracted ${extracted.length} tweets from __NEXT_DATA__`);
                        return extracted;
                    }
                } catch (e) {
                    console.log('[ClipX Intel] __NEXT_DATA__ parsing failed:', e.message);
                }
            }

            // Strategy 1b: Try window.__INITIAL_STATE__
            const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
            if (jsonMatch) {
                try {
                    const data = JSON.parse(jsonMatch[1]);
                    const tweets = data?.tweets || {};
                    Object.values(tweets).forEach(tweet => {
                        if (tweet.full_text || tweet.text) {
                            extracted.push({
                                id: tweet.id_str || tweet.id,
                                text: tweet.full_text || tweet.text,
                                metrics: {
                                    likes: tweet.favorite_count || 0,
                                    retweets: tweet.retweet_count || 0
                                }
                            });
                        }
                    });
                    if (extracted.length > 0) {
                        console.log(`[ClipX Intel] Extracted ${extracted.length} tweets from __INITIAL_STATE__`);
                        return extracted;
                    }
                } catch (e) {
                    console.log('[ClipX Intel] __INITIAL_STATE__ parsing failed');
                }
            }

            // Strategy 1c: Look for any JSON with tweet data in script tags
            const allScripts = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
            for (const scriptMatch of allScripts) {
                const script = scriptMatch[1];
                // Look for tweet-like JSON objects
                if (script.includes('"favorite_count"') || script.includes('"like_count"')) {
                    try {
                        // Try to find and parse JSON objects
                        const jsonObjects = script.match(/\{[^{}]*"(?:full_text|text)"[^{}]*\}/g) || [];
                        for (const jsonStr of jsonObjects) {
                            try {
                                const obj = JSON.parse(jsonStr);
                                if (obj.full_text || obj.text) {
                                    extracted.push({
                                        id: obj.id_str || obj.id,
                                        text: obj.full_text || obj.text,
                                        metrics: {
                                            likes: obj.favorite_count || obj.like_count || 0,
                                            retweets: obj.retweet_count || 0
                                        }
                                    });
                                }
                            } catch (e) { /* skip invalid JSON */ }
                        }
                    } catch (e) { }
                }
            }

            if (extracted.length > 0) {
                console.log(`[ClipX Intel] Extracted ${extracted.length} tweets from script JSON`);
                return extracted;
            }

            // Strategy 2: Look for script with tweet data
            const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
            for (const sm of scriptMatches) {
                const script = sm[1];
                if (script.includes('favorite_count') || script.includes('retweet_count')) {
                    try {
                        // Try to extract tweet objects
                        const tweetObjMatch = script.match(/\{[^{}]*"id_str"\s*:\s*"(\d+)"[^{}]*"full_text"\s*:\s*"([^"]*)"[^{}]*"favorite_count"\s*:\s*(\d+)[^{}]*"retweet_count"\s*:\s*(\d+)[^{}]*\}/g);
                        if (tweetObjMatch) {
                            for (const obj of tweetObjMatch) {
                                const id = obj.match(/"id_str"\s*:\s*"(\d+)"/)?.[1];
                                const text = obj.match(/"full_text"\s*:\s*"([^"]*)"/)?.[1];
                                const likes = parseInt(obj.match(/"favorite_count"\s*:\s*(\d+)/)?.[1] || 0, 10);
                                const rts = parseInt(obj.match(/"retweet_count"\s*:\s*(\d+)/)?.[1] || 0, 10);
                                if (id && text) {
                                    extracted.push({ id, text, metrics: { likes, retweets: rts } });
                                }
                            }
                        }
                    } catch (e) { }
                }
            }

            if (extracted.length > 0) {
                console.log(`[ClipX Intel] Extracted ${extracted.length} tweets from script tags`);
                return extracted;
            }

            // Strategy 3: HTML parsing fallback
            const tweetBlockRegex = /<div[^>]*class="[^"]*timeline-Tweet[^"]*"[^>]*data-tweet-id="(\d+)"[^>]*>([\s\S]*?)<\/div>/gi;
            const tweetBlockMatches = html.matchAll(tweetBlockRegex);

            for (const match of tweetBlockMatches) {
                const id = match[1];
                const content = match[2];
                const textMatch = content.match(/<p[^>]*class="[^"]*timeline-Tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/);

                let likes = 0, retweets = 0;
                const likeMatch = content.match(/data-tweet-stat-count="(\d+)"[\s\S]*?heart/i);
                if (likeMatch) likes = parseInt(likeMatch[1], 10);
                const rtMatch = content.match(/data-tweet-stat-count="(\d+)"[\s\S]*?retweet/i);
                if (rtMatch) retweets = parseInt(rtMatch[1], 10);

                if (textMatch) {
                    const text = textMatch[1]
                        .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                        .replace(/\s+/g, ' ').trim();
                    if (text) extracted.push({ id, text, metrics: { likes, retweets } });
                }
            }

            // Final fallback - just get text
            if (extracted.length === 0) {
                const tweetTextRegex = /<p[^>]*class="[^"]*timeline-Tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
                const tweetMatches = html.matchAll(tweetTextRegex);
                for (const match of tweetMatches) {
                    const text = match[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
                    if (text) extracted.push({ text, metrics: { likes: 0, retweets: 0 } });
                }
            }

            return extracted;
        };

        // Try Syndication API with retry logic
        console.log(`[ClipX Intel] Trying Syndication API for ${count} tweets...`);
        const syndicationUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${username}?showReplies=false`;

        // Retry up to 3 times for better reliability
        let syndicationSuccess = false;
        for (let attempt = 1; attempt <= 3 && !syndicationSuccess; attempt++) {
            try {
                const response = await fetch(syndicationUrl, {
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });

                if (response.ok) {
                    const html = await response.text();
                    const extracted = extractFromSyndication(html);
                    for (const tweet of extracted) {
                        if (tweets.length >= count) break;
                        if (tweet.id && seenIds.has(tweet.id)) continue;
                        if (tweet.id) seenIds.add(tweet.id);
                        addTweet(tweet);
                    }
                    console.log(`[ClipX Intel] Syndication attempt ${attempt} added ${extracted.length} tweets, total: ${tweets.length}`);
                    if (tweets.length >= 10) syndicationSuccess = true; // Consider success if we got decent amount
                } else {
                    console.log(`[ClipX Intel] Syndication attempt ${attempt} failed with status ${response.status}`);
                }
            } catch (e) {
                console.log(`[ClipX Intel] Syndication attempt ${attempt} error:`, e.message);
            }

            // Small delay between retries
            if (!syndicationSuccess && attempt < 3) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // Fallback: Try Nitter instances if we need more tweets
        if (tweets.length < count) {
            console.log(`[ClipX Intel] Syndication returned ${tweets.length}, trying Nitter for more...`);
            const nitterInstances = [
                'nitter.net',
                'nitter.privacydev.net',
                'nitter.poast.org'
            ];

            for (const instance of nitterInstances) {
                if (tweets.length >= count) break;

                try {
                    const nitterUrl = `https://${instance}/${username}`;
                    console.log(`[ClipX Intel] Trying ${instance}...`);

                    const nitterRes = await fetch(nitterUrl, {
                        headers: {
                            'Accept': 'text/html',
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });

                    if (!nitterRes.ok) continue;

                    const nitterHtml = await nitterRes.text();
                    let foundOnPage = 0;

                    // Extract tweets from Nitter HTML
                    const simpleRegex = /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
                    const simpleMatches = [...nitterHtml.matchAll(simpleRegex)];

                    for (const match of simpleMatches) {
                        if (tweets.length >= count) break;
                        const text = match[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
                        if (text && text.length > 5) {
                            tweets.push({ text, metrics: { likes: 0, retweets: 0 } });
                            foundOnPage++;
                        }
                    }

                    console.log(`[ClipX Intel] Nitter ${instance} added ${foundOnPage} tweets, total: ${tweets.length}`);
                    if (foundOnPage > 0) break;
                } catch (e) {
                    console.log(`[ClipX Intel] Nitter ${instance} failed:`, e.message);
                }
            }
        }

        console.log(`[ClipX Intel] Final tweet count: ${tweets.length} for @${username}`);

        // Log sample of tweets to debug metrics
        if (tweets.length > 0) {
            console.log('[ClipX Intel] Sample tweet metrics:', tweets.slice(0, 3).map(t => ({
                hasMetrics: !!t.metrics,
                likes: t.metrics?.likes,
                retweets: t.metrics?.retweets
            })));
        }

        // Extract tickers and addresses from all tweets
        const tickers = new Map(); // Map<ticker, { count, tweetId }>
        const addresses = new Map(); // Use Map to store address -> tweetID
        let totalLikes = 0;
        let totalRetweets = 0;
        let tweetsWithMetrics = 0;

        const tickerRegex = /\$[a-zA-Z]{2,10}\b/g;
        const addressRegex = /0x[a-fA-F0-9]{40}\b/g;

        tweets.forEach(tweet => {
            const foundTickers = tweet.text.match(tickerRegex) || [];
            const foundAddresses = tweet.text.match(addressRegex) || [];

            // Accumulate metrics
            if (tweet.metrics && (tweet.metrics.likes > 0 || tweet.metrics.retweets > 0)) {
                totalLikes += tweet.metrics.likes || 0;
                totalRetweets += tweet.metrics.retweets || 0;
                tweetsWithMetrics++;
            }

            foundTickers.forEach(t => {
                const ticker = t.toUpperCase();
                const existing = tickers.get(ticker) || { count: 0, tweetId: null };

                // Store first tweetId found for this ticker
                if (!existing.tweetId && tweet.id) {
                    existing.tweetId = tweet.id;
                }

                existing.count++;
                tickers.set(ticker, existing);
            });

            foundAddresses.forEach(a => {
                // Store the first tweet ID where this address was found
                if (!addresses.has(a)) {
                    addresses.set(a, tweet.id);
                }
            });
        });

        // Calculate average based on tweets that actually have metrics
        const avgLikes = tweetsWithMetrics > 0 ? Math.round(totalLikes / tweetsWithMetrics) : 0;
        const avgRetweets = tweetsWithMetrics > 0 ? Math.round(totalRetweets / tweetsWithMetrics) : 0;

        console.log(`[ClipX Intel] Metrics summary: ${tweetsWithMetrics}/${tweets.length} tweets with metrics, avgLikes: ${avgLikes}, totalLikes: ${totalLikes}`);

        sendResponse({
            success: true,
            tweets: tweets.slice(0, count),
            tickers: Array.from(tickers.entries()), // Send as [[ticker, {count, tweetId}], ...]
            addresses: Array.from(addresses.entries()), // Send as [[addr, id], ...]
            metrics: {
                totalLikes,
                totalRetweets,
                avgLikes,
                avgRetweets,
                tweetsWithMetrics
            },
            totalFetched: tweets.length
        });

    } catch (error) {
        console.error('[ClipX Intel] Tweet fetch error:', error);
        sendResponse({ success: false, error: error.message });
    }
}


// --- Profile Label API Helpers ---

async function getProfileLabel(handle) {
    try {
        const response = await fetch(`${API_BASE}/api/labels/${handle}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) {
            if (response.status === 404) return { label: null };
            console.log('[ClipX Background] Label API mismatch/error, returning null');
            return { label: null };
        }
        const data = await response.json();

        // Cache the REAL API result locally to build the categories list
        if (data && data.label) {
            cacheLabelLocally(handle, data.label, data.category || 'Identity');
        }

        return data;
    } catch (e) {
        console.error('[ClipX Background] Failed to fetch label:', e);
        return { label: null };
    }
}

// Helper to cache labels locally acting as a "Local Database" of real API data
async function cacheLabelLocally(handle, label, category = 'Identity') {
    try {
        const result = await chrome.storage.local.get(['labeledUsers']);
        let users = result.labeledUsers || {};

        if (!users[handle.toLowerCase()]) {
            users[handle.toLowerCase()] = {
                handle: handle,
                name: handle,
                label: label,
                category: label,
                timestamp: Date.now()
            };
        } else {
            users[handle.toLowerCase()].label = label;
            users[handle.toLowerCase()].category = label;
            users[handle.toLowerCase()].timestamp = Date.now();
        }

        await chrome.storage.local.set({ labeledUsers: users });
    } catch (e) {
        console.error('[ClipX] Failed to cache label:', e);
    }
}

async function saveProfileLabel(handle, label, color) {
    try {
        const storage = await chrome.storage.local.get(['webUserAddress', 'userAddress', 'authToken', 'webAuthToken']);

        // Use any available user address
        const userAddr = storage.webUserAddress || storage.userAddress || 'anonymous';
        console.log('[ClipX Background] saveProfileLabel - user address:', userAddr, 'storage:', storage);

        const response = await fetch(`${API_BASE}/api/labels`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ handle, label_text: label, color, updated_by: userAddr })
        });

        if (!response.ok) throw new Error('API Error: ' + response.statusText);

        // Update local cache with this new real data
        await cacheLabelLocally(handle, label);

        return await response.json();
    } catch (e) {
        console.error('[ClipX Background] Failed to save label (Backend likely missing):', e);
        return { success: false, error: e.message };
    }
}



// TweetScout Smart Followers Cache (permanent — only refreshed via force or server-side version check)
const tweetScoutCache = new Map();

// Handle TweetScout Info Request
async function handleGetTweetScoutInfo(request, sendResponse) {
    const { handle } = request;

    if (!handle) {
        sendResponse({ success: false, error: 'Handle required' });
        return;
    }

    // Check in-memory cache (permanent, no expiry)
    const cached = tweetScoutCache.get(handle.toLowerCase());
    if (cached) {
        console.log('[ClipX Background] Using cached TweetScout data for:', handle);
        sendResponse(cached.data);
        return;
    }

    console.log('[ClipX Background] Fetching TweetScout info for:', handle);

    try {
        const response = await fetch(`${API_BASE}/api/tweetscout/info/${handle}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            if (response.status === 404) {
                sendResponse({ success: false, error: 'Account not found' });
                return;
            }
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        console.log('[ClipX Background] TweetScout data received:', JSON.stringify(data).slice(0, 500));

        // Parse TweetScout response and extract key info
        const result = {
            success: true,
            score: data.score || data.account_score || 0,
            topFollowersCount: data.top_followers_count || data.followers_count || 0,
            topFollowers: (data.top_followers || []).slice(0, 10).map(f => ({
                username: f.username || f.handle || f.screeName,
                name: f.name || f.display_name,
                avatar: f.avatar || f.profile_image_url,
                type: f.type || f.category || 'kol', // VC, KOL, Project
                score: f.score || 0
            })),
            categories: {
                // Use new field names from followers-stats API
                vcs: data.venture_capitals_count || (data.top_followers || []).filter(f => (f.type || '').toLowerCase().includes('vc')).length,
                kols: data.influencers_count || (data.top_followers || []).filter(f => (f.type || '').toLowerCase().includes('kol')).length,
                projects: data.projects_count || (data.top_followers || []).filter(f => (f.type || '').toLowerCase().includes('project')).length
            },
            // Include handle history for username changes
            handle_history: data.handle_history || []
        };


        // Cache the result
        tweetScoutCache.set(handle.toLowerCase(), {
            data: result,
            timestamp: Date.now()
        });

        sendResponse(result);
    } catch (error) {
        console.error('[ClipX Background] TweetScout fetch error:', error);
        sendResponse({ success: false, error: error.message });
    }
}


// ========================================
// FOUR.MEME INTEGRATION
// ========================================

// Load four.meme ABIs
async function loadFourMemeABIs() {
    try {
        const [tokenManager2Response, helper3Response] = await Promise.all([
            fetch(chrome.runtime.getURL('src/contracts/TokenManager2.lite.abi')),
            fetch(chrome.runtime.getURL('src/contracts/TokenManagerHelper3.abi'))
        ]);

        const tokenManager2ABI = await tokenManager2Response.json();
        const helper3ABI = await helper3Response.json();

        return { tokenManager2ABI, helper3ABI };
    } catch (e) {
        console.error('[ClipX] Failed to load four.meme ABIs:', e);
        return null;
    }
}

// Check if token is from four.meme and get bonding curve status
async function handleGetFourMemeTokenInfo(request, sendResponse) {
    const { tokenAddress } = request;

    if (!tokenAddress) {
        sendResponse({ success: false, error: 'No token address provided' });
        return;
    }

    try {
        const abis = await loadFourMemeABIs();
        if (!abis) {
            sendResponse({ success: false, error: 'Failed to load ABIs' });
            return;
        }

        const provider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
        const helper = new ethers.Contract(FOURMEME_HELPER3, abis.helper3ABI, provider);

        // Call getTokenInfo to check if this is a four.meme token
        const tokenInfo = await helper.getTokenInfo(tokenAddress);

        // tokenInfo returns: [version, tokenManager, quote, lastPrice, tradingFeeRate, minTradingFee, 
        //                     launchTime, offers, maxOffers, funds, maxFunds, liquidityAdded]

        const isFourMeme = tokenInfo[0] > 0; // version > 0 means it's a four.meme token

        if (!isFourMeme) {
            sendResponse({
                success: true,
                isFourMeme: false
            });
            return;
        }

        const version = Number(tokenInfo[0]);
        const tokenManager = tokenInfo[1];
        const quote = tokenInfo[2];
        const lastPrice = tokenInfo[3];
        const tradingFeeRate = tokenInfo[4];
        const minTradingFee = tokenInfo[5];
        const launchTime = Number(tokenInfo[6]);
        const offers = tokenInfo[7];
        const maxOffers = tokenInfo[8];
        const funds = tokenInfo[9];
        const maxFunds = tokenInfo[10];
        const liquidityAdded = tokenInfo[11];

        // Detect X Mode exclusive tokens
        const tokenManager2 = new ethers.Contract(FOURMEME_TOKEN_MANAGER2, abis.tokenManager2ABI, provider);
        const tokenInfoEx = await tokenManager2._tokenInfos(tokenAddress);
        const template = Number(tokenInfoEx.template);
        const isXMode = (template & 0x10000) > 0;

        const bondingData = {
            version,
            tokenManager,
            quote: quote === ethers.ZeroAddress ? null : quote, // null means BNB, otherwise BEP20
            lastPrice: ethers.formatEther(lastPrice),
            tradingFeeRate: Number(tradingFeeRate) / 10000, // Convert to decimal (e.g., 0.01 for 1%)
            minTradingFee: ethers.formatEther(minTradingFee),
            launchTime,
            offers: ethers.formatEther(offers),
            maxOffers: ethers.formatEther(maxOffers),
            funds: ethers.formatEther(funds),
            maxFunds: ethers.formatEther(maxFunds),
            liquidityAdded,
            isUnbonded: !liquidityAdded, // Token is unbonded if liquidity hasn't been added
            bondingProgress: Number(funds) / Number(maxFunds), // 0 to 1
            isXMode
        };

        sendResponse({
            success: true,
            isFourMeme: true,
            bondingData
        });

    } catch (e) {
        console.error('[ClipX] Error getting four.meme token info:', e);
        sendResponse({ success: false, error: e.message });
    }
}

// Buy four.meme unbonded token
async function buyFourMemeToken(tokenAddress, amountBNB, slippage = 0.05) { // Increased default slippage to 5%
    await ensureWalletUnlocked();

    if (!unlockedWallet) {
        throw new Error('Wallet not unlocked');
    }

    const abis = await loadFourMemeABIs();
    if (!abis) throw new Error('Failed to load ABIs');

    const provider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
    const wallet = unlockedWallet.connect(provider);

    const helper = new ethers.Contract(FOURMEME_HELPER3, abis.helper3ABI, provider);
    const tokenManager2 = new ethers.Contract(FOURMEME_TOKEN_MANAGER2, abis.tokenManager2ABI, wallet);

    // Get estimation using tryBuy (amount=0, funds=amountBNB)
    const fundsWei = ethers.parseEther(amountBNB.toString());
    const estimation = await helper.tryBuy(tokenAddress, 0, fundsWei);

    // estimation returns: [tokenManager, quote, estimatedAmount, estimatedCost, estimatedFee, 
    //                      amountMsgValue, amountApproval, amountFunds]

    const correctTokenManagerAddress = estimation[0];
    const estimatedAmount = estimation[2];
    const amountMsgValue = estimation[5];
    const amountFunds = estimation[7];

    // Calculate minAmount with slippage
    const minAmount = estimatedAmount * BigInt(Math.floor((1 - slippage) * 10000)) / BigInt(10000);

    console.log('[ClipX] Buying four.meme token:', {
        tokenAddress,
        manager: correctTokenManagerAddress,
        funds: ethers.formatEther(amountFunds),
        minAmount: ethers.formatEther(minAmount),
        msgValue: ethers.formatEther(amountMsgValue)
    });

    // Use the correct TokenManager contract instance
    const dynamicTokenManager = new ethers.Contract(correctTokenManagerAddress, abis.tokenManager2ABI, wallet);

    // Call buyTokenAMAP (As Much As Possible with specified funds)
    const tx = await dynamicTokenManager.buyTokenAMAP(
        tokenAddress,
        wallet.address,
        amountFunds,
        minAmount,
        {
            value: amountMsgValue,
            gasLimit: 3000000 // High gas limit for safety
        }
    );

    const receipt = await tx.wait();
    return {
        success: true,
        transactionHash: receipt.hash,
        receipt
    };
}

// Sell four.meme unbonded token
async function sellFourMemeToken(tokenAddress, amount, slippage = 0.05) { // Increased default slippage to 5%
    await ensureWalletUnlocked();

    if (!unlockedWallet) {
        throw new Error('Wallet not unlocked');
    }

    const abis = await loadFourMemeABIs();
    if (!abis) throw new Error('Failed to load ABIs');

    const provider = new ethers.JsonRpcProvider('https://bsc-dataseed1.binance.org');
    const wallet = unlockedWallet.connect(provider);

    const helper = new ethers.Contract(FOURMEME_HELPER3, abis.helper3ABI, provider);
    const tokenManager2 = new ethers.Contract(FOURMEME_TOKEN_MANAGER2, abis.tokenManager2ABI, wallet);

    // Get estimation using trySell
    const amountWei = ethers.parseEther(amount.toString());
    const estimation = await helper.trySell(tokenAddress, amountWei);

    // estimation returns: [tokenManager, quote, funds, fee]
    const correctTokenManagerAddress = estimation[0];
    const expectedFunds = estimation[2];

    // Calculate minFunds with slippage 
    const minFunds = expectedFunds * BigInt(Math.floor((1 - slippage) * 10000)) / BigInt(10000);

    console.log('[ClipX] Selling four.meme token:', {
        tokenAddress,
        manager: correctTokenManagerAddress,
        amount: ethers.formatEther(amountWei),
        minFunds: ethers.formatEther(minFunds)
    });

    // Approve token spending first - MUST approve the correct Manager contract
    const tokenABI = ['function approve(address spender, uint256 amount) returns (bool)'];
    const tokenContract = new ethers.Contract(tokenAddress, tokenABI, wallet);

    console.log('[ClipX] Approving token manager:', correctTokenManagerAddress);
    const approveTx = await tokenContract.approve(correctTokenManagerAddress, amountWei);
    await approveTx.wait();

    // Use the correct TokenManager contract instance
    const dynamicTokenManager = new ethers.Contract(correctTokenManagerAddress, abis.tokenManager2ABI, wallet);

    // Call sellToken
    const tx = await dynamicTokenManager.sellToken(
        tokenAddress,
        amountWei,
        minFunds, // Add minFunds parameter if supported by ABI or verify overload
        { gasLimit: 3000000 } // High gas limit for safety
    );

    const receipt = await tx.wait();
    return {
        success: true,
        transactionHash: receipt.hash,
        receipt
    };
}
