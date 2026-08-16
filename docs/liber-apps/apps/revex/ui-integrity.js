(function(root){
  'use strict';
  const BUILD='20260816r79';
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

  function installCanonicalOverlayStore(){
    const Store=root.RevexStore;
    if(!Store)return;
    Store.__revexR71CanonicalViewerState=true;
    if(Store.commitBimOverlay&&!Store.commitBimOverlay.__revexR71Canonical){
      const original=Store.commitBimOverlay.bind(Store);
      const wrapped=async function(projectId,element,patch,meta={}){
        const next=clone(patch||{});delete next.material;
        let visibility=String(patch?.visibility||'').trim().toLowerCase();
        if(!['visible','hidden','deleted'].includes(visibility)){
          if(has(patch,'deleted')&&patch.deleted===true) visibility='deleted';
          else if(has(patch,'hidden')&&patch.hidden===true) visibility='hidden';
          else if((has(patch,'hidden')&&patch.hidden===false)||(has(patch,'deleted')&&patch.deleted===false)||/^(show|restore)$/i.test(String(meta?.operation||''))) visibility='visible';
          else visibility='';
        }
        if(visibility){next.visibility=visibility;next.hidden=visibility==='hidden';next.deleted=visibility==='deleted';}
        const result=await original(projectId,element,next,meta);if(result?.overlay)result.overlay=canonicalVisibility(result.overlay);return result;
      };
      wrapped.__revexR71Canonical=true;wrapped.__revexOriginal=original;Store.commitBimOverlay=wrapped;
    }
    if(Store.listBimOverlays&&!Store.listBimOverlays.__revexR71Canonical){const original=Store.listBimOverlays.bind(Store);const wrapped=async projectId=>(await original(projectId)||[]).map(canonicalVisibility);wrapped.__revexR71Canonical=true;wrapped.__revexOriginal=original;Store.listBimOverlays=wrapped;}
    if(Store.subscribeKind&&!Store.subscribeKind.__revexR71Canonical){const original=Store.subscribeKind.bind(Store);const wrapped=(projectId,kind,callback,max)=>kind==='bim-overlay'?original(projectId,kind,rows=>callback((rows||[]).map(canonicalVisibility)),max):original(projectId,kind,callback,max);wrapped.__revexR71Canonical=true;wrapped.__revexOriginal=original;Store.subscribeKind=wrapped;}
  }
  installCanonicalOverlayStore();

  function updateProjectId(){const select=document.getElementById('project-select');if(!select)return;let badge=document.getElementById('project-id-badge');if(!badge){badge=document.createElement('button');badge.id='project-id-badge';badge.type='button';badge.className='sp-badge project-id-badge';badge.title='Copy REVEX Project ID';select.closest('.project-picker')?.insertAdjacentElement('afterend',badge);badge.addEventListener('click',async()=>{const id=String(select.value||'').trim();if(!id)return;try{await navigator.clipboard.writeText(id);badge.textContent='ID copied';setTimeout(updateProjectId,1000)}catch(_){}})}const id=String(select.value||'').trim();badge.hidden=!id;const text=id?`ID ${id}`:'';if(badge.textContent!==text)badge.textContent=text;}
  function enforceLabels(){const invite=document.getElementById('invite-project-button'),render=document.getElementById('render-button');if(invite&&invite.textContent!=='Invite')invite.textContent='Invite';if(render&&render.textContent!=='Render')render.textContent='Render';}
  function loadScript(src,key,type='text/javascript'){if(document.querySelector(`script[data-revex-runtime="${key}"]`))return;const script=document.createElement('script');script.dataset.revexRuntime=key;script.src=src;script.type=type;script.async=false;script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','R79_RUNTIME',`Could not load ${src}.`,{initiator:'ui integrity loader'});document.head.appendChild(script);}
  function loadReviewIntegrity(){if(document.querySelector('script[data-revex-review-integrity]'))return;const script=document.createElement('script');script.type='module';script.dataset.revexReviewIntegrity='1';script.src='review-integrity-r50.js?v=20260813r49-review2';script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','REVIEW_RUNTIME','Could not load review-integrity-r50.js.',{initiator:'ui integrity loader'});document.head.appendChild(script);}
  function loadCurrentRepairs(){
    // r75 remains the consolidated data/UI owner. r79 repairs only the four
    // interfaces proven broken in live WebView testing: pick routing, auth-time
    // appearance rehydrate, Restore All persistence fallback, adaptive proxy use.
    loadScript('energy-diagnostics-r68.js?v=20260816r68-energy-diagnostics1','energy-diagnostics-r68');
    loadScript('viewer-polish-r68.js?v=20260816r68-viewer-polish1','viewer-polish-r68','module');
    loadScript('appearance-state-r75.js?v=20260816r75-appearance1','appearance-state-r75');
    loadScript('viewer-runtime-r75.js?v=20260816r75-viewer1','viewer-runtime-r75');
    loadScript('companion-runtime-r75.js?v=20260816r75-companion1','companion-runtime-r75');
    loadScript('viewer-repair-r79.js?v=20260816r79-viewer-repair1','viewer-repair-r79');
  }
  function bind(){installCanonicalOverlayStore();const select=document.getElementById('project-select');if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}updateProjectId();enforceLabels();loadReviewIntegrity();loadCurrentRepairs();}
  loadReviewIntegrity();loadCurrentRepairs();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',reviewRuntime:'r49-review2',docsPages:'native-pdf-page-navigation-no-main-thread-split',viewerPolish:'r68',appearance:'single-owner-r75+auth-rehydrate-r79',modelFilter:'single-owner-r75',viewerRuntime:'r75-preemptible+r79-adaptive-exact',materialIntegration:'embedded-properties-architextures-user-download-auto-apply',restoreAll:'setDoc-fallback-r79',selection:'viewer-to-properties-r79',targetFps:30,spatialObjects:'invisible'});
})(window);
