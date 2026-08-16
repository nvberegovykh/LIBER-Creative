(() => {
  'use strict';
  const VERSION = '20260816r75';
  const LIMIT = 200;
  const DEDUPE_MS = 1600;
  const entries = [];
  const recent = new Map();
  const native = () => window.chrome?.webview?.postMessage;
  const clean = (value, max = 4000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const correlation = () => `browser-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  function emit(level, stage, message, extra = {}) {
    const normalizedLevel = clean(level || 'INFO', 12).toUpperCase();
    const normalizedStage = clean(stage || 'BROWSER', 80);
    const normalizedMessage = clean(message || 'Companion diagnostic event');
    const key = `${normalizedLevel}|${normalizedStage}|${normalizedMessage}`;
    const now = Date.now();
    const duplicate = recent.get(key);
    if (duplicate && now - duplicate.at < DEDUPE_MS) {
      duplicate.at = now;
      duplicate.count += 1;
      const row = entries[duplicate.index];
      if (row) row.repeatCount = duplicate.count;
      return row || null;
    }

    const row = {
      at: new Date(now).toISOString(),
      level: normalizedLevel,
      stage: normalizedStage,
      message: normalizedMessage,
      stack: clean(extra.stack || '', 8000),
      correlationId: clean(extra.correlationId || correlation(), 120),
      initiator: clean(extra.initiator || 'REVEX Companion browser', 160),
      href: location.href,
      build: VERSION,
      repeatCount: 1
    };
    entries.push(row);
    if (entries.length > LIMIT) {
      entries.splice(0, entries.length - LIMIT);
      recent.clear();
    }
    recent.set(key, { at: now, count: 1, index: entries.length - 1 });
    try {
      if (native()) window.chrome.webview.postMessage({ type: 'liber:revex-diagnostic', ...row });
    } catch (_) {}
    return row;
  }

  window.__revexBrowserDiagnostics = {
    version: VERSION,
    emit,
    snapshot: () => entries.map((row) => ({ ...row })),
    clear: () => { entries.length = 0; recent.clear(); }
  };

  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window) {
      const src = target.src || target.href || target.currentSrc || target.tagName || 'resource';
      emit('ERROR', 'RESOURCE_LOAD', `Failed to load ${src}`, { initiator: 'browser resource loader' });
      return;
    }
    emit('ERROR', 'WINDOW_ERROR', event.message || 'Unhandled browser error', {
      stack: event.error?.stack || '', initiator: 'window error event'
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    emit('ERROR', 'UNHANDLED_PROMISE', reason?.message || reason || 'Unhandled promise rejection', {
      stack: reason?.stack || '', initiator: 'unhandledrejection event'
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
      : `REVEX Store contract complete (${requiredStore.length} required methods).`, { initiator: 'browser dependency audit' });

    const viewer = window.__revexViewerR26Instance;
    if (viewer) {
      const requiredViewer = ['sectionBox','sectionApply','setSectionFace','setSectionDimension','resetSection','pick'];
      const missingViewer = requiredViewer.filter((name) => typeof viewer[name] !== 'function');
      emit(missingViewer.length ? 'ERROR' : 'INFO', 'VIEWER_CONTRACT', missingViewer.length
        ? `BIM viewer contract incomplete: ${missingViewer.join(', ')}`
        : 'BIM viewer contract ready: exact instance picking + six-face section box.', { initiator: 'browser dependency audit' });
    } else if (window.__revexViewerR26Unavailable) {
      emit('WARN', 'VIEWER_CONTRACT', `BIM viewer controlled fallback active: ${clean(window.__revexViewerR26Unavailable.reason || 'WebGL unavailable')}`, { initiator: 'browser dependency audit' });
    } else {
      emit('WARN', 'VIEWER_CONTRACT', 'BIM viewer instance is not ready yet; deferred audit will retry.', { initiator: 'browser dependency audit' });
    }
  }

  emit('INFO', 'BOOT', 'REVEX Companion browser diagnostics bridge initialized.', { initiator: native() ? 'REVEX Revit WebView2' : 'regular browser' });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(auditContracts, 250), { once: true });
  else setTimeout(auditContracts, 250);
  setTimeout(auditContracts, 2500);
})();
