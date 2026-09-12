const fs = require('fs');

const file = process.argv[2];
if (!file) throw new Error('Usage: node r26-adaptive-patch.cjs <cleanroom-xwear.js>');
let s = fs.readFileSync(file, 'utf8');

function mustReplace(oldText, newText, label) {
  if (!s.includes(oldText)) throw new Error('R2.6 patch anchor missing: ' + label);
  s = s.replace(oldText, newText);
}
function replaceSpan(start, end, replacement, label) {
  const a = s.indexOf(start);
  if (a < 0) throw new Error('R2.6 start anchor missing: ' + label);
  const b = s.indexOf(end, a + start.length);
  if (b < 0) throw new Error('R2.6 end anchor missing: ' + label);
  s = s.slice(0, a) + replacement.trimEnd() + '\n' + s.slice(b);
}
function insertBefore(anchor, text, label) {
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error('R2.6 insert anchor missing: ' + label);
  s = s.slice(0, i) + text.trimEnd() + '\n' + s.slice(i);
}

// Preserve creator hierarchy and the source VRC PhysBone values while reading the chosen prefab.
mustReplace(
  "const docs=t.split(/^--- !u!/m).slice(1),goNames=new Map(),transformDocs=new Map(),goToTransform=new Map(),rendererByGo=new Map();",
  "const docs=t.split(/^--- !u!/m).slice(1),goNames=new Map(),transformDocs=new Map(),goToTransform=new Map(),rendererByGo=new Map(),monoDocs=[];",
  'prefab mono declaration'
);
mustReplace(
  "} else if(typ===33 || typ===137){",
  "} else if(typ===114){monoDocs.push(d)} else if(typ===33 || typ===137){",
  'prefab MonoBehaviour capture'
);
insertBefore(
  "  if(Object.keys(transforms).length<2)return null;",
  `  const nodes={};
  for(const [fid,tr] of transformDocs){
    const name=goNames.get(tr.go);if(!name)continue;
    const parentTr=transformDocs.get(tr.father),parentName=parentTr?goNames.get(parentTr.go)||null:null,w=worldFor(fid);
    nodes[name]={transformFileId:fid,parentName,worldPosition:[w[3],w[7],w[11]]};
  }
  function monoNum(d,names,def){for(const n of names){const m=d.match(new RegExp('(?:^|\\n)\\s*'+n+':\\s*([-+0-9.eE]+)','m'));if(m){const v=Number(m[1]);if(Number.isFinite(v))return v}}return def}
  function monoVec(d,names,def){for(const n of names){const m=d.match(new RegExp('(?:^|\\n)\\s*'+n+':\\s*\\{x:\\s*([-+0-9.eE]+),\\s*y:\\s*([-+0-9.eE]+),\\s*z:\\s*([-+0-9.eE]+)\\}','m'));if(m)return m.slice(1).map(Number)}return def}
  const physBones=[];
  for(const d of monoDocs){
    if(!/(?:^|\\n)\\s*(?:pull|m_Pull):/m.test(d)||!/(?:^|\\n)\\s*(?:stiffness|m_Stiffness):/m.test(d)||!/(?:^|\\n)\\s*(?:spring|m_Spring):/m.test(d))continue;
    const go=+(d.match(/m_GameObject: \\{fileID: (-?\\d+)\\}/)||[])[1]||0,ownerName=goNames.get(go)||'';
    const rm=d.match(/(?:rootTransform|m_RootTransform): \\{fileID: (-?\\d+)\\}/),rootFid=rm?(+rm[1]||0):0,effectiveFid=rootFid||goToTransform.get(go)||0,rt=transformDocs.get(effectiveFid),rootName=rt?goNames.get(rt.go)||ownerName:ownerName;
    physBones.push({ownerName,rootName,pull:monoNum(d,['pull','m_Pull'],0),stiffness:monoNum(d,['stiffness','m_Stiffness'],0.2),spring:monoNum(d,['spring','m_Spring'],0.5),gravity:monoNum(d,['gravity','m_Gravity'],0),gravityFalloff:monoNum(d,['gravityFalloff','gravityFallOff','m_GravityFalloff'],0),immobile:monoNum(d,['immobile','m_Immobile'],0),radius:monoNum(d,['radius','m_Radius'],0),gravityDir:monoVec(d,['gravityDir','gravityDirection','m_GravityDir'],[0,-1,0])});
  }`,
  'prefab nodes and PhysBones'
);
mustReplace(
  "return {pathname:asset.pathname,transforms,count:Object.keys(transforms).length,worldByName,worldByTransform:Object.fromEntries([...worldByTransform].map(([k,v])=>[String(k),v])),goNames:Object.fromEntries(goNames)};",
  "return {pathname:asset.pathname,transforms,count:Object.keys(transforms).length,worldByName,worldByTransform:Object.fromEntries([...worldByTransform].map(([k,v])=>[String(k),v])),goNames:Object.fromEntries(goNames),nodes,physBones};",
  'prefab enriched return'
);

