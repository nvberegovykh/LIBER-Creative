(function(root){
  'use strict';
  const BUILD='20260810r11';
  const Store=root.RevexStore;
  let applying=false;

  function setText(node,text){
    if(node&&String(node.textContent||'').trim()!==text) node.textContent=text;
  }
  function setAttr(node,name,value){
    if(node&&node.getAttribute(name)!==value) node.setAttribute(name,value);
  }
  const iso=()=>new Date().toISOString();
  const safe=(value)=>String(value||'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=(value)=>safe(value).replace(/\./g,'_');
  const clone=(value)=>JSON.parse(JSON.stringify(value===undefined?null:value));

  function ensureProjectIdBadge(){
    const picker=document.querySelector('.project-picker');
    const select=document.getElementById('project-select');
    if(!picker||!select) return;
    let badge=document.getElementById('project-id-badge');
    if(!badge){
      badge=document.createElement('button');
      badge.id='project-id-badge';
      badge.type='button';
      badge.className='sp-badge';
      badge.style.maxWidth='250px';
      badge.style.overflow='hidden';
      badge.style.textOverflow='ellipsis';
      badge.style.whiteSpace='nowrap';
      badge.style.fontFamily='var(--mono, ui-monospace, monospace)';
      badge.style.cursor='copy';
      badge.title='Copy REVEX Project ID';
      badge.addEventListener('click',async()=>{
        const id=String(select.value||'').trim();
        if(!id) return;
        try{ await navigator.clipboard.writeText(id); badge.textContent='Copied '+id; setTimeout(()=>updateProjectIdBadge(),900); }
        catch(_){ badge.textContent=id; }
      });
      picker.after(badge);
    }
    updateProjectIdBadge();
  }

  function updateProjectIdBadge(){
    const select=document.getElementById('project-select');
    const badge=document.getElementById('project-id-badge');
    if(!select||!badge) return;
    const id=String(select.value||'').trim();
    badge.hidden=!id;
    if(id) badge.textContent='ID '+id;
  }

  function canonicalize(){
    if(applying) return;
    applying=true;
    try{
      const nav=document.querySelector('.main-nav');
      const invite=document.getElementById('invite-project-button');
      const render=document.getElementById('render-button');
      const projectId=String(document.getElementById('project-select')?.value||'').trim();

      ensureProjectIdBadge();
      updateProjectIdBadge();

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

  function installSyncRecovery(){
    if(!Store||Store.__revexR11SyncInstalled) return;
    Store.__revexR11SyncInstalled=true;

    const cloudReady=()=>Store.isCloud()&&Store.api&&Store.db&&Store.user?.uid;
    const libraryDoc=(projectId,id)=>Store.api.doc(Store.db,'projects',projectId,'library',id);
    const setRecord=async(projectId,id,kind,data,merge=true)=>{
      const payload=clone({...data,type:'revex',hidden:true,revexKind:kind,updatedAt:data?.updatedAt||iso()});
      await Store.api.setDoc(libraryDoc(projectId,id),payload,clone({merge}));
      return payload;
    };
    const byName=(files,name)=>files.find((file)=>String(file.name||'').toLowerCase()===String(name).toLowerCase())||null;
    const readJson=async(file)=>{
      if(!file) return null;
      try{return JSON.parse(await file.text());}
      catch(error){throw new Error(`${file.name} is not valid JSON: ${error.message}`);}
    };
    const sha256=async(file)=>{
      const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
      return [...new Uint8Array(digest)].map((b)=>b.toString(16).padStart(2,'0')).join('');
    };
    const verifyIntegrity=async(files,integrity)=>{
      const entries=Array.isArray(integrity?.files)?integrity.files:[];
      if(!entries.length) throw new Error('REVEX integrity manifest is empty. Re-sync from Revit.');
      for(const entry of entries){
        const name=String(entry?.name||'').split('/').pop();
        const file=byName(files,name);
        if(!file) throw new Error(`REVEX package is missing ${name}. Re-sync from Revit.`);
        if(Number(entry.bytes)!==Number(file.size)) throw new Error(`${name} size does not match the Revit revision manifest.`);
        if(await sha256(file)!==String(entry.sha256||'').toLowerCase()) throw new Error(`${name} failed REVEX SHA-256 integrity validation.`);
      }
    };
    const upload=async(projectId,area,file)=>{
      if(!Store.fs?.storage) throw new Error('LIBER Storage is not available in this session.');
      const name=safe(file.name||'file');
      const path=`projects/${projectId}/library/revex/${area}/${name}`;
      const ref=Store.api.ref(Store.fs.storage,path);
      await Store.api.uploadBytes(ref,file,clone({contentType:file.type||(/\.json$/i.test(name)?'application/json':'application/octet-stream')}));
      return {path,url:await Store.api.getDownloadURL(ref),name,size:file.size};
    };

    Store.syncPackage=async function syncR11(fileList,preferredProjectId,preferredSpecProjectId){
      const files=Array.from(fileList||[]);
      const projectFile=byName(files,'project.json');
      const designFile=byName(files,'design-book.json');
      const viewerFile=byName(files,'viewer-model.json');
      const specFile=byName(files,'spec-revit-push.json');
      const integrityFile=byName(files,'integrity.json');
      const ifcFile=files.find((file)=>/\.ifc$/i.test(file.name))||null;
      const fbxFile=files.find((file)=>/\.fbx$/i.test(file.name))||null;
      if(!projectFile||!designFile||!viewerFile||!specFile||!integrityFile)
        throw new Error('Incomplete REVEX revision. Re-sync from Revit; project, Design Book, Spec Book, viewer metadata and integrity manifest are required.');

      const [project,design,viewer,specPush,integrity]=await Promise.all([
        readJson(projectFile),readJson(designFile),readJson(viewerFile),readJson(specFile),readJson(integrityFile)
      ]);
      const projectId=preferredProjectId||project?.central?.projectId||null;
      if(!projectId) throw new Error('Choose the REVEX project before the first Revit sync.');
      if(!ifcFile) throw new Error('The Revit revision has no IFC authority model.');
      await verifyIntegrity(files,integrity);

      const revision=docId(integrity?.revision||`rev_${Date.now()}`);
      const localPackage={projectId,revision,project,design,viewer,specPush,integrity,ifcUrl:URL.createObjectURL(ifcFile),modelUrl:fbxFile?URL.createObjectURL(fbxFile):null,syncedAt:iso(),cloud:false};
      this.lastLocalPackage=localPackage;
      if(!cloudReady()){
        localStorage.setItem(`liber.revex.state.${projectId}`,JSON.stringify({projectId,revision,syncedAt:localPackage.syncedAt,geometryAuthority:'ifc',sourceMode:'controlled-revit-sync',localOnly:true,scheduleCount:integrity?.counts?.schedules||0,elementCount:integrity?.counts?.elements||0}));
        return localPackage;
      }

      const area=`revisions/${revision}`;
      const uploads={};
      for(const file of [projectFile,designFile,viewerFile,specFile,integrityFile,ifcFile,fbxFile].filter(Boolean))
        uploads[file.name]=await upload(projectId,area,file);

      let specProjectId=preferredSpecProjectId||project?.central?.specProjectId||null;
      try{ specProjectId=await this.ensureSpecProject(projectId,specProjectId); }
      catch(error){ console.warn('[REVEX] Spec Project link fallback',error); }

      const source=clone({type:'revit',name:'REVEX controlled Revit sync',rev:specPush?.rev||revision,pushedAt:specPush?.pushedAt||iso(),payload:specPush?.payload||[],linkedProjectId:projectId,centralDocumentUniqueId:project?.central?.documentUniqueId||null,storagePath:uploads['spec-revit-push.json']?.path||null});
      let specSync={status:'project-library',projectId:specProjectId,rev:source.rev,pushedAt:source.pushedAt};
      if(specProjectId){
        try{
          await this.api.setDoc(this.api.doc(this.db,'specProjects',specProjectId,'sources','revex-revit'),source,clone({merge:true}));
          specSync={status:'published',projectId:specProjectId,rev:source.rev,pushedAt:source.pushedAt};
        }catch(error){
          console.warn('[REVEX] Direct Spec Book source write denied; using project library source.',error);
          await setRecord(projectId,'revex_spec_source','spec-source',{...source,specProjectId},true);
        }
      }else{
        await setRecord(projectId,'revex_spec_source','spec-source',{...source,specProjectId:null},true);
      }

      const state=clone({schema:'liber.revex.cloud-state.v3',projectId,revision,syncedAt:iso(),syncedBy:this.user.uid,sourceMode:'controlled-revit-sync',geometryAuthority:'ifc',central:project?.central||null,integrity:integrity||null,ifcUrl:uploads[ifcFile.name]?.url||null,ifcPath:uploads[ifcFile.name]?.path||null,modelUrl:fbxFile?uploads[fbxFile.name]?.url||null:null,modelPath:fbxFile?uploads[fbxFile.name]?.path||null:null,viewerUrl:uploads['viewer-model.json']?.url||null,designUrl:uploads['design-book.json']?.url||null,projectUrl:uploads['project.json']?.url||null,specPushUrl:uploads['spec-revit-push.json']?.url||null,scheduleCount:integrity?.counts?.schedules||design?.schedules?.length||0,elementCount:integrity?.counts?.elements||viewer?.elements?.length||0,spec:specSync,writeBackToRvt:false});
      await setRecord(projectId,'revex_state','state',state,true);
      await setRecord(projectId,`revex_revision_${revision}`,'revision',{revision,syncedAt:state.syncedAt,ifcPath:state.ifcPath,modelPath:state.modelPath,viewerUrl:state.viewerUrl,designUrl:state.designUrl,projectUrl:state.projectUrl,specPushUrl:state.specPushUrl,integrity:state.integrity,createdAt:state.syncedAt},false);
      root.__revexCloudState=state;
      return {...localPackage,...state,cloud:true,specProjectId};
    };
  }

  function start(){
    installSyncRecovery();
    canonicalize();
    const observer=new MutationObserver(canonicalize);
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','disabled']});
    document.getElementById('project-select')?.addEventListener('change',canonicalize);
    root.addEventListener('pageshow',canonicalize);
    root.addEventListener('focus',canonicalize);
    setTimeout(canonicalize,0);
    setTimeout(canonicalize,300);
    setTimeout(canonicalize,1200);
    console.log('[REVEX] UI integrity '+BUILD,{invite:'canonical',render:'canonical',projectId:'visible',sync:'permission-resilient',driveModelSource:false});
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})(window);
