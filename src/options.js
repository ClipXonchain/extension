// ClipX Wallet Management - Options Page

let balanceUpdateInterval = null;

// Initialize page
document.addEventListener('DOMContentLoaded', async () => {
    await checkWalletStatus();
});

async function checkWalletStatus() {
    const storage = await chrome.storage.local.get(['authToken', 'nativeWallet']);

    if (storage.authToken === 'native-wallet' && storage.nativeWallet) {
        // Show wallet content
        document.getElementById('not-logged-in').style.display = 'none';
        document.getElementById('import-wallet-modal').style.display = 'none';
        document.getElementById('wallet-content').style.display = 'block';

        // Load wallet info
        loadWalletInfo(storage.nativeWallet);

        // Start live balance updates
        await loadBalances();
        startBalanceUpdates();

        // Setup event listeners
        setupEventListeners();
    } else {
        // Show not logged in state
        document.getElementById('not-logged-in').style.display = 'block';
        document.getElementById('wallet-content').style.display = 'none';
        document.getElementById('import-wallet-modal').style.display = 'none';

        // Setup import wallet listeners
        // setupImportWalletListeners();
    }
}

function setupImportWalletListeners() {
    // Show import modal
    const showImportBtn = document.getElementById('show-import-wallet');
    if (showImportBtn) {
        showImportBtn.addEventListener('click', () => {
            document.getElementById('not-logged-in').style.display = 'none';
            document.getElementById('import-wallet-modal').style.display = 'block';
        });
    }

    // Cancel import
    const cancelImportBtn = document.getElementById('cancel-import');
    if (cancelImportBtn) {
        cancelImportBtn.addEventListener('click', () => {
            document.getElementById('import-wallet-modal').style.display = 'none';
            document.getElementById('not-logged-in').style.display = 'block';
        });
    }

    // Tab switching
    const importTabs = document.querySelectorAll('[data-import-tab]');
    importTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-import-tab');

            // Update tab styles
            importTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Show/hide content
            document.querySelectorAll('.import-tab-content').forEach(content => {
                content.classList.remove('active');
                content.style.display = 'none';
            });

            const targetContent = document.getElementById(`import-${tabName}-tab`);
            if (targetContent) {
                targetContent.classList.add('active');
                targetContent.style.display = 'block';
            }
        });
    });

    // Import by phrase
    const importPhraseBtn = document.getElementById('import-phrase-btn');
    if (importPhraseBtn) {
        importPhraseBtn.addEventListener('click', async () => {
            const phrase = document.getElementById('import-phrase-input').value.trim();
            const password = document.getElementById('import-phrase-password').value;
            const confirmPassword = document.getElementById('import-phrase-password-confirm').value;
            const errorDiv = document.getElementById('import-phrase-error');

            // Validate
            if (!phrase) {
                errorDiv.textContent = 'Please enter your secret phrase';
                errorDiv.style.display = 'block';
                return;
            }

            if (password.length < 6) {
                errorDiv.textContent = 'Password must be at least 6 characters';
                errorDiv.style.display = 'block';
                return;
            }

            if (password !== confirmPassword) {
                errorDiv.textContent = 'Passwords do not match';
                errorDiv.style.display = 'block';
                return;
            }

            try {
                importPhraseBtn.disabled = true;
                importPhraseBtn.textContent = 'Importing...';
                errorDiv.style.display = 'none';

                // Create wallet from mnemonic
                const wallet = ethers.Wallet.fromPhrase(phrase);

                // Encrypt wallet
                const encryptedJson = await wallet.encrypt(password);

                // Save to storage (include privateKey for auto-unlock AND encrypted for security features)
                await chrome.storage.local.set({
                    authToken: 'native-wallet',
                    nativeWallet: {
                        address: wallet.address,
                        privateKey: wallet.privateKey,  // For auto-unlock
                        encrypted: encryptedJson        // For secure private key display
                    },
                    userAddress: wallet.address
                });

                // Unlock immediately for this session
                await chrome.runtime.sendMessage({
                    action: 'unlockWallet',
                    privateKey: wallet.privateKey
                });

                // Reload page
                window.location.reload();

            } catch (error) {
                console.error('Import failed:', error);
                errorDiv.textContent = 'Import failed: ' + error.message;
                errorDiv.style.display = 'block';
                importPhraseBtn.disabled = false;
                importPhraseBtn.textContent = 'Import Wallet';
            }
        });
    }

    // Import by private key
    const importKeyBtn = document.getElementById('import-key-btn');
    if (importKeyBtn) {
        importKeyBtn.addEventListener('click', async () => {
            const privateKey = document.getElementById('import-key-input').value.trim();
            const password = document.getElementById('import-key-password').value;
            const confirmPassword = document.getElementById('import-key-password-confirm').value;
            const errorDiv = document.getElementById('import-key-error');

            // Validate
            if (!privateKey) {
                errorDiv.textContent = 'Please enter your private key';
                errorDiv.style.display = 'block';
                return;
            }

            if (password.length < 6) {
                errorDiv.textContent = 'Password must be at least 6 characters';
                errorDiv.style.display = 'block';
                return;
            }

            if (password !== confirmPassword) {
                errorDiv.textContent = 'Passwords do not match';
                errorDiv.style.display = 'block';
                return;
            }

            try {
                importKeyBtn.disabled = true;
                importKeyBtn.textContent = 'Importing...';
                errorDiv.style.display = 'none';

                // Create wallet from private key
                const wallet = new ethers.Wallet(privateKey);

                // Encrypt wallet
                const encryptedJson = await wallet.encrypt(password);

                // Save to storage (include privateKey for auto-unlock AND encrypted for security features)
                await chrome.storage.local.set({
                    authToken: 'native-wallet',
                    nativeWallet: {
                        address: wallet.address,
                        privateKey: wallet.privateKey,  // For auto-unlock
                        encrypted: encryptedJson        // For secure private key display
                    },
                    userAddress: wallet.address
                });

                // Unlock immediately for this session
                await chrome.runtime.sendMessage({
                    action: 'unlockWallet',
                    privateKey: wallet.privateKey
                });

                // Reload page
                window.location.reload();

            } catch (error) {
                console.error('Import failed:', error);
                errorDiv.textContent = 'Import failed: Invalid private key';
                errorDiv.style.display = 'block';
                importKeyBtn.disabled = false;
                importKeyBtn.textContent = 'Import Wallet';
            }
        });
    }
}