replaceSpan(
  'function weightedSkin(',
  'function prefabTransformFor',
  `function weightedSkin(part,prefab,unit){
  const bones=part.bones||[];if(!bones.length||!prefab?.worldByName)return null;
  const n=part.rawVertices.length,acc=Array.from({length:n},()=>[0,0,0,0]),nacc=Array.from({length:n},()=>[0,0,0,0]),rawWeights=Array.from({length:n},()=>[]),boneNames=[];let usable=0;
  for(const b of bones){
    const bw=prefab.worldByName[b.name],off=meterMatrix(b.offsetmatrix,unit);if(!bw||!Array.isArray(b.weights))continue;
    const outBone=boneNames.length;boneNames.push(b.name);usable++;const skin=mul4(bw,off);
    for(const wt of b.weights){if(!Array.isArray(wt)||wt.length<2)continue;const vi=wt[0]|0,w=+wt[1]||0;if(vi<0||vi>=n||w<=0)continue;rawWeights[vi].push([outBone,w]);const rv=part.rawVertices[vi].map(x=>x*unit),pv=point(skin,rv);acc[vi][0]+=pv[0]*w;acc[vi][1]+=pv[1]*w;acc[vi][2]+=pv[2]*w;acc[vi][3]+=w;if(part.rawNormals[vi]){const nv=vec(skin,part.rawNormals[vi]);nacc[vi][0]+=nv[0]*w;nacc[vi][1]+=nv[1]*w;nacc[vi][2]+=nv[2]*w;nacc[vi][3]+=w}}
  }
  if(!usable)return null;
  const verts=acc.map((a,i)=>a[3]>.00001?[a[0]/a[3],a[1]/a[3],a[2]/a[3]]:part.rawVertices[i].map(x=>x*unit));
  const normals=nacc.map((a,i)=>{if(a[3]>.00001){const q=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/q,a[1]/q,a[2]/q]}return part.rawNormals[i]||[0,1,0]});
  const weights=rawWeights.map(list=>{const a=list.sort((x,y)=>y[1]-x[1]).slice(0,4);if(!a.length)return[[0,1]];const q=a.reduce((z,x)=>z+x[1],0)||1;return a.map(x=>[x[0],x[1]/q])});
  return{verts,normals,boneCount:boneNames.length,boneNames,weights};
}
`,
  'weighted skin with weights'
);

insertBefore(
  'function reconstructMeshes(scene,prefab){',
  `function rawGroupCenter(parts,unit){const vs=[];for(const p of parts)for(const v of p.rawVertices||[])vs.push(point(p.world,v).map(x=>x*unit));return vs.length?boundsOf([{vertices:vs}]).center:null}
function assignPrefabRenderers(groups,prefab,unit){
  const result=new Map();if(!prefab?.transforms)return result;
  const entries=Object.entries(prefab.transforms),used=new Set(),infos=[...groups].map(([name,parts])=>({name,parts,kind:parts.some(p=>p.bones?.length)?'skinned':'mesh',side:sideOf(name),center:rawGroupCenter(parts,unit)}));
  for(const pass of['skinned','mesh'])for(const info of infos.filter(x=>x.kind===pass)){
    let cand=entries.filter(([name,tr])=>tr?.kind===pass&&!used.has(name)&&(!info.side||!sideOf(name)||sideOf(name)===info.side));if(!cand.length)continue;
    let pick=cand.find(([name])=>name===info.name)||null;
    if(!pick){const n=info.name.toLowerCase(),related=cand.filter(([name])=>{const x=name.toLowerCase();return n===x||n.startsWith(x+'_')||n.startsWith(x+'.')||x.startsWith(n+'_')||x.startsWith(n+'.')});if(related.length===1)pick=related[0]}
    if(!pick&&cand.length===1)pick=cand[0];
    if(!pick&&info.center){cand=cand.map(x=>[...x,Math.hypot(x[1].pos[0]-info.center[0],x[1].pos[1]-info.center[1],x[1].pos[2]-info.center[2])]).sort((a,b)=>a[2]-b[2]);pick=cand[0]}
    if(pick){used.add(pick[0]);result.set(info.name,{name:pick[0],tr:pick[1],distance:pick[2]??null});if(pick[0]!==info.name)log('[+] Renderer map '+info.name+' ('+pass+') -> '+pick[0]+' ('+pass+')'+(Number.isFinite(pick[2])?' d='+pick[2].toFixed(5):''))}
  }
  return result;
}
`,
  'renderer assignment'
);

