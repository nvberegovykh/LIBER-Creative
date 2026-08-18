(function(root){
'use strict';
const BUILD='20260817r126-docs-owner1';
if(root.__revexDocsConvergenceR126)return;
root.__revexDocsConvergenceR126={build:BUILD,owner:'docs-pages-r115',fullSetAuthority:true};
let scheduled=false,repairing=false,observer=null;
const byId=id=>document.getElementById(id);
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'docs convergence r126',...detail})}catch(_){}}
function r115Ready(){return root.__revexDocsPagesR115?.fullSetAuthority===true}
function legacyOwnsTree(host){
 if(!host)return false;
 if(host.querySelector('.docs-group.printing-set details'))return true;
 if(host.querySelector('[data-printing-set]:not([data-r115-set])'))return true;
 const sets=[...host.querySelectorAll('.docs-group.printing-set')];
 return sets.length>0&&sets.some(set=>!set.hasAttribute('data-r115-set'));
}
function requestCanonicalRender(reason='mutation'){
 if(repairing||!r115Ready())return false;
 const search=byId('docs-search');if(!search)return false;
 repairing=true;
 try{
   // Legacy app.js and sync-docs listeners render synchronously. r115 intentionally
   // schedules its own render in a microtask, so dispatching one input event makes
   // the canonical Full Set + linked one-page projection the final DOM owner.
   search.dispatchEvent(new Event('input',{bubbles:true}));
   diag('INFO','DOCS_OWNER_R126','Reasserted canonical Docs renderer.',{reason});
   return true;
 }finally{queueMicrotask(()=>{repairing=false})}
}
function schedule(reason){
 if(scheduled)return;scheduled=true;
 queueMicrotask(()=>{scheduled=false;const host=byId('docs-tree');if(!host)return;if(legacyOwnsTree(host))requestCanonicalRender(reason)});
}
function bind(){
 const host=byId('docs-tree');if(!host||!r115Ready())return false;
 observer?.disconnect?.();
 observer=new MutationObserver(()=>schedule('legacy-dom-write'));
 observer.observe(host,{childList:true,subtree:true});
 for(const event of['revex:r24-revision','revex:source-revision-loaded','revex:authoritative-project-bound'])root.addEventListener(event,()=>setTimeout(()=>requestCanonicalRender(event),0));
 document.querySelector('[data-view="docs"]')?.addEventListener('click',()=>setTimeout(()=>requestCanonicalRender('docs-open'),0));
 setTimeout(()=>requestCanonicalRender('startup'),0);
 setTimeout(()=>schedule('startup-audit'),300);
 diag('INFO','DOCS_OWNER_R126','Docs ownership converged: r115 is the only final printing-set renderer.',{legacyRenderers:'allowed-to-sync-data-not-own-final-DOM'});
 return true;
}
let attempts=0;const timer=setInterval(()=>{attempts++;if(bind()||attempts>120)clearInterval(timer)},50);
})(window);
