(function (root) {
  'use strict';

  const Store = root.RevexStore;
  if (!Store) return;
  const BUILD = '20260813r49';
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

  const assetFields = ['images', 'inspiration', 'renders', 'versionImages'];
  function sanitizeAssetRows(rows, label) {
    return (rows || []).map((asset) => Store.sanitizeStoredAsset(asset, label));
  }
  async function hydrateAssetFields(row, label) {
    const next = { ...row };
    for (const field of assetFields) if (Array.isArray(next[field]))
      next[field] = await Promise.all(next[field].map((asset) => Store.hydrateStoredAsset(asset, `${label} ${field}`)));
    return next;
  }

  function exactProjectAssetPath(projectId, value, label = 'project asset') {
    const path = String(value || '').trim().replace(/\\/g, '/');
    if (!path || !path.startsWith(`projects/${projectId}/`) || path.includes('/../') || path.endsWith('/..'))
      throw new Error(`${label} is not scoped to the active REVEX project.`);
    return path;
  }

  async function sanitizeRenderJob(projectId, value) {
    const data = { ...(value || {}) };
    let resultPath = data.resultPath ? exactProjectAssetPath(projectId, data.resultPath, 'Render result') : null;
    if (!resultPath && data.resultUrl && typeof Store.storagePathForObjectUrl === 'function') {
      const cachedPath = Store.storagePathForObjectUrl(data.resultUrl);
      if (cachedPath) resultPath = exactProjectAssetPath(projectId, cachedPath, 'Render result');
    }
    delete data.resultUrl;
    if (resultPath) data.resultPath = resultPath;
    else delete data.resultPath;
    return data;
  }

  async function hydrateRenderJob(row) {
    const next = { ...row };
    if (next.resultPath) next.resultUrl = await Store.fileUrl(next.resultPath);
    else if (next.resultUrl) next.resultUrl = Store.assertEphemeralUrl(next.resultUrl, 'legacy render result');
    return next;
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

  Store.subscribeKind = function subscribeControlledKind(projectId, kind, callback, max = 500) {
    if (!cloudReady() || !projectId || !kind || !this.api.onSnapshot) return () => {};
    const f = this.api;
    const q = f.query(library(projectId), f.where('revexKind', '==', kind), f.limit(max));
    return f.onSnapshot(q,
      (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (error) => console.warn(`[REVEX] ${kind} subscription`, error));
  };

  Store.subscribeLibraryFiles = function subscribeControlledLibrary(projectId, callback) {
    if (!cloudReady() || !projectId || !this.api.onSnapshot) return () => {};
    return this.api.onSnapshot(library(projectId),
      (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((row) => row.type === 'file')),
      (error) => console.warn('[REVEX] project library subscription', error));
  };

  async function upload(projectId, area, file, immutableName = false) {
    if (!Store.fs?.storage) throw new Error('LIBER Storage is not available in this session.');
    const f = Store.api;
    const name = safe(file.name || 'file');
    const path = `projects/${projectId}/library/revex/${area}/${immutableName ? name : `${Date.now()}_${name}`}`;
    const ref = f.ref(Store.fs.storage, path);
    await f.uploadBytes(ref, file, firestorePlain({ contentType: file.type || (/\.json$/i.test(name) ? 'application/json' : 'application/octet-stream') }));
    return { path, name, size: file.size };
  }

  async function verifyUploadedAsset(uploaded, file, label) {
    if (!uploaded?.path || !file?.size || typeof Store.fileBlob !== 'function') throw new Error(`${label} did not produce a readable revision asset.`);
    const blob = await Store.fileBlob(uploaded.path);
    if (!blob || blob.size !== file.size) throw new Error(`${label} authenticated verification returned the wrong byte count.`);
    const first = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
      if (!first.byteLength) throw new Error(`${label} upload verification returned an empty asset.`);
      if (/\.rvxmesh\.gz$/i.test(file.name) && (first.byteLength < 2 || first[0] !== 0x1f || first[1] !== 0x8b))
        throw new Error('Exact Revit geometry upload is not a valid gzip stream.');
  }

  async function publishSpecScheduleSources(store, specProjectId, projectId, specPush, project, storagePath, revision) {
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
        payloadIndex: sourceIds.length - 1,
        linkedProjectId: projectId,
        sourceScheduleId: identity,
        centralDocumentUniqueId: project?.central?.documentUniqueId || null,
        storagePath
      });
      await store.api.setDoc(store.api.doc(collection, sourceId), source, firestorePlain({ merge: false }));
    }

    for (const sourceId of previousIds.filter((id) => !sourceIds.includes(id))) {
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
      storagePath, payloadEncoding: 'revex-storage-index-v1'
    });
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
    return files.find((file) => String(file.name || '').toLowerCase() === String(name).toLowerCase()) || null;
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

  async function verifyIntegrity(files, integrity) {
    const entries = Array.isArray(integrity?.files) ? integrity.files : [];
    if (!entries.length) throw new Error('REVEX integrity manifest is empty. Re-sync from Revit.');
    for (const entry of entries) {
      const name = String(entry?.name || '').split('/').pop();
      const file = byName(files, name);
      if (!file) throw new Error(`REVEX package is missing ${name}. Re-sync from Revit.`);
      if (Number(entry.bytes) !== Number(file.size)) throw new Error(`${name} size does not match the Revit revision manifest.`);
      const digest = await sha256(file);
      if (digest !== String(entry.sha256 || '').toLowerCase()) throw new Error(`${name} failed REVEX SHA-256 integrity validation.`);
    }
    return true;
  }

  Store.createProject = async function createProjectControlled(args = {}) {
    return originalCreateProject({ ...args, driveFileId: '' });
  };

  Store.ensureSpecProject = async function ensureSpecWithoutChurn(projectId, preferredId, suppliedProject = null) {
    // Keep Spec linkage stable, but never assume a newer Store helper exists. This file
    // can briefly coexist with an older cached store.js during a deployment refresh.
    if (typeof this.resolveSpecProject === 'function') {
      const existing = await this.resolveSpecProject(projectId, preferredId);
      if (existing) return existing;
    }
    return originalEnsureSpecProject(projectId, preferredId, suppliedProject);
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
    const rows = (await listKind(projectId, 'derived-plan', 1000)).map((row) => ({ ...row, id: row.revexId || row.id }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return Promise.all(rows.map((row) => Store.hydrateStorageRecord(row)));
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
    let imagePath = null;
    if (imageDataUrl && this.fs?.storage) {
      const blob = await (await fetch(imageDataUrl)).blob();
      const file = new File([blob], `${id}.png`, { type: 'image/png' });
      const uploaded = await upload(projectId, `derived-plans/${docId(id)}`, file);
      imagePath = uploaded.path;
    }
    const finalData = clone({ ...data, imagePath });
    await setRecord(projectId, `revex_plan_${docId(id)}`, 'derived-plan', finalData, false);
    return Store.hydrateStorageRecord(finalData);
  };

  Store.getState = async function getControlledState(projectId) {
    if (!projectId) return null;
    if (!cloudReady()) {
      try { return JSON.parse(localStorage.getItem(`liber.revex.state.${projectId}`) || 'null'); } catch (_) { return null; }
    }
    const snap = await this.api.getDoc(libraryDoc(projectId, 'revex_state'));
    const state = snap.exists() ? await this.hydrateStorageRecord({ id: snap.id, ...snap.data() }) : null;
    root.__revexCloudState = state;
    return state;
  };

  Store.subscribeState = function subscribeControlledState(projectId, callback) {
    if (!cloudReady() || !projectId || !this.api.onSnapshot) return () => {};
    return this.api.onSnapshot(
      libraryDoc(projectId, 'revex_state'),
      (snap) => {
        if (!snap.exists()) { root.__revexCloudState = null; callback(null); return; }
        this.hydrateStorageRecord({ id: snap.id, ...snap.data() }).then((state) => {
          root.__revexCloudState = state;
          callback(state);
        }).catch((error) => console.warn('[REVEX] controlled state asset hydration', error));
      },
      (error) => console.warn('[REVEX] controlled state subscription', error)
    );
  };

  Store.syncPackage = async function syncControlledPackage(fileList, preferredProjectId, preferredSpecProjectId) {
    const files = Array.from(fileList || []);
    const projectFile = byName(files, 'project.json');
    const designFile = byName(files, 'design-book.json');
    const viewerFile = byName(files, 'viewer-model.json');
    const specFile = byName(files, 'spec-revit-push.json');
    const integrityFile = byName(files, 'integrity.json');
    const printingFile = byName(files, 'printing-sets.json');
    const pdfFiles = files.filter((file) => /\.pdf$/i.test(file.name));
    const ifcFile = files.find((file) => /\.ifc$/i.test(file.name)) || null;
    const rvxMeshFile = files.find((file) => /^model\.rvxmesh\.gz$/i.test(file.name)) || null;
    const meshManifestFile = byName(files, 'model.rvxpages.json');
    const meshPageFiles = files.filter((file) => /^model-page-\d+\.rvxmesh\.gz$/i.test(file.name)).sort((a,b)=>a.name.localeCompare(b.name));
    const fbxFile = files.find((file) => /\.fbx$/i.test(file.name)) || null;

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
    await verifyIntegrity(files, integrity);

    const revision = docId(integrity?.revision || `rev_${Date.now()}`);
    const localPackage = {
      projectId, revision, project, design, viewer, specPush, integrity, printingSets,
      printingDocs: pdfFiles.map((file) => ({ name: file.name, url: URL.createObjectURL(file), size: file.size })),
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

    if (!cloudReady()) {
      localStorage.setItem(`liber.revex.state.${projectId}`, JSON.stringify({
        projectId, revision, syncedAt: localPackage.syncedAt,
        geometryAuthority: 'ifc', sourceMode: 'controlled-revit-sync', localOnly: true,
        scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0,
        elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0
      }));
      return localPackage;
    }

    const area = `revisions/${revision}`;
    const packageFiles = [projectFile, designFile, viewerFile, specFile, integrityFile, printingFile, ifcFile, meshManifestFile, rvxMeshFile, ...meshPageFiles, fbxFile, ...pdfFiles].filter(Boolean);
    const uploads = {};
    for (const file of packageFiles) uploads[file.name] = await upload(projectId, area, file, true);
    for (const file of meshPageFiles) await verifyUploadedAsset(uploads[file.name], file, `Exact Revit geometry page ${file.name}`);
    if (rvxMeshFile) await verifyUploadedAsset(uploads[rvxMeshFile.name], rvxMeshFile, 'Exact Revit geometry');
    await verifyUploadedAsset(uploads['viewer-model.json'], viewerFile, 'BIM metadata');
    await verifyUploadedAsset(uploads['design-book.json'], designFile, 'Design Book source');

    const specProjectId = await this.ensureSpecProject(projectId, packageBinding.specProjectId);
    let specSync = { status: 'unlinked', projectId: null, rev: specPush?.rev || revision };
    if (specProjectId) {
      const source = await publishSpecScheduleSources(
        this, specProjectId, projectId, specPush, project,
        uploads['spec-revit-push.json']?.path || null, revision);
      specSync = { status: 'published', projectId: specProjectId, rev: source.rev, pushedAt: source.pushedAt, scheduleCount: source.scheduleCount };
    }

    const printingDocs = [];
    if (printingSets?.sets?.length) {
      for (const set of printingSets.sets) {
        const pdf = pdfFiles.find((file) => String(file.name).toLowerCase() === String(set.fileName || '').toLowerCase());
        const uploaded = pdf ? uploads[pdf.name] : null;
        if (!uploaded) continue;
        const recordId = `revex_print_${docId(set.id || set.name || 'set')}_${revision}`;
        const record = firestorePlain({
          type: 'file', hidden: false, folderPath: 'record_out/printing_sets',
          name: `${set.name || 'Printing Set'} · ${revision}.pdf`, originalName: set.fileName || pdf.name,
          storagePath: uploaded.path, size: uploaded.size || pdf.size, mimeType: 'application/pdf',
          source: 'revex-revit-printing-set', editable: false, revexDocKind: 'printing-set',
          printingSetId: set.id || null, printingSetName: set.name || 'Printing Set', revision,
          sheetIndex: (set.pages || []).map((page) => ({ page: Number(page.page || 0), sheetId: page.sheetId || null, sheetUniqueId: page.sheetUniqueId || null, sheetNumber: page.sheetNumber || '', sheetName: page.sheetName || '', currentRevision: page.currentRevision || null })),
          createdAt: iso(), updatedAt: iso(), createdBy: this.user.uid
        });
        await this.api.setDoc(libraryDoc(projectId, recordId), record, firestorePlain({ merge: true }));
        printingDocs.push({ id: recordId, ...record });
      }
    }

    const state = clone({
      schema: 'liber.revex.cloud-state.v3',
      projectId,
      revision,
      latestRevision: revision,
      assetRevision: revision,
      modelRevision: revision,
      syncedAt: iso(),
      syncedBy: this.user.uid,
      sourceMode: 'controlled-revit-sync',
      geometryAuthority: 'ifc',
      central: project?.central || null,
      integrity: integrity || null,
      ifcPath: uploads[ifcFile.name]?.path || null,
      modelPath: meshManifestFile ? uploads[meshManifestFile.name]?.path || null : uploads[rvxMeshFile?.name]?.path || null,
      modelPages: meshPageFiles.map((file,index)=>({ index:index+1, name:file.name, path:uploads[file.name]?.path||null, bytes:file.size })),
      modelFormat: meshManifestFile ? 'rvxmesh-gzip-pages' : 'rvxmesh-gzip',
      fallbackModelPath: fbxFile ? uploads[fbxFile.name]?.path || null : null,
      viewerPath: uploads['viewer-model.json']?.path || null,
      designPath: uploads['design-book.json']?.path || null,
      projectPath: uploads['project.json']?.path || null,
      specPushPath: uploads['spec-revit-push.json']?.path || null,
      printingSetsPath: uploads['printing-sets.json']?.path || null,
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
    await setRecord(projectId, `revex_revision_${revision}`, 'revision', {
      ...state, revision, syncedAt: state.syncedAt, ifcPath: state.ifcPath, modelPath: state.modelPath,
      viewerPath: state.viewerPath, designPath: state.designPath, projectPath: state.projectPath,
      specPushPath: state.specPushPath, printingSetsPath: state.printingSetsPath, integrity: state.integrity,
      immutable: true, createdAt: state.syncedAt
    }, false);
    // Publish the single current pointer last. Readers keep the prior complete
    // revision visible until every new immutable asset and projection is ready.
    await setRecord(projectId, 'revex_state', 'state', state, false);
    root.__revexCloudState = state;
    return { ...localPackage, ...state, cloud: true, specProjectId, printingDocs };
  };

  Store.listDesignEdits = async function listDesignEditsControlled(projectId) {
    if (!cloudReady() || !projectId) return [];
    return Promise.all((await listKind(projectId, 'design-item')).map((row) => hydrateAssetFields({ ...row, id: row.revexId || row.id }, 'Design Book item')));
  };

  Store.saveDesignEdit = async function saveDesignEditControlled(projectId, itemId, patch) {
    const sourceRevision = patch?.sourceRevision || root.__revexCloudState?.revision || null;
    const data = { ...patch, sourceRevision, revexId: itemId, overlayLane: 'design-book', updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
    for (const field of assetFields) if (Array.isArray(data[field])) data[field] = sanitizeAssetRows(data[field], `Design Book item ${field}`);
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
    return hydrateAssetFields({ id: itemId, ...data }, 'Design Book item');
  };

  Store.listChapterEdits = async function listChapterEditsControlled(projectId) {
    if (!cloudReady() || !projectId) {
      try { return Object.values(JSON.parse(localStorage.getItem(`liber.revex.chapters.${projectId}`) || '{}')); } catch (_) { return []; }
    }
    return Promise.all((await listKind(projectId, 'design-chapter')).map((row) => hydrateAssetFields({ ...row, id: row.revexId || row.id }, 'Design Book chapter')));
  };

  Store.saveChapterEdit = async function saveChapterEditControlled(projectId, chapterId, patch) {
    const sourceRevision = patch?.sourceRevision || root.__revexCloudState?.revision || null;
    const data = { ...patch, sourceRevision, revexId: chapterId, overlayLane: 'design-book', updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
    for (const field of assetFields) if (Array.isArray(data[field])) data[field] = sanitizeAssetRows(data[field], `Design Book chapter ${field}`);
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
    return hydrateAssetFields({ id: chapterId, ...data }, 'Design Book chapter');
  };

  Store.uploadChapterImage = async function uploadChapterImageControlled(projectId, chapterId, field, file, currentImages) {
    if (!['inspiration', 'renders', 'versionImages'].includes(field)) throw new Error('Unknown Design Book image lane.');
    if (!cloudReady()) {
      const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = reject; r.readAsDataURL(file); });
      const images = [...(currentImages || []), { url, path: null, name: safe(file.name) }].slice(-24);
      await this.saveChapterEdit(projectId, chapterId, { [field]: images });
      return images;
    }
    const uploaded = await upload(projectId, `design/chapters/${docId(chapterId)}/${field}`, file);
    const images = [...sanitizeAssetRows(currentImages, `Design Book chapter ${field}`), { path: uploaded.path, name: uploaded.name }].slice(-24);
    const saved = await this.saveChapterEdit(projectId, chapterId, { [field]: images });
    return saved[field] || [];
  };

  Store.uploadDesignImage = async function uploadDesignImageControlled(projectId, itemId, file, currentImages) {
    if (!cloudReady()) {
      const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = reject; r.readAsDataURL(file); });
      const images = [...(currentImages || []), { url, path: null, name: safe(file.name) }].slice(-12);
      await this.saveDesignEdit(projectId, itemId, { images });
      return images;
    }
    const uploaded = await upload(projectId, `design/items/${docId(itemId)}`, file);
    const images = [...sanitizeAssetRows(currentImages, 'Design Book item image'), { path: uploaded.path, name: uploaded.name }].slice(-12);
    const saved = await this.saveDesignEdit(projectId, itemId, { images });
    return saved.images || [];
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
      try { return Promise.all(JSON.parse(localStorage.getItem(`liber.revex.renders.${projectId}`) || '[]').map(hydrateRenderJob)); } catch (_) { return []; }
    }
    const rows = (await listKind(projectId, 'render', 100))
      .map((row) => ({ ...row, id: row.revexId || row.id }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 40);
    return Promise.all(rows.map(hydrateRenderJob));
  };

  Store.createRenderJob = async function createRenderJobControlled(projectId, job) {
    const id = `render_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const data = { ...await sanitizeRenderJob(projectId, job), revexId: id, status: job.status || 'prepared', createdAt: iso(), updatedAt: iso(), createdBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.renders.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      const row = { id, ...data }; all.unshift(row); localStorage.setItem(key, JSON.stringify(all.slice(0, 40))); return row;
    }
    await setRecord(projectId, `revex_render_${docId(id)}`, 'render', data, false);
    return { id, ...data };
  };

  Store.updateRenderJob = async function updateRenderJobControlled(projectId, jobId, patch) {
    const transientResultUrl = patch?.resultUrl ? Store.assertEphemeralUrl(patch.resultUrl, 'render result') : null;
    const data = { ...await sanitizeRenderJob(projectId, patch), revexId: jobId, updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.renders.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      const index = all.findIndex((row) => row.id === jobId);
      if (index >= 0) all[index] = { ...all[index], ...data };
      localStorage.setItem(key, JSON.stringify(all));
      const row = index >= 0 ? all[index] : { id: jobId, ...data };
      return transientResultUrl ? { ...row, resultUrl: transientResultUrl } : row;
    }
    await setRecord(projectId, `revex_render_${docId(jobId)}`, 'render', data, true);
    return transientResultUrl ? { id: jobId, ...data, resultUrl: transientResultUrl } : hydrateRenderJob({ id: jobId, ...data });
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
    const expected = { 'new-project-button': 'New', 'invite-project-button': 'Invite', 'sync-button': 'Sync project', 'render-button': 'Render' };
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