mustReplace(
  "const raw=extractRawMeshes(scene);if(!raw.length)die('FBX import produced no mesh objects');const groups=new Map();for(const m of raw){if(!groups.has(m.name))groups.set(m.name,[]);groups.get(m.name).push(m)}const havePrefab=!!prefab,unit=havePrefab?.01:1,out=[];let skinnedParts=0,fallbackParts=0,calibratedSkinGroups=0;",
  "const raw=extractRawMeshes(scene);if(!raw.length)die('FBX import produced no mesh objects');const groups=new Map();for(const m of raw){if(!groups.has(m.name))groups.set(m.name,[]);groups.get(m.name).push(m)}const havePrefab=!!prefab,unit=havePrefab?.01:1,assignments=assignPrefabRenderers(groups,prefab,havePrefab?.01:1),out=[];let skinnedParts=0,fallbackParts=0,calibratedSkinGroups=0;",
  'reconstruct renderer assignments'
);
mustReplace(
  "for(const[name,parts]of groups){const tr=prefabTransformFor(name,prefab,parts);",
  "for(const[name,parts]of groups){const assigned=assignments.get(name),tr=assigned?.tr||prefabTransformFor(name,prefab,parts),logicalName=assigned?.name||name;",
  'reconstruct logical renderer name'
);
mustReplace(
  "out.push({name:p.name,side:p.side,",
  "out.push({name:logicalName,sourceName:p.name,side:sideOf(logicalName)||p.side,",
  'logical output name'
);
mustReplace(
  "skinned:!!x.skinInfo,boneCount:x.skinInfo?.boneCount||0})",
  "skinned:!!x.skinInfo,boneCount:x.skinInfo?.boneCount||0,boneNames:x.skinInfo?.boneNames||[],weights:x.skinInfo?.weights||[]})",
  'preserve skin data'
);

replaceSpan(
  'function meshBinary(',
  'function mergeLogicalMeshes',
  `function meshBinary(m){
  const w=writer();w.i32(0);w.str(m.name);w.i32(m.vertices.length);w.i32(m.vertices.length);for(const v of m.vertices)w.vec3(v);w.i32(m.normals.length);for(const v of m.normals)w.vec3(v);w.i32(m.tangents.length);for(const v of m.tangents)w.vec4(v);w.i32(m.colors.length);for(const v of m.colors)w.vec4(v);for(let c=0;c<4;c++){const uv=m.uvs[c]||[];w.i32(uv.length);for(const v of uv)w.vec2(v)}
  const weights=(m.weights||[]).length===m.vertices.length?m.weights:[];w.i32(weights.length);for(const list of weights){const a=(list||[]).slice(0,4),ww=[0,0,0,0],ii=[0,0,0,0];for(let k=0;k<a.length;k++){ii[k]=a[k][0]|0;ww[k]=+a[k][1]||0}for(const x of ww)w.f32(x);for(const x of ii)w.i32(x)}
  const bindposes=m.bindposes||[];w.i32(bindposes.length);for(const mat of bindposes)for(let i=0;i<16;i++)w.f32(mat?.[i]??(i%5===0?1:0));
  const subs=m.submeshes?.length?m.submeshes:[m.indices||[]];w.i32(subs.length);for(const inds of subs){w.i32(0);w.i32(inds.length);for(const n of inds)w.i32(n)}w.i32(0);w.i32(0);return w.done();
}
`,
  'mesh binary skin fields'
);

