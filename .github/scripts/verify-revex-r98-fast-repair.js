'use strict';
const fs=require('fs');
const text=fs.readFileSync('REPAIR_REVEX_ENERGY_VERTEX_BINDING_CURRENT.ps1','utf8');
for(const marker of ['run','services','update','--update-env-vars','REVEX_VERTEX_PROJECT=$VertexProject','REVEX_VERTEX_LOCATION=$VertexLocation','REVEX_SOURCE_CANDIDATE','roles/run.invoker']){
  if(!text.includes(marker))throw new Error(`fast repair missing ${marker}`);
}
for(const forbidden of ['builds","submit','run","deploy','firebase","deploy','SYNC ENGINEERING']){
  if(text.includes(forbidden))throw new Error(`fast repair unexpectedly contains ${forbidden}`);
}
console.log('REVEX_R98_FAST_REPAIR_SCOPE=PASSED');
