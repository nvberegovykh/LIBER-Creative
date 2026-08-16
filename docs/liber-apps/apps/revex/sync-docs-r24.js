(function(root){
  'use strict';
  const BUILD='20260816r64-sheet-pdf1';
  const Store=root.RevexStore;
  if(!Store||root.__revexSyncDocsR24) return;
  root.__revexSyncDocsR24=true;

  const safe=v=>String(v||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=v=>safe(v).replace(/\./g,'_');
  const clone=v=>JSON.parse(JSON.stringify(v===undefined?null:v));
  const byName=(files,name)=>files.find(f=>String(f.name||'').toLowerCase()===String(name||'').toLowerCase())||null;
  const readJson=async file=>file?JSON.parse(await file.text()):null;

  function post(stage,detail={}){
    try{root.chrome?.webview?.postMessage({type:'liber:revex-sync-progress',stage,build:BUILD,...detail});}catch(_){}
  }

  async function upload(projectId,revision,file,lane){
    const path=`projects/${projectId}/library/revex/revisions/${revision}/${lane}/${safe(file.name)}`;
    const ref=Store.api.ref(Store.fs.storage,path);
    post('docs-upload-start',{path,bytes:file.size});
    await Store.api.uploadBytes(ref,file,clone({contentType:file.type||'application/pdf'}));
    post('docs-upload-complete',{path,bytes:file.size});
    return{path,url:await Store.api.getDownloadURL(ref)};
  }

  function pageWithLocalPdf(page,files){
    const single=page?.singlePageFileName?byName(files,page.singlePageFileName):null;
    return{
      ...page,
      singlePageLocalUrl:single?URL.createObjectURL(single):null,
      singlePageSize:single?.size||null
    };
  }

  function localPrinting(manifest,files){
    return(manifest?.sets||[]).map(set=>{
      const file=byName(files,set.fileName);
      if(!file)return null;
      const pages=(set.pages||[]).map(page=>pageWithLocalPdf(page,files));
      return{name:file.name,size:file.size,url:URL.createObjectURL(file),set:{...set,pages}};
    }).filter(Boolean);
  }

  function localAffected(manifest,files){
    return(manifest?.views||[]).map(view=>{
      const file=byName(files,view.fileName);
      return file?{name:file.name,size:file.size,url:URL.createObjectURL(file),view}:null;
    }).filter(Boolean);
  }

  async function publishSheetPages(projectId,revision,set,files){
    const out=[];
    for(const page of set.pages||[]){
      const row={
        page:Number(page.page)||1,
        kind:page.kind||'sheet',
        sheetId:page.sheetId??null,
        sheetUniqueId:page.sheetUniqueId||null,
        sheetNumber:page.sheetNumber||'',
        sheetName:page.sheetName||'',
        currentRevision:page.currentRevision||null,
        singlePageFileName:page.singlePageFileName||null,
        singlePagePdf:page.singlePagePdf||null
      };
      if(page.singlePageFileName){
        const single=byName(files,page.singlePageFileName);
        if(!single) throw new Error(`REVEX printing set is missing required single-page PDF ${page.singlePageFileName}. Re-sync this Revit revision.`);
        const uploaded=await upload(projectId,revision,single,`printing-sets/sheets/${safe(set.id||set.name||'set')}`);
        row.singlePageStoragePath=uploaded.path;
        row.singlePageSize=single.size;
      }
      out.push(row);
    }
    return out;
  }

  const original=Store.syncPackage.bind(Store);
  Store.syncPackage=async function(fileList,preferredProjectId,preferredSpecProjectId){
    const files=Array.from(fileList||[]);
    const printing=await readJson(byName(files,'printing-sets.json')).catch(()=>null);
    const affected=await readJson(byName(files,'affected-plan-views.json')).catch(()=>null);
    const result=await original(fileList,preferredProjectId,preferredSpecProjectId);
    result.printingSets=printing;
    result.printingDocs=localPrinting(printing,files);
    result.affectedPlans=affected;
    result.affectedPlanDocs=localAffected(affected,files);

    const announce=()=>{
      try{root.dispatchEvent(new CustomEvent('revex:r24-revision',{detail:{projectId:result.projectId,revision:result.revision,cloud:!!result.cloud,affectedPlanViews:affected?.views?.length||0}}));}catch(_){}
    };
    try{
      await Store.appendHistory(result.projectId,{
        id:`source_${docId(result.revision)}`,
        sourceRevision:result.revision,
        kind:'source-revision',operation:'sync',label:`Revit revision ${result.revision}`,
        affectedElementIds:[],affectedUniqueIds:[],affectedLevels:[],
        affectedViews:(affected?.views||[]).map(v=>v.name).filter(Boolean),
        before:null,
        after:{revision:result.revision,scheduleCount:result.integrity?.counts?.schedules||null,elementCount:result.integrity?.counts?.elements||null,affectedPlanViews:affected?.views?.length||0},
        note:'Atomic REVEX source revision: BIM, Design Book, Spec Book, Docs and affected native Revit plan exports.'
      });
    }catch(e){console.warn('[REVEX r64] source history',e);}

    if(!result.cloud||!Store.isCloud()||!Store.user?.uid||!Store.fs?.storage){
      post('docs-local-preview',{printingSets:printing?.sets?.length||0,affectedPlans:affected?.views?.length||0});
      announce();
      return result;
    }

    const printingRecords=[];
    for(const set of printing?.sets||[]){
      const file=byName(files,set.fileName);
      if(!file)continue;
      const uploaded=await upload(result.projectId,result.revision,file,'printing-sets');
      const id=`revex_print_${docId(set.id||set.name)}_${docId(result.revision)}`;
      const at=result.syncedAt||new Date().toISOString();
      const sheetIndex=await publishSheetPages(result.projectId,result.revision,set,files);
      const data=clone({
        type:'file',hidden:false,
        name:`${set.name||'Printing Set'} · ${result.revision}.pdf`,
        storagePath:uploaded.path,folderPath:'record_out/printing_sets',size:file.size,mimeType:'application/pdf',
        source:'revex-revit-printing-set',editable:false,revexDocKind:'printing-set',
        printingSetId:set.id||null,printingSetName:set.name||'Printing Set',revision:result.revision,
        sheetIndex,createdAt:at,updatedAt:at,createdBy:Store.user.uid
      });
      await Store.api.setDoc(Store.api.doc(Store.db,'projects',result.projectId,'library',id),data,clone({merge:true}));
      printingRecords.push({id,...data,url:uploaded.url});
    }
    result.printingDocs=printingRecords;

    const affectedRecords=[];
    for(const view of affected?.views||[]){
      const file=byName(files,view.fileName);
      if(!file)continue;
      const uploaded=await upload(result.projectId,result.revision,file,'affected-plans');
      const id=`revex_plan_${docId(view.uniqueId||view.id||view.name)}_${docId(result.revision)}`;
      const at=result.syncedAt||new Date().toISOString();
      const data=clone({
        type:'file',hidden:false,name:`${view.name||'Affected Plan'} · ${result.revision}.pdf`,
        storagePath:uploaded.path,folderPath:'record_out/affected_plans',size:file.size,mimeType:'application/pdf',
        source:'revex-revit-affected-plan',editable:false,revexDocKind:'affected-revit-plan',
        revitViewId:view.id??null,revitViewUniqueId:view.uniqueId||null,revitViewName:view.name||'',
        levelId:view.levelId??null,levelUniqueId:view.levelUniqueId||null,levelName:view.levelName||null,
        changedElementIds:view.changedElementIds||[],reason:view.reason||'',revision:result.revision,
        createdAt:at,updatedAt:at,createdBy:Store.user.uid
      });
      await Store.api.setDoc(Store.api.doc(Store.db,'projects',result.projectId,'library',id),data,clone({merge:true}));
      affectedRecords.push({id,...data,url:uploaded.url});
      try{
        await Store.appendHistory(result.projectId,{
          id:`plan_${docId(view.uniqueId||view.id||view.name)}_${docId(result.revision)}`,
          sourceRevision:result.revision,kind:'derived-plan',operation:'native-revit-export',
          label:`Updated plan · ${view.name||'Plan'}`,affectedElementIds:view.changedElementIds||[],
          affectedUniqueIds:[],affectedLevels:view.levelName?[view.levelName]:[],affectedViews:view.name?[view.name]:[],
          before:null,after:{libraryId:id,storagePath:uploaded.path},
          note:'Native Revit plan export generated from the same authoritative REVEX source revision.'
        });
      }catch(e){console.warn('[REVEX r64] plan history',e);}
    }
    result.affectedPlanDocs=affectedRecords;
    post('docs-index-complete',{
      printingSets:printingRecords.length,
      printingPages:printingRecords.reduce((n,r)=>n+(r.sheetIndex?.length||0),0),
      isolatedSheetPdfs:printingRecords.reduce((n,r)=>n+(r.sheetIndex||[]).filter(p=>p.singlePageStoragePath).length,0),
      affectedPlans:affectedRecords.length
    });
    announce();
    return result;
  };

  function ensureShareButton(){
    let button=document.getElementById('docs-share-sheet');
    if(button)return button;
    const open=document.getElementById('docs-open-external');
    if(!open?.parentElement)return null;
    button=document.createElement('button');
    button.id='docs-share-sheet';
    button.type='button';
    button.className='button ghost compact';
    button.textContent='Share sheet PDF';
    button.hidden=true;
    open.parentElement.insertBefore(button,open);
    return button;
  }

  async function isolatedSheetUrl(sheet){
    if(sheet?.singlePageLocalUrl)return sheet.singlePageLocalUrl;
    if(sheet?.singlePageUrl)return sheet.singlePageUrl;
    if(sheet?.singlePageStoragePath&&typeof Store.fileUrl==='function')return Store.fileUrl(sheet.singlePageStoragePath);
    return null;
  }

  async function selectIsolatedSheet(button,event){
    const state=root.__revexState;
    const file=state?.library?.find(row=>String(row.id)===String(button.dataset.docId));
    if(!file)return false;
    const pageNumber=Number(button.dataset.page)||1;
    const sheet=(file.sheetIndex||[]).find(row=>Number(row.page)===pageNumber);
    const url=await isolatedSheetUrl(sheet);
    if(!sheet||!url)return false;

    event.preventDefault();
    event.stopImmediatePropagation();
    state.docSelection={file,page:pageNumber,sheet,url,isolatedSheetUrl:url,mode:'isolated-sheet-pdf'};
    const frame=document.getElementById('docs-frame');
    const empty=document.getElementById('docs-empty');
    const title=document.getElementById('docs-preview-title');
    const meta=document.getElementById('docs-preview-meta');
    if(title)title.textContent=`${sheet.sheetNumber||`Page ${pageNumber}`} · ${sheet.sheetName||''}`;
    if(meta)meta.textContent=[file.revision?`REVEX ${file.revision}`:null,sheet.currentRevision?`Sheet revision ${sheet.currentRevision}`:null,'single-page PDF'].filter(Boolean).join(' · ');
    if(frame){frame.src=url;frame.hidden=false;}
    if(empty)empty.hidden=true;
    const copy=document.getElementById('docs-copy-ref');if(copy)copy.disabled=false;
    const open=document.getElementById('docs-open-external');if(open)open.disabled=false;
    const share=ensureShareButton();if(share)share.hidden=false;
    document.querySelectorAll('.docs-node.active').forEach(node=>node.classList.remove('active'));
    button.classList.add('active');
    return true;
  }

  async function shareSelectedSheet(){
    const sel=root.__revexState?.docSelection;
    const url=sel?.isolatedSheetUrl;
    if(!url||!sel?.sheet)return;
    const name=safe(`${sel.sheet.sheetNumber||'sheet'}_${sel.sheet.sheetName||''}.pdf`);
    try{
      const response=await fetch(url,{cache:'no-store'});
      if(!response.ok)throw new Error(`Sheet PDF returned ${response.status}`);
      const blob=await response.blob();
      const file=new File([blob],name,{type:'application/pdf'});
      if(navigator.share&&navigator.canShare?.({files:[file]})){
        await navigator.share({title:sel.sheet.sheetNumber||'REVEX sheet',files:[file]});
        return;
      }
      if(navigator.clipboard){await navigator.clipboard.writeText(url);}
      else root.open(url,'_blank','noopener');
    }catch(error){console.warn('[REVEX r64] share sheet PDF',error);root.open(url,'_blank','noopener');}
  }

  function installDocsIsolation(){
    ensureShareButton();
    document.addEventListener('click',async event=>{
      const sheetButton=event.target.closest?.('.docs-node.sheet');
      if(sheetButton){
        try{if(await selectIsolatedSheet(sheetButton,event))return;}catch(error){console.warn('[REVEX r64] isolated sheet selection',error);}
      }
      const share=event.target.closest?.('#docs-share-sheet');
      if(share){event.preventDefault();event.stopImmediatePropagation();await shareSelectedSheet();return;}
      const external=event.target.closest?.('#docs-open-external');
      const sel=root.__revexState?.docSelection;
      if(external&&sel?.mode==='isolated-sheet-pdf'&&sel.isolatedSheetUrl){
        event.preventDefault();event.stopImmediatePropagation();root.open(sel.isolatedSheetUrl,'_blank','noopener');return;
      }
      const other=event.target.closest?.('.docs-node:not(.sheet)');
      if(other){const b=ensureShareButton();if(b)b.hidden=true;}
    },true);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installDocsIsolation,{once:true});
  else installDocsIsolation();

  console.log('[REVEX] sync Docs '+BUILD,{
    revisionedPrintingSets:true,
    singlePageSheetPdfs:true,
    isolatedSheetViewer:true,
    isolatedSheetShare:true,
    nativeAffectedPlans:true,
    appendOnlyHistory:true,
    manualDocsPreserved:true
  });
})(window);
