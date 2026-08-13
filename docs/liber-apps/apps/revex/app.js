
const Store = window.RevexStore;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const params = new URLSearchParams(location.search);

const state = {
  projects: [],
  project: null,
  projectId: params.get('projectId') || '',
  preferredSpecId: params.get('specProjectId') || '',
  cloudState: null,
  viewerData: null,
  designData: null,
  designEdits: new Map(),
  chapterEdits: new Map(),
  issues: [],
  library: [],
  renderJobs: [],
  activeRenderJob: null,
  selectedElement: null,
  selectedDesign: null,
  selectedContext: '',
  activeChapter: '',
  viewerMode: '',
  unsubscribe: null,
  loadingRevision: '',
  docSelection: null,
  chatConnId: '',
  chatLoaded: false,
  historyEvents: [],
  bimOverlays: new Map(),
  derivedPlans: [],
  showHiddenOnly: false
};
window.__revexState = state;

function storeCall(name, args = [], fallback = null) {
  const fn = Store?.[name];
  if (typeof fn !== 'function') {
    console.warn(`[REVEX] Store.${name} unavailable; continuing with fallback.`, { build: '20260813r47' });
    return Promise.resolve(fallback);
  }
  try { return Promise.resolve(fn.apply(Store, args)); }
  catch (error) { return Promise.reject(error); }
}

let projectReturnFocus = null;
let renderReturnFocus = null;
let pendingNativeRender = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatDate(value) {
  if (!value) return '—';
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function setSync(label, tone = 'quiet') {
  $('#sync-label').textContent = label;
  $('#sync-indicator').dataset.tone = tone;
}

let toastTimer;
function toast(message, bad = false) {
  clearTimeout(toastTimer);
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('bad', bad);
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; }, 4200);
}

function appUrl(appFolder, query = {}) {
  const url = new URL(location.href);
  url.pathname = url.pathname.replace(/\/apps\/revex\/[^/]*$/, `/apps/${appFolder}/index.html`);
  url.search = '';
  Object.entries(query).forEach(([key, value]) => { if (value) url.searchParams.set(key, value); });
  return url.href;
}

function openInLiberShell(id, name, url) {
  try {
    const host = window.parent && window.parent !== window ? window.parent : window.top;
    if (host?.appsManager?.openAppInShell) {
      host.appsManager.openAppInShell({ id, name }, url);
      return;
    }
  } catch (_) {}
  location.href = url;
}

function contextFor(kind, record) {
  const project = state.project?.name || state.project?.title || state.projectId || 'Project';
  if (kind === 'BIM') {
    return `[REVEX · BIM]\nProject: ${project}\nElement ${record.id}: ${record.category || 'Element'} / ${record.name || record.type || 'Unnamed'}\nCentral revision: ${state.cloudState?.revision || 'local'}`;
  }
  return `[REVEX · Design Book]\nProject: ${project}\n${record.chapterTitle} / ${record.label}\nStatus: ${record.status || 'Not Selected'}\nCentral revision: ${state.cloudState?.revision || 'local'}`;
}

async function ensureChatEmbedded(context = state.selectedContext) {
  if (!state.projectId) return;
  const frame = $('#chat-frame');
  const placeholder = $('#chat-placeholder');
  if (!frame) return;
  try {
    if (!state.chatConnId) {
      const result = await Store.ensureProjectChat(state.projectId);
      if (!result?.connId) throw new Error('No project connection was returned.');
      state.chatConnId = result.connId;
    }
    if (context) {
      sessionStorage.setItem('liber_revex_chat_draft', context);
      try { frame.contentWindow?.postMessage({ type: 'liber:revex-chat-context', context, projectId: state.projectId }, location.origin); } catch (_) {}
    }
    if (!state.chatLoaded) {
      frame.src = appUrl('secure-chat', { connId: state.chatConnId, embedded: 'revex' });
      state.chatLoaded = true;
    }
    placeholder.hidden = true;
  } catch (error) {
    placeholder.hidden = false;
    placeholder.textContent = error.message || 'Project Chat is unavailable.';
  }
}

async function openProjectChat(context = state.selectedContext) {
  if (!state.projectId) return toast('Choose a LIBER project first.', true);
  showView('chat');
  await ensureChatEmbedded(context);
}

// BIM rendering is owned exclusively by the external lightweight viewer.
let viewer = null;
function activeBimViewer(){ return window.__revexViewerR26Instance || window.__revexViewerR25Instance || window.__revexViewerR24Instance || window.__revexViewerR23Instance || window.__revexViewerR22Instance || window.__revexViewerR21Instance || viewer || null; }

function showView(name) {
  closeWorkspaceRail();
  const hasProject = Boolean(state.projectId);
  const engineeringOnboarding = name === 'energy';
  $('#view-empty').hidden = hasProject || engineeringOnboarding;
  for (const view of ['bim', 'design', 'spec', 'docs', 'energy', 'chat', 'history']) {
    const allowed = hasProject || view === 'energy';
    $(`#view-${view}`).hidden = !allowed || view !== name;
  }
  $$('.main-nav [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  const query = new URLSearchParams({
    ...(params.get('inShell') ? { inShell: '1' } : {}),
    ...(hasProject ? { projectId: state.projectId } : {}),
    ...(state.preferredSpecId ? { specProjectId: state.preferredSpecId } : {}),
    view: name
  });
  history.replaceState(null, '', `${location.pathname}?${query}`);
  if (name === 'energy') window.dispatchEvent(new CustomEvent('revex:energy-open', { detail: { projectId: state.projectId || '' } }));
  if (!hasProject) return;
  const av = activeBimViewer();
  av?.setActive?.(name === 'bim');
  if (name === 'bim') setTimeout(() => { av?.resize?.(); av?.requestRender?.(); }, 0);
  if (name === 'spec') renderSpec();
  if (name === 'chat') { renderChatContext(); setTimeout(() => ensureChatEmbedded(state.selectedContext), 0); }
  if (name === 'history') window.dispatchEvent(new CustomEvent('revex:history-open', { detail: { projectId: state.projectId } }));
}

function currentWorkspaceRail() {
  return $('.view:not([hidden]) .rail, .view:not([hidden]) .chapter-rail');
}

function setWorkspaceRail(open) {
  const rail = currentWorkspaceRail();
  if (!rail) open = false;
  $$('.rail.open, .chapter-rail.open').forEach((node) => node.classList.remove('open'));
  if (open) rail.classList.add('open');
  $('#rail-scrim').hidden = !open;
  $('#rail-toggle').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('sp-locked', open);
}

function closeWorkspaceRail() { setWorkspaceRail(false); }

function toggleWorkspaceRail() {
  const rail = currentWorkspaceRail();
  setWorkspaceRail(Boolean(rail) && !rail.classList.contains('open'));
}

function renderProjects() {
  const select = $('#project-select');
  const hasActive = state.projectId && state.projects.some((project) => project.id === state.projectId);
  const provisional = state.projectId && !hasActive
    ? `<option value="${escapeHtml(state.projectId)}" data-revex-provisional="1">${escapeHtml(state.project?.name || state.project?.title || state.projectId)}</option>`
    : '';
  select.innerHTML = '<option value="">Choose a project</option>' + provisional + state.projects.map((project) =>
    `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name || project.title || 'Untitled project')}</option>`
  ).join('');
  select.value = state.projectId;
}

function persistProjectRoute() {
  if (state.projectId) params.set('projectId', state.projectId);
  else params.delete('projectId');
  if (state.preferredSpecId) params.set('specProjectId', state.preferredSpecId);
  else params.delete('specProjectId');
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`);
}

function notifyNativeProject() {
  if (!state.projectId) return;
  try {
    window.chrome?.webview?.postMessage({
      type: 'liber:revex-project-selected',
      projectId: state.projectId,
      specProjectId: state.preferredSpecId || null,
      projectName: state.project?.name || state.project?.title || ''
    });
  } catch (_) {}
}

function openProjectDialog() {
  projectReturnFocus = document.activeElement;
  $('#project-form').reset();
  $('#project-dialog').hidden = false;
  setTimeout(() => $('#project-name').focus(), 0);
}

function closeProjectDialog() {
  $('#project-dialog').hidden = true;
  const target = projectReturnFocus;
  projectReturnFocus = null;
  target?.focus?.();
}

async function createProject(event) {
  event.preventDefault();
  const button = $('#project-create');
  button.disabled = true;
  button.textContent = 'Creating…';
  setSync('Creating REVEX project…', 'busy');
  try {
    const created = await Store.createProject({
      name: $('#project-name').value,
      code: $('#project-code').value,
      driveFileId: $('#project-drive-id').value,
      description: $('#project-description').value
    });
    state.projects = await Store.listProjects();
    if (!state.projects.some((row) => row.id === created.id)) state.projects.unshift(created);
    renderProjects();
    closeProjectDialog();
    await activateProject(created.id);
    toast('REVEX project, Spec Book and project connection created.');
  } catch (error) {
    setSync('Project creation failed', 'bad');
    toast(error.message || 'Could not create the project.', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Create project';
  }
}

function connectExistingProject() {
  if (!state.projects.length) return openProjectDialog();
  $('#project-select').focus();
  try { $('#project-select').showPicker?.(); } catch (_) {}
  toast('Choose the existing LIBER project from the project field.');
}

function modelFamilyTypeKey(row) {
  const family = String(row?.family || row?.category || 'System / Other').trim() || 'System / Other';
  const type = String(row?.type || row?.name || 'Unnamed type').trim() || 'Unnamed type';
  return `${family}\u241f${type}`;
}

function modelFamilyTypeLabel(row) {
  const family = String(row?.family || row?.category || 'System / Other').trim() || 'System / Other';
  const type = String(row?.type || row?.name || 'Unnamed type').trim() || 'Unnamed type';
  return family.toLowerCase() === type.toLowerCase() ? family : `${family} · ${type}`;
}

function modelInstanceLabel(row) {
  const name = String(row?.name || '').trim();
  const type = String(row?.type || '').trim();
  const level = String(row?.level || '').trim();
  const primary = name && name.toLowerCase() !== type.toLowerCase() ? name : (level ? `${type || row?.category || 'Instance'} · ${level}` : (type || row?.category || 'Instance'));
  return `${primary} · #${row?.id ?? ''}`;
}

