// ClipX Tipping Assistant - Popup Script

const CLIPX_PRODUCTION_API = 'https://clipx.app';
let API_BASE = CLIPX_PRODUCTION_API;

function clipxNormalizeApiBase(v) {
    if (typeof v !== 'string' || !v.trim()) return CLIPX_PRODUCTION_API;
    try {
        const u = new URL(v);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return CLIPX_PRODUCTION_API;
        return v.replace(/\/$/, '') || CLIPX_PRODUCTION_API;
    } catch {
        return CLIPX_PRODUCTION_API;
    }
}

chrome.storage.local.get(['apiBase'], (result) => {
    const next = clipxNormalizeApiBase(result.apiBase);
    API_BASE = next;
    if (result.apiBase !== next) chrome.storage.local.set({ apiBase: next });
    console.log('[ClipX Popup] API_BASE initialized to:', API_BASE);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.apiBase) return;
    const v = changes.apiBase.newValue;
    API_BASE = clipxNormalizeApiBase(typeof v === 'string' ? v : '');
    console.log('[ClipX Popup] API_BASE updated to:', API_BASE);
});

// DOM Elements
const loading = document.getElementById('loading');
const content = document.getElementById('content');
const avatar = document.getElementById('avatar');
const username = document.getElementById('username');
const handle = document.getElementById('handle');
const status = document.getElementById('status');
const statusText = document.getElementById('statusText');
const errorMessage = document.getElementById('errorMessage');
const successMessage = document.getElementById('successMessage');
const tipForm = document.getElementById('tipForm');
const notRegisteredMessage = document.getElementById('notRegisteredMessage');
const sendBtn = document.getElementById('sendBtn');
const cancelBtn = document.getElementById('cancelBtn');
const sendEscrowBtn = document.getElementById('sendEscrowBtn');
const tokenSelect = document.getElementById('token');
const amountInput = document.getElementById('amount');
const gasTierSelect = document.getElementById('gasTier');
const transactionsSection = document.getElementById('transactions-section');
const txListContainer = document.getElementById('tx-list-container');
const settingsBtn = document.getElementById('settingsBtn');
const walletBalanceSection = document.getElementById('wallet-balance');
const balBnb = document.getElementById('bal-bnb');
const balClipx = document.getElementById('bal-clipx');
const refreshBalanceBtn = document.getElementById('refreshBalance');
const tradeBalBnb = document.getElementById('trade-bal-bnb');
const tradeAmountInput = document.getElementById('tradeAmount');
const tradeSettingsBtn = document.getElementById('tradeSettingsBtn');
const tradeSettingsModal = document.getElementById('tradeSettingsModal');
const closeTradeSettingsBtn = document.getElementById('closeTradeSettings');
const saveTradeSettingsBtn = document.getElementById('saveTradeSettings');
const settingGasInput = document.getElementById('settingGas');
const settingSlippageInput = document.getElementById('settingSlippage');
const settingAmount1Input = document.getElementById('settingAmount1');
const settingAmount2Input = document.getElementById('settingAmount2');
const settingAmount3Input = document.getElementById('settingAmount3');
const quickBuyBtns = document.querySelectorAll('.quick-buy-btn');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const slippageInput = document.getElementById('slippage');
const gasPriceInput = document.getElementById('gasPrice');
// Send Modal Elements
const sendModal = document.getElementById('sendModal');
const openSendModalBtn = document.getElementById('openSendModalBtn');
const closeSendModalBtn = document.getElementById('closeSendModal');
const confirmSendBtn = document.getElementById('confirmSendBtn');
const sendRecipientInput = document.getElementById('send-recipient');
const sendTokenSelect = document.getElementById('send-token-select');
const sendAmountInput = document.getElementById('send-amount');

// Watchlist elements
const watchlistAddressInput = document.getElementById('watchlist-address');
const watchlistLabelInput = document.getElementById('watchlist-label');
const watchlistAddBtn = document.getElementById('watchlist-add-btn');
const watchlistList = document.getElementById('watchlist-list');
const watchlistEmpty = document.getElementById('watchlist-empty');

// Trending elements
const trendingList = document.getElementById('trending-list');
const trendingEmpty = document.getElementById('trending-empty');
const trending1mBtn = document.getElementById('trending-1m');
const trending5mBtn = document.getElementById('trending-5m');
const trending1hBtn = document.getElementById('trending-1h');

let currentUser = null;

// History elements
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const historyLoading = document.getElementById('history-loading');

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // 0. Check for Encrypted Wallet & Lock Status
        const storage = await chrome.storage.local.get(['authToken', 'nativeWallet', 'webAuthToken', 'webUserAddress']);
        const unlockScreen = document.getElementById('unlock-wallet-screen');
        const loginScreen = document.getElementById('login-screen');
        const unlockBtn = document.getElementById('unlockWalletBtn');
        const unlockPass = document.getElementById('unlockPassword');
        const unlockError = document.getElementById('unlockError');
        const resetBtn = document.getElementById('resetWalletBtn');

        // --- Wallet Switching Logic ---
        const switchBtn = document.getElementById('switchProfileBtn');
        const switchContainer = document.getElementById('profile-switcher-container');

        if (switchBtn && switchContainer) {
            if (storage.authToken === 'native-wallet') {
                // Currently in Native Mode. Check if Web session exists.
                if (storage.webAuthToken) {
                    switchContainer.style.display = 'block';
                    switchBtn.innerHTML = '🔁 Switch to Web Account';
                    switchBtn.onclick = () => {
                        chrome.storage.local.set({
                            authToken: storage.webAuthToken,
                            userAddress: storage.webUserAddress || ''
                        }, () => window.location.reload());
                    };
                }
            } else {
                // Currently in Web Mode. Check if Native Wallet exists.
                if (storage.nativeWallet) {
                    switchContainer.style.display = 'block';
                    switchBtn.innerHTML = '🔁 Switch to Native Wallet';
                    switchBtn.onclick = () => {
                        chrome.storage.local.set({
                            authToken: 'native-wallet',
                            userAddress: storage.nativeWallet.address || ''
                        }, () => window.location.reload());
                    };
                }
            }
        }

        if (storage.authToken === 'native-wallet' && storage.nativeWallet) {
            // Native wallet - always auto-unlock from stored private key
            const session = await chrome.storage.session.get(['unlockedPrivateKey', 'walletUnlocked']);

            // Get private key from storage (either from encrypted or direct storage)
            let privateKey = storage.nativeWallet.privateKey;

            // If private key exists and not yet unlocked in session, unlock it
            if (privateKey && !session.walletUnlocked) {
                await chrome.runtime.sendMessage({
                    action: 'unlockWallet',
                    privateKey: privateKey
                });
            }

            // Show main UI immediately (no unlock screen)
            loading.style.display = 'none';
            content.style.display = 'flex';
            loginScreen.style.display = 'none';
            if (unlockScreen) unlockScreen.style.display = 'none';
        }

        // Continue with normal initialization...
        // 1. Load cached data immediately for instant UI
        const cached = await chrome.storage.local.get(['cachedBalance', 'cachedTransactions', 'authToken']);


        if (cached.authToken) {
            // Show UI immediately if we have auth
            loading.style.display = 'none';
            content.style.display = 'flex';
            transactionsSection.style.display = 'block';
            walletBalanceSection.style.display = 'block';

            // Render cached data if available
            if (cached.cachedBalance) renderBalance(cached.cachedBalance);
            if (cached.cachedTransactions) renderTransactions(cached.cachedTransactions.transactions, cached.cachedTransactions.userId);
        } else {
            // Public Mode: Show UI but hide wallet/history components
            loading.style.display = 'none';
            content.style.display = 'flex';

            // Hide wallet-specific sections
            if (transactionsSection) transactionsSection.style.display = 'none';
            if (walletBalanceSection) walletBalanceSection.style.display = 'none';

            // Default to Categories tab if not logged in
            // check if we are in a sub-page or just opened
            const activeTab = document.querySelector('.tab-btn.active');
            if (!activeTab || activeTab.getAttribute('data-tab') === 'send-tip') {
                // Switch to Categories by default for non-logged in users
                const catBtn = document.querySelector('.tab-btn[data-tab="categories"]');
                if (catBtn) catBtn.click();
            }
        }

        // 2. Determine target user
        const stored = await chrome.storage.local.get('tipTargetUser');
        let targetUsername = stored.tipTargetUser;

        if (!targetUsername) {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs[0]) {
                targetUsername = extractUsernameFromUrl(tabs[0].url);
            }
        }

        // 3. Fetch fresh data in parallel
        if (cached.authToken) {
            // Run these in parallel without blocking UI
            const balancePromise = loadWalletBalance(cached.authToken);
            const txPromise = loadRecentTransactions(cached.authToken);

            // If we have a target user, fetch their info too
            if (targetUsername) {
                // Show loading state for user info specifically if not cached
                // But we want the rest of the UI to be interactive
                await loadUserInfo(targetUsername);
                chrome.storage.local.remove('tipTargetUser');
            }

            await Promise.allSettled([balancePromise, txPromise]);
        } else {
            // Not authenticated - We still load Categories
            // Note: We don't show the full login overlay anymore on load.
            // Instead, we show it only when trying to access protected tabs (like Wallet/Send)
            console.log('[ClipX] Public mode initialized');
            loadCategories(); // Always load categories
        }

        // Initialize Trade Settings
        loadTradeSettings();

        // Login Button Logic
        const loginWebBtn = document.getElementById('loginWebBtn');
        if (loginWebBtn) {
            loginWebBtn.addEventListener('click', () => {
                chrome.tabs.create({ url: `${API_BASE.replace(/\/$/, '')}/dashboard` });
            });
        }

        // Open Side Panel Logic
        const openSidePanelBtn = document.getElementById('openSidePanelBtn');
        if (openSidePanelBtn) {
            openSidePanelBtn.addEventListener('click', async () => {
                try {
                    const windowId = (await chrome.windows.getCurrent()).id;
                    await chrome.sidePanel.open({ windowId });
                    window.close(); // Close the popup
                } catch (error) {
                    console.error('Failed to open side panel:', error);
                    // Fallback to opening as a tab if side panel fails
                    chrome.tabs.create({ url: 'src/popup.html' });
                }
            });
        }

        // Close Login Screen Logic
        const closeLoginBtn = document.getElementById('closeLoginBtn');
        if (closeLoginBtn) {
            closeLoginBtn.addEventListener('click', () => {
                const loginScreen = document.getElementById('login-screen');
                if (loginScreen) {
                    loginScreen.style.display = 'none';
                }
            });
        }

    } catch (error) {
        console.error('Error initializing popup:', error);
        showError('Error loading popup: ' + error.message);
        loading.style.display = 'none';
        content.style.display = 'flex';
    }
});

