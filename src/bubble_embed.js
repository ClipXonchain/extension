const params = new URLSearchParams(window.location.search);
const address = params.get('address');
const chain = params.get('chain') || 'bsc';

const link = document.getElementById('ext-link');
const targetUrl = `https://app.bubblemaps.io/${chain}/token/${address}`;
link.href = targetUrl;

console.log('[Bubblemaps Embed] Initializing for:', address);

if (address) {
    const iframe = document.createElement('iframe');
    // Using iframe.bubblemaps.io which is the dedicated embed domain
    const url = `https://iframe.bubblemaps.io/map?address=${address}&chain=${chain}&partnerId=demo`; 
    
    console.log('[Bubblemaps Embed] Loading URL:', url);

    iframe.src = url;
    iframe.allow = "clipboard-write; fullscreen";
    iframe.sandbox = "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";
    
    // Set a timeout to detect if it hangs
    const loadTimeout = setTimeout(() => {
        const loader = document.querySelector('.loading');
        if (loader && loader.style.display !== 'none') {
            loader.textContent = 'Taking longer than expected...';
        }
    }, 5000);

    iframe.onload = () => {
        console.log('[Bubblemaps Embed] Iframe loaded');
        clearTimeout(loadTimeout);
        const loader = document.querySelector('.loading');
        if (loader) loader.style.display = 'none';
    };
    
    iframe.onerror = (e) => {
        console.error('[Bubblemaps Embed] Iframe error:', e);
        clearTimeout(loadTimeout);
        const loader = document.querySelector('.loading');
        if (loader) loader.textContent = 'Failed to load content';
    };

    document.body.appendChild(iframe);
} else {
    document.querySelector('.loading').textContent = 'No address provided';
}
