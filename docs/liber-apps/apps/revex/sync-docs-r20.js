(function(root){
  'use strict';
  const BUILD='20260810r20';
  const Store=root.RevexStore;
  if(!Store||root.__revexSyncDocsR20) return;
  root.__revexSyncDocsR20=true;
  const safe=(v)=>String(v||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=(v)=>safe(v).replace(/\./g,'_');
  const clone=(v)=>JSON.parse(JSON.stringify(v===undefined?null:v));
  const byName=(files,name)=>files.find(f=>String(f.name||'').toLowerCase()===String(name||'').toLowerCase())||null;
  const readJson=async(file)=>file?JSON.parse(await file.text()):null;
  function post(stage,detail={}){try{root.chrome?.webview?.postMessage({type:'liber:revex-sync-progress',stage,build:BUILD,...detail});}catch(_){}}
  async function upload(projectId,revision,file){
    const path=`projects/${projectId}/library/revex/revisions/${revision}/printing-sets/${safe(file.name)}`;
    const ref=Store.api.ref(Store.fs.storage,path); post('docs-upload-start',{path,bytes:file.size});
    await Store.api.uploadBytes(ref,file,clone({contentType:'application/pdf'}));
    post('docs-upload-complete',{path,bytes:file.size});
    return {path,url:await Store.api.getDownloadURL(ref)};
  }
  function localDocs(manifest,files){
    return (manifest?.sets||[]).map(set=>{const file=byName(files,set.fileName);return file?{name:file.name,size:file.size,url:URL.createObjectURL(file),set}:null;}).filter(Boolean);
  }
  const original=Store.syncPackage.bind(Store);
  Store.syncPackage=async function(fileList,preferredProjectId,preferredSpecProjectId){
    const files=Array.from(fileList||[]), manifestFile=byName(files,'printing-sets.json');
    const manifest=await readJson(manifestFile).catch(()=>null);
    const result=await original(fileList,preferredProjectId,preferredSpecProjectId);
    result.printingSets=manifest;
    result.printingDocs=localDocs(manifest,files);
    if(!manifest?.sets?.length) return result;
    if(!result.cloud||!Store.isCloud()||!Store.user?.uid||!Store.fs?.storage){
      post('docs-local-preview',{sets:manifest.sets.length}); return result;
    }
    const records=[];
    for(const set of manifest.sets){
      const file=byName(files,set.fileName); if(!file) continue;
      const uploaded=await upload(result.projectId,result.revision,file);
      const id=`revex_print_${docId(set.id||set.name)}_${docId(result.revision)}`;
      const at=result.syncedAt||new Date().toISOString();
      const data=clone({
        type:'file',hidden:false,name:`${set.name||'Printing Set'} · ${result.revision}.pdf`,storagePath:uploaded.path,
        folderPath:'record_out/printing_sets',size:file.size,mimeType:'application/pdf',source:'revex-revit-printing-set',editable:false,
        revexDocKind:'printing-set',printingSetId:set.id||null,printingSetName:set.name||'Printing Set',revision:result.revision,
        sheetIndex:(set.pages||[]).map(p=>({page:Number(p.page)||1,kind:p.kind||'sheet',sheetId:p.sheetId??null,sheetUniqueId:p.sheetUniqueId||null,sheetNumber:p.sheetNumber||'',sheetName:p.sheetName||'',currentRevision:p.currentRevision||null})),
        createdAt:at,updatedAt:at,createdBy:Store.user.uid
      });
      await Store.api.setDoc(Store.api.doc(Store.db,'projects',result.projectId,'library',id),data,clone({merge:true}));
      records.push({id,...data,url:uploaded.url});
    }
    result.printingDocs=records;
    post('docs-index-complete',{sets:records.length,pages:records.reduce((n,r)=>n+(r.sheetIndex?.length||0),0)});
    return result;
  };
  console.log('[REVEX] sync Docs '+BUILD,{revisionedPrintingSets:true,manualDocsPreserved:true});
})(window);
