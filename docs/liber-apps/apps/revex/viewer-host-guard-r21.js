(function(root){
'use strict';if(root.__revexViewerHostGuardR21)return;root.__revexViewerHostGuardR21=true;root.__revexExternalViewerR21=true;
const ready=()=>{const host=document.getElementById('viewer');if(!host)return false;root.__revexViewerHostR21=host;root.dispatchEvent(new CustomEvent('revex:viewer-host-ready'));return true;};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
console.log('[REVEX] viewer host guard 20260811r26',{singleRenderer:true,legacyRendererDisabled:true});
})(window);
