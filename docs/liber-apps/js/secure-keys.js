/**
 * Managed public-client configuration for LIBER Apps.
 * Provider credentials, admin passwords and master keys are server-only.
 */

class SecureKeyManager {
    constructor() {
        this.apiCacheExpiry = 5 * 60 * 1000; // 5 mins
        this.lastApiFetch = 0;
        this.cachedResponse = null;
        this.keyUrl = null;
        this.cachedKeys = null;
        this.keyCacheExpiry = 30 * 60 * 1000; // 30 minutes
        this.lastFetch = 0;
        this.cacheKeyName = 'liber_keys_cache_v2';
        this.deviceSecretKeyName = 'liber_device_secret_v1';
        // No baked URL; client fetches public config from our Cloud Function endpoint
        this._rawUrlParts = [];
    }

    /**
     * Decode base64 URL to prevent easy discovery
     */
    decodeUrl(encoded) {
        try {
            return atob(encoded);
        } catch (error) {
            console.error('Failed to decode URL:', error);
            return '';
        }
    }

    /** Runtime config is deployment-owned; browser users cannot redirect token-bearing clients. */
    setKeySource() {
        localStorage.removeItem('liber_keys_url');
        this.keyUrl = null;
        return false;
    }

    /**
     * Get the key source URL
     */
    getKeySource() {
        return this.getDefaultRawUrl();
    }

    getDefaultRawUrl(){
        // Use the deployed HTTPS function (region may be in Gist keys/firebase.functionsRegion)
        const region = (window.__CFN_REGION_OVERRIDE__) || 'europe-west1';
        return `https://${region}-liber-apps-cca20.cloudfunctions.net/getPublicConfig`;
    }

    /**
     * Clear all encrypted data when keys change
     */
    clearAllEncryptedData() {
        // Public-config repair must never erase project/user/session data.
        const keysToRemove = [this.cacheKeyName, this.deviceSecretKeyName, 'liber_keys_url'];
        
        keysToRemove.forEach(key => {
            localStorage.removeItem(key);
        });
        
        // Clear cache
        this.cachedKeys = null;
        this.lastFetch = 0;
        this.keyUrl = null; // Force re-fetch of URL
        
        if (window.__DEBUG_KEYS__) console.log('Cleared all encrypted data due to key change');
    }

    /** Force refresh of keys from the managed endpoint. */
    forceRefreshKeys() {
        this.cachedKeys = null;
        this.lastFetch = 0;
        this.keyUrl = null;
        if (window.__DEBUG_KEYS__) console.log('Forced refresh of managed keys');
    }

    /** Fetch keys from the managed endpoint. */
    async fetchKeys() {
        // 1) Return in-memory cache if still fresh
        if (this.cachedResponse && Date.now() - this.lastFetch < this.keyCacheExpiry) {
            if (window.__DEBUG_KEYS__) console.log('Using in-memory cached keys');
            return this.cachedResponse;
        }

        // 2) Try encrypted local cache
        try {
            const cached = localStorage.getItem(this.cacheKeyName);
            if (cached) {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.iv && parsed.ct && parsed.ts && (Date.now() - parsed.ts < this.keyCacheExpiry)) {
                    const plain = await this.decryptAtRest(parsed);
                    const publicConfig = this.sanitizePublicConfig(plain);
                    if (publicConfig.firebase) {
                        this.cachedResponse = publicConfig;
                        this.lastFetch = Date.now();
                        if (window.__DEBUG_KEYS__) console.log('Loaded keys from encrypted local cache');
                        return publicConfig;
                    }
                }
            }
        } catch(_) { /* ignore cache errors */ }

        // 3) Fetch public client config from the deployment-owned Cloud Function.
        const maxRetries = 3; let attempt = 0;
        while (attempt < maxRetries) {
            try {
                const endpoint = this.getKeySource();
                if (window.__DEBUG_KEYS__) console.log('Fetching managed public config (attempt ' + (attempt + 1) + ')');
                const resp = await fetch(endpoint, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
                if (!resp.ok) throw new Error(`Config endpoint failed: ${resp.status}`);
                const keysData = this.sanitizePublicConfig(await resp.json());

                if (!keysData || !keysData.firebase) throw new Error('Invalid public client configuration');

                // Save to caches
                this.cachedResponse = keysData; this.lastFetch = Date.now();
                try { await this.encryptAtRest(keysData); } catch(_){}
                if (window.__DEBUG_KEYS__) console.log('Keys fetched and cached (redacted)');
                return keysData;
            } catch (error) {
                console.error('Secure keys load failed (attempt ' + (attempt + 1) + '):', error);
                attempt++;
                if (attempt >= maxRetries) {
                    console.warn('All retries failed - using cached or limited mode');
                    const cached = localStorage.getItem(this.cacheKeyName);
                    if (cached) {
                        try {
                            const plain = this.sanitizePublicConfig(await this.decryptAtRest(JSON.parse(cached)));
                            if (plain.firebase) return plain;
                        } catch(_){}
                    }
                    return {};
                }
            }
        }
    }

    /**
     * Validate keys structure
     */
    validateKeys(keys) {
        // New rule: accept public config (firebase + optional messaging). Admin/system are optional now.
        if (!(keys && typeof keys === 'object' && keys.firebase)) return false;
        if (!keys.firebase.apiKey || !keys.firebase.projectId) {
            console.warn('⚠️ Firebase config missing essential fields');
        }
        if (window.__DEBUG_KEYS__) console.log('✅ Public config validated');
        return true;
    }