function loadWalletInfo(wallet) {
    const addressEl = document.getElementById('wallet-address');
    if (addressEl) {
        addressEl.textContent = wallet.address.slice(0, 6) + '...' + wallet.address.slice(-4);
        addressEl.setAttribute('data-full-address', wallet.address);
    }
}

async function loadBalances() {
    const storage = await chrome.storage.local.get(['nativeWallet']);
    if (!storage.nativeWallet) return;

    const address = storage.nativeWallet.address;

    // Show loading state
    document.getElementById('balance-bnb').innerHTML = '<span class="loading"></span>';
    document.getElementById('balance-usdt').innerHTML = '<span class="loading"></span>';
    document.getElementById('balance-clipx').innerHTML = '<span class="loading"></span>';

    try {
        // Fetch BNB balance
        const bnbResponse = await chrome.runtime.sendMessage({
            action: 'getBnbBalance',
            walletAddress: address
        });

        if (bnbResponse && bnbResponse.success) {
            const bnbBalance = parseFloat(bnbResponse.balance || 0);
            document.getElementById('balance-bnb').textContent = bnbBalance.toFixed(4);

            // Update USD value
            await updateUSDPrices(bnbBalance, 0);
        } else {
            document.getElementById('balance-bnb').textContent = 'Error';
        }

        // Fetch USDT balance
        const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
        const usdtResponse = await chrome.runtime.sendMessage({
            action: 'getTokenBalance',
            tokenAddress: USDT_ADDRESS,
            walletAddress: address
        });

        if (usdtResponse && usdtResponse.success) {
            const usdtBalance = parseFloat(usdtResponse.balance || 0);
            document.getElementById('balance-usdt').textContent = usdtBalance.toFixed(2);
            document.getElementById('balance-usdt-usd').textContent = usdtBalance.toFixed(2);
        } else {
            document.getElementById('balance-usdt').textContent = 'Error';
        }

        // Fetch CLIPX balance
        const CLIPX_ADDRESS = '0xc269d59a0d608ea0bd672f2f4616c372d8554444';
        const clipxResponse = await chrome.runtime.sendMessage({
            action: 'getTokenBalance',
            tokenAddress: CLIPX_ADDRESS,
            walletAddress: address
        });

        if (clipxResponse && clipxResponse.success) {
            const clipxBalance = parseFloat(clipxResponse.balance || 0);
            document.getElementById('balance-clipx').textContent = clipxBalance.toFixed(2);

            // Update CLIPX USD value via GMGN API
            await updateUSDPrices(0, clipxBalance);
        } else {
            document.getElementById('balance-clipx').textContent = 'Error';
        }

    } catch (error) {
        console.error('Failed to load balances:', error);
        showBalanceError();
    }
}