// Custom Success Notification
function showSuccessNotification(message, txHash) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: white;
        padding: 20px 24px;
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        z-index: 10000;
        max-width: 320px;
        text-align: center;
        animation: slideIn 0.3s ease-out;
    `;

    notification.innerHTML = `
        <div style="font-size: 32px; margin-bottom: 8px;">✅</div>
        <div style="font-size: 16px; font-weight: 600; margin-bottom: 12px;">${message}</div>
        <div style="font-size: 11px; opacity: 0.9; margin-bottom: 12px; word-break: break-all;">
            TX: ${txHash.substring(0, 10)}...${txHash.substring(txHash.length - 8)}
        </div>
        <button onclick="this.parentElement.remove()" style="
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            padding: 8px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
        ">OK</button>
    `;

    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 5000);
}

// Save Send Transaction to Local History
async function saveSendToHistory(to, amount, tokenAddress, txHash) {
    try {
        const stored = await chrome.storage.local.get(['sendHistory', 'nativeWallet']);
        const history = stored.sendHistory || [];

        // Get token symbol
        let tokenSymbol = 'BNB';
        if (tokenAddress !== 'BNB') {
            // Try to get from assets
            const sendSelect = document.getElementById('send-token-inline');
            if (sendSelect) {
                const selectedOption = sendSelect.options[sendSelect.selectedIndex];
                tokenSymbol = selectedOption.text.split(' ')[0]; // Extract symbol before (Bal:...)
            }
        }

        history.unshift({
            type: 'send',
            to,
            amount,
            tokenAddress,
            tokenSymbol,
            txHash,
            timestamp: Date.now()
        });

        // Keep last 50 sends
        if (history.length > 50) history.length = 50;

        await chrome.storage.local.set({ sendHistory: history });
    } catch (e) {
        console.error('Failed to save send history:', e);
    }
}

// Enhanced Load Trade History (Trades + Sends)
async function loadTradeHistory() {
    if (!historyList || !historyEmpty || !historyLoading) return;

    historyLoading.style.display = 'block';
    historyList.style.display = 'none';
    historyEmpty.style.display = 'none';
    historyList.innerHTML = '';

    try {
        const stored = await chrome.storage.local.get(['authToken', 'nativeWallet']);

        if (stored.authToken !== 'native-wallet' || !stored.nativeWallet?.address) {
            historyLoading.style.display = 'none';
            historyEmpty.style.display = 'block';
            historyEmpty.textContent = 'History available for native wallet only';
            return;
        }

        const walletAddress = stored.nativeWallet.address;

        // Fetch on-chain transactions
        chrome.runtime.sendMessage({ action: 'getTradeHistory', walletAddress }, (response) => {
            historyLoading.style.display = 'none';

            if (!response || !response.success || !Array.isArray(response.events) || response.events.length === 0) {
                historyEmpty.style.display = 'block';
                historyEmpty.textContent = 'No transactions found';
                return;
            }

            const allTxs = response.events;

            historyList.style.display = 'block';
            historyEmpty.style.display = 'none';

            allTxs.forEach((tx) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;margin-bottom:6px;border-radius:10px;background:var(--bg-input);cursor:pointer;';
                row.onclick = () => window.open(`https://bscscan.com/tx/${tx.txHash || tx.hash}`, '_blank');

                const left = document.createElement('div');
                left.style.cssText = 'display:flex;flex-direction:column;font-size:11px;';

                // Determine type and icon
                let typeIcon = '🔄';
                let typeText = 'Swap';
                let color = 'var(--text-main)';

                const isOut = tx.from && tx.from.toLowerCase() === walletAddress.toLowerCase();
                if (isOut) {
                    typeIcon = '📤';
                    typeText = 'Sent';
                    color = '#ef4444';
                } else {
                    typeIcon = '📥';
                    typeText = 'Received';
                    color = '#22c55e';
                }

                const symbol = tx.tokenSymbol || '???';
                const title = document.createElement('div');
                title.style.cssText = 'font-size:12px;font-weight:600;';
                title.textContent = `${typeIcon} ${typeText} ${symbol}`;

                const timeEl = document.createElement('div');
                timeEl.style.cssText = 'color:var(--text-muted);font-size:10px;margin-top:2px;';
                const ts = tx.timestamp || parseInt(tx.timeStamp, 10) * 1000;
                const diffMin = Math.floor((Date.now() - ts) / 60000);
                timeEl.textContent = diffMin < 1 ? 'Just now' : diffMin < 60 ? `${diffMin}m ago` : diffMin < 1440 ? `${Math.floor(diffMin / 60)}h ago` : `${Math.floor(diffMin / 1440)}d ago`;

                left.appendChild(title);
                left.appendChild(timeEl);

                const right = document.createElement('div');
                right.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;font-size:11px;';

                const amountEl = document.createElement('div');
                const decimals = parseInt(tx.decimals || '18', 10) || 18;
                const raw = tx.value || tx.amount || '0';
                const amt = Number(raw) / Math.pow(10, decimals);
                const sign = color === '#ef4444' ? '-' : '+';
                amountEl.textContent = `${sign}${amt.toFixed(4)}`;
                amountEl.style.color = color;
                amountEl.style.fontWeight = '600';

                right.appendChild(amountEl);

                row.appendChild(left);
                row.appendChild(right);
                historyList.appendChild(row);
            });
        });
    } catch (e) {
        console.error('Failed to load history', e);
        historyLoading.style.display = 'none';
        historyEmpty.style.display = 'block';
        historyEmpty.textContent = 'Error loading history';
    }
}

// Initialize Send Funds Inline Form
const sendBtnInline = document.getElementById('send-btn-inline');
const sendRecipientInline = document.getElementById('send-recipient-inline');
const sendTokenInline = document.getElementById('send-token-inline');
const sendAmountInline = document.getElementById('send-amount-inline');

if (sendBtnInline && sendRecipientInline && sendTokenInline && sendAmountInline) {
    sendBtnInline.addEventListener('click', async () => {
        const to = sendRecipientInline.value.trim();
        const amount = sendAmountInline.value.trim();
        const tokenAddress = sendTokenInline.value;

        // Basic validation
        if (!to || to.length !== 42 || !to.startsWith('0x')) {
            alert('Invalid Address. Please enter a valid BSC address (0x...)');
            return;
        }
        if (!amount || parseFloat(amount) <= 0) {
            alert('Invalid Amount. Please enter a positive number');
            return;
        }

        // Disable button and show loading
        sendBtnInline.disabled = true;
        sendBtnInline.textContent = '⏳ Sending...';

        chrome.runtime.sendMessage({
            action: 'nativeTransfer',
            to,
            amount,
            tokenAddress: tokenAddress === 'BNB' ? 'BNB' : tokenAddress
        }, (response) => {
            sendBtnInline.disabled = false;
            sendBtnInline.textContent = '💸 Send Now';

            if (response && response.success) {
                // Play ka-ching sound
                const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIGGe77OWdTRAMUKfj8LZjHAY4ktjyzHksBSR3yPDdkEAKFF+06OqoVRQKRp/g8r5sIQUrgs/y2Ik2CBhnu+zlnU0QDFCn4/C2YxwGOJLY8sx5LAUkd8jw3ZBBChRftOjqqFUUCkaf4PK+bCEFK4LQ8tmJNggYZ7vs5Z1NEAxQp+PwtmMcBjiS2PLMeSwFJHfI8N2QQQoUX7To6qhVFApGn+DyvmwhBSuC0PLZiTYIGGe77OWdTRAMUKfj8LZjHAY4ktjyzHksBSR3yPDdkEEKFF+06OqoVRQKRp/g8r5sIQUrgtDy2Yk2CBhnu+zlnU0QDFCn4/C2YxwGOJLY8sx5LAUkd8jw3ZBBChRftOjqqFUUCkaf4PK+bCEFK4LQ8tmJNggYZ7vs5Z1NEAxQp+PwtmMcBjiS2PLMeSwFJHfI8N2QQQoUX7To6qhVFApGn+DyvmwhBSuC0PLZiTYIGGe77OWdTRAMUKfj8LZjHAY4ktjyzHksBSR3yPDdkEEKFF+06OqoVRQKRp/g8r5sIQUrgtDy2Yk2CBhnu+zlnU0QDFCn4/C2YxwGOJLY8sx5LAUkd8jw3ZBBChRftOjqqFUUCkaf4PK+bCEFK4LQ8tmJNggYZ7vs5Z1NEAxQp+PwtmMcBjiS2PLMeSwFJHfI8N2QQQoUX7To6qhVFApGn+DyvmwhBSuC0PLZiTYIGGe77OWdTRAMUKfj8LZjHAY4ktjyzHksBSR3yPDdkEEKFF+06OqoVRQKRp/g8r5sIQUrgtDy2Yk2CBhnu+zlnU0QDFCn4/C2YxwGOJLY8sx5LAUkd8jw3ZBBChRftOjqqFUUCkaf4PK+bCEFK4LQ8tmJNggYZ7vs5Z1NEAxQp+PwtmMcBjiS2PLMeSwFJHfI8N2QQQoUX7To6qhVFApGn+DyvmwhBSuC0PLZiTYIGGe77OWdTRAMUKfj8LZjHAY=');
                audio.play().catch(e => console.log('Audio play failed:', e));

                // Show custom success notification
                showSuccessNotification('✅ Sent Successfully!', response.txHash);

                // Save to local history
                saveSendToHistory(to, amount, tokenAddress, response.txHash);

                // Clear form
                sendRecipientInline.value = '';
                sendAmountInline.value = '';
                // Refresh wallet assets
                if (typeof loadWalletAssets === 'function') loadWalletAssets();
            } else {
                alert('❌ Error: ' + (response ? response.error : 'Unknown error occurred'));
            }
        });
    });
}

