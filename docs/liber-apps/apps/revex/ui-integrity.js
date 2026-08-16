(function(root){
  'use strict';
  const BUILD='20260816r72';
  if(root.__revexUiIntegrityR20) return;
  root.__revexUiIntegrityR20=true;

  const clone=(value)=>JSON.parse(JSON.stringify(value===undefined?null:value));
  const has=(object,key)=>Object.prototype.hasOwnProperty.call(object||{},key);
  const canonicalVisibility=(row)=>{
    const next={...(row||{})};
    let visibility=String(next.visibility||'').trim().toLowerCase();
    if(!['visible','hidden','deleted'].includes(visibility)) visibility=next.deleted?'deleted':next.hidden?'hidden':'visible';
    next.visibility=visibility;
    next.hidden=visibility==='hidden';
    next.deleted=visibility==='deleted';
    return next;
  };

  // This guard is intentionally installed synchronously while ui-integrity.js
  // is parsed, before app.js can hydrate a project or establish live listeners.
  // Each Store method is guarded independently because compatibility runtimes
  // may define methods later in startup. Visibility is one state; material
  // appearance is never a geometry overlay.
  function installCanonicalOverlayStore(){
    const Store=root.RevexStore;
    if(!Store)return;
    Store.__revexR71CanonicalViewerState=true;

    if(Store.commitBimOverlay&&!Store.commitBimOverlay.__revexR71Canonical){
      const original=Store.commitBimOverlay.bind(Store);
      const wrapped=async function(projectId,element,patch,meta={}){
        const next=clone(patch||{});
        delete next.material;
        let visibility=String(patch?.visibility||'').trim().toLowerCase();
        if(!['visible','hidden','deleted'].includes(visibility)){
          if(has(patch,'deleted')&&patch.deleted===true) visibility='deleted';
          else if(has(patch,'hidden')&&patch.hidden===true) visibility='hidden';
          else if((has(patch,'hidden')&&patch.hidden===false)||(has(patch,'deleted')&&patch.deleted===false)||/^(show|restore)$/i.test(String(meta?.operation||''))) visibility='visible';
          else visibility='';
        }
        if(visibility){
          next.visibility=visibility;
          next.hidden=visibility==='hidden';
          next.deleted=visibility==='deleted';
        }
        const result=await original(projectId,element,next,meta);
        if(result?.overlay) result.overlay=canonicalVisibility(result.overlay);
        return result;
      };
      wrapped.__revexR71Canonical=true;
      wrapped.__revexOriginal=original;
      Store.commitBimOverlay=wrapped;
    }

    if(Store.listBimOverlays&&!Store.listBimOverlays.__revexR71Canonical){
      const original=Store.listBimOverlays.bind(Store);
      const wrapped=async projectId=>(await original(projectId)||[]).map(canonicalVisibility);
      wrapped.__revexR71Canonical=true;
      wrapped.__revexOriginal=original;
      Store.listBimOverlays=wrapped;
    }

    if(Store.subscribeKind&&!Store.subscribeKind.__revexR71Canonical){
      const original=Store.subscribeKind.bind(Store);
      const wrapped=(projectId,kind,callback,max)=>kind==='bim-overlay'
        ? original(projectId,kind,rows=>callback((rows||[]).map(canonicalVisibility)),max)
        : original(projectId,kind,callback,max);
      wrapped.__revexR71Canonical=true;
      wrapped.__revexOriginal=original;
      Store.subscribeKind=wrapped;
    }
  }
  installCanonicalOverlayStore();

  function updateProjectId(){
    const select=document.getElementById('project-select'); if(!select) return;
    let badge=document.getElementById('project-id-badge');
    if(!badge){
      badge=document.createElement('button'); badge.id='project-id-badge';badge.type='button';badge.className='sp-badge project-id-badge';badge.title='Copy REVEX Project ID';
      select.closest('.project-picker')?.insertAdjacentElement('afterend',badge);
      badge.addEventListener('click',async()=>{const id=String(select.value||'').trim();if(!id)return;try{await navigator.clipboard.writeText(id);badge.textContent='ID copied';setTimeout(updateProjectId,1000);}catch(_){}});
    }
    const id=String(select.value||'').trim(); badge.hidden=!id;
    const text=id?`ID ${id}`:''; if(badge.textContent!==text)badge.textContent=text;
  }

  function enforceLabels(){
    const invite=document.getElementById('invite-project-button'), render=document.getElementById('render-button');
    if(invite&&invite.textContent!=='Invite')invite.textContent='Invite';
    if(render&&render.textContent!=='Render')render.textContent='Render';
  }

  function loadScript(src,key,type='text/javascript'){
    if(document.querySelector(`script[data-revex-runtime="${key}"]`))return;
    const script=document.createElement('script');
    script.dataset.revexRuntime=key;script.src=src;script.type=type;script.async=false;
    script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','R72_RUNTIME',`Could not load ${src}.`,{initiator:'ui integrity loader'});
    document.head.appendChild(script);
  }

  function loadReviewIntegrity(){
    if(document.querySelector('script[data-revex-review-integrity]')) return;
    const script=document.createElement('script');
    script.type='module';
    script.dataset.revexReviewIntegrity='1';
    script.src='review-integrity-r50.js?v=20260813r49-review2';
    script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','REVIEW_RUNTIME','Could not load review-integrity-r50.js.',{initiator:'ui integrity loader'});
    document.head.appendChild(script);
  }

  function loadCurrentRepairs(){
    loadScript('docs-pages-r68.js?v=20260816r68-doc-pages1','docs-pages-r68');
    loadScript('energy-diagnostics-r68.js?v=20260816r68-energy-diagnostics1','energy-diagnostics-r68');
    loadScript('viewer-polish-r68.js?v=20260816r68-viewer-polish1','viewer-polish-r68','module');
    loadScript('appearance-r70.js?v=20260816r70-appearance1','appearance-r70');
    loadScript('companion-state-r71.js?v=20260816r71-state1','companion-state-r71');
    loadScript('model-filter-r71.js?v=20260816r71-filter1','model-filter-r71');
    loadScript('viewer-runtime-r72.js?v=20260816r72-nonblocking1','viewer-runtime-r72');
    loadScript('material-modal-r72.js?v=20260816r72-material-modal1','material-modal-r72');
  }

  function bind(){
    installCanonicalOverlayStore();
    const select=document.getElementById('project-select');
    if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}
    updateProjectId();enforceLabels();loadReviewIntegrity();loadCurrentRepairs();
  }

  // Begin loading repair runtimes immediately; bind() remains idempotent and
  // completes DOM-dependent controls once the document is ready.
  loadReviewIntegrity();
  loadCurrentRepairs();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  setTimeout(bind,250);setTimeout(bind,1000);
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',labels:'source-text',reviewRuntime:'r49-review2',docsPages:'real-single-page-pdf',viewerPolish:'r68',energyFailureEvidence:'exact',appearance:'r70-storage-r72-incremental-render',canonicalViewerState:'r71-before-hydration',appearanceLive:'r71',modelFilter:'family-type-full-index-r71',viewerRuntime:'r72-nonblocking-shadow-patches',materialIntegration:'r72-single-modal',targetFps:30,spatialObjects:'invisible'});
})(window);
