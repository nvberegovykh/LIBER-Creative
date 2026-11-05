(function(root){
  'use strict';
  const BUILD='20260909r191-sync-reader1';
  const Store=root.RevexStore;
  if(!Store||root.__revexSyncDocsR24) return;
  root.__revexSyncDocsR24=true;
  Store.revisionDocumentIdentity='manifest-path-sha256-size-v1';

  const safe=v=>String(v||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=v=>safe(v).replace(/\./g,'_');
  const clone=v=>JSON.parse(JSON.stringify(v===undefined?null:v));
  const readJson=async file=>file?JSON.parse(await file.text()):null;
  const readerUrl=new URL('./affected-index-worker.mjs?build=20260909r191-sync-reader1&v=20260914r192-morning1',document.currentScript?.src||root.location?.href||'http://localhost/');
  let cancelActiveIndexRead=null;
  const readerFailure=message=>Object.assign(new Error(message),{code:'revex/index-read'});
  Store.readAffectedDocumentIndex=function(file,expectedRevision,{assertCurrent=()=>{},signal}={}){
    if(!file)return Promise.resolve(null);
    cancelActiveIndexRead?.();
    return new Promise((resolve,reject)=>{
      let worker=null,timer=null,finished=false,unsubscribe=null;
      const cancel=()=>finish(readerFailure('The affected-plan index read was canceled. The preserved revision can be retried.'));
      const finish=(error,index)=>{
        if(finished)return;finished=true;
        worker?.terminate();clearTimeout(timer);unsubscribe?.();
        signal?.removeEventListener('abort',cancel);
        root.removeEventListener?.('revex:project-boundary',cancel);
        root.removeEventListener?.('pagehide',cancel);
        if(cancelActiveIndexRead===cancel)cancelActiveIndexRead=null;
        error?reject(error):resolve(index);
      };
      try{
        assertCurrent();
        if(signal?.aborted){cancel();return;}
        if(typeof root.Worker!=='function')throw readerFailure('This browser cannot safely read the affected-plan index. Open REVEX in a current supported browser; the preserved revision was not published.');
        worker=new root.Worker(readerUrl,{type:'module',name:'revex-affected-document-index'});
        cancelActiveIndexRead=cancel;
        signal?.addEventListener('abort',cancel,{once:true});
        root.addEventListener?.('revex:project-boundary',cancel);
        root.addEventListener?.('pagehide',cancel);
        if(typeof Store.api?.onAuthStateChanged==='function'&&Store.fs?.auth)
          unsubscribe=Store.api.onAuthStateChanged(Store.fs.auth,()=>{try{assertCurrent();}catch(error){finish(error);}});
        if(finished){unsubscribe?.();return;}
        worker.onmessage=event=>{
          try{
            if(finished)return;
            assertCurrent();if(signal?.aborted){cancel();return;}
            if(event.data?.type==='progress'){
              post('docs-index-reading',{bytes:event.data.bytes,total:event.data.total});
              if(!finished)worker.postMessage({type:'continue'});
            }else if(event.data?.type==='complete'){
              post('docs-index-read',{bytes:event.data.stats?.inputBytes,views:event.data.stats?.views});
              finish(null,event.data.index);
            }else if(event.data?.type==='failed'){
              // Never surface arbitrary worker/parser text or source excerpts.
              const kind=String(event.data.code||'');
              const message=kind==='revex/index-limits'?'The affected-plan index exceeds safe document-reader limits. The preserved revision was not published.':
                kind==='revex/index-revision'?'The affected-plan index does not belong to this revision. Nothing was published.':
                'The affected-plan index is malformed or incomplete. The preserved revision was not published.';
              finish(readerFailure(message));
            }
          }catch(error){finish(error);}
        };
        worker.onerror=event=>{event.preventDefault?.();finish(readerFailure('The affected-plan document reader could not finish. The preserved revision was not published; retry after reloading Companion.'));};
        worker.onmessageerror=()=>finish(readerFailure('The affected-plan document reader could not return a verified index. Nothing was published.'));
        timer=setTimeout(()=>finish(readerFailure('Reading the affected-plan index timed out. The preserved revision was not published and can be retried.')),180000);
        worker.postMessage({type:'read',file,expectedRevision});
      }catch(error){finish(error);}
    });
  };
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmt=value=>{
    if(!value)return '—';
    const date=value?.toDate?value.toDate():new Date(value);
    return Number.isNaN(date.getTime())?'—':date.toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
  };

  function post(stage,detail={}){
    try{root.chrome?.webview?.postMessage({type:'liber:revex-sync-progress',stage,build:BUILD,...detail});}catch(_){}
  }

  function documentPath(projectId,revision,file,identity){
    return `projects/${projectId}/library/revex/revisions/${revision}/${identity.path(file)}`;
  }
  function reusableDocument(prior,projectId,revision,file,identity){
    const entry=identity.entry(file);
    return prior?.revision===revision&&prior.size===file.size&&prior.manifestPath===entry.path&&
      prior.sha256===entry.digest&&prior.storagePath===documentPath(projectId,revision,file,identity);
  }
  async function upload(projectId,revision,file,identity,publisher){
    const path=documentPath(projectId,revision,file,identity);
    post('docs-upload-start',{path,bytes:file.size});
    const uploaded=await Store.publishRevisionFile(projectId,revision,file,identity,publisher);
    post('docs-upload-complete',{path,bytes:file.size});
    return uploaded;
  }

  function pageFile(page,identity){
    return page?.singlePagePdf||page?.singlePageFileName?identity.resolve(page.singlePagePdf||page.singlePageFileName,'printing-sets'):null;
  }
  function pageWithLocalPdf(page,identity){
    const single=pageFile(page,identity);
    return{...page,singlePageLocalUrl:single?URL.createObjectURL(single):null,singlePageSize:single?.size||null,
      singlePageManifestPath:single?identity.path(single):null};
  }

  function localPrinting(manifest,identity){
    return(manifest?.sets||[]).map(set=>{
      const file=identity.resolve(set.pdf||set.fileName,'printing-sets');
      const pages=(set.pages||[]).map(page=>pageWithLocalPdf(page,identity));
      return{name:file.name,manifestPath:identity.path(file),size:file.size,url:URL.createObjectURL(file),set:{...set,pages}};
    }).filter(Boolean);
  }

  function localAffected(manifest,identity){
    return(manifest?.views||[]).map(view=>{
      const file=identity.resolve(view.pdf||view.fileName,'affected-plans');
      return{name:file.name,manifestPath:identity.path(file),size:file.size,url:URL.createObjectURL(file),view};
    }).filter(Boolean);
  }

  async function publishSheetPages(projectId,revision,set,identity,publisher,priorPages=[]){
    const out=[];
    for(const page of set.pages||[]){
      const row={
        page:Number(page.page)||1,kind:page.kind||'sheet',sheetId:page.sheetId??null,
        sheetUniqueId:page.sheetUniqueId||null,sheetNumber:page.sheetNumber||'',sheetName:page.sheetName||'',
        currentRevision:page.currentRevision||null,singlePageFileName:page.singlePageFileName||null,
        singlePagePdf:page.singlePagePdf||null
      };
      const single=pageFile(page,identity);
      if(single){
        const entry=identity.entry(single);
        const prior=priorPages.find(p=>p.singlePageManifestPath===entry.path&&p.singlePageSha256===entry.digest&&
          p.singlePageSize===single.size&&p.singlePageStoragePath===documentPath(projectId,revision,single,identity));
        const uploaded=prior?{path:prior.singlePageStoragePath}:await upload(projectId,revision,single,identity,publisher);
        row.singlePageStoragePath=uploaded.path;
        row.singlePageSize=single.size;
        row.singlePageManifestPath=entry.path;
        row.singlePageSha256=entry.digest;
      }
      out.push(row);
    }
    return out;
  }

  async function existingDoc(projectId,id,publisher){
    const snapshot=await Store.api.getDoc(Store.api.doc(Store.db,'projects',projectId,'library',id));
    publisher.assertCurrent();
    return snapshot.exists()?snapshot.data():null;
  }

  async function packageDigest(identity){
    const file=identity.manifestFile;
    if(!file)throw new Error('The publication receipt requires integrity.json.');
    const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
  }

  const original=Store.syncPackage.bind(Store);
  Store.syncPackage=async function(fileList,preferredProjectId,preferredSpecProjectId,options={}){
    const files=Object.freeze(Array.from(fileList||[]));
    const publisher=Store.captureSyncPublisher();
    const ownerState=root.__revexState,ownerProject=ownerState?.projectId,ownerActivation=ownerState?.activationToken;
    const assertReaderCurrent=()=>{
      publisher.assertCurrent();
      if(options.signal?.aborted||root.__revexState!==ownerState||ownerState?.projectId!==ownerProject||ownerState?.activationToken!==ownerActivation)
        throw readerFailure('The active project changed or the index read was canceled. The preserved revision was not published and can be retried.');
    };
    if(typeof Store.prepareRevisionFiles!=='function'||typeof Store.publishRevisionFile!=='function')
      throw new Error('REVEX sync components are not aligned. Reload Companion before retrying; this revision was not published.');
    const identity=await Store.prepareRevisionFiles(files);
    assertReaderCurrent();
    const printing=await readJson(identity.resolve('printing-sets.json','',false));
    const affected=await Store.readAffectedDocumentIndex(identity.resolve('affected-plan-views.json','',false),identity.integrity.revision,{assertCurrent:assertReaderCurrent,signal:options.signal});
    assertReaderCurrent();
    // Resolve every document relation before the core can advance the BIM revision.
    const referenced=new Set();
    for(const set of printing?.sets||[]){
      referenced.add(identity.resolve(set.pdf||set.fileName,'printing-sets'));
      for(const page of set.pages||[]){const file=pageFile(page,identity);if(file)referenced.add(file);}
    }
    for(const view of affected?.views||[])referenced.add(identity.resolve(view.pdf||view.fileName,'affected-plans'));
    if(identity.files.some(file=>/\.pdf$/i.test(file.name)&&!referenced.has(file)))
      throw new Error('REVEX package has a PDF missing from its printing/affected-plan index. Re-export the complete revision.');
    const result=await original(files,preferredProjectId,preferredSpecProjectId);
    publisher.assertCurrent();
    result.printingSets=printing;
    result.printingDocs=localPrinting(printing,identity);
    result.affectedPlans=affected;
    result.affectedPlanDocs=localAffected(affected,identity);

    const receiptId=`revex_revision_receipt_${docId(result.revision)}`;
    const packageSha256=await packageDigest(identity);
    if(result.cloud){
      const receipt=await existingDoc(result.projectId,receiptId,publisher);
      if(receipt){
        if(receipt.schema!=='liber.revex.publication-receipt.v1'||receipt.projectId!==result.projectId||receipt.revision!==result.revision||receipt.packageSha256!==packageSha256)
          throw new Error('The completed publication receipt does not match this immutable package.');
        result.reusedPublication=true;
        result.publicationReceipt={id:receiptId,packageSha256};
        return result;
      }
    }

    const announce=()=>{
      try{root.dispatchEvent(new CustomEvent('revex:r24-revision',{detail:{projectId:result.projectId,revision:result.revision,cloud:!!result.cloud,affectedPlanViews:affected?.views?.length||0}}));}catch(_){}
    };
    try{
      const sourceHistoryId=`source_${docId(result.revision)}`;
      const previousHistory=result.cloud?await existingDoc(result.projectId,`revex_history_${sourceHistoryId}`,publisher):null;
      publisher.assertCurrent();
      if(!previousHistory)await Store.appendHistory(result.projectId,{
        id:`source_${docId(result.revision)}`,sourceRevision:result.revision,kind:'source-revision',operation:'sync',
        label:`Revit revision ${result.revision}`,affectedElementIds:[],affectedUniqueIds:[],affectedLevels:[],
        affectedViews:(affected?.views||[]).map(v=>v.name).filter(Boolean),before:null,
        after:{revision:result.revision,scheduleCount:result.integrity?.counts?.schedules||null,elementCount:result.integrity?.counts?.elements||null,affectedPlanViews:affected?.views?.length||0},
        note:'Atomic REVEX source revision: BIM, Design Book, Spec Book, Docs and affected native Revit plan exports.'
      });
    }catch(e){console.warn('[REVEX r113 Docs] source history',e);}

    publisher.assertCurrent();
    if(!result.cloud||!Store.isCloud()||!Store.user?.uid||!Store.fs?.storage){
      post('docs-local-preview',{printingSets:printing?.sets?.length||0,affectedPlans:affected?.views?.length||0});
      announce();
      return result;
    }

    const printingRecords=[];
    for(const set of printing?.sets||[]){
      const file=identity.resolve(set.pdf||set.fileName,'printing-sets');
      const id=`revex_print_${docId(set.id||set.name)}_${docId(result.revision)}`;
      const prior=await existingDoc(result.projectId,id,publisher);
      const reusable=reusableDocument(prior,result.projectId,result.revision,file,identity);
      const uploaded=reusable?{path:prior.storagePath,url:await Store.api.getDownloadURL(Store.api.ref(Store.fs.storage,prior.storagePath))}:await upload(result.projectId,result.revision,file,identity,publisher);
      const at=result.syncedAt||new Date().toISOString();
      const sheetIndex=await publishSheetPages(result.projectId,result.revision,set,identity,publisher,reusable?(prior.sheetIndex||[]):[]);
      const data=clone({
        type:'file',hidden:false,name:`${set.name||'Printing Set'} · ${result.revision}.pdf`,
        storagePath:uploaded.path,manifestPath:identity.path(file),sha256:identity.entry(file).digest,
        folderPath:'record_out/printing_sets',size:file.size,mimeType:'application/pdf',
        source:'revex-revit-printing-set',editable:false,revexDocKind:'printing-set',printingSetId:set.id||null,
        printingSetName:set.name||'Printing Set',revision:result.revision,sheetIndex,createdAt:at,updatedAt:at,createdBy:publisher.uid
      });
      publisher.assertCurrent();
      if(!reusable||JSON.stringify(prior.sheetIndex)!==JSON.stringify(sheetIndex))
        await Store.api.setDoc(Store.api.doc(Store.db,'projects',result.projectId,'library',id),data,clone({merge:true}));
      printingRecords.push({id,...data,url:uploaded.url});
    }
    result.printingDocs=printingRecords;

    const affectedRecords=[];
    for(const view of affected?.views||[]){
      const file=identity.resolve(view.pdf||view.fileName,'affected-plans');
      const id=`revex_plan_${docId(view.uniqueId||view.id||view.name)}_${docId(result.revision)}`;
      const prior=await existingDoc(result.projectId,id,publisher);
      const reusable=reusableDocument(prior,result.projectId,result.revision,file,identity);
      const uploaded=reusable?{path:prior.storagePath,url:await Store.api.getDownloadURL(Store.api.ref(Store.fs.storage,prior.storagePath))}:await upload(result.projectId,result.revision,file,identity,publisher);
      const at=result.syncedAt||new Date().toISOString();
      const data=clone({
        type:'file',hidden:false,name:`${view.name||'Affected Plan'} · ${result.revision}.pdf`,
        storagePath:uploaded.path,manifestPath:identity.path(file),sha256:identity.entry(file).digest,
        folderPath:'record_out/affected_plans',size:file.size,mimeType:'application/pdf',
        source:'revex-revit-affected-plan',editable:false,revexDocKind:'affected-revit-plan',
        revitViewId:view.id??null,revitViewUniqueId:view.uniqueId||null,revitViewName:view.name||'',
        levelId:view.levelId??null,levelUniqueId:view.levelUniqueId||null,levelName:view.levelName||null,
        changedElementIds:view.changedElementIds||[],reason:view.reason||'',revision:result.revision,
        createdAt:at,updatedAt:at,createdBy:publisher.uid
      });
      publisher.assertCurrent();
      if(!reusable)await Store.api.setDoc(Store.api.doc(Store.db,'projects',result.projectId,'library',id),data,clone({merge:true}));
      affectedRecords.push({id,...data,url:uploaded.url});
      try{
        const planHistoryId=`plan_${docId(view.uniqueId||view.id||view.name)}_${docId(result.revision)}`;
        const priorHistory=await existingDoc(result.projectId,`revex_history_${planHistoryId}`,publisher);
        publisher.assertCurrent();
        if(!priorHistory)await Store.appendHistory(result.projectId,{
          id:`plan_${docId(view.uniqueId||view.id||view.name)}_${docId(result.revision)}`,sourceRevision:result.revision,
          kind:'derived-plan',operation:'native-revit-export',label:`Updated plan · ${view.name||'Plan'}`,
          affectedElementIds:view.changedElementIds||[],affectedUniqueIds:[],affectedLevels:view.levelName?[view.levelName]:[],
          affectedViews:view.name?[view.name]:[],before:null,after:{libraryId:id,storagePath:uploaded.path},
          note:'Native Revit plan export generated from the same authoritative REVEX source revision.'
        });
      }catch(e){console.warn('[REVEX r113 Docs] plan history',e);}
    }
    result.affectedPlanDocs=affectedRecords;
    publisher.assertCurrent();
    // Separate write-once receipt, not a mutation of the immutable source revision.
    await Store.api.setDoc(Store.api.doc(Store.db,'projects',result.projectId,'library',receiptId),clone({
      schema:'liber.revex.publication-receipt.v1',type:'revex',hidden:true,revexKind:'publication-receipt',
      projectId:result.projectId,revision:result.revision,packageSha256,completedAt:new Date().toISOString(),createdBy:publisher.uid
    }),clone({merge:false}));
    publisher.assertCurrent();
    result.publicationReceipt={id:receiptId,packageSha256};
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
        const key=sheetKey(sheet);if(seen.has(key))continue;seen.add(key);file.sheetIndex.push(sheet);
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
    const selectionCurrent=root.__revexDocumentViewer.beginSelection();
    const s=state();if(!s)return;
    const frame=document.getElementById('docs-frame'),empty=document.getElementById('docs-empty');
    const pageNumber=page?Number(page):null;
    const isolated=sheet?await isolatedSheetUrl(sheet):null;
    const full=file.localUrl||file.url||(file.storagePath&&typeof Store.fileUrl==='function'?await Store.fileUrl(file.storagePath):null);
    if(!selectionCurrent())return;
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
    root.__revexDocumentViewer.show(frame,s.docSelection);
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
    s.docsRevisionBySet=s.docsRevisionBySet||{};
    const selection=s.docSelection;
    const selectedPage=Number(selection?.sourcePage||selection?.page)||null;
    const setEntries=[...bySet.entries()];
    const printHtml=setEntries.map(([key,revisions],setIndex)=>{
      revisions.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
      const latest=revisions[0];
      const selectedInSet=revisions.find(row=>String(row.id)===String(selection?.file?.id||''));
      const preferredId=selectedInSet?.id||s.docsRevisionBySet[key]||latest?.id;
      const file=revisions.find(row=>String(row.id)===String(preferredId))||latest;
      if(!file)return '';
      const allText=`${file.printingSetName||''} ${(file.sheetIndex||[]).map(p=>`${p.sheetNumber} ${p.sheetName}`).join(' ')}`;
      if(!matches(allText))return '';
      s.docsRevisionBySet[key]=file.id;
      const selected=String(selection?.file?.id||'')===String(file.id);
      const versionControl=revisions.length>1
        ? `<select class="docs-version-select" data-set-index="${setIndex}" aria-label="${esc(file.printingSetName||'Printing Set')} revision">${revisions.map((row,ri)=>`<option value="${esc(row.id)}" ${String(row.id)===String(file.id)?'selected':''}>${ri===0?'Current':'Previous'} · ${esc(row.revision||fmt(row.createdAt))}</option>`).join('')}</select>`
        : `<span class="docs-current-revision">${esc(file.revision||fmt(file.createdAt))}</span>`;
      return `<section class="docs-group printing-set" data-printing-set="${esc(key)}"><div class="docs-set-head"><h3>${esc(file.printingSetName||'Printing Set')}<small>${(file.sheetIndex||[]).length} sheets</small></h3>${versionControl}</div><button type="button" class="docs-node whole ${selected&&!selection?.sheet?'active':''}" data-doc-id="${esc(file.id)}"><span>Full document</span><small>PDF</small></button>${(file.sheetIndex||[]).map(sheet=>`<button type="button" class="docs-node sheet ${selected&&selectedPage===Number(sheet.page)?'active':''}" data-doc-id="${esc(file.id)}" data-page="${Number(sheet.page)||1}"><b>${esc(sheet.sheetNumber||String(sheet.page))}</b><span>${esc(sheet.sheetName||'Sheet')}</span><small>${sheet.singlePageStoragePath||sheet.singlePageUrl||sheet.singlePageLocalUrl?'PDF':'p.'+(Number(sheet.page)||1)}</small></button>`).join('')}</section>`;
    }).join('');
    host.innerHTML=printHtml+affectedGroup(affected)+manualGroup('Record In',manualIn)+manualGroup('Record Out',manualOut)||'<div class="file-empty">No matching project documents.</div>';
    host.querySelectorAll('.docs-version-select').forEach(select=>select.addEventListener('change',()=>{
      const entry=setEntries[Number(select.dataset.setIndex)||0];if(!entry)return;s.docsRevisionBySet[entry[0]]=select.value;renderLibrary();
    }));
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
    }catch(error){console.warn('[REVEX r113 Docs] share sheet PDF',error);root.open(url,'_blank','noopener');}
  }

  function installDocsCore(){
    ensureShareButton();
    root.selectDocument=selectDocument;
    root.renderLibrary=renderLibrary;
    const search=document.getElementById('docs-search');
    if(search&&!search.dataset.revexR113Docs){
      search.dataset.revexR113Docs='1';
      search.addEventListener('input',()=>queueMicrotask(renderLibrary));
    }
    root.addEventListener('revex:r24-revision',()=>queueMicrotask(renderLibrary));
    renderLibrary();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installDocsCore,{once:true});
  else installDocsCore();

  console.log('[REVEX] sync Docs '+BUILD,{
    revisionedPrintingSets:true,singleVisibleRevisionPerSet:true,revisionSelector:true,
    fullDocumentPlusLinkedSheets:true,singlePageSheetPdfs:true,isolatedSheetViewer:true,isolatedSheetShare:true,
    legacySheetProjection:'render-only',nativeAffectedPlans:true,appendOnlyHistory:true,manualDocsPreserved:true,
    globalClickInterception:false,mutationObservers:false
  });
})(window);
