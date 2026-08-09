import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

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
  issues: [],
  library: [],
  selectedElement: null,
  selectedDesign: null,
  selectedContext: '',
  activeChapter: '',
  unsubscribe: null,
  loadingRevision: ''
};

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

class BimViewer {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe9ebe6);
    this.camera = new THREE.PerspectiveCamera(43, 1, .01, 1e8);
    this.camera.position.set(18, 14, 18);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .08;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x687068, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(14, 25, 11);
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(400, 80, 0xa9aea8, 0xd1d4cf);
    this.scene.add(this.grid);
    this.model = null;
    this.helper = null;
    this.metadata = [];
    this.elementById = new Map();
    this.metaWorld = null;
    this.modelBounds = null;
    this.edges = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.onSelect = null;
    this.renderer.domElement.addEventListener('click', (event) => this.pick(event));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.animate();
  }

  resize() {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.updatePins();
    this.renderer.render(this.scene, this.camera);
  }

  clearModel() {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((node) => {
        node.geometry?.dispose?.();
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.filter(Boolean).forEach((material) => material.dispose?.());
      });
    }
    if (this.helper) this.scene.remove(this.helper);
    this.model = null;
    this.helper = null;
    this.modelBounds = null;
  }

  async load(url, viewerData) {
    this.clearModel();
    this.metadata = viewerData?.elements || [];
    this.elementById = new Map(this.metadata.map((row) => [String(row.id), row]));
    if (!url) return false;
    const object = await new Promise((resolve, reject) => new FBXLoader().load(url, resolve, undefined, reject));
    this.model = object;
    this.model.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = false;
      node.receiveShadow = true;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.filter(Boolean).forEach((material) => {
        material.wireframe = this.edges;
        if ('roughness' in material) material.roughness = Math.max(material.roughness ?? .6, .45);
      });
    });
    this.scene.add(object);
    this.modelBounds = new THREE.Box3().setFromObject(object);
    this.computeMetadataTransform();
    this.fit();
    return true;
  }

  rawPoint(value) {
    const p = value || [0, 0, 0];
    return new THREE.Vector3(Number(p[0]) || 0, Number(p[2]) || 0, -(Number(p[1]) || 0));
  }

  computeMetadataTransform() {
    const boxes = this.metadata.filter((row) => row?.bbox?.min && row?.bbox?.max);
    if (!boxes.length || !this.modelBounds) { this.metaWorld = null; return; }
    const source = new THREE.Box3();
    source.makeEmpty();
    boxes.forEach((row) => {
      source.expandByPoint(this.rawPoint(row.bbox.min));
      source.expandByPoint(this.rawPoint(row.bbox.max));
    });
    const sourceSize = source.getSize(new THREE.Vector3());
    const targetSize = this.modelBounds.getSize(new THREE.Vector3());
    const ratios = [targetSize.x / Math.max(sourceSize.x, 1e-6), targetSize.y / Math.max(sourceSize.y, 1e-6), targetSize.z / Math.max(sourceSize.z, 1e-6)].filter(Number.isFinite);
    const scale = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] || 1;
    const sourceCenter = source.getCenter(new THREE.Vector3());
    const targetCenter = this.modelBounds.getCenter(new THREE.Vector3());
    this.metaWorld = { scale, sourceCenter, targetCenter };
  }

  worldPoint(value) {
    const point = this.rawPoint(value);
    if (!this.metaWorld) return point;
    return point.sub(this.metaWorld.sourceCenter).multiplyScalar(this.metaWorld.scale).add(this.metaWorld.targetCenter);
  }

  worldBox(element) {
    if (!element?.bbox?.min || !element?.bbox?.max) return null;
    const min = element.bbox.min;
    const max = element.bbox.max;
    const box = new THREE.Box3(); box.makeEmpty();
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) box.expandByPoint(this.worldPoint([x, y, z]));
    return box;
  }

  fit(box = this.modelBounds) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), .1);
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(size * .62, size * .46, size * .62));
    this.camera.near = Math.max(size / 10000, .01);
    this.camera.far = Math.max(size * 20, 2000);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  select(element, fit = true) {
    if (this.helper) this.scene.remove(this.helper);
    this.helper = null;
    const box = this.worldBox(element);
    if (box) {
      this.helper = new THREE.Box3Helper(box, 0x98bd16);
      this.scene.add(this.helper);
      if (fit) this.fit(box.expandByScalar(Math.max(box.getSize(new THREE.Vector3()).length() * .75, .5)));
    }
  }

  pick(event) {
    if (!this.model) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.model, true);
    if (!hits.length || !this.metadata.length) return;
    const hit = hits[0].point;
    let nearest = null;
    let distance = Infinity;
    for (const element of this.metadata) {
      const box = this.worldBox(element);
      if (!box) continue;
      const d = box.distanceToPoint(hit);
      if (d < distance) { distance = d; nearest = element; if (d < 1e-5) break; }
    }
    if (nearest) this.onSelect?.(nearest);
  }

  toggleEdges(enabled) {
    this.edges = enabled;
    this.model?.traverse((node) => {
      if (!node.isMesh) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.filter(Boolean).forEach((material) => { material.wireframe = enabled; material.needsUpdate = true; });
    });
  }

  updatePins() {
    if (!state.issues.length) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    $$('.issue-pin', $('#issue-pins')).forEach((pin) => {
      const issue = state.issues.find((row) => row.id === pin.dataset.id);
      const element = issue?.anchorElementId ? this.elementById.get(String(issue.anchorElementId)) : null;
      const box = this.worldBox(element);
      if (!box) { pin.hidden = true; return; }
      const p = box.getCenter(new THREE.Vector3()).project(this.camera);
      pin.hidden = p.z < -1 || p.z > 1;
      pin.style.left = `${(p.x * .5 + .5) * width}px`;
      pin.style.top = `${(-p.y * .5 + .5) * height}px`;
    });
  }
}

let viewer;
try {
  viewer = new BimViewer($('#viewer'));
  viewer.onSelect = (element) => selectElement(element, true);
} catch (error) {
  console.error('[REVEX] WebGL viewer', error);
  $('#viewer-message').textContent = '3D acceleration is unavailable. The element tree and project data remain usable.';
}

function showView(name) {
  const hasProject = Boolean(state.projectId);
  $('#view-empty').hidden = hasProject;
  for (const view of ['bim', 'design', 'spec', 'docs', 'chat']) $(`#view-${view}`).hidden = !hasProject || view !== name;
  $$('.main-nav [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  if (hasProject) {
    history.replaceState(null, '', `${location.pathname}?${new URLSearchParams({ ...(params.get('inShell') ? { inShell: '1' } : {}), projectId: state.projectId, ...(state.preferredSpecId ? { specProjectId: state.preferredSpecId } : {}), view: name })}`);
    if (name === 'bim') setTimeout(() => viewer?.resize(), 0);
    if (name === 'chat') renderChatContext();
  }
}

function renderProjects() {
  const select = $('#project-select');
  select.innerHTML = '<option value="">Choose a project</option>' + state.projects.map((project) =>
    `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name || project.title || 'Untitled project')}</option>`
  ).join('');
  select.value = state.projectId;
}

function renderModelTree() {
  const data = state.viewerData;
  const elements = data?.elements || [];
  $('#model-title').textContent = data?.source?.documentTitle || state.cloudState?.central?.documentTitle || 'No model synced';
  $('#model-facts').innerHTML = state.cloudState ? `
    <div class="fact"><strong>${elements.length.toLocaleString()}</strong><span>visible elements</span></div>
    <div class="fact"><strong>${(data?.source?.viewName || '3D').slice(0, 20)}</strong><span>Revit view</span></div>
    <div class="fact"><strong>${state.cloudState.scheduleCount || state.designData?.schedules?.length || 0}</strong><span>schedules</span></div>
    <div class="fact"><strong>${state.cloudState.central?.driveFileId ? 'Drive' : 'Path'}</strong><span>central binding</span></div>` : '';
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
    if (element) selectElement(element, true);
  }));
}

function elementIssues(element) {
  return state.issues.filter((issue) => String(issue.anchorElementId || '') === String(element?.id || ''));
}

