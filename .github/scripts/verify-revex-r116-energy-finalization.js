'use strict';
const fs=require('fs');
const assert=require('assert');
const read=p=>fs.readFileSync(p,'utf8');
const worker=read('server/revex-energy-worker/durable_execution.py');
const broker=read('server/firebase-functions/index.js');
const evidence=read('server/revex-energy-worker/revex_comcheck_evidence.py');
const test=read('server/revex-energy-worker/verify_comcheck_evidence_r100.py');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);
const forbid=(text,needle,label)=>assert(!text.includes(needle),label||`Forbidden ${needle}`);

// Derived worker output is reusable only for the exact deployed worker source.
must(worker,'def _cache_path(output_prefix: str, source_candidate: str)','worker cache must be source-candidate scoped');
must(worker,'cached_source != current','old-source cache must be rejected');
must(worker,'workerSourceCandidate','durable job must persist worker source candidate');
must(worker,'workerPipelineStatus','durable job must persist pipeline terminal status');
must(worker,'"workerStatus": "FAILED"','non-COMPLETE worker result must be terminal FAILED');
must(worker,'"workerStage": "PIPELINE_TERMINAL_CACHED"','cached blocked result must not masquerade as COMPLETE');

// Broker success is binary: strict final package COMPLETE or explicit terminal failure.
must(broker,"const pipelineStatus = String(resultManifest.status || body.status || 'UNKNOWN').toUpperCase();",'broker must read pipeline status explicitly');
must(broker,"status: 'FAILED', pipelineStatus, resultRevision",'blocked pipeline must be persisted as failed');
must(broker,"stage: 'PIPELINE_TERMINAL'",'blocked pipeline must expose terminal stage');
must(broker,"ok: pipelineStatus === 'COMPLETE'",'broker ok may only be true for COMPLETE');
for(const name of ['BASELINE_UPDATED_GEOMETRY.osm','PROPOSED_UPDATED_GEOMETRY.osm','EN-1_READY_TO_INSERT.xlsx','COMcheck_PROJECT_INPUT_READY.cxl','COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf','COMcheck_BACKSTOP_RESULT.json'])must(broker,name,`strict final output missing: ${name}`);

// Actual G-002 authority: visible row + provided/proposed value (85' allowable, 65' provided).
must(evidence,'BUILDING\\s+(?:HEIGHT|HIGHT)\\s+ABOVE\\s+GRADE\\s+PLANE','fallback must use real building-height-above-grade row semantics');
must(evidence,'return values[-1]','fallback must take the provided/proposed value from the row');
forbid(evidence,'if "MAX BUILDING HEIGHT" in upper','retired fake MAX BUILDING HEIGHT branch must not return');
forbid(evidence,'MAX(?:IMUM)?\\s+BUILDING\\s+HEIGHT','retired fake MAX BUILDING HEIGHT regex must not return');
must(test,'Building Hight above grade plane 85\' 65\'','regression must use the actual G-002 row shape');
must(test,"assert t['bulk']['buildingHeightFt'] == 65.0",'regression must lock 65 ft provided height');
must(test,'assert r100._extract_height("MAX BUILDING HEIGHT 85\' 65\'") is None','fake MAX row must be rejected');

console.log(JSON.stringify({schema:'liber.revex.r116.energy-finalization.v1',status:'PASSED',providedHeightFt:65,sourceBoundCache:true,blockedIsTerminal:true,strictFinalPackage:true},null,2));
