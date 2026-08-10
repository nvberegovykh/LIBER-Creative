(function(root){
  'use strict';
  const BUILD='20260810r13';
  try{
    const parent=root.parent&&root.parent!==root?root.parent:null;
    const manager=parent?.appsManager||null;
    if(!manager) return;

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
        app.version='0.7.6';
        app.lastUpdated='2026-08-10';
        app.path='apps/revex/index.html?build='+BUILD;
      }
    }
    const card=parent.document?.querySelector?.('.app-card[data-app-id="revex"] .app-version');
    if(card) card.textContent='v0.7.6';
    console.log('[REVEX] shell integrity '+BUILD,{keepAlive:false,freshLaunch:true,uiGuard:'single'});
  }catch(error){
    console.warn('[REVEX] shell integrity failed',error);
  }
})(window);
