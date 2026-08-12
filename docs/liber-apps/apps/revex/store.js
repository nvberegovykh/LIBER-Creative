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
        const rows = await this.listProjects();
        return rows.find((row) => row.id === projectId) || null;
      }
      const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', projectId));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },

    async createProject(input) {
      const name = String(input?.name || '').trim();
      if (!name) throw new Error('Project name is required.');
      const now = iso();
      if (!this.isCloud()) {
        const id = `revex_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const project = { id, name, title: name, code: String(input?.code || '').trim(), description: String(input?.description || '').trim(), driveFileId: String(input?.driveFileId || '').trim(), createdAt: now, updatedAt: now, ownerId: 'local', memberIds: ['local'] };
        const all = JSON.parse(localStorage.getItem('liber.revex.projects.v1') || '{}');
        all[id] = project;
        localStorage.setItem('liber.revex.projects.v1', JSON.stringify(all));
        return project;
      }
      const ref = this.api.doc(this.api.collection(this.db, 'projects'));
      const data = plain({
        name, title: name, code: String(input?.code || '').trim(), description: String(input?.description || '').trim(),
        driveFileId: String(input?.driveFileId || '').trim(), ownerId: this.user.uid, memberIds: [this.user.uid],
        createdAt: now, updatedAt: now, status: 'active', source: 'REVEX'
      });
      await this.api.setDoc(ref, data, plain({ merge: false }));
      return { id: ref.id, ...data };
    },

    async ensureSpecProject(projectId, preferredSpecId, project) {
      if (!projectId) return preferredSpecId || '';
      if (!this.isCloud()) return preferredSpecId || `spec_${projectId}`;
      const parent = project || await this.getProject(projectId);
      const existing = preferredSpecId || parent?.revexSpecProjectId || '';
      if (existing) return existing;
      try {
        const ref = this.api.doc(this.api.collection(this.db, 'specProjects'));
        const at = iso();
        const data = plain({
          title: parent?.name || parent?.title || 'REVEX Specifications', name: parent?.name || parent?.title || 'REVEX Specifications',
          ownerId: this.user.uid, memberIds: Array.from(new Set([this.user.uid, ...(parent?.memberIds || [])])),
          revexProjectId: projectId, source: 'REVEX', createdAt: at, updatedAt: at
        });
        await this.api.setDoc(ref, data, plain({ merge: false }));
        await this.api.setDoc(this.api.doc(this.db, 'projects', projectId), plain({ revexSpecProjectId: ref.id, updatedAt: at }), plain({ merge: true }));
        return ref.id;
      } catch (error) {
        console.warn('[REVEX] Spec project bootstrap', error);
        return '';
      }
    },

    async ensureProjectChat(projectId) {
      if (!projectId) return null;
      if (!this.isCloud()) return { connId: `revex_${projectId}` };
      if (!this.fs?.callFunction) return null;
      return await this.fs.callFunction('ensureProjectChat', { projectId });
    },

    async uploadFile(path, file) {
      if (!this.fs?.storage || !this.api?.ref) throw new Error('LIBER Storage is unavailable.');
      const storageRef = this.api.ref(this.fs.storage, path);
      await this.api.uploadBytes(storageRef, file);
      const url = await this.api.getDownloadURL(storageRef);
      return { path, url };
    },

    async fetchJson(url) {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
      return await response.json();
    },

    async getState(projectId) {
      if (!projectId) return null;
      if (!this.isCloud()) return this.lastLocalPackage?.projectId === projectId ? this.lastLocalPackage : null;
      const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', projectId, 'revex', 'state'));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },

    subscribeState(projectId, callback) {
      if (!projectId || !this.isCloud() || !this.api.onSnapshot) return () => {};
      return this.api.onSnapshot(this.api.doc(this.db, 'projects', projectId, 'revex', 'state'), (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null));
    },

    async syncPackage(fileList, preferredProjectId, preferredSpecId) {
      const files = Array.from(fileList || []);
      const projectFile = byName(files, 'project.json');
      const viewerFile = byName(files, 'viewer-model.json');
      const designFile = byName(files, 'design-book.json');
      const specFile = byName(files, 'spec-revit-push.json');
      const integrityFile = byName(files, 'integrity.json');
      const manifestFile = byName(files, 'revex-sync.json');
      const modelFile = files.find((file) => /\.rvxmesh\.gz$/i.test(file.name)) || files.find((file) => /\.fbx$/i.test(file.name)) || null;
      const rvxMeshFile = files.find((file) => /\.rvxmesh\.gz$/i.test(file.name)) || null;
      const fbxFile = files.find((file) => /\.fbx$/i.test(file.name)) || null;
      if (!projectFile || !viewerFile || !designFile || !integrityFile || !manifestFile) throw new Error('This is not a complete REVEX BIM + Books sync package.');
      const [projectData, viewer, design, integrity, manifest, spec] = await Promise.all([
        readJson(projectFile), readJson(viewerFile), readJson(designFile), readJson(integrityFile), readJson(manifestFile), readJson(specFile)
      ]);
      if (manifest?.schema !== 'liber.revex.sync.v2') throw new Error('Unsupported REVEX sync package schema.');
      const projectId = preferredProjectId || manifest.projectId || projectData?.projectId || null;
      if (!projectId) throw new Error('Choose or create a REVEX project before publishing the Revit revision.');
      if (manifest.projectId && manifest.projectId !== projectId) throw new Error('The sync package belongs to a different REVEX project.');
      const revision = docId(manifest.revision || `rev_${Date.now()}`);
      const specProjectId = await this.ensureSpecProject(projectId, preferredSpecId, await this.getProject(projectId));
      const localPackage = {
        schema: 'liber.revex.state.v2', projectId, revision, syncedAt: manifest.createdAt || iso(), cloud: false,
        central: manifest.central || projectData?.central || null, ownership: projectData?.ownership || null,
        viewer, design, project: projectData, integrity, spec, specProjectId,
        viewerFile, designFile, projectFile, integrityFile, manifestFile, modelFile, rvxMeshFile, fbxFile,
        modelUrl: modelFile ? URL.createObjectURL(modelFile) : null,
        modelFormat: rvxMeshFile ? 'rvxmesh-gzip' : (fbxFile ? 'fbx' : null),
        fallbackModelUrl: rvxMeshFile && fbxFile ? URL.createObjectURL(fbxFile) : null,
        scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0,
        elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0,
        writeBackToRvt: false
      };
      this.lastLocalPackage = localPackage;
      if (!this.isCloud()) return localPackage;
      if (!this.fs.storage) throw new Error('LIBER Storage is not available in this session.');
      const base = `projects/${projectId}/revex/revisions/${revision}`;
      const uploads = {};
      for (const file of files) {
        const uploaded = await this.uploadFile(`${base}/${safe(file.name)}`, file);
        uploads[file.name] = uploaded;
      }
      const specSync = spec ? await this.syncSpecProjection(projectId, specProjectId, spec, revision) : null;
      const state = plain({
        schema: 'liber.revex.state.v2', projectId, revision, syncedAt: manifest.createdAt || iso(),
        central: manifest.central || projectData?.central || null, ownership: projectData?.ownership || null,
        integrity: integrity || null, modelUrl: uploads[modelFile?.name]?.url || null, modelPath: uploads[modelFile?.name]?.path || null,
        modelFormat: rvxMeshFile ? 'rvxmesh-gzip' : (fbxFile ? 'fbx' : null),
        fallbackModelUrl: rvxMeshFile && fbxFile ? (uploads[fbxFile.name]?.url || null) : null,
        viewerUrl: uploads['viewer-model.json']?.url || null, designUrl: uploads['design-book.json']?.url || null,
        projectUrl: uploads['project.json']?.url || null, specPushUrl: uploads['spec-revit-push.json']?.url || null,
        printingSetsUrl: uploads['printing-sets.json']?.url || null, affectedPlansUrl: uploads['affected-plan-views.json']?.url || null,
        scheduleCount: integrity?.counts?.schedules || design?.schedules?.length || 0, elementCount: integrity?.counts?.elements || viewer?.elements?.length || 0,
        spec: specSync, writeBackToRvt: false
      });
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revex', 'state'), state, plain({ merge: true }));
      await this.api.setDoc(this.api.doc(this.db, 'projects', projectId, 'revexRevisions', revision), plain({ ...state, viewerUrl: state.viewerUrl, designUrl: state.designUrl, projectUrl: state.projectUrl, createdAt: state.syncedAt }), plain({ merge: false }));
      return { ...localPackage, ...state, cloud: true, specProjectId };
    },

    async syncEngineeringPackage(fileList, preferredProjectId) {
      const files = Array.from(fileList || []);
      const manifestFile = byName(files, 'engineering-sync.json');
      const gbxmlFile = files.find((file) => /\.xml$/i.test(file.name)) || null;
      const weatherFile = files.find((file) => /\.epw$/i.test(file.name)) || null;
      if (!manifestFile || !gbxmlFile || !weatherFile) throw new Error('The Energy Sync evidence must include engineering-sync.json, the Revit gbXML, and the selected EPW weather file.');
      const manifest = await readJson(manifestFile);
      if (manifest?.schema !== 'liber.revex.engineering-sync.v1' || manifest?.architecture !== 'REVIT_EVIDENCE_GRAPH_V1') throw new Error('This is not a compatible REVIT_EVIDENCE_GRAPH_V1 Energy Sync revision.');
      if (Number(manifest?.publicationIntegrity?.threshold || 0) < 0.98 || Object.values(manifest?.publicationIntegrity?.ratios || {}).some((value) => Number(value) < 0.98)) throw new Error('Energy Sync requires at least 98% integrity in every Revit evidence domain.');
      const projectId = preferredProjectId || manifest.projectId || null;
      if (!projectId) throw new Error('Choose a REVEX project before importing Energy Sync.');
      if (manifest.projectId && manifest.projectId !== projectId) throw new Error('The Energy Sync revision belongs to a different REVEX project.');
      if (manifest.writeBackToRevitAfterExport !== false || manifest.pdfInsertion !== false) throw new Error('The Energy Sync authority boundary is invalid.');
      const revision = docId(manifest.revision || `eng_${Date.now()}`);
      const at = iso();
      const localArtifacts = files.map((file, index) => ({ name: file.name, bytes: file.size || 0, kind: index === 0 ? 'manifest' : 'engineering-evidence', url: URL.createObjectURL(file), cloud: false }));
      const state = { schema: 'liber.revex.engineering-state.v1', projectId, revision, syncedAt: at, manifest, artifacts: localArtifacts, cloud: false, writeBackToRevitAfterExport: false, pdfInsertion: false };
      localStorage.setItem(`liber.revex.engineering.${projectId}`, JSON.stringify({ ...state, artifacts: localArtifacts.map(({ url, ...row }) => row), localOnly: true }));
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

    async startEnergyRun(projectId, sourceRevision) {
      if (!projectId) throw new Error('Choose a REVEX project before running Energy.');
      if (!sourceRevision) throw new Error('A published Energy Sync revision is required.');
      if (!this.isCloud() || !this.fs?.callFunction) {
        const error = new Error('REVEX managed Energy server requires a signed-in LIBER cloud session.');
        error.code = 'revex/local-only';
        throw error;
      }
      const result = await this.fs.callFunction('revexRunEnergy', { projectId, sourceRevision });
      const data = result?.data || result || {};
      if (!data.jobId) throw new Error(data.error || 'REVEX Energy server did not return a job identity.');
      return data;
    },

    async getEnergyJob(projectId, jobId) {
      if (!projectId || !jobId || !this.isCloud()) return null;
      const snap = await this.api.getDoc(this.api.doc(this.db, 'projects', projectId, 'revexEnergyJobs', jobId));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },

    subscribeEnergyJob(projectId, jobId, callback) {
      if (!projectId || !jobId || !this.isCloud() || !this.api?.onSnapshot) return () => {};
      return this.api.onSnapshot(this.api.doc(this.db, 'projects', projectId, 'revexEnergyJobs', jobId), (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null), (error) => console.warn('[REVEX] Energy job subscription', error));
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
      if (manifest.revitWriteBack !== false || manifest.pdfInsertion !== false) throw new Error('The Energy result attempts to cross the Revit authority boundary.');
      const revision = docId(manifest.resultRevision || `energy_${Date.now()}`);
      const resultFiles = files.filter((file) => file !== manifestFile);
      const declared = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
      const at = iso();
      const localArtifacts = resultFiles.map((file, index) => ({ ...(declared[index] || {}), name: declared[index]?.name || file.name, bytes: file.size || 0, url: URL.createObjectURL(file), cloud: false }));
      const state = { schema: 'liber.revex.energy-state.v1', projectId, revision, publishedAt: at, manifest, artifacts: localArtifacts, cloud: false };
      localStorage.setItem(`liber.revex.energy-result.${projectId}`, JSON.stringify({ ...state, artifacts: localArtifacts.map(({ url, ...row }) => row), localOnly: true }));
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

    async syncSpecProjection(projectId, specProjectId, spec, revision) { return null; }
  };

  root.RevexStore = Store;
})(window);
