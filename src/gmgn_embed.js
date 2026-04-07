const params = new URLSearchParams(window.location.search);
const address = params.get('address');
const chain = params.get('chain') || 'bsc';

const link = document.getElementById('ext-link');
// GMGN main page URL for "Open External" link
const mainPageUrl = `https://gmgn.ai/${chain}/token/${address}?r=captain`;
link.href = mainPageUrl;

// GMGN official embeddable chart URL
// Format: https://www.gmgn.cc/kline/{chain}/{token_address}?theme=dark&interval=5
const chartUrl = `https://www.gmgn.cc/kline/${chain}/${address}?theme=dark&interval=5`;

console.log('[GMGN Embed] Loading chart:', chartUrl);

if (address) {
    const iframe = document.createElement('iframe');
    iframe.src = chartUrl;
    iframe.allow = "clipboard-write; fullscreen";
    
    iframe.onload = () => {
        console.log('[GMGN Embed] Chart loaded');
        const loader = document.querySelector('.loading');
        if (loader) loader.style.display = 'none';
    };
    
    iframe.onerror = () => {
        console.error('[GMGN Embed] Chart error');
        const loader = document.querySelector('.loading');
        if (loader) loader.textContent = 'Failed to load chart';
    };

    // Timeout fallback
    setTimeout(() => {
        const loader = document.querySelector('.loading');
        if (loader && loader.style.display !== 'none') {
            loader.innerHTML = 'Taking longer than expected...<br><a href="' + mainPageUrl + '" target="_blank" style="color:#fff;text-decoration:underline;margin-top:8px;display:block;">Click to open GMGN directly</a>';
        }
    }, 5000);

    document.body.appendChild(iframe);
} else {
    document.querySelector('.loading').textContent = 'No address provided';
}