// Tab Switching Logic
tabBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
        const tabId = btn.getAttribute('data-tab');

        // Protected Tabs Check
        const protectedTabs = ['send-tip', 'watchlist', 'history', 'wallet-control'];
        if (protectedTabs.includes(tabId)) {
            const stored = await chrome.storage.local.get(['authToken']);
            if (!stored.authToken) {
                // Show Login Screen
                const loginScreen = document.getElementById('login-screen');
                if (loginScreen) {
                    loginScreen.style.display = 'flex'; // Use flex for center alignment
                    // Add close button to login screen for this context? 
                    // Or just let them click "Categories" to exit? 
                    // For now, let's keep it simple.
                }
                return; // Stop tab switch
            }
        }

        // Remove active class from all buttons and contents
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));

        // Add active class to clicked button
        btn.classList.add('active');

        // Show corresponding content
        const tabContent = document.getElementById(`${tabId}-tab`);
        if (tabContent) {
            tabContent.classList.add('active');
        }

        // Toggle global sections based on tab
        if (tabId === 'wallet-control') {
            if (transactionsSection) transactionsSection.style.display = 'none';
            // Fetch wallet assets if needed
            loadWalletAssets();
        } else {
            // Only show transactions on certain tabs if logged in
            if (transactionsSection && tabId !== 'categories' && tabId !== 'watchlist') {
                // transactionsSection.style.display = 'block'; 
                // Actually, transactions are usually main view. Let's hide them for sidebar-ish tabs
            }
        }

        // When switching to watchlist/history/categories, refresh data
        if (tabId === 'watchlist') {
            loadWatchlist();
        }
        if (tabId === 'history') {
            loadTradeHistory();
        }
        if (tabId === 'categories') {
            loadCategories();
        }
        if (tabId === 'square') {
            loadSquareStatus();
        }
    });
});

// ── Binance Square Tab ──────────────────────────────────────────────────────

function loadSquareStatus() {
    chrome.runtime.sendMessage({ action: 'getSquareStatus' }, (r) => {
        if (!r) return;

        const countEl = document.getElementById('sq-count');
        if (countEl) countEl.textContent = r.count || 0;

        const resetEl = document.getElementById('sq-reset');
        if (resetEl) {
            if (r.resetsInMs && r.resetsInMs > 0) {
                const h = Math.floor(r.resetsInMs / 3600000);
                const m = Math.floor((r.resetsInMs % 3600000) / 60000);
                resetEl.textContent = `resets in ${h}h ${m}m`;
            } else {
                resetEl.textContent = r.count > 0 ? 'resets in <1m' : 'resets in —';
            }
        }

        const dot = document.getElementById('sq-status-dot');
        const txt = document.getElementById('sq-status-text');
        if (dot && txt) {
            if (r.hasKey) {
                dot.style.background = '#22c55e';
                txt.textContent = 'Key saved';
                txt.style.color = '#22c55e';
            } else {
                dot.style.background = '#52525b';
                txt.textContent = 'No key';
                txt.style.color = '#a1a1aa';
            }
        }
    });
}

const sqSaveBtn = document.getElementById('sq-save-btn');
if (sqSaveBtn) {
    sqSaveBtn.addEventListener('click', () => {
        const input = document.getElementById('sq-key-input');
        const key = input ? input.value.trim() : '';
        if (!key) {
            sqSaveBtn.textContent = 'Enter a key first';
            setTimeout(() => { sqSaveBtn.textContent = 'Save Key'; }, 2000);
            return;
        }
        sqSaveBtn.textContent = 'Saving…';
        sqSaveBtn.disabled = true;
        chrome.runtime.sendMessage({ action: 'saveSquareApiKey', key }, (r) => {
            sqSaveBtn.disabled = false;
            if (r && r.success) {
                if (input) input.value = '';
                sqSaveBtn.textContent = '✓ Saved!';
                sqSaveBtn.style.background = '#22c55e';
                setTimeout(() => {
                    sqSaveBtn.textContent = 'Save Key';
                    sqSaveBtn.style.background = '#F0B90B';
                }, 2000);
                loadSquareStatus();
            } else {
                sqSaveBtn.textContent = 'Error — try again';
                setTimeout(() => { sqSaveBtn.textContent = 'Save Key'; }, 2000);
            }
        });
    });
}

const sqClearBtn = document.getElementById('sq-clear-btn');
if (sqClearBtn) {
    sqClearBtn.addEventListener('click', () => {
        const confirmBox = document.getElementById('sq-clear-confirm');
        if (confirmBox) confirmBox.style.display = 'flex';
    });
}

const sqClearConfirmYes = document.getElementById('sq-clear-confirm-yes');
if (sqClearConfirmYes) {
    sqClearConfirmYes.addEventListener('click', () => {
        const confirmBox = document.getElementById('sq-clear-confirm');
        if (confirmBox) confirmBox.style.display = 'none';
        chrome.runtime.sendMessage({ action: 'clearSquareApiKey' }, () => {
            loadSquareStatus();
            const input = document.getElementById('sq-key-input');
            if (input) input.value = '';
        });
    });
}

const sqClearConfirmNo = document.getElementById('sq-clear-confirm-no');
if (sqClearConfirmNo) {
    sqClearConfirmNo.addEventListener('click', () => {
        const confirmBox = document.getElementById('sq-clear-confirm');
        if (confirmBox) confirmBox.style.display = 'none';
    });
}

const sqToggle = document.getElementById('sq-key-toggle');
if (sqToggle) {
    sqToggle.addEventListener('click', () => {
        const inp = document.getElementById('sq-key-input');
        if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
        sqToggle.textContent = sqToggle.textContent === '👁' ? '🙈' : '👁';
    });
}

// =============================================================================
// LOGIN SCREEN TAB SWITCHING (Create Wallet, Login with Key, Login via Web)
// =============================================================================
// BUG FIX: The login screen uses ".tab" class but was missing click handlers.
// This fix enables switching between login methods including "Create Wallet".
// 
// HOW TO TEST:
// 1. Clear storage: DevTools Console → chrome.storage.local.clear()
// 2. Reopen popup - login screen appears
// 3. Click each tab (Login with Key / Login via Web / Create Wallet)
// 4. Verify content switches correctly
// =============================================================================
const loginTabs = document.querySelectorAll('#login-screen .tab-btn[data-tab]');
if (loginTabs.length > 0) {
    loginTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-tab');

            // Update active tab styling
            loginTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Hide all tab contents in login screen
            document.querySelectorAll('#login-screen .tab-content').forEach(content => {
                content.classList.remove('active');
            });

            // Show the selected tab content
            const targetContent = document.getElementById(`tab-${tabName}`);
            if (targetContent) {
                targetContent.classList.add('active');
            }

            console.log('[ClipX] Switched to login tab:', tabName);
        });
    });
    console.log('[ClipX] Login tab switching initialized for', loginTabs.length, 'tabs');
}

// --- Categories Logic ---
const categoriesList = document.getElementById('categories-list');
const categoryDetailView = document.getElementById('category-detail-view');
const categoryTitle = document.getElementById('category-title');
const categoryUsersList = document.getElementById('category-users-list');
const backToCategoriesBtn = document.getElementById('back-to-categories');

if (backToCategoriesBtn) {
    backToCategoriesBtn.addEventListener('click', () => {
        if (categoryDetailView) categoryDetailView.style.display = 'none';
        if (categoriesList) {
            categoriesList.style.display = 'grid'; // Restore grid layout
            // categoriesList.style.display = 'flex'; // Old flex
        }
    });
}

async function loadCategories() {
    if (!categoriesList) return;

    categoriesList.innerHTML = '<div class="message-box info">Loading categories...</div>';

    try {
        chrome.runtime.sendMessage({ action: 'getLabeledUsers' }, (response) => {
            if (response && response.success && response.categories) {
                renderCategories(response.categories);
            } else {
                categoriesList.innerHTML = '<div class="message-box error">Failed to load categories.</div>';
            }
        });
    } catch (e) {
        console.error('Error loading categories:', e);
        categoriesList.innerHTML = `<div class="message-box error">Error: ${e.message}</div>`;
    }
}

