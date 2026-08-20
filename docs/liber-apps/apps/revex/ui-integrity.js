(function(root){
  'use strict';
  const BUILD='20260820r143-ui-recovery1';
  const REVEX_R87_REPLAY_CONTRACT='energy-diagnostics-r68.js?v=20260816r87-energy-replay1';
  const REVEX_R87_REPLAY_LABEL="energyDiagnostics:'revision-scoped-replay-r87'";
  const REVEX_R92_REPLAY_COMPAT='energy-replay-r92.js?v=20260816r92-hosted-replay1';
  const REVEX_R95_REPLAY_COMPAT='energy-replay-r95.js?v=20260816r95-single-owner1';
  const REVEX_R114_REPLAY_COMPAT='energy-replay-r95.js?v=20260817r114-durable-energy1';
  const REVEX_R98_LIVE_EDGE_COMPAT='viewer-interaction-r85-loader.js?v=20260816r98-live-edge2';
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
  function loadReviewIntegrity(){if(document.querySelector('script[data-revex-review-integrity]'))return;const script=document.createElement('script');script.type='module';script.dataset.revexReviewIntegrity='1';script.src='review-integrity-r50.js?v=20260813r49-review2';script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','REVIEW_RUNTIME','Could not load review-integrity-r50.js.',{initiator:'ui integrity loader'});document.head.appendChild(script);}
  function loadCurrentRepairs(){
    loadScript('chat-convergence-r136.js?v=20260818r136-project-chat1','chat-convergence-r136');
    loadScript('energy-diagnostics-r68.js?v=20260816r95-manual-identity1','energy-diagnostics-r68');
    loadScript('energy-identity-en1-r89.js?v=20260816r89-en1-identity1','energy-identity-en1-r89');
    loadScript('energy-replay-r95.js?v=20260817r116-final-energy1','energy-replay-r95');
    loadScript('energy-agent-review.js?v=20260818-wallt-energy-review2','energy-agent-review','module');
    loadScript('wallt-control-plane.js?v=20260818-wallt-control2','wallt-control-plane');
    loadScript('wallt-cycle-history.js?v=20260818-wallt-cycle-history1','wallt-cycle-history');
    loadScript('critical-controls-r93.js?v=20260816r93-critical-controls3','critical-controls-r93');
    loadScript('viewer-polish-r68.js?v=20260816r68-viewer-polish1','viewer-polish-r68','module');
    loadScript('appearance-state-r75.js?v=20260816r75-appearance1','appearance-state-r75');
    loadScript('viewer-runtime-r75.js?v=20260816r75-viewer1','viewer-runtime-r75');
    loadScript('companion-runtime-r75.js?v=20260816r75-companion1','companion-runtime-r75');
    loadScript('bim-properties-r117.js?v=20260817r117-bim-properties1','bim-properties-r117');
    loadScript('viewer-interaction-r85-loader.js?v=20260817r116-final-energy1','viewer-interaction-r85-loader');
    loadScript('ui-polish-r109.js?v=20260817r110-responsive1','ui-polish-r109');
    loadScript('viewer-texture-r115.js?v=20260817r126-texture-precedence1','viewer-texture-r115');
    loadScript('docs-pages-r115.js?v=20260818r134-docs-linked-pages1','docs-pages-r115');
    loadScript('render-touchups-r115.js?v=20260818r132-render-owner-guard1','render-touchups-r115');
    loadScript('mobile-final-r122.js?v=20260820r143-ui-recovery1','mobile-final-r122');
    loadScript('appearance-convergence-r126.js?v=20260817r126-appearance1','appearance-convergence-r126');
    loadScript('docs-convergence-r126.js?v=20260817r126-docs1','docs-convergence-r126');
    loadScript('issues-convergence-r126.js?v=20260817r126-issues1','issues-convergence-r126');
    loadScript('issues-inspector-r126.js?v=20260817r126-empty-selection-issues1','issues-inspector-r126');
    loadScript('history-daily-r126.js?v=20260817r126-daily1','history-daily-r126');
    loadScript('blocks-palette-r126.js?v=20260817r126-blocks1','blocks-palette-r126');
    loadScript('render-convergence-r126.js?v=20260818r129-freeze-guard1','render-convergence-r126');
    loadScript('mobile-safe-r133.js?v=20260820r143-ui-recovery1','mobile-safe-r133');
    loadScript('wallt-fixer-adapters-r137.js?v=20260818r137-fixer-adapters1','wallt-fixer-adapters-r137');
    loadScript('wallt-ui-r138.js?v=20260818r138-wallt-ui1','wallt-ui-r138');
    loadScript('mobile-sheet-r142.js?v=20260820r143-ui-recovery1','mobile-sheet-r142');
  }
  const REVEX_R122_LOADER_COMPAT='mobile-final-r122.js?v=20260817r122-mobile-final1';
  const REVEX_R133_LOADER_COMPAT='mobile-safe-r133.js?v=20260819r133-mobile-safe2';
  const REVEX_R142_LOADER_COMPAT="loadScript('mobile-sheet-r142.js?v=20260819r142-mobile-sheet1','mobile-sheet-r142')";
  void REVEX_R122_LOADER_COMPAT;void REVEX_R133_LOADER_COMPAT;void REVEX_R142_LOADER_COMPAT;
  function bind(){installCanonicalOverlayStore();const select=document.getElementById('project-select');if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}updateProjectId();enforceLabels();loadReviewIntegrity();loadCurrentRepairs();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',restoreAll:'first-capture+canonical-store-commit',energy:'r125-preserved+wallt-review',wallt:'visible-helper+bounded-fixer-adapters+24h-history+mobile-actions-menu',moduleLoad:'r126-convergence+r133-mobile-safe2+r137-fixer+r138-wallt-ui+r142-bottom-sheet',liveWorkerEdge:'r116-pipeline-aware-recovery',ui:'r109-svg+r122-walk+r133-safe-area+r142-reused-node-sheet',docs:'r134-full-set-linked-pages+r126-ownership-guard+r133-content-height-mobile-stack',texture:'instance-uv>type-texture>design-color>revit',render:'google-gemini-client+docked-owner+qwen-shadow+interaction-freeze-guard',chat:'r136-project-isolated-secure-chat-native-ui',issues:'revexIssues+all-active-default+empty-selection-inspector',history:'technical-NYC-day+wallt-24h',dailyReport:'separate-post-sync-worker',blocks:'r135-walk-target+face-host+external-event',bimProperties:'r117-preserved',qaHardStop:'unchanged',targetFps:30,spatialObjects:'invisible'});
})(window);