function showBalanceError() {
    document.getElementById('balance-bnb').textContent = 'Error';
    document.getElementById('balance-usdt').textContent = 'Error';
    document.getElementById('balance-clipx').textContent = 'Error';
}

async function updateUSDPrices(bnbBalance, clipxBalance) {
    try {
        console.log('[Options] Fetching prices from DexScreener...');

        // Fetch BNB price from DexScreener (WBNB)
        try {
            const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
            const bnbPriceResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WBNB_ADDRESS}`);
            const bnbPriceData = await bnbPriceResponse.json();

            console.log('[Options] BNB price data:', bnbPriceData);

            if (bnbPriceData && bnbPriceData.pairs && bnbPriceData.pairs.length > 0) {
                const bnbPrice = parseFloat(bnbPriceData.pairs[0].priceUsd);
                console.log('[Options] BNB price:', bnbPrice);
                const bnbUSD = (bnbBalance * bnbPrice).toFixed(2);
                document.getElementById('balance-bnb-usd').textContent = `$${bnbUSD}`;
            } else {
                console.warn('[Options] BNB price not found in response');
                const bnbUSD = (bnbBalance * 650).toFixed(2);
                document.getElementById('balance-bnb-usd').textContent = `$${bnbUSD}`;
            }
        } catch (error) {
            console.error('[Options] Failed to fetch BNB price:', error);
            const bnbUSD = (bnbBalance * 650).toFixed(2);
            document.getElementById('balance-bnb-usd').textContent = `$${bnbUSD}`;
        }

        // Fetch CLIPX price from DexScreener
        try {
            const CLIPX_ADDRESS = '0xc269d59a0d608ea0bd672f2f4616c372d8554444';
            const clipxPriceResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${CLIPX_ADDRESS}`);
            const clipxPriceData = await clipxPriceResponse.json();

            console.log('[Options] CLIPX price data:', clipxPriceData);

            if (clipxPriceData && clipxPriceData.pairs && clipxPriceData.pairs.length > 0) {
                const clipxPrice = parseFloat(clipxPriceData.pairs[0].priceUsd);
                console.log('[Options] CLIPX price:', clipxPrice);

                const clipxBalanceText = document.getElementById('balance-clipx').textContent;
                const currentClipxBalance = parseFloat(clipxBalanceText) || clipxBalance;

                const clipxUSD = (currentClipxBalance * clipxPrice).toFixed(2);
                document.getElementById('balance-clipx-usd').textContent = `$${clipxUSD}`;
            } else {
                console.warn('[Options] CLIPX price not found in DexScreener');
            }
        } catch (error) {
            console.error('[Options] Failed to fetch CLIPX price:', error);
        }
    } catch (error) {
        console.error('[Options] Failed to fetch USD prices:', error);
    }
}

function startBalanceUpdates() {
    // Update balances every 15 seconds
    balanceUpdateInterval = setInterval(async () => {
        await loadBalances();
    }, 15000);
}

function stopBalanceUpdates() {
    if (balanceUpdateInterval) {
        clearInterval(balanceUpdateInterval);
        balanceUpdateInterval = null;
    }
}