function renderCategories(categories) {
    if (!categoriesList) return;
    categoriesList.innerHTML = '';

    // Clear any inline styles
    categoriesList.removeAttribute('style');

    // Enforce List Layout logic if needed (handled by CSS now, but let's be safe)
    // categoriesList.style.display = 'flex';
    // categoriesList.style.flexDirection = 'column';
    categoriesList.className = 'category-grid'; // Keeping class name but it behaves as list in CSS

    if (categories.length === 0) {
        categoriesList.innerHTML = '<div class="message-box info">No categories found.</div>';
        return;
    }

    // Helper to get icon SVG
    const getIcon = (name) => {
        const n = name.toLowerCase();
        const iconStyle = 'width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

        // Colors for specific categories
        let color = '#a1a1aa'; // default
        if (n.includes('kol') || n.includes('influencer')) color = '#f472b6'; // pink
        if (n.includes('vc') || n.includes('fund')) color = '#fbbf24'; // amber
        if (n.includes('founder') || n.includes('exec')) color = '#c084fc'; // purple
        if (n.includes('builder') || n.includes('engineer')) color = '#60a5fa'; // blue
        if (n.includes('smart') || n.includes('money')) color = '#60a5fa'; // blue
        if (n.includes('meme')) color = '#4ade80'; // green

        const svgWrapper = (path, c) => `<svg ${iconStyle} style="color: ${c || color};">${path}</svg>`;

        if (n.includes('kol') || n.includes('influencer')) {
            return svgWrapper('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line>');
        }
        if (n.includes('vc') || n.includes('fund')) {
            return svgWrapper('<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>');
        }
        if (n.includes('founder') || n.includes('exec')) {
            return svgWrapper('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>');
        }
        if (n.includes('builder') || n.includes('engineer')) {
            return svgWrapper('<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>');
        }
        if (n.includes('smart') || n.includes('money')) {
            return svgWrapper('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>');
        }
        if (n.includes('whale')) {
            return svgWrapper('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>');
        }
        if (n.includes('exchange') || n.includes('cex')) {
            return svgWrapper('<path d="M3 21h18M5 21v-7M19 21v-7M4 10h16v4h-16zM2 10l10-7 10 7"></path>');
        }
        if (n.includes('media') || n.includes('news')) {
            return svgWrapper('<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"></path><path d="M18 14h-8"></path><path d="M15 18h-5"></path><path d="M10 6h8v4h-8V6Z"></path>');
        }

        return svgWrapper('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>');
    };

    categories.forEach(cat => {
        const item = document.createElement('div');
        item.className = 'category-card';

        const iconDiv = document.createElement('div');
        iconDiv.className = 'category-icon';
        iconDiv.innerHTML = getIcon(cat.name);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'category-info';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'category-name';
        nameDiv.textContent = cat.name;

        const countDiv = document.createElement('div');
        countDiv.className = 'category-count';
        // countDiv.innerHTML = `<span style="width: 6px; height: 6px; background: var(--success); border-radius: 50%; box-shadow: 0 0 8px var(--success);"></span> ${cat.users.length} Users`;
        countDiv.textContent = `${cat.users.length} Users`;

        infoDiv.appendChild(nameDiv);
        infoDiv.appendChild(countDiv);

        // Arrow
        const arrowDiv = document.createElement('div');
        arrowDiv.className = 'category-arrow';
        arrowDiv.innerHTML = '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

        item.appendChild(iconDiv);
        item.appendChild(infoDiv);
        item.appendChild(arrowDiv);

        item.addEventListener('click', () => {
            console.log('Category clicked:', cat.name);
            showCategoryDetail(cat);
        });

        categoriesList.appendChild(item);
    });
}

function showCategoryDetail(category) {
    console.log('Showing detail for category:', category.name);

    if (!categoriesList || !categoryDetailView || !categoryUsersList || !categoryTitle) {
        console.error('Missing DOM elements', { categoriesList, categoryDetailView, categoryUsersList, categoryTitle });
        return;
    }

    categoriesList.style.display = 'none';
    categoryDetailView.style.display = 'block';

    // Update Title
    categoryTitle.textContent = category.name;

    // Clear previous users
    categoryUsersList.innerHTML = '';

    if (!category.users || category.users.length === 0) {
        categoryUsersList.innerHTML = '<div class="message-box info">No users in this category.</div>';
        return;
    }

    category.users.forEach(user => {
        const row = document.createElement('div');
        row.className = 'user-list-item';
        row.style.justifyContent = 'flex-start';

        row.onclick = () => {
            window.open(`https://x.com/${user.handle}`, '_blank');
        };

        // Avatar
        const avatar = document.createElement('img');
        avatar.className = 'user-avatar';
        avatar.src = user.avatar || `https://unavatar.io/twitter/${user.handle}`;
        avatar.onerror = () => { avatar.src = 'assets/icons/icon-48.png'; };
        avatar.style.width = '36px';
        avatar.style.height = '36px';
        avatar.style.borderRadius = '50%';
        avatar.style.objectFit = 'cover';
        avatar.style.flexShrink = '0';

        // Info Column (Handle + Label stacked)
        const infoCol = document.createElement('div');
        infoCol.style.display = 'flex';
        infoCol.style.flexDirection = 'column';
        infoCol.style.gap = '4px';
        infoCol.style.marginLeft = '12px';
        infoCol.style.minWidth = '0';

        // Handle
        const handleSpan = document.createElement('div');
        handleSpan.textContent = `@${user.handle}`;
        handleSpan.style.color = '#e4e4e7';
        handleSpan.style.fontWeight = '600';
        handleSpan.style.fontSize = '13px';

        infoCol.appendChild(handleSpan);

        // Label Badge below handle
        if (user.type) {
            const labelBadge = document.createElement('span');
            labelBadge.style.cssText = 'display: inline-block; width: fit-content; background: rgba(192, 132, 252, 0.1); color: #c084fc; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 500; border: 1px solid rgba(192, 132, 252, 0.2);';
            labelBadge.textContent = user.type;
            infoCol.appendChild(labelBadge);
        }

        row.appendChild(avatar);
        row.appendChild(infoCol);

        categoryUsersList.appendChild(row);
    });
}

// Ensure tab switching triggers load logic
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');
        if (tabId === 'categories') {
            loadCategories();
        }
    });
});

// Quick Buy Logic
quickBuyBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const amount = btn.getAttribute('data-amount');
        if (amount) {
            tradeAmountInput.value = amount;
        }
    });
});

// Trade Settings Logic
if (tradeSettingsBtn) {
    tradeSettingsBtn.addEventListener('click', () => {
        tradeSettingsModal.style.display = 'flex';
        // Load current settings into inputs
        chrome.storage.local.get(['tradeSettings', 'showTipsButtons'], (result) => {
            const settings = result.tradeSettings || {
                gas: '',
                slippage: '10',
                amounts: [0.1, 0.5, 1.0]
            };
            settingGasInput.value = settings.gas;
            settingSlippageInput.value = settings.slippage;
            settingAmount1Input.value = settings.amounts[0];
            settingAmount2Input.value = settings.amounts[1];
            settingAmount3Input.value = settings.amounts[2];

            // Load Tips toggle (default: true)
            const showTipsToggle = document.getElementById('showTipsToggle');
            if (showTipsToggle) {
                showTipsToggle.checked = result.showTipsButtons !== false;
            }
        });
    });
}

