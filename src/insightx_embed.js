const params = new URLSearchParams(window.location.search);
const address = params.get('address');
const chain = params.get('chain') || 'bsc';

// Map chain names to InsightX chain IDs
const chainIdMap = {
    'bsc': '56',
    'eth': '1',
    'ethereum': '1',
    'solana': 'solana',
    'base': '8453'
};

const chainId = chainIdMap[chain.toLowerCase()] || '56';

const link = document.getElementById('ext-link');
const targetUrl = `https://app.insightx.network/bubblemaps/${chainId}/${address}`;
link.href = targetUrl;

console.log('[InsightX Embed] Address:', address, 'Chain:', chain, 'Chain ID:', chainId);

if (address) {
    const iframe = document.createElement('iframe');
    const url = `https://app.insightx.network/bubblemaps/${chainId}/${address}`;
    console.log('[InsightX Embed] Loading URL:', url);

    iframe.src = url;
    iframe.allow = "clipboard-write; fullscreen";
    iframe.sandbox = "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";

    // Shorter timeout - 5 seconds
    const timeout = setTimeout(() => {
        console.log('[InsightX Embed] Timeout - showing fallback');
        const loader = document.querySelector('.loading');
        if (loader && loader.style.display !== 'none') {
            loader.textContent = 'Taking longer than expected...';
        }
    }, 5000);

    iframe.onload = () => {
        console.log('[InsightX Embed] Iframe loaded successfully');
        clearTimeout(timeout);
        const loader = document.querySelector('.loading');
        if (loader) loader.style.display = 'none';
    };

    iframe.onerror = () => {
        console.log('[InsightX Embed] Iframe error');
        clearTimeout(timeout);
        const loader = document.querySelector('.loading');
        if (loader) loader.textContent = 'Failed to load content';
    };

    document.body.appendChild(iframe);
} else {
    console.error('[InsightX Embed] No address provided');
    document.querySelector('.loading').textContent = 'No address provided';
}
