'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const must = (text, needle, label) => assert(text.includes(needle), label || `Missing: ${needle}`);
const mustNot = (text, needle, label) => assert(!text.includes(needle), label || `Forbidden: ${needle}`);

const workspace = read('docs/liber-apps/apps/revex/workspace-r51.js');
const selfhost = read('docs/liber-apps/apps/revex/render-selfhost-r54.js');
const google = read('docs/liber-apps/apps/revex/render-agent.js');
const review = read('docs/liber-apps/apps/revex/review-integrity-r50.js');
const store = read('docs/liber-apps/apps/revex/store.js');
const worker = read('server/revex-render-worker/app.py');
const docker = read('server/revex-render-worker/Dockerfile');
const manifest = JSON.parse(read('server/revex-render-worker/model-manifest.json'));
const broker = read('server/revex-render-functions/index.js');
const deploy = read('server/revex-render-worker/DEPLOY_RENDER_SERVER.ps1');
const energyQa = read('src/Liber.Revex.Revit/Engineering/Energy/verify_revex_r49_energy.py');
const currentGuard = read('.github/scripts/verify-revex-current-generation-r53.js');
const currentEnergyDeploy = read('server/revex-energy-worker/DEPLOY_ENERGY_CURRENT.ps1');
const unifiedDeploy = read('DEPLOY_REVEX_CURRENT_SERVICES.ps1');
const unifiedBootstrap = read('DEPLOY_REVEX_CURRENT_SERVICES_BOOTSTRAP.ps1');

// Default render path is private/off-device and requires no model-provider login.
must(workspace, "import './render-selfhost-r54.js';", 'workspace must load self-host renderer');
must(selfhost, "provider: 'revex-selfhosted'", 'self-host provider not declared');
must(selfhost, "browserInference: false", 'browser inference must stay disabled');
must(selfhost, "extraLogin: false", 'default renderer must require no extra login');
must(selfhost, "document.addEventListener('click', interceptClick, true)", 'self-host renderer must own default render click in capture phase');
must(selfhost, 'allowGoogleOnce', 'Google must remain explicit one-shot fallback');
must(selfhost, 'runRevexRender', 'browser must use private authenticated render broker');
mustNot(selfhost, 'huggingface.co/api', 'browser must never call Hugging Face directly');
mustNot(selfhost, 'from_pretrained', 'browser must never load the model');
mustNot(selfhost.toLowerCase(), 'rendair.com', 'Rendair routing must not return');

// Exact public upstream is pinned and tokenless; no moving-main dependency.
assert.strictEqual(manifest.model, 'Qwen/Qwen-Image-Edit-2511');
assert.strictEqual(manifest.revision, '6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9');
assert.strictEqual(manifest.license, 'Apache-2.0');
assert.strictEqual(manifest.authentication, 'none-public-repository');
assert.strictEqual(manifest.integrity.revisionPinned, true);
assert.strictEqual(manifest.integrity.allowMovingMain, false);
assert.strictEqual(manifest.integrity.allowHuggingFaceTokenRequirement, false);
must(worker, 'os.environ.pop("HF_TOKEN", None)', 'worker must discard HF runtime token');
must(worker, 'token": False', 'public upstream must explicitly load without token');
must(worker, '"revision": MODEL_REVISION', 'worker must use immutable model revision');
must(worker, '"device_map": "cuda"', 'large model must load directly to GPU');
must(worker, 'HF_XET_HIGH_PERFORMANCE', 'public cold-load acceleration missing');
must(worker, '_INFERENCE_LOCK', 'GPU inference must remain serialized');
must(worker, 'MIN_GPU_VRAM_GIB', 'worker must reject undersized GPU instead of OOM thrashing');
must(docker, 'HF_ENABLE_PARALLEL_LOADING=YES', 'parallel shard loading not enabled');
mustNot(docker, 'COPY Qwen', 'model weights must not be committed/baked accidentally');

// Broker is project-authenticated and the Cloud Run worker remains private.
must(broker, "if (!request.auth?.uid)", 'render broker must require LIBER auth');
must(broker, 'assertProjectAccess', 'render broker must enforce project access');
must(broker, 'getIdTokenClient(RENDER_WORKER_URL)', 'broker must invoke private Cloud Run with identity token');
must(broker, 'projects/${projectId}/revex/renders/${jobId}', 'render source/result path must be project/job scoped');
must(deploy, '--no-allow-unauthenticated', 'worker must not be public');
must(deploy, '--gpu-type=nvidia-rtx-pro-6000', '96 GiB render GPU contract missing');
must(deploy, '--cpu=20', 'RTX PRO 6000 CPU floor missing');
must(deploy, '--memory=80Gi', 'RTX PRO 6000 instance-memory floor missing');
must(deploy, '--concurrency=1', 'GPU worker concurrency must remain one');
must(deploy, '--min-instances=0', 'GPU service must be able to scale to zero');
must(deploy, 'roles/run.invoker', 'private worker invoker grant missing');