replaceSpan(
  'function mergeLogicalMeshes(',
  'const T=',
  `function mergeLogicalMeshes(parts){
  const groups=new Map();for(const p of parts){const key=(p.side||'')+'|'+p.name;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p)}const out=[];
  for(const ps of groups.values()){
    const unionBones=[],boneMap=new Map();for(const p of ps)for(const b of p.boneNames||[])if(!boneMap.has(b)){boneMap.set(b,unionBones.length);unionBones.push(b)}
    const remapPartWeights=p=>{const local=p.boneNames||[],ww=p.weights||[];return p.vertices.map((_,i)=>{const src=ww[i]||[];if(!src.length)return unionBones.length?[[0,1]]:[];const a=src.map(x=>[boneMap.get(local[x[0]])??0,x[1]]).sort((a,b)=>b[1]-a[1]).slice(0,4),q=a.reduce((z,x)=>z+x[1],0)||1;return a.map(x=>[x[0],x[1]/q])})};
    if(ps.length===1){const p=ps[0];out.push({...p,submeshes:[p.indices||[]],materialIndices:[p.materialIndex],boneNames:unionBones,weights:remapPartWeights(p),boneCount:unionBones.length,skinned:unionBones.length>0});continue}
    const vertices=[],submeshes=[],materialIndices=[],weights=[];let base=0;for(const p of ps){vertices.push(...p.vertices);submeshes.push((p.indices||[]).map(i=>i+base));materialIndices.push(p.materialIndex);weights.push(...remapPartWeights(p));base+=p.vertices.length}
    function attr(get){if(!ps.every(p=>{const a=get(p)||[];return !a.length||a.length===p.vertices.length}))return[];if(!ps.some(p=>(get(p)||[]).length))return[];const a=[];for(const p of ps){const x=get(p)||[];if(x.length)a.push(...x);else return[]}return a}
    const uvs=[0,1,2,3].map(c=>attr(p=>(p.uvs||[])[c]));const merged={...ps[0],vertices,normals:attr(p=>p.normals),tangents:attr(p=>p.tangents),colors:attr(p=>p.colors),uvs,indices:submeshes.flat(),submeshes,materialIndices,materialIndex:materialIndices[0],mergedParts:ps.length,skinned:unionBones.length>0,boneCount:unionBones.length,boneNames:unionBones,weights};out.push(merged);log('[+] Logical object merge '+merged.name+': '+ps.length+' material-split meshes -> 1 object / '+submeshes.length+' submeshes')
  }
  return out;
}
`,
  'logical skin merge'
);

mustReplace(
  "const T={meshFilter:'XWear.IO.Runtime.Components.Meshes.XResourceMeshFilter, XWear.IO.Runtime',accessory:'XWear.IO.Runtime.Components.AccessoryRoot.XResourceAccessoryRoot, XWear.IO.Runtime',color:'XWear.IO.Runtime.Materials.Shader.ShaderColorProperty, XWear.IO.Runtime',float:'XWear.IO.Runtime.Materials.Shader.ShaderFloatProperty, XWear.IO.Runtime'};",
  "const T={meshFilter:'XWear.IO.Runtime.Components.Meshes.XResourceMeshFilter, XWear.IO.Runtime',skinned:'XWear.IO.Runtime.Components.Meshes.XResourceSkinnedMeshRenderer, XWear.IO.Runtime',accessory:'XWear.IO.Runtime.Components.AccessoryRoot.XResourceAccessoryRoot, XWear.IO.Runtime',anything:'XWear.IO.Runtime.Components.Anything.XResourceAnythingJson, XWear.IO.Runtime',color:'XWear.IO.Runtime.Materials.Shader.ShaderColorProperty, XWear.IO.Runtime',float:'XWear.IO.Runtime.Materials.Shader.ShaderFloatProperty, XWear.IO.Runtime'};",
  'component type names'
);
replaceSpan(
  'function xform(',
  'function materialJson',
  `function xform(pos=[0,0,0],rot=[0,0,0,1],scale=[1,1,1]){return{Name:'',Position:{x:pos[0],y:pos[1],z:pos[2]},Rotation:{x:rot[0],y:rot[1],z:rot[2],w:rot[3]},Scale:{x:scale[0],y:scale[1],z:scale[2]},LocalPosition:{x:pos[0],y:pos[1],z:pos[2]},LocalRotation:{x:rot[0],y:rot[1],z:rot[2],w:rot[3]},LocalScale:{x:scale[0],y:scale[1],z:scale[2]},Index:0}}
`,
  'world-aware XWear transform'
);

