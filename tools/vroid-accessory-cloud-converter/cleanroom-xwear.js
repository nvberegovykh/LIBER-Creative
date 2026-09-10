#!/usr/bin/env node
'use strict';

// LIBER VRoid 2.14 XWear clean-room converter.
// This file contains no pixiv/XWear Packager source code. It writes the
// interoperable XWear v2 container layout from independently observed I/O.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

function die(m){ throw new Error(m); }
function arg(name, fallback=null){ const i=process.argv.indexOf(name); return i>=0 ? process.argv[i+1] : fallback; }
const packageRoot = path.resolve(arg('--package-root') || die('Missing --package-root'));
const outDir = path.resolve(arg('--output-dir') || die('Missing --output-dir'));
const requestedScale = Number(arg('--scale','1'));
if (!Number.isFinite(requestedScale) || requestedScale <= 0) die('Invalid --scale');
const licensePathArg = arg('--license-file','');
const logPath = arg('--log-file','');
const logs=[];
function log(s){ const line=String(s); console.log(line); logs.push(line); }
function guid(){ return crypto.randomUUID(); }
function sha256(b){ return crypto.createHash('sha256').update(b).digest('hex'); }
function safeName(s){ return String(s||'Accessory').replace(/[<>:"/\\|?*\x00-\x1f]+/g,'_').replace(/\s+/g,' ').trim().slice(0,100)||'Accessory'; }

function scanUnityPackage(root){
  const assets=[];
  for(const ent of fs.readdirSync(root,{withFileTypes:true})){
    if(!ent.isDirectory()) continue;
    const d=path.join(root,ent.name), pn=path.join(d,'pathname'), ap=path.join(d,'asset');
    if(!fs.existsSync(pn)) continue;
    const pathname=fs.readFileSync(pn,'utf8').trim();
    assets.push({guid:ent.name, pathname, asset:fs.existsSync(ap)?ap:null, meta:fs.existsSync(path.join(d,'asset.meta'))?path.join(d,'asset.meta'):null});
  }
  if(!assets.length) die('No Unity package assets found');
  return assets;
}

function chooseFbx(assets){
  const f=assets.filter(x=>x.asset && /\.fbx$/i.test(x.pathname));
  if(!f.length) die('No FBX model found in Unity package');
  f.sort((a,b)=>{
    const pa=/_[A-Za-z0-9]+\.fbx$/i.test(path.basename(a.pathname))?1:0;
    const pb=/_[A-Za-z0-9]+\.fbx$/i.test(path.basename(b.pathname))?1:0;
    return pa-pb || path.basename(a.pathname).length-path.basename(b.pathname).length || a.pathname.localeCompare(b.pathname);
  });
  return f[0];
}

function yamlNum(text,key,fallback){
  const re=new RegExp('^\\s*-\\s+'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+':\\s*([-+0-9.eE]+)\\s*$','m');
  const m=text.match(re), n=m?Number(m[1]):NaN; return Number.isFinite(n)?n:fallback;
}
function yamlColor(text,key){
  const re=new RegExp('^\\s*-\\s+'+key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+':\\s*\\{r:\\s*([-+0-9.eE]+),\\s*g:\\s*([-+0-9.eE]+),\\s*b:\\s*([-+0-9.eE]+),\\s*a:\\s*([-+0-9.eE]+)\\}','m');
  const m=text.match(re); return m?{r:+m[1],g:+m[2],b:+m[3],a:+m[4]}:null;
}
function parseUnityMaterials(assets){
  const map=new Map();
  for(const a of assets.filter(x=>x.asset && /\.mat$/i.test(x.pathname))){
    let t=''; try{t=fs.readFileSync(a.asset,'utf8')}catch{continue}
    const n=(t.match(/^\s*m_Name:\s*(.+)$/m)||[])[1] || path.basename(a.pathname,'.mat');
    const lower=n.toLowerCase();
    let color=yamlColor(t,'_Color')||yamlColor(t,'_BaseColor')||(lower.includes('jewel')?{r:.18,g:.32,b:.88,a:1}:{r:.7,g:.7,b:.72,a:1});
    if(/jewel|gem|stone|sapphire/i.test(lower) && Math.max(color.r,color.g,color.b)-Math.min(color.r,color.g,color.b)<0.08) color={r:.18,g:.32,b:.88,a:color.a??1};
    let metallic=yamlNum(t,'_Metallic', lower.includes('metal')?.85:0.0);
    let smooth=yamlNum(t,'_Smoothness', yamlNum(t,'_Glossiness', lower.includes('jewel')?.9:.75));
    metallic=Math.max(0,Math.min(1,metallic)); smooth=Math.max(0,Math.min(1,smooth));
    map.set(n.toLowerCase(),{name:n,color,metallic,smooth,source:a.pathname});
  }
  return map;
}

function assimpMaterialName(mat,idx){ const p=mat?.properties?.find(x=>x.key==='?mat.name'); return p?.value?String(p.value):'Material_'+idx; }
function assimpDiffuse(mat){ const p=mat?.properties?.find(x=>x.key==='$clr.diffuse'); return p&&Array.isArray(p.value)&&p.value.length>=3?{r:+p.value[0],g:+p.value[1],b:+p.value[2],a:1}:null; }
function assimpShininess(mat){ const p=mat?.properties?.find(x=>x.key==='$mat.shininess'); return p?Number(p.value):NaN; }
function matchUnityMaterial(name,unity){
  const key=name.toLowerCase(); if(unity.has(key)) return unity.get(key);
  for(const [k,v] of unity) if(key.includes(k)||k.includes(key)) return v;
  if(key.includes('metal')) for(const [k,v] of unity) if(k.includes('metal')) return v;
  if(/jewel|gem|stone|sapphire/i.test(key)) for(const [k,v] of unity) if(/jewel|gem|stone|sapphire/i.test(k)) return v;
  return null;
}

function mul4(a,b){ const r=new Array(16).fill(0); for(let i=0;i<4;i++)for(let j=0;j<4;j++)for(let k=0;k<4;k++)r[i*4+j]+=a[i*4+k]*b[k*4+j]; return r; }
const I4=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function point(m,v){ return [m[0]*v[0]+m[1]*v[1]+m[2]*v[2]+m[3],m[4]*v[0]+m[5]*v[1]+m[6]*v[2]+m[7],m[8]*v[0]+m[9]*v[1]+m[10]*v[2]+m[11]]; }
function vec(m,v){ const x=m[0]*v[0]+m[1]*v[1]+m[2]*v[2],y=m[4]*v[0]+m[5]*v[1]+m[6]*v[2],z=m[8]*v[0]+m[9]*v[1]+m[10]*v[2],q=Math.hypot(x,y,z)||1; return [x/q,y/q,z/q]; }
function flat3(a){ const out=[]; for(let i=0;i<(a||[]).length;i+=3)out.push([+a[i]||0,+a[i+1]||0,+a[i+2]||0]); return out; }
function flat4(a){ const out=[]; for(let i=0;i<(a||[]).length;i+=4)out.push([+a[i]||0,+a[i+1]||0,+a[i+2]||0,+a[i+3]||0]); return out; }
function uvChannel(mesh,c){ const a=mesh.texturecoords?.[c]||[], comps=mesh.numuvcomponents?.[c]||2,out=[]; for(let i=0;i<a.length;i+=comps)out.push([+a[i]||0,+a[i+1]||0]); return out; }
function triangulate(faces){ const out=[]; for(const f of faces||[]){ if(f.length===3)out.push(...f); else if(f.length>3)for(let i=1;i<f.length-1;i++)out.push(f[0],f[i],f[i+1]); } return out; }
function sideOf(s){
  const n=String(s||'');
  if(/(?:three\s*star\s*pierce)?l[_-]?\d+/i.test(n)||/piercel(?:_|-|\d)/i.test(n)||/(?:^|[^a-z])left(?:[^a-z]|$)/i.test(n)||/(?:^|[_ .-])l(?:[_ .-]|$)/i.test(n)) return 'L';
  if(/(?:three\s*star\s*pierce)?r[_-]?\d+/i.test(n)||/piercer(?:_|-|\d)/i.test(n)||/(?:^|[^a-z])right(?:[^a-z]|$)/i.test(n)||/(?:^|[_ .-])r(?:[_ .-]|$)/i.test(n)) return 'R';
  return '';
}
function flattenMeshes(scene,scale){
  const out=[];
  function visit(node,parent){
    const local=Array.isArray(node.transformation)&&node.transformation.length===16?node.transformation:I4, world=mul4(parent,local);
    for(const mi of node.meshes||[]){
      const m=scene.meshes[mi]; if(!m)continue;
      const verts=flat3(m.vertices).map(v=>point(world,v).map(x=>x*scale));
      const normals=flat3(m.normals).map(v=>vec(world,v));
      let colors=[]; if(Array.isArray(m.colors?.[0]))colors=flat4(m.colors[0]); else if(Array.isArray(m.colors))colors=flat4(m.colors);
      const name=safeName(node.name||m.name||('Mesh_'+mi));
      out.push({name,side:sideOf(name+' '+(m.name||'')),materialIndex:Number.isInteger(m.materialindex)?m.materialindex:0,vertices:verts,normals,tangents:[],colors,uvs:[uvChannel(m,0),uvChannel(m,1),uvChannel(m,2),uvChannel(m,3)],indices:triangulate(m.faces)});
    }
    for(const ch of node.children||[])visit(ch,world);
  }
  visit(scene.rootnode||{name:'Root'},I4); if(!out.length)die('FBX import produced no mesh objects'); return out;
}

function writer(){ const chunks=[]; return {i32(n){const b=Buffer.alloc(4);b.writeInt32LE(n|0);chunks.push(b)},f32(n){const b=Buffer.alloc(4);b.writeFloatLE(Number(n)||0);chunks.push(b)},str(s){const b=Buffer.from(String(s),'utf8');let n=b.length;const p=[];do{let v=n&0x7f;n>>>=7;if(n)v|=0x80;p.push(v)}while(n);chunks.push(Buffer.from(p),b)},vec2(v){this.f32(v[0]);this.f32(v[1])},vec3(v){this.f32(v[0]);this.f32(v[1]);this.f32(v[2])},vec4(v){this.f32(v[0]);this.f32(v[1]);this.f32(v[2]);this.f32(v[3])},done(){return Buffer.concat(chunks)}}; }
function meshBinary(mesh){
  const w=writer(); w.i32(0);w.str(mesh.name);w.i32(mesh.vertices.length);w.i32(mesh.vertices.length);for(const v of mesh.vertices)w.vec3(v);w.i32(mesh.normals.length);for(const v of mesh.normals)w.vec3(v);w.i32(mesh.tangents.length);for(const v of mesh.tangents)w.vec4(v);w.i32(mesh.colors.length);for(const v of mesh.colors)w.vec4(v);for(let c=0;c<4;c++){const uv=mesh.uvs[c]||[];w.i32(uv.length);for(const v of uv)w.vec2(v)}w.i32(0);w.i32(0);w.i32(1);w.i32(0);w.i32(mesh.indices.length);for(const n of mesh.indices)w.i32(n);w.i32(0);w.i32(0);return w.done();
}

const T={meshFilter:'XWear.IO.Runtime.Components.Meshes.XResourceMeshFilter, XWear.IO.Runtime',accessory:'XWear.IO.Runtime.Components.AccessoryRoot.XResourceAccessoryRoot, XWear.IO.Runtime',color:'XWear.IO.Runtime.Materials.Shader.ShaderColorProperty, XWear.IO.Runtime',float:'XWear.IO.Runtime.Materials.Shader.ShaderFloatProperty, XWear.IO.Runtime'};
function xform(){return {Name:'',Position:{x:0,y:0,z:0},Rotation:{x:0,y:0,z:0,w:1},Scale:{x:1,y:1,z:1},LocalPosition:{x:0,y:0,z:0},LocalRotation:{x:0,y:0,z:0,w:1},LocalScale:{x:1,y:1,z:1},Index:0};}
function materialJson(name,src){ const g=guid(),c=src.color||{r:.7,g:.7,b:.7,a:1}; return {Name:name,Guid:g,ShaderName:'Standard',ShaderProperties:[{$type:T.color,Color:{r:c.r,g:c.g,b:c.b,a:c.a??1},PropertyName:'_Color'},{$type:T.float,Value:src.metallic??0,PropertyName:'_Metallic'},{$type:T.float,Value:src.smooth??.6,PropertyName:'_Glossiness'}],MaterialTags:[],ShaderKeywords:[],RenderQueue:-1,referencedTextureGuids:[]}; }
function authorGuess(assets,licenseText){ if(/𝐏𝐫𝐞𝐜𝐢𝐨𝐮𝐬|Precious/i.test(licenseText||''))return 'Precious'; const p=assets.map(x=>x.pathname).find(x=>/^Assets\/[^/]+\//.test(x)); return p?p.split('/')[1]:''; }
function itemLicense(itemName,author){return {contents:[{itemName,licenseType:0,author,licenseUrls:[]}]};}
function buildXwear(baseName,variant,meshes,scene,unityMats,author){
  const used=[...new Set(meshes.map(m=>m.materialIndex))],matByIndex=new Map(),materials=[];
  for(const idx of used){ const am=scene.materials?.[idx],n=safeName(assimpMaterialName(am,idx)),u=matchUnityMaterial(n,unityMats),diff=assimpDiffuse(am),shin=assimpShininess(am),src=u||{color:diff||(/jewel|gem|stone/i.test(n)?{r:.15,g:.3,b:.85,a:1}:{r:.65,g:.65,b:.68,a:1}),metallic:/metal/i.test(n)?.85:0,smooth:Number.isFinite(shin)?Math.max(0,Math.min(1,shin/1000)):.7},mj=materialJson(n,src); materials.push(mj);matByIndex.set(idx,mj.Guid); }
  const resourceGuid=guid(),rootGuid=guid(),children=[],components=[],zfiles={};
  components.push({$type:T.accessory,GameObjectGuid:rootGuid,ComponentType:11,UseDefaultParent:true,DefaultParent:10,FittingOriginGuid:rootGuid});
  for(const mesh of meshes){ const go=guid(),mg=guid(),bin=meshBinary(mesh);zfiles['Mesh\\'+mg]=new Uint8Array(bin);children.push({Guid:go,Name:mesh.name,Tag:'Untagged',Layer:0,Transform:xform(),Children:[],ActiveSelf:true});components.push({$type:T.meshFilter,MeshGuid:mg,GameObjectGuid:go,ComponentType:10,Mesh:{Name:mesh.name,Guid:mg,IndexFormat:mesh.vertices.length>65535?1:0,VertexCount:mesh.vertices.length,BoneCount:0},RefMaterialGuids:[matByIndex.get(mesh.materialIndex)]}); }
  const resource={Name:baseName+' '+variant,Guid:resourceGuid,RootGameObject:{Guid:rootGuid,Name:baseName+' '+variant,Tag:'Untagged',Layer:0,Transform:xform(),Children:children,ActiveSelf:true},Components:components,XResourceHumanoidMap:null,MaterialGuids:materials.map(x=>x.Guid),TextureGuids:[]};
  const xitem={XItemVersion:2,XResourceMaterials:materials,XResourceTextures:[],XResourceInfoList:[{Guid:resourceGuid,Type:1,License:itemLicense(baseName,author)}]};
  zfiles['Body\\XResources\\'+resourceGuid]=strToU8(JSON.stringify(resource));zfiles['Body\\XItem.json']=strToU8(JSON.stringify(xitem));
  const zip=Buffer.from(zipSync(zfiles,{level:6})),opened=unzipSync(new Uint8Array(zip));if(!opened['Body\\XItem.json']||!opened['Body\\XResources\\'+resourceGuid])die('Internal XWear validation failed');const parsed=JSON.parse(strFromU8(opened['Body\\XItem.json']));if(parsed.XItemVersion!==2)die('Bad XItemVersion');return {zip,meshCount:meshes.length,materialCount:materials.length};
}

(async()=>{
  fs.mkdirSync(outDir,{recursive:true});const assets=scanUnityPackage(packageRoot),fbx=chooseFbx(assets),unityMats=parseUnityMaterials(assets);let licenseText='';if(licensePathArg&&fs.existsSync(licensePathArg))try{licenseText=fs.readFileSync(licensePathArg,'utf8')}catch{}
  const baseName=safeName(path.basename(fbx.pathname,'.fbx').replace(/_[A-Za-z0-9]+$/,'')),author=authorGuess(assets,licenseText);log('[+] LIBER clean-room XWear v2');log('[+] Source FBX: '+fbx.pathname);log('[+] Source materials found: '+unityMats.size);log('[+] Rights metadata author: '+(author||'(unspecified)'));
  const ajs=await require('assimpjs')(),fl=new ajs.FileList();fl.AddFile(path.basename(fbx.pathname),fs.readFileSync(fbx.asset));const res=ajs.ConvertFileList(fl,'assjson');if(!res.IsSuccess()||res.FileCount()===0)die('Assimp FBX conversion failed: '+res.GetErrorCode());const scene=JSON.parse(new TextDecoder().decode(res.GetFile(0).GetContent())),meshes=flattenMeshes(scene,requestedScale);log('[+] Mesh objects: '+meshes.length);log(`[+] Side classification: L=${meshes.filter(x=>x.side==='L').length} R=${meshes.filter(x=>x.side==='R').length} neutral=${meshes.filter(x=>!x.side).length}`);
  const variants=[['Pair',meshes]],L=meshes.filter(x=>x.side==='L'),R=meshes.filter(x=>x.side==='R');if(L.length)variants.push(['Left',L]);if(R.length)variants.push(['Right',R]);const outputs=[];
  for(const [v,ms] of variants){const r=buildXwear(baseName,v,ms,scene,unityMats,author),fn=`${baseName}_${v}.xwear`,fp=path.join(outDir,fn);fs.writeFileSync(fp,r.zip);outputs.push({name:fn,sha256:sha256(r.zip),bytes:r.zip.length,meshCount:r.meshCount,materialCount:r.materialCount});log(`[+] ${fn}: ${r.meshCount} meshes, ${r.zip.length} bytes, sha256=${outputs.at(-1).sha256}`);}
  const manifest={schema:1,converter:'LIBER clean-room XWear v2',target:'VRoid Studio 2.14.0',sourceFbx:fbx.pathname,sourceRights:'unchanged',author,scale:requestedScale,outputs,warnings:['Test build uses self-contained Unity Standard material colors/metallic/smoothness; source shader-specific effects are intentionally not redistributed.']};fs.writeFileSync(path.join(outDir,'manifest.json'),JSON.stringify(manifest,null,2));if(logPath)fs.writeFileSync(logPath,logs.join('\n')+'\n');
})().catch(e=>{console.error('FAILED:',e.stack||e);if(logPath)try{fs.writeFileSync(logPath,logs.join('\n')+'\nFAILED: '+(e.stack||e)+'\n')}catch{};process.exit(1);});
