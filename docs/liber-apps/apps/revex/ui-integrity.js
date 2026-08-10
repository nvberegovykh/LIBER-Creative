(function(root){
  'use strict';
  const BUILD='20260810r10';
  let applying=false;

  function canonicalize(){
    if(applying) return;
    applying=true;
    try{
      const nav=document.querySelector('.main-nav');
      const invite=document.getElementById('invite-project-button');
      const render=document.getElementById('render-button');
      const projectId=String(document.getElementById('project-select')?.value||'').trim();

      if(invite){
        invite.textContent='Invite';
        invite.type='button';
        invite.hidden=false;
        invite.disabled=!projectId;
        invite.setAttribute('aria-label','Invite people to the active REVEX project');
        invite.title='Invite to project';
      }
      if(render){
        render.textContent='Render';
        render.type='button';
        render.hidden=false;
        render.setAttribute('aria-label','Open REVEX Render');
        render.title='Render';
      }

      if(nav){
        // There is exactly one canonical Invite and one canonical Render action.
        [...nav.querySelectorAll('button')].forEach((button)=>{
          if(button===invite||button===render||button.matches('[data-view]')) return;
          const text=String(button.textContent||'').trim().toLowerCase();
          if(text==='invite'||text==='render') button.remove();
        });
        const spacer=nav.querySelector('.nav-spacer');
        if(spacer&&invite&&render){
          spacer.after(invite);
          invite.after(render);
        }
      }

      // Legacy Drive model-source controls must never be visible in REVEX.
      const drive=document.getElementById('project-drive-id');
      if(drive){
        drive.type='hidden';
        drive.value='';
        const label=drive.closest('label');
        if(label) label.remove();
      }
      [...document.querySelectorAll('#project-dialog label')].forEach((label)=>{
        if(/google\s*drive|central\s*file/i.test(label.textContent||'')) label.remove();
      });
    }finally{ applying=false; }
  }

  function start(){
    canonicalize();
    const observer=new MutationObserver(canonicalize);
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','disabled']});
    document.getElementById('project-select')?.addEventListener('change',canonicalize);
    root.addEventListener('pageshow',canonicalize);
    root.addEventListener('focus',canonicalize);
    setTimeout(canonicalize,0);
    setTimeout(canonicalize,300);
    setTimeout(canonicalize,1200);
    console.log('[REVEX] UI integrity '+BUILD,{invite:'canonical',render:'canonical',driveModelSource:false});
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})(window);
