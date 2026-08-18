(function(root){
'use strict';
const BUILD='20260818r129-freeze-guard1';
if(root.__revexRenderConvergenceR126)return;
root.__revexRenderConvergenceR126={build:BUILD,providerOwner:'render-agent.js',browserInference:false,localModelCache:false,legacyIframe:false,selfHostedEnhancementOptional:true,interactionGuard:'idempotent-frame-src-only'};
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'render convergence current',...detail})}catch(_){}}
function suppressLegacyFrame(){
  const frame=document.getElementById('render-frame');
  if(!frame)return false;
  const clean=()=>{
    const src=String(frame.getAttribute('src')||'');
    if(src&&src!=='about:blank'){
      frame.setAttribute('src','about:blank');
      diag('WARN','RENDER_LEGACY_FRAME_CURRENT','Suppressed legacy external Render iframe navigation.',{src});
    }
    if(!frame.hidden)frame.hidden=true;
    const empty=document.getElementById('render-frame-empty');
    if(empty&&!empty.hidden)empty.hidden=true;
  };
  clean();
  if(!frame.__revexCurrentObserver){
    frame.__revexCurrentObserver=new MutationObserver((mutations)=>{
      if(mutations.some((mutation)=>mutation.type==='attributes'&&mutation.attributeName==='src'))clean();
    });
    frame.__revexCurrentObserver.observe(frame,{attributes:true,attributeFilter:['src']});
  }
  return true;
}
function preserveGoogleOwner(){
  const panel=document.getElementById('render-agent-panel');
  if(!panel)return false;
  const cap=document.getElementById('render-agent-capability');
  if(cap&&/revex gpu|server warm/i.test(cap.textContent||'')){
    if(cap.textContent!=='Google AI · permission required')cap.textContent='Google AI · permission required';
    if(cap.dataset.tone!=='quiet')cap.dataset.tone='quiet';
  }
  const connect=document.getElementById('google-ai-connect');
  if(connect?.hasAttribute('hidden'))connect.removeAttribute('hidden');
  const button=document.getElementById('render-google-generate');
  if(button&&!button.disabled&&button.textContent!=='Render current viewport')button.textContent='Render current viewport';
  const runtime=panel.querySelector('.render-selfhost-runtime');
  if(runtime&&!runtime.hidden)runtime.hidden=true;
  const fallback=document.getElementById('revex-google-fallback');
  if(fallback&&!fallback.hidden)fallback.hidden=true;
  return true;
}
function converge(){
  suppressLegacyFrame();
  const ready=preserveGoogleOwner();
  if(ready)diag('INFO','RENDER_CLIENT_CURRENT','Render converged on render-agent.js Google image path without a broad DOM observer; self-hosted Qwen remains a non-owning enhancement.',{providerOwner:'render-agent.js',browserInference:false,localModelCache:false,legacyIframe:false,interactionGuard:'idempotent-frame-src-only'});
  return ready;
}
let tries=0;
const timer=setInterval(()=>{
  tries++;
  if(converge()||tries>240)clearInterval(timer);
},50);
document.addEventListener('click',(event)=>{
  if(event.target?.closest?.('#render-button,#element-render,#design-render,#revex-r110-render'))setTimeout(converge,0);
},true);
root.addEventListener('revex:source-revision-loaded',()=>setTimeout(converge,30));
})(window);
