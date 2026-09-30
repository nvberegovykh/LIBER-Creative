import * as THREE from 'three';

// One surface picker for measurements and browser placement. Never invent a
// point along the camera ray when the pointer misses the actual geometry.
export function visibleSurface(hit) {
  const object = hit.object;
  if (!object.isMesh || object.name.startsWith('REVEX_PROXY_')) return false;
  for (let node = object; node; node = node.parent) {
    if (!node.visible || node.userData?.revexFallbackOnly) return false;
  }
  const material = Array.isArray(object.material) ? object.material[hit.face?.materialIndex || 0] : object.material;
  if (!material || material.visible === false || material.opacity === 0) return false;
  const clipped = (material.clippingPlanes || []).map(plane => plane.distanceToPoint(hit.point) < 0);
  return !(material.clipIntersection ? clipped.length && clipped.every(Boolean) : clipped.some(Boolean));
}

export function pickSurface(viewer, clientX, clientY, { assets = true } = {}) {
  if (!viewer?.detailLoaded) return null;
  const rect = viewer.renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  viewer.scene.updateMatrixWorld(true);
  viewer.camera.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2), viewer.camera);
  const targets = [viewer.model, ...viewer.editGroups.values()];
  if (assets) for (const item of window.RevexWebAssets?.placed?.values?.() || []) if (!item.pending) targets.push(item.group);
  return ray.intersectObjects(targets.filter(Boolean), true).find(visibleSurface) || null;
}

export function surfaceAnchor(hit) {
  const matrix = new THREE.Matrix4().copy(hit.object.matrixWorld);
  if (hit.object.isInstancedMesh && Number.isInteger(hit.instanceId)) {
    const instance = new THREE.Matrix4();
    hit.object.getMatrixAt(hit.instanceId, instance); matrix.multiply(instance);
  }
  return { object: hit.object, instanceId: hit.instanceId, face: hit.face, local: hit.point.clone().applyMatrix4(matrix.invert()) };
}

export function anchorPoint(anchor, target = new THREE.Vector3()) {
  target.copy(anchor.local);
  if (anchor.object.isInstancedMesh && Number.isInteger(anchor.instanceId)) {
    const instance = new THREE.Matrix4(); anchor.object.getMatrixAt(anchor.instanceId, instance); target.applyMatrix4(instance);
  }
  return target.applyMatrix4(anchor.object.matrixWorld);
}
