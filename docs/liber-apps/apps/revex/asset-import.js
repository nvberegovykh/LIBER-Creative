import * as THREE from 'three';

const MAX_BYTES=60*1024*1024,MAX_VERTICES=4000000;
export const MODEL_EXTENSIONS=/\.(glb|gltf|ifc|fbx|obj|stl)$/i;
export function disposeAsset(root){root?.traverse(n=>{n.geometry?.dispose();for(const m of [n.material].flat().filter(Boolean)){for(const value of Object.values(m))if(value?.isTexture)value.dispose();m.dispose();}});}
function safePath(name){const p=String(name).replaceAll('\\','/');if(p.startsWith('/')||p.split('/').includes('..')||/^[a-z]+:/i.test(p))throw Error('The model package contains an unsafe file path.');return p;}
async function filesFrom(input){
 const files=[...input];if(files.reduce((n,f)=>n+f.size,0)>MAX_BYTES)throw Error('Choose a model package smaller than 60 MB.');
 if(files.length===1&&/\.zip$/i.test(files[0].name)){
  const {unzipSync}=await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');
  let bytes=0,count=0;const unpacked=unzipSync(new Uint8Array(await files[0].arrayBuffer()),{filter:entry=>{safePath(entry.name);bytes+=entry.originalSize;count++;if(bytes>MAX_BYTES||count>200)throw Error('The expanded model package is too large.');return !entry.name.endsWith('/');}});
  return Object.entries(unpacked).map(([name,data])=>new File([data],safePath(name)));
 }return files;
}
async function loadIfc(buffer){
 const {IfcAPI}=await import('https://cdn.jsdelivr.net/npm/web-ifc@0.0.72/web-ifc-api.js');
 const api=new IfcAPI();api.SetWasmPath('https://cdn.jsdelivr.net/npm/web-ifc@0.0.72/',true);await api.Init();
 const id=api.OpenModel(new Uint8Array(buffer),{COORDINATE_TO_ORIGIN:true}),root=new THREE.Group();let count=0;
 if(id<0)throw Error('The IFC model could not be opened.');
 try{api.StreamAllMeshes(id,flat=>{for(let i=0;i<flat.geometries.size();i++){
  const placed=flat.geometries.get(i),g=api.GetGeometry(id,placed.geometryExpressID);
  try{const vertices=api.GetVertexArray(g.GetVertexData(),g.GetVertexDataSize()),indices=api.GetIndexArray(g.GetIndexData(),g.GetIndexDataSize());count+=vertices.length/6;if(count>MAX_VERTICES)throw Error('This model has too much detail for browser placement. Choose a lighter export.');
   const positions=new Float32Array(vertices.length/2),normals=new Float32Array(vertices.length/2);for(let j=0;j<vertices.length/6;j++){positions.set(vertices.subarray(j*6,j*6+3),j*3);normals.set(vertices.subarray(j*6+3,j*6+6),j*3);}
   const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices),1));
   const c=placed.color,mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:new THREE.Color(c.x,c.y,c.z),opacity:c.w,transparent:c.w<1,roughness:.7,side:THREE.DoubleSide}));mesh.applyMatrix4(new THREE.Matrix4().fromArray(placed.flatTransformation));root.add(mesh);
  }finally{g.delete();}
 }});return root;}catch(e){disposeAsset(root);throw e;}finally{api.CloseModel(id);api.Dispose?.();}
}
export async function importAsset(input){
 const files=await filesFrom(input),models=files.filter(f=>MODEL_EXTENSIONS.test(f.name));
 if(!models.length){if(files.some(f=>/\.rfa$/i.test(f.name)))throw Error('Automatic RFA conversion is not connected yet. This file has not been placed. IFC, GLB, glTF, FBX, OBJ and STL models can be placed directly in REVEX.');throw Error('Choose a GLB, glTF, IFC, FBX, OBJ or STL model, or a ZIP containing one model.');}
 // Prefer a self-contained GLB when an archive includes both glTF and GLB.
 const preferred=models.filter(f=>/\.glb$/i.test(f.name)),file=preferred.length===1?preferred[0]:models.length===1?models[0]:null;
 if(!file)throw Error('This package contains several models. Extract it and select one model with its texture files.');
 const ext=file.name.split('.').at(-1).toLowerCase(),buffer=await file.arrayBuffer(),urls=new Map(),manager=new THREE.LoadingManager();
 let pending=0,resourceError=false;const start=manager.itemStart.bind(manager),end=manager.itemEnd.bind(manager);
 manager.itemStart=url=>{pending++;start(url);};manager.itemEnd=url=>{pending--;end(url);};manager.onError=()=>{resourceError=true;};
 for(const f of files)urls.set(safePath(f.name).toLowerCase(),URL.createObjectURL(f));
 manager.setURLModifier(url=>{
  // GLB/FBX loaders create origin-bound blob URLs for embedded images.
  if(url.startsWith('data:')||url.startsWith('blob:'+location.origin+'/')||[...urls.values()].includes(url))return url;
  let decoded;try{decoded=decodeURIComponent(url).replaceAll('\\','/').replace(/^\.\//,'');}catch{throw Error('A model resource path is invalid.');}
  const exact=urls.get(decoded.toLowerCase());if(exact)return exact;
  const tail=decoded.split('/').at(-1).toLowerCase(),matches=[...urls].filter(([name])=>name.split('/').at(-1)===tail);
  if(matches.length===1)return matches[0][1];
  throw Error('A texture or model resource is missing. Choose the model and its companion files together, or use a self-contained GLB.');
 });
 let root;
 try{
  if(ext==='gltf'||ext==='glb'){
   const json=ext==='gltf'?JSON.parse(new TextDecoder().decode(buffer)):JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,new DataView(buffer).getUint32(12,true))));
   if((json.accessors||[]).some(a=>!Number.isSafeInteger(a.count)||a.count<0||a.count>MAX_VERTICES))throw Error('The model contains an oversized geometry buffer.');
   const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
   root=(await new GLTFLoader(manager).parseAsync(buffer,'')).scene;
  }else if(ext==='ifc')root=await loadIfc(buffer);
  else if(ext==='fbx'){const {FBXLoader}=await import('three/addons/loaders/FBXLoader.js');root=new FBXLoader(manager).parse(buffer,'');}
  else if(ext==='obj'){
   const [{OBJLoader},{MTLLoader}]=await Promise.all([import('three/addons/loaders/OBJLoader.js'),import('three/addons/loaders/MTLLoader.js')]);
   const loader=new OBJLoader(manager),materials=files.filter(f=>/\.mtl$/i.test(f.name));
   if(materials.length===1){const mtl=new MTLLoader(manager).parse(await materials[0].text(),'');mtl.preload();loader.setMaterials(mtl);}
   root=loader.parse(new TextDecoder().decode(buffer));
  }
  else {const {STLLoader}=await import('three/addons/loaders/STLLoader.js');root=new THREE.Mesh(new STLLoader(manager).parse(buffer),new THREE.MeshStandardMaterial({color:0xc6c9cc,roughness:.7}));}
  const deadline=Date.now()+30000;while(pending&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  if(pending||resourceError)throw Error('A model texture could not be opened. Choose the model with all its texture files.');
  let vertices=0,meshes=0;root.traverse(n=>{if(n.isMesh){vertices+=n.geometry?.attributes.position?.count||0;meshes++;}});
  if(!meshes||vertices>MAX_VERTICES)throw Error(!meshes?'This file has no visible 3D geometry.':'This model has too much detail. Choose a lighter export.');
  const box=new THREE.Box3().setFromObject(root);if(box.isEmpty()||![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite))throw Error('The model has invalid dimensions.');
  return {root,name:file.name,format:ext,units:['glb','gltf','ifc'].includes(ext)?'m':ext==='fbx'?'cm':'mm',vertices};
 }catch(e){disposeAsset(root);throw e;}finally{for(const url of urls.values())URL.revokeObjectURL(url);}
}
export async function exportAsset(root){const {GLTFExporter}=await import('three/addons/exporters/GLTFExporter.js');const bytes=await new GLTFExporter().parseAsync(root,{binary:true,onlyVisible:true});if(bytes.byteLength>MAX_BYTES)throw Error('The converted model is too large to save.');return new File([bytes],'asset.glb',{type:'model/gltf-binary'});}
export async function loadSavedAsset(buffer){const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');const manager=new THREE.LoadingManager();manager.setURLModifier(url=>{if(/^(data:|blob:)/.test(url))return url;throw Error('Saved placements must contain their own model resources.');});return(await new GLTFLoader(manager).parseAsync(buffer,'')).scene;}
