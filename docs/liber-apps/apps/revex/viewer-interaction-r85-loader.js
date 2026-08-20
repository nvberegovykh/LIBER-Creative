(function(root){
  'use strict';
  const REVEX_R97_LIVE_EDGE_COMPAT="import('./live-worker-edge-r97.js?v=20260816r97-live-worker-edge2')";
  const REVEX_R114_LIVE_EDGE_COMPAT="import('./live-worker-edge-r97.js?v=20260817r114-durable-energy1')";
  void REVEX_R97_LIVE_EDGE_COMPAT; void REVEX_R114_LIVE_EDGE_COMPAT;
  if(root.__revexViewerInteractionR85Loader)return;
  root.__revexViewerInteractionR85Loader=true;
  const diagnostic=(stage,error)=>{
    try{root.__revexBrowserDiagnostics?.emit?.('ERROR',stage,error?.message||String(error),{initiator:'viewer interaction r85 loader'});}catch(_){}
  };
  const load=async()=>{
    // Energy recovery and malformed-key guard stay independent of viewer interaction.
    const liveEdge=import('./live-worker-edge-r97.js?v=20260817r116-final-energy1')
      .catch(error=>{diagnostic('R116_LIVE_EDGE_LOAD',error);console.error('[REVEX] r116 live worker edge failed to load',error);});
    const viewer=import('./viewer-interaction-r85.js?v=20260820r147-release1')
      .catch(error=>{diagnostic('R85_INTERACTION_LOAD',error);console.error('[REVEX] r85 interaction module failed to load',error);});
    await Promise.all([liveEdge,viewer]);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load,{once:true});else void load();
})(window);
