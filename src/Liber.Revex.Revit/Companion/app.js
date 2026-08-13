import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const OFFLINE_BUILD = '20260811r27';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { project: null, design: null, viewer: null, comments: [], selected: null };

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

async function readJson(path) {
  try {
    const response = await fetch(path, { cache: 'no-store' });
    return response.ok ? response.json() : null;
  } catch (_) { return null; }
}

async function init() {
  [state.project, state.design, state.viewer] = await Promise.all([
    readJson('project.json'), readJson('design-book.json'), readJson('viewer-model.json')
  ]);
  state.comments = readComments();
  $('#project-name').textContent = state.project?.central?.documentTitle || state.design?.source?.documentTitle || 'REVEX Project';
  renderTree();
  renderBook();
  renderComments();
  startViewer();
  route();
}

function route() {
  const mode = (location.hash || '#viewer').slice(1);
  for (const value of ['viewer', 'design', 'comments']) $(`#${value}-pane`).hidden = value !== mode;
  $$('.top nav button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
}

addEventListener('hashchange', route);
$$('.top nav button').forEach((button) => { button.onclick = () => { location.hash = button.dataset.mode; }; });

function renderTree() {
  const host = $('#tree');
  host.innerHTML = '';
  for (const chapter of state.design?.chapters || []) {
    const heading = document.createElement('div');
    heading.className = 'tree-group';
    heading.textContent = chapter.title;
    host.append(heading);
    for (const item of chapter.items || []) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-item';
      row.dataset.search = `${chapter.title} ${item.label} ${(item.candidateMaterials || []).join(' ')}`.toLowerCase();
      row.innerHTML = `<span>${escapeHtml(item.label)}</span>${item.revit ? `<small>${Number(item.revit.instanceCount || 0)}</small>` : ''}`;
      row.onclick = () => inspect(chapter, item);
      host.append(row);
    }
  }
}

$('#search').oninput = (event) => {
  const query = event.target.value.toLowerCase();
  $$('.tree-item').forEach((row) => { row.hidden = Boolean(query && !row.dataset.search.includes(query)); });
};

function inspect(chapter, item) {
  state.selected = { chapter, item };
  $('#inspector').innerHTML = `
    <div class="eyebrow">${escapeHtml(chapter.title)}</div>
    <h2>${escapeHtml(item.label)}</h2>
    <span class="status">${escapeHtml(item.status || 'Not Selected')}</span>
    ${item.revit ? `<div class="source"><b>REVIT MODEL SOURCE</b><strong>${Number(item.revit.instanceCount || 0).toLocaleString()} visible instances</strong><p>${escapeHtml([item.revit.category, item.revit.family, item.revit.type].filter(Boolean).join(' · '))}</p></div>` : ''}
    <h3>Candidate Revit materials</h3>
    <p>${(item.candidateMaterials || []).map(escapeHtml).join('<br>') || '—'}</p>
    <button id="inspect-comment" type="button">Leave comment</button>`;
  $('#inspect-comment').onclick = () => openComment(`${chapter.title} / ${item.label}`);
}