// --- Watchlist Logic ---
async function loadWatchlist() {
    try {
        const stored = await chrome.storage.local.get(['watchlist']);
        const items = stored.watchlist || [];

        if (!items.length) {
            if (watchlistEmpty) watchlistEmpty.style.display = 'block';
            if (watchlistList) watchlistList.style.display = 'none';
            return;
        }

        if (watchlistEmpty) watchlistEmpty.style.display = 'none';
        if (watchlistList) {
            watchlistList.innerHTML = '';
            watchlistList.style.display = 'block';

            items.forEach((item, index) => {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.justifyContent = 'space-between';
                row.style.padding = '8px 10px';
                row.style.marginBottom = '6px';
                row.style.borderRadius = '10px';
                row.style.background = 'var(--bg-input)';

                const left = document.createElement('div');
                left.style.display = 'flex';
                left.style.alignItems = 'center';
                left.style.gap = '8px';

                const icon = document.createElement('div');
                icon.style.width = '24px';
                icon.style.height = '24px';
                icon.style.borderRadius = '999px';
                icon.style.backgroundColor = '#1f2933';
                icon.style.display = 'flex';
                icon.style.alignItems = 'center';
                icon.style.justifyContent = 'center';
                icon.style.fontSize = '11px';
                icon.style.color = '#e5e7eb';
                icon.textContent = '?';

                const textCol = document.createElement('div');
                textCol.style.display = 'flex';
                textCol.style.flexDirection = 'column';
                textCol.style.fontSize = '11px';

                const title = document.createElement('div');
                title.style.fontSize = '12px';
                title.style.fontWeight = '600';
                title.textContent = item.label || 'Token';

                const mcEl = document.createElement('div');
                mcEl.style.color = 'var(--text-muted)';
                mcEl.style.fontSize = '10px';
                mcEl.textContent = '';

                textCol.appendChild(title);
                textCol.appendChild(mcEl);

                left.appendChild(icon);
                left.appendChild(textCol);

                const right = document.createElement('div');
                right.style.display = 'flex';
                right.style.flexDirection = 'column';
                right.style.alignItems = 'flex-end';
                right.style.gap = '2px';

                const priceEl = document.createElement('div');
                priceEl.style.fontSize = '12px';
                priceEl.textContent = 'Loading...';

                const changeEl = document.createElement('div');
                changeEl.style.fontSize = '10px';
                changeEl.style.color = 'var(--text-muted)';

                const removeBtn = document.createElement('button');
                removeBtn.textContent = '✕';
                removeBtn.style.border = 'none';
                removeBtn.style.background = 'transparent';
                removeBtn.style.color = 'var(--text-muted)';
                removeBtn.style.cursor = 'pointer';
                removeBtn.style.fontSize = '11px';
                removeBtn.onclick = async () => {
                    const updated = items.filter((_, i) => i !== index);
                    await chrome.storage.local.set({ watchlist: updated });
                    loadWatchlist();
                };

                right.appendChild(priceEl);
                right.appendChild(changeEl);
                right.appendChild(removeBtn);

                row.appendChild(left);
                row.appendChild(right);

                watchlistList.appendChild(row);

                // Fetch token intel via background
                chrome.runtime.sendMessage({ action: 'fetchTokenInfo', address: item.address }, (response) => {
                    if (!response || !response.success) {
                        priceEl.textContent = 'N/A';
                        changeEl.textContent = '';
                        mcEl.textContent = '';
                        return;
                    }

                    const symbol = response.symbol || '???';

                    // Icon: first letter fallback, image if provided
                    if (response.iconUrl) {
                        icon.style.backgroundImage = `url(${response.iconUrl})`;
                        icon.style.backgroundSize = 'cover';
                        icon.style.backgroundPosition = 'center';
                        icon.textContent = '';
                    } else {
                        icon.textContent = symbol.charAt(0).toUpperCase();
                    }

                    // Title prefers label, else symbol
                    if (!item.label) {
                        title.textContent = symbol;
                    }

                    // Price text
                    let priceText = '';
                    if (response.priceUsd) {
                        const price = parseFloat(response.priceUsd);
                        if (price < 0.01) priceText = `$${price.toFixed(6)}`;
                        else if (price < 1) priceText = `$${price.toFixed(4)}`;
                        else priceText = `$${price.toFixed(2)}`;
                    }
                    priceEl.textContent = priceText ? `${symbol} ${priceText}` : symbol;

                    // 24h change
                    if (typeof response.priceChange === 'number') {
                        const pct = response.priceChange;
                        const sign = pct > 0 ? '+' : '';
                        changeEl.textContent = `${sign}${pct.toFixed(2)}% 24h`;
                        changeEl.style.color = pct > 0 ? '#22c55e' : pct < 0 ? '#ef4444' : 'var(--text-muted)';
                    } else {
                        changeEl.textContent = '';
                    }

                    // Market cap text, formatted with K / M / B units
                    if (typeof response.marketCapUsd === 'number') {
                        const mc = response.marketCapUsd;
                        let mcText;
                        if (mc >= 1e9) mcText = `$${(mc / 1e9).toFixed(1)}B MC`;
                        else if (mc >= 1e6) mcText = `$${(mc / 1e6).toFixed(1)}M MC`;
                        else if (mc >= 1e3) mcText = `$${(mc / 1e3).toFixed(1)}k MC`;
                        else mcText = `$${Math.round(mc)} MC`;
                        mcEl.textContent = mcText;
                    } else {
                        mcEl.textContent = '';
                    }
                });
            });
        }
    } catch (e) {
        console.error('Failed to load watchlist', e);
    }
}

if (watchlistAddBtn) {
    watchlistAddBtn.addEventListener('click', async () => {
        const addr = (watchlistAddressInput?.value || '').trim();
        const label = (watchlistLabelInput?.value || '').trim();

        if (!addr || !addr.startsWith('0x') || addr.length !== 42) {
            alert('Please enter a valid BSC contract address (0x...)');
            return;
        }

        const stored = await chrome.storage.local.get(['watchlist']);
        const items = stored.watchlist || [];

        // Avoid duplicates
        if (items.some(i => i.address.toLowerCase() === addr.toLowerCase())) {
            watchlistAddressInput.value = '';
            watchlistLabelInput.value = '';
            loadWatchlist();
            return;
        }

        items.push({ address: addr, label });
        await chrome.storage.local.set({ watchlist: items });

        watchlistAddressInput.value = '';
        watchlistLabelInput.value = '';
        loadWatchlist();
    });
}

// --- Trending Logic ---
async function loadTrending(interval) {
    try {
        // Highlight active interval button
        [trending1mBtn, trending5mBtn, trending1hBtn].forEach(btn => {
            if (!btn) return;
            btn.classList.remove('active');
            btn.style.background = 'var(--bg-input)';
        });
        const activeBtn = interval === '1m' ? trending1mBtn : interval === '1h' ? trending1hBtn : trending5mBtn;
        if (activeBtn) {
            activeBtn.classList.add('active');
            activeBtn.style.background = 'var(--primary)';
            activeBtn.style.color = '#fff';
        }

        if (trendingEmpty) trendingEmpty.style.display = 'none';
        if (trendingList) {
            trendingList.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:4px 2px;">Loading...</div>';
            trendingList.style.display = 'block';
        }

        chrome.runtime.sendMessage({ action: 'fetchTrendingTokens', interval }, (response) => {
            if (!trendingList) return;
            if (!response || !response.success || !response.tokens?.length) {
                trendingList.style.display = 'none';
                if (trendingEmpty) trendingEmpty.style.display = 'block';
                return;
            }

            trendingList.innerHTML = '';
            response.tokens.forEach(token => {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.justifyContent = 'space-between';
                row.style.padding = '8px 10px';
                row.style.marginBottom = '6px';
                row.style.borderRadius = '10px';
                row.style.background = 'var(--bg-input)';

                const left = document.createElement('div');
                left.style.display = 'flex';
                left.style.flexDirection = 'column';
                left.style.fontSize = '11px';

                const title = document.createElement('div');
                title.style.fontSize = '12px';
                title.style.fontWeight = '600';
                title.textContent = `${token.symbol || '???'} · ${token.name || ''}`;

                const meta = document.createElement('div');
                meta.style.color = 'var(--text-muted)';
                meta.style.fontSize = '10px';
                if (token.address) meta.textContent = token.address;

                left.appendChild(title);
                left.appendChild(meta);

                const right = document.createElement('div');
                right.style.display = 'flex';
                right.style.flexDirection = 'column';
                right.style.alignItems = 'flex-end';
                right.style.gap = '2px';

                const priceEl = document.createElement('div');
                priceEl.style.fontSize = '12px';
                let priceText = '';
                if (token.priceUsd) {
                    const p = parseFloat(token.priceUsd);
                    if (p < 0.01) priceText = `$${p.toFixed(6)}`;
                    else if (p < 1) priceText = `$${p.toFixed(4)}`;
                    else priceText = `$${p.toFixed(2)}`;
                }
                priceEl.textContent = priceText || '$0.0000';

                const changeEl = document.createElement('div');
                changeEl.style.fontSize = '10px';
                let pct = interval === '1m' ? token.change1m : interval === '1h' ? token.change1h : token.change5m;
                pct = typeof pct === 'number' ? pct : parseFloat(pct || '0');
                const sign = pct > 0 ? '+' : '';
                changeEl.textContent = `${sign}${pct.toFixed(2)}% ${interval}`;
                changeEl.style.color = pct > 0 ? '#22c55e' : pct < 0 ? '#ef4444' : 'var(--text-muted)';

                right.appendChild(priceEl);
                right.appendChild(changeEl);

                row.appendChild(left);
                row.appendChild(right);

                trendingList.appendChild(row);
            });
        });
    } catch (e) {
        console.error('Failed to load trending', e);
    }
}

if (trending1mBtn) {
    trending1mBtn.addEventListener('click', () => loadTrending('1m'));
}
if (trending5mBtn) {
    trending5mBtn.addEventListener('click', () => loadTrending('5m'));
}
if (trending1hBtn) {
    trending1hBtn.addEventListener('click', () => loadTrending('1h'));
}

if (closeTradeSettingsBtn) {
    closeTradeSettingsBtn.addEventListener('click', () => {
        tradeSettingsModal.style.display = 'none';
    });
}

if (saveTradeSettingsBtn) {
    saveTradeSettingsBtn.addEventListener('click', () => {
        // Get Tips toggle value
        const showTipsToggle = document.getElementById('showTipsToggle');
        const showTipsButtons = showTipsToggle ? showTipsToggle.checked : true;

        // Get Market Insight toggle value
        const showMarketInsightToggle = document.getElementById('showMarketInsightToggle');
        const showMarketInsight = showMarketInsightToggle ? showMarketInsightToggle.checked : true;

        // Get Label Effect Style
        const labelEffectSelect = document.getElementById('labelEffectStyle');
        const labelEffectStyle = labelEffectSelect ? labelEffectSelect.value : 'gradient';

        chrome.storage.local.set({
            showTipsButtons: showTipsButtons,
            showMarketInsight: showMarketInsight,
            labelEffectStyle: labelEffectStyle
        }, () => {
            // Close modal
            tradeSettingsModal.style.display = 'none';

            // Notify content script to refresh settings
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]) {
                    chrome.tabs.sendMessage(tabs[0].id, {
                        action: 'refreshSettings',
                        showTipsButtons: showTipsButtons,
                        showMarketInsight: showMarketInsight,
                        labelEffectStyle: labelEffectStyle
                    });
                }
            });
        });
    });
}

function loadTradeSettings() {
    chrome.storage.local.get(['tradeSettings'], (result) => {
        const settings = result.tradeSettings || {
            gas: '',
            slippage: '10',
            amounts: [0.1, 0.5, 1.0]
        };
        applyTradeSettings(settings);
    });
}

