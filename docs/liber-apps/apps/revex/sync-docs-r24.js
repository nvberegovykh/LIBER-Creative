(function(root){
  'use strict';
  const BUILD='20260811r27';
  const Store=root.RevexStore;
  if(!Store||root.__revexSyncDocsR24) return;
  root.__revexSyncDocsR24=true;
  const safe=v=>String(v||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=v=>safe(v).replace(/\./g,'_');
  const clone=v=>JSON.parse(JSON.stringify(v===undefined?null:v));
  const byName=(files,name)=>files.find(f=>String(f.name||'').toLowerCase()===String(name||'').toLowerCase())||null;
  const readJson=async file=>file?JSON.parse(await file.text()):null;
  function post(stage,detail={}){try{root.chrome?.webview?.postMessage({type:'liber:revex-sync-progress',stage,build:BUILD,...detail});}catch(_){}}
  async function upload(projectId,revision,file,lane){
    const path=`projects/${projectId}/library/revex/revisions/${revision}/${lane}/${safe(file.name)}`;
    const ref=Store.api.ref(Store.fs.storage,path);post('docs-upload-start',{path,bytes:file.size});
    await Store.api.uploadBytes(ref,file,clone({contentType:file.type||'application/pdf'}));
    post('docs-upload-complete',{path,bytes:file.size});return{path,url:await Store.api.getDownloadURL(ref)};
  }
  function localPrinting(manifest,files){return(manifest?.sets||[]).map(set=>{const file=byName(files,set.fileName);return file?{name:file.name,size:file.size,url:URL.createObjectURL(file),set}:null}).filter(Boolean)}
  function localAffected(manifest,files){return(manifest?.views||[]).map(view=>{const file=byName(files,view.fileName);return file?{name:file.name,size:file.size,url:URL.createObjectURL(file),view}:null}).filter(Boolean)}
  const original=Store.syncPackage.bind(Store);
  Store.syncPackage=async function(fileList,preferredProjectId,preferredSpecProjectId){
    const files=Array.from(fileList||[]);
    const printing=await readJson(byName(files,'printing-sets.json')).catch(()=>null);
    const affected=await readJson(byName(files,'affected-plan-views.json')).catch(()=>null);
    const result=await original(fileList,preferredProjectId,preferredSpecProjectId);
    result.printingSets=printing;result.printingDocs=localPrinting(printing,files);
    result.affectedPlans=affected;result.affectedPlanDocs=localAffected(affected,files);
    const announce=()=>{try{root.dispatchEvent(new CustomEvent('revex:r24-revision',{detail:{projectId:result.projectId,revision:result.revision,cloud:!!result.cloud,affectedPlanViews:affected?.views?.length||0}}))}catch(_){}};
    try{await Store.appendHistory(result.projectId,{id:`source_${docId(result.revision)}`,sourceRevision:result.revision,kind:'source-revision',operation:'sync',label:`Revit revision ${result.revision}`,affectedElementIds:[],affectedUniqueIds:[],affectedLevels:[],affectedViews:(affected?.views||[]).map(v=>v.name).filter(Boolean),before:null,after:{revision:result.revision,scheduleCount:result.integrity?.counts?.schedules||null,elementCount:result.integrity?.counts?.elements||null,affectedPlanViews:affected?.views?.length||0},note:'Atomic REVEX source revision: BIM, Design Book, Spec Book, Docs and affected native Revit plan exports.'})}catch(e){console.warn('[REVEX r24] source history',e)}
    if(!result.cloud||!Store.isCloud()||!Store.user?.uid||!Store.fs?.storage){post('docs-local-preview',{printingSets:printing?.sets?.length||0,affectedPlans:affected?.views?.length||0});announce();return result}
    const printingRecords=[];
    for(const set of printing?.sets||[]){const file=byName(files,set.fileName);if(!file)continue;const uploaded=await upload(result.projectId,result.revision,file,'printing-sets');const id=`revex_print_${docId(set.id||set.name)}_${docId(result.revision)}`;const at=result.syncedAt||new Date().toISOString();const data=clone({type:'file',hidden:false,name:`${set.name||'Printing Set'} · ${result.revision}.pdf`,storagePath:uploaded.path,folderPath:'record_out/printing_sets',size:file.size,mimeType:'application/pdf',source:'revex-revit-printing-set',editable:false,revexDocKind:'printing-set',printingSetId:set.id||null,printingSetName:set.name||'Printing Set',revision:result.revision,sheetIndex:(set.pages||[]).map(p=>({page:Number(p.page)||1,kind:p.kind||'sheet',sheetId:p.sheetId??null,sheetUniqueId:p.sheetUniqueId||null,sheetNumber:p.sheetNumber||'',sheetName:p.sheetName||'',currentRevision:p.currentRevision||null})),createdAt:at,updatedAt:at,createdBy:Store.user.uid});await Store.api.setDoc(Store.api.doc(Store.db,'projects',result.projectId,'library',id),data,clone({merge:true}));printingRecords.push({id,...data,url:uploaded.url})}
    result.printingDocs=printingRecords;
    const affectedRecords=[];
    for(const view of affected?.views||[]){const file=byName(files,view.fileName);if(!file)continue;const uploaded=await upload(result.projectId,result.revision,file,'affected-plans');const id=`revex_plan_${docId(view.uniqueId||view.id||view.name)}_${docId(result.revision)}`;const at=result.syncedAt||new Date().toISOString();const data=clone({type:'file',hidden:false,name:`${view.name||'Affected Plan'} · ${result.revision}.pdf`,storagePath:uploaded.path,folderPath:'record_out/affected_plans',size:file.size,mimeType:'application/pdf',source:'revex-revit-affected-plan',editable:false,revexDocKind:'affected-revit-plan',revitViewId:view.id??null,revitViewUniqueId:view.uniqueId||null,revitViewName:view.name||'',levelId:view.levelId??null,levelUniqueId:view.levelUniqueId||null,levelName:view.levelName||null,changedElementIds:view.changedElementIds||[],reason:view.reason||'',revision:result.revision,createdAt:at,updatedAt:at,createdBy:Store.user.uid});await Store.api.setDoc(Store.api.doc(Store.db,'projects',result.projectId,'library',id),data,clone({merge:true}));affectedRecords.push({id,...data,url:uploaded.url});try{await Store.appendHistory(result.projectId,{id:`plan_${docId(view.uniqueId||view.id||view.name)}_${docId(result.revision)}`,sourceRevision:result.revision,kind:'derived-plan',operation:'native-revit-export',label:`Updated plan · ${view.name||'Plan'}`,affectedElementIds:view.changedElementIds||[],affectedUniqueIds:[],affectedLevels:view.levelName?[view.levelName]:[],affectedViews:view.name?[view.name]:[],before:null,after:{libraryId:id,storagePath:uploaded.path},note:'Native Revit plan export generated from the same authoritative REVEX source revision.'})}catch(e){console.warn('[REVEX r24] plan history',e)}}
    result.affectedPlanDocs=affectedRecords;
    post('docs-index-complete',{printingSets:printingRecords.length,printingPages:printingRecords.reduce((n,r)=>n+(r.sheetIndex?.length||0),0),affectedPlans:affectedRecords.length});announce();return result;
  };
  console.log('[REVEX] sync Docs '+BUILD,{revisionedPrintingSets:true,nativeAffectedPlans:true,appendOnlyHistory:true,manualDocsPreserved:true});
})(window);
