(function(root){
  'use strict';
  const BUILD='20260817r110-docs-core1';
  const Store=root.RevexStore;
  if(!Store||root.__revexSyncDocsR24) return;
  root.__revexSyncDocsR24=true;

  const safe=v=>String(v||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=v=>safe(v).replace(/\./g,'_');
  const clone=v=>JSON.parse(JSON.stringify(v===undefined?null:v));
  const byName=(files,name)=>files.find(f=>String(f.name||'').toLowerCase()===String(name||'').toLowerCase())||null;
  const readJson=async file=>file?JSON.parse(await file.text()):null;
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmt=value=>{
    if(!value)return '—';
    const date=value?.toDate?value.toDate():new Date(value);
    return Number.isNaN(date.getTime())?'—':date.toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
  };

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
    return{...page,singlePageLocalUrl:single?URL.createObjectURL(single):null,singlePageSize:single?.size||null};
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
        page:Number(page.page)||1,kind:page.kind||'sheet',sheetId:page.sheetId??null,
        sheetUniqueId:page.sheetUniqueId||null,sheetNumber:page.sheetNumber||'',sheetName:page.sheetName||'',
        currentRevision:page.currentRevision||null,singlePageFileName:page.singlePageFileName||null,
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
        id:`source_${docId(result.revision)}`,sourceRevision:result.revision,kind:'source-revision',operation:'sync',
        label:`Revit revision ${result.revision}`,affectedElementIds:[],affectedUniqueIds:[],affectedLevels:[],
        affectedViews:(affected?.views||[]).map(v=>v.name).filter(Boolean),before:null,
        after:{revision:result.revision,scheduleCount:result.integrity?.counts?.schedules||null,elementCount:result.integrity?.counts?.elements||null,affectedPlanViews:affected?.views?.length||0},
        note:'Atomic REVEX source revision: BIM, Design Book, Spec Book, Docs and affected native Revit plan exports.'
      });
    }catch(e){console.warn('[REVEX r110 Docs] source history',e);}

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
        type:'file',hidden:false,name:`${set.name||'Printing Set'} · ${result.revision}.pdf`,
        storagePath:uploaded.path,folderPath:'record_out/printing_sets',size:file.size,mimeType:'application/pdf',
        source:'revex-revit-printing-set',editable:false,revexDocKind:'printing-set',printingSetId:set.id||null,
        printingSetName:set.name||'Printing Set',revision:result.revision,sheetIndex,createdAt:at,updatedAt:at,createdBy:Store.user.uid
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
          id:`plan_${docId(view.uniqueId||view.id||view.name)}_${docId(result.revision)}`,sourceRevision:result.revision,
          kind:'derived-plan',operation:'native-revit-export',label:`Updated plan · ${view.name||'Plan'}`,
          affectedElementIds:view.changedElementIds||[],affectedUniqueIds:[],affectedLevels:view.levelName?[view.levelName]:[],
          affectedViews:view.name?[view.name]:[],before:null,after:{libraryId:id,storagePath:uploaded.path},
          note:'Native Revit plan export generated from the same authoritative REVEX source revision.'
        });
      }catch(e){console.warn('[REVEX r110 Docs] plan history',e);}
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

  function state(){return root.__revexState||null;}
  function matches(text){
    const q=String(document.getElementById('docs-search')?.value||'').trim().toLowerCase();
    return !q||String(text||'').toLowerCase().includes(q);
  }
  function label(file){
    if(file.revexDocKind==='printing-set')return `${file.printingSetName||file.name} ${file.revision||''}`;
    return `${file.name||'file'} ${file.folderPath||''}`;
  }
  function legacySheet(file){
    const kind=String(file?.revexDocKind||'').toLowerCase();
    const folder=String(file?.folderPath||'').toLowerCase();
    return kind==='printing-sheet'||kind==='printing-set-sheet'||kind==='revit-printing-sheet'||
      folder.includes('printing_sets/sheets')||folder.includes('printing-sets/sheets');
  }
  function sheetKey(sheet){
    return String(sheet?.sheetUniqueId||sheet?.sheetId||sheet?.sheetNumber||`page:${Number(sheet?.page)||1}`);
  }
  function sameSetRevision(file,row){
    const revisionMatch=!file.revision||!row.revision||String(file.revision)===String(row.revision)||String(file.revision)===String(row.sourceRevision);
    const idMatch=file.printingSetId&&row.printingSetId&&String(file.printingSetId)===String(row.printingSetId);
    const nameMatch=file.printingSetName&&row.printingSetName&&String(file.printingSetName)===String(row.printingSetName);
    return revisionMatch&&(idMatch||nameMatch);
  }
  function projectedPrintingRows(rows){
    const printing=rows.filter(file=>file.revexDocKind==='printing-set').map(file=>({...file,sheetIndex:(file.sheetIndex||[]).map(sheet=>({...sheet}))}));
    const legacy=rows.filter(legacySheet);
    for(const file of printing){
      const seen=new Set((file.sheetIndex||[]).map(sheetKey));
      for(const row of legacy){
        if(!sameSetRevision(file,row))continue;
        const sheet={
          page:Number(row.page||row.sheetPage||row.pageNumber)||1,kind:'sheet',sheetId:row.sheetId??null,
          sheetUniqueId:row.sheetUniqueId||null,sheetNumber:row.sheetNumber||'',sheetName:row.sheetName||row.name||'',
          currentRevision:row.currentRevision||row.sheetRevision||null,
          singlePageStoragePath:row.singlePageStoragePath||row.storagePath||null,
          singlePageUrl:row.singlePageUrl||row.localUrl||row.url||null,
          legacyLibraryId:row.id||null
        };
        const key=sheetKey(sheet);
        if(seen.has(key))continue;
        seen.add(key);file.sheetIndex.push(sheet);
      }
      file.sheetIndex.sort((a,b)=>(Number(a.page)||0)-(Number(b.page)||0));
    }
    return printing;
  }

  async function isolatedSheetUrl(sheet){
    if(sheet?.singlePageLocalUrl)return sheet.singlePageLocalUrl;
    if(sheet?.singlePageUrl)return sheet.singlePageUrl;
    if(sheet?.singlePageStoragePath&&typeof Store.fileUrl==='function')return Store.fileUrl(sheet.singlePageStoragePath);
    return null;
  }
  function ensureShareButton(){
    let button=document.getElementById('docs-share-sheet');
    if(button)return button;
    const open=document.getElementById('docs-open-external');
    if(!open?.parentElement)return null;
    button=document.createElement('button');
    button.id='docs-share-sheet';button.type='button';button.className='button ghost compact';button.textContent='Share sheet PDF';button.hidden=true;
    open.parentElement.insertBefore(button,open);
    button.addEventListener('click',event=>{event.preventDefault();void shareSelectedSheet();});
    return button;
  }

  async function selectDocument(file,page=null,sheet=null){
    const s=state();if(!s)return;
    const frame=document.getElementById('docs-frame'),empty=document.getElementById('docs-empty');
    const pageNumber=page?Number(page):null;
    const isolated=sheet?await isolatedSheetUrl(sheet):null;
    const full=file.localUrl||file.url||(file.storagePath&&typeof Store.fileUrl==='function'?await Store.fileUrl(file.storagePath):null);
    if(!isolated&&!full)throw new Error('Document URL is unavailable.');
    const url=isolated||full;
    s.docSelection={file,page:isolated?null:pageNumber,sourcePage:pageNumber,sheet:sheet||null,url,isolatedSheetUrl:isolated||null,mode:isolated?'isolated-sheet-pdf':'document'};
    const title=document.getElementById('docs-preview-title');
    const meta=document.getElementById('docs-preview-meta');
    if(title)title.textContent=sheet?`${sheet.sheetNumber||`Page ${pageNumber||1}`} · ${sheet.sheetName||''}`:(file.printingSetName||file.revitViewName||file.name||'Document');
    if(meta)meta.textContent=[file.revision?`REVEX ${file.revision}`:null,sheet?.currentRevision?`Sheet revision ${sheet.currentRevision}`:null,isolated?'single-page PDF':pageNumber?`page ${pageNumber}`:null,file.source==='manual'?'manual file':null].filter(Boolean).join(' · ')||'Project document';
    const copy=document.getElementById('docs-copy-ref');if(copy)copy.disabled=false;
    const external=document.getElementById('docs-open-external');if(external)external.disabled=false;
    const share=ensureShareButton();if(share)share.hidden=!isolated;
    if(frame){frame.src=isolated?url:(pageNumber?`${url}#page=${pageNumber}`:url);frame.hidden=false;}
    if(empty)empty.hidden=true;
    renderLibrary();
  }

  function manualGroup(title,files){
    const visible=files.filter(file=>matches(label(file)));
    if(!visible.length)return '';
    return `<section class="docs-group"><h3>${esc(title)}<small>${visible.length}</small></h3>${visible.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).map(file=>`<button type="button" class="docs-node ${state()?.docSelection?.file?.id===file.id&&!state()?.docSelection?.sheet?'active':''}" data-doc-id="${esc(file.id)}"><span>${esc(file.name||'file')}</span><small>${esc(fmt(file.createdAt))}</small></button>`).join('')}</section>`;
  }
  function affectedGroup(files){
    const visible=files.filter(file=>matches(label(file)));
    if(!visible.length)return '';
    return `<section class="docs-group"><h3>Affected Plans<small>${visible.length}</small></h3>${visible.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).map(file=>`<button type="button" class="docs-node ${state()?.docSelection?.file?.id===file.id?'active':''}" data-doc-id="${esc(file.id)}"><span>${esc(file.revitViewName||file.name||'Plan')}</span><small>${esc(file.revision||fmt(file.createdAt))}</small></button>`).join('')}</section>`;
  }

  function renderLibrary(){
    const s=state(),host=document.getElementById('docs-tree');if(!s||!host)return;
    const rows=[...(s.library||[])];
    const printing=projectedPrintingRows(rows);
    const legacyIds=new Set(rows.filter(legacySheet).map(row=>String(row.id||'')));
    const affected=rows.filter(file=>file.revexDocKind==='affected-revit-plan');
    const manualIn=rows.filter(file=>file.revexDocKind!=='printing-set'&&!legacyIds.has(String(file.id||''))&&file.revexDocKind!=='affected-revit-plan'&&String(file.folderPath||'').startsWith('record_in'));
    const manualOut=rows.filter(file=>file.revexDocKind!=='printing-set'&&!legacyIds.has(String(file.id||''))&&file.revexDocKind!=='affected-revit-plan'&&String(file.folderPath||'').startsWith('record_out'));
    const bySet=new Map();
    printing.forEach(file=>{const key=file.printingSetId||file.printingSetName||file.name;if(!bySet.has(key))bySet.set(key,[]);bySet.get(key).push(file);});
    const selection=s.docSelection;
    const selectedPage=Number(selection?.sourcePage||selection?.page)||null;
    const printHtml=[...bySet.values()].map(revisions=>{
      revisions.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
      const latest=revisions[0];
      const allText=`${latest.printingSetName||''} ${revisions.flatMap(row=>(row.sheetIndex||[]).map(p=>`${p.sheetNumber} ${p.sheetName}`)).join(' ')}`;
      if(!matches(allText))return '';
      return `<section class="docs-group printing-set"><h3>${esc(latest.printingSetName||'Printing Set')}<small>${revisions.length} revision${revisions.length===1?'':'s'}</small></h3>${revisions.map((file,ri)=>{
        const selected=selection?.file?.id===file.id;
        return `<details ${ri===0||selected?'open':''}><summary><span>${ri===0?'Current':'Revision'} · ${esc(file.revision||fmt(file.createdAt))}</span><small>${(file.sheetIndex||[]).length} sheets</small></summary><button type="button" class="docs-node whole ${selected&&!selection?.sheet?'active':''}" data-doc-id="${esc(file.id)}"><span>Full document</span><small>PDF</small></button>${(file.sheetIndex||[]).map(sheet=>`<button type="button" class="docs-node sheet ${selected&&selectedPage===Number(sheet.page)?'active':''}" data-doc-id="${esc(file.id)}" data-page="${Number(sheet.page)||1}"><b>${esc(sheet.sheetNumber||String(sheet.page))}</b><span>${esc(sheet.sheetName||'Sheet')}</span><small>${sheet.singlePageStoragePath||sheet.singlePageUrl||sheet.singlePageLocalUrl?'PDF':'p.'+(Number(sheet.page)||1)}</small></button>`).join('')}</details>`;
      }).join('')}</section>`;
    }).join('');
    host.innerHTML=printHtml+affectedGroup(affected)+manualGroup('Record In',manualIn)+manualGroup('Record Out',manualOut)||'<div class="file-empty">No matching project documents.</div>';
    host.querySelectorAll('.docs-node').forEach(button=>button.addEventListener('click',()=>{
      const file=printing.find(row=>String(row.id)===String(button.dataset.docId))||rows.find(row=>String(row.id)===String(button.dataset.docId));if(!file)return;
      const page=button.dataset.page?Number(button.dataset.page):null;
      const sheet=page?(file.sheetIndex||[]).find(row=>Number(row.page)===page):null;
      void selectDocument(file,page,sheet).catch(error=>{
        const frame=document.getElementById('docs-frame'),empty=document.getElementById('docs-empty');
        if(frame){frame.removeAttribute('src');frame.hidden=true;}if(empty){empty.hidden=false;empty.textContent=error.message||'Could not open document.';}
      });
    }));
  }

  async function shareSelectedSheet(){
    const sel=state()?.docSelection,url=sel?.isolatedSheetUrl;if(!url||!sel?.sheet)return;
    const name=safe(`${sel.sheet.sheetNumber||'sheet'}_${sel.sheet.sheetName||''}.pdf`);
    try{
      const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(`Sheet PDF returned ${response.status}`);
      const blob=await response.blob(),file=new File([blob],name,{type:'application/pdf'});
      if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({title:sel.sheet.sheetNumber||'REVEX sheet',files:[file]});return;}
      if(navigator.clipboard)await navigator.clipboard.writeText(url);else root.open(url,'_blank','noopener');
    }catch(error){console.warn('[REVEX r110 Docs] share sheet PDF',error);root.open(url,'_blank','noopener');}
  }

  function installDocsCore(){
    ensureShareButton();
    root.selectDocument=selectDocument;
    root.renderLibrary=renderLibrary;
    const search=document.getElementById('docs-search');
    if(search&&!search.dataset.revexR110Docs){
      search.dataset.revexR110Docs='1';
      search.addEventListener('input',()=>queueMicrotask(renderLibrary));
    }
    renderLibrary();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installDocsCore,{once:true});
  else installDocsCore();

  console.log('[REVEX] sync Docs '+BUILD,{
    revisionedPrintingSets:true,singlePageSheetPdfs:true,isolatedSheetViewer:true,isolatedSheetShare:true,
    legacySheetProjection:'render-only',nativeAffectedPlans:true,appendOnlyHistory:true,manualDocsPreserved:true,
    globalClickInterception:false,mutationObservers:false
  });
})(window);
