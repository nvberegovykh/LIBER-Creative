(function(root){
'use strict';if(root.__revexViewerHostGuardR21)return;root.__revexViewerHostGuardR21=true;root.__revexExternalViewerR21=true;
const ready=()=>{const host=document.getElementById('viewer');if(!host)return false;root.__revexViewerHostR21=host;root.dispatchEvent(new CustomEvent('revex:viewer-host-ready'));return true;};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
if(!document.querySelector('script[data-revex-sync-r29]')){const s=document.createElement('script');s.src='sync-rvx-r29.js?v=20260811r29';s.async=false;s.dataset.revexSyncR29='1';document.head.appendChild(s);}
if(!document.querySelector('script[data-revex-r28-fix]')){const s=document.createElement('script');s.type='module';s.src='viewer-r28-fix.js?v=20260811r28';s.dataset.revexR28Fix='1';document.head.appendChild(s);}
if(!document.querySelector('script[data-revex-r29-fix]')){const s=document.createElement('script');s.type='module';s.src='viewer-r29-fix.js?v=20260811r29';s.dataset.revexR29Fix='1';document.head.appendChild(s);}
console.log('[REVEX] viewer host guard 20260811r29',{singleRenderer:true,legacyRendererDisabled:true,exactRvxSyncRepair:true,fbxCompatibilityOnly:true,solidViewport:true});
})(window);
