import { isBookDivision, bookDivisionItems, bookFilename, printBookDocument } from './book-structure.js?v=20260914r193-books1';
import { loadSpreadsheetEngine, createBookWorkbook } from './book-spreadsheet.js?v=20260914r193-books1';
import './product-sourcing.js?v=20260914r193-books1';

const Store = window.RevexStore;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const params = new URLSearchParams(location.search);
const currentParams = () => new URLSearchParams(location.search);

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
  liveUnsubscribers: [],
  activationToken: 0,
  loadingRevision: '',
  loadingProjectId: '',
  docSelection: null,
  chatConnId: '',
  chatLoaded: false,
  historyEvents: [],
  bimOverlays: new Map(),
  bimAppearances: new Map(),
  derivedPlans: [],
  showHiddenOnly: false
};
window.__revexState = state;

let projectReturnFocus = null;
let renderReturnFocus = null;
let pendingNativeRender = null;
let appInitialized = false;
let pendingAuthReconcile = false;
let authReconcileQueued = false;
let authReconcileGeneration = 0;
let reconciledAuthUid = null;
let hardBoundaryNavigating = false;
let projectEntryPending = false;
let appStartupFailed = false;
let startupRetryNavigating = false;

function captureProjectContext() {
  return { projectId: String(state.projectId || ''), activationToken: state.activationToken, uid: Store.user?.uid || null };
}