function setupEventListeners() {
    // Refresh balances button
    const refreshBtn = document.getElementById('refresh-balances');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            await loadBalances();
        });
    }

    // Copy address button
    const copyAddressBtn = document.getElementById('copy-address');
    if (copyAddressBtn) {
        copyAddressBtn.addEventListener('click', () => {
            const addressEl = document.getElementById('wallet-address');
            const fullAddress = addressEl.getAttribute('data-full-address');
            navigator.clipboard.writeText(fullAddress);
            copyAddressBtn.textContent = '✓';
            setTimeout(() => copyAddressBtn.textContent = '📋', 2000);
        });
    }

    // Show private key button
    const showKeyBtn = document.getElementById('show-private-key');
    const privateKeyDisplay = document.getElementById('private-key-display');
    const copyKeyBtn = document.getElementById('copy-private-key');
    const hideKeyBtn = document.getElementById('hide-private-key');
    const passwordModal = document.getElementById('password-modal');
    const modalPasswordInput = document.getElementById('modal-password-input');
    const modalPasswordError = document.getElementById('modal-password-error');
    const modalPasswordConfirm = document.getElementById('modal-password-confirm');
    const modalPasswordCancel = document.getElementById('modal-password-cancel');

    if (showKeyBtn) {
        showKeyBtn.addEventListener('click', () => {
            // Show custom password modal
            passwordModal.style.display = 'flex';
            modalPasswordInput.value = '';
            modalPasswordError.style.display = 'none';
            modalPasswordInput.focus();
        });
    }

    // Modal cancel button
    if (modalPasswordCancel) {
        modalPasswordCancel.addEventListener('click', () => {
            passwordModal.style.display = 'none';
            modalPasswordInput.value = '';
            modalPasswordError.style.display = 'none';
        });
    }

    // Modal confirm button
    if (modalPasswordConfirm) {
        modalPasswordConfirm.addEventListener('click', async () => {
            const password = modalPasswordInput.value;
            if (!password) {
                modalPasswordError.textContent = 'Please enter your password';
                modalPasswordError.style.display = 'block';
                return;
            }

            modalPasswordConfirm.disabled = true;
            modalPasswordConfirm.textContent = 'Decrypting...';
            modalPasswordError.style.display = 'none';

            try {
                const storage = await chrome.storage.local.get(['nativeWallet']);
                if (storage.nativeWallet && storage.nativeWallet.encrypted) {
                    const wallet = await ethers.Wallet.fromEncryptedJson(
                        storage.nativeWallet.encrypted,
                        password
                    );

                    // Hide modal
                    passwordModal.style.display = 'none';
                    modalPasswordInput.value = '';

                    // Show private key
                    privateKeyDisplay.textContent = wallet.privateKey;
                    privateKeyDisplay.style.display = 'block';
                    showKeyBtn.style.display = 'none';
                    copyKeyBtn.style.display = 'inline-flex';
                    hideKeyBtn.style.display = 'inline-flex';
                } else {
                    modalPasswordError.textContent = 'No encrypted wallet found';
                    modalPasswordError.style.display = 'block';
                }
            } catch (error) {
                console.error('Decryption failed:', error);
                modalPasswordError.textContent = 'Incorrect password';
                modalPasswordError.style.display = 'block';
            } finally {
                modalPasswordConfirm.disabled = false;
                modalPasswordConfirm.textContent = 'Confirm';
            }
        });

        // Allow Enter key to confirm
        modalPasswordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                modalPasswordConfirm.click();
            }
        });
    }

    // Copy private key button
    if (copyKeyBtn) {
        copyKeyBtn.addEventListener('click', () => {
            const privateKey = privateKeyDisplay.textContent;
            navigator.clipboard.writeText(privateKey);
            copyKeyBtn.textContent = '✓ Copied';
            setTimeout(() => copyKeyBtn.textContent = '📋 Copy Private Key', 2000);
        });
    }

    // Hide private key button
    if (hideKeyBtn) {
        hideKeyBtn.addEventListener('click', () => {
            privateKeyDisplay.style.display = 'none';
            privateKeyDisplay.textContent = '';
            showKeyBtn.style.display = 'inline-flex';
            copyKeyBtn.style.display = 'none';
            hideKeyBtn.style.display = 'none';
        });
    }

    // Logout button
    const logoutBtn = document.getElementById('logout-wallet');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to log out? Make sure you have saved your Secret Phrase. This action cannot be undone.')) {
                stopBalanceUpdates();
                await chrome.storage.local.remove(['authToken', 'nativeWallet', 'userAddress', 'cachedBalance', 'cachedTransactions']);
                await chrome.runtime.sendMessage({ action: 'lockWallet' });
                window.location.reload();
            }
        });
    }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopBalanceUpdates();
});