function renderBook() {
  const chaptersHost = $('#chapters');
  chaptersHost.innerHTML = '';
  const chapters = state.design?.chapters || [];
  chapters.forEach((chapter, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chapter-link${index ? '' : ' active'}`;
    button.innerHTML = `<span>${escapeHtml(chapter.title)}</span><small>${chapter.items?.length || 0}</small>`;
    button.onclick = () => showChapter(chapter, button);
    chaptersHost.append(button);
  });
  if (chapters[0]) showChapter(chapters[0], chaptersHost.firstChild);
}

function showChapter(chapter, button) {
  $$('.chapter-link').forEach((node) => node.classList.remove('active'));
  button?.classList.add('active');
  $('#book').innerHTML = `
    <div class="eyebrow">${chapter.sourceKind === 'revit-model-fallback' ? 'VISIBLE REVIT MODEL' : '87 WINTHROP ST — DESIGN REFERENCE'}</div>
    <h1>${escapeHtml(chapter.title)}</h1>
    <p class="chapter-meta">${chapter.items?.length || 0} positions · Inspiration · Rendering · Versions 1–3</p>
    <div class="hero"><div class="placeholder">INSPIRATION</div><div class="placeholder">RENDERING</div><div class="placeholder">VERSION 1–3</div></div>
    <div class="item-grid">${(chapter.items || []).map((item) => `
      <button class="item-card" type="button" data-id="${escapeHtml(item.id)}">
        <div class="item-image">${item.images?.length ? `<img src="${escapeHtml(item.images.at(-1).url)}" alt="" />` : 'ADD REFERENCE / RENDER'}</div>
        <strong>${escapeHtml(item.label)}</strong>
        <p>${escapeHtml(item.description || 'No decision note yet.')}</p>
        <span class="status">${escapeHtml(item.status || 'Not Selected')}</span>
        ${item.revit ? `<span class="revit-chip">REVIT · ${Number(item.revit.instanceCount || 0).toLocaleString()}</span>` : ''}
      </button>`).join('')}</div>`;
  $$('.item-card', $('#book')).forEach((card) => {
    const item = chapter.items.find((candidate) => candidate.id === card.dataset.id);
    card.onclick = () => inspect(chapter, item);
  });
}

function rawPoint(value) {
  const point = value || [0, 0, 0];
  return new THREE.Vector3(Number(point[0]) || 0, Number(point[2]) || 0, -(Number(point[1]) || 0));
}

function proxyModel(elements) {
  const nonPhysical = /(room separation|space separation|area boundary|analytical|lighting.*area|electrical.*area|energy.*area|imported categories|dwg|dxf)/i;
  const rows = (elements || []).filter((row) => row?.bbox?.min && row?.bbox?.max && !/^(rooms?|spaces?|areas?)$/i.test(String(row.category || '').trim()) && !nonPhysical.test(String(row.category || '')));
  if (!rows.length) return null;
  const palette = { walls: 0x9aa8b7, doors: 0xc88a55, windows: 0x4da3ff, floors: 0x66727f, roofs: 0xa6798e, rooms: 0x5d7b70, other: 0x6e7782 };
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.categoryKey || String(row.category || 'other').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const root = new THREE.Group();
  const quaternion = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  groups.forEach((categoryRows, key) => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: palette[key] || palette.other, roughness: .82, transparent: key === 'rooms', opacity: key === 'rooms' ? .18 : .82 }),
      categoryRows.length
    );
    categoryRows.forEach((row, index) => {
      const box = new THREE.Box3(); box.makeEmpty();
      const min = row.bbox.min; const max = row.bbox.max;
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) box.expandByPoint(rawPoint([x, y, z]));
      matrix.compose(box.getCenter(new THREE.Vector3()), quaternion, box.getSize(new THREE.Vector3()).max(new THREE.Vector3(.025, .025, .025)));
      mesh.setMatrixAt(index, matrix);
    });
    root.add(mesh);
  });
  return root;
}

function materialFromRow(row, materialId) {
  const mats = row?.materials || [];
  const hit = mats.find((m) => String(m.id) === String(Math.trunc(Number(materialId)))) || mats[0];
  const color = hit?.color?.length >= 3 ? new THREE.Color().setRGB((+hit.color[0] || 0) / 255, (+hit.color[1] || 0) / 255, (+hit.color[2] || 0) / 255, THREE.SRGBColorSpace) : new THREE.Color(0x8e969f);
  const opacity = hit ? Math.max(.04, 1 - (+hit.transparency || 0) / 100) : 1;
  return new THREE.MeshStandardMaterial({ color, roughness: .68, metalness: .04, opacity, transparent: opacity < .995, depthWrite: opacity > .72 });
}

class OfflineStreamBytes {
  constructor(reader) { this.reader = reader; this.chunk = null; this.offset = 0; }
  async readExact(n) { const out = new Uint8Array(n); let p = 0; while (p < n) { if (!this.chunk || this.offset >= this.chunk.length) { const next = await this.reader.read(); if (next.done) throw new Error('Unexpected end of REVEX geometry stream.'); this.chunk = next.value; this.offset = 0; } const take = Math.min(n - p, this.chunk.length - this.offset); out.set(this.chunk.subarray(this.offset, this.offset + take), p); this.offset += take; p += take; } return out; }
  async u8() { return (await this.readExact(1))[0]; }
  async i32() { const b = await this.readExact(4); return new DataView(b.buffer).getInt32(0, true); }
  async f64() { const b = await this.readExact(8); return new DataView(b.buffer).getFloat64(0, true); }
}

async function loadOfflineRvx(url, byId, onProgress) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Streaming gzip is unavailable.');
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error(`REVEX geometry fetch failed (${response.status}).`);
  const reader = response.body.pipeThrough(new DecompressionStream('gzip')).getReader();
  const bytes = new OfflineStreamBytes(reader);
  const magic = new TextDecoder().decode(await bytes.readExact(8));
  if (!magic.startsWith('RVXSCN2')) throw new Error('Invalid REVEX geometry stream.');
  if (await bytes.i32() !== 2) throw new Error('Unsupported REVEX geometry stream version.');
  const root = new THREE.Group(); root.name = 'REVEX_EXACT_MODEL';
  let elements = 0;
  while (true) {
    const type = await bytes.u8(); if (type === 0) break; if (type !== 1) throw new Error('Invalid REVEX geometry record.');
    const elementId = String(Math.trunc(await bytes.f64())); const partCount = await bytes.i32(); const row = byId.get(elementId);
    for (let i = 0; i < partCount; i++) {
      const materialId = await bytes.f64(); const vertexCount = await bytes.i32(); const raw = await bytes.readExact(vertexCount * 24);
      const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4); const ib = new THREE.InterleavedBuffer(floats, 6); const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0, false)); geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3, false)); geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, materialFromRow(row, materialId)); mesh.userData.revexElementId = elementId; root.add(mesh);
    }
    elements++; if (elements % 32 === 0) { onProgress?.(elements); await new Promise((r) => requestAnimationFrame(r)); }
  }
  return root;
}

function startViewer() {
  const host = $('#viewer');
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101319);
  const camera = new THREE.PerspectiveCamera(43, 1, .01, 1e8); camera.position.set(20, 20, 20);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.25)); host.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = false;
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x202a35, 2.1)); const sun = new THREE.DirectionalLight(0xffffff, 2.3); sun.position.set(10, 20, 10); scene.add(sun);
  let renderFrame = 0, current = null;
  const requestRender = () => { if (renderFrame || document.hidden) return; renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderer.render(scene, camera); }); };
  controls.addEventListener('change', requestRender);
  const resize = () => { const width = Math.max(host.clientWidth, 1), height = Math.max(host.clientHeight, 1); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); requestRender(); };
  new ResizeObserver(resize).observe(host); resize();
  const fit = (object) => { const box = new THREE.Box3().setFromObject(object); if (box.isEmpty()) return; const size = Math.max(box.getSize(new THREE.Vector3()).length(), .1), center = box.getCenter(new THREE.Vector3()); controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(size * .62, size * .46, size * .62)); camera.near = Math.max(size / 10000, .01); camera.far = Math.max(size * 20, 2000); camera.updateProjectionMatrix(); controls.update(); requestRender(); };
  const show = (object, label) => { if (current) scene.remove(current); current = object; scene.add(object); fit(object); requestRender(); $('#sync-state').textContent = label; };
  const proxy = proxyModel(state.viewer?.elements); if (proxy) show(proxy, 'Loading exact model…');
  const geometry = state.viewer?.geometry || {}, display = geometry.display || null, fallback = geometry.displayFallback || null, format = geometry.displayFormat || null;
  const byId = new Map((state.viewer?.elements || []).map((row) => [String(row.id), row]));
  if (display && format === 'rvxmesh-gzip') {
    loadOfflineRvx(display, byId, (n) => { $('#sync-state').textContent = `Loading exact model · ${n.toLocaleString()} elements`; })
      .then((model) => show(model, `Exact Revit model · ${OFFLINE_BUILD}`))
      .catch((error) => { console.warn('[REVEX offline] RVX', error); if (!fallback) { $('#sync-state').textContent = 'Exact model unavailable · metadata proxy'; return; } new FBXLoader().load(fallback, (object) => show(object, 'FBX compatibility model'), undefined, () => { $('#sync-state').textContent = 'Model geometry unavailable · metadata proxy'; }); });
  } else if (display) {
    new FBXLoader().load(display, (object) => show(object, 'FBX compatibility model'), undefined, () => { $('#sync-state').textContent = 'Model geometry unavailable · metadata proxy'; });
  } else $('#sync-state').textContent = proxy ? 'Metadata model only' : 'No model geometry';
}

function readComments() {
  try { return JSON.parse(localStorage.getItem('liber.revex.comments') || '[]'); } catch (_) { return []; }
}
function saveComments() { localStorage.setItem('liber.revex.comments', JSON.stringify(state.comments)); }
function renderComments() {
  const host = $('#comments-list');
  host.innerHTML = state.comments.length ? '' : '<p class="empty">No comments yet.</p>';
  for (const comment of state.comments) {
    const card = document.createElement('div'); card.className = 'comment';
    card.innerHTML = `<strong>${escapeHtml(comment.link || 'Project')}</strong><p>${escapeHtml(comment.text)}</p><small>${escapeHtml(comment.at)}</small>`;
    host.append(card);
  }
}
function openComment(link = '') { $('#comment-modal').hidden = false; $('#comment-link').value = link; $('#comment-text').focus(); }
function closeComment() { $('#comment-modal').hidden = true; }
$('#new-comment').onclick = () => openComment();
$('#comment-cancel').onclick = closeComment;
$('#comment-modal').onclick = (event) => { if (event.target === event.currentTarget) closeComment(); };
addEventListener('keydown', (event) => { if (event.key === 'Escape') closeComment(); });
$('#comment-form').onsubmit = (event) => {
  event.preventDefault();
  state.comments.unshift({ id: crypto.randomUUID(), text: $('#comment-text').value, link: $('#comment-link').value, at: new Date().toLocaleString(), status: 'open' });
  saveComments(); renderComments(); event.target.reset(); closeComment();
};

init();