replaceSpan(
  'function fittedMeshes(',
  'function buildXwear',
  `function fitPoint(p,srcAnchor,dst){let u=p.map((x,i)=>x-srcAnchor[i]);u=u.map(x=>x*requestedScale);u=eulerXYZdeg(fitRotDeg,u);return u.map((x,i)=>x+dst[i]+fitOffset[i])}
function fittedMeshes(meshes,variant){const srcAnchor=variantSourceAnchor(meshes),dst=DEFAULT_ANCHORS[variant]||DEFAULT_ANCHORS.Pair,pivot=dst.map((x,i)=>x+fitOffset[i]);return{sourceAnchor:srcAnchor,defaultAnchor:dst,pivot,meshes:meshes.map(m=>({...m,vertices:m.vertices.map(v=>fitPoint(v,srcAnchor,dst)),normals:m.normals.map(v=>eulerXYZdeg(fitRotDeg,v))}))}}
function transMat(v){return[1,0,0,v[0],0,1,0,v[1],0,0,1,v[2],0,0,0,1]}
function variantAllowsBone(name,variant){const sd=sideOf(name);return variant==='Pair'||!sd||(variant==='Left'&&sd==='L')||(variant==='Right'&&sd==='R')}
function buildSpringChains(prefab,variant){
  const pbs=(prefab?.physBones||[]).filter(pb=>pb.rootName&&variantAllowsBone(pb.rootName,variant)),nodes=prefab?.nodes||{},rootSet=new Set(pbs.map(x=>x.rootName)),children=new Map();for(const[name,n]of Object.entries(nodes)){if(!n.parentName)continue;if(!children.has(n.parentName))children.set(n.parentName,[]);children.get(n.parentName).push(name)}
  const out=[];for(const pb of pbs){const root=pb.rootName;if(!nodes[root])continue;const paths=[];function walk(n,path){let ch=(children.get(n)||[]).filter(x=>/^Earring/i.test(x)&&variantAllowsBone(x,variant)&&!(x!==root&&rootSet.has(x)));if(!ch.length){if(path.length>1)paths.push(path);return}for(const c of ch)walk(c,[...path,c])}walk(root,[root]);for(const chain of paths)out.push({pb,chain})}return out;
}
function skeletonData(prefab,meshes,fit,variant){
  const needed=new Set(),nodes=prefab?.nodes||{};for(const m of meshes)for(const b of m.boneNames||[])needed.add(b);const springs=buildSpringChains(prefab,variant);for(const sp of springs)for(const b of sp.chain)needed.add(b);
  for(const start of[...needed]){let n=start,guard=0;while(n&&nodes[n]&&guard++<64){if(/^Earring/i.test(n))needed.add(n);n=nodes[n].parentName;if(!n||!/Earring/i.test(n))break}}
  if(prefab?.worldByName?.Earring_Root)needed.add('Earring_Root');
  const guidByName=new Map([...needed].map(n=>[n,guid()])),posByName=new Map();for(const n of needed){const w=prefab?.worldByName?.[n],p=w?[w[3],w[7],w[11]]:fit.sourceAnchor;posByName.set(n,fitPoint(p,fit.sourceAnchor,fit.defaultAnchor))}
  const childNames=new Map();for(const n of needed){const p=nodes[n]?.parentName;if(p&&needed.has(p)){if(!childNames.has(p))childNames.set(p,[]);childNames.get(p).push(n)}}
  function nodeJson(n){return{Guid:guidByName.get(n),Name:n,Tag:'Untagged',Layer:0,Transform:xform(posByName.get(n)),Children:(childNames.get(n)||[]).sort().map(nodeJson),ActiveSelf:true}}
  const roots=[...needed].filter(n=>!needed.has(nodes[n]?.parentName)).sort(),rootNodes=roots.map(nodeJson);
  return{needed,guidByName,posByName,springs,rootNodes};
}
function springAnything(rootGuid,skel){
  if(!skel.springs.length)return null;const jointIndexByBone=new Map(),jointItems=[],refs=[],springItems=[];let ji=0;
  function jointFor(b,pb){if(jointIndexByBone.has(b))return jointIndexByBone.get(b);const idx=ji++,g=skel.guidByName.get(b);jointIndexByBone.set(b,idx);refs.push({key:'Vrm1Joint_'+idx,referenceGuid:g});const dir=pb.gravityDir||[0,-1,0],dq=Math.hypot(...dir)||1;jointItems.push({StiffnessForce:Math.max(0,Math.min(4,+pb.stiffness||0)),GravityPower:Math.max(0,Math.abs(+pb.gravity||0)),GravityDir:{x:dir[0]/dq,y:dir[1]/dq,z:dir[2]/dq},DragForce:Math.max(0,Math.min(1,1-(+pb.spring||0))),JointRadius:Math.max(0,(+pb.radius||0)*requestedScale)});return idx}
  let si=0;for(const sp of skel.springs){const ids=sp.chain.filter(b=>skel.guidByName.has(b)).map(b=>jointFor(b,sp.pb));if(ids.length>1)springItems.push({Name:'SourcePhysBone_'+(++si)+'_'+sp.chain[0],JointIndexes:ids,ColliderGroupIndexes:[],CenterReferenceKey:null})}
  if(!springItems.length)return null;const json={Version:1,SpringItems:springItems,JointItems:jointItems,ColliderGroupItems:[],ColliderItems:[]};return{$type:T.anything,AnythingName:'Vrm1InstanceAddon',GameObjectGuid:rootGuid,ComponentType:12,AnythingJson:JSON.stringify(json),ReferenceGuidStores:refs,ClassFullName:'UniVRM10.Vrm10Instance',AssemblyFullName:'VRM10, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null',_springCount:springItems.length,_jointCount:jointItems.length};
}
function buildXwear`,
  'fit skeleton and spring helpers'
);

