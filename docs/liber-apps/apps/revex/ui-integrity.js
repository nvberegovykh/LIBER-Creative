(function(root){
  'use strict';
  const BUILD='20260812r39';
  if(root.__revexUiIntegrityR20)return;
  root.__revexUiIntegrityR20=true;

  // r39 is the compatibility boundary between the current deployed shell and the
  // canonical 0.8.19 source. Load it synchronously while the parser is still here so
  // Store methods exist before app.js evaluates.
  if(!root.__revexR39Runtime){
    if(document.readyState==='loading'){
      document.write('<script src="revex-r39-runtime.js?v='+BUILD+'"></'+'script>');
    }else{
      const script=document.createElement('script');script.src='revex-r39-runtime.js?v='+BUILD;script.async=false;document.head.appendChild(script);
    }
  }

  function installControlledBimStore(){
    const Store=root.RevexStore;
    if(!Store||Store.__r39ControlledBim)return;
    Store.__r39ControlledBim=true;
    const iso=()=>new Date().toISOString();
    const clone=(v)=>JSON.parse(JSON.stringify(v===undefined?null:v));
    const safe=(v)=>String(v||'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'item';
    const docId=(v)=>safe(v).replace(/\./g,'_');
    const cloud=()=>Boolean(Store.isCloud?.()&&Store.api&&Store.db&&Store.user?.uid);
    const library=(projectId)=>Store.api.collection(Store.db,'projects',projectId,'library');
    const libraryDoc=(projectId,id)=>Store.api.doc(Store.db,'projects',projectId,'library',id);
    async function listKind(projectId,kind,max=1000){
      if(!cloud()||!projectId)return[];
      try{const f=Store.api,q=f.query(library(projectId),f.where('revexKind','==',kind),f.limit(max)),snap=await f.getDocs(q);return snap.docs.map(d=>({id:d.id,...d.data()}))}
      catch(error){console.warn(`[REVEX r39] ${kind} list`,error);return[]}
    }
    async function setRecord(projectId,id,kind,data,merge=true){
      const payload=clone({...data,type:'revex',hidden:true,revexKind:kind,updatedAt:data?.updatedAt||iso()});
      await Store.api.setDoc(libraryDoc(projectId,id),payload,clone({merge}));return payload;
    }

    Store.listBimOverlays=async function(projectId){
      if(!projectId)return[];
      if(!cloud()){try{return Object.values(JSON.parse(localStorage.getItem(`liber.revex.bim-overlays.${projectId}`)||'{}'))}catch(_){return[]}}
      return(await listKind(projectId,'bim-overlay',5000)).map(r=>({...r,id:r.revexId||r.id}));
    };
    Store.commitBimOverlay=async function(projectId,element,patch,meta={}){
      if(!projectId||!element)throw new Error('Project and BIM element are required.');
      const stable=String(element.uniqueId||element.id||'').trim();if(!stable)throw new Error('The selected BIM element has no stable Revit identity.');
      const overlayId=docId(stable);let before=null,after=null;
      if(!cloud()){
        const key=`liber.revex.bim-overlays.${projectId}`,all=JSON.parse(localStorage.getItem(key)||'{}');before=all[overlayId]||null;
        after={...(before||{}),...clone(patch),id:overlayId,revexId:overlayId,elementId:element.id??before?.elementId??null,uniqueId:element.uniqueId||before?.uniqueId||null,category:element.category||before?.category||'',level:element.level||before?.level||'',sourceRevision:meta.sourceRevision||before?.sourceRevision||null,updatedAt:iso(),updatedBy:this.user?.uid||'local'};
        all[overlayId]=after;localStorage.setItem(key,JSON.stringify(all));
      }else{
        before=(await listKind(projectId,'bim-overlay',5000)).find(r=>String(r.revexId||r.id)===overlayId)||null;
        after=clone({...(before||{}),...patch,id:overlayId,revexId:overlayId,elementId:element.id??before?.elementId??null,uniqueId:element.uniqueId||before?.uniqueId||null,category:element.category||before?.category||'',level:element.level||before?.level||'',sourceRevision:meta.sourceRevision||before?.sourceRevision||null,updatedAt:iso(),updatedBy:this.user?.uid||'local'});
        await setRecord(projectId,`revex_bim_${overlayId}`,'bim-overlay',after,false);
      }
      const event=typeof this.appendHistory==='function'?await this.appendHistory(projectId,{sourceRevision:meta.sourceRevision||null,kind:'bim-overlay',operation:meta.operation||'edit',label:meta.label||`${element.category||'BIM'} ${element.id||''}`.trim(),affectedElementIds:element.id!=null?[element.id]:[],affectedUniqueIds:element.uniqueId?[element.uniqueId]:[],affectedLevels:element.level?[element.level]:[],affectedViews:meta.affectedViews||[],before,after,camera:meta.camera||null,snapshot:meta.snapshot||null,note:meta.note||'',relatedId:overlayId,previousEventId:meta.previousEventId||null}):null;
      return{overlay:after,event};
    };
    Store.listDerivedPlans=async function(projectId){
      if(!projectId)return[];
      if(!cloud()){try{return JSON.parse(localStorage.getItem(`liber.revex.derived-plans.${projectId}`)||'[]')}catch(_){return[]}}
      return(await listKind(projectId,'derived-plan',1000)).map(r=>({...r,id:r.revexId||r.id})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    };
    Store.saveDerivedPlan=async function(projectId,plan={},imageDataUrl=''){
      if(!projectId)throw new Error('Choose a REVEX project first.');
      const id=plan.id||`plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,data=clone({...plan,id,revexId:id,createdAt:plan.createdAt||iso(),createdBy:plan.createdBy||this.user?.uid||'local'});
      if(!cloud()){const key=`liber.revex.derived-plans.${projectId}`,all=JSON.parse(localStorage.getItem(key)||'[]');all.unshift({...data,imageDataUrl:imageDataUrl||null});localStorage.setItem(key,JSON.stringify(all.slice(0,250)));return all[0]}
      let imageUrl=null,imagePath=null;
      if(imageDataUrl&&this.fs?.storage){const blob=await(await fetch(imageDataUrl)).blob(),file=new File([blob],`${id}.png`,{type:'image/png'}),path=`projects/${projectId}/library/revex/derived-plans/${docId(id)}/${Date.now()}_${id}.png`,ref=this.api.ref(this.fs.storage,path);await this.api.uploadBytes(ref,file,clone({contentType:'image/png'}));imageUrl=await this.api.getDownloadURL(ref);imagePath=path}
      const finalData=clone({...data,imageUrl,imagePath});await setRecord(projectId,`revex_plan_${docId(id)}`,'derived-plan',finalData,false);return finalData;
    };
    console.info('[REVEX] r39 controlled BIM persistence',{overlays:'project-library',derivedPlans:'project-library'});
  }
  installControlledBimStore();

  function installCompanion(){
    if(root.__revexInstallBannerR38)return;
    root.__revexInstallBannerR38=true;
    const isRevitHost=()=>Boolean(root.chrome?.webview);
    const isStandalone=()=>root.matchMedia?.('(display-mode: standalone)').matches||root.navigator.standalone===true;
    if(isRevitHost()||isStandalone())return;
    const dismissKey='liber.revex.install-banner.dismissed.v1';
    let deferredPrompt=null;
    try{
      if(!document.querySelector('link[rel="manifest"][data-revex-manifest]')){const link=document.createElement('link');link.rel='manifest';link.href='manifest.webmanifest?v='+BUILD;link.dataset.revexManifest='1';document.head.appendChild(link)}
      if(!document.querySelector('meta[name="theme-color"][data-revex-theme]')){const meta=document.createElement('meta');meta.name='theme-color';meta.content='#080a0e';meta.dataset.revexTheme='1';document.head.appendChild(meta)}
      if(!document.querySelector('meta[name="mobile-web-app-capable"]')){const meta=document.createElement('meta');meta.name='mobile-web-app-capable';meta.content='yes';document.head.appendChild(meta)}
      if(!document.querySelector('meta[name="apple-mobile-web-app-capable"]')){const meta=document.createElement('meta');meta.name='apple-mobile-web-app-capable';meta.content='yes';document.head.appendChild(meta)}
      if(!document.querySelector('meta[name="apple-mobile-web-app-title"]')){const meta=document.createElement('meta');meta.name='apple-mobile-web-app-title';meta.content='REVEX';document.head.appendChild(meta)}
      if(!document.querySelector('link[rel="apple-touch-icon"]')){const link=document.createElement('link');link.rel='apple-touch-icon';link.href='/liber-apps/images/LIBER%20LOGO.png';document.head.appendChild(link)}
    }catch(_){}
    if('serviceWorker'in navigator&&location.protocol==='https:')navigator.serviceWorker.register('/liber-apps/sw.js').catch(()=>{});
    if(!document.getElementById('revex-install-banner-style')){const style=document.createElement('style');style.id='revex-install-banner-style';style.textContent='.revex-install-banner{position:fixed;inset:0 0 auto 0;z-index:10000;min-height:46px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left));background:rgba(8,10,14,.97);border-bottom:1px solid rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.28);backdrop-filter:blur(16px);color:#eef2f7;font-size:12px}.revex-install-banner[hidden]{display:none!important}.revex-install-copy{display:flex;align-items:baseline;gap:8px;min-width:0}.revex-install-copy strong{white-space:nowrap}.revex-install-copy span{opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.revex-install-actions{display:flex;align-items:center;gap:6px}.revex-install-action,.revex-install-close{border:1px solid rgba(255,255,255,.18);border-radius:7px;background:rgba(255,255,255,.08);color:inherit;min-height:30px;padding:5px 10px;font:inherit;cursor:pointer}.revex-install-action{background:#eef2f7;color:#0b0d11;font-weight:650}.revex-install-close{width:30px;padding:0;font-size:18px;line-height:1}body.revex-install-banner-open .app-shell{padding-top:47px;box-sizing:border-box}@media(max-width:720px){.revex-install-banner{justify-content:space-between;min-height:52px}.revex-install-copy{display:block}.revex-install-copy span{display:block;max-width:52vw;margin-top:2px}body.revex-install-banner-open .app-shell{padding-top:53px}}';document.head.appendChild(style)}
    let banner=document.getElementById('revex-install-banner');if(!banner){banner=document.createElement('aside');banner.id='revex-install-banner';banner.className='revex-install-banner';banner.hidden=true;banner.setAttribute('role','region');banner.setAttribute('aria-label','Install REVEX Companion');banner.innerHTML='<div class="revex-install-copy"><strong>Install REVEX Companion</strong><span id="revex-install-hint">Open REVEX like an app from your desktop or home screen.</span></div><div class="revex-install-actions"><button id="revex-install-action" class="revex-install-action" type="button">Install app</button><button id="revex-install-close" class="revex-install-close" type="button" aria-label="Close install banner">×</button></div>';document.body.prepend(banner)}
    const action=banner.querySelector('#revex-install-action'),close=banner.querySelector('#revex-install-close'),hint=banner.querySelector('#revex-install-hint');
    const hide=()=>{banner.hidden=true;document.body.classList.remove('revex-install-banner-open')};
    const show=()=>{if(isRevitHost()||isStandalone())return hide();try{if(localStorage.getItem(dismissKey)==='1')return hide()}catch(_){}banner.hidden=false;document.body.classList.add('revex-install-banner-open')};
    const platformHint=()=>/iphone|ipad|ipod/i.test(navigator.userAgent||'')?'Tap Share, then Add to Home Screen.':(/safari/i.test(navigator.userAgent||'')&&!/chrome|chromium|edg/i.test(navigator.userAgent||'')?'Use the browser Share/File menu, then Add to Dock or Home Screen.':'Use your browser menu → Install app / Add to home screen.');
    root.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredPrompt=event;action.textContent='Install app';hint.textContent='Open REVEX like an app from your desktop or home screen.';show()});
    root.addEventListener('appinstalled',()=>{deferredPrompt=null;hide()});
    action?.addEventListener('click',async()=>{if(deferredPrompt){const p=deferredPrompt;deferredPrompt=null;try{await p.prompt();const choice=await p.userChoice;if(choice?.outcome==='accepted')hide();else show()}catch(_){hint.textContent=platformHint()}return}hint.textContent=platformHint();action.textContent='How to install'});
    close?.addEventListener('click',()=>{try{localStorage.setItem(dismissKey,'1')}catch(_){}hide()});
    root.matchMedia?.('(display-mode: standalone)').addEventListener?.('change',()=>{if(isStandalone())hide()});show();
  }

  function updateProjectId(){const select=document.getElementById('project-select');if(!select)return;let badge=document.getElementById('project-id-badge');if(!badge){badge=document.createElement('button');badge.id='project-id-badge';badge.type='button';badge.className='sp-badge project-id-badge';badge.title='Copy REVEX Project ID';select.closest('.project-picker')?.insertAdjacentElement('afterend',badge);badge.addEventListener('click',async()=>{const id=String(select.value||'').trim();if(!id)return;try{await navigator.clipboard.writeText(id);badge.textContent='ID copied';setTimeout(updateProjectId,1000)}catch(_){}})}const id=String(select.value||'').trim();badge.hidden=!id;const text=id?`ID ${id}`:'';if(badge.textContent!==text)badge.textContent=text}
  function enforceLabels(){const invite=document.getElementById('invite-project-button'),render=document.getElementById('render-button');if(invite&&invite.textContent!=='Invite')invite.textContent='Invite';if(render&&render.textContent!=='Render')render.textContent='Render'}
  function bind(){installCompanion();const select=document.getElementById('project-select');if(select&&!select.dataset.revexUiR20){select.dataset.revexUiR20='1';select.addEventListener('change',()=>{updateProjectId();enforceLabels()})}updateProjectId();enforceLabels()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();setTimeout(bind,250);setTimeout(bind,1000);
  console.log('[REVEX] UI integrity '+BUILD,{projectId:'visible',pwaInstallBanner:true,revitSuppressed:true,r39Runtime:true,controlledBim:true});
})(window);