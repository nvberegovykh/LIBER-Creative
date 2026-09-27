// Chat encryption built on the existing crypto manager
class ChatCrypto {
    constructor() {
        this.ivLength = 12;
        this.identityCache = Object.create(null);
        this.identityDbPromise = null;
        this.deviceIdentityTasks = Object.create(null);
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
        const databaseName = 'liber-secure-chat-identity-v2';
        const openDatabase = (version)=> new Promise((resolve, reject)=>{
            // Do not open at a stale fixed version. Some users already have a newer
            // database from the read-compat release, so inspect first and only bump
            // when this browser is missing a required local store.
            const request = version == null ? indexedDB.open(databaseName) : indexedDB.open(databaseName, version);
            request.onupgradeneeded = ()=>{
                const db = request.result;
                if (!db.objectStoreNames.contains('identities')) db.createObjectStore('identities', { keyPath:'uid' });
                if (!db.objectStoreNames.contains('deviceIdentities')) db.createObjectStore('deviceIdentities', { keyPath:'id' });
            };
            request.onsuccess = ()=> resolve(request.result);
            request.onerror = ()=> reject(request.error || new Error('Secure identity database could not be opened.'));
            request.onblocked = ()=> reject(new Error('Secure identity database is blocked by another LIBER tab. Close the other tab and retry.'));
        });
        const ensureStores = async()=>{
            let db = await openDatabase();
            if (!db.objectStoreNames.contains('identities') || !db.objectStoreNames.contains('deviceIdentities')){
                const nextVersion = Number(db.version || 1) + 1;
                try{ db.close(); }catch(_){ }
                try{
                    db = await openDatabase(nextVersion);
                }catch(error){
                    // Another tab can win the one-time schema bump. Re-open at the
                    // actual current version before failing the identity operation.
                    if (error?.name !== 'VersionError') throw error;
                    db = await openDatabase();
                }
            }
            if (!db.objectStoreNames.contains('identities') || !db.objectStoreNames.contains('deviceIdentities')){
                try{ db.close(); }catch(_){ }
                throw new Error('Secure identity database is missing a required identity store.');
            }
            db.onversionchange = ()=>{
                try{ db.close(); }catch(_){ }
                this.identityDbPromise = null;
            };
            return db;
        };
        this.identityDbPromise = ensureStores().catch((error)=>{
            this.identityDbPromise = null;
            throw error;
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

    async importAesKeyBase64(encoded, extractable = false){
        const raw = Uint8Array.from(atob(String(encoded || '')), c=>c.charCodeAt(0));
        if (raw.byteLength !== 32) throw new Error('Invalid wrapped group key length');
        return crypto.subtle.importKey('raw', raw, {name:'AES-GCM'}, !!extractable, ['encrypt','decrypt']);
    }

    async wrapGroupAesKey(groupKey, wrappingKey){
        return this.encryptWithKey(await this.exportAesKeyBase64(groupKey), wrappingKey);
    }

    async unwrapGroupAesKey(envelope, wrappingKey, extractable = false){
        return this.importAesKeyBase64(await this.decryptWithKey(envelope, wrappingKey), extractable);
    }

    // v4 device identities are local, per-account, and create-once. The private
    // CryptoKey never leaves IndexedDB; callers receive it only to derive ECDH
    // wrapping keys in this origin.
    deviceIdentityRecordId(uid, deviceId){
        return `${String(uid || '').trim()}:${String(deviceId || '').trim()}`;
    }

    deviceIdentityPointerId(uid){
        return `__liber_secure_chat_current_device_v4:${String(uid || '').trim()}`;
    }

    isStoredDeviceId(value){
        return /^[a-z0-9_-]{16,96}$/i.test(String(value || '').trim());
    }

    isV4DeviceId(value){
        return /^[A-Za-z0-9_-]{22,64}$/.test(String(value || '').trim());
    }

    createDeviceId(){
        if (!globalThis.crypto?.getRandomValues || typeof globalThis.btoa !== 'function') {
            throw new Error('Secure random device identity generation is unavailable in this browser.');
        }
        const bytes = new Uint8Array(24);
        crypto.getRandomValues(bytes);
        return btoa(Array.from(bytes, byte=>String.fromCharCode(byte)).join(''))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    readDeviceIdFromStorage(keys){
        try{
            for (const key of keys){
                const value = String(localStorage.getItem(key) || '').trim();
                if (this.isStoredDeviceId(value)) return value;
            }
        }catch(_){ }
        return '';
    }

    // New mappings are UID-scoped so an account switch in the same browser cannot
    // accidentally bind the next user to the prior user's device record.
    getStoredDeviceId(uid){
        const identityUid = String(uid || '').trim();
        if (!identityUid) return '';
        return this.readDeviceIdFromStorage([`liber_secure_chat_device_id_v4:${identityUid}`]);
    }

    getLegacyStoredDeviceId(){
        return this.readDeviceIdFromStorage(['liber_secure_chat_device_id_v4', 'liber_secure_chat_device_id_v3']);
    }

    persistStoredDeviceId(uid, deviceId){
        const identityUid = String(uid || '').trim();
        const normalizedDeviceId = String(deviceId || '').trim();
        if (!identityUid || !this.isStoredDeviceId(normalizedDeviceId)) return false;
        try{
            localStorage.setItem(`liber_secure_chat_device_id_v4:${identityUid}`, normalizedDeviceId);
            return true;
        }catch(_){
            // The IndexedDB pointer remains the durable source if localStorage is
            // unavailable (for example, a restrictive browser privacy setting).
            return false;
        }
    }

    async readStoredDeviceIdentity(id){
        const db = await this.openIdentityDb();
        return new Promise((resolve, reject)=>{
            const request = db.transaction('deviceIdentities', 'readonly').objectStore('deviceIdentities').get(id);
            request.onsuccess = ()=> resolve(request.result || null);
            request.onerror = ()=> reject(request.error || new Error('Secure device identity could not be read.'));
        });
    }

    async readStoredDevicePointer(uid){
        const identityUid = String(uid || '').trim();
        if (!identityUid) return null;
        const pointer = await this.readStoredDeviceIdentity(this.deviceIdentityPointerId(identityUid));
        if (pointer?.schema !== 'liber.secure-chat.device-pointer.v4' || pointer.uid !== identityUid || !this.isStoredDeviceId(pointer.deviceId)) return null;
        return pointer;
    }

    async writeStoredDevicePointer(uid, deviceId){
        const identityUid = String(uid || '').trim();
        const normalizedDeviceId = String(deviceId || '').trim();
        if (!identityUid || !this.isStoredDeviceId(normalizedDeviceId)) throw new Error('Invalid Secure Chat device identity pointer.');
        const pointer = {
            id: this.deviceIdentityPointerId(identityUid),
            uid: identityUid,
            deviceId: normalizedDeviceId,
            schema: 'liber.secure-chat.device-pointer.v4'
        };
        const db = await this.openIdentityDb();
        return new Promise((resolve, reject)=>{
            const transaction = db.transaction('deviceIdentities', 'readwrite');
            transaction.objectStore('deviceIdentities').put(pointer);
            transaction.oncomplete = ()=> resolve(pointer);
            transaction.onerror = ()=> reject(transaction.error || new Error('Secure device identity pointer could not be stored.'));
            transaction.onabort = ()=> reject(transaction.error || new Error('Secure device identity pointer storage was aborted.'));
        });
    }

    // A browser-local pointer can outlive cleared/corrupt IndexedDB key
    // material. Clear only that local pointer—not any remote registration or
    // legacy account root—so a fresh immutable v4 device can be aligned.
    async clearStoredDevicePointer(uid){
        const identityUid = String(uid || '').trim();
        if (!identityUid) return;
        try{ localStorage.removeItem(`liber_secure_chat_device_id_v4:${identityUid}`); }catch(_){ }
        try{
            const db = await this.openIdentityDb();
            await new Promise((resolve, reject)=>{
                const transaction = db.transaction('deviceIdentities', 'readwrite');
                transaction.objectStore('deviceIdentities').delete(this.deviceIdentityPointerId(identityUid));
                transaction.oncomplete = ()=> resolve();
                transaction.onerror = ()=> reject(transaction.error || new Error('Secure device identity pointer could not be cleared.'));
                transaction.onabort = ()=> reject(transaction.error || new Error('Secure device identity pointer clear was aborted.'));
            });
        }catch(_){ }
    }

    // A device id is immutable on the server.  If this browser retained a
    // local private key whose public half does not match an already-published
    // record under that same id, it can never be aligned safely.  Forget only
    // that local device record and its pointers; never alter the remote record
    // or the account-wide legacy root.  The caller creates one fresh device
    // identity and retries registration exactly once.
    async discardConflictingDeviceIdentity(uid, deviceId){
        const identityUid = String(uid || '').trim();
        const normalizedDeviceId = String(deviceId || '').trim();
        if (!identityUid || !this.isStoredDeviceId(normalizedDeviceId)) return;
        try{
            if (String(localStorage.getItem(`liber_secure_chat_device_id_v4:${identityUid}`) || '').trim() === normalizedDeviceId) {
                localStorage.removeItem(`liber_secure_chat_device_id_v4:${identityUid}`);
            }
            for (const legacyKey of ['liber_secure_chat_device_id_v4', 'liber_secure_chat_device_id_v3']){
                if (String(localStorage.getItem(legacyKey) || '').trim() === normalizedDeviceId) localStorage.removeItem(legacyKey);
            }
        }catch(_){ }
        try{
            const db = await this.openIdentityDb();
            await new Promise((resolve, reject)=>{
                const transaction = db.transaction('deviceIdentities', 'readwrite');
                const store = transaction.objectStore('deviceIdentities');
                const pointerId = this.deviceIdentityPointerId(identityUid);
                const pointerRequest = store.get(pointerId);
                pointerRequest.onsuccess = ()=>{
                    if (String(pointerRequest.result?.deviceId || '').trim() === normalizedDeviceId) store.delete(pointerId);
                    store.delete(this.deviceIdentityRecordId(identityUid, normalizedDeviceId));
                };
                pointerRequest.onerror = ()=>{
                    try{ transaction.abort(); }catch(_){ }
                };
                transaction.oncomplete = ()=> resolve();
                transaction.onerror = ()=> reject(transaction.error || new Error('Secure device identity could not be cleared after a registration conflict.'));
                transaction.onabort = ()=> reject(transaction.error || new Error('Secure device identity clear was aborted after a registration conflict.'));
            });
        }finally{
            delete this.identityCache[`stored-device:${identityUid}:${normalizedDeviceId}`];
        }
    }

    async createStoredDeviceIdentity(record){
        const db = await this.openIdentityDb();
        const pointer = {
            id: this.deviceIdentityPointerId(record.uid),
            uid: record.uid,
            deviceId: record.deviceId,
            schema: 'liber.secure-chat.device-pointer.v4'
        };
        return new Promise((resolve, reject)=>{
            const transaction = db.transaction('deviceIdentities', 'readwrite');
            const store = transaction.objectStore('deviceIdentities');
            let failure = null;
            const pointerRequest = store.get(pointer.id);
            pointerRequest.onsuccess = ()=>{
                if (pointerRequest.result?.deviceId){
                    failure = new Error('A Secure Chat device identity is already enrolled for this account in this browser.');
                    failure.code = 'liber/chat-device-identity-conflict';
                    transaction.abort();
                    return;
                }
                store.add(record);
                store.put(pointer);
            };
            pointerRequest.onerror = ()=>{
                failure = pointerRequest.error || new Error('Secure device identity pointer could not be read.');
                try{ transaction.abort(); }catch(_){ }
            };
            transaction.oncomplete = ()=> resolve(record);
            transaction.onerror = ()=> reject(failure || transaction.error || new Error('Secure device identity could not be stored.'));
            transaction.onabort = ()=> reject(failure || transaction.error || new Error('Secure device identity storage was aborted.'));
        });
    }

    async normalizeStoredDeviceIdentity(record, uid, deviceId){
        const identityUid = String(uid || '').trim();
        const normalizedDeviceId = String(deviceId || '').trim();
        if (!identityUid || !this.isStoredDeviceId(normalizedDeviceId)) return null;
        if (!record || (record.id && record.id !== this.deviceIdentityRecordId(identityUid, normalizedDeviceId))) return null;
        if (record.uid !== identityUid || String(record.deviceId || normalizedDeviceId).trim() !== normalizedDeviceId) return null;
        if (!record.publicJwk || record.publicJwk.kty !== 'EC' || record.publicJwk.crv !== 'P-256'
            || typeof record.publicJwk.x !== 'string' || typeof record.publicJwk.y !== 'string') return null;
        const privateKey = record.privateKey;
        if (privateKey?.type !== 'private' || privateKey?.algorithm?.name !== 'ECDH'
            || privateKey?.algorithm?.namedCurve !== 'P-256' || privateKey.extractable !== false
            || !Array.from(privateKey.usages || []).includes('deriveBits')) return null;
        const fingerprint = await this.fingerprintPublicJwk(record.publicJwk);
        if (record.fingerprint && record.fingerprint !== fingerprint) return null;
        return {
            uid: identityUid,
            deviceId: normalizedDeviceId,
            publicJwk: record.publicJwk,
            privateKey,
            fingerprint,
            // Older retained device keys predate the publication field. They use
            // the same non-exportable P-256 material, so publish them under the
            // v4 registry schema without changing their private key or key ID.
            cryptoVersion: 'liber.secure-chat.device-identity.v4',
            createdAt: String(record.createdAt || new Date().toISOString())
        };
    }

    async resolveStoredDeviceIdentity(uid){
        const identityUid = String(uid || '').trim();
        if (!identityUid) throw new Error('Secure Chat device identity requires an authenticated user.');
        const localDeviceId = this.getStoredDeviceId(identityUid);
        const pointer = await this.readStoredDevicePointer(identityUid);
        const candidateIds = [];
        const add = (value)=>{
            const normalized = String(value || '').trim();
            if (this.isStoredDeviceId(normalized) && !candidateIds.includes(normalized)) candidateIds.push(normalized);
        };
        add(localDeviceId);
        add(pointer?.deviceId);
        // Read an R167-R169 marker only when it resolves to this exact account's
        // persisted record. A stale global marker must never block a new account.
        add(this.getLegacyStoredDeviceId());
        let hasBrokenCurrentReference = !!localDeviceId || !!pointer;
        for (const deviceId of candidateIds){
            const record = await this.readStoredDeviceIdentity(this.deviceIdentityRecordId(identityUid, deviceId));
            const identity = await this.normalizeStoredDeviceIdentity(record, identityUid, deviceId);
            if (!identity){
                if (deviceId === localDeviceId || deviceId === pointer?.deviceId) hasBrokenCurrentReference = true;
                continue;
            }
            this.persistStoredDeviceId(identityUid, deviceId);
            if (pointer?.deviceId !== deviceId) await this.writeStoredDevicePointer(identityUid, deviceId);
            const cacheKey = `stored-device:${identityUid}:${deviceId}`;
            this.identityCache[cacheKey] = identity;
            return identity;
        }
        if (hasBrokenCurrentReference) await this.clearStoredDevicePointer(identityUid);
        return null;
    }

    async loadOrCreateDeviceIdentity(uid){
        const identityUid = String(uid || '').trim();
        if (!identityUid) throw new Error('Secure Chat device identity requires an authenticated user.');
        const taskKey = `create-device:${identityUid}`;
        if (this.deviceIdentityTasks[taskKey]) return this.deviceIdentityTasks[taskKey];
        const task = (async()=>{
            const existing = await this.resolveStoredDeviceIdentity(identityUid);
            if (existing) return existing;
            const deviceId = this.createDeviceId();
            if (!this.isV4DeviceId(deviceId)) throw new Error('Secure Chat generated an invalid device identity.');
            const pair = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits']);
            if (pair.privateKey?.extractable !== false) throw new Error('Secure Chat refused an exportable device private key.');
            const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
            const fingerprint = await this.fingerprintPublicJwk(publicJwk);
            const record = {
                id: this.deviceIdentityRecordId(identityUid, deviceId),
                uid: identityUid,
                deviceId,
                publicJwk,
                privateKey: pair.privateKey,
                fingerprint,
                cryptoVersion: 'liber.secure-chat.device-identity.v4',
                createdAt: new Date().toISOString()
            };
            try{
                await this.createStoredDeviceIdentity(record);
            }catch(error){
                if (error?.code !== 'liber/chat-device-identity-conflict') throw error;
                const enrolled = await this.resolveStoredDeviceIdentity(identityUid);
                if (enrolled) return enrolled;
                throw error;
            }
            this.persistStoredDeviceId(identityUid, deviceId);
            const identity = await this.normalizeStoredDeviceIdentity(record, identityUid, deviceId);
            if (!identity) throw new Error('Secure Chat could not verify its newly stored device identity.');
            this.identityCache[`stored-device:${identityUid}:${deviceId}`] = identity;
            return identity;
        })();
        this.deviceIdentityTasks[taskKey] = task;
        try{ return await task; }
        finally{ delete this.deviceIdentityTasks[taskKey]; }
    }

    async getDeviceIdentityPublication(uid){
        const identity = await this.loadOrCreateDeviceIdentity(uid);
        return {
            uid: identity.uid,
            deviceId: identity.deviceId,
            publicJwk: identity.publicJwk,
            fingerprint: identity.fingerprint,
            cryptoVersion: identity.cryptoVersion,
            createdAt: identity.createdAt
        };
    }

    async listStoredDeviceIdentities(uid, limit = 8){
        const identityUid = String(uid || '').trim();
        if (!identityUid) return [];
        const db = await this.openIdentityDb();
        const rows = await new Promise((resolve, reject)=>{
            const request = db.transaction('deviceIdentities', 'readonly').objectStore('deviceIdentities').getAll();
            request.onsuccess = ()=> resolve(Array.isArray(request.result) ? request.result : []);
            request.onerror = ()=> reject(request.error || new Error('Secure device identity history could not be read.'));
        });
        const prefix = `${identityUid}:`;
        const pointer = await this.readStoredDevicePointer(identityUid);
        const currentId = this.getStoredDeviceId(identityUid) || String(pointer?.deviceId || '');
        const found = [];
        for (const stored of rows){
            const id = String(stored?.id || '');
            if (!id.startsWith(prefix)) continue;
            const deviceId = String(stored.deviceId || id.slice(prefix.length)).trim();
            const identity = await this.normalizeStoredDeviceIdentity(stored, identityUid, deviceId);
            if (!identity) continue;
            found.push({ ...identity, current: identity.deviceId === currentId });
        }
        found.sort((a,b)=>Number(b.current)-Number(a.current));
        return found.slice(0, Math.max(1, Math.min(16, Number(limit)||8)));
    }

    async loadExistingLegacyIdentity(uid){
        const identityUid = String(uid || '').trim();
        if (!identityUid) return null;
        const stored = await this.readStoredIdentity(identityUid);
        if (stored?.publicJwk && stored?.privateKey?.type === 'private' && stored?.privateKey?.algorithm?.name === 'ECDH'){
            return { uid:identityUid, deviceId:'legacy-v2', publicJwk:stored.publicJwk, privateKey:stored.privateKey };
        }
        try{
            const publicJwk = JSON.parse(localStorage.getItem(`secure_chat_pub_${identityUid}_v1`) || 'null');
            const encryptedPrivate = JSON.parse(localStorage.getItem(`secure_chat_priv_${identityUid}_v1`) || 'null');
            if (!publicJwk || !encryptedPrivate) return null;
            const privateJwk = await this.decryptJsonForDevice(encryptedPrivate, identityUid);
            const privateKey = await crypto.subtle.importKey('jwk', privateJwk, {name:'ECDH', namedCurve:'P-256'}, false, ['deriveBits']);
            return { uid:identityUid, deviceId:'legacy-v2', publicJwk, privateKey };
        }catch(_){ return null; }
    }

    async loadStoredDeviceIdentity(uid){
        const identityUid = String(uid || '').trim();
        if (!identityUid) throw new Error('Secure Chat device identity requires an authenticated user.');
        const stored = await this.resolveStoredDeviceIdentity(identityUid);
        if (!stored){
            const error = new Error('The previously enrolled multi-device chat identity is unavailable on this browser.');
            error.code = 'liber/chat-device-identity-missing';
            throw error;
        }
        return stored;
    }

    async unwrapMessageAesKey(envelope, myPrivateKey, senderPublicJwk, context, extractable = false){
        const wrappingKey = await this.deriveSharedAesKey(myPrivateKey, senderPublicJwk, `message-envelope-v3|${String(context || '')}`);
        return this.unwrapGroupAesKey(envelope, wrappingKey, extractable);
    }

    async unwrapMessageAesKeyV4(envelope, myPrivateKey, senderPublicJwk, context, extractable = false){
        const wrappingKey = await this.deriveSharedAesKey(myPrivateKey, senderPublicJwk, `message-envelope-v4|${String(context || '')}`);
        return this.unwrapGroupAesKey(envelope, wrappingKey, extractable);
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