function selectElement(element, fit = true) {
  state.selectedElement = element;
  state.selectedDesign = null;
  state.selectedContext = contextFor('BIM', element);
  viewer?.select(element, fit);
  renderModelTree();
  const issues = elementIssues(element);
  $('#bim-inspector').innerHTML = `
    <div class="eyebrow">REVIT ELEMENT ${escapeHtml(element.id)}</div>
    <h2>${escapeHtml(element.name || element.type || element.category || 'Element')}</h2>
    <div class="property-list">
      <div class="property"><span>Category</span>${escapeHtml(element.category || '—')}</div>
      <div class="property"><span>Type</span>${escapeHtml(element.type || '—')}</div>
      <div class="property"><span>Unique ID</span>${escapeHtml(element.uniqueId || '—')}</div>
      <div class="property"><span>Materials</span>${(element.materials || []).map((m) => `<b class="material-chip">${escapeHtml(m.name)}</b>`).join('') || '—'}</div>
    </div>
    <button class="button" id="element-issue" type="button">Add BIM issue</button>
    <button class="button ghost" id="element-chat" type="button">Send context to Project Chat</button>
    <h3>Issues · ${issues.length}</h3>
    <div class="issue-list">${issues.map((issue) => `<div class="issue-row"><strong>${escapeHtml(issue.title)}</strong><small>${escapeHtml(issue.status)} · ${formatDate(issue.createdAt)}</small><p>${escapeHtml(issue.body)}</p></div>`).join('') || '<p class="muted">No issues on this element.</p>'}</div>`;
  $('#element-issue').addEventListener('click', () => openIssue({ kind: 'bim', element }));
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

function renderDesign() {
  const list = chapters();
  if (!state.activeChapter || !list.some((chapter) => chapter.id === state.activeChapter)) state.activeChapter = list[0]?.id || '';
  $('#chapter-list').innerHTML = list.map((chapter) => `<button type="button" class="${chapter.id === state.activeChapter ? 'active' : ''}" data-chapter="${escapeHtml(chapter.id)}">${escapeHtml(chapter.title)}</button>`).join('') || '<p class="muted">Sync from Revit to form the Design Book.</p>';
  $$('#chapter-list button').forEach((button) => button.addEventListener('click', () => { state.activeChapter = button.dataset.chapter; state.selectedDesign = null; renderDesign(); renderDesignInspector(); }));
  const chapter = list.find((row) => row.id === state.activeChapter);
  $('#chapter-title').textContent = chapter?.title || 'Design Book';
  $('#chapter-subtitle').textContent = chapter ? `${chapter.items?.length || 0} Revit-derived positions · editable LIBER project decisions` : 'Sync room and material schedules from Revit.';
  $('#design-grid').innerHTML = (chapter?.items || []).map((sourceItem) => {
    const item = mergedItem(sourceItem);
    const image = item.images?.at?.(-1)?.url || item.images?.[item.images.length - 1]?.url;
    return `<button class="design-card${state.selectedDesign?.id === item.id ? ' active' : ''}" data-item="${escapeHtml(item.id)}" type="button">
      <div class="design-image">${image ? `<img src="${escapeHtml(image)}" alt="" />` : 'ADD REFERENCE / RENDER'}</div>
      <div class="design-copy"><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.description || 'No decision note yet.')}</p><span class="status-chip">${escapeHtml(item.status || 'Not Selected')}</span></div>
    </button>`;
  }).join('') || '<p class="muted">No positions in this chapter.</p>';
  $$('.design-card', $('#design-grid')).forEach((card) => card.addEventListener('click', () => {
    const source = chapter.items.find((item) => item.id === card.dataset.item);
    state.selectedDesign = { ...mergedItem(source), chapterTitle: chapter.title };
    state.selectedElement = null;
    state.selectedContext = contextFor('Design', state.selectedDesign);
    renderDesign();
    renderDesignInspector();
  }));
}

function renderDesignInspector() {
  const item = state.selectedDesign;
  if (!item) {
    $('#design-inspector').innerHTML = '<div class="eyebrow">DESIGN POSITION</div><h2>Select a position</h2><p class="muted">Images and decisions are saved outside the RVT and survive the next Revit sync.</p>';
    return;
  }
  $('#design-inspector').innerHTML = `
    <div class="eyebrow">${escapeHtml(item.chapterTitle)}</div><h2>${escapeHtml(item.label)}</h2>
    <form id="design-edit-form" class="edit-form">
      <label>Status<select id="design-status"><option>Not Selected</option><option>Research</option><option>Proposed</option><option>Approved</option><option>On Hold</option></select></label>
      <label>Description<textarea id="design-description" rows="4" placeholder="Selection, intent, dimensions…">${escapeHtml(item.description || '')}</textarea></label>
      <label>Source / product link<input id="design-source" type="url" value="${escapeHtml(item.source || '')}" placeholder="https://…" /></label>
      <label>Images<input id="design-image-upload" type="file" accept="image/*" /></label>
      <div class="image-strip">${(item.images || []).map((image) => `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name || '')}" />`).join('')}</div>
      <div><span class="eyebrow">REVIT MATERIAL CANDIDATES</span><div>${(item.candidateMaterials || []).map((name) => `<b class="material-chip">${escapeHtml(name)}</b>`).join('') || '<span class="muted">None inferred.</span>'}</div></div>
      <button class="button" type="submit">Save Design Book position</button>
      <button class="button ghost" id="design-issue" type="button">Add design issue</button>
      <button class="button ghost" id="design-chat" type="button">Send context to Project Chat</button>
    </form>`;
  $('#design-status').value = item.status || 'Not Selected';
  $('#design-edit-form').addEventListener('submit', saveDesign);
  $('#design-image-upload').addEventListener('change', uploadDesignImage);
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
    ? `${spec?.status === 'published' ? 'Revit source published' : 'Linked'} · ${spec?.rev ? `revision ${spec.rev}` : 'ready'} · Specifications remains authoritative for authored spec fields.`
    : 'Link this LIBER project to a Specifications project, or add a Specifications project ID in the Revit add-in.';
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
  renderModelTree(); renderPins(); renderDesign(); renderDesignInspector(); renderSpec(); renderLibrary(); renderChatContext();
}

async function loadCloudState(cloudState, localPackage = null) {
  state.cloudState = cloudState || null;
  if (!cloudState && !localPackage) {
    state.viewerData = null; state.designData = null; state.designEdits = new Map(); state.issues = []; state.library = [];
    renderAll(); setSync('No Revit sync yet', 'quiet'); return;
  }
  const revision = localPackage?.revision || cloudState?.revision || 'unknown';
  if (state.loadingRevision === revision && !localPackage) return;
  state.loadingRevision = revision;
  setSync('Loading project revision…', 'busy');
  try {
    const [viewerData, designData, edits, issues, library] = await Promise.all([
      localPackage?.viewer || Store.fetchJson(cloudState.viewerUrl),
      localPackage?.design || Store.fetchJson(cloudState.designUrl),
      Store.listDesignEdits(state.projectId), Store.listIssues(state.projectId), Store.listLibrary(state.projectId)
    ]);
    state.viewerData = viewerData;
    state.designData = designData;
    state.designEdits = new Map(edits.map((row) => [row.id, row]));
    state.issues = issues;
    state.library = library;
    renderAll();
    const modelUrl = localPackage?.modelUrl || cloudState.modelUrl;
    $('#viewer-message').hidden = Boolean(modelUrl);
    if (modelUrl && viewer) {
      try { await viewer.load(modelUrl, viewerData); $('#viewer-message').hidden = true; }
      catch (error) { $('#viewer-message').hidden = false; $('#viewer-message').textContent = `Model could not load: ${error.message}`; }
    }
    setSync(`${localPackage?.cloud === false ? 'Local preview' : 'Synced'} ${formatDate(localPackage?.syncedAt || cloudState.syncedAt)}`, localPackage?.cloud === false ? 'quiet' : 'good');
  } catch (error) {
    console.error('[REVEX] load revision', error);
    setSync('Revision load failed', 'bad'); toast(error.message, true);
  }
}

async function activateProject(projectId) {
  state.unsubscribe?.(); state.unsubscribe = null;
  state.projectId = projectId || '';
  state.project = state.projects.find((row) => row.id === projectId) || (projectId ? await Store.getProject(projectId) : null);
  $('#project-select').value = state.projectId;
  if (!projectId) { showView('bim'); return; }
  const requestedView = params.get('view') || 'bim';
  showView(requestedView);
  setSync('Loading project…', 'busy');
  try {
    const cloudState = await Store.getState(projectId);
    await loadCloudState(cloudState);
    state.unsubscribe = Store.subscribeState(projectId, (next) => {
      if (next?.revision && next.revision !== state.cloudState?.revision) loadCloudState(next);
      else if (next) { state.cloudState = next; renderSpec(); }
    });
  } catch (error) { setSync('Project unavailable', 'bad'); toast(error.message, true); }
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
$('#project-select').addEventListener('change', () => activateProject($('#project-select').value));
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
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#issue-drawer').hidden) closeIssue();
});
$('#open-chat').addEventListener('click', () => openProjectChat());
$('#open-spec').addEventListener('click', () => openInLiberShell('specifications', 'Specifications', appUrl('specifications', { specProjectId: state.preferredSpecId || state.cloudState?.spec?.projectId })));
$('#open-tracker').addEventListener('click', () => openInLiberShell('project-tracker', 'Project Tracker', appUrl('project-tracker', { projectId: state.projectId })));
$('#rendair-button').addEventListener('click', () => window.open('https://rendair.ai/tools/3d-model-to-render', '_blank', 'noopener'));

window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'liber:app-params') return;
  if (data.params?.specProjectId) state.preferredSpecId = data.params.specProjectId;
  if (data.params?.projectId && data.params.projectId !== state.projectId) activateProject(data.params.projectId);
  if (data.params?.view) showView(data.params.view);
});

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