function modelOverlay(row) {
  const overlays = state.bimOverlays;
  if (!overlays?.get) return null;
  return overlays.get(String(row?.uniqueId || '')) || overlays.get(String(row?.id || '')) || null;
}

function modelRowInVisibilityMode(row) {
  const overlay = modelOverlay(row);
  const hidden = Boolean(overlay?.hidden) && !overlay?.deleted;
  return state.showHiddenOnly ? hidden : !hidden && !overlay?.deleted;
}

function syncHiddenMode() {
  const button = $('#model-hidden-filter');
  if (button) {
    button.classList.toggle('active', state.showHiddenOnly);
    button.setAttribute('aria-pressed', String(state.showHiddenOnly));
    button.textContent = state.showHiddenOnly ? 'Show visible' : 'Show hidden';
  }
  activeBimViewer()?.setVisibilityMode?.(state.showHiddenOnly ? 'hidden-only' : 'normal');
}

function ensureModelFilterBar() {
  const search = $('#element-search');
  if (!search) return null;
  let host = $('#model-filter-bar');
  if (!host) {
    host = document.createElement('div');
    host.id = 'model-filter-bar';
    host.className = 'model-filter-bar';
    host.innerHTML = `
      <label><span>Family type</span><select id="model-family-type-filter" class="sp-inp"><option value="">All family types</option></select></label>
      <label><span>Instance</span><select id="model-instance-filter" class="sp-inp"><option value="">All instances</option></select></label>
      <button id="model-hidden-filter" type="button" class="button ghost compact" aria-pressed="false">Show hidden</button>
      <button id="model-filter-clear" type="button" class="button ghost compact">Clear</button>`;
    search.insertAdjacentElement('afterend', host);
    $('#model-hidden-filter', host)?.addEventListener('click', () => {
      state.showHiddenOnly = !state.showHiddenOnly;
      const family = $('#model-family-type-filter');
      const instance = $('#model-instance-filter');
      if (family) family.value = '';
      if (instance) instance.value = '';
      if (search) search.value = '';
      syncHiddenMode();
      renderModelTree();
    });
    $('#model-filter-clear', host)?.addEventListener('click', () => {
      const family = $('#model-family-type-filter');
      const instance = $('#model-instance-filter');
      if (family) family.value = '';
      if (instance) instance.value = '';
      if (search) search.value = '';
      renderModelTree();
    });
  }
  syncHiddenMode();
  return host;
}

