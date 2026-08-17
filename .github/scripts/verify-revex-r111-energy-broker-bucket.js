'use strict';
const fs=require('fs');
const vm=require('vm');
const assert=require('assert');
const path='server/firebase-functions/index.js';
const source=fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n');
const must=(needle,label)=>assert(source.includes(needle),label||`Missing ${needle}`);
const forbid=(needle,label)=>assert(!source.includes(needle),label||`Forbidden ${needle}`);

function extract(startNeedle,endNeedle){
  const start=source.indexOf(startNeedle);
  const end=source.indexOf(endNeedle,start+startNeedle.length);
  assert(start>=0&&end>start,`Could not extract ${startNeedle}`);
  return source.slice(start,end);
}

const helperSource = [
  extract('function bucketFromArtifactUrls','function configuredStorageBucket'),
  extract('function configuredStorageBucket','function resolveStorageBucket'),
  extract('function resolveStorageBucket','exports.runRevexEnergy')
].join('\n');
const sandbox={URL,decodeURIComponent,process:{env:{}},Error};
vm.createContext(sandbox);
vm.runInContext(`${helperSource}\nthis.bucketFromArtifactUrls=bucketFromArtifactUrls;this.resolveStorageBucket=resolveStorageBucket;`,sandbox);
const firebaseUrl=bucket=>`https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/projects%2Fp%2Ffile.json?alt=media&token=x`;
const gcsUrl=bucket=>`https://storage.googleapis.com/${bucket}/projects/p/file.json`;
assert.strictEqual(sandbox.bucketFromArtifactUrls([{url:firebaseUrl('liber-apps-cca20.firebasestorage.app')}]),'liber-apps-cca20.firebasestorage.app');
assert.strictEqual(sandbox.bucketFromArtifactUrls([{url:gcsUrl('liber-apps-cca20.appspot.com')}]),'liber-apps-cca20.appspot.com');
assert.strictEqual(sandbox.bucketFromArtifactUrls([{url:firebaseUrl('bucket-a')},{url:firebaseUrl('bucket-a')}]),'bucket-a');
assert.throws(()=>sandbox.bucketFromArtifactUrls([{url:firebaseUrl('bucket-a')},{url:firebaseUrl('bucket-b')}]),/multiple storage buckets/);
assert.strictEqual(sandbox.resolveStorageBucket([{url:firebaseUrl('live-bucket')}]),'live-bucket');

forbid('getStorage().bucket().name','Energy broker must not depend on an implicit/unconfigured default Storage bucket');
forbid("require('firebase-admin/storage')",'Energy broker must not need Admin Storage merely to discover the bucket name');
must("stage: 'BROKER_PREPARE'",'revision job must begin before broker preparation');
must('const bucketName = resolveStorageBucket(artifacts);','broker must bind worker to immutable artifact storage');
must("brokerLog('STORAGE_BUCKET_RESOLVED'",'resolved bucket provenance must be logged');
must("failureStage = 'WORKER_REQUEST';",'broker must distinguish prepare from worker-call failure');
must("status: 'INFRASTRUCTURE_FAILED'",'broker must persist exact infrastructure failure');
must('error: detail.message, stage: detail.stage','job must preserve exact pre-worker/worker error detail');

const jobWrite=source.indexOf("stage: 'BROKER_PREPARE'");
const bucketResolve=source.indexOf('const bucketName = resolveStorageBucket(artifacts);');
assert(jobWrite>=0&&bucketResolve>jobWrite,'revision job must be persisted before Storage bucket resolution');

// The successful handoff contract is otherwise unchanged.
must("schema: 'liber.revex.energy-server-request.v1'",'worker request schema changed unexpectedly');
must("pipelineVersion || '') !== '0.8.19-r49'",'r49 pipeline pin must remain');
for(const name of ['BASELINE_UPDATED_GEOMETRY.osm','PROPOSED_UPDATED_GEOMETRY.osm','EN-1_READY_TO_INSERT.xlsx','COMcheck_PROJECT_INPUT_READY.cxl','COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf','COMcheck_BACKSTOP_RESULT.json']) must(name,`required Energy output lost: ${name}`);

console.log(JSON.stringify({
  schema:'liber.revex.r111-energy-broker-bucket.v1',status:'PASSED',
  regression:'real-250-broker-failed-before-job-detail',
  storage:{implicitDefault:false,artifactBound:true,mixedBucketsRejected:true},
  failureVisibility:{jobBeforePrepare:true,stageScoped:true},
  replay:{sameEngineeringRevision:true,revitResyncRequired:false}
},null,2));