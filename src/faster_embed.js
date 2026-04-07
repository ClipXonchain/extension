const params = new URLSearchParams(window.location.search);
const address = params.get('address');
const chain = params.get('chain') || 'bsc';

console.log('[Faster100x Embed] Address:', address, 'Chain:', chain);

if (address) {
    const iframe = document.createElement('iframe');
    const url = `https://faster100x.com/en?tokenAddress=${address}&tokenChain=${chain}`;
    console.log('[Faster100x Embed] Loading URL:', url);

    iframe.src = url;
    iframe.allow = "clipboard-write";
    iframe.sandbox = "allow-scripts allow-same-origin allow-popups allow-forms";

    // Shorter timeout - 5 seconds
    const timeout = setTimeout(() => {
        console.log('[Faster100x Embed] Timeout - showing fallback');
        document.querySelector('.loading').style.display = 'none';
        document.querySelector('.error').style.display = 'block';
        document.getElementById('fallback-link').href = url;
    }, 5000);

    iframe.onload = () => {
        console.log('[Faster100x Embed] Iframe loaded successfully');
        clearTimeout(timeout);
        document.querySelector('.loading').style.display = 'none';
    };

    iframe.onerror = () => {
        console.log('[Faster100x Embed] Iframe error');
        clearTimeout(timeout);
        document.querySelector('.loading').style.display = 'none';
        document.querySelector('.error').style.display = 'block';
        document.getElementById('fallback-link').href = url;
    };

    document.body.appendChild(iframe);
} else {
    console.error('[Faster100x Embed] No address provided');
    document.querySelector('.loading').textContent = 'No address provided';
}
