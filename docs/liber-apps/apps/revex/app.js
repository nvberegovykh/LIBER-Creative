
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
  loadingRevision: ''
};

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

async function openProjectChat(context = state.selectedContext) {
  if (!state.projectId) return toast('Choose a LIBER project first.', true);
  try {
    setSync('Opening project chat…', 'busy');
    const result = await Store.ensureProjectChat(state.projectId);
    if (!result?.connId) throw new Error('No project connection was returned.');
    if (context) sessionStorage.setItem('liber_revex_chat_draft', context);
    const url = appUrl('secure-chat', { connId: result.connId });
    openInLiberShell('secure-chat', 'Connections', url);
    setSync(state.cloudState ? `Synced ${formatDate(state.cloudState.syncedAt)}` : 'Project connected', 'good');
  } catch (error) {
    setSync('Chat unavailable', 'bad');
    toast(error.message || 'Could not open Project Chat.', true);
  }
}

// BIM rendering is owned exclusively by viewer-r21.js.
let viewer = null;
function activeBimViewer(){ return window.__revexViewerR21Instance || viewer || null; }

function showView(name) {
  closeWorkspaceRail();
  const hasProject = Boolean(state.projectId);
  $('#view-empty').hidden = hasProject;
  for (const view of ['bim', 'design', 'spec', 'docs', 'chat']) $(`#view-${view}`).hidden = !hasProject || view !== name;
  $$('.main-nav [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  if (hasProject) {
    history.replaceState(null, '', `${location.pathname}?${new URLSearchParams({ ...(params.get('inShell') ? { inShell: '1' } : {}), projectId: state.projectId, ...(state.preferredSpecId ? { specProjectId: state.preferredSpecId } : {}), view: name })}`);
    if (name === 'bim') setTimeout(() => activeBimViewer()?.resize?.(), 0);
    if (name === 'spec') renderSpec();
    if (name === 'chat') renderChatContext();
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

function renderModelTree() {
  const data = state.viewerData;
  const elements = data?.elements || [];
  $('#model-title').textContent = data?.source?.documentTitle || state.cloudState?.central?.documentTitle || 'No model synced';
  $('#model-facts').innerHTML = state.cloudState ? `
    <div class="fact"><strong>${elements.length.toLocaleString()}</strong><span>visible elements</span></div>
    <div class="fact"><strong>${(data?.source?.viewName || '3D').slice(0, 20)}</strong><span>Revit view</span></div>
    <div class="fact"><strong>${state.cloudState.scheduleCount || state.designData?.schedules?.length || 0}</strong><span>schedules</span></div>
    <div class="fact"><strong>${state.viewerMode === 'fallback' ? 'Proxy' : state.viewerMode === 'fbx' ? 'FBX' : 'Ready'}</strong><span>geometry</span></div>` : '';
  const groups = new Map();
  elements.forEach((element) => {
    const category = element.category || 'Other';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(element);
  });
  const q = $('#element-search').value.trim().toLowerCase();
  let shown = 0;
  const chunks = [];
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([category, rows]) => {
    const matching = rows.filter((row) => !q || `${row.id} ${row.category} ${row.name} ${row.type} ${(row.materials || []).map((m) => m.name).join(' ')}`.toLowerCase().includes(q));
    if (!matching.length || shown >= 3000) return;
    chunks.push(`<div class="tree-group">${escapeHtml(category)} · ${matching.length}</div>`);
    for (const row of matching.slice(0, Math.max(3000 - shown, 0))) {
      shown += 1;
      chunks.push(`<button class="tree-item${String(state.selectedElement?.id) === String(row.id) ? ' active' : ''}" data-element-id="${escapeHtml(row.id)}"><span>${escapeHtml(row.name || row.type || category)}</span><span class="tree-id">${escapeHtml(row.id)}</span></button>`);
    }
  });
  if (elements.length > shown && !q) chunks.push(`<p class="muted">Showing the first ${shown.toLocaleString()} elements. Search to find the rest.</p>`);
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
  $('#issue-pins').innerHTML = state.issues.filter((issue) => issue.anchorElementId).map((issue, index) =>
    `<button class="issue-pin ${escapeHtml(issue.status || 'open')}" data-id="${escapeHtml(issue.id)}" type="button" title="${escapeHtml(issue.title)}">${index + 1}</button>`
  ).join('');
  $$('.issue-pin', $('#issue-pins')).forEach((pin) => pin.addEventListener('click', () => {
    const issue = state.issues.find((row) => row.id === pin.dataset.id);
    const element = viewer?.elementById.get(String(issue?.anchorElementId));
    if (element) selectElement(element, true);
  }));
}

function mergedItem(item) {
  return { ...item, ...(state.designEdits.get(item.id) || {}) };
}

function chapters() { return state.designData?.chapters || []; }

function mergedChapter(chapter) {
  return { ...chapter, ...(state.chapterEdits.get(chapter.id) || {}) };
}

function openDesignPosition(chapter, sourceItem, switchView = false) {
  state.activeChapter = chapter.id;
  state.selectedDesign = { ...mergedItem(sourceItem), chapterTitle: chapter.title };
  state.selectedElement = null;
  state.selectedContext = contextFor('Design', state.selectedDesign);
  if (switchView) showView('design');
  renderDesign();
  renderDesignInspector();
}

function renderDesign() {
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
    images: item.images || []
  };
  try {
    setSync('Saving Design Book…', 'busy');
    const saved = await Store.saveDesignEdit(state.projectId, item.id, patch);
    state.designEdits.set(item.id, { ...(state.designEdits.get(item.id) || {}), ...saved });
    state.selectedDesign = { ...item, ...saved };
    state.selectedContext = contextFor('Design', state.selectedDesign);
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
    const images = await Store.uploadDesignImage(state.projectId, state.selectedDesign.id, file, state.selectedDesign.images || []);
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

function renderLibrary() {
  const groups = { in: [], out: [] };
  state.library.forEach((file) => {
    const folder = file.folderPath || '';
    if (folder.startsWith('record_out')) groups.out.push(file); else if (folder.startsWith('record_in')) groups.in.push(file);
  });
  const render = (rows) => rows.length ? rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map((file) => {
    const ext = String(file.name || '').split('.').pop().slice(0, 4).toUpperCase();
    return `<div class="file-row"><span class="file-kind">${escapeHtml(ext || 'FILE')}</span><a href="#" data-storage-path="${escapeHtml(file.storagePath || '')}">${escapeHtml(file.name || 'file')}</a><small>${formatDate(file.createdAt)}</small></div>`;
  }).join('') : '<div class="file-empty">No project files in this folder.</div>';
  $('#docs-in').innerHTML = render(groups.in);
  $('#docs-out').innerHTML = render(groups.out);
  $$('.file-row a').forEach((link) => link.addEventListener('click', async (event) => {
    event.preventDefault();
    try { const url = await Store.fileUrl(link.dataset.storagePath); if (url) window.open(url, '_blank', 'noopener'); }
    catch (error) { toast(error.message || 'Could not open file.', true); }
  }));
}

function renderChatContext() {
  $('#chat-context').textContent = state.selectedContext || 'Select a BIM element or Design Book position to carry its context into the conversation.';
}

function renderAll() {
  renderModelTree(); renderPins(); renderDesign(); renderDesignInspector(); renderLibrary(); renderChatContext();
}

let revisionHydrationToken=0;
async function hydrateRevisionOverlays(cloudState,localPackage,revision){
  const token=++revisionHydrationToken;
  try{
    const [designData,edits,chapterEdits,issues,library]=await Promise.all([
      localPackage?.design||(cloudState?.designUrl?Store.fetchJson(cloudState.designUrl):Promise.resolve(null)),
      Store.listDesignEdits(state.projectId),Store.listChapterEdits(state.projectId),Store.listIssues(state.projectId),Store.listLibrary(state.projectId)
    ]);
    if(token!==revisionHydrationToken||state.loadingRevision!==revision)return;
    state.designData=designData;state.designEdits=new Map(edits.map(r=>[r.id,r]));state.chapterEdits=new Map(chapterEdits.map(r=>[r.id,r]));state.issues=issues;state.library=library;
    renderPins();renderDesign();renderDesignInspector();renderLibrary();activeBimViewer()?.requestRender?.();
    if(!$('#view-spec')?.hidden)renderSpec();
  }catch(error){console.warn('[REVEX] deferred revision overlays',error);}
}

async function loadCloudState(cloudState,localPackage=null){
  state.cloudState=cloudState||null;
  if(!cloudState&&!localPackage){revisionHydrationToken++;state.viewerData=null;state.designData=null;state.designEdits=new Map();state.chapterEdits=new Map();state.issues=[];state.library=[];renderAll();setSync('No Revit sync yet','quiet');return;}
  const revision=localPackage?.revision||cloudState?.revision||'unknown';
  if(state.loadingRevision===revision&&!localPackage)return;
  state.loadingRevision=revision;setSync('Loading BIM revision…','busy');
  try{
    const viewerData=localPackage?.viewer||await Store.fetchJson(cloudState.viewerUrl);
    state.viewerData=viewerData;renderModelTree();renderPins();
    setSync(`${localPackage?.cloud===false?'Local preview':'Synced'} ${formatDate(localPackage?.syncedAt||cloudState.syncedAt)}`,localPackage?.cloud===false?'quiet':'good');
    const hydrate=()=>hydrateRevisionOverlays(cloudState,localPackage,revision);
    if('requestIdleCallback'in window)requestIdleCallback(hydrate,{timeout:700});else setTimeout(hydrate,0);
  }catch(error){console.error('[REVEX] load revision',error);setSync('Revision load failed','bad');toast(error.message,true);}
}

async function activateProject(projectId){
  state.unsubscribe?.();state.unsubscribe=null;state.projectId=projectId||'';
  state.project=state.projects.find(r=>r.id===projectId)||(projectId?await Store.getProject(projectId):null);
  state.preferredSpecId=((params.get('projectId')===projectId&&params.get('specProjectId'))||state.project?.revexSpecProjectId||'');
  $('#project-select').value=state.projectId;notifyNativeProject();
  if(!projectId){state.preferredSpecId='';showView('bim');return;}
  showView(params.get('view')||'bim');setSync('Loading project…','busy');
  try{
    const cloudState=await Store.getState(projectId);await loadCloudState(cloudState);notifyNativeProject();
    state.unsubscribe=Store.subscribeState(projectId,next=>{if(next?.revision&&next.revision!==state.cloudState?.revision)loadCloudState(next);else if(next){state.cloudState=next;if(!$('#view-spec')?.hidden)renderSpec();}});
    Promise.all([Store.ensureSpecProject(projectId,state.preferredSpecId||state.project?.revexSpecProjectId,state.project),Store.listRenderJobs(projectId)]).then(([specId,jobs])=>{
      if(state.projectId!==projectId)return;state.preferredSpecId=specId||state.preferredSpecId||'';state.renderJobs=jobs||[];if(state.project)state.project.revexSpecProjectId=state.preferredSpecId;renderRenderHistory();notifyNativeProject();if(!$('#view-spec')?.hidden)renderSpec();
    }).catch(error=>console.warn('[REVEX] deferred project services',error));
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
    state.issues.unshift(saved); closeIssue(); renderPins();
    if (state.selectedElement) selectElement(state.selectedElement, false);
    setSync('Issue saved', Store.isCloud() ? 'good' : 'quiet'); toast('Issue saved outside the RVT.');
  } catch (error) { setSync('Issue save failed', 'bad'); toast(error.message, true); }
});

$$('.main-nav [data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('#rail-toggle').addEventListener('click', toggleWorkspaceRail);
$('#rail-scrim').addEventListener('click', closeWorkspaceRail);
$('#project-select').addEventListener('change', () => activateProject($('#project-select').value));
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
$('#fit-model').addEventListener('click', () => viewer?.fit());
$('#model-edges').addEventListener('click', (event) => { event.currentTarget.classList.toggle('active'); viewer?.toggleEdges(event.currentTarget.classList.contains('active')); });
$('#model-grid').addEventListener('click', (event) => { event.currentTarget.classList.toggle('active'); if (viewer) viewer.grid.visible = event.currentTarget.classList.contains('active'); });
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
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('#render-dialog').hidden) closeRenderDialog();
  else if (!$('#project-dialog').hidden) closeProjectDialog();
  else if (!$('#issue-drawer').hidden) closeIssue();
  else closeWorkspaceRail();
});
window.addEventListener('resize', () => { if (innerWidth > 860) closeWorkspaceRail(); });
$('#open-chat').addEventListener('click', () => openProjectChat());
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
    showView('bim');
    if (state.projects.length === 1) await activateProject(state.projects[0].id);
  }
}

init().catch((error) => { console.error(error); setSync('REVEX could not start', 'bad'); toast(error.message, true); });
