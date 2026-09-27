/**
 * Secure Chat R178 device-envelope read bridge.
 *
 * It reads retained v3/v4 encrypted history using only private keys already in
 * IndexedDB. It never creates or publishes a device and leaves the legacy
 * writer untouched. The R178 chat module installs it before constructing the
 * app so old history remains readable after a room moves to v4-required.
 */
(() => {
  'use strict';
  const BUILD = '20260905r183-late-device-delivery1';
  const V3 = 'liber.secure-chat.message-envelope.v3';
  const V4 = 'liber.secure-chat.message-envelope.v4';
  const PAYLOAD = 'liber.secure-chat.payload.v1';

  async function sha256Hex(value){
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function envelopeDocId(uid, deviceId){
    return `env_${await sha256Hex(`${String(uid || '')}|${String(deviceId || '')}`)}`;
  }
  function compatError(code, message){
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function storagePath(fileUrl){
    const direct = /^storage:\/\/(.+)$/i.exec(String(fileUrl || '').trim());
    if (direct?.[1]) { try { return decodeURIComponent(direct[1]); } catch (_) { return direct[1]; } }
    const firebaseUrl = /\/o\/([^?#]+)/i.exec(String(fileUrl || '').trim());
    if (firebaseUrl?.[1]) { try { return decodeURIComponent(firebaseUrl[1]); } catch (_) { return firebaseUrl[1]; } }
    return '';
  }

  window.installR178ChatReadCompatibility = function installR178ChatReadCompatibility(prototype){
    if (!prototype || prototype.__r178ReadCompatibilityInstalled) return;
    prototype.__r178ReadCompatibilityInstalled = true;
    const legacyGetMessageKey = prototype.getMessageDecryptionKeyForConn;

    // Complete delivery only from the original sender device to a UID that was
    // already addressed by this immutable direct message. No history rotation,
    // server plaintext, new participants, or replacement envelopes.
    prototype.r183RecoverLateDeviceEnvelopes = async function(messages, connId, owns = ()=>true){
      const fb = window.firebase, cc = window.chatCrypto;
      const user = this.currentUser, service = window.firebaseService;
      const auth = service?.auth, authUser = auth?.currentUser, revision = service?._authStateRevision;
      const uid = String(user?.uid || ''), cid = String(connId || '');
      const current = ()=> owns() && !this._authSessionRetired && this.currentUser === user
        && window.firebase === fb && window.firebaseService === service && service?.auth === auth
        && auth?.currentUser === authUser && authUser?.uid === uid
        && service?._authStateRevision === revision;
      const direct = room => room && room.cryptoMode === 'v4-required'
        && !room.projectId && room.type !== 'project' && room.type !== 'group' && !room.groupName
        && Array.isArray(room.participantIds) && room.participantIds.length === 2
        && new Set(room.participantIds).size === 2 && room.participantIds.includes(uid)
        && [...room.participantIds].sort().join('|') === cid;
      const result = { created:0 };
      if (!uid || !current()) return result;
      const room = await this._getLiveConnectionForCrypto(cid);
      if (!current() || !direct(room)) return result;
      const devices = await this._registeredV4DevicesForParticipants(room);
      const local = await cc.listStoredDeviceIdentities(uid, 8);
      if (!current()) return result;
      const parents = messages.filter(m=>m?.cryptoVersion === V4 && m.sender === uid && m.connId === cid).slice(0,50);
      for (const candidate of parents){
        if (!current()) break;
        const original = local.find(d=>d.deviceId === candidate.senderDeviceId && d.fingerprint === candidate.senderFingerprint);
        const published = devices.find(d=>d.uid === uid && d.deviceId === candidate.senderDeviceId && d.fingerprint === candidate.senderFingerprint);
        if (!original?.privateKey || !published?.publicJwk) continue;
        const parentRef = fb.doc(this.db,'chatMessages',cid,'messages',candidate.id);
        const parentSnap = await fb.getDoc(parentRef);
        if (!current() || !parentSnap.exists()) continue;
        const parent = parentSnap.data();
        const context = `${cid}|${candidate.id}|${V4}`;
        const bound = m => m && m.id === candidate.id && m.connId === cid && m.sender === uid
          && m.cryptoVersion === V4 && m.senderDeviceId === original.deviceId
          && m.senderFingerprint === original.fingerprint && m.messageEnvelopeContext === context;
        if (!bound(parent)) continue;
        const envelopes = await fb.getDocs(fb.query(fb.collection(this.db,'chatMessages',cid,'messages',candidate.id,'keyEnvelopes'),fb.limit(20)));
        if (!current() || envelopes.docs.length >= 20) continue;
        const rows = envelopes.docs.map(d=>d.data());
        const valid = e => e.schema === 'liber.secure-chat.key-envelope.v4' && e.connId === cid
          && e.messageId === candidate.id && e.wrapperUid === uid
          && e.wrapperDeviceId === original.deviceId && e.wrapperFingerprint === original.fingerprint;
        const ownEnvelope = rows.find(e=>valid(e) && e.recipientUid === uid
          && e.recipientDeviceId === original.deviceId && e.recipientFingerprint === original.fingerprint);
        if (!ownEnvelope) continue;
        const addressed = new Set(rows.filter(valid).map(e=>e.recipientUid));
        const missing = devices.filter(d=>room.participantIds.includes(d.uid) && addressed.has(d.uid)
          && !rows.some(e=>e.recipientUid === d.uid && e.recipientDeviceId === d.deviceId));
        if (!missing.length) continue;
        const key = await cc.unwrapMessageAesKeyV4(ownEnvelope.wrappedKey, original.privateKey, published.publicJwk, context, true);
        for (const recipient of missing){
          if (!current()) break;
          const wrappingKey = await cc.deriveSharedAesKey(original.privateKey,recipient.publicJwk,`message-envelope-v4|${context}`);
          const wrappedKey = await cc.wrapGroupAesKey(key,wrappingKey);
          const id = await this._v4EnvelopeDocId(recipient.uid,recipient.deviceId);
          const ref = fb.doc(this.db,'chatMessages',cid,'messages',candidate.id,'keyEnvelopes',id);
          if (!current()) break;
          const created = await fb.runTransaction(this.db, async tx=>{
            const latest = await tx.get(parentRef);
            const latestRoom = await tx.get(fb.doc(this.db,'chatConnections',cid));
            const existing = await tx.get(ref);
            if (!current() || existing.exists() || !latest.exists() || !latestRoom.exists()
              || !direct(latestRoom.data()) || !bound(latest.data())
              || latestRoom.data().cryptoMembershipDigest !== room.cryptoMembershipDigest
              || JSON.stringify(latest.data().cipher) !== JSON.stringify(parent.cipher)) return false;
            tx.set(ref, {schema:'liber.secure-chat.key-envelope.v4',connId:cid,messageId:candidate.id,
              recipientUid:recipient.uid,recipientKind:'v4-device',recipientDeviceId:recipient.deviceId,
              recipientFingerprint:recipient.fingerprint,wrapperUid:uid,wrapperDeviceId:original.deviceId,
              wrapperFingerprint:original.fingerprint,wrapperPublicJwk:published.publicJwk,wrappedKey,
              createdAt:new Date().toISOString()});
            return true;
          });
          if (created) result.created++;
        }
      }
      return result;
    };

    prototype.r183StopDeliveryRecovery = function(){
      const state = this._r183Delivery;
      if (!state) return;
      state.retired = true;
      clearTimeout(state.timer);
      state.watches.forEach(stop=>{ try{ stop(); }catch(_){} });
      this._r183Delivery = null;
    };
    prototype.r183DeliveryState = function(cid){
      if (this._r183Delivery?.cid !== cid || this._r183Delivery?.user !== this.currentUser) this.r183StopDeliveryRecovery();
      return this._r183Delivery ||= {cid,user:this.currentUser,service:window.firebaseService,auth:window.firebaseService?.auth,
        authUser:window.firebaseService?.auth?.currentUser,revision:window.firebaseService?._authStateRevision,
        seq:this._setActiveSeq,rows:[],watches:new Map(),lastSignature:'',roomRevision:'',retired:false};
    };
    prototype.r183QueueDeliveryRecovery = function(rows,cid){
      const state = this.r183DeliveryState(cid);
      if (rows) state.rows = rows.map(d=>({...((typeof d.data === 'function' ? d.data() : d.data) || d),id:d.id,connId:cid})).filter(m=>m.sender === state.user?.uid && m.cryptoVersion === V4).slice(0,50);
      const signature = state.roomRevision + ':' + state.rows.map(m=>m.id).join('|');
      if (!state.rows.length || signature === state.lastSignature || state.running || state.timer) return;
      const owns = ()=>!state.retired && this._r183Delivery === state && this.activeConnection === cid && this._setActiveSeq === state.seq;
      state.timer = setTimeout(async()=>{
        state.timer = null;
        if (!owns()) return;
        state.running = true; state.lastSignature = signature;
        try { await this.r183RecoverLateDeviceEnvelopes(state.rows,cid,owns); }
        catch(error){ console.warn('Secure delivery recovery paused:', error?.code || 'temporarily-unavailable'); }
        finally { state.running = false; if (owns()) this.r183QueueDeliveryRecovery(null,cid); }
      },100);
    };
    prototype.r183ObserveDeliveryRoom = function(cid,room){
      if (this.activeConnection !== cid) return;
      const state = this.r183DeliveryState(cid);
      state.roomRevision = JSON.stringify([room.cryptoMode,room.cryptoMembershipDigest,room.cryptoModeUpdatedAt,room.secureDeliveryRequestedAt]);
      this.r183QueueDeliveryRecovery(null,cid);
    };
    prototype.r183WatchMissingEnvelope = async function(message,cid){
      if (message?.cryptoVersion !== V4 || this.activeConnection !== cid) return;
      const state = this.r183DeliveryState(cid), uid = state.user?.uid;
      const owns = ()=> !state.retired && this._r183Delivery === state && this.currentUser === state.user
        && this.activeConnection === cid && this._setActiveSeq === state.seq && !this._authSessionRetired
        && window.firebaseService === state.service && state.service?.auth === state.auth
        && state.auth?.currentUser === state.authUser && state.authUser?.uid === uid
        && state.service?._authStateRevision === state.revision;
      const identity = await window.chatCrypto.loadStoredDeviceIdentity(uid).catch(()=>null);
      if (!identity || !owns() || state.watches.size >= 8) return;
      const mid = message.id, slot = `${cid}|${mid}`;
      if (!mid || state.watches.has(slot)) return;
      state.watches.set(slot,()=>{});
      const id = await envelopeDocId(uid,identity.deviceId);
      if (!owns()) { state.watches.delete(slot); return; }
      const ref = window.firebase.doc(this.db,'chatMessages',cid,'messages',mid,'keyEnvelopes',id);
      let resolved = false;
      const stop = window.firebase.onSnapshot(ref,async snap=>{
        if (!snap.exists() || !owns()) return;
        if (resolved) return;
        resolved = true;
        state.watches.get(slot)?.(); state.watches.delete(slot);
        try {
          const key = await this.r178V4MessageKey(message,cid);
          await window.chatCrypto.decryptWithKey(message.cipher,key);
          if (!owns()) return;
          this._lastRenderSigByConn?.delete(cid); this._lastDocIdsByConn?.delete(cid);
          const box = document.getElementById('messages');
          if (box?.dataset.renderedConnId === cid) box.dataset.renderedConnId = '';
          this.loadMessages().catch(()=>{});
        }catch(_){}
      },()=>{state.watches.get(slot)?.();state.watches.delete(slot);});
      if (resolved) stop(); else state.watches.set(slot,stop);
      // One wake-up per active conversation, not polling or per-message retries.
      // This timestamp grants no authority; the sender still checks the original
      // message recipients, exact original key and live membership transaction.
      if (!state.requested && owns()){
        state.requested = true;
        window.firebase.updateDoc(window.firebase.doc(this.db,'chatConnections',cid),{
          secureDeliveryRequestedAt:window.firebase.serverTimestamp()
        }).catch(()=>{});
      }
    };

    prototype.normalizeDecryptedMessageText = function(message, plaintext){
      const raw = String(plaintext ?? '');
      if (message?.cryptoVersion !== V4 || !raw.startsWith('{')) return raw;
      try{
        const payload = JSON.parse(raw);
        if (payload?.schema !== PAYLOAD) return raw;
        if (payload.systemType === 'connection_request_intro') message.systemType = payload.systemType;
        if (payload.sharedAsset && typeof payload.sharedAsset === 'object') message.sharedAsset = payload.sharedAsset;
        if (payload.replyTo && typeof payload.replyTo === 'object') message.replyTo = payload.replyTo;
        const attachmentFields = ['fileUrl','fileName','attachmentSourceConnId','attachmentCryptoVersion','isVideoRecording','isVoiceRecording'];
        const attachment = value => {
          const result = {};
          for (const field of attachmentFields) if (value?.[field] != null) result[field] = value[field];
          return result;
        };
        if (payload.fileUrl) Object.assign(message, attachment(payload));
        if (Array.isArray(payload.media)) message.media = payload.media.slice(0,16).map(attachment);
        if (payload.shareMeta && typeof payload.shareMeta === 'object') {
          for (const field of ['isShared','sharedFromConnId','sharedFromMessageId','sharedOriginalAuthorUid','sharedOriginalAuthorName']) {
            if (payload.shareMeta[field] != null) message[field] = payload.shareMeta[field];
          }
        }
        return String(payload.text || '');
      }catch(_){ return raw; }
    };

    prototype.getDecryptionFailureText = function(error){
      if (error?.code === 'liber/chat-envelope-pending') return '[secure delivery pending]';
      if (error?.code === 'liber/chat-device-not-in-envelope'
        || error?.code === 'liber/chat-device-identity-missing'
        || error?.code === 'liber/chat-legacy-private-key-missing'
        || error?.code === 'liber/chat-legacy-history-key-unavailable') {
        return '[encrypted history key unavailable on this device]';
      }
      return '[unable to decrypt]';
    };

    prototype.r178V4MessageKey = async function(message, connId){
      const firebase = window.firebase;
      const chatCrypto = window.chatCrypto;
      const uid = String(this.currentUser?.uid || '').trim();
      const cid = String(connId || message?.connId || '').trim();
      const mid = String(message?.id || message?.messageId || '').trim();
      if (!uid) throw compatError('unauthenticated', 'Sign in to decrypt this message.');
      if (!cid || !mid) throw compatError('liber/chat-envelope-context-missing', 'Encrypted message identity is incomplete.');
      this._r178MessageKeyCache ||= new Map();
      const cacheKey = `${cid}|${mid}|v4`;
      if (this._r178MessageKeyCache.has(cacheKey)) return this._r178MessageKeyCache.get(cacheKey);
      const task = (async()=>{
        const expectedContext = `${cid}|${mid}|${V4}`;
        const senderUid = String(message?.sender || '').trim();
        const senderDeviceId = String(message?.senderDeviceId || '').trim();
        const senderFingerprint = String(message?.senderFingerprint || '').trim();
        if (!senderUid || !senderDeviceId || !senderFingerprint
          || String(message?.messageEnvelopeContext || '') !== expectedContext){
          throw compatError('liber/chat-envelope-parent-invalid', 'Encrypted message metadata does not bind this device envelope to its parent message.');
        }
        const identities = await chatCrypto.listStoredDeviceIdentities(uid, 8);
        // A pending direct room can issue a one-time bridge envelope to the
        // immutable legacy root while the recipient's first v4 device is still
        // being created. Read it only if this browser already retains that key.
        const identityCandidates = identities.slice();
        try{
          const legacy = await chatCrypto.loadExistingLegacyIdentity(uid);
          if (legacy?.privateKey && legacy?.publicJwk){
            const fingerprint = await chatCrypto.fingerprintPublicJwk(legacy.publicJwk);
            if (fingerprint) identityCandidates.push({
              ...legacy,
              deviceId:'legacy-v2',
              fingerprint,
              legacyRoot:true
            });
          }
        }catch(_){ }
        if (!identityCandidates.length) throw compatError('liber/chat-device-identity-missing', 'This browser has no retained device identity for this encrypted history.');
        const reads = identityCandidates.map(async(device)=>{
          const id = await envelopeDocId(uid, device.deviceId);
          const ref = firebase.doc(this.db, 'chatMessages', cid, 'messages', mid, 'keyEnvelopes', id);
          const snapshot = await firebase.getDoc(ref);
          return snapshot.exists() ? { device, envelope:snapshot.data() || {} } : null;
        });
        const candidates = (await Promise.allSettled(reads))
          .filter(row=>row.status === 'fulfilled' && row.value).map(row=>row.value);
        if (!candidates.length) throw compatError('liber/chat-device-not-in-envelope', 'No secure envelope exists for a private key retained on this browser.');
        let lastError = null;
        for (const candidate of candidates){
          const { device, envelope } = candidate;
          try{
            if (envelope.schema !== 'liber.secure-chat.key-envelope.v4'
              || envelope.connId !== cid || envelope.messageId !== mid
              || envelope.recipientUid !== uid || envelope.recipientDeviceId !== device.deviceId
              || (device.legacyRoot
                ? String(envelope.recipientKind || '') !== 'legacy-root'
                : (envelope.recipientKind != null && String(envelope.recipientKind || '') !== 'v4-device'))
              || String(envelope.recipientFingerprint || '') !== String(device.fingerprint || '')
              || String(envelope.wrapperUid || '') !== senderUid
              || String(envelope.wrapperDeviceId || '') !== senderDeviceId
              || String(envelope.wrapperFingerprint || '') !== senderFingerprint
              || !envelope.wrapperPublicJwk || !envelope.wrappedKey){
              throw compatError('liber/chat-envelope-invalid', 'Encrypted message envelope does not match this retained device identity.');
            }
            const wrapperFingerprint = await chatCrypto.fingerprintPublicJwk(envelope.wrapperPublicJwk);
            if (wrapperFingerprint !== senderFingerprint){
              throw compatError('liber/chat-envelope-fingerprint', 'Encrypted message wrapper fingerprint is invalid.');
            }
            const pinKey = `liber_secure_chat_peer_device_pin_v4:${uid}:${String(envelope.wrapperUid || '')}:${String(envelope.wrapperDeviceId || '')}`;
            const pinned = String(localStorage.getItem(pinKey) || '').trim();
            if (pinned && pinned !== wrapperFingerprint){
              throw compatError('liber/chat-device-pin-changed', 'The sender device identity changed. Verify it before continuing.');
            }
            if (!pinned) localStorage.setItem(pinKey, wrapperFingerprint);
            return await chatCrypto.unwrapMessageAesKeyV4(envelope.wrappedKey, device.privateKey, envelope.wrapperPublicJwk, expectedContext);
          }catch(error){ lastError = error; }
        }
        throw lastError || compatError('liber/chat-device-not-in-envelope', 'No retained device identity can decrypt this message.');
      })();
      this._r178MessageKeyCache.set(cacheKey, task);
      try{ return await task; }
      catch(error){
        // A temporary offline/permission/envelope read failure must be retried
        // when the message renders again instead of poisoning this tab's cache.
        if (this._r178MessageKeyCache.get(cacheKey) === task) this._r178MessageKeyCache.delete(cacheKey);
        throw error;
      }
    };

    prototype.r178V3MessageKey = async function(message, connId){
      const chatCrypto = window.chatCrypto;
      const uid = String(this.currentUser?.uid || '').trim();
      if (!uid) throw compatError('unauthenticated', 'Sign in to decrypt this message.');
      const envelopes = Array.isArray(message?.messageKeyEnvelopes) ? message.messageKeyEnvelopes : [];
      const cid = String(connId || message?.connId || '').trim();
      const mid = String(message?.id || message?.messageId || '').trim();
      const context = String(message?.messageEnvelopeContext || `${cid}|${mid}`);
      const identities = await chatCrypto.listStoredDeviceIdentities(uid, 8);
      for (const device of identities){
        const envelope = envelopes.find(row => String(row?.recipientUid || '') === uid && String(row?.recipientDeviceId || '') === String(device.deviceId));
        if (!envelope?.senderPublicJwk || !envelope?.wrappedKey) continue;
        try{ return await chatCrypto.unwrapMessageAesKey(envelope.wrappedKey, device.privateKey, envelope.senderPublicJwk, context); }catch(_){ }
      }
      const legacyEnvelope = envelopes.find(row => String(row?.recipientUid || '') === uid && String(row?.recipientDeviceId || '') === 'legacy-v2');
      const legacy = legacyEnvelope ? await chatCrypto.loadExistingLegacyIdentity(uid) : null;
      if (legacyEnvelope?.senderPublicJwk && legacyEnvelope?.wrappedKey && legacy?.privateKey){
        return chatCrypto.unwrapMessageAesKey(legacyEnvelope.wrappedKey, legacy.privateKey, legacyEnvelope.senderPublicJwk, context);
      }
      throw compatError('liber/chat-device-not-in-envelope', 'This encrypted message was not issued to any private key retained on this browser.');
    };

    prototype.getMessageDecryptionKeyForConn = async function(message, connId){
      const version = String(message?.cryptoVersion || message?.attachmentCryptoVersion || '');
      if (version === V4) return this.r178V4MessageKey(message, connId);
      if (version === V3) return this.r178V3MessageKey(message, connId);
      return legacyGetMessageKey.call(this, message, connId);
    };

    prototype.r178ValidateV4AttachmentContext = function(message, fileUrl, sourceConnId){
      const version = String(message?.attachmentCryptoVersion || message?.cryptoVersion || '');
      if (version !== V4) return;
      const messageId = String(message?.id || message?.messageId || '').trim();
      const connectionId = String(message?.attachmentSourceConnId || message?.connId || sourceConnId || '').trim();
      const senderUid = String(message?.sender || '').trim();
      const path = storagePath(fileUrl);
      const prefix = senderUid && connectionId && messageId ? `chat-v4/${senderUid}/${connectionId}/${messageId}/` : '';
      const currentPrefix = senderUid && connectionId && messageId ? `chat/${connectionId}/v4/${senderUid}/${messageId}/` : '';
      if (!prefix || (!path.startsWith(prefix) && !path.startsWith(currentPrefix)) || !path.endsWith('.enc.json')){
        throw compatError('liber/chat-attachment-context-mismatch', 'Encrypted attachment does not match its message context.');
      }
    };

    window.__liberR178ChatReadCompatibility = Object.freeze({
      build:BUILD,
      installed:true,
      legacyWriterPreserved:true,
      v3Read:true,
      v4Read:true,
      deviceIdentityWrites:false,
      serverWrites:false
    });
    console.log('[LIBER Secure Chat] read compatibility ' + BUILD, window.__liberR178ChatReadCompatibility);
  };
})();
