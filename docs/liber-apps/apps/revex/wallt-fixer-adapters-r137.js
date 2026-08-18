(function(root){
'use strict';
const BUILD='20260818r137-fixer-adapters1';
if(root.__revexWalltFixerAdaptersR137)return;
const api=root.__revexWalltFixerAdaptersR137={build:BUILD,adapter:'current',reversibleLocalOnly:true,sourceMutation:false};
const state=()=>root.__revexState||null;
const byId=id=>document.getElementById(id);
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'WALLT fixer adapters r137',...detail})}catch(_){}}
function activeTab(){return document.querySelector('.main-nav [data-view].active')}
async function docsReassert(){
 const owner=root.__revexDocsPagesR115,s=state();
 if(!owner?.projectRows||!Array.isArray(s?.library))throw new Error('Current Docs owner is unavailable.');
 const before=s.library.filter(owner.legacySheet||(()=>false)).length;
 const projected=owner.projectRows(s.library);
 const search=byId('docs-search');if(search)search.dispatchEvent(new Event('input',{bubbles:true}));
 return{owner:owner.build||'docs-pages-r115',libraryRows:projected.length,foldedDetachedRows:before};
}
async function chatReset(){
 const owner=root.__revexChatConvergenceR136,s=state(),projectId=String(s?.projectId||'').trim();
 if(!projectId)throw new Error('Choose a REVEX project before repairing Chat.');
 if(typeof owner?.reset!=='function')throw new Error('Current Chat boundary owner is unavailable.');
 const tab=document.querySelector('[data-view="chat"]'),wasActive=tab?.classList?.contains('active')===true;
 owner.reset(projectId,'wallt-fixer-current');
 if(wasActive)setTimeout(()=>tab?.click?.(),0);
 return{projectId,reconnectRequested:wasActive};
}
async function bimReapplyOverlays(){
 const s=state(),viewer=root.__revexViewerR26Instance;
 if(!viewer?.setOverlays)throw new Error('Current BIM viewer owner is unavailable.');
 const overlays=s?.bimOverlays instanceof Map?[...s.bimOverlays.values()]:Array.isArray(s?.bimOverlays)?s.bimOverlays:[];
 viewer.setOverlays(overlays);viewer.requestRender?.();
 return{overlays:overlays.length,source:'current-project-state'};
}
async function bimRefit(){const viewer=root.__revexViewerR26Instance;if(!viewer?.fit)throw new Error('Current BIM viewer owner is unavailable.');viewer.fit();viewer.requestRender?.();return{fitted:true};}
async function reopenActiveView(){const tab=activeTab();if(!tab)throw new Error('No active REVEX module is available to re-open.');const view=String(tab.dataset?.view||'');tab.click();return{view};}
async function mobileReapply(){if(!root.__revexMobileSafeR133)throw new Error('Current mobile safety owner is unavailable.');root.dispatchEvent(new Event('resize'));return{build:root.__revexMobileSafeR133.build||null,reapplied:true};}
async function energyReopenReview(){const tab=document.querySelector('[data-view="energy"]');if(!tab)throw new Error('Energy module is unavailable.');tab.click();return{view:'energy',pipelineMutation:false};}
function install(){
 const control=root.__revexWalltControl;if(!control?.registerAdapter)return false;
 if(api.registered)return true;
 const unregister=control.registerAdapter('current',{
   describe:'Reversible current-owner repair actions only; no immutable source, Energy model, filing fact, deployment or database ownership mutation.',
   fixerActions:{
     docs_reassert_owner:docsReassert,
     chat_reset_active_project:chatReset,
     bim_reapply_overlays:bimReapplyOverlays,
     bim_refit_view:bimRefit,
     ui_reopen_active_view:reopenActiveView,
     mobile_reapply_constraints:mobileReapply,
     energy_reopen_review:energyReopenReview
   }
 });
 Object.assign(api,{registered:true,unregister,actions:['current:docs_reassert_owner','current:chat_reset_active_project','current:bim_reapply_overlays','current:bim_refit_view','current:ui_reopen_active_view','current:mobile_reapply_constraints','current:energy_reopen_review']});
 diag('INFO','WALLT_FIXER_ADAPTERS_R137','Registered bounded current-owner Fixer actions.',{actions:api.actions,sourceMutation:false,databaseOwner:false,energyPipelineMutation:false});
 return true;
}
Object.assign(api,{install});
let attempts=0;
let timer=null;
timer=setInterval(()=>{
 attempts++;
 if(install()||attempts>200){
   if(timer!==null)clearInterval(timer);
 }
},25);
})(window);
