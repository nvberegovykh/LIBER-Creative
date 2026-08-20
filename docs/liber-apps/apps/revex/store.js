/* REVEX cloud bridge.
 * BIM packages live in Firebase Storage; only revision pointers and editable
 * Companion data live in Firestore. Project docs, Specifications and Chat keep
 * using their existing LIBER collections and services.
 */
(function (root) {
  'use strict';

  let REALM = root;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const iso = () => new Date().toISOString();
  const safe = (value) => String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
  const docId = (value) => safe(value).replace(/\./g, '_');
  const ENERGY_HARD_STOP = 0.80;
  const ENERGY_QUALITY_TARGET = 0.95;
  const ENGINEERING_CURRENT_ID = 'revex_engineering';
  const ENERGY_CURRENT_ID = 'revex_energy';
  const COMCHECK_CONSENT_SCHEMA = 'liber.revex.comcheck-consent.v1';
  const COMCHECK_SERVICE = 'PNNL_COMCHECK_BACKSTOP';
  const COMCHECK_ENDPOINT = 'https://legacy-comcheck.energycode.pnl.gov/CheckWeb/';
  const COMCHECK_SCOPE = 'GENERATED_CURRENT_PROJECT_CXL_ONLY';
  const GOOGLE_RENDER_JOB_SCHEMA = 'liber.revex.google-render-job.v1';
  const GOOGLE_RENDER_PROVIDER = 'google-gemini-server';
  const GOOGLE_RENDER_MODEL = 'gemini-3.1-flash-image';
  const blobUrlCache = new Map();
  const blobUrlPathCache = new Map();
  let blobUrlCacheProjectId = null;
  const BLOB_URL_CACHE_LIMIT = 160;

  function clearBlobUrlCache() {
    for (const pendingUrl of blobUrlCache.values()) Promise.resolve(pendingUrl)
      .then((url) => { blobUrlPathCache.delete(url); try { URL.revokeObjectURL(url); } catch (_) {} }).catch(() => {});
    blobUrlCache.clear();
    blobUrlPathCache.clear();
    blobUrlCacheProjectId = null;
  }

  function controlledRenderJobId() {
    let nonce = '';
    if (typeof root.crypto?.randomUUID === 'function') {
      nonce = root.crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    } else if (typeof root.crypto?.getRandomValues === 'function') {
      const bytes = root.crypto.getRandomValues(new Uint8Array(16));
      nonce = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }
    if (!nonce) throw new Error('Secure browser randomness is required to create a Render job.');
    return `render_${Date.now().toString(36)}_${nonce}`;
  }

  function isLegacyFirebaseDownloadUrl(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    try {
      const url = new URL(text, root.location?.href || 'https://liberpict.com/');
      return (url.hostname === 'firebasestorage.googleapis.com' || /\.googleapis\.com$/i.test(url.hostname) && url.pathname.includes('/v0/b/')) &&
        (url.searchParams.has('token') || url.searchParams.get('alt') === 'media');
    } catch (_) { return /firebasestorage\.googleapis\.com/i.test(text) && /[?&]token=/i.test(text); }
  }

  function compatibleEphemeralUrl(value, label = 'project asset') {
    const text = String(value || '').trim();
    if (!text) return null;
    if (isLegacyFirebaseDownloadUrl(text))
      throw new Error(`Blocked a legacy permanent Firebase download URL for ${label}. Re-publish this revision so it stores an authenticated Storage path.`);
    return text;
  }

  function projectStoragePath(value) {
    const storagePath = String(value || '').trim().replace(/\\/g, '/');
    if (!storagePath || storagePath.startsWith('/') || storagePath.includes('//'))
      throw new Error('The project file path is invalid.');
    const segments = storagePath.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..'))
      throw new Error('The project file path is invalid.');
    if (segments.length < 3 || segments[0] !== 'projects' || !/^[A-Za-z0-9._-]{1,160}$/.test(segments[1]))
      throw new Error('REVEX can open only project-scoped Storage files.');
    const activeProjectId = String(root.__revexState?.projectId || '').trim();
    if (activeProjectId && activeProjectId !== segments[1])
      throw new Error('Blocked a cross-project file reference. Reload the selected REVEX project and try again.');
    return storagePath;
  }

  function exactText(value, label) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`Engineering Sync is missing ${label}.`);
    return text;
  }

  function assertEngineeringSourceAlignment(source, manifest, projectId) {
    const sourceRevision = exactText(manifest?.sourceRevision, 'sourceRevision');
    const sourceProjectId = exactText(source?.projectId, 'the immutable source project id');
    if (!source || source.immutable !== true || source.revexKind !== 'revision' || String(source.revision || '') !== sourceRevision)
      throw new Error(`Engineering Sync source ${sourceRevision} is not the exact immutable REVEX source revision.`);
    if (sourceProjectId !== projectId || String(manifest?.projectId || '') !== projectId)
      throw new Error('Engineering Sync and its immutable source revision belong to different projects.');
    const central = source.central || {};
    const binding = manifest?.projectBinding || {};
    for (const [field, label] of [
      ['documentUniqueId', 'active Revit document id'],
      ['documentFingerprint', 'active Revit document fingerprint'],
      ['identityEvidenceDigest', 'identity evidence digest']
    ]) {
      const sourceValue = exactText(central[field], `source ${label}`);
      const engineeringValue = exactText(binding[field], `Engineering ${label}`);
      if (sourceValue !== engineeringValue)
        throw new Error(`Engineering Sync ${label} does not match immutable source revision ${sourceRevision}.`);
    }
    return sourceRevision;
  }

  function resolveAtomicPackageProject(project, preferredProjectId, preferredSpecProjectId) {
    const packageProjectId = String(project?.central?.projectId || project?.central?.liberProjectId || '').trim();
    const requestedProjectId = String(preferredProjectId || '').trim();
    if (!packageProjectId)
      throw new Error('project.json has no authoritative Revit project binding. Re-sync the active Revit model.');
    if (requestedProjectId && requestedProjectId !== packageProjectId)
      throw new Error(`Blocked a mixed-project publish: the open Companion selected ${requestedProjectId}, but this immutable Revit revision belongs to ${packageProjectId}.`);

    const expectedSpecProjectId = `spec_${docId(packageProjectId)}`;
    const packageSpecProjectId = String(project?.central?.specProjectId || '').trim();
    const requestedSpecProjectId = String(preferredSpecProjectId || '').trim();
    if (packageSpecProjectId && packageSpecProjectId !== expectedSpecProjectId)
      throw new Error(`Blocked a mixed BIM/Spec revision: ${packageProjectId} cannot publish into ${packageSpecProjectId}.`);
    if (requestedSpecProjectId && requestedSpecProjectId !== expectedSpecProjectId)
      throw new Error(`Blocked a mixed BIM/Spec selection: ${packageProjectId} requires ${expectedSpecProjectId}, not ${requestedSpecProjectId}.`);
    return { projectId: packageProjectId, specProjectId: expectedSpecProjectId };
  }

  async function publishSpecScheduleSources(store, specProjectId, projectId, specPush, project, storagePath, revision, batch = null) {
    const collection = store.api.collection(store.db, 'specProjects', specProjectId, 'sources');
    const manifestRef = store.api.doc(collection, 'revex-revit');
    const write = async (ref, value, options) => {
      if (batch) {
        batch.set(ref, value, options);
        return;
      }
      await store.api.setDoc(ref, value, options);
    };
    let previousIds = [];
    try {
      const previous = await store.api.getDoc(manifestRef);
      previousIds = previous.exists() && Array.isArray(previous.data()?.scheduleSourceIds)
        ? previous.data().scheduleSourceIds.map(String)
        : [];
    } catch (_) {}

    const schedules = Array.isArray(specPush?.payload) ? specPush.payload : [];
    const sourceIds = [];
    for (const schedule of schedules) {
      const identity = schedule?.sourceScheduleId || schedule?.presentation?.scheduleUniqueId || schedule?.schedule || `schedule-${sourceIds.length + 1}`;
      const sourceId = `revex-revit-${docId(identity)}`;
      sourceIds.push(sourceId);
      await write(store.api.doc(collection, sourceId), plain({
        type: 'revit', name: schedule?.schedule || 'REVEX Revit schedule',
        rev: specPush?.rev || revision, pushedAt: specPush?.pushedAt || iso(), payload: [schedule],
        linkedProjectId: projectId, sourceScheduleId: identity,
        centralDocumentUniqueId: project?.central?.documentUniqueId || null, storagePath
      }), plain({ merge: false }));
    }

    const retiredIds = previousIds.filter((id) => !sourceIds.includes(id));
    if (batch && sourceIds.length + retiredIds.length + 3 > 500)
      throw new Error('This BIM/Spec publication exceeds Firestore\'s atomic 500-write limit. Split the schedule package before publishing; no current pointer was changed.');
    for (const sourceId of retiredIds) {
      await write(store.api.doc(collection, sourceId), plain({
        type: 'revit', name: 'Retired REVEX Revit schedule', rev: specPush?.rev || revision,
        pushedAt: specPush?.pushedAt || iso(), payload: [], linkedProjectId: projectId,
        retired: true, retiredAt: iso(), storagePath
      }), plain({ merge: false }));
    }

    const manifest = plain({
      type: 'revit-manifest', name: 'REVEX controlled Revit schedules',
      rev: specPush?.rev || revision, pushedAt: specPush?.pushedAt || iso(), payload: [],
      linkedProjectId: projectId, scheduleSourceIds: sourceIds, scheduleCount: sourceIds.length,
      centralDocumentUniqueId: project?.central?.documentUniqueId || null, storagePath
    });
    await write(manifestRef, manifest, plain({ merge: false }));
    return manifest;
  }

  function plain(value) {
    const json = JSON.stringify(value === undefined ? null : value);
    try { return (REALM.JSON || JSON).parse(json); } catch (_) { return JSON.parse(json); }
  }

  function revexRecord(kind, value, updatedAt = iso()) {
    return plain({
      ...value,
      type: 'revex',
      hidden: true,
      revexKind: kind,
      updatedAt
    });
  }

  function getService() {
    // REVEX loads its own Firebase service before Store.init(). Keep that
    // service authoritative even while it is still initializing. Borrowing an
    // already-ready parent service pairs the parent's SDK with objects created
    // in this iframe, which Firestore correctly rejects as custom Objects.
    if (root.firebaseService) {
      REALM = root;
      return root.firebaseService;
    }
    try {
      for (const w of [root.parent, root.top].filter(Boolean)) {
        if (w.firebaseService && w.firebaseService.isInitialized) {
          REALM = w;
          return w.firebaseService;
        }
      }
    } catch (_) {}
    return root.firebaseService || null;
  }

  function getApi(fs) {
    if (fs && fs === root.firebaseService) {
      REALM = root;
      if (fs.firebase?.collection) return fs.firebase;
      if (root.firebase?.collection) return root.firebase;
      return null;
    }
    try {
      if (fs?.firebase?.collection) return fs.firebase;
      for (const w of [root.parent, root.top].filter(Boolean)) {
        if (w.firebase?.collection) { REALM = w; return w.firebase; }
      }
    } catch (_) {}
    return null;
  }

  function energyCallableError(error) {
    const code = String(error?.code || error?.status || 'functions/unknown').trim();
    const message = String(error?.message || 'REVEX Energy broker failed.').replace(/^Firebase:\s*/i, '').trim();
    const details = error?.details == null ? '' : (typeof error.details === 'string' ? error.details : JSON.stringify(error.details));
    const result = new Error([message, code && `Code: ${code}`, details && `Details: ${details}`].filter(Boolean).join(' · '));
    result.name = 'RevexEnergyBrokerError';
    result.code = code;
    result.details = error?.details ?? null;
    result.cause = error;
    return result;
  }

  async function callEnergyBroker(fs, payload) {
    await fs?.waitForInit?.();
    const modular = root.firebaseModular || REALM.firebaseModular;
    if (modular?.httpsCallable && modular?.getFunctions && fs?.app) {
      const functions = fs.functionsByRegion?.['us-central1'] || modular.getFunctions(fs.app, 'us-central1');
      try {
        const callable = modular.httpsCallable(functions, 'runRevexEnergy', { timeout: 3600000 });
        const response = await callable(payload);
        return response?.data ?? null;
      } catch (error) {
        throw energyCallableError(error);
      }
    }
    if (!fs?.callFunction) throw new Error('REVEX managed Energy broker is unavailable in this session.');
    try {
      const response = await fs.callFunction('runRevexEnergy', payload);
      if (response == null) throw new Error('The shared Firebase wrapper returned no broker response.');
      return response;
    } catch (error) {
      throw energyCallableError(error);
    }
  }

  async function readJson(file) {
    if (!file) return null;
    try { return JSON.parse(await file.text()); } catch (error) {
      throw new Error(`${file.name} is not valid JSON: ${error.message}`);
    }
  }

  async function sha256File(file) {
    if (!file?.arrayBuffer || !root.crypto?.subtle)
      throw new Error(`SHA-256 is unavailable for ${file?.name || 'an Engineering artifact'}.`);
    const bytes = await file.arrayBuffer();
    const digest = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read the image.'));
      reader.readAsDataURL(file);
    });
  }

  function byName(files, name) {
    return files.find((file) => String(file.name || '').toLowerCase() === name.toLowerCase()) || null;
  }

  const Store = {
    fs: null,
    api: null,
    db: null,
    user: null,
    mode: 'local',
    lastLocalPackage: null,
    authSettled: false,
    _lastAuthUid: null,

    _applyAuthState(user, source = 'auth') {
      const previousMode = this.mode;
      const previousUid = this._lastAuthUid;
      this.user = user || null;
      this._lastAuthUid = this.user?.uid || null;
      this.mode = this.user ? 'cloud' : 'local';
      this.authSettled = true;
      if (previousMode === this.mode && previousUid === this._lastAuthUid) return this.mode;
      clearBlobUrlCache();
      const pending = this.lastLocalPackage?.cloud === false ? {
        projectId: this.lastLocalPackage.projectId,
        revision: this.lastLocalPackage.revision,
        syncedAt: this.lastLocalPackage.syncedAt
      } : null;
      try {
        root.dispatchEvent(new CustomEvent('revex:auth-mode-changed', { detail: {
          mode: this.mode, uid: this._lastAuthUid, source, pendingLocalRevision: pending
        } }));
      } catch (_) {}
      return this.mode;
    },

    _reconcileAuthState(source = 'live-auth-check') {
      const live = this.fs?.auth?.currentUser || null;
      const uid = live?.uid || null;
      if (uid !== this._lastAuthUid || (live && this.mode !== 'cloud') || (!live && this.authSettled && this.mode !== 'local')) {
        this._applyAuthState(live, source);
      }
      return this.mode;
    },

    // Firebase's modular SDK rejects otherwise-plain objects created in a
    // different Window realm. Keep every REVEX writer on the SDK's own realm.
    toFirestorePlain(value) { return plain(value); },
    assertEphemeralUrl(value, label) { return compatibleEphemeralUrl(value, label); },
    sanitizeStoredAsset(asset, label = 'project asset') {
      if (!asset || typeof asset !== 'object') return asset;
      const row = { ...asset };
      if (row.path) delete row.url;
      else if (row.url) row.url = compatibleEphemeralUrl(row.url, label);
      return row;
    },
    sanitizeRenderJob(projectId, value) {
      const row = { ...(value || {}) };
      let resultPath = row.resultPath ? projectStoragePath(row.resultPath) : null;
      if (!resultPath && row.resultUrl) resultPath = this.storagePathForObjectUrl(row.resultUrl);
      delete row.resultUrl;
      if (resultPath) {
        if (resultPath.split('/')[1] !== String(projectId || '')) throw new Error('Render result belongs to a different REVEX project.');
        row.resultPath = resultPath;
      } else delete row.resultPath;
      return row;
    },
    async hydrateStoredAsset(asset, label = 'project asset') {
      if (!asset || typeof asset !== 'object') return asset;
      return {
        ...asset,
        url: asset.path ? await this.fileUrl(asset.path) : compatibleEphemeralUrl(asset.url, label)
      };
    },

    async init() {
      for (let i = 0; i < 50; i += 1) {
        this.fs = getService();
        this.api = getApi(this.fs);
        if (this.fs?.db && this.api?.collection) break;
        await wait(150);
      }
      if (this.fs?.db && this.api?.collection) {
        this.db = this.api.firestore && this.fs.app ? this.api.firestore(this.fs.app) : this.fs.db;
        this.user = this.fs.auth?.currentUser || null;
        if (this.api.onAuthStateChanged && this.fs.auth) {
          await new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
              if (!settled) { settled = true; this._applyAuthState(this.fs.auth?.currentUser || null, 'auth-timeout'); resolve(); }
            }, 2500);
            try {
              this.api.onAuthStateChanged(this.fs.auth, (user) => {
                this._applyAuthState(user, 'auth-listener');
                if (!settled) { settled = true; clearTimeout(timer); resolve(); }
              });
            } catch (_) { clearTimeout(timer); this._applyAuthState(this.fs.auth?.currentUser || null, 'auth-listener-error'); resolve(); }
          });
        }
        else this._applyAuthState(this.user, 'auth-initial');
      }
      return this.mode;
    },

    isCloud() { return this._reconcileAuthState() === 'cloud'; },

    async listProjects() {
      if (!this.isCloud()) {
        try {
          const rows = Object.values(JSON.parse(localStorage.getItem('liber.revex.projects.v1') || '{}'));
          return rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        } catch (_) { return []; }
      }
      const f = this.api;
      const uid = this.user.uid;
      const out = new Map();
      const grab = async (query) => {
        const snap = await f.getDocs(query);
        snap.docs.forEach((d) => out.set(d.id, { id: d.id, ...d.data() }));
      };
      try { await grab(f.query(f.collection(this.db, 'projects'), f.where('ownerId', '==', uid), f.limit(50))); } catch (e) { console.warn('[REVEX] owner projects', e); }
      try { await grab(f.query(f.collection(this.db, 'projects'), f.where('memberIds', 'array-contains', uid), f.limit(50))); } catch (e) { console.warn('[REVEX] member projects', e); }
      return [...out.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    },

    async getProject(projectId) {
      if (!projectId) return null;
      if (!this.isCloud()) {
        try { return JSON.parse(localStorage.getItem('liber.revex.projects.v1') || '{}')[projectId] || null; } catch (_) { return null; }
      }
      const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', projectId));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },

    async createProject({ name, code, description, driveFileId }) {
      const title = String(name || '').trim();
      if (!title) throw new Error('Enter a project name.');
      const at = iso();
      if (!this.isCloud()) {
        const id = `local_${Date.now().toString(36)}`;
        const all = JSON.parse(localStorage.getItem('liber.revex.projects.v1') || '{}');
        all[id] = {
          id, name: title, code: String(code || '').trim(), description: String(description || '').trim(),
          ownerId: 'local', memberIds: ['local'], status: 'Active', driveFileId: String(driveFileId || '').trim() || null,
          createdAt: at, updatedAt: at, revexProject: true
        };
        localStorage.setItem('liber.revex.projects.v1', JSON.stringify(all));
        const specProjectId = await this.ensureSpecProject(id, null, all[id]);
        all[id].revexSpecProjectId = specProjectId;
        localStorage.setItem('liber.revex.projects.v1', JSON.stringify(all));
        return { ...all[id], specProjectId };
      }

      const uid = this.user.uid;
      const data = plain({
        name: title,
        code: String(code || '').trim(),
        description: String(description || '').trim(),
        status: 'Active',
        ownerId: uid,
        memberIds: [uid],
        driveFileId: String(driveFileId || '').trim() || null,
        createdAt: at,
        updatedAt: at,
        requestData: null,
        revexProject: true
      });
      const ref = await this.api.addDoc(this.api.collection(this.db, 'projects'), data);
      const project = { id: ref.id, ...data };
      let specProjectId = null;
      try {
        specProjectId = await this.ensureSpecProject(ref.id, null, project);
        await this.api.updateDoc(this.api.doc(this.db, 'projects', ref.id), plain({ revexSpecProjectId: specProjectId, specBookStatus: 'ready', updatedAt: iso() }));
      } catch (error) {
        // Project creation must never be blocked by a secondary compatibility projection.
        // REVEX owns the project identity; the internal Spec Book can retry after activation.
        console.warn('[REVEX] Spec Book projection deferred', error);
        try { await this.api.updateDoc(this.api.doc(this.db, 'projects', ref.id), plain({ specBookStatus: 'pending', updatedAt: iso() })); } catch (_) {}
      }
      try {
        const chat = await this.ensureProjectChat(ref.id);
        if (chat?.connId) await this.api.updateDoc(this.api.doc(this.db, 'projects', ref.id), plain({ chatConnId: chat.connId }));
      } catch (error) { console.warn('[REVEX] project chat will be created when first opened', error); }
      try { await this.appendHistory(ref.id, { kind: 'project', operation: 'create', label: `Project created · ${title}`, before: null, after: { projectId: ref.id, name: title, code: data.code }, note: specProjectId ? 'REVEX project and internal Spec Book created.' : 'REVEX project created; Spec Book projection will retry on activation.' }); } catch (_) {}
      return { ...project, revexSpecProjectId: specProjectId, specProjectId, specBookStatus: specProjectId ? 'ready' : 'pending' };
    },

    async getState(projectId) {
      if (!projectId) return null;
      if (!this.isCloud()) {
        try { return JSON.parse(localStorage.getItem(`liber.revex.state.${projectId}`) || 'null'); } catch (_) { return null; }
      }
      const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', projectId, 'revex', 'state'));
      return snap.exists() ? this.hydrateStorageRecord({ id: snap.id, ...snap.data() }) : null;
    },

    subscribeState(projectId, callback) {
      if (!this.isCloud() || !projectId || !this.api.onSnapshot) return () => {};
      return this.api.onSnapshot(
        this.api.doc(this.db, 'projects', projectId, 'revex', 'state'),
        (snap) => {
          if (!snap.exists()) { callback(null); return; }
          this.hydrateStorageRecord({ id: snap.id, ...snap.data() })
            .then(callback)
            .catch((error) => console.warn('[REVEX] state asset hydration', error));
        },
        (error) => console.warn('[REVEX] state subscription', error)
      );
    },

    async fetchJson(urlOrPath) {
      if (!urlOrPath) return null;
      const value = String(urlOrPath || '').trim();
      const storagePath = value.startsWith('storage://') ? value.slice('storage://'.length) : null;
      if (storagePath) return JSON.parse(await (await this.fileBlob(storagePath)).text());
      const url = compatibleEphemeralUrl(value, 'synced JSON');
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not load synced data (${response.status})`);
      return response.json();
    },

    async fileBlob(storagePath) {
      if (!storagePath || !this.fs?.storage) return null;
      if (!this.user?.uid) throw new Error('Sign in before opening a project file.');
      const scopedPath = projectStoragePath(storagePath);
      const getBlob = this.api?.getBlob || root.firebaseModular?.getBlob || REALM.firebaseModular?.getBlob;
      if (typeof getBlob !== 'function') throw new Error('Authenticated Firebase Storage reads are unavailable in this browser.');
      try {
        return await getBlob(this.api.ref(this.fs.storage, scopedPath));
      } catch (error) {
        const code = String(error?.code || '').toLowerCase();
        if (code.includes('unauthorized') || code.includes('permission-denied')) {
          const denied = new Error('Project file access is unavailable. Verify project membership and deploy the current REVEX Storage access rules.');
          denied.code = error?.code || 'storage/unauthorized';
          denied.cause = error;
          throw denied;
        }
        throw error;
      }
    },

    async hydrateStorageRecord(value) {
      if (!value || typeof value !== 'object') return value;
      const row = plain(value);
      const fields = [
        ['ifcPath', 'ifcUrl'], ['modelPath', 'modelUrl'], ['fallbackModelPath', 'fallbackModelUrl'],
        ['viewerPath', 'viewerUrl'], ['designPath', 'designUrl'], ['projectPath', 'projectUrl'],
        ['specPushPath', 'specPushUrl'], ['printingSetsPath', 'printingSetsUrl'],
        ['affectedPlansPath', 'affectedPlansUrl'], ['manifestPath', 'manifestUrl'],
        ['imagePath', 'imageUrl'], ['resultPath', 'resultUrl']
      ];
      for (const [pathField, urlField] of fields) {
        if (row[pathField]) row[urlField] = await this.fileUrl(row[pathField]);
        else if (row[urlField]) row[urlField] = compatibleEphemeralUrl(row[urlField], urlField);
      }
      if (Array.isArray(row.modelPages)) row.modelPages = await Promise.all(row.modelPages.map(async (asset) => ({
        ...asset,
        url: asset?.path ? await this.fileUrl(asset.path) : compatibleEphemeralUrl(asset?.url, 'model page')
      })));
      if (Array.isArray(row.artifacts)) row.artifacts = await Promise.all(row.artifacts.map(async (asset) => ({
        ...asset,
        url: asset?.path ? await this.fileUrl(asset.path) : compatibleEphemeralUrl(asset?.url, 'Engineering/Energy artifact')
      })));
      return row;
    },

    async resolveSpecProject(projectId, preferredId) {
      if (!this.isCloud()) {
        if (preferredId) return preferredId;
        const project = await this.getProject(projectId);
        return project?.revexSpecProjectId || null;
      }
      const f = this.api;
      if (preferredId) {
        try {
          const exact = await f.getDoc(f.doc(this.db, 'specProjects', preferredId));
          if (exact.exists()) {
            const data = exact.data();
            if (!data.linkedProjectId || data.linkedProjectId === projectId) return preferredId;
          }
        } catch (_) {}
        // An explicit deterministic Spec Project ID is an atomic contract. Do not
        // fall back to a stale project pointer or another project's linked book.
        return null;
      }
      try {
        const project = await this.getProject(projectId);
        if (project?.revexSpecProjectId) {
          const linked = await f.getDoc(f.doc(this.db, 'specProjects', project.revexSpecProjectId));
          if (linked.exists() && (!linked.data()?.linkedProjectId || linked.data()?.linkedProjectId === projectId))
            return project.revexSpecProjectId;
        }
        const q = f.query(f.collection(this.db, 'specProjects'), f.where('linkedProjectId', '==', projectId), f.limit(10));
        const snap = await f.getDocs(q);
        if (!snap.empty) return snap.docs[0].id;
      } catch (error) { console.warn('[REVEX] linked Specifications project', error); }
      return null;
    },

    async ensureSpecProject(projectId, preferredId, suppliedProject = null) {
      const existing = await this.resolveSpecProject(projectId, preferredId);
      if (existing) {
        if (this.isCloud()) {
          await this.api.setDoc(this.api.doc(this.db, 'specProjects', existing), plain({ linkedProjectId: projectId, updatedAt: iso(), managedByRevex: true }), plain({ merge: true }));
          await this.api.updateDoc(this.api.doc(this.db, 'projects', projectId), plain({ revexSpecProjectId: existing, updatedAt: iso() }));
        }
        return existing;
      }
      const project = suppliedProject || await this.getProject(projectId);
      if (!project) throw new Error('The shared LIBER project could not be loaded.');
      const specProjectId = `spec_${docId(projectId)}`;
      const at = iso();
      const memberIds = Array.from(new Set([...(project.memberIds || []), project.ownerId, this.user?.uid || 'local'].filter(Boolean)));
      const specData = {
        id: specProjectId,
        name: `${project.name || project.title || 'Project'} — Spec Book`,
        code: project.code || '',
        linkedProjectId: projectId,
        linkedProjectName: project.name || project.title || '',
        ownerId: project.ownerId || this.user?.uid || 'local',
        memberIds,
        settings: { divisionPerSchedule: true, showEmptyArticles: false },
        createdAt: at,
        updatedAt: at,
        managedByRevex: true
      };
      if (!this.isCloud()) {
        const specDb = JSON.parse(localStorage.getItem('liber.spec.v1') || '{}');
        specDb.projects = specDb.projects || {};
        specDb.projects[specProjectId] = { ...(specDb.projects[specProjectId] || {}), ...specData };
        localStorage.setItem('liber.spec.v1', JSON.stringify(specDb));
        const projects = JSON.parse(localStorage.getItem('liber.revex.projects.v1') || '{}');
        if (projects[projectId]) {
          projects[projectId].revexSpecProjectId = specProjectId;
          projects[projectId].updatedAt = at;
          localStorage.setItem('liber.revex.projects.v1', JSON.stringify(projects));
        }
        return specProjectId;
      }
      await this.api.setDoc(this.api.doc(this.db, 'specProjects', specProjectId), plain(specData), plain({ merge: true }));
      await this.api.updateDoc(this.api.doc(this.db, 'projects', projectId), plain({ revexSpecProjectId: specProjectId, updatedAt: at }));
      return specProjectId;
    },

    async uploadFile(path, file) {
      const f = this.api;
      const ref = f.ref(this.fs.storage, path);
      await f.uploadBytes(ref, file, plain({ contentType: file.type || (file.name.endsWith('.json') ? 'application/json' : 'application/octet-stream') }));
      return { path, name: file.name, size: file.size };
    },

    async syncPackage(fileList, preferredProjectId, preferredSpecProjectId) {
      const files = Array.from(fileList || []);
      const projectFile = byName(files, 'project.json');
      const designFile = byName(files, 'design-book.json');
      const viewerFile = byName(files, 'viewer-model.json');
      const specFile = byName(files, 'spec-revit-push.json');
      const integrityFile = byName(files, 'integrity.json');
      const printingFile = byName(files, 'printing-sets.json');
      let affectedPlansFile = byName(files, 'affected-plan-views.json');
      if (!affectedPlansFile) affectedPlansFile = new File([JSON.stringify({ schema: 'liber.revex.affected-plan-views.v1', revision: null, exportedAt: iso(), source: 'compatibility-empty-for-pre-0.8.4-import', changedElementCount: 0, hadDeletion: false, views: [] }, null, 2)], 'affected-plan-views.json', { type: 'application/json' });
      const rvxMeshFile = files.find((file) => /\.rvxmesh\.gz$/i.test(file.name)) || null;
      const fbxFile = files.find((file) => /\.fbx$/i.test(file.name)) || null;
      const modelFile = rvxMeshFile || fbxFile;

      if (!projectFile || !designFile || !viewerFile || !specFile || !integrityFile) {
        throw new Error('Select the complete REVEX package: project, Design Book, viewer metadata, Spec Book source, integrity manifest and affected native plan manifest.');
      }

      const [project, design, viewer, specPush, integrity] = await Promise.all([
        readJson(projectFile), readJson(designFile), readJson(viewerFile), readJson(specFile), readJson(integrityFile)
      ]);
      const packageBinding = resolveAtomicPackageProject(project, preferredProjectId, preferredSpecProjectId);
      const projectId = packageBinding.projectId;

      const revision = docId(integrity?.revision || `rev_${Date.now()}`);
      const localPackage = {
        projectId, revision, project, design, viewer, specPush, integrity,
        modelUrl: modelFile ? URL.createObjectURL(modelFile) : null,
        modelFormat: rvxMeshFile ? 'rvxmesh-gzip' : (fbxFile ? 'fbx' : null),
        fallbackModelUrl: rvxMeshFile && fbxFile ? URL.createObjectURL(fbxFile) : null,
        syncedAt: iso(), cloud: false
      };
      this.lastLocalPackage = localPackage;

      if (!this.isCloud()) {
        localStorage.setItem(`liber.revex.state.${projectId}`, JSON.stringify({
          projectId, revision, syncedAt: localPackage.syncedAt, central: project.central || null,
          scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0,
          elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0,
          localOnly: true
        }));
        try {
          localStorage.setItem(`liber.revex.pending.${projectId}`, JSON.stringify({
            schema: 'liber.revex.pending-cloud-sync.v1', projectId, revision,
            syncedAt: localPackage.syncedAt, reason: this.authSettled ? 'offline-or-signed-out' : 'auth-pending'
          }));
        } catch (_) {}
        return localPackage;
      }
      if (!this.fs.storage) throw new Error('LIBER Storage is not available in this session.');

      const base = `projects/${projectId}/revex/revisions/${revision}`;
      const uploadFiles = [projectFile, designFile, viewerFile, specFile, integrityFile, printingFile, affectedPlansFile, rvxMeshFile, fbxFile].filter(Boolean);
      const uploads = {};
      for (const file of uploadFiles) uploads[file.name] = await this.uploadFile(`${base}/${safe(file.name)}`, file);

      const specProjectId = await this.ensureSpecProject(projectId, packageBinding.specProjectId);
      const publicationBatch = this.api.writeBatch ? this.api.writeBatch(this.db) : null;
      let specSync = { status: 'unlinked', projectId: null, rev: specPush?.rev || revision };
      if (specProjectId) {
        const source = await publishSpecScheduleSources(
          this, specProjectId, projectId, specPush, project,
          uploads['spec-revit-push.json']?.path || null, revision, publicationBatch);
        specSync = { status: 'published', projectId: specProjectId, rev: source.rev, pushedAt: source.pushedAt, scheduleCount: source.scheduleCount };
      }

      const state = plain({
        schema: 'liber.revex.cloud-state.v1',
        projectId,
        revision,
        syncedAt: iso(),
        syncedBy: this.user.uid,
        central: project?.central || null,
        ownership: project?.rules || null,
        integrity: integrity || null,
        modelPath: uploads[modelFile?.name]?.path || null,
        modelFormat: rvxMeshFile ? 'rvxmesh-gzip' : (fbxFile ? 'fbx' : null),
        fallbackModelPath: rvxMeshFile && fbxFile ? (uploads[fbxFile.name]?.path || null) : null,
        viewerPath: uploads['viewer-model.json']?.path || null,
        designPath: uploads['design-book.json']?.path || null,
        projectPath: uploads['project.json']?.path || null,
        specPushPath: uploads['spec-revit-push.json']?.path || null,
        printingSetsPath: uploads['printing-sets.json']?.path || null,
        affectedPlansPath: uploads['affected-plan-views.json']?.path || null,
        scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0,
        elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0,
        spec: specSync,
        writeBackToRvt: false
      });

      const currentRef = this.api.doc(this.db, 'projects', projectId, 'revex', 'state');
      const revisionRef = this.api.doc(this.db, 'projects', projectId, 'revexRevisions', revision);
      const revisionState = plain({
        ...state,
        viewerPath: state.viewerPath,
        designPath: state.designPath,
        projectPath: state.projectPath,
        createdAt: state.syncedAt
      });
      if (publicationBatch) {
        // Spec sources, immutable BIM revision, and current pointer become visible
        // together. A failed publish therefore cannot expose mixed revisions.
        publicationBatch.set(revisionRef, revisionState, plain({ merge: false }));
        publicationBatch.set(currentRef, state, plain({ merge: true }));
        await publicationBatch.commit();
      } else {
        // Legacy SDK fallback keeps the current pointer last. An orphan immutable
        // revision is recoverable; a current pointer without its source is not.
        await this.api.setDoc(revisionRef, revisionState, plain({ merge: false }));
        await this.api.setDoc(currentRef, state, plain({ merge: true }));
      }

      try { localStorage.removeItem(`liber.revex.pending.${projectId}`); } catch (_) {}

      return { ...localPackage, ...state, cloud: true, specProjectId };
    },

    async syncEngineeringPackage(fileList, preferredProjectId) {
      const files = Array.from(fileList || []);
      const manifestFile = byName(files, 'engineering-sync.json');
      const gbxmlFile = files.find((file) => /\.xml$/i.test(file.name)) || null;
      if (!manifestFile || !gbxmlFile) throw new Error('The Engineering Sync package must include engineering-sync.json and the Revit gbXML.');
      const manifest = await readJson(manifestFile);
      if (manifest?.schema !== 'liber.revex.engineering-sync.v1' || manifest?.architecture !== 'REVIT_EVIDENCE_GRAPH_V1')
        throw new Error('This is not a compatible REVIT_EVIDENCE_GRAPH_V1 Engineering Sync revision.');
      const binding = manifest?.projectBinding || {};
      const sourceRevision = exactText(manifest?.sourceRevision, 'sourceRevision');
      if (binding.version !== 'active-revit-evidence-v1' || !String(binding.identityEvidenceDigest || '').trim() || !String(binding.documentUniqueId || '').trim())
        throw new Error('Engineering Sync has no evidence-verified active Revit document binding. Re-sync from the active model.');
      const publication = manifest?.publicationIntegrity || {};
      const integrityRatios = Object.values(publication.ratios || {}).map((value) => Number(value));
      const declaredQualityTarget = Number(publication.qualityTarget || publication.threshold || 0);
      if (Number(publication.threshold || 0) < ENERGY_HARD_STOP || !integrityRatios.length || integrityRatios.some((value) => value < ENERGY_HARD_STOP))
        throw new Error('Energy Sync requires at least 80% integrity in every required Revit evidence domain.');
      if (declaredQualityTarget < ENERGY_QUALITY_TARGET)
        throw new Error('Energy Sync is missing the 80% hard-stop / 95% quality-target integrity contract.');
      const projectId = preferredProjectId || manifest.projectId || null;
      if (!projectId) throw new Error('Choose a LIBER project before importing Engineering Sync.');
      if (manifest.projectId && manifest.projectId !== projectId) throw new Error('The Engineering Sync revision belongs to a different REVEX project.');
      if (manifest.writeBackToRevitAfterExport !== false || manifest.pdfInsertion !== false)
        throw new Error('The Engineering Sync authority boundary is invalid.');

      const declaredArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
      const declaredByName = new Map(declaredArtifacts.map((row) => [String(row?.name || '').toLowerCase(), row]));
      if (!declaredArtifacts.length || declaredByName.size !== declaredArtifacts.length)
        throw new Error('Engineering Sync has no unique immutable artifact manifest.');
      const transferFiles = files.filter((file) => String(file?.name || '').toLowerCase() !== 'engineering-sync.json');
      const transferNames = new Set(transferFiles.map((file) => String(file?.name || '').toLowerCase()));
      const undeclared = transferFiles.filter((file) => !declaredByName.has(String(file?.name || '').toLowerCase()));
      const missing = declaredArtifacts.filter((row) => !transferNames.has(String(row?.name || '').toLowerCase()));
      if (undeclared.length || missing.length)
        throw new Error(`Engineering artifact manifest mismatch: undeclared=${undeclared.map((file) => file.name).join(',') || 'none'}; missing=${missing.map((row) => row.name).join(',') || 'none'}.`);

      const fileIntegrity = new Map();
      for (const file of files) {
        const hash = await sha256File(file);
        fileIntegrity.set(String(file.name || '').toLowerCase(), hash);
        const declared = declaredByName.get(String(file.name || '').toLowerCase());
        if (!declared) continue;
        if (Number(declared.bytes || 0) !== Number(file.size || 0) ||
            !/^[a-f0-9]{64}$/i.test(String(declared.sha256 || '')) ||
            String(declared.sha256).toLowerCase() !== hash)
          throw new Error(`Engineering artifact failed immutable byte/hash validation: ${file.name}.`);
      }

      const revision = docId(manifest.revision || `eng_${Date.now()}`);
      const at = iso();
      const localArtifacts = files.map((file, index) => ({
        name: file.name, bytes: file.size || 0, kind: index === 0 ? 'manifest' : 'engineering-evidence',
        sha256: fileIntegrity.get(String(file.name || '').toLowerCase()), url: URL.createObjectURL(file), cloud: false
      }));
      const state = {
        schema: 'liber.revex.engineering-state.v1', projectId, revision, syncedAt: at,
        manifest, artifacts: localArtifacts, cloud: false, writeBackToRevitAfterExport: false, pdfInsertion: false
      };
      localStorage.setItem(`liber.revex.engineering.${projectId}`, JSON.stringify({
        ...state, artifacts: localArtifacts.map(({ url, ...row }) => row), localOnly: true
      }));
      if (!this.isCloud()) return state;
      if (!this.fs.storage) throw new Error('LIBER Storage is not available in this session.');

      // A cloud Engineering revision can follow only the exact immutable source
      // revision named by the native package. Never infer this from a mutable
      // current pointer and never upload bytes before the full Revit envelope agrees.
      const sourceRef = this.api.doc(this.db, 'projects', projectId, 'library', `revex_revision_${docId(sourceRevision)}`);
      const sourceSnap = await this.api.getDoc(sourceRef);
      if (!sourceSnap.exists())
        throw new Error(`Publish immutable source revision ${sourceRevision} before its aligned Engineering revision.`);
      assertEngineeringSourceAlignment({ id: sourceSnap.id, ...sourceSnap.data() }, manifest, projectId);

      const base = `projects/${projectId}/revex/engineering/revisions/${revision}`;
      const artifacts = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const uploaded = await this.uploadFile(`${base}/${String(index + 1).padStart(3, '0')}_${safe(file.name)}`, file);
        artifacts.push({
          name: file.name, bytes: file.size || 0,
          sha256: fileIntegrity.get(String(file.name || '').toLowerCase()),
          kind: index === 0 ? 'manifest' : 'engineering-evidence',
          path: uploaded.path, cloud: true
        });
      }
      const cloudState = plain({ ...state, artifacts, cloud: true, syncedBy: this.user.uid });
      const currentRef = this.api.doc(this.db, 'projects', projectId, 'library', ENGINEERING_CURRENT_ID);
      const immutableRef = this.api.doc(this.db, 'projects', projectId, 'library', `revex_engineering_revision_${revision}`);
      const currentRecord = revexRecord('engineering', cloudState, at);
      const immutableRecord = revexRecord('engineering-revision', { ...cloudState, immutable: true }, at);
      if (this.api.writeBatch) {
        const batch = this.api.writeBatch(this.db);
        batch.set(immutableRef, immutableRecord, plain({ merge: false }));
        batch.set(currentRef, currentRecord, plain({ merge: false }));
        await batch.commit();
      } else {
        // Safe fallback for older shared Firebase wrappers: an orphan immutable
        // revision is recoverable; a current pointer without its immutable source is not.
        await this.api.setDoc(immutableRef, immutableRecord, plain({ merge: false }));
        await this.api.setDoc(currentRef, currentRecord, plain({ merge: false }));
      }
      return this.hydrateStorageRecord(cloudState);
    },

    async getEngineeringState(projectId) {
      if (!projectId) return null;
      if (!this.isCloud()) {
        try { return JSON.parse(localStorage.getItem(`liber.revex.engineering.${projectId}`) || 'null'); } catch (_) { return null; }
      }
      const canonicalRef = this.api.doc(this.db, 'projects', projectId, 'library', ENGINEERING_CURRENT_ID);
      const snap = await this.api.getDoc(canonicalRef);
      if (snap.exists()) return this.hydrateStorageRecord({ id: snap.id, ...snap.data() });
      // Legacy r41-r48 records never establish project identity. Only a fresh
      // active-document evidence revision may become the managed Energy source.
      return null;
    },

    subscribeEngineeringState(projectId, callback) {
      if (!this.isCloud() || !projectId || !this.api.onSnapshot) return () => {};
      return this.api.onSnapshot(
        this.api.doc(this.db, 'projects', projectId, 'library', ENGINEERING_CURRENT_ID),
        (snap) => {
          if (!snap.exists()) { callback(null); return; }
          this.hydrateStorageRecord({ id: snap.id, ...snap.data() })
            .then(callback)
            .catch((error) => console.warn('[REVEX] Engineering asset hydration', error));
        },
        (error) => console.warn('[REVEX] Engineering state subscription', error)
      );
    },

    async recordEnergyConsent(projectId, sourceRevision) {
      if (!String(sourceRevision || '').trim()) throw new Error('Project and Engineering revision are required for COMcheck authorization.');
      const revision = docId(sourceRevision);
      if (!projectId || !revision) throw new Error('Project and Engineering revision are required for COMcheck authorization.');
      if (!this.isCloud() || !this.user?.uid) throw new Error('Sign in to authorize official COMcheck processing.');
      const engineeringRef = this.api.doc(this.db, 'projects', projectId, 'library', `revex_engineering_revision_${revision}`);
      const engineeringSnap = await this.api.getDoc(engineeringRef);
      if (!engineeringSnap.exists()) throw new Error('Publish the immutable Engineering revision before authorizing COMcheck processing.');
      const engineering = plain(engineeringSnap.data() || {});
      if (String(engineering.revision || engineering.manifest?.revision || '') !== revision)
        throw new Error('COMcheck authorization cannot be attached to a different Engineering revision.');
      const consent = plain({
        schema: COMCHECK_CONSENT_SCHEMA,
        projectId,
        sourceEngineeringRevision: revision,
        service: COMCHECK_SERVICE,
        endpoint: COMCHECK_ENDPOINT,
        scope: COMCHECK_SCOPE,
        approved: true,
        approvedAt: iso(),
        approvedByUid: String(this.user.uid),
        immutable: true
      });
      const consentRef = this.api.doc(this.db, 'projects', projectId, 'revexEnergyConsents', revision, 'approvers', String(this.user.uid));
      const existing = await this.api.getDoc(consentRef);
      if (existing.exists()) {
        const recorded = plain(existing.data() || {});
        const same = recorded.schema === COMCHECK_CONSENT_SCHEMA && recorded.approved === true &&
          recorded.projectId === projectId && recorded.sourceEngineeringRevision === revision &&
          recorded.service === COMCHECK_SERVICE && recorded.endpoint === COMCHECK_ENDPOINT &&
          recorded.scope === COMCHECK_SCOPE && recorded.approvedByUid === String(this.user.uid);
        if (!same) throw new Error('An incompatible COMcheck authorization record already exists for this user and Engineering revision.');
        return recorded;
      }
      await this.api.setDoc(consentRef, consent, plain({ merge: false }));
      return consent;
    },

    async getEnergyConsent(projectId, sourceRevision) {
      if (!String(sourceRevision || '').trim()) return null;
      const revision = docId(sourceRevision);
      if (!projectId || !revision || !this.isCloud() || !this.user?.uid) return null;
      const snap = await this.api.getDoc(
        this.api.doc(this.db, 'projects', projectId, 'revexEnergyConsents', revision, 'approvers', String(this.user.uid))
      );
      if (!snap.exists()) return null;
      const consent = plain(snap.data() || {});
      const valid = consent.schema === COMCHECK_CONSENT_SCHEMA && consent.approved === true &&
        consent.projectId === projectId && consent.sourceEngineeringRevision === revision &&
        consent.service === COMCHECK_SERVICE && consent.endpoint === COMCHECK_ENDPOINT &&
        consent.scope === COMCHECK_SCOPE && consent.approvedByUid === String(this.user.uid);
      return valid ? consent : null;
    },

    async runEnergyServer(projectId, sourceRevision) {
      if (!projectId || !sourceRevision) throw new Error('Project and Engineering revision are required for managed Energy processing.');
      if (!this.isCloud()) throw new Error('Managed Energy processing requires a signed-in REVEX cloud session.');
      const consent = await this.getEnergyConsent(projectId, sourceRevision);
      if (!consent) throw new Error('Authorize official COMcheck processing for this exact Engineering revision. No current-project CXL was transmitted.');
      const fs = this.fs || getService();
      const response = await callEnergyBroker(fs, plain({
        schema: 'liber.revex.energy-broker-request.v1',
        projectId,
        sourceRevision,
        clientBuild: '20260813r49'
      }));
      if (!response?.ok) throw new Error(response?.message || response?.error || 'REVEX managed Energy worker did not complete.');
      return response;
    },

    async applyEn1IdentityAmendment(projectId, sourceRevision, parentResultRevision, amendmentId) {
      if (!projectId || !sourceRevision || !parentResultRevision || !amendmentId)
        throw new Error('Project, Engineering revision, parent Energy result and amendment id are required.');
      if (!this.isCloud()) throw new Error('Apply to EN-1 requires a signed-in REVEX cloud session.');
      const consent = await this.getEnergyConsent(projectId, sourceRevision);
      if (!consent) throw new Error('This Engineering revision has no authenticated Energy authorization record.');
      const fs = this.fs || getService();
      const response = await callEnergyBroker(fs, plain({
        schema: 'liber.revex.energy-broker-request.v1',
        mode: 'EN1_IDENTITY_AMENDMENT',
        projectId,
        sourceRevision,
        parentResultRevision,
        amendmentId,
        clientBuild: '20260820r145-en1-amendment1'
      }));
      if (!response?.ok) throw new Error(response?.message || response?.error || 'REVEX could not publish the EN-1 amendment.');
      return response;
    },

    async publishEnergyResult(fileList, preferredProjectId) {
      const files = Array.from(fileList || []);
      const manifestFile = byName(files, 'energy-result.json');
      if (!manifestFile) throw new Error('The Energy result must include energy-result.json.');
      const manifest = await readJson(manifestFile);
      if (manifest?.schema !== 'liber.revex.energy-result.v1') throw new Error('This is not a compatible REVEX Energy result.');
      const projectId = preferredProjectId || manifest.projectId || null;
      if (!projectId) throw new Error('Choose a LIBER project before publishing an Energy result.');
      if (manifest.projectId && manifest.projectId !== projectId) throw new Error('The Energy result belongs to a different REVEX project.');
      if (manifest.revitWriteBack !== false || manifest.pdfInsertion !== false)
        throw new Error('The Energy result attempts to cross the Revit authority boundary.');

      const revision = docId(manifest.resultRevision || `energy_${Date.now()}`);
      const resultFiles = files.filter((file) => file !== manifestFile);
      const declared = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
      const at = iso();
      const localArtifacts = resultFiles.map((file, index) => ({
        ...(declared[index] || {}), name: declared[index]?.name || file.name, bytes: file.size || 0,
        url: URL.createObjectURL(file), cloud: false
      }));
      const state = { schema: 'liber.revex.energy-state.v1', projectId, revision, publishedAt: at, manifest, artifacts: localArtifacts, cloud: false };
      localStorage.setItem(`liber.revex.energy-result.${projectId}`, JSON.stringify({
        ...state, artifacts: localArtifacts.map(({ url, ...row }) => row), localOnly: true
      }));
      if (!this.isCloud()) return state;
      if (!this.fs.storage) throw new Error('LIBER Storage is not available in this session.');

      const base = `projects/${projectId}/revex/energy/results/${revision}`;
      const artifacts = [];
      for (let index = 0; index < resultFiles.length; index += 1) {
        const file = resultFiles[index];
        const uploaded = await this.uploadFile(`${base}/${String(index + 1).padStart(3, '0')}_${safe(file.name)}`, file);
        artifacts.push({ ...(declared[index] || {}), name: declared[index]?.name || file.name, bytes: file.size || 0, path: uploaded.path, cloud: true });
      }
      const manifestUpload = await this.uploadFile(`${base}/000_energy-result.json`, manifestFile);
      const cloudState = plain({ ...state, artifacts, manifestPath: manifestUpload.path, cloud: true, publishedBy: this.user.uid });
      await this.api.setDoc(
        this.api.doc(this.db, 'projects', projectId, 'library', ENERGY_CURRENT_ID),
        revexRecord('energy', cloudState, at),
        plain({ merge: false })
      );
      await this.api.setDoc(
        this.api.doc(this.db, 'projects', projectId, 'library', `revex_energy_result_${revision}`),
        revexRecord('energy-result', { ...cloudState, immutable: true }, at),
        plain({ merge: false })
      );
      return this.hydrateStorageRecord(cloudState);
    },

    async getEnergyResult(projectId) {
      if (!projectId) return null;
      if (!this.isCloud()) {
        try { return JSON.parse(localStorage.getItem(`liber.revex.energy-result.${projectId}`) || 'null'); } catch (_) { return null; }
      }
      const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', projectId, 'library', ENERGY_CURRENT_ID));
      return snap.exists() ? this.hydrateStorageRecord({ id: snap.id, ...snap.data() }) : null;
    },

    subscribeEnergyResult(projectId, callback) {
      if (!this.isCloud() || !projectId || !this.api.onSnapshot) return () => {};
      return this.api.onSnapshot(
        this.api.doc(this.db, 'projects', projectId, 'library', ENERGY_CURRENT_ID),
        (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null),
        (error) => console.warn('[REVEX] Energy result subscription', error)
      );
    },

    async listDesignEdits(projectId) {
      if (!this.isCloud() || !projectId) return [];
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'revexDesignItems'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },

    async saveDesignEdit(projectId, itemId, patch) {
      const data = { ...patch, updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
      if (!this.isCloud()) {
        const key = `liber.revex.design.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '{}');
        all[itemId] = { ...(all[itemId] || {}), ...data, id: itemId };
        localStorage.setItem(key, JSON.stringify(all));
        return all[itemId];
      }
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexDesignItems', itemId), plain(data), plain({ merge: true }));
      return { id: itemId, ...data };
    },

    async listChapterEdits(projectId) {
      if (!this.isCloud() || !projectId) {
        try { return Object.values(JSON.parse(localStorage.getItem(`liber.revex.chapters.${projectId}`) || '{}')); } catch (_) { return []; }
      }
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'revexDesignChapters'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },

    async saveChapterEdit(projectId, chapterId, patch) {
      const data = { ...patch, updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
      if (!this.isCloud()) {
        const key = `liber.revex.chapters.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '{}');
        all[chapterId] = { ...(all[chapterId] || {}), ...data, id: chapterId };
        localStorage.setItem(key, JSON.stringify(all));
        return all[chapterId];
      }
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexDesignChapters', chapterId), plain(data), plain({ merge: true }));
      return { id: chapterId, ...data };
    },

    async uploadChapterImage(projectId, chapterId, field, file, currentImages) {
      if (!['inspiration', 'renders', 'versionImages'].includes(field)) throw new Error('Unknown Design Book image lane.');
      const name = safe(file.name || 'image');
      if (!this.isCloud()) {
        const images = [...(currentImages || []), { url: await readDataUrl(file), path: null, name }].slice(-24);
        await this.saveChapterEdit(projectId, chapterId, { [field]: images });
        return images;
      }
      const uploaded = await this.uploadFile(`projects/${projectId}/revex/design/chapters/${docId(chapterId)}/${field}/${Date.now()}_${name}`, file);
      const images = [...(currentImages || []).map((asset) => this.sanitizeStoredAsset(asset, `Design Book chapter ${field}`)), { path: uploaded.path, name }].slice(-24);
      await this.saveChapterEdit(projectId, chapterId, { [field]: images });
      return Promise.all(images.map((asset) => this.hydrateStoredAsset(asset, `Design Book chapter ${field}`)));
    },

    async uploadDesignImage(projectId, itemId, file, currentImages) {
      const name = safe(file.name || 'image');
      if (!this.isCloud()) {
        const images = [...(currentImages || []), { url: await readDataUrl(file), path: null, name }].slice(-12);
        await this.saveDesignEdit(projectId, itemId, { images });
        return images;
      }
      const uploaded = await this.uploadFile(`projects/${projectId}/revex/design/${docId(itemId)}/${Date.now()}_${name}`, file);
      const images = [...(currentImages || []).map((asset) => this.sanitizeStoredAsset(asset, 'Design Book item image')), { path: uploaded.path, name }].slice(-12);
      await this.saveDesignEdit(projectId, itemId, { images });
      return Promise.all(images.map((asset) => this.hydrateStoredAsset(asset, 'Design Book item image')));
    },

    async listIssues(projectId) {
      if (!this.isCloud() || !projectId) {
        try { return JSON.parse(localStorage.getItem(`liber.revex.issues.${projectId}`) || '[]'); } catch (_) { return []; }
      }
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'revexIssues'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    async addIssue(projectId, issue) {
      const data = { ...issue, createdAt: iso(), createdBy: this.user?.uid || 'local' };
      if (!this.isCloud()) {
        const key = `liber.revex.issues.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '[]');
        const row = { id: `issue_${Date.now()}`, ...data };
        all.unshift(row); localStorage.setItem(key, JSON.stringify(all)); return row;
      }
      const ref = await this.api.addDoc(this.api.collection(this.db, 'projects', projectId, 'revexIssues'), plain(data));
      return { id: ref.id, ...data };
    },

    async updateIssue(projectId, issueId, patch) {
      if (!this.isCloud()) return;
      await this.api.updateDoc(this.api.doc(this.db, 'projects', projectId, 'revexIssues', issueId), plain({ ...patch, updatedAt: iso() }));
    },

    async listRenderJobs(projectId) {
      if (!projectId) return [];
      if (!this.isCloud()) {
        try { return Promise.all(JSON.parse(localStorage.getItem(`liber.revex.renders.${projectId}`) || '[]').map((row) => this.hydrateStorageRecord(row))); } catch (_) { return []; }
      }
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'revexRenders'));
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 40);
      return Promise.all(rows.map((row) => this.hydrateStorageRecord(row)));
    },

    async createRenderJob(projectId, job) {
      if (!this.isCloud()) throw new Error('Render jobs require a signed-in REVEX cloud session.');
      const uid = String(this.fs?.auth?.currentUser?.uid || this.user?.uid || '').trim();
      if (!uid) throw new Error('Sign in to LIBER Apps before creating a Render job.');
      if (job?.schema !== GOOGLE_RENDER_JOB_SCHEMA || job?.provider !== GOOGLE_RENDER_PROVIDER || job?.model !== GOOGLE_RENDER_MODEL || String(job?.status || '').toUpperCase() !== 'PREPARED')
        throw new Error('The Render request is not a controlled Google Render job.');
      const id = controlledRenderJobId();
      const now = iso();
      const data = plain({
        schema: GOOGLE_RENDER_JOB_SCHEMA,
        type: 'revex', hidden: true, revexKind: 'render', revexId: id,
        contextKind: String(job.contextKind || 'view').slice(0, 40),
        contextLabel: String(job.contextLabel || '').slice(0, 1000),
        elementId: job.elementId == null ? null : String(job.elementId).slice(0, 160),
        designItemId: job.designItemId == null ? null : String(job.designItemId).slice(0, 160),
        chapterId: job.chapterId == null ? null : String(job.chapterId).slice(0, 160),
        revision: job.revision == null ? null : String(job.revision).slice(0, 160),
        renderLocation: job.renderLocation && typeof job.renderLocation === 'object' ? job.renderLocation : null,
        sourceCamera: job.sourceCamera && typeof job.sourceCamera === 'object' ? job.sourceCamera : null,
        sourceRevision: String(job.sourceRevision || '').slice(0, 160),
        settings: job.settings && typeof job.settings === 'object' ? job.settings : {},
        provider: GOOGLE_RENDER_PROVIDER, model: GOOGLE_RENDER_MODEL,
        status: 'PREPARED', createdAt: now, updatedAt: now, createdBy: uid
      });
      const ref = this.api.doc(this.db, 'projects', projectId, 'revexRenders', id);
      await this.api.setDoc(ref, data, plain({ merge: false }));
      return { id, ...data };
    },

    async updateRenderJob(projectId, jobId, patch) {
      const transientResultUrl = patch?.resultUrl ? compatibleEphemeralUrl(patch.resultUrl, 'render result') : null;
      const data = { ...this.sanitizeRenderJob(projectId, patch), updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
      if (!this.isCloud()) {
        const key = `liber.revex.renders.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '[]');
        const index = all.findIndex((row) => row.id === jobId);
        if (index >= 0) all[index] = { ...all[index], ...data };
        localStorage.setItem(key, JSON.stringify(all));
        const row = index >= 0 ? all[index] : { id: jobId, ...data };
        return transientResultUrl ? { ...row, resultUrl: transientResultUrl } : row;
      }
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexRenders', jobId), plain(data), plain({ merge: true }));
      return transientResultUrl ? { id: jobId, ...data, resultUrl: transientResultUrl } : this.hydrateStorageRecord({ id: jobId, ...data });
    },

    async listLibrary(projectId) {
      if (!this.isCloud() || !projectId) return [];
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'library'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((row) => row.type === 'file');
    },

    async fileUrl(storagePath) {
      if (!storagePath || !this.fs?.storage) return null;
      const scopedPath = projectStoragePath(storagePath);
      const assetProjectId = scopedPath.split('/')[1];
      if (blobUrlCacheProjectId && blobUrlCacheProjectId !== assetProjectId) clearBlobUrlCache();
      blobUrlCacheProjectId = assetProjectId;
      if (!blobUrlCache.has(scopedPath)) {
        const pending = this.fileBlob(scopedPath).then((blob) => {
          if (!blob) throw new Error('The authenticated project file returned no data.');
          const url = URL.createObjectURL(blob);
          blobUrlPathCache.set(url, scopedPath);
          while (blobUrlCache.size >= BLOB_URL_CACHE_LIMIT) {
            const oldest = blobUrlCache.keys().next().value;
            const evicted = blobUrlCache.get(oldest);
            blobUrlCache.delete(oldest);
            Promise.resolve(evicted).then((prior) => { blobUrlPathCache.delete(prior); try { URL.revokeObjectURL(prior); } catch (_) {} }).catch(() => {});
          }
          return url;
        }).catch((error) => { blobUrlCache.delete(scopedPath); throw error; });
        blobUrlCache.set(scopedPath, pending);
      }
      return blobUrlCache.get(scopedPath);
    },

    storagePathForObjectUrl(value) {
      const url = compatibleEphemeralUrl(value, 'session object URL');
      if (!url || !url.startsWith('blob:')) return null;
      const storagePath = blobUrlPathCache.get(url) || null;
      return storagePath ? projectStoragePath(storagePath) : null;
    },

    async uploadLibraryFile(projectId, file, folderPath = 'record_in/docs', metadata = {}) {
      if (!projectId || !file) throw new Error('Project and file are required.');
      if (!this.isCloud() || !this.fs?.storage) throw new Error('Sign in to upload project documents.');
      const safeName = safe(file.name || 'file');
      const id = `manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
      const storagePath = `projects/${projectId}/library/${String(folderPath || 'record_in/docs').replace(/^\/+|\/+$/g,'')}/${id}_${safeName}`;
      const ref = this.api.ref(this.fs.storage, storagePath);
      await this.api.uploadBytes(ref, file, plain({ contentType: file.type || 'application/octet-stream' }));
      const at = iso();
      const data = plain({
        type: 'file', name: file.name || safeName, storagePath, folderPath, size: file.size || 0, mimeType: file.type || '',
        createdAt: at, updatedAt: at, createdBy: this.user?.uid || null, source: 'manual', editable: true, ...metadata
      });
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'library', id), data, plain({ merge: true }));
      return { id, ...data };
    },

    async listHistory(projectId) {
      if (!projectId) return [];
      if (!this.isCloud()) {
        try { return JSON.parse(localStorage.getItem(`liber.revex.history.${projectId}`) || '[]'); } catch (_) { return []; }
      }
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'revexHistory'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    async appendHistory(projectId, event) {
      if (!projectId) throw new Error('Choose a REVEX project first.');
      const at = iso();
      const id = event?.id || `hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const data = plain({
        id,
        projectId,
        sourceRevision: event?.sourceRevision || null,
        baseSourceRevision: event?.baseSourceRevision || null,
        commandId: event?.commandId || null,
        correlationId: event?.correlationId || null,
        documentFingerprint: event?.documentFingerprint || null,
        kind: event?.kind || 'project',
        operation: event?.operation || 'change',
        label: event?.label || event?.operation || 'Change',
        affectedElementIds: event?.affectedElementIds || [],
        affectedUniqueIds: event?.affectedUniqueIds || [],
        affectedLevels: event?.affectedLevels || [],
        affectedViews: event?.affectedViews || [],
        before: event?.before ?? null,
        after: event?.after ?? null,
        camera: event?.camera ?? null,
        snapshot: event?.snapshot ?? null,
        note: event?.note || '',
        relatedId: event?.relatedId || null,
        previousEventId: event?.previousEventId || null,
        createdAt: at,
        createdBy: this.user?.uid || 'local'
      });
      if (!this.isCloud()) {
        const key = `liber.revex.history.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '[]');
        all.unshift(data);
        localStorage.setItem(key, JSON.stringify(all.slice(0, 2500)));
        return data;
      }
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexHistory', id), data, plain({ merge: false }));
      return data;
    },

    async listBimOverlays(projectId) {
      if (!projectId) return [];
      if (!this.isCloud()) {
        try { return Object.values(JSON.parse(localStorage.getItem(`liber.revex.bim-overlays.${projectId}`) || '{}')); } catch (_) { return []; }
      }
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'revexBimOverlays'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },

    async commitBimOverlay(projectId, element, patch, meta = {}) {
      if (!projectId || !element) throw new Error('Project and BIM element are required.');
      const stable = String(element.uniqueId || element.id || '').trim();
      if (!stable) throw new Error('The selected BIM element has no stable Revit identity.');
      const overlayId = docId(stable);
      let before = null;
      if (!this.isCloud()) {
        const key = `liber.revex.bim-overlays.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '{}');
        before = all[overlayId] || null;
        const after = {
          ...(before || {}),
          ...plain(patch),
          id: overlayId,
          elementId: element.id ?? before?.elementId ?? null,
          uniqueId: element.uniqueId || before?.uniqueId || null,
          category: element.category || before?.category || '',
          level: element.level || before?.level || '',
          sourceRevision: meta.sourceRevision || before?.sourceRevision || null,
          updatedAt: iso(),
          updatedBy: this.user?.uid || 'local'
        };
        all[overlayId] = after;
        localStorage.setItem(key, JSON.stringify(all));
        const event = await this.appendHistory(projectId, {
          sourceRevision: meta.sourceRevision || null,
          kind: 'bim-overlay', operation: meta.operation || 'edit', label: meta.label || `${element.category || 'BIM'} ${element.id || ''}`.trim(),
          affectedElementIds: element.id != null ? [element.id] : [], affectedUniqueIds: element.uniqueId ? [element.uniqueId] : [],
          affectedLevels: element.level ? [element.level] : [], affectedViews: meta.affectedViews || [], before, after, camera: meta.camera || null,
          snapshot: meta.snapshot || null, note: meta.note || '', relatedId: overlayId, previousEventId: meta.previousEventId || null
        });
        return { overlay: after, event };
      }
      const f = this.api;
      const ref = f.doc(this.db, 'projects', projectId, 'revexBimOverlays', overlayId);
      try { const snap = await f.getDoc(ref); before = snap.exists() ? { id: snap.id, ...snap.data() } : null; } catch (_) {}
      const after = plain({
        ...(before || {}), ...patch, id: overlayId,
        elementId: element.id ?? before?.elementId ?? null, uniqueId: element.uniqueId || before?.uniqueId || null,
        category: element.category || before?.category || '', level: element.level || before?.level || '',
        sourceRevision: meta.sourceRevision || before?.sourceRevision || null, updatedAt: iso(), updatedBy: this.user?.uid || 'local'
      });
      await f.setDoc(ref, after, plain({ merge: false }));
      const event = await this.appendHistory(projectId, {
        sourceRevision: meta.sourceRevision || null,
        kind: 'bim-overlay', operation: meta.operation || 'edit', label: meta.label || `${element.category || 'BIM'} ${element.id || ''}`.trim(),
        affectedElementIds: element.id != null ? [element.id] : [], affectedUniqueIds: element.uniqueId ? [element.uniqueId] : [],
        affectedLevels: element.level ? [element.level] : [], affectedViews: meta.affectedViews || [], before, after, camera: meta.camera || null,
        snapshot: meta.snapshot || null, note: meta.note || '', relatedId: overlayId, previousEventId: meta.previousEventId || null
      });
      return { overlay: after, event };
    },

    async listDerivedPlans(projectId) {
      if (!projectId) return [];
      if (!this.isCloud()) {
        try { return JSON.parse(localStorage.getItem(`liber.revex.derived-plans.${projectId}`) || '[]'); } catch (_) { return []; }
      }
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'revexDerivedPlans'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },

    async saveDerivedPlan(projectId, plan, imageDataUrl = '') {
      if (!projectId) throw new Error('Choose a REVEX project first.');
      const id = plan?.id || `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const data = { ...plain(plan || {}), id, createdAt: iso(), createdBy: this.user?.uid || 'local' };
      if (!this.isCloud()) {
        const key = `liber.revex.derived-plans.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '[]');
        all.unshift({ ...data, imageDataUrl: imageDataUrl || null });
        localStorage.setItem(key, JSON.stringify(all.slice(0, 250)));
        return all[0];
      }
      let imagePath = null;
      if (imageDataUrl && this.fs?.storage) {
        const blob = await (await fetch(imageDataUrl)).blob();
        const file = new File([blob], `${id}.png`, { type: 'image/png' });
        const uploaded = await this.uploadFile(`projects/${projectId}/revex/derived-plans/${id}.png`, file);
        imagePath = uploaded.path;
      }
      const finalData = plain({ ...data, imagePath });
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexDerivedPlans', id), finalData, plain({ merge: false }));
      return this.hydrateStorageRecord(finalData);
    },

    async ensureProjectChat(projectId) {
      if (!this.fs?.callFunction) throw new Error('Project Chat is not available in this session.');
      return this.fs.callFunction('ensureProjectChat', { projectId });
    }
  };

  root.__revexStorageDataBoundary = Object.freeze({
    isLegacyFirebaseDownloadUrl,
    projectStoragePath,
    assertEngineeringSourceAlignment
  });
  root.RevexStore = Store;
})(window);
