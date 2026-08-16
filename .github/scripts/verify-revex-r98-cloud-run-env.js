'use strict';
const fs=require('fs');
const scripts=['server/revex-energy-worker/DEPLOY_ENERGY_CURRENT.ps1','server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1'];
for(const p of scripts){const t=fs.readFileSync(p,'utf8');const env=t.match(/--set-env-vars=([^"\r\n]+)/);if(!env)throw new Error(`${p}: no Cloud Run env set`);for(const k of ['REVEX_ENERGY_TIMEOUT_SECONDS=3500','REVEX_SOURCE_CANDIDATE=$SourceCandidate','REVEX_VERTEX_PROJECT=$VertexProject','REVEX_VERTEX_LOCATION=$VertexLocation'])if(!env[1].includes(k))throw new Error(`${p}: missing ${k}`)}
console.log('REVEX_R98_CLOUD_RUN_ENV=PASSED');
