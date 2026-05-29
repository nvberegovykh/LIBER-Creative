/**
 * Secure Key Management for Liber Apps Control Panel
 * Fetches decryption keys from Google Drive to decrypt sensitive data
 */

class SecureKeyManager {
    constructor() {
        // Deprecated Gist path removed in favor of server-provided config via Cloud Function
        this.gistId = null;
        this.gistFilename = null;
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

    /**
     * Set the secure keys URL (GitHub Gist, private repo, etc.)
     * This should be called by admin during setup
     */
    setKeySource(url) { this.keyUrl = url; localStorage.setItem('liber_keys_url', url); }

    /**
     * Get the key source URL
     */
    getKeySource() {
        if (!this.keyUrl) {
            this.keyUrl = localStorage.getItem('liber_keys_url') || null;
        }
        // Default to Cloud Function endpoint that serves public client config from Secret Manager
        return this.keyUrl || this.getDefaultRawUrl();
    }

    getDefaultRawUrl(){
        // Use the deployed HTTPS function (region may be in Gist keys/firebase.functionsRegion)
        const region = (window.__CFN_REGION_OVERRIDE__) || 'europe-west1';
        return `https://${region}-liber-apps-cca20.cloudfunctions.net/getPublicConfig`;
    }

    /**
     * Generate default admin credentials for fallback
     */
    async generateDefaultCredentials() {
        // Use environment variables or generate random fallback
        const adminPassword = 'FALLBACK_PASSWORD_' + Math.random().toString(36).substring(2, 15);
        const adminHash = await this.generateAdminHash(adminPassword);
        
        return {
            admin: {
                username: 'admin_fallback',
                email: 'admin@fallback.local',
                passwordHash: adminHash,
                role: 'admin'
            },
            system: {
                masterKeyHash: 'fallback_system_key_' + Math.random().toString(36).substring(2, 15)
            }
        };
    }

    /**
     * Clear all encrypted data when keys change
     */
    clearAllEncryptedData() {
        const keysToRemove = [
            'liber_users',
            'liber_session',
            'liber_current_user',
            'liber_user_password',
            'liber_keys_url' // Also clear the cached URL
        ];
        
        keysToRemove.forEach(key => {
            localStorage.removeItem(key);
        });
        
        // Clear cache
        this.cachedKeys = null;
        this.lastFetch = 0;
        this.keyUrl = null; // Force re-fetch of URL
        
        if (window.__DEBUG_KEYS__) console.log('Cleared all encrypted data due to key change');
    }

    /**
     * Force refresh of keys from Gist
     */
    forceRefreshKeys() {
        this.cachedKeys = null;
        this.lastFetch = 0;
        this.keyUrl = null;
        if (window.__DEBUG_KEYS__) console.log('Forced refresh of keys from Gist');
    }

    /**
     * Fetch keys from secure source (GitHub Gist, private repo, etc.)
     */
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
                    if (plain) {
                        this.cachedResponse = plain;
                        this.lastFetch = Date.now();
                        if (window.__DEBUG_KEYS__) console.log('Loaded keys from encrypted local cache');
                        return plain;
                    }
                }
            }
        } catch(_) { /* ignore cache errors */ }

        // 3) Fetch from remote: prefer explicit keyUrl (raw Gist) else fallback to GitHub API
        const maxRetries = 3; let attempt = 0;
        while (attempt < maxRetries) {
            try {
                const overrideUrl = this.getKeySource();
                let keysData = null;
                if (overrideUrl) {
                    if (window.__DEBUG_KEYS__) console.log('Fetching keys from override URL (attempt ' + (attempt + 1) + ')');
                    const resp = await fetch(overrideUrl, { cache: 'no-store' });
                    if (!resp.ok) throw new Error(`Override URL failed: ${resp.status}`);
                    keysData = await resp.json();
                } else {
                    // Directly call our function endpoint
                    const resp = await fetch(this.getDefaultRawUrl(), { cache: 'no-store' });
                    if (!resp.ok) throw new Error(`Config endpoint failed: ${resp.status}`);
                    keysData = await resp.json();
                }

                // Accept public-only config from server function: firebase (+ optional messaging)
                if (!keysData || !keysData.firebase) throw new Error('Invalid Gist structure');

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
                        try { const plain = await this.decryptAtRest(JSON.parse(cached)); if (plain) return plain; } catch(_){}
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

    /**
     * Get admin credentials from secure keys
     */
    async getAdminCredentials() {
        const keys = await this.fetchKeys();
        return keys.admin;
    }

    /**
     * Get system master key from secure keys
     */
    async getSystemKey() {
        const keys = await this.fetchKeys();
        return keys.system.masterKeyHash;
    }

    /**
     * Get all keys (for Firebase service)
     */
    async getKeys() {
        return await this.fetchKeys();
    }

    /**
     * Generate admin password hash for comparison
     */
    async generateAdminHash(password) {
        const salt = 'liber_admin_salt_2024';
        const encoder = new TextEncoder();
        const data = encoder.encode(password + salt);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Get the correct hash for the admin password
     * This is the hash that should be in your Gist file
     */
    async getCorrectAdminHash() {
        // This method should be called with the actual password
        // For security, we don't hardcode the password here
        if (window.__devWarn) window.__devWarn('Please provide the actual admin password to generate the correct hash');
        return 'HASH_NOT_AVAILABLE';
    }

    /**
     * Generate correct admin hash for the default admin password
     * This is the hash that should be in your Gist configuration
     */
    async generateCorrectAdminHash() {
        try {
            // The default admin password is likely 'admin' or similar
            // You can change this to match your actual admin password
            const adminPassword = 'admin'; // Change this to your actual admin password
            const hash = await this.generateAdminHash(adminPassword);
            console.log('Correct admin hash for password "' + adminPassword + '":', hash);
            console.log('Copy this hash to your Gist configuration file');
            return hash;
        } catch (error) {
            console.error('Error generating admin hash:', error);
            return null;
        }
    }

    /**
     * Test key connectivity
     */
    async testConnection() {
        try {
            const keys = await this.fetchKeys();
            const url = this.getKeySource();
            
            if (!url) {
                return { success: true, message: 'Using default credentials (no Gist configured)' };
            }
            
            // Try to fetch from Gist
            const response = await fetch(url);
            if (response.ok) {
                return { success: true, message: 'Keys accessible from Gist' };
            } else {
                return { success: false, message: `Gist returned ${response.status}. Using fallback credentials.` };
            }
        } catch (error) {
            return { success: false, message: `Connection failed: ${error.message}. Using fallback credentials.` };
        }
    }

    /**
     * Debug Gist configuration
     */
    async debugGistConfig() {
        console.log('=== Debugging Gist Configuration (redacted) ===');
        try {
            const data = await this.fetchKeys();
            if (data && typeof data === 'object') {
                console.log('Gist data structure (redacted):', Object.keys(data));
                console.log('Has Firebase config:', !!data.firebase);
            } else {
                console.warn('No keys available to debug');
            }
            return data;
        } catch (error) {
            console.error('Gist debug error:', error);
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
     * Get Mailgun configuration from secure Gist
     * 
     * PRODUCTION SETUP:
     * 1. Add your own domain to Mailgun (not sandbox)
     * 2. Configure DNS records as provided by Mailgun
     * 3. Update the domain below to your production domain
     * 4. Update the Gist with your production API key
     * 
     * SANDBOX LIMITATIONS:
     * - Can only send to 5 authorized recipients per month
     * - Cannot send to any email address
     * - For testing only
     */
    async getMailgunConfig() {
        try {
            const mailgunGistUrl = this.decodeUrl('aHR0cHM6Ly9naXN0LmdpdGh1YnVzZXJjb250ZW50LmNvbS9udmJlcmVnb3Z5a2gvNjBkYTlmNWFkODA4YWYxNjJkM2M1NzAwYjgzYTEyZWYvcmF3L2JlY2NjNGY2NjBiNWVhMTAzNGU1MDFlOGI3ODM3YjQ5ZDUzNWNkNGEvbWFpbGd1bi1jb25maWcuanNvbg==');
            console.log('Fetching Mailgun config from separate Gist...');
            const response = await fetch(mailgunGistUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch Mailgun config: ${response.status} ${response.statusText}`);
            }
            const config = await response.json();
            console.log('Mailgun config loaded successfully:', { hasMailgun: !!config.mailgun, hasApiKey: !!config.mailgun?.apiKey });
            if (!config.mailgun || !config.mailgun.apiKey) {
                throw new Error('Invalid Mailgun configuration format - missing mailgun.apiKey');
            }
            
            // PRODUCTION: Replace with your own domain
            const domain = 'mail.liberpict.com'; // Your production domain
            
            // SANDBOX: For testing only (limited to authorized recipients)
            // const domain = 'sandbox96d3d2543629448cba4e500e0da88a60.mailgun.org';
            
            return {
                apiKey: config.mailgun.apiKey,
                domain: domain
            };
        } catch (error) {
            console.error('Error loading Mailgun config from Gist:', error);
            throw new Error('Mailgun configuration not available. Please check your Gist configuration.');
        }
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