// Existing render job and Design Book paths are reused; no parallel data universe.
must(store, "'revexRenders'", 'existing render-job collection must remain authoritative');
must(selfhost, 'Store.createRenderJob', 'self-host path must use existing render history');
must(selfhost, 'Store.uploadChapterImage', 'render save must use existing Design Book image path');

// Viewer aesthetics are additive. Core review/navigation functionality must survive.
must(review, 'v.setSectionEnabled', 'visible six-face section box functionality missing');
must(review, 'v.setSectionFace', 'section face controls missing');
must(review, 'v.setSectionDimension', 'section dimension controls missing');
must(review, 'commitVisibility', 'reversible hide/delete overlay functionality missing');
must(review, 'renderHiddenRegistry', 'hidden/deleted restore registry missing');
must(review, "id === 'walk-toggle'", 'Walk control path missing');
must(workspace, 'captureRenderReference', 'clean renderer snapshot contract missing');
must(workspace, 'for (const [node, visible] of hidden) node.visible = visible', 'clean capture must restore viewer helper visibility');
must(workspace, 'applyPresentation(v)', 'visual presentation layer missing');
mustNot(workspace, 'scene.clear(', 'presentation must never clear authoritative BIM scene');
mustNot(workspace, 'data.elements = []', 'presentation must never erase BIM element data');

// Spatial objects remain presentation-invisible while real BIM stays functional.
must(currentGuard, 'spatialObjectsVisible', 'current-generation guard must retain spatial-object visibility contract');
must(workspace, 'spatialObjectsVisible: false', 'rooms/spaces should not become visible geometry');

// Do not regress the accepted Midwood >=80% / <95% Energy reconciliation.
must(energyQa, 'reconcile_publication_message_severity', 'accepted gbXML severity reconciliation QA missing');
must(energyQa, 'REVIT_TO_GBXML_GEOMETRY_INTEGRITY_REVIEW', 'accepted geometry review downgrade missing');
must(energyQa, 'sub-80 geometry integrity failure was incorrectly downgraded', 'hard floor regression test missing');
must(currentGuard, 'reconcile_publication_message_severity', 'current-generation Energy guard missing');

// Production Energy deployment must use fresh/current source, never the stale r49 archive-restoration publisher.
must(currentEnergyDeploy, '[Parameter(Mandatory = $true)]', 'current Energy deploy must require an exact source candidate');
must(currentEnergyDeploy, 'REVEX_SOURCE_CANDIDATE=$SourceCandidate', 'Energy worker must be bound to deployed source candidate');
must(currentEnergyDeploy, 'REVEX_ENERGY_WORKER_URL=$WorkerUrl', 'Energy broker must bind to the just-deployed worker');
must(currentEnergyDeploy, 'verify-revex-current-generation-r53.js', 'Energy deploy must run the current-generation guard before cloud changes');
must(currentEnergyDeploy, '--no-allow-unauthenticated', 'Energy worker must remain private');
must(currentEnergyDeploy, 'roles/run.invoker', 'only the Energy broker may invoke private worker');
mustNot(currentEnergyDeploy, 'REVEX_R49_SOURCE_', 'current Energy deploy must not restore the legacy immutable source archive');
mustNot(currentEnergyDeploy, 'CanonicalSourceCommit', 'current Energy deploy must not pin the stale publisher candidate');
must(unifiedDeploy, 'DEPLOY_REVEX_CURRENT_SERVICES_BOOTSTRAP.ps1', 'unified launcher must delegate to the Windows-safe current-source bootstrap');
must(unifiedDeploy, 'Start-Transcript', 'unified launcher must preserve deployment diagnostics');
must(unifiedBootstrap, '"clone", "--depth", "1", "--branch", "main"', 'unified bootstrap must begin from a fresh GitHub main clone');
must(unifiedBootstrap, '"rev-parse", "HEAD"', 'unified bootstrap must resolve the exact cloned main commit');
must(unifiedBootstrap, 'DEPLOY_ENERGY_CURRENT.ps1', 'unified bootstrap must use the current Energy path');
must(unifiedBootstrap, 'DEPLOY_RENDER_SERVER.ps1', 'unified bootstrap must use the private render path');
mustNot(unifiedDeploy, 'PUBLISH_REVEX_R49.ps1', 'unified launcher must never invoke the stale publisher');
mustNot(unifiedBootstrap, 'PUBLISH_REVEX_R49.ps1', 'unified bootstrap must never invoke the stale publisher');

console.log(JSON.stringify({
  schema: 'liber.revex.r54-selfhost-render-energy-viewer-qa.v1',
  status: 'PASSED',
  model: manifest.model,
  revision: manifest.revision,
  defaultRenderer: 'private-revex-gpu',
  extraModelLogin: false,
  browserInference: false,
  googleFallback: true,
  viewerFunctionPreserved: true,
  energyAcceptedReviewPreserved: true,
  cleanCurrentDeployment: true,
  stalePublisherUsed: false
}, null, 2));
