import * as THREE from 'three';

const BUILD = '20260820r145-section-delegate1';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const Store = window.RevexStore;
const state = window.__revexState;

if (!window.__revexReviewIntegrityR50) {
  window.__revexReviewIntegrityR50 = true;

  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const stableElementKey = (row) => String(row?.uniqueId || row?.elementId || row?.id || '').trim();
  const diagnostic = (level, stage, message) => {
    try { window.__revexBrowserDiagnostics?.emit?.(level, stage, message, { initiator: 'r49 review integrity' }); } catch (_) {}
  };

  function activeViewer() {
    return window.__revexViewerR26Instance || null;
  }

  function actualSectionBox(v) {
    if (!v?.bounds || v.bounds.isEmpty?.()) return null;
    const base = v.bounds;
    const size = base.getSize(new THREE.Vector3());
    const s = v.__reviewSection;
    return new THREE.Box3(
      new THREE.Vector3(
        base.min.x + size.x * s.minX,
        base.min.y + size.y * s.minY,
        base.min.z + size.z * s.minZ
      ),
      new THREE.Vector3(
        base.min.x + size.x * s.maxX,
        base.min.y + size.y * s.maxY,
        base.min.z + size.z * s.maxZ
      )
    );
  }

  function syncSectionInputs(v) {
    if (!v?.__reviewSection || !v.bounds) return;
    const s = v.__reviewSection;
    const faceValues = {
      'section-left': s.minX * 100,
      'section-right': s.maxX * 100,
      'section-front': s.minZ * 100,
      'section-back': s.maxZ * 100,
      'section-bottom': s.minY * 100,
      'section-top': s.maxY * 100
    };
    Object.entries(faceValues).forEach(([id, value]) => {
      const input = document.getElementById(id);
      if (input && document.activeElement !== input) input.value = String(Math.round(value * 10) / 10);
    });
    const box = actualSectionBox(v);
    if (!box) return;
    const size = box.getSize(new THREE.Vector3());
    const dimensions = {
      'section-width': size.x,
      'section-length': size.z,
      'section-height': size.y
    };
    Object.entries(dimensions).forEach(([id, value]) => {
      const input = document.getElementById(id);
      if (input && document.activeElement !== input) input.value = String(Math.round(value * 100) / 100);
    });
    const note = $('#section-size-note');
    if (note) note.textContent = `${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)} ft`;
  }

  function patchViewer(v) {
    if (!v || v.__reviewIntegrityR50) return Boolean(v);
    v.__reviewIntegrityR50 = true;
    v.__reviewSection = {
      enabled: false,
      minX: 0, maxX: 1,
      minY: 0, maxY: 1,
      minZ: 0, maxZ: 1
    };

    v.sectionBox = function sectionBox() {
      return actualSectionBox(this);
    };

    v.setSectionEnabled = function setSectionEnabled(enabled) {
      this.__reviewSection.enabled = Boolean(enabled);
      this.section.enabled = this.__reviewSection.enabled;
      this.sectionApply();
      const button = $('#section-toggle');
      if (button) {
        button.classList.toggle('active', this.__reviewSection.enabled);
        button.setAttribute('aria-expanded', String(this.__reviewSection.enabled));
      }
      const controls = $('#section-controls');
      if (controls) controls.hidden = !this.__reviewSection.enabled;
    };

    v.setSectionFace = function setSectionFace(face, percent) {
      const s = this.__reviewSection;
      const value = clamp(Number(percent) / 100);
      const gap = 0.002;
      if (face === 'left') s.minX = Math.min(value, s.maxX - gap);
      if (face === 'right') s.maxX = Math.max(value, s.minX + gap);
      if (face === 'front') s.minZ = Math.min(value, s.maxZ - gap);
      if (face === 'back') s.maxZ = Math.max(value, s.minZ + gap);
      if (face === 'bottom') s.minY = Math.min(value, s.maxY - gap);
      if (face === 'top') s.maxY = Math.max(value, s.minY + gap);
      this.sectionApply();
      syncSectionInputs(this);
    };

    v.setSectionDimension = function setSectionDimension(dimension, requested) {
      if (!this.bounds) return;
      const s = this.__reviewSection;
      const full = this.bounds.getSize(new THREE.Vector3());
      const value = Math.max(0.01, Number(requested) || 0.01);
      const config = dimension === 'width'
        ? ['minX', 'maxX', full.x]
        : dimension === 'length'
          ? ['minZ', 'maxZ', full.z]
          : ['minY', 'maxY', full.y];
      const [minKey, maxKey, fullSize] = config;
      const span = clamp(value / Math.max(fullSize, 0.0001), 0.002, 1);
      let center = (s[minKey] + s[maxKey]) / 2;
      center = clamp(center, span / 2, 1 - span / 2);
      s[minKey] = center - span / 2;
      s[maxKey] = center + span / 2;
      this.sectionApply();
      syncSectionInputs(this);
    };

    v.resetSection = function resetSection() {
      Object.assign(this.__reviewSection, { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 });
      this.sectionApply();
      syncSectionInputs(this);
    };

    v.sectionApply = function sectionApply() {
      const s = this.__reviewSection;
      const box = actualSectionBox(this);
      const planes = s.enabled && box ? [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -box.min.x),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), box.max.x),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -box.min.z),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), box.max.z),
        new THREE.Plane(new THREE.Vector3(0, 1, 0), -box.min.y),
        new THREE.Plane(new THREE.Vector3(0, -1, 0), box.max.y)
      ] : [];

      this.scene?.traverse?.((node) => {
        if (!node.isMesh) return;
        (Array.isArray(node.material) ? node.material : [node.material]).filter(Boolean).forEach((material) => {
          material.clippingPlanes = planes;
          material.needsUpdate = true;
        });
      });

      if (!this.__reviewSectionHelper && box) {
        this.__reviewSectionHelper = new THREE.Box3Helper(box.clone(), 0xffc247);
        this.__reviewSectionHelper.name = 'REVEX_SECTION_BOX';
        this.scene.add(this.__reviewSectionHelper);
      }
      if (this.__reviewSectionHelper) {
        this.__reviewSectionHelper.visible = Boolean(s.enabled && box);
        if (box) this.__reviewSectionHelper.box.copy(box);
        this.__reviewSectionHelper.updateMatrixWorld(true);
      }
      this.requestRender?.();
    };

    const originalLoad = typeof v.load === 'function' ? v.load.bind(v) : null;
    if (originalLoad) {
      v.load = async function reviewLoad(...args) {
        const result = await originalLoad(...args);
        this.resetSection();
        this.setSectionEnabled(false);
        return result;
      };
    }

    syncSectionInputs(v);
    diagnostic('INFO', 'VIEWER_REVIEW_CONTRACT', 'Physical BIM review controls and six-face visible section box installed. Spatial objects remain excluded.');
    return true;
  }

  function ensureViewerPatched() {
    const v = activeViewer();
    if (patchViewer(v)) return v;
    return null;
  }

  function handleViewerClick(event) {
    const button = event.target?.closest?.('button');
    if (!button) return;
    const id = button.id;
    if (!['fit-model', 'fit-model-rail', 'detail-toggle', 'walk-toggle', 'section-toggle', 'section-reset'].includes(id)) return;
    if (id === 'section-toggle' && window.__revexViewerInteractionR85) return; // r85 is the deterministic Section/selection owner.
    const v = ensureViewerPatched();
    if (!v) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (id === 'fit-model' || id === 'fit-model-rail') return v.fit?.();
    if (id === 'detail-toggle') return v.loadDetailed?.();
    if (id === 'section-toggle') return v.setSectionEnabled(!v.__reviewSection.enabled);
    if (id === 'section-reset') return v.resetSection();
    if (id === 'walk-toggle') {
      const on = !button.classList.contains('active');
      button.classList.toggle('active', on);
      const controls = $('#walk-controls');
      if (controls) controls.hidden = !on;
      v.walkOn?.(on);
    }
  }

  function handleViewerInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
    const v = ensureViewerPatched();
    if (!v) return;
    const face = {
      'section-left': 'left', 'section-right': 'right',
      'section-front': 'front', 'section-back': 'back',
      'section-bottom': 'bottom', 'section-top': 'top'
    }[target.id];
    const dimension = { 'section-width': 'width', 'section-length': 'length', 'section-height': 'height' }[target.id];
    if (!face && !dimension) return;
    event.stopImmediatePropagation();
    if (face) v.setSectionFace(face, target.value);
    if (dimension) v.setSectionDimension(dimension, target.value);
  }

  function uniqueOverlays() {
    if (!state?.bimOverlays) return [];
    const map = new Map();
    for (const row of state.bimOverlays.values()) {
      const key = stableElementKey(row);
      if (key) map.set(key, row);
    }
    return [...map.values()];
  }

  function overlayFor(element) {
    const key = stableElementKey(element);
    return uniqueOverlays().find((row) => stableElementKey(row) === key || String(row.elementId || row.id || '') === String(element?.id || '')) || null;
  }

  function replaceOverlay(row) {
    if (!state?.bimOverlays || !row) return;
    const key = stableElementKey(row);
    for (const [mapKey, value] of state.bimOverlays) {
      if (stableElementKey(value) === key || String(value.elementId || value.id || '') === String(row.elementId || row.id || '')) state.bimOverlays.delete(mapKey);
    }
    state.bimOverlays.set(key || String(row.id || Date.now()), row);
  }

  async function commitVisibility(element, patch, operation) {
    if (!Store?.commitBimOverlay || !state?.projectId || !element) return;
    const v = ensureViewerPatched();
    const result = await Store.commitBimOverlay(state.projectId, element, patch, {
      operation,
      sourceRevision: state.cloudState?.revision || null,
      label: `${element.category || 'BIM'} ${element.name || element.type || element.id || ''}`.trim(),
      camera: v?.cameraState?.() || null,
      snapshot: null,
      note: 'REVEX review visibility edit; authoritative RVT geometry remains unchanged.'
    });
    replaceOverlay(result?.overlay);
    v?.setOverlays?.(uniqueOverlays());
    renderHiddenRegistry();
    setTimeout(() => injectBimReviewControls(element), 0);
    diagnostic('INFO', 'BIM_REVIEW_EDIT', `${operation} saved for ${stableElementKey(element)}.`);
  }

  function injectBimReviewControls(element = state?.selectedElement) {
    const inspector = $('#bim-inspector');
    if (!inspector || !element) return;
    inspector.querySelector('[data-review-bim-controls]')?.remove();
    const overlay = overlayFor(element) || {};
    const hidden = Boolean(overlay.hidden);
    const deleted = Boolean(overlay.deleted);
    const box = document.createElement('div');
    box.dataset.reviewBimControls = '1';
    box.className = 'review-bim-controls';
    box.innerHTML = `
      <div class="eyebrow">REVIEW VISIBILITY</div>
      <div class="review-action-row">
        <button class="button ghost" type="button" data-review-hide>${hidden ? 'Show element' : 'Hide element'}</button>
        <button class="button ghost" type="button" data-review-delete>${deleted ? 'Restore deleted' : 'Delete'}</button>
      </div>
      <small class="muted">Hide/Delete are reversible REVEX review overlays. They never delete Revit geometry.</small>`;
    inspector.appendChild(box);
    $('[data-review-hide]', box)?.addEventListener('click', () => commitVisibility(element, { hidden: !hidden, deleted: false }, hidden ? 'show' : 'hide'));
    $('[data-review-delete]', box)?.addEventListener('click', () => commitVisibility(element, { deleted: !deleted, hidden: false }, deleted ? 'restore' : 'delete'));
  }

  function sourceElementForOverlay(row) {
    const elements = state?.viewerData?.elements || [];
    return elements.find((element) => stableElementKey(element) === stableElementKey(row) || String(element.id || '') === String(row.elementId || row.id || '')) || null;
  }

  function renderHiddenRegistry() {
    const tree = $('#element-tree');
    if (!tree) return;
    let registry = $('#review-hidden-registry');
    if (!state?.showHiddenOnly) {
      registry?.remove();
      return;
    }
    if (!registry) {
      registry = document.createElement('section');
      registry.id = 'review-hidden-registry';
      registry.className = 'review-hidden-registry';
      tree.insertAdjacentElement('afterend', registry);
    }
    const overlays = uniqueOverlays().filter((row) => row.hidden || row.deleted);
    registry.innerHTML = `<div class="tree-group">Hidden / deleted review records · ${overlays.length}</div>` + (overlays.length ? overlays.map((row) => {
      const source = sourceElementForOverlay(row);
      const status = row.deleted ? 'deleted' : 'hidden';
      return `<div class="review-hidden-row" data-overlay-key="${esc(stableElementKey(row))}">
        <div><strong>${esc(row.category || source?.category || 'BIM element')}</strong><span>${esc(source?.name || source?.type || row.elementId || row.id || stableElementKey(row))}</span><small>${status}${source ? ' · present in current revision' : ' · no longer present in current Revit revision'}</small></div>
        <button class="button ghost compact" type="button" data-review-restore="${esc(stableElementKey(row))}">Restore</button>
      </div>`;
    }).join('') : '<p class="muted">No hidden or deleted review records.</p>');
    $$('[data-review-restore]', registry).forEach((button) => button.addEventListener('click', async () => {
      const row = overlays.find((item) => stableElementKey(item) === button.dataset.reviewRestore);
      if (!row) return;
      const source = sourceElementForOverlay(row) || row;
      await commitVisibility(source, { hidden: false, deleted: false }, 'restore');
    }));
  }

  async function listDesignVersions(itemId) {
    if (!itemId || !state?.projectId) return [];
    if (!Store?.isCloud?.()) {
      try {
        return JSON.parse(localStorage.getItem(`liber.revex.design-versions.${state.projectId}`) || '[]')
          .filter((row) => String(row.overlayId || '') === String(itemId));
      } catch (_) { return []; }
    }
    try {
      const f = Store.api;
      const q = f.query(
        f.collection(Store.db, 'projects', state.projectId, 'library'),
        f.where('revexKind', '==', 'design-item-version'),
        f.limit(1000)
      );
      const snap = await f.getDocs(q);
      return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((row) => String(row.overlayId || '') === String(itemId));
    } catch (error) {
      console.warn('[REVEX] position versions', error);
      return [];
    }
  }

  async function injectPositionVersions(item = state?.selectedDesign) {
    const inspector = $('#design-inspector');
    if (!inspector || !item?.id) return;
    inspector.querySelector('[data-position-versions]')?.remove();
    const panel = document.createElement('section');
    panel.dataset.positionVersions = '1';
    panel.className = 'position-versions';
    panel.innerHTML = '<div class="eyebrow">POSITION VERSIONS</div><p class="muted">Loading this position’s immutable edit history…</p>';
    inspector.appendChild(panel);
    const versions = (await listDesignVersions(item.id)).sort((a, b) => String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || ''))).slice(0, 40);
    if (!panel.isConnected || String(state?.selectedDesign?.id || '') !== String(item.id)) return;
    panel.innerHTML = `<div class="eyebrow">POSITION VERSIONS · ${versions.length}</div>
      <p class="muted">Versions belong to this Design Book position, not to the whole chapter.</p>
      <div class="position-version-list">${versions.map((version, index) => {
        const images = Array.isArray(version.images) ? version.images : [];
        return `<article class="position-version-row">
          <strong>${esc(version.status || `Version ${versions.length - index}`)}</strong>
          <small>${esc(new Date(version.createdAt || version.updatedAt || Date.now()).toLocaleString())}</small>
          ${version.description ? `<p>${esc(version.description)}</p>` : ''}
          ${images.length ? `<div class="image-strip">${images.slice(-4).map((image) => `<img src="${esc(image.url)}" alt="${esc(image.name || '')}" />`).join('')}</div>` : ''}
        </article>`;
      }).join('') || '<p class="muted">No saved versions yet. The first edit or image on this position creates one automatically.</p>'}</div>`;
  }

  function enforcePositionVersionOwnership() {
    $$('#design-lanes .design-lane[data-field="versionImages"]').forEach((lane) => lane.remove());
  }

  function refreshSelectionUi() {
    enforcePositionVersionOwnership();
    if (state?.selectedElement) injectBimReviewControls(state.selectedElement);
    if (state?.selectedDesign) injectPositionVersions(state.selectedDesign);
    renderHiddenRegistry();
  }

  document.addEventListener('click', handleViewerClick, true);
  document.addEventListener('input', handleViewerInput, true);
  window.addEventListener('revex:bim-selection', (event) => setTimeout(() => injectBimReviewControls(event.detail?.element), 0));
  window.addEventListener('revex:design-selection', (event) => setTimeout(() => injectPositionVersions(event.detail?.item), 20));
  window.addEventListener('revex:source-revision-loaded', () => setTimeout(() => { ensureViewerPatched(); refreshSelectionUi(); }, 40));

  $('#show-hidden-elements')?.addEventListener('click', () => setTimeout(renderHiddenRegistry, 0));

  const designLanes = $('#design-lanes');
  if (designLanes) new MutationObserver(enforcePositionVersionOwnership).observe(designLanes, { childList: true, subtree: true });
  const bimInspector = $('#bim-inspector');
  if (bimInspector) new MutationObserver(() => {
    if (state?.selectedElement && !bimInspector.querySelector('[data-review-bim-controls]')) setTimeout(() => injectBimReviewControls(state.selectedElement), 0);
  }).observe(bimInspector, { childList: true, subtree: false });

  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    if (ensureViewerPatched()) {
      clearInterval(timer);
      refreshSelectionUi();
    } else if (attempts > 120) {
      clearInterval(timer);
      diagnostic('ERROR', 'VIEWER_REVIEW_CONTRACT', 'Viewer did not become available for the r49 review integrity layer.');
    }
  }, 100);

  console.info('[REVEX] review integrity ' + BUILD, {
    physicalModelOnly: true,
    spatialObjectsVisible: false,
    sixFaceSectionBox: true,
    visibleSectionHelper: true,
    reversibleHideDelete: true,
    hiddenRegistry: true,
    perPositionVersions: true,
    singleViewerControlOwner: true
  });
}
