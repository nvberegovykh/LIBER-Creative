(function(root){
  'use strict';
  const BUILD='20260817r113-docs-presentation1';
  if(root.__revexDocsPresentationR113)return;
  root.__revexDocsPresentationR113=true;

  const Store=root.RevexStore;
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const safe=v=>String(v||'file').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const fmt=value=>{
    if(!value)return '—';
    const date=value?.toDate?value.toDate():new Date(value);
    return Number.isNaN(date.getTime())?'—':date.toLocaleString([],{dateStyle:'medium',timeStyle:'short'});
  };
  const state=()=>root.__revexState||null;
  const matches=text=>{
    const q=String(document.getElementById('docs-search')?.value||'').trim().toLowerCase();
    return !q||String(text||'').toLowerCase().includes(q);
  };
  const label=file=>file?.revexDocKind==='printing-set'?`${file.printingSetName||file.name} ${file.revision||''}`:`${file?.name||'file'} ${file?.folderPath||''}`;
  const legacySheet=file=>{
    const kind=String(file?.revexDocKind||'').toLowerCase();
    const folder=String(file?.folderPath||'').toLowerCase();
    return kind==='printing-sheet'||kind==='printing-set-sheet'||kind==='revit-printing-sheet'||folder.includes('printing_sets/sheets')||folder.includes('printing-sets/sheets');
  };
  const sheetKey=sheet=>String(sheet?.sheetUniqueId||sheet?.sheetId||sheet?.sheetNumber||`page:${Number(sheet?.page)||1}`);
  const sameSetRevision=(file,row)=>{
    const revisionMatch=!file.revision||!row.revision||String(file.revision)===String(row.revision)||String(file.revision)===String(row.sourceRevision);
    const idMatch=file.printingSetId&&row.printingSetId&&String(file.printingSetId)===String(row.printingSetId);
    const nameMatch=file.printingSetName&&row.printingSetName&&String(file.printingSetName)===String(row.printingSetName);
    return revisionMatch&&(idMatch||nameMatch);
  };

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
    if(sheet?.singlePageStoragePath&&typeof Store?.fileUrl==='function')return Store.fileUrl(sheet.singlePageStoragePath);
    return null;
  }

  function ensureShareButton(){
    let button=document.getElementById('docs-share-sheet');
    if(button)return button;
    const open=document.getElementById('docs-open-external');if(!open?.parentElement)return null;
    button=document.createElement('button');button.id='docs-share-sheet';button.type='button';button.className='button ghost compact';button.textContent='Share sheet PDF';button.hidden=true;
    open.parentElement.insertBefore(button,open);button.addEventListener('click',event=>{event.preventDefault();void shareSelectedSheet();});return button;
  }

  async function selectDocument(file,page=null,sheet=null){
    const s=state();if(!s)return;
    const frame=document.getElementById('docs-frame'),empty=document.getElementById('docs-empty');
    const pageNumber=page?Number(page):null;
    const isolated=sheet?await isolatedSheetUrl(sheet):null;
    const full=file.localUrl||file.url||(file.storagePath&&typeof Store?.fileUrl==='function'?await Store.fileUrl(file.storagePath):null);
    if(!isolated&&!full)throw new Error('Document URL is unavailable.');
    const url=isolated||full;
    s.docSelection={file,page:isolated?null:pageNumber,sourcePage:pageNumber,sheet:sheet||null,url,isolatedSheetUrl:isolated||null,mode:isolated?'isolated-sheet-pdf':'document'};
    const title=document.getElementById('docs-preview-title'),meta=document.getElementById('docs-preview-meta');
    if(title)title.textContent=sheet?`${sheet.sheetNumber||`Page ${pageNumber||1}`} · ${sheet.sheetName||''}`:(file.printingSetName||file.revitViewName||file.name||'Document');
    if(meta)meta.textContent=[file.revision?`REVEX ${file.revision}`:null,sheet?.currentRevision?`Sheet revision ${sheet.currentRevision}`:null,isolated?'single-page PDF':pageNumber?`page ${pageNumber}`:null,file.source==='manual'?'manual file':null].filter(Boolean).join(' · ')||'Project document';
    const copy=document.getElementById('docs-copy-ref'),external=document.getElementById('docs-open-external');if(copy)copy.disabled=false;if(external)external.disabled=false;
    const share=ensureShareButton();if(share)share.hidden=!isolated;
    if(frame){frame.src=isolated?url:(pageNumber?`${url}#page=${pageNumber}`:url);frame.hidden=false;}if(empty)empty.hidden=true;
    renderLibrary();
  }

  function manualGroup(title,files){
    const visible=files.filter(file=>matches(label(file)));if(!visible.length)return '';
    return `<section class="docs-group"><h3>${esc(title)}<small>${visible.length}</small></h3>${visible.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).map(file=>`<button type="button" class="docs-node ${state()?.docSelection?.file?.id===file.id&&!state()?.docSelection?.sheet?'active':''}" data-doc-id="${esc(file.id)}"><span>${esc(file.name||'file')}</span><small>${esc(fmt(file.createdAt))}</small></button>`).join('')}</section>`;
  }
  function affectedGroup(files){
    const visible=files.filter(file=>matches(label(file)));if(!visible.length)return '';
    return `<section class="docs-group"><h3>Affected Plans<small>${visible.length}</small></h3>${visible.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).map(file=>`<button type="button" class="docs-node ${state()?.docSelection?.file?.id===file.id?'active':''}" data-doc-id="${esc(file.id)}"><span>${esc(file.revitViewName||file.name||'Plan')}</span><small>${esc(file.revision||fmt(file.createdAt))}</small></button>`).join('')}</section>`;
  }

  function renderLibrary(){
    const s=state(),host=document.getElementById('docs-tree');if(!s||!host)return;
    const rows=[...(s.library||[])],printing=projectedPrintingRows(rows),legacyIds=new Set(rows.filter(legacySheet).map(row=>String(row.id||'')));
    const affected=rows.filter(file=>file.revexDocKind==='affected-revit-plan');
    const manualIn=rows.filter(file=>file.revexDocKind!=='printing-set'&&!legacyIds.has(String(file.id||''))&&file.revexDocKind!=='affected-revit-plan'&&String(file.folderPath||'').startsWith('record_in'));
    const manualOut=rows.filter(file=>file.revexDocKind!=='printing-set'&&!legacyIds.has(String(file.id||''))&&file.revexDocKind!=='affected-revit-plan'&&String(file.folderPath||'').startsWith('record_out'));
    const bySet=new Map();printing.forEach(file=>{const key=file.printingSetId||file.printingSetName||file.name;if(!bySet.has(key))bySet.set(key,[]);bySet.get(key).push(file);});
    const sets=[...bySet.entries()];
    s.docsRevisionBySet=s.docsRevisionBySet||{};
    const selection=s.docSelection,selectedPage=Number(selection?.sourcePage||selection?.page)||null;
    const html=sets.map(([key,revisions],index)=>{
      revisions.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
      const latest=revisions[0];
      const selectedInSet=revisions.find(row=>String(row.id)===String(selection?.file?.id||''));
      const preferredId=selectedInSet?.id||s.docsRevisionBySet[key]||latest?.id;
      const file=revisions.find(row=>String(row.id)===String(preferredId))||latest;
      if(!file)return '';
      const allText=`${file.printingSetName||''} ${(file.sheetIndex||[]).map(p=>`${p.sheetNumber} ${p.sheetName}`).join(' ')}`;if(!matches(allText))return '';
      s.docsRevisionBySet[key]=file.id;
      const selected=String(selection?.file?.id||'')===String(file.id);
      const versionControl=revisions.length>1?`<select class="docs-version-select" data-doc-set-index="${index}" aria-label="${esc(file.printingSetName||'Printing Set')} revision">${revisions.map((row,ri)=>`<option value="${esc(row.id)}" ${String(row.id)===String(file.id)?'selected':''}>${ri===0?'Current':'Previous'} · ${esc(row.revision||fmt(row.createdAt))}</option>`).join('')}</select>`:`<span class="docs-current-revision">${esc(file.revision||fmt(file.createdAt))}</span>`;
      return `<section class="docs-group printing-set" data-printing-set="${esc(key)}"><div class="docs-set-head"><h3>${esc(file.printingSetName||'Printing Set')}<small>${(file.sheetIndex||[]).length} sheets</small></h3>${versionControl}</div><button type="button" class="docs-node whole ${selected&&!selection?.sheet?'active':''}" data-doc-id="${esc(file.id)}"><span>Full document</span><small>PDF</small></button>${(file.sheetIndex||[]).map(sheet=>`<button type="button" class="docs-node sheet ${selected&&selectedPage===Number(sheet.page)?'active':''}" data-doc-id="${esc(file.id)}" data-page="${Number(sheet.page)||1}"><b>${esc(sheet.sheetNumber||String(sheet.page))}</b><span>${esc(sheet.sheetName||'Sheet')}</span><small>${sheet.singlePageStoragePath||sheet.singlePageUrl||sheet.singlePageLocalUrl?'PDF':'p.'+(Number(sheet.page)||1)}</small></button>`).join('')}</section>`;
    }).join('');
    host.innerHTML=html+affectedGroup(affected)+manualGroup('Record In',manualIn)+manualGroup('Record Out',manualOut)||'<div class="file-empty">No matching project documents.</div>';

    host.querySelectorAll('.docs-version-select').forEach(select=>select.addEventListener('change',()=>{
      const row=sets[Number(select.dataset.docSetIndex)||0];if(!row)return;s.docsRevisionBySet[row[0]]=select.value;renderLibrary();
    }));
    host.querySelectorAll('.docs-node').forEach(button=>button.addEventListener('click',()=>{
      const file=printing.find(row=>String(row.id)===String(button.dataset.docId))||rows.find(row=>String(row.id)===String(button.dataset.docId));if(!file)return;
      const page=button.dataset.page?Number(button.dataset.page):null,sheet=page?(file.sheetIndex||[]).find(row=>Number(row.page)===page):null;
      void selectDocument(file,page,sheet).catch(error=>{
        const frame=document.getElementById('docs-frame'),empty=document.getElementById('docs-empty');if(frame){frame.removeAttribute('src');frame.hidden=true;}if(empty){empty.hidden=false;empty.textContent=error.message||'Could not open document.';}
      });
    }));
  }

  async function shareSelectedSheet(){
    const sel=state()?.docSelection,url=sel?.isolatedSheetUrl;if(!url||!sel?.sheet)return;
    const name=safe(`${sel.sheet.sheetNumber||'sheet'}_${sel.sheet.sheetName||''}.pdf`);
    try{const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error(`Sheet PDF returned ${response.status}`);const blob=await response.blob(),file=new File([blob],name,{type:'application/pdf'});if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({title:sel.sheet.sheetNumber||'REVEX sheet',files:[file]});return;}if(navigator.clipboard)await navigator.clipboard.writeText(url);else root.open(url,'_blank','noopener');}catch(error){console.warn('[REVEX r113 Docs] share sheet PDF',error);root.open(url,'_blank','noopener');}
  }

  function install(){
    if(!root.__revexSyncDocsR24){setTimeout(install,50);return;}
    ensureShareButton();root.selectDocument=selectDocument;root.renderLibrary=renderLibrary;
    const search=document.getElementById('docs-search');
    if(search&&!search.dataset.revexR113Docs){
      const clean=search.cloneNode(true);clean.dataset.revexR113Docs='1';search.replaceWith(clean);clean.addEventListener('input',()=>queueMicrotask(renderLibrary));
    }
    root.addEventListener('revex:r24-revision',()=>queueMicrotask(renderLibrary));
    renderLibrary();
    console.info('[REVEX] Docs '+BUILD,{singleVisibleRevisionPerSet:true,fullDocumentPlusLinkedSheets:true,revisionSelector:true,legacyProjection:'render-only',stateRewrite:false,mutationObservers:false});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
