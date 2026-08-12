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

  function plain(value) {
    const json = JSON.stringify(value === undefined ? null : value);
    try { return (REALM.JSON || JSON).parse(json); } catch (_) { return JSON.parse(json); }
  }

  function getService() {
    try {
      for (const w of [root, root.parent, root.top].filter(Boolean)) {
        if (w.firebaseService && w.firebaseService.isInitialized) {
          REALM = w;
          return w.firebaseService;
        }
      }
    } catch (_) {}
    return root.firebaseService || null;
  }

  function getApi(fs) {
    try {
      if (fs?.firebase?.collection) return fs.firebase;
      for (const w of [root, root.parent, root.top].filter(Boolean)) {
        if (w.firebase?.collection) { REALM = w; return w.firebase; }
      }
    } catch (_) {}
    return null;
  }

  async function readJson(file) {
    if (!file) return null;
    try { return JSON.parse(await file.text()); } catch (error) {
      throw new Error(`${file.name} is not valid JSON: ${error.message}`);
    }
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
        if (!this.user && this.api.onAuthStateChanged && this.fs.auth) {
          await new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 2500);
            try {
              this.api.onAuthStateChanged(this.fs.auth, (user) => {
                this.user = user || null;
                if (!settled) { settled = true; clearTimeout(timer); resolve(); }
              });
            } catch (_) { clearTimeout(timer); resolve(); }
          });
        }
        if (this.user) this.mode = 'cloud';
      }
      return this.mode;
    },

    isCloud() { return this.mode === 'cloud'; },

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
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },

    subscribeState(projectId, callback) {
      if (!this.isCloud() || !projectId || !this.api.onSnapshot) return () => {};
      return this.api.onSnapshot(
        this.api.doc(this.db, 'projects', projectId, 'revex', 'state'),
        (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null),
        (error) => console.warn('[REVEX] state subscription', error)
      );
    },

    async fetchJson(url) {
      if (!url) return null;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not load synced data (${response.status})`);
      return response.json();
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
      }
      try {
        const project = await this.getProject(projectId);
        if (project?.revexSpecProjectId) {
          const linked = await f.getDoc(f.doc(this.db, 'specProjects', project.revexSpecProjectId));
          if (linked.exists()) return project.revexSpecProjectId;
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
      return { path, url: await f.getDownloadURL(ref), name: file.name, size: file.size };
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
      const projectId = preferredProjectId || project?.central?.projectId || project?.central?.liberProjectId || null;
      if (!projectId) throw new Error('Choose a LIBER project before importing the Revit sync.');

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
        return localPackage;
      }
      if (!this.fs.storage) throw new Error('LIBER Storage is not available in this session.');

      const base = `projects/${projectId}/revex/revisions/${revision}`;
      const uploadFiles = [projectFile, designFile, viewerFile, specFile, integrityFile, printingFile, affectedPlansFile, rvxMeshFile, fbxFile].filter(Boolean);
      const uploads = {};
      for (const file of uploadFiles) uploads[file.name] = await this.uploadFile(`${base}/${safe(file.name)}`, file);

      const specProjectId = await this.ensureSpecProject(projectId, preferredSpecProjectId || project?.central?.specProjectId);
      let specSync = { status: 'unlinked', projectId: null, rev: specPush?.rev || revision };
      if (specProjectId) {
        const source = plain({
          type: 'revit',
          name: 'LIBER REVEX / Revit',
          rev: specPush?.rev || revision,
          pushedAt: specPush?.pushedAt || iso(),
          payload: specPush?.payload || [],
          linkedProjectId: projectId,
          centralDocumentUniqueId: project?.central?.documentUniqueId || null,
          storagePath: uploads['spec-revit-push.json']?.path || null
        });
        await this.api.setDoc(this.api.doc(this.db, 'specProjects', specProjectId, 'sources', 'revex-revit'), source, plain({ merge: true }));
        specSync = { status: 'published', projectId: specProjectId, rev: source.rev, pushedAt: source.pushedAt };
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
        modelUrl: uploads[modelFile?.name]?.url || null,
        modelPath: uploads[modelFile?.name]?.path || null,
        modelFormat: rvxMeshFile ? 'rvxmesh-gzip' : (fbxFile ? 'fbx' : null),
        fallbackModelUrl: rvxMeshFile && fbxFile ? (uploads[fbxFile.name]?.url || null) : null,
        viewerUrl: uploads['viewer-model.json']?.url || null,
        designUrl: uploads['design-book.json']?.url || null,
        projectUrl: uploads['project.json']?.url || null,
        specPushUrl: uploads['spec-revit-push.json']?.url || null,
        printingSetsUrl: uploads['printing-sets.json']?.url || null,
        affectedPlansUrl: uploads['affected-plan-views.json']?.url || null,
        scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0,
        elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0,
        spec: specSync,
        writeBackToRvt: false
      });

      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revex', 'state'), state, plain({ merge: true }));
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexRevisions', revision), plain({
        ...state,
        viewerUrl: state.viewerUrl,
        designUrl: state.designUrl,
        projectUrl: state.projectUrl,
        createdAt: state.syncedAt
      }), plain({ merge: false }));

      return { ...localPackage, ...state, cloud: true, specProjectId };
    },

    async syncEngineeringPackage(fileList, preferredProjectId) {
      const files = Array.from(fileList || []);
      const manifestFile = byName(files, 'engineering-sync.json');
      const gbxmlFile = files.find((file) => /\.xml$/i.test(file.name)) || null;
      if (!manifestFile || !gbxmlFile) throw new Error('The Energy Sync evidence must include engineering-sync.json and the Revit gbXML.');
      const manifest = await readJson(manifestFile);
      if (manifest?.schema !== 'liber.revex.engineering-sync.v1' || manifest?.architecture !== 'REVIT_EVIDENCE_GRAPH_V1')
        throw new Error('This is not a compatible REVIT_EVIDENCE_GRAPH_V1 Energy Sync revision.');
      if (Number(manifest?.publicationIntegrity?.threshold || 0) < 0.98 ||
          Object.values(manifest?.publicationIntegrity?.ratios || {}).some((value) => Number(value) < 0.98))
        throw new Error('Energy Sync requires at least 98% integrity in every Revit evidence domain.');
      const projectId = preferredProjectId || manifest.projectId || null;
      if (!projectId) throw new Error('Choose a REVEX project before importing Energy Sync.');
      if (manifest.projectId && manifest.projectId !== projectId) throw new Error('The Energy Sync revision belongs to a different REVEX project.');
      if (manifest.writeBackToRevitAfterExport !== false || manifest.pdfInsertion !== false)
        throw new Error('The Energy Sync authority boundary is invalid.');

      const revision = docId(manifest.revision || `eng_${Date.now()}`);
      const at = iso();
      const localArtifacts = files.map((file, index) => ({
        name: file.name, bytes: file.size || 0, kind: index === 0 ? 'manifest' : 'engineering-evidence',
        url: URL.createObjectURL(file), cloud: false
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

      const base = `projects/${projectId}/revex/engineering/revisions/${revision}`;
      const artifacts = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const uploaded = await this.uploadFile(`${base}/${String(index + 1).padStart(3, '0')}_${safe(file.name)}`, file);
        artifacts.push({ name: file.name, bytes: file.size || 0, kind: index === 0 ? 'manifest' : 'engineering-evidence', url: uploaded.url, path: uploaded.path, cloud: true });
      }
      const cloudState = plain({ ...state, artifacts, cloud: true, syncedBy: this.user.uid });
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revex', 'engineering'), cloudState, plain({ merge: false }));
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexEngineeringRevisions', revision), cloudState, plain({ merge: false }));
      return cloudState;
    },

    async getEngineeringState(projectId) {
      if (!projectId) return null;
      if (!this.isCloud()) {
        try { return JSON.parse(localStorage.getItem(`liber.revex.engineering.${projectId}`) || 'null'); } catch (_) { return null; }
      }
      const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', projectId, 'revex', 'engineering'));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
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
        artifacts.push({ ...(declared[index] || {}), name: declared[index]?.name || file.name, bytes: file.size || 0, url: uploaded.url, path: uploaded.path, cloud: true });
      }
      const manifestUpload = await this.uploadFile(`${base}/000_energy-result.json`, manifestFile);
      const cloudState = plain({ ...state, artifacts, manifestUrl: manifestUpload.url, manifestPath: manifestUpload.path, cloud: true, publishedBy: this.user.uid });
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revex', 'energy'), cloudState, plain({ merge: false }));
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexEnergyResults', revision), cloudState, plain({ merge: false }));
      return cloudState;
    },

    async getEnergyResult(projectId) {
      if (!projectId) return null;
      if (!this.isCloud()) {
        try { return JSON.parse(localStorage.getItem(`liber.revex.energy-result.${projectId}`) || 'null'); } catch (_) { return null; }
      }
      const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', projectId, 'revex', 'energy'));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
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
      const images = [...(currentImages || []), { url: uploaded.url, path: uploaded.path, name }].slice(-24);
      await this.saveChapterEdit(projectId, chapterId, { [field]: images });
      return images;
    },

    async uploadDesignImage(projectId, itemId, file, currentImages) {
      const name = safe(file.name || 'image');
      if (!this.isCloud()) {
        const images = [...(currentImages || []), { url: await readDataUrl(file), path: null, name }].slice(-12);
        await this.saveDesignEdit(projectId, itemId, { images });
        return images;
      }
      const uploaded = await this.uploadFile(`projects/${projectId}/revex/design/${docId(itemId)}/${Date.now()}_${name}`, file);
      const images = [...(currentImages || []), { url: uploaded.url, path: uploaded.path, name }].slice(-12);
      await this.saveDesignEdit(projectId, itemId, { images });
      return images;
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
        try { return JSON.parse(localStorage.getItem(`liber.revex.renders.${projectId}`) || '[]'); } catch (_) { return []; }
      }
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'revexRenders'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 40);
    },

    async createRenderJob(projectId, job) {
      const data = { ...job, status: job.status || 'prepared', createdAt: iso(), updatedAt: iso(), createdBy: this.user?.uid || 'local' };
      if (!this.isCloud()) {
        const key = `liber.revex.renders.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '[]');
        const row = { id: `render_${Date.now()}`, ...data };
        all.unshift(row); localStorage.setItem(key, JSON.stringify(all.slice(0, 40))); return row;
      }
      const ref = await this.api.addDoc(this.api.collection(this.db, 'projects', projectId, 'revexRenders'), plain(data));
      return { id: ref.id, ...data };
    },

    async updateRenderJob(projectId, jobId, patch) {
      const data = { ...patch, updatedAt: iso(), updatedBy: this.user?.uid || 'local' };
      if (!this.isCloud()) {
        const key = `liber.revex.renders.${projectId}`;
        const all = JSON.parse(localStorage.getItem(key) || '[]');
        const index = all.findIndex((row) => row.id === jobId);
        if (index >= 0) all[index] = { ...all[index], ...data };
        localStorage.setItem(key, JSON.stringify(all));
        return index >= 0 ? all[index] : { id: jobId, ...data };
      }
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexRenders', jobId), plain(data), plain({ merge: true }));
      return { id: jobId, ...data };
    },

    async listLibrary(projectId) {
      if (!this.isCloud() || !projectId) return [];
      const snap = await this.api.getDocs(this.api.collection(this.db, 'projects', projectId, 'library'));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((row) => row.type === 'file');
    },

    async fileUrl(storagePath) {
      if (!storagePath || !this.fs?.storage) return null;
      return this.api.getDownloadURL(this.api.ref(this.fs.storage, storagePath));
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
      let imageUrl = null, imagePath = null;
      if (imageDataUrl && this.fs?.storage) {
        const blob = await (await fetch(imageDataUrl)).blob();
        const file = new File([blob], `${id}.png`, { type: 'image/png' });
        const uploaded = await this.uploadFile(`projects/${projectId}/revex/derived-plans/${id}.png`, file);
        imageUrl = uploaded.url; imagePath = uploaded.path;
      }
      const finalData = plain({ ...data, imageUrl, imagePath });
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexDerivedPlans', id), finalData, plain({ merge: false }));
      return finalData;
    },

    async ensureProjectChat(projectId) {
      if (!this.fs?.callFunction) throw new Error('Project Chat is not available in this session.');
      return this.fs.callFunction('ensureProjectChat', { projectId });
    }
  };

  root.RevexStore = Store;
})(window);
