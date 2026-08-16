'use strict';
const fs = require('fs');

const read = p => fs.readFileSync(p, 'utf8');
const workerOnly = read('server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1');
const full = read('server/revex-energy-worker/DEPLOY_ENERGY_CURRENT.ps1');
const docker = read('server/revex-energy-worker/Dockerfile');
const entry = read('server/revex-energy-worker/app_entry.py');
const helper = read('server/revex-energy-worker/revex_cloud_project.py');
const agent = read('server/revex-energy-worker/revex_identity_content_agent.py');
const repair = read('REPAIR_REVEX_ENERGY_VERTEX_BINDING_CURRENT.ps1');
const ui = read('docs/liber-apps/apps/revex/ui-integrity.js');
const loader = read('docs/liber-apps/apps/revex/viewer-interaction-r85-loader.js');

for (const [name,text] of [['worker-only',workerOnly],['full',full]]) {
  if (!text.includes('REVEX_VERTEX_PROJECT=$VertexProject')) throw new Error(`${name}: Vertex project not passed to Cloud Run`);
  if (!text.includes('REVEX_VERTEX_LOCATION=$VertexLocation')) throw new Error(`${name}: Vertex location not passed to Cloud Run`);
  if (!text.includes("$VertexProject = $ProjectId")) throw new Error(`${name}: deployment GCP project is not the Vertex source`);
  if (!text.includes("$VertexLocation = \"global\"")) throw new Error(`${name}: Vertex location is not explicit`);
  if (!text.includes("Live worker Vertex AI project")) throw new Error(`${name}: live env verification is missing`);
}
for (const marker of [
  'COPY server/revex-energy-worker/app_entry.py',
  'COPY server/revex-energy-worker/revex_cloud_project.py',
  'COPY server/revex-energy-worker/verify_vertex_project_binding_r98.py',
  'REVEX_VERTEX_PROJECT=liber-apps-cca20 REVEX_VERTEX_LOCATION=global python3 -c',
  'python3 /opt/revex/server/verify_vertex_project_binding_r98.py',
  'app_entry:APP'
]) if (!docker.includes(marker)) throw new Error(`Docker missing ${marker}`);
for (const marker of ['os.environ["REVEX_VERTEX_PROJECT"] = resolve_vertex_project()','from app import APP'])
  if (!entry.includes(marker)) throw new Error(`production entrypoint missing ${marker}`);
for (const marker of ['REVEX_VERTEX_PROJECT','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','google.auth.default','not a valid substitute'])
  if (!helper.includes(marker)) throw new Error(`cloud resolver missing ${marker}`);
if (!agent.includes('project = resolve_vertex_project()')) throw new Error('content identity agent is not using the authoritative cloud project resolver');
for (const marker of ['aiplatform.googleapis.com','roles/aiplatform.user','roles/storage.objectAdmin',"'--update-env-vars'",'roles/run.invoker'])
  if (!repair.includes(marker)) throw new Error(`fast repair dependency proof missing ${marker}`);
if (/builds["', ]+submit|run["', ]+deploy|firebase["', ]+deploy/.test(repair)) throw new Error('fast repair unexpectedly rebuilds or deploys code');
if (!ui.includes('viewer-interaction-r85-loader.js?v=20260816r98-live-edge2')) throw new Error('Revit WebView can retain a pre-r97 viewer loader');
if (!loader.includes("import('./live-worker-edge-r97.js?v=20260816r97-live-worker-edge2')")) throw new Error('r97 exact-job recovery is not independently loaded');
for (const forbidden of ['250 MIDWOOD','79 WINTHROP']) {
  if ((helper+'\n'+agent+'\n'+entry).toUpperCase().includes(forbidden)) throw new Error(`project-specific runtime branch found: ${forbidden}`);
}
console.log('REVEX_R98_SOURCE_CONTRACT=PASSED');
