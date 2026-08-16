(function (root) {
  'use strict';

  const BUILD = '20260815r49-design-property-overlays1';
  const SCHEMA = 'liber.revex.design-property-versions.v1';
  const BOOK_ID = '__design_book__';
  const DRAFT_ID = '__working_draft__';
  const Store = root.RevexStore;
  const state = root.__revexState;
  const $ = (selector, base = document) => base.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const iso = () => new Date().toISOString();
  const activeByPosition = new Map();
  const draftByPosition = new Map();
  let busy = false;

  if (!Store || !state || root.__revexDesignPropertyVersionsR52) return;

  function diagnostic(level, stage, message, detail = {}) {
    try { root.__revexBrowserDiagnostics?.emit?.(level, stage, message, { initiator: 'design property versions r52', ...detail }); } catch (_) {}
  }

  function toast(message, bad = false) {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('bad', bad);
    node.hidden = false;
    clearTimeout(node.__revexVersionToast);
    node.__revexVersionToast = setTimeout(() => { node.hidden = true; }, 4200);
  }

  function setSync(message, tone = 'quiet') {
    const label = $('#sync-label');
    const indicator = $('#sync-indicator');
    if (label) label.textContent = message;
    if (indicator) indicator.dataset.tone = tone;
  }

  function itemKey(item = state.selectedDesign) {
    return item && state.projectId ? `${state.projectId}::${item.id}` : '';
  }

  function cleanImage(image) {
    if (!image || typeof image !== 'object') return null;
    const url = String(image.url || '').trim();
    if (!url) return null;
    return { url, path: image.path || null, name: String(image.name || '').slice(0, 180) };
  }

  function snapshot(value = {}) {
    return {
      status: String(value.status || 'Not Selected'),
      description: String(value.description || ''),
      source: String(value.source || ''),
      images: (Array.isArray(value.images) ? value.images : []).map(cleanImage).filter(Boolean).slice(-12)
    };
  }

  function sourceItemRecord(item = state.selectedDesign) {
    if (!item) return {};
    return state.designEdits?.get?.(item.id) || {};
  }

  function canonicalSnapshot(item = state.selectedDesign) {
    if (!item) return snapshot();
    return snapshot(item);
  }

  function versions(item = state.selectedDesign) {
    const raw = sourceItemRecord(item)?.propertyVersions;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((row) => row && row.id && row.patch)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name || 'Version'),
        patch: snapshot(row.patch),
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null,
        createdBy: row.createdBy || null,
        updatedBy: row.updatedBy || null,
        syncedAt: row.syncedAt || null
      }))
      .slice(-40);
  }

  function selectedId(item = state.selectedDesign) {
    const key = itemKey(item);
    if (!key) return BOOK_ID;
    const current = activeByPosition.get(key);
    const rows = versions(item);
    if (current === BOOK_ID || current === DRAFT_ID || rows.some((row) => row.id === current)) return current;
    if (rows.length) return rows[rows.length - 1].id;
    return DRAFT_ID;
  }

  function draftSnapshot(item = state.selectedDesign) {
    const key = itemKey(item);
    if (!key) return canonicalSnapshot(item);
    if (!draftByPosition.has(key)) draftByPosition.set(key, canonicalSnapshot(item));
    return snapshot(draftByPosition.get(key));
  }

  function activeSnapshot(item = state.selectedDesign) {
    const id = selectedId(item);
    if (id === BOOK_ID) return canonicalSnapshot(item);
    if (id === DRAFT_ID) return draftSnapshot(item);
    return snapshot(versions(item).find((row) => row.id === id)?.patch || canonicalSnapshot(item));
  }

  function newVersionId() {
    return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function nextVersionName(rows) {
    let max = 0;
    for (const row of rows) {
      const match = String(row.name || '').match(/(?:version|option)\s*(\d+)/i);
      if (match) max = Math.max(max, Number(match[1]) || 0);
    }
    return `Version ${max + 1}`;
  }

  function updateLocalRecord(itemId, patch) {
    const current = state.designEdits?.get?.(itemId) || {};
    state.designEdits?.set?.(itemId, { ...current, ...patch, id: itemId });
  }

  async function persistVersions(item, rows, extra = {}) {
    const payload = {
      propertyVersionsSchema: SCHEMA,
      propertyVersions: rows,
      ...extra
    };
    const saved = await Store.saveDesignEdit(state.projectId, item.id, payload);
    updateLocalRecord(item.id, saved);
    return saved;
  }

  function readForm() {
    return snapshot({
      status: $('#design-status')?.value || 'Not Selected',
      description: $('#design-description')?.value || '',
      source: $('#design-source')?.value || '',
      images: activeSnapshot().images
    });
  }

  function imageStripHtml(images) {
    return (images || []).map((image) => `<img src="${esc(image.url)}" alt="${esc(image.name || '')}" />`).join('');
  }

  function applySnapshotToProperties(value, readOnly = false) {
    const status = $('#design-status');
    const description = $('#design-description');
    const source = $('#design-source');
    const upload = $('#design-image-upload');
    if (status) { status.value = value.status || 'Not Selected'; status.disabled = readOnly; }
    if (description) { description.value = value.description || ''; description.disabled = readOnly; }
    if (source) { source.value = value.source || ''; source.disabled = readOnly; }
    if (upload) upload.disabled = readOnly;
    const strip = $('#design-edit-form .image-strip');
    if (strip) strip.innerHTML = imageStripHtml(value.images);
    const submit = $('#design-edit-form button[type="submit"]');
    if (submit) {
      submit.textContent = readOnly ? 'Design Book release' : 'Save version';
      submit.disabled = readOnly;
      submit.title = readOnly ? 'The current Design Book card is released. Select or create a version to edit Properties.' : 'Save these Properties into the selected lightweight version.';
    }
    const syncButton = $('#design-sync-to-book');
    if (syncButton) syncButton.disabled = readOnly || busy;
  }

  function cardImage(value) {
    const image = value.images?.[value.images.length - 1];
    return image?.url ? `<img src="${esc(image.url)}" alt="" />` : '<span>NO IMAGE</span>';
  }

  function cardHtml(id, name, value, active, meta = '') {
    return `<button class="design-version-card${active ? ' active' : ''}" type="button" data-design-version="${esc(id)}">
      <div class="design-version-image">${cardImage(value)}</div>
      <div class="design-version-copy"><strong>${esc(name)}</strong><span>${esc(value.status || 'Not Selected')}</span><p>${esc(value.description || 'No note yet.')}</p>${meta ? `<small>${esc(meta)}</small>` : ''}</div>
    </button>`;
  }

  function ensureStyle() {
    if ($('#revex-design-property-versions-style')) return;
    const style = document.createElement('style');
    style.id = 'revex-design-property-versions-style';
    style.textContent = `
      .design-property-versions{margin:10px 0 14px;padding:10px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--panel-2) 82%,transparent)}
      .design-version-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.design-version-head>div{min-width:0}.design-version-head strong{display:block;font:10px var(--mono);letter-spacing:.11em}.design-version-head span{display:block;margin-top:2px;color:var(--tx-3);font-size:10px;line-height:1.3}.design-version-new{min-height:28px;padding:4px 8px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--tx-1);font:10px var(--mono);cursor:pointer}.design-version-cards{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,190px);gap:7px;overflow-x:auto;padding:1px 1px 5px;scrollbar-width:thin}.design-version-card{min-width:0;padding:0;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--tx-1);text-align:left;overflow:hidden;cursor:pointer}.design-version-card.active{border-color:var(--accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent) 55%,transparent)}.design-version-image{height:58px;display:grid;place-items:center;background:#10110f;color:var(--tx-3);font:8px var(--mono);overflow:hidden}.design-version-image img{width:100%;height:100%;object-fit:cover}.design-version-copy{padding:7px}.design-version-copy strong{display:block;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.design-version-copy>span{display:inline-block;margin-top:4px;padding:2px 5px;border:1px solid var(--line);border-radius:999px;color:var(--tx-2);font:8px var(--mono)}.design-version-copy p{margin:5px 0 0;color:var(--tx-2);font-size:9px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.design-version-copy small{display:block;margin-top:5px;color:var(--tx-3);font:8px var(--mono)}.design-version-release-note{margin:7px 0 0;color:var(--tx-3);font-size:9px;line-height:1.35}.design-version-actions{display:grid;grid-template-columns:1fr;gap:6px;margin-top:6px}.design-version-actions #design-sync-to-book{width:100%}.design-property-versions[data-book-active="1"]+.design-source-summary{opacity:.9}
    `;
    document.head.appendChild(style);
  }

  function renderSwitcher() {
    const item = state.selectedDesign;
    const inspector = $('#design-inspector');
    const form = $('#design-edit-form');
    if (!item || !inspector || !form) return;
    ensureStyle();
    const key = itemKey(item);
    const rows = versions(item);
    const active = selectedId(item);
    if (!activeByPosition.has(key)) activeByPosition.set(key, active);
    const book = canonicalSnapshot(item);
    const draft = draftSnapshot(item);
    let host = $('.design-property-versions', inspector);
    if (!host) {
      host = document.createElement('section');
      host.className = 'design-property-versions';
      const sourceSummary = $('.design-source-summary', inspector);
      if (sourceSummary) inspector.insertBefore(host, sourceSummary);
      else inspector.insertBefore(host, form);
    }
    host.dataset.bookActive = active === BOOK_ID ? '1' : '0';
    const cards = [cardHtml(BOOK_ID, 'Design Book', book, active === BOOK_ID, 'released card')];
    if (!rows.length || active === DRAFT_ID) cards.push(cardHtml(DRAFT_ID, 'Working version', draft, active === DRAFT_ID, 'not released'));
    for (const row of rows) cards.push(cardHtml(row.id, row.name, row.patch, active === row.id, row.syncedAt ? 'synced · retained' : 'overlay'));
    host.innerHTML = `<div class="design-version-head"><div><strong>VERSIONS</strong><span>Lightweight Property overlays. The Design Book card changes only on Sync.</span></div><button class="design-version-new" type="button">+ New version</button></div><div class="design-version-cards">${cards.join('')}</div><p class="design-version-release-note">Switch versions here, edit the normal Properties below, then sync the chosen version when it should become the Design Book card. Sync never deletes the version.</p>`;

    $('.design-version-new', host)?.addEventListener('click', createVersion);
    host.querySelectorAll('[data-design-version]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.designVersion;
      activeByPosition.set(key, id);
      renderSwitcher();
    }));

    let actions = $('.design-version-actions', form);
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'design-version-actions';
      const submit = $('button[type="submit"]', form);
      if (submit) submit.insertAdjacentElement('afterend', actions);
      else form.appendChild(actions);
    }
    actions.innerHTML = '<button class="button" id="design-sync-to-book" type="button">Sync to Design Book</button>';
    $('#design-sync-to-book')?.addEventListener('click', syncToDesignBook);

    applySnapshotToProperties(activeSnapshot(item), active === BOOK_ID);
  }

  async function createVersion() {
    if (busy || !state.selectedDesign) return;
    const item = state.selectedDesign;
    const key = itemKey(item);
    const rows = versions(item);
    const base = activeSnapshot(item);
    const row = {
      id: newVersionId(),
      name: nextVersionName(rows),
      patch: snapshot(base),
      createdAt: iso(),
      updatedAt: iso(),
      createdBy: Store.user?.uid || 'local',
      updatedBy: Store.user?.uid || 'local',
      syncedAt: null
    };
    busy = true;
    setSync('Creating Design Book version…', 'busy');
    try {
      await persistVersions(item, [...rows, row]);
      activeByPosition.set(key, row.id);
      draftByPosition.delete(key);
      try { await Store.appendHistory?.(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'design-version', operation: 'create', label: `${item.chapterTitle || 'Design Book'} · ${item.label} · ${row.name}`, relatedId: item.id, before: null, after: { versionId: row.id, name: row.name, patch: row.patch }, note: 'Lightweight Design Book Property overlay created; released card unchanged.' }); } catch (_) {}
      setSync('Version created · Design Book unchanged', Store.isCloud?.() ? 'good' : 'quiet');
      toast(`${row.name} created. Design Book unchanged.`);
    } catch (error) {
      setSync('Version creation failed', 'bad'); toast(error.message || 'Could not create the version.', true);
    } finally {
      busy = false;
      renderSwitcher();
    }
  }

  async function ensureSavedVersion(item, value) {
    const key = itemKey(item);
    const rows = versions(item);
    const active = selectedId(item);
    if (active === BOOK_ID) throw new Error('Select or create a version before editing the released Design Book card.');
    if (active === DRAFT_ID) {
      const row = {
        id: newVersionId(), name: nextVersionName(rows), patch: snapshot(value),
        createdAt: iso(), updatedAt: iso(), createdBy: Store.user?.uid || 'local', updatedBy: Store.user?.uid || 'local', syncedAt: null
      };
      await persistVersions(item, [...rows, row]);
      activeByPosition.set(key, row.id);
      draftByPosition.delete(key);
      return row;
    }
    const current = rows.find((row) => row.id === active);
    if (!current) throw new Error('The selected Design Book version is no longer available.');
    const updated = { ...current, patch: snapshot(value), updatedAt: iso(), updatedBy: Store.user?.uid || 'local' };
    await persistVersions(item, rows.map((row) => row.id === active ? updated : row));
    return updated;
  }

  async function saveVersion(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    if (busy || !state.selectedDesign) return;
    const item = state.selectedDesign;
    const before = activeSnapshot(item);
    const after = readForm();
    busy = true;
    setSync('Saving version Properties…', 'busy');
    try {
      const saved = await ensureSavedVersion(item, after);
      try { await Store.appendHistory?.(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'design-version', operation: 'edit', label: `${item.chapterTitle || 'Design Book'} · ${item.label} · ${saved.name}`, relatedId: item.id, before, after: saved.patch, note: 'Property overlay saved; Design Book released card unchanged.' }); } catch (_) {}
      setSync('Version saved · Design Book unchanged', Store.isCloud?.() ? 'good' : 'quiet');
      toast(`${saved.name} saved. Use Sync to Design Book when ready.`);
    } catch (error) {
      setSync('Version save failed', 'bad'); toast(error.message || 'Could not save this version.', true);
    } finally {
      busy = false;
      renderSwitcher();
    }
  }

  async function syncToDesignBook(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    if (busy || !state.selectedDesign) return;
    const item = state.selectedDesign;
    if (selectedId(item) === BOOK_ID) return toast('The Design Book release is already selected.', true);
    const before = canonicalSnapshot(item);
    const working = readForm();
    busy = true;
    setSync('Syncing selected version to Design Book…', 'busy');
    try {
      let savedVersion = await ensureSavedVersion(item, working);
      let rows = versions(item);
      const syncedAt = iso();
      rows = rows.map((row) => row.id === savedVersion.id ? { ...row, syncedAt } : row);
      savedVersion = { ...savedVersion, syncedAt };
      const released = snapshot(savedVersion.patch);
      const saved = await Store.saveDesignEdit(state.projectId, item.id, {
        ...released,
        propertyVersionsSchema: SCHEMA,
        propertyVersions: rows,
        syncedPropertyVersionId: savedVersion.id,
        syncedPropertyVersionAt: savedVersion.syncedAt
      });
      updateLocalRecord(item.id, saved);
      state.selectedDesign = { ...item, ...released, propertyVersions: rows, syncedPropertyVersionId: savedVersion.id, syncedPropertyVersionAt: savedVersion.syncedAt };
      try { await Store.appendHistory?.(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'design', operation: 'sync-version', label: `Sync to Design Book · ${item.chapterTitle || ''} / ${item.label}`, relatedId: item.id, affectedElementIds: item.revit?.elementIds || [], affectedLevels: item.revit?.levels || [], before, after: released, note: `${savedVersion.name} merged into the Design Book card; the version remains available.` }); } catch (_) {}
      setSync('Design Book synced', Store.isCloud?.() ? 'good' : 'quiet');
      toast(`${savedVersion.name} synced to Design Book. Version retained.`);
      diagnostic('INFO', 'DESIGN_VERSION_SYNC', 'Lightweight Property version merged into Design Book without deleting the version.', { projectId: state.projectId, itemId: item.id, versionId: savedVersion.id });
      refreshApplicationCard(item.id);
    } catch (error) {
      setSync('Design Book sync failed', 'bad'); toast(error.message || 'Could not sync this version to Design Book.', true);
    } finally {
      busy = false;
      setTimeout(renderSwitcher, 0);
    }
  }

  function refreshApplicationCard(itemId) {
    const chapterId = state.activeChapter;
    const chapterButton = chapterId ? $(`#chapter-list [data-chapter="${CSS.escape(String(chapterId))}"]`) : null;
    if (!chapterButton) return;
    chapterButton.click();
    requestAnimationFrame(() => {
      const card = $(`#design-grid .design-card[data-item="${CSS.escape(String(itemId))}"]`);
      card?.click?.();
    });
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read the image.'));
      reader.readAsDataURL(file);
    });
  }

  function safeName(name) {
    return String(name || 'image').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'image';
  }

  async function uploadVersionImage(event) {
    const input = event.target;
    if (input?.id !== 'design-image-upload' || !state.selectedDesign) return;
    event.stopImmediatePropagation();
    const file = input.files?.[0];
    if (!file) return;
    const item = state.selectedDesign;
    if (selectedId(item) === BOOK_ID) {
      toast('Create or select a version before adding an image. The released Design Book card is read-only.', true);
      input.value = '';
      return;
    }
    busy = true;
    setSync('Uploading image to version…', 'busy');
    try {
      let selected = selectedId(item);
      if (selected === DRAFT_ID) {
        const seeded = await ensureSavedVersion(item, activeSnapshot(item));
        selected = seeded.id;
      }
      let image;
      if (Store.isCloud?.() && Store.fs?.storage && Store.uploadFile) {
        const uploaded = await Store.uploadFile(`projects/${state.projectId}/revex/design/${encodeURIComponent(String(item.id))}/versions/${encodeURIComponent(selected)}/${Date.now()}_${safeName(file.name)}`, file);
        image = { url: uploaded.url, path: uploaded.path, name: file.name || safeName(file.name) };
      } else {
        image = { url: await readAsDataUrl(file), path: null, name: file.name || safeName(file.name) };
      }
      const current = activeSnapshot(item);
      const next = { ...current, images: [...(current.images || []), image].slice(-12) };
      const saved = await ensureSavedVersion(item, next);
      setSync('Version image saved · Design Book unchanged', Store.isCloud?.() ? 'good' : 'quiet');
      toast(`Image added to ${saved.name}.`);
    } catch (error) {
      setSync('Version image upload failed', 'bad'); toast(error.message || 'Could not upload the image.', true);
    } finally {
      busy = false;
      input.value = '';
      renderSwitcher();
    }
  }

  function install() {
    const inspector = $('#design-inspector');
    if (!state.selectedDesign || !$('#design-edit-form') || !inspector || $('.design-property-versions', inspector)) return;
    renderSwitcher();
  }

  document.addEventListener('submit', (event) => {
    if (event.target?.id !== 'design-edit-form') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void saveVersion(event);
  }, true);

  document.addEventListener('change', (event) => {
    if (event.target?.id !== 'design-image-upload') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void uploadVersionImage(event);
  }, true);

  root.addEventListener('revex:design-selection', () => setTimeout(install, 0));
  const observer = new MutationObserver(() => {
    const inspector = $('#design-inspector');
    if (state.selectedDesign && $('#design-edit-form') && inspector && !$('.design-property-versions', inspector)) install();
  });
  const startObserver = () => {
    const inspector = $('#design-inspector');
    if (inspector) observer.observe(inspector, { childList: true, subtree: true });
    install();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  else startObserver();

  root.__revexDesignPropertyVersionsR52 = {
    build: BUILD,
    schema: SCHEMA,
    kind: 'lightweight-property-overlay',
    releasedCard: 'Design Book',
    syncPreservesVersion: true,
    snapshot,
    versions: () => versions(),
    activeSnapshot: () => activeSnapshot(),
    render: renderSwitcher
  };

  diagnostic('INFO', 'DESIGN_PROPERTY_VERSIONS', 'Per-position lightweight Property overlays installed. Design Book remains the explicit released card.', { build: BUILD });
})(window);
