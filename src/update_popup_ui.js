// This script updates popup.js to use the new modal UI
const fs = require('fs');
const path = 'd:/extension all version/v1.13.0/ClipX Extension/src/popup.js';

if (!fs.existsSync(path)) {
    console.error("File not found:", path);
    process.exit(1);
}

let content = fs.readFileSync(path, 'utf8');

// The block to replace:
// withdrawMiningBtn.addEventListener('click', async () => { ... });
// We use a regex to match it robustly.

const regex = /withdrawMiningBtn\.addEventListener\('click', async \(\) => \{[\s\S]*?\}\);/;

const newLogic = `    // Withdraw Modal Logic
    const withdrawModal = document.getElementById('withdrawModal');
    const closeWithdrawModal = document.getElementById('closeWithdrawModal');
    const confirmWithdrawBtn = document.getElementById('confirmWithdrawBtn');
    const withdrawAmountInput = document.getElementById('withdraw-amount-input');
    const withdrawStatus = document.getElementById('withdraw-status');
    const withdrawBalanceDisplay = document.getElementById('withdraw-balance-display');

    withdrawMiningBtn.addEventListener('click', () => {
        const text = withdrawMiningBtn.textContent; 
        const amountStr = text.replace(/[^0-9.]/g, '');
        const amount = parseFloat(amountStr) || 0;

        if (withdrawModal) {
            withdrawModal.style.display = 'flex';
            if (withdrawBalanceDisplay) withdrawBalanceDisplay.textContent = \`Available: \${amount.toLocaleString()} CLIPX\`;
            if (withdrawAmountInput) withdrawAmountInput.value = Math.floor(amount); 
            if (withdrawStatus) {
                withdrawStatus.style.display = 'none';
                withdrawStatus.textContent = '';
            }
            if (confirmWithdrawBtn) {
                confirmWithdrawBtn.disabled = false;
                confirmWithdrawBtn.textContent = 'Confirm Withdraw';
            }
        }
    });

    if (closeWithdrawModal) {
        closeWithdrawModal.addEventListener('click', () => {
            if (withdrawModal) withdrawModal.style.display = 'none';
        });
    }

    if (confirmWithdrawBtn) {
        confirmWithdrawBtn.addEventListener('click', async () => {
            const amount = parseFloat(withdrawAmountInput.value);

            if (!amount || amount < 1000) {
                showStatus('Min withdrawal is 1,000 CLIPX', 'error');
                return;
            }

            confirmWithdrawBtn.disabled = true;
            confirmWithdrawBtn.textContent = 'Processing...';
            showStatus('Processing... will arrive in seconds ⚡', 'info');

            try {
                const storage = await chrome.storage.local.get(['authToken']);
                if (!storage.authToken) {
                    showStatus('Session expired. Please re-login.', 'error');
                    return;
                }

                const response = await fetch(\`\${API_BASE}/api/mine/withdraw\`, {
                    method: 'POST',
                    headers: {
                        'Authorization': \`Bearer \${storage.authToken}\`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ amount })
                });

                // Check for HTML response (error)
                const contentType = response.headers.get("content-type");
                if (contentType && contentType.indexOf("application/json") === -1) {
                    const text = await response.text();
                    console.error("API Error (HTML):", text);
                    throw new Error("Server returned HTML error. Check server logs.");
                }

                const data = await response.json();

                if (data.success) {
                    showStatus('Withdrawal Successful! 🚀', 'success');
                    confirmWithdrawBtn.textContent = 'Sent!';
                    await loadMiningBalance();
                    setTimeout(() => {
                        if (withdrawModal) withdrawModal.style.display = 'none';
                        confirmWithdrawBtn.disabled = false;
                        confirmWithdrawBtn.textContent = 'Confirm Withdraw';
                    }, 2000);
                } else {
                    showStatus(data.error || 'Withdrawal failed', 'error');
                    confirmWithdrawBtn.disabled = false;
                    confirmWithdrawBtn.textContent = 'Try Again';
                }
            } catch (error) {
                console.error('Withdraw error:', error);
                showStatus('Network error: ' + error.message, 'error');
                confirmWithdrawBtn.disabled = false;
                confirmWithdrawBtn.textContent = 'Try Again';
            }
        });
    }

    function showStatus(msg, type) {
        if (!withdrawStatus) return;
        withdrawStatus.textContent = msg;
        withdrawStatus.style.display = 'block';
        withdrawStatus.style.color = '#fff';
        if (type === 'error') {
            withdrawStatus.style.background = 'rgba(239, 68, 68, 0.2)';
            withdrawStatus.style.border = '1px solid rgba(239, 68, 68, 0.5)';
        } else if (type === 'success') {
            withdrawStatus.style.background = 'rgba(16, 185, 129, 0.2)';
            withdrawStatus.style.border = '1px solid rgba(16, 185, 129, 0.5)';
        } else {
            withdrawStatus.style.background = 'rgba(255, 255, 255, 0.05)';
            withdrawStatus.style.border = 'none';
        }
    }`;

if (content.match(regex)) {
    content = content.replace(regex, newLogic);
    fs.writeFileSync(path, content);
    console.log("SUCCESS: popup.js updated!");
} else {
    console.error("ERROR: Could not find code block to replace!");
}
