const params = new URLSearchParams(window.location.search);
const address = params.get('address');
const chain = params.get('chain') || 'bsc';

const targetUrl = `https://web3.binance.com/en/token/${chain}/${address}`;

// Update external links
const extLink = document.getElementById('ext-link');
const fallbackBtn = document.getElementById('fallback-btn');
extLink.href = targetUrl;
fallbackBtn.href = targetUrl;

console.log('[Binance Embed] Loading:', targetUrl);

if (address) {
    const iframe = document.createElement('iframe');
    
    // Try to load with various sandbox permissions
    iframe.sandbox = 'allow-scripts allow-same-origin allow-popups allow-forms allow-top-navigation';
    iframe.allow = 'clipboard-write; fullscreen';
    iframe.src = targetUrl;
    
    let loaded = false;
    
    iframe.onload = () => {
        console.log('[Binance Embed] Iframe onload triggered');
        loaded = true;
        
        // Give it a moment to render, then check if it's actually showing content
        setTimeout(() => {
            const loader = document.querySelector('.loading');
            if (loader) loader.style.display = 'none';
        }, 1000);
    };
    
    iframe.onerror = () => {
        console.error('[Binance Embed] Iframe error');
        showFallback();
    };

    // Timeout fallback - if still loading after 8 seconds, show fallback
    setTimeout(() => {
        if (!loaded) {
            console.log('[Binance Embed] Timeout - showing fallback');
            showFallback();
        }
    }, 8000);

    document.body.appendChild(iframe);
} else {
    document.querySelector('.loading').textContent = 'No address provided';
}

function showFallback() {
    const loader = document.querySelector('.loading');
    const fallback = document.getElementById('fallback');
    if (loader) loader.style.display = 'none';
    if (fallback) fallback.style.display = 'block';
}

// Listen for any errors from the iframe content
window.addEventListener('message', (event) => {
    console.log('[Binance Embed] Message received:', event.data);
});