function applyTradeSettings(settings) {
    // Update main UI inputs
    if (settings.gas) gasPriceInput.value = settings.gas;
    if (settings.slippage) slippageInput.value = settings.slippage;

    // Update Quick Buy buttons
    const btns = document.querySelectorAll('.quick-buy-btn');
    if (btns.length >= 3) {
        btns[0].textContent = `${settings.amounts[0]} BNB`;
        btns[0].setAttribute('data-amount', settings.amounts[0]);

        btns[1].textContent = `${settings.amounts[1]} BNB`;
        btns[1].setAttribute('data-amount', settings.amounts[1]);

        btns[2].textContent = `${settings.amounts[2]} BNB`;
        btns[2].setAttribute('data-amount', settings.amounts[2]);
    }
}

// Header Side Panel Button
const headerSidePanelBtn = document.getElementById('headerSidePanelBtn');
if (headerSidePanelBtn) {
    headerSidePanelBtn.addEventListener('click', async () => {
        try {
            const windowId = (await chrome.windows.getCurrent()).id;
            await chrome.sidePanel.open({ windowId });
            window.close(); // Close the popup
        } catch (error) {
            console.error('Failed to open side panel:', error);
            // Fallback to opening as a tab if side panel fails
            chrome.tabs.create({ url: 'src/popup.html' });
        }
    });
}

if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        // Open Trade Settings modal instead of options page
        if (tradeSettingsModal) {
            tradeSettingsModal.style.display = 'flex';
            // Load current settings
            chrome.storage.local.get(['tradeSettings', 'showTipsButtons'], (result) => {
                const settings = result.tradeSettings || {
                    gas: '',
                    slippage: '10',
                    amounts: [0.1, 0.5, 1.0]
                };
                if (settingGasInput) settingGasInput.value = settings.gas;
                if (settingSlippageInput) settingSlippageInput.value = settings.slippage;
                if (settingAmount1Input) settingAmount1Input.value = settings.amounts[0];
                if (settingAmount2Input) settingAmount2Input.value = settings.amounts[1];
                if (settingAmount3Input) settingAmount3Input.value = settings.amounts[2];

                // Load Tips toggle
                const showTipsToggle = document.getElementById('showTipsToggle');
                if (showTipsToggle) {
                    showTipsToggle.checked = result.showTipsButtons !== false;
                }

                // Load Market Insight toggle
                chrome.storage.local.get(['showMarketInsight'], (mi) => {
                    const marketInsightToggle = document.getElementById('showMarketInsightToggle');
                    if (marketInsightToggle) {
                        marketInsightToggle.checked = mi.showMarketInsight !== false;
                    }
                });

                // Load Label Effect Style
                chrome.storage.local.get(['labelEffectStyle'], (r) => {
                    const labelSelect = document.getElementById('labelEffectStyle');
                    if (labelSelect) {
                        labelSelect.value = r.labelEffectStyle || 'gradient';
                    }
                });
            });
        }
    });
}


if (refreshBalanceBtn) {
    refreshBalanceBtn.addEventListener('click', async () => {
        const auth = await chrome.storage.local.get('authToken');
        if (auth.authToken) {
            const icon = refreshBalanceBtn.querySelector('svg');
            if (icon) icon.style.animation = 'spin 1s linear infinite';

            await loadWalletBalance(auth.authToken);

            if (icon) icon.style.animation = 'none';
        }
    });
}

function extractUsernameFromUrl(url) {
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'twitter.com' || urlObj.hostname === 'x.com') {
            const pathParts = urlObj.pathname.split('/').filter(p => p);
            if (pathParts.length > 0 && !['home', 'explore', 'notifications', 'messages', 'search'].includes(pathParts[0])) {
                return pathParts[0];
            }
        }
    } catch (e) {
        console.error('Invalid URL:', url);
    }
    return null;
}
async function loadUserInfo(usernameToLoad) {
    try {
        // Only show loading if we don't have cached user info for this specific user
        // For now, simple loading state on the user card
        const userCard = document.querySelector('.user-info');
        userCard.style.opacity = '0.7';

        const response = await fetch(`${API_BASE}/api/user-check/${usernameToLoad}`);
        const data = await response.json();

        currentUser = {
            username: usernameToLoad,
            isRegistered: data.isRegistered || false,
            displayName: data.displayName || usernameToLoad,
            avatarUrl: data.avatarUrl || null,
            address: data.address || null
        };

        displayUserInfo();
        userCard.style.opacity = '1';

        // Ensure user info card is visible
        document.querySelector('.card:first-child').style.display = 'block';
    } catch (error) {
        showError('Failed to load user info: ' + error.message);
    }
}

function renderBalance(data) {
    if (balBnb) balBnb.textContent = parseFloat(data.balance || 0).toFixed(4);
    if (balClipx) balClipx.textContent = parseFloat(data.clipxBalance || 0).toFixed(2);
    if (tradeBalBnb) tradeBalBnb.textContent = parseFloat(data.balance || 0).toFixed(4);
}

async function loadWalletBalance(token) {
    try {
        // Native Wallet Support
        if (token === 'native-wallet') {
            const stored = await chrome.storage.local.get('nativeWallet');
            if (stored.nativeWallet && stored.nativeWallet.address) {
                const walletAddress = stored.nativeWallet.address;

                // Fetch BNB balance
                chrome.runtime.sendMessage({
                    action: 'getBnbBalance',
                    walletAddress: walletAddress
                }, (bnbResponse) => {
                    const balanceData = {
                        balance: bnbResponse && bnbResponse.success ? bnbResponse.balance : 0,
                        clipxBalance: 0
                    };

                    // Fetch CLIPX token balance
                    const CLIPX_ADDRESS = '0xc269d59a0d608ea0bd672f2f4616c372d8554444';
                    chrome.runtime.sendMessage({
                        action: 'getTokenBalance',
                        tokenAddress: CLIPX_ADDRESS,
                        walletAddress: walletAddress
                    }, (clipxResponse) => {
                        if (clipxResponse && clipxResponse.success) {
                            balanceData.clipxBalance = clipxResponse.balance;
                        }

                        renderBalance(balanceData);
                        chrome.storage.local.set({ cachedBalance: balanceData });
                    });
                });
            }
            return;
        }

        const response = await fetch(`${API_BASE}/api/dashboard`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) throw new Error('Failed to fetch balance');

        const data = await response.json();

        // Cache the fresh data
        chrome.storage.local.set({ cachedBalance: data });

        renderBalance(data);

    } catch (e) {
        console.error('Failed to load balance', e);
        // Don't show error in UI if we have cached data, just log it
        if (!balBnb.textContent || balBnb.textContent === '...') {
            if (balBnb) balBnb.textContent = 'Error';
            if (balClipx) balClipx.textContent = 'Error';
        }
    }
}

function renderTransactions(data, currentUserId) {
    if (data && data.length > 0) {
        txListContainer.innerHTML = data.map(tx => {
            // If we don't have currentUserId (e.g. from cache), we might guess or just show generic
            // But usually we should cache userId too. For now, let's assume we can derive it or it's in the tx object structure we cached?
            // The API returns { transactions: [...], user: { id: ... } }
            // So we should cache the whole response.

            const isSent = tx.fromUserId === currentUserId;
            const type = isSent ? 'Sent' : 'Received';
            const otherUser = isSent ? tx.toUser : tx.fromUser;
            const otherName = otherUser ? (otherUser.displayName || '@' + otherUser.username) : 'Unknown';
            const date = new Date(tx.createdAt).toLocaleDateString();
            const amountClass = isSent ? 'sent' : 'received';
            const sign = isSent ? '-' : '+';

            return `
                <div class="tx-item">
                    <div class="tx-info">
                        <span class="tx-title">${type} ${isSent ? 'to' : 'from'} ${otherName}</span>
                        <span class="tx-time">${date}</span>
                    </div>
                    <div class="tx-value ${amountClass}">
                        ${sign}${parseFloat(tx.amount).toFixed(4)} ${tx.currency}
                    </div>
                </div>
            `;
        }).join('');
    } else {
        txListContainer.innerHTML = '<div class="empty-tx" style="text-align: center; color: #94a3b8; font-size: 12px; padding: 10px;">No recent transactions</div>';
    }
}

async function loadRecentTransactions(token) {
    try {
        const response = await fetch(`${API_BASE}/api/transactions`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();

        if (data.transactions) {
            // Sort by date desc
            const recent = data.transactions
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
                .slice(0, 5);

            // Cache it
            chrome.storage.local.set({
                cachedTransactions: {
                    transactions: recent,
                    userId: data.user.id
                }
            });

            renderTransactions(recent, data.user.id);
        }
    } catch (e) {
        console.error('Failed to load transactions', e);
        // Keep cached version if available
    }
}

function displayUserInfo() {
    username.textContent = currentUser.displayName;
    handle.textContent = '@' + currentUser.username;

    if (currentUser.avatarUrl) {
        avatar.style.backgroundImage = `url(${currentUser.avatarUrl})`;
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
    } else {
        avatar.style.backgroundImage = 'none';
        avatar.style.backgroundColor = '#334155';
    }

    if (currentUser.isRegistered) {
        statusText.textContent = '✓ Registered';
        status.className = 'status-badge registered';
        tipForm.style.display = 'block';
        notRegisteredMessage.style.display = 'none';
    } else {
        statusText.textContent = '○ Not Registered';
        status.className = 'status-badge not-registered';
        tipForm.style.display = 'none';
        notRegisteredMessage.style.display = 'block';
    }
}

function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.style.display = 'flex';
    successMessage.style.display = 'none';
}

function showSuccess(msg) {
    successMessage.textContent = msg;
    successMessage.style.display = 'flex';
    errorMessage.style.display = 'none';
}

