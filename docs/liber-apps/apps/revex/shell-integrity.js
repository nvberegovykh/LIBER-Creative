(function(root){
  'use strict';
  const BUILD='20260810r17';

  function loadFirestoreCompat(){
    if(root.__revexFirestoreCompatR17||document.getElementById('revex-firestore-compat')) return;
    const script=document.createElement('script');
    script.id='revex-firestore-compat';
    script.src=`firestore-compat.js?v=${BUILD}`;
    script.async=false;
    script.onload=()=>console.log('[REVEX] Firestore compatibility loaded');
    script.onerror=()=>console.error('[REVEX] Firestore compatibility failed to load');
    document.head.appendChild(script);
  }

  function notify(message,type='success'){
    try{
      if(root.parent?.dashboardManager?.showNotification) return root.parent.dashboardManager.showNotification(message,type);
      if(root.dashboardManager?.showNotification) return root.dashboardManager.showNotification(message,type);
    }catch(_){ }
    if(type==='error') console.error('[REVEX invite]',message);
    else console.log('[REVEX invite]',message);
  }

  function inviteProject(){
    const select=document.getElementById('project-select');
    return {
      id:String(select?.value||'').trim(),
      name:select?.selectedOptions?.[0]?.textContent?.trim()||'REVEX project'
    };
  }

  function fallbackInviteUrl(projectId,email){
    const url=new URL(location.href);
    url.search='';
    url.hash='';
    url.searchParams.set('projectId',projectId);
    url.searchParams.set('invite','1');
    if(email) url.searchParams.set('inviteEmail',email);
    return url.href;
  }

  function resultInviteUrl(result,projectId,email){
    const candidate=result?.inviteUrl||result?.magicLink||result?.actionLink||result?.link||result?.url||result?.continueUrl||'';
    if(candidate){
      try{ return new URL(String(candidate),location.href).href; }catch(_){ }
    }
    return fallbackInviteUrl(projectId,email);
  }

  async function copyText(text){
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(text);
      return;
    }
    const area=document.createElement('textarea');
    area.value=text;
    area.setAttribute('readonly','');
    area.style.position='fixed';
    area.style.opacity='0';
    document.body.appendChild(area);
    area.select();
    const ok=document.execCommand('copy');
    area.remove();
    if(!ok) throw new Error('Clipboard is not available.');
  }

  async function copyInvitation(){
    const button=document.getElementById('invite-copy');
    const emailInput=document.getElementById('invite-email');
    const {id,name}=inviteProject();
    const email=String(emailInput?.value||'').trim().toLowerCase();
    if(!id) return notify('Choose a REVEX project first.','error');
    if(!email){
      emailInput?.focus?.();
      return notify('Enter the recipient email so REVEX can grant the correct account access.','error');
    }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      emailInput?.focus?.();
      return notify('Enter a valid recipient email.','error');
    }
    const fs=root.firebaseService;
    if(!fs?.callFunction) return notify('Project invitations are not available in this session.','error');

    const old=button?.textContent||'Copy invitation';
    if(button){ button.disabled=true; button.textContent='Preparing…'; }
    try{
      const result=await fs.callFunction('inviteProjectMemberByEmail',{
        projectId:id,
        email,
        source:'revex',
        returnTo:'revex',
        delivery:'copy'
      });
      if(result?.ok===false) throw new Error(result?.message||'Invitation could not be prepared.');
      const link=resultInviteUrl(result,id,email);
      const message=`You're invited to the REVEX project “${name}”.\n\nOpen this link to sign in or create your LIBER account and enter the project:\n${link}`;
      await copyText(message);
      if(button){ button.textContent='Copied'; setTimeout(()=>{ if(button){ button.textContent=old; button.disabled=false; } },1800); }
      notify('Invitation copied — ready to paste into WhatsApp, Telegram or SMS.','success');
    }catch(error){
      if(button){ button.disabled=false; button.textContent=old; }
      notify(error?.message||'Could not prepare the invitation.','error');
    }
  }

  function bindInviteCopy(){
    const form=document.getElementById('invite-form');
    const actions=form?.querySelector('.drawer-actions');
    if(!form||!actions||document.getElementById('invite-copy')) return;

    const helper=form.querySelector('#invite-project-label + label + .modal-intro');
    if(helper) helper.textContent='Enter the recipient email to grant access. Send by email, or copy the same project invitation to paste into WhatsApp, Telegram or SMS.';

    const button=document.createElement('button');
    button.id='invite-copy';
    button.type='button';
    button.className='button ghost sp-btn sp-btn-ghost';
    button.textContent='Copy invitation';
    button.title='Copy a REVEX invitation message';
    button.addEventListener('click',copyInvitation);
    actions.insertBefore(button,actions.firstChild);
  }

  function postNativeProjectSelection(reason='selection'){
    try{
      if(!root.chrome?.webview?.postMessage) return false;
      const select=document.getElementById('project-select');
      const projectId=String(select?.value||'').trim();
      if(!projectId) return false;
      const projectName=String(select?.selectedOptions?.[0]?.textContent||'').trim();
      const params=new URLSearchParams(location.search);
      root.chrome.webview.postMessage({
        type:'liber:revex-project-selected',
        projectId,
        specProjectId:String(params.get('specProjectId')||'').trim()||null,
        projectName,
        source:'companion-immediate',
        reason
      });
      return true;
    }catch(_){ return false; }
  }

  function bindNativeProjectBridge(){
    const select=document.getElementById('project-select');
    if(!select) return;
    if(!select.dataset.revexNativeProjectBridge){
      select.dataset.revexNativeProjectBridge='1';
      select.addEventListener('change',()=>postNativeProjectSelection('change'));
      select.addEventListener('input',()=>postNativeProjectSelection('input'));
      const observer=new MutationObserver(()=>postNativeProjectSelection('options'));
      observer.observe(select,{childList:true,subtree:true});
    }
    postNativeProjectSelection('bind');
  }

  function announceNativeSyncReady(reason='load'){
    try{
      const input=document.querySelector("input[data-liber-revex-sync-upload='1']");
      if(!input) return false;
      input.dataset.liberRevexSyncHandlerReady='1';
      root.__liberRevexNativeSyncReady=true;
      if(root.chrome?.webview?.postMessage){
        const select=document.getElementById('project-select');
        root.chrome.webview.postMessage({
          type:'liber:revex-native-sync-ready',
          build:BUILD,
          projectId:String(select?.value||'').trim()||null,
          reason
        });
      }
      return true;
    }catch(error){
      console.warn('[REVEX] native sync readiness failed',error);
      return false;
    }
  }

  function bindWhenReady(){
    loadFirestoreCompat();
    bindInviteCopy();
    bindNativeProjectBridge();
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{ loadFirestoreCompat(); bindInviteCopy(); bindNativeProjectBridge(); },{once:true});
    setTimeout(()=>{ loadFirestoreCompat(); bindInviteCopy(); bindNativeProjectBridge(); },250);
    setTimeout(()=>{ loadFirestoreCompat(); bindInviteCopy(); bindNativeProjectBridge(); },1000);

    root.addEventListener('load',()=>{
      announceNativeSyncReady('window-load');
      setTimeout(()=>announceNativeSyncReady('window-load-settle'),250);
    },{once:true});
    if(document.readyState==='complete') setTimeout(()=>announceNativeSyncReady('already-complete'),0);
  }

  try{
    bindWhenReady();

    const parent=root.parent&&root.parent!==root?root.parent:null;
    const manager=parent?.appsManager||null;
    if(manager){
      if(!manager.__revexControlledKeepAlivePatch){
        const originalKeep=typeof manager.isKeepAliveApp==='function'?manager.isKeepAliveApp.bind(manager):null;
        manager.isKeepAliveApp=(src)=>/apps\/revex\/index\.html/i.test(String(src||''))?false:(originalKeep?originalKeep(src):false);
        manager.__revexControlledKeepAlivePatch=true;
      }

      if(!manager.__revexFreshLaunchPatch&&typeof manager.openAppInShell==='function'){
        const originalOpen=manager.openAppInShell.bind(manager);
        manager.openAppInShell=(app,appUrl)=>{
          const isRevex=String(app?.id||'')==='revex'||/apps\/revex\/index\.html/i.test(String(appUrl||''));
          if(!isRevex) return originalOpen(app,appUrl);
          let url=String(appUrl||'');
          try{
            const u=new URL(url,parent.location.href);
            u.searchParams.set('build',BUILD);
            u.searchParams.set('fresh',String(Date.now()));
            url=u.href;
          }catch(_){
            const sep=url.includes('?')?'&':'?';
            url+=sep+'build='+encodeURIComponent(BUILD)+'&fresh='+Date.now();
          }
          const frame=parent.document?.getElementById?.('app-shell-frame');
          if(frame&&/apps\/revex\/index\.html/i.test(String(frame.getAttribute('src')||''))) frame.src='about:blank';
          return originalOpen(app,url);
        };
        manager.__revexFreshLaunchPatch=true;
      }

      if(Array.isArray(manager.apps)){
        const app=manager.apps.find((row)=>row?.id==='revex');
        if(app){
          app.version='0.7.8';
          app.lastUpdated='2026-08-10';
          app.path='apps/revex/index.html?build='+BUILD;
        }
      }
      const card=parent.document?.querySelector?.('.app-card[data-app-id="revex"] .app-version');
      if(card) card.textContent='v0.7.8';
    }
    console.log('[REVEX] shell integrity '+BUILD,{keepAlive:false,freshLaunch:true,uiGuard:'single',inviteCopy:true,nativeProjectBridge:true,nativeSyncHandshake:true,firestoreCompat:true});
  }catch(error){
    console.warn('[REVEX] shell integrity failed',error);
  }
})(window);
