import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const BUILD = '20260817r108-single-viewer1';
const Store = window.RevexStore;
const $ = (s, r = document) => r.querySelector(s);
const physical = (r) => r?.proxyEligible !== false && r?.bbox?.min && r?.bbox?.max && !/^(rooms?|spaces?|areas?|levels?|grids?|sheets?|views?|viewports?|cameras?)$/i.test(String(r.category || '').trim());
const yieldFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function diag(level, stage, message, detail = {}) {
  try { window.__revexBrowserDiagnostics?.emit?.(level, stage, message, { initiator: 'single viewer r108', ...detail }); } catch (_) {}
}

class Viewer {
  constructor(host) {
    this.host = host;
    this.embedded = !!window.chrome?.webview;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101319);
    this.camera = new THREE.PerspectiveCamera(50, 1, .01, 1e8);
    this.renderer = new THREE.WebGLRenderer({ antialias: !this.embedded, powerPreference: this.embedded ? 'low-power' : 'default' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.embedded ? 1 : 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.localClippingEnabled = true;
    host.replaceChildren(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.scene.add(new THREE.HemisphereLight(0xdbe9f5, 0x28323b, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7); sun.position.set(18, 28, 14); this.scene.add(sun);
    this.data = null;
    this.sourceState = null;
    this.model = null;
    this.bounds = null;
    this.byId = new Map();
    this.byUid = new Map();
    this.nodesByKey = new Map();
    this.overlays = new Map();
    this.appearances = new Map();
    this.loadToken = 0;
    this.detailLoaded = false;
    this.detailLoading = false;
    this.active = true;
    this.renderFrame = 0;
    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.walk = false;
    this.keys = new Set();
    this.walkFrame = 0;
    this.floor = 0;
    this.eye = 5.5;
    this.yaw = 0;
    this.pitch = 0;
    this.drag = false;
    this.lastPointer = null;
    this.section = { enabled: false, left: 0, right: 1, front: 0, back: 1, bottom: 0, top: 1 };
    this.renderer.domElement.addEventListener('click', (e) => { if (!this.walk) this.pick(e); });
    this.renderer.domElement.addEventListener('pointerdown', (e) => { if (!this.walk) return; this.drag = true; this.lastPointer = [e.clientX, e.clientY]; this.renderer.domElement.setPointerCapture?.(e.pointerId); });
    this.renderer.domElement.addEventListener('pointermove', (e) => { if (!this.walk || !this.drag || !this.lastPointer) return; const dx = e.clientX - this.lastPointer[0], dy = e.clientY - this.lastPointer[1]; this.lastPointer = [e.clientX, e.clientY]; this.yaw -= dx * .004; this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch - dy * .003)); this.look(); this.requestRender(); });
    this.renderer.domElement.addEventListener('pointerup', () => { this.drag = false; this.lastPointer = null; });
    addEventListener('keydown', (e) => { const k = e.key.toLowerCase(); if (this.walk && 'wasdqe'.includes(k)) { this.keys.add(k); e.preventDefault(); this.startWalk(); } });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  raw(v) { const p = v || [0, 0, 0]; return new THREE.Vector3(+p[0] || 0, +p[2] || 0, -(+p[1] || 0)); }
  box(row) { if (!row?.bbox?.min || !row?.bbox?.max) return null; const b = new THREE.Box3(); b.makeEmpty(); for (const x of [row.bbox.min[0], row.bbox.max[0]]) for (const y of [row.bbox.min[1], row.bbox.max[1]]) for (const z of [row.bbox.min[2], row.bbox.max[2]]) b.expandByPoint(this.raw([x, y, z])); return b; }
  key(row) { return String(row?.uniqueId || row?.id || ''); }
  requestRender() { if (this.renderFrame || document.hidden || !this.active) return; this.renderFrame = requestAnimationFrame(() => { this.renderFrame = 0; this.renderer.render(this.scene, this.camera); }); }
  resize() { const w = Math.max(this.host.clientWidth, 1), h = Math.max(this.host.clientHeight, 1); this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.requestRender(); }
  setActive(active) { this.active = !!active; if (!this.active) { this.walk = false; this.keys.clear(); if (this.walkFrame) cancelAnimationFrame(this.walkFrame); this.walkFrame = 0; } else this.requestRender(); }

  dispose(root) { if (!root) return; const mats = new Set(); root.traverse?.((n) => { n.geometry?.dispose?.(); for (const m of (Array.isArray(n.material) ? n.material : [n.material]).filter(Boolean)) mats.add(m); }); mats.forEach((m) => m.dispose?.()); }
  clearModel() { if (this.model) { this.scene.remove(this.model); this.dispose(this.model); this.model = null; } this.nodesByKey.clear(); }

  material(row) {
    const m = (row?.materials || []).find((x) => Array.isArray(x.color) && x.color.length >= 3);
    const color = m ? new THREE.Color().setRGB((+m.color[0] || 0) / 255, (+m.color[1] || 0) / 255, (+m.color[2] || 0) / 255, THREE.SRGBColorSpace) : new THREE.Color(0xa7aaae);
    const opacity = m ? Math.max(.08, 1 - (+m.transparency || 0) / 100) : 1;
    return new THREE.MeshStandardMaterial({ color, roughness: .72, metalness: .02, transparent: opacity < .995, opacity, depthWrite: opacity > .7 });
  }

  buildProxy(rows) {
    const root = new THREE.Group(); root.name = 'REVEX_LIGHTWEIGHT_MODEL_R108';
    const unit = new THREE.BoxGeometry(1, 1, 1); const mats = new Map();
    for (const row of rows) {
      const b = this.box(row); if (!b) continue;
      const mk = `${row.category || ''}|${row.type || row.name || ''}`;
      if (!mats.has(mk)) mats.set(mk, this.material(row));
      const mesh = new THREE.Mesh(unit, mats.get(mk)); const center = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3()).max(new THREE.Vector3(.02, .02, .02));
      mesh.position.copy(center); mesh.scale.copy(size); mesh.name = `REVEX_PROXY_${row.id}`; mesh.userData.revexElementId = String(row.id); root.add(mesh);
    }
    return root;
  }

  indexNodes() {
    this.nodesByKey.clear();
    this.model?.traverse?.((n) => {
      if (!n.isMesh) return;
      const id = String(n.userData?.revexElementId || ''); const row = this.byId.get(id); if (!row) return;
      const key = this.key(row); if (!this.nodesByKey.has(key)) this.nodesByKey.set(key, []); this.nodesByKey.get(key).push(n);
    });
  }

  async load(state, source) {
    const token = ++this.loadToken;
    this.sourceState = state || null; this.detailLoaded = false; this.detailLoading = false;
    const msg = $('#viewer-message'); if (msg) { msg.hidden = false; msg.classList.remove('fallback'); msg.textContent = 'Loading lightweight BIM…'; }
    const data = source || await Store.fetchJson(state?.viewerUrl); if (token !== this.loadToken || !data) return;
    const rows = (data.elements || []).filter(physical); this.data = { ...data, elements: rows };
    this.byId = new Map(rows.map((r) => [String(r.id), r])); this.byUid = new Map();
    for (const row of rows) if (row.uniqueId) { this.byUid.set(String(row.uniqueId), row); this.byUid.set(String(row.uniqueId).toLowerCase(), row); }
    const bounds = new THREE.Box3(); bounds.makeEmpty(); rows.forEach((r) => { const b = this.box(r); if (b) bounds.union(b); }); this.bounds = bounds.isEmpty() ? null : bounds;
    this.clearModel(); this.model = this.buildProxy(rows); this.scene.add(this.model); this.indexNodes(); this.applyState(); this.fit(); this.populateFloors(); this.requestRender();
    const button = $('#detail-toggle'); if (button) { button.disabled = !state?.modelUrl; button.classList.remove('active'); button.textContent = state?.modelUrl ? 'Model' : 'No model'; }
    if (msg) { msg.hidden = false; msg.textContent = state?.modelUrl ? 'Lightweight BIM ready · press Model for exact geometry.' : 'BIM index ready.'; }
    window.dispatchEvent(new CustomEvent('revex:viewer-mode', { detail: { mode: 'lightweight', stats: { elements: rows.length, exactAvailable: !!state?.modelUrl } } }));
    diag('INFO', 'VIEWER_R108_READY', 'Single lightweight BIM viewer ready; exact geometry is explicit only.', { elements: rows.length, exactAvailable: !!state?.modelUrl, embedded: this.embedded });
  }

  async fetchBuffer(url) {
    const response = await fetch(url, { cache: 'no-store' }); if (!response.ok) throw new Error(`Geometry fetch failed (${response.status}).`);
    if (typeof DecompressionStream === 'undefined') throw new Error('Streaming gzip decompression is unavailable.');
    return await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }

  async parseRvxBuffer(buffer, group, token) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer); let p = 0;
    const i32 = () => { const x = view.getInt32(p, true); p += 4; return x; }; const f64 = () => { const x = view.getFloat64(p, true); p += 8; return x; }; const u8 = () => view.getUint8(p++);
    const magic = new TextDecoder().decode(bytes.subarray(0, 8)); p = 8; if (!magic.startsWith('RVXSCN2')) throw new Error('Invalid REVEX geometry header.'); if (i32() !== 2) throw new Error('Unsupported REVEX geometry version.');
    let elements = 0, vertices = 0, slice = performance.now();
    while (p < bytes.length) {
      if (token !== this.loadToken) return { elements, vertices };
      const type = u8(); if (type === 0) break; if (type !== 1) throw new Error(`Unknown geometry record ${type}.`);
      const elementId = String(Math.trunc(f64())), partCount = i32(), row = this.byId.get(elementId);
      for (let part = 0; part < partCount; part++) {
        f64(); const vertexCount = i32(); if (vertexCount < 0 || vertexCount > 50000000) throw new Error('Invalid geometry vertex count.'); const byteLength = vertexCount * 6 * 4; if (p + byteLength > bytes.length) throw new Error('Geometry page ended inside a mesh.');
        const floats = new Float32Array(buffer.slice(p, p + byteLength)); p += byteLength;
        const ib = new THREE.InterleavedBuffer(floats, 6), g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0, false)); g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3, false)); g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.material(row)); mesh.userData.revexElementId = elementId; mesh.name = `REVEX_${elementId}`; group.add(mesh); vertices += vertexCount;
      }
      elements++;
      if (performance.now() - slice > 4) { await yieldFrame(); slice = performance.now(); }
    }
    return { elements, vertices };
  }

  async loadDetailed() {
    if (this.detailLoaded || this.detailLoading || !this.sourceState?.modelUrl) return this.detailLoaded;
    const token = this.loadToken, button = $('#detail-toggle'), msg = $('#viewer-message'); this.detailLoading = true;
    if (button) { button.disabled = true; button.textContent = 'Loading…'; } if (msg) { msg.hidden = false; msg.textContent = 'Loading exact BIM by request…'; }
    try {
      const format = this.sourceState.modelFormat || this.data?.geometry?.displayFormat || (String(this.sourceState.modelUrl).includes('rvxmesh') ? 'rvxmesh-gzip' : 'fbx');
      let exact = new THREE.Group(), elements = 0, vertices = 0;
      if (format === 'rvxmesh-gzip-pages') {
        const pages = (this.sourceState.modelPages || []).filter((p) => p?.url); if (!pages.length) throw new Error('No geometry pages are available.');
        for (let i = 0; i < pages.length; i++) { if (token !== this.loadToken) return false; if (msg) msg.textContent = `Loading exact BIM · page ${i + 1} / ${pages.length}`; const stats = await this.parseRvxBuffer(await this.fetchBuffer(pages[i].url), exact, token); elements += stats.elements; vertices += stats.vertices; await yieldFrame(); }
      } else if (format === 'rvxmesh-gzip') {
        const stats = await this.parseRvxBuffer(await this.fetchBuffer(this.sourceState.modelUrl), exact, token); elements = stats.elements; vertices = stats.vertices;
      } else {
        const object = await new Promise((resolve, reject) => new FBXLoader().load(this.sourceState.modelUrl, resolve, undefined, reject)); exact.add(object); exact.traverse((n) => { if (n.isMesh) vertices += n.geometry?.attributes?.position?.count || 0; });
      }
      if (token !== this.loadToken) { this.dispose(exact); return false; }
      this.clearModel(); this.model = exact; this.scene.add(exact); this.indexNodes(); this.applyState(); this.detailLoaded = true; this.fit(); this.requestRender();
      if (button) { button.disabled = false; button.textContent = 'Model'; button.classList.add('active'); } if (msg) msg.hidden = true;
      window.dispatchEvent(new CustomEvent('revex:viewer-mode', { detail: { mode: format, stats: { elements, vertices, explicit: true } } }));
      return true;
    } catch (error) {
      if (msg) { msg.hidden = false; msg.classList.add('fallback'); msg.textContent = 'Exact BIM could not load. Lightweight BIM remains active.'; }
      if (button) { button.disabled = false; button.textContent = 'Retry'; button.classList.remove('active'); }
      diag('WARN', 'VIEWER_R108_EXACT', error?.message || String(error)); return false;
    } finally { this.detailLoading = false; }
  }

  applyState() {
    for (const row of this.data?.elements || []) {
      const key = this.key(row), overlay = this.overlays.get(key) || this.overlays.get(String(row.id)); const nodes = this.nodesByKey.get(key) || [];
      const visible = !(overlay?.hidden || overlay?.deleted || String(overlay?.visibility || '').toLowerCase() === 'hidden' || String(overlay?.visibility || '').toLowerCase() === 'deleted');
      for (const n of nodes) n.visible = visible;
    }
    this.applySection(); this.requestRender();
  }
  setOverlays(rows) { this.overlays = new Map((rows || []).map((o) => [String(o.uniqueId || o.elementId || o.id), o])); this.applyState(); }
  setAppearances(rows) { this.appearances = new Map((rows || []).map((r) => [`${r.scope}:${r.scopeKey}`, r])); this.requestRender(); }
  applyAppearances() { this.requestRender(); }

  fit(box = this.bounds) { if (!box || box.isEmpty()) return; const c = box.getCenter(new THREE.Vector3()), s = Math.max(box.getSize(new THREE.Vector3()).length(), .1); this.controls.target.copy(c); this.camera.position.copy(c).add(new THREE.Vector3(s * .58, s * .45, s * .58)); this.camera.near = Math.max(s / 10000, .01); this.camera.far = Math.max(s * 20, 2000); this.camera.updateProjectionMatrix(); this.camera.lookAt(c); this.requestRender(); }
  select(row, fit = false) { const b = this.box(row); if (!b) return; if (this.helper) this.scene.remove(this.helper); this.helper = new THREE.Box3Helper(b, 0xff2f6e); this.scene.add(this.helper); if (fit) { const c = b.getCenter(new THREE.Vector3()), s = Math.max(b.getSize(new THREE.Vector3()).length(), .1); this.controls.target.copy(c); this.camera.position.copy(c).add(new THREE.Vector3(s * 2.2, s * 1.6, s * 2.2)); } this.requestRender(); }
  pick(e) { if (!this.model) return; const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -((e.clientY - rect.top) / rect.height * 2 - 1)); this.ray.setFromCamera(this.pointer, this.camera); const hit = this.ray.intersectObject(this.model, true).find((x) => x.object.visible !== false); if (!hit) return; let n = hit.object, row = null; while (n && !row) { const id = String(n.userData?.revexElementId || ''); if (id) row = this.byId.get(id) || null; n = n.parent; } if (row) { this.select(row); const btn = document.querySelector(`.tree-item[data-element-id="${CSS.escape(String(row.id))}"]`); btn?.click(); } }

  populateFloors() { const select = $('#walk-floor'), levels = this.data?.levels || []; if (!select) return; select.innerHTML = '<option value="">Floor</option>' + levels.map((l) => `<option value="${+l.elevation || 0}">${String(l.name || 'Level').replace(/[&<>]/g, '')}</option>`).join(''); if (levels.length) { this.floor = +levels[0].elevation || 0; select.value = String(this.floor); } }
  look() { const d = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); this.camera.lookAt(this.camera.position.clone().add(d)); }
  startWalk() { if (this.walkFrame || !this.walk) return; let last = performance.now(); const tick = (now) => { this.walkFrame = 0; if (!this.walk || !this.keys.size) { this.requestRender(); return; } const dt = Math.min((now - last) / 1000, .05); last = now; const speed = Math.max((this.bounds?.getSize(new THREE.Vector3()).length() || 40) / 55, 2), f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), m = new THREE.Vector3(); if (this.keys.has('w')) m.add(f); if (this.keys.has('s')) m.sub(f); if (this.keys.has('d')) m.add(r); if (this.keys.has('a')) m.sub(r); if (this.keys.has('q')) m.y--; if (this.keys.has('e')) m.y++; if (m.lengthSq()) { m.normalize().multiplyScalar(speed * dt); this.camera.position.add(m); if (!this.keys.has('q') && !this.keys.has('e')) this.camera.position.y = this.floor + this.eye; this.look(); this.renderer.render(this.scene, this.camera); } this.walkFrame = requestAnimationFrame(tick); }; this.walkFrame = requestAnimationFrame(tick); }
  walkOn(on) { this.walk = !!on; this.controls.enabled = !this.walk; this.keys.clear(); if (this.walk && this.bounds) { const c = this.bounds.getCenter(new THREE.Vector3()); this.camera.position.set(c.x, this.floor + this.eye, c.z); this.yaw = 0; this.pitch = 0; this.look(); } this.requestRender(); }
  toggleWalk(on) { this.walkOn(on); }
  setWalkFloor(v) { this.floor = +v || 0; if (this.walk) this.camera.position.y = this.floor + this.eye; this.requestRender(); }
  setWalkHeight(v) { this.eye = Math.max(2.5, Math.min(9, +v || 5.5)); if (this.walk) this.camera.position.y = this.floor + this.eye; this.requestRender(); }
  setFov(v) { this.camera.fov = Math.max(30, Math.min(90, +v || 55)); this.camera.updateProjectionMatrix(); this.requestRender(); }

  setSectionEnabled(on) { this.section.enabled = !!on; this.applySection(); }
  setSectionAxis(axis, value) { if (axis === 'x') this.section.right = +value || 1; else if (axis === 'y') this.section.back = +value || 1; else if (axis === 'z') this.section.top = +value || 1; this.applySection(); }
  resetSection() { this.section = { enabled: this.section.enabled, left: 0, right: 1, front: 0, back: 1, bottom: 0, top: 1 }; this.applySection(); }
  applySection() { const planes = []; if (this.section.enabled && this.bounds) { const b = this.bounds, s = b.getSize(new THREE.Vector3()); const lx = b.min.x + s.x * this.section.left, rx = b.min.x + s.x * this.section.right, fz = b.min.z + s.z * this.section.front, bz = b.min.z + s.z * this.section.back, by = b.min.y + s.y * this.section.bottom, ty = b.min.y + s.y * this.section.top; planes.push(new THREE.Plane(new THREE.Vector3(1, 0, 0), -lx), new THREE.Plane(new THREE.Vector3(-1, 0, 0), rx), new THREE.Plane(new THREE.Vector3(0, 0, 1), -fz), new THREE.Plane(new THREE.Vector3(0, 0, -1), bz), new THREE.Plane(new THREE.Vector3(0, 1, 0), -by), new THREE.Plane(new THREE.Vector3(0, -1, 0), ty)); } this.model?.traverse?.((n) => { if (!n.isMesh) return; for (const m of (Array.isArray(n.material) ? n.material : [n.material]).filter(Boolean)) { m.clippingPlanes = planes; m.needsUpdate = true; } }); this.requestRender(); }

  snapshot() { try { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); } catch (_) { return ''; } }
  captureTopPlan() { return this.snapshot(); }
  cameraState() { return { position: this.camera.position.toArray(), quaternion: this.camera.quaternion.toArray(), fov: this.camera.fov, target: this.controls.target.toArray(), walk: this.walk, floor: this.floor, eye: this.eye }; }
  canTransform(row) { return !!this.nodesByKey.get(this.key(row))?.length; }
}

