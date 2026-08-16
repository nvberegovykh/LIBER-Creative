(function(root){
  'use strict';
  const BUILD='20260816r70';
  if(root.__revexUiIntegrityR20) return;
  root.__revexUiIntegrityR20=true;

  function updateProjectId(){
    const select=document.getElementById('project-select'); if(!select) return;
    let badge=document.getElementById('project-id-badge');
    if(!badge){
      badge=document.createElement('button'); badge.id='project-id-badge';badge.type='button';badge.className='sp-badge project-id-badge';badge.title='Copy REVEX Project ID';
      select.closest('.project-picker')?.insertAdjacentElement('afterend',badge);
      badge.addEventListener('click',async()=>{const id=String(select.value||'').trim();if(!id)return;try{await navigator.clipboard.writeText(id);badge.textContent='ID copied';setTimeout(updateProjectId,1000);}catch(_){}});
    }
    const id=String(select.value||'').trim(); badge.hidden=!id;
    const text=id?`ID ${id}`:''; if(badge.textContent!==text)badge.textContent=text;
  }

  function enforceLabels(){
    const invite=document.getElementById('invite-project-button'), render=document.getElementById('render-button');
    if(invite&&invite.textContent!=='Invite')invite.textContent='Invite';
    if(render&&render.textContent!=='Render')render.textContent='Render';
  }

  function loadScript(src,key,type='text/javascript'){
    if(document.querySelector(`script[data-revex-runtime="${key}"]`))return;
    const script=document.createElement('script');
    script.dataset.revexRuntime=key;script.src=src;script.type=type;
    script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','R70_RUNTIME',`Could not load ${src}.`,{initiator:'ui integrity loader'});
    document.head.appendChild(script);
  }

  function loadReviewIntegrity(){
    if(document.querySelector('script[data-revex-review-integrity]')) return;
    const script=document.createElement('script');
    script.type='module';
    script.dataset.revexReviewIntegrity='1';
    script.src='review-integrity-r50.js?v=20260813r49-review2';
    script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','REVIEW_RUNTIME','Could not load review-integrity-r50.js.',{initiator:'ui integrity loader'});
    document.head.appendChild(script);
  }

  function loadCurrentRepairs(){
    loadScript('docs-pages-r68.js?v=20260816r68-doc-pages1','docs-pages-r68');
    loadScript('energy-diagnostics-r68.js?v=20260816r68-energy-diagnostics1','energy-diagnostics-r68');
    loadScript('viewer-polish-r68.js?v=20260816r68-viewer-polish1','viewer-polish-r68','module');
    loadScript('appearance-r70.js?v=20260816r70-appearance1','appearance-r70');
  }

  function bind(){
    const select=document.getElementById('project-select');
    if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}
    updateProjectId();enforceLabels();loadReviewIntegrity();loadCurrentRepairs();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  setTimeout(bind,250);setTimeout(bind,1000);
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',labels:'source-text',reviewRuntime:'r49-review2',docsPages:'real-single-page-pdf',viewerPolish:'r68',energyFailureEvidence:'exact',appearance:'r70-independent-type-or-instance',spatialObjects:'invisible'});
})(window);
