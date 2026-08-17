'use strict';
const fs=require('fs');
const assert=require('assert');
const deploy=fs.readFileSync('server/revex-render-worker/DEPLOY_RENDER_SERVER.ps1','utf8').replace(/\r\n/g,'\n');
const pkg=JSON.parse(fs.readFileSync('server/revex-render-functions/package.json','utf8'));
const must=(needle,label)=>assert(deploy.includes(needle),label||`Missing ${needle}`);
const forbid=(needle,label)=>assert(!deploy.includes(needle),label||`Forbidden ${needle}`);

assert.strictEqual(String(pkg?.engines?.node||''),'22','render broker package must pin Node 22');
must('if ([string]$package.engines.node -ne "22")','deployment must validate package Node 22 pin');
must('Preflight callable broker export','local preflight must validate export, not timing');
forbid('if(ms>10000)','local cold module time must never be a release hard-stop');
forbid('broker module discovery exceeded 10s','the exact false failure must not return');
must('"--runtime","nodejs22"','Cloud Function deployment must pin Node 22');
must('"value(buildConfig.runtime)"','deployment must read back the live runtime');
must('$RuntimeName -ne "nodejs22"','deployment must reject a non-Node-22 live broker');
must('deployed runtime is pinned separately to nodejs22','local Node version must be diagnostic only');

console.log(JSON.stringify({
  schema:'liber.revex.r112-render-preflight.v1',status:'PASSED',
  localNode:{versionAgnostic:true,coldLoadHardStop:false},
  cloudRuntime:{packagePin:'22',deployPin:'nodejs22',postDeployVerified:true},
  workerPreservedInBrokerOnly:true
},null,2));
