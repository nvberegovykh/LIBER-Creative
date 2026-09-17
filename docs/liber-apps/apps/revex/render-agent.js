(function (root) {
  'use strict';

  const BUILD = '20260820r146-render-broker1';
  const MODEL = 'gemini-3.1-flash-image';
  const REQUEST_SCHEMA = 'liber.revex.google-render-request.v1';
  const JOB_SCHEMA = 'liber.revex.google-render-job.v1';
  const Store = root.RevexStore;
  const state = root.__revexState;
  const $ = (selector, base = document) => base.querySelector(selector);
  let initialized = false;
  let resultBlob = null;
  let resultObjectUrl = '';
  let activeResultPath = '';
  let activeJob = null;
  let locationAbort = null;
  let locationTimer = 0;
  let selectedLocation = null;

  const LOCATION_KEY = 'liber.revex.render.location.v1';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const diagnostic = (level, stage, message, detail = {}) => {
    try { root.__revexBrowserDiagnostics?.emit?.(level, stage, message, { initiator: 'google render current', build: BUILD, ...detail }); } catch (_) {}
  };
  const activeViewer = () => root.__revexViewerR26Instance || null;

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

  async function requireCloudIdentity() {
    const fs = root.firebaseService;
    await fs?.waitForInit?.();
    const uid = String(fs?.auth?.currentUser?.uid || Store?.user?.uid || '');
    if (!Store?.isCloud?.() || !uid) throw new Error('Sign in to LIBER Apps before rendering. Render files are project-isolated and cannot run in local mode.');
    return fs;
  }

  function callableError(error) {
    const code = String(error?.code || 'functions/unknown').replace(/^functions\//, '');
    const message = String(error?.message || 'REVEX Google Render failed.').replace(/^Firebase:\s*/i, '').trim();
    const stage = String(error?.details?.stage || 'BROKER');
    const result = new Error(`${message}${stage && !message.includes(stage) ? ` · Stage: ${stage}` : ''}`);
    result.name = 'RevexGoogleRenderError';
    result.code = code;
    result.stage = stage;
    result.cause = error;
    return result;
  }

  async function callRenderBroker(payload) {
    const fs = await requireCloudIdentity();
    const modular = root.firebaseModular;
    if (modular?.httpsCallable && modular?.getFunctions && fs?.app) {
      try {
        const functions = fs.functionsByRegion?.['us-central1'] || modular.getFunctions(fs.app, 'us-central1');
        const callable = modular.httpsCallable(functions, 'runRevexGoogleRender', { timeout: 540000 });
        const response = await callable(payload);
        return response?.data ?? null;
      } catch (error) { throw callableError(error); }
    }
    if (typeof fs?.callFunction === 'function') {
      try { return await fs.callFunction('runRevexGoogleRender', payload); }
      catch (error) { throw callableError(error); }
    }
    throw new Error('The authenticated REVEX Google Render broker is unavailable in this session.');
  }

  function cameraContext(reference) {
    const camera = reference?.camera || activeViewer()?.cameraState?.() || null;
    if (!camera) return 'Camera metadata unavailable; preserve the attached viewport exactly.';
    const p = Array.isArray(camera.position) ? camera.position.map((x) => Number(x).toFixed(3)).join(', ') : 'unknown';
    return `Camera lock: FOV ${Number(camera.fov || 55).toFixed(1)}°, position [${p}]. Preserve the attached viewport projection and framing exactly.`;
  }

  function selectedContext() {
    const design = state?.selectedDesign;
    const element = state?.selectedElement;
    if (design) return `Design Book position: ${design.chapterTitle || ''} / ${design.label || ''}. Status: ${design.status || 'Not Selected'}.`;
    if (element) return `Selected Revit element: ${element.category || 'Element'} / ${element.name || element.type || element.id || ''}.`;
    return `Current Revit view: ${state?.viewerData?.source?.viewName || '3D'}.`;
  }

  function locationContext() {
    const typed = String($('#render-location')?.value || '').trim();
    const label = String(selectedLocation?.label || typed || '').trim();
    if (!label) return 'Location/environment context: unspecified; do not invent a distinctive city identity.';
    const coordinates = selectedLocation?.lat && selectedLocation?.lon ? ` (${selectedLocation.lat}, ${selectedLocation.lon})` : '';
    return `Location/environment context: ${label}${coordinates}. Use this only for plausible sky, climate, vegetation, distant context and surrounding public realm outside the modeled architecture.`;
  }

  function refinedPrompt(userPrompt, reference) {
    const environment = $('#render-environment')?.value || 'Natural daylight';
    const staging = $('#render-staging')?.value || 'Preserve modeled objects only';
    const people = $('#render-people')?.value || 'None';
    const useMaterials = Boolean($('#render-materials')?.checked);
    const project = state?.project?.name || state?.project?.title || state?.projectId || 'REVEX project';
    return [
      `Create one realistic architectural visualization for ${project} by editing the attached REVEX BIM viewport image.`,
      'GEOMETRY LOCK — treat the attached image as a strict image-space geometry reference. Preserve camera projection, crop, silhouette, wall positions, openings, windows, doors, curtain-wall grids and panels, floor/ceiling lines, object positions, dimensions and proportions exactly. Do not add, delete, move, resize or redesign architectural geometry.',
      cameraContext(reference),
      locationContext(),
      'Remove viewer UI, annotations, tags, selection helpers, technical overlays and temporary linework from the final image. Do not add labels, text, logos or watermarks.',
      useMaterials ? 'Preserve the visible Revit material/color/texture intent. Improve only physically plausible texture scale, reflectance and micro-detail; do not substitute a different design material.' : 'Use physically plausible finishes while keeping all modeled geometry unchanged.',
      `Lighting/environment: ${environment}. Staging rule: ${staging}. People: ${people}.`,
      'Make the result photographic, buildable and spatially faithful. Prefer restrained realistic detail over creative reinterpretation. If anything is ambiguous, preserve the source image rather than inventing geometry.',
      selectedContext(),
      `User instruction: ${String(userPrompt || '').trim() || 'Create a clean realistic architectural rendering of the current viewport.'}`
    ].join('\n');
  }

  function captureReference() {
    const viewer = activeViewer();
    const direct = viewer?.captureRenderReference?.();
    if (direct?.imageDataUrl) return direct;
    try {
      viewer?.renderer?.render?.(viewer.scene, viewer.camera);
      const imageDataUrl = viewer?.renderer?.domElement?.toDataURL?.('image/png') || '';
      if (imageDataUrl) return { imageDataUrl, camera: viewer?.cameraState?.() || null, sourceRevision: state?.cloudState?.revision || null };
    } catch (_) {}
    const fallback = $('#render-source img')?.src || '';
    return fallback ? { imageDataUrl: fallback, camera: viewer?.cameraState?.() || null, sourceRevision: state?.cloudState?.revision || null } : null;
  }

  function usageText(json, resolution) {
    const usage = json?.usage || json?.usageMetadata || {};
    const total = Number(usage.totalTokenCount || 0);
    const prompt = Number(usage.promptTokenCount || 0);
    const output = Number(usage.candidatesTokenCount || 0);
    const bits = [`Nano Banana 2 · ${resolution}`];
    if (total) bits.push(`${total.toLocaleString()} total tokens`);
    else if (prompt || output) bits.push(`${prompt.toLocaleString()} input · ${output.toLocaleString()} output tokens`);
    return bits.join(' · ');
  }

  function disposeResultObjectUrl() {
    if (!resultObjectUrl) return;
    try { URL.revokeObjectURL(resultObjectUrl); } catch (_) {}
    resultObjectUrl = '';
  }

  function showResult(blob, sourceUrl, json, modelText = '') {
    const stage = $('#render-ai-stage');
    if (!stage) return;
    resultBlob = blob;
    disposeResultObjectUrl();
    resultObjectUrl = URL.createObjectURL(blob);
    stage.classList.add('has-result');
    stage.innerHTML = `<div class="render-ai-compare">
      ${sourceUrl ? `<img class="render-ai-source" src="${esc(sourceUrl)}" alt="REVEX viewport source" />` : ''}
      <img class="render-ai-result" src="${esc(resultObjectUrl)}" alt="Generated architectural render" />
    </div>
    <div class="render-ai-stage-tools"><button id="render-show-source" type="button">Hold source</button><button id="render-save-book" type="button">Save to Design Book</button></div>`;
    const result = $('.render-ai-result', stage);
    const source = $('.render-ai-source', stage);
    const hold = $('#render-show-source', stage);
    const setCompare = (on) => { if (result) result.style.opacity = on ? '0' : '1'; if (source) source.style.opacity = '1'; };
    hold?.addEventListener('pointerdown', () => setCompare(true));
    hold?.addEventListener('pointerup', () => setCompare(false));
    hold?.addEventListener('pointerleave', () => setCompare(false));
    $('#render-save-book', stage)?.addEventListener('click', saveResultToDesignBook);
    if (modelText) addMessage('assistant', modelText.slice(0, 1200));
    const resolution = $('#google-ai-resolution')?.value || '1K';
    const usage = usageText(json, resolution);
    $('#render-workspace-meta').textContent = usage;
    setStatus(`Render complete · ${usage}`, 'good');
  }

  async function callGemini(reference, prompt, resolution, jobId) {
    const projectId = String(state?.projectId || '');
    const sourceRevision = String(reference?.sourceRevision || state?.cloudState?.revision || '');
    const result = await callRenderBroker({
      schema: REQUEST_SCHEMA,
      projectId,
      jobId,
      sourceRevision,
      imageDataUrl: reference.imageDataUrl,
      prompt,
      resolution,
      clientBuild: BUILD
    });
    const resultPath = String(result?.resultPath || '');
    const exactPrefix = `projects/${projectId}/revex/renders/${jobId}/`;
    if (!result?.ok || result?.status !== 'COMPLETE' || !resultPath.startsWith(exactPrefix))
      throw new Error('The Render broker returned an incomplete or cross-project result.');
    const blob = await Store.fileBlob(resultPath);
    if (!blob || !['image/png', 'image/jpeg', 'image/webp'].includes(String(blob.type || result?.resultMimeType || '').toLowerCase()) || blob.size > 32 * 1024 * 1024)
      throw new Error('The authenticated Render result is missing, unsupported or exceeds 32 MiB.');
    return { json: result, blob, text: String(result.text || ''), resultPath };
  }

  function addMessage(role, text) {
    const host = $('#render-agent-messages');
    if (!host || !String(text || '').trim()) return;
    const row = document.createElement('div');
    row.className = `render-agent-message ${role}`;
    row.innerHTML = `<div class="render-agent-message-body">${esc(text).replace(/\n/g, '<br>')}</div>`;
    host.appendChild(row);
    host.scrollTop = host.scrollHeight;
  }

  async function generateRender(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    if (!state?.projectId) return toast('Choose a REVEX project first.', true);
    const reference = captureReference();
    if (!reference?.imageDataUrl) return toast('The current BIM viewport is not ready to render.', true);
    const promptField = $('#render-prompt');
    const userPrompt = String(promptField?.value || '').trim();
    const refined = refinedPrompt(userPrompt, reference);
    const resolution = $('#google-ai-resolution')?.value || '1K';
    const button = $('#render-google-generate');
    if (button) { button.disabled = true; button.textContent = 'Rendering…'; }
    setStatus('Sending the current viewport + geometry/camera lock to Nano Banana 2…', 'busy');
    const sourceStage = $('#render-ai-stage');
    if (sourceStage) {
      disposeResultObjectUrl();
      resultBlob = null;
      activeResultPath = '';
      activeJob = null;
      sourceStage.classList.add('has-result');
      sourceStage.innerHTML = `<div class="render-ai-loading"><img src="${esc(reference.imageDataUrl)}" alt="Current BIM viewport" /><div><strong>Nano Banana 2</strong><span>Preserving geometry and camera…</span></div></div>`;
    }
    try {
      await requireCloudIdentity();
      const sourceRevision = String(reference.sourceRevision || state.cloudState?.revision || '');
      activeJob = await Store?.createRenderJob?.(state.projectId, {
        schema: JOB_SCHEMA,
        contextKind: state.selectedDesign ? 'design' : state.selectedElement ? 'bim' : 'view',
        contextLabel: selectedContext(),
        elementId: state.selectedElement?.id || null,
        designItemId: state.selectedDesign?.id || null,
        chapterId: $('#render-chapter')?.value || null,
        revision: sourceRevision || null,
        provider: 'google-gemini-server', model: MODEL,
        renderLocation: selectedLocation || (String($('#render-location')?.value || '').trim() ? { label: String($('#render-location').value).trim() } : null),
        sourceCamera: reference.camera || null, sourceRevision,
        settings: { resolution, aspectRatio: '16:9', preserveGeometry: true }, status: 'PREPARED'
      }) || null;
      if (!activeJob?.id) throw new Error('REVEX could not create the controlled Render job.');
      const generated = await callGemini(reference, refined, resolution, activeJob.id);
      activeResultPath = generated.resultPath;
      showResult(generated.blob, reference.imageDataUrl, generated.json, generated.text);
      diagnostic('INFO', 'GOOGLE_RENDER_COMPLETE', 'Server-brokered Nano Banana 2 render completed.', { model: MODEL, resolution, projectId: state.projectId, jobId: activeJob.id });
    } catch (error) {
      if (sourceStage) sourceStage.classList.remove('has-result');
      setStatus(error?.message || 'Google AI render failed.', 'bad');
      addMessage('tool error', error?.message || 'Google AI render failed.');
      diagnostic('ERROR', 'GOOGLE_RENDER_FAILED', error?.message || String(error), { projectId: state.projectId, jobId: activeJob?.id || null, stage: error?.stage || null });
    } finally {
      if (button) { button.disabled = false; button.textContent = 'Render current viewport'; }
    }
  }

  async function saveResultToDesignBook() {
    if (!resultBlob || !state?.projectId) return;
    const chapterId = $('#render-chapter')?.value || state.activeChapter || '';
    const chapter = (state.designData?.chapters || []).find((row) => String(row.id) === String(chapterId));
    if (!chapter) return toast('Choose a Design Book chapter first.', true);
    try {
      setStatus('Saving generated render into the Design Book…', 'busy');
      const formed = { ...chapter, ...(state.chapterEdits?.get?.(chapter.id) || {}) };
      const extension = resultBlob.type === 'image/jpeg' ? 'jpg' : resultBlob.type === 'image/webp' ? 'webp' : 'png';
      const file = new File([resultBlob], `REVEX_${Date.now()}_NanoBanana2.${extension}`, { type: resultBlob.type || 'image/png' });
      const images = await Store.uploadChapterImage(state.projectId, chapter.id, 'renders', file, formed.renders || []);
      state.chapterEdits?.set?.(chapter.id, { ...(state.chapterEdits?.get?.(chapter.id) || {}), renders: images });
      if (activeJob?.id) activeJob = { ...activeJob, resultPath: activeResultPath, chapterId: chapter.id, savedToDesignBookAt: new Date().toISOString() };
      setStatus(`Saved to Design Book · ${chapter.title}`, 'good');
      toast(`Render saved to ${chapter.title}.`);
    } catch (error) {
      setStatus(error?.message || 'Could not save the render.', 'bad');
      toast(error?.message || 'Could not save the render.', true);
    }
  }

  function showSource(reference = captureReference()) {
    const stage = $('#render-ai-stage');
    if (!stage) return;
    disposeResultObjectUrl();
    resultBlob = null;
    activeResultPath = '';
    stage.classList.remove('has-result');
    if (!reference?.imageDataUrl) {
      stage.innerHTML = '<div class="render-ai-live-note bad">Open a synced BIM view to render.</div>';
      return;
    }
    stage.innerHTML = '<div class="render-ai-live-note">Live BIM viewport · move / zoom / Walk normally · the camera is captured only when you press Render</div>';
    $('#render-workspace-meta').textContent = `${reference.viewName || 'Current 3D view'} · ${reference.sourceRevision || state.cloudState?.revision || 'current revision'}`;
  }

  function locationLabel(row) {
    const a = row?.address || {};
    const city = a.city || a.town || a.village || a.municipality || a.county || '';
    const stateName = a.state || a.region || '';
    const country = a.country || '';
    const compact = [city, stateName, country].filter(Boolean).join(', ');
    return compact || String(row?.display_name || '').split(',').slice(0, 3).join(', ').trim();
  }

  function hideLocationSuggestions() {
    const box = $('#render-location-suggestions');
    if (box) { box.hidden = true; box.innerHTML = ''; }
  }

  async function searchLocations(query) {
    const box = $('#render-location-suggestions');
    if (!box) return;
    locationAbort?.abort?.();
    locationAbort = new AbortController();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '8');
    url.searchParams.set('layer', 'address');
    url.searchParams.set('accept-language', navigator.language || 'en');
    try {
      const response = await fetch(url, { signal: locationAbort.signal, headers: { 'Accept': 'application/json' } });
      if (!response.ok) throw new Error(`location lookup ${response.status}`);
      const raw = await response.json();
      const rows = (Array.isArray(raw) ? raw : []).filter((row) => {
        const kind = String(row?.addresstype || row?.type || '').toLowerCase();
        const a = row?.address || {};
        return ['city','town','village','municipality','administrative','borough','county'].includes(kind) || a.city || a.town || a.village || a.municipality;
      }).slice(0, 6);
      if (!rows.length) return hideLocationSuggestions();
      box.innerHTML = rows.map((row, index) => `<button type="button" data-location-index="${index}"><strong>${esc(locationLabel(row))}</strong><small>${esc(row.display_name || '')}</small></button>`).join('') + '<div class="render-location-attribution">Location data © OpenStreetMap contributors</div>';
      box.hidden = false;
      box.querySelectorAll('[data-location-index]').forEach((button) => button.addEventListener('click', () => {
        const row = rows[Number(button.dataset.locationIndex)];
        selectedLocation = { label: locationLabel(row), lat: String(row?.lat || ''), lon: String(row?.lon || ''), countryCode: String(row?.address?.country_code || '').toUpperCase() };
        const input = $('#render-location');
        if (input) input.value = selectedLocation.label;
        localStorage.setItem(LOCATION_KEY, JSON.stringify(selectedLocation));
        hideLocationSuggestions();
        diagnostic('INFO', 'RENDER_LOCATION', 'Render location selected from public OpenStreetMap data.', selectedLocation);
      }));
    } catch (error) {
      if (error?.name !== 'AbortError') diagnostic('WARN', 'RENDER_LOCATION', error?.message || String(error));
      hideLocationSuggestions();
    }
  }

  function setupLocationSearch() {
    const input = $('#render-location');
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    try {
      const stored = JSON.parse(localStorage.getItem(LOCATION_KEY) || 'null');
      if (stored?.label) { selectedLocation = stored; input.value = stored.label; }
    } catch (_) {}
    input.addEventListener('input', () => {
      selectedLocation = null;
      clearTimeout(locationTimer);
      const query = input.value.trim();
      if (query.length < 2) return hideLocationSuggestions();
      // Public Nominatim policy is intentionally respected with a low-frequency debounce.
      locationTimer = setTimeout(() => void searchLocations(query), 700);
    });
    input.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideLocationSuggestions(); });
    document.addEventListener('pointerdown', (event) => {
      if (!event.target?.closest?.('.render-location-wrap')) hideLocationSuggestions();
    });
  }

  function syncDockOffset() {
    const dialog = $('#render-dialog');
    if (!dialog) return;
    const bars = [$('.topbar'), $('.main-nav')].filter(Boolean);
    const bottom = bars.reduce((max, node) => Math.max(max, node.getBoundingClientRect().bottom || 0), 0);
    dialog.style.setProperty('--revex-render-top', `${Math.max(0, Math.round(bottom))}px`);
  }

  function bindSheetResize() {
    const handle = $('#render-sheet-handle');
    const panel = $('#render-agent-panel');
    const dialog = $('#render-dialog');
    if (!handle || !panel || !dialog || handle.dataset.bound === '1') return;
    handle.dataset.bound = '1';
    const limits = () => ({
      min: 220,
      max: Math.max(260, innerHeight - Number.parseFloat(getComputedStyle(dialog).getPropertyValue('--revex-render-top') || '0') - 72),
    });
    const setHeight = value => {
      const { min, max } = limits();
      const next = Math.max(min, Math.min(max, Number(value) || min));
      dialog.style.setProperty('--revex-render-sheet-h', `${Math.round(next)}px`);
      handle.setAttribute('aria-valuemin', String(min));
      handle.setAttribute('aria-valuemax', String(Math.round(max)));
      handle.setAttribute('aria-valuenow', String(Math.round(next)));
    };
    const syncValue = () => setHeight(panel.getBoundingClientRect().height);
    handle.setAttribute('role', 'slider');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-orientation', 'vertical');
    syncValue();
    handle.addEventListener('keydown', event => {
      if (!matchMedia('(max-width:860px)').matches || !['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const { min, max } = limits();
      const current = panel.getBoundingClientRect().height;
      setHeight(event.key === 'Home' ? min : event.key === 'End' ? max : current + (event.key === 'ArrowUp' ? 24 : -24));
    });
    handle.addEventListener('pointerdown', (event) => {
      if (!matchMedia('(max-width:860px)').matches) return;
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const startY = event.clientY;
      const startHeight = panel.getBoundingClientRect().height;
      const move = (e) => {
        setHeight(startHeight + (startY - e.clientY));
      };
      const up = (e) => {
        handle.releasePointerCapture?.(e.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  function buildUi() {
    const dialog = $('#render-dialog');
    const layout = $('.render-layout');
    const controls = $('.render-controls');
    const workspace = $('.render-workspace');
    if (!dialog || !layout || !controls || !workspace) return false;

    dialog.classList.add('agentized', 'google-render', 'render-docked');
    dialog.setAttribute('aria-modal', 'false');
    layout.classList.add('agentized');
    controls.classList.add('render-controls-hidden');
    controls.setAttribute('aria-hidden', 'true');

    const head = $('.render-head', dialog);
    if (head) {
      const eyebrow = $('.eyebrow', head); if (eyebrow) eyebrow.textContent = 'REVEX RENDER';
      const title = $('#render-dialog-title', head); if (title) title.textContent = 'Render properties';
    }

    const workspaceHead = $('.render-workspace-head', workspace);
    if (workspaceHead) workspaceHead.innerHTML = `<strong>Current BIM viewport</strong><span id="render-workspace-meta">live camera authority</span>`;
    const frame = $('#render-frame', workspace); if (frame) { frame.removeAttribute('src'); frame.hidden = true; }
    const empty = $('#render-frame-empty', workspace); if (empty) empty.hidden = true;
    let stage = $('#render-ai-stage', workspace);
    if (!stage) {
      stage = document.createElement('div'); stage.id = 'render-ai-stage'; stage.className = 'render-ai-stage'; workspace.appendChild(stage);
    }

    let panel = $('#render-agent-panel');
    if (!panel) {
      panel = document.createElement('aside');
      panel.id = 'render-agent-panel'; panel.className = 'render-agent-panel';
      panel.innerHTML = `<div id="render-sheet-handle" class="render-sheet-handle" aria-label="Resize Render properties"><span></span></div>
        <header class="render-agent-head"><div><strong>REVEX AI Render</strong><span>viewport-to-image</span></div><span id="render-agent-capability" class="render-agent-chip" data-tone="good">Google AI · project secured</span></header>
        <div id="render-agent-messages" class="render-agent-messages"><div class="render-agent-message assistant"><div class="render-agent-message-body">Keep moving, zooming or walking in BIM while these properties are open. Render captures the viewport only when you press Render.</div></div></div>
        <div class="render-google-config">
          <label>Output<select id="google-ai-resolution"><option value="1K">1K · fastest</option><option value="2K">2K · review</option><option value="4K">4K · final</option></select></label>
        </div>
        <div id="render-agent-fields" class="render-agent-fields"><label class="render-location-field">Location / surroundings<div class="render-location-wrap"><input id="render-location" type="search" autocomplete="off" spellcheck="false" placeholder="Start typing a city…" /><div id="render-location-suggestions" class="render-location-suggestions" hidden></div></div><small>Used only for sky, climate, vegetation and surrounding context.</small></label></div>
        <div id="render-agent-status-slot" class="render-agent-status-slot"></div>
        <button id="render-google-generate" class="button render-google-generate" type="button">Render current viewport</button>`;
      layout.appendChild(panel);
    }

    if ($('#render-google-generate').dataset.bound !== '1') {
      $('#render-google-generate').dataset.bound = '1';
      $('#render-google-generate').addEventListener('click', generateRender);
    }

    const fieldHost = $('#render-agent-fields');
    const promptLabel = $('#render-prompt')?.closest('label');
    const options = $('.render-options', controls);
    const materials = $('.render-check', controls);
    const chapter = $('#render-chapter')?.closest('label');
    [promptLabel, options, materials, chapter].filter(Boolean).forEach((node) => fieldHost.appendChild(node));
    const prompt = $('#render-prompt');
    if (prompt) { prompt.rows = 5; prompt.maxLength = 8000; prompt.placeholder = 'Describe light, atmosphere and finish intent. REVEX adds geometry/camera and location context.'; }
    const status = $('#render-status'); if (status) $('#render-agent-status-slot')?.appendChild(status);
    $('#render-prepare', controls)?.setAttribute('hidden', '');
    $('.result-upload', controls)?.setAttribute('hidden', '');

    if ($('#render-form') && $('#render-form').dataset.googleOwner !== '1') {
      $('#render-form').dataset.googleOwner = '1';
      $('#render-form').addEventListener('submit', (event) => { event.preventDefault(); event.stopImmediatePropagation(); generateRender(event); }, true);
    }
    setupLocationSearch();
    bindSheetResize();
    syncDockOffset();
    showSource();
    return true;
  }

  function onDialogOpen() {
    if (!buildUi()) return;
    // Render is a property surface around the real BIM viewport, not a second viewer.
    const bimTab = document.querySelector('.main-nav [data-view="bim"]');
    if (bimTab && !bimTab.classList.contains('active')) bimTab.click();
    syncDockOffset();
    showSource();
    const sourcePrompt = $('#render-prompt');
    if (sourcePrompt && !sourcePrompt.value.trim()) sourcePrompt.value = 'Create a realistic architectural rendering of the current viewport while preserving the design exactly.';
    setStatus('Ready · secured by your LIBER project access.');
  }

  async function init() {
    if (initialized) return;
    if (!buildUi()) return setTimeout(init, 120);
    initialized = true;
    const dialog = $('#render-dialog');
    if (dialog) new MutationObserver(() => { if (!dialog.hidden) onDialogOpen(); }).observe(dialog, { attributes: true, attributeFilter: ['hidden'] });
    root.addEventListener('resize', syncDockOffset, { passive: true });
    root.addEventListener('pagehide', disposeResultObjectUrl, { once: true });
    if (!dialog?.hidden) onDialogOpen();
    console.info('[REVEX] Google renderer ' + BUILD, { model: MODEL, broker: 'authenticated Firebase callable / server identity', userGoogleOAuth: false, apiKeyInBrowser: false, input: 'live current viewport + camera context', location: 'OpenStreetMap Nominatim suggestions' });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else void init();
})(window);
