(function (root) {
  'use strict';

  const Store = root.RevexStore;
  if (!Store) return;
  const BUILD = '20260813r43';
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

  async function upload(projectId, area, file) {
    if (!Store.fs?.storage) throw new Error('LIBER Storage is not available in this session.');
    const f = Store.api;
    const name = safe(file.name || 'file');
    const path = `projects/${projectId}/library/revex/${area}/${Date.now()}_${name}`;
    const ref = f.ref(Store.fs.storage, path);
    await f.uploadBytes(ref, file, firestorePlain({ contentType: file.type || (/\.json$/i.test(name) ? 'application/json' : 'application/octet-stream') }));
    return { path, url: await f.getDownloadURL(ref), name, size: file.size };
  }

  async function readJson(file) {
    if (!file) return null;
    try { return JSON.parse(await file.text()); }
    catch (error) { throw new Error(`${file.name} is not valid JSON: ${error.message}`); }
  }

  function byName(files, name) {
    return files.find((file) => String(file.name || '').toLowerCase() === String(name).toLowerCase()) || null;
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
    root.__revexCloudState = state;
    return state;
  };

  Store.subscribeState = function subscribeControlledState(projectId, callback) {
    if (!cloudReady() || !projectId || !this.api.onSnapshot) return () => {};
    return this.api.onSnapshot(
      libraryDoc(projectId, 'revex_state'),
      (snap) => {
        const state = snap.exists() ? { id: snap.id, ...snap.data() } : null;
        root.__revexCloudState = state;
        callback(state);
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
    const fbxFile = files.find((file) => /\.fbx$/i.test(file.name)) || null;

    if (!projectFile || !designFile || !viewerFile || !specFile || !integrityFile) {
      throw new Error('Select the complete REVEX revision: project, Design Book, Spec Book, viewer metadata and integrity manifest.');
    }

    const [project, design, viewer, specPush, integrity, printingSets] = await Promise.all([
      readJson(projectFile), readJson(designFile), readJson(viewerFile), readJson(specFile), readJson(integrityFile), printingFile ? readJson(printingFile) : null
    ]);
    const projectId = preferredProjectId || project?.central?.projectId || null;
    if (!projectId) throw new Error('Choose the REVEX project once before the first Revit sync.');
    if (!ifcFile) throw new Error('This revision has no IFC authority model. Re-sync with REVEX 0.7.0 or newer.');
    await verifyIntegrity(files, integrity);

    const revision = docId(integrity?.revision || `rev_${Date.now()}`);
    const localPackage = {
      projectId, revision, project, design, viewer, specPush, integrity, printingSets,
      printingDocs: pdfFiles.map((file) => ({ name: file.name, url: URL.createObjectURL(file), size: file.size })),
      ifcUrl: URL.createObjectURL(ifcFile),
      modelUrl: fbxFile ? URL.createObjectURL(fbxFile) : null,
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
    const packageFiles = [projectFile, designFile, viewerFile, specFile, integrityFile, printingFile, ifcFile, fbxFile, ...pdfFiles].filter(Boolean);
    const uploads = {};
    for (const file of packageFiles) uploads[file.name] = await upload(projectId, area, file);

    const specProjectId = await this.ensureSpecProject(projectId, preferredSpecProjectId || project?.central?.specProjectId);
    let specSync = { status: 'unlinked', projectId: null, rev: specPush?.rev || revision };
    if (specProjectId) {
      const source = firestorePlain({
        type: 'revit',
        name: 'REVEX controlled Revit sync',
        rev: specPush?.rev || revision,
        pushedAt: specPush?.pushedAt || iso(),
        payload: specPush?.payload || [],
        linkedProjectId: projectId,
        centralDocumentUniqueId: project?.central?.documentUniqueId || null,
        storagePath: uploads['spec-revit-push.json']?.path || null
      });
      await this.api.setDoc(this.api.doc(this.db, 'specProjects', specProjectId, 'sources', 'revex-revit'), source, firestorePlain({ merge: true }));
      specSync = { status: 'published', projectId: specProjectId, rev: source.rev, pushedAt: source.pushedAt };
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
      schema: 'liber.revex.cloud-state.v2',
      projectId,
      revision,
      syncedAt: iso(),
      syncedBy: this.user.uid,
      sourceMode: 'controlled-revit-sync',
      geometryAuthority: 'ifc',
      central: project?.central || null,
      integrity: integrity || null,
      ifcUrl: uploads[ifcFile.name]?.url || null,
      ifcPath: uploads[ifcFile.name]?.path || null,
      modelUrl: fbxFile ? uploads[fbxFile.name]?.url || null : null,
      modelPath: fbxFile ? uploads[fbxFile.name]?.path || null : null,
      viewerUrl: uploads['viewer-model.json']?.url || null,
      designUrl: uploads['design-book.json']?.url || null,
      projectUrl: uploads['project.json']?.url || null,
      specPushUrl: uploads['spec-revit-push.json']?.url || null,
      printingSetsUrl: uploads['printing-sets.json']?.url || null,
      printingSetCount: printingSets?.sets?.length || 0,
      printingSheetCount: (printingSets?.sets || []).reduce((n, set) => n + (set.pages?.length || 0), 0),
      scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0,
      elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0,
      spec: specSync,
      writeBackToRvt: false,
      type: 'revex', hidden: true, revexKind: 'state'
    });

    await setRecord(projectId, 'revex_state', 'state', state, true);
    await setRecord(projectId, `revex_revision_${revision}`, 'revision', {
      revision, syncedAt: state.syncedAt, ifcPath: state.ifcPath, modelPath: state.modelPath,
      viewerUrl: state.viewerUrl, designUrl: state.designUrl, projectUrl: state.projectUrl,
      specPushUrl: state.specPushUrl, printingSetsUrl: state.printingSetsUrl, integrity: state.integrity, createdAt: state.syncedAt
    }, false);
    root.__revexCloudState = state;
    return { ...localPackage, ...state, cloud: true, specProjectId, printingDocs };
  };

  Store.listDesignEdits = async function listDesignEditsControlled(projectId) {
    if (!cloudReady() || !projectId) return [];
    return (await listKind(projectId, 'design-item')).map((row) => ({ ...row, id: row.revexId || row.id }));
  };

  Store.saveDesignEdit = async function saveDesignEditControlled(projectId, itemId, patch) {
    const data = { ...patch, revexId: itemId, updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.design.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      all[itemId] = { ...(all[itemId] || {}), ...data, id: itemId };
      localStorage.setItem(key, JSON.stringify(all));
      return all[itemId];
    }
    await setRecord(projectId, `revex_design_${docId(itemId)}`, 'design-item', data, true);
    return { id: itemId, ...data };
  };

  Store.listChapterEdits = async function listChapterEditsControlled(projectId) {
    if (!cloudReady() || !projectId) {
      try { return Object.values(JSON.parse(localStorage.getItem(`liber.revex.chapters.${projectId}`) || '{}')); } catch (_) { return []; }
    }
    return (await listKind(projectId, 'design-chapter')).map((row) => ({ ...row, id: row.revexId || row.id }));
  };

  Store.saveChapterEdit = async function saveChapterEditControlled(projectId, chapterId, patch) {
    const data = { ...patch, revexId: chapterId, updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
    if (!cloudReady()) {
      const key = `liber.revex.chapters.${projectId}`;
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      all[chapterId] = { ...(all[chapterId] || {}), ...data, id: chapterId };
      localStorage.setItem(key, JSON.stringify(all));
      return all[chapterId];
    }
    await setRecord(projectId, `revex_chapter_${docId(chapterId)}`, 'design-chapter', data, true);
    return { id: chapterId, ...data };
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
    const images = [...(currentImages || []), { url: uploaded.url, path: uploaded.path, name: uploaded.name }].slice(-24);
    await this.saveChapterEdit(projectId, chapterId, { [field]: images });
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
