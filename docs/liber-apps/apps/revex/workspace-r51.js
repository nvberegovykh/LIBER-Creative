import * as THREE from 'three';

const BUILD = '20260815r49-workspace1';
const state = window.__revexState;
const $ = (selector, root = document) => root.querySelector(selector);

if (!window.__revexWorkspaceR51) {
  window.__revexWorkspaceR51 = { build: BUILD };

  const diagnostic = (level, stage, message, detail = {}) => {
    try { window.__revexBrowserDiagnostics?.emit?.(level, stage, message, { initiator: 'workspace r51', ...detail }); } catch (_) {}
  };

  function activeViewer() {
    return window.__revexViewerR26Instance || null;
  }

  function makeBoxOutlineGeometry(v) {
    const positions = [];
    const edges = [
      [0,1],[1,3],[3,2],[2,0], [4,5],[5,7],[7,6],[6,4], [0,4],[1,5],[2,6],[3,7]
    ];
    for (const row of v.data?.elements || []) {
      const box = v.box?.(row);
      if (!box || box.isEmpty?.()) continue;
      const min = box.min, max = box.max;
      const c = [
        [min.x,min.y,min.z],[max.x,min.y,min.z],[min.x,max.y,min.z],[max.x,max.y,min.z],
        [min.x,min.y,max.z],[max.x,min.y,max.z],[min.x,max.y,max.z],[max.x,max.y,max.z]
      ];
      for (const [a,b] of edges) positions.push(...c[a], ...c[b]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  function applyPresentation(v) {
    if (!v?.scene || !v?.renderer) return;
    v.scene.background = new THREE.Color(0x171715);
    v.renderer.toneMappingExposure = 1.02;
    v.scene.traverse((node) => {
      if (!node.isMesh || node.userData?.revexPresentationAdjusted) return;
      node.userData.revexPresentationAdjusted = true;
      const materials = (Array.isArray(node.material) ? node.material : [node.material]).filter(Boolean);
      for (const material of materials) {
        if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
          material.roughness = Math.max(Number(material.roughness ?? 0.75), 0.78);
          material.metalness = Math.min(Number(material.metalness ?? 0), 0.18);
          if (material.color) material.color.lerp(new THREE.Color(0xe7dfcf), 0.035);
          material.needsUpdate = true;
        }
      }
    });

    if (v.__revexObjectOutlineLayer) {
      v.scene.remove(v.__revexObjectOutlineLayer);
      v.__revexObjectOutlineLayer.geometry?.dispose?.();
      v.__revexObjectOutlineLayer.material?.dispose?.();
    }
    const geometry = makeBoxOutlineGeometry(v);
    const material = new THREE.LineBasicMaterial({ color: 0xe9e0cf, transparent: true, opacity: 0.105, depthTest: true, depthWrite: false });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = 'REVEX_LIGHTWEIGHT_OBJECT_OUTLINES';
    lines.renderOrder = 5;
    lines.frustumCulled = false;
    v.__revexObjectOutlineLayer = lines;
    v.scene.add(lines);

    const canvas = v.renderer.domElement;
    if (canvas) canvas.classList.add('revex-illustration-canvas');
    v.requestRender?.();
  }

  function captureRenderReference(v) {
    if (!v?.renderer || !v?.scene || !v?.camera) return null;
    const hidden = [v.helper, v.__reviewSectionHelper, v.__revexObjectOutlineLayer].filter(Boolean).map((node) => [node, node.visible]);
    try {
      for (const [node] of hidden) node.visible = false;
      v.renderer.render(v.scene, v.camera);
      const imageDataUrl = v.renderer.domElement.toDataURL('image/png');
      return {
        imageDataUrl,
        camera: v.cameraState?.() || {
          position: v.camera.position.toArray(), quaternion: v.camera.quaternion.toArray(), fov: v.camera.fov
        },
        sourceRevision: state?.cloudState?.revision || null,
        documentTitle: v.data?.source?.documentTitle || '',
        viewName: v.data?.source?.viewName || '',
        modelFormat: state?.viewerMode || state?.cloudState?.modelFormat || ''
      };
    } finally {
      for (const [node, visible] of hidden) node.visible = visible;
      v.requestRender?.();
    }
  }

  function patchWalk(v) {
    if (!v || v.__revexAccWalkR51) return;
    v.__revexAccWalkR51 = true;
    v.__revexWalkPointerLocked = false;
    v.__revexWalkBaseSpeed = 5.2;

    const canvas = v.renderer?.domElement;
    const originalWalkOff = () => {
      v.walk = false;
      v.keys?.clear?.();
      if (v.controls) {
        v.controls.enabled = true;
        const forward = new THREE.Vector3(-Math.sin(v.yaw || 0), 0, -Math.cos(v.yaw || 0));
        v.controls.target.copy(v.camera.position.clone().add(forward.multiplyScalar(12)));
        v.controls.update?.();
      }
      if (document.pointerLockElement === canvas) document.exitPointerLock?.();
      v.requestRender?.();
    };

    v.walkOn = function revexAccWalk(on) {
      if (!this.bounds) return;
      if (!on) return originalWalkOff();
      this.walk = true;
      this.keys?.clear?.();
      if (this.controls) this.controls.enabled = false;
      const direction = new THREE.Vector3();
      this.camera.getWorldDirection(direction);
      this.yaw = Math.atan2(-direction.x, -direction.z);
      this.pitch = Math.asin(Math.max(-0.98, Math.min(0.98, direction.y)));
      const target = this.controls?.target?.clone?.() || this.bounds.getCenter(new THREE.Vector3());
      const horizontal = new THREE.Vector3(direction.x, 0, direction.z).normalize();
      if (!Number.isFinite(horizontal.x)) horizontal.set(0,0,-1);
      this.camera.position.set(
        target.x - horizontal.x * 8,
        Number(this.floor || 0) + Number(this.eye || 5.5),
        target.z - horizontal.z * 8
      );
      this.look?.();
      this.requestRender?.();
      try { canvas?.requestPointerLock?.(); } catch (_) {}
      diagnostic('INFO', 'WALK_START', 'ACC-like Walk started. Click the model for mouse look; WASD moves, Shift accelerates, Esc exits.');
    };

    v.step = function revexAccStep(dt) {
      if (!this.walk) return;
      const diagonal = this.bounds?.getSize(new THREE.Vector3()).length() || 100;
      const base = Math.max(3.4, Math.min(11, diagonal / 90));
      const speed = base * (this.keys?.has?.('ShiftLeft') || this.keys?.has?.('ShiftRight') ? 2.4 : 1);
      const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const delta = new THREE.Vector3();
      if (this.keys?.has?.('KeyW')) delta.add(forward);
      if (this.keys?.has?.('KeyS')) delta.sub(forward);
      if (this.keys?.has?.('KeyD')) delta.add(right);
      if (this.keys?.has?.('KeyA')) delta.sub(right);
      if (delta.lengthSq() > 0) this.camera.position.add(delta.normalize().multiplyScalar(speed * dt));
      const vertical = ((this.keys?.has?.('KeyE') ? 1 : 0) - (this.keys?.has?.('KeyQ') ? 1 : 0)) * speed * 0.55 * dt;
      this.eye = Math.max(2.5, Math.min(9, Number(this.eye || 5.5) + vertical));
      this.camera.position.y = Number(this.floor || 0) + this.eye;
      this.look?.();
    };

    v.startWalkFrames = function revexAccWalkFrames() {
      if (this.walkFrame || !this.walk) return;
      this.lastStep = performance.now();
      const tick = (now) => {
        this.walkFrame = 0;
        if (!this.walk) return;
        const dt = Math.min((now - this.lastStep) / 1000, 0.05);
        this.lastStep = now;
        if (this.keys?.size) this.step(dt);
        this.renderer.render(this.scene, this.camera);
        this.updatePins?.();
        this.walkFrame = requestAnimationFrame(tick);
      };
      this.walkFrame = requestAnimationFrame(tick);
    };

    document.addEventListener('pointerlockchange', () => {
      v.__revexWalkPointerLocked = document.pointerLockElement === canvas;
      if (!v.__revexWalkPointerLocked && v.walk && !document.hidden) {
        // Keep Walk active after Esc only long enough for the button state to unwind cleanly.
        originalWalkOff();
        $('#walk-toggle')?.classList.remove('active');
        const controls = $('#walk-controls'); if (controls) controls.hidden = true;
      }
    });
    document.addEventListener('mousemove', (event) => {
      if (!v.walk || document.pointerLockElement !== canvas) return;
      v.yaw -= event.movementX * 0.0021;
      v.pitch = Math.max(-1.25, Math.min(1.25, v.pitch - event.movementY * 0.0018));
      v.look?.();
      v.requestRender?.();
    }, true);
    canvas?.addEventListener('click', () => {
      if (v.walk && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    });
    document.addEventListener('keydown', (event) => {
      if (!v.walk) return;
      if (/^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|ShiftLeft|ShiftRight)$/.test(event.code)) {
        v.keys?.add?.(event.code); v.startWalkFrames(); event.preventDefault();
      }
    }, true);
    document.addEventListener('keyup', (event) => {
      if (!v.walk) return;
      v.keys?.delete?.(event.code);
    }, true);
  }

  function patchViewer(v) {
    if (!v || v.__revexWorkspaceR51Patched) return Boolean(v);
    v.__revexWorkspaceR51Patched = true;
    patchWalk(v);
    v.captureRenderReference = () => captureRenderReference(v);
    const originalLoad = typeof v.load === 'function' ? v.load.bind(v) : null;
    if (originalLoad) {
      v.load = async (...args) => {
        const result = await originalLoad(...args);
        applyPresentation(v);
        return result;
      };
    }
    applyPresentation(v);
    diagnostic('INFO', 'WORKSPACE_R51', 'Lightweight material nuance, object outlines, clean render capture, and ACC-like Walk installed.');
    return true;
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (patchViewer(activeViewer()) || attempts > 180) clearInterval(timer);
  }, 100);
  window.addEventListener('revex:source-revision-loaded', () => setTimeout(() => patchViewer(activeViewer()), 30));

  console.info('[REVEX] workspace ' + BUILD, {
    sourceTexturesPreserved: true,
    lightweightOutlines: true,
    cleanRenderReference: true,
    accLikeWalk: true,
    spatialObjectsVisible: false
  });
}
