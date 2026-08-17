(function(root){
  'use strict';
  if(root.__revexViewerInteractionR85Loader)return;
  root.__revexViewerInteractionR85Loader=true;
  const diagnostic=(stage,error)=>{
    try{root.__revexBrowserDiagnostics?.emit?.('ERROR',stage,error?.message||String(error),{initiator:'viewer interaction r85 loader'});}catch(_){}
  };
  const load=async()=>{
    // Energy job recovery and the malformed-key guard must not wait behind viewer
    // interaction module loading. Start both independently so a slow/broken viewer
    // enhancement cannot detach the managed Energy control edge.
    const liveEdge=import('./live-worker-edge-r97.js?v=20260817r114-durable-energy1')
      .catch(error=>{diagnostic('R114_LIVE_EDGE_LOAD',error);console.error('[REVEX] r114 live worker edge failed to load',error);});
    const viewer=import('./viewer-interaction-r85.js?v=20260816r85-viewer-interaction1')
      .catch(error=>{diagnostic('R85_INTERACTION_LOAD',error);console.error('[REVEX] r85 interaction module failed to load',error);});
    await Promise.all([liveEdge,viewer]);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load,{once:true});else void load();
})(window);
