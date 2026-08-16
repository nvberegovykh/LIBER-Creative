'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const broker=fs.readFileSync(path.join(root,'server/firebase-functions/index.js'),'utf8');
const deploy=fs.readFileSync(path.join(root,'server/revex-energy-worker/DEPLOY_ENERGY_BROKER_ONLY_R77.ps1'),'utf8');
const must=(t,n,m)=>assert(t.includes(n),m||`Missing ${n}`);

must(broker,"const workerSourceCandidate = String(resultManifest.sourceCandidate || '').trim();",'broker must read the worker source candidate from the worker result');
must(broker,"!/^[a-f0-9]{40}$/i.test(workerSourceCandidate)",'worker source candidate must be a real git SHA');
must(broker,"String(resultManifest.pipelineVersion || '') !== '0.8.19-r49'",'pipeline version remains pinned');
must(broker,'resultManifest.revitWriteBack !== false || resultManifest.pdfInsertion !== false','authority boundary remains no-writeback/no-PDF-insertion');
assert(!broker.includes("String(resultManifest.sourceCandidate || '') !== SOURCE_CANDIDATE"),'broker must not require its own deployment SHA to equal the independently deployed worker SHA');
must(broker,'workerSourceCandidate, brokerSourceCandidate: SOURCE_CANDIDATE || null','result state must retain actual worker and broker provenance');

must(deploy,'BrokerOnly','broker-only deployment contract marker missing');
must(deploy,'runRevexEnergy','energy callable must be the only deployed function');
must(deploy,'REVEX_ENERGY_WORKER_URL=$WorkerUrl','broker-only deploy must bind to the already-running private worker');
must(deploy,'Google Cloud CLI','broker-only deploy must use gcloud');
assert(!/Require-Command[^\n]*firebase/i.test(deploy),'broker-only deployment must not require Firebase CLI');
assert(!/run','deploy',[^\n]*\$Service/.test(deploy),'broker-only deployment must not redeploy the worker');
must(deploy,"'functions','deploy','runRevexEnergy'",'broker-only deployment must deploy only runRevexEnergy');

console.log(JSON.stringify({schema:'liber.revex.r77-energy-broker-worker-contract.v1',status:'PASSED',resume:{revitRerun:false,workerRedeploy:false,brokerOnly:true},authority:{pipelinePinned:true,noRevitWriteBack:true,noPdfInsertion:true,workerShaRecorded:true,brokerWorkerShaDecoupled:true}},null,2));
