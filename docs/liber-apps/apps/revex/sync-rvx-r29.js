(function(root){
'use strict';
const Store=root.RevexStore;if(!Store||Store.__revexRvxR29)return;Store.__revexRvxR29=true;
const previous=Store.syncPackage.bind(Store),safe=s=>String(s||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
Store.syncPackage=async function(fileList,preferredProjectId,preferredSpecProjectId){
  const files=Array.from(fileList||[]),rvx=files.find(f=>/\.rvxmesh\.gz$/i.test(f.name))||null,fbx=files.find(f=>/\.fbx$/i.test(f.name))||null,affected=files.find(f=>/^affected-plan-views\.json$/i.test(f.name))||null;
  const result=await previous(fileList,preferredProjectId,preferredSpecProjectId);
  if(!rvx){
    console.warn('[REVEX r29] revision has no model.rvxmesh.gz; compatibility geometry remains active');
    return result;
  }
  const localRvx=URL.createObjectURL(rvx),fallback=result?.modelFormat==='fbx'?result.modelUrl:(fbx?URL.createObjectURL(fbx):(result?.fallbackModelUrl||null));
  if(!result?.cloud||!Store.fs?.storage||!Store.api||!Store.db){
    return {...result,modelUrl:localRvx,modelFormat:'rvxmesh-gzip',fallbackModelUrl:fallback};
  }
  const f=Store.api,projectId=result.projectId||preferredProjectId,revision=result.revision||`rev_${Date.now()}`;
  const uploadOne=async(file,label)=>{const path=`projects/${projectId}/library/revex/revisions/${safe(revision)}/${Date.now()}_${safe(file.name)}`;const ref=f.ref(Store.fs.storage,path);await f.uploadBytes(ref,file,{contentType:file.type||'application/octet-stream'});return{path,url:await f.getDownloadURL(ref),label};};
  const mesh=await uploadOne(rvx,'rvxmesh'),plan=affected?await uploadOne(affected,'affected-plans'):null;
  const statePatch={modelUrl:mesh.url,modelPath:mesh.path,modelFormat:'rvxmesh-gzip',fallbackModelUrl:fallback,updatedAt:new Date().toISOString()};
  if(plan){statePatch.affectedPlansUrl=plan.url;statePatch.affectedPlansPath=plan.path;}
  const stateRef=f.doc(Store.db,'projects',projectId,'library','revex_state');await f.setDoc(stateRef,statePatch,{merge:true});
  const revRef=f.doc(Store.db,'projects',projectId,'library',`revex_revision_${safe(revision).replace(/\./g,'_')}`);await f.setDoc(revRef,statePatch,{merge:true});
  const merged={...result,...statePatch,cloud:true};root.__revexCloudState={...(root.__revexCloudState||{}),...statePatch};
  console.info('[REVEX] RVX controlled-sync repair 20260811r29',{projectId,revision,modelPath:mesh.path,fbxFallback:!!fallback});
  return merged;
};
console.info('[REVEX] sync RVX r29 installed',{controlledSyncOverrideRepair:true,rvxPreferred:true});
})(window);
