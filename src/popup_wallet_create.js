// Wallet Creation Logic for Popup
// This file handles the "Create Wallet" tab functionality
// SIMPLIFIED: No password/encryption required

const generateWalletBtn = document.getElementById('generateWalletBtn');
const mnemonicDisplay = document.getElementById('mnemonicDisplay');
const copyMnemonicBtn = document.getElementById('copyMnemonicBtn');
const savedCheckbox = document.getElementById('savedCheckbox');
const confirmCreateBtn = document.getElementById('confirmCreateBtn');
const createError = document.getElementById('createError');
const createStep1 = document.getElementById('create-step-1');
const createStep2 = document.getElementById('create-step-2');

let newWallet = null;

if (generateWalletBtn) {
    generateWalletBtn.addEventListener('click', () => {
        try {
            // Generate random wallet using ethers
            newWallet = ethers.Wallet.createRandom();
            mnemonicDisplay.textContent = newWallet.mnemonic.phrase;

            createStep1.style.display = 'none';
            createStep2.style.display = 'block';
        } catch (e) {
            console.error('Wallet generation failed:', e);
            alert('Failed to generate wallet. Please try again.');
        }
    });
}

if (copyMnemonicBtn) {
    copyMnemonicBtn.addEventListener('click', () => {
        if (newWallet) {
            navigator.clipboard.writeText(newWallet.mnemonic.phrase);
            copyMnemonicBtn.textContent = 'Copied!';
            setTimeout(() => copyMnemonicBtn.textContent = 'Copy Phrase', 2000);
        }
    });
}

const validateCreateForm = () => {
    const isSaved = savedCheckbox?.checked || false;

    if (confirmCreateBtn) {
        if (isSaved) {
            confirmCreateBtn.disabled = false;
            confirmCreateBtn.style.opacity = '1';
        } else {
            confirmCreateBtn.disabled = true;
            confirmCreateBtn.style.opacity = '0.5';
        }
    }
};

if (savedCheckbox) savedCheckbox.onchange = validateCreateForm;

if (confirmCreateBtn) {
    confirmCreateBtn.addEventListener('click', async () => {
        if (!newWallet || !savedCheckbox?.checked) return;

        try {
            confirmCreateBtn.disabled = true;
            confirmCreateBtn.textContent = 'Saving...';
            if (createError) createError.style.display = 'none';

            // Save wallet WITHOUT encryption (always unlocked)
            await chrome.storage.local.set({
                authToken: 'native-wallet',
                nativeWallet: {
                    address: newWallet.address,
                    privateKey: newWallet.privateKey,  // Store directly, no encryption
                    mnemonic: newWallet.mnemonic.phrase
                },
                userAddress: newWallet.address
            });

            // Unlock immediately for this session
            await chrome.runtime.sendMessage({
                action: 'unlockWallet',
                privateKey: newWallet.privateKey
            });

            // Success - reload popup
            alert('✅ Wallet created successfully!\n\nAddress: ' + newWallet.address);
            window.location.reload();

        } catch (error) {
            console.error('Wallet creation failed:', error);
            if (createError) {
                createError.textContent = 'Failed to create wallet: ' + error.message;
                createError.style.display = 'block';
            }
            confirmCreateBtn.disabled = false;
            confirmCreateBtn.textContent = 'Save Wallet';
        }
    });
}
