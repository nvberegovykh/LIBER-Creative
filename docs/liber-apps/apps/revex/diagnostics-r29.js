(() => {
  'use strict';
  const VERSION = '20260812r38';
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

  emit('INFO', 'BOOT', 'REVEX Companion browser diagnostics bridge initialized.', {
    initiator: native() ? 'REVEX Revit WebView2' : 'regular browser'
  });
})();
