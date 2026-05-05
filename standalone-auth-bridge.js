// Standalone Auth Bridge Script
// This can be injected manually via browser console for testing

(function () {
    console.log('[Standalone Auth Bridge] Starting...');

    // Wait for Privy to be ready
    const waitForPrivy = setInterval(() => {
        // Try to find Privy's instance in window
        if (window.__PRIVY__ || window.privy) {
            console.log('[Standalone Auth Bridge] Privy found');
            clearInterval(waitForPrivy);
            setupAuthBridge();
        }
    }, 1000);

    function setupAuthBridge() {
        // Try to get the token from Privy's internal storage
        const syncToken = () => {
            try {
                // Method 1: Check localStorage for Privy tokens
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.includes('privy')) {
                        const value = localStorage.getItem(key);
                        console.log('[Standalone Auth Bridge] Found Privy key:', key);

                        try {
                            const parsed = JSON.parse(value);
                            if (parsed && parsed.token) {
                                console.log('[Standalone Auth Bridge] Found token in:', key);
                                window.postMessage({
                                    type: 'CLIPX_AUTH_TOKEN',
                                    token: parsed.token
                                }, '*');
                                return;
                            }
                        } catch (e) {
                            // Not JSON
                        }
                    }
                }

                console.log('[Standalone Auth Bridge] No token found yet');
            } catch (e) {
                console.error('[Standalone Auth Bridge] Error:', e);
            }
        };

        // Sync immediately
        syncToken();

        // And every 5 seconds
        setInterval(syncToken, 5000);

        console.log('[Standalone Auth Bridge] Setup complete');
    }
})();
