(function (root) {
  'use strict';

  const BUILD = '20260914r197-render-return1';
  const MODEL = 'gemini-3.1-flash-image';
  const RENDER_PROVIDER = 'google-gemini';
  const GOOGLE_PROJECT_DEFAULT = 'liber-apps-cca20';
  const Store = root.RevexStore;
  const state = root.__revexState;
  const $ = (selector, base = document) => base.querySelector(selector);
  let initialized = false;
  let accessToken = '';
  let tokenExpiresAt = 0;
  let credentialUid = '';
  let accountUid = '';
  let watchedAuth = null;
  let stopWatchingAuth = null;
  let accountUser = null;
  let accountRevision = null;
  let accountService = null;
  let accountAuth = null;
  let accountBoundaryGeneration = 0;
  let redirectReadPromise = null;
  let resultBlob = null;
  let resultObjectUrl = '';
  let activeJob = null;
  let activeOwner = null;
  let authorizationIntent = null;
  let resultOwner = null;
  let savingOwner = null;
  let renderGeneration = 0;
  let generationAbort = null;
  let locationAbort = null;
  let locationTimer = 0;
  let selectedLocation = null;
  let redirectNavigationStarted = false;
  let restoredReturnId = '';

  const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/generative-language.retriever'
  ];
  const GOOGLE_REDIRECT_PENDING = 'liber.revex.google-ai.redirect.pending.v2';
  const GOOGLE_PROJECT_KEY = 'liber.revex.google-ai.project-id.v2';
  const LOCATION_KEY = 'liber.revex.render.location.v1';
  const RENDER_RETURN_KEY = 'liber.revex.render.return.v1';
  const RENDER_RETURN_TTL = 20 * 60_000;
  const RETURN_FIELDS = ['render-prompt', 'render-environment', 'render-staging', 'render-people', 'render-chapter', 'render-location', 'google-ai-resolution'];

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char]));
  const diagnostic = (level, stage, message, detail = {}) => {
    try { root.__revexBrowserDiagnostics?.emit?.(level, stage, message, { initiator: 'google render current', build: BUILD, ...detail }); } catch (_) {}
  };
  const activeViewer = () => root.__revexViewerR26Instance || null;
  const constrainedAuthHost = () => Boolean(root.chrome?.webview) || (() => { try { return root.self !== root.top; } catch (_) { return true; } })();

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

  const currentUid = () => String(root.firebaseService?.auth?.currentUser?.uid || '');
  const accountStorageKey = (key, uid = currentUid()) => uid ? `${key}.${uid}` : '';

  function clearGoogleCredential() {
    accessToken = '';
    tokenExpiresAt = 0;
    credentialUid = '';
  }

  function clearRenderResult() {
    resultBlob = null;
    resultOwner = null;
    activeJob = null;
    if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
    resultObjectUrl = '';
    const stage = $('#render-ai-stage');
    if (stage) { stage.innerHTML = ''; stage.classList.remove('has-result'); }
  }

  function retireRenderWork() {
    renderGeneration += 1;
    generationAbort?.abort?.();
    generationAbort = null;
    activeOwner = null;
    savingOwner = null;
    clearRenderResult();
    $('#render-agent-messages')?.querySelectorAll?.('[data-render-output="1"]').forEach((row) => row.remove());
    const button = $('#render-google-generate');
    if (button) { button.disabled = Boolean(authorizationIntent); button.textContent = authorizationIntent ? 'Checking Google AI…' : 'Render current viewport'; }
  }

  function captureRenderIntent() {
    const service = root.firebaseService;
    const auth = service?.auth;
    const uid = currentUid();
    if (!uid || !state?.projectId) throw new Error('Sign in and choose a REVEX project first.');
    return Object.freeze({ service, auth, uid, accountBoundaryGeneration,
      projectId: String(state.projectId), activationToken: state.activationToken,
      revision: String(state.cloudState?.revision || '') });
  }

  function renderIntentCurrent(intent) {
    // Link/reauth can refresh the same user's SDK object. Only this pre-job
    // authorization intent tolerates that; UID transitions and project revisions
    // still invalidate it. The immutable job owner is captured after authorization.
    return Boolean(intent && authorizationIntent === intent && root.firebaseService === intent.service &&
      intent.service.auth === intent.auth && currentUid() === intent.uid &&
      accountBoundaryGeneration === intent.accountBoundaryGeneration && String(state?.projectId || '') === intent.projectId &&
      state.activationToken === intent.activationToken && String(state.cloudState?.revision || '') === intent.revision);
  }

  function captureRenderOwner() {
    const service = root.firebaseService;
    const auth = service?.auth;
    const user = auth?.currentUser;
    if (!user?.uid || !state?.projectId) throw new Error('Sign in and choose a REVEX project first.');
    return Object.freeze({ service, auth, user, uid: user.uid, projectId: String(state.projectId),
      accountBoundaryGeneration, activationToken: state.activationToken,
      revision: String(state.cloudState?.revision || ''), generation: renderGeneration });
  }

  function renderOwnerCurrent(owner) {
    return Boolean(owner && owner.generation === renderGeneration && root.firebaseService === owner.service &&
      owner.service.auth === owner.auth && currentUid() === owner.uid &&
      accountBoundaryGeneration === owner.accountBoundaryGeneration && String(state?.projectId || '') === owner.projectId &&
      state.activationToken === owner.activationToken && String(state.cloudState?.revision || '') === owner.revision);
  }

  function assertRenderOwner(owner) {
    if (renderOwnerCurrent(owner)) return;
    const error = new Error('The account, project or source revision changed. Render again in the current project.');
    error.code = 'revex/stale-render-owner';
    throw error;
  }

  function retireStaleRenderWork() {
    if ((activeOwner && !renderOwnerCurrent(activeOwner)) || (resultOwner && !renderOwnerCurrent(resultOwner))) retireRenderWork();
  }

  function synchronizeGoogleAccount() {
    const uid = currentUid();
    const user = root.firebaseService?.auth?.currentUser || null;
    const revision = root.firebaseService?._authStateRevision;
    const service = root.firebaseService, auth = service?.auth;
    // Reauthentication and SDK hydration can replace a User object or advance
    // a notification counter without changing the authenticated account.
    const boundary = uid !== accountUid || service !== accountService || auth !== accountAuth;
    if (boundary) {
      accountBoundaryGeneration += 1;
      clearGoogleCredential();
      retireRenderWork();
      if (accountUid && uid !== accountUid) {
        localStorage.removeItem(accountStorageKey(GOOGLE_REDIRECT_PENDING, accountUid));
        sessionStorage.removeItem(RENDER_RETURN_KEY);
      }
      const field = $('#google-ai-project');
      if (field) field.value = uid ? localStorage.getItem(accountStorageKey(GOOGLE_PROJECT_KEY, uid)) || '' : '';
    }
    accountUid = uid; accountUser = user; accountRevision = revision;
    accountService = service; accountAuth = auth;
    return uid;
  }

  function readRenderReturn() {
    try {
      const raw = sessionStorage.getItem(RENDER_RETURN_KEY);
      if (!raw) return null;
      const draft = raw.length <= 24000 ? JSON.parse(raw) : null;
      if (!draft || draft.version !== 1 || typeof draft.uid !== 'string' || !draft.uid ||
          typeof draft.projectId !== 'string' || !draft.projectId || typeof draft.revision !== 'string' ||
          !Number.isFinite(draft.at) || Date.now() - draft.at > RENDER_RETURN_TTL || draft.at > Date.now() + 5000) {
        sessionStorage.removeItem(RENDER_RETURN_KEY); return null;
      }
      return draft;
    } catch (_) { sessionStorage.removeItem(RENDER_RETURN_KEY); return null; }
  }

  function saveRenderReturn(uid) {
    if (!state?.projectId || currentUid() !== uid) throw new Error('Choose the current project before connecting Google.');
    const draft = { version: 1, id: root.crypto.randomUUID(), uid, at: Date.now(),
      projectId: String(state.projectId), revision: String(state.cloudState?.revision || ''),
      fields: Object.fromEntries(RETURN_FIELDS.map(id => [id, String($('#' + id)?.value || '').slice(0, 6000)])),
      materials: Boolean($('#render-materials')?.checked), camera: activeViewer()?.cameraState?.() || null };
    // Only a short-lived, same-tab form/camera draft. Never persist OAuth tokens
    // or viewport image data, and never automatically submit a paid render.
    const json = JSON.stringify(draft);
    if (json.length > 24000) throw new Error('The render draft is too large to preserve during sign-in. Shorten the prompt and try again.');
    try { sessionStorage.setItem(RENDER_RETURN_KEY, json); }
    catch (_) { throw new Error('This window cannot preserve the render draft during sign-in. Allow session storage and try again.'); }
  }

  function restoreRenderReturn() {
    if (redirectNavigationStarted) return false;
    const draft = readRenderReturn(), uid = currentUid();
    if (!draft || !uid) return false;
    if (uid !== draft.uid) { sessionStorage.removeItem(RENDER_RETURN_KEY); return false; }
    if (!state?.projectId || !state.cloudState?.revision || !activeViewer()?.detailLoaded) return false;
    if (String(state.projectId) !== draft.projectId || String(state.cloudState.revision) !== draft.revision) {
      sessionStorage.removeItem(RENDER_RETURN_KEY); return false;
    }
    if (restoredReturnId === draft.id || !buildUi()) return false;
    restoredReturnId = draft.id;
    $('#render-dialog').hidden = false;
    for (const id of RETURN_FIELDS) {
      const field = $('#' + id), value = draft.fields?.[id];
      if (!field || typeof value !== 'string') continue;
      if (field.tagName === 'SELECT' && !Array.from(field.options).some(option => option.value === value)) continue;
      field.value = value.slice(0, 6000);
    }
    if ($('#render-materials')) $('#render-materials').checked = draft.materials === true;
    selectedLocation = null;
    if (draft.camera) activeViewer()?.restoreCameraState?.(draft.camera);
    showSource();
    sessionStorage.removeItem(RENDER_RETURN_KEY);
    setStatus(tokenReady() ? 'Google connected. Your render settings are restored—press Render current viewport to continue.' : 'Your render settings are restored. Press Render current viewport to reconnect Google.', tokenReady() ? 'good' : '');
    return true;
  }

  function redirectPending() {
    const key = accountStorageKey(GOOGLE_REDIRECT_PENDING);
    return Boolean(key && localStorage.getItem(key) === '1');
  }

  function connectedProjectId() {
    const uid = synchronizeGoogleAccount();
    if (!uid) return '';
    return GOOGLE_PROJECT_DEFAULT;
  }

  function rememberProjectId() {
    const uid = currentUid();
    if (!uid) throw new Error('Sign in to LIBER Apps first, then connect Gemini.');
    localStorage.setItem(accountStorageKey(GOOGLE_PROJECT_KEY, uid), GOOGLE_PROJECT_DEFAULT);
    return GOOGLE_PROJECT_DEFAULT;
  }

  function assertGeminiOnly() {
    if (RENDER_PROVIDER !== 'google-gemini' || MODEL !== 'gemini-3.1-flash-image') {
      const error = new Error('REVEX render provider integrity failure. Gemini-only rendering is required.');
      error.code = 'revex/render-provider-integrity';
      throw error;
    }
  }

  function tokenReady() {
    const uid = synchronizeGoogleAccount();
    return Boolean(uid && credentialUid === uid && accessToken && Date.now() < tokenExpiresAt - 60_000);
  }

  function adoptGoogleCredential(result, expectedUid) {
    if (!expectedUid || synchronizeGoogleAccount() !== expectedUid || result?.user?.uid !== expectedUid) {
      throw new Error('The LIBER account changed during Google authorization. Connect Google again for the current account.');
    }
    const f = root.firebaseModular || root.firebase;
    const credential = f?.GoogleAuthProvider?.credentialFromResult?.(result);
    if (!credential?.accessToken) return false;
    accessToken = credential.accessToken;
    credentialUid = expectedUid;
    const expiresIn = Number(result?._tokenResponse?.oauthExpireIn || result?._tokenResponse?.expiresIn || 3300);
    tokenExpiresAt = Date.now() + Math.max(600, expiresIn) * 1000;
    localStorage.removeItem(accountStorageKey(GOOGLE_REDIRECT_PENDING, expectedUid));
    rememberProjectId();
    updateConnectionUi();
    diagnostic('INFO', 'GOOGLE_AI_CONNECTED', 'Google AI OAuth access granted for this REVEX session.', { projectId: connectedProjectId(), operationType: result?.operationType || null });
    return true;
  }

  async function restoreRedirectCredential() {
    // Calling Firebase getRedirectResult when no redirect is pending can trigger
    // resolver/persistence assertions in embedded or mixed Firebase runtimes.
    // Only consume a result that this renderer explicitly initiated.
    const uid = synchronizeGoogleAccount();
    if (!uid || !redirectPending()) return false;
    if (redirectReadPromise) return redirectReadPromise;
    const auth = root.firebaseService?.auth;
    const f = root.firebaseModular || root.firebase;
    if (!auth || typeof f?.getRedirectResult !== 'function') return false;
    redirectReadPromise = (async () => { try {
      const result = await f.getRedirectResult(auth);
      if (!result) {
        localStorage.removeItem(accountStorageKey(GOOGLE_REDIRECT_PENDING, uid));
        setStatus('Google did not return a rendering permission. Your settings are preserved; press Render current viewport to reconnect.', 'bad');
        return false;
      }
      const adopted = adoptGoogleCredential(result, uid);
      if (adopted) setStatus(`Google AI connected · ${connectedProjectId()}`, 'good');
      return adopted;
    } catch (error) {
      localStorage.removeItem(accountStorageKey(GOOGLE_REDIRECT_PENDING, uid));
      diagnostic('WARN', 'GOOGLE_AI_REDIRECT', error?.message || String(error));
      return false;
    } })();
    try { return await redirectReadPromise; }
    finally { redirectReadPromise = null; updateConnectionUi(); restoreRenderReturn(); }
  }

  async function startGoogleRedirect(current, provider, alreadyGoogle) {
    const f = root.firebaseModular || root.firebase;
    const pendingKey = accountStorageKey(GOOGLE_REDIRECT_PENDING, current.uid);
    saveRenderReturn(current.uid);
    localStorage.setItem(pendingKey, '1');
    setStatus('Opening Google permission in this window; REVEX returns here automatically…', 'busy');
    redirectNavigationStarted = true;
    try { if (alreadyGoogle && typeof f?.reauthenticateWithRedirect === 'function') {
      await f.reauthenticateWithRedirect(current, provider);
      return;
    }
    if (!alreadyGoogle && typeof f?.linkWithRedirect === 'function') {
      await f.linkWithRedirect(current, provider);
      return;
    }
    throw new Error('Google redirect authorization is unavailable in this Firebase runtime.');
    } catch (error) {
      redirectNavigationStarted = false;
      localStorage.removeItem(pendingKey);
      sessionStorage.removeItem(RENDER_RETURN_KEY);
      throw error;
    }
  }

  async function connectGoogle(forceConsent = false) {
    bindGoogleAccountGuard();
    rememberProjectId();
    if (redirectPending()) await restoreRedirectCredential();
    if (tokenReady() && !forceConsent) return accessToken;
    const auth = root.firebaseService?.auth;
    const f = root.firebaseModular || root.firebase;
    if (!auth || !f?.GoogleAuthProvider) throw new Error('Google authorization is not ready in this REVEX session.');

    const provider = new f.GoogleAuthProvider();
    GOOGLE_SCOPES.forEach((scope) => provider.addScope(scope));
    provider.setCustomParameters?.({ prompt: forceConsent ? 'consent select_account' : 'select_account' });

    const current = auth.currentUser;
    if (!current) throw new Error('Sign in to LIBER Apps first, then connect Google AI.');
    const alreadyGoogle = (current.providerData || []).some((row) => row.providerId === 'google.com');

    // WebView2 and embedded shells are hostile to popup ownership. Use the Firebase
    // redirect flow there; normal standalone browsers keep the faster popup path.
    if (constrainedAuthHost()) {
      await startGoogleRedirect(current, provider, alreadyGoogle);
      return '';
    }

    try {
      const result = alreadyGoogle
        ? await f.reauthenticateWithPopup(current, provider)
        : await f.linkWithPopup(current, provider);
      if (!adoptGoogleCredential(result, current.uid)) throw new Error('Google approved the account but did not return a usable Gemini OAuth access token.');
      return accessToken;
    } catch (error) {
      const text = `${error?.code || ''} ${error?.message || error}`;
      if (/popup-blocked|cancelled-popup|pending promise|internal assertion|web-storage-unsupported/i.test(text) &&
          (f?.linkWithRedirect || f?.reauthenticateWithRedirect)) {
        await startGoogleRedirect(current, provider, alreadyGoogle);
        return '';
      }
      throw error;
    }
  }

  function updateConnectionUi() {
    const chip = $('#render-agent-capability');
    const pending = redirectPending();
    const ready = tokenReady();
    if (chip) {
      chip.textContent = pending ? 'Gemini · connecting…' : ready ? 'Gemini · ready' : 'Gemini';
      chip.dataset.tone = ready ? 'good' : 'quiet';
    }
  }

  function bindGoogleAccountGuard() {
    const auth = root.firebaseService?.auth;
    const f = root.firebaseModular || root.firebase;
    if (!auth || auth === watchedAuth || typeof f?.onAuthStateChanged !== 'function') return;
    stopWatchingAuth?.();
    watchedAuth = auth;
    stopWatchingAuth = f.onAuthStateChanged(auth, () => {
      if (root.firebaseService?.auth !== auth) return;
      synchronizeGoogleAccount();
      updateConnectionUi();
      void restoreRedirectCredential();
    });
  }

  function reconcileGoogleSession() {
    bindGoogleAccountGuard();
    synchronizeGoogleAccount();
    updateConnectionUi();
    void restoreRedirectCredential();
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

  function cleanBase64(dataUrl) {
    const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) throw new Error('REVEX could not encode the current viewport for Google AI.');
    return { mimeType: match[1] || 'image/png', data: match[2] };
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

  function bytesToBlob(base64, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType || 'image/png' });
  }

  function usageText(json, resolution) {
    const usage = json?.usageMetadata || {};
    const total = Number(usage.totalTokenCount || 0);
    const prompt = Number(usage.promptTokenCount || 0);
    const output = Number(usage.candidatesTokenCount || 0);
    const bits = [`Gemini Image · ${resolution}`];
    if (total) bits.push(`${total.toLocaleString()} total tokens`);
    else if (prompt || output) bits.push(`${prompt.toLocaleString()} input · ${output.toLocaleString()} output tokens`);
    return bits.join(' · ');
  }

  function showResult(blob, sourceUrl, json, modelText = '', owner = null) {
    assertRenderOwner(owner);
    resultBlob = blob;
    resultOwner = owner;
    if (resultObjectUrl) URL.revokeObjectURL(resultObjectUrl);
    resultObjectUrl = URL.createObjectURL(blob);
    const stage = $('#render-ai-stage');
    if (!stage) return;
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

  async function callGemini(reference, prompt, resolution, owner) {
    assertGeminiOnly();
    assertRenderOwner(owner);
    if (!tokenReady()) throw new Error('Google AI permission is still being established. Return to REVEX after authorization, then render.');
    const requestUid = credentialUid;
    const { mimeType, data } = cleanBase64(reference.imageDataUrl);
    const projectId = rememberProjectId();
    generationAbort?.abort?.();
    generationAbort = new AbortController();
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent`, {
      method: 'POST',
      signal: generationAbort.signal,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'x-goog-user-project': projectId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data } }
        ] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '16:9', imageSize: resolution }
        }
      })
    });
    const json = await response.json().catch(() => ({}));
    assertRenderOwner(owner);
    if (synchronizeGoogleAccount() !== requestUid) throw new Error('The LIBER account changed during rendering. Render again from the current account.');
    if (!response.ok) {
      if (response.status === 401) { clearGoogleCredential(); updateConnectionUi(); }
      const detail = json?.error?.message || json?.message || `Google AI returned HTTP ${response.status}.`;
      throw new Error(detail + (response.status === 403 ? ` Verify that the Gemini API and billing are enabled for Google Cloud project ${projectId}, then reconnect.` : ''));
    }
    let imagePart = null;
    const texts = [];
    for (const candidate of json.candidates || []) {
      for (const part of candidate?.content?.parts || []) {
        if (part.text) texts.push(String(part.text));
        const inline = part.inlineData || part.inline_data;
        if (inline?.data && !imagePart) imagePart = inline;
      }
    }
    if (!imagePart) throw new Error('Gemini Image returned no image. Refine the prompt and try again.');
    return { json, blob: bytesToBlob(imagePart.data, imagePart.mimeType || imagePart.mime_type || 'image/png'), text: texts.join('\n') };
  }

  function addMessage(role, text) {
    const host = $('#render-agent-messages');
    if (!host || !String(text || '').trim()) return;
    const row = document.createElement('div');
    row.className = `render-agent-message ${role}`;
    row.dataset.renderOutput = '1';
    row.innerHTML = `<div class="render-agent-message-body">${esc(text).replace(/\n/g, '<br>')}</div>`;
    host.appendChild(row);
    host.scrollTop = host.scrollHeight;
  }

  async function generateRender(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    try { assertGeminiOnly(); }
    catch (error) { diagnostic('ERROR', 'RENDER_PROVIDER_INTEGRITY', error.message); return toast(error.message, true); }
    if (!state?.projectId) return toast('Choose a REVEX project first.', true);
    synchronizeGoogleAccount();
    retireStaleRenderWork();
    if (activeOwner || authorizationIntent || savingOwner) return;
    const reference = captureReference();
    if (!reference?.imageDataUrl) return toast('The current BIM viewport is not ready to render.', true);
    clearRenderResult();
    renderGeneration += 1;
    let intent;
    let owner;
    try { intent = captureRenderIntent(); }
    catch (error) { return toast(error.message, true); }
    authorizationIntent = intent;
    let job = null;
    const promptField = $('#render-prompt');
    const userPrompt = String(promptField?.value || '').trim();
    const refined = refinedPrompt(userPrompt, reference);
    const resolution = $('#google-ai-resolution')?.value || '1K';
    const button = $('#render-google-generate');
    if (button) { button.disabled = true; button.textContent = 'Rendering…'; }
    setStatus('Checking Google AI permission for the current viewport…', 'busy');
    const sourceStage = $('#render-ai-stage');
    if (sourceStage) {
      sourceStage.classList.add('has-result');
      sourceStage.innerHTML = `<div class="render-ai-loading"><img src="${esc(reference.imageDataUrl)}" alt="Current BIM viewport" /><div><strong>Gemini Image</strong><span>Preserving geometry and camera…</span></div></div>`;
    }
    const preparedJob = {
        contextKind: state.selectedDesign ? 'design' : state.selectedElement ? 'bim' : 'view',
        contextLabel: selectedContext(),
        elementId: state.selectedElement?.id || null,
        designItemId: state.selectedDesign?.id || null,
        chapterId: $('#render-chapter')?.value || null,
        revision: state.cloudState?.revision || null,
        provider: RENDER_PROVIDER, model: MODEL, prompt: userPrompt, refinedPrompt: refined,
        renderLocation: selectedLocation || (String($('#render-location')?.value || '').trim() ? { label: String($('#render-location').value).trim() } : null),
        sourceCamera: reference.camera || null, sourceRevision: reference.sourceRevision || null,
        settings: { resolution, aspectRatio: '16:9', preserveGeometry: true }, status: 'generating'
    };
    try {
      await connectGoogle(false);
      if (redirectNavigationStarted) return;
      if (!renderIntentCurrent(intent)) {
        const error = new Error('The account, project or source revision changed during Google authorization.');
        error.code = 'revex/stale-render-owner';
        throw error;
      }
      if (!tokenReady()) throw new Error('Google AI permission is still being established. Return to REVEX after authorization, then render.');
      owner = captureRenderOwner();
      activeOwner = owner;
      setStatus('Sending the current viewport + geometry/camera lock to Gemini Image…', 'busy');
      assertRenderOwner(owner);
      job = await Store?.createRenderJob?.(owner.projectId, preparedJob) || null;
      assertRenderOwner(owner);
      activeJob = job;
      const generated = await callGemini(reference, refined, resolution, owner);
      assertRenderOwner(owner);
      showResult(generated.blob, reference.imageDataUrl, generated.json, generated.text, owner);
      if (job?.id) {
        await Store.updateRenderJob?.(owner.projectId, job.id, {
          status: 'generated', provider: RENDER_PROVIDER, model: MODEL,
          usage: generated.json?.usageMetadata || null, generatedAt: new Date().toISOString()
        });
        assertRenderOwner(owner);
      }
      diagnostic('INFO', 'GOOGLE_RENDER_COMPLETE', 'Gemini Image render completed.', { model: MODEL, resolution, projectId: connectedProjectId() });
    } catch (error) {
      if (!(owner ? renderOwnerCurrent(owner) : renderIntentCurrent(intent)) || error?.code === 'revex/stale-render-owner') {
        if (activeOwner === owner || resultOwner === owner) retireRenderWork();
        return;
      }
      if (error?.name === 'AbortError') return;
      clearRenderResult();
      if (sourceStage) sourceStage.classList.remove('has-result');
      const detail = error?.message || String(error);
      const setupFailure = /authorization|permission|connect google|oauth|access token|popup|redirect/i.test(detail);
      const userMessage = setupFailure ? (detail || 'Google connection needs attention. Press Render current viewport to reconnect.') : (detail || 'Google AI render failed.');
      setStatus(userMessage, 'bad');
      addMessage('tool error', userMessage);
      if (job?.id) await Store.updateRenderJob?.(owner.projectId, job.id, { status: 'failed', error: detail }).catch(() => {});
      diagnostic('ERROR', 'GOOGLE_RENDER_FAILED', detail, { projectId: connectedProjectId(), setupFailure });
    } finally {
      const finishingIntent = authorizationIntent === intent;
      if (finishingIntent) authorizationIntent = null;
      if (activeOwner === owner) activeOwner = null;
      if (finishingIntent && !activeOwner && !authorizationIntent) {
        if (button) { button.disabled = false; button.textContent = 'Render current viewport'; }
      }
    }
  }

  async function saveResultToDesignBook() {
    synchronizeGoogleAccount();
    retireStaleRenderWork();
    if (!resultBlob || !state?.projectId) return;
    if (savingOwner || activeOwner || authorizationIntent) return;
    const chapterId = $('#render-chapter')?.value || state.activeChapter || '';
    const chapter = (state.designData?.chapters || []).find((row) => String(row.id) === String(chapterId));
    if (!chapter) return toast('Choose a Design Book chapter first.', true);
    const owner = resultOwner;
    const blob = resultBlob;
    const job = activeJob;
    const saveOwner = Object.freeze({ owner, chapterId: String(chapter.id) });
    savingOwner = saveOwner;
    const assertCurrent = () => assertRenderOwner(owner);
    try {
      assertCurrent();
      setStatus('Saving generated render into the Design Book…', 'busy');
      const formed = { ...chapter, ...(state.chapterEdits?.get?.(chapter.id) || {}) };
      const file = new File([blob], `REVEX_${Date.now()}_Gemini.png`, { type: blob.type || 'image/png' });
      const images = await Store.uploadChapterImage(owner.projectId, saveOwner.chapterId, 'renders', file, formed.renders || [], assertCurrent);
      assertCurrent();
      state.chapterEdits?.set?.(saveOwner.chapterId, { ...(state.chapterEdits?.get?.(saveOwner.chapterId) || {}), renders: images });
      if (job?.id) await Store.updateRenderJob?.(owner.projectId, job.id, { status: 'saved', resultUrl: images.at?.(-1)?.url || images[images.length - 1]?.url || null, chapterId: saveOwner.chapterId });
      assertCurrent();
      setStatus(`Saved to Design Book · ${chapter.title}`, 'good');
      toast(`Render saved to ${chapter.title}.`);
    } catch (error) {
      if (!renderOwnerCurrent(owner) || error?.code === 'revex/stale-render-owner') {
        if (resultOwner === owner) retireRenderWork();
        return;
      }
      setStatus(error?.message || 'Could not save the render.', 'bad');
      toast(error?.message || 'Could not save the render.', true);
    } finally {
      if (savingOwner === saveOwner) savingOwner = null;
    }
  }

  function showSource(reference = captureReference()) {
    const stage = $('#render-ai-stage');
    if (!stage) return;
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
    if (!handle || !panel || handle.dataset.bound === '1') return;
    handle.dataset.bound = '1';
    handle.addEventListener('pointerdown', (event) => {
      if (!matchMedia('(max-width:860px)').matches) return;
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const startY = event.clientY;
      const startHeight = panel.getBoundingClientRect().height;
      const maxHeight = Math.max(260, innerHeight - Number.parseFloat(getComputedStyle($('#render-dialog')).getPropertyValue('--revex-render-top') || '0') - 72);
      const move = (e) => {
        const next = Math.max(220, Math.min(maxHeight, startHeight + (startY - e.clientY)));
        panel.style.setProperty('--revex-render-sheet-h', `${Math.round(next)}px`);
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
        <header class="render-agent-head"><div><strong>REVEX Render</strong><span>Gemini image · current viewport</span></div><span id="render-agent-capability" class="render-agent-chip" data-tone="quiet">Gemini</span></header>
        <div id="render-agent-messages" class="render-agent-messages"><div class="render-agent-message assistant"><div class="render-agent-message-body">Move, zoom or Walk normally. Render captures the current viewport only when you press Render.</div></div></div>
        <div class="render-google-config">
          <label>Output<select id="google-ai-resolution"><option value="1K">1K · fastest</option><option value="2K">2K · review</option><option value="4K">4K · final</option></select></label>
        </div>
        <div id="render-agent-fields" class="render-agent-fields"><label class="render-location-field">Location / surroundings<div class="render-location-wrap"><input id="render-location" type="search" autocomplete="off" spellcheck="false" placeholder="Start typing a city…" /><div id="render-location-suggestions" class="render-location-suggestions" hidden></div></div><small>Used only for sky, climate, vegetation and surrounding context.</small></label></div>
        <div id="render-agent-status-slot" class="render-agent-status-slot"></div>
        <button id="render-google-generate" class="button render-google-generate" type="button">Render current viewport</button>`;
      layout.appendChild(panel);
    }

    synchronizeGoogleAccount();
    // Rendering the panel is not an authenticated operation. Account-specific
    // configuration is remembered by the existing explicit connect action.
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
    if (prompt) { prompt.rows = 5; prompt.placeholder = 'Describe light, atmosphere and finish intent. REVEX adds geometry/camera and location context.'; }
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
    updateConnectionUi();
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
    const pending = redirectPending();
    setStatus(!currentUid() ? 'Sign in to LIBER Apps to render.' : pending ? 'Preparing render session…' : 'REVEX Render ready.');
  }

  async function init() {
    if (initialized) return;
    assertGeminiOnly();
    if (!buildUi()) return setTimeout(init, 120);
    initialized = true;
    bindGoogleAccountGuard();
    root.addEventListener('firebase-ready', reconcileGoogleSession);
    root.addEventListener('revex:auth-mode-changed', reconcileGoogleSession);
    for (const name of ['revex:authoritative-project-bound', 'revex:source-revision-loaded']) root.addEventListener(name, restoreRenderReturn);
    for (const name of ['revex:project-boundary', 'revex:authoritative-project-bound', 'revex:source-revision-loaded', 'revex:auth-mode-changed']) root.addEventListener(name, retireStaleRenderWork);
    await restoreRedirectCredential();
    // Detail geometry can complete after the source-revision event. This bounded
    // return-only retry stops once the draft is consumed; it does not poll auth.
    if (readRenderReturn()) {
      let attempts = 0;
      const restoreWhenReady = () => {
        restoreRenderReturn();
        if (readRenderReturn() && ++attempts < 120) setTimeout(restoreWhenReady, 1000);
      };
      restoreWhenReady();
    }
    const dialog = $('#render-dialog');
    if (dialog) new MutationObserver(() => { if (!dialog.hidden) onDialogOpen(); }).observe(dialog, { attributes: true, attributeFilter: ['hidden'] });
    root.addEventListener('resize', syncDockOffset, { passive: true });
    if (!dialog?.hidden) onDialogOpen();
    console.info('[REVEX] Google renderer ' + BUILD, { model: MODEL, oauth: 'Firebase popup in browser / redirect in WebView', apiKeyInBrowser: false, input: 'live current viewport + camera context', location: 'OpenStreetMap Nominatim suggestions' });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else void init();
})(window);
