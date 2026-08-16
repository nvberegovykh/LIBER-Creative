'use strict';
const fs = require('fs');

const read = p => fs.readFileSync(p, 'utf8');
const workerOnly = read('server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1');
const full = read('server/revex-energy-worker/DEPLOY_ENERGY_CURRENT.ps1');
const docker = read('server/revex-energy-worker/Dockerfile');
const helper = read('server/revex-energy-worker/revex_cloud_project.py');
const agent = read('server/revex-energy-worker/revex_identity_content_agent.py');
const repair = read('REPAIR_REVEX_ENERGY_VERTEX_BINDING_CURRENT.ps1');

for (const [name,text] of [['worker-only',workerOnly],['full',full]]) {
  if (!text.includes('REVEX_VERTEX_PROJECT=$VertexProject')) throw new Error(`${name}: Vertex project not passed to Cloud Run`);
  if (!text.includes('REVEX_VERTEX_LOCATION=$VertexLocation')) throw new Error(`${name}: Vertex location not passed to Cloud Run`);
  if (!text.includes("$VertexProject = $ProjectId")) throw new Error(`${name}: deployment GCP project is not the Vertex source`);
  if (!text.includes("$VertexLocation = \"global\"")) throw new Error(`${name}: Vertex location is not explicit`);
  if (!text.includes("Live worker Vertex AI project")) throw new Error(`${name}: live env verification is missing`);
}
for (const marker of [
  'COPY server/revex-energy-worker/revex_cloud_project.py',
  'COPY server/revex-energy-worker/verify_vertex_project_binding_r98.py',
  'python3 /opt/revex/server/verify_vertex_project_binding_r98.py'
]) if (!docker.includes(marker)) throw new Error(`Docker missing ${marker}`);
for (const marker of ['REVEX_VERTEX_PROJECT','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','google.auth.default','not a valid substitute'])
  if (!helper.includes(marker)) throw new Error(`cloud resolver missing ${marker}`);
if (!agent.includes('project = resolve_vertex_project()')) throw new Error('content identity agent is not using the authoritative cloud project resolver');
if (!repair.includes("'--update-env-vars'")) throw new Error('fast repair is not env-only');
if (/builds["', ]+submit|run["', ]+deploy|firebase["', ]+deploy/.test(repair)) throw new Error('fast repair unexpectedly rebuilds or deploys code');
for (const forbidden of ['250 MIDWOOD','79 WINTHROP']) {
  if ((helper+'\n'+agent).toUpperCase().includes(forbidden)) throw new Error(`project-specific runtime branch found: ${forbidden}`);
}
console.log('REVEX_R98_SOURCE_CONTRACT=PASSED');
