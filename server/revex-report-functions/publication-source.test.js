'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {revisionIdentity,createPublicationSource,sha}=require('./publication-source');
const projectId='projectA',revision='rev_20260810T082353323Z';
const legacy=()=>({recordId:`revex_revision_${revision}`,revision,integrity:{schema:'liber.revex.integrity.v1',revision,central:{projectId}}});
test('Legacy exporter identity is accepted from its bound manifest without modifying the record',()=>{const row=legacy(),result=revisionIdentity(projectId,row);assert.equal(result.projectId,projectId);assert.equal(result.identitySource,'integrity.central');assert.equal(row.projectId,undefined);assert.equal(result.receipt,undefined);});
test('Explicit conflicting project, absent binding, wrong revision and wrong document id fail closed',()=>{
 for(const patch of [{projectId:'other'},{projectId:null},{recordId:'other'},{revision:'../wrong'},{integrity:{}},{integrity:{...legacy().integrity,revision:'rev_other'}},{integrity:{...legacy().integrity,central:{projectId:'other'}}}])assert.throws(()=>revisionIdentity(projectId,{...legacy(),...patch}),/immutable identity/);
});
test('A legacy predecessor still requires exact stored manifest and file bytes, and cannot supply a completed report without a receipt',async()=>{
 const data=Buffer.from('{"elements":[]}'),row=legacy();row.id=revision;row.integrity.files=[{name:'viewer-model.json',bytes:data.length,sha256:sha(data)}];
 let manifest=Buffer.from(JSON.stringify(row.integrity)),content=data;
 const source=createPublicationSource({readBytes:async name=>name.endsWith('integrity.json')?manifest:content});
 await assert.rejects(source.packageFor(projectId,row),/publication receipt/);
 const pkg=await source.packageFor(projectId,row,false);assert.deepEqual(await pkg.json('viewer-model.json'),{elements:[]});
 content=Buffer.from('{"elements":[1]}');await assert.rejects(pkg.json('viewer-model.json'),/integrity check/);
 manifest=Buffer.from(JSON.stringify({...row.integrity,central:{projectId:'other'}}));await assert.rejects(source.packageFor(projectId,row,false),/stored manifest differs/);
});
