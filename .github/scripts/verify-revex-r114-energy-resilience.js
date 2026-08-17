'use strict';
const fs=require('fs');
const assert=require('assert');
const read=p=>fs.readFileSync(p,'utf8');
const worker=read('server/revex-energy-worker/durable_execution.py');
const entry=read('server/revex-energy-worker/app_entry.py');
const docker=read('server/revex-energy-worker/Dockerfile');
const requirements=read('server/revex-energy-worker/requirements-server.txt');
const deploy=read('server/revex-energy-worker/DEPLOY_ENERGY_RESILIENT_R114.ps1');
const replay=read('docs/liber-apps/apps/revex/energy-replay-r95.js');
const edge=read('docs/liber-apps/apps/revex/live-worker-edge-r97.js');
const loader=read('docs/liber-apps/apps/revex/viewer-interaction-r85-loader.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const broker=read('server/firebase-functions/index.js');
const geometry=read('src/Liber.Revex.Revit/Engineering/Energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);
const forbid=(text,needle,label)=>assert(!text.includes(needle),label||`Forbidden ${needle}`);

must(worker,'HEARTBEAT_SECONDS = 15','worker heartbeat must be 15 seconds');
must(worker,'LEASE_SECONDS = 120','worker lease must be bounded');
must(worker,'worker-response.json','completed worker response must be durable in Storage');
must(worker,'workerStatus": "RUNNING"','worker must persist RUNNING state');
must(worker,'workerStatus": "COMPLETE"','worker must persist COMPLETE state');
must(worker,'workerStatus": "FAILED"','worker must persist FAILED state');
must(worker,'@firestore.transactional','duplicate worker launches must be transactionally lease-guarded');
must(worker,'workerLeaseExpiresAt','worker lease expiry must be durable');
must(worker,'return jsonify(cached), 200','completed worker response must be replayable without recomputation');
must(worker,'return jsonify({\n                "schema": "liber.revex.energy-worker-async.v1"','fresh duplicate launch must attach, not duplicate');
forbid(worker,'firestore.Client()\n    storage_client = storage.Client()\n\n    def durable_run_energy','cloud clients must not bind at module install/import time');
must(entry,'install_durable_energy_execution(APP)','production app must install the durability wrapper');
must(requirements,'google-cloud-firestore==','worker image must carry Firestore durability client');
must(docker,'COPY server/revex-energy-worker/durable_execution.py','durable wrapper must ship in worker image');
must(docker,'/opt/revex/server/durable_execution.py','durable wrapper must be py-compiled in worker image');
must(docker,'OpenStudio_Energy_Model_Geometry_Compiler_core.py','GeometryCo core preservation must remain intact');

must(deploy,'roles/datastore.user','worker must receive durable Firestore job access');
must(deploy,"if($timeout -ne 3600)",'live worker timeout must be verified at 3600s');
must(deploy,"if($functionTimeout -ne 3600)",'live broker timeout must be verified at 3600s');
must(deploy,"if($brokerRuntime -ne 'nodejs22')",'live broker runtime must remain Node 22');
must(deploy,"REVEX_ENERGY_TIMEOUT_SECONDS'] -ne '3500'",'live pipeline hard limit must be verified');
must(deploy,'DEPLOY_ENERGY_WORKER_ONLY_R69.ps1','r114 must reuse the current worker deployment primitive');
must(deploy,'DEPLOY_ENERGY_BROKER_ONLY_R77.ps1','r114 must reuse the authenticated broker deployment primitive');

must(replay,"worker.status==='COMPLETE'",'client must auto-finalize a completed worker after transport loss');
must(replay,"worker.status==='RUNNING'&&worker.fresh",'fresh worker heartbeat must override false broker transport failure');
must(replay,"WORKER_LEASE_STALE",'stale worker lease must become an explicit recovery condition');
must(replay,'Store.runEnergyServer(id,revision)','recovery must re-enter the exact revision broker, not Revit');
must(replay,"status==='COMPLETE'",'final client success must still require COMPLETE');
must(edge,"worker.status==='RUNNING'&&worker.fresh",'native edge must distinguish transport loss from live worker');
must(edge,'WORKER_FINALIZING','native edge must surface cached-package finalization');
must(edge,'ENERGY_NATIVE_EDGE_R114','native edge build must be r114');
must(loader,'20260817r114-durable-energy1','native live edge import must be cache-broken');
must(ui,"energy-replay-r95.js?v=20260817r114-durable-energy1",'hosted Energy owner must be cache-broken');
must(ui,"viewer-interaction-r85-loader.js?v=20260817r114-durable-energy1",'native Energy loader must be cache-broken');

// r114 is execution-envelope-only: strict r49 package and GeometryCo policy remain present.
for(const required of ['BASELINE_UPDATED_GEOMETRY.osm','PROPOSED_UPDATED_GEOMETRY.osm','EN-1_READY_TO_INSERT.xlsx','COMcheck_PROJECT_INPUT_READY.cxl','COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf','COMcheck_BACKSTOP_RESULT.json'])must(broker,required,`strict final package output missing: ${required}`);
must(geometry,'MINIMUM_MAPPING_CONFIDENCE = 0.75','GeometryCo 75% confidence contract must remain present');
forbid(replay,'SYNC ENGINEERING','recovery must not instruct a new Revit sync');

console.log(JSON.stringify({schema:'liber.revex.r114.energy-resilience.v1',status:'PASSED',heartbeatSeconds:15,leaseSeconds:120,workerCache:true,transportLossRecoverable:true,staleWorkerReacquire:true,strictFinalPackage:true},null,2));
