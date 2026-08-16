(function(root){
  'use strict';
  const BUILD='20260816r67';
  const VERSION='0.8.19';
  if(root.__revexShellR20) return;
  root.__revexShellR20=true;

  // r67 interaction guard: render-selfhost-r54 historically installed one broad
  // documentElement child-list observer whose decorator rewrites text nodes. That
  // combination can schedule itself forever and starve clicks after the UI paints.
  // Preserve every normal observer, but scope that exact broad pattern to the
  // render dialog and wake it only when the render-agent panel itself appears.
  function installMutationObserverGuard(){
    const NativeMutationObserver=root.MutationObserver;
    if(!NativeMutationObserver||root.__revexMutationObserverGuardR67)return;
    class RevexSafeMutationObserver extends NativeMutationObserver{
      constructor(callback){
        const state={renderDecorator:false};
        super((mutations,observer)=>{
          if(!state.renderDecorator){callback(mutations,observer);return;}
          const panelChanged=mutations.some((mutation)=>{
            if(mutation.type!=='childList')return false;
            const nodes=[...mutation.addedNodes,...mutation.removedNodes];
            return nodes.some((node)=>node?.nodeType===1&&(node.id==='render-agent-panel'||node.querySelector?.('#render-agent-panel')));
          });
          if(panelChanged)callback(mutations,observer);
        });
        this.__revexR67State=state;
      }
      observe(target,options){
        const broadDocumentObserver=target===document.documentElement&&options?.childList===true&&options?.subtree===true&&!options?.attributes&&!options?.characterData;
        if(broadDocumentObserver){
          const dialog=document.getElementById('render-dialog');
          if(dialog){
            this.__revexR67State.renderDecorator=true;
            return super.observe(dialog,{childList:true,subtree:true});
          }
        }
        return super.observe(target,options);
      }
    }
    root.MutationObserver=RevexSafeMutationObserver;
    root.__revexMutationObserverGuardR67=Object.freeze({build:BUILD,reason:'render-decorator-loop',native:NativeMutationObserver});
  }
  installMutationObserverGuard();

  function notify(message,type='success'){
    try{
      if(root.parent?.dashboardManager?.showNotification) return root.parent.dashboardManager.showNotification(message,type);
      if(root.dashboardManager?.showNotification) return root.dashboardManager.showNotification(message,type);
    }catch(_){ }
    (type==='error'?console.error:console.log)('[REVEX]',message);
  }
  function project(){
    const select=document.getElementById('project-select');
    return { id:String(select?.value||'').trim(), name:String(select?.selectedOptions?.[0]?.textContent||'REVEX project').trim() };
  }
  async function copyText(text){
    if(navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const area=document.createElement('textarea'); area.value=text; area.readOnly=true;
    area.style.cssText='position:fixed;opacity:0;pointer-events:none'; document.body.appendChild(area); area.select();
    const ok=document.execCommand('copy'); area.remove(); if(!ok) throw new Error('Clipboard is not available.');
  }
  function inviteUrl(projectId,email,result){
    const candidate=result?.inviteUrl||result?.magicLink||result?.actionLink||result?.link||result?.url||result?.continueUrl||'';
    if(candidate){ try{return new URL(String(candidate),location.href).href;}catch(_){ } }
    const url=new URL(location.href); url.search=''; url.hash=''; url.searchParams.set('projectId',projectId); url.searchParams.set('invite','1');
    if(email) url.searchParams.set('inviteEmail',email); return url.href;
  }
  async function copyInvitation(){
    const button=document.getElementById('invite-copy'), input=document.getElementById('invite-email');
    const {id,name}=project(), email=String(input?.value||'').trim().toLowerCase();
    if(!id) return notify('Choose a REVEX project first.','error');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ input?.focus?.(); return notify('Enter the recipient email first.','error'); }
    const fs=root.firebaseService; if(!fs?.callFunction) return notify('Project invitations are unavailable in this session.','error');
    const old=button?.textContent||'Copy invitation'; if(button){button.disabled=true;button.textContent='Preparing…';}
    try{
      const result=await fs.callFunction('inviteProjectMemberByEmail',{projectId:id,email,source:'revex',returnTo:'revex',delivery:'copy'});
      if(result?.ok===false) throw new Error(result?.message||'Invitation could not be prepared.');
      const link=inviteUrl(id,email,result);
      await copyText(`You're invited to the REVEX project “${name}”.\n\nOpen this link to sign in or create your LIBER account and enter the project:\n${link}`);
      if(button){button.textContent='Copied';setTimeout(()=>{if(button){button.textContent=old;button.disabled=false;}},1600);}
      notify('Invitation copied — ready for WhatsApp, Telegram or SMS.');
    }catch(error){ if(button){button.disabled=false;button.textContent=old;} notify(error?.message||'Could not prepare the invitation.','error'); }
  }
  function bindInviteCopy(){
    const form=document.getElementById('invite-form'), actions=form?.querySelector('.drawer-actions'); if(!form||!actions) return;
    const helper=form.querySelector('#invite-project-label + label + .modal-intro');
    if(helper) helper.textContent='Enter the recipient email to grant access. Send by email, or copy the invitation for WhatsApp, Telegram or SMS.';
    if(document.getElementById('invite-copy')) return;
    const button=document.createElement('button'); button.id='invite-copy';button.type='button';button.className='button ghost sp-btn sp-btn-ghost';button.textContent='Copy invitation';
    button.addEventListener('click',copyInvitation); actions.insertBefore(button,actions.firstChild);
  }
  function postProject(reason='selection'){
    try{
      if(!root.chrome?.webview?.postMessage) return false; const {id,name}=project(); if(!id) return false;
      const qs=new URLSearchParams(location.search);
      root.chrome.webview.postMessage({type:'liber:revex-project-selected',projectId:id,specProjectId:String(qs.get('specProjectId')||'').trim()||null,projectName:name,source:'companion-immediate',reason,build:BUILD});
      return true;
    }catch(_){return false;}
  }
  function bindProjectBridge(){
    const select=document.getElementById('project-select'); if(!select) return;
    if(!select.dataset.revexNativeProjectBridge){
      select.dataset.revexNativeProjectBridge='r67'; select.addEventListener('change',()=>postProject('change')); select.addEventListener('input',()=>postProject('input'));
    }
    postProject('bind');
  }
  function announceReady(reason){
    try{
      const input=document.querySelector("input[data-liber-revex-sync-upload='1']"); if(!input||!root.chrome?.webview?.postMessage) return false;
      input.dataset.liberRevexSyncHandlerReady='1'; root.__liberRevexNativeSyncReady=true;
      root.chrome.webview.postMessage({type:'liber:revex-native-sync-ready',build:BUILD,projectId:project().id||null,reason}); return true;
    }catch(_){return false;}
  }
  function alignParentShell(){
    try{
      const parent=root.parent&&root.parent!==root?root.parent:null, manager=parent?.appsManager; if(!manager) return;
      if(!manager.__revexR49KeepAlive&&typeof manager.isKeepAliveApp==='function'){
        const original=manager.isKeepAliveApp.bind(manager); manager.isKeepAliveApp=(src)=>/apps\/revex\/index\.html/i.test(String(src||''))?false:original(src); manager.__revexR49KeepAlive=true;
      }
      if(!manager.__revexR49FreshLaunch&&typeof manager.openAppInShell==='function'){
        const original=manager.openAppInShell.bind(manager); manager.openAppInShell=(app,appUrl)=>{
          const isRevex=String(app?.id||'')==='revex'||/apps\/revex\/index\.html/i.test(String(appUrl||'')); if(!isRevex) return original(app,appUrl);
          let url=String(appUrl||''); try{const u=new URL(url,parent.location.href);u.searchParams.set('build',BUILD);u.searchParams.set('fresh',String(Date.now()));url=u.href;}catch(_){url+=(url.includes('?')?'&':'?')+'build='+BUILD+'&fresh='+Date.now();}
          return original(app,url);
        }; manager.__revexR49FreshLaunch=true;
      }
      if(Array.isArray(manager.apps)){const app=manager.apps.find(row=>row?.id==='revex');if(app){app.version=VERSION;app.lastUpdated='2026-08-16';app.path='apps/revex/index.html?build='+BUILD;}}
      const card=parent.document?.querySelector?.('.app-card[data-app-id="revex"] .app-version');if(card)card.textContent='v'+VERSION;
    }catch(error){console.warn('[REVEX] shell alignment',error);}
  }
  function bind(){bindInviteCopy();bindProjectBridge();alignParentShell();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
  setTimeout(bind,250);setTimeout(bind,1000);
  root.addEventListener('load',()=>{bind();announceReady('window-load');setTimeout(()=>announceReady('window-load-settle'),250);},{once:true});
  if(document.readyState==='complete')setTimeout(()=>announceReady('already-complete'),0);
  console.log('[REVEX] shell '+BUILD,{version:VERSION,freshLaunch:true,inviteCopy:true,projectBridge:true,nativeReady:true,interactionGuard:true});
})(window);
