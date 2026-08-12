(function(root){
  'use strict';
  const BUILD='20260812r39';
  if(root.__revexR39Runtime) return;
  root.__revexR39Runtime=true;

  const Store=root.RevexStore;
  const iso=()=>new Date().toISOString();
  const clone=(v)=>JSON.parse(JSON.stringify(v===undefined?null:v));
  const safe=(v)=>String(v||'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=(v)=>safe(v).replace(/\./g,'_');
  const cloud=()=>Boolean(Store?.isCloud?.()&&Store.api&&Store.db&&Store.user?.uid);
  const lib=(projectId)=>Store.api.collection(Store.db,'projects',projectId,'library');
  const libDoc=(projectId,id)=>Store.api.doc(Store.db,'projects',projectId,'library',id);

  async function listKind(projectId,kind,max=1000){
    if(!cloud()||!projectId) return [];
    try{
      const f=Store.api,q=f.query(lib(projectId),f.where('revexKind','==',kind),f.limit(max)),snap=await f.getDocs(q);
      return snap.docs.map(d=>({id:d.id,...d.data()}));
    }catch(error){console.warn(`[REVEX r39] ${kind} list`,error);return []}
  }
  async function setKind(projectId,id,kind,data,merge=true){
    const payload=clone({...data,type:'revex',hidden:true,revexKind:kind,updatedAt:data?.updatedAt||iso()});
    await Store.api.setDoc(libDoc(projectId,id),payload,clone({merge}));
    return payload;
  }
  async function upload(projectId,area,file){
    if(!Store?.fs?.storage) throw new Error('LIBER Storage is unavailable.');
    const f=Store.api,name=safe(file.name||'file'),path=`projects/${projectId}/library/revex/${area}/${Date.now()}_${name}`,ref=f.ref(Store.fs.storage,path);
    await f.uploadBytes(ref,file,clone({contentType:file.type||(/\.json$/i.test(name)?'application/json':'application/octet-stream')}));
    return {path,url:await f.getDownloadURL(ref),name,size:file.size||0};
  }
  const dataUrl=(file)=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result||''));r.onerror=reject;r.readAsDataURL(file)});

  function installStoreContract(){
    if(!Store) return;

    if(typeof Store.resolveSpecProject!=='function') Store.resolveSpecProject=async function(projectId,preferredId){
      if(!projectId) return preferredId||null;
      if(!cloud()){
        if(preferredId) return preferredId;
        try{return (await this.getProject(projectId))?.revexSpecProjectId||null}catch(_){return null}
      }
      const f=this.api;
      if(preferredId){try{const snap=await f.getDoc(f.doc(this.db,'specProjects',preferredId));if(snap.exists()){const d=snap.data();if(!d.linkedProjectId||d.linkedProjectId===projectId)return preferredId}}catch(_){}}
      try{
        const project=await this.getProject(projectId);
        if(project?.revexSpecProjectId){const snap=await f.getDoc(f.doc(this.db,'specProjects',project.revexSpecProjectId));if(snap.exists())return project.revexSpecProjectId}
        const q=f.query(f.collection(this.db,'specProjects'),f.where('linkedProjectId','==',projectId),f.limit(10)),snap=await f.getDocs(q);
        if(!snap.empty)return snap.docs[0].id;
      }catch(error){console.warn('[REVEX r39] resolve Spec Book',error)}
      return null;
    };

    if(typeof Store.ensureSpecProject!=='function') Store.ensureSpecProject=async function(projectId,preferredId,suppliedProject=null){
      const existing=await this.resolveSpecProject(projectId,preferredId);if(existing)return existing;
      const project=suppliedProject||await this.getProject(projectId);if(!project)throw new Error('The shared LIBER project could not be loaded.');
      const id=`spec_${docId(projectId)}`,at=iso(),memberIds=[...new Set([...(project.memberIds||[]),project.ownerId,this.user?.uid||'local'].filter(Boolean))];
      const row={id,name:`${project.name||project.title||'Project'} — Spec Book`,code:project.code||'',linkedProjectId:projectId,linkedProjectName:project.name||project.title||'',ownerId:project.ownerId||this.user?.uid||'local',memberIds,settings:{divisionPerSchedule:true,showEmptyArticles:false},createdAt:at,updatedAt:at,managedByRevex:true};
      if(!cloud()) return id;
      await this.api.setDoc(this.api.doc(this.db,'specProjects',id),clone(row),clone({merge:true}));
      try{await this.api.updateDoc(this.api.doc(this.db,'projects',projectId),clone({revexSpecProjectId:id,updatedAt:at}))}catch(_){}
      return id;
    };

    if(typeof Store.listDesignEdits!=='function') Store.listDesignEdits=async function(projectId){
      if(!cloud()){try{return Object.values(JSON.parse(localStorage.getItem(`liber.revex.design.${projectId}`)||'{}'))}catch(_){return []}}
      return (await listKind(projectId,'design-item',2000)).map(r=>({...r,id:r.revexId||r.id}));
    };
    if(typeof Store.saveDesignEdit!=='function') Store.saveDesignEdit=async function(projectId,itemId,patch){
      const data={...patch,revexId:itemId,updatedAt:iso(),updatedBy:this.user?.uid||'local'};
      if(!cloud()){const key=`liber.revex.design.${projectId}`,all=JSON.parse(localStorage.getItem(key)||'{}');all[itemId]={...(all[itemId]||{}),...data,id:itemId};localStorage.setItem(key,JSON.stringify(all));return all[itemId]}
      await setKind(projectId,`revex_design_${docId(itemId)}`,'design-item',data,true);return{id:itemId,...data};
    };
    if(typeof Store.listChapterEdits!=='function') Store.listChapterEdits=async function(projectId){
      if(!cloud()){try{return Object.values(JSON.parse(localStorage.getItem(`liber.revex.chapters.${projectId}`)||'{}'))}catch(_){return []}}
      return (await listKind(projectId,'design-chapter',1000)).map(r=>({...r,id:r.revexId||r.id}));
    };
    if(typeof Store.saveChapterEdit!=='function') Store.saveChapterEdit=async function(projectId,chapterId,patch){
      const data={...patch,revexId:chapterId,updatedAt:iso(),updatedBy:this.user?.uid||'local'};
      if(!cloud()){const key=`liber.revex.chapters.${projectId}`,all=JSON.parse(localStorage.getItem(key)||'{}');all[chapterId]={...(all[chapterId]||{}),...data,id:chapterId};localStorage.setItem(key,JSON.stringify(all));return all[chapterId]}
      await setKind(projectId,`revex_chapter_${docId(chapterId)}`,'design-chapter',data,true);return{id:chapterId,...data};
    };
    if(typeof Store.uploadDesignImage!=='function') Store.uploadDesignImage=async function(projectId,itemId,file,current=[]){
      const added=cloud()?await upload(projectId,`design/items/${docId(itemId)}`,file):{url:await dataUrl(file),path:null,name:safe(file.name)};
      const images=[...(current||[]),{url:added.url,path:added.path||null,name:added.name}].slice(-12);await this.saveDesignEdit(projectId,itemId,{images});return images;
    };
    if(typeof Store.uploadChapterImage!=='function') Store.uploadChapterImage=async function(projectId,chapterId,field,file,current=[]){
      if(!['inspiration','renders','versionImages'].includes(field))throw new Error('Unknown Design Book image lane.');
      const added=cloud()?await upload(projectId,`design/chapters/${docId(chapterId)}/${field}`,file):{url:await dataUrl(file),path:null,name:safe(file.name)};
      const images=[...(current||[]),{url:added.url,path:added.path||null,name:added.name}].slice(-24);await this.saveChapterEdit(projectId,chapterId,{[field]:images});return images;
    };

    if(typeof Store.listIssues!=='function') Store.listIssues=async function(projectId){
      if(!cloud()){try{return JSON.parse(localStorage.getItem(`liber.revex.issues.${projectId}`)||'[]')}catch(_){return []}}
      return (await listKind(projectId,'issue',1000)).map(r=>({...r,id:r.revexId||r.id})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    };
    if(typeof Store.addIssue!=='function') Store.addIssue=async function(projectId,issue){const id=`issue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,data={...issue,revexId:id,createdAt:iso(),createdBy:this.user?.uid||'local'};if(!cloud()){const key=`liber.revex.issues.${projectId}`,all=JSON.parse(localStorage.getItem(key)||'[]'),row={id,...data};all.unshift(row);localStorage.setItem(key,JSON.stringify(all));return row}await setKind(projectId,`revex_issue_${docId(id)}`,'issue',data,false);return{id,...data}};
    if(typeof Store.updateIssue!=='function') Store.updateIssue=async function(projectId,issueId,patch){if(cloud())await setKind(projectId,`revex_issue_${docId(issueId)}`,'issue',{...patch,revexId:issueId,updatedAt:iso()},true)};

    if(typeof Store.listLibrary!=='function') Store.listLibrary=async function(projectId){
      if(!cloud()||!projectId)return[];try{const snap=await this.api.getDocs(this.api.collection(this.db,'projects',projectId,'library'));return snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.type==='file')}catch(error){console.warn('[REVEX r39] library',error);return[]}
    };
    if(typeof Store.fileUrl!=='function') Store.fileUrl=async function(storagePath){if(!storagePath||!this.fs?.storage)return null;return this.api.getDownloadURL(this.api.ref(this.fs.storage,storagePath))};
    if(typeof Store.uploadLibraryFile!=='function') Store.uploadLibraryFile=async function(projectId,file,folderPath='record_in/docs',metadata={}){if(!cloud())throw new Error('Sign in to upload project documents.');const id=`manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,name=safe(file.name),storagePath=`projects/${projectId}/library/${String(folderPath).replace(/^\/+|\/+$/g,'')}/${id}_${name}`,ref=this.api.ref(this.fs.storage,storagePath);await this.api.uploadBytes(ref,file,clone({contentType:file.type||'application/octet-stream'}));const at=iso(),data=clone({type:'file',name:file.name||name,storagePath,folderPath,size:file.size||0,mimeType:file.type||'',createdAt:at,updatedAt:at,createdBy:this.user?.uid||null,source:'manual',editable:true,...metadata});await this.api.setDoc(libDoc(projectId,id),data,clone({merge:true}));return{id,...data}};

    Store.listHistory=async function(projectId){
      if(!projectId)return[];if(!cloud()){try{return JSON.parse(localStorage.getItem(`liber.revex.history.${projectId}`)||'[]')}catch(_){return[]}}
      return (await listKind(projectId,'history',2500)).map(r=>({...r,id:r.revexId||r.id})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    };
    Store.appendHistory=async function(projectId,event={}){const at=iso(),id=event.id||`hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,data=clone({...event,revexId:id,projectId,createdAt:event.createdAt||at,createdBy:event.createdBy||this.user?.uid||'local',updatedAt:at});if(!cloud()){const key=`liber.revex.history.${projectId}`,all=JSON.parse(localStorage.getItem(key)||'[]');all.unshift({id,...data});localStorage.setItem(key,JSON.stringify(all.slice(0,2500)));return{id,...data}}await setKind(projectId,`revex_history_${docId(id)}`,'history',data,false);return{id,...data}};

    if(typeof Store.listBimOverlays!=='function') Store.listBimOverlays=async()=>[];
    if(typeof Store.listDerivedPlans!=='function') Store.listDerivedPlans=async()=>[];
    if(typeof Store.listRenderJobs!=='function') Store.listRenderJobs=async function(projectId){if(!projectId)return[];if(!cloud()){try{return JSON.parse(localStorage.getItem(`liber.revex.renders.${projectId}`)||'[]')}catch(_){return[]}}return(await listKind(projectId,'render',100)).map(r=>({...r,id:r.revexId||r.id})).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,40)};
    if(typeof Store.createRenderJob!=='function') Store.createRenderJob=async function(projectId,job){const id=`render_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,data={...job,revexId:id,status:job.status||'prepared',createdAt:iso(),updatedAt:iso(),createdBy:this.user?.uid||'local'};if(!cloud()){const key=`liber.revex.renders.${projectId}`,all=JSON.parse(localStorage.getItem(key)||'[]'),row={id,...data};all.unshift(row);localStorage.setItem(key,JSON.stringify(all.slice(0,40)));return row}await setKind(projectId,`revex_render_${docId(id)}`,'render',data,false);return{id,...data}};
    if(typeof Store.updateRenderJob!=='function') Store.updateRenderJob=async function(projectId,jobId,patch){const data={...patch,revexId:jobId,updatedAt:iso(),updatedBy:this.user?.uid||'local'};if(cloud())await setKind(projectId,`revex_render_${docId(jobId)}`,'render',data,true);return{id:jobId,...data}};

    console.info('[REVEX] r39 Store contract',{design:true,spec:true,docs:true,history:true,failSoft:true});
  }

  installStoreContract();

  function familyKey(row){const family=String(row?.family||row?.category||'System / Other').trim()||'System / Other',type=String(row?.type||row?.name||'Unnamed type').trim()||'Unnamed type';return `${family}\u241f${type}`}
  function familyLabel(row){const [family,type]=familyKey(row).split('\u241f');return family.toLowerCase()===type.toLowerCase()?family:`${family} · ${type}`}
  function instanceLabel(row){const type=String(row?.type||row?.name||row?.category||'Instance').trim(),level=String(row?.level||'').trim();return `${level?`${type} · ${level}`:type} · #${row?.id??''}`}
  let treeObserver=null,treeBusy=false,selectedFamily='',selectedInstance='';

  function ensureModelFilters(){
    const search=document.getElementById('element-search');if(!search)return;
    let bar=document.getElementById('model-filter-bar');
    if(!bar){bar=document.createElement('div');bar.id='model-filter-bar';bar.className='model-filter-bar';bar.innerHTML='<label><span>Family type</span><select id="model-family-type-filter" class="sp-inp"><option value="">All family types</option></select></label><label><span>Instance</span><select id="model-instance-filter" class="sp-inp"><option value="">All instances</option></select></label><button id="model-filter-clear" type="button" class="button ghost compact">Clear</button>';search.insertAdjacentElement('afterend',bar);document.getElementById('model-family-type-filter').addEventListener('change',e=>{selectedFamily=e.target.value;selectedInstance='';syncFilterOptions();organizeTree()});document.getElementById('model-instance-filter').addEventListener('change',e=>{selectedInstance=e.target.value;organizeTree()});document.getElementById('model-filter-clear').addEventListener('click',()=>{selectedFamily='';selectedInstance='';document.getElementById('model-family-type-filter').value='';document.getElementById('model-instance-filter').value='';organizeTree()})}
    syncFilterOptions();
  }
  function syncFilterOptions(){
    const rows=root.__revexState?.viewerData?.elements||[],family=document.getElementById('model-family-type-filter'),instance=document.getElementById('model-instance-filter');if(!family||!instance)return;
    const groups=new Map();for(const r of rows){const k=familyKey(r);if(!groups.has(k))groups.set(k,{label:familyLabel(r),rows:[]});groups.get(k).rows.push(r)}
    const options=[...groups.entries()].sort((a,b)=>a[1].label.localeCompare(b[1].label,undefined,{numeric:true,sensitivity:'base'}));family.innerHTML='<option value="">All family types</option>'+options.map(([k,g])=>`<option value="${escapeHtml(k)}">${escapeHtml(g.label)} · ${g.rows.length}</option>`).join('');if(groups.has(selectedFamily))family.value=selectedFamily;else selectedFamily='';
    const source=selectedFamily?(groups.get(selectedFamily)?.rows||[]):rows,sorted=[...source].sort((a,b)=>instanceLabel(a).localeCompare(instanceLabel(b),undefined,{numeric:true,sensitivity:'base'}));instance.innerHTML='<option value="">All instances</option>'+sorted.slice(0,3000).map(r=>`<option value="${escapeHtml(String(r.id))}">${escapeHtml(instanceLabel(r))}</option>`).join('');if(sorted.some(r=>String(r.id)===selectedInstance))instance.value=selectedInstance;else selectedInstance='';
  }
  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function organizeTree(){
    const host=document.getElementById('element-tree'),rows=root.__revexState?.viewerData?.elements||[];if(!host||!rows.length||treeBusy)return;ensureModelFilters();
    const byId=new Map(rows.map(r=>[String(r.id),r])),buttons=[...host.querySelectorAll('.tree-item[data-element-id]')];if(!buttons.length)return;
    treeBusy=true;treeObserver?.disconnect();
    try{
      host.querySelectorAll('.tree-group,.tree-family-type').forEach(n=>n.remove());
      const groups=new Map();
      for(const b of buttons){const r=byId.get(String(b.dataset.elementId));if(!r)continue;const key=familyKey(r);if(!groups.has(key))groups.set(key,{label:familyLabel(r),items:[]});groups.get(key).items.push({b,r})}
      const frag=document.createDocumentFragment();
      [...groups.values()].sort((a,b)=>a.label.localeCompare(b.label,undefined,{numeric:true,sensitivity:'base'})).forEach(g=>{
        const visibleItems=g.items.filter(({r})=>(!selectedFamily||familyKey(r)===selectedFamily)&&(!selectedInstance||String(r.id)===selectedInstance));if(!visibleItems.length){g.items.forEach(({b})=>{b.hidden=true;frag.appendChild(b)});return}
        const h=document.createElement('div');h.className='tree-group tree-family-type';h.innerHTML=`<span>${escapeHtml(g.label)}</span><b>${visibleItems.length}</b>`;frag.appendChild(h);
        g.items.sort((a,b)=>instanceLabel(a.r).localeCompare(instanceLabel(b.r),undefined,{numeric:true,sensitivity:'base'})).forEach(({b,r})=>{b.hidden=Boolean((selectedFamily&&familyKey(r)!==selectedFamily)||(selectedInstance&&String(r.id)!==selectedInstance));if(!b.hidden){const span=b.querySelector('span:first-child');if(span&&!span.dataset.r39Instance){span.dataset.r39Instance='1';span.textContent=instanceLabel(r).replace(/ · #.*$/,'')}}frag.appendChild(b)});
      });
      host.replaceChildren(frag);
    }finally{treeBusy=false;observeTree()}
  }
  function observeTree(){const host=document.getElementById('element-tree');if(!host)return;if(!treeObserver)treeObserver=new MutationObserver(()=>{if(!treeBusy)setTimeout(organizeTree,0)});treeObserver.observe(host,{childList:true,subtree:false})}

  async function patchViewer(){
    const v=root.__revexViewerR26Instance;if(!v||v.__r39Patched)return false;
    v.__r39Patched=true;
    let THREE=null;try{THREE=await import('three')}catch(error){console.warn('[REVEX r39] three import',error);return false}
    const originalClear=typeof v.clear==='function'?v.clear.bind(v):null;
    v.sectionHelper=null;v.section={enabled:false,minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1};
    v.sectionBox=function(){if(!this.bounds)return null;const b=this.bounds,s=b.getSize(new THREE.Vector3());return new THREE.Box3(new THREE.Vector3(b.min.x+s.x*this.section.minX,b.min.y+s.y*this.section.minY,b.min.z+s.z*this.section.minZ),new THREE.Vector3(b.min.x+s.x*this.section.maxX,b.min.y+s.y*this.section.maxY,b.min.z+s.z*this.section.maxZ))};
    v.syncSectionControls=function(){if(!this.bounds)return;const s=this.bounds.getSize(new THREE.Vector3()),set=(id,val)=>{const el=document.getElementById(id);if(el&&document.activeElement!==el)el.value=String(val)};for(const [id,key]of[['section-left','minX'],['section-right','maxX'],['section-bottom','minY'],['section-top','maxY'],['section-front','minZ'],['section-back','maxZ']])set(id,Math.round(this.section[key]*1000)/10);set('section-width',((this.section.maxX-this.section.minX)*s.x).toFixed(2));set('section-height',((this.section.maxY-this.section.minY)*s.y).toFixed(2));set('section-length',((this.section.maxZ-this.section.minZ)*s.z).toFixed(2));const note=document.getElementById('section-size-note');if(note)note.textContent=`W ${((this.section.maxX-this.section.minX)*s.x).toFixed(1)}′ · L ${((this.section.maxZ-this.section.minZ)*s.z).toFixed(1)}′ · H ${((this.section.maxY-this.section.minY)*s.y).toFixed(1)}′`};
    v.sectionApply=function(){if(!this.model)return;const box=this.section.enabled?this.sectionBox():null,planes=box?[new THREE.Plane(new THREE.Vector3(1,0,0),-box.min.x),new THREE.Plane(new THREE.Vector3(-1,0,0),box.max.x),new THREE.Plane(new THREE.Vector3(0,1,0),-box.min.y),new THREE.Plane(new THREE.Vector3(0,-1,0),box.max.y),new THREE.Plane(new THREE.Vector3(0,0,1),-box.min.z),new THREE.Plane(new THREE.Vector3(0,0,-1),box.max.z)]:[];this.renderer.localClippingEnabled=true;this.model.traverse(n=>{if(!n.isMesh)return;(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean).forEach(m=>{m.clippingPlanes=planes;m.clipIntersection=false;m.needsUpdate=true})});if(this.sectionHelper){this.scene.remove(this.sectionHelper);this.sectionHelper.geometry?.dispose?.();this.sectionHelper.material?.dispose?.();this.sectionHelper=null}if(box){this.sectionHelper=new THREE.Box3Helper(box,0xb9c1cc);this.sectionHelper.name='REVEX_SECTION_BOX';this.scene.add(this.sectionHelper)}this.syncSectionControls();this.requestRender()};
    v.setSectionFace=function(key,value){const x=Math.max(0,Math.min(1,+value||0)),gap=.002;if(key.startsWith('min'))this.section[key]=Math.min(x,this.section['max'+key.slice(3)]-gap);else this.section[key]=Math.max(x,this.section['min'+key.slice(3)]+gap);this.syncSectionControls();this.sectionApply()};
    v.setSectionDimension=function(axis,value){if(!this.bounds)return;const s=this.bounds.getSize(new THREE.Vector3()),dim=axis==='X'?s.x:axis==='Y'?s.y:s.z,target=Math.max(dim*.002,Math.min(dim,+value||dim)),span=target/Math.max(dim,1e-9),minKey='min'+axis,maxKey='max'+axis;let center=(this.section[minKey]+this.section[maxKey])*.5,min=center-span*.5,max=center+span*.5;if(min<0){max-=min;min=0}if(max>1){min-=max-1;max=1}this.section[minKey]=Math.max(0,min);this.section[maxKey]=Math.min(1,max);this.syncSectionControls();this.sectionApply()};
    v.resetSection=function(){Object.assign(this.section,{minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1});this.syncSectionControls();this.sectionApply()};
    v.clear=function(){if(this.sectionHelper){this.scene.remove(this.sectionHelper);this.sectionHelper.geometry?.dispose?.();this.sectionHelper.material?.dispose?.();this.sectionHelper=null}return originalClear?.()};

    function attachInstanceIds(){if(!v.data||!v.model)return;const groups=new Map();for(const r of v.data.elements||[]){if(!r?.bbox?.min||!r?.bbox?.max)continue;const d=v.descriptor?.(r),k=d?.name||r.typeUniqueId||r.categoryKey||'other';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r)}v.model.traverse?.(n=>{if(!n.isInstancedMesh)return;const rows=groups.get(n.name);if(rows?.length===n.count)n.userData.revexElementIds=rows.map(r=>String(r.id))})}
    const oldPick=v.pick.bind(v);v.pick=function(e){attachInstanceIds();if(!this.model)return;const rect=this.renderer.domElement.getBoundingClientRect();this.pointer.set((e.clientX-rect.left)/rect.width*2-1,-((e.clientY-rect.top)/rect.height*2-1));this.ray.setFromCamera(this.pointer,this.camera);const box=this.section.enabled?this.sectionBox():null,h=this.ray.intersectObject(this.model,true).find(x=>x.object.visible!==false&&(!box||box.containsPoint(x.point)));if(!h)return;let node=h.object,best=null;if(h.object?.isInstancedMesh&&Number.isInteger(h.instanceId)){const id=h.object.userData?.revexElementIds?.[h.instanceId];if(id!=null)best=this.byId.get(String(id))||null}while(node&&!best){const id=String(node.userData?.revexElementId||'');if(id)best=this.byId.get(id)||null;node=node.parent}if(!best)best=this.nearestRow(h.point);if(best)this.selectAndRoute(best);else oldPick(e)};

    const host=document.getElementById('section-controls');if(host){host.innerHTML='<div class="section-box-head"><div><strong>Section box</strong><small id="section-size-note">Model extents</small></div><button id="section-reset" type="button">Reset</button></div><div class="section-dimensions"><label>Width <span><input id="section-width" type="number" min="0.01" step="0.1"><b>ft</b></span></label><label>Length <span><input id="section-length" type="number" min="0.01" step="0.1"><b>ft</b></span></label><label>Height <span><input id="section-height" type="number" min="0.01" step="0.1"><b>ft</b></span></label></div><div class="section-faces"><label><span>Left</span><input id="section-left" type="range" min="0" max="100" step="0.1" value="0"></label><label><span>Right</span><input id="section-right" type="range" min="0" max="100" step="0.1" value="100"></label><label><span>Front</span><input id="section-front" type="range" min="0" max="100" step="0.1" value="0"></label><label><span>Back</span><input id="section-back" type="range" min="0" max="100" step="0.1" value="100"></label><label><span>Bottom</span><input id="section-bottom" type="range" min="0" max="100" step="0.1" value="0"></label><label><span>Top</span><input id="section-top" type="range" min="0" max="100" step="0.1" value="100"></label></div><div class="section-box-note">Six-face geometric clip. Material-layer cut caps are intentionally not synthesized yet.</div>';for(const [id,key]of[['section-left','minX'],['section-right','maxX'],['section-bottom','minY'],['section-top','maxY'],['section-front','minZ'],['section-back','maxZ']])document.getElementById(id)?.addEventListener('input',e=>v.setSectionFace(key,(+e.target.value||0)/100));for(const [id,axis]of[['section-width','X'],['section-height','Y'],['section-length','Z']])document.getElementById(id)?.addEventListener('change',e=>v.setSectionDimension(axis,+e.target.value));document.getElementById('section-reset')?.addEventListener('click',()=>v.resetSection())}
    attachInstanceIds();v.syncSectionControls();
    root.addEventListener('revex:source-revision-loaded',()=>setTimeout(()=>{attachInstanceIds();v.syncSectionControls()},50));
    console.info('[REVEX] r39 viewer upgrade',{instanceIdPicking:true,trueSectionBox:true,planes:6});return true;
  }

  function installCss(){if(document.getElementById('revex-r39-runtime-style'))return;const s=document.createElement('style');s.id='revex-r39-runtime-style';s.textContent='.model-filter-bar{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:6px;padding:6px 0 10px}.model-filter-bar label{display:grid;gap:3px;min-width:0}.model-filter-bar label>span{font-size:9px;letter-spacing:.08em;text-transform:uppercase;opacity:.55}.model-filter-bar select{min-width:0;height:30px}.tree-family-type{display:flex;justify-content:space-between;gap:8px}.tree-family-type b{font-weight:500;opacity:.5}.section-box-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.section-box-head>div{display:grid;gap:2px}.section-box-head small{font-size:10px;opacity:.55}.section-dimensions{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}.section-dimensions label{display:grid;gap:3px;font-size:10px}.section-dimensions label span{display:flex;align-items:center;gap:4px}.section-dimensions input{min-width:0;width:100%}.section-faces{display:grid;gap:5px}.section-faces label{display:grid;grid-template-columns:44px minmax(0,1fr);align-items:center;gap:7px;font-size:10px}.section-box-note{margin-top:7px;font-size:9px;line-height:1.35;opacity:.52}@media(max-width:720px){.model-filter-bar{grid-template-columns:1fr 1fr}.model-filter-bar button{grid-column:1/-1}.section-dimensions{grid-template-columns:1fr}}';document.head.appendChild(s)}

  function start(){installCss();ensureModelFilters();organizeTree();observeTree();const tick=()=>{ensureModelFilters();organizeTree();patchViewer().then(ok=>{if(!ok)setTimeout(tick,250)})};tick()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  console.info('[REVEX] runtime '+BUILD,{storeContract:true,bimFamilyType:true,sectionBox:true});
})(window);