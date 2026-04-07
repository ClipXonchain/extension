// ClipX Tipping Assistant - Background Service Worker
importScripts('../lib/ethers.js');

const API_BASE = 'https://clipx.app';
// const API_BASE = 'http://localhost:5000';

// KOL Database API endpoint (same as API_BASE)
const KOL_API_BASE = API_BASE;

let unlockedWallet = null;

// Cache for KOL data to avoid repeated API calls
let kolCache = null;
let kolCacheTime = 0;
const KOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Handle messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'sendTip') {
        handleSendTip(request, sendResponse);
        return true;
    }
    if (request.action === 'openPopup') {
        chrome.action.openPopup();
        sendResponse({ success: true });
    }
    if (request.action === 'openOptionsPage') {
        chrome.runtime.openOptionsPage();
        sendResponse({ success: true });
        return true;
    }
    if (request.action === 'syncAuth') {
        // Don't let web/Twitter auth overwrite an active native wallet session
        chrome.storage.local.get(['authToken'], (current) => {
            const existing = current.authToken;

            // If already in native-wallet mode and incoming auth is different, ignore it
            if (existing === 'native-wallet' && request.authToken !== 'native-wallet') {
                console.log('[ClipX Background] Ignoring web auth sync because native wallet is active');
                sendResponse({ success: false, reason: 'native-wallet-active' });
                return;
            }

            chrome.storage.local.set({
                authToken: request.authToken,
                userAddress: request.userAddress
            }, () => {
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
    if (request.action === 'fetchTokenInfo') {
        fetch(`https://api.dexscreener.com/latest/dex/tokens/${request.address}`)
            .then(res => res.json())
            .then(data => {
                if (data.pairs && data.pairs.length > 0) {
                    // Get the first pair (usually the most liquid one)
                    const pair = data.pairs[0];
                    sendResponse({
                        success: true,
                        symbol: pair.baseToken.symbol,
                        name: pair.baseToken.name,
                        priceUsd: pair.priceUsd,
                        priceChange: pair.priceChange ? pair.priceChange.h24 : 0,
                        // Use FDV or marketCap as an approximation for MC in USD
                        marketCapUsd: pair.fdv || pair.marketCap || null,
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
    if (request.action === 'unlockWallet') {
        try {
            unlockedWallet = new ethers.Wallet(request.privateKey);
            sendResponse({ success: true });
        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }

    if (request.action === 'lockWallet') {
        unlockedWallet = null;
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
    if (request.action === 'getTokenMetadata') {
        handleGetTokenMetadata(request, sendResponse);
        return true;
    }
    if (request.action === 'fetchTokenList') {
        handleFetchTokenList(request, sendResponse);
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

        // GoPlus Security API for BSC (Chain ID 56)
        fetch(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${address}`, { signal: controller.signal })
            .then(res => res.json())
            .then(data => {
                clearTimeout(timeoutId);
                if (data.code === 1 && data.result && data.result[address.toLowerCase()]) {
                    const result = data.result[address.toLowerCase()];
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
                            holder_count: result.holder_count,
                            lp_holder_count: result.lp_holder_count,
                            holders: result.holders // Array of top holders if available
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
        const address = request.address;
        if (!address) {
            sendResponse({ success: false, error: 'No address provided' });
            return true;
        }

        // Fetch local KOL database
        const fetchLocalKols = async () => {
            const now = Date.now();
            if (kolCache && (now - kolCacheTime) < KOL_CACHE_TTL) {
                return kolCache;
            }
            try {
                const res = await fetch(`${KOL_API_BASE}/api/kol/all`);
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
        };

        // Try multiple APIs for KOL data
        const tryGMGN = async () => {
            try {
                // If you have an official API Key, the endpoint might change to https://api.gmgn.ai/...
                // For now we use the public endpoint, but add the key if present
                const headers = {
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                };

                // Add API Key if configured
                if (typeof GMGN_API_KEY !== 'undefined' && GMGN_API_KEY) {
                    headers['X-API-KEY'] = GMGN_API_KEY; // Verify the header name with GMGN docs
                    headers['Authorization'] = `Bearer ${GMGN_API_KEY}`; // Some APIs use this format
                }

                // Increase limit to 500 to find more KOLs
                // Add credentials: 'include' to share cookies if the user is logged in to GMGN
                const res = await fetch(`https://gmgn.ai/defi/quotation/v1/tokens/top_holders/bsc/${address}?orderby=amount_percentage&direction=desc&limit=500`, {
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
        };

        // Try DeBank API for wallet labels
        const tryDeBank = async () => {
            try {
                const res = await fetch(`https://api.debank.com/token/top_holders?id=bsc:${address}`, {
                    headers: {
                        'Accept': 'application/json'
                    }
                });
                if (!res.ok) return null;
                const data = await res.json();
                console.log('[ClipX] DeBank holders response:', data);

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
        };

        // Execute API calls
        (async () => {
            // Fetch local KOL database in parallel with holder data
            const [localKols, holderList] = await Promise.all([
                fetchLocalKols(),
                tryGMGN().then(result => result || tryDeBank())
            ]);

            if (holderList && holderList.length > 0) {
                // Process up to 500 holders to find matches, but strictly limit display to top 500
                const holders = holderList.slice(0, 500).map(h => {
                    const holderAddr = (h.address || h.holder_address || h.wallet_address || '').toLowerCase();
                    const localKol = localKols[holderAddr];

                    // If holder is in our local KOL database, mark them specially
                    const isMyKol = !!localKol;

                    return {
                        address: h.address || h.holder_address || h.wallet_address || '',
                        percent: h.amount_percentage || h.percentage || h.percent || h.balance_percentage || 0,
                        usd_value: h.usd_value || h.value_usd || h.balance_usd || 0,
                        is_contract: h.is_contract || h.isContract || h.type === 'contract' || false,
                        tag: h.tag || h.wallet_tag || h.label || null,
                        // Use local KOL name if available, otherwise use API data
                        name: localKol ? localKol.kolName : (h.name || h.wallet_name || h.ens || h.label || null),
                        twitter_username: h.twitter_username || h.twitterUsername || h.twitter || null,
                        twitter_name: h.twitter_name || h.twitterName || null,
                        // Use local KOL avatar if available
                        avatar: localKol && localKol.logoUrl ? localKol.logoUrl : (h.avatar || h.logo || h.image || null),
                        is_kol: !!(h.twitter_username || h.twitterUsername || h.twitter || h.tag === 'kol' || h.tag === 'smart_money' || h.wallet_tag === 'kol' || h.is_smart_money || h.name || h.wallet_name || h.label),
                        tags: h.tags || [],
                        last_active: h.last_active || h.last_active_time || null,
                        // NEW: Mark as "My KOL" if in local database
                        is_my_kol: isMyKol,
                        my_kol_data: localKol || null,
                        // Profile link from local KOL data
                        profile_link: localKol ? localKol.profileLink : null
                    };
                });

                // Count how many are from our local KOL list
                const myKolCount = holders.filter(h => h.is_my_kol).length;
                console.log('[ClipX] Found', myKolCount, 'holders from My KOL list');
                console.log('[ClipX] Total KOLs loaded:', Object.keys(localKols).length);

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
                    const res = await fetch(`${KOL_API_BASE}/api/kol/all`);
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
                        // Pass error to content script
                        return { error: `HTTP ${res.status}` };
                    }
                } catch (e) {
                    console.error('Failed to load KOLs for check:', e);
                    return { error: e.message };
                }
            }

            if (!kolMap) {
                // If kolMap is still null, it means fetch failed and we returned above, OR it's a logic error
                // But the loop above returns early on error. 
                // So if we are here and kolMap is null, it's because of cache logic failure or initial state.
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
        const { tokenAddress } = request;
        if (!tokenAddress) {
            sendResponse({ success: false, error: 'No token address' });
            return true;
        }

        (async () => {
            // 1. Ensure KOLs are loaded
            let kolMap = kolCache;
            const now = Date.now();
            if (!kolMap || (now - kolCacheTime) >= KOL_CACHE_TTL) {
                try {
                    const res = await fetch(`${KOL_API_BASE}/api/kol/all`);
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
                                        balance: balance // Extra field for sorting
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
});

// Priority tokens that should always be available for ticker detection
const PRIORITY_TOKENS = {
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

async function handleFetchTokenList(request, sendResponse) {
    try {
        const stored = await chrome.storage.local.get(['cachedTokenList', 'tokenListTimestamp']);
        const now = Date.now();
        const ONE_DAY = 24 * 60 * 60 * 1000;

        // Check if cached list has priority tokens (version check)
        const hasPriorityTokens = stored.cachedTokenList && stored.cachedTokenList['CLIPX'];

        if (stored.cachedTokenList && stored.tokenListTimestamp && (now - stored.tokenListTimestamp < ONE_DAY) && hasPriorityTokens) {
            console.log('[ClipX Background] Using cached token list');
            sendResponse({ success: true, tokens: stored.cachedTokenList });
            return;
        }

        console.log('[ClipX Background] Fetching new token list...');

        // Start with priority tokens
        const tokenMap = { ...PRIORITY_TOKENS };

        try {
            const response = await fetch('https://tokens.pancakeswap.finance/pancakeswap-extended.json');
            const data = await response.json();

            if (data && data.tokens) {
                // Merge PancakeSwap tokens, but don't overwrite priority tokens
                data.tokens.forEach(token => {
                    if (token.chainId === 56) { // Ensure BSC
                        const symbol = token.symbol.toUpperCase();
                        // Only add if not already in priority tokens
                        if (!PRIORITY_TOKENS[symbol]) {
                            tokenMap[symbol] = {
                                address: token.address,
                                decimals: token.decimals,
                                logoURI: token.logoURI,
                                name: token.name,
                                isVerified: true  // PancakeSwap tokens are also verified
                            };
                        }
                    }
                });
            }
        } catch (fetchError) {
            console.warn('[ClipX Background] Failed to fetch PancakeSwap list, using priority tokens only:', fetchError);
        }

        console.log('[ClipX Background] Token map loaded with', Object.keys(tokenMap).length, 'tokens');
        console.log('[ClipX Background] Priority tokens included:', Object.keys(PRIORITY_TOKENS).join(', '));

        await chrome.storage.local.set({
            cachedTokenList: tokenMap,
            tokenListTimestamp: now
        });

        sendResponse({ success: true, tokens: tokenMap });
    } catch (error) {
        console.error('[ClipX Background] Error in handleFetchTokenList:', error);
        // Fallback to priority tokens only
        sendResponse({ success: true, tokens: PRIORITY_TOKENS });
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
            gasPrice: request.gasPrice
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
                gasPrice: request.gasPrice
            })
        });

        console.log('[ClipX Background] Response status:', response.status);

        if (response.status === 401) {
            await chrome.storage.local.remove('authToken');
            sendResponse({ success: false, error: 'Session expired. Please log in again.' });
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

// Handle Recent Trade / Transfer History via BSCScan API
async function handleGetTradeHistory(request, sendResponse) {
    try {
        const { walletAddress } = request;

        if (!walletAddress) {
            sendResponse({ success: false, error: 'Missing walletAddress' });
            return;
        }

        const apiKey = '7X3W6GJFB9TMNG29J4TNAWJSBA8WDWPSHB'; // User can replace with their own key
        const url = `https://api.bscscan.com/api?module=account&action=tokentx&address=${walletAddress}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status === '1' && Array.isArray(data.result)) {
            // Take the most recent 20 transfers
            const events = data.result.slice(0, 20).map(tx => ({
                hash: tx.hash,
                timeStamp: tx.timeStamp,
                tokenSymbol: tx.tokenSymbol,
                tokenName: tx.tokenName,
                contractAddress: tx.contractAddress,
                value: tx.value,
                decimals: tx.tokenDecimal,
                from: tx.from,
                to: tx.to
            }));

            sendResponse({ success: true, events });
        } else {
            sendResponse({ success: false, error: 'No history found or API error' });
        }
    } catch (error) {
        console.error('[ClipX Background] Error fetching trade history:', error);
        sendResponse({ success: false, error: error.message });
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
            // Convert hex to decimal
            const balanceWei = parseInt(data.result, 16);
            // Assuming 18 decimals (standard)
            const balance = balanceWei / 1e18;

            console.log('[ClipX Background] Token balance calculated:', balance);
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
        // Get auth token from storage
        const stored = await chrome.storage.local.get(['authToken', 'nativeWallet']);
        const authToken = stored.authToken;

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
            await chrome.storage.local.remove('authToken');
            sendResponse({
                success: false,
                error: 'Session expired. Please log in again.'
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

        if (!unlockedWallet) {
            sendResponse({ success: false, error: 'Wallet is locked. Please unlock it in the extension popup.' });
            return;
        }

        const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');
        const wallet = unlockedWallet.connect(provider);
        const router = new ethers.Contract(PANCAKESWAP_ROUTER, ROUTER_ABI, wallet);

        const tokenAddress = request.tokenAddress;
        const amount = request.amount; // String
        const type = request.type || 'buy';
        const slippage = parseFloat(request.slippage || 1); // Percentage
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

        console.log(`[ClipX Background] Native Swap: ${type} ${amount} for ${tokenAddress}`);

        let tx;

        if (type === 'buy') {
            // BNB -> Token
            const amountIn = ethers.parseEther(amount.toString());
            const path = [WBNB_ADDRESS, tokenAddress];

            // Calculate min amount out
            const amountsOut = await router.getAmountsOut(amountIn, path);
            const amountOutExpected = amountsOut[1];
            const amountOutMin = amountOutExpected - (amountOutExpected * BigInt(Math.floor(slippage * 100)) / 10000n);

            console.log(`[ClipX Background] Buy: In ${amountIn}, Min Out ${amountOutMin}`);

            tx = await router.swapExactETHForTokens(
                amountOutMin,
                path,
                wallet.address,
                deadline,
                { value: amountIn }
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

            const amountIn = ethers.parseUnits(amount.toString(), decimals);
            const path = [tokenAddress, WBNB_ADDRESS];

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

            tx = await router.swapExactTokensForETH(
                amountIn,
                amountOutMin,
                path,
                wallet.address,
                deadline
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
