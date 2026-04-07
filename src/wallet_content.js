// Inject the actual provider script into the page context
const injectScript = () => {
    try {
        const container = document.head || document.documentElement;
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('src/wallet_inject.js');
        script.onload = () => script.remove();
        container.insertBefore(script, container.children[0]);
        console.log('[ClipX] Injecting wallet provider...');
    } catch (e) {
        console.error('[ClipX] Injection failed:', e);
    }
};

injectScript();

// Proxy messages: Page <-> Content Script <-> Background
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.target !== 'CLIPX_CONTENT') return;

    const { type, method, params, reqId } = event.data;

    if (type === 'CLIPX_REQUEST') {
        // Forward to background
        chrome.runtime.sendMessage({
            action: 'walletRequest',
            method,
            params
        }, (response) => {
            // Send response back to page
            window.postMessage({
                target: 'CLIPX_PROVIDER',
                type: 'CLIPX_RESPONSE',
                reqId,
                result: response ? response.result : null,
                error: response ? response.error : 'No response'
            }, '*');
        });
    }
});