function isCurrentProjectContext(context) {
  return Boolean(context?.projectId) && state.projectId === context.projectId &&
    state.activationToken === context.activationToken && (Store.user?.uid || null) === context.uid;
}

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
  const projectId = state.projectId;
  const activationToken = state.activationToken;
  const frame = $('#chat-frame');
  const placeholder = $('#chat-placeholder');
  if (!frame) return;
  try {
    if (!state.chatConnId) {
      const result = await Store.ensureProjectChat(projectId);
      if (state.activationToken !== activationToken || state.projectId !== projectId) return;
      if (!result?.connId) throw new Error('No project connection was returned.');
      state.chatConnId = result.connId;
    }
    if (state.activationToken !== activationToken || state.projectId !== projectId) return;
    if (context) {
      sessionStorage.setItem('liber_revex_chat_draft', context);
      try { frame.contentWindow?.postMessage({ type: 'liber:revex-chat-context', context, projectId }, location.origin); } catch (_) {}
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
const REVEX_VIEWS = ['bim', 'design', 'spec', 'docs', 'energy', 'chat', 'history'];

function showView(name) {
  if (!REVEX_VIEWS.includes(name)) name = 'bim';
  closeWorkspaceRail();
  const hasProject = Boolean(state.projectId);
  $('#view-empty').hidden = hasProject;
  for (const view of REVEX_VIEWS) {
    const panel = $(`#view-${view}`);
    if (panel) panel.hidden = !hasProject || view !== name;
  }
  $$('.main-nav [data-view]').forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  if (hasProject) {
    history.replaceState(null, '', `${location.pathname}?${new URLSearchParams({ ...(currentParams().get('inShell') ? { inShell: '1' } : {}), projectId: state.projectId, ...(state.preferredSpecId ? { specProjectId: state.preferredSpecId } : {}), view: name })}`);
    const av = activeBimViewer();
    av?.setActive?.(name === 'bim');
    if (name === 'bim') setTimeout(() => { av?.resize?.(); av?.requestRender?.(); }, 0);
    if (name === 'spec') renderSpec();
    if (name === 'chat') { renderChatContext(); setTimeout(() => ensureChatEmbedded(state.selectedContext), 0); }
    if (name === 'history') window.dispatchEvent(new CustomEvent('revex:history-open', { detail: { projectId: state.projectId } }));
    if (name === 'energy') window.dispatchEvent(new CustomEvent('revex:energy-open', { detail: { projectId: state.projectId } }));
  }
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
  select.innerHTML = '<option value="">Choose a project</option>' + state.projects.map((project) =>
    `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name || project.title || 'Untitled project')}</option>`
  ).join('');
  select.value = state.projectId;
}

function notifyNativeProject(explicitUserSelection = false) {
  if (!state.projectId) return;
  try {
    window.chrome?.webview?.postMessage({
      type: 'liber:revex-project-selected',
      projectId: state.projectId,
      specProjectId: state.preferredSpecId || null,
      projectName: state.project?.name || state.project?.title || '',
      explicitUserSelection: Boolean(explicitUserSelection),
      source: explicitUserSelection ? 'native-selection-bridge' : 'companion-observation'
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
  const creationToken = state.activationToken;
  const creationUid = Store.user?.uid || null;
  const stillCreatingForCurrentIdentity = () => !hardBoundaryNavigating && state.activationToken === creationToken && (Store.user?.uid || null) === creationUid;
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
    if (!stillCreatingForCurrentIdentity()) return;
    state.projects = await Store.listProjects();
    if (!stillCreatingForCurrentIdentity()) return;
    if (!state.projects.some((row) => row.id === created.id)) state.projects.unshift(created);
    renderProjects();
    closeProjectDialog();
    const navigated = await activateProject(created.id, { explicitUserSelection: true });
    if (!stillCreatingForCurrentIdentity() || navigated) return;
    toast('REVEX project, Spec Book and project connection created.');
  } catch (error) {
    if (!stillCreatingForCurrentIdentity()) return;
    setSync('Project creation failed', 'bad');
    toast(error.message || 'Could not create the project.', true);
  } finally {
    if (!stillCreatingForCurrentIdentity()) return;
    button.disabled = false;
    button.textContent = 'Create project';
  }
}

function retryFailedStartup() {
  // Only an explicit retry from the cleaned-up, uninitialized empty workspace
  // may reload. Never replay Store.init or replace a meaningful live workspace.
  if (!appStartupFailed || appInitialized || hardBoundaryNavigating || state.projectId || state.project) return false;
  if (['#project-dialog', '#issue-drawer', '#render-dialog'].some((selector) => {
    const panel = $(selector);
    return panel && !panel.hidden;
  })) return false;
  startupRetryNavigating = true;
  setSync('Retrying connection; keeping your sign-in…', 'busy');
  toast('Retrying REVEX startup. Your sign-in and current link will be kept.');
  const button = $('#empty-connect-button');
  if (button) button.textContent = 'Retrying connection…';
  try { location.reload(); } catch (error) { startupRetryNavigating = false; throw error; }
  return true;
}

async function connectExistingProject() {
  if (projectEntryPending || hardBoundaryNavigating || startupRetryNavigating) return;
  const button = $('#empty-connect-button');
  projectEntryPending = true;
  if (button) button.disabled = true;
  try {
    if (!appInitialized) {
      if (appStartupFailed) {
        if (!retryFailedStartup()) toast('Finish or close the open project work before retrying startup.', true);
        return;
      }
      setSync('Checking remembered sign-in…', 'busy');
      await appStartup;
    }
    if (!Store.authSettled) {
      return toast('Sign-in is still unavailable. Check your connection, then try again.', true);
    }
    if (!Store.isCloud()) {
      // Use the existing LIBER sign-in owner on this origin. Never sign out,
      // create a project, or clear persistence to enter an existing project.
      const target = new URL('../../index.html', location.href);
      const current = currentParams();
      target.searchParams.set('returnTo', 'revex');
      for (const key of ['projectId', 'specProjectId', 'view']) {
        const value = current.get(key);
        if (value) target.searchParams.set(key, value);
      }
      target.hash = 'apps';
      let host = window;
      try {
        if (window.top.location.origin === location.origin) host = window.top;
      } catch (_) {}
      host.location.assign(target.href);
      return;
    }
    const uid = Store.user?.uid;
    const generation = authReconcileGeneration;
    setSync('Checking accessible projects…', 'busy');
    const projects = await Store.listProjects();
    if (hardBoundaryNavigating || generation !== authReconcileGeneration || !Store.isCloud() || Store.user?.uid !== uid) return;
    state.projects = projects;
    renderProjects();
    if (!projects.length) {
      setSync('No accessible REVEX projects found', 'quiet');
      return toast('No existing projects are available to this account. Ask a project member for an invitation.');
    }
    $('#project-select').focus();
    try { $('#project-select').showPicker?.(); } catch (_) {}
    setSync('Choose a project to start', 'quiet');
    toast('Choose the existing LIBER project from the project field.');
  } catch (_) {
    setSync('Project connection unavailable', 'bad');
    toast(appStartupFailed ? 'Startup did not complete. Press Retry connection to reload this link without signing out.' : 'Could not check sign-in or load your projects. Check your connection and try again.', true);
  } finally {
    projectEntryPending = false;
    if (button) button.disabled = false;
  }
}

function renderModelTree() {
  const data = state.viewerData;
  const allElements = data?.elements || [];
  const hiddenIds = new Set([...state.bimOverlays.values()].filter(row=>row.hidden||row.deleted).flatMap(row=>[String(row.uniqueId||''),String(row.elementId||row.id||'')]));
  const elements = state.showHiddenOnly ? allElements.filter(row=>hiddenIds.has(String(row.uniqueId||''))||hiddenIds.has(String(row.id))) : allElements;
  $('#model-title').textContent = data?.source?.documentTitle || state.cloudState?.central?.documentTitle || 'No model synced';
  $('#model-facts').innerHTML = state.cloudState ? `
    <div class="fact"><strong>${elements.length.toLocaleString()}</strong><span>${state.showHiddenOnly?'hidden elements':'model elements'}</span></div>
    <div class="fact"><strong>${(data?.source?.viewName || '3D').slice(0, 20)}</strong><span>Revit view</span></div>
    <div class="fact"><strong>${state.cloudState.scheduleCount || state.designData?.schedules?.length || 0}</strong><span>schedules</span></div>
    <div class="fact"><strong>${String(state.viewerMode||'').startsWith('rvxmesh') ? 'Exact' : state.viewerMode === 'fbx' ? 'FBX' : state.viewerMode === 'fallback' ? 'Index' : 'Loading'}</strong><span>geometry</span></div>` : '';
  const groups = new Map();
  elements.forEach((element) => {
    const category = element.category || 'Other';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(element);
  });
  const q = $('#element-search').value.trim().toLowerCase();
  const treeLimit = q ? 1500 : 800;
  let shown = 0;
  const chunks = [];
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([category, rows]) => {
    const matching = rows.filter((row) => !q || `${row.id} ${row.category} ${row.name} ${row.type} ${(row.materials || []).map((m) => m.name).join(' ')}`.toLowerCase().includes(q));
    if (!matching.length || shown >= treeLimit) return;
    chunks.push(`<div class="tree-group">${escapeHtml(category)} · ${matching.length}</div>`);
    for (const row of matching.slice(0, Math.max(treeLimit - shown, 0))) {
      shown += 1;
      chunks.push(`<button class="tree-item${String(state.selectedElement?.id) === String(row.id) ? ' active' : ''}" data-element-id="${escapeHtml(row.id)}"><span>${escapeHtml(row.name || row.type || category)}</span><span class="tree-id">${escapeHtml(row.id)}</span></button>`);
    }
  });
  if (elements.length > shown && !q) chunks.push(`<p class="muted">Showing ${shown.toLocaleString()} of ${elements.length.toLocaleString()} elements for responsiveness. Search finds the rest.</p>`);
  $('#element-tree').innerHTML = chunks.join('') || '<p class="muted">No matching elements.</p>';
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
      <div class="property"><span>Type</span>${escapeHtml(element.type || '—')}</div>
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

function bookChapters() {
  return chapters().filter(chapter => isBookDivision(chapter, state.chapterEdits.get(chapter.id), state.designEdits));
}
function bookItems(chapter) { return bookDivisionItems(chapter,state.chapterEdits.get(chapter.id),state.designEdits); }
async function setBookVisibility(chapterId, visibility, button) {
  const context = captureProjectContext();
  if (!context.projectId || !isCurrentProjectContext(context)) return;
  button.disabled = true;
  try {
    const patch = { bookVisibility: visibility };
    await Store.saveChapterEdit(context.projectId, chapterId, patch);
    if (!isCurrentProjectContext(context)) return;
    state.chapterEdits.set(chapterId, { ...(state.chapterEdits.get(chapterId) || {}), ...patch });
    renderDesign(); toast(visibility === 'included' ? 'Division included in Design Book.' : 'Kept in synced sources. All selections are preserved.');
  } catch(error) { if (isCurrentProjectContext(context)) { button.disabled = false; toast(error.message, true); } }
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

window.RevexDesignContext = {
  positions: () => chapters().flatMap(chapter => (chapter.items || []).map(source => ({ chapterId:chapter.id, chapterTitle:chapter.title, ...mergedItem(source) }))),
  open: (chapterId, itemId) => {
    const chapter=chapters().find(row=>row.id===chapterId), item=chapter?.items?.find(row=>String(row.id)===String(itemId));
    if (!item) return false;
    $('#design-search').value=''; openDesignPosition(chapter,item,true); rootMobilePosition(); return true;
  }
};


function renderDesignProgress() {
  const sourceItems = bookChapters().flatMap((chapter) => bookItems(chapter).map((item) => ({ chapter, item })));
  const active = sourceItems.map(({ item }) => mergedItem(item));
  const specified = active.filter((item) => {
    const status = String(item.status || 'Not Selected');
    return status !== 'Not Selected' || Boolean(String(item.description || '').trim()) || Boolean(String(item.source || '').trim()) || Boolean(item.images?.length);
  }).length;
  const total = active.length;
  const percent = total ? Math.round(specified / total * 100) : 0;
  const host = $('#design-progress');
  if (!host) return;
  const approved = active.filter(item => item.status === 'Approved').length;
  host.innerHTML = `<div class="design-progress-head"><div><strong>Design Book progress</strong><span> · whole project</span></div><b>${percent}%</b></div><div class="design-progress-meta">${specified.toLocaleString()} of ${total.toLocaleString()} positions have selections or notes</div><div class="design-progress-track"><i style="width:${percent}%"></i></div><small>${approved.toLocaleString()} approved · ${(total-approved).toLocaleString()} awaiting approval</small>`;
}
function designSearchTerms(item, chapter) {
  const fields = [chapter.title, item.label, item.description, item.source, item.status,
    item.originalChapterTitle, item.location, item.room, item.level,
    item.revit?.category, item.revit?.family, item.revit?.type,
    ...(item.revit?.levels || []), ...(item.candidateMaterials || [])];
  return fields.filter(value => typeof value === 'string' || typeof value === 'number').join(' ').normalize('NFKC').toLocaleLowerCase();
}
function renderDesign() {
  renderDesignProgress();
  const list = chapters(), divisions = bookChapters(), source = list.filter(chapter => !divisions.includes(chapter));
  if (!state.activeChapter || !list.some(chapter => chapter.id === state.activeChapter)) state.activeChapter = divisions[0]?.id || list[0]?.id || '';
  const chapterButton = chapter => `<button type="button" class="${chapter.id === state.activeChapter ? 'active' : ''}" data-chapter="${escapeHtml(chapter.id)}"><span>${escapeHtml(chapter.title)}</span><small>${chapter.items?.length || 0}</small></button>`;
  const sourcesOpen = $('#design-source-records')?.open || source.some(chapter => chapter.id === state.activeChapter);
  $('#chapter-list').innerHTML = divisions.map(chapterButton).join('') + (source.length ? `<details id="design-source-records" ${sourcesOpen ? 'open' : ''}><summary>Synced spaces &amp; model records <small>${source.length}</small></summary><p>Preserved source records. Include a space when it needs its own design division.</p><input class="search" id="design-source-filter" type="search" placeholder="Find a synced space or model type" aria-label="Find a synced space or model type"><div id="design-source-list">${source.map(chapterButton).join('')}</div></details>` : '') || '<p class="muted">Sync from Revit to form the Design Book.</p>';
  $('#design-source-filter')?.addEventListener('input', event => { const query=event.target.value.normalize('NFKC').toLocaleLowerCase(); $$('#design-source-list [data-chapter]').forEach(button=>button.hidden=!button.textContent.normalize('NFKC').toLocaleLowerCase().includes(query)); });
  $$('#chapter-list [data-chapter]').forEach(button => button.addEventListener('click', () => { state.activeChapter = button.dataset.chapter; state.selectedDesign = null; $('#design-search').value=''; renderDesign(); renderDesignInspector(); closeWorkspaceRail(); }));
  const chapter = list.find((row) => row.id === state.activeChapter);
  const query = String($('#design-search')?.value || '').normalize('NFKC').trim().toLocaleLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  const positions = (query ? list : chapter ? [chapter] : []).flatMap(owner => (owner.items || []).map(source => ({ owner, source, item: mergedItem(source) })))
    .filter(({ owner, item }) => tokens.every(token => designSearchTerms(item, owner).includes(token)));
  const formedChapter = chapter ? mergedChapter(chapter) : null;
  $('#chapter-title').textContent = query ? 'Search results' : chapter?.title || 'Design Book';
  $('#chapter-subtitle').textContent = query ? 'Matching positions across design divisions and preserved sources.' : chapter
    ? `${chapter.items?.length || 0} positions · ${divisions.includes(chapter) ? 'Design Book division' : 'Synced source · excluded from book pages until included'}`
    : 'Sync room, material and design schedules from Revit.';
  let visibilityButton = $('#design-division-visibility');
  if (!visibilityButton) { visibilityButton=document.createElement('button'); visibilityButton.id='design-division-visibility'; visibilityButton.type='button'; visibilityButton.className='button ghost compact'; $('#chapter-subtitle').after(visibilityButton); }
  visibilityButton.hidden=Boolean(query || !chapter);
  visibilityButton.textContent=divisions.includes(chapter) ? 'Move division to synced sources' : 'Include division in Design Book';
  visibilityButton.onclick=()=>setBookVisibility(chapter.id,divisions.includes(chapter)?'source':'included',visibilityButton);
  renderDesignLanes(formedChapter);
  $('#design-lanes').hidden = Boolean(query || !divisions.includes(chapter));
  const count = $('#design-search-count');
  if (count) count.textContent = query ? `${positions.length.toLocaleString()} result${positions.length === 1 ? '' : 's'}` : '';
  $('#design-grid').innerHTML = positions.map(({ owner, item }) => {
    const image = item.images?.at?.(-1)?.url || item.images?.[item.images.length - 1]?.url;
    return `<button class="design-card${state.selectedDesign?.id === item.id ? ' active' : ''}" data-item="${escapeHtml(item.id)}" data-chapter="${escapeHtml(owner.id)}" type="button">
      <div class="design-image">${image ? `<img src="${escapeHtml(image)}" alt="" />` : 'ADD REFERENCE / RENDER'}</div>
      <div class="design-copy">${query ? `<small class="design-result-location">${escapeHtml([owner.title, ...(item.revit?.levels || [])].filter(Boolean).join(' · '))}</small>` : ''}<strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.description || 'No decision note yet.')}</p><span class="status-chip">${escapeHtml(item.status || 'Not Selected')}</span>${item.revit ? `<span class="source-chip">REVIT · ${Number(item.revit.instanceCount || 0).toLocaleString()}</span>` : ''}</div>
    </button>`;
  }).join('') || `<p class="muted">${query ? 'No matching positions. Try a material, room, level or a shorter name.' : 'No positions in this chapter.'}</p>`;
  $$('.design-card', $('#design-grid')).forEach((card) => card.addEventListener('click', () => {
    const owner = list.find(row => row.id === card.dataset.chapter);
    const source = owner?.items.find((item) => item.id === card.dataset.item);
    if (owner && source) openDesignPosition(owner, source);
  }));
}
$('#design-search')?.addEventListener('input', renderDesign);
window.addEventListener('revex:project-boundary', () => { const search = $('#design-search'); if (search) search.value = ''; });

function publishedBookRows() {
  return bookChapters().flatMap(chapter => bookItems(chapter).map(source => ({ chapter, item: mergedItem(source) })));
}
function productLink(value) {
  try { const url = new URL(String(value || '')); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; }
}
function bookDialog() {
  let dialog = $('#design-book-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog'); dialog.id = 'design-book-dialog'; dialog.className = 'design-book-dialog'; dialog.setAttribute('aria-labelledby','design-book-title');
  dialog.innerHTML = '<header class="design-book-head"><div><div class="eyebrow">PUBLISHED SELECTIONS</div><h2 id="design-book-title"></h2><p id="design-book-summary"></p></div><div class="design-book-actions"><button type="button" class="button ghost" id="design-book-csv">Download table</button><button type="button" class="button" id="design-book-print">Print / PDF</button><button type="button" class="icon-button" id="design-book-close" aria-label="Close Design Book">×</button></div></header><div class="design-book-table-wrap" id="design-book-rows"></div>';
  document.body.appendChild(dialog);
  $('#design-book-close').addEventListener('click',()=>dialog.close());
  $('#design-book-print').addEventListener('click',()=>{try{printBookDocument({title:bookFilename('Design Book',state.project?.name),html:$('#design-book-rows').innerHTML});}catch(error){toast(error.message,true);}});
  $('#design-book-csv').addEventListener('click',downloadDesignBook);
  const excel=document.createElement('button');excel.type='button';excel.className='button ghost';excel.id='design-book-xlsx';excel.textContent='Excel (.xlsx)';
  $('#design-book-csv').textContent='CSV';$('#design-book-csv').before(excel);
  excel.addEventListener('click',downloadDesignWorkbook);
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();const button=event.target.closest('[data-book-position]');if(!button)return;const chapter=chapters().find(row=>row.id===button.dataset.bookChapter),source=chapter?.items.find(row=>row.id===button.dataset.bookPosition);if(!source)return;dialog.close();$('#design-search').value='';openDesignPosition(chapter,source,true);rootMobilePosition();});
  return dialog;
}
function rootMobilePosition() { window.__revexMobileSheetR142?.sync?.(); window.__revexMobileSheetR142?.openPane?.('b'); }
function renderBookPreview() {
  const divisions=bookChapters(), rows=publishedBookRows(), approved=rows.filter(({item})=>item.status==='Approved').length;
  const project=state.project?.name||'Project', date=new Date().toISOString().slice(0,10);
  $('#design-book-title').textContent = `Design Book · ${project}`;
  $('#design-book-summary').textContent = `${divisions.length} divisions · ${rows.length} positions · ${approved} approved · ${date}. Working versions appear here after Publish to Design Book. ${chapters().length-divisions.length} source groups remain available in Synced spaces & model records.`;
  $('#design-book-rows').innerHTML=divisions.map((chapter,index)=>{
    const formed=mergedChapter(chapter);
    const lanes=[['inspiration','Inspiration'],['renders','Renderings'],['versionImages','Design studies']].map(([key,label])=>formed[key]?.length?`<div class="book-lane"><h3>${label}</h3><div class="book-lane-images">${formed[key].map(image=>`<img class="design-book-image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name||label)}">`).join('')}</div></div>`:'').join('');
    return `<section class="design-book-division" data-book-division="${escapeHtml(chapter.id)}"><header class="design-book-division-head"><div><small>DESIGN BOOK · ${escapeHtml(project)}</small><h2>${escapeHtml(chapter.title)}</h2></div><small>${String(index+1).padStart(2,'0')} / ${divisions.length}<br>${date}</small></header>${lanes}<div class="design-book-position-grid">${bookItems(chapter).map(source=>{
      const item=mergedItem(source),image=item.images?.at(-1),link=productLink(item.source);
      return `<article class="design-book-position"><h3><button type="button" data-book-position="${escapeHtml(item.id)}" data-book-chapter="${escapeHtml(chapter.id)}">${escapeHtml(item.label)}</button></h3>${item.revit?.levels?.length?`<small>${escapeHtml(item.revit.levels.join(' · '))}</small>`:''}<div class="design-book-position-body">${image?.url?`<img class="design-book-image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name||item.label)}" tabindex="0" role="button" aria-label="View ${escapeHtml(item.label)} image">`:''}<div><p class="design-book-notes">${escapeHtml(item.description||'Selection to be developed.')}</p>${!image?.url?'<span class="book-empty-image">No image selected</span>':''}<div class="book-position-meta"><span class="status-chip">${escapeHtml(item.status||'Not Selected')}</span>${link?`<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">View product ↗</a>`:''}</div></div></div></article>`;
    }).join('')}</div></section>`;
  }).join('') || '<p>No design divisions included yet. Include a division from Synced spaces &amp; model records.</p>';
}

function downloadDesignBook() {
  const cell = value => { let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"'; };
  const rows = [['Chapter','Position','Location','Status','Description','Product link','Image links'],...publishedBookRows().map(({chapter,item})=>[chapter.title,item.label,(item.revit?.levels||[]).join('; '),item.status||'Not Selected',item.description||'',productLink(item.source),(item.images||[]).map(row=>row.url).join('; ')])];
  const blob = new Blob(['\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=bookFilename('Design Book',state.project?.name)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function downloadDesignWorkbook() {
  const context=captureProjectContext(),button=$('#design-book-xlsx');
  if(!context.projectId||!isCurrentProjectContext(context))return;
  button.disabled=true;button.textContent='Preparing Excel…';
  try{
    const XLSX=await loadSpreadsheetEngine();
    if(!isCurrentProjectContext(context))return;
    const project=state.project?.name||'Project',date=new Date();
    const workbook=createBookWorkbook(XLSX,{project,date,divisions:bookChapters().map(chapter=>({...chapter,items:bookItems(chapter).map(mergedItem)}))});
    XLSX.writeFile(workbook,bookFilename('Design Book',project,date)+'.xlsx',{compression:true,bookType:'xlsx'});
  }catch(error){if(isCurrentProjectContext(context))toast(error.message,true);}
  finally{if(button.isConnected){button.disabled=false;button.textContent='Excel (.xlsx)';}}
}
$('#design-book-preview')?.addEventListener('click',()=>{const dialog=bookDialog();renderBookPreview();dialog.showModal();});
window.addEventListener('revex:project-boundary',()=>{const dialog=$('#design-book-dialog');dialog?.close();dialog?.remove();});

const chapterImageBusy = new Set(), chapterImageUndo = new Map();
function chapterImageKey(chapterId, field) { return `${Store.user?.uid || 'local'}::${state.projectId}::${chapterId}::${field}`; }
window.addEventListener('revex:project-boundary', () => chapterImageUndo.clear());

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
      <div class="lane-images">${lane.images.map((image,index) => `<figure class="design-lane-image"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name || lane.title)}" tabindex="0" role="button" aria-label="View ${escapeHtml(image.name || lane.title)}" /><button type="button" data-remove-chapter-image="${index}" data-lane="${lane.field}" aria-label="Remove ${escapeHtml(image.name || 'image')} from ${lane.title}">×</button></figure>`).join('') || '<span>Drop in the first visual</span>'}</div>
      ${chapterImageUndo.has(chapterImageKey(chapter.id,lane.field)) ? `<button type="button" class="button ghost" data-undo-chapter-image="${lane.field}">Undo removal</button>` : ''}
    </section>`).join('');
  $$('[data-chapter-field]', host).forEach((input) => input.addEventListener('change', uploadChapterImage));
  $$('[data-remove-chapter-image]', host).forEach(button => button.addEventListener('click', () => void changeChapterImage(chapter.id,button.dataset.lane,Number(button.dataset.removeChapterImage))));
  $$('[data-undo-chapter-image]', host).forEach(button => button.addEventListener('click', () => void changeChapterImage(chapter.id,button.dataset.undoChapterImage,null)));
  $$('.design-lane',host).forEach(lane => { const busy=chapterImageBusy.has(chapterImageKey(chapter.id,lane.dataset.field));lane.setAttribute('aria-busy',String(busy));lane.querySelectorAll('input,button').forEach(control=>{control.disabled=busy;}); });
}

async function changeChapterImage(chapterId,field,index) {
  const context=captureProjectContext(),chapter=chapters().find(row=>row.id===chapterId),key=chapterImageKey(chapterId,field);
  if(!chapter||chapterImageBusy.has(key)||!isCurrentProjectContext(context))return;
  const current=mergedChapter(chapter)[field]||[], undo=chapterImageUndo.get(key);
  if(index===null&&!undo)return;
  const images=index===null?undo:current.filter((_,i)=>i!==index);
  chapterImageBusy.add(key);renderDesignLanes(mergedChapter(chapter));
  try {
    await Store.saveChapterImages(context.projectId,chapterId,field,images,current);
    if(!isCurrentProjectContext(context))return;
    state.chapterEdits.set(chapterId,{...(state.chapterEdits.get(chapterId)||{}),[field]:images});
    if(index===null)chapterImageUndo.delete(key);else chapterImageUndo.set(key,current);
    setSync('Chapter images saved','good');toast(index===null?'Image restored.':'Image removed. Use Undo removal to restore it.');
  } catch(error) {if(isCurrentProjectContext(context))toast(error.message||'Could not update chapter images.',true);}
  finally {chapterImageBusy.delete(key);if(isCurrentProjectContext(context))renderDesign();}
}

async function uploadChapterImage(event) {
  const context = captureProjectContext();
  const file = event.target.files?.[0];
  const chapter = chapters().find((row) => row.id === state.activeChapter);
  if (!context.projectId || !file || !chapter || !isCurrentProjectContext(context)) return;
  const field = event.target.dataset.chapterField;
  const current = mergedChapter(chapter)[field] || [];
  const key=chapterImageKey(chapter.id,field);
  if(chapterImageBusy.has(key))return;
  chapterImageBusy.add(key);event.target.disabled=true;
  try {
    setSync(`Uploading ${field === 'inspiration' ? 'inspiration' : field === 'renders' ? 'rendering' : 'version'}…`, 'busy');
    const images = await Store.uploadChapterImage(context.projectId, chapter.id, field, file, current);
    if (!isCurrentProjectContext(context)) return;
    const edit = { ...(state.chapterEdits.get(chapter.id) || {}), [field]: images };
    state.chapterEdits.set(chapter.id, edit);
    renderDesign();
    setSync('Design Book visual saved', Store.isCloud() ? 'good' : 'quiet');
    toast('Chapter visual saved outside the RVT.');
  } catch (error) { if(isCurrentProjectContext(context)){setSync('Visual upload failed', 'bad'); toast(error.message, true);} }
  finally { chapterImageBusy.delete(key);event.target.value='';if(isCurrentProjectContext(context))renderDesign(); }
}

function renderDesignInspector() {
  const item = state.selectedDesign;
  if (!item) {
    $('#design-inspector').innerHTML = '<div class="eyebrow">DESIGN POSITION</div><h2>Select a position</h2><p class="muted">Images and decisions are saved outside the RVT and survive the next Revit sync.</p>';
    return;
  }
  $('#design-inspector').innerHTML = `
    <div class="eyebrow">${escapeHtml(item.chapterTitle)}</div><h2>${escapeHtml(item.label)}</h2>
    ${item.revit ? `<details class="design-source-summary"><summary>Model location and properties</summary>
      <span>REVIT MODEL SOURCE</span>
      <strong>${Number(item.revit.instanceCount || 0).toLocaleString()} visible instance${Number(item.revit.instanceCount || 0) === 1 ? '' : 's'}</strong>
      <p>${escapeHtml([item.revit.category, item.revit.family, item.revit.type].filter(Boolean).join(' · '))}</p>
      ${(item.revit.levels || []).length ? `<small>${escapeHtml(item.revit.levels.join(' · '))}</small>` : ''}
      <button class="button ghost" id="design-show-bim" type="button">Show representative in BIM</button>
    </details>` : ''}
    <form id="design-edit-form" class="edit-form">
      <label>Status<select id="design-status"><option>Not Selected</option><option>Research</option><option>Proposed</option><option>Approved</option><option>On Hold</option></select></label>
      <label>Description<textarea id="design-description" rows="4" placeholder="Selection, intent, dimensions…">${escapeHtml(item.description || '')}</textarea></label>
      <label>Source / product link<input id="design-source" type="url" value="${escapeHtml(item.source || '')}" placeholder="https://…" /></label>
      <button class="button ghost" id="design-source-products" type="button">Find products with WALLT</button>
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
  $('#design-source-products').addEventListener('click',()=>window.dispatchEvent(new CustomEvent('revex:source-products')));
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
  const context = captureProjectContext();
  const item = state.selectedDesign;
  if (!context.projectId || !item || !isCurrentProjectContext(context)) return;
  const sourceRevision = state.cloudState?.revision || null;
  const patch = {
    status: $('#design-status').value,
    description: $('#design-description').value.trim(),
    source: $('#design-source').value.trim(),
    images: item.images || [],
    sourceSnapshot: { id: item.id, label: item.label, chapterTitle: item.chapterTitle, revit: item.revit || null }
  };
  try {
    setSync('Saving Design Book…', 'busy');
    const saved = await Store.saveDesignEdit(context.projectId, item.id, patch);
    if (!isCurrentProjectContext(context)) return;
    try { await Store.appendHistory(context.projectId, { sourceRevision, kind: 'design', operation: 'edit', label: `Design Book · ${item.chapterTitle} / ${item.label}`, affectedElementIds: item.revit?.elementIds || [], affectedUniqueIds: [], affectedLevels: item.revit?.levels || [], before: { status: item.status || 'Not Selected', description: item.description || '', source: item.source || '', images: item.images || [] }, after: { status: saved.status, description: saved.description, source: saved.source, images: saved.images || [] }, relatedId: item.id }); } catch (historyError) { console.warn('[REVEX] Design history', historyError); }
    if (!isCurrentProjectContext(context)) return;
    state.designEdits.set(item.id, { ...(state.designEdits.get(item.id) || {}), ...saved });
    state.selectedDesign = { ...item, ...saved };
    state.selectedContext = contextFor('Design', state.selectedDesign);
    window.dispatchEvent(new CustomEvent('revex:design-selection', { detail: { item: state.selectedDesign } }));
    renderDesign(); renderDesignInspector();
    setSync(Store.isCloud() ? 'Design Book saved' : 'Saved on this device', Store.isCloud() ? 'good' : 'quiet');
    toast('Design Book position saved.');
  } catch (error) { if(isCurrentProjectContext(context)){setSync('Save failed', 'bad'); toast(error.message, true);} }
}

async function uploadDesignImage(event) {
  const context = captureProjectContext();
  const file = event.target.files?.[0];
  const item = state.selectedDesign;
  if (!context.projectId || !file || !item || !isCurrentProjectContext(context)) return;
  const beforeImages = item.images || [];
  const sourceRevision = state.cloudState?.revision || null;
  try {
    setSync('Uploading design image…', 'busy');
    const images = await Store.uploadDesignImage(context.projectId, item.id, file, beforeImages);
    if (!isCurrentProjectContext(context)) return;
    try { await Store.appendHistory(context.projectId, { sourceRevision, kind: 'design', operation: 'image-upload', label: `Design Book image · ${item.chapterTitle} / ${item.label}`, affectedElementIds: item.revit?.elementIds || [], affectedLevels: item.revit?.levels || [], before: { images: beforeImages }, after: { images }, relatedId: item.id }); } catch (historyError) { console.warn('[REVEX] Design history', historyError); }
    if (!isCurrentProjectContext(context)) return;
    const edit = { ...(state.designEdits.get(item.id) || {}), images };
    state.designEdits.set(item.id, edit);
    state.selectedDesign = { ...item, images };
    renderDesign(); renderDesignInspector(); setSync('Design image saved', 'good');
  } catch (error) { if(isCurrentProjectContext(context)){setSync('Image upload failed', 'bad'); toast(error.message, true);} }
}

function renderSpec() {
  const liveParams = currentParams();
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
    specUrl: liveParams.get('specUrl'),
    specTitle: liveParams.get('specTitle'),
    specNote: liveParams.get('specNote'),
    section: liveParams.get('section'),
    item: liveParams.get('item')
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
  const context = captureProjectContext();
  if (!context.projectId || !isCurrentProjectContext(context)) return openProjectDialog();
  const prompt = $('#render-prompt').value.trim();
  if (!prompt) return setRenderStatus('Add a render instruction first.', 'bad');
  const chapter = chapters().find((row) => row.id === $('#render-chapter').value) || null;
  const selectedDesign = state.selectedDesign;
  const selectedElement = state.selectedElement;
  const contextLabel = renderContextLabel();
  const sourceRevision = state.cloudState?.revision || null;
  const specProjectId = state.preferredSpecId || null;
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
    const job = await Store.createRenderJob(context.projectId, {
      contextKind: selectedDesign ? 'design' : selectedElement ? 'bim' : 'view',
      contextLabel,
      elementId: selectedElement?.id || null,
      designItemId: selectedDesign?.id || null,
      chapterId: chapter?.id || null,
      chapterTitle: chapter?.title || null,
      revision: sourceRevision,
      prompt,
      settings,
      status: 'bridging'
    });
    if (!isCurrentProjectContext(context)) return;
    try { await Store.appendHistory(context.projectId, { sourceRevision, kind: 'render', operation: 'prepare', label: `Render prepared · ${contextLabel}`, affectedElementIds: selectedElement?.id ? [selectedElement.id] : [], affectedLevels: selectedElement?.level ? [selectedElement.level] : [], before: null, after: { renderJobId: job.id, prompt, settings }, relatedId: job.id }); } catch (historyError) { console.warn('[REVEX] Render history', historyError); }
    if (!isCurrentProjectContext(context)) return;
    state.activeRenderJob = job;
    state.renderJobs = [job, ...state.renderJobs.filter((row) => row.id !== job.id)].slice(0, 40);
    renderRenderHistory();
    pendingNativeRender = {
      type: 'liber:revex-render-request', action: 'capture-current', projectId: context.projectId,
      specProjectId, renderJobId: job.id, prompt, settings,
      context: { label: contextLabel, elementId: selectedElement?.id || null, designItemId: selectedDesign?.id || null, chapterId: chapter?.id || null }
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
      if (!isCurrentProjectContext(context)) return;
      await Store.updateRenderJob(context.projectId, job.id, { status: 'workspace-ready' });
      if (!isCurrentProjectContext(context)) return;
      job.status = 'workspace-ready';
      renderRenderHistory();
      setRenderStatus('AI workspace ready. The prompt is copied; attach the prepared source preview in the embedded workspace, then save the result below.', 'good');
    }
  } catch (error) {
    if(isCurrentProjectContext(context))setRenderStatus(error.message || 'The render could not be prepared.', 'bad');
  }
}

async function saveRenderResult(event) {
  const context = captureProjectContext();
  const file = event.target.files?.[0];
  const chapter = chapters().find((row) => row.id === $('#render-chapter').value);
  const activeJob = state.activeRenderJob;
  const sourceRevision = state.cloudState?.revision || null;
  if (!context.projectId || !file || !chapter || !isCurrentProjectContext(context)) return setRenderStatus('Choose a Design Book chapter before saving the result.', 'bad');
  try {
    setRenderStatus('Saving the generated result into the Design Book…', 'busy');
    const formed = mergedChapter(chapter);
    const images = await Store.uploadChapterImage(context.projectId, chapter.id, 'renders', file, formed.renders || []);
    if (!isCurrentProjectContext(context)) return;
    const result = images[images.length - 1];
    if (activeJob?.id) {
      await Store.updateRenderJob(context.projectId, activeJob.id, { status: 'saved', resultUrl: result?.url || null, resultName: file.name, chapterId: chapter.id });
      if (!isCurrentProjectContext(context)) return;
      try { await Store.appendHistory(context.projectId, { sourceRevision, kind: 'render', operation: 'save-result', label: `Render saved · ${chapter.title}`, before: null, after: { renderJobId: activeJob.id, resultUrl: result?.url || null, resultName: file.name, chapterId: chapter.id }, relatedId: activeJob.id }); } catch (historyError) { console.warn('[REVEX] Render result history', historyError); }
      if (!isCurrentProjectContext(context)) return;
    }
    state.chapterEdits.set(chapter.id, { ...(state.chapterEdits.get(chapter.id) || {}), renders: images });
    state.activeChapter = chapter.id;
    if (activeJob?.id) {
      state.activeRenderJob = { ...activeJob, status: 'saved', resultUrl: result?.url || null, resultName: file.name };
      state.renderJobs = state.renderJobs.map((row) => row.id === activeJob.id ? state.activeRenderJob : row);
    }
    renderDesign(); renderRenderHistory();
    setRenderStatus(`Saved to ${chapter.title} · Renderings.`, 'good');
    toast('Render saved into the Design Book.');
  } catch (error) { if(isCurrentProjectContext(context))setRenderStatus(error.message || 'Could not save the render.', 'bad'); }
  finally { event.target.value = ''; }
}

async function handleNativeRenderStatus(data) {
  if (!data || data.type !== 'liber:revex-render-status') return;
  const context = captureProjectContext();
  const activeJob = state.activeRenderJob;
  if (!context.projectId || !activeJob?.id || !isCurrentProjectContext(context)) return;
  // Native messages can be queued across a WebView reload.  Legacy status
  // payloads without both correlations are therefore unsafe: never let an
  // old render alter the current project's job or UI.
  if (data.projectId !== context.projectId || data.renderJobId !== activeJob.id) return;
  const jobId = activeJob.id;
  const status = data.ok ? 'ready-in-ai' : 'bridge-error';
  try { await Store.updateRenderJob(context.projectId, jobId, { status, bridgeMessage: data.message || '' }); } catch (_) {}
  if (!isCurrentProjectContext(context)) return;
  setRenderStatus(data.message || (data.ok ? 'Render bridge ready.' : 'Render bridge failed.'), data.ok ? 'good' : 'bad');
  state.renderJobs = state.renderJobs.map((row) => row.id === jobId ? { ...row, status } : row);
  if (state.activeRenderJob?.id === jobId) state.activeRenderJob = { ...state.activeRenderJob, status };
  renderRenderHistory();
}

function docsSetDisplayName(fileOrName) {
  const raw = typeof fileOrName === 'string' ? fileOrName : (fileOrName?.printingSetName || fileOrName?.name || 'Printing Set');
  return String(raw || 'Printing Set').replace(/\.[^.]+$/, '').trim() || 'Printing Set';
}

function docsSetNameKey(fileOrName) {
  return docsSetDisplayName(fileOrName).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function docsSetFallbackKey(fileOrName) {
  return docsSetNameKey(fileOrName)
    .replace(/\b(?:rev(?:ision)?|issue|issued|set|r)\s*[a-z0-9._-]+\s*$/i, '')
    .replace(/\b20\d{2}[ ._-]?\d{1,2}[ ._-]?\d{1,2}\s*$/i, '')
    .trim();
}

function docsSetStableKey(file) {
  return String(file?.printingSetStableKey || '').trim()
    || (docsSetNameKey(file) ? `name:${docsSetNameKey(file)}` : '')
    || (String(file?.printingSetId || '').trim() ? `id:${String(file.printingSetId).trim()}` : '')
    || (docsSetFallbackKey(file) ? `fallback:${docsSetFallbackKey(file)}` : '')
    || `file:${String(file?.id || file?.name || 'set')}`;
}

function docsPrintingGroups(rows = state.library) {
  const files = (rows || []).filter((row)=>row?.revexDocKind === 'printing-set');
  const groups = [];
  const byExplicit = new Map();
  const byId = new Map();
  const byName = new Map();
  for (const file of files) {
    const explicit = String(file.printingSetStableKey || '').trim();
    const setId = String(file.printingSetId || '').trim();
    const nameKey = docsSetNameKey(file);
    let group = explicit ? byExplicit.get(explicit) : null;
    if (!group && setId) group = byId.get(setId) || null;
    if (!group && nameKey) group = byName.get(nameKey) || null;
    if (!group) {
      group = { key: explicit || (setId ? `id:${setId}` : (nameKey ? `name:${nameKey}` : docsSetStableKey(file))), rows: [], nameKeys: new Set(), fallbackKeys: new Set(), setIds: new Set() };
      groups.push(group);
    }
    group.rows.push(file);
    if (explicit) byExplicit.set(explicit, group);
    if (setId) { group.setIds.add(setId); byId.set(setId, group); }
    if (nameKey) { group.nameKeys.add(nameKey); byName.set(nameKey, group); }
    const fallback = docsSetFallbackKey(file); if (fallback) group.fallbackKeys.add(fallback);
  }
  // Fallback names are aliases only when they identify exactly one existing set.
  // Ambiguous fallback keys never cause an automatic replacement or merge.
  const fallbackOwners = new Map();
  for (const group of groups) for (const key of group.fallbackKeys) {
    const owners = fallbackOwners.get(key) || []; owners.push(group); fallbackOwners.set(key, owners);
  }
  for (const group of groups) {
    group.uniqueFallbackKeys = new Set([...group.fallbackKeys].filter((key)=>(fallbackOwners.get(key)||[]).length === 1));
    group.rows.sort((a,b)=>String(b.createdAt||b.updatedAt||'').localeCompare(String(a.createdAt||a.updatedAt||'')));
  }
  return groups;
}

function inferDocsRevision(fileName) {
  const base = docsSetDisplayName(fileName);
  const m = base.match(/(?:^|[ _.-])(?:rev(?:ision)?|r|issue)[ _.-]*([a-z0-9._-]+)$/i);
  if (m?.[1]) return m[1];
  return `Manual ${new Date().toISOString().slice(0,16).replace('T',' ')}`;
}

const pendingDocsUploadChoices = new Set();

function chooseDocsUploadTarget(file, groups) {
  return new Promise((resolve)=>{
    const existing = groups.filter(g=>g.rows.length).sort((a,b)=>docsSetDisplayName(a.rows[0]).localeCompare(docsSetDisplayName(b.rows[0])));
    const dialog = document.createElement('dialog');
    dialog.className='docs-upload-choice';
    const options = existing.map((g,i)=>`<option value="${i}">${escapeHtml(docsSetDisplayName(g.rows[0]))}</option>`).join('');
    dialog.innerHTML = `<form method="dialog" class="docs-upload-choice-card"><h3>How should REVEX file this PDF?</h3><p><strong>${escapeHtml(file.name)}</strong> does not match an existing printing-set name.</p><label><input type="radio" name="mode" value="new-set" checked> Create a new printing set</label>${existing.length?`<label><input type="radio" name="mode" value="replace-set"> Replace the current revision of <select data-target>${options}</select></label>`:''}<label><input type="radio" name="mode" value="manual"> Keep it as a normal Record In/Out document</label><div class="docs-upload-choice-actions"><button value="cancel" type="submit" class="button ghost">Cancel</button><button value="apply" type="submit" class="button">Continue</button></div><small>Replacing keeps the same set identity and revision history. The uploaded file name becomes the current set name; the prior revision remains available in History.</small></form>`;
    document.body.appendChild(dialog);
    let done=false;
    let cancelChoice=null;
    const finish=(value)=>{if(done)return;done=true;pendingDocsUploadChoices.delete(cancelChoice);try{dialog.close()}catch(_){};dialog.remove();resolve(value)};
    cancelChoice=()=>finish(null);
    pendingDocsUploadChoices.add(cancelChoice);
    dialog.addEventListener('cancel',(e)=>{e.preventDefault();finish(null)},{once:true});
    dialog.addEventListener('close',()=>{if(dialog.isConnected)finish(null)},{once:true});
    dialog.querySelector('form').addEventListener('submit',(e)=>{
      e.preventDefault();
      const submitter=e.submitter?.value||'apply'; if(submitter==='cancel')return finish(null);
      const mode=dialog.querySelector('input[name="mode"]:checked')?.value||'new-set';
      const index=Number(dialog.querySelector('[data-target]')?.value||0);
      finish({mode,target:mode==='replace-set'?existing[index]||null:null});
    });
    try{dialog.showModal()}catch(_){finish(null)};
  });
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
  const selectionCurrent=window.__revexDocumentViewer.beginSelection();
  const context = captureProjectContext();
  if (!context.projectId) return;
  const frame = $('#docs-frame'), empty = $('#docs-empty');
  try {
    const base = file.localUrl || await Store.fileUrl(file.storagePath);
    if (!base) throw new Error('Document URL is unavailable.');
    if (!isCurrentProjectContext(context) || !selectionCurrent()) return;
    state.docSelection = { file, page: page || null, sheet: sheet || null, url: base };
    $('#docs-preview-title').textContent = sheet ? `${sheet.sheetNumber || `Page ${page}`} · ${sheet.sheetName || ''}` : (file.printingSetName || file.name || 'Document');
    $('#docs-preview-meta').textContent = [file.revision ? `REVEX ${file.revision}` : null, sheet?.currentRevision ? `Sheet revision ${sheet.currentRevision}` : null, page ? `page ${page}` : null, file.source === 'manual' ? 'manual file' : null].filter(Boolean).join(' · ') || 'Project document';
    $('#docs-copy-ref').disabled = false; $('#docs-open-external').disabled = false;
    const url = page ? `${base}#page=${page}` : base;
    window.__revexDocumentViewer.show(frame,state.docSelection);empty.hidden = true;
  } catch (error) {
    if (!isCurrentProjectContext(context)) return;
    frame.removeAttribute('src'); frame.hidden = true; empty.hidden = false; empty.textContent = error.message || 'Could not open document.';
  }
  if (!isCurrentProjectContext(context)) return;
  renderLibrary();
}

function renderLibrary() {
  if (window.__revexDocsPagesR115?.renderTree) { window.__revexDocsPagesR115.renderTree(); return; }
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
  const projectId=state.projectId;
  const activationToken=state.activationToken;
  const uid=Store.user?.uid || null;
  const sourceRevision=state.cloudState?.revision || null;
  const stillCurrent=()=>state.projectId===projectId&&state.activationToken===activationToken&&(Store.user?.uid||null)===uid;
  if (!projectId) return toast('Choose a project before uploading documents.', true);
  if (!Store.isCloud()) return toast('Sign in to upload project documents.', true);
  try {
    setSync(`Uploading ${files.length} project document${files.length===1?'':'s'}…`, 'busy');
    for (const file of [...files]) {
      const ext = String(file.name || '').split('.').pop().toLowerCase();
      let metadata = { manualInRevex: true };
      let folder = `${lane === 'out' ? 'record_out' : 'record_in'}/${/^(png|jpg|jpeg|gif|webp)$/i.test(ext)?'images':'docs'}`;
      if (ext === 'pdf') {
        const groups = docsPrintingGroups();
        const exactName = docsSetNameKey(file.name);
        const fallback = docsSetFallbackKey(file.name);
        let target = groups.find((g)=>g.nameKeys.has(exactName)) || null;
        // Fallback mapping is intentionally secondary so two genuinely different
        // sets with similar revision suffixes are not merged silently.
        if (!target && fallback) {
          const fallbackMatches = groups.filter((g)=>g.uniqueFallbackKeys?.has(fallback));
          if (fallbackMatches.length === 1) target = fallbackMatches[0];
        }
        let choice = target ? { mode:'replace-set', target, automatic:true } : await chooseDocsUploadTarget(file, groups);
        if (!choice) continue;
        if (!stillCurrent()) return;
        if (choice.mode !== 'manual') {
          const latest = choice.target?.rows?.[0] || null;
          const stableKey = latest ? docsSetStableKey(latest) : `manual:${docsSetNameKey(file.name)||Date.now().toString(36)}`;
          metadata = {
            manualInRevex: true,
            revexDocKind: 'printing-set',
            printingSetStableKey: stableKey,
            printingSetId: latest?.printingSetId || null,
            printingSetName: docsSetDisplayName(file.name),
            revision: inferDocsRevision(file.name),
            sheetIndex: [],
            setHidden: latest?.setHidden === true,
            replacedLibraryId: latest?.id || null,
            replacementMode: latest ? (choice.automatic ? 'name-match' : 'operator-selected') : 'new-set'
          };
          folder = `${lane === 'out' ? 'record_out' : 'record_in'}/printing_sets`;
        }
      }
      if (!stillCurrent()) return;
      const record = await Store.uploadLibraryFile(projectId, file, folder, metadata);
      // The upload belongs to the captured project even if the user navigates
      // elsewhere while it finishes; never redirect its history into another one.
      if ((Store.user?.uid||null)===uid) try { await Store.appendHistory(projectId, { sourceRevision, kind: 'document', operation: record.revexDocKind==='printing-set'?'printing-set-revision':'upload', label: record.revexDocKind==='printing-set'?`Printing set revision · ${record.printingSetName}`:`Document uploaded · ${file.name}`, before: record.replacedLibraryId ? { libraryId: record.replacedLibraryId } : null, after: { libraryId: record.id, name: record.name, printingSetName: record.printingSetName||null, printingSetStableKey: record.printingSetStableKey||null, revision: record.revision||null, folderPath: record.folderPath, size: record.size }, relatedId: record.id }); } catch (historyError) { console.warn('[REVEX] Docs history', historyError); }
      if (!stillCurrent()) return;
      state.library.unshift(record);
    }
    if (!stillCurrent()) return;
    renderLibrary(); setSync('Docs updated', 'good'); toast('Project document upload complete.');
  } catch (error) { if(!stillCurrent())return;setSync('Docs upload failed', 'bad'); toast(error.message || 'Document upload failed.', true); }
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

function clearProjectUrlBinding() {
  const safe = new URLSearchParams();
  if (currentParams().get('inShell')) safe.set('inShell', '1');
  const query = safe.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash || ''}`);
}

function restartAtProjectBoundary(projectId, view) {
  if (hardBoundaryNavigating) return true;
  const target = new URL(location.href);
  const next = new URLSearchParams();
  if (currentParams().get('inShell')) next.set('inShell', '1');
  if (projectId) next.set('projectId', projectId);
  if (view) next.set('view', view);
  target.search = next.toString();
  hardBoundaryNavigating = true;
  location.replace(target.href);
  return true;
}

function beginHardProjectBoundary(projectId, view) {
  if (hardBoundaryNavigating) return true;
  // Invalidate every in-flight callback before any old identity can be
  // observed by an older helper.  The replacement navigation gives each
  // project/account transition a clean JavaScript realm.
  state.activationToken += 1;
  state.unsubscribe?.(); state.unsubscribe = null;
  stopLiveProjectSubscriptions();
  state.projectId = ''; state.project = null;
  clearProjectBoundState();
  $('#project-select').value = '';
  renderAll(); showView(view || 'bim');
  return restartAtProjectBoundary(projectId, view || 'bim');
}

function clearProjectBoundState() {
  revisionHydrationToken++;
  state.cloudState=null;state.viewerData=null;state.designData=null;
  state.designEdits=new Map();state.chapterEdits=new Map();state.issues=[];state.library=[];
  state.historyEvents=[];state.bimOverlays=new Map();state.bimAppearances=new Map();state.derivedPlans=[];
  state.renderJobs=[];state.activeRenderJob=null;state.selectedElement=null;state.selectedDesign=null;
  state.selectedContext='';state.docSelection=null;state.chatConnId='';state.chatLoaded=false;state.activeChapter='';
  state.loadingRevision='';state.loadingProjectId='';state.viewerMode='';state.showHiddenOnly=false;
  state.preferredSpecId='';
  window.__revexCloudState=null;
  // Some extension modules historically fall back to the URL when state is
  // momentarily blank. Remove the former identity before emitting any reset.
  clearProjectUrlBinding();
  try{sessionStorage.removeItem('liber_revex_chat_draft')}catch(_){}
  for(const cancelChoice of [...pendingDocsUploadChoices])cancelChoice();
  const frame=$('#chat-frame');if(frame)frame.removeAttribute('src');
  const placeholder=$('#chat-placeholder');if(placeholder){placeholder.hidden=false;placeholder.textContent='Choose a project to load Project Chat.';}
  const docsFrame=$('#docs-frame');if(docsFrame){docsFrame.removeAttribute('src');docsFrame.hidden=true;}
  const docsEmpty=$('#docs-empty');if(docsEmpty){docsEmpty.hidden=false;docsEmpty.textContent='Select a document to preview it here.';}
  const docsTitle=$('#docs-preview-title');if(docsTitle)docsTitle.textContent='Select a document';
  const docsMeta=$('#docs-preview-meta');if(docsMeta)docsMeta.textContent='Full documents and exact sheet/page references open here.';
  const docsCopy=$('#docs-copy-ref');if(docsCopy)docsCopy.disabled=true;
  const docsExternal=$('#docs-open-external');if(docsExternal)docsExternal.disabled=true;
  const docsShare=$('#docs-share-sheet');if(docsShare)docsShare.hidden=true;
  const specFrame=$('#spec-frame');if(specFrame)specFrame.removeAttribute('src');
  $('.spec-frame-wrap')?.classList.remove('ready');
  pendingNativeRender=null;renderReturnFocus=null;
  const renderFrame=$('#render-frame');if(renderFrame){renderFrame.removeAttribute('src');renderFrame.hidden=true;delete renderFrame.dataset.loaded;}
  const renderDialog=$('#render-dialog');if(renderDialog)renderDialog.hidden=true;
  $('.render-workspace')?.classList.remove('ready');
  const issueDrawer=$('#issue-drawer');if(issueDrawer)issueDrawer.hidden=true;
  issueAnchor=null;issueReturnFocus=null;
  const lightbox=$('#design-image-lightbox');try{lightbox?.close?.()}catch(_){}
  const lightboxImage=$('#design-image-lightbox-image');if(lightboxImage)lightboxImage.removeAttribute('src');
  const lightboxCaption=$('#design-image-lightbox-caption');if(lightboxCaption)lightboxCaption.textContent='';
  const elementSearch=$('#element-search');if(elementSearch)elementSearch.value='';
  const inspector=$('#bim-inspector');if(inspector)inspector.innerHTML='<div class="eyebrow">BIM INSPECTOR</div><h2>Select an element</h2><p class="muted">Choose an element in the synced model to inspect it.</p>';
  const renderSource=$('#render-source');if(renderSource)renderSource.innerHTML='<span>Choose a synced BIM view before preparing a render.</span>';
  renderRenderHistory();
  const archive=$('#design-archive');if(archive){archive.hidden=true;archive.innerHTML='';}
  const energyConsent=$('#energy-consent-dialog');try{energyConsent?.close?.()}catch(_){}
  for(const id of ['energy-consent-project','energy-consent-revision','energy-consent-endpoint']){const node=$('#'+id);if(node)node.textContent='';}
  const energyFailure=$('#energy-exact-failure');if(energyFailure){energyFailure.hidden=true;energyFailure.innerHTML='';}
  const energyRun=$('#energy-run-status');if(energyRun){energyRun.textContent='Waiting for active-document Engineering evidence.';energyRun.dataset.tone='quiet';}
  const bim=activeBimViewer();
  if(bim){
    bim.loadToken=(Number(bim.loadToken)||0)+1;
    bim.clear?.();bim.data=null;bim.sourceState=null;bim.bounds=null;
    bim.byId?.clear?.();bim.byUid?.clear?.();bim.setOverlays?.([]);bim.setAppearances?.([]);
    bim.detailLoaded=false;bim.detailLoading=false;bim.proxyReady=false;bim.requestRender?.();
  }
  window.dispatchEvent(new CustomEvent('revex:project-boundary',{detail:{projectId:null}}));
  window.dispatchEvent(new CustomEvent('revex:history-data',{detail:{historyEvents:[],bimOverlays:[],derivedPlans:[]}}));
}

function stopLiveProjectSubscriptions(){
  for(const unsubscribe of state.liveUnsubscribers||[]){try{unsubscribe?.();}catch(_){}}
  state.liveUnsubscribers=[];
}

function publishHistoryState(){
  const overlays=[...state.bimOverlays.values()];
  activeBimViewer()?.setOverlays?.(overlays);
  window.dispatchEvent(new CustomEvent('revex:bim-overlays-changed',{detail:{overlays}}));
  window.dispatchEvent(new CustomEvent('revex:history-data',{detail:{historyEvents:state.historyEvents,bimOverlays:overlays,derivedPlans:state.derivedPlans}}));
}

function startLiveProjectSubscriptions(projectId){
  stopLiveProjectSubscriptions();
  if(!projectId||!Store.subscribeKind)return;
  const add=(unsubscribe)=>state.liveUnsubscribers.push(unsubscribe||(()=>{}));
  const current=()=>state.projectId===projectId;
  add(Store.subscribeKind(projectId,'design-item',rows=>{if(!current())return;state.designEdits=new Map(rows.map(row=>[row.revexId||row.id,{...row,id:row.revexId||row.id}]));renderDesign();renderDesignInspector();},5000));
  add(Store.subscribeKind(projectId,'design-chapter',rows=>{if(!current())return;state.chapterEdits=new Map(rows.map(row=>[row.revexId||row.id,{...row,id:row.revexId||row.id}]));renderDesign();renderDesignInspector();},500));
  add(Store.subscribeKind(projectId,'issue',rows=>{if(!current())return;state.issues=rows.map(row=>({...row,id:row.revexId||row.id})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));renderPins();},1000));
  add(Store.subscribeKind(projectId,'bim-overlay',rows=>{if(!current())return;state.bimOverlays=new Map(rows.map(row=>[String(row.uniqueId||row.elementId||row.revexId||row.id),{...row,id:row.revexId||row.id}]));publishHistoryState();renderModelTree();renderPins();},5000));
  add(Store.subscribeKind(projectId,'history',rows=>{if(!current())return;state.historyEvents=rows.map(row=>({...row,id:row.revexId||row.id})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));publishHistoryState();},2500));
  add(Store.subscribeKind(projectId,'derived-plan',rows=>{if(!current())return;state.derivedPlans=rows.map(row=>({...row,id:row.revexId||row.id})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));publishHistoryState();},500));
  if(Store.subscribeLibraryFiles)add(Store.subscribeLibraryFiles(projectId,rows=>{if(!current())return;state.library=rows;renderLibrary();}));
}

let revisionHydrationToken=0;
function settledValue(result,fallback){ return result?.status==='fulfilled' ? result.value : fallback; }
async function hydrateRevisionOverlays(cloudState,localPackage,revision,projectId,activationToken){
  const token=++revisionHydrationToken;
  const results=await Promise.allSettled([
    Store.listDesignEdits(projectId),Store.listChapterEdits(projectId),Store.listIssues(projectId),Store.listLibrary(projectId),
    Store.listHistory(projectId),Store.listBimOverlays(projectId),Store.listDerivedPlans(projectId)
  ]);
  if(token!==revisionHydrationToken||state.activationToken!==activationToken||state.projectId!==projectId||state.loadingProjectId!==projectId||state.loadingRevision!==revision)return;
  const [editsR,chapterR,issuesR,libraryR,historyR,overlayR,plansR]=results;
  for(const [label,result] of [['design edits',editsR],['chapter edits',chapterR],['issues',issuesR],['library',libraryR],['history',historyR],['BIM overlays',overlayR],['derived plans',plansR]]){
    if(result.status==='rejected')console.warn(`[REVEX] ${label} hydration`,result.reason);
  }
  const edits=settledValue(editsR,[]),chapterEdits=settledValue(chapterR,[]),issues=settledValue(issuesR,[]),library=settledValue(libraryR,[]),historyEvents=settledValue(historyR,[]),bimOverlays=settledValue(overlayR,[]),derivedPlans=settledValue(plansR,[]);
  state.designEdits=new Map(edits.map(r=>[r.id,r]));state.chapterEdits=new Map(chapterEdits.map(r=>[r.id,r]));state.issues=issues;state.library=library;state.historyEvents=historyEvents||[];state.bimOverlays=new Map((bimOverlays||[]).map(r=>[String(r.uniqueId||r.elementId||r.id),r]));state.derivedPlans=derivedPlans||[];
  renderPins();renderDesign();renderDesignInspector();renderLibrary();activeBimViewer()?.setOverlays?.(bimOverlays||[]);activeBimViewer()?.requestRender?.();window.dispatchEvent(new CustomEvent('revex:history-data', { detail: { historyEvents: state.historyEvents, bimOverlays: bimOverlays||[], derivedPlans: state.derivedPlans } }));
  if(!$('#view-spec')?.hidden)renderSpec();
}

async function fetchRevisionJson(url, timeoutMs = 15000) {
  if (!url) return null;
  const controller = window.AbortController ? new window.AbortController() : null;
  const timeout = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, { cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
    if (!response.ok) throw new Error(`Could not load synced data (${response.status})`);
    return await response.json();
  } catch (error) {
    if (controller?.signal.aborted) throw new Error(`Timed out loading the synced revision after ${Math.ceil(timeoutMs / 1000)} seconds`);
    throw error;
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }
}

async function loadCloudState(cloudState,localPackage=null,projectId=state.projectId,activationToken=state.activationToken){
  if(state.activationToken!==activationToken||state.projectId!==projectId)return;
  if(!cloudState&&!localPackage){revisionHydrationToken++;state.cloudState=null;window.__revexCloudState=null;state.loadingRevision='';state.loadingProjectId=projectId;state.viewerData=null;state.designData=null;state.designEdits=new Map();state.chapterEdits=new Map();state.issues=[];state.library=[];state.historyEvents=[];state.bimOverlays=new Map();state.derivedPlans=[];renderAll();setSync('No Revit sync yet','quiet');return;}
  const revision=localPackage?.revision||cloudState?.revision||'unknown';
  if(state.loadingProjectId===projectId&&state.loadingRevision===revision&&!localPackage&&state.viewerData&&state.designData)return;
  const previousLoadingRevision=state.loadingRevision,previousLoadingProjectId=state.loadingProjectId;state.loadingProjectId=projectId;state.loadingRevision=revision;setSync('Loading project revision…','busy');
  const viewerPromise=localPackage?.viewer?Promise.resolve(localPackage.viewer):(cloudState?.viewerUrl?fetchRevisionJson(cloudState.viewerUrl):Promise.resolve(null));
  const designPromise=localPackage?.design?Promise.resolve(localPackage.design):(cloudState?.designUrl?fetchRevisionJson(cloudState.designUrl):Promise.resolve(null));
  const [viewerResult,designResult]=await Promise.allSettled([viewerPromise,designPromise]);
  if(state.activationToken!==activationToken||state.projectId!==projectId||state.loadingProjectId!==projectId||state.loadingRevision!==revision)return;
  const viewerData=settledValue(viewerResult,null);
  const fetchedDesign=settledValue(designResult,null);
  if(viewerResult.status==='rejected')console.error('[REVEX] BIM index load',viewerResult.reason);
  if(designResult.status==='rejected')console.warn('[REVEX] Design Book source load',designResult.reason);
  const nextDesign=normalizeDesignSource(fetchedDesign,viewerData);
  if(!viewerData&&!nextDesign){state.loadingRevision=previousLoadingRevision;state.loadingProjectId=previousLoadingProjectId;setSync('Revision data unavailable · previous revision retained','bad');toast('The new BIM/Design revision could not load; the previous complete revision remains visible.',true);return;}
  // Shadow-page commit: keep the prior complete revision on screen while all
  // new source pointers resolve, then swap BIM + Design atomically.
  state.cloudState=cloudState||null;
  window.__revexCloudState=state.cloudState;
  state.viewerData=viewerData;
  state.designData=nextDesign;
  renderDesign();renderDesignInspector();
  if(viewerData){
    renderModelTree();renderPins();
    window.dispatchEvent(new CustomEvent('revex:source-revision-loaded', { detail: { revision, cloudState, localPackage, viewerData } }));
  }
  const sourceLabel=localPackage?.cloud===false?'Local preview':'Synced';
  if(!fetchedDesign&&state.designData){setSync(`${sourceLabel} · Design Book rebuilt from BIM index`,'quiet');}
  else setSync(`${sourceLabel} ${formatDate(localPackage?.syncedAt||cloudState?.syncedAt)}`,localPackage?.cloud===false?'quiet':'good');
  // User-authored overlays are independent of source files. Start immediately; never wait for browser idle.
  setTimeout(()=>hydrateRevisionOverlays(cloudState,localPackage,revision,projectId,activationToken),0);
}

async function activateProject(projectId,{explicitUserSelection=false,view=null,force=false}={}){
  projectId=String(projectId||'').trim();
  if(projectId&&projectId===state.projectId&&state.project&&!explicitUserSelection&&!force){if(view)showView(view);notifyNativeProject(false);return;}
  const previousProjectId=state.projectId;
  const changingProject=projectId!==previousProjectId;
  const liveParams=currentParams();
  const targetView=view||$('.main-nav [data-view].active')?.dataset.view||liveParams.get('view')||'bim';
  const activationToken=++state.activationToken;
  state.unsubscribe?.();state.unsubscribe=null;stopLiveProjectSubscriptions();
  if(changingProject){
    // A project boundary is also an account boundary. Blank the old project before
    // exposing a different project, rather than relying on later async hydration.
    state.projectId='';state.project=null;clearProjectBoundState();$('#project-select').value='';renderAll();showView(targetView);
    // Each project/account transition gets a fresh JavaScript realm.  Several
    // historical UI helpers run asynchronous work, and a clean navigation is
    // the only reliable boundary that prevents an old callback reaching B.
    if(previousProjectId&&restartAtProjectBoundary(projectId,targetView))return true;
  }
  state.projectId=projectId;state.project=null;
  try{
    const project=state.projects.find(r=>r.id===projectId)||(projectId?await Store.getProject(projectId):null);
    if(state.activationToken!==activationToken||state.projectId!==projectId)return;
    if(projectId&&!project)throw new Error('Project is unavailable or you no longer have access.');
    state.project=project;
    state.preferredSpecId=((liveParams.get('projectId')===projectId&&liveParams.get('specProjectId'))||state.project?.revexSpecProjectId||'');
    $('#project-select').value=state.projectId;notifyNativeProject(explicitUserSelection);
    if(!projectId){state.preferredSpecId='';showView(targetView);return;}
    if(!changingProject)showView(targetView);setSync('Loading project…','busy');
    const cloudState=await Store.getState(projectId);if(state.activationToken!==activationToken||state.projectId!==projectId)return;await loadCloudState(cloudState,null,projectId,activationToken);if(state.activationToken!==activationToken||state.projectId!==projectId)return;if(changingProject)showView(targetView);notifyNativeProject(explicitUserSelection);window.dispatchEvent(new CustomEvent('revex:authoritative-project-bound',{detail:{projectId,source:explicitUserSelection?'explicit-user-selection':'atomic-project-activation'}}));
    state.unsubscribe=Store.subscribeState(projectId,next=>{if(state.activationToken!==activationToken||state.projectId!==projectId)return;window.__revexCloudState=next||null;if(next?.revision&&next.revision!==state.cloudState?.revision)loadCloudState(next,null,projectId,activationToken);else if(next){state.cloudState=next;if(!$('#view-spec')?.hidden)renderSpec();}});
    startLiveProjectSubscriptions(projectId);
    Promise.allSettled([Store.ensureSpecProject(projectId,state.preferredSpecId||state.project?.revexSpecProjectId,state.project),Store.listRenderJobs(projectId)]).then(([specResult,renderResult])=>{
      if(state.activationToken!==activationToken||state.projectId!==projectId)return;
      if(specResult.status==='fulfilled')state.preferredSpecId=specResult.value||state.preferredSpecId||'';else console.warn('[REVEX] Spec Book projection pending',specResult.reason);
      state.renderJobs=renderResult.status==='fulfilled'?(renderResult.value||[]):[];
      if(state.project&&state.preferredSpecId)state.project.revexSpecProjectId=state.preferredSpecId;
      renderRenderHistory();notifyNativeProject();if(!$('#view-spec')?.hidden)renderSpec();
    });
    if(currentParams().get('render')==='1')openRenderDialog();
  }catch(error){if(state.activationToken!==activationToken||state.projectId!==projectId)return;if(changingProject||!state.project){state.projectId='';state.project=null;clearProjectBoundState();$('#project-select').value='';renderAll();showView(targetView);}setSync('Project unavailable','bad');toast(error.message,true);}
}

async function handleSyncFiles(files) {
  if (!files?.length) return;
  if(window.__liberRevexPublicationBusy)return;
  window.__liberRevexPublicationBusy=true;
  const syncStartToken=state.activationToken;
  const syncStartUid=Store.user?.uid || null;
  let appliedToken=syncStartToken;
  let packageProjectId='',packageRevision='',packageSha256='',publicationAcknowledged=false,cloudPublished=false;
  const acknowledge=(ok,cloud,error=null,receiptId=null)=>{
    try{window.chrome?.webview?.postMessage({type:'liber:revex-sync-result',ok,cloud,projectId:packageProjectId,revision:packageRevision,packageSha256,publisherUid:syncStartUid,publicationReceiptId:receiptId,error});}catch(_){}
  };
  try {
    setSync('Validating Revit package…', 'busy');
    const projectFile=[...files].find(file=>String(file.name||'').toLowerCase()==='project.json');
    if(!projectFile)throw new Error('The active Revit package is missing project.json.');
    const projectManifest=JSON.parse(await projectFile.text());
    packageProjectId=String(projectManifest?.central?.projectId||'').trim();
    if(!packageProjectId)throw new Error('The active Revit package has no exact evidence-bound project ID.');
    const integrityFile=[...files].find(file=>String(file.name||'').toLowerCase()==='integrity.json');
    if(!integrityFile)throw new Error('The active Revit package is missing integrity.json.');
    const integrityBytes=await integrityFile.arrayBuffer();
    packageRevision=String(JSON.parse(new TextDecoder().decode(integrityBytes)).revision||'');
    packageSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',integrityBytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
    if((Store.user?.uid||null)!==syncStartUid)throw new Error('The LIBER account changed before publication.');
    const packageSpecId=`spec_${packageProjectId.replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120).replace(/\./g,'_')}`;
    const result = await Store.syncPackage(files, packageProjectId, packageSpecId);
    // The cloud receipt acknowledges publication, not expensive viewer hydration.
    // A renderer failure or project navigation must not cause another full upload.
    cloudPublished=Boolean(result.cloud);
    acknowledge(true,cloudPublished,null,result.publicationReceipt?.id||null);
    publicationAcknowledged=true;
    if(state.activationToken!==syncStartToken||(Store.user?.uid||null)!==syncStartUid)return;
    if(result.reusedPublication||result.resumedRevision){
      toast(result.reusedPublication?'This Revit revision is already published; no files were uploaded again.':'Revit revision publication completed.');
      // Open the authoritative current revision, never replay an older package
      // over a newer model that is already visible in this project.
      if(!result.reusedPublication||result.projectId!==state.projectId||!state.cloudState||!state.viewerData)
        await activateProject(result.projectId,{view:'bim',force:true});
      else{setSync('Revision already published','good');showView('bim');}
      return;
    }
    if(result.projectId!==state.projectId&&state.projectId){
      if(await activateProject(result.projectId,{view:'bim',force:true}))return;
    }
    const changingProject=result.projectId!==state.projectId;
    appliedToken=++state.activationToken;
    state.unsubscribe?.();state.unsubscribe=null;stopLiveProjectSubscriptions();
    if(changingProject){state.projectId='';state.project=null;clearProjectBoundState();$('#project-select').value='';renderAll();showView('bim');}
    state.projectId = result.projectId;
    state.project = state.projects.find((row) => row.id === result.projectId) || await Store.getProject(result.projectId);
    if(state.activationToken!==appliedToken||(Store.user?.uid||null)!==syncStartUid)return;
    if(state.project&&!state.projects.some((row)=>row.id===state.project.id)){state.projects.unshift(state.project);renderProjects();}
    state.preferredSpecId=result.specProjectId||packageSpecId;
    $('#project-select').value = state.projectId;
    await loadCloudState(result, result, result.projectId, appliedToken);
    if(state.activationToken!==appliedToken||state.projectId!==result.projectId||(Store.user?.uid||null)!==syncStartUid)return;
    if(result.cloud){state.unsubscribe=Store.subscribeState(result.projectId,next=>{if(state.activationToken!==appliedToken||state.projectId!==result.projectId)return;window.__revexCloudState=next||null;if(next?.revision&&next.revision!==state.cloudState?.revision)loadCloudState(next,null,result.projectId,appliedToken);else if(next){state.cloudState=next;if(!$('#view-spec')?.hidden)renderSpec();}});startLiveProjectSubscriptions(result.projectId);}
    showView('bim');
    toast(result.cloud ? 'Revit revision published to the live Companion.' : 'Local preview loaded. Sign in to publish it across devices.');
  } catch (error) {
    if(!publicationAcknowledged)acknowledge(false,false,error.message||'REVEX sync failed.');
    if(state.activationToken!==appliedToken||(Store.user?.uid||null)!==syncStartUid)return;
    setSync(publicationAcknowledged?(cloudPublished?'Published · viewer could not load':'Local preview could not load'):'Sync failed', 'bad'); toast(error.message || 'REVEX sync failed.', true);
  } finally { window.__liberRevexPublicationBusy=false;$('#revex-sync-upload').value = ''; }
}

function announcePublicationReady(){
  window.__liberRevexPublicationReady=Boolean(appInitialized&&Store.isCloud()&&navigator.onLine!==false);
  if(window.__liberRevexPublicationReady){try{window.chrome?.webview?.postMessage({type:'liber:revex-publication-ready',projectId:state.projectId||null});}catch(_){}}
}
window.addEventListener('online',announcePublicationReady);
window.addEventListener('offline',()=>{window.__liberRevexPublicationReady=false;});
window.addEventListener('revex:authoritative-project-bound',announcePublicationReady);

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
  const context = captureProjectContext();
  const anchor = issueAnchor;
  if (!context.projectId || !anchor || !isCurrentProjectContext(context)) return;
  const sourceRevision = state.cloudState?.revision || null;
  const selectedLevel = state.selectedElement?.level || null;
  const issue = {
    title: $('#issue-title').value.trim(), body: $('#issue-body').value.trim(), status: $('#issue-status').value,
    anchorKind: anchor.kind,
    anchorElementId: anchor.element?.id || null,
    anchorUniqueId: anchor.element?.uniqueId || null,
    anchorDesignItemId: anchor.item?.id || null,
    anchorLabel: anchor.element?.name || anchor.item?.label || null,
    revision: sourceRevision
  };
  try {
    setSync('Saving issue…', 'busy');
    const saved = await Store.addIssue(context.projectId, issue);
    if (!isCurrentProjectContext(context)) return;
    try { await Store.appendHistory(context.projectId, { sourceRevision, kind: 'issue', operation: 'create', label: `Issue · ${saved.title}`, affectedElementIds: saved.anchorElementId ? [saved.anchorElementId] : [], affectedUniqueIds: saved.anchorUniqueId ? [saved.anchorUniqueId] : [], affectedLevels: selectedLevel ? [selectedLevel] : [], before: null, after: saved, relatedId: saved.id }); } catch (historyError) { console.warn('[REVEX] Issue history', historyError); }
    if (!isCurrentProjectContext(context)) return;
    state.issues.unshift(saved);
    closeIssue(); renderPins();
    if (state.selectedElement) selectElement(state.selectedElement, false);
    setSync('Issue saved', Store.isCloud() ? 'good' : 'quiet'); toast('Issue saved outside the RVT.');
  } catch (error) { if(isCurrentProjectContext(context)){setSync('Issue save failed', 'bad'); toast(error.message, true);} }
});

$$('.main-nav [data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('.main-nav .revex-tabs')?.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = $$('.main-nav [data-view]');
  if (!tabs.length) return;
  const current = Math.max(0, tabs.indexOf(document.activeElement));
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  showView(tabs[next].dataset.view);
});
$('#rail-toggle').addEventListener('click', toggleWorkspaceRail);
$('#rail-scrim').addEventListener('click', closeWorkspaceRail);
window.addEventListener('revex:viewer-mode', (event) => {
  state.viewerMode = event.detail?.mode || '';
  renderModelTree();
});

const projectSelect = $('#project-select');
// This runs before historical bubble listeners.  A selector change is a hard
// trust boundary, not a same-document state swap: stop older handlers from
// starting work for A after the user has selected B.
projectSelect.addEventListener('change', (event) => {
  const nextProjectId = String(event.currentTarget?.value || '').trim();
  if (!state.projectId || nextProjectId === state.projectId || hardBoundaryNavigating) return;
  event.stopImmediatePropagation();
  beginHardProjectBoundary(nextProjectId, $('.main-nav [data-view].active')?.dataset.view || 'bim');
}, true);
projectSelect.addEventListener('change', () => activateProject(projectSelect.value,{explicitUserSelection:true}));

window.addEventListener('revex:native-project-binding',(event)=>{
  const detail=event.detail||{};
  const projectId=String(detail.projectId||'').trim();
  if(!projectId || !state.projectId || projectId===state.projectId || hardBoundaryNavigating)return;
  // Capture phase prevents legacy listeners from beginning a stale, in-page
  // activation before the fresh project realm replaces this one.
  event.stopImmediatePropagation();
  beginHardProjectBoundary(projectId,String(detail.view||'bim'));
},true);
window.addEventListener('revex:native-project-binding',(event)=>{
  const detail=event.detail||{};
  const projectId=String(detail.projectId||'').trim();
  if(!projectId)return;
  if(detail.specProjectId)state.preferredSpecId=String(detail.specProjectId);
  activateProject(projectId,{view:String(detail.view||'bim')}).catch(error=>{
    setSync('Bound project unavailable','bad');toast(error.message||'Could not activate the Revit-bound project.',true);
  });
});
$('#new-project-button').addEventListener('click', openProjectDialog);
$('#empty-create-button').addEventListener('click', openProjectDialog);
$('#empty-connect-button').addEventListener('click', connectExistingProject);
$('#project-form').addEventListener('submit', createProject);
$('#project-close').addEventListener('click', closeProjectDialog);
$('#project-cancel').addEventListener('click', closeProjectDialog);
$('#project-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeProjectDialog(); });
$('#sync-button').addEventListener('click', () => $('#revex-sync-upload').click());
$('#empty-sync-button').addEventListener('click', () => $('#revex-sync-upload').click());
$('#revex-sync-upload').addEventListener('change', (event) => handleSyncFiles(event.target.files));
$('#element-search').addEventListener('input', renderModelTree);
$('#show-hidden-elements')?.addEventListener('click', (event) => {
  state.showHiddenOnly = !state.showHiddenOnly;
  event.currentTarget.setAttribute('aria-pressed', String(state.showHiddenOnly));
  event.currentTarget.classList.toggle('active', state.showHiddenOnly);
  event.currentTarget.textContent = state.showHiddenOnly ? 'Show all elements' : 'Show hidden only';
  renderModelTree();
});
window.addEventListener('revex:bim-overlays-changed', (event) => {
  const rows = event.detail?.overlays || [];
  state.bimOverlays = new Map(rows.map(row => [String(row.uniqueId || row.elementId || row.id), row]));
  renderModelTree();
});
let designGallery = [], designGalleryIndex = 0;
function showDesignGalleryImage() {
  const image=designGallery[designGalleryIndex];if(!image)return;
  $('#design-image-lightbox-image').src=image.url;
  $('#design-image-lightbox-image').alt=image.name;
  $('#design-image-lightbox-caption').textContent=`${image.name} · ${designGalleryIndex+1} of ${designGallery.length}`;
  $('#design-image-previous').hidden=designGallery.length<2;$('#design-image-next').hidden=designGallery.length<2;
}
function moveDesignGallery(delta) {if(!designGallery.length)return;designGalleryIndex=(designGalleryIndex+delta+designGallery.length)%designGallery.length;showDesignGalleryImage();}
document.addEventListener('click', (event) => {
  const image = event.target.closest?.('.design-image img, .lane-images img, .image-strip img, .design-book-image');
  if (!image) return;
  event.preventDefault();event.stopPropagation();
  const dialog = $('#design-image-lightbox');
  const owner=image.closest('.lane-images,.image-strip,#design-grid,#design-book-rows');
  const images=owner?[...owner.querySelectorAll('img')]:[image];
  designGallery=images.map(row=>({url:row.currentSrc||row.src,name:row.alt||'Design Book visual'}));designGalleryIndex=Math.max(0,images.indexOf(image));showDesignGalleryImage();
  dialog?.showModal?.();
});
$('#design-image-previous')?.addEventListener('click',()=>moveDesignGallery(-1));$('#design-image-next')?.addEventListener('click',()=>moveDesignGallery(1));
document.addEventListener('keydown',event=>{if($('#design-image-lightbox')?.open&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();moveDesignGallery(event.key==='ArrowLeft'?-1:1);}else if(['Enter',' '].includes(event.key)&&event.target.matches?.('img[role="button"]')){event.preventDefault();event.target.click();}});
window.addEventListener('revex:project-boundary',()=>{designGallery=[];designGalleryIndex=0;});
$('#design-image-lightbox-close')?.addEventListener('click', () => $('#design-image-lightbox')?.close());
$('#design-image-lightbox')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
for (const id of ['fit-model','fit-model-rail']) $('#'+id)?.addEventListener('click', () => { viewer?.fit(); $('#walk-toggle')?.classList.remove('active'); });
$('#walk-toggle')?.addEventListener('click', (event) => { const on=!event.currentTarget.classList.contains('active'); event.currentTarget.classList.toggle('active',on); viewer?.toggleWalk(on); });
$('#walk-floor')?.addEventListener('change', (event) => viewer?.setWalkFloor(Number(event.target.value)||0));
$('#walk-height')?.addEventListener('input', (event) => viewer?.setWalkHeight(event.target.value));
$('#walk-fov')?.addEventListener('input', (event) => viewer?.setFov(event.target.value));
$('#section-toggle')?.addEventListener('click', (event) => { const on=!event.currentTarget.classList.contains('active'); event.currentTarget.classList.toggle('active',on); event.currentTarget.setAttribute('aria-expanded',String(on)); $('#section-panel').hidden=!on; viewer?.setSectionEnabled(on); });
for (const [id,axis] of [['section-x','x'],['section-y','y'],['section-z','z']]) $('#'+id)?.addEventListener('input', (event) => viewer?.setSectionAxis(axis, Number(event.target.value)/100));
$('#section-reset')?.addEventListener('click', () => { for (const id of ['section-x','section-y','section-z']) $('#'+id).value='100'; viewer?.resetSection(); });
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
    // Only the same-origin Liber shell may change app routing.  Do not accept
    // a detached iframe/window message that can smuggle A's spec identity
    // into B while a transition is underway.
    if (event.origin !== location.origin || event.source !== window.parent) return;
    const requestedProjectId = String(data.params?.projectId || '').trim();
    if (data.params?.specProjectId && requestedProjectId && requestedProjectId === state.projectId) {
      state.preferredSpecId = String(data.params.specProjectId);
    }
    if (requestedProjectId && requestedProjectId !== state.projectId) activateProject(requestedProjectId);
    if (data.params?.view) showView(data.params.view);
    if (data.params?.render === '1') openRenderDialog();
  }
});
try { window.chrome?.webview?.addEventListener('message', (event) => handleNativeRenderStatus(event.data || {})); } catch (_) {}

function runPendingAuthReconcile() {
  if (!appInitialized || !pendingAuthReconcile || authReconcileQueued) return;
  const generation = authReconcileGeneration;
  authReconcileQueued = true;
  Promise.resolve().then(async () => {
    authReconcileQueued = false;
    if (generation !== authReconcileGeneration) return runPendingAuthReconcile();
    pendingAuthReconcile = false;
    const activeProjectId = state.projectId;
    const activeView = $('.main-nav [data-view].active')?.dataset.view || 'bim';
    const cloud = Store.isCloud();
    const uid = Store.user?.uid || null;
    const identityChanged = uid !== reconciledAuthUid;
    // Never keep an old account's state on screen while we discover the new
    // account's accessible projects. This also cancels stale model hydration.
    if (identityChanged) {
      if(await activateProject('', { force: true, view: activeView }))return;
      state.projects=[];renderProjects();
    }
    if (generation !== authReconcileGeneration || cloud !== Store.isCloud() || uid !== (Store.user?.uid || null)) {
      pendingAuthReconcile = true;
      return runPendingAuthReconcile();
    }
    if (!cloud) {
      reconciledAuthUid=null;
      setSync('Sign in for live project sync', 'quiet');
      return;
    }
    let projects;
    try { projects=await Store.listProjects(); }
    catch (error) {
      if (generation !== authReconcileGeneration) return;
      setSync('Live projects could not be refreshed. Reload to retry.', 'bad');
      console.warn('[REVEX] auth project refresh', error);
      return;
    }
    if (generation !== authReconcileGeneration || !Store.isCloud() || uid !== (Store.user?.uid || null)) {
      pendingAuthReconcile = true;
      return runPendingAuthReconcile();
    }
    // Do not clobber a project selection made while the auth refresh was running.
    if (state.projectId) { reconciledAuthUid=uid; return; }
    state.projects=projects;
    if (!identityChanged && activeProjectId && !projects.some((project) => project.id === activeProjectId) && state.project) {
      state.projects=[state.project,...projects];
    }
    renderProjects();
    reconciledAuthUid=uid;
    if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
      await activateProject(activeProjectId, { force: true, view: activeView });
      return;
    }
    if (projects.length === 1) { await activateProject(projects[0].id, { force: true, view: activeView }); return; }
    setSync(projects.length ? 'Choose a project to start' : 'No accessible REVEX projects found', 'quiet');
  }).catch((error) => {
    console.warn('[REVEX] auth reconciliation', error);
  }).finally(announcePublicationReady);
}

window.addEventListener('revex:auth-mode-changed', (event) => {
  // Initial sign-in confirmation belongs to this page's requested project.
  // Only a later identity change invalidates that route and its loaded data.
  if (event.detail?.initialAuthState) return;
  if (!state.projectId || hardBoundaryNavigating) return;
  // Auth identity changes must blank the old project before any legacy
  // listener can reconcile data into the new account.
  event.stopImmediatePropagation();
  beginHardProjectBoundary('', $('.main-nav [data-view].active')?.dataset.view || 'bim');
}, true);

window.addEventListener('revex:auth-mode-changed', () => {
  pendingAuthReconcile = true;
  authReconcileGeneration += 1;
  runPendingAuthReconcile();
});

async function init() {
  setSync('Connecting to LIBER…', 'busy');
  await Store.init();
  const initialCloud = Store.isCloud();
  const initialUid = Store.user?.uid || null;
  state.projects = await Store.listProjects();
  renderProjects();
  if (!initialCloud) setSync('Sign in for live project sync', 'quiet');
  else if (!state.projectId && state.projects.length !== 1) {
    setSync(state.projects.length ? 'Choose a project to start' : 'Create or connect a project to start', 'quiet');
  }
  if (state.projectId) await activateProject(state.projectId);
  else {
    showView('bim');
    if (state.projects.length === 1) await activateProject(state.projects[0].id);
  }
  appInitialized = true;
  announcePublicationReady();
  const finalUid=Store.user?.uid || null;
  if (Store.isCloud() !== initialCloud || finalUid !== initialUid) {
    reconciledAuthUid=initialUid;
    pendingAuthReconcile=true;
    runPendingAuthReconcile();
  } else {
    reconciledAuthUid=finalUid;
    pendingAuthReconcile=false;
  }
}

const appStartup = init();
appStartup.catch((error) => {
  console.error(error);
  state.activationToken += 1;
  state.unsubscribe?.(); state.unsubscribe = null; stopLiveProjectSubscriptions();
  state.projectId = ''; state.project = null; clearProjectBoundState(); renderAll(); showView('bim');
  setSync('REVEX could not start', 'bad'); toast(error.message, true);
  // Set retry eligibility only after the existing failure cleanup completes.
  appStartupFailed = true;
  const connect = $('#empty-connect-button');
  if (connect) connect.textContent = 'Retry connection';
});
