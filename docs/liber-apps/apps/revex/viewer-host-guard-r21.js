(function(root){
  'use strict';
  if(root.__revexViewerHostGuardR21) return;
  root.__revexViewerHostGuardR21=true;
  const host=document.getElementById('viewer');
  if(!host) return;
  host.id='viewer-r21-host';
  root.__revexViewerHostR21=host;
  const message=document.getElementById('viewer-message');
  const restore=()=>{
    if(host.id!=='viewer') host.id='viewer';
    root.dispatchEvent(new CustomEvent('revex:viewer-host-ready'));
  };
  const ready=()=>String(message?.textContent||'').includes('3D acceleration is unavailable');
  if(ready()) restore();
  else {
    const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();restore();}});
    if(message) observer.observe(message,{childList:true,subtree:true,characterData:true});
    setTimeout(()=>{observer.disconnect();restore();},5000);
  }
  console.log('[REVEX] viewer host guard 20260810r21',{legacyCanvasSuppressed:true});
})(window);
