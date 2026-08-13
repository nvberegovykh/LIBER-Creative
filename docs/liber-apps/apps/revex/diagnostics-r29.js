(() => {
  'use strict';
  const VERSION = '20260812r41';
  const LIMIT = 200;
  const entries = [];
  const native = () => window.chrome?.webview?.postMessage;
  const clean = (value, max = 4000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const correlation = () => `browser-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  function emit(level, stage, message, extra = {}) {
    const row = {
      at: new Date().toISOString(),
      level: clean(level || 'INFO', 12).toUpperCase(),
      stage: clean(stage || 'BROWSER', 80),
      message: clean(message || 'Companion diagnostic event'),
      stack: clean(extra.stack || '', 8000),
      correlationId: clean(extra.correlationId || correlation(), 120),
      initiator: clean(extra.initiator || 'REVEX Companion browser', 160),
      href: location.href,
      build: VERSION
    };
    entries.push(row);
    if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
    try {
      if (native()) window.chrome.webview.postMessage({ type: 'liber:revex-diagnostic', ...row });
    } catch (_) {}
    return row;
  }

  window.__revexBrowserDiagnostics = {
    version: VERSION,
    emit,
    snapshot: () => entries.map((row) => ({ ...row })),
    clear: () => { entries.length = 0; }
  };

  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window) {
      const src = target.src || target.href || target.currentSrc || target.tagName || 'resource';
      emit('ERROR', 'RESOURCE_LOAD', `Failed to load ${src}`, { initiator: 'browser resource loader' });
      return;
    }
    emit('ERROR', 'WINDOW_ERROR', event.message || 'Unhandled browser error', {
      stack: event.error?.stack || '',
      initiator: 'window error event'
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    emit('ERROR', 'UNHANDLED_PROMISE', reason?.message || reason || 'Unhandled promise rejection', {
      stack: reason?.stack || '',
      initiator: 'unhandledrejection event'
    });
  });

  window.addEventListener('offline', () => emit('WARN', 'NETWORK', 'Browser went offline.', { initiator: 'network state' }));
  window.addEventListener('online', () => emit('INFO', 'NETWORK', 'Browser is online.', { initiator: 'network state' }));
  window.addEventListener('liber:revex-diagnostic', (event) => {
    const d = event.detail || {};
    emit(d.level || 'INFO', d.stage || 'APP', d.message || 'Companion app diagnostic', d);
  });

  function auditContracts() {
    const store = window.RevexStore;
    const requiredStore = [
      'listProjects','getProject','createProject','getState','syncPackage',
      'resolveSpecProject','ensureSpecProject',
      'listDesignEdits','saveDesignEdit','listChapterEdits','saveChapterEdit','uploadDesignImage','uploadChapterImage',
      'listLibrary','fileUrl','uploadLibraryFile','listHistory','appendHistory',
      'listBimOverlays','commitBimOverlay','listDerivedPlans','saveDerivedPlan',
      'getEngineeringState','syncEngineeringPackage','runEnergyServer','getEnergyResult'
    ];
    const missingStore = !store ? requiredStore : requiredStore.filter((name) => typeof store[name] !== 'function');
    emit(missingStore.length ? 'ERROR' : 'INFO', 'RUNTIME_CONTRACT', missingStore.length
      ? `REVEX Store contract incomplete: ${missingStore.join(', ')}`
      : `REVEX Store contract complete (${requiredStore.length} required methods).`, {
        initiator: 'browser dependency audit'
      });

    const viewer = window.__revexViewerR26Instance;
    if (viewer) {
      const requiredViewer = ['sectionBox','sectionApply','setSectionFace','setSectionDimension','resetSection','pick'];
      const missingViewer = requiredViewer.filter((name) => typeof viewer[name] !== 'function');
      emit(missingViewer.length ? 'ERROR' : 'INFO', 'VIEWER_CONTRACT', missingViewer.length
        ? `BIM viewer contract incomplete: ${missingViewer.join(', ')}`
        : 'BIM viewer contract ready: exact instance picking + six-face section box.', {
          initiator: 'browser dependency audit',
          detail: {
            instanceIdPicking: true,
            familyFilter: Boolean(document.getElementById('model-family-type-filter')),
            instanceFilter: Boolean(document.getElementById('model-instance-filter'))
          }
        });
    } else {
      emit('WARN', 'VIEWER_CONTRACT', 'BIM viewer instance is not ready yet; deferred audit will retry.', { initiator: 'browser dependency audit' });
    }
  }

  function sanitizeLegacyViewerBindings() {
    const v = window.__revexViewerR26Instance;
    if (!v || v.__revexR41ControlOwnership) return Boolean(v);
    if (typeof v.sectionApply !== 'function' || typeof v.setSectionFace !== 'function' || typeof v.setSectionDimension !== 'function') return false;
    v.__revexR41ControlOwnership = true;
    const replace = (id, bind) => {
      const old = document.getElementById(id);
      if (!old) return null;
      const fresh = old.cloneNode(true);
      old.replaceWith(fresh);
      bind?.(fresh);
      return fresh;
    };
    replace('fit-model', el => el.addEventListener('click', () => v.fit?.()));
    replace('fit-model-rail', el => el.addEventListener('click', () => v.fit?.()));
    replace('walk-toggle', el => el.addEventListener('click', () => {
      const on = !el.classList.contains('active');
      el.classList.toggle('active', on);
      const controls = document.getElementById('walk-controls');
      if (controls) controls.hidden = !on;
      v.walkOn?.(on);
    }));
    replace('walk-floor', el => el.addEventListener('change', () => {
      v.floor = Number(el.value) || 0;
      if (v.walk) { v.camera.position.y = v.floor + v.eye; v.requestRender?.(); }
    }));
    replace('walk-height', el => el.addEventListener('input', () => {
      v.eye = Math.max(2.5, Math.min(9, Number(el.value) || 5.5));
      if (v.walk) { v.camera.position.y = v.floor + v.eye; v.requestRender?.(); }
    }));
    replace('walk-fov', el => el.addEventListener('input', () => {
      v.camera.fov = Math.max(30, Math.min(90, Number(el.value) || 55));
      v.camera.updateProjectionMatrix();
      const label = document.getElementById('walk-fov-value');
      if (label) label.textContent = `${Math.round(v.camera.fov)}°`;
      v.requestRender?.();
    }));
    replace('section-toggle', el => el.addEventListener('click', () => {
      v.section.enabled = !v.section.enabled;
      el.classList.toggle('active', v.section.enabled);
      el.setAttribute('aria-expanded', String(v.section.enabled));
      const controls = document.getElementById('section-controls');
      if (controls) controls.hidden = !v.section.enabled;
      v.sectionApply();
    }));
    for (const [id, key] of [['section-left','minX'],['section-right','maxX'],['section-bottom','minY'],['section-top','maxY'],['section-front','minZ'],['section-back','maxZ']]) {
      replace(id, el => el.addEventListener('input', () => v.setSectionFace(key, (Number(el.value) || 0) / 100)));
    }
    for (const [id, axis] of [['section-width','X'],['section-height','Y'],['section-length','Z']]) {
      replace(id, el => el.addEventListener('change', () => v.setSectionDimension(axis, Number(el.value))));
    }
    replace('section-reset', el => el.addEventListener('click', () => v.resetSection()));
    emit('INFO', 'VIEWER_CONTROL_OWNERSHIP', 'r41 removed legacy duplicate Walk/Section bindings; viewer owns the controls once.', { initiator: 'public compatibility boundary' });
    return true;
  }

  emit('INFO', 'BOOT', 'REVEX Companion browser diagnostics bridge initialized.', {
    initiator: native() ? 'REVEX Revit WebView2' : 'regular browser'
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(auditContracts, 250), { once: true });
  else setTimeout(auditContracts, 250);
  setTimeout(auditContracts, 2500);
  let ownershipAttempts = 0;
  const ensureOwnership = () => { if (sanitizeLegacyViewerBindings()) return; ownershipAttempts += 1; if (ownershipAttempts < 12) setTimeout(ensureOwnership, 1000); };
  setTimeout(ensureOwnership, 1200);
  emit('INFO', 'PUBLIC_COMPAT', 'Public REVEX is using the r41 compatibility boundary over the older hosted core until the canonical large-file mirror is replaced atomically.', { initiator: 'public compatibility boundary' });
})();
