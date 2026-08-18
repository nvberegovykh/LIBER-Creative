/* REVEX WALLT control plane — two isolated channels over the existing runtime.
 * HELPER: navigate, find, focus and execute explicit user project actions through current UI owners.
 * FIXER: diagnose runtime failures and apply only registered reversible local overrides.
 *
 * This file owns no BIM, Docs, Chat, Render, Energy, Family or database implementation.
 * It dispatches into the already-active owners and keeps a rolling 24-hour evidence ledger.
 */
(function (root) {
  'use strict';

  const BUILD = '20260818-wallt-control1';
  const CYCLE_MS = 24 * 60 * 60 * 1000;
  const LEDGER_KEY = 'liber.revex.wallt.fix-cycle.v1';
  const MAX_LEDGER = 1000;
  const MAX_DIAGNOSTICS = 80;
  const CHANNEL_HELPER = 'helper';
  const CHANNEL_FIXER = 'fixer';
  const adapters = new Map();

  const clean = (value, max = 6000) => String(value ?? '').trim().slice(0, max);
  const clone = (value) => { try { return JSON.parse(JSON.stringify(value ?? null)); } catch (_) { return null; } };
  const nowIso = () => new Date().toISOString();
  const uid = (prefix = 'wallt') => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  function diagnostic(level, stage, message, detail = {}) {
    try {
      root.__revexBrowserDiagnostics?.emit?.(level, stage, message, {
        initiator: 'WALLT REVEX control plane', build: BUILD, ...detail
      });
    } catch (_) {}
  }

  function readLedger() {
    try {
      const rows = JSON.parse(localStorage.getItem(LEDGER_KEY) || '[]');
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  }

  function writeLedger(rows) {
    const cutoff = Date.now() - CYCLE_MS;
    const compact = rows.filter((row) => Date.parse(row?.at || '') >= cutoff).slice(-MAX_LEDGER);
    try { localStorage.setItem(LEDGER_KEY, JSON.stringify(compact)); } catch (_) {}
    return compact;
  }

  function record(channel, phase, request, detail = {}) {
    const row = {
      schema: 'liber.revex.wallt-cycle-event.v1',
      id: uid('cycle'),
      at: nowIso(),
      channel,
      phase,
      projectId: clean(root.__revexState?.projectId || '', 180) || null,
      revision: clean(root.__revexState?.cloudState?.revision || '', 240) || null,
      request: clean(request, 12000),
      detail: clone(detail)
    };
    writeLedger([...readLedger(), row]);
    try { root.dispatchEvent(new CustomEvent('revex:wallt-cycle-event', { detail: row })); } catch (_) {}
    return row;
  }

  function activeView() {
    const active = document.querySelector('.main-nav [data-view].active');
    return clean(active?.dataset?.view || '', 40) || null;
  }

  function runtimeSnapshot() {
    const state = root.__revexState || {};
    const selectedElement = state.selectedElement ? {
      id: state.selectedElement.id,
      uniqueId: state.selectedElement.uniqueId || null,
      category: state.selectedElement.category || null,
      name: state.selectedElement.name || state.selectedElement.type || null
    } : null;
    const selectedDesign = state.selectedDesign ? {
      id: state.selectedDesign.id || null,
      label: state.selectedDesign.label || null,
      chapterTitle: state.selectedDesign.chapterTitle || null,
      status: state.selectedDesign.status || null
    } : null;
    const diagnostics = root.__revexBrowserDiagnostics?.snapshot?.() || [];
    return {
      schema: 'liber.revex.wallt-runtime-snapshot.v1',
      at: nowIso(),
      build: BUILD,
      projectId: state.projectId || null,
      projectName: state.project?.name || state.project?.title || null,
      revision: state.cloudState?.revision || null,
      view: activeView(),
      selectedElement,
      selectedDesign,
      viewerMode: state.viewerMode || null,
      online: navigator.onLine,
      nativeRevit: Boolean(root.chrome?.webview?.postMessage),
      diagnostics: diagnostics.slice(-MAX_DIAGNOSTICS),
      adapters: [...adapters.keys()],
      loadedRuntimeOwners: [...document.querySelectorAll('script[data-revex-runtime]')].map((node) => node.dataset.revexRuntime).filter(Boolean)
    };
  }

  function spotlight(node, options = {}) {
    if (!node) throw new Error('Requested REVEX control is not currently available.');
    try { node.scrollIntoView({ behavior: options.instant ? 'auto' : 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
    node.classList.add('revex-wallt-target');
    let style = document.getElementById('revex-wallt-target-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'revex-wallt-target-style';
      style.textContent = '.revex-wallt-target{outline:2px solid currentColor!important;outline-offset:4px!important;box-shadow:0 0 0 6px rgba(255,255,255,.08)!important;transition:outline-color .2s,box-shadow .2s}.revex-wallt-target.revex-wallt-target-release{outline-color:transparent!important;box-shadow:none!important}';
      document.head.appendChild(style);
    }
    clearTimeout(node.__walltTargetTimer);
    node.__walltTargetTimer = setTimeout(() => {
      node.classList.add('revex-wallt-target-release');
      setTimeout(() => node.classList.remove('revex-wallt-target', 'revex-wallt-target-release'), 250);
    }, 2400);
    try { if (options.focus !== false && typeof node.focus === 'function') node.focus({ preventScroll: true }); } catch (_) {}
    return node;
  }

  const VIEW_NAMES = new Set(['bim', 'design', 'spec', 'docs', 'energy', 'chat', 'history']);
  const TARGETS = Object.freeze({
    'project': '#project-select',
    'bim.search': '#element-search',
    'bim.tree': '#element-tree',
    'bim.inspector': '#bim-inspector',
    'bim.viewer': '#viewer',
    'bim.section': '#section-controls',
    'design.chapters': '#chapter-list',
    'design.positions': '#design-grid',
    'design.inspector': '#design-inspector',
    'spec.book': '#spec-frame-wrap, #view-spec',
    'docs.search': '#docs-search',
    'docs.explorer': '#docs-tree, #docs-list, #view-docs',
    'docs.viewer': '#docs-frame',
    'energy.status': '#energy-run-status',
    'energy.results': '#energy-artifacts',
    'chat': '#chat-frame-wrap, #view-chat',
    'history': '#history-stream',
    'render': '#render-dialog',
    'issue': '#issue-drawer'
  });

  const CONTROLS = Object.freeze({
    'bim.fit': '#fit-model',
    'bim.walk': '#walk-toggle',
    'bim.section': '#section-toggle',
    'bim.showHidden': '#show-hidden-elements',
    'render.open': '#render-button',
    'history.refresh': '#history-refresh',
    'history.exportAffectedPlan': '#history-export-plan'
  });

  function fireInput(node, value) {
    if (!node) throw new Error('REVEX input is not available.');
    node.value = String(value ?? '');
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return node;
  }

  async function helperNavigate(action) {
    const view = clean(action.view, 40).toLowerCase();
    if (!VIEW_NAMES.has(view)) throw new Error(`Unsupported REVEX view: ${view || 'blank'}`);
    const tab = document.querySelector(`.main-nav [data-view="${CSS.escape(view)}"]`);
    if (!tab) throw new Error(`REVEX ${view} tab is unavailable.`);
    tab.click();
    spotlight(document.getElementById(`view-${view}`) || tab, { focus: false });
    return { view };
  }

  async function helperFocus(action) {
    const name = clean(action.target, 100);
    const selector = TARGETS[name];
    if (!selector) throw new Error(`Unsupported REVEX target: ${name || 'blank'}`);
    const node = document.querySelector(selector);
    spotlight(node);
    return { target: name };
  }

  async function helperSearch(action) {
    const scope = clean(action.scope, 40).toLowerCase();
    const query = clean(action.query, 500);
    if (!query) throw new Error('Search text is empty.');
    if (scope === 'bim') {
      await helperNavigate({ view: 'bim' });
      fireInput(document.getElementById('element-search'), query);
      spotlight(document.getElementById('element-tree'), { focus: false });
      return { scope, query };
    }
    if (scope === 'docs') {
      await helperNavigate({ view: 'docs' });
      fireInput(document.getElementById('docs-search'), query);
      spotlight(document.getElementById('view-docs'), { focus: false });
      return { scope, query };
    }
    throw new Error(`Unsupported REVEX search scope: ${scope || 'blank'}`);
  }

  async function helperSelectBim(action) {
    await helperNavigate({ view: 'bim' });
    const id = clean(action.elementId || '', 240);
    const query = clean(action.query || id, 500);
    if (query) fireInput(document.getElementById('element-search'), query);
    await new Promise((resolve) => setTimeout(resolve, 40));
    let node = id ? document.querySelector(`.tree-item[data-element-id="${CSS.escape(id)}"]`) : null;
    if (!node && query) {
      const q = query.toLowerCase();
      node = [...document.querySelectorAll('#element-tree .tree-item')].find((row) => (row.textContent || '').toLowerCase().includes(q)) || null;
    }
    if (!node) throw new Error(`Could not find BIM element ${id || query}.`);
    node.click();
    spotlight(document.getElementById('bim-inspector') || node, { focus: false });
    return { elementId: node.dataset.elementId || id || null };
  }

  async function helperControl(action) {
    const name = clean(action.control, 100);
    const selector = CONTROLS[name];
    if (!selector) throw new Error(`Unsupported REVEX control: ${name || 'blank'}`);
    const node = document.querySelector(selector);
    if (!node) throw new Error(`REVEX control ${name} is unavailable in the current state.`);
    if (action.value !== undefined && /^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) fireInput(node, action.value);
    else node.click();
    spotlight(node);
    return { control: name, value: action.value ?? null };
  }

  async function helperIssue(action) {
    const target = clean(action.target || 'current', 40).toLowerCase();
    if (target === 'bim' || (target === 'current' && root.__revexState?.selectedElement)) {
      await helperNavigate({ view: 'bim' });
      const button = document.getElementById('element-issue');
      if (!button) throw new Error('Select a BIM element before adding a BIM issue.');
      button.click();
    } else if (target === 'design' || (target === 'current' && root.__revexState?.selectedDesign)) {
      await helperNavigate({ view: 'design' });
      const button = document.getElementById('design-issue');
      if (!button) throw new Error('Select a Design Book position before adding a design issue.');
      button.click();
    } else {
      throw new Error('Choose or find the BIM element / Design Book position that the issue belongs to first.');
    }
    const drawer = document.getElementById('issue-drawer');
    if (!drawer || drawer.hidden) throw new Error('REVEX issue editor did not open.');
    if (action.title) fireInput(document.getElementById('issue-title'), clean(action.title, 120));
    if (action.body) fireInput(document.getElementById('issue-body'), clean(action.body, 3000));
    if (action.status) fireInput(document.getElementById('issue-status'), clean(action.status, 30));
    spotlight(drawer, { focus: false });
    if (action.commit === true) {
      const form = document.getElementById('issue-form');
      if (!form) throw new Error('REVEX issue form is unavailable.');
      form.requestSubmit();
      return { opened: true, committed: true };
    }
    return { opened: true, committed: false };
  }

  async function helperChat(action) {
    await helperNavigate({ view: 'chat' });
    const frame = document.getElementById('chat-frame');
    spotlight(frame || document.getElementById('view-chat'), { focus: false });
    if (action.message) {
      try {
        frame?.contentWindow?.postMessage({
          type: 'liber:revex-chat-context',
          context: clean(action.message, 6000),
          projectId: root.__revexState?.projectId || null,
          source: 'wallt-helper'
        }, location.origin);
      } catch (_) {}
    }
    return { opened: true };
  }

  const BUILTIN_HELPER = Object.freeze({
    navigate: helperNavigate,
    focus: helperFocus,
    search: helperSearch,
    select_bim: helperSelectBim,
    control: helperControl,
    issue: helperIssue,
    chat: helperChat
  });

  function actionHandler(channel, type) {
    const builtin = channel === CHANNEL_HELPER ? BUILTIN_HELPER[type] : null;
    if (builtin) return builtin;
    for (const adapter of adapters.values()) {
      const table = channel === CHANNEL_HELPER ? adapter.helperActions : adapter.fixerActions;
      if (typeof table?.[type] === 'function') return table[type];
    }
    return null;
  }

  async function execute(channel, actions, request = '') {
    const rows = Array.isArray(actions) ? actions : [];
    const results = [];
    for (const action of rows) {
      const type = clean(action?.type, 80);
      const handler = actionHandler(channel, type);
      if (!handler) throw new Error(`WALLT ${channel} action is not registered: ${type || 'blank'}`);
      const started = performance.now();
      try {
        const result = await handler(action || {}, { snapshot: runtimeSnapshot(), request });
        const row = { type, ok: true, ms: Math.round(performance.now() - started), result: clone(result) };
        results.push(row);
        record(channel, 'ACTION_OK', request, row);
      } catch (error) {
        const row = { type, ok: false, ms: Math.round(performance.now() - started), error: clean(error?.message || error, 3000) };
        results.push(row);
        record(channel, 'ACTION_FAILED', request, row);
        throw error;
      }
    }
    return results;
  }

  function parseJsonLoose(text) {
    const raw = clean(text, 50000);
    if (!raw) return null;
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(stripped); } catch (_) {}
    const a = stripped.indexOf('{'), b = stripped.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(stripped.slice(a, b + 1)); } catch (_) {} }
    return null;
  }

  async function planHelper(request) {
    const agent = root.walltAgent;
    if (!agent?.response) throw new Error('WALLT text service is not ready.');
    const snapshot = runtimeSnapshot();
    const instructions = [
      'You are WALLT Helper inside REVEX Companion.',
      'Your job is to help the user operate the CURRENT application, not to invent another implementation.',
      'Prefer taking the user directly to the correct module/control, finding the requested item, scrolling/focusing the exact panel, and performing explicit reversible actions.',
      'When the user explicitly asks to add an issue, you may open, fill and commit the existing REVEX issue form.',
      'Do not delete BIM geometry, overwrite Revit source evidence, deploy code, or fabricate project facts.',
      'Use only these built-in action types: navigate, focus, search, select_bim, control, issue, chat.',
      'Views: bim, design, spec, docs, energy, chat, history.',
      `Named focus targets: ${Object.keys(TARGETS).join(', ')}.`,
      `Named controls: ${Object.keys(CONTROLS).join(', ')}.`,
      `Registered helper adapters: ${[...adapters.entries()].flatMap(([name, value]) => Object.keys(value.helperActions || {}).map((action) => `${name}:${action}`)).join(', ') || 'none'}.`,
      'Return ONLY JSON: {"assistant":"short explanation","actions":[{...}],"needsUser":false}.',
      'Use issue.commit=true only when the user explicitly asked to create/save/add the issue; otherwise open and prefill it for review.',
      `Current REVEX runtime snapshot: ${JSON.stringify(snapshot)}`
    ].join('\n');
    const text = await agent.response({ instructions, input: [{ role: 'user', content: clean(request, 12000) }] });
    const plan = parseJsonLoose(text);
    if (!plan || !Array.isArray(plan.actions)) throw new Error('WALLT Helper returned an invalid action plan.');
    return plan;
  }

  async function planFixer(request) {
    const agent = root.walltAgent;
    if (!agent?.response) throw new Error('WALLT text service is not ready.');
    const snapshot = runtimeSnapshot();
    const fixerActions = [...adapters.entries()].flatMap(([name, value]) => Object.keys(value.fixerActions || {}).map((action) => `${name}:${action}`));
    const instructions = [
      'You are WALLT Fixer inside REVEX Companion.',
      'Diagnose the CURRENT runtime from supplied evidence. Do not create a second BIM/Docs/Chat/Render/Energy engine.',
      'A local fix may execute only a registered fixer adapter. If no matching adapter exists, diagnose and request a source candidate change rather than mutating arbitrary JavaScript/DOM state.',
      'Every attempted fix is recorded in the rolling 24-hour cycle ledger with evidence and outcome.',
      'Prefer current-owner repair; old generation files are evidence/rollback shadows, not new runtime owners.',
      'Never rewrite immutable Revit/Engineering revisions. Never fabricate project or filing facts.',
      `Registered fixer actions: ${fixerActions.join(', ') || 'none'}.`,
      'Return ONLY JSON: {"assistant":"short diagnosis","suspectedOwner":"runtime/file/module","evidence":["..."],"actions":[{...}],"needsSourceChange":true,"needsUser":false,"confidence":0.0}.',
      `Current REVEX runtime snapshot: ${JSON.stringify(snapshot)}`
    ].join('\n');
    const text = await agent.response({ instructions, input: [{ role: 'user', content: clean(request, 12000) }] });
    const plan = parseJsonLoose(text);
    if (!plan || !Array.isArray(plan.actions)) throw new Error('WALLT Fixer returned an invalid repair plan.');
    return plan;
  }

  async function run(channel, request, options = {}) {
    channel = String(channel || CHANNEL_HELPER).toLowerCase() === CHANNEL_FIXER ? CHANNEL_FIXER : CHANNEL_HELPER;
    const text = clean(request, 12000);
    if (!text) throw new Error('WALLT request is empty.');
    record(channel, 'REQUEST', text, { snapshot: runtimeSnapshot() });
    try {
      const plan = channel === CHANNEL_HELPER ? await planHelper(text) : await planFixer(text);
      record(channel, 'PLAN', text, plan);
      const results = options.planOnly === true ? [] : await execute(channel, plan.actions, text);
      const response = { schema: 'liber.revex.wallt-control-result.v1', channel, request: text, plan, results, snapshot: runtimeSnapshot() };
      record(channel, 'COMPLETE', text, { plan, results });
      return response;
    } catch (error) {
      record(channel, 'FAILED', text, { error: clean(error?.message || error, 4000), snapshot: runtimeSnapshot() });
      diagnostic('ERROR', `WALLT_${channel.toUpperCase()}`, error?.message || String(error));
      throw error;
    }
  }

  function registerAdapter(name, adapter = {}) {
    name = clean(name, 100);
    if (!name) throw new Error('WALLT adapter name is required.');
    const normalized = {
      describe: clean(adapter.describe || '', 1200),
      helperActions: { ...(adapter.helperActions || {}) },
      fixerActions: { ...(adapter.fixerActions || {}) }
    };
    adapters.set(name, normalized);
    diagnostic('INFO', 'WALLT_ADAPTER', `Registered WALLT local adapter: ${name}`, {
      helperActions: Object.keys(normalized.helperActions), fixerActions: Object.keys(normalized.fixerActions)
    });
    return () => adapters.delete(name);
  }

  function cycleReport() {
    const rows = writeLedger(readLedger());
    const summary = { helper: 0, fixer: 0, completed: 0, failed: 0, actionFailed: 0 };
    for (const row of rows) {
      if (row.channel === CHANNEL_HELPER) summary.helper += 1;
      if (row.channel === CHANNEL_FIXER) summary.fixer += 1;
      if (row.phase === 'COMPLETE') summary.completed += 1;
      if (row.phase === 'FAILED') summary.failed += 1;
      if (row.phase === 'ACTION_FAILED') summary.actionFailed += 1;
    }
    return {
      schema: 'liber.revex.wallt-24h-cycle-report.v1',
      generatedAt: nowIso(),
      windowHours: 24,
      projectId: root.__revexState?.projectId || null,
      summary,
      events: rows
    };
  }

  function clearCycle() {
    try { localStorage.removeItem(LEDGER_KEY); } catch (_) {}
  }

  function acceptMessage(event) {
    if (event.origin !== location.origin) return;
    const data = event.data || {};
    if (data.type !== 'liber:wallt-control') return;
    const requestId = clean(data.requestId || uid('request'), 160);
    run(data.channel, data.request, { planOnly: data.planOnly === true }).then((result) => {
      try { event.source?.postMessage({ type: 'liber:wallt-control-result', requestId, ok: true, result }, event.origin); } catch (_) {}
    }).catch((error) => {
      try { event.source?.postMessage({ type: 'liber:wallt-control-result', requestId, ok: false, error: clean(error?.message || error, 3000) }, event.origin); } catch (_) {}
    });
  }

  root.addEventListener('message', acceptMessage);
  root.__revexWalltControl = Object.freeze({
    build: BUILD,
    channels: Object.freeze([CHANNEL_HELPER, CHANNEL_FIXER]),
    run,
    helper: (request, options) => run(CHANNEL_HELPER, request, options),
    fixer: (request, options) => run(CHANNEL_FIXER, request, options),
    execute: (channel, actions, request = '') => execute(channel, actions, request),
    snapshot: runtimeSnapshot,
    registerAdapter,
    cycleReport,
    clearCycle
  });

  record(CHANNEL_HELPER, 'BOOT', 'WALLT control plane initialized.', { build: BUILD, channels: [CHANNEL_HELPER, CHANNEL_FIXER] });
  diagnostic('INFO', 'WALLT_CONTROL_READY', 'WALLT Helper + Fixer control plane initialized.', {
    channels: [CHANNEL_HELPER, CHANNEL_FIXER], cycleHours: 24, arbitraryDomMutation: false, sourceMutation: false
  });
})(window);
