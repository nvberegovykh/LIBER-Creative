(function(root){
  'use strict';
  const BUILD='20260810r10';
  let applying=false;

  function setText(node,text){
    if(node&&String(node.textContent||'').trim()!==text) node.textContent=text;
  }
  function setAttr(node,name,value){
    if(node&&node.getAttribute(name)!==value) node.setAttribute(name,value);
  }

  function canonicalize(){
    if(applying) return;
    applying=true;
    try{
      const nav=document.querySelector('.main-nav');
      const invite=document.getElementById('invite-project-button');
      const render=document.getElementById('render-button');
      const projectId=String(document.getElementById('project-select')?.value||'').trim();

      if(invite){
        setText(invite,'Invite');
        if(invite.type!=='button') invite.type='button';
        if(invite.hidden) invite.hidden=false;
        const shouldDisable=!projectId;
        if(invite.disabled!==shouldDisable) invite.disabled=shouldDisable;
        setAttr(invite,'aria-label','Invite people to the active REVEX project');
        if(invite.title!=='Invite to project') invite.title='Invite to project';
      }
      if(render){
        setText(render,'Render');
        if(render.type!=='button') render.type='button';
        if(render.hidden) render.hidden=false;
        setAttr(render,'aria-label','Open REVEX Render');
        if(render.title!=='Render') render.title='Render';
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
          if(spacer.nextElementSibling!==invite) spacer.after(invite);
          if(invite.nextElementSibling!==render) invite.after(render);
        }
      }

      // Legacy Drive model-source controls must never be visible in REVEX.
      const drive=document.getElementById('project-drive-id');
      if(drive){
        if(drive.type!=='hidden') drive.type='hidden';
        if(drive.value) drive.value='';
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
