// ClipX Tipping Assistant - Popup Script

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

    console.log('[ClipX Popup] API_BASE initialized to:', API_BASE, _clipxDevMode ? '(dev)' : '');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.clipxDevMode) _clipxDevMode = changes.clipxDevMode.newValue === true;
    if (!changes.apiBase && !changes.clipxDevMode) return;
    const v = changes.apiBase ? changes.apiBase.newValue : API_BASE;
    API_BASE = clipxNormalizeApiBase(typeof v === 'string' ? v : '', _clipxDevMode);
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
const balSol = document.getElementById('bal-sol');
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

// Native wallet panel elements
const nativeWalletStatus = document.getElementById('native-wallet-status');
const nativeBscAddress = document.getElementById('native-bsc-address');
const nativeSolAddress = document.getElementById('native-sol-address');
const nativeWalletCreateBox = document.getElementById('native-wallet-create-box');
const nativeWalletActions = document.getElementById('native-wallet-actions');
const nativeWalletMessage = document.getElementById('native-wallet-message');
const nativeWalletPassword = document.getElementById('native-wallet-password');
const nativeCreateBothBtn = document.getElementById('native-create-both-btn');
const nativeWalletRefreshBtn = document.getElementById('native-wallet-refresh-btn');
const nativeShowImportBtn = document.getElementById('native-show-import-btn');
const nativeShowExportBtn = document.getElementById('native-show-export-btn');
const nativeWalletImportBox = document.getElementById('native-wallet-import-box');
const nativeWalletExportBox = document.getElementById('native-wallet-export-box');
const nativeImportBscKey = document.getElementById('native-import-bsc-key');
const nativeImportSolKey = document.getElementById('native-import-sol-key');
const nativeImportPassword = document.getElementById('native-import-password');
const nativeImportConfirmBtn = document.getElementById('native-import-confirm-btn');
const nativeCopyBscBtn = document.getElementById('native-copy-bsc-btn');
const nativeCopySolBtn = document.getElementById('native-copy-sol-btn');
const nativeExportConfirmBtn = document.getElementById('native-export-confirm-btn');
const nativeExportBscKey = document.getElementById('native-export-bsc-key');
const nativeExportSolKey = document.getElementById('native-export-sol-key');
const nativeHideExportBtn = document.getElementById('native-hide-export-btn');

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
            const activeTabName = activeTab ? activeTab.getAttribute('data-tab') : '';
            if (!activeTab || activeTabName === 'send-tip' || activeTabName === 'watchlist') {
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

function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(message, (response) => resolve(response));
    });
}

function shortAddress(address) {
    if (!address) return 'Not created';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function setNativeWalletMessage(message, type = 'info') {
    if (!nativeWalletMessage) return;
    const colors = {
        info: 'var(--text-muted)',
        success: '#6ee7b7',
        error: '#fca5a5',
        warn: '#fbbf24'
    };
    nativeWalletMessage.textContent = message || '';
    nativeWalletMessage.style.color = colors[type] || colors.info;
}

function setButtonBusy(btn, isBusy, busyText) {
    if (!btn) return () => { };
    const originalText = btn.textContent;
    btn.disabled = isBusy;
    if (isBusy && busyText) btn.textContent = busyText;
    return () => {
        btn.disabled = false;
        btn.textContent = originalText;
    };
}

async function getNativeWalletStateForPopup() {
    const stored = await chrome.storage.local.get(['nativeWallet', 'walletPrivateKey', 'solWallet', 'authToken', 'userAddress']);
    return {
        bscAddress: stored.nativeWallet?.address || (stored.userAddress && stored.userAddress.startsWith('0x') ? stored.userAddress : ''),
        solAddress: stored.solWallet?.address || '',
        hasBscKey: !!(stored.walletPrivateKey || stored.nativeWallet?.privateKey || stored.nativeWallet?.encrypted),
        hasSolKey: !!stored.solWallet?.privateKey
    };
}

async function refreshNativeWalletPanel() {
    const state = await getNativeWalletStateForPopup();
    const bscCard = document.getElementById('native-bsc-card');
    const solCard = document.getElementById('native-sol-card');
    if (nativeBscAddress) {
        nativeBscAddress.textContent = state.bscAddress ? shortAddress(state.bscAddress) : 'Not created';
        nativeBscAddress.title = state.bscAddress || '';
    }
    if (nativeSolAddress) {
        nativeSolAddress.textContent = state.solAddress ? shortAddress(state.solAddress) : 'Not created';
        nativeSolAddress.title = state.solAddress || '';
    }
    if (bscCard) bscCard.classList.toggle('is-ready', !!state.bscAddress);
    if (solCard) solCard.classList.toggle('is-ready', !!state.solAddress);

    const hasBoth = !!(state.bscAddress && state.solAddress);
    const hasAny = !!(state.bscAddress || state.solAddress);
    if (nativeWalletStatus) {
        nativeWalletStatus.textContent = hasBoth
            ? 'Ready for native BSC and Solana one-click trading.'
            : hasAny
                ? 'One chain is ready. Create or import the missing wallet before funding.'
                : 'Create one secure wallet set for BSC and Solana one-click trades.';
        nativeWalletStatus.style.color = hasBoth ? '#6ee7b7' : 'var(--text-muted)';
    }
    if (nativeWalletActions) nativeWalletActions.style.display = hasAny ? 'block' : 'none';
    if (nativeWalletCreateBox) nativeWalletCreateBox.style.display = hasBoth ? 'none' : 'block';
    if (nativeCreateBothBtn) nativeCreateBothBtn.textContent = hasAny ? 'Create Missing Wallet' : 'Create BSC + Solana Wallets';
    if (nativeWalletPassword) nativeWalletPassword.style.display = state.bscAddress ? 'none' : 'block';
    const passwordLabel = nativeWalletPassword?.closest('.input-group')?.querySelector('.input-label');
    if (passwordLabel) passwordLabel.style.display = state.bscAddress ? 'none' : 'block';
    return state;
}

async function copyTextWithFeedback(text, btn) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    const originalText = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = originalText; }, 1400);
}

function clearExportedKeys() {
    [nativeExportBscKey, nativeExportSolKey].forEach((el) => {
        if (!el) return;
        el.textContent = '';
        el.style.display = 'none';
        el.onclick = null;
    });
}

function wireSecretCopy(el, label, value) {
    if (!el || !value) return;
    el.textContent = `${label}: ${value}`;
    el.style.display = 'block';
    el.title = 'Click to copy';
    el.onclick = async () => {
        await navigator.clipboard.writeText(value);
        setNativeWalletMessage(`${label} copied. Clear your clipboard after backup.`, 'warn');
    };
}

async function initNativeWalletPanel() {
    await refreshNativeWalletPanel();

    if (nativeWalletRefreshBtn) {
        nativeWalletRefreshBtn.onclick = refreshNativeWalletPanel;
    }

    if (nativeCreateBothBtn) {
        nativeCreateBothBtn.onclick = async () => {
            const state = await getNativeWalletStateForPopup();
            const needsBsc = !state.bscAddress;
            const needsSol = !state.solAddress;
            const password = nativeWalletPassword ? nativeWalletPassword.value.trim() : '';
            if (needsBsc && password.length < 8) {
                setNativeWalletMessage('Use at least 8 characters for the BSC backup password.', 'error');
                return;
            }

            const done = setButtonBusy(nativeCreateBothBtn, true, 'Creating...');
            setNativeWalletMessage('Creating wallet keys locally...', 'info');
            try {
                let bscAddress = state.bscAddress;
                let solAddress = state.solAddress;
                if (needsBsc) {
                    const generated = await sendRuntimeMessage({ action: 'clipxGenerateNativeWallet' });
                    if (!generated?.success) throw new Error(generated?.error || 'Failed to create BSC wallet');
                    const finalized = await sendRuntimeMessage({
                        action: 'clipxFinalizeNativeWallet',
                        sessionId: generated.sessionId,
                        password
                    });
                    if (!finalized?.success) throw new Error(finalized?.error || 'Failed to save BSC wallet');
                    bscAddress = finalized.address || generated.address;
                }
                if (needsSol) {
                    const sol = await sendRuntimeMessage({ action: 'clipxGenerateSolWallet' });
                    if (!sol?.success) throw new Error(sol?.error || 'Failed to create Solana wallet');
                    solAddress = sol.address;
                }
                if (nativeWalletPassword) nativeWalletPassword.value = '';
                await refreshNativeWalletPanel();
                loadSolBalance();
                loadWalletAssets();
                setNativeWalletMessage(`Wallet ready. BSC ${shortAddress(bscAddress)} / SOL ${shortAddress(solAddress)}. Export and back up keys before funding.`, 'success');
            } catch (e) {
                setNativeWalletMessage(e.message || String(e), 'error');
            } finally {
                done();
            }
        };
    }

    if (nativeShowImportBtn && nativeWalletImportBox) {
        nativeShowImportBtn.onclick = () => {
            nativeWalletImportBox.style.display = nativeWalletImportBox.style.display === 'none' ? 'block' : 'none';
            if (nativeWalletExportBox) nativeWalletExportBox.style.display = 'none';
            clearExportedKeys();
        };
    }

    if (nativeShowExportBtn && nativeWalletExportBox) {
        nativeShowExportBtn.onclick = () => {
            nativeWalletExportBox.style.display = nativeWalletExportBox.style.display === 'none' ? 'block' : 'none';
            if (nativeWalletImportBox) nativeWalletImportBox.style.display = 'none';
            clearExportedKeys();
        };
    }

    if (nativeImportConfirmBtn) {
        nativeImportConfirmBtn.onclick = async () => {
            const bscKey = nativeImportBscKey ? nativeImportBscKey.value.trim() : '';
            const solKey = nativeImportSolKey ? nativeImportSolKey.value.trim() : '';
            const password = nativeImportPassword ? nativeImportPassword.value.trim() : '';
            if (!bscKey && !solKey) {
                setNativeWalletMessage('Paste a BSC key/phrase, a Solana key, or both.', 'error');
                return;
            }
            if (bscKey && password.length < 8) {
                setNativeWalletMessage('Use at least 8 characters to protect the imported BSC backup.', 'error');
                return;
            }

            const done = setButtonBusy(nativeImportConfirmBtn, true, 'Importing...');
            try {
                if (bscKey) {
                    const bsc = await sendRuntimeMessage({
                        action: 'clipxImportNativeWallet',
                        privateKey: bscKey,
                        password
                    });
                    if (!bsc?.success) throw new Error(bsc?.error || 'BSC import failed');
                }
                if (solKey) {
                    const sol = await sendRuntimeMessage({
                        action: 'clipxImportSolWallet',
                        privateKey: solKey
                    });
                    if (!sol?.success) throw new Error(sol?.error || 'Solana import failed');
                }
                if (nativeImportBscKey) nativeImportBscKey.value = '';
                if (nativeImportSolKey) nativeImportSolKey.value = '';
                if (nativeImportPassword) nativeImportPassword.value = '';
                if (nativeWalletImportBox) nativeWalletImportBox.style.display = 'none';
                await refreshNativeWalletPanel();
                loadSolBalance();
                loadWalletAssets();
                setNativeWalletMessage('Wallet import complete.', 'success');
            } catch (e) {
                setNativeWalletMessage(e.message || String(e), 'error');
            } finally {
                done();
            }
        };
    }

    if (nativeCopyBscBtn) {
        nativeCopyBscBtn.onclick = async () => {
            const state = await getNativeWalletStateForPopup();
            copyTextWithFeedback(state.bscAddress, nativeCopyBscBtn);
        };
    }

    if (nativeCopySolBtn) {
        nativeCopySolBtn.onclick = async () => {
            const state = await getNativeWalletStateForPopup();
            copyTextWithFeedback(state.solAddress, nativeCopySolBtn);
        };
    }

    if (nativeExportConfirmBtn) {
        nativeExportConfirmBtn.onclick = async () => {
            const done = setButtonBusy(nativeExportConfirmBtn, true, 'Revealing...');
            clearExportedKeys();
            try {
                const [bsc, sol] = await Promise.all([
                    sendRuntimeMessage({ action: 'clipxExportNativeWallet' }),
                    sendRuntimeMessage({ action: 'clipxExportSolWallet' })
                ]);
                if (bsc?.success) wireSecretCopy(nativeExportBscKey, 'BSC private key', bsc.privateKey);
                if (sol?.success) wireSecretCopy(nativeExportSolKey, 'Solana private key', sol.privateKey);
                if (!bsc?.success && !sol?.success) throw new Error('No exportable wallet keys found.');
                setNativeWalletMessage('Keys revealed. Click a key to copy, then hide this section.', 'warn');
            } catch (e) {
                setNativeWalletMessage(e.message || String(e), 'error');
            } finally {
                done();
            }
        };
    }

    if (nativeHideExportBtn) {
        nativeHideExportBtn.onclick = () => {
            clearExportedKeys();
            if (nativeWalletExportBox) nativeWalletExportBox.style.display = 'none';
            setNativeWalletMessage('Private keys hidden.', 'info');
        };
    }
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
                const txChain = tx.chain || 'bnb';
                const txExplorer = txChain === 'sol'
                    ? `https://solscan.io/tx/${tx.txHash || tx.hash}`
                    : `https://bscscan.com/tx/${tx.txHash || tx.hash}`;
                row.onclick = () => window.open(txExplorer, '_blank');

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

        const isEvmAddr = to && to.length === 42 && to.startsWith('0x');
        const isSolAddr = to && to.length >= 32 && to.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(to);
        if (!isEvmAddr && !isSolAddr) {
            alert('Invalid Address. Please enter a valid BSC (0x...) or Solana address.');
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
            const protectedTabs = ['history'];
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

            chrome.storage.local.get(['useDashboardWalletSwap'], (r) => {
                const dashSwap = document.getElementById('useDashboardWalletSwapToggle');
                if (dashSwap) dashSwap.checked = r.useDashboardWalletSwap === true;
            });
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

        const isEvm = addr && addr.startsWith('0x') && addr.length === 42;
        const isSolana = addr && addr.length >= 32 && addr.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr);
        if (!isEvm && !isSolana) {
            alert('Please enter a valid BSC (0x...) or Solana contract address.');
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

        const showTrendingAccountsSidebarToggle = document.getElementById('showTrendingAccountsSidebarToggle');
        const showTrendingAccountsSidebar = showTrendingAccountsSidebarToggle ? showTrendingAccountsSidebarToggle.checked : true;

        // Get Label Effect Style
        const labelEffectSelect = document.getElementById('labelEffectStyle');
        const labelEffectStyle = labelEffectSelect ? labelEffectSelect.value : 'gradient';

        const tokenPillStyleSelect = document.getElementById('tokenPillStyle');
        const tokenPillStyle = tokenPillStyleSelect ? tokenPillStyleSelect.value : 'market';

        const dashboardSwapToggle = document.getElementById('useDashboardWalletSwapToggle');
        const useDashboardWalletSwap = dashboardSwapToggle ? dashboardSwapToggle.checked : false;

        chrome.storage.local.set({
            showTipsButtons: showTipsButtons,
            showMarketInsight: showMarketInsight,
            showTrendingAccountsSidebar: showTrendingAccountsSidebar,
            labelEffectStyle: labelEffectStyle,
            tokenPillStyle: tokenPillStyle,
            useDashboardWalletSwap: useDashboardWalletSwap,
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
                        showTrendingAccountsSidebar: showTrendingAccountsSidebar,
                        labelEffectStyle: labelEffectStyle,
                        tokenPillStyle: tokenPillStyle
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

                chrome.storage.local.get(['showTrendingAccountsSidebar'], (ta) => {
                    const taToggle = document.getElementById('showTrendingAccountsSidebarToggle');
                    if (taToggle) {
                        taToggle.checked = ta.showTrendingAccountsSidebar !== false;
                    }
                });

                // Load Label Effect Style
                chrome.storage.local.get(['labelEffectStyle'], (r) => {
                    const labelSelect = document.getElementById('labelEffectStyle');
                    if (labelSelect) {
                        labelSelect.value = r.labelEffectStyle || 'gradient';
                    }
                });

                chrome.storage.local.get(['tokenPillStyle'], (r) => {
                    const tokenPillSelect = document.getElementById('tokenPillStyle');
                    if (tokenPillSelect) {
                        const stored = r.tokenPillStyle;
                        const normalized = (stored === 'classic' || stored === 'clean') ? 'market'
                            : stored === 'neon' ? 'chain'
                            : stored === 'compact' ? 'micro'
                            : (['market', 'chain', 'micro'].includes(stored) ? stored : 'market');
                        tokenPillSelect.value = normalized;
                    }
                });

                chrome.storage.local.get(['useDashboardWalletSwap'], (r) => {
                    const dashSwap = document.getElementById('useDashboardWalletSwapToggle');
                    if (dashSwap) dashSwap.checked = r.useDashboardWalletSwap === true;
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
    if (data.solBalance != null && balSol) balSol.textContent = parseFloat(data.solBalance || 0).toFixed(4);
}

function loadSolBalance() {
    chrome.runtime.sendMessage({ action: 'getSolBalance' }, (resp) => {
        if (resp && resp.success && balSol) {
            balSol.textContent = parseFloat(resp.balance || 0).toFixed(4);
        } else if (balSol) {
            balSol.textContent = '—';
        }
    });
}

async function loadWalletBalance(token) {
    try {
        // Always try loading SOL balance in parallel
        loadSolBalance();

        // Native Wallet Support
        if (token === 'native-wallet') {
            const stored = await chrome.storage.local.get('nativeWallet');
            if (stored.nativeWallet && stored.nativeWallet.address) {
                const walletAddress = stored.nativeWallet.address;

                chrome.runtime.sendMessage({
                    action: 'getBnbBalance',
                    walletAddress: walletAddress
                }, (bnbResponse) => {
                    const balanceData = {
                        balance: bnbResponse && bnbResponse.success ? bnbResponse.balance : 0,
                        clipxBalance: 0
                    };

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

        chrome.storage.local.set({ cachedBalance: data });

        renderBalance(data);

    } catch (e) {
        console.error('Failed to load balance', e);
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
        // `/api/transactions` is ClipX social tip history — needs a real session token (e.g. extension token from the dashboard).
        // Native-only traders use on-chain swaps; never send placeholders like `native-wallet` here (that causes 401 noise).
        if (!token || token === 'native-wallet') {
            return;
        }

        const response = await fetch(`${API_BASE}/api/transactions`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            if (response.status === 401) {
                console.warn('[ClipX] Tip history: session expired. Open ClipX while logged in so the extension can sync a fresh token.');
            }
            return;
        }

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
    const hasNative = !!(result.nativeWallet && result.nativeWallet.address);
    const isClipxWebSession = !!(result.authToken && result.authToken !== 'native-wallet');

    // Get the web wallet address, ensuring it's a valid 0x address
    const webAddr = result.userAddress || result.webUserAddress;
    const hasClipxWallet = isClipxWebSession && webAddr && webAddr.startsWith('0x');

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
        if (logoutBtn) {
            logoutBtn.style.display = isClipxWebSession ? 'none' : 'block';
        }
    } else {
        // No wallet bound; show the simpler Twitter/logout UI
        if (nativeWalletUi) nativeWalletUi.style.display = 'none';
        if (noNativeWalletUi) noNativeWalletUi.style.display = 'block';
        if (twitterLogoutBtn) twitterLogoutBtn.style.display = 'none';
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
    confirmLogoutBtn.addEventListener('click', async () => {
        confirmLogoutBtn.disabled = true;
        confirmLogoutBtn.textContent = 'Removing...';

        const stored = await chrome.storage.local.get(['authToken']);
        const keysToRemove = ['nativeWallet', 'walletPrivateKey', 'solWallet', 'cachedBalance', 'cachedTransactions'];
        if (stored.authToken === 'native-wallet') {
            keysToRemove.push('authToken', 'userAddress');
        }

        chrome.storage.local.remove(keysToRemove, () => {
            // Send lock message to background to clear memory
            chrome.runtime.sendMessage({ action: 'lockWallet' });
            chrome.runtime.sendMessage({ action: 'lockSolWallet' });
            window.close();
        });
    });
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', showLogoutModal);
}

if (twitterLogoutBtn) twitterLogoutBtn.style.display = 'none';

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
        if (stored.nativeWallet && stored.nativeWallet.address) {
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
            const allAssets = [
                { address: 'BNB', name: 'BNB', symbol: 'BNB', decimals: 18, isNative: true, balance: 0, chain: 'bnb' },
                { address: 'SOL', name: 'Solana', symbol: 'SOL', decimals: 9, isNative: true, balance: 0, chain: 'sol' }
            ];

            const finalizeWithBnb = async (extraAssets) => {
                // Fetch BNB and SOL balances in parallel
                const [bnbResp, solResp] = await Promise.all([
                    new Promise(resolve => chrome.runtime.sendMessage({ action: 'getBnbBalance', walletAddress }, resolve)),
                    new Promise(resolve => chrome.runtime.sendMessage({ action: 'getSolBalance' }, resolve))
                ]);

                if (bnbResp && bnbResp.success) allAssets[0].balance = bnbResp.balance;
                if (solResp && solResp.success) allAssets[1].balance = solResp.balance;

                // Also fetch SOL wallet assets
                const solAssetsResp = await new Promise(resolve => chrome.runtime.sendMessage({ action: 'getSolWalletAssets' }, resolve));
                const solTokens = (solAssetsResp && solAssetsResp.success && Array.isArray(solAssetsResp.assets))
                    ? solAssetsResp.assets.map(a => ({ ...a, chain: 'sol' }))
                    : [];

                const bnbTokens = (extraAssets || []).map(a => ({ ...a, chain: 'bnb' }));
                const assets = [...allAssets, ...bnbTokens, ...solTokens];
                const enrichedAssets = await enrichAssetsWithPrices(assets);
                renderAssets(enrichedAssets);
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

function clipxResolveAssetLogo(asset) {
    if (!asset) return '';
    if (asset.iconUrl) return asset.iconUrl;
    const chain = asset.chain === 'sol' ? 'sol' : 'bnb';
    if (asset.isNative) {
        if (chain === 'sol') {
            return 'https://dd.dexscreener.com/ds-data/tokens/solana/So11111111111111111111111111111111111111112.png';
        }
        return 'https://dd.dexscreener.com/ds-data/tokens/bsc/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c.png';
    }
    const addr = (asset.address || '').toLowerCase();
    if (!addr) return '';
    if (chain === 'sol') {
        return `https://dd.dexscreener.com/ds-data/tokens/solana/${asset.address}.png`;
    }
    return `https://dd.dexscreener.com/ds-data/tokens/bsc/${addr}.png`;
}

async function enrichAssetsWithPrices(assets) {
    const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';

    const tasks = assets.map(asset => {
        return new Promise(resolve => {
            const assetChain = asset.chain === 'sol' ? 'sol' : 'bnb';

            let lookupAddress;
            if (asset.isNative) {
                lookupAddress = assetChain === 'sol' ? WSOL_MINT : WBNB_ADDRESS;
            } else {
                lookupAddress = asset.address;
            }

            if (!lookupAddress || lookupAddress === 'BNB' || lookupAddress === 'SOL') {
                resolve(asset);
                return;
            }

            chrome.runtime.sendMessage({
                action: 'fetchTokenInfo',
                address: lookupAddress,
                chain: assetChain
            }, (response) => {
                if (!response || !response.success) {
                    resolve(asset);
                    return;
                }

                const priceUsd = response.priceUsd ? parseFloat(response.priceUsd) : null;
                const priceChange = typeof response.priceChange === 'number'
                    ? response.priceChange
                    : 0;
                const iconUrl = response.iconUrl || asset.iconUrl || null;

                resolve({
                    ...asset,
                    priceUsd,
                    priceChange,
                    iconUrl
                });
            });
        });
    });

    return Promise.all(tasks);
}

function formatPortfolioUnitPrice(price) {
    if (!Number.isFinite(price) || price <= 0) return '';
    if (price < 0.000001) return `$${price.toExponential(2)}`;
    if (price < 0.01) return `$${price.toFixed(8)}`;
    if (price < 1) return `$${price.toFixed(4)}`;
    if (price < 1000) return `$${price.toFixed(2)}`;
    return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function renderAssets(assets) {
    try {
        document.dispatchEvent(new CustomEvent('clipx:assets-rendered', { detail: { assets } }));
    } catch (e) { /* ignore */ }
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
        assetsList.style.display = 'flex';
        assetsList.style.flexDirection = 'column';
        assetsList.style.gap = '8px';
        assetsList.innerHTML = assets.map(asset => {
            const balanceNum = parseFloat(asset.balance || 0);
            const balance = Number.isFinite(balanceNum)
                ? balanceNum.toFixed(asset.isNative ? 4 : balanceNum < 1 ? 4 : 2)
                : '0';

            const price = typeof asset.priceUsd === 'number'
                ? asset.priceUsd
                : asset.priceUsd ? parseFloat(asset.priceUsd) : null;
            const unitPriceText = formatPortfolioUnitPrice(price);

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

            const chain = asset.chain === 'sol' ? 'sol' : 'bnb';
            const chainLabel = chain === 'sol' ? 'SOL' : 'BSC';
            const iconClass = asset.isNative ? chain : 'token';
            const iconText = asset.isNative
                ? (chain === 'sol' ? 'S' : 'B')
                : (asset.symbol || 'T').slice(0, 1).toUpperCase();
            const safeSymbol = asset.symbol || 'Token';
            const safeName = asset.name || (asset.isNative ? safeSymbol : 'Token asset');
            const logoUrl = clipxResolveAssetLogo(asset);
            const iconInner = logoUrl
                ? `<img class="wallet-asset-img" data-fallback="${iconText.replace(/"/g, '&quot;')}" src="${logoUrl}" alt="" loading="lazy" referrerpolicy="no-referrer">`
                : `<span class="wallet-asset-fallback">${iconText}</span>`;
            return `
                <div class="wallet-asset-row" data-chain="${chain}">
                    <div class="wallet-asset-left">
                        <div class="wallet-asset-icon ${iconClass}">${iconInner}</div>
                        <div style="min-width:0;">
                            <div class="wallet-asset-name">
                                <span class="wallet-asset-symbol">${safeSymbol}</span>
                                <span class="wallet-chain-badge ${chain}">${chainLabel}</span>
                            </div>
                            <div class="wallet-asset-meta">${safeName}</div>
                            ${unitPriceText ? `<div class="wallet-asset-price">Live ${unitPriceText}</div>` : ''}
                        </div>
                    </div>
                    <div class="wallet-asset-right">
                        <span class="wallet-asset-balance">${balance}</span>
                        <span class="wallet-asset-value">
                            ${valueText}
                            ${changeText ? `<span style=\"margin-left:4px; color:${changeColor};\">${changeText}</span>` : ''}
                        </span>
                    </div>
                </div>
            `;
        }).join('');

        // Programmatic onerror fallback (CSP-safe: no inline handlers).
        assetsList.querySelectorAll('img.wallet-asset-img').forEach((img) => {
            img.addEventListener('error', () => {
                const span = document.createElement('span');
                span.className = 'wallet-asset-fallback';
                span.textContent = img.getAttribute('data-fallback') || '?';
                if (img.parentNode) img.parentNode.replaceChild(span, img);
            }, { once: true });
        });
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
        const isEvmAddress = (ethers && ethers.isAddress && ethers.isAddress(to)) || (ethers && ethers.utils && ethers.utils.isAddress && ethers.utils.isAddress(to));
        const isSolAddress = to && to.length >= 32 && to.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(to);

        if (!isEvmAddress && !isSolAddress) {
            alert('Invalid Address. Please enter a valid BSC or Solana address.'); return;
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

// ─── Solana Wallet UI Handlers ───────────────────────────

function initSolWalletUI() {
    const solActive = document.getElementById('sol-wallet-active');
    const solSetup = document.getElementById('sol-wallet-setup');
    const solAddrDisplay = document.getElementById('sol-wallet-address-display');
    const solBalDisplay = document.getElementById('sol-balance-display');

    function showSolWalletActive(address) {
        if (solActive) solActive.style.display = 'block';
        if (solSetup) solSetup.style.display = 'none';
        if (solAddrDisplay) solAddrDisplay.value = address;
        chrome.runtime.sendMessage({ action: 'getSolBalance' }, (resp) => {
            if (solBalDisplay) {
                solBalDisplay.textContent = resp && resp.success
                    ? parseFloat(resp.balance || 0).toFixed(4) + ' SOL'
                    : '—';
            }
        });
    }

    function showSolWalletSetup() {
        if (solActive) solActive.style.display = 'none';
        if (solSetup) solSetup.style.display = 'block';
    }

    chrome.storage.local.get(['solWallet'], (res) => {
        if (res.solWallet && res.solWallet.address) {
            showSolWalletActive(res.solWallet.address);
        } else {
            showSolWalletSetup();
        }
    });

    const copyBtn = document.getElementById('copy-sol-address-btn');
    if (copyBtn) {
        copyBtn.onclick = () => {
            if (solAddrDisplay && solAddrDisplay.value) {
                navigator.clipboard.writeText(solAddrDisplay.value);
                copyBtn.textContent = '✅';
                setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
            }
        };
    }

    const createBtn = document.getElementById('sol-create-wallet-btn');
    if (createBtn) {
        createBtn.onclick = () => {
            createBtn.disabled = true;
            createBtn.textContent = 'Creating...';
            chrome.runtime.sendMessage({ action: 'clipxGenerateSolWallet' }, (resp) => {
                createBtn.disabled = false;
                createBtn.textContent = 'Create SOL Wallet';
                if (resp && resp.success) {
                    showSolWalletActive(resp.address);
                    loadSolBalance();
                    alert('Solana wallet created!\n\nAddress: ' + resp.address + '\n\nIMPORTANT: Back up your private key from the extension storage.');
                } else {
                    alert('Failed: ' + (resp && resp.error || 'Unknown error'));
                }
            });
        };
    }

    const importBtn = document.getElementById('sol-import-wallet-btn');
    const importForm = document.getElementById('sol-import-form');
    if (importBtn && importForm) {
        importBtn.onclick = () => {
            importForm.style.display = importForm.style.display === 'none' ? 'block' : 'none';
        };
    }

    const importConfirm = document.getElementById('sol-import-confirm-btn');
    const importInput = document.getElementById('sol-import-key-input');
    if (importConfirm && importInput) {
        importConfirm.onclick = () => {
            const key = importInput.value.trim();
            if (!key) { alert('Please enter a private key'); return; }
            importConfirm.disabled = true;
            importConfirm.textContent = 'Importing...';
            chrome.runtime.sendMessage({ action: 'clipxImportSolWallet', privateKey: key }, (resp) => {
                importConfirm.disabled = false;
                importConfirm.textContent = 'Import';
                if (resp && resp.success) {
                    importInput.value = '';
                    if (importForm) importForm.style.display = 'none';
                    showSolWalletActive(resp.address);
                    loadSolBalance();
                } else {
                    alert('Import failed: ' + (resp && resp.error || 'Invalid key'));
                }
            });
        };
    }

    const solSendBtn = document.getElementById('sol-send-btn');
    if (solSendBtn) {
        solSendBtn.onclick = () => {
            const recipient = document.getElementById('sol-send-recipient');
            const amount = document.getElementById('sol-send-amount');
            const status = document.getElementById('sol-send-status');
            if (!recipient || !amount) return;
            if (!recipient.value.trim()) { if (status) status.textContent = 'Enter recipient address'; return; }
            if (!amount.value || parseFloat(amount.value) <= 0) { if (status) status.textContent = 'Enter a valid amount'; return; }
            solSendBtn.disabled = true;
            if (status) status.textContent = 'Sending...';
            chrome.runtime.sendMessage({
                action: 'solTransfer',
                recipient: recipient.value.trim(),
                amount: amount.value
            }, (resp) => {
                solSendBtn.disabled = false;
                if (resp && resp.success) {
                    if (status) status.innerHTML = `✅ Sent! <a href="https://solscan.io/tx/${resp.txHash}" target="_blank" style="color: #9945FF;">View</a>`;
                    amount.value = '';
                    loadSolBalance();
                } else {
                    if (status) status.textContent = '❌ ' + (resp && resp.error || 'Failed');
                }
            });
        };
    }
}

initNativeWalletPanel();
initSolWalletUI();
initProWallet();

// ─── Professional Wallet Hero ────────────────────────────────
function initProWallet() {
    const root = document.getElementById('native-wallet-panel');
    if (!root) return;

    const emptyState = document.getElementById('pro-empty-state');
    const activeState = document.getElementById('pro-active-state');
    const balanceAmountEl = document.getElementById('pro-balance-amount');
    const balanceNativeEl = document.getElementById('pro-balance-native');
    const balanceChangeEl = document.getElementById('pro-balance-change');
    const addressTextEl = document.getElementById('pro-address-text');
    const addressChip = document.getElementById('pro-address-chip');
    const chainBnb = document.getElementById('pro-chain-bnb');
    const chainSol = document.getElementById('pro-chain-sol');
    const sendBtn = document.getElementById('pro-send-btn');
    const receiveBtn = document.getElementById('pro-receive-btn');
    const moreBtn = document.getElementById('pro-more-btn');
    const moreActionBtn = document.getElementById('pro-more-action-btn');
    const showImportEmpty = document.getElementById('native-show-import-empty');

    let currentChain = localStorage.getItem('pro_wallet_chain') || 'bnb';
    let cachedBnb = null;
    let cachedSol = null;
    let cachedAssets = [];

    function setChain(chain) {
        currentChain = chain === 'sol' ? 'sol' : 'bnb';
        try { localStorage.setItem('pro_wallet_chain', currentChain); } catch (e) {}
        if (chainBnb) chainBnb.setAttribute('aria-pressed', currentChain === 'bnb' ? 'true' : 'false');
        if (chainSol) chainSol.setAttribute('aria-pressed', currentChain === 'sol' ? 'true' : 'false');
        root.dataset.chain = currentChain;
        renderHero();
    }

    function fmtUsd(n) {
        if (!Number.isFinite(n) || n <= 0) return '$0.00';
        if (n >= 1000) return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
        if (n >= 1) return '$' + n.toFixed(2);
        if (n >= 0.01) return '$' + n.toFixed(2);
        return '$' + n.toFixed(4);
    }

    function aggregateUsd(chain) {
        if (!Array.isArray(cachedAssets) || !cachedAssets.length) return null;
        let total = 0;
        let any = false;
        cachedAssets.forEach((a) => {
            const aChain = a.chain === 'sol' ? 'sol' : 'bnb';
            if (aChain !== chain) return;
            const bal = parseFloat(a.balance || 0);
            const px = typeof a.priceUsd === 'number' ? a.priceUsd : (a.priceUsd ? parseFloat(a.priceUsd) : 0);
            if (!Number.isFinite(bal) || !Number.isFinite(px)) return;
            if (bal > 0 && px > 0) {
                total += bal * px;
                any = true;
            }
        });
        return any ? total : null;
    }

    async function readState() {
        const stored = await chrome.storage.local.get(['nativeWallet', 'solWallet', 'cachedBalance']);
        return {
            bscAddress: stored.nativeWallet?.address || '',
            solAddress: stored.solWallet?.address || '',
            cachedBalance: stored.cachedBalance || null
        };
    }

    async function renderHero() {
        const state = await readState();
        const hasAny = !!(state.bscAddress || state.solAddress);

        if (emptyState) emptyState.style.display = hasAny ? 'none' : 'block';
        if (activeState) activeState.style.display = hasAny ? 'block' : 'none';

        const addr = currentChain === 'sol' ? state.solAddress : state.bscAddress;
        if (addressTextEl) addressTextEl.textContent = addr ? shortAddress(addr) : 'No wallet';
        if (addressChip) addressChip.dataset.address = addr || '';

        const nativeSym = currentChain === 'sol' ? 'SOL' : 'BNB';
        const nativeBal = currentChain === 'sol' ? cachedSol : cachedBnb;
        if (balanceNativeEl) {
            balanceNativeEl.textContent = nativeBal != null
                ? `${parseFloat(nativeBal).toFixed(4)} ${nativeSym}`
                : `— ${nativeSym}`;
        }

        const usd = aggregateUsd(currentChain);
        if (balanceAmountEl) balanceAmountEl.textContent = usd != null ? fmtUsd(usd) : '$0.00';

        if (balanceChangeEl) {
            const chainAssets = (cachedAssets || []).filter(a => (a.chain === 'sol' ? 'sol' : 'bnb') === currentChain);
            let weighted = 0; let weightTotal = 0;
            chainAssets.forEach(a => {
                const bal = parseFloat(a.balance || 0);
                const px = typeof a.priceUsd === 'number' ? a.priceUsd : 0;
                const ch = typeof a.priceChange === 'number' ? a.priceChange : null;
                if (bal > 0 && px > 0 && ch != null) {
                    const w = bal * px;
                    weighted += ch * w;
                    weightTotal += w;
                }
            });
            if (weightTotal > 0) {
                const avg = weighted / weightTotal;
                const sign = avg >= 0 ? '+' : '';
                balanceChangeEl.textContent = `${sign}${avg.toFixed(2)}% 24h`;
                balanceChangeEl.style.display = 'inline-flex';
                balanceChangeEl.classList.toggle('negative', avg < 0);
            } else {
                balanceChangeEl.style.display = 'none';
            }
        }
    }

    function refreshNativeBalances() {
        chrome.storage.local.get(['nativeWallet'], (res) => {
            const a = res.nativeWallet?.address;
            if (!a) { cachedBnb = null; renderHero(); return; }
            chrome.runtime.sendMessage({ action: 'getBnbBalance', walletAddress: a }, (r) => {
                if (r && r.success) cachedBnb = parseFloat(r.balance || 0);
                renderHero();
            });
        });
        chrome.runtime.sendMessage({ action: 'getSolBalance' }, (r) => {
            if (r && r.success) cachedSol = parseFloat(r.balance || 0);
            renderHero();
        });
    }

    // Sheet helpers ---------------------------------------------------------
    function openSheet(id) {
        const s = document.getElementById(id);
        if (!s) return;
        s.classList.add('is-open');
        document.body.style.overflow = 'hidden';
    }
    function closeSheet(id) {
        const s = document.getElementById(id);
        if (!s) return;
        s.classList.remove('is-open');
        document.body.style.overflow = '';
    }
    function closeAllSheets() {
        document.querySelectorAll('.pro-sheet-backdrop.is-open').forEach((s) => s.classList.remove('is-open'));
        document.body.style.overflow = '';
    }

    document.querySelectorAll('.pro-sheet-backdrop').forEach((sheet) => {
        sheet.addEventListener('click', (e) => {
            if (e.target === sheet || e.target.matches('[data-pro-close]')) {
                sheet.classList.remove('is-open');
                document.body.style.overflow = '';
            }
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllSheets();
    });

    // Chain switch ----------------------------------------------------------
    if (chainBnb) chainBnb.addEventListener('click', () => setChain('bnb'));
    if (chainSol) chainSol.addEventListener('click', () => setChain('sol'));

    // Address chip → copy
    if (addressChip) {
        addressChip.addEventListener('click', () => {
            const a = addressChip.dataset.address;
            if (!a) return;
            navigator.clipboard.writeText(a).then(() => {
                const original = addressTextEl ? addressTextEl.textContent : '';
                if (addressTextEl) addressTextEl.textContent = 'Copied ✓';
                setTimeout(() => { if (addressTextEl) addressTextEl.textContent = original; }, 1100);
            });
        });
    }

    // Hero actions ----------------------------------------------------------
    if (sendBtn) sendBtn.addEventListener('click', () => openSendSheet());
    if (receiveBtn) receiveBtn.addEventListener('click', () => openReceiveSheet());
    if (moreBtn) moreBtn.addEventListener('click', () => openSheet('pro-more-sheet'));
    if (moreActionBtn) moreActionBtn.addEventListener('click', () => openSheet('pro-more-sheet'));

    if (showImportEmpty) {
        showImportEmpty.addEventListener('click', () => openSheet('pro-import-sheet'));
    }

    // More menu rows --------------------------------------------------------
    const menuRefresh = document.getElementById('pro-menu-refresh');
    const menuCreateSol = document.getElementById('pro-menu-create-sol');
    const menuImport = document.getElementById('pro-menu-import');
    const menuExport = document.getElementById('pro-menu-export');
    const menuRemove = document.getElementById('pro-menu-remove');
    const menuSolSub = document.getElementById('pro-menu-sol-sub');

    if (menuRefresh) {
        menuRefresh.addEventListener('click', async () => {
            await refreshNativeWalletPanel();
            refreshNativeBalances();
            if (typeof loadWalletAssets === 'function') loadWalletAssets();
            closeSheet('pro-more-sheet');
        });
    }
    if (menuCreateSol) {
        menuCreateSol.addEventListener('click', () => {
            closeSheet('pro-more-sheet');
            openSheet('pro-sol-sheet');
        });
    }
    if (menuImport) {
        menuImport.addEventListener('click', () => {
            closeSheet('pro-more-sheet');
            openSheet('pro-import-sheet');
        });
    }
    if (menuExport) {
        menuExport.addEventListener('click', () => {
            closeSheet('pro-more-sheet');
            openSheet('pro-export-sheet');
        });
    }
    if (menuRemove) {
        menuRemove.addEventListener('click', () => {
            closeSheet('pro-more-sheet');
            const m = document.getElementById('logoutModal');
            if (m) m.style.display = 'flex';
        });
    }

    // Update Solana row subtitle dynamically
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.solWallet || changes.nativeWallet) {
            renderHero();
            refreshNativeBalances();
        }
    });

    // ── Send Sheet ─────────────────────────────────────────────
    function openSendSheet() {
        const bnbForm = document.getElementById('pro-send-bnb');
        const solForm = document.getElementById('pro-send-sol');
        const fromEl = document.getElementById('pro-send-from');
        readState().then((state) => {
            if (currentChain === 'sol') {
                if (bnbForm) bnbForm.style.display = 'none';
                if (solForm) solForm.style.display = 'block';
                if (fromEl) fromEl.textContent = state.solAddress ? shortAddress(state.solAddress) + ' · SOL' : 'No SOL wallet';
            } else {
                if (bnbForm) bnbForm.style.display = 'block';
                if (solForm) solForm.style.display = 'none';
                if (fromEl) fromEl.textContent = state.bscAddress ? shortAddress(state.bscAddress) + ' · BSC' : 'No BSC wallet';
            }
            openSheet('pro-send-sheet');
        });
    }

    // ── Receive Sheet ──────────────────────────────────────────
    const recvBnbBtn = document.getElementById('pro-recv-bnb');
    const recvSolBtn = document.getElementById('pro-recv-sol');
    const recvAddrEl = document.getElementById('pro-recv-address');
    const recvNetworkLabel = document.getElementById('pro-recv-network-label');
    const recvCopyBtn = document.getElementById('pro-recv-copy');
    const recvShareBtn = document.getElementById('pro-recv-share');
    const recvQrEl = document.getElementById('pro-recv-qr');

    let receiveChain = currentChain;

    function paintReceive() {
        readState().then((state) => {
            if (recvBnbBtn) recvBnbBtn.setAttribute('aria-pressed', receiveChain === 'bnb' ? 'true' : 'false');
            if (recvSolBtn) recvSolBtn.setAttribute('aria-pressed', receiveChain === 'sol' ? 'true' : 'false');
            const addr = receiveChain === 'sol' ? state.solAddress : state.bscAddress;
            if (recvAddrEl) recvAddrEl.textContent = addr || 'No address available — create or import this wallet first.';
            if (recvNetworkLabel) recvNetworkLabel.textContent = receiveChain === 'sol' ? 'Solana' : 'BSC';
            if (recvQrEl) {
                recvQrEl.innerHTML = '';
                if (addr && window.ClipxQR) {
                    try {
                        recvQrEl.innerHTML = window.ClipxQR.toSvg(addr, { scale: 4, margin: 2, dark: '#0a0a0c', light: '#fff' });
                    } catch (e) {
                        recvQrEl.textContent = 'QR error';
                    }
                } else if (!addr) {
                    recvQrEl.textContent = '—';
                }
            }
        });
    }

    function openReceiveSheet() {
        receiveChain = currentChain;
        paintReceive();
        openSheet('pro-receive-sheet');
    }
    if (recvBnbBtn) recvBnbBtn.addEventListener('click', () => { receiveChain = 'bnb'; paintReceive(); });
    if (recvSolBtn) recvSolBtn.addEventListener('click', () => { receiveChain = 'sol'; paintReceive(); });
    if (recvCopyBtn) recvCopyBtn.addEventListener('click', () => {
        readState().then((state) => {
            const addr = receiveChain === 'sol' ? state.solAddress : state.bscAddress;
            if (!addr) return;
            navigator.clipboard.writeText(addr).then(() => {
                const orig = recvCopyBtn.textContent;
                recvCopyBtn.textContent = 'Copied ✓';
                setTimeout(() => { recvCopyBtn.textContent = orig; }, 1100);
            });
        });
    });
    if (recvShareBtn) recvShareBtn.addEventListener('click', () => {
        readState().then((state) => {
            const addr = receiveChain === 'sol' ? state.solAddress : state.bscAddress;
            if (!addr) return;
            const url = receiveChain === 'sol'
                ? `https://solscan.io/account/${addr}`
                : `https://bscscan.com/address/${addr}`;
            if (navigator.share) {
                navigator.share({ title: 'My ClipX wallet', text: addr, url }).catch(() => {});
            } else {
                window.open(url, '_blank');
            }
        });
    });

    // Listen for asset renders to recompute hero balance / 24h change
    document.addEventListener('clipx:assets-rendered', (e) => {
        const list = e?.detail?.assets;
        cachedAssets = Array.isArray(list) ? list : [];
        renderHero();
    });

    // First paint
    setChain(currentChain);
    refreshNativeBalances();
    renderHero();
    readState().then((state) => {
        if ((state.bscAddress || state.solAddress) && typeof loadWalletAssets === 'function') {
            loadWalletAssets();
        }
    });
}

// Hide loading overlay after initialization
setTimeout(() => {
    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'flex';
}, 100);


