(function(root){
  'use strict';
  if(root.__revexViewerInteractionR85Loader)return;
  root.__revexViewerInteractionR85Loader=true;
  const diagnostic=(stage,error)=>{
    try{root.__revexBrowserDiagnostics?.emit?.('ERROR',stage,error?.message||String(error),{initiator:'viewer interaction r85 loader'});}catch(_){}
  };
  const load=async()=>{
    try{await import('./viewer-interaction-r85.js?v=20260816r85-viewer-interaction1');}
    catch(error){diagnostic('R85_INTERACTION_LOAD',error);console.error('[REVEX] r85 interaction module failed to load',error);}
    try{await import('./live-worker-edge-r97.js?v=20260816r97-live-worker-edge2');}
    catch(error){diagnostic('R97_LIVE_EDGE_LOAD',error);console.error('[REVEX] r97 live worker edge failed to load',error);}
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load,{once:true});else void load();
})(window);
