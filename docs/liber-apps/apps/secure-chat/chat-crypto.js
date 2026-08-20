// Chat encryption built on the existing crypto manager
class ChatCrypto {
    constructor() {
        this.ivLength = 12;
        this.identityCache = {};
        this.identityDbPromise = null;
    }

    async deriveChatKey(secret) {
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'PBKDF2'}, false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            {name:'PBKDF2', salt: encoder.encode('liber_chat_salt_v1'), iterations: 100000, hash:'SHA-256'},
            keyMaterial,
            {name:'AES-GCM', length:256},
            true,
            ['encrypt','decrypt']
        );
    }

    randomIV(){
        const iv = new Uint8Array(this.ivLength);
        crypto.getRandomValues(iv);
        return iv;
    }

    async encryptMessage(plaintext, secret){
        const key = await this.deriveChatKey(secret);
        const iv = this.randomIV();
        const encoded = new TextEncoder().encode(plaintext);
        const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, encoded);
        return {
            iv: Array.from(iv, b=>b.toString(16).padStart(2,'0')).join(''),
            data: Array.from(new Uint8Array(ct), b=>b.toString(16).padStart(2,'0')).join('')
        };
    }

    async decryptMessage(cipher, secret){
        if (!cipher || typeof cipher.iv !== 'string' || typeof cipher.data !== 'string') {
            throw new Error('Invalid cipher format: expected { iv: string, data: string }');
        }
        const key = await this.deriveChatKey(secret);
        const iv = new Uint8Array(cipher.iv.match(/.{1,2}/g)?.map(h=>parseInt(h,16)) || []);
        const data = new Uint8Array(cipher.data.match(/.{1,2}/g)?.map(h=>parseInt(h,16)) || []);
        const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, data);
        return new TextDecoder().decode(pt);
    }

    // === New E2EE identity and shared-key helpers (ECDH P-256 + HKDF → AES-GCM) ===
    async openIdentityDb(){
        if (this.identityDbPromise) return this.identityDbPromise;
        if (!globalThis.indexedDB) throw new Error('Secure identity storage is unavailable in this browser.');
        this.identityDbPromise = new Promise((resolve, reject)=>{
            const request = indexedDB.open('liber-secure-chat-identity-v2', 1);
            request.onupgradeneeded = ()=>{
                const db = request.result;
                if (!db.objectStoreNames.contains('identities')) db.createObjectStore('identities', { keyPath:'uid' });
            };
            request.onsuccess = ()=> resolve(request.result);
            request.onerror = ()=> reject(request.error || new Error('Secure identity database could not be opened.'));
            request.onblocked = ()=> reject(new Error('Secure identity database upgrade is blocked by another LIBER tab.'));
        });
        return this.identityDbPromise;
    }

    async readStoredIdentity(uid){
        const db = await this.openIdentityDb();
        return new Promise((resolve, reject)=>{
            const request = db.transaction('identities', 'readonly').objectStore('identities').get(uid);
            request.onsuccess = ()=> resolve(request.result || null);
            request.onerror = ()=> reject(request.error || new Error('Secure identity could not be read.'));
        });
    }

    async writeStoredIdentity(record){
        const db = await this.openIdentityDb();
        return new Promise((resolve, reject)=>{
            const transaction = db.transaction('identities', 'readwrite');
            transaction.objectStore('identities').put(record);
            transaction.oncomplete = ()=> resolve(record);
            transaction.onerror = ()=> reject(transaction.error || new Error('Secure identity could not be stored.'));
            transaction.onabort = ()=> reject(transaction.error || new Error('Secure identity storage was aborted.'));
        });
    }

    async loadOrCreateIdentity(uid){
        const identityUid = String(uid || '').trim();
        if (!identityUid) throw new Error('Secure Chat identity requires an authenticated user.');
        if (this.identityCache[identityUid]) return this.identityCache[identityUid];
        const stored = await this.readStoredIdentity(identityUid);
        if (stored?.publicJwk && stored?.privateKey?.type === 'private' && stored?.privateKey?.algorithm?.name === 'ECDH'){
            this.identityCache[identityUid] = { publicJwk:stored.publicJwk, privateKey:stored.privateKey };
            return this.identityCache[identityUid];
        }

        // One-time migration preserves the already-published fingerprint while
        // replacing extractable/localStorage private-key material with a
        // non-exportable CryptoKey held by IndexedDB.
        const pubKeyKey = `secure_chat_pub_${identityUid}_v1`;
        const privKeyKey = `secure_chat_priv_${identityUid}_v1`;
        let publicJwk = null;
        let privateKey = null;
        try{
            const legacyPublic = JSON.parse(localStorage.getItem(pubKeyKey) || 'null');
            const legacyEncryptedPrivate = JSON.parse(localStorage.getItem(privKeyKey) || 'null');
            if (legacyPublic && legacyEncryptedPrivate){
                const privateJwk = await this.decryptJsonForDevice(legacyEncryptedPrivate, identityUid);
                privateKey = await crypto.subtle.importKey('jwk', privateJwk, {name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits']);
                publicJwk = legacyPublic;
            }
        }catch(_){ publicJwk = null; privateKey = null; }

        if (!publicJwk || !privateKey){
            const pair = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits']);
            publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
            privateKey = pair.privateKey;
        }
        const record = { uid:identityUid, publicJwk, privateKey, schema:'liber.secure-chat.device-identity.v2', createdAt:new Date().toISOString() };
        await this.writeStoredIdentity(record);
        localStorage.removeItem(pubKeyKey);
        localStorage.removeItem(privKeyKey);
        this.identityCache[identityUid] = { publicJwk, privateKey };
        return this.identityCache[identityUid];
    }

    async getPrivateKey(uid){
        const id = await this.loadOrCreateIdentity(uid);
        return id.privateKey;
    }

    async getPublicKeyFromJwk(jwk){
        return crypto.subtle.importKey('jwk', jwk, {name:'ECDH', namedCurve:'P-256'}, true, []);
    }

    async fingerprintPublicJwk(jwk){
        if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
            throw new Error('Invalid P-256 public key');
        }
        const canonical = JSON.stringify({ crv:'P-256', kty:'EC', x:jwk.x, y:jwk.y });
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
        return Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('');
    }

    async deriveSharedAesKey(myPrivateKey, peerPublicJwk, context = ''){
        const peerPubKey = await this.getPublicKeyFromJwk(peerPublicJwk);
        const sharedBits = await crypto.subtle.deriveBits({name:'ECDH', public: peerPubKey}, myPrivateKey, 256);
        // HKDF to AES-GCM
        const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new TextEncoder().encode('liber_secure_chat_v2'),
                info: new TextEncoder().encode(`conn_shared_key|${String(context || '')}`)
            },
            hkdfKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt','decrypt']
        );
    }

    async encryptWithKey(plaintext, aesKey){
        const iv = this.randomIV();
        const encoded = new TextEncoder().encode(plaintext);
        const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, aesKey, encoded);
        return {
            iv: Array.from(iv, b=>b.toString(16).padStart(2,'0')).join(''),
            data: Array.from(new Uint8Array(ct), b=>b.toString(16).padStart(2,'0')).join('')
        };
    }

    async decryptWithKey(cipher, aesKey){
        if (!cipher || typeof cipher.iv !== 'string' || typeof cipher.data !== 'string') {
            throw new Error('Invalid cipher format: expected { iv: string, data: string }');
        }
        const iv = new Uint8Array(cipher.iv.match(/.{1,2}/g)?.map(h=>parseInt(h,16)) || []);
        const data = new Uint8Array(cipher.data.match(/.{1,2}/g)?.map(h=>parseInt(h,16)) || []);
        const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv}, aesKey, data);
        return new TextDecoder().decode(pt);
    }

    async generateGroupAesKey(){
        return crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
    }

    async exportAesKeyBase64(aesKey){
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', aesKey));
        return btoa(String.fromCharCode(...raw));
    }

    async importAesKeyBase64(encoded){
        const raw = Uint8Array.from(atob(String(encoded || '')), c=>c.charCodeAt(0));
        if (raw.byteLength !== 32) throw new Error('Invalid wrapped group key length');
        return crypto.subtle.importKey('raw', raw, {name:'AES-GCM'}, false, ['encrypt','decrypt']);
    }

    async wrapGroupAesKey(groupKey, wrappingKey){
        return this.encryptWithKey(await this.exportAesKeyBase64(groupKey), wrappingKey);
    }

    async unwrapGroupAesKey(envelope, wrappingKey){
        return this.importAesKeyBase64(await this.decryptWithKey(envelope, wrappingKey));
    }

    // Legacy read-only compatibility. Never use this public-metadata-derived key
    // for new ciphertext; new writes must use the ECDH envelope path.
    async deriveFallbackSharedAesKey(uidA, uidB, connId){
        const a = String(uidA||'');
        const b = String(uidB||'');
        const sorted = [a,b].sort().join('|');
        const secret = `${sorted}|${connId}|liber_secure_chat_fallback_v1`;
        const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'PBKDF2'}, false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            {name:'PBKDF2', salt:new TextEncoder().encode('liber_fallback_salt'), iterations:100000, hash:'SHA-256'},
            material,
            {name:'AES-GCM', length:256},
            false,
            ['encrypt','decrypt']
        );
    }

    // Device-scoped encryption for private key persistence (PBKDF2 → AES-GCM)
    async encryptJsonForDevice(obj, uid){
        const saltKey = 'secure_chat_device_salt_v1';
        let salt = localStorage.getItem(saltKey);
        if (!salt){
            const arr = new Uint8Array(16); crypto.getRandomValues(arr);
            salt = Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join('');
            localStorage.setItem(saltKey, salt);
        }
        const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${uid}:${salt}`), {name:'PBKDF2'}, false, ['deriveKey']);
        const aes = await crypto.subtle.deriveKey({name:'PBKDF2', salt:new TextEncoder().encode('secure_chat_identity_v1'), iterations:100000, hash:'SHA-256'}, material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
        const iv = this.randomIV();
        const pt = new TextEncoder().encode(JSON.stringify(obj));
        const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, aes, pt);
        return { iv: Array.from(iv, b=>b.toString(16).padStart(2,'0')).join(''), data: Array.from(new Uint8Array(ct), b=>b.toString(16).padStart(2,'0')).join('') };
    }

    async decryptJsonForDevice(payload, uid){
        const saltKey = 'secure_chat_device_salt_v1';
        const salt = localStorage.getItem(saltKey) || '';
        const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${uid}:${salt}`), {name:'PBKDF2'}, false, ['deriveKey']);
        const aes = await crypto.subtle.deriveKey({name:'PBKDF2', salt:new TextEncoder().encode('secure_chat_identity_v1'), iterations:100000, hash:'SHA-256'}, material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
        const iv = new Uint8Array(payload.iv.match(/.{1,2}/g).map(h=>parseInt(h,16)));
        const data = new Uint8Array(payload.data.match(/.{1,2}/g).map(h=>parseInt(h,16)));
        const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv}, aes, data);
        return JSON.parse(new TextDecoder().decode(pt));
    }
}

window.chatCrypto = new ChatCrypto();