replaceSpan(
  'function buildXwear(',
  '(async()=>',
  `function buildXwear(baseName,variant,sourceMeshes,scene,unityMats,author,prefab){
  const fit=fittedMeshes(sourceMeshes,variant),rawMeshes=fit.meshes,worldMeshes=mergeLogicalMeshes(rawMeshes),meshes=worldMeshes.map(m=>({...m,vertices:m.vertices.map(v=>v.map((x,i)=>x-fit.pivot[i]))})),used=[...new Set(meshes.flatMap(m=>m.materialIndices?.length?m.materialIndices:[m.materialIndex]))],matByIndex=new Map(),materials=[];
  for(const idx of used){const am=scene.materials?.[idx],n=safeName(assimpMaterialName(am,idx)),u=matchUnityMaterial(n,unityMats),diff=assimpDiffuse(am),shin=assimpShininess(am),src=u||{color:diff||(/jewel|gem|stone/i.test(n)?{r:.15,g:.3,b:.85,a:1}:{r:.65,g:.65,b:.68,a:1}),metallic:/metal/i.test(n)?.85:0,smooth:Number.isFinite(shin)?Math.max(0,Math.min(1,shin/1000)):.7},mj=materialJson(n,src);materials.push(mj);matByIndex.set(idx,mj.Guid)}
  const resourceGuid=guid(),rootGuid=guid(),children=[],components=[],zfiles={},skel=skeletonData(prefab,meshes,fit,variant);components.push({$type:T.accessory,GameObjectGuid:rootGuid,ComponentType:11,UseDefaultParent:true,DefaultParent:10,FittingOriginGuid:rootGuid});children.push(...skel.rootNodes);
  for(const mesh of meshes){
    const go=guid(),mg=guid(),isSkin=!!(mesh.skinned&&mesh.boneNames?.length);if(isSkin){mesh.bindposes=mesh.boneNames.map(b=>{const bp=skel.posByName.get(b)||fit.pivot;return transMat(fit.pivot.map((x,i)=>x-bp[i]))})}
    const bin=meshBinary(mesh);zfiles['Mesh\\\\'+mg]=new Uint8Array(bin);children.push({Guid:go,Name:mesh.name,Tag:'Untagged',Layer:0,Transform:xform(fit.pivot),Children:[],ActiveSelf:true});const refs=(mesh.materialIndices?.length?mesh.materialIndices:[mesh.materialIndex]).map(i=>matByIndex.get(i));
    if(isSkin){const bones=mesh.boneNames.map((b,i)=>({Index:i,BoneGuid:skel.guidByName.get(b)}));const rootBone=skel.guidByName.get('Earring_Root')||bones[0]?.BoneGuid;components.push({$type:T.skinned,MeshGuid:mg,GameObjectGuid:go,ComponentType:1,Mesh:{Name:mesh.name,Guid:mg,IndexFormat:mesh.vertices.length>65535?1:0,VertexCount:mesh.vertices.length,BoneCount:bones.length},RootBoneGuid:rootBone,Bones:bones,RefMaterialGuids:refs})}
    else components.push({$type:T.meshFilter,MeshGuid:mg,GameObjectGuid:go,ComponentType:10,Mesh:{Name:mesh.name,Guid:mg,IndexFormat:mesh.vertices.length>65535?1:0,VertexCount:mesh.vertices.length,BoneCount:0},RefMaterialGuids:refs});
  }
  const spring=springAnything(rootGuid,skel);if(spring){const springCount=spring._springCount,jointCount=spring._jointCount;delete spring._springCount;delete spring._jointCount;components.push(spring);log('[+] Adaptive physics '+variant+': '+springCount+' spring chains / '+jointCount+' joints')}else log('[!] Adaptive physics '+variant+': no source spring chains resolved');
  const resource={Name:baseName+' '+variant,Guid:resourceGuid,RootGameObject:{Guid:rootGuid,Name:baseName+' '+variant,Tag:'Untagged',Layer:0,Transform:xform(fit.pivot),Children:children,ActiveSelf:true},Components:components,XResourceHumanoidMap:null,MaterialGuids:materials.map(x=>x.Guid),TextureGuids:[]},xitem={XItemVersion:2,XResourceMaterials:materials,XResourceTextures:[],XResourceInfoList:[{Guid:resourceGuid,Type:1,License:itemLicense(baseName,author)}]},xitemPath='Body\\\\XItem.json\\\\XItem.json';zfiles['Body\\\\XResources\\\\'+resourceGuid]=strToU8(JSON.stringify(resource));zfiles[xitemPath]=strToU8(JSON.stringify(xitem));const zip=Buffer.from(zipSync(zfiles,{level:6})),opened=unzipSync(new Uint8Array(zip));if(!opened[xitemPath]||!opened['Body\\\\XResources\\\\'+resourceGuid])die('Internal XWear validation failed');if(JSON.parse(strFromU8(opened[xitemPath])).XItemVersion!==2)die('Bad XItemVersion');return{zip,meshCount:meshes.length,rawMeshCount:rawMeshes.length,materialCount:materials.length,sourceAnchor:fit.sourceAnchor,defaultAnchor:fit.defaultAnchor,pivot:fit.pivot,bounds:boundsOf(worldMeshes),skinnedMeshCount:meshes.filter(m=>m.skinned).length,springCount:skel.springs.length};
}

`,
  'R2.6 XWear builder'
);

mustReplace(
  "const r=buildXwear(baseName,v,ms,scene,unityMats,author)",
  "const r=buildXwear(baseName,v,ms,scene,unityMats,author,prefab)",
  'pass prefab to builder'
);
mustReplace("log('[+] LIBER clean-room XWear v2 R2');", "log('[+] LIBER clean-room XWear v2 R2.6 adaptive');", 'version log');
mustReplace(
  "variantMeta[v]={sourceAnchor:r.sourceAnchor,defaultAnchor:r.defaultAnchor,bounds:r.bounds};",
  "variantMeta[v]={sourceAnchor:r.sourceAnchor,defaultAnchor:r.defaultAnchor,pivot:r.pivot,bounds:r.bounds,skinnedMeshCount:r.skinnedMeshCount,springCount:r.springCount};",
  'preview R2.6 metadata'
);

fs.writeFileSync(file, s);
console.log('Applied VRoid Accessory Converter R2.6 adaptive patch');
