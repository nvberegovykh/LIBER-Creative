/* LIBER Specifications — data layer
 * Firestore-backed when running inside the Liber Apps shell; localStorage
 * fallback (with cross-tab realtime) when standalone/offline.
 *
 * Collections
 *   specProjects/{sid}                     project header + membership
 *   specProjects/{sid}/sections/{secId}    CSI sections (one per schedule by default)
 *   specProjects/{sid}/items/{key}         spec items (key = source fingerprint)
 *   specProjects/{sid}/sources/{srcId}     sync sources (upload / gsheet / revit / atlantist)
 *   specProjects/{sid}/inbox/{id}          queued links from the browser extension
 */
(function (root) {
  'use strict';

  /* ---------- platform bridge ---------- */
  /* The app runs in an iframe while firebaseService/the Firestore SDK live in the shell
   * (a different JS realm). Firestore validates payloads with its OWN Object.prototype,
   * so an object literal built here is rejected as "a custom Object object". Every write
   * is therefore re-created in the SDK's realm via realm.JSON.parse — see plain(). */
  let REALM = (typeof window !== 'undefined') ? window : null;

  function getFS() {
    try {
      for (const w of [window, window.parent, window.top].filter(Boolean)) {
        if (w.firebaseService && w.firebaseService.isInitialized) { REALM = w; return w.firebaseService; }
      }
    } catch (_) {}
    return (typeof window !== 'undefined' && window.firebaseService) || null;
  }
  function getApi(fs) {
    try {
      if (fs && fs.firebase && typeof fs.firebase.collection === 'function') return fs.firebase;
      for (const w of [window, window.parent, window.top].filter(Boolean)) {
        if (w.firebase && typeof w.firebase.collection === 'function') { REALM = w; return w.firebase; }
      }
    } catch (_) {}
    return null;
  }

  /** Rebuild a payload inside the SDK's realm; also strips undefined and functions. */
  function plain(v) {
    let json;
    try { json = JSON.stringify(v === undefined ? null : v); } catch (_) { return v; }
    try { return (REALM && REALM.JSON ? REALM.JSON : JSON).parse(json); } catch (_) { return JSON.parse(json); }
  }

  const uid4 = () => 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const nowISO = () => new Date().toISOString();

  /* ---------- local fallback ---------- */
  const LKEY = 'liber.spec.v1';
  const bc = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('liber-spec') : null;

  const Local = {
    read() { try { return JSON.parse(localStorage.getItem(LKEY) || '{}'); } catch (_) { return {}; } },
    write(db) { localStorage.setItem(LKEY, JSON.stringify(db)); if (bc) bc.postMessage({ t: 'change' }); window.dispatchEvent(new Event('liber-spec-change')); },
    listeners: [],
    onChange(fn) {
      Local.listeners.push(fn);
      const h = () => fn();
      window.addEventListener('liber-spec-change', h);
      window.addEventListener('storage', h);
      if (bc) bc.addEventListener('message', h);
      return () => { window.removeEventListener('liber-spec-change', h); window.removeEventListener('storage', h); if (bc) bc.removeEventListener('message', h); };
    }
  };

  /* ---------- store ---------- */
  const Store = {
    mode: 'local',
    fs: null, api: null, db: null,
    user: null,

    async init() {
      this.fs = getFS();
      this.api = getApi(this.fs);
      if (this.fs && this.api && this.fs.db) {
        this.db = (this.api.firestore && this.fs.app) ? this.api.firestore(this.fs.app) : this.fs.db;
        this.mode = 'cloud';
        this.user = this.fs.auth && this.fs.auth.currentUser
          ? { uid: this.fs.auth.currentUser.uid, email: this.fs.auth.currentUser.email, name: this.fs.auth.currentUser.displayName }
          : null;
        if (!this.user) { // wait briefly for auth to settle
          await new Promise((res) => {
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; res(); } }, 2500);
            try {
              this.api.onAuthStateChanged(this.fs.auth, (u) => {
                if (u) this.user = { uid: u.uid, email: u.email, name: u.displayName };
                if (!done) { done = true; clearTimeout(t); res(); }
              });
            } catch (_) { clearTimeout(t); res(); }
          });
        }
        if (!this.user) this.mode = 'local'; // signed out → keep working locally
      }
      return this.mode;
    },

    isCloud() { return this.mode === 'cloud'; },
    me() { return this.user || { uid: 'local', email: 'local@device', name: 'Local user' }; },

    captureProjectListOwner() {
      const store = this, mode = this.mode, fs = this.fs, auth = fs?.auth;
      const user = this.user, authUser = auth?.currentUser, revision = fs?._authStateRevision;
      const api = this.api, db = this.db, service = getFS(), uid = user?.uid, authUid = authUser?.uid;
      const isCurrent = () => store.mode === mode && store.fs === fs && fs?.auth === auth
        && store.user === user && auth?.currentUser === authUser && fs?._authStateRevision === revision
        && store.api === api && store.db === db && getFS() === service
        && store.user?.uid === uid && auth?.currentUser?.uid === authUid;
      return { isCurrent, assertCurrent() {
        if (!isCurrent() || (mode === 'cloud' && (!uid || uid !== authUid)))
          throw new Error('Sign-in changed while loading specification projects. Please retry.');
      } };
    },

    // Cross-realm Firestore write boundary. Prefer firebaseService wrappers because
    // those functions execute in the same realm as the modular Firebase SDK.
    async _setDoc(ref, data, options = null) {
      if (this.fs && typeof this.fs.setDocPlain === 'function') return this.fs.setDocPlain(ref, data, options);
      if (options == null) return this.api.setDoc(ref, plain(data));
      return this.api.setDoc(ref, plain(data), plain(options));
    },
    async _addDoc(ref, data) {
      if (this.fs && typeof this.fs.addDocPlain === 'function') return this.fs.addDocPlain(ref, data);
      return this.api.addDoc(ref, plain(data));
    },
    async _updateDoc(ref, data) {
      if (this.fs && typeof this.fs.updateDocPlain === 'function') return this.fs.updateDocPlain(ref, data);
      return this.api.updateDoc(ref, plain(data));
    },
    async _uploadBytes(ref, file, metadata = null) {
      if (this.fs && typeof this.fs.uploadBytesPlain === 'function') return this.fs.uploadBytesPlain(ref, file, metadata);
      if (metadata == null) return this.api.uploadBytes(ref, file);
      return this.api.uploadBytes(ref, file, plain(metadata));
    },

    /* ----- projects ----- */
    async listProjects() {
      const owner = this.captureProjectListOwner();
      if (!this.isCloud()) {
        const db = Local.read();
        return Object.values(db.projects || {}).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      }
      const f = this.api, me = this.me();
      const out = new Map();
      const current = owner.assertCurrent;
      const grab = async (q) => { current(); const s = await f.getDocs(q); current(); s.forEach((d) => out.set(d.id, { id: d.id, ...d.data() })); };
      // Standalone books keep their own ACL. Linked books are discovered only
      // through currently authorized parent projects, never copied stale ACLs.
      await grab(f.query(f.collection(this.db, 'specProjects'), f.where('linkedProjectId', '==', null), f.where('ownerId', '==', me.uid), f.limit(100)));
      await grab(f.query(f.collection(this.db, 'specProjects'), f.where('linkedProjectId', '==', null), f.where('memberIds', 'array-contains', me.uid), f.limit(100)));
      const parents = [...new Set((await this.listTrackerProjects()).map(p => p.id))];
      current();
      // Retain existing per-query limits; at most four reads are in flight.
      for (let i = 0; i < parents.length; i += 4) {
        await Promise.all(parents.slice(i, i + 4).map(id => grab(f.query(f.collection(this.db, 'specProjects'), f.where('linkedProjectId', '==', id), f.limit(100)))));
      }
      current();
      return [...out.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    },

    /** Projects from Project Tracker available to link. */
    async listTrackerProjects() {
      if (!this.isCloud()) return [];
      const owner = this.captureProjectListOwner();
      const f = this.api, me = this.me(), out = new Map();
      const current = owner.assertCurrent;
      const grab = async (q) => { current(); const s = await f.getDocs(q); current(); s.forEach((d) => out.set(d.id, { id: d.id, ...d.data() })); };
      await grab(f.query(f.collection(this.db, 'projects'), f.where('ownerId', '==', me.uid), f.limit(50)));
      await grab(f.query(f.collection(this.db, 'projects'), f.where('memberIds', 'array-contains', me.uid), f.limit(50)));
      return [...out.values()];
    },

    async createProject({ name, code, linkedProjectId }) {
      const me = this.me();
      let memberIds = [];
      let linked = null;
      if (linkedProjectId && this.isCloud()) {
        try {
          const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', linkedProjectId));
          if (snap.exists()) {
            const p = snap.data();
            linked = { id: linkedProjectId, name: p.name || p.title || '' };
            memberIds = Array.from(new Set([...(p.memberIds || []), p.ownerId].filter(Boolean)));
          }
        } catch (_) {}
      }
      const data = {
        name: name || 'Project Specifications',
        code: code || '',
        linkedProjectId: linkedProjectId || null,
        linkedProjectName: linked ? linked.name : '',
        ownerId: me.uid,
        memberIds,
        settings: { divisionPerSchedule: true, showEmptyArticles: false },
        createdAt: nowISO(), updatedAt: nowISO()
      };
      if (!this.isCloud()) {
        const db = Local.read(); db.projects = db.projects || {};
        const id = uid4(); db.projects[id] = { id, ...data }; Local.write(db); return id;
      }
      const ref = await this._addDoc(this.api.collection(this.db, 'specProjects'), data);
      return ref.id;
    },

    async updateProject(sid, patch) {
      patch = { ...patch, updatedAt: nowISO() };
      if (!this.isCloud()) { const db = Local.read(); Object.assign(db.projects[sid], patch); Local.write(db); return; }
      await this._updateDoc(this.api.doc(this.db, 'specProjects', sid), patch);
    },

    async deleteProject(sid) {
      if (!this.isCloud()) { const db = Local.read(); delete db.projects[sid]; delete (db.sections || {})[sid]; delete (db.items || {})[sid]; Local.write(db); return; }
      for (const sub of ['sections', 'items', 'sources', 'inbox', 'history']) {
        try {
          const s = await this.api.getDocs(this.api.collection(this.db, 'specProjects', sid, sub));
          await Promise.all(s.docs.map((d) => this.api.deleteDoc(d.ref)));
        } catch (_) {}
      }
      await this.api.deleteDoc(this.api.doc(this.db, 'specProjects', sid));
    },

    async getProject(sid) {
      if (!this.isCloud()) return (Local.read().projects || {})[sid] || null;
      const s = await this.api.getDoc(this.api.doc(this.db, 'specProjects', sid));
      return s.exists() ? { id: s.id, ...s.data() } : null;
    },

    /* ----- generic subcollection helpers ----- */
    _localBucket(kind, sid) { const db = Local.read(); db[kind] = db[kind] || {}; db[kind][sid] = db[kind][sid] || {}; return { db, bucket: db[kind][sid] }; },

    async setDocIn(kind, sid, id, data, merge = true) {
      if (!this.isCloud()) {
        const { db, bucket } = this._localBucket(kind, sid);
        bucket[id] = merge ? { ...(bucket[id] || {}), ...data, id } : { ...data, id };
        Local.write(db); return id;
      }
      await this._setDoc(this.api.doc(this.db, 'specProjects', sid, kind, id), data, { merge });
      return id;
    },

    async addDocIn(kind, sid, data) {
      if (!this.isCloud()) { const id = uid4(); await this.setDocIn(kind, sid, id, data, false); return id; }
      const ref = await this._addDoc(this.api.collection(this.db, 'specProjects', sid, kind), data);
      return ref.id;
    },

    async deleteDocIn(kind, sid, id) {
      if (!this.isCloud()) { const { db, bucket } = this._localBucket(kind, sid); delete bucket[id]; Local.write(db); return; }
      await this.api.deleteDoc(this.api.doc(this.db, 'specProjects', sid, kind, id));
    },

    async listIn(kind, sid) {
      if (!this.isCloud()) { const { bucket } = this._localBucket(kind, sid); return Object.values(bucket); }
      const s = await this.api.getDocs(this.api.collection(this.db, 'specProjects', sid, kind));
      return s.docs.map((d) => ({ id: d.id, ...d.data() }));
    },

    /** Realtime subscription. cb(list). Returns unsubscribe. */
    subscribe(kind, sid, cb, onError = () => {}) {
      if (!this.isCloud()) {
        const emit = () => cb(Object.values(this._localBucket(kind, sid).bucket));
        emit();
        return Local.onChange(emit);
      }
      try {
        const collection = this.api.collection(this.db, 'specProjects', sid, kind);
        const target = kind === 'history' ? this.api.query(collection, this.api.orderBy('at', 'desc'), this.api.limit(this.HISTORY_MAX)) : collection;
        return this.api.onSnapshot(target, (snap) => {
          cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        }, (e) => { console.warn('subscribe ' + kind, e); onError(e); });
      } catch (e) { console.warn(e); onError(e); return () => {}; }
    },

    subscribeProject(sid, cb, onError = () => {}) {
      if (!this.isCloud()) { const emit = () => cb((Local.read().projects || {})[sid]); emit(); return Local.onChange(emit); }
      try {
        return this.api.onSnapshot(this.api.doc(this.db, 'specProjects', sid), (d) => cb(d.exists() ? { id: d.id, ...d.data() } : null), onError);
      } catch (e) { onError(e); return () => {}; }
    },

    /* ----- media (images in cells) -----
     * Uploads to Firebase Storage under specs/{sid}/{uid}/... and returns a download URL.
     * Falls back to an inline data URL when Storage is unavailable or rejects the write,
     * so images keep working in local mode and for members without Storage access. */
    async uploadImage(sid, file, keyHint) {
      const asData = () => new Promise((res, rej) => {
        if (file.size > 700 * 1024) return rej(new Error('too large to inline (max 700 KB without Storage)'));
        const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file);
      });
      if (!this.isCloud() || !this.fs || !this.fs.storage || !this.api.ref) return { url: await asData(), name: file.name, inline: true };
      try {
        const uidPart = this.me().uid;
        const safe = String(file.name || 'image').replace(/[^\w.\-]+/g, '_').slice(-60);
        const path = `specs/${sid}/${uidPart}/${keyHint || 'item'}/${Date.now()}_${safe}`;
        const ref = this.api.ref(this.fs.storage, path);
        await this._uploadBytes(ref, file, { contentType: file.type || 'image/jpeg' });
        return { url: await this.api.getDownloadURL(ref), name: file.name, path };
      } catch (e) {
        console.warn('storage upload failed, inlining', e);
        return { url: await asData(), name: file.name, inline: true, uploadError: String(e && e.message || e) };
      }
    },

    /* ----- durable edit history; the recent undo view is bounded ----- */
    HISTORY_MAX: 50,

    /** Record one reversible edit. ops: [{kind,id,before,after}] */
    async logEdit(sid, entry) {
      const rec = { at: nowISO(), by: this.me().uid, byName: this.me().name || this.me().email || 'user', undone: false, ...entry };
      const id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await this.setDocIn('history', sid, id, rec, false);
      return id;
    },

    async _trimHistory(sid) {
      // Kept for older callers. Pruning the undo view must never erase audit evidence.
    },

    async listHistory(sid) {
      const all = await this.listIn('history', sid);
      return all.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, this.HISTORY_MAX);
    },

    /** Batched writes with graceful local fallback. */
    async bulkSet(kind, sid, records, options = {}) {
      const owner = this.captureProjectListOwner();
      const current = () => { owner.assertCurrent(); options.assertCurrent?.(); };
      const chunk = 150;
      for (let i = 0; i < records.length; i += chunk) {
        current();
        const rows = records.slice(i, i + chunk);
        if (this.isCloud() && typeof this.api.writeBatch === 'function') {
          const batch = this.api.writeBatch(this.db);
          rows.forEach(r => {
            const data = plain(r.data);
            // Source maps replace their previous columns; other document fields stay intact.
            batch.set(this.api.doc(this.db, 'specProjects', sid, kind, r.id), data, plain({ mergeFields: Object.keys(data) }));
          });
          current();
          await batch.commit();
        } else if (!this.isCloud()) {
          const { db, bucket } = this._localBucket(kind, sid);
          rows.forEach(r => { bucket[r.id] = { ...(bucket[r.id] || {}), ...r.data, id: r.id }; });
          current();
          Local.write(db);
        } else {
          // Compatibility with older shells, with bounded write concurrency.
          for (let j = 0; j < rows.length; j += 8) {
            current();
            await Promise.all(rows.slice(j, j + 8).map(r => {
              const data = plain(r.data);
              return this._setDoc(this.api.doc(this.db, 'specProjects', sid, kind, r.id), data, { mergeFields: Object.keys(data) });
            }));
          }
        }
        current();
      }
    }
  };

  root.SpecStore = Store;
})(typeof window !== 'undefined' ? window : globalThis);
