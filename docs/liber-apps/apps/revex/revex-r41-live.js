(function(root){
  'use strict';
  const BUILD='20260813r47';
  if(root.__revexR41Live)return;
  root.__revexR41Live=true;

  const Store=root.RevexStore;
  const requiredStore=['resolveSpecProject','ensureSpecProject','listDesignEdits','saveDesignEdit','listChapterEdits','saveChapterEdit','listLibrary','listHistory','appendHistory','listBimOverlays','commitBimOverlay','listDerivedPlans','saveDerivedPlan','syncEngineeringPackage','getEngineeringState','runEnergyServer','publishEnergyResult','getEnergyResult'];
  const iso=()=>new Date().toISOString();
  const clone=(value)=>JSON.parse(JSON.stringify(value===undefined?null:value));
  const safe=(value)=>String(value||'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'item';
  const docId=(value)=>safe(value).replace(/\./g,'_');
  const cloud=()=>Boolean(Store?.isCloud?.()&&Store.api&&Store.db&&Store.user?.uid);

  function installStoreCorrections(){
    if(!Store)return;

    // r41 owns the Spec-project compatibility boundary. Older public Store builds
    // used revexProjectId while the current schema uses linkedProjectId. Resolve
    // either form before creating anything so an existing Spec Book is never duplicated.
    Store.resolveSpecProject=async function(projectId,preferredId){
      if(!projectId)return preferredId||null;
      if(!cloud()){
        if(preferredId)return preferredId;
        try{return (await this.getProject(projectId))?.revexSpecProjectId||null}catch(_){return null}
      }
      const f=this.api;
      const belongs=(data={})=>{
        const linked=String(data.linkedProjectId||'').trim();
        const legacy=String(data.revexProjectId||'').trim();
        return (!linked&&!legacy)||linked===String(projectId)||legacy===String(projectId);
      };
      const exact=async(id)=>{
        if(!id)return null;
        try{const snap=await f.getDoc(f.doc(this.db,'specProjects',id));return snap.exists()&&belongs(snap.data())?id:null}catch(_){return null}
      };
      const preferred=await exact(preferredId);if(preferred)return preferred;
      try{
        const project=await this.getProject(projectId);
        const pointer=await exact(project?.revexSpecProjectId||project?.specProjectId||'');
        if(pointer)return pointer;
      }catch(_){}
      for(const field of['linkedProjectId','revexProjectId']){
        try{
          const q=f.query(f.collection(this.db,'specProjects'),f.where(field,'==',projectId),f.limit(10));
          const snap=await f.getDocs(q);
          if(!snap.empty)return snap.docs[0].id;
        }catch(error){console.warn(`[REVEX r41] Spec lookup ${field}`,error)}
      }
      return null;
    };

    Store.ensureSpecProject=async function(projectId,preferredId,suppliedProject=null){
      if(!projectId)return preferredId||null;
      const existing=await this.resolveSpecProject(projectId,preferredId);
      if(existing){
        if(cloud()){
          const at=iso();
          await this.api.setDoc(this.api.doc(this.db,'specProjects',existing),clone({linkedProjectId:projectId,revexProjectId:projectId,managedByRevex:true,updatedAt:at}),clone({merge:true}));
          try{await this.api.setDoc(this.api.doc(this.db,'projects',projectId),clone({revexSpecProjectId:existing,specBookStatus:'ready',updatedAt:at}),clone({merge:true}))}catch(_){}
        }
        return existing;
      }
      const project=suppliedProject||await this.getProject(projectId);
      if(!project)throw new Error('The shared LIBER project could not be loaded.');
      const id=`spec_${docId(projectId)}`,at=iso();
      if(!cloud())return id;
      const memberIds=[...new Set([...(project.memberIds||[]),project.ownerId,this.user?.uid].filter(Boolean))];
      const row=clone({
        id,
        title:`${project.name||project.title||'Project'} — Spec Book`,
        name:`${project.name||project.title||'Project'} — Spec Book`,
        code:project.code||'',
        linkedProjectId:projectId,
        revexProjectId:projectId,
        linkedProjectName:project.name||project.title||'',
        ownerId:project.ownerId||this.user?.uid,
        memberIds,
        settings:{divisionPerSchedule:true,showEmptyArticles:false},
        createdAt:at,updatedAt:at,managedByRevex:true
      });
      await this.api.setDoc(this.api.doc(this.db,'specProjects',id),row,clone({merge:true}));
      await this.api.setDoc(this.api.doc(this.db,'projects',projectId),clone({revexSpecProjectId:id,specBookStatus:'ready',updatedAt:at}),clone({merge:true}));
      return id;
    };

    // The hosted pre-r41 Store has the Energy evidence/result readers but lacks the
    // managed broker call used by energy-r27.js. Restore the canonical method here.
    // Compatibility assets may still be cached by an older shell. Never replace
    // the canonical regional/bounded implementation supplied by store.js.
    if(typeof Store.runEnergyServer!=='function'){
      Store.runEnergyServer=async function(projectId,sourceRevision){
        if(!projectId||!sourceRevision)throw new Error('Project and Engineering revision are required for managed Energy processing.');
        if(!this.isCloud?.())throw new Error('Managed Energy processing requires a signed-in REVEX cloud session.');
        const fs=this.fs;
        const modular=root.firebaseModular;
        const functions=fs?.functionsByRegion?.['us-central1']||(modular?.getFunctions&&fs?.app?modular.getFunctions(fs.app,'us-central1'):null);
        if(!modular?.httpsCallable||!functions)throw new Error('REVEX managed Energy broker is unavailable in this session.');
        const response=await modular.httpsCallable(functions,'runRevexEnergy',{timeout:3600000})(clone({
          schema:'liber.revex.energy-broker-request.v1',projectId,sourceRevision,clientBuild:BUILD
        }));
        const data=response?.data;
        if(!data?.ok)throw new Error(data?.message||data?.error||'REVEX managed Energy worker did not complete.');
        return data;
      };
    }
  }

  function claim(buttonId,handler){
    const button=document.getElementById(buttonId);
    if(!button||button.dataset.revexR41Owner)return;
    button.dataset.revexR41Owner='1';
    document.addEventListener('click',(event)=>{
      const hit=event.target?.closest?.('#'+buttonId);
      if(!hit)return;
      const viewer=root.__revexViewerR26Instance;
      if(!viewer)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handler(viewer,hit,event);
    },true);
  }

  function bindViewerOwnership(){
    const viewer=root.__revexViewerR26Instance;
    if(!viewer)return false;

    claim('fit-model',(v)=>v.fit?.());
    claim('fit-model-rail',(v)=>v.fit?.());
    claim('section-toggle',(v,button)=>{
      v.section=v.section||{enabled:false,minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1};
      v.section.enabled=!v.section.enabled;
      button.classList.toggle('active',v.section.enabled);
      button.setAttribute('aria-expanded',String(v.section.enabled));
      const controls=document.getElementById('section-controls');
      if(controls)controls.hidden=!v.section.enabled;
      v.sectionApply?.();
    });
    claim('walk-toggle',(v,button)=>{
      const on=!button.classList.contains('active');
      button.classList.toggle('active',on);
      const controls=document.getElementById('walk-controls');
      if(controls)controls.hidden=!on;
      v.walkOn?.(on);
    });
    return true;
  }

  function verify(){
    const store=root.RevexStore||{};
    const missing=requiredStore.filter((name)=>typeof store[name]!=='function');
    const viewer=root.__revexViewerR26Instance;
    console.info('[REVEX] live coherence '+BUILD,{
      storeContract:missing.length===0,
      missingStoreMethods:missing,
      specSchemaCompatibility:'linkedProjectId + revexProjectId',
      managedEnergyBroker:typeof store.runEnergyServer==='function',
      viewerReady:Boolean(viewer),
      exactInstancePicking:Boolean(viewer?.pick),
      sectionBox:Boolean(viewer?.sectionBox&&viewer?.sectionApply),
      singleControlOwner:true
    });
  }

  installStoreCorrections();

  function start(){
    let tries=0;
    const tick=()=>{
      tries+=1;
      if(bindViewerOwnership()||tries>80){verify();return;}
      setTimeout(tick,125);
    };
    tick();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})(window);
