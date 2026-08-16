(function(root){
  'use strict';
  const BUILD='20260816r71-filter1';
  if(root.__revexModelFilterR71)return;
  root.__revexModelFilterR71={build:BUILD};
  const text=value=>String(value??'').trim();
  const norm=value=>text(value).toLowerCase().replace(/\s+/g,' ');
  const state=()=>root.__revexState||null;
  const familyKey=row=>text(row?.familyUniqueId||row?.familyId)
    ?`uid:${text(row.familyUniqueId||row.familyId)}`
    :`text:${norm(row?.category)}|${norm(row?.family||'System Family')}`;
  const typeKey=row=>text(row?.typeUniqueId||row?.typeId||row?.revitTypeUniqueId)
    ?`uid:${text(row.typeUniqueId||row.typeId||row.revitTypeUniqueId)}`
    :`text:${norm(row?.category)}|${norm(row?.family)}|${norm(row?.type||row?.typeName||row?.name)}`;
  const typeLabel=row=>text(row?.type||row?.typeName||row?.name||'');

  function diagnostic(message,detail={}){
    try{root.__revexBrowserDiagnostics?.emit?.('INFO','MODEL_FILTER_R71',message,{initiator:'model filter r71',...detail});}catch(_){}
  }

  function selectedState(){
    const bar=document.getElementById('r70-filter');
    return bar?{
      family:text(bar.querySelector('[data-f]')?.value),
      type:text(bar.querySelector('[data-t]')?.value),
      instance:text(bar.querySelector('[data-i]')?.value)
    }:{family:'',type:'',instance:''};
  }

  function bridgeTerm(selection){
    const rows=state()?.viewerData?.elements||[];
    if(selection.instance){
      const row=rows.find(item=>String(item.id)===selection.instance);
      return row?String(row.id):selection.instance;
    }
    if(selection.type){
      const row=rows.find(item=>typeKey(item)===selection.type);
      return typeLabel(row)||'';
    }
    if(selection.family){
      const row=rows.find(item=>familyKey(item)===selection.family);
      // Core search indexes category/type/material but historically omitted family.
      // Category is the broadest reliable bridge; r70 then applies the exact family key.
      return text(row?.category||row?.family||'');
    }
    return '';
  }

  function applyBridge(){
    const search=document.getElementById('element-search');
    if(!search)return;
    const selection=selectedState();
    const active=!!(selection.family||selection.type||selection.instance);
    if(!active){
      if(search.dataset.revexR71Filter==='1'){
        const auto=search.dataset.revexR71AutoTerm||'';
        const previous=search.dataset.revexR71Previous||'';
        if(search.value===auto)search.value=previous;
        delete search.dataset.revexR71Filter;
        delete search.dataset.revexR71AutoTerm;
        delete search.dataset.revexR71Previous;
        search.dispatchEvent(new Event('input',{bubbles:true}));
      }
      return;
    }
    const term=bridgeTerm(selection);
    if(!term)return;
    if(search.dataset.revexR71Filter!=='1')search.dataset.revexR71Previous=search.value||'';
    search.dataset.revexR71Filter='1';
    search.dataset.revexR71AutoTerm=term;
    search.value=term;
    // app.js now re-renders from the complete viewerData index (search limit),
    // after which r70's exact Family/Type/Instance filter removes false positives.
    search.dispatchEvent(new Event('input',{bubbles:true}));
    diagnostic('Family/Type filter bridged through full model search index.',{selection,term});
  }

  function bind(){
    document.addEventListener('change',event=>{
      if(event.target?.closest?.('#r70-filter'))setTimeout(applyBridge,0);
    },true);
    document.addEventListener('click',event=>{
      const button=event.target?.closest?.('#r70-filter button');
      if(button)setTimeout(applyBridge,0);
    },true);
    root.addEventListener('revex:source-revision-loaded',()=>setTimeout(applyBridge,80));
    let tries=0;
    const timer=setInterval(()=>{
      tries+=1;
      if(document.getElementById('r70-filter'))applyBridge();
      if(tries>100)clearInterval(timer);
    },150);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
})(window);
