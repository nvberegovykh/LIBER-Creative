import * as THREE from 'three';

// The viewer normalizes exact Revit geometry into internal feet (including FBX).
// Measurements stay local to the loaded revision and never edit model geometry.
export function formatDistance(feet) {
  const inches = Math.round(feet * 12 * 8) / 8;
  const wholeFeet = Math.floor(inches / 12), remainder = inches - wholeFeet * 12;
  return `${wholeFeet}′ ${Number(remainder.toFixed(3))}″ · ${(feet * .3048).toFixed(3)} m`;
}

function install(v) {
  const button = document.querySelector('#measure-toggle');
  if (!button || v.measurement) return;
  const canvas = v.renderer.domElement, group = new THREE.Group();
  group.name = 'REVEX_MEASURE'; v.scene.add(group);
  const panel = document.createElement('div'); panel.className = 'bim-measure-panel'; panel.hidden = true;
  panel.innerHTML = '<output aria-live="polite">Choose the first point on the model.</output><div><button type="button" data-measure-clear>Clear</button><button type="button" data-measure-done>Done</button></div>';
  v.host.parentElement.append(panel);
  const output = panel.querySelector('output');
  const state = { active: false, points: [], distanceFeet: null, loadToken: v.loadToken };
  const dispose = () => { for (const child of [...group.children]) { child.geometry?.dispose(); child.material?.dispose(); group.remove(child); } };
  function clear() { dispose(); state.points = []; state.distanceFeet = null; output.textContent = 'Choose the first point on the model.'; v.requestRender(); }
  function setActive(active) {
    state.active = active; panel.hidden = !active; group.visible = active;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    canvas.classList.toggle('bim-measuring', active);
    if (active) {
      if (v.walk) v.walkOn(false);
      if (document.pointerLockElement === canvas) document.exitPointerLock?.();
      if (state.loadToken !== v.loadToken) clear();
      state.loadToken = v.loadToken;
      if (!v.detailLoaded) output.textContent = 'Wait for the exact model to load before measuring.';
    }
    v.requestRender();
  }
  function usable(hit) {
    if (!hit.object.isMesh || hit.object.name.startsWith('REVEX_PROXY_')) return false;
    for (let node = hit.object; node; node = node.parent) if (!node.visible || node.userData?.revexFallbackOnly) return false;
    const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face?.materialIndex || 0] : hit.object.material;
    if (!material || material.visible === false || material.opacity === 0) return false;
    const clipped = (material.clippingPlanes || []).map(plane => plane.distanceToPoint(hit.point) < 0);
    return !(material.clipIntersection ? clipped.length && clipped.every(Boolean) : clipped.some(Boolean));
  }
  function pick(event) {
    if (!v.detailLoaded || state.loadToken !== v.loadToken) { clear(); setActive(false); return; }
    const rect = canvas.getBoundingClientRect(), pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, v.camera);
    v.scene.updateMatrixWorld(true);
    const targets = [v.model, ...v.editGroups.values()].filter(Boolean);
    const hit = ray.intersectObjects(targets, true).find(usable);
    if (!hit) { output.textContent = 'Choose a visible model surface. Empty space and placeholder geometry cannot be measured.'; return; }
    if (state.points.length === 2) clear();
    const point = hit.point.clone();
    if (state.points.length && state.points[0].distanceTo(point) < .001) { output.textContent = 'Choose a different second point.'; return; }
    state.points.push(point);
    // Points render at a consistent screen size while orbiting or zooming.
    const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([point]), new THREE.PointsMaterial({ color: 0xff2b80, size: 9, sizeAttenuation: false, depthTest: false }));
    dot.renderOrder = 1000; group.add(dot);
    if (state.points.length === 1) output.textContent = 'Choose the second point. Drag to orbit; scroll to zoom.';
    else {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(state.points), new THREE.LineBasicMaterial({ color: 0xff2b80, depthTest: false }));
      line.renderOrder = 999; group.add(line);
      state.distanceFeet = state.points[0].distanceTo(state.points[1]);
      output.textContent = `${formatDistance(state.distanceFeet)} — straight-line distance`;
    }
    v.requestRender();
  }
  let down = null, moved = false;
  canvas.addEventListener('pointerdown', event => { down = [event.clientX, event.clientY]; moved = false; }, true);
  canvas.addEventListener('pointermove', event => { if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) moved = true; }, true);
  canvas.addEventListener('pointercancel', () => { down = null; moved = true; }, true);
  // Capture before the viewer's selection handler; orbit dragging still works.
  canvas.addEventListener('click', event => { if (!state.active) return; event.preventDefault(); event.stopImmediatePropagation(); if (down && !moved) pick(event); down = null; }, true);
  button.addEventListener('click', () => setActive(!state.active));
  panel.querySelector('[data-measure-clear]').onclick = clear;
  panel.querySelector('[data-measure-done]').onclick = () => setActive(false);
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && state.active) setActive(false); });
  window.addEventListener('revex:walk-mode-changed', event => { if (event.detail?.active) setActive(false); });
  const reset = () => { clear(); setActive(false); };
  window.addEventListener('revex:project-boundary', reset);
  window.addEventListener('revex:source-revision-loaded', reset);
  window.addEventListener('revex:viewer-mode', () => {
    if (state.loadToken !== v.loadToken) reset();
    else if (state.active && v.detailLoaded && !state.points.length) clear();
  });
  v.measurement = { state, clear, setActive };
}
function boot() { const v = window.__revexViewerR26Instance; if (v) install(v); else setTimeout(boot, 100); }
boot();
