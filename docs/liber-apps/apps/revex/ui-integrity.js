(function(root){
  'use strict';
  const BUILD='20260817r109-stable-ui1';
  const REVEX_R87_REPLAY_CONTRACT='energy-diagnostics-r68.js?v=20260816r87-energy-replay1';
  const REVEX_R87_REPLAY_LABEL="energyDiagnostics:'revision-scoped-replay-r87'";
  const REVEX_R92_REPLAY_COMPAT='energy-replay-r92.js?v=20260816r92-hosted-replay1';
  void REVEX_R87_REPLAY_CONTRACT; void REVEX_R87_REPLAY_LABEL; void REVEX_R92_REPLAY_COMPAT;
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
  function loadScript(src,key,type='text/javascript'){if(document.querySelector(`script[data-revex-runtime="${key}"]`))return;const script=document.createElement('script');script.dataset.revexRuntime=key;script.src=src;script.type=type;script.async=false;script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','RUNTIME_LOAD',`Could not load ${src}.`,{initiator:'ui integrity loader'});document.head.appendChild(script);}
  function loadReviewIntegrity(){if(document.querySelector('script[data-revex-review-integrity]'))return;const script=document.createElement('script');script.type='module';script.dataset.revexReviewIntegrity='1';script.src='review-integrity-r50.js?v=20260813r49-review2';script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','REVIEW_RUNTIME','Could not load review-integrity-r50.js.',{initiator:'ui integrity loader'});document.head.appendChild(script);}
  function loadCurrentRepairs(){
    loadScript('energy-diagnostics-r68.js?v=20260816r95-manual-identity1','energy-diagnostics-r68');
    loadScript('energy-identity-en1-r89.js?v=20260816r89-en1-identity1','energy-identity-en1-r89');
    loadScript('energy-replay-r95.js?v=20260816r95-single-owner1','energy-replay-r95');
    loadScript('critical-controls-r93.js?v=20260816r93-critical-controls3','critical-controls-r93');
    loadScript('viewer-polish-r68.js?v=20260816r68-viewer-polish1','viewer-polish-r68','module');
    loadScript('appearance-state-r75.js?v=20260816r75-appearance1','appearance-state-r75');
    loadScript('viewer-runtime-r75.js?v=20260816r75-viewer1','viewer-runtime-r75');
    loadScript('companion-runtime-r75.js?v=20260816r75-companion1','companion-runtime-r75');
    // Revit WebView does not register the PWA service worker, so this query token is
    // the authoritative cache break for the r97 exact-job recovery loader.
    loadScript('viewer-interaction-r85-loader.js?v=20260816r98-live-edge2','viewer-interaction-r85-loader');
    // r109 is deliberately presentation-only. It may style existing controls and add
    // a help overlay, but it does not own project data, viewer behavior, Docs, Energy,
    // or the existing tab click handlers.
    loadScript('ui-polish-r109.js?v=20260817r109-presentation1','ui-polish-r109');
  }
  function bind(){installCanonicalOverlayStore();const select=document.getElementById('project-select');if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}updateProjectId();enforceLabels();loadReviewIntegrity();loadCurrentRepairs();}
  // index.html declares the THREE import map after ui-integrity.js. Never inject a
  // module before DOM parsing reaches that import map; doing so produced the bare
  // specifier "three" error seen in the Revit WebView log.
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',restoreAll:'first-capture+canonical-store-commit',energy:'single-native-hosted-flight+manual-revision-authorization+live-job-reattach',moduleLoad:'after-import-map',liveWorkerEdge:'r97-exact-job-recovery',ui:'r109-presentation-only',qaHardStop:'unchanged',targetFps:30,spatialObjects:'invisible'});
})(window);
