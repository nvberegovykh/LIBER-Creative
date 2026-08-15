(function(root){
  'use strict';
  const BUILD='20260815r49-design-release1';
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

  function loadReviewIntegrity(){
    if(document.querySelector('script[data-revex-review-integrity]')) return;
    const script=document.createElement('script');
    script.type='module';
    script.dataset.revexReviewIntegrity='1';
    script.src='review-integrity-r50.js?v=20260813r49-review1';
    script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','REVIEW_RUNTIME','Could not load review-integrity-r50.js.',{initiator:'ui integrity loader'});
    document.head.appendChild(script);
  }

  function loadDesignRelease(){
    if(root.__revexDesignReleaseR51||document.querySelector('script[data-revex-design-release]')) return;
    const script=document.createElement('script');
    script.async=false;
    script.dataset.revexDesignRelease='1';
    script.src='design-release-r51.js?v=20260815r49-design-release1';
    script.onerror=()=>root.__revexBrowserDiagnostics?.emit?.('ERROR','DESIGN_RELEASE_RUNTIME','Could not load design-release-r51.js.',{initiator:'ui integrity loader'});
    document.head.appendChild(script);
  }

  function bind(){
    const select=document.getElementById('project-select');
    if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}
    updateProjectId();enforceLabels();loadReviewIntegrity();loadDesignRelease();
  }

  loadDesignRelease();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  setTimeout(bind,250);setTimeout(bind,1000);
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',labels:'source-text',reviewRuntime:'r49-review1',designBookReleaseModel:'r51',spatialObjects:'invisible'});
})(window);
