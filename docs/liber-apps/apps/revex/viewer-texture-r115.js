(function(root){
'use strict';
const BUILD='20260817r126-texture-precedence1';
if(root.__revexViewerTextureR115)return;
root.__revexViewerTextureR115={build:BUILD};
let threePromise=null,patched=null,generation=0;
const getThree=()=>threePromise||(threePromise=import('three'));
const text=v=>String(v??'').trim();
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'viewer texture r115/r126',...detail})}catch(_){}}
function baseMaterials(node){return (node?.userData?.r75BaseMaterials?.length?node.userData.r75BaseMaterials:node?.userData?.revexBaseMaterials?.length?node.userData.revexBaseMaterials:(Array.isArray(node?.material)?node.material:[node?.material])).filter(Boolean)}
async function ensureUv(node){
  const geometry=node?.geometry,position=geometry?.attributes?.position;
  if(!geometry||!position||geometry.attributes.uv||geometry.userData?.revexGeneratedUvR115)return false;
  const T=await getThree();
  geometry.computeBoundingBox?.();
  const box=geometry.boundingBox;if(!box)return false;
  const size={x:Math.max(box.max.x-box.min.x,1e-6),y:Math.max(box.max.y-box.min.y,1e-6),z:Math.max(box.max.z-box.min.z,1e-6)};
  const axes=['x','y','z'].sort((a,b)=>size[b]-size[a]);
  const uAxis=axes[0],vAxis=axes[1],uv=new Float32Array(position.count*2);
  for(let i=0;i<position.count;i++){
    const p={x:position.getX(i),y:position.getY(i),z:position.getZ(i)};
    uv[i*2]=(p[uAxis]-box.min[uAxis])/size[uAxis];
    uv[i*2+1]=(p[vAxis]-box.min[vAxis])/size[vAxis];
  }
  geometry.setAttribute('uv',new T.BufferAttribute(uv,2));
  geometry.userData=geometry.userData||{};geometry.userData.revexGeneratedUvR115={uAxis,vAxis};
  return true;
}
async function ensureAllUv(v){
  const seen=new Set(),jobs=[];
  for(const nodes of v?.elementNodes?.values?.()||[])for(const node of nodes||[]){if(!node?.geometry||seen.has(node.geometry))continue;seen.add(node.geometry);jobs.push(ensureUv(node));}
  if(jobs.length)await Promise.all(jobs);
}
function blendMappedMaterials(v,token,attempt=0){
  if(token!==generation||v!==patched)return;
  let waiting=false,changed=false;
  for(const nodes of v?.elementNodes?.values?.()||[])for(const node of nodes||[]){
    const mats=node?.userData?.r75AppearanceMaterials||[],base=baseMaterials(node);
    if(!mats.length)continue;
    for(let i=0;i<mats.length;i++){
      const material=mats[i],source=base[i]||base[0];
      if(!material?.map){waiting=true;continue;}
      // A user texture is the visible finish. Revit/model color is preserved only
      // as the fallback when no texture exists; it must never tint an active map.
      if(material.color){material.color.set(0xffffff);changed=true;}
      if(Number.isFinite(source?.roughness)&&Number.isFinite(material.roughness))material.roughness=source.roughness;
      if(Number.isFinite(source?.metalness)&&Number.isFinite(material.metalness))material.metalness=source.metalness;
      material.needsUpdate=true;
    }
  }
  if(changed)v.requestRender?.();
  if(waiting&&attempt<48)setTimeout(()=>blendMappedMaterials(v,token,attempt+1),75);
}
function patch(v){
  if(!v||v.__revexTextureR115)return false;
  v.__revexTextureR115=true;patched=v;
  const originalSet=typeof v.setAppearances==='function'?v.setAppearances.bind(v):null;
  const originalApply=typeof v.applyAppearances==='function'?v.applyAppearances.bind(v):null;
  const originalDetailed=typeof v.loadDetailed==='function'?v.loadDetailed.bind(v):null;
  if(originalSet)v.setAppearances=function(rows){
    const textured=(rows||[]).some(row=>row?.enabled!==false&&row?.texture?.assetUrl);
    const token=++generation;
    if(textured)void ensureAllUv(this).then(()=>{originalSet(rows);blendMappedMaterials(this,token)});
    else originalSet(rows);
  };
  if(originalApply)v.applyAppearances=function(){const token=++generation;void ensureAllUv(this).then(()=>{originalApply();blendMappedMaterials(this,token)})};
  if(originalDetailed)v.loadDetailed=async function(...args){const result=await originalDetailed(...args);if(result){await ensureAllUv(this);this.applyAppearances?.();}return result};
  void ensureAllUv(v).then(()=>{v.applyAppearances?.();diag('INFO','BIM_TEXTURE_R126','Stable planar UVs enabled; texture > design color fallback > Revit/model color.',{viewerBuild:text(v?.constructor?.name)})});
  return true;
}
let attempts=0;const timer=setInterval(()=>{attempts++;if(patch(root.__revexViewerR26Instance)||attempts>200)clearInterval(timer)},50);
root.addEventListener('revex:source-revision-loaded',()=>setTimeout(()=>patch(root.__revexViewerR26Instance),0));
})(window);
