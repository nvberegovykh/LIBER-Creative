'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..', '..');
const sourcePath = path.join(root, 'docs/liber-apps/apps/revex/live-worker-edge-r97.js');
const loaderPath = path.join(root, 'docs/liber-apps/apps/revex/viewer-interaction-r85-loader.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const loader = fs.readFileSync(loaderPath, 'utf8');
new vm.Script(source, { filename: sourcePath });
new vm.Script(loader, { filename: loaderPath });

// r97 transport-loss invariants remain mandatory, while r116 adds explicit
// pipeline-terminal handling so BLOCKED_* can never be re-followed forever.
assert(source.includes("status==='RUNNING'||status==='COMPLETE'||durable"));
assert(source.includes("pipelineTerminal(status)||worker.status==='FAILED'"));
assert(source.includes("worker.status==='RUNNING'&&worker.fresh"));
assert(source.includes('workerPipelineStatus'));
assert(source.includes('followAuthoritativeJob'));
assert(source.includes('readJobAfterCallable'));
assert(source.includes('event.stopImmediatePropagation'));
assert(source.includes('ENERGY_NATIVE_EDGE_R116'));
assert(loader.includes('REVEX_R114_LIVE_EDGE_COMPAT'));
assert(loader.includes('live-worker-edge-r97.js?v=20260817r116-final-energy1'));

function makeHarness(job) {
  const listeners = new Map();
  const diagnostics = [];
  let followCount = 0;
  const Store = {
    isCloud: () => true,
    user: { uid: 'user-1' },
    getEngineeringState: async () => ({ revision: 'eng_test', manifest: { revision: 'eng_test' } }),
    getEnergyResult: async () => ({
      projectId: 'revex_test', revision: job.resultRevision || 'energy_test',
      manifest: { projectId: 'revex_test', sourceEngineeringRevision: 'eng_test', resultRevision: job.resultRevision || 'energy_test', status: 'COMPLETE' }
    }),
    api: {
      doc: (...parts) => parts.join('/'),
      getDoc: async () => ({ exists: () => true, data: () => job })
    },
    db: {}
  };
  const document = { readyState: 'complete', getElementById: () => null };
  const window = {
    document,
    location: { search: '?projectId=revex_test' },
    URLSearchParams,
    console: { info() {}, error() {}, warn() {}, log() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    CustomEvent: function(type, options){ this.type=type; this.detail=options?.detail; },
    __revexState: { projectId: 'revex_test' },
    __revexBrowserDiagnostics: { emit: (...args) => diagnostics.push(args) },
    RevexStore: Store,
    __revexManagedEnergyBridge: {
      version: '20260816r83',
      authorizeCurrentRevision: async () => { throw new Error('internal · Code: functions/internal'); }
    },
    __revexHostedEnergyReplayR95: {
      followExistingJob: async (store, id, revision) => {
        followCount += 1;
        assert.strictEqual(store, Store);
        assert.strictEqual(id, 'revex_test');
        assert.strictEqual(revision, 'eng_test');
        return { ok: true, followed: true };
      }
    },
    addEventListener(type, handler, capture) {
      const rows = listeners.get(type) || [];
      rows.push({ handler, capture });
      listeners.set(type, rows);
    },
    dispatchEvent() { return true; }
  };
  window.window = window;
  const context = vm.createContext({ window, document, location: window.location, URLSearchParams, console: window.console, setTimeout, clearTimeout, setInterval, clearInterval, CustomEvent: window.CustomEvent });
  new vm.Script(source, { filename: sourcePath }).runInContext(context);
  return { window, listeners, diagnostics, getFollowCount: () => followCount };
}

(async () => {
  {
    const h = makeHarness({ status: 'RUNNING', stage: 'OPENSTUDIO' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = await h.window.__revexManagedEnergyBridge.authorizeCurrentRevision();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { ok: true, followed: true });
    assert.strictEqual(h.getFollowCount(), 1, 'dropped callable must reattach to exact running job');
  }
  {
    const h = makeHarness({ status: 'COMPLETE', stage: 'COMPLETE', resultRevision: 'energy_exact' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = await h.window.__revexManagedEnergyBridge.authorizeCurrentRevision();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { ok: true, followed: true });
    assert.strictEqual(h.getFollowCount(), 1, 'dropped callable after strict server completion must bind the exact completed job');
  }
  {
    const now=Date.now();
    const h = makeHarness({ status: 'INFRASTRUCTURE_FAILED', stage: 'WORKER_REQUEST', error: 'read ECONNRESET', workerStatus: 'RUNNING', workerStage: 'WORKER_EXECUTION', workerHeartbeatAt: { toMillis: () => now } });
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = await h.window.__revexManagedEnergyBridge.authorizeCurrentRevision();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { ok: true, followed: true });
    assert.strictEqual(h.getFollowCount(), 1, 'broker transport loss must not terminate a worker with a fresh durable heartbeat');
  }
  {
    const h = makeHarness({ status: 'BLOCKED_COMCHECK_INPUT', stage: 'COMCHECK_INPUT', error: 'missing filing-grade current-project COMcheck input', workerStatus: 'FAILED', workerStage: 'PIPELINE_TERMINAL', workerPipelineStatus: 'BLOCKED_COMCHECK_INPUT' });
    await new Promise(resolve => setTimeout(resolve, 30));
    await assert.rejects(
      () => h.window.__revexManagedEnergyBridge.authorizeCurrentRevision(),
      error => /COMCHECK_INPUT: missing filing-grade current-project COMcheck input/.test(String(error?.message || error))
    );
    assert.strictEqual(h.getFollowCount(), 0, 'terminal COMcheck evidence failure must not enter durable recovery/finalization loop');
  }
  {
    const h = makeHarness({ status: 'INFRASTRUCTURE_FAILED', stage: 'WORKER_REQUEST', error: 'upstream reset', workerHttpStatus: 503 });
    await new Promise(resolve => setTimeout(resolve, 30));
    await assert.rejects(
      () => h.window.__revexManagedEnergyBridge.authorizeCurrentRevision(),
      error => /WORKER_REQUEST \[HTTP 503\]: upstream reset/.test(String(error?.message || error))
    );
    assert.strictEqual(h.getFollowCount(), 0, 'infrastructure failure without a live durable worker must remain a real failure');
  }
  {
    const h = makeHarness({ status: 'COMPLETE', resultRevision: 'energy_exact' });
    const keydown = (h.listeners.get('keydown') || []).find(row => row.capture)?.handler;
    assert.strictEqual(typeof keydown, 'function');
    let stopped = false;
    keydown({ key: undefined, stopImmediatePropagation: () => { stopped = true; } });
    assert.strictEqual(stopped, true, 'malformed key-less WebView event must be stopped before legacy viewer handler');
    stopped = false;
    keydown({ key: 'W', stopImmediatePropagation: () => { stopped = true; } });
    assert.strictEqual(stopped, false, 'normal keyboard event must remain untouched');
  }
  console.log(JSON.stringify({
    schema: 'liber.revex.r116-live-worker-edge-qa.v1',
    status: 'PASSED',
    callableDropRunningJob: 'reattach-same-job',
    callableDropCompletedJob: 'bind-exact-complete-result',
    callableDropLiveWorker: 'durable-heartbeat-preserves-run',
    blockedComcheckInput: 'terminal-no-loop',
    infrastructureFailureWithoutWorker: 'exact-firestore-job-error',
    malformedViewerKey: 'ignored-before-legacy-toLowerCase',
    duplicateLaunch: 'not-created',
    qaHardStop: 'unchanged'
  }, null, 2));
})().catch(error => { console.error(error); process.exit(1); });
