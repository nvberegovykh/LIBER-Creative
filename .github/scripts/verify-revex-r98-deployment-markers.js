'use strict';
const fs=require('fs');
for(const p of ['server/revex-energy-worker/DEPLOY_ENERGY_CURRENT.ps1','server/revex-energy-worker/DEPLOY_ENERGY_WORKER_ONLY_R69.ps1']){
 const t=fs.readFileSync(p,'utf8');
 for(const m of ["$LiveEnv['REVEX_VERTEX_PROJECT']","$LiveEnv['REVEX_VERTEX_LOCATION']","REVEX_SOURCE_CANDIDATE"]){if(!t.includes(m))throw new Error(`${p} missing live assertion ${m}`)}
}
console.log('REVEX_R98_LIVE_ENV_ASSERTIONS=PASSED');
