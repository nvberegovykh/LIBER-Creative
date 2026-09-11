'use strict';

// R2.5.2 logical-object preservation patch.
// Assimp can split one Unity renderer into multiple meshes when a source object
// uses multiple material slots. VRoid/XWear should still see that renderer as
// one logical child. This patch merges same-name reconstructed parts into one
// Mesh with multiple submeshes/material references, matching creator object
// boundaries instead of exposing material splits as independent accessories.
//
// Important binary-layout invariant: the official MeshInfo stream stores
// boneWeights count and bindPoses count before subMesh count. Static MeshFilter
// output writes both as zero. R2.5.1 accidentally omitted those two zero fields
// when adding multi-submesh support, shifting the stream so VRoid interpreted
// submesh data as skinning data and eventually hit EndOfStream in
// MeshInfoReader.ReadSubMeshIndices. R2.5.2 restores the exact field order.

const fs=require('fs');
const target=process.argv[2];
if(!target)throw new Error('Usage: node r25-logical-object-patch.cjs cleanroom-xwear.js');
let s=fs.readFileSync(target,'utf8');
function once(oldText,newText,label){const n=s.split(oldText).length-1;if(n!==1)throw new Error(`Patch ${label}: expected one match, found ${n}`);s=s.replace(oldText,newText)}

once(
"function meshBinary(m){const w=writer();w.i32(0);w.str(m.name);w.i32(m.vertices.length);w.i32(m.vertices.length);for(const v of m.vertices)w.vec3(v);w.i32(m.normals.length);for(const v of m.normals)w.vec3(v);w.i32(m.tangents.length);for(const v of m.tangents)w.vec4(v);w.i32(m.colors.length);for(const v of m.colors)w.vec4(v);for(let c=0;c<4;c++){const uv=m.uvs[c]||[];w.i32(uv.length);for(const v of uv)w.vec2(v)}w.i32(0);w.i32(0);w.i32(1);w.i32(0);w.i32(m.indices.length);for(const n of m.indices)w.i32(n);w.i32(0);w.i32(0);return w.done()}",
"function meshBinary(m){const w=writer();w.i32(0);w.str(m.name);w.i32(m.vertices.length);w.i32(m.vertices.length);for(const v of m.vertices)w.vec3(v);w.i32(m.normals.length);for(const v of m.normals)w.vec3(v);w.i32(m.tangents.length);for(const v of m.tangents)w.vec4(v);w.i32(m.colors.length);for(const v of m.colors)w.vec4(v);for(let c=0;c<4;c++){const uv=m.uvs[c]||[];w.i32(uv.length);for(const v of uv)w.vec2(v)}w.i32(0);w.i32(0);const subs=m.submeshes?.length?m.submeshes:[m.indices||[]];w.i32(subs.length);for(const inds of subs){w.i32(0);w.i32(inds.length);for(const n of inds)w.i32(n)}w.i32(0);w.i32(0);return w.done()}\nfunction mergeLogicalMeshes(parts){const groups=new Map();for(const p of parts){const key=(p.side||'')+'|'+p.name;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p)}const out=[];for(const ps of groups.values()){if(ps.length===1){const p=ps[0];out.push({...p,submeshes:[p.indices||[]],materialIndices:[p.materialIndex]});continue}const vertices=[],submeshes=[],materialIndices=[];let base=0;for(const p of ps){vertices.push(...p.vertices);submeshes.push((p.indices||[]).map(i=>i+base));materialIndices.push(p.materialIndex);base+=p.vertices.length}function attr(get){if(!ps.every(p=>{const a=get(p)||[];return !a.length||a.length===p.vertices.length}))return[];if(!ps.some(p=>(get(p)||[]).length))return[];const a=[];for(const p of ps){const x=get(p)||[];if(x.length)a.push(...x);else return[]}return a}const uvs=[0,1,2,3].map(c=>attr(p=>(p.uvs||[])[c]));const merged={...ps[0],vertices,normals:attr(p=>p.normals),tangents:attr(p=>p.tangents),colors:attr(p=>p.colors),uvs,indices:submeshes.flat(),submeshes,materialIndices,materialIndex:materialIndices[0],mergedParts:ps.length,skinned:ps.some(p=>p.skinned),boneCount:Math.max(...ps.map(p=>p.boneCount||0))};out.push(merged);log('[+] Logical object merge '+merged.name+': '+ps.length+' material-split meshes -> 1 object / '+submeshes.length+' submeshes')}return out}",
'multi-submesh mesh writer');

once(
"function buildXwear(baseName,variant,sourceMeshes,scene,unityMats,author){const fit=fittedMeshes(sourceMeshes,variant),meshes=fit.meshes,used=[...new Set(meshes.map(m=>m.materialIndex))],matByIndex=new Map(),materials=[];",
"function buildXwear(baseName,variant,sourceMeshes,scene,unityMats,author){const fit=fittedMeshes(sourceMeshes,variant),rawMeshes=fit.meshes,meshes=mergeLogicalMeshes(rawMeshes),used=[...new Set(meshes.flatMap(m=>m.materialIndices?.length?m.materialIndices:[m.materialIndex]))],matByIndex=new Map(),materials=[];",
'logical merge before export');

once(
"RefMaterialGuids:[matByIndex.get(mesh.materialIndex)]",
"RefMaterialGuids:(mesh.materialIndices?.length?mesh.materialIndices:[mesh.materialIndex]).map(i=>matByIndex.get(i))",
'material references per submesh');

once(
"return{zip,meshCount:meshes.length,materialCount:materials.length,sourceAnchor:fit.sourceAnchor,defaultAnchor:fit.defaultAnchor,bounds:boundsOf(meshes)}}",
"return{zip,meshCount:meshes.length,rawMeshCount:rawMeshes.length,materialCount:materials.length,sourceAnchor:fit.sourceAnchor,defaultAnchor:fit.defaultAnchor,bounds:boundsOf(meshes)}}",
'logical mesh count metadata');

// Logging shape changed across calibration revisions, so this is deliberately
// optional: functionality must not depend on a cosmetic log-string match.
const logRe=/outputs\.push\(\{name:fn,sha256:sha256\(r\.zip\),bytes:r\.zip\.length,meshCount:r\.meshCount,materialCount:r\.materialCount\}\);log\(`\[\+\] \$\{fn\}: [^`]+`\)/;
if(logRe.test(s))s=s.replace(logRe,"outputs.push({name:fn,sha256:sha256(r.zip),bytes:r.zip.length,meshCount:r.meshCount,rawMeshCount:r.rawMeshCount,materialCount:r.materialCount});log(`[+] ${fn}: logicalObjects=${r.meshCount} rawMeshes=${r.rawMeshCount} ${r.zip.length} bytes`)");
else console.log('[i] R2.5.2: converter log signature differs; skipping cosmetic output-log rewrite');

// Add object-level diagnostics to preview without changing the preview renderer's
// raw-part representation. This lets validation distinguish genuinely detached
// creator objects from harmless material submesh splits.
once(
"const preview={schema:2,units:'meters'",
"const logicalDiagnostics=mergeLogicalMeshes(meshes).map(m=>({name:m.name,side:m.side,mergedParts:m.mergedParts||1,materialIndices:m.materialIndices,bounds:boundsOf([m])}));const preview={schema:3,logicalObjects:logicalDiagnostics,units:'meters'",
'preview logical diagnostics');

fs.writeFileSync(target,s);
console.log('[+] R2.5.2 logical-object/material-split preservation patch applied');
