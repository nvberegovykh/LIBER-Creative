/* REVEX r54 self-hosted renderer overlay.
 * Default path: existing LIBER/Firebase session -> private broker -> private GPU.
 * No Hugging Face account, model token, Google AI popup, or browser inference.
 * Gemini remains an explicit fallback handled by render-agent.js.
 */
(function (root) {
  'use strict';

  const BUILD = '20260816r54-selfhost-render1';
  const MODEL = 'Qwen/Qwen-Image-Edit-2511';
  const MODEL_REVISION = '6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9';
  const Store = root.RevexStore;
  const state = root.__revexState;
  const $ = (selector, base = document) => base.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  let running = false;
  let allowGoogleOnce = false;
  let activeJob = null;
  let resultBlob = null;
  let resultObjectUrl = '';
  let unsubscribeJob = null;

  const diagnostic = (level, stage, message, detail = {}) => {
    try { root.__revexBrowserDiagnostics?.emit?.(level, stage, message, { initiator: 'self-host render r54', ...detail }); } catch (_) {}
  };

  function toast(message, bad = false) {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('bad', bad);
    node.hidden = false;
    clearTimeout(node.__renderToast);
    node.__renderToast = setTimeout(() => { node.hidden = true; }, 4200);
  }

  function setStatus(message, tone = '') {
    const node = $('#render-status');
    if (!node) return;
    node.textContent = message;
    node.className = `render-status${tone ? ` ${tone}` : ''}`;
  }

  function activeViewer() { return root.__revexViewerR26Instance || null; }

  function captureReference() {
    const viewer = activeViewer();
    const direct = viewer?.captureRenderReference?.();
    if (direct?.imageDataUrl) return direct;
    try {
      viewer?.renderer?.render?.(viewer.scene, viewer.camera);
      const imageDataUrl = viewer?.renderer?.domElement?.toDataURL?.('image/png') || '';
      if (imageDataUrl) return { imageDataUrl, camera: viewer?.cameraState?.() || null, sourceRevision: state?.cloudState?.revision || null };
    } catch (_) {}
    return null;
  }

  function cameraContext(reference) {
    const camera = reference?.camera || activeViewer()?.cameraState?.() || null;
    if (!camera) return 'Preserve the supplied REVEX viewport framing exactly.';
    const position = Array.isArray(camera.position) ? camera.position.map((x) => Number(x).toFixed(3)).join(', ') : 'unknown';
    return `Camera lock: FOV ${Number(camera.fov || 55).toFixed(1)}°, position [${position}]. Preserve projection, crop and framing exactly.`;
  }

  function refinedPrompt(userPrompt, reference) {
    const environment = $('#render-environment')?.value || 'Natural daylight';
    const staging = $('#render-staging')?.value || 'Preserve modeled objects only';
    const people = $('#render-people')?.value || 'None';
    const useMaterials = Boolean($('#render-materials')?.checked);
    const project = state?.project?.name || state?.project?.title || state?.projectId || 'REVEX project';
    return [
      `Create one realistic architectural visualization for ${project} by editing the supplied REVEX BIM viewport.`,
      'GEOMETRY LOCK — the source viewport is authoritative BIM evidence. Preserve camera projection, crop, silhouette, wall positions, openings, windows, doors, curtain-wall grids and panels, floor and ceiling lines, stairs, roofs, modeled objects, dimensions and proportions exactly. Do not add, delete, move, resize, rotate or redesign architectural geometry.',
      cameraContext(reference),
      'Do not reproduce viewer UI, annotations, tags, selection helpers, technical overlays, labels, text, logos or watermarks.',
      useMaterials ? 'Preserve visible Revit material/color/texture intent; improve only physically plausible realism and texture scale.' : 'Use physically plausible finishes without changing the design.',
      `Lighting/environment: ${environment}. Staging rule: ${staging}. People: ${people}.`,
      'Prefer restrained photographic realism over creative reinterpretation. If ambiguous, preserve the source rather than inventing geometry.',
      `User instruction: ${String(userPrompt || '').trim() || 'Create a clean realistic architectural rendering of the current viewport.'}`
    ].join('\n');
  }

  function prepareSource(dataUrl, maxEdge = 2048) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        try {
          const longest = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
          if (!longest || longest <= maxEdge) return resolve(dataUrl);
          const scale = maxEdge / longest;
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(32, Math.round((image.naturalWidth || image.width) * scale));
          canvas.height = Math.max(32, Math.round((image.naturalHeight || image.height) * scale));
          const context = canvas.getContext('2d', { alpha: false });
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.94));
        } catch (error) { reject(error); }
      };
      image.onerror = () => reject(new Error('REVEX could not prepare the clean BIM viewport for rendering.'));
      image.src = dataUrl;
    });
  }

  async function callBroker(payload) {
    const fs = root.firebaseService;
    await fs?.waitForInit?.();
    const modular = root.firebaseModular;
    if (modular?.httpsCallable && modular?.getFunctions && fs?.app) {
      const functions = fs.functionsByRegion?.['us-central1'] || modular.getFunctions(fs.app, 'us-central1');
      const callable = modular.httpsCallable(functions, 'runRevexRender', { timeout: 3600000 });
      const response = await callable(payload);
      return response?.data ?? null;
    }
    if (fs?.callFunction) return fs.callFunction('runRevexRender', payload);
    throw new Error('REVEX private render broker is unavailable in this session.');
  }

  const STATUS_TEXT = {
    queued: 'Render queued — REVEX remains fully usable while the GPU job runs…',
    UPLOADING_SOURCE: 'Uploading the clean viewport to the private render job…',
    DISPATCHED: 'Private GPU worker accepted the job…',
    READING_SOURCE: 'GPU worker is reading the authoritative viewport…',
    WARMING_MODEL: 'Warming the pinned public Qwen model. First render on a cold worker can take longer; no login is required…',
    RENDERING: 'Rendering off-device on the private REVEX GPU…',
    UPLOADING: 'Render complete on GPU; publishing the result…',
    COMPLETE: 'Render complete.',
    FAILED: 'Render failed.'
  };

  function subscribeJob(projectId, jobId) {
    try { unsubscribeJob?.(); } catch (_) {}
    unsubscribeJob = null;
    if (!Store?.isCloud?.() || !Store?.api?.onSnapshot || !Store?.db) return;
    try {
      const ref = Store.api.doc(Store.db, 'projects', projectId, 'revexRenders', jobId);
      unsubscribeJob = Store.api.onSnapshot(ref, (snap) => {
        const job = snap.exists() ? snap.data() || {} : {};
        const status = String(job.status || '');
        const message = STATUS_TEXT[status] || (status ? `REVEX render · ${status}` : 'REVEX render queued…');
        setStatus(message, status === 'FAILED' ? 'bad' : status === 'COMPLETE' ? 'good' : 'busy');
      }, () => {});
    } catch (_) {}
  }

  function showResult(blob, sourceUrl, result) {
    resultBlob = blob;
    if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
    resultObjectUrl = URL.createObjectURL(blob);
    const stage = $('#render-ai-stage');
    if (!stage) return;
    stage.innerHTML = `<div class="render-ai-compare">
      ${sourceUrl ? `<img class="render-ai-source" src="${esc(sourceUrl)}" alt="REVEX viewport source" />` : ''}
      <img class="render-ai-result" src="${esc(resultObjectUrl)}" alt="REVEX self-hosted architectural render" />
    </div>
    <div class="render-ai-stage-tools"><button id="render-selfhost-source" type="button">Hold source</button><button id="render-selfhost-save" type="button">Save to Design Book</button></div>`;
    const generated = $('.render-ai-result', stage);
    const source = $('.render-ai-source', stage);
    const compare = (on) => { if (generated) generated.style.opacity = on ? '0' : '1'; if (source) source.style.opacity = '1'; };
    $('#render-selfhost-source', stage)?.addEventListener('pointerdown', () => compare(true));
    $('#render-selfhost-source', stage)?.addEventListener('pointerup', () => compare(false));
    $('#render-selfhost-source', stage)?.addEventListener('pointerleave', () => compare(false));
    $('#render-selfhost-save', stage)?.addEventListener('click', saveToDesignBook);
    const dimensions = result?.width && result?.height ? `${result.width}×${result.height}` : ($('#revex-selfhost-resolution')?.value || '1K');
    const seconds = Number(result?.inferenceSeconds || 0);
    $('#render-workspace-meta').textContent = `${MODEL.split('/').pop()} · ${dimensions}${seconds ? ` · ${seconds.toFixed(1)}s GPU` : ''}`;
    setStatus('Render complete · private REVEX GPU · no external model login', 'good');
  }

  async function saveToDesignBook() {
    if (!resultBlob || !state?.projectId) return;
    const chapterId = $('#render-chapter')?.value || state.activeChapter || '';
    const chapter = (state.designData?.chapters || []).find((row) => String(row.id) === String(chapterId));
    if (!chapter) return toast('Choose a Design Book chapter first.', true);
    try {
      setStatus('Saving generated render into the Design Book…', 'busy');
      const formed = { ...chapter, ...(state.chapterEdits?.get?.(chapter.id) || {}) };
      const file = new File([resultBlob], `REVEX_${Date.now()}_Qwen2511.jpg`, { type: resultBlob.type || 'image/jpeg' });
      const images = await Store.uploadChapterImage(state.projectId, chapter.id, 'renders', file, formed.renders || []);
      state.chapterEdits?.set?.(chapter.id, { ...(state.chapterEdits?.get?.(chapter.id) || {}), renders: images });
      if (activeJob?.id) await Store.updateRenderJob?.(state.projectId, activeJob.id, { status: 'saved', resultUrl: images.at?.(-1)?.url || images[images.length - 1]?.url || null, chapterId: chapter.id });
      setStatus(`Saved to Design Book · ${chapter.title}`, 'good');
      toast(`Render saved to ${chapter.title}.`);
    } catch (error) {
      setStatus(error?.message || 'Could not save the render.', 'bad');
      toast(error?.message || 'Could not save the render.', true);
    }
  }

  async function runSelfHosted(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    if (running) return;
    if (!state?.projectId) return toast('Choose a REVEX project first.', true);
    if (!Store?.isCloud?.()) return toast('Sign in to LIBER Apps to use the private render worker.', true);
    const reference = captureReference();
    if (!reference?.imageDataUrl) return toast('The current BIM viewport is not ready to render.', true);

    const button = $('#render-google-generate');
    const userPrompt = String($('#render-prompt')?.value || '').trim();
    const prompt = refinedPrompt(userPrompt, reference);
    const resolution = $('#revex-selfhost-resolution')?.value || '1K';
    const sourceImageDataUrl = await prepareSource(reference.imageDataUrl);
    running = true;
    if (button) { button.disabled = true; button.textContent = 'Rendering off-device…'; }
    setStatus('Queuing private GPU render. BIM viewer remains responsive…', 'busy');
    const stage = $('#render-ai-stage');
    if (stage) stage.innerHTML = `<div class="render-ai-loading"><img src="${esc(reference.imageDataUrl)}" alt="Current BIM viewport" /><div><strong>REVEX GPU</strong><span>Qwen Image Edit 2511 · geometry locked · off-device</span></div></div>`;

    try {
      activeJob = await Store.createRenderJob(state.projectId, {
        contextKind: state.selectedDesign ? 'design' : state.selectedElement ? 'bim' : 'view',
        contextLabel: state.selectedDesign?.label || state.selectedElement?.name || state.viewerData?.source?.viewName || 'Current BIM viewport',
        elementId: state.selectedElement?.id || null,
        designItemId: state.selectedDesign?.id || null,
        chapterId: $('#render-chapter')?.value || null,
        revision: state.cloudState?.revision || null,
        provider: 'revex-selfhosted',
        model: MODEL,
        modelRevision: MODEL_REVISION,
        prompt: userPrompt,
        refinedPrompt: prompt,
        sourceCamera: reference.camera || null,
        sourceRevision: reference.sourceRevision || null,
        settings: { resolution, preserveGeometry: true, asynchronousClient: true },
        status: 'queued'
      });
      subscribeJob(state.projectId, activeJob.id);
      diagnostic('INFO', 'SELFHOST_RENDER_QUEUED', 'Private REVEX render queued.', { projectId: state.projectId, jobId: activeJob.id, resolution });
      const result = await callBroker({
        schema: 'liber.revex.render-broker-request.v1',
        projectId: state.projectId,
        jobId: activeJob.id,
        sourceImageDataUrl,
        prompt,
        seed: Math.floor(Math.random() * 0x7fffffff),
        settings: { resolution, preserveGeometry: true, sourceRevision: reference.sourceRevision || state.cloudState?.revision || null }
      });
      if (!result?.ok || !result?.resultUrl) throw new Error(result?.message || result?.error || 'REVEX GPU worker returned no render.');
      const response = await fetch(result.resultUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`REVEX render result could not be opened (HTTP ${response.status}).`);
      const blob = await response.blob();
      showResult(blob, reference.imageDataUrl, result);
      diagnostic('INFO', 'SELFHOST_RENDER_COMPLETE', 'Private REVEX render completed.', { projectId: state.projectId, jobId: activeJob.id, model: MODEL, modelRevision: MODEL_REVISION });
    } catch (error) {
      const message = String(error?.message || error || 'REVEX private render failed.').replace(/^Firebase:\s*/i, '');
      setStatus(message, 'bad');
      if (activeJob?.id) await Store.updateRenderJob?.(state.projectId, activeJob.id, { status: 'FAILED', error: message }).catch(() => {});
      diagnostic('ERROR', 'SELFHOST_RENDER_FAILED', message, { projectId: state.projectId, jobId: activeJob?.id || null });
      const host = $('#render-agent-messages');
      if (host) {
        const row = document.createElement('div');
        row.className = 'render-agent-message tool error';
        row.innerHTML = `<div class="render-agent-message-body">${esc(message)}<br><button id="revex-fallback-inline" type="button">Use Google fallback</button></div>`;
        host.appendChild(row);
        $('#revex-fallback-inline', row)?.addEventListener('click', useGoogleFallback);
      }
    } finally {
      running = false;
      try { unsubscribeJob?.(); } catch (_) {}
      unsubscribeJob = null;
      if (button) { button.disabled = false; button.textContent = 'Render current viewport'; }
    }
  }

  function useGoogleFallback(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    allowGoogleOnce = true;
    const hiddenResolution = $('#google-ai-resolution');
    const selfResolution = $('#revex-selfhost-resolution')?.value || '1K';
    if (hiddenResolution) hiddenResolution.value = selfResolution;
    $('#render-google-generate')?.click();
  }

  function decorate() {
    const dialog = $('#render-dialog');
    const panel = $('#render-agent-panel');
    if (!dialog || !panel) return;
    dialog.classList.add('revex-selfhost-render');
    const eyebrow = $('.render-head .eyebrow', dialog); if (eyebrow) eyebrow.textContent = 'REVEX PRIVATE GPU + PUBLIC QWEN';
    const title = $('#render-dialog-title', dialog); if (title) title.textContent = 'REVEX Render';
    const head = $('.render-workspace-head strong', dialog); if (head) head.textContent = 'REVEX Render Engine';
    const chip = $('#render-agent-capability');
    if (chip) { chip.textContent = 'REVEX GPU · no extra login'; chip.dataset.tone = 'good'; }
    const panelTitle = $('.render-agent-head strong', panel); if (panelTitle) panelTitle.textContent = 'REVEX AI Render';
    const panelSub = $('.render-agent-head span:not(.render-agent-chip)', panel); if (panelSub) panelSub.textContent = 'off-device · geometry locked';

    const googleConfig = $('.render-google-config', panel);
    if (googleConfig && !googleConfig.dataset.selfhosted) {
      const priorResolution = $('#google-ai-resolution')?.value || '1K';
      googleConfig.dataset.selfhosted = '1';
      googleConfig.innerHTML = `<div class="render-selfhost-runtime"><strong>Qwen Image Edit 2511</strong><span>private Cloud Run GPU · pinned public Apache-2.0 model · no Hugging Face login</span></div>
        <label>Output<select id="revex-selfhost-resolution"><option value="1K">1K · fastest</option><option value="2K">2K · review</option><option value="4K">4K · final</option></select></label>
        <select id="google-ai-resolution" hidden><option value="1K">1K</option><option value="2K">2K</option><option value="4K">4K</option></select>
        <button id="revex-google-fallback" class="button ghost" type="button">Google fallback</button>`;
      $('#revex-selfhost-resolution').value = priorResolution;
      $('#google-ai-resolution').value = priorResolution;
      $('#revex-selfhost-resolution')?.addEventListener('change', () => { const h = $('#google-ai-resolution'); if (h) h.value = $('#revex-selfhost-resolution').value; });
      $('#revex-google-fallback')?.addEventListener('click', useGoogleFallback);
    }
    const button = $('#render-google-generate');
    if (button && !running) button.textContent = 'Render current viewport';
    const status = $('#render-status');
    if (status && /connect google ai|google ai connected|permission/i.test(status.textContent || ''))
      setStatus('Ready · private REVEX GPU · no model login required', 'good');
  }

  function interceptClick(event) {
    const target = event.target?.closest?.('#render-google-generate');
    if (!target) return;
    if (allowGoogleOnce) { allowGoogleOnce = false; return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    runSelfHosted(event);
  }

  function interceptSubmit(event) {
    if (event.target?.id !== 'render-form') return;
    if (allowGoogleOnce) { allowGoogleOnce = false; return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    runSelfHosted(event);
  }

  document.addEventListener('click', interceptClick, true);
  document.addEventListener('submit', interceptSubmit, true);
  const observer = new MutationObserver(() => decorate());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const dialogObserver = new MutationObserver(() => setTimeout(decorate, 0));
  const attachDialogObserver = () => {
    const dialog = $('#render-dialog');
    if (dialog) dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['hidden'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { decorate(); attachDialogObserver(); }, { once: true });
  else { decorate(); attachDialogObserver(); }
  root.__revexSelfHostedRenderR54 = Object.freeze({ build: BUILD, model: MODEL, revision: MODEL_REVISION, provider: 'revex-selfhosted', browserInference: false, extraLogin: false });
  console.info('[REVEX] self-hosted renderer ' + BUILD, { model: MODEL, revision: MODEL_REVISION, browserInference: false, huggingFaceLogin: false, googleFallback: true });
})(window);