// Send Tip for registered users
if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
        const amount = amountInput.value;
        const token = tokenSelect.value;
        const gasTier = gasTierSelect.value;
        const isPrivate = true;

        const parsedAmount = parseFloat(amount);

        if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
            showError('Please enter a valid amount');
            return;
        }

        if (!currentUser) {
            showError('User not loaded');
            return;
        }

        try {
            sendBtn.disabled = true;
            sendBtn.innerHTML = '<div class="spinner" style="width: 16px; height: 16px; border-width: 2px;"></div> Sending...';

            const auth = await chrome.storage.local.get(['authToken', 'webAuthToken']);
            const bearer = auth.authToken || auth.webAuthToken;
            if (!bearer) {
                showError('Not authenticated. Please log in on ClipX first.');
                return;
            }

            const response = await fetch(`${API_BASE}/api/send-tip-x`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${bearer}`
                },
                body: JSON.stringify({
                    recipient: currentUser.username,
                    amount: amount,
                    token: token,
                    gasTier: gasTier,
                    isPrivate: isPrivate,
                    isEscrow: false
                })
            });

            const data = await response.json();

            if (data.success) {
                showSuccess(`✓ Tip sent! TX: ${data.txHash.slice(0, 10)}...`);
                amountInput.value = '';
                // Refresh transactions and balance
                loadRecentTransactions(bearer);
                loadWalletBalance(bearer);
                setTimeout(() => window.close(), 2000);
            } else {
                showError(data.error || 'Failed to send tip');
            }
        } catch (error) {
            showError('Error: ' + error.message);
        } finally {
            sendBtn.disabled = false;
            sendBtn.innerHTML = 'Send Tip 💸';
        }
    });
}

// Send Tip for unregistered users (via Escrow)
if (sendEscrowBtn) {
    sendEscrowBtn.addEventListener('click', async () => {
        const amount = document.getElementById('amount2').value;
        const token = document.getElementById('token2').value;
        const gasTier = document.getElementById('gasTier2').value;

        if (!amount || parseFloat(amount) <= 0) {
            showError('Please enter a valid amount');
            return;
        }

        if (!currentUser) {
            showError('User not loaded');
            return;
        }

        try {
            sendEscrowBtn.disabled = true;
            sendEscrowBtn.innerHTML = '<div class="spinner" style="width: 16px; height: 16px; border-width: 2px;"></div> Sending...';

            const auth = await chrome.storage.local.get(['authToken', 'webAuthToken']);
            const bearer = auth.authToken || auth.webAuthToken;
            if (!bearer) {
                showError('Not authenticated. Please log in on ClipX first.');
                return;
            }

            const response = await fetch(`${API_BASE}/api/send-tip-x`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${bearer}`
                },
                body: JSON.stringify({
                    recipient: currentUser.username,
                    amount: amount,
                    token: token,
                    gasTier: gasTier,
                    isPrivate: true,
                    isEscrow: true
                })
            });

            const data = await response.json();

            if (data.success) {
                showSuccess(`✓ Escrow sent! They have 3 days to claim. TX: ${data.txHash.slice(0, 10)}...`);
                document.getElementById('amount2').value = '';
                // Refresh transactions and balance
                loadRecentTransactions(bearer);
                loadWalletBalance(bearer);
                setTimeout(() => window.close(), 2000);
            } else {
                showError(data.error || 'Failed to send escrow tip');
            }
        } catch (error) {
            showError('Error: ' + error.message);
        } finally {
            sendEscrowBtn.disabled = false;
            sendEscrowBtn.innerHTML = 'Send to Escrow 📦';
        }
    });
}

if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
        amountInput.value = '';
        document.getElementById('amount2').value = '';
        errorMessage.style.display = 'none';
        successMessage.style.display = 'none';
    });
}


// --- Wallet Control Logic ---
const walletAddressDisplay = document.getElementById('wallet-address-display');
const copyAddressBtn = document.getElementById('copy-address-btn');
const logoutBtn = document.getElementById('logout-btn');
const twitterLogoutBtn = document.getElementById('twitter-logout-btn');
const nativeWalletUi = document.getElementById('native-wallet-ui');
const noNativeWalletUi = document.getElementById('no-native-wallet-ui');

// Check wallet state on load (Wallet tab supports native wallet and ClipX web wallet)
chrome.storage.local.get(['authToken', 'nativeWallet', 'userAddress', 'webUserAddress'], (result) => {
    const hasNative = result.authToken === 'native-wallet' && result.nativeWallet && result.nativeWallet.address;

    // Get the web wallet address, ensuring it's a valid 0x address
    const webAddr = result.userAddress || result.webUserAddress;
    const hasClipxWallet = result.authToken && result.authToken !== 'native-wallet' && webAddr && webAddr.startsWith('0x');

    // If we have some wallet (native or ClipX), show the main wallet UI
    if (hasNative || hasClipxWallet) {
        if (nativeWalletUi) nativeWalletUi.style.display = 'block';
        if (noNativeWalletUi) noNativeWalletUi.style.display = 'none';

        const addr = hasNative ? result.nativeWallet.address : webAddr;
        if (walletAddressDisplay && addr) walletAddressDisplay.value = addr;

        if (hasNative) {
            if (username) username.textContent = 'Native Wallet';
            if (handle) handle.textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
        } else {
            if (username) username.textContent = 'ClipX Wallet';
            if (handle) handle.textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
        }

        if (avatar) {
            avatar.style.backgroundImage = 'none';
            avatar.style.backgroundColor = '#8b5cf6';
            avatar.textContent = '⚡';
            avatar.style.display = 'flex';
            avatar.style.alignItems = 'center';
            avatar.style.justifyContent = 'center';
            avatar.style.color = 'white';
        }
        if (statusText) statusText.textContent = 'Active';
        if (status) status.className = 'status-badge registered';
    } else {
        // No wallet bound; show the simpler Twitter/logout UI
        if (nativeWalletUi) nativeWalletUi.style.display = 'none';
        if (noNativeWalletUi) noNativeWalletUi.style.display = 'block';
    }
});

if (copyAddressBtn) {
    copyAddressBtn.addEventListener('click', () => {
        if (walletAddressDisplay && walletAddressDisplay.value) {
            navigator.clipboard.writeText(walletAddressDisplay.value);
            const originalText = copyAddressBtn.textContent;
            copyAddressBtn.textContent = '✓';
            setTimeout(() => copyAddressBtn.textContent = originalText, 2000);
        }
    });
}

// Open Wallet Management Page
/* const openWalletManagementBtn = document.getElementById('open-wallet-management');
if (openWalletManagementBtn) {
    openWalletManagementBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
} */

// Custom Logout Modal Logic
const logoutModal = document.getElementById('logoutModal');
const confirmLogoutBtn = document.getElementById('confirmLogoutBtn');
const cancelLogoutBtn = document.getElementById('cancelLogoutBtn');

function showLogoutModal() {
    if (logoutModal) logoutModal.style.display = 'flex';
}

function hideLogoutModal() {
    if (logoutModal) logoutModal.style.display = 'none';
}

if (cancelLogoutBtn) {
    cancelLogoutBtn.addEventListener('click', hideLogoutModal);
}

if (confirmLogoutBtn) {
    confirmLogoutBtn.addEventListener('click', () => {
        confirmLogoutBtn.disabled = true;
        confirmLogoutBtn.textContent = 'Logging out...';

        chrome.storage.local.remove(['authToken', 'nativeWallet', 'userAddress', 'cachedBalance', 'cachedTransactions'], () => {
            // Send lock message to background to clear memory
            chrome.runtime.sendMessage({ action: 'lockWallet' });
            window.close();
        });
    });
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', showLogoutModal);
}

if (twitterLogoutBtn) {
    twitterLogoutBtn.addEventListener('click', () => {
        // For Twitter logout, we can use the same modal or a simpler one.
        // For now, let's use the same one but maybe change text dynamically if we wanted to be fancy.
        // Or just keep it simple and use the same "Log Out?" modal.
        showLogoutModal();
    });
}

