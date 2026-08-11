import * as THREE from 'three';
const BUILD='20260811r29';
const AUTHORING=/^(cameras?|views?|viewports?|sheets?|levels?|grids?|reference planes?|scope boxes?|project information|internal origin|survey point|project base point|sections?|elevations?|callouts?|lines?|model lines?|detail lines?|sketch lines?|analytical nodes?|reference points?|rooms?|spaces?|areas?|room separation|space separation|area boundary)$/i;
const JUNK=/(room separation|space separation|area boundary|analytical|lighting.*area|electrical.*area|energy.*area|imported categories|import instance|cad link|coordination model|point cloud|\bdwg\b|\bdxf\b|<not shared>|location <not shared>)/i;
const physical=r=>{
  if(!r?.bbox?.min||!r?.bbox?.max)return false;
  const category=String(r.category||'').trim();
  const text=`${category} ${r.name||''} ${r.type||''} ${r.family||''}`;
  return !AUTHORING.test(category)&&!JUNK.test(text);
};
const filteredSource=source=>source?{...source,elements:(source.elements||[]).filter(physical)}:source;

function cleanTree(){
  const host=document.getElementById('element-tree'),state=window.__revexState;if(!host||!state?.viewerData)return;
  const allowed=new Set((state.viewerData.elements||[]).filter(physical).map(r=>String(r.id)));
  let currentGroup=null,groupHas=false;
  for(const node of [...host.children]){
    if(node.classList.contains('tree-group')){
      if(currentGroup&&!groupHas)currentGroup.remove();
      currentGroup=node;groupHas=false;continue;
    }
    if(node.classList.contains('tree-item')){
      if(!allowed.has(String(node.dataset.elementId||''))){node.remove();continue;}
      groupHas=true;
    }
  }
  if(currentGroup&&!groupHas)currentGroup.remove();
  const fact=document.querySelector('#model-facts .fact');
  if(fact){fact.querySelector('strong').textContent=allowed.size.toLocaleString();const span=fact.querySelector('span');if(span)span.textContent='physical elements';}
}

function legacyNotice(v){
  const state=v?.sourceState,format=state?.modelFormat||v?.data?.geometry?.displayFormat||'';
  const msg=document.getElementById('viewer-message'),button=document.getElementById('detail-toggle');
  if(format==='rvxmesh-gzip'){
    if(button&&!v.detailLoading)button.textContent=v.detailLoaded?'Exact':'Model';
    return;
  }
  if(format==='fbx'){
    if(button){button.textContent='Legacy FBX';button.title='This revision predates the exact REVEX mesh. Run SYNC BIM + BOOKS from the current REVEX add-in to publish model.rvxmesh.gz.';}
    if(msg){msg.hidden=false;msg.classList.add('fallback');msg.textContent='Legacy FBX revision. Re-sync BIM + Books once to publish exact Revit tessellation; FBX is compatibility-only.';}
  }
}

function install(v){
  if(v.__revexR29)return;v.__revexR29=true;
  const oldOutline=v.buildOutlineOverlay?.bind(v);
  if(oldOutline)v.buildOutlineOverlay=async function(root){
    const format=this.sourceState?.modelFormat||this.data?.geometry?.displayFormat||'';
    if(format!=='rvxmesh-gzip'){
      if(this.__r28Outline){this.scene.remove(this.__r28Outline);this.__r28Outline.geometry?.dispose?.();this.__r28Outline.material?.dispose?.();this.__r28Outline=null;this.requestRender();}
      return;
    }
    return oldOutline(root);
  };

  const oldLoad=v.load.bind(v);
  v.load=async function(state,source=null){
    const clean=filteredSource(source||window.__revexState?.viewerData||null);
    const result=await oldLoad(state,clean);
    cleanTree();legacyNotice(this);
    return result;
  };

  v.registerFixed=function(root,target){
    root.position.set(0,0,0);root.quaternion.identity();root.scale.setScalar(1);root.updateMatrixWorld(true);
    const source=new THREE.Box3().setFromObject(root);if(source.isEmpty()||!target||target.isEmpty())return;
    const ss=source.getSize(new THREE.Vector3()),ts=target.getSize(new THREE.Vector3());
    const ratios=[ts.x/Math.max(ss.x,1e-9),ts.y/Math.max(ss.y,1e-9),ts.z/Math.max(ss.z,1e-9)].filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b);
    const scale=ratios[1]||1,sc=source.getCenter(new THREE.Vector3()),tc=target.getCenter(new THREE.Vector3());
    root.scale.setScalar(scale);root.position.copy(tc.clone().sub(sc.multiplyScalar(scale)));root.updateMatrixWorld(true);
    console.info('[REVEX r29] FBX compatibility registration',{rotation:'identity-only',scale});
  };

  v.pruneFloating=function(root,target){
    const size=target.getSize(new THREE.Vector3()),pad=Math.max(size.length()*.03,1.25),keep=target.clone().expandByScalar(pad);let hidden=0;
    root.updateMatrixWorld(true);root.traverse(n=>{if(!n.isMesh)return;const row=this.elementForNode(n),text=`${this.keyText(n)} ${row?.category||''} ${row?.name||''} ${row?.type||''}`;
      if(JUNK.test(text)||(row&&!physical(row))){n.visible=false;hidden++;return;}
      const b=new THREE.Box3().setFromObject(n);if(!b.isEmpty()&&!b.intersectsBox(keep)){n.visible=false;hidden++;}
    });
    if(hidden)console.info('[REVEX r29] hidden authoring/reference FBX nodes',{hidden});
  };

  const oldDetailed=v.loadDetailed.bind(v);
  v.loadDetailed=async function(...args){const ok=await oldDetailed(...args);cleanTree();legacyNotice(this);return ok;};

  const state=window.__revexState,source=state?.viewerData;if(source&&v.sourceState){
    v.detailLoaded=false;v.detailLoading=false;setTimeout(()=>v.load(v.sourceState,source),20);
  }else{cleanTree();legacyNotice(v);}
  console.info('[REVEX] viewer r29 installed',{exactRvxPrimary:true,fbxCompatibilityOnly:true,identityFbxRotation:true,referenceFiltering:true,solidViewport:true});
}
function wait(){const v=window.__revexViewerR26Instance;if(!v){setTimeout(wait,25);return}install(v)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wait,{once:true});else wait();
