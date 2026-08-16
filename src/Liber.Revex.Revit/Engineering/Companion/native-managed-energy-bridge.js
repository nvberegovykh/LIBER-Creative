(() => {
  'use strict';

  const VERSION = '20260816r83';
  const ENDPOINT = 'https://legacy-comcheck.energycode.pnl.gov/CheckWeb/';

  // The native host may ensure/inject this bridge more than once while the
  // same Companion document remains alive. Re-injection must never create a
  // second consent handler or a second revision execution owner.
  const priorBridge = window.__revexManagedEnergyBridge;
  if (priorBridge?.version === VERSION &&
      typeof priorBridge.processInput === 'function' &&
      typeof priorBridge.authorizeCurrentRevision === 'function') return;

  const active = window.__revexManagedEnergyActive instanceof Map
    ? window.__revexManagedEnergyActive
    : new Map();
  window.__revexManagedEnergyActive = active;

  let current = null;
  const $ = (selector) => document.querySelector(selector);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value ?? '').trim();

  function post(stage, message, ok = false, detail = {}) {
    const payload = {
      type: 'liber:revex-managed-energy-status',
      build: VERSION,
      stage,
      message,
      ok: Boolean(ok),
      projectId: clean(detail.projectId || current?.projectId),
      revision: clean(detail.revision || current?.revision),
      elapsedSeconds: detail.startedAt ? Math.round((Date.now() - detail.startedAt) / 1000) : undefined,
      ...detail
    };
    try { window.chrome?.webview?.postMessage(payload); } catch (_) {}
    window.dispatchEvent(new CustomEvent('revex:managed-energy-status', { detail: payload }));
    const node = $('#energy-run-status');
    if (node) {
      node.textContent = message;
      node.dataset.tone = ok ? 'good' : (/FAILED|REJECTED|BLOCKED/.test(stage) ? 'bad' : 'busy');
    }
    console.info('[REVEX managed Energy]', payload);
  }

  async function readManifest(files) {
    const rows = Array.from(files || []);
    const file = rows.find((row) => clean(row?.name).toLowerCase() === 'engineering-sync.json');
    if (!file) throw new Error('Engineering Sync is missing engineering-sync.json.');
    let manifest;
    try { manifest = JSON.parse(await file.text()); }
    catch (error) { throw new Error(`engineering-sync.json is invalid: ${error.message}`); }
    if (manifest?.schema !== 'liber.revex.engineering-sync.v1' || manifest?.architecture !== 'REVIT_EVIDENCE_GRAPH_V1')
      throw new Error('The attached Engineering Sync revision has an unsupported schema.');
    const binding = manifest?.projectBinding || {};
    if (binding.version !== 'active-revit-evidence-v1' || !clean(binding.identityEvidenceDigest) || !clean(binding.documentUniqueId))
      throw new Error('The attached Engineering Sync has no evidence-verified active Revit document binding.');
    const projectId = clean(manifest.projectId);
    const revision = clean(manifest.revision);
    if (!projectId || !revision) throw new Error('Engineering Sync has no exact project ID or immutable revision.');
    return { manifest, projectId, revision };
  }

  function bindCompanion(projectId) {
    window.dispatchEvent(new CustomEvent('revex:native-project-binding', {
      detail: { projectId, view: 'energy', source: 'active-revit-evidence' }
    }));
  }

  function resultMatches(result, projectId, revision, expectedResultRevision = '') {
    if (!result?.manifest) return false;
    const manifest = result.manifest;
    const resultProject = clean(result.projectId || manifest.projectId);
    const sourceRevision = clean(manifest.sourceEngineeringRevision || manifest.sourceRevision || manifest.engineeringRevision);
    const actualResultRevision = clean(result.revision || manifest.resultRevision);
    const expected = clean(expectedResultRevision);
    return resultProject === projectId && sourceRevision === revision && (!expected || actualResultRevision === expected);
  }

  async function waitForCloudStore(Store, projectId, revision, startedAt, timeoutMs = 30000) {
    const began = Date.now();
    let announced = false;
    while (Date.now() - began < timeoutMs) {
      if (Store?.isCloud?.() && Store?.user?.uid) return Store;
      if (!announced) {
        announced = true;
        post('AUTH_WAIT', 'Waiting for the existing LIBER cloud session before publishing this preserved Engineering revision…', false, { projectId, revision, startedAt });
      }
      await delay(100);
    }
    throw new Error('LIBER cloud session did not become ready within 30 seconds. The immutable Engineering revision remains preserved locally and was not published.');
  }

  function showConsent(projectId, revision) {
    const dialog = $('#energy-consent-dialog');
    if (!dialog?.showModal) throw new Error('The revision-scoped COMcheck authorization dialog is unavailable.');
    $('#energy-consent-project').textContent = projectId;
    $('#energy-consent-revision').textContent = revision;
    $('#energy-consent-endpoint').textContent = ENDPOINT;
    dialog.returnValue = '';
    return new Promise((resolve) => {
      const closed = () => resolve(dialog.returnValue === 'approve');
      dialog.addEventListener('close', closed, { once: true });
      dialog.showModal();
    });
  }

  async function waitForExactResult(Store, projectId, revision, startedAt, expectedResultRevision) {
    const expected = clean(expectedResultRevision);
    if (!expected) throw new Error('The managed Energy broker returned no exact result revision for this execution.');
    for (let attempt = 1; attempt <= 240; attempt += 1) {
      const result = await Store.getEnergyResult(projectId);
      if (resultMatches(result, projectId, revision, expected)) return result;
      if (attempt === 1 || attempt % 8 === 0)
        post('RESULT_WAIT', `Managed worker completed; waiting for exact result ${expected} (${attempt}/240)…`, false, { projectId, revision, startedAt, attempt, resultRevision: expected });
      await delay(2000);
    }
    throw new Error(`The broker completed, but exact Energy result ${expected} did not become current within 8 minutes.`);
  }

  async function runApproved(Store, projectId, revision, startedAt) {
    post('BROKER_RUNNING', 'Private managed Energy worker started: GeometryCo → two OSMs → two EnergyPlus runs → official COMcheck → EN-1.', false, { projectId, revision, startedAt });
    let heartbeat = 0;
    const timer = setInterval(() => {
      heartbeat += 1;
      post('BROKER_RUNNING', `Managed Energy is still running safely (${Math.round((Date.now() - startedAt) / 1000)} s).`, false, { projectId, revision, startedAt, heartbeat });
    }, 15000);
    try {
      const response = await Store.runEnergyServer(projectId, revision);
      const expectedResultRevision = clean(response?.resultRevision);
      if (!expectedResultRevision) throw new Error('Managed Energy broker completed without publishing an exact resultRevision.');
      post('BROKER_PASSED', response?.message || `Managed Energy worker completed as ${expectedResultRevision}; verifying that exact immutable result…`, true, { projectId, revision, startedAt, resultRevision: expectedResultRevision });
      const result = resultMatches(response?.result, projectId, revision, expectedResultRevision)
        ? response.result
        : await waitForExactResult(Store, projectId, revision, startedAt, expectedResultRevision);
      const status = clean(result?.manifest?.status).toUpperCase();
      if (status !== 'COMPLETE') throw new Error(result?.manifest?.error || `Energy result ${expectedResultRevision} status is ${status || 'UNKNOWN'}.`);
      window.dispatchEvent(new CustomEvent('revex:managed-energy-result', { detail: { projectId, revision, resultRevision: expectedResultRevision, result, response } }));
      post('COMPLETE', `Energy chain complete for ${revision} as ${expectedResultRevision}. Current-project CXL, COMcheck PDF, both OSMs, simulations, PRM review, and EN-1 are available.`, true, { projectId, revision, startedAt, resultRevision: expectedResultRevision });
      return { ok: true, projectId, revision, resultRevision: expectedResultRevision, result, response };
    } finally {
      clearInterval(timer);
    }
  }

  async function authorizeAndRun(Store, projectId, revision, startedAt, forcePrompt = false) {
    let consent = await Store.getEnergyConsent(projectId, revision);
    if (!consent || forcePrompt) {
      post('CONSENT_REQUIRED', 'One essential approval is required for this immutable revision only.', false, { projectId, revision, startedAt });
      if (!(await showConsent(projectId, revision))) {
        post('EVIDENCE_ONLY', 'Engineering evidence is safely published. No CXL was transmitted and downstream Energy processing was not started.', true, { projectId, revision, startedAt });
        return { ok: true, evidenceOnly: true, projectId, revision };
      }
      consent = await Store.recordEnergyConsent(projectId, revision);
      post('CONSENT_RECORDED', 'Revision-scoped COMcheck authorization recorded. Later revisions will ask again.', true, { projectId, revision, startedAt });
    } else {
      post('CONSENT_REUSED', 'Using the existing authorization for this exact immutable revision only.', true, { projectId, revision, startedAt });
    }
    return runApproved(Store, projectId, revision, startedAt);
  }

  function ownTask(key, factory) {
    if (active.has(key)) return active.get(key);
    const task = Promise.resolve().then(factory).finally(() => active.delete(key));
    active.set(key, task);
    return task;
  }

  async function processInput(fileList) {
    const Store = window.RevexStore;
    if (!Store) throw new Error('REVEX cloud Store is unavailable.');
    const files = Array.from(fileList || []);
    const { projectId, revision } = await readManifest(files);
    const key = `${projectId}:${revision}`;
    return ownTask(key, async () => {
      const startedAt = Date.now();
      current = { projectId, revision, startedAt };
      try {
        post('VALIDATING', 'Validating active-document identity, immutable evidence, and project boundary…', false, current);
        bindCompanion(projectId);
        await waitForCloudStore(Store, projectId, revision, startedAt);
        const state = await Store.syncEngineeringPackage(files, projectId);
        if (clean(state?.projectId) !== projectId || clean(state?.revision) !== revision)
          throw new Error('Cloud Engineering state did not preserve the exact active-document project and revision.');
        current.state = state;
        post('CLOUD_UPLOAD_PASSED', `Immutable Engineering revision ${revision} published to ${projectId}.`, true, current);
        return await authorizeAndRun(Store, projectId, revision, startedAt, false);
      } catch (error) {
        post('BROKER_FAILED', error?.message || 'Managed Energy chain failed.', false, { projectId, revision, startedAt, error: error?.stack || String(error) });
        throw error;
      } finally {
        if (current?.projectId === projectId && current?.revision === revision) current = null;
      }
    });
  }

  async function authorizeCurrentRevision() {
    const Store = window.RevexStore;
    const projectId = clean(window.__revexState?.projectId);
    await waitForCloudStore(Store, projectId, clean(current?.revision), Date.now());
    const source = current?.projectId === projectId ? current?.state : await Store?.getEngineeringState?.(projectId);
    const revision = clean(source?.revision || source?.manifest?.revision);
    if (!Store || !projectId || !revision) throw new Error('Publish an active-document Engineering Sync revision first.');
    const key = `${projectId}:${revision}`;
    return ownTask(key, () => authorizeAndRun(Store, projectId, revision, Date.now(), true));
  }

  window.__revexManagedEnergyBridge = { version: VERSION, processInput, authorizeCurrentRevision, resultMatches };

  const authorizeButton = $('#energy-authorize-backstop');
  if (authorizeButton) {
    const handler = () => {
      authorizeCurrentRevision().catch((error) => post('BROKER_FAILED', error?.message || 'Managed Energy could not start.'));
    };
    // Property ownership is intentionally singular. Combined with the version
    // guard and global active map, one user click can create at most one broker
    // call for one project/revision even if the host ensures the bridge again.
    authorizeButton.onclick = handler;
    window.__revexManagedEnergyAuthorizeHandler = handler;
  }
})();