async function loadWalletAssets() {
    const assetsLoading = document.getElementById('assets-loading');
    const assetsList = document.getElementById('assets-list');
    const assetsEmpty = document.getElementById('assets-empty');

    // Show loading state
    if (assetsLoading) assetsLoading.style.display = 'block';
    if (assetsList) assetsList.style.display = 'none';
    if (assetsEmpty) assetsEmpty.style.display = 'none';

    try {
        const stored = await chrome.storage.local.get(['authToken', 'nativeWallet', 'userAddress']);

        let walletAddress = null;
        if (stored.authToken === 'native-wallet' && stored.nativeWallet && stored.nativeWallet.address) {
            walletAddress = stored.nativeWallet.address;
        } else if (stored.authToken && stored.userAddress) {
            // ClipX web wallet mode; use the bound on-chain address from syncAuth
            walletAddress = stored.userAddress;
        }

        if (!walletAddress) {
            if (assetsLoading) assetsLoading.style.display = 'none';
            if (assetsEmpty) assetsEmpty.style.display = 'block';
            return;
        }

        console.log('[ClipX] Loading holdings for wallet:', walletAddress);

        // Ask background for all token contracts this wallet has touched
        chrome.runtime.sendMessage({
            action: 'getWalletAssets',
            walletAddress: walletAddress
        }, async (response) => {
            // Always start with BNB as a native asset
            const allAssets = [{
                address: 'BNB',
                name: 'BNB',
                symbol: 'BNB',
                decimals: 18,
                isNative: true,
                balance: 0
            }];

            // Helper to fetch BNB balance and render whatever assets we have
            const finalizeWithBnb = async (extraAssets) => {
                chrome.runtime.sendMessage({
                    action: 'getBnbBalance',
                    walletAddress: walletAddress
                }, async (bnbResponse) => {
                    if (bnbResponse && bnbResponse.success) {
                        allAssets[0].balance = bnbResponse.balance;
                    }

                    const assets = [...allAssets, ...(extraAssets || [])];
                    const enrichedAssets = await enrichAssetsWithPrices(assets);
                    renderAssets(enrichedAssets);
                });
            };

            // Core tokens we always want to probe in addition to discovered ones
            const CORE_TOKENS = [
                '0xc269d59a0d608ea0bd672f2f4616c372d8554444', // CLIPX
                '0x000ae314e2a2172a039b26378814c252734f556a', // ASTER
                '0x55d398326f99059fF775485246999027B3197955', // USDT
                '0x20d6015660b3fe52e6690a889b5c51f69902ce0e'  // GIGGLE
            ];

            const discovered = (response && response.success && Array.isArray(response.tokens))
                ? response.tokens
                : [];

            // Merge discovered token addresses with core ones
            const uniqueAddresses = Array.from(new Set([...discovered, ...CORE_TOKENS]));

            // For each token address, fetch metadata + balance
            const tokenPromises = uniqueAddresses.map(async (tokenAddress) => {
                try {
                    const metadata = await new Promise(resolve => {
                        chrome.runtime.sendMessage({
                            action: 'getTokenMetadata',
                            tokenAddress
                        }, (metaResponse) => resolve(metaResponse));
                    });

                    if (!metadata || !metadata.success) return null;

                    const balanceResp = await new Promise(resolve => {
                        chrome.runtime.sendMessage({
                            action: 'getTokenBalance',
                            tokenAddress,
                            walletAddress
                        }, (balResponse) => resolve(balResponse));
                    });

                    const balance = balanceResp && balanceResp.success ? balanceResp.balance : 0;
                    if (!balance || balance <= 0) return null;

                    return {
                        address: tokenAddress,
                        name: metadata.name,
                        symbol: metadata.symbol,
                        decimals: metadata.decimals,
                        balance,
                        isNative: false
                    };
                } catch (e) {
                    console.error('Error loading token for holdings:', tokenAddress, e);
                    return null;
                }
            });

            const tokens = await Promise.all(tokenPromises);
            const validTokens = tokens.filter(t => t !== null);

            await finalizeWithBnb(validTokens);
        });
    } catch (error) {
        console.error('Error loading wallet assets:', error);
        if (assetsLoading) assetsLoading.style.display = 'none';
        if (assetsEmpty) assetsEmpty.style.display = 'block';
    }
}

async function enrichAssetsWithPrices(assets) {
    const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

    const tasks = assets.map(asset => {
        return new Promise(resolve => {
            // Determine which address to use for price lookup
            const lookupAddress = asset.isNative ? WBNB_ADDRESS : asset.address;

            if (!lookupAddress || lookupAddress === 'BNB') {
                resolve(asset);
                return;
            }

            chrome.runtime.sendMessage({
                action: 'fetchTokenInfo',
                address: lookupAddress
            }, (response) => {
                if (!response || !response.success) {
                    resolve(asset);
                    return;
                }

                const priceUsd = response.priceUsd ? parseFloat(response.priceUsd) : null;
                const priceChange = typeof response.priceChange === 'number'
                    ? response.priceChange
                    : 0;

                resolve({
                    ...asset,
                    priceUsd,
                    priceChange
                });
            });
        });
    });

    return Promise.all(tasks);
}

function renderAssets(assets) {
    const assetsLoading = document.getElementById('assets-loading');
    const assetsList = document.getElementById('assets-list');
    const assetsEmpty = document.getElementById('assets-empty');

    // Populate Send Token Select (Inline Form)
    const sendSelect = document.getElementById('send-token-inline');
    if (sendSelect) {
        // Keep selected value if possible
        const currentVal = sendSelect.value;
        sendSelect.innerHTML = '';

        // Add BNB default if assets empty or not loaded yet?
        // But here assets are loaded.
        if (assets && assets.length > 0) {
            assets.forEach(asset => {
                const opt = document.createElement('option');
                opt.value = asset.isNative ? 'BNB' : asset.address;
                const bal = parseFloat(asset.balance || 0).toFixed(4);
                opt.textContent = `${asset.symbol} (Bal: ${bal})`;
                sendSelect.appendChild(opt);
            });
            if (currentVal) sendSelect.value = currentVal;
            if (!sendSelect.value && sendSelect.options.length > 0) sendSelect.selectedIndex = 0;
        } else {
            const opt = document.createElement('option');
            opt.value = 'BNB';
            opt.textContent = 'BNB';
            sendSelect.appendChild(opt);
        }
    }

    if (assetsLoading) assetsLoading.style.display = 'none';

    if (!assets || assets.length === 0) {
        if (assetsEmpty) assetsEmpty.style.display = 'block';
        if (assetsList) assetsList.style.display = 'none';
        return;
    }

    if (assetsEmpty) assetsEmpty.style.display = 'none';
    if (assetsList) {
        assetsList.style.display = 'block';
        assetsList.innerHTML = assets.map(asset => {
            const icon = asset.isNative ? '🟡' : '💎';
            const balanceNum = parseFloat(asset.balance || 0);
            const balance = balanceNum.toFixed(asset.isNative ? 4 : 2);

            const price = typeof asset.priceUsd === 'number'
                ? asset.priceUsd
                : asset.priceUsd ? parseFloat(asset.priceUsd) : null;

            let valueText = '';
            if (!isNaN(balanceNum) && price && price > 0) {
                const value = balanceNum * price;
                if (value < 1) valueText = `≈ $${value.toFixed(4)}`;
                else if (value < 1000) valueText = `≈ $${value.toFixed(2)}`;
                else valueText = `≈ $${value.toFixed(0)}`;
            }

            let changeText = '';
            let changeColor = 'var(--text-muted)';
            if (typeof asset.priceChange === 'number' && asset.priceChange !== 0) {
                const pct = asset.priceChange;
                const sign = pct > 0 ? '+' : '';
                changeText = `${sign}${pct.toFixed(2)}% 24h`;
                changeColor = pct > 0 ? '#22c55e' : '#ef4444';
            }

            return `
                <div class="balance-item" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px;">
                    <div style="display: flex; flex-direction: column;">
                        <span style="font-size: 12px; color: var(--text-main); font-weight: 600;">${icon} ${asset.symbol}</span>
                        <span style="font-size: 10px; color: var(--text-muted);">${asset.name}</span>
                    </div>
                    <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
                        <span style="font-weight: 600; font-size: 12px;">${balance}</span>
                        <span style="font-size: 10px; color: var(--text-muted);">
                            ${valueText}
                            ${changeText ? `<span style=\"margin-left:4px; color:${changeColor};\">${changeText}</span>` : ''}
                        </span>
                    </div>
                </div>
            `;
        }).join('');
    }
}

const refreshAssetsBtn = document.getElementById('refresh-assets-btn');
if (refreshAssetsBtn) {

    refreshAssetsBtn.addEventListener('click', loadWalletAssets);
}

// --- Send Modal Logic ---
if (openSendModalBtn) {
    openSendModalBtn.addEventListener('click', () => {
        if (sendModal) sendModal.style.display = 'flex';
    });
}
if (closeSendModalBtn) {
    closeSendModalBtn.addEventListener('click', () => {
        if (sendModal) sendModal.style.display = 'none';
        if (sendAmountInput) sendAmountInput.value = '';
        if (sendRecipientInput) sendRecipientInput.value = '';
    });
}
if (confirmSendBtn) {
    confirmSendBtn.addEventListener('click', async () => {
        const to = sendRecipientInput.value.trim();
        const amount = sendAmountInput.value.trim();
        const tokenAddress = sendTokenSelect.value;
        // Basic validation
        const isAddress = (ethers && ethers.isAddress && ethers.isAddress(to)) || (ethers && ethers.utils && ethers.utils.isAddress && ethers.utils.isAddress(to));

        if (!isAddress) {
            alert('Invalid Address. Please enter a valid BSC address.'); return;
        }
        if (!amount || parseFloat(amount) <= 0) {
            alert('Invalid Amount'); return;
        }

        confirmSendBtn.disabled = true;
        confirmSendBtn.textContent = 'Sending...';

        chrome.runtime.sendMessage({
            action: 'nativeTransfer',
            to,
            amount,
            tokenAddress: tokenAddress === 'BNB' ? 'BNB' : tokenAddress
        }, (response) => {
            confirmSendBtn.disabled = false;
            confirmSendBtn.textContent = 'Confirm Send';
            if (response && response.success) {
                alert('Sent! TX: ' + response.txHash);
                if (sendModal) sendModal.style.display = 'none';
                // Refresh
                loadWalletAssets();
                // Also refresh history logic
                if (typeof loadRecentTransactions === 'function') loadRecentTransactions('native-wallet');
            } else {
                alert('Error: ' + (response ? response.error : 'Unknown'));
            }
        });
    });
}

// --- Markets Tab Button (Opinion Trade Widget Toggle) ---
const marketsTabBtn = document.getElementById('marketsTabBtn');
if (marketsTabBtn) {
    marketsTabBtn.addEventListener('click', async () => {
        // Send message to the active tab's content script to toggle the widget
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && tabs[0].id) {
            chrome.tabs.sendMessage(tabs[0].id, { action: 'toggleOpinionWidget' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn('[ClipX] Could not toggle widget:', chrome.runtime.lastError.message);
                    // Maybe not on a twitter page
                    alert('Please open X (Twitter) to use the Markets widget!');
                } else if (response && response.success) {
                    console.log('[ClipX] Opinion widget toggled. Visible:', response.visible);
                }
            });
        }
    });
}

// Hide loading overlay after initialization
setTimeout(() => {
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'flex';
}, 100);


