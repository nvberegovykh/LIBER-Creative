(function(root){
  'use strict';
  const BUILD='20260816r68-doc-pages1';
  const PDF_LIB_URL='https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
  const safe=v=>String(v||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const clone=v=>JSON.parse(JSON.stringify(v===undefined?null:v));
  const jobs=new Map();
  let pdfLibPromise=null;

  function Store(){return root.RevexStore;}
  function state(){return root.__revexState||{};}
  function post(level,stage,message,detail={}){
    try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'docs pages r68',...detail});}catch(_){}
  }
  function ensurePdfLib(){
    if(root.PDFLib?.PDFDocument)return Promise.resolve(root.PDFLib);
    if(pdfLibPromise)return pdfLibPromise;
    pdfLibPromise=new Promise((resolve,reject)=>{
      const existing=document.querySelector('script[data-revex-pdf-lib]');
      if(existing){
        const poll=()=>root.PDFLib?.PDFDocument?resolve(root.PDFLib):setTimeout(poll,30);
        poll();return;
      }
      const script=document.createElement('script');
      script.src=PDF_LIB_URL;script.async=true;script.dataset.revexPdfLib='1';
      script.onload=()=>root.PDFLib?.PDFDocument?resolve(root.PDFLib):reject(new Error('pdf-lib loaded without PDFDocument.'));
      script.onerror=()=>reject(new Error('REVEX could not load the pinned PDF splitter.'));
      document.head.appendChild(script);
    });
    return pdfLibPromise;
  }
  async function fullDocumentUrl(file){
    if(file?.localUrl)return file.localUrl;
    if(file?.url)return file.url;
    const store=Store();
    if(file?.storagePath&&store?.fileUrl)return store.fileUrl(file.storagePath);
    throw new Error('Full printing-set PDF is unavailable.');
  }
  async function existingSheetUrl(sheet){
    const store=Store();
    if(sheet?.singlePageLocalUrl)return sheet.singlePageLocalUrl;
    if(sheet?.singlePageUrl)return sheet.singlePageUrl;
    if(sheet?.singlePageStoragePath&&store?.fileUrl)return store.fileUrl(sheet.singlePageStoragePath);
    return null;
  }
  function replaceSheetInMemory(file,page,next){
    file.sheetIndex=(file.sheetIndex||[]).map(row=>Number(row.page)===Number(page)?{...row,...next}:row);
    const current=state().docSelection;
    if(current?.file?.id===file.id&&Number(current.page)===Number(page))current.sheet={...(current.sheet||{}),...next};
  }
  async function persistSheetIndex(file){
    const store=Store(),projectId=state().projectId;
    if(!store?.isCloud?.()||!projectId||!file?.id||!store.api?.setDoc)return;
    await store.api.setDoc(store.api.doc(store.db,'projects',projectId,'library',file.id),clone({sheetIndex:file.sheetIndex,updatedAt:new Date().toISOString()}),clone({merge:true}));
  }
  async function buildOnePagePdf(file,sheet){
    const projectId=state().projectId;
    const page=Math.max(1,Number(sheet?.page)||1);
    const key=`${projectId}:${file?.id||file?.storagePath||file?.name}:${page}`;
    if(jobs.has(key))return jobs.get(key);
    const task=(async()=>{
      const already=await existingSheetUrl(sheet);
      if(already)return already;
      const sourceUrl=await fullDocumentUrl(file);
      const response=await fetch(sourceUrl,{cache:'no-store'});
      if(!response.ok)throw new Error(`Full printing-set PDF returned HTTP ${response.status}.`);
      const bytes=await response.arrayBuffer();
      const {PDFDocument}=await ensurePdfLib();
      const source=await PDFDocument.load(bytes);
      if(page>source.getPageCount())throw new Error(`Printing set has ${source.getPageCount()} pages; requested page ${page}.`);
      const target=await PDFDocument.create();
      const [copied]=await target.copyPages(source,[page-1]);
      target.addPage(copied);
      const out=await target.save({useObjectStreams:true});
      const name=safe(`${String(page).padStart(3,'0')}_${sheet?.sheetNumber||`page_${page}`}.pdf`);
      const blob=new File([out],name,{type:'application/pdf'});
      const store=Store();
      if(store?.isCloud?.()&&projectId&&store.fs?.storage&&store.api?.ref&&store.api?.uploadBytes){
        const lane=safe(file.printingSetId||file.printingSetName||file.id||'set');
        const revision=safe(file.revision||'current');
        const path=`projects/${projectId}/library/revex/printing-pages/${lane}/${revision}/${name}`;
        const ref=store.api.ref(store.fs.storage,path);
        await store.api.uploadBytes(ref,blob,clone({contentType:'application/pdf'}));
        const url=await store.api.getDownloadURL(ref);
        replaceSheetInMemory(file,page,{singlePageStoragePath:path,singlePageUrl:url,singlePageFileName:name,singlePageSize:blob.size});
        await persistSheetIndex(file);
        post('INFO','DOCS_PAGE_SPLIT','Split printing-set PDF into a real single-page document.',{projectId,fileId:file.id,page,path});
        return url;
      }
      const url=URL.createObjectURL(blob);
      replaceSheetInMemory(file,page,{singlePageLocalUrl:url,singlePageFileName:name,singlePageSize:blob.size});
      return url;
    })();
    jobs.set(key,task);
    try{return await task;}finally{jobs.delete(key);}
  }
  function setPreview(file,sheet,page,url){
    const s=state();
    s.docSelection={file,page,sheet,url,isolatedSheetUrl:url,mode:'isolated-sheet-pdf'};
    const frame=document.getElementById('docs-frame'),empty=document.getElementById('docs-empty');
    const title=document.getElementById('docs-preview-title'),meta=document.getElementById('docs-preview-meta');
    if(title)title.textContent=`${sheet.sheetNumber||`Page ${page}`} · ${sheet.sheetName||''}`;
    if(meta)meta.textContent=[file.revision?`REVEX ${file.revision}`:null,sheet.currentRevision?`Sheet revision ${sheet.currentRevision}`:null,'single-page PDF'].filter(Boolean).join(' · ');
    if(frame){frame.src='about:blank';requestAnimationFrame(()=>{frame.src=url;frame.hidden=false;});}
    if(empty)empty.hidden=true;
    const copy=document.getElementById('docs-copy-ref');if(copy)copy.disabled=false;
    const open=document.getElementById('docs-open-external');if(open)open.disabled=false;
    document.querySelectorAll('.docs-node.active').forEach(node=>node.classList.remove('active'));
  }
  async function handleSheet(button,event){
    const s=state();
    const file=(s.library||[]).find(row=>String(row.id)===String(button.dataset.docId));
    if(!file)return;
    const page=Math.max(1,Number(button.dataset.page)||1);
    const sheet=(file.sheetIndex||[]).find(row=>Number(row.page)===page);
    if(!sheet)return;
    event.preventDefault();event.stopImmediatePropagation();
    const meta=document.getElementById('docs-preview-meta');
    if(meta)meta.textContent='Preparing isolated sheet PDF…';
    button.disabled=true;
    try{
      const url=await buildOnePagePdf(file,sheet);
      const refreshed=(file.sheetIndex||[]).find(row=>Number(row.page)===page)||sheet;
      setPreview(file,refreshed,page,url);button.classList.add('active');
    }catch(error){
      const empty=document.getElementById('docs-empty');
      if(empty){empty.hidden=false;empty.textContent=error?.message||'Could not isolate this sheet.';}
      post('ERROR','DOCS_PAGE_SPLIT_FAILED',error?.message||String(error),{fileId:file.id,page});
    }finally{button.disabled=false;}
  }
  function install(){
    if(root.__revexDocsPagesR68)return;
    root.__revexDocsPagesR68={build:BUILD,pdfLib:'1.17.1'};
    document.addEventListener('click',event=>{
      const sheet=event.target.closest?.('.docs-node.sheet');
      if(sheet){void handleSheet(sheet,event);return;}
      const open=event.target.closest?.('#docs-open-external');
      const selected=state().docSelection;
      if(open&&selected?.mode==='isolated-sheet-pdf'&&selected.isolatedSheetUrl){event.preventDefault();event.stopImmediatePropagation();root.open(selected.isolatedSheetUrl,'_blank','noopener');}
    },true);
    post('INFO','DOCS_PAGE_RUNTIME','Full-set PDF stays first; sheet positions use real one-page PDFs.',{build:BUILD});
  }
  const wait=()=>{if(Store()&&root.__revexState){install();return;}setTimeout(wait,50);};
  wait();
})(window);
