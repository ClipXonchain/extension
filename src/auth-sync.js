// ClipX Auth Sync Script
// Runs on clipx.app (and www) to sync the auth token to the extension

console.log('[ClipX Auth Sync] Script loaded on:', window.location.origin);

// Try to find Privy tokens in localStorage
function findPrivyToken() {
    try {
        // First check our custom token storage
        const extensionToken = localStorage.getItem('clipx_extension_token');
        if (extensionToken) {
            console.log('[ClipX Auth Sync] Found extension token');
            return extensionToken;
        }

        // Privy stores tokens with keys like "privy:token:{appId}"
        // We'll search for any keys that contain auth information
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (key.includes('privy') || key.includes('token') || key.includes('auth'))) {
                const value = localStorage.getItem(key);
                console.log('[ClipX Auth Sync] Found potential auth key:', key);
                // Try to parse and check if it looks like a token
                try {
                    const parsed = JSON.parse(value);
                    if (parsed && (parsed.token || parsed.access_token || parsed.accessToken)) {
                        return parsed.token || parsed.access_token || parsed.accessToken;
                    }
                } catch (e) {
                    // Not JSON, might be a plain token
                    if (typeof value === 'string' && value.length > 20) {
                        return value;
                    }
                }
            }
        }

        // Also check common token locations
        const authToken = localStorage.getItem('authToken');
        const accessToken = localStorage.getItem('accessToken');

        return authToken || accessToken;
    } catch (e) {
        console.error('[ClipX Auth Sync] Error finding token:', e);
        return null;
    }
}

function syncAuth() {
    try {
        const authToken = findPrivyToken();

        if (authToken) {
            console.log('[ClipX Auth Sync] Found token, syncing to extension...');
            chrome.runtime.sendMessage({
                action: 'syncAuth',
                authToken: authToken,
                userAddress: localStorage.getItem('userAddress'),
                origin: window.location.origin
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.log('[ClipX Auth Sync] Extension not ready:', chrome.runtime.lastError.message);
                } else {
                    console.log('[ClipX Auth Sync] Sync response:', response);
                }
            });
        } else {
            console.log('[ClipX Auth Sync] No token found in storage');
        }
    } catch (e) {
        console.error('[ClipX Auth Sync] Error syncing:', e);
    }
}

// Sync on load
setTimeout(syncAuth, 1000); // Give the page time to load

// Sync on storage change (login/logout)
window.addEventListener('storage', (e) => {
    console.log('[ClipX Auth Sync] Storage changed:', e.key);
    syncAuth();
});

// Also sync periodically to catch any updates
setInterval(syncAuth, 10000); // Every 10 seconds

// Listen for messages from the page (we'll inject a script to send the token)
window.addEventListener('message', (event) => {
    if (event.source === window && event.data.type === 'CLIPX_AUTH_TOKEN') {
        console.log('[ClipX Auth Sync] Received token from page');
        chrome.runtime.sendMessage({
            action: 'syncAuth',
            authToken: event.data.token,
            userAddress: event.data.userAddress,
            origin: window.location.origin
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.log('[ClipX Auth Sync] Extension not ready:', chrome.runtime.lastError.message);
            } else {
                console.log('[ClipX Auth Sync] Sync response:', response);
            }
        });
    }
});
