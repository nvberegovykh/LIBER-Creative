'use strict';
const crypto=require('node:crypto');
const {parseJsonBytes}=require('./affected-plan-evidence');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
function fail(message){throw Object.assign(new Error(message),{code:'failed-precondition'});}
function relativePath(value){const p=String(value||'').replace(/\\/g,'/');if(!p||/[\u0000-\u001f\u007f:*?"<>|]/.test(p)||/%(?:2e|2f|5c)/i.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..'))fail('The immutable package has an invalid file path.');return p;}
function revisionIdentity(projectId, row) {
 const legacy = row.projectId === undefined && row.integrity?.schema === 'liber.revex.integrity.v1' &&
   row.integrity.revision === row.revision && row.integrity.central?.projectId === projectId;
 if ((!legacy && row.projectId !== projectId) || !/^rev_[a-zA-Z0-9_-]+$/.test(row.revision || '') || row.recordId !== `revex_revision_${row.revision}`)
   fail('A revision record does not match its immutable identity.');
 // Early exporters bound identity inside the integrity manifest. Normalize only
 // in memory; packageFor still verifies stored manifest bytes and file hashes,
 // and a legacy revision without a receipt cannot become a completed report.
 return {...row, projectId, identitySource: legacy ? 'integrity.central' : 'projectId'};
}
function createPublicationSource({db,readBytes}){
 async function list(projectId,kind){const rows=[];let last;do{let q=db.collection(`projects/${projectId}/library`).where('revexKind','==',kind).orderBy('__name__').limit(500);if(last)q=q.startAfter(last);const s=await q.get();rows.push(...s.docs.map(d=>({...d.data(),recordId:d.id})));if(s.docs.length<500)break;last=s.docs.at(-1);if(rows.length>=20000)fail(`The project exceeds the report reader's 20,000 ${kind} record limit. No partial report was published.`);}while(true);return rows;}
 async function revisions(projectId){const [cores,receipts]=await Promise.all([list(projectId,'revision'),list(projectId,'publication-receipt')]);const byReceipt=new Map();for(const r of receipts){if(r.schema!=='liber.revex.publication-receipt.v1'||r.projectId!==projectId||!r.revision||!/^[a-f0-9]{64}$/i.test(r.packageSha256)||!Number.isFinite(Date.parse(r.completedAt)))fail('A publication receipt is invalid. Restore the matching completed package before retrying.');if(byReceipt.has(r.revision))fail('A revision has conflicting completion receipts.');byReceipt.set(r.revision,r);}const all=cores.map(row=>{const r=revisionIdentity(projectId,row);return {...r,id:r.revision,receipt:byReceipt.get(r.revision)||null};}).sort((a,b)=>String(a.syncedAt||a.createdAt).localeCompare(String(b.syncedAt||b.createdAt))||a.id.localeCompare(b.id));for(const r of receipts)if(!all.some(c=>c.id===r.revision))fail('A completion receipt has no matching immutable model revision.');return all;}
 async function packageFor(projectId,revision,requireReceipt=true){const prefix=`projects/${projectId}/library/revex/revisions/${revision.id}/`,bytes=await readBytes(prefix+'integrity.json');if(requireReceipt&&(!revision.receipt||sha(bytes)!==String(revision.receipt.packageSha256).toLowerCase()))fail(`Revision ${revision.id} has no matching verified publication receipt. Finish or retry its package synchronization.`);let manifest;try{manifest=parseJsonBytes(bytes);}catch{fail('The immutable integrity manifest is malformed.');}if(JSON.stringify(canonical(manifest))!==JSON.stringify(canonical(revision.integrity)))fail('The stored manifest differs from the immutable revision record.');if(!Array.isArray(manifest.files)||!manifest.files.length)fail('The immutable manifest has no file entries.');const entries=new Map();for(const row of manifest.files){const name=relativePath(row.name),key=name.toLowerCase();if(entries.has(key)||!/^[a-f0-9]{64}$/i.test(row.sha256)||!Number.isSafeInteger(row.bytes)||row.bytes<0)fail('The immutable manifest has duplicate or invalid file entries.');entries.set(key,{...row,name});}
  function resolve(name){const p=relativePath(name),exact=entries.get(p.toLowerCase());if(exact)return exact;const matches=[...entries.values()].filter(e=>e.name.split('/').at(-1).toLowerCase()===p.toLowerCase());if(matches.length!==1)fail(`The package cannot uniquely resolve ${p}.`);return matches[0];}
  async function read(name){const entry=resolve(name);if(entry.bytes>256*1024*1024)fail(`${entry.name} exceeds the report reader's 256 MB per-file limit.`);const data=await readBytes(prefix+entry.name);if(data.length!==entry.bytes||sha(data)!==entry.sha256.toLowerCase())fail(`The immutable bytes for ${entry.name} failed their integrity check.`);return data;}
  return {read,json:async name=>parseJsonBytes(await read(name)),resolve,prefix,manifest,packageSha256:sha(bytes)};
 }
 return {list,revisions,packageFor};
}
module.exports={createPublicationSource,relativePath,sha,revisionIdentity};
