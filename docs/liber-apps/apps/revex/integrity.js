(function (root) {
  'use strict';

  const Store = root.RevexStore;
  if (!Store) return;
  const BUILD = '20260909r190-sync-identity2';
  const iso = () => new Date().toISOString();
  const safe = (value) => String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
  const docId = (value) => safe(value).replace(/\./g, '_');
  const clone = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
  const firestorePlain = (value) => typeof Store.toFirestorePlain === 'function' ? Store.toFirestorePlain(value) : clone(value);
  const originalEnsureSpecProject = Store.ensureSpecProject.bind(Store);
  const originalCreateProject = Store.createProject.bind(Store);

  function cloudReady() {
    return Store.isCloud() && Store.api && Store.db && Store.user?.uid;
  }

  // A sync keeps the publishing account, even when auth changes between awaits.
  Store.captureSyncPublisher = function () {
    const uid = this.user?.uid || null;
    const wasCloud = Boolean(cloudReady());
    const assertCurrent = () => {
      const auth = this.fs?.auth;
      if ((this.user?.uid || null) !== uid ||
          (auth && 'currentUser' in auth && (auth.currentUser?.uid || null) !== uid))
        throw new Error('The LIBER account changed during publication. The preserved revision can be retried after sign-in.');
    };
    return { uid, wasCloud, assertCurrent };
  };

  function sameArtifactManifest(left, right) {
    const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
  }

  async function resumeCurrentPointer(projectId, prior, publisher) {
    const ref = libraryDoc(projectId, 'revex_state');
    const decide = snapshot => {
      const current = snapshot.exists() ? snapshot.data() : null;
      if (current?.revision === prior.revision) return false;
      // A retry may finish a failed pointer commit, but never roll back a newer sync.
      return (current?.revision || null) === (prior.publicationPreviousRevision || null);
    };
    const payload = firestorePlain({ ...prior, revexKind: 'state' });
    if (Store.api.runTransaction) {
      await Store.api.runTransaction(Store.db, async transaction => {
        const snapshot = await transaction.get(ref);
        publisher.assertCurrent();
        if (decide(snapshot)) transaction.set(ref, payload, firestorePlain({ merge: false }));
      });
    } else {
      const snapshot = await Store.api.getDoc(ref);
      publisher.assertCurrent();
      // Older wrappers cannot compare-and-set a nonempty current pointer safely.
      if (!snapshot.exists()) await Store.api.setDoc(ref, payload, firestorePlain({ merge: false }));
    }
    publisher.assertCurrent();
  }

  function library(projectId) {
    return Store.api.collection(Store.db, 'projects', projectId, 'library');
  }

  function libraryDoc(projectId, id) {
    return Store.api.doc(Store.db, 'projects', projectId, 'library', id);
  }

  async function setRecord(projectId, id, kind, data, merge = true) {
    const payload = firestorePlain({
      ...data,
      type: 'revex',
      hidden: true,
      revexKind: kind,
      updatedAt: data?.updatedAt || iso()
    });
    await Store.api.setDoc(libraryDoc(projectId, id), payload, firestorePlain({ merge }));
    return payload;
  }

  async function listKind(projectId, kind, max = 500) {
    if (!cloudReady() || !projectId) return [];
    const f = Store.api;
    const q = f.query(library(projectId), f.where('revexKind', '==', kind), f.limit(max));
    const snap = await f.getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  Store.subscribeKind = function subscribeControlledKind(projectId, kind, callback, max = 500, onError = null) {
    if (!cloudReady() || !projectId || !kind || !this.api.onSnapshot) return () => {};
    const f = this.api;
    const q = f.query(library(projectId), f.where('revexKind', '==', kind), f.limit(max));
    return f.onSnapshot(q,
      (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (error) => { console.warn(`[REVEX] ${kind} subscription`, error); onError?.(error); });
  };

  Store.subscribeLibraryFiles = function subscribeControlledLibrary(projectId, callback) {
    if (!cloudReady() || !projectId || !this.api.onSnapshot) return () => {};
    return this.api.onSnapshot(library(projectId),
      (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((row) => row.type === 'file')),
      (error) => console.warn('[REVEX] project library subscription', error));
  };

  async function upload(projectId, area, file, immutableName = false, assertCurrent = () => {}) {
    if (!Store.fs?.storage) throw new Error('LIBER Storage is not available in this session.');
    const f = Store.api;
    const name = safe(file.name || 'file');
    const path = `projects/${projectId}/library/revex/${area}/${immutableName ? name : `${Date.now()}_${name}`}`;
    const ref = f.ref(Store.fs.storage, path);
    assertCurrent();
    await f.uploadBytes(ref, file, firestorePlain({ contentType: file.type || (/\.json$/i.test(name) ? 'application/json' : 'application/octet-stream') }));
    assertCurrent();
    return { path, url: await f.getDownloadURL(ref), name, size: file.size };
  }

  async function verifyUploadedAsset(uploaded, file, label) {
    if (!uploaded?.url || !file?.size) throw new Error(`${label} did not produce a readable revision asset.`);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(uploaded.url, {
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`${label} upload verification returned ${response.status}.`);
      const reader = response.body?.getReader?.();
      if (!reader) throw new Error(`${label} upload verification returned no data stream.`);
      const first = await reader.read();
      await reader.cancel().catch(() => {});
      if (first.done || !first.value?.byteLength) throw new Error(`${label} upload verification returned an empty asset.`);
      if (/\.rvxmesh\.gz$/i.test(file.name) && (first.value.byteLength < 2 || first.value[0] !== 0x1f || first.value[1] !== 0x8b))
        throw new Error('Exact Revit geometry upload is not a valid gzip stream.');
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  }

  async function publishSpecScheduleSources(store, specProjectId, projectId, specPush, project, storagePath, storageUrl, revision, assertCurrent = () => {}) {
    const collection = store.api.collection(store.db, 'specProjects', specProjectId, 'sources');
    const manifestRef = store.api.doc(collection, 'revex-revit');
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
      const source = firestorePlain({
        type: 'revit',
        name: schedule?.schedule || 'REVEX Revit schedule',
        rev: specPush?.rev || revision,
        pushedAt: specPush?.pushedAt || iso(),
        payload: [],
        payloadEncoding: 'revex-storage-index-v1',
        payloadUrl: storageUrl,
        payloadIndex: sourceIds.length - 1,
        linkedProjectId: projectId,
        sourceScheduleId: identity,
        centralDocumentUniqueId: project?.central?.documentUniqueId || null,
        storagePath
      });
      assertCurrent();
      await store.api.setDoc(store.api.doc(collection, sourceId), source, firestorePlain({ merge: false }));
    }

    for (const sourceId of previousIds.filter((id) => !sourceIds.includes(id))) {
      assertCurrent();
      await store.api.setDoc(store.api.doc(collection, sourceId), firestorePlain({
        type: 'revit', name: 'Retired REVEX Revit schedule', rev: specPush?.rev || revision,
        pushedAt: specPush?.pushedAt || iso(), payload: [], linkedProjectId: projectId,
        retired: true, retiredAt: iso(), storagePath
      }), firestorePlain({ merge: false }));
    }

    // Emptying the former monolithic payload retires pre-r48 rows through the
    // existing non-destructive Spec merge while keeping authored fields/history.
    const manifest = firestorePlain({
      type: 'revit-manifest', name: 'REVEX controlled Revit schedules',
      rev: specPush?.rev || revision, pushedAt: specPush?.pushedAt || iso(),
      payload: [], linkedProjectId: projectId, scheduleSourceIds: sourceIds,
      scheduleCount: sourceIds.length, centralDocumentUniqueId: project?.central?.documentUniqueId || null,
      storagePath, payloadUrl: storageUrl, payloadEncoding: 'revex-storage-index-v1'
    });
    assertCurrent();
    await store.api.setDoc(manifestRef, manifest, firestorePlain({ merge: false }));
    return manifest;
  }

  function overlayVersionId(prefix, overlayId) {
    return `${prefix}_${docId(overlayId)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  async function appendLocalOverlayVersion(projectId, lane, overlayId, data) {
    const key = `liber.revex.${lane}-versions.${projectId}`;
    const rows = JSON.parse(localStorage.getItem(key) || '[]');
    rows.unshift({ id: overlayVersionId(lane, overlayId), overlayId, ...clone(data), createdAt: iso() });
    localStorage.setItem(key, JSON.stringify(rows.slice(0, 5000)));
  }

  async function readJson(file) {
    if (!file) return null;
    try { return JSON.parse(await file.text()); }
    catch (error) { throw new Error(`${file.name} is not valid JSON: ${error.message}`); }
  }

  function byName(files, name) {
    const matches = files.filter((file) => revisionBasename(file.name).toLowerCase() === String(name).toLowerCase());
    if (matches.length > 1) throw new Error(`REVEX package has ambiguous ${name}. Select one complete revision.`);
    return matches[0] || null;
  }

  function resolveAtomicPackageProject(project, preferredProjectId, preferredSpecProjectId) {
    const packageProjectId = String(project?.central?.projectId || '').trim();
    const requestedProjectId = String(preferredProjectId || '').trim();
    if (!packageProjectId)
      throw new Error('project.json has no authoritative Revit project binding. Re-sync the active Revit model.');
    if (project?.central?.bindingVersion !== 'active-revit-evidence-v1' || !String(project?.central?.identityEvidenceDigest || '').trim() || !String(project?.central?.documentUniqueId || '').trim())
      throw new Error('project.json has no evidence-verified active Revit document binding. Re-sync the active model.');
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

  async function sha256(file) {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // R190: one immutable binding per selected package, never a global "last file" map.
  // Paths retain their original spelling for Storage; comparison is Windows-case-insensitive.
  function revisionPath(value) {
    const path = String(value || '').replace(/\\/g, '/');
    if (!path || /[\u0000-\u001f\u007f:*?"<>|]/.test(path) || /%(?:2e|2f|5c)/i.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('REVEX package contains an invalid relative file path. Re-export this revision.');
    return path;
  }
  function revisionBasename(value) { return String(value || '').replace(/\\/g, '/').split('/').pop(); }
  const preparedRevisionFiles = new WeakMap();

  async function verifyIntegrity(files, integrity) {
    const manifest = Array.isArray(integrity?.files) ? integrity.files : [];
    if (!manifest.length) throw new Error('REVEX integrity manifest is empty. Re-sync from Revit.');
    if (new Set(files).size !== files.length) throw new Error('REVEX package reuses the same selected file more than once.');
    const entries = manifest.map(entry => {
      const path = revisionPath(entry?.name), key = path.toLowerCase();
      const digest = String(entry?.sha256 || '').toLowerCase(), bytes = Number(entry?.bytes);
      if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(bytes) || bytes < 0 || key === 'integrity.json')
        throw new Error(`REVEX integrity entry ${path} has invalid SHA-256 or byte-count authority.`);
      return Object.freeze({ path, key, digest, bytes });
    });
    if (new Set(entries.map(entry => entry.key)).size !== entries.length)
      throw new Error('REVEX integrity manifest repeats a path, including a case-only duplicate.');
    const pool = files.map(file => ({ file, name: revisionBasename(file.name).toLowerCase(),
      path: file.webkitRelativePath || String(file.name).includes('/') || String(file.name).includes('\\')
        ? revisionPath(file.webkitRelativePath || file.name).toLowerCase() : '', used: false }));
    const digests = new Map(), byPath = new Map(), byFile = new Map();
    const digestOf = file => {
      if (!digests.has(file)) digests.set(file, sha256(file));
      return digests.get(file);
    };
    // Assign explicit paths before pathless browser Files, so the latter cannot consume
    // an exact-path candidate required later. Same-byte duplicates remain distinct Files.
    for (const row of pool) if (row.path) {
      const paths = entries.filter(entry => row.path === entry.key || row.path.endsWith(`/${entry.key}`))
        .sort((a, b) => b.key.length - a.key.length);
      row.assignedPath = paths[0]?.key || '';
    }
    const pathMatches = (row, entry) => row.assignedPath === entry.key;
    const ordered = [...entries].sort((a, b) =>
      Number(pool.some(row => row.path && pathMatches(row, b))) - Number(pool.some(row => row.path && pathMatches(row, a))));
    for (const entry of ordered) {
      const candidates = pool.filter(row => !row.used && row.name === revisionBasename(entry.path).toLowerCase() &&
        (!row.path || pathMatches(row, entry)));
      const exact = candidates.filter(row => row.path);
      const available = exact.length ? exact : candidates;
      if (!available.length) throw new Error(`REVEX package is missing ${entry.path}. Re-sync from Revit.`);
      const matching = [];
      for (const row of available) if (await digestOf(row.file) === entry.digest) matching.push(row);
      if (!matching.length) throw new Error(`${entry.path} failed REVEX SHA-256 integrity validation.`);
      const row = matching.find(candidate => Number(candidate.file.size) === entry.bytes);
      if (!row) throw new Error(`${entry.path} size does not match the Revit revision manifest.`);
      row.used = true;
      byPath.set(entry.key, row.file);
      byFile.set(row.file, entry);
    }
    const extras = pool.filter(row => !row.used && row.name !== 'integrity.json');
    if (extras.length) throw new Error(`REVEX package includes an unassigned file ${extras[0].file.name}. Select only one complete revision.`);
    const resolve = (requested, lane = '', required = true) => {
      const path = revisionPath(requested), key = path.toLowerCase();
      const prefix = lane ? `${revisionPath(lane).toLowerCase()}/` : '';
      if (path.includes('/') && prefix && !key.startsWith(prefix))
        throw new Error(`REVEX document reference ${requested} is outside its ${lane} lane.`);
      const exactKey = path.includes('/') ? key : `${prefix}${key}`;
      // An explicit path is authority: never silently substitute its basename.
      const matches = byPath.has(exactKey) ? [byPath.get(exactKey)] : path.includes('/') || !prefix ? [] :
        entries.filter(entry => entry.key.startsWith(prefix) && revisionBasename(entry.key) === key).map(entry => byPath.get(entry.key));
      if (matches.length > 1) throw new Error(`REVEX document reference ${requested} is ambiguous. Re-export its full relative path.`);
      if (!matches.length && required) throw new Error(`REVEX package is missing ${lane ? `${lane}/` : ''}${requested}. Re-sync from Revit.`);
      return matches[0] || null;
    };
    return Object.freeze({ integrity, files: Object.freeze(entries.map(entry => byPath.get(entry.key))), resolve,
      entry: file => byFile.get(file) || null,
      path: file => { const entry = byFile.get(file); if (!entry) throw new Error('Cannot publish a file outside its verified REVEX package.'); return entry.path; }
    });
  }

  Store.prepareRevisionFiles = function prepareRevisionFiles(files) {
    if (!Object.isFrozen(files)) throw new Error('REVEX package selection must be fixed before verification.');
    if (!preparedRevisionFiles.has(files)) {
      const pending = (async () => {
        const manifestFile = byName(files, 'integrity.json');
        if (!manifestFile) throw new Error('Select the complete REVEX revision including integrity.json.');
        const identity = await verifyIntegrity(files, await readJson(manifestFile));
        return Object.freeze({ ...identity, manifestFile, manifestSha256: await sha256(manifestFile) });
      })();
      preparedRevisionFiles.set(files, pending);
      pending.catch(() => preparedRevisionFiles.delete(files));
    }
    return preparedRevisionFiles.get(files);
  };

  // A failed request can still have created its object. Check the exact destination
  // before writing, and reconcile an uncertain response once. Never replace an
  // existing object whose bytes differ, or treat denied access as "not found".
  Store.publishRevisionFile = async function publishRevisionFile(projectId, revision, file, identity, publisher) {
    const entry = file === identity.manifestFile
      ? { path: 'integrity.json', bytes: file.size, digest: identity.manifestSha256 }
      : identity.entry(file);
    if (!entry) throw new Error('Cannot publish a file outside its verified REVEX package.');
    if (revisionPath(projectId).includes('/') || revisionPath(revision).includes('/'))
      throw new Error('Invalid REVEX publication destination.');
    const path = `projects/${projectId}/library/revex/revisions/${revision}/${entry.path}`;
    const ref = this.api.ref(this.fs.storage, path);
    const authFailure = error => /^(storage\/(unauthenticated|unauthorized)|auth\/)/.test(String(error?.code || ''));
    const readExisting = async () => {
      publisher.assertCurrent();
      let url;
      try { url = await this.api.getDownloadURL(ref); }
      catch (error) {
        publisher.assertCurrent();
        if (error?.code === 'storage/object-not-found') return null;
        throw error;
      }
      publisher.assertCurrent();
      const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 90000);
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        publisher.assertCurrent();
        if (!response.ok) {
          const error = new Error(`REVEX preserved asset verification returned ${response.status}.`);
          if (response.status === 401 || response.status === 403) error.code = 'storage/unauthorized';
          throw error;
        }
        const reader = response.body?.getReader?.();
        if (!reader) throw new Error('REVEX preserved asset verification returned no readable stream.');
        const bytes = new Uint8Array(entry.bytes);
        let offset = 0;
        try {
          while (true) {
            const part = await reader.read();
            publisher.assertCurrent();
            if (part.done) break;
            if (offset + part.value.byteLength > bytes.length) throw new Error('REVEX preserved asset size differs from this immutable revision.');
            bytes.set(part.value, offset); offset += part.value.byteLength;
          }
        } finally { await reader.cancel().catch(() => {}); }
        if (offset !== entry.bytes) throw new Error('REVEX preserved asset size differs from this immutable revision.');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        publisher.assertCurrent();
        if ([...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') !== entry.digest)
          throw new Error('REVEX preserved asset SHA-256 differs from this immutable revision. It was not replaced.');
        return { path, url, name: file.name, size: file.size, reused: true };
      } finally { clearTimeout(deadline); controller.abort(); }
    };
    const existing = await readExisting();
    if (existing) return existing;
    publisher.assertCurrent();
    try {
      await this.api.uploadBytes(ref, file, firestorePlain({ contentType: file.type || (/\.json$/i.test(file.name) ? 'application/json' : 'application/octet-stream') }));
      publisher.assertCurrent();
      const url = await this.api.getDownloadURL(ref);
      publisher.assertCurrent();
      return { path, url, name: file.name, size: file.size, reused: false };
    } catch (error) {
      publisher.assertCurrent();
      if (authFailure(error) || error?.code === 'storage/canceled') throw error;
      const recovered = await readExisting();
      if (recovered) return recovered;
      throw error;
    }
  };

  Store.createProject = async function createProjectControlled(args = {}) {
    return originalCreateProject({ ...args, driveFileId: '' });
  };

  Store.ensureSpecProject = async function ensureSpecWithoutChurn(projectId, preferredId, suppliedProject = null, assertCurrent = () => {}) {
    // Keep Spec linkage stable, but never assume a newer Store helper exists. This file
    // can briefly coexist with an older cached store.js during a deployment refresh.
    if (typeof this.resolveSpecProject === 'function') {
      const existing = await this.resolveSpecProject(projectId, preferredId);
      assertCurrent();
      if (existing) return existing;
    }
    return originalEnsureSpecProject(projectId, preferredId, suppliedProject, assertCurrent);
  };

  Store.listHistory = async function listHistoryControlled(projectId) {
    if (!projectId) return [];
    if (!cloudReady()) {
      try { return JSON.parse(localStorage.getItem(`liber.revex.history.${projectId}`) || '[]'); } catch (_) { return []; }
    }
    return (await listKind(projectId, 'history', 2500))
      .map((row) => ({ ...row, id: row.revexId || row.id }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  };

  Store.appendHistory = async function appendHistoryControlled(projectId, event = {}) {
    if (!projectId) throw new Error('Choose a REVEX project first.');
    const at = iso();
    const id = event.id || `hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const data = clone({
      ...event, revexId: id, projectId, createdAt: event.createdAt || at,
      createdBy: event.createdBy || this.user?.uid || 'local', updatedAt: at
    });
    if (!cloudReady()) {
      const key = `liber.revex.history.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      all.unshift({ id, ...data });
      localStorage.setItem(key, JSON.stringify(all.slice(0, 2500)));
      return { id, ...data };
    }
    await setRecord(projectId, `revex_history_${docId(id)}`, 'history', data, false);
    return { id, ...data };
  };

  Store.listBimOverlays = async function listBimOverlaysControlled(projectId) {
    if (!projectId) return [];
    if (!cloudReady()) {
      try { return Object.values(JSON.parse(localStorage.getItem(`liber.revex.bim-overlays.${projectId}`) || '{}')); } catch (_) { return []; }
    }
    return (await listKind(projectId, 'bim-overlay', 5000)).map((row) => ({ ...row, id: row.revexId || row.id }));
  };

  Store.commitBimOverlay = async function commitBimOverlayControlled(projectId, element, patch, meta = {}) {
    if (!projectId || !element) throw new Error('Project and BIM element are required.');
    const stable = String(element.uniqueId || element.id || '').trim();
    if (!stable) throw new Error('The selected BIM element has no stable Revit identity.');
    const overlayId = docId(stable);
    let before = null;
    if (!cloudReady()) {
      const key = `liber.revex.bim-overlays.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      before = all[overlayId] || null;
      const after = {
        ...(before || {}), ...clone(patch), id: overlayId, revexId: overlayId,
        elementId: element.id ?? before?.elementId ?? null,
        uniqueId: element.uniqueId || before?.uniqueId || null,
        category: element.category || before?.category || '', level: element.level || before?.level || '',
        sourceRevision: meta.sourceRevision || before?.sourceRevision || null,
        updatedAt: iso(), updatedBy: this.user?.uid || 'local'
      };
      all[overlayId] = after;
      localStorage.setItem(key, JSON.stringify(all));
      const event = await this.appendHistory(projectId, {
        sourceRevision: meta.sourceRevision || null, kind: 'bim-overlay', operation: meta.operation || 'edit',
        label: meta.label || `${element.category || 'BIM'} ${element.id || ''}`.trim(),
        affectedElementIds: element.id != null ? [element.id] : [],
        affectedUniqueIds: element.uniqueId ? [element.uniqueId] : [], affectedLevels: element.level ? [element.level] : [],
        affectedViews: meta.affectedViews || [], before, after, camera: meta.camera || null, snapshot: meta.snapshot || null,
        note: meta.note || '', relatedId: overlayId, previousEventId: meta.previousEventId || null
      });
      return { overlay: after, event };
    }
    const existing = await listKind(projectId, 'bim-overlay', 5000);
    before = existing.find((row) => String(row.revexId || row.id) === overlayId) || null;
    const after = clone({
      ...(before || {}), ...patch, id: overlayId, revexId: overlayId,
      elementId: element.id ?? before?.elementId ?? null, uniqueId: element.uniqueId || before?.uniqueId || null,
      category: element.category || before?.category || '', level: element.level || before?.level || '',
      sourceRevision: meta.sourceRevision || before?.sourceRevision || null, updatedAt: iso(), updatedBy: this.user?.uid || 'local'
    });
    await setRecord(projectId, `revex_bim_${overlayId}`, 'bim-overlay', after, false);
    const event = await this.appendHistory(projectId, {
      sourceRevision: meta.sourceRevision || null, kind: 'bim-overlay', operation: meta.operation || 'edit',
      label: meta.label || `${element.category || 'BIM'} ${element.id || ''}`.trim(),
      affectedElementIds: element.id != null ? [element.id] : [], affectedUniqueIds: element.uniqueId ? [element.uniqueId] : [],
      affectedLevels: element.level ? [element.level] : [], affectedViews: meta.affectedViews || [], before, after,
      camera: meta.camera || null, snapshot: meta.snapshot || null, note: meta.note || '', relatedId: overlayId,
      previousEventId: meta.previousEventId || null
    });
    return { overlay: after, event };
  };

  Store.listDerivedPlans = async function listDerivedPlansControlled(projectId) {
    if (!projectId) return [];
    if (!cloudReady()) {
      try { return JSON.parse(localStorage.getItem(`liber.revex.derived-plans.${projectId}`) || '[]'); } catch (_) { return []; }
    }
    return (await listKind(projectId, 'derived-plan', 1000)).map((row) => ({ ...row, id: row.revexId || row.id }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  };

  Store.saveDerivedPlan = async function saveDerivedPlanControlled(projectId, plan = {}, imageDataUrl = '') {
    if (!projectId) throw new Error('Choose a REVEX project first.');
    const id = plan.id || `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const data = clone({ ...plan, id, revexId: id, createdAt: plan.createdAt || iso(), createdBy: plan.createdBy || this.user?.uid || 'local' });
    if (!cloudReady()) {
      const key = `liber.revex.derived-plans.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      all.unshift({ ...data, imageDataUrl: imageDataUrl || null });
      localStorage.setItem(key, JSON.stringify(all.slice(0, 250)));
      return all[0];
    }
    let imageUrl = null, imagePath = null;
    if (imageDataUrl && this.fs?.storage) {
      const blob = await (await fetch(imageDataUrl)).blob();
      const file = new File([blob], `${id}.png`, { type: 'image/png' });
      const uploaded = await upload(projectId, `derived-plans/${docId(id)}`, file);
      imageUrl = uploaded.url; imagePath = uploaded.path;
    }
    const finalData = clone({ ...data, imageUrl, imagePath });
    await setRecord(projectId, `revex_plan_${docId(id)}`, 'derived-plan', finalData, false);
    return finalData;
  };

  Store.getState = async function getControlledState(projectId) {
    if (!projectId) return null;
    if (!cloudReady()) {
      try { return JSON.parse(localStorage.getItem(`liber.revex.state.${projectId}`) || 'null'); } catch (_) { return null; }
    }
    const snap = await this.api.getDoc(libraryDoc(projectId, 'revex_state'));
    const state = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    return state;
  };

  Store.subscribeState = function subscribeControlledState(projectId, callback) {
    if (!cloudReady() || !projectId || !this.api.onSnapshot) return () => {};
    let active = true;
    const unsubscribe = this.api.onSnapshot(
      libraryDoc(projectId, 'revex_state'),
      (snap) => {
        if (!active) return;
        const state = snap.exists() ? { id: snap.id, ...snap.data() } : null;
        callback(state);
      },
      (error) => console.warn('[REVEX] controlled state subscription', error)
    );
    return () => { active = false; unsubscribe?.(); };
  };

  Store.syncPackage = async function syncControlledPackage(fileList, preferredProjectId, preferredSpecProjectId) {
    const publisher = this.captureSyncPublisher();
    const files = Array.isArray(fileList) && Object.isFrozen(fileList) ? fileList : Object.freeze(Array.from(fileList || []));
    const identity = await this.prepareRevisionFiles(files);
    publisher.assertCurrent();
    const projectFile = identity.resolve('project.json');
    const designFile = identity.resolve('design-book.json');
    const viewerFile = identity.resolve('viewer-model.json');
    const specFile = identity.resolve('spec-revit-push.json');
    const integrityFile = identity.manifestFile;
    const printingFile = identity.resolve('printing-sets.json', '', false);
    const pdfFiles = identity.files.filter(file => /\.pdf$/i.test(file.name));
    if (pdfFiles.length && this.revisionDocumentIdentity !== 'manifest-path-sha256-size-v1')
      throw new Error('REVEX sync components are not aligned. Reload Companion before retrying; this revision was not published.');
    const oneAsset = expression => {
      const matches = identity.files.filter(file => expression.test(revisionBasename(file.name)));
      if (matches.length > 1) throw new Error('REVEX revision has ambiguous authority model files. Re-export one complete revision.');
      return matches[0] || null;
    };
    const ifcFile = oneAsset(/\.ifc$/i);
    const geometryAsset = name => {
      const candidates = [identity.resolve(name, '', false),identity.resolve(name, 'geometry', false)].filter(Boolean);
      if (candidates.length > 1) throw new Error('This revision has ambiguous geometry authority files. Export one complete revision.');
      return candidates[0] || null;
    };
    const rvxMeshFile = geometryAsset('model.rvxmesh.gz');
    const meshManifestFile = geometryAsset('model.rvxpages.json');
    let meshPageFiles = [];
    if (meshManifestFile) {
      const pages = await readJson(meshManifestFile), lane = identity.path(meshManifestFile).includes('/') ? 'geometry' : '';
      if (pages?.schema !== 'liber.revex.geometry-pages.v1' || !Array.isArray(pages.pages) || !pages.pages.length ||
          new Set(pages.pages.map(row => String(row.file).toLowerCase())).size !== pages.pages.length)
        throw new Error('The geometry page manifest is incomplete or ambiguous.');
      meshPageFiles = pages.pages.map(row => {
        const file = identity.resolve(row.file,lane), entry = identity.entry(file);
        if (!/^model-page-\d+\.rvxmesh\.gz$/i.test(revisionBasename(row.file)) ||
            String(row.sha256 || '').toLowerCase() !== entry.digest || Number(row.compressedBytes) !== file.size)
          throw new Error('A geometry page differs from its declared immutable source.');
        return file;
      });
    }
    const fbxFile = oneAsset(/\.fbx$/i);

    if (!projectFile || !designFile || !viewerFile || !specFile || !integrityFile) {
      throw new Error('Select the complete REVEX revision: project, Design Book, Spec Book, viewer metadata and integrity manifest.');
    }

    const [project, design, viewer, specPush, integrity, printingSets] = await Promise.all([
      readJson(projectFile), readJson(designFile), readJson(viewerFile), readJson(specFile), readJson(integrityFile), printingFile ? readJson(printingFile) : null
    ]);
    const packageBinding = resolveAtomicPackageProject(project, preferredProjectId, preferredSpecProjectId);
    const projectId = packageBinding.projectId;
    if (!ifcFile) throw new Error('This revision has no IFC authority model. Re-sync with REVEX 0.7.0 or newer.');
    if ((!meshManifestFile || !meshPageFiles.length) && !rvxMeshFile)
      throw new Error('This revision has neither paged exact Revit geometry nor a compatible legacy geometry stream. The BIM pointer was not advanced.');
    publisher.assertCurrent();

    const revision = docId(integrity?.revision || `rev_${Date.now()}`);
    const localPackage = {
      projectId, revision, project, design, viewer, specPush, integrity, printingSets,
      printingDocs: pdfFiles.map((file) => ({ name: file.name, manifestPath: identity.path(file), url: URL.createObjectURL(file), size: file.size })),
      ifcUrl: URL.createObjectURL(ifcFile),
      modelUrl: meshManifestFile ? URL.createObjectURL(meshManifestFile) : URL.createObjectURL(rvxMeshFile),
      modelPages: meshPageFiles.map((file,index)=>({index:index+1,name:file.name,url:URL.createObjectURL(file),bytes:file.size})),
      modelFormat: meshManifestFile ? 'rvxmesh-gzip-pages' : 'rvxmesh-gzip',
      fallbackModelUrl: fbxFile ? URL.createObjectURL(fbxFile) : null,
      assetRevision: revision,
      modelRevision: revision,
      syncedAt: iso(), cloud: false
    };
    this.lastLocalPackage = localPackage;

    if (!publisher.wasCloud) {
      localStorage.setItem(`liber.revex.state.${projectId}`, JSON.stringify({
        projectId, revision, syncedAt: localPackage.syncedAt,
        geometryAuthority: 'ifc', sourceMode: 'controlled-revit-sync', localOnly: true,
        scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0,
        elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0
      }));
      return localPackage;
    }

    // A failed Docs handoff may already have committed the immutable BIM revision.
    // Validate and reuse it; never re-upload then try to overwrite a write-once record.
    const existing = await this.api.getDoc(libraryDoc(projectId, `revex_revision_${revision}`));
    publisher.assertCurrent();
    if (existing.exists()) {
      const prior = existing.data();
      if (prior.projectId !== projectId || prior.revision !== revision ||
          prior.central?.documentUniqueId !== project.central?.documentUniqueId ||
          !sameArtifactManifest(prior.integrity, integrity))
        throw new Error('This revision ID already belongs to a different package. Re-export a new revision; the existing revision was not changed.');
      await resumeCurrentPointer(projectId, prior, publisher);
      return { ...localPackage, ...prior, cloud: true, specProjectId: prior.spec?.projectId || packageBinding.specProjectId, resumedRevision: true };
    }
    const previousCurrent = await this.api.getDoc(libraryDoc(projectId, 'revex_state'));
    publisher.assertCurrent();

    // Docs owns PDF upload and indexing after this core immutable revision.
    const packageFiles = [...identity.files.filter(file => !/\.pdf$/i.test(file.name)), integrityFile];
    const uploads = new Map();
    for (const file of packageFiles) uploads.set(file, await this.publishRevisionFile(projectId, revision, file, identity, publisher));
    for (const file of meshPageFiles) await verifyUploadedAsset(uploads.get(file), file, `Exact Revit geometry page ${file.name}`);
    if (rvxMeshFile) await verifyUploadedAsset(uploads.get(rvxMeshFile), rvxMeshFile, 'Exact Revit geometry');
    await verifyUploadedAsset(uploads.get(viewerFile), viewerFile, 'BIM metadata');
    await verifyUploadedAsset(uploads.get(designFile), designFile, 'Design Book source');

    publisher.assertCurrent();
    const specProjectId = await this.ensureSpecProject(projectId, packageBinding.specProjectId, null, publisher.assertCurrent);
    publisher.assertCurrent();
    let specSync = { status: 'unlinked', projectId: null, rev: specPush?.rev || revision };
    if (specProjectId) {
      const source = await publishSpecScheduleSources(
        this, specProjectId, projectId, specPush, project,
        uploads.get(specFile)?.path || null,
        uploads.get(specFile)?.url || null, revision, publisher.assertCurrent);
      specSync = { status: 'published', projectId: specProjectId, rev: source.rev, pushedAt: source.pushedAt, scheduleCount: source.scheduleCount };
    }

    const state = clone({
      schema: 'liber.revex.cloud-state.v3',
      projectId,
      revision,
      latestRevision: revision,
      assetRevision: revision,
      modelRevision: revision,
      syncedAt: iso(),
      syncedBy: publisher.uid,
      publicationPreviousRevision: previousCurrent.exists() ? previousCurrent.data()?.revision || null : null,
      sourceMode: 'controlled-revit-sync',
      geometryAuthority: 'ifc',
      central: project?.central || null,
      integrity: integrity || null,
      ifcUrl: uploads.get(ifcFile)?.url || null,
      ifcPath: uploads.get(ifcFile)?.path || null,
      modelUrl: uploads.get(meshManifestFile || rvxMeshFile)?.url || null,
      modelPath: uploads.get(meshManifestFile || rvxMeshFile)?.path || null,
      modelPages: meshPageFiles.map((file,index)=>({ index:index+1, name:file.name, url:uploads.get(file)?.url||null, path:uploads.get(file)?.path||null, bytes:file.size })),
      modelFormat: meshManifestFile ? 'rvxmesh-gzip-pages' : 'rvxmesh-gzip',
      fallbackModelUrl: uploads.get(fbxFile)?.url || null,
      fallbackModelPath: uploads.get(fbxFile)?.path || null,
      viewerUrl: uploads.get(viewerFile)?.url || null,
      designUrl: uploads.get(designFile)?.url || null,
      projectUrl: uploads.get(projectFile)?.url || null,
      specPushUrl: uploads.get(specFile)?.url || null,
      printingSetsUrl: uploads.get(printingFile)?.url || null,
      printingSetCount: printingSets?.sets?.length || 0,
      printingSheetCount: (printingSets?.sets || []).reduce((n, set) => n + (set.pages?.length || 0), 0),
      scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0,
      elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0,
      spec: specSync,
      writeBackToRvt: false,
      type: 'revex', hidden: true, revexKind: 'state'
    });

    // The current pointer is a complete immutable-revision projection. Replacing
    // it prevents missing new assets from silently retaining URLs from an older
    // revision. Older revision records and files remain append-only/offloaded.
    publisher.assertCurrent();
    await setRecord(projectId, `revex_revision_${revision}`, 'revision', {
      ...state, revision, syncedAt: state.syncedAt, ifcPath: state.ifcPath, modelPath: state.modelPath,
      viewerUrl: state.viewerUrl, designUrl: state.designUrl, projectUrl: state.projectUrl,
      specPushUrl: state.specPushUrl, printingSetsUrl: state.printingSetsUrl, integrity: state.integrity, createdAt: state.syncedAt
    }, false);
    // Publish the single current pointer last. Readers keep the prior complete
    // revision visible until every new immutable asset and projection is ready.
    publisher.assertCurrent();
    await setRecord(projectId, 'revex_state', 'state', state, false);
    return { ...localPackage, ...state, cloud: true, specProjectId };
  };

  Store.listDesignEdits = async function listDesignEditsControlled(projectId) {
    if (!cloudReady() || !projectId) return [];
    return (await listKind(projectId, 'design-item')).map((row) => ({ ...row, id: row.revexId || row.id }));
  };

  Store.saveDesignEdit = async function saveDesignEditControlled(projectId, itemId, patch) {
    const sourceRevision = patch?.sourceRevision || root.__revexCloudState?.revision || null;
    const data = { ...patch, sourceRevision, revexId: itemId, overlayLane: 'design-book', updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.design.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      all[itemId] = { ...(all[itemId] || {}), ...data, id: itemId };
      localStorage.setItem(key, JSON.stringify(all));
      await appendLocalOverlayVersion(projectId, 'design', itemId, data);
      return all[itemId];
    }
    const versionId = overlayVersionId('design', itemId);
    await setRecord(projectId, `revex_design_version_${docId(versionId)}`, 'design-item-version', {
      ...data, revexId: versionId, overlayId: itemId, immutable: true, createdAt: iso()
    }, false);
    await setRecord(projectId, `revex_design_${docId(itemId)}`, 'design-item', data, true);
    return { id: itemId, ...data };
  };

  Store.saveDesignVersionEdit = async function saveDesignVersionEditControlled(projectId, itemId, patch, expectedVersions) {
    const publisher = this.captureSyncPublisher();
    publisher.assertCurrent();
    const sourceRevision = patch?.sourceRevision || root.__revexCloudState?.revision || null;
    const data = { ...patch, sourceRevision, revexId: itemId, overlayLane: 'design-book', updatedAt: iso(), updatedBy: publisher.uid || 'local' };
    const verify = record => {
      if (!sameArtifactManifest(record?.propertyVersions || [], expectedVersions || [])) {
        const error = new Error('This position changed in another session. Reopen the position before saving; your current entries are still here.');
        error.code = 'design-version-conflict'; throw error;
      }
    };
    if (!cloudReady()) {
      const key = `liber.revex.design.${projectId}`, all = JSON.parse(localStorage.getItem(key) || '{}');
      verify(all[itemId]);
      all[itemId] = { ...(all[itemId] || {}), ...data, id: itemId };
      localStorage.setItem(key, JSON.stringify(all));
      await appendLocalOverlayVersion(projectId, 'design', itemId, data);
      return all[itemId];
    }
    const currentRef = libraryDoc(projectId, `revex_design_${docId(itemId)}`);
    const versionId = overlayVersionId('design', itemId);
    const versionRef = libraryDoc(projectId, `revex_design_version_${docId(versionId)}`);
    const payload = firestorePlain({ ...data, type: 'revex', hidden: true, revexKind: 'design-item' });
    await this.api.runTransaction(this.db, async transaction => {
      const previous = await transaction.get(currentRef);
      publisher.assertCurrent(); verify(previous.exists() ? previous.data() : null);
      transaction.set(versionRef, firestorePlain({ ...payload, revexKind: 'design-item-version', revexId: versionId, overlayId: itemId, immutable: true, createdAt: iso() }), firestorePlain({ merge: false }));
      transaction.set(currentRef, payload, firestorePlain({ merge: true }));
    });
    publisher.assertCurrent();
    return { id: itemId, ...data };
  };

  Store.listChapterEdits = async function listChapterEditsControlled(projectId) {
    if (!cloudReady() || !projectId) {
      try { return Object.values(JSON.parse(localStorage.getItem(`liber.revex.chapters.${projectId}`) || '{}')); } catch (_) { return []; }
    }
    return (await listKind(projectId, 'design-chapter')).map((row) => ({ ...row, id: row.revexId || row.id }));
  };

  Store.saveChapterEdit = async function saveChapterEditControlled(projectId, chapterId, patch) {
    const sourceRevision = patch?.sourceRevision || root.__revexCloudState?.revision || null;
    const data = { ...patch, sourceRevision, revexId: chapterId, overlayLane: 'design-book', updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.chapters.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      all[chapterId] = { ...(all[chapterId] || {}), ...data, id: chapterId };
      localStorage.setItem(key, JSON.stringify(all));
      await appendLocalOverlayVersion(projectId, 'chapter', chapterId, data);
      return all[chapterId];
    }
    const versionId = overlayVersionId('chapter', chapterId);
    await setRecord(projectId, `revex_chapter_version_${docId(versionId)}`, 'design-chapter-version', {
      ...data, revexId: versionId, overlayId: chapterId, immutable: true, createdAt: iso()
    }, false);
    await setRecord(projectId, `revex_chapter_${docId(chapterId)}`, 'design-chapter', data, true);
    return { id: chapterId, ...data };
  };

  Store.saveChapterImages = async function saveChapterImagesControlled(projectId, chapterId, field, images, expectedImages) {
    if (!['inspiration', 'renders', 'versionImages'].includes(field)) throw new Error('Unknown Design Book image lane.');
    const publisher = this.captureSyncPublisher(); publisher.assertCurrent();
    const data = { [field]: images, revexId: chapterId, overlayLane: 'design-book', sourceRevision: root.__revexCloudState?.revision || null, updatedAt: iso(), updatedBy: publisher.uid || 'local' };
    const verify = record => {
      // A missing overlay inherits the source chapter; an existing empty array is intentional.
      if (!sameArtifactManifest(record?.[field] ?? expectedImages ?? [], expectedImages || [])) {
        const error = new Error('These chapter images changed in another session. Reload the chapter before trying again.');
        error.code = 'chapter-image-conflict'; throw error;
      }
    };
    if (!cloudReady()) {
      const key = `liber.revex.chapters.${projectId}`, all = JSON.parse(localStorage.getItem(key) || '{}');
      verify(all[chapterId]); all[chapterId] = { ...(all[chapterId] || {}), ...data, id: chapterId };
      localStorage.setItem(key, JSON.stringify(all));
      await appendLocalOverlayVersion(projectId, 'chapter', chapterId, data);
    } else {
      const currentRef = libraryDoc(projectId, `revex_chapter_${docId(chapterId)}`), versionId = overlayVersionId('chapter', chapterId);
      const versionRef = libraryDoc(projectId, `revex_chapter_version_${docId(versionId)}`);
      const payload = firestorePlain({ ...data, type: 'revex', hidden: true, revexKind: 'design-chapter' });
      await this.api.runTransaction(this.db, async tx => {
        const previous = await tx.get(currentRef); publisher.assertCurrent(); verify(previous.exists() ? previous.data() : null);
        tx.set(versionRef, firestorePlain({ ...payload, revexKind: 'design-chapter-version', revexId: versionId, overlayId: chapterId, immutable: true, createdAt: iso() }));
        tx.set(currentRef, payload, { merge: true });
      });
    }
    publisher.assertCurrent(); return images;
  };

  Store.uploadChapterImage = async function uploadChapterImageControlled(projectId, chapterId, field, file, currentImages) {
    if (!['inspiration', 'renders', 'versionImages'].includes(field)) throw new Error('Unknown Design Book image lane.');
    if ((currentImages || []).length >= 24) throw new Error('This lane has 24 images. Remove one before adding another.');
    const publisher = this.captureSyncPublisher(); publisher.assertCurrent();
    if (!cloudReady()) {
      const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = reject; r.readAsDataURL(file); });
      const images = [...(currentImages || []), { url, path: null, name: safe(file.name) }];
      publisher.assertCurrent(); await this.saveChapterImages(projectId, chapterId, field, images, currentImages);
      return images;
    }
    const uploaded = await upload(projectId, `design/chapters/${docId(chapterId)}/${field}`, file);
    const images = [...(currentImages || []), { url: uploaded.url, path: uploaded.path, name: uploaded.name }];
    publisher.assertCurrent(); await this.saveChapterImages(projectId, chapterId, field, images, currentImages);
    return images;
  };

  Store.uploadDesignImage = async function uploadDesignImageControlled(projectId, itemId, file, currentImages) {
    if (!cloudReady()) {
      const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = reject; r.readAsDataURL(file); });
      const images = [...(currentImages || []), { url, path: null, name: safe(file.name) }].slice(-12);
      await this.saveDesignEdit(projectId, itemId, { images });
      return images;
    }
    const uploaded = await upload(projectId, `design/items/${docId(itemId)}`, file);
    const images = [...(currentImages || []), { url: uploaded.url, path: uploaded.path, name: uploaded.name }].slice(-12);
    await this.saveDesignEdit(projectId, itemId, { images });
    return images;
  };

  Store.listIssues = async function listIssuesControlled(projectId) {
    if (!cloudReady() || !projectId) {
      try { return JSON.parse(localStorage.getItem(`liber.revex.issues.${projectId}`) || '[]'); } catch (_) { return []; }
    }
    return (await listKind(projectId, 'issue', 500))
      .map((row) => ({ ...row, id: row.revexId || row.id }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  };

  Store.addIssue = async function addIssueControlled(projectId, issue) {
    const id = `issue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const data = { ...issue, revexId: id, createdAt: iso(), createdBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.issues.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      const row = { id, ...data }; all.unshift(row); localStorage.setItem(key, JSON.stringify(all)); return row;
    }
    await setRecord(projectId, `revex_issue_${docId(id)}`, 'issue', data, false);
    return { id, ...data };
  };

  Store.updateIssue = async function updateIssueControlled(projectId, issueId, patch) {
    if (!cloudReady()) return;
    await setRecord(projectId, `revex_issue_${docId(issueId)}`, 'issue', { ...patch, revexId: issueId, updatedAt: iso() }, true);
  };

  Store.listRenderJobs = async function listRenderJobsControlled(projectId) {
    if (!projectId) return [];
    if (!cloudReady()) {
      try { return JSON.parse(localStorage.getItem(`liber.revex.renders.${projectId}`) || '[]'); } catch (_) { return []; }
    }
    return (await listKind(projectId, 'render', 100))
      .map((row) => ({ ...row, id: row.revexId || row.id }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 40);
  };

  Store.createRenderJob = async function createRenderJobControlled(projectId, job) {
    const id = `render_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const data = { ...job, revexId: id, status: job.status || 'prepared', createdAt: iso(), updatedAt: iso(), createdBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.renders.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      const row = { id, ...data }; all.unshift(row); localStorage.setItem(key, JSON.stringify(all.slice(0, 40))); return row;
    }
    await setRecord(projectId, `revex_render_${docId(id)}`, 'render', data, false);
    return { id, ...data };
  };

  Store.updateRenderJob = async function updateRenderJobControlled(projectId, jobId, patch) {
    const data = { ...patch, revexId: jobId, updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.renders.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      const index = all.findIndex((row) => row.id === jobId);
      if (index >= 0) all[index] = { ...all[index], ...data };
      localStorage.setItem(key, JSON.stringify(all));
      return index >= 0 ? all[index] : { id: jobId, ...data };
    }
    await setRecord(projectId, `revex_render_${docId(jobId)}`, 'render', data, true);
    return { id: jobId, ...data };
  };

  function disableParentRevexKeepAlive() {
    try {
      const manager = root.parent && root.parent !== root ? root.parent.appsManager : null;
      if (!manager || manager.__revexControlledKeepAlivePatch) return;
      const original = typeof manager.isKeepAliveApp === 'function' ? manager.isKeepAliveApp.bind(manager) : null;
      manager.isKeepAliveApp = (src) => {
        if (/apps\/revex\/index\.html/i.test(String(src || ''))) return false;
        return original ? original(src) : false;
      };
      manager.__revexControlledKeepAlivePatch = true;
    } catch (_) {}
  }

  function stabilizeActions() {
    const expected = { 'new-project-button': 'New', 'invite-project-button': 'Invite', 'sync-button': 'Import sync', 'render-button': 'Render' };
    Object.entries(expected).forEach(([id, text]) => { const button = document.getElementById(id); if (button) button.textContent = text; });
    const nav = document.querySelector('.main-nav');
    if (nav) {
      const renders = [...nav.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Render');
      renders.slice(1).forEach((button) => { if (button.id !== 'render-button') button.remove(); });
    }
  }

  function installSelectionSheet() {
    const inspector = document.getElementById('bim-inspector');
    if (!inspector) return;
    const update = () => {
      const selected = !/no element selected/i.test(inspector.querySelector('h2')?.textContent || '');
      inspector.classList.toggle('revex-selection-open', selected && window.matchMedia('(max-width: 860px)').matches);
      if (selected && !inspector.querySelector('.revex-selection-close')) {
        const close = document.createElement('button');
        close.type = 'button'; close.className = 'revex-selection-close sp-icon-btn'; close.textContent = '×'; close.setAttribute('aria-label', 'Close element information');
        close.addEventListener('click', () => inspector.classList.remove('revex-selection-open'));
        inspector.prepend(close);
      }
    };
    new MutationObserver(update).observe(inspector, { childList: true, subtree: true });
    update();
  }

  function installAuthorityBadge() {
    const facts = document.getElementById('model-facts');
    if (!facts) return;
    const update = () => {
      if (root.__revexCloudState?.geometryAuthority !== 'ifc') return;
      if (facts.querySelector('[data-revex-ifc-authority]')) return;
      const node = document.createElement('div');
      node.className = 'fact'; node.dataset.revexIfcAuthority = '1'; node.innerHTML = '<strong>IFC</strong><span>sync authority</span>';
      facts.appendChild(node);
    };
    new MutationObserver(update).observe(facts, { childList: true, subtree: true });
    update();
  }

  document.addEventListener('DOMContentLoaded', () => {
    disableParentRevexKeepAlive();
    stabilizeActions();
    installSelectionSheet();
    installAuthorityBadge();
    console.log(`[REVEX] integrity ${BUILD}`, { sync: 'controlled-ifc', state: 'project-library', driveModelSource: false });
  }, { once: true });
})(window);