function renderModelTree() {
  const data = state.viewerData;
  const elements = data?.elements || [];
  $('#model-title').textContent = data?.source?.documentTitle || state.cloudState?.central?.documentTitle || 'No model synced';
  $('#model-facts').innerHTML = state.cloudState ? `
    <div class="fact"><strong>${elements.length.toLocaleString()}</strong><span>model instances</span></div>
    <div class="fact"><strong>${(data?.source?.viewName || '3D').slice(0, 20)}</strong><span>Revit view</span></div>
    <div class="fact"><strong>${state.cloudState.scheduleCount || state.designData?.schedules?.length || 0}</strong><span>schedules</span></div>
    <div class="fact"><strong>${state.viewerMode === 'rvxmesh' ? 'Exact' : state.viewerMode === 'fbx' ? 'FBX' : state.viewerMode === 'fallback' ? 'Index' : 'Loading'}</strong><span>geometry</span></div>` : '';

  const filterHost = ensureModelFilterBar();
  const familySelect = $('#model-family-type-filter', filterHost || document);
  const instanceSelect = $('#model-instance-filter', filterHost || document);
  const q = ($('#element-search')?.value || '').trim().toLowerCase();
  const previousFamily = familySelect?.value || '';
  const previousInstance = instanceSelect?.value || '';

  const modeElements = elements.filter(modelRowInVisibilityMode);
  const typeBuckets = new Map();
  for (const row of modeElements) {
    const key = modelFamilyTypeKey(row);
    if (!typeBuckets.has(key)) typeBuckets.set(key, { key, label: modelFamilyTypeLabel(row), rows: [] });
    typeBuckets.get(key).rows.push(row);
  }
  const sortedTypes = [...typeBuckets.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  if (familySelect) {
    familySelect.innerHTML = '<option value="">All family types</option>' + sortedTypes.map((bucket) => `<option value="${escapeHtml(bucket.key)}">${escapeHtml(bucket.label)} · ${bucket.rows.length}</option>`).join('');
    familySelect.value = typeBuckets.has(previousFamily) ? previousFamily : '';
    familySelect.onchange = () => { if (instanceSelect) instanceSelect.value = ''; renderModelTree(); };
  }
  const activeFamily = familySelect?.value || '';
  const familyRows = activeFamily ? (typeBuckets.get(activeFamily)?.rows || []) : modeElements;
  const sortedInstances = [...familyRows].sort((a, b) => modelInstanceLabel(a).localeCompare(modelInstanceLabel(b), undefined, { numeric: true, sensitivity: 'base' }));
  if (instanceSelect) {
    instanceSelect.innerHTML = '<option value="">All instances</option>' + sortedInstances.slice(0, 3000).map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(modelInstanceLabel(row))}</option>`).join('');
    instanceSelect.value = sortedInstances.some((row) => String(row.id) === previousInstance) ? previousInstance : '';
    instanceSelect.onchange = () => {
      const id = instanceSelect.value;
      if (!id) return renderModelTree();
      const element = elements.find((row) => String(row.id) === String(id));
      if (element) selectElement(element, true);
    };
  }
  const activeInstance = instanceSelect?.value || '';

  const visible = modeElements.filter((row) => {
    if (activeFamily && modelFamilyTypeKey(row) !== activeFamily) return false;
    if (activeInstance && String(row.id) !== activeInstance) return false;
    if (!q) return true;
    return `${row.id} ${row.category || ''} ${row.family || ''} ${row.name || ''} ${row.type || ''} ${row.level || ''} ${(row.materials || []).map((m) => m.name).join(' ')}`.toLowerCase().includes(q);
  });

  const grouped = new Map();
  for (const row of visible) {
    const key = modelFamilyTypeKey(row);
    if (!grouped.has(key)) grouped.set(key, { label: modelFamilyTypeLabel(row), rows: [] });
    grouped.get(key).rows.push(row);
  }
  const treeLimit = (q || activeFamily || activeInstance) ? 1800 : 900;
  let shown = 0;
  const chunks = [];
  [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })).forEach((bucket) => {
    if (shown >= treeLimit) return;
    const rows = bucket.rows.sort((a, b) => modelInstanceLabel(a).localeCompare(modelInstanceLabel(b), undefined, { numeric: true, sensitivity: 'base' }));
    chunks.push(`<div class="tree-group tree-family-type"><span>${escapeHtml(bucket.label)}</span><b>${rows.length}</b></div>`);
    for (const row of rows.slice(0, Math.max(treeLimit - shown, 0))) {
      shown += 1;
      const secondary = [row.category, row.level].filter(Boolean).join(' · ');
      const hiddenTag = modelOverlay(row)?.hidden ? '<small>Hidden in Companion</small>' : '';
      chunks.push(`<button class="tree-item${String(state.selectedElement?.id) === String(row.id) ? ' active' : ''}" data-element-id="${escapeHtml(row.id)}"><span class="tree-instance"><b>${escapeHtml(modelInstanceLabel(row).replace(/ · #.*$/, ''))}</b>${secondary ? `<small>${escapeHtml(secondary)}</small>` : ''}${hiddenTag}</span><span class="tree-id">#${escapeHtml(row.id)}</span></button>`);
    }
  });
  if (visible.length > shown) chunks.push(`<p class="muted">Showing ${shown.toLocaleString()} of ${visible.length.toLocaleString()} matching instances. Use Family type, Instance or search to narrow.</p>`);
  $('#element-tree').innerHTML = chunks.join('') || `<p class="muted">${state.showHiddenOnly ? 'No hidden model instances.' : 'No matching visible model instances.'}</p>`;
  $$('.tree-item', $('#element-tree')).forEach((button) => button.addEventListener('click', () => {
    const element = elements.find((row) => String(row.id) === button.dataset.elementId);
    if (element) { selectElement(element, true); closeWorkspaceRail(); }
  }));
}

function elementIssues(element) {
  return state.issues.filter((issue) => String(issue.anchorElementId || '') === String(element?.id || ''));
}

function designPositionForElement(element) {
  let typeMatch = null;
  for (const chapter of chapters()) {
    for (const source of chapter.items || []) {
      const revit = source.revit;
      if (!revit) continue;
      if ((revit.elementIds || []).some((id) => String(id) === String(element.id))) return { chapter, source };
      if (!typeMatch && String(revit.category || '').toLowerCase() === String(element.category || '').toLowerCase() &&
          String(revit.type || '').toLowerCase() === String(element.type || '').toLowerCase()) typeMatch = { chapter, source };
    }
  }
  return typeMatch;
}

function selectElement(element, fit = true) {
  state.selectedElement = element;
  state.selectedDesign = null;
  state.selectedContext = contextFor('BIM', element);
  window.dispatchEvent(new CustomEvent('revex:bim-selection', { detail: { element } }));
  activeBimViewer()?.select?.(element, fit);
  renderModelTree();
  const issues = elementIssues(element);
  const designPosition = designPositionForElement(element);
  $('#bim-inspector').innerHTML = `
    <div class="eyebrow">REVIT ELEMENT ${escapeHtml(element.id)}</div>
    <h2>${escapeHtml(element.name || element.type || element.category || 'Element')}</h2>
    <div class="property-list">
      <div class="property"><span>Category</span>${escapeHtml(element.category || '—')}</div>
      <div class="property"><span>Family</span>${escapeHtml(element.family || element.category || '—')}</div>
      <div class="property"><span>Type</span>${escapeHtml(element.type || '—')}</div>
      <div class="property"><span>Level</span>${escapeHtml(element.level || '—')}</div>
      <div class="property"><span>Unique ID</span>${escapeHtml(element.uniqueId || '—')}</div>
      <div class="property"><span>Materials</span>${(element.materials || []).map((m) => `<b class="material-chip">${escapeHtml(m.name)}</b>`).join('') || '—'}</div>
    </div>
    <button class="button" id="element-render" type="button">Render selection</button>
    <button class="button" id="element-issue" type="button">Add BIM issue</button>
    ${designPosition ? '<button class="button ghost" id="element-design" type="button">Open Design Book position</button>' : ''}
    <button class="button ghost" id="element-chat" type="button">Send context to Project Chat</button>
    <h3>Issues · ${issues.length}</h3>
    <div class="issue-list">${issues.map((issue) => `<div class="issue-row"><strong>${escapeHtml(issue.title)}</strong><small>${escapeHtml(issue.status)} · ${formatDate(issue.createdAt)}</small><p>${escapeHtml(issue.body)}</p></div>`).join('') || '<p class="muted">No issues on this element.</p>'}</div>`;
  $('#element-render').addEventListener('click', openRenderDialog);
  $('#element-issue').addEventListener('click', () => openIssue({ kind: 'bim', element }));
  $('#element-design')?.addEventListener('click', () => openDesignPosition(designPosition.chapter, designPosition.source, true));
  $('#element-chat').addEventListener('click', () => openProjectChat(state.selectedContext));
}

function renderPins() {
  $('#issue-pins').innerHTML = state.issues.filter((issue) => issue.anchorUniqueId || issue.anchorElementId).map((issue, index) =>
    `<button class="issue-pin ${escapeHtml(issue.status || 'open')}" data-id="${escapeHtml(issue.id)}" data-element-id="${escapeHtml(issue.anchorElementId || '')}" data-unique-id="${escapeHtml(issue.anchorUniqueId || '')}" type="button" title="${escapeHtml(issue.title)}">${index + 1}</button>`
  ).join('');
  $$('.issue-pin', $('#issue-pins')).forEach((pin) => pin.addEventListener('click', () => {
    const issue = state.issues.find((row) => row.id === pin.dataset.id);
    const av = activeBimViewer();
    const element = issue?.anchorUniqueId ? av?.byUid?.get?.(String(issue.anchorUniqueId)) : av?.byId?.get?.(String(issue?.anchorElementId));
    if (element) selectElement(element, true);
  }));
  activeBimViewer()?.requestRender?.();
}

function smallStableHash(value) {
  let h = 2166136261;
  for (const ch of String(value || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function formDesignFallback(viewerData) {
  const rows = viewerData?.elements || [];
  if (!rows.length) return null;
  const categories = new Map();
  for (const row of rows) {
    const category = String(row.category || 'Other').trim() || 'Other';
    const family = String(row.family || '').trim();
    const type = String(row.type || row.name || 'Unnamed type').trim() || 'Unnamed type';
    const key = `${category}\u0000${family}\u0000${type}`;
    if (!categories.has(category)) categories.set(category, new Map());
    const bucket = categories.get(category);
    if (!bucket.has(key)) bucket.set(key, { category, family, type, ids: [], levels: new Set() });
    const item = bucket.get(key);
    item.ids.push(row.id);
    if (row.level) item.levels.add(String(row.level));
  }
  const chapters = [...categories.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([category, bucket], order) => ({
    id: `model-${smallStableHash(category)}`, title: category, order, sourceKind: 'revit-model-fallback',
    items: [...bucket.values()].sort((a,b) => `${a.family} ${a.type}`.localeCompare(`${b.family} ${b.type}`)).map((item) => ({
      id: `model-${smallStableHash(`${item.category}|${item.family}|${item.type}`)}`,
      label: [item.family, item.type].filter(Boolean).join(' · ') || item.category,
      description: '', status: 'Not Selected', source: '', images: [],
      revit: { category: item.category, family: item.family, type: item.type, instanceCount: item.ids.length, elementIds: item.ids, levels: [...item.levels] }
    }))
  }));
  return { schema: 'liber.revex.design-book.fallback.v1', sourceKind: 'revit-model-fallback', chapters, schedules: [] };
}

function normalizeDesignSource(data, viewerData) {
  if (data && Array.isArray(data.chapters) && data.chapters.length) return data;
  return formDesignFallback(viewerData) || data || null;
}

function assertRevisionAssets(cloudState, revision) {
  if (!cloudState || cloudState.schema !== 'liber.revex.cloud-state.v3') return;
  if (String(cloudState.latestRevision || '') !== String(revision) ||
      String(cloudState.assetRevision || '') !== String(revision) ||
      String(cloudState.modelRevision || '') !== String(revision))
    throw new Error(`BIM revision ${revision} has mismatched geometry assets; the previous active revision remains isolated.`);
  if (!cloudState.viewerUrl || !cloudState.designUrl || !cloudState.modelUrl || cloudState.modelFormat !== 'rvxmesh-gzip')
    throw new Error(`BIM revision ${revision} is incomplete; the active revision pointer was not accepted.`);
}

function mergedItem(item) {
  return { ...item, ...(state.designEdits.get(item.id) || {}) };
}

function chapters() {
  const current = [...(state.designData?.chapters || [])];
  const sourceIds = new Set(current.flatMap((chapter) => (chapter.items || []).map((item) => String(item.id))));
  const archived = [];
  state.designEdits.forEach((edit, id) => {
    if (sourceIds.has(String(id))) return;
    const snap = edit.sourceSnapshot;
    if (!snap?.label) return;
    archived.push({
      id: String(id), label: snap.label, description: edit.description || 'Removed from the current Revit source revision.',
      status: edit.status || 'Archived', source: edit.source || '', images: edit.images || [], revit: snap.revit || null,
      archivedFromRevit: true, originalChapterTitle: snap.chapterTitle || 'Design Book'
    });
  });
  if (archived.length) current.push({ id: 'revex-archived-source', title: 'Archived / Removed from Revit', order: 999999, sourceKind: 'revex-overlay-archive', items: archived });
  return current;
}

function mergedChapter(chapter) {
  return { ...chapter, ...(state.chapterEdits.get(chapter.id) || {}) };
}

function openDesignPosition(chapter, sourceItem, switchView = false) {
  state.activeChapter = chapter.id;
  state.selectedDesign = { ...mergedItem(sourceItem), chapterTitle: chapter.title };
  state.selectedElement = null;
  state.selectedContext = contextFor('Design', state.selectedDesign);
  window.dispatchEvent(new CustomEvent('revex:design-selection', { detail: { item: state.selectedDesign } }));
  if (switchView) showView('design');
  renderDesign();
  renderDesignInspector();
}


function renderDesignProgress() {
  const sourceItems = chapters().flatMap((chapter) => (chapter.items || []).map((item) => ({ chapter, item })));
  const active = sourceItems.map(({ item }) => mergedItem(item));
  const specified = active.filter((item) => {
    const status = String(item.status || 'Not Selected');
    return status !== 'Not Selected' || Boolean(String(item.description || '').trim()) || Boolean(String(item.source || '').trim()) || Boolean(item.images?.length);
  }).length;
  const total = active.length;
  const percent = total ? Math.round(specified / total * 100) : 0;
  const host = $('#design-progress');
  if (!host) return;
  const needs = specified < total;
  host.innerHTML = `<div class="design-progress-head"><div><strong>${needs ? 'Needs attention' : 'Design Book complete'}</strong><span> · whole project</span></div><b>${percent}%</b></div><div class="design-progress-meta">${specified.toLocaleString()} of ${total.toLocaleString()} positions carry a decision, note, source or image</div><div class="design-progress-track"><i style="width:${percent}%"></i></div><small>${needs ? `${(total-specified).toLocaleString()} positions still need a designer decision` : 'No unreviewed positions left'}</small>`;
}
function renderDesign() {
  renderDesignProgress();
  const list = chapters();
  if (!state.activeChapter || !list.some((chapter) => chapter.id === state.activeChapter)) state.activeChapter = list[0]?.id || '';
  $('#chapter-list').innerHTML = list.map((chapter) => `<button type="button" class="${chapter.id === state.activeChapter ? 'active' : ''}" data-chapter="${escapeHtml(chapter.id)}"><span>${escapeHtml(chapter.title)}</span><small>${chapter.items?.length || 0}</small></button>`).join('') || '<p class="muted">Sync from Revit to form the Design Book.</p>';
  $$('#chapter-list button').forEach((button) => button.addEventListener('click', () => { state.activeChapter = button.dataset.chapter; state.selectedDesign = null; renderDesign(); renderDesignInspector(); closeWorkspaceRail(); }));
  const chapter = list.find((row) => row.id === state.activeChapter);
  const formedChapter = chapter ? mergedChapter(chapter) : null;
  $('#chapter-title').textContent = chapter?.title || 'Design Book';
  $('#chapter-subtitle').textContent = chapter
    ? `${chapter.items?.length || 0} positions · ${chapter.sourceKind === 'revit-model-fallback' ? 'formed from visible Revit model types' : 'approved Design Book reference enriched by Revit schedules'}`
    : 'Sync room, material and design schedules from Revit.';
  renderDesignLanes(formedChapter);
  $('#design-grid').innerHTML = (chapter?.items || []).map((sourceItem) => {
    const item = mergedItem(sourceItem);
    const image = item.images?.at?.(-1)?.url || item.images?.[item.images.length - 1]?.url;
    return `<button class="design-card${state.selectedDesign?.id === item.id ? ' active' : ''}" data-item="${escapeHtml(item.id)}" type="button">
      <div class="design-image">${image ? `<img src="${escapeHtml(image)}" alt="" />` : 'ADD REFERENCE / RENDER'}</div>
      <div class="design-copy"><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.description || 'No decision note yet.')}</p><span class="status-chip">${escapeHtml(item.status || 'Not Selected')}</span>${item.revit ? `<span class="source-chip">REVIT · ${Number(item.revit.instanceCount || 0).toLocaleString()}</span>` : ''}</div>
    </button>`;
  }).join('') || '<p class="muted">No positions in this chapter.</p>';
  $$('.design-card', $('#design-grid')).forEach((card) => card.addEventListener('click', () => {
    const source = chapter.items.find((item) => item.id === card.dataset.item);
    openDesignPosition(chapter, source);
  }));
}

function renderDesignLanes(chapter) {
  const host = $('#design-lanes');
  if (!chapter) { host.innerHTML = ''; return; }
  const lanes = [
    { field: 'inspiration', title: 'Inspiration', hint: 'References and precedents', images: chapter.inspiration || [] },
    { field: 'renders', title: 'Renderings', hint: 'Current project visualizations', images: chapter.renders || [] },
    { field: 'versionImages', title: 'Versions', hint: 'Saved visual directions', images: chapter.versionImages || [], versions: chapter.versions || [] }
  ];
  host.innerHTML = lanes.map((lane) => `
    <section class="design-lane" data-field="${lane.field}">
      <div class="design-lane-head"><div><strong>${lane.title}</strong><small>${lane.hint}</small></div><label class="lane-upload">Add<input type="file" accept="image/*" data-chapter-field="${lane.field}" /></label></div>
      ${lane.versions?.length ? `<div class="version-list">${lane.versions.map((version) => `<span>${escapeHtml(version.name)}</span>`).join('')}</div>` : ''}
      <div class="lane-images">${lane.images.map((image) => `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name || lane.title)}" />`).join('') || '<span>Drop in the first visual</span>'}</div>
    </section>`).join('');
  $$('[data-chapter-field]', host).forEach((input) => input.addEventListener('change', uploadChapterImage));
}

async function uploadChapterImage(event) {
  const file = event.target.files?.[0];
  const chapter = chapters().find((row) => row.id === state.activeChapter);
  if (!file || !chapter) return;
  const field = event.target.dataset.chapterField;
  const current = mergedChapter(chapter)[field] || [];
  try {
    setSync(`Uploading ${field === 'inspiration' ? 'inspiration' : field === 'renders' ? 'rendering' : 'version'}…`, 'busy');
    const images = await Store.uploadChapterImage(state.projectId, chapter.id, field, file, current);
    const edit = { ...(state.chapterEdits.get(chapter.id) || {}), [field]: images };
    state.chapterEdits.set(chapter.id, edit);
    renderDesign();
    setSync('Design Book visual saved', Store.isCloud() ? 'good' : 'quiet');
    toast('Chapter visual saved outside the RVT.');
  } catch (error) { setSync('Visual upload failed', 'bad'); toast(error.message, true); }
}

function renderDesignInspector() {
  const item = state.selectedDesign;
  if (!item) {
    $('#design-inspector').innerHTML = '<div class="eyebrow">DESIGN POSITION</div><h2>Select a position</h2><p class="muted">Images and decisions are saved outside the RVT and survive the next Revit sync.</p>';
    return;
  }
  $('#design-inspector').innerHTML = `
    <div class="eyebrow">${escapeHtml(item.chapterTitle)}</div><h2>${escapeHtml(item.label)}</h2>
    ${item.revit ? `<div class="design-source-summary">
      <span>REVIT MODEL SOURCE</span>
      <strong>${Number(item.revit.instanceCount || 0).toLocaleString()} visible instance${Number(item.revit.instanceCount || 0) === 1 ? '' : 's'}</strong>
      <p>${escapeHtml([item.revit.category, item.revit.family, item.revit.type].filter(Boolean).join(' · '))}</p>
      ${(item.revit.levels || []).length ? `<small>${escapeHtml(item.revit.levels.join(' · '))}</small>` : ''}
      <button class="button ghost" id="design-show-bim" type="button">Show representative in BIM</button>
    </div>` : ''}
    <form id="design-edit-form" class="edit-form">
      <label>Status<select id="design-status"><option>Not Selected</option><option>Research</option><option>Proposed</option><option>Approved</option><option>On Hold</option></select></label>
      <label>Description<textarea id="design-description" rows="4" placeholder="Selection, intent, dimensions…">${escapeHtml(item.description || '')}</textarea></label>
      <label>Source / product link<input id="design-source" type="url" value="${escapeHtml(item.source || '')}" placeholder="https://…" /></label>
      <label>Images<input id="design-image-upload" type="file" accept="image/*" /></label>
      <div class="image-strip">${(item.images || []).map((image) => `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name || '')}" />`).join('')}</div>
      <div><span class="eyebrow">REVIT MATERIAL CANDIDATES</span><div>${(item.candidateMaterials || []).map((name) => `<b class="material-chip">${escapeHtml(name)}</b>`).join('') || '<span class="muted">None inferred.</span>'}</div></div>
      <button class="button" type="submit">Save Design Book position</button>
      <button class="button ghost" id="design-render" type="button">Render this position</button>
      <button class="button ghost" id="design-issue" type="button">Add design issue</button>
      <button class="button ghost" id="design-chat" type="button">Send context to Project Chat</button>
    </form>`;
  $('#design-status').value = item.status || 'Not Selected';
  $('#design-edit-form').addEventListener('submit', saveDesign);
  $('#design-image-upload').addEventListener('change', uploadDesignImage);
  $('#design-show-bim')?.addEventListener('click', () => {
    const element = (item.revit?.elementIds || []).map(String).map((id) => state.viewerData?.elements?.find((row) => String(row.id) === id)).find(Boolean);
    if (!element) return toast('This type is not visible in the current synced 3D view.', true);
    showView('bim');
    selectElement(element, true);
  });
  $('#design-render').addEventListener('click', openRenderDialog);
  $('#design-issue').addEventListener('click', () => openIssue({ kind: 'design', item }));
  $('#design-chat').addEventListener('click', () => openProjectChat(state.selectedContext));
}

async function saveDesign(event) {
  event.preventDefault();
  const item = state.selectedDesign;
  const patch = {
    status: $('#design-status').value,
    description: $('#design-description').value.trim(),
    source: $('#design-source').value.trim(),
    images: item.images || [],
    sourceRevision: state.cloudState?.revision || state.loadingRevision || null,
    sourceSnapshot: { id: item.id, label: item.label, chapterTitle: item.chapterTitle, revit: item.revit || null }
  };
  try {
    setSync('Saving Design Book…', 'busy');
    const saved = await Store.saveDesignEdit(state.projectId, item.id, patch);
    state.designEdits.set(item.id, { ...(state.designEdits.get(item.id) || {}), ...saved });
    state.selectedDesign = { ...item, ...saved };
    state.selectedContext = contextFor('Design', state.selectedDesign);
    try { await Store.appendHistory(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'design', operation: 'edit', label: `Design Book · ${item.chapterTitle} / ${item.label}`, affectedElementIds: item.revit?.elementIds || [], affectedUniqueIds: [], affectedLevels: item.revit?.levels || [], before: { status: item.status || 'Not Selected', description: item.description || '', source: item.source || '', images: item.images || [] }, after: { status: saved.status, description: saved.description, source: saved.source, images: saved.images || [] }, relatedId: item.id }); } catch (historyError) { console.warn('[REVEX] Design history', historyError); }
  window.dispatchEvent(new CustomEvent('revex:design-selection', { detail: { item: state.selectedDesign } }));
    renderDesign(); renderDesignInspector();
    setSync(Store.isCloud() ? 'Design Book saved' : 'Saved on this device', Store.isCloud() ? 'good' : 'quiet');
    toast('Design Book position saved.');
  } catch (error) { setSync('Save failed', 'bad'); toast(error.message, true); }
}

async function uploadDesignImage(event) {
  const file = event.target.files?.[0];
  if (!file || !state.selectedDesign) return;
  try {
    setSync('Uploading design image…', 'busy');
    const beforeImages = state.selectedDesign.images || [];
    const images = await Store.uploadDesignImage(state.projectId, state.selectedDesign.id, file, beforeImages);
    try { await Store.appendHistory(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'design', operation: 'image-upload', label: `Design Book image · ${state.selectedDesign.chapterTitle} / ${state.selectedDesign.label}`, affectedElementIds: state.selectedDesign.revit?.elementIds || [], affectedLevels: state.selectedDesign.revit?.levels || [], before: { images: beforeImages }, after: { images }, relatedId: state.selectedDesign.id }); } catch (historyError) { console.warn('[REVEX] Design image history', historyError); }
    const edit = { ...(state.designEdits.get(state.selectedDesign.id) || {}), images };
    state.designEdits.set(state.selectedDesign.id, edit);
    state.selectedDesign = { ...state.selectedDesign, images };
    renderDesign(); renderDesignInspector(); setSync('Design image saved', 'good');
  } catch (error) { setSync('Image upload failed', 'bad'); toast(error.message, true); }
}

function renderSpec() {
  const spec = state.cloudState?.spec;
  const linked = state.preferredSpecId || spec?.projectId;
  $('#spec-status').textContent = linked
    ? `${spec?.status === 'published' ? 'Revit source published' : 'Connected'} · ${spec?.rev ? `revision ${spec.rev}` : 'ready'} · authored fields remain stable across Revit syncs.`
    : 'Preparing the internal Spec Book for this project…';
  const frame = $('#spec-frame');
  const wrap = $('.spec-frame-wrap');
  if (!linked) {
    frame.removeAttribute('src');
    wrap.classList.remove('ready');
    return;
  }
  const query = {
    embedded: '1',
    specProjectId: linked,
    specUrl: params.get('specUrl'),
    specTitle: params.get('specTitle'),
    specNote: params.get('specNote'),
    section: params.get('section'),
    item: params.get('item')
  };
  const next = appUrl('specifications', query);
  if (frame.src !== next) {
    wrap.classList.remove('ready');
    frame.src = next;
  }
}

function renderContextLabel() {
  if (state.selectedDesign) return `${state.selectedDesign.chapterTitle} · ${state.selectedDesign.label}`;
  if (state.selectedElement) return `${state.selectedElement.category || 'Revit element'} · ${state.selectedElement.name || state.selectedElement.type || state.selectedElement.id}`;
  return state.viewerData?.source?.viewName || 'Current BIM viewport';
}

function renderPrompt() {
  const project = state.project?.name || state.project?.title || 'the project';
  const context = renderContextLabel();
  const materials = state.selectedDesign?.candidateMaterials || state.selectedElement?.materials?.map((row) => row.name) || [];
  return [
    `Create a realistic architectural visualization for ${project}.`,
    `Source context: ${context}.`,
    'Preserve the Revit camera, geometry, openings, proportions and modeled objects exactly.',
    materials.length ? `Use the Revit material intent: ${materials.join(', ')}.` : 'Use physically plausible project materials without changing the design.',
    'Natural scale, buildable details, realistic light and no invented structural elements.'
  ].join('\n');
}

function captureViewerPreview() {
  try {
    const av=activeBimViewer();
    if(!av?.renderer?.domElement)return '';
    av.renderer.render(av.scene,av.camera);
    return av.renderer.domElement.toDataURL('image/png');
  } catch (_) { return ''; }
}

function setRenderStatus(message, tone = '') {
  const node = $('#render-status');
  node.textContent = message;
  node.className = `render-status${tone ? ` ${tone}` : ''}`;
}

function renderRenderHistory() {
  $('#render-history').innerHTML = state.renderJobs.map((job) => `
    <div class="render-job" data-render-job="${escapeHtml(job.id)}">
      <strong>${escapeHtml(job.contextLabel || job.chapterTitle || 'Project view')}</strong>
      <span>${escapeHtml(job.status || 'prepared')}</span>
      <small>${escapeHtml(job.prompt || '')}</small>
    </div>`).join('') || '<div class="file-empty">No renders prepared for this project yet.</div>';
}

function populateRenderChapters() {
  const select = $('#render-chapter');
  select.innerHTML = chapters().map((chapter) => `<option value="${escapeHtml(chapter.id)}">${escapeHtml(chapter.title)}</option>`).join('');
  select.value = state.activeChapter || chapters()[0]?.id || '';
}

function openRenderDialog() {
  if (!state.projectId) return openProjectDialog();
  renderReturnFocus = document.activeElement;
  $('#render-context').textContent = renderContextLabel();
  $('#render-prompt').value = renderPrompt();
  populateRenderChapters();
  const preview = captureViewerPreview();
  $('#render-source').innerHTML = `${preview ? `<img src="${preview}" alt="Current BIM render source" />` : ''}<span>${escapeHtml(renderContextLabel())}</span>`;
  renderRenderHistory();
  $('#render-dialog').hidden = false;
  setRenderStatus('The source view, project and Design Book context stay attached to this render.');
  // Keep the complete context stack visible when the bottom-sheet opens on mobile.
  // Desktop still gets the prompt-first keyboard workflow.
  if (window.matchMedia('(min-width: 861px)').matches) setTimeout(() => $('#render-prompt').focus(), 0);
}

function closeRenderDialog() {
  $('#render-dialog').hidden = true;
  pendingNativeRender = null;
  const target = renderReturnFocus;
  renderReturnFocus = null;
  target?.focus?.();
}

function postNativeRender(payload) {
  try {
    if (!window.chrome?.webview?.postMessage) return false;
    window.chrome.webview.postMessage(payload);
    return true;
  } catch (_) { return false; }
}

async function prepareRender(event) {
  event.preventDefault();
  if (!state.projectId) return openProjectDialog();
  const prompt = $('#render-prompt').value.trim();
  if (!prompt) return setRenderStatus('Add a render instruction first.', 'bad');
  const chapter = chapters().find((row) => row.id === $('#render-chapter').value) || null;
  const settings = {
    environment: $('#render-environment').value,
    staging: $('#render-staging').value,
    people: $('#render-people').value,
    autoMaterials: $('#render-materials').checked,
    preserveGeometry: true,
    realisticOnly: true
  };
  setRenderStatus('Preparing the BIM source and AI workspace…', 'busy');
  try {
    const job = await Store.createRenderJob(state.projectId, {
      contextKind: state.selectedDesign ? 'design' : state.selectedElement ? 'bim' : 'view',
      contextLabel: renderContextLabel(),
      elementId: state.selectedElement?.id || null,
      designItemId: state.selectedDesign?.id || null,
      chapterId: chapter?.id || null,
      chapterTitle: chapter?.title || null,
      revision: state.cloudState?.revision || null,
      prompt,
      settings,
      status: 'bridging'
    });
    try { await Store.appendHistory(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'render', operation: 'prepare', label: `Render prepared · ${renderContextLabel()}`, affectedElementIds: state.selectedElement?.id ? [state.selectedElement.id] : [], affectedLevels: state.selectedElement?.level ? [state.selectedElement.level] : [], before: null, after: { renderJobId: job.id, prompt, settings }, relatedId: job.id }); } catch (historyError) { console.warn('[REVEX] Render history', historyError); }
    state.activeRenderJob = job;
    state.renderJobs = [job, ...state.renderJobs.filter((row) => row.id !== job.id)].slice(0, 40);
    renderRenderHistory();
    pendingNativeRender = {
      type: 'liber:revex-render-request', action: 'capture-current', projectId: state.projectId,
      specProjectId: state.preferredSpecId || null, renderJobId: job.id, prompt, settings,
      context: { label: renderContextLabel(), elementId: state.selectedElement?.id || null, designItemId: state.selectedDesign?.id || null, chapterId: chapter?.id || null }
    };
    const frame = $('#render-frame');
    const workspace = $('.render-workspace');
    workspace.classList.remove('ready');
    frame.src = 'https://rendair.ai/tools/3d-model-to-render';
    if (frame.dataset.loaded === '1' && postNativeRender(pendingNativeRender)) {
      pendingNativeRender = null;
      setRenderStatus('Revit is capturing the active 3D view and attaching it to the embedded AI workspace…', 'busy');
    } else if (!window.chrome?.webview?.postMessage) {
      try { await navigator.clipboard?.writeText(prompt); } catch (_) {}
      await Store.updateRenderJob(state.projectId, job.id, { status: 'workspace-ready' });
      job.status = 'workspace-ready';
      renderRenderHistory();
      setRenderStatus('AI workspace ready. The prompt is copied; attach the prepared source preview in the embedded workspace, then save the result below.', 'good');
    }
  } catch (error) {
    setRenderStatus(error.message || 'The render could not be prepared.', 'bad');
  }
}

async function saveRenderResult(event) {
  const file = event.target.files?.[0];
  const chapter = chapters().find((row) => row.id === $('#render-chapter').value);
  if (!file || !chapter) return setRenderStatus('Choose a Design Book chapter before saving the result.', 'bad');
  try {
    setRenderStatus('Saving the generated result into the Design Book…', 'busy');
    const formed = mergedChapter(chapter);
    const images = await Store.uploadChapterImage(state.projectId, chapter.id, 'renders', file, formed.renders || []);
    state.chapterEdits.set(chapter.id, { ...(state.chapterEdits.get(chapter.id) || {}), renders: images });
    state.activeChapter = chapter.id;
    if (state.activeRenderJob) {
      const result = images[images.length - 1];
      await Store.updateRenderJob(state.projectId, state.activeRenderJob.id, { status: 'saved', resultUrl: result?.url || null, resultName: file.name, chapterId: chapter.id });
      state.activeRenderJob = { ...state.activeRenderJob, status: 'saved', resultUrl: result?.url || null, resultName: file.name };
      state.renderJobs = state.renderJobs.map((row) => row.id === state.activeRenderJob.id ? state.activeRenderJob : row);
      try { await Store.appendHistory(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'render', operation: 'save-result', label: `Render saved · ${chapter.title}`, before: null, after: { renderJobId: state.activeRenderJob.id, resultUrl: result?.url || null, resultName: file.name, chapterId: chapter.id }, relatedId: state.activeRenderJob.id }); } catch (historyError) { console.warn('[REVEX] Render result history', historyError); }
    }
    renderDesign(); renderRenderHistory();
    setRenderStatus(`Saved to ${chapter.title} · Renderings.`, 'good');
    toast('Render saved into the Design Book.');
  } catch (error) { setRenderStatus(error.message || 'Could not save the render.', 'bad'); }
  finally { event.target.value = ''; }
}

async function handleNativeRenderStatus(data) {
  if (!data || data.type !== 'liber:revex-render-status') return;
  setRenderStatus(data.message || (data.ok ? 'Render bridge ready.' : 'Render bridge failed.'), data.ok ? 'good' : 'bad');
  const jobId = data.renderJobId || state.activeRenderJob?.id;
  if (!jobId) return;
  const status = data.ok ? 'ready-in-ai' : 'bridge-error';
  try { await Store.updateRenderJob(state.projectId, jobId, { status, bridgeMessage: data.message || '' }); } catch (_) {}
  state.renderJobs = state.renderJobs.map((row) => row.id === jobId ? { ...row, status } : row);
  if (state.activeRenderJob?.id === jobId) state.activeRenderJob = { ...state.activeRenderJob, status };
  renderRenderHistory();
}

function docsMatches(text) {
  const q = String($('#docs-search')?.value || '').trim().toLowerCase();
  return !q || String(text || '').toLowerCase().includes(q);
}

function docsRecordLabel(file) {
  if (file.revexDocKind === 'printing-set') return `${file.printingSetName || file.name} ${file.revision || ''}`;
  return `${file.name || 'file'} ${file.folderPath || ''}`;
}

async function selectDocument(file, page = null, sheet = null) {
  state.docSelection = { file, page: page || null, sheet: sheet || null };
  const frame = $('#docs-frame'), empty = $('#docs-empty');
  $('#docs-preview-title').textContent = sheet ? `${sheet.sheetNumber || `Page ${page}`} · ${sheet.sheetName || ''}` : (file.printingSetName || file.name || 'Document');
  $('#docs-preview-meta').textContent = [file.revision ? `REVEX ${file.revision}` : null, sheet?.currentRevision ? `Sheet revision ${sheet.currentRevision}` : null, page ? `page ${page}` : null, file.source === 'manual' ? 'manual file' : null].filter(Boolean).join(' · ') || 'Project document';
  $('#docs-copy-ref').disabled = false; $('#docs-open-external').disabled = false;
  try {
    const base = file.localUrl || await Store.fileUrl(file.storagePath);
    if (!base) throw new Error('Document URL is unavailable.');
    state.docSelection.url = base;
    const url = page ? `${base}#page=${page}` : base;
    frame.src = url; frame.hidden = false; empty.hidden = true;
  } catch (error) {
    frame.removeAttribute('src'); frame.hidden = true; empty.hidden = false; empty.textContent = error.message || 'Could not open document.';
  }
  renderLibrary();
}

function renderLibrary() {
  const host = $('#docs-tree');
  if (!host) return;
  const rows = [...state.library];
  const printing = rows.filter((f) => f.revexDocKind === 'printing-set');
  const manualIn = rows.filter((f) => f.revexDocKind !== 'printing-set' && String(f.folderPath || '').startsWith('record_in'));
  const manualOut = rows.filter((f) => f.revexDocKind !== 'printing-set' && String(f.folderPath || '').startsWith('record_out'));
  const bySet = new Map();
  printing.forEach((file) => {
    const key = file.printingSetId || file.printingSetName || file.name;
    if (!bySet.has(key)) bySet.set(key, []);
    bySet.get(key).push(file);
  });

  const manualGroup = (title, files, lane) => {
    const visible = files.filter((file) => docsMatches(docsRecordLabel(file)));
    if (!visible.length) return '';
    return `<section class="docs-group"><h3>${title}<small>${visible.length}</small></h3>${visible.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).map((file)=>`<button type="button" class="docs-node ${state.docSelection?.file?.id===file.id&&!state.docSelection?.page?'active':''}" data-doc-id="${escapeHtml(file.id)}"><span>${escapeHtml(file.name||'file')}</span><small>${escapeHtml(formatDate(file.createdAt))}</small></button>`).join('')}</section>`;
  };

  const printHtml = [...bySet.entries()].map(([key, revisions]) => {
    revisions.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    const latest = revisions[0];
    const allText = `${latest.printingSetName||''} ${revisions.flatMap(r => (r.sheetIndex||[]).map(p => `${p.sheetNumber} ${p.sheetName}`)).join(' ')}`;
    if (!docsMatches(allText)) return '';
    return `<section class="docs-group printing-set"><h3>${escapeHtml(latest.printingSetName || 'Printing Set')}<small>${revisions.length} revision${revisions.length===1?'':'s'}</small></h3>${revisions.map((file,ri)=>{
      const selected = state.docSelection?.file?.id===file.id;
      return `<details ${ri===0||selected?'open':''}><summary><span>${ri===0?'Current':'Revision'} · ${escapeHtml(file.revision||formatDate(file.createdAt))}</span><small>${(file.sheetIndex||[]).length} sheets</small></summary><button type="button" class="docs-node whole ${selected&&!state.docSelection?.page?'active':''}" data-doc-id="${escapeHtml(file.id)}"><span>Full document</span><small>PDF</small></button>${(file.sheetIndex||[]).map((sheet)=>`<button type="button" class="docs-node sheet ${selected&&Number(state.docSelection?.page)===Number(sheet.page)?'active':''}" data-doc-id="${escapeHtml(file.id)}" data-page="${Number(sheet.page)||1}"><b>${escapeHtml(sheet.sheetNumber||String(sheet.page))}</b><span>${escapeHtml(sheet.sheetName||'Sheet')}</span><small>p.${Number(sheet.page)||1}</small></button>`).join('')}</details>`;
    }).join('')}</section>`;
  }).join('');

  host.innerHTML = printHtml + manualGroup('Record In', manualIn, 'in') + manualGroup('Record Out', manualOut, 'out') || '<div class="file-empty">No matching project documents.</div>';
  $$('.docs-node', host).forEach((button) => button.addEventListener('click', () => {
    const file = rows.find((row) => row.id === button.dataset.docId); if (!file) return;
    const page = button.dataset.page ? Number(button.dataset.page) : null;
    const sheet = page ? (file.sheetIndex || []).find((row) => Number(row.page) === page) : null;
    selectDocument(file, page, sheet);
  }));
}

async function uploadDocsFiles(files, lane) {
  if (!files?.length) return;
  if (!Store.isCloud()) return toast('Sign in to upload project documents.', true);
  try {
    setSync(`Uploading ${files.length} project document${files.length===1?'':'s'}…`, 'busy');
    for (const file of [...files]) {
      const ext = String(file.name || '').split('.').pop().toLowerCase();
      const folder = `${lane === 'out' ? 'record_out' : 'record_in'}/${/^(png|jpg|jpeg|gif|webp)$/i.test(ext)?'images':'docs'}`;
      const record = await Store.uploadLibraryFile(state.projectId, file, folder, { manualInRevex: true });
      state.library.unshift(record);
      try { await Store.appendHistory(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'document', operation: 'upload', label: `Document uploaded · ${file.name}`, before: null, after: { libraryId: record.id, name: record.name, folderPath: record.folderPath, size: record.size }, relatedId: record.id }); } catch (historyError) { console.warn('[REVEX] Docs history', historyError); }
    }
    renderLibrary(); setSync('Docs updated', 'good'); toast('Project document uploaded.');
  } catch (error) { setSync('Docs upload failed', 'bad'); toast(error.message || 'Document upload failed.', true); }
}

function copyDocumentReference() {
  const sel = state.docSelection; if (!sel?.file) return;
  const parts = ['REVEX Docs', state.project?.name || state.projectId, sel.file.printingSetName || sel.file.name];
  if (sel.file.revision) parts.push(sel.file.revision);
  if (sel.sheet) parts.push(`${sel.sheet.sheetNumber || `Page ${sel.page}`} — ${sel.sheet.sheetName || ''}`.trim());
  else if (sel.page) parts.push(`Page ${sel.page}`);
  const text = parts.filter(Boolean).join(' · ');
  navigator.clipboard?.writeText(text).then(()=>toast('Document reference copied.')).catch(()=>toast(text));
}

function openDocumentExternal() {
  const sel = state.docSelection; if (!sel?.url) return;
  window.open(sel.page ? `${sel.url}#page=${sel.page}` : sel.url, '_blank', 'noopener');
}

function renderChatContext() {
  const context = state.selectedContext || 'Project-wide conversation';
  $('#chat-context').textContent = context;
  try { $('#chat-frame')?.contentWindow?.postMessage({ type: 'liber:revex-chat-context', context: state.selectedContext || '', projectId: state.projectId }, location.origin); } catch (_) {}
}


function renderAll() {
  renderModelTree(); renderPins(); renderDesign(); renderDesignInspector(); renderLibrary(); renderChatContext();
}

let revisionHydrationToken=0;
function settledValue(result,fallback){ return result?.status==='fulfilled' ? result.value : fallback; }
async function hydrateRevisionOverlays(cloudState,localPackage,revision){
  const token=++revisionHydrationToken;
  const results=await Promise.allSettled([
    storeCall('listDesignEdits',[state.projectId],[]),storeCall('listChapterEdits',[state.projectId],[]),storeCall('listIssues',[state.projectId],[]),storeCall('listLibrary',[state.projectId],[]),
    storeCall('listHistory',[state.projectId],[]),storeCall('listBimOverlays',[state.projectId],[]),storeCall('listDerivedPlans',[state.projectId],[])
  ]);
  if(token!==revisionHydrationToken||state.loadingRevision!==revision)return;
  const [editsR,chapterR,issuesR,libraryR,historyR,overlayR,plansR]=results;
  for(const [label,result] of [['design edits',editsR],['chapter edits',chapterR],['issues',issuesR],['library',libraryR],['history',historyR],['BIM overlays',overlayR],['derived plans',plansR]]){
    if(result.status==='rejected')console.warn(`[REVEX] ${label} hydration`,result.reason);
  }
  const edits=settledValue(editsR,[]),chapterEdits=settledValue(chapterR,[]),issues=settledValue(issuesR,[]),library=settledValue(libraryR,[]),historyEvents=settledValue(historyR,[]),bimOverlays=settledValue(overlayR,[]),derivedPlans=settledValue(plansR,[]);
  state.designEdits=new Map(edits.map(r=>[r.id,r]));state.chapterEdits=new Map(chapterEdits.map(r=>[r.id,r]));state.issues=issues;state.library=library;state.historyEvents=historyEvents||[];state.bimOverlays=new Map((bimOverlays||[]).map(r=>[String(r.uniqueId||r.elementId||r.id),r]));state.derivedPlans=derivedPlans||[];
  syncHiddenMode();renderModelTree();renderPins();renderDesign();renderDesignInspector();renderLibrary();activeBimViewer()?.setOverlays?.(bimOverlays||[]);activeBimViewer()?.requestRender?.();window.dispatchEvent(new CustomEvent('revex:history-data', { detail: { historyEvents: state.historyEvents, bimOverlays: bimOverlays||[], derivedPlans: state.derivedPlans } }));
  if(!$('#view-spec')?.hidden)renderSpec();
}

async function loadCloudState(cloudState,localPackage=null){
  state.cloudState=cloudState||null;
  if(!cloudState&&!localPackage){revisionHydrationToken++;state.viewerData=null;state.designData=null;state.designEdits=new Map();state.chapterEdits=new Map();state.issues=[];state.library=[];state.historyEvents=[];state.bimOverlays=new Map();state.derivedPlans=[];renderAll();setSync('No Revit sync yet','quiet');return;}
  const revision=localPackage?.revision||cloudState?.revision||'unknown';
  if(state.loadingRevision===revision&&!localPackage&&state.viewerData&&state.designData)return;
  assertRevisionAssets(cloudState,revision);
  state.loadingRevision=revision;setSync('Loading project revision…','busy');
  activeBimViewer()?.beginRevision?.(revision);
  const viewerPromise=localPackage?.viewer?Promise.resolve(localPackage.viewer):(cloudState?.viewerUrl?Store.fetchJson(cloudState.viewerUrl):Promise.resolve(null));
  const designPromise=localPackage?.design?Promise.resolve(localPackage.design):(cloudState?.designUrl?Store.fetchJson(cloudState.designUrl):Promise.resolve(null));
  const [viewerResult,designResult]=await Promise.allSettled([viewerPromise,designPromise]);
  if(state.loadingRevision!==revision)return;
  const viewerData=settledValue(viewerResult,null);
  const fetchedDesign=settledValue(designResult,null);
  if(viewerResult.status==='rejected')console.error('[REVEX] BIM index load',viewerResult.reason);
  if(designResult.status==='rejected')console.warn('[REVEX] Design Book source load',designResult.reason);
  state.viewerData=viewerData;
  state.designData=normalizeDesignSource(fetchedDesign,viewerData);
  renderDesign();renderDesignInspector();
  if(viewerData){
    renderModelTree();renderPins();
    window.dispatchEvent(new CustomEvent('revex:source-revision-loaded', { detail: { revision, cloudState, localPackage, viewerData } }));
  }
  const sourceLabel=localPackage?.cloud===false?'Local preview':'Synced';
  if(!viewerData&&!state.designData){setSync('Revision data unavailable','bad');toast('BIM and Design Book source files could not load.',true);}
  else if(!fetchedDesign&&state.designData){setSync(`${sourceLabel} · Design Book rebuilt from BIM index`,'quiet');}
  else setSync(`${sourceLabel} ${formatDate(localPackage?.syncedAt||cloudState?.syncedAt)}`,localPackage?.cloud===false?'quiet':'good');
  // User-authored overlays are independent of source files. Start immediately; never wait for browser idle.
  setTimeout(()=>hydrateRevisionOverlays(cloudState,localPackage,revision),0);
}

async function activateProject(projectId){
  state.unsubscribe?.();state.unsubscribe=null;state.projectId=projectId||'';state.showHiddenOnly=false;
  state.project=state.projects.find(r=>r.id===projectId)||(projectId?await Store.getProject(projectId):null);
  state.preferredSpecId=((params.get('projectId')===projectId&&params.get('specProjectId'))||state.project?.revexSpecProjectId||'');
  renderProjects();persistProjectRoute();notifyNativeProject();
  if(!projectId){state.preferredSpecId='';showView(params.get('view')||'bim');return;}
  showView(params.get('view')||'bim');setSync('Loading project…','busy');
  try{
    const cloudState=await Store.getState(projectId);await loadCloudState(cloudState);notifyNativeProject();
    state.unsubscribe=Store.subscribeState(projectId,next=>{if(next?.revision&&next.revision!==state.cloudState?.revision)loadCloudState(next);else if(next){state.cloudState=next;if(!$('#view-spec')?.hidden)renderSpec();}});
    Promise.allSettled([storeCall('ensureSpecProject',[projectId,state.preferredSpecId||state.project?.revexSpecProjectId,state.project],state.preferredSpecId||''),storeCall('listRenderJobs',[projectId],[])]).then(([specResult,renderResult])=>{
      if(state.projectId!==projectId)return;
      if(specResult.status==='fulfilled')state.preferredSpecId=specResult.value||state.preferredSpecId||'';else console.warn('[REVEX] Spec Book projection pending',specResult.reason);
      state.renderJobs=renderResult.status==='fulfilled'?(renderResult.value||[]):[];
      if(state.project&&state.preferredSpecId)state.project.revexSpecProjectId=state.preferredSpecId;
      persistProjectRoute();renderProjects();renderRenderHistory();notifyNativeProject();if(!$('#view-spec')?.hidden)renderSpec();
    });
    if(params.get('render')==='1')openRenderDialog();
  }catch(error){setSync('Project unavailable','bad');toast(error.message,true);}
}

async function handleSyncFiles(files) {
  if (!files?.length) return;
  try {
    setSync('Validating Revit package…', 'busy');
    const result = await Store.syncPackage(files, state.projectId, state.preferredSpecId);
    state.projectId = result.projectId;
    if (!state.project) state.project = state.projects.find((row) => row.id === result.projectId) || null;
    $('#project-select').value = state.projectId;
    await loadCloudState(result, result);
    showView('bim');
    toast(result.cloud ? 'Revit revision published to the live Companion.' : 'Local preview loaded. Sign in to publish it across devices.');
    try { window.chrome?.webview?.postMessage({ type: 'liber:revex-sync-result', ok: true, projectId: result.projectId, revision: result.revision, cloud: result.cloud }); } catch (_) {}
  } catch (error) {
    setSync('Sync failed', 'bad'); toast(error.message || 'REVEX sync failed.', true);
    try { window.chrome?.webview?.postMessage({ type: 'liber:revex-sync-result', ok: false, error: error.message }); } catch (_) {}
  } finally { $('#revex-sync-upload').value = ''; }
}

let issueAnchor = null;
let issueReturnFocus = null;
function openIssue(anchor) {
  issueAnchor = anchor;
  issueReturnFocus = document.activeElement;
  $('#issue-title').value = anchor.kind === 'bim' ? `${anchor.element.category || 'Element'} ${anchor.element.id}` : anchor.item.label;
  $('#issue-body').value = '';
  $('#issue-status').value = 'open';
  $('#issue-drawer').hidden = false;
  $('#issue-body').focus();
}
function closeIssue() {
  $('#issue-drawer').hidden = true;
  issueAnchor = null;
  const target = issueReturnFocus;
  issueReturnFocus = null;
  target?.focus?.();
}

$('#issue-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!issueAnchor || !state.projectId) return;
  const issue = {
    title: $('#issue-title').value.trim(), body: $('#issue-body').value.trim(), status: $('#issue-status').value,
    anchorKind: issueAnchor.kind,
    anchorElementId: issueAnchor.element?.id || null,
    anchorUniqueId: issueAnchor.element?.uniqueId || null,
    anchorDesignItemId: issueAnchor.item?.id || null,
    anchorLabel: issueAnchor.element?.name || issueAnchor.item?.label || null,
    revision: state.cloudState?.revision || null
  };
  try {
    setSync('Saving issue…', 'busy');
    const saved = await Store.addIssue(state.projectId, issue);
    state.issues.unshift(saved);
    try { await Store.appendHistory(state.projectId, { sourceRevision: state.cloudState?.revision || null, kind: 'issue', operation: 'create', label: `Issue · ${saved.title}`, affectedElementIds: saved.anchorElementId ? [saved.anchorElementId] : [], affectedUniqueIds: saved.anchorUniqueId ? [saved.anchorUniqueId] : [], affectedLevels: state.selectedElement?.level ? [state.selectedElement.level] : [], before: null, after: saved, relatedId: saved.id }); } catch (historyError) { console.warn('[REVEX] Issue history', historyError); }
    closeIssue(); renderPins();
    if (state.selectedElement) selectElement(state.selectedElement, false);
    setSync('Issue saved', Store.isCloud() ? 'good' : 'quiet'); toast('Issue saved outside the RVT.');
  } catch (error) { setSync('Issue save failed', 'bad'); toast(error.message, true); }
});

