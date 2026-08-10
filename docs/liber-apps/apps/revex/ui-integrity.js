(function(root){
  'use strict';
  const BUILD='20260810r24';
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
  function bind(){
    const select=document.getElementById('project-select');
    if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels();});}
    updateProjectId();enforceLabels();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  setTimeout(bind,250);setTimeout(bind,1000);
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',labels:'source-text',observer:false});
})(window);
