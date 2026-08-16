(function(root){
  'use strict';
  if(root.__revexViewerInteractionR85Loader)return;
  root.__revexViewerInteractionR85Loader=true;
  const load=()=>import('./viewer-interaction-r85.js?v=20260816r85-viewer-interaction1').catch(error=>{
    try{root.__revexBrowserDiagnostics?.emit?.('ERROR','R85_INTERACTION_LOAD',error?.message||String(error),{initiator:'viewer interaction r85 loader'});}catch(_){}
    console.error('[REVEX] r85 interaction module failed to load',error);
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load,{once:true});else load();
})(window);