let viewer = null;
function sourceState(detail = {}) { return detail.localPackage || detail.cloudState || window.__revexState?.cloudState || null; }
async function loadFromApp(detail = {}) { if (!viewer) return; const data = detail.viewerData || window.__revexState?.viewerData || null, state = sourceState(detail); if (!data || !state) return; try { await viewer.load(state, data); } catch (e) { diag('ERROR', 'VIEWER_R108_LOAD', e?.message || String(e)); } }

function bind() {
  const host = window.__revexViewerHostR21 || $('#viewer'); if (!host || host.id !== 'viewer' || viewer) return false;
  viewer = new Viewer(host); window.__revexViewerR26Instance = viewer; window.__revexViewerR108Instance = viewer;
  viewer.setActive(!$('#view-bim')?.hidden);
  $('#fit-model')?.addEventListener('click', () => viewer.fit()); $('#fit-model-rail')?.addEventListener('click', () => viewer.fit());
  $('#detail-toggle')?.addEventListener('click', () => viewer.loadDetailed());
  $('#walk-toggle')?.addEventListener('click', (e) => { const on = !e.currentTarget.classList.contains('active'); e.currentTarget.classList.toggle('active', on); $('#walk-controls').hidden = !on; viewer.walkOn(on); });
  $('#walk-floor')?.addEventListener('change', (e) => viewer.setWalkFloor(e.target.value)); $('#walk-height')?.addEventListener('input', (e) => viewer.setWalkHeight(e.target.value)); $('#walk-fov')?.addEventListener('input', (e) => viewer.setFov(e.target.value));
  $('#section-toggle')?.addEventListener('click', (e) => { const on = !e.currentTarget.classList.contains('active'); e.currentTarget.classList.toggle('active', on); e.currentTarget.setAttribute('aria-expanded', String(on)); const panel = $('#section-controls'); if (panel) panel.hidden = !on; viewer.setSectionEnabled(on); });
  $('#section-reset')?.addEventListener('click', () => viewer.resetSection());
  for (const [id, key] of [['section-left', 'left'], ['section-right', 'right'], ['section-front', 'front'], ['section-back', 'back'], ['section-bottom', 'bottom'], ['section-top', 'top']]) $('#'+id)?.addEventListener('input', (e) => { viewer.section[key] = (+e.target.value || 0) / 100; viewer.applySection(); });
  window.addEventListener('revex:source-revision-loaded', (e) => loadFromApp(e.detail || {}));
  window.addEventListener('revex:bim-overlays-changed', (e) => viewer.setOverlays(e.detail?.overlays || []));
  window.addEventListener('revex:bim-appearances-changed', (e) => viewer.setAppearances(e.detail?.appearances || []));
  setTimeout(() => loadFromApp({ viewerData: window.__revexState?.viewerData, cloudState: window.__revexState?.cloudState }), 0);
  window.dispatchEvent(new CustomEvent('revex:viewer-host-ready', { detail: { build: BUILD, singleOwner: true } }));
  return true;
}

function start() { if (bind()) return; const f = () => { if (bind()) window.removeEventListener('revex:viewer-host-ready', f); }; window.addEventListener('revex:viewer-host-ready', f); setTimeout(bind, 250); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
console.log('[REVEX] viewer ' + BUILD, { singleOwner: true, lightweightFirst: true, exactGeometryExplicitOnly: true, projectDataSchema: 'unchanged' });
