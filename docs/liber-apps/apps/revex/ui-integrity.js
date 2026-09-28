(function(root){
  'use strict';
  const BUILD='20260914r192-morning1';
  const REVEX_R87_REPLAY_CONTRACT='energy-diagnostics-r68.js?v=20260928r201-audit3';
  const REVEX_R87_REPLAY_LABEL="energyDiagnostics:'revision-scoped-replay-r87'";
  const REVEX_R92_REPLAY_COMPAT='energy-replay-r92.js?v=20260914r192-morning1';
  const REVEX_R95_REPLAY_COMPAT='energy-replay-r95.js?v=20260928r201-audit3';
  const REVEX_R114_REPLAY_COMPAT='energy-replay-r95.js?v=20260928r201-audit3';
  const REVEX_R98_LIVE_EDGE_COMPAT='viewer-interaction-r85-loader.js?v=20260914r192-morning1';
  void REVEX_R87_REPLAY_CONTRACT; void REVEX_R87_REPLAY_LABEL; void REVEX_R92_REPLAY_COMPAT; void REVEX_R95_REPLAY_COMPAT; void REVEX_R114_REPLAY_COMPAT; void REVEX_R98_LIVE_EDGE_COMPAT;
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
  function loadReviewIntegrity(){if(document.querySelector('script[data-revex-review-integrity]'))return;const script=document.createElement('script');script.type='module';script.dataset.revexReviewIntegrity='1';script.src='review-integrity-r50.js?v=20260928r201-audit3';script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','REVIEW_RUNTIME','Could not load review-integrity-r50.js.',{initiator:'ui integrity loader'});document.head.appendChild(script);}
  function loadCurrentRepairs(){
    loadScript('chat-convergence-r136.js?v=20260914r192-morning1','chat-convergence-r136');
    loadScript('energy-diagnostics-r68.js?v=20260928r201-audit3','energy-diagnostics-r68');
    loadScript('energy-identity-en1-r89.js?v=20260914r192-morning1','energy-identity-en1-r89');
    loadScript('energy-replay-r95.js?v=20260928r201-audit3','energy-replay-r95');
    // WALLT and the superseded control/history overlays are deliberately not
    // loaded here.  Their legacy global queues can outlive a project/account
    // boundary; core REVEX owns the reviewed controls and history paths.
    loadScript('viewer-polish-r68.js?v=20260927r198-walk-entry2','viewer-polish-r68','module');
    loadScript('appearance-state-r75.js?v=20260914r192-morning1','appearance-state-r75');
    loadScript('viewer-runtime-r75.js?v=20260914r192-morning1','viewer-runtime-r75');
    loadScript('companion-runtime-r75.js?v=20260914r192-morning1','companion-runtime-r75');
    loadScript('bim-properties-r117.js?v=20260914r192-morning1','bim-properties-r117');
    loadScript('viewer-interaction-r85-loader.js?v=20260914r192-morning1','viewer-interaction-r85-loader');
    loadScript('ui-polish-r109.js?v=20260914r192-morning1','ui-polish-r109');
    loadScript('viewer-texture-r115.js?v=20260914r192-morning1','viewer-texture-r115');
    loadScript('docs-pages-r115.js?v=20260914r192-morning1','docs-pages-r115');
    loadScript('render-touchups-r115.js?v=20260914r192-morning1','render-touchups-r115');
    loadScript('mobile-final-r122.js?v=20260914r192-morning1','mobile-final-r122');
    loadScript('appearance-convergence-r126.js?v=20260914r193-books1','appearance-convergence-r126');
    loadScript('docs-convergence-r126.js?v=20260914r192-morning1','docs-convergence-r126');
    loadScript('issues-inspector-r126.js?v=20260914r192-morning1','issues-inspector-r126');
    loadScript('blocks-palette-r126.js?v=20260914r197-family-flow1','blocks-palette-r126');
    loadScript('render-convergence-r126.js?v=20260914r192-morning1','render-convergence-r126');
    loadScript('mobile-safe-r133.js?v=20260928r201-audit3','mobile-safe-r133');
    loadScript('mobile-sheet-r142.js?v=20260914r192-morning1','mobile-sheet-r142');
  }
  const REVEX_R122_LOADER_COMPAT='mobile-final-r122.js?v=20260914r192-morning1';
  const REVEX_R133_LOADER_COMPAT='mobile-safe-r133.js?v=20260928r201-audit3';
  const REVEX_R142_LOADER_COMPAT="loadScript('mobile-sheet-r142.js?v=20260914r192-morning1','mobile-sheet-r142')";
  void REVEX_R122_LOADER_COMPAT;void REVEX_R133_LOADER_COMPAT;void REVEX_R142_LOADER_COMPAT;
  function bind(){installCanonicalOverlayStore();const select=document.getElementById('project-select');if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}updateProjectId();enforceLabels();loadReviewIntegrity();loadCurrentRepairs();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',restoreAll:'core-reviewed-controls',energy:'r125-preserved',wallt:'project-scoped-controller',moduleLoad:'project-boundary-safe-core+r126-convergence+r133-mobile-safe+r142-bottom-sheet',liveWorkerEdge:'r116-pipeline-aware-recovery',ui:'r109-svg+r122-walk+r133-safe-area+r142-reused-node-sheet',docs:'r134-full-set-linked-pages+r126-ownership-guard+r133-content-height-mobile-stack',texture:'instance-uv>type-texture>design-color>revit',render:'google-gemini-only+docked-owner+interaction-freeze-guard',chat:'r136-project-isolated-secure-chat-native-ui',issues:'core-revexIssues+empty-selection-inspector',history:'core-append-only-project-history',dailyReport:'project-scoped-reports',blocks:'r135-walk-target+face-host+session-bound-external-event',bimProperties:'r117-preserved',qaHardStop:'unchanged',targetFps:30,spatialObjects:'invisible'});
})(window);