    sanitizePublicConfig(input) {
        if (!input || typeof input !== 'object' || !input.firebase || typeof input.firebase !== 'object') return {};
        const allowedFirebaseFields = [
            'apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId',
            'appId', 'measurementId', 'databaseURL', 'functionsRegion', 'region'
        ];
        const firebase = {};
        allowedFirebaseFields.forEach((field) => {
            const value = input.firebase[field];
            if (typeof value === 'string' && value.trim()) firebase[field] = value.trim();
        });
        if (!firebase.projectId) return {};
        const output = { firebase };
        const vapidPublicKey = input.messaging?.vapidPublicKey;
        if (typeof vapidPublicKey === 'string' && vapidPublicKey.trim()) {
            output.messaging = { vapidPublicKey: vapidPublicKey.trim() };
        }
        const functionsRegion = input.functionsRegion;
        if (typeof functionsRegion === 'string' && /^[a-z]+-[a-z]+\d$/i.test(functionsRegion)) {
            output.functionsRegion = functionsRegion;
        }
        return output;
    }

    /**
     * Get admin credentials from secure keys
     */
    async getAdminCredentials() {
        throw new Error('Admin authentication is Firebase-only; browser credentials are disabled.');
    }

    /**
     * Get system master key from secure keys
     */
    async getSystemKey() {
        throw new Error('System keys are server-only and are never returned to the browser.');
    }

    /**
     * Get all keys (for Firebase service)
     */
    async getKeys() {
        return this.sanitizePublicConfig(await this.fetchKeys());
    }

    async generateAdminHash(password) {
        void password;
        throw new Error('Browser-admin password hashing is disabled; use Firebase Authentication.');
    }

    /**
     * Test key connectivity
     */
    async testConnection() {
        try {
            const keys = await this.fetchKeys();
            const url = this.getKeySource();
            
            if (!url) {
                return { success: false, message: 'Managed public-config endpoint is unavailable.' };
            }
            
            const response = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
            if (response.ok) {
                const config = this.sanitizePublicConfig(await response.json());
                return config.firebase ? { success: true, message: 'Managed public configuration is available.' } : { success: false, message: 'Managed endpoint returned invalid public configuration.' };
            } else {
                return { success: false, message: `Managed endpoint returned ${response.status}.` };
            }
        } catch (error) {
            return { success: false, message: `Connection failed: ${error.message}. Using fallback credentials.` };
        }
    }

    /**
     * Debug managed public configuration without logging values.
     */
    async debugGistConfig() {
        console.log('=== Debugging managed public configuration (redacted) ===');
        try {
            const data = await this.fetchKeys();
            if (data && typeof data === 'object') {
                console.log('Public configuration fields:', Object.keys(data));
                console.log('Has Firebase config:', !!data.firebase);
            } else {
                console.warn('No keys available to debug');
            }
            return data;
        } catch (error) {
            console.error('Managed configuration debug error:', error);
            return null;
        }
    }

    /**
     * Clear cached keys (for security)
     */
    clearCache() {
        this.cachedKeys = null;
        this.lastFetch = 0;
    }

    // --- Encrypted-at-rest helpers ---
    async getOrCreateDeviceKey() {
        try {
            const existing = localStorage.getItem(this.deviceSecretKeyName);
            if (existing) {
                const raw = Uint8Array.from(atob(existing), c=>c.charCodeAt(0));
                return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt','decrypt']);
            }
            const key = await crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt','decrypt']);
            const raw = await crypto.subtle.exportKey('raw', key);
            const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
            localStorage.setItem(this.deviceSecretKeyName, b64);
            return key;
        } catch(_) { return null; }
    }

    async encryptAtRest(obj) {
        try {
            const key = await this.getOrCreateDeviceKey(); if (!key) return;
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const data = new TextEncoder().encode(JSON.stringify(obj));
            const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, data);
            const out = { iv: btoa(String.fromCharCode(...iv)), ct: btoa(String.fromCharCode(...new Uint8Array(ct))), ts: Date.now() };
            localStorage.setItem(this.cacheKeyName, JSON.stringify(out));
        } catch(_) { /* ignore */ }
    }

    async decryptAtRest(bundle) {
        try {
            const key = await this.getOrCreateDeviceKey(); if (!key) return null;
            const iv = Uint8Array.from(atob(bundle.iv), c=>c.charCodeAt(0));
            const ct = Uint8Array.from(atob(bundle.ct), c=>c.charCodeAt(0));
            const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct);
            const json = new TextDecoder().decode(pt);
            return JSON.parse(json);
        } catch(_) { return null; }
    }

    /**
     * Provider credentials are deliberately unavailable to browser code.
     * Email must be sent by Firebase Auth or an authenticated server handler whose
     * provider secret is held in Secret Manager. Keep this compatibility method
     * fail-closed so an old caller cannot re-introduce a client credential path.
     */
    async getMailgunConfig() {
        throw new Error('Email provider credentials are server-only. Use Firebase Auth email delivery.');
    }

}

// Initialize secure key manager
window.secureKeyManager = new SecureKeyManager();

// Add global debug function
window.debugGistConfig = function() {
    if (window.secureKeyManager) {
        return window.secureKeyManager.debugGistConfig();
    } else {
        console.error('Secure key manager not available');
        return null;
    }
};
