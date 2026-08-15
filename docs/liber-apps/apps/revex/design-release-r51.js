(function (root) {
  'use strict';

  const BUILD = '20260815r49-design-release1';
  const Store = root.RevexStore;
  if (!Store || root.__revexDesignReleaseR51) return;
  root.__revexDesignReleaseR51 = true;

  const iso = () => new Date().toISOString();
  const clone = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
  const docId = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 160) || 'item';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const plain = (value) => typeof Store.toFirestorePlain === 'function' ? Store.toFirestorePlain(value) : clone(value);
  const state = () => root.__revexState || null;
  const cloudReady = () => Boolean(Store.isCloud?.() && Store.api && Store.db && Store.user?.uid);
  const localDesignKey = (projectId) => `liber.revex.design.${projectId}`;
  const localVersionKey = (projectId) => `liber.revex.design-versions.${projectId}`;
  const versionCache = new Map();
  const selectedVersion = new Map();
  let decorating = false;

  function normalizeImages(images) {
    return Array.isArray(images)
      ? images.filter(Boolean).map((image) => ({
          url: String(image?.url || ''),
          path: image?.path == null ? null : String(image.path),
          name: String(image?.name || '')
        })).filter((image) => image.url)
      : [];
  }

  function snapshot(value = {}, fallback = {}) {
    const source = value || {};
    const base = fallback || {};
    return {
      status: String(source.status ?? base.status ?? 'Not Selected'),
      description: String(source.description ?? base.description ?? ''),
      source: String(source.source ?? base.source ?? ''),
      images: normalizeImages(source.images ?? base.images ?? []),
      sourceSnapshot: clone(source.sourceSnapshot ?? base.sourceSnapshot ?? null),
      candidateMaterials: Array.isArray(source.candidateMaterials ?? base.candidateMaterials)
        ? [...(source.candidateMaterials ?? base.candidateMaterials)].map(String)
        : []
    };
  }

  function snapshotSignature(value) {
    if (!value) return '';
    const row = snapshot(value);
    return JSON.stringify({
      status: row.status,
      description: row.description.trim(),
      source: row.source.trim(),
      images: row.images.map((image) => [image.url, image.path || '', image.name || ''])
    });
  }

  function hasLegacyRelease(record) {
    if (!record || Number(record.releaseModelVersion || 0) >= 2) return false;
    return Boolean(
      record.revexId || record.updatedAt || record.createdAt ||
      String(record.status || '') || String(record.description || '') || String(record.source || '') ||
      (Array.isArray(record.images) && record.images.length)
    );
  }

  function releasedSnapshot(record) {
    if (!record) return null;
    if (Number(record.releaseModelVersion || 0) >= 2) {
      const released = record.releasedSnapshot || record.released || null;
      return released ? snapshot(released) : null;
    }
    return hasLegacyRelease(record) ? snapshot(record) : null;
  }

  function workingSnapshot(record, fallback = {}) {
    if (!record) return snapshot(fallback);
    if (Number(record.releaseModelVersion || 0) >= 2) {
      return snapshot(record.workingSnapshot || record.working || record.releasedSnapshot || fallback, fallback);
    }
    return snapshot(record, fallback);
  }

  function projectionFor(record) {
    const released = releasedSnapshot(record);
    const working = workingSnapshot(record, released || {});
    const projection = released || snapshot({ status: 'Not Selected', description: '', source: '', images: [] }, working);
    return {
      ...record,
      releaseModelVersion: 2,
      workingSnapshot: working,
      releasedSnapshot: released,
      status: projection.status,
      description: projection.description,
      source: projection.source,
      images: projection.images,
      sourceSnapshot: working.sourceSnapshot || released?.sourceSnapshot || record?.sourceSnapshot || null,
      candidateMaterials: projection.candidateMaterials?.length ? projection.candidateMaterials : working.candidateMaterials,
      draftDirty: released ? snapshotSignature(working) !== snapshotSignature(released) : true
    };
  }

  function sourceItem(itemId) {
    const s = state();
    for (const chapter of s?.designData?.chapters || []) {
      const item = (chapter.items || []).find((row) => String(row.id) === String(itemId));
      if (item) return { chapter, item };
    }
    return null;
  }

  function currentRecord(itemId) {
    const s = state();
    const record = s?.designEdits?.get?.(itemId) || s?.designEdits?.get?.(String(itemId)) || null;
    return record ? projectionFor(record) : null;
  }

  function updateStateRecord(itemId, record) {
    const s = state();
    if (!s?.designEdits || !record) return record;
    const normalized = projectionFor(record);
    s.designEdits.set(itemId, normalized);
    return normalized;
  }

  function normalizeStateRecords() {
    const s = state();
    if (!s?.designEdits) return;
    for (const [itemId, record] of [...s.designEdits.entries()]) {
      if (Number(record?.releaseModelVersion || 0) >= 2) s.designEdits.set(itemId, projectionFor(record));
    }
  }

  async function readCloudRecord(projectId, itemId) {
    if (!cloudReady()) return null;
    const ref = Store.api.doc(Store.db, 'projects', projectId, 'library', `revex_design_${docId(itemId)}`);
    const snap = await Store.api.getDoc(ref);
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }

  async function readRecord(projectId, itemId) {
    const fromState = currentRecord(itemId);
    if (fromState) return fromState;
    if (!cloudReady()) {
      try {
        const row = JSON.parse(localStorage.getItem(localDesignKey(projectId)) || '{}')[itemId] || null;
        return row ? projectionFor(row) : null;
      } catch (_) { return null; }
    }
    const row = await readCloudRecord(projectId, itemId);
    return row ? projectionFor(row) : null;
  }

  async function writeCurrent(projectId, itemId, record) {
    const normalized = projectionFor(record);
    if (!cloudReady()) {
      const key = localDesignKey(projectId);
      const all = JSON.parse(localStorage.getItem(key) || '{}');
      all[itemId] = { ...normalized, id: itemId };
      localStorage.setItem(key, JSON.stringify(all));
      return all[itemId];
    }
    const ref = Store.api.doc(Store.db, 'projects', projectId, 'library', `revex_design_${docId(itemId)}`);
    const payload = plain({ ...normalized, type: 'revex', hidden: true, revexKind: 'design-item' });
    await Store.api.setDoc(ref, payload, plain({ merge: true }));
    return { id: itemId, ...normalized };
  }

  async function writeVersion(projectId, itemId, version) {
    if (!cloudReady()) {
      const key = localVersionKey(projectId);
      const all = JSON.parse(localStorage.getItem(key) || '[]');
      all.unshift(version);
      localStorage.setItem(key, JSON.stringify(all.slice(0, 5000)));
      return version;
    }
    const ref = Store.api.doc(Store.db, 'projects', projectId, 'library', `revex_design_version_${docId(version.revexId)}`);
    await Store.api.setDoc(ref, plain({ ...version, type: 'revex', hidden: true, revexKind: 'design-item-version' }), plain({ merge: false }));
    return version;
  }

  Store.saveDesignEdit = async function saveDesignWorkingProperties(projectId, itemId, patch = {}) {
    if (!projectId || !itemId) throw new Error('Project and Design Book position are required.');
    const s = state();
    const source = sourceItem(itemId)?.item || s?.selectedDesign || {};
    const existingRaw = (s?.designEdits?.get?.(itemId) || await readRecord(projectId, itemId) || null);
    const existing = existingRaw ? projectionFor(existingRaw) : null;
    const legacyRelease = existingRaw && Number(existingRaw.releaseModelVersion || 0) < 2 && hasLegacyRelease(existingRaw)
      ? snapshot(existingRaw, source)
      : null;
    const released = existing?.releasedSnapshot || legacyRelease || null;
    const baseWorking = existing ? workingSnapshot(existing, source) : snapshot(source);
    const working = snapshot({ ...baseWorking, ...patch, images: patch.images ?? baseWorking.images }, source);
    if (!working.sourceSnapshot) {
      working.sourceSnapshot = clone(patch.sourceSnapshot || existing?.sourceSnapshot || {
        id: itemId,
        label: source.label || s?.selectedDesign?.label || '',
        chapterTitle: s?.selectedDesign?.chapterTitle || source.chapterTitle || '',
        revit: source.revit || s?.selectedDesign?.revit || null
      });
    }
    if (!working.candidateMaterials.length) {
      working.candidateMaterials = [...(s?.selectedDesign?.candidateMaterials || source.candidateMaterials || [])].map(String);
    }
    const sourceRevision = patch.sourceRevision || existing?.sourceRevision || root.__revexCloudState?.revision || s?.cloudState?.revision || null;
    const at = iso();
    const record = projectionFor({
      ...(existing || {}),
      revexId: itemId,
      overlayLane: 'design-book',
      releaseModelVersion: 2,
      workingSnapshot: working,
      releasedSnapshot: released,
      releasedVersionId: existing?.releasedVersionId || null,
      releasedAt: existing?.releasedAt || existingRaw?.updatedAt || null,
      releaseNumber: Number(existing?.releaseNumber || (legacyRelease ? 1 : 0)),
      sourceRevision,
      updatedAt: at,
      updatedBy: Store.user?.uid || 'local'
    });
    const saved = await writeCurrent(projectId, itemId, record);
    updateStateRecord(itemId, saved);
    return saved;
  };

  Store.listDesignVersions = async function listDesignBookReleases(projectId, itemId) {
    if (!projectId || !itemId) return [];
    let rows = [];
    if (!cloudReady()) {
      try { rows = JSON.parse(localStorage.getItem(localVersionKey(projectId)) || '[]'); } catch (_) { rows = []; }
    } else {
      const f = Store.api;
      const q = f.query(
        f.collection(Store.db, 'projects', projectId, 'library'),
        f.where('revexKind', '==', 'design-item-version'),
        f.limit(1500)
      );
      const snap = await f.getDocs(q);
      rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    }
    return rows
      .filter((row) => String(row.overlayId || '') === String(itemId))
      .map((row) => ({ ...row, snapshot: snapshot(row.snapshot || row) }))
      .sort((a, b) => String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || '')))
      .slice(0, 60);
  };

  Store.releaseDesignPosition = async function releaseDesignBookPosition(projectId, itemId, options = {}) {
    if (!projectId || !itemId) throw new Error('Project and Design Book position are required.');
    const s = state();
    const source = sourceItem(itemId)?.item || s?.selectedDesign || {};
    const existing = projectionFor(await readRecord(projectId, itemId) || {});
    const working = snapshot(options.snapshot || existing.workingSnapshot || source, source);
    if (!working.sourceSnapshot) {
      working.sourceSnapshot = clone(existing.sourceSnapshot || {
        id: itemId,
        label: source.label || s?.selectedDesign?.label || '',
        chapterTitle: s?.selectedDesign?.chapterTitle || '',
        revit: source.revit || s?.selectedDesign?.revit || null
      });
    }
    const previousRelease = releasedSnapshot(existing);
    const legacyBase = Number(existing.releaseNumber || 0) || (previousRelease ? 1 : 0);
    const releaseNumber = legacyBase + 1;
    const at = iso();
    const versionId = `release_${docId(itemId)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const version = {
      revexId: versionId,
      overlayId: itemId,
      overlayLane: 'design-book',
      versionKind: 'design-book-release',
      releaseModelVersion: 2,
      releaseNumber,
      releaseLabel: options.label || `Release ${releaseNumber}`,
      sourceRevision: options.sourceRevision || existing.sourceRevision || s?.cloudState?.revision || root.__revexCloudState?.revision || null,
      snapshot: working,
      status: working.status,
      description: working.description,
      source: working.source,
      images: working.images,
      sourceSnapshot: working.sourceSnapshot,
      candidateMaterials: working.candidateMaterials,
      immutable: true,
      createdAt: at,
      createdBy: Store.user?.uid || 'local'
    };
    await writeVersion(projectId, itemId, version);
    const record = projectionFor({
      ...existing,
      revexId: itemId,
      overlayLane: 'design-book',
      releaseModelVersion: 2,
      workingSnapshot: working,
      releasedSnapshot: working,
      releasedVersionId: versionId,
      releasedAt: at,
      releaseNumber,
      sourceRevision: version.sourceRevision,
      updatedAt: at,
      updatedBy: Store.user?.uid || 'local',
      draftDirty: false
    });
    const saved = await writeCurrent(projectId, itemId, record);
    updateStateRecord(itemId, saved);
    versionCache.delete(String(itemId));
    return { record: saved, version };
  };

  function installStyles() {
    if (document.getElementById('revex-design-release-r51-style')) return;
    const style = document.createElement('style');
    style.id = 'revex-design-release-r51-style';
    style.textContent = `
      [data-position-versions] { display:none !important; }
      .design-release-switcher { margin:14px 0 16px; padding:12px; border:1px solid rgba(255,255,255,.12); border-radius:12px; background:rgba(255,255,255,.025); }
      .design-release-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:9px; }
      .design-release-head strong { display:block; font-size:13px; }
      .design-release-head small { display:block; margin-top:3px; color:rgba(232,238,247,.62); line-height:1.35; }
      .design-release-track { display:flex; gap:9px; overflow-x:auto; padding:2px 1px 7px; scroll-snap-type:x proximity; }
      .design-release-card { flex:0 0 218px; min-width:0; padding:0; overflow:hidden; border:1px solid rgba(255,255,255,.12); border-radius:10px; background:#0b0e13; color:inherit; text-align:left; cursor:pointer; scroll-snap-align:start; }
      .design-release-card:hover { border-color:rgba(255,255,255,.28); }
      .design-release-card.active { border-color:#ff2d6f; box-shadow:0 0 0 1px rgba(255,45,111,.42) inset; }
      .design-release-card.working { border-style:dashed; }
      .design-release-thumb { height:92px; display:grid; place-items:center; overflow:hidden; background:#0f1319; color:rgba(232,238,247,.44); font:10px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; }
      .design-release-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
      .design-release-copy { padding:9px 10px 10px; }
      .design-release-copy b { display:flex; justify-content:space-between; gap:8px; font-size:12px; }
      .design-release-copy b span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .design-release-copy em { flex:0 0 auto; color:#ff5a8b; font:9px/1 ui-monospace,SFMono-Regular,Consolas,monospace; font-style:normal; letter-spacing:.08em; }
      .design-release-copy p { margin:6px 0 0; min-height:30px; color:rgba(232,238,247,.72); font-size:11px; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .design-release-copy small { display:block; margin-top:6px; color:rgba(232,238,247,.45); font-size:9px; }
      .design-release-actions { margin:0 0 14px; padding:11px; border:1px solid rgba(255,255,255,.1); border-radius:10px; background:rgba(255,255,255,.02); }
      .design-release-state { display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:8px; }
      .design-release-state strong { font-size:12px; }
      .design-release-state span { font:9px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; color:rgba(232,238,247,.58); }
      .design-release-actions .button { width:100%; margin-top:6px; }
      .design-release-actions .button.primary-release { background:#ff2d6f; color:#05070a; border-color:#ff2d6f; font-weight:750; }
      .design-release-actions .button[disabled] { opacity:.45; cursor:default; }
      .design-working-note { margin:7px 0 0; color:rgba(232,238,247,.56); font-size:10px; line-height:1.4; }
      .design-card .release-chip { display:inline-flex; margin-left:5px; padding:2px 5px; border:1px solid rgba(255,255,255,.13); border-radius:999px; font:8px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.07em; color:rgba(232,238,247,.58); }
      .design-card.has-unsynced-draft .release-chip::after { content:' · DRAFT'; color:#ff5a8b; }
      .design-release-preview-note { margin:0 0 10px; padding:8px 9px; border-left:2px solid #ff2d6f; background:rgba(255,45,111,.06); color:rgba(232,238,247,.72); font-size:10px; line-height:1.4; }
      @media (max-width:860px) { .design-release-card { flex-basis:190px; } .design-release-thumb { height:78px; } }
    `;
    document.head.appendChild(style);
  }

  function formatTime(value) {
    if (!value) return 'Working draft';
    const date = value?.toDate ? value.toDate() : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  }

  function cardMarkup(kind, row, active) {
    const snap = snapshot(row.snapshot || row);
    const image = snap.images.at?.(-1)?.url || snap.images[snap.images.length - 1]?.url || '';
    const title = kind === 'working'
      ? 'Working properties'
      : row.versionKind === 'design-book-release'
        ? (row.releaseLabel || `Release ${row.releaseNumber || ''}`)
        : 'Saved snapshot';
    const tag = kind === 'working' ? 'DRAFT' : row.versionKind === 'design-book-release' ? `R${row.releaseNumber || ''}` : 'LEGACY';
    return `<button class="design-release-card ${kind === 'working' ? 'working' : ''}${active ? ' active' : ''}" type="button" data-design-version="${esc(kind === 'working' ? 'working' : row.revexId || row.id || '')}">
      <div class="design-release-thumb">${image ? `<img src="${esc(image)}" alt="" />` : (kind === 'working' ? 'WORKING CARD' : 'RELEASE CARD')}</div>
      <div class="design-release-copy"><b><span>${esc(title)}</span><em>${esc(tag)}</em></b><p>${esc(snap.description || snap.status || 'No decision note yet.')}</p><small>${esc(kind === 'working' ? 'Editable properties' : formatTime(row.createdAt || row.updatedAt))}</small></div>
    </button>`;
  }

  async function loadVersions(itemId) {
    const key = String(itemId);
    if (versionCache.has(key)) return versionCache.get(key);
    const s = state();
    const promise = Store.listDesignVersions(s?.projectId, itemId).catch((error) => {
      console.warn('[REVEX] Design Book releases', error);
      return [];
    });
    versionCache.set(key, promise);
    const rows = await promise;
    versionCache.set(key, rows);
    return rows;
  }

  function selectedSnapshot(itemId, versions) {
    const record = currentRecord(itemId);
    const working = workingSnapshot(record, sourceItem(itemId)?.item || state()?.selectedDesign || {});
    const selected = selectedVersion.get(String(itemId)) || 'working';
    if (selected === 'working') return { mode: 'working', snapshot: working, version: null };
    const version = versions.find((row) => String(row.revexId || row.id || '') === String(selected));
    return version ? { mode: 'version', snapshot: snapshot(version.snapshot || version), version } : { mode: 'working', snapshot: working, version: null };
  }

  function setFormSnapshot(form, snap, readOnly) {
    const status = form.querySelector('#design-status');
    const description = form.querySelector('#design-description');
    const source = form.querySelector('#design-source');
    const upload = form.querySelector('#design-image-upload');
    if (status) { status.value = snap.status || 'Not Selected'; status.disabled = readOnly; }
    if (description) { description.value = snap.description || ''; description.disabled = readOnly; }
    if (source) { source.value = snap.source || ''; source.disabled = readOnly; }
    if (upload) upload.disabled = readOnly;
    const strip = form.querySelector('.image-strip');
    if (strip) strip.innerHTML = snap.images.map((image) => `<img src="${esc(image.url)}" alt="${esc(image.name || '')}" />`).join('');
    const submit = form.querySelector('button[type="submit"]');
    if (submit) {
      submit.textContent = 'Save working properties';
      submit.hidden = readOnly;
      submit.disabled = readOnly;
    }
  }

  function gatherWorkingPatch(itemId) {
    const inspector = document.getElementById('design-inspector');
    const form = inspector?.querySelector('#design-edit-form');
    const record = currentRecord(itemId);
    const prior = workingSnapshot(record, sourceItem(itemId)?.item || state()?.selectedDesign || {});
    if (!form) return prior;
    return snapshot({
      ...prior,
      status: form.querySelector('#design-status')?.value || prior.status,
      description: form.querySelector('#design-description')?.value?.trim?.() ?? prior.description,
      source: form.querySelector('#design-source')?.value?.trim?.() ?? prior.source,
      images: prior.images,
      sourceSnapshot: prior.sourceSnapshot || state()?.selectedDesign?.sourceSnapshot || null,
      candidateMaterials: prior.candidateMaterials?.length ? prior.candidateMaterials : state()?.selectedDesign?.candidateMaterials || []
    });
  }

  async function restoreVersionToWorking(itemId, snap) {
    const s = state();
    if (!s?.projectId) return;
    const saved = await Store.saveDesignEdit(s.projectId, itemId, snap);
    updateStateRecord(itemId, saved);
    selectedVersion.set(String(itemId), 'working');
    decorateBook();
    await decorateInspector(true);
  }

  async function syncToDesignBook(itemId) {
    const s = state();
    if (!s?.projectId || !itemId) return;
    const button = document.querySelector('[data-sync-design-book]');
    if (button) { button.disabled = true; button.textContent = 'Syncing release…'; }
    try {
      const before = releasedSnapshot(currentRecord(itemId));
      const patch = gatherWorkingPatch(itemId);
      const saved = await Store.saveDesignEdit(s.projectId, itemId, patch);
      updateStateRecord(itemId, saved);
      const result = await Store.releaseDesignPosition(s.projectId, itemId, { snapshot: patch, sourceRevision: s.cloudState?.revision || null });
      const record = updateStateRecord(itemId, result.record);
      const source = sourceItem(itemId);
      if (s.selectedDesign && String(s.selectedDesign.id) === String(itemId)) {
        s.selectedDesign = {
          ...(source?.item || s.selectedDesign),
          ...record,
          chapterTitle: source?.chapter?.title || s.selectedDesign.chapterTitle
        };
      }
      try {
        await Store.appendHistory?.(s.projectId, {
          sourceRevision: s.cloudState?.revision || null,
          kind: 'design-release',
          operation: 'sync-to-design-book',
          label: `Design Book release · ${s.selectedDesign?.chapterTitle || ''} / ${s.selectedDesign?.label || itemId}`,
          before,
          after: result.version.snapshot,
          relatedId: itemId,
          note: `Immutable Design Book release ${result.version.releaseNumber}`
        });
      } catch (error) { console.warn('[REVEX] Design Book release history', error); }
      selectedVersion.set(String(itemId), 'working');
      versionCache.delete(String(itemId));
      normalizeStateRecords();
      decorateBook();
      await decorateInspector(true);
      root.__revexBrowserDiagnostics?.emit?.('INFO', 'DESIGN_BOOK_RELEASE', `Design Book position ${itemId} synced as release ${result.version.releaseNumber}.`, { initiator: 'design release r51' });
    } catch (error) {
      console.error('[REVEX] Design Book release failed', error);
      if (button) { button.disabled = false; button.textContent = error?.message || 'Sync failed — retry'; }
    }
  }

  function decorateBook() {
    if (decorating) return;
    const s = state();
    const grid = document.getElementById('design-grid');
    if (!s?.designEdits || !grid) return;
    decorating = true;
    try {
      normalizeStateRecords();
      for (const card of grid.querySelectorAll('.design-card[data-item]')) {
        const itemId = card.dataset.item;
        const source = sourceItem(itemId)?.item || {};
        const editRaw = s.designEdits.get(itemId) || s.designEdits.get(String(itemId)) || null;
        const edit = editRaw ? projectionFor(editRaw) : null;
        if (edit) s.designEdits.set(itemId, edit);
        const released = releasedSnapshot(edit);
        const visible = released || snapshot(source);
        const image = visible.images.at?.(-1)?.url || visible.images[visible.images.length - 1]?.url || '';
        const imageHost = card.querySelector('.design-image');
        const copy = card.querySelector('.design-copy');
        if (imageHost) {
          const next = image ? `<img src="${esc(image)}" alt="" />` : 'ADD REFERENCE / RENDER';
          if (imageHost.innerHTML !== next) imageHost.innerHTML = next;
        }
        if (copy) {
          const title = copy.querySelector('strong');
          const description = copy.querySelector('p');
          const status = copy.querySelector('.status-chip');
          if (title) title.textContent = source.label || edit?.sourceSnapshot?.label || title.textContent;
          if (description) description.textContent = visible.description || (released ? 'No decision note yet.' : 'No released decision yet.');
          if (status) status.textContent = visible.status || 'Not Selected';
          let chip = copy.querySelector('.release-chip');
          if (!chip) {
            chip = document.createElement('span');
            chip.className = 'release-chip';
            copy.appendChild(chip);
          }
          chip.textContent = released
            ? Number(edit?.releaseModelVersion || 0) >= 2
              ? `RELEASE ${Number(edit?.releaseNumber || 1)}`
              : 'CURRENT RELEASE'
            : 'NOT RELEASED';
        }
        card.classList.toggle('has-unsynced-draft', Boolean(edit?.draftDirty));
      }
    } finally {
      decorating = false;
    }
  }

  async function decorateInspector(forceReload = false) {
    if (decorating) return;
    const s = state();
    const item = s?.selectedDesign;
    const inspector = document.getElementById('design-inspector');
    const form = inspector?.querySelector('#design-edit-form');
    if (!item?.id || !inspector || !form) return;
    decorating = true;
    try {
      inspector.querySelectorAll('[data-position-versions]').forEach((node) => node.remove());
      const itemId = String(item.id);
      const record = currentRecord(itemId);
      const working = workingSnapshot(record, sourceItem(itemId)?.item || item);
      const released = releasedSnapshot(record);
      if (!selectedVersion.has(itemId)) selectedVersion.set(itemId, 'working');

      let switcher = inspector.querySelector('[data-design-release-switcher]');
      if (!switcher) {
        switcher = document.createElement('section');
        switcher.dataset.designReleaseSwitcher = '1';
        switcher.className = 'design-release-switcher';
        form.insertAdjacentElement('beforebegin', switcher);
      }
      switcher.innerHTML = `<div class="design-release-head"><div><strong>Card versions</strong><small>Switch the full Design Book card state. Properties are editable only in Working.</small></div><span class="eyebrow">POSITION</span></div><div class="design-release-track"><div class="muted">Loading releases…</div></div>`;

      let actions = inspector.querySelector('[data-design-release-actions]');
      if (!actions) {
        actions = document.createElement('section');
        actions.dataset.designReleaseActions = '1';
        actions.className = 'design-release-actions';
        switcher.insertAdjacentElement('afterend', actions);
      }

      const versions = forceReload ? await (versionCache.delete(itemId), loadVersions(itemId)) : await loadVersions(itemId);
      if (!switcher.isConnected || String(state()?.selectedDesign?.id || '') !== itemId) return;
      const selected = selectedSnapshot(itemId, versions);
      const dirty = released ? snapshotSignature(working) !== snapshotSignature(released) : true;
      const workingRow = { snapshot: working };
      switcher.querySelector('.design-release-track').innerHTML = [
        cardMarkup('working', workingRow, selected.mode === 'working'),
        ...versions.map((version) => cardMarkup('version', version, selected.mode === 'version' && String(version.revexId || version.id || '') === String(selected.version?.revexId || selected.version?.id || '')))
      ].join('');
      switcher.querySelectorAll('[data-design-version]').forEach((card) => card.addEventListener('click', () => {
        selectedVersion.set(itemId, card.dataset.designVersion || 'working');
        decorateInspector();
      }));

      setFormSnapshot(form, selected.snapshot, selected.mode !== 'working');
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.textContent = 'Save working properties';

      actions.innerHTML = selected.mode === 'working'
        ? `<div class="design-release-state"><strong>${released ? `Design Book release ${Number(record?.releaseNumber || 1)}` : 'Not released to Design Book'}</strong><span>${dirty ? 'UNSYNCED WORKING CHANGES' : 'RELEASED'}</span></div>
           <button class="button primary-release" type="button" data-sync-design-book ${!dirty && released ? 'disabled' : ''}>${released ? (dirty ? 'Sync changes to Design Book' : 'Design Book is up to date') : 'Sync to Design Book'}</button>
           <p class="design-working-note">Save changes here as working properties. The Design Book card changes only when you sync a release.</p>`
        : `<div class="design-release-preview-note">You are previewing an immutable released card. Its full card state is shown in Properties below.</div>
           <button class="button" type="button" data-restore-design-version>Restore this version to working properties</button>
           <button class="button ghost" type="button" data-return-working>Return to working properties</button>`;
      actions.querySelector('[data-sync-design-book]')?.addEventListener('click', () => syncToDesignBook(itemId));
      actions.querySelector('[data-restore-design-version]')?.addEventListener('click', () => restoreVersionToWorking(itemId, selected.snapshot));
      actions.querySelector('[data-return-working]')?.addEventListener('click', () => { selectedVersion.set(itemId, 'working'); decorateInspector(); });
    } finally {
      decorating = false;
    }
  }

  function scheduleDecorate() {
    queueMicrotask(() => {
      if (decorating) return;
      decorateBook();
      decorateInspector();
    });
  }

  function bind() {
    installStyles();
    normalizeStateRecords();
    document.querySelectorAll('[data-position-versions]').forEach((node) => node.remove());
    const grid = document.getElementById('design-grid');
    const inspector = document.getElementById('design-inspector');
    if (grid && !grid.dataset.designReleaseObserver) {
      grid.dataset.designReleaseObserver = '1';
      new MutationObserver(scheduleDecorate).observe(grid, { childList: true, subtree: true });
    }
    if (inspector && !inspector.dataset.designReleaseObserver) {
      inspector.dataset.designReleaseObserver = '1';
      new MutationObserver(scheduleDecorate).observe(inspector, { childList: true, subtree: true });
    }
    scheduleDecorate();
  }

  root.addEventListener('revex:design-selection', (event) => {
    const itemId = String(event.detail?.item?.id || '');
    if (itemId) selectedVersion.set(itemId, 'working');
    setTimeout(scheduleDecorate, 0);
  });
  root.addEventListener('revex:source-revision-loaded', () => {
    versionCache.clear();
    setTimeout(bind, 20);
  });
  document.addEventListener('change', (event) => {
    if (event.target?.id === 'project-select') {
      versionCache.clear();
      selectedVersion.clear();
      setTimeout(bind, 20);
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
  setTimeout(bind, 250);
  setTimeout(bind, 1200);

  console.info('[REVEX] Design Book release model ' + BUILD, {
    workingProperties: true,
    explicitSyncToDesignBook: true,
    immutableFullCardReleases: true,
    cardVersionSwitcherAboveProperties: true,
    bookDisplaysReleasedStateOnly: true,
    legacyEditsPreservedAsCurrentRelease: true
  });
})(window);