$$('.main-nav [data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('#rail-toggle').addEventListener('click', toggleWorkspaceRail);
$('#rail-scrim').addEventListener('click', closeWorkspaceRail);
window.addEventListener('revex:viewer-mode', (event) => {
  state.viewerMode = event.detail?.mode || '';
  renderModelTree();
});
window.addEventListener('revex:bim-overlays-changed', (event) => {
  const rows = event.detail?.overlays || [];
  state.bimOverlays = event.detail?.map || new Map(rows.map((row) => [String(row.uniqueId || row.elementId || row.id), row]));
  syncHiddenMode();
  renderModelTree();
});

$('#project-select').addEventListener('change', () => activateProject($('#project-select').value));
$('#new-project-button').addEventListener('click', openProjectDialog);
$('#empty-create-button').addEventListener('click', openProjectDialog);
$('#empty-connect-button').addEventListener('click', connectExistingProject);
$('#energy-create-project')?.addEventListener('click', openProjectDialog);
$('#energy-connect-project')?.addEventListener('click', connectExistingProject);
$('#project-form').addEventListener('submit', createProject);
$('#project-close').addEventListener('click', closeProjectDialog);
$('#project-cancel').addEventListener('click', closeProjectDialog);
$('#project-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeProjectDialog(); });
$('#sync-button').addEventListener('click', () => $('#revex-sync-upload').click());
$('#empty-sync-button').addEventListener('click', () => $('#revex-sync-upload').click());
$('#revex-sync-upload').addEventListener('change', (event) => handleSyncFiles(event.target.files));
$('#element-search').addEventListener('input', renderModelTree);
// BIM viewport controls are owned exclusively by viewer-r26.js. Keeping a second
// handler here caused Walk/Section to toggle twice and retained obsolete three-axis clipping UI.
$('#issue-close').addEventListener('click', closeIssue);
$('#issue-cancel').addEventListener('click', closeIssue);
$('#issue-drawer').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeIssue(); });
$('#render-button').addEventListener('click', openRenderDialog);
$('#render-form').addEventListener('submit', prepareRender);
$('#render-close').addEventListener('click', closeRenderDialog);
$('#render-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeRenderDialog(); });
$('#render-result-upload').addEventListener('change', saveRenderResult);
$('#render-frame').addEventListener('load', () => {
  $('#render-frame').dataset.loaded = '1';
  $('.render-workspace').classList.add('ready');
  if (pendingNativeRender && postNativeRender(pendingNativeRender)) {
    pendingNativeRender = null;
    setRenderStatus('Revit is capturing the active 3D view and attaching it to the embedded AI workspace…', 'busy');
  }
});
$('#spec-frame').addEventListener('load', () => $('.spec-frame-wrap').classList.add('ready'));
$('#chat-frame')?.addEventListener('load', () => { $('#chat-placeholder').hidden = true; renderChatContext(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('#render-dialog').hidden) closeRenderDialog();
  else if (!$('#project-dialog').hidden) closeProjectDialog();
  else if (!$('#issue-drawer').hidden) closeIssue();
  else closeWorkspaceRail();
});
window.addEventListener('resize', () => { if (innerWidth > 860) closeWorkspaceRail(); });
$('#docs-search')?.addEventListener('input', renderLibrary);
$('#docs-upload-in')?.addEventListener('change', (event) => { uploadDocsFiles(event.target.files, 'in'); event.target.value=''; });
$('#docs-upload-out')?.addEventListener('change', (event) => { uploadDocsFiles(event.target.files, 'out'); event.target.value=''; });
$('#docs-copy-ref')?.addEventListener('click', copyDocumentReference);
$('#docs-open-external')?.addEventListener('click', openDocumentExternal);
$('#open-tracker').addEventListener('click', () => openInLiberShell('project-tracker', 'Project Tracker', appUrl('project-tracker', { projectId: state.projectId })));

window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'liber:revex-render-status') return handleNativeRenderStatus(data);
  if (data.type === 'liber:app-params') {
    if (data.params?.specProjectId) state.preferredSpecId = data.params.specProjectId;
    if (data.params?.projectId && data.params.projectId !== state.projectId) activateProject(data.params.projectId);
    if (data.params?.view) showView(data.params.view);
    if (data.params?.render === '1') openRenderDialog();
  }
});
try { window.chrome?.webview?.addEventListener('message', (event) => handleNativeRenderStatus(event.data || {})); } catch (_) {}

async function init() {
  setSync('Connecting to LIBER…', 'busy');
  await Store.init();
  state.projects = await Store.listProjects();
  renderProjects();
  if (!Store.isCloud()) setSync('Sign in for live project sync', 'quiet');
  if (state.projectId) await activateProject(state.projectId);
  else {
    showView(params.get('view') || 'bim');
    if (state.projects.length === 1) await activateProject(state.projects[0].id);
  }
}

init().catch((error) => { console.error(error); setSync('REVEX could not start', 'bad'); toast(error.message, true); });
