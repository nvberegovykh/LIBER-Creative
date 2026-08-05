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

    /* ----- projects ----- */
    async listProjects() {
      if (!this.isCloud()) {
        const db = Local.read();
        return Object.values(db.projects || {}).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      }
      const f = this.api, me = this.me();
      const out = new Map();
      const grab = async (q) => { const s = await f.getDocs(q); s.forEach((d) => out.set(d.id, { id: d.id, ...d.data() })); };
      try { await grab(f.query(f.collection(this.db, 'specProjects'), f.where('ownerId', '==', me.uid), f.limit(100))); } catch (_) {}
      try { await grab(f.query(f.collection(this.db, 'specProjects'), f.where('memberIds', 'array-contains', me.uid), f.limit(100))); } catch (_) {}
      return [...out.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    },

    /** Projects from Project Tracker available to link. */
    async listTrackerProjects() {
      if (!this.isCloud()) return [];
      const f = this.api, me = this.me(), out = new Map();
      const grab = async (q) => { const s = await f.getDocs(q); s.forEach((d) => out.set(d.id, { id: d.id, ...d.data() })); };
      try { await grab(f.query(f.collection(this.db, 'projects'), f.where('ownerId', '==', me.uid), f.limit(50))); } catch (_) {}
      try { await grab(f.query(f.collection(this.db, 'projects'), f.where('memberIds', 'array-contains', me.uid), f.limit(50))); } catch (_) {}
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
      const ref = await this.api.addDoc(this.api.collection(this.db, 'specProjects'), plain(data));
      return ref.id;
    },

    async updateProject(sid, patch) {
      patch = { ...patch, updatedAt: nowISO() };
      if (!this.isCloud()) { const db = Local.read(); Object.assign(db.projects[sid], patch); Local.write(db); return; }
      await this.api.updateDoc(this.api.doc(this.db, 'specProjects', sid), plain(patch));
    },

    async deleteProject(sid) {
      if (!this.isCloud()) { const db = Local.read(); delete db.projects[sid]; delete (db.sections || {})[sid]; delete (db.items || {})[sid]; Local.write(db); return; }
      for (const sub of ['sections', 'items', 'sources', 'inbox']) {
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
      await this.api.setDoc(this.api.doc(this.db, 'specProjects', sid, kind, id), plain(data), plain({ merge }));
      return id;
    },

    async addDocIn(kind, sid, data) {
      if (!this.isCloud()) { const id = uid4(); await this.setDocIn(kind, sid, id, data, false); return id; }
      const ref = await this.api.addDoc(this.api.collection(this.db, 'specProjects', sid, kind), plain(data));
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
    subscribe(kind, sid, cb) {
      if (!this.isCloud()) {
        const emit = () => cb(Object.values(this._localBucket(kind, sid).bucket));
        emit();
        return Local.onChange(emit);
      }
      try {
        return this.api.onSnapshot(this.api.collection(this.db, 'specProjects', sid, kind), (snap) => {
          cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        }, (e) => console.warn('subscribe ' + kind, e));
      } catch (e) { console.warn(e); return () => {}; }
    },

    subscribeProject(sid, cb) {
      if (!this.isCloud()) { const emit = () => cb((Local.read().projects || {})[sid]); emit(); return Local.onChange(emit); }
      try {
        return this.api.onSnapshot(this.api.doc(this.db, 'specProjects', sid), (d) => cb(d.exists() ? { id: d.id, ...d.data() } : null));
      } catch (e) { return () => {}; }
    },

    /** Batched writes with graceful local fallback. */
    async bulkSet(kind, sid, records) {
      const chunk = 150;
      for (let i = 0; i < records.length; i += chunk) {
        await Promise.all(records.slice(i, i + chunk).map((r) => this.setDocIn(kind, sid, r.id, r.data, true)));
      }
    }
  };

  root.SpecStore = Store;
})(typeof window !== 'undefined' ? window : globalThis);
