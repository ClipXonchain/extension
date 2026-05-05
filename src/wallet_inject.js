class ClipXProvider {
    constructor() {
        this.isClipX = true;
        this.isMetaMask = true; // Pretend to be MetaMask for compatibility
        this.chainId = '0x38'; // BSC Mainnet
        this.networkVersion = '56';
        this.selectedAddress = null;
        this._listeners = {};
        this._idCounter = 0;
        
        // Bind methods
        this.request = this.request.bind(this);
        this.enable = this.enable.bind(this);
        this.on = this.on.bind(this);
        this.removeListener = this.removeListener.bind(this);
        
        // Listen for events from content script
        window.addEventListener('message', (event) => {
            if (event.source !== window || !event.data || event.data.target !== 'CLIPX_PROVIDER') return;
            
            const { type, payload } = event.data;
            if (type === 'CLIPX_AccountsChanged') {
                this.selectedAddress = payload[0] || null;
                this._emit('accountsChanged', payload);
            }
        });

        // Auto-initialize to support "already connected" state
        this._initialize();
    }

    async _initialize() {
        // Yield to let the rest of the page load slightly, then fetch accounts
        setTimeout(async () => {
            try {
                // We use 'eth_accounts' which background.js is configured to answer 
                // with the stored address even if the wallet is "locked" (read-only mode)
                const accounts = await this.request({ method: 'eth_accounts' });
                if (accounts && accounts.length > 0) {
                    this.selectedAddress = accounts[0];
                    // Emit connect event so dApps know we are ready
                    this._emit('connect', { chainId: this.chainId });
                    this._emit('accountsChanged', accounts);
                    console.log('[ClipX] Auto-connected to GMGN as', this.selectedAddress);
                }
            } catch (e) {
                // Ignore initialization errors
            }
        }, 0);
    }

    _emit(event, data) {
        if (this._listeners[event]) {
            this._listeners[event].forEach(cb => cb(data));
        }
    }

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
    }

    removeListener(event, callback) {
        if (this._listeners[event]) {
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
        }
    }

    async request(args) {
        const { method, params } = args;
        const reqId = this._idCounter++;

        // If we already have the address and the app is just asking for it, return immediately
        if ((method === 'eth_accounts' || method === 'eth_requestAccounts') && this.selectedAddress) {
            return [this.selectedAddress];
        }

        return new Promise((resolve, reject) => {
            // Setup response listener
            const handler = (event) => {
                if (event.source !== window || !event.data || event.data.target !== 'CLIPX_PROVIDER') return;
                
                if (event.data.type === 'CLIPX_RESPONSE' && event.data.reqId === reqId) {
                    window.removeEventListener('message', handler);
                    
                    if (event.data.error) {
                        reject(event.data.error);
                    } else {
                        // If this was an account request, update our state
                        if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
                             const accs = event.data.result;
                             if (accs && accs.length > 0 && accs[0] !== this.selectedAddress) {
                                 this.selectedAddress = accs[0];
                                 this._emit('accountsChanged', accs);
                             }
                        }
                        resolve(event.data.result);
                    }
                }
            };
            window.addEventListener('message', handler);

            // Send request to content script
            window.postMessage({
                target: 'CLIPX_CONTENT',
                type: 'CLIPX_REQUEST',
                reqId,
                method,
                params
            }, '*');
        });
    }

    async enable() {
        return this.request({ method: 'eth_requestAccounts' });
    }
}

// Inject provider
if (!window.ethereum) {
    window.ethereum = new ClipXProvider();
    console.log('[ClipX] Wallet Provider Injected into GMGN');
    window.dispatchEvent(new Event('ethereum#initialized'));
}
