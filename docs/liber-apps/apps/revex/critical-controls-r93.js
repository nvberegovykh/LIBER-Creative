(function(root){
  'use strict';
  const BUILD='20260816r93-critical-controls2';
  if(root.__revexCriticalControlsR93)return;
  root.__revexCriticalControlsR93={build:BUILD};
  const clean=v=>String(v??'').trim();
  const state=()=>root.__revexState||{};
  const Store=()=>root.RevexStore;
  const viewer=()=>root.__revexViewerR26Instance||root.__revexViewerR25Instance||root.__revexViewerR24Instance||null;
  const stable=r=>clean(r?.uniqueId||r?.elementId||r?.id);
  const hidden=r=>r?.hidden===true||r?.deleted===true||['hidden','deleted'].includes(clean(r?.visibility).toLowerCase());
  let refreshing=false;
  function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'critical controls r93',...detail});}catch(_){} }
  function elementForOverlay(row){
    const elements=state()?.viewerData?.elements||[];
    const uid=clean(row?.uniqueId),id=clean(row?.elementId||row?.id);
    return elements.find(e=>(uid&&clean(e.uniqueId)===uid)||(id&&clean(e.id)===id))||null;
  }
  function applyOverlayState(rows){
    const s=state();
    s.bimOverlays=new Map((rows||[]).map(row=>[stable(row),row]).filter(([key])=>key));
    viewer()?.setOverlays?.(rows||[]);
    s.showHiddenOnly=false;
    const show=document.getElementById('show-hidden-elements');
    if(show){show.setAttribute('aria-pressed','false');show.classList.remove('active');show.textContent='Show hidden only';}
    document.getElementById('element-search')?.dispatchEvent(new Event('input',{bubbles:true}));
  }
  async function restoreAll(){
    const store=Store(),s=state(),projectId=clean(s.projectId||document.getElementById('project-select')?.value);
    if(!store||!projectId)throw new Error('REVEX project Store is not connected.');
    const button=document.getElementById('restore-all-elements');
    const all=(await store.listBimOverlays?.(projectId))||[];
    const targets=all.filter(hidden);
    if(!targets.length){applyOverlayState(all);if(button){button.disabled=true;button.textContent='All elements visible';}return {restored:0};}
    if(button){button.disabled=true;button.textContent=`Restoring ${targets.length}…`;}
    const missing=[];let restored=0;
    for(const overlay of targets){
      const element=elementForOverlay(overlay);
      if(!element){missing.push(stable(overlay));continue;}
      await store.commitBimOverlay(projectId,element,{visibility:'visible',hidden:false,deleted:false},{
        operation:'restore',label:`Restore BIM element ${element.id||''}`.trim(),sourceRevision:s.cloudState?.revision||null,note:'Restore All through canonical REVEX Store commit path.'
      });
      restored+=1;
    }
    if(missing.length)throw new Error(`Restore All could not resolve ${missing.length} persisted overlay(s) back to current BIM element identity.`);
    const refreshed=(await store.listBimOverlays?.(projectId))||[];
    applyOverlayState(refreshed);
    if(button){button.disabled=true;button.textContent='All elements visible';}
    root.dispatchEvent(new CustomEvent('revex:bim-overlays-changed',{detail:{projectId,overlays:refreshed,source:'critical-controls-r93'}}));
    diag('INFO','BIM_RESTORE_ALL_CANONICAL',`Restored ${restored} hidden/deleted BIM elements through Store.commitBimOverlay.`,{projectId,restored});
    return {restored};
  }
  async function refreshRestore(){
    if(refreshing)return;
    const store=Store(),s=state(),projectId=clean(s.projectId||document.getElementById('project-select')?.value),button=document.getElementById('restore-all-elements');
    if(!button||!store||!projectId)return;
    refreshing=true;
    try{const rows=(await store.listBimOverlays?.(projectId))||[];applyOverlayState(rows);const count=rows.filter(hidden).length;button.disabled=!count;button.textContent=count?`Restore all hidden / deleted · ${count}`:'All elements visible';}
    catch(error){diag('WARN','BIM_RESTORE_REFRESH',error?.message||String(error));}
    finally{refreshing=false;}
  }
  function install(){
    const button=document.getElementById('restore-all-elements');
    if(button&&!button.dataset.revexR93Canonical){
      button.dataset.revexR93Canonical='1';
      button.addEventListener('click',event=>{
        event.preventDefault();event.stopImmediatePropagation();
        void restoreAll().catch(error=>{
          if(button){button.disabled=false;button.textContent='Restore all hidden / deleted';}
          diag('ERROR','BIM_RESTORE_ALL_CANONICAL',error?.message||String(error));
          const node=document.getElementById('viewer-message');if(node){node.textContent=`Restore All failed: ${error?.message||error}`;node.hidden=false;}
        });
      },true);
    }
    void refreshRestore();
  }
  root.__revexCriticalControlsR93.restoreAll=restoreAll;
  const start=()=>{install();setTimeout(install,300);setTimeout(install,1200);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  root.addEventListener('revex:authoritative-project-bound',()=>setTimeout(install,0));
  root.addEventListener('revex:source-revision-loaded',()=>setTimeout(install,0));
  root.addEventListener('revex:bim-overlays-changed',()=>setTimeout(refreshRestore,0));
  diag('INFO','CRITICAL_CONTROLS_R93','Canonical Store-backed critical controls installed.');
})(window);
