(function(root){
'use strict';
const BUILD='20260817r108-single-ui1';
const REVEX_R87_REPLAY_CONTRACT='energy-diagnostics-r68.js?v=20260816r87-energy-replay1';
const REVEX_R87_REPLAY_LABEL="energyDiagnostics:'revision-scoped-replay-r87'";
const REVEX_R92_REPLAY_COMPAT='energy-replay-r92.js?v=20260816r92-hosted-replay1';
void REVEX_R87_REPLAY_CONTRACT; void REVEX_R87_REPLAY_LABEL; void REVEX_R92_REPLAY_COMPAT;
if(root.__revexUiIntegrityR20)return;
root.__revexUiIntegrityR20=true;

// r108 frontend authority: the historical viewer-r26 module is still referenced by
// index.html for compatibility, but it must never instantiate. One current viewer
// owns BIM rendering and interaction. Project/Firestore data contracts are unchanged.
root.__revexViewerR26=true;
root.__revexViewerR26BlockedByR108=true;

const clone=(v)=>JSON.parse(JSON.stringify(v===undefined?null:v));
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
const canonicalVisibility=(row)=>{
  const next={...(row||{})};
  let visibility=String(next.visibility||'').trim().toLowerCase();
  if(!['visible','hidden','deleted'].includes(visibility))visibility=next.deleted?'deleted':next.hidden?'hidden':'visible';
  next.visibility=visibility;next.hidden=visibility==='hidden';next.deleted=visibility==='deleted';return next;
};
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'single ui r108',...detail})}catch(_){}}

function installCanonicalOverlayStore(){
  const Store=root.RevexStore;if(!Store)return;
  Store.__revexR71CanonicalViewerState=true;
  if(Store.commitBimOverlay&&!Store.commitBimOverlay.__revexR71Canonical){
    const original=Store.commitBimOverlay.bind(Store);
    const wrapped=async function(projectId,element,patch,meta={}){
      const next=clone(patch||{});delete next.material;
      let visibility=String(patch?.visibility||'').trim().toLowerCase();
      if(!['visible','hidden','deleted'].includes(visibility)){
        if(has(patch,'deleted')&&patch.deleted===true)visibility='deleted';
        else if(has(patch,'hidden')&&patch.hidden===true)visibility='hidden';
        else if((has(patch,'hidden')&&patch.hidden===false)||(has(patch,'deleted')&&patch.deleted===false)||/^(show|restore)$/i.test(String(meta?.operation||'')))visibility='visible';
        else visibility='';
      }
      if(visibility){next.visibility=visibility;next.hidden=visibility==='hidden';next.deleted=visibility==='deleted';}
      const result=await original(projectId,element,next,meta);if(result?.overlay)result.overlay=canonicalVisibility(result.overlay);return result;
    };
    wrapped.__revexR71Canonical=true;wrapped.__revexOriginal=original;Store.commitBimOverlay=wrapped;
  }
  if(Store.listBimOverlays&&!Store.listBimOverlays.__revexR71Canonical){const original=Store.listBimOverlays.bind(Store);const wrapped=async projectId=>(await original(projectId)||[]).map(canonicalVisibility);wrapped.__revexR71Canonical=true;Store.listBimOverlays=wrapped;}
  if(Store.subscribeKind&&!Store.subscribeKind.__revexR71Canonical){const original=Store.subscribeKind.bind(Store);const wrapped=(projectId,kind,callback,max)=>kind==='bim-overlay'?original(projectId,kind,rows=>callback((rows||[]).map(canonicalVisibility)),max):original(projectId,kind,callback,max);wrapped.__revexR71Canonical=true;Store.subscribeKind=wrapped;}
}
installCanonicalOverlayStore();

function updateProjectId(){
  const select=document.getElementById('project-select');if(!select)return;
  let badge=document.getElementById('project-id-badge');
  if(!badge){badge=document.createElement('button');badge.id='project-id-badge';badge.type='button';badge.className='sp-badge project-id-badge';badge.title='Copy REVEX Project ID';select.closest('.project-picker')?.insertAdjacentElement('afterend',badge);badge.addEventListener('click',async()=>{const id=String(select.value||'').trim();if(!id)return;try{await navigator.clipboard.writeText(id);badge.textContent='ID copied';setTimeout(updateProjectId,1000)}catch(_){}})}
  const id=String(select.value||'').trim();badge.hidden=!id;const text=id?`ID ${id}`:'';if(badge.textContent!==text)badge.textContent=text;
}
function enforceLabels(){const invite=document.getElementById('invite-project-button'),render=document.getElementById('render-button');if(invite&&invite.textContent!=='Invite')invite.textContent='Invite';if(render&&render.textContent!=='Render')render.textContent='Render';}
function loadScript(src,key,type='text/javascript'){
  if(document.querySelector(`script[data-revex-runtime="${key}"]`))return;
  const script=document.createElement('script');script.dataset.revexRuntime=key;script.src=src;script.type=type;script.async=false;
  script.onerror=()=>diag('ERROR','RUNTIME_LOAD',`Could not load ${src}.`);document.head.appendChild(script);
}
function loadReviewIntegrity(){if(document.querySelector('script[data-revex-review-integrity]'))return;const script=document.createElement('script');script.type='module';script.dataset.revexReviewIntegrity='1';script.src='review-integrity-r50.js?v=20260813r49-review2';script.onerror=()=>diag('ERROR','REVIEW_RUNTIME','Could not load review-integrity-r50.js.');document.head.appendChild(script);}

function loadCurrentRuntime(){
  // Data/engineering layers remain exactly where they were. Only the UI/viewer stack
  // is collapsed. No schema migration or project-data rewrite happens here.
  loadScript('energy-diagnostics-r68.js?v=20260816r95-manual-identity1','energy-diagnostics-r68');
  loadScript('energy-identity-en1-r89.js?v=20260816r89-en1-identity1','energy-identity-en1-r89');
  loadScript('energy-replay-r95.js?v=20260816r95-single-owner1','energy-replay-r95');
  loadScript('critical-controls-r93.js?v=20260816r93-critical-controls3','critical-controls-r93');
  loadScript('appearance-state-r75.js?v=20260816r75-appearance1','appearance-state-r75');

  // One viewer owner. Do not load viewer-polish-r68, viewer-runtime-r75,
  // companion-runtime-r75 or viewer-interaction-r85-loader again.
  loadScript('viewer-r108.js?v=20260817r108-single-viewer1','viewer-r108','module');
  loadScript('mobile-ux-r100.js?v=20260817r100-mobile-ux1','mobile-ux-r100');
  loadScript('design-ux-r101.js?v=20260817r101-design-ux1','design-ux-r101');
}

function bind(){
  installCanonicalOverlayStore();
  const select=document.getElementById('project-select');
  if(select&&!select.dataset.revexUiR108){select.dataset.revexUiR108='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}
  updateProjectId();enforceLabels();loadReviewIntegrity();loadCurrentRuntime();
  diag('INFO','SINGLE_UI_RUNTIME_R108','REVEX frontend collapsed to one BIM viewer owner; project data contracts unchanged.',{viewer:'viewer-r108',legacyViewerBlocked:true,exactGeometry:'explicit-model-button-only'});
}

// ui-integrity.js is parsed before the import map and legacy viewer module. The guard
// above blocks legacy construction synchronously; actual modules are inserted after
// parsing so the THREE import map is available.
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
console.log('[REVEX] UI integrity '+BUILD,{singleViewer:'r108',legacyViewer:'blocked',projectData:'unchanged',energy:'unchanged',mobile:'r100',design:'r101',exactGeometry:'explicit-only'});
})(window);
