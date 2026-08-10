(function(root){
  'use strict';
  const BUILD='20260810r19';
  const Store=root.RevexStore;
  if(!Store||root.__revexProjectionIntegrityR19) return;
  root.__revexProjectionIntegrityR19=true;

  const blockedCategories=/^(cameras?|views?|viewports?|sheets?|levels?|grids?|reference planes?|scope boxes?|project information|internal origin|survey point|project base point|sections?|elevations?|callouts?)$/i;
  const categoryTitles={
    walls:'Walls',doors:'Doors',windows:'Windows',floors:'Floors',roofs:'Roofs',rooms:'Rooms',ceilings:'Ceilings',
    'stairs-railings':'Stairs & Railings',casework:'Casework',furniture:'Furniture','lighting-fixtures':'Lighting Fixtures',
    'plumbing-fixtures':'Plumbing Fixtures','electrical-equipment':'Electrical Equipment','mechanical-equipment':'Mechanical Equipment',
    'structural-columns':'Structural Columns','structural-framing':'Structural Framing','specialty-equipment':'Specialty Equipment',
    'generic-models':'Generic Models',site:'Site',other:'Other Model Elements'
  };
  const safe=(v)=>String(v??'').trim();
  const slug=(v)=>safe(v).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'item';

  function post(type,detail={}){
    try{ root.chrome?.webview?.postMessage({type,build:BUILD,...detail}); }catch(_){ }
  }

  function isUsableElement(row){
    if(!row||!row.bbox?.min||!row.bbox?.max) return false;
    const cat=safe(row.category);
    if(blockedCategories.test(cat)) return false;
    return true;
  }

  function normalizeViewer(viewer){
    if(!viewer||typeof viewer!=='object') return viewer;
    const all=Array.isArray(viewer.elements)?viewer.elements:[];
    const elements=all.filter(isUsableElement);
    const counts=new Map();
    elements.forEach((row)=>{
      const key=safe(row.categoryKey)||'other';
      counts.set(key,(counts.get(key)||0)+1);
    });
    return {
      ...viewer,
      schema:viewer.schema||'liber.revex.viewer.v2',
      projectionIntegrity:{build:BUILD,sourceElements:all.length,usableElements:elements.length,excludedElements:all.length-elements.length},
      categories:[...counts].map(([key,count])=>({key,count})),
      elements
    };
  }

  function deriveDesign(viewer,original){
    const elements=Array.isArray(viewer?.elements)?viewer.elements:[];
    const byChapter=new Map();
    elements.forEach((row)=>{
      const key=safe(row.categoryKey)||'other';
      if(!byChapter.has(key)) byChapter.set(key,new Map());
      const family=safe(row.family);
      const type=safe(row.type)||safe(row.name)||safe(row.category)||'Element';
      const stable=`${family}|${type}`;
      const types=byChapter.get(key);
      if(!types.has(stable)) types.set(stable,{family,type,category:safe(row.category),ids:[],materials:new Set(),levels:new Set()});
      const rec=types.get(stable);
      rec.ids.push(row.id);
      (row.materials||[]).forEach((m)=>{ if(safe(m?.name)) rec.materials.add(safe(m.name)); });
      if(safe(row.level)) rec.levels.add(safe(row.level));
    });
    const chapters=[...byChapter.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,types],chapterIndex)=>({
      id:`revit-${slug(key)}`,
      title:categoryTitles[key]||safe([...types.values()][0]?.category)||categoryTitles.other,
      order:(chapterIndex+1)*10,
      sourceKind:'revit-model-fallback',
      roomAliases:[],inspiration:[],renders:[],versions:[{id:'v1',name:'Version 1'},{id:'v2',name:'Version 2'},{id:'v3',name:'Version 3'}],
      items:[...types.values()].sort((a,b)=>`${a.family} ${a.type}`.localeCompare(`${b.family} ${b.type}`)).map((rec,index)=>({
        id:`revit-${slug(key)}-${slug(rec.family||rec.type)}-${slug(rec.type)}`,
        label:rec.family&&rec.family!==rec.type?`${rec.family} — ${rec.type}`:rec.type,
        description:`${rec.ids.length} synced Revit instance${rec.ids.length===1?'':'s'} · ${rec.category||categoryTitles[key]||'Model element'}`,
        source:'',status:'Not Selected',images:[],comments:[],candidateMaterials:[...rec.materials].slice(0,24),order:(index+1)*10,
        revit:{sourceKind:'synced-model-type',categoryKey:key,category:rec.category,family:rec.family,type:rec.type,instanceCount:rec.ids.length,elementIds:rec.ids.slice(0,250),elementIdsTruncated:rec.ids.length>250,levels:[...rec.levels]}
      }))
    }));
    return {
      ...(original||{}),
      schema:original?.schema||'liber.revex.designbook.browser-fallback.v1',
      generatedAt:original?.generatedAt||new Date().toISOString(),
      formation:{...(original?.formation||{}),browserRecovery:true,recoveryBuild:BUILD,syncedModelTypePositions:chapters.reduce((n,c)=>n+c.items.length,0)},
      chapters,
      schedules:Array.isArray(original?.schedules)?original.schedules:[]
    };
  }

  function normalizeDesign(design,viewer){
    const chapters=Array.isArray(design?.chapters)?design.chapters:[];
    if(chapters.length) return design;
    return deriveDesign(viewer,design);
  }

  function jsonUrl(value){
    return URL.createObjectURL(new Blob([JSON.stringify(value??null)],{type:'application/json'}));
  }

  function localStateFor(pkg){
    if(!pkg) return null;
    if(!pkg.__projectionUrls){
      pkg.__projectionUrls={viewerUrl:jsonUrl(pkg.viewer),designUrl:jsonUrl(pkg.design),projectUrl:jsonUrl(pkg.project),specPushUrl:jsonUrl(pkg.specPush)};
    }
    return {
      ...pkg,
      ...pkg.__projectionUrls,
      localOnly:true,
      sourceMode:'controlled-revit-sync',
      geometryAuthority:'ifc',
      scheduleCount:Number(pkg.integrity?.counts?.schedules||pkg.design?.schedules?.length||0),
      elementCount:Number(pkg.viewer?.elements?.length||0),
      spec:{status:'local-preview',projectId:safe(pkg.project?.central?.specProjectId)||new URLSearchParams(location.search).get('specProjectId')||null,rev:pkg.specPush?.rev||pkg.revision}
    };
  }

  function setLocalUi(pkg){
    if(!pkg||pkg.cloud!==false) return;
    const rev=safe(pkg.revision).replace(/^rev_/,'');
    setTimeout(()=>{
      const label=document.getElementById('sync-label');
      const indicator=document.getElementById('sync-indicator');
      if(label) label.textContent=`Local revision ${rev.slice(-12)} · sign in to publish`;
      if(indicator) indicator.dataset.tone='quiet';
      const designTab=document.querySelector('.main-nav [data-view="design"]');
      if(designTab) designTab.textContent='Design Book';
    },0);
  }

  function wrapStore(){
    if(Store.__revexProjectionWrappedR19) return true;
    if(typeof Store.syncPackage!=='function'||typeof Store.getState!=='function') return false;
    const originalSync=Store.syncPackage.bind(Store);
    const originalGetState=Store.getState.bind(Store);

    Store.syncPackage=async function projectionSync(fileList,preferredProjectId,preferredSpecProjectId){
      const result=await originalSync(fileList,preferredProjectId,preferredSpecProjectId);
      result.viewer=normalizeViewer(result.viewer);
      result.design=normalizeDesign(result.design,result.viewer);
      Store.lastLocalPackage=result;
      root.__revexActiveRevision=result;
      setLocalUi(result);
      post('liber:revex-revision-projection',{
        revision:result.revision,cloud:Boolean(result.cloud),viewerElements:result.viewer?.elements?.length||0,
        designChapters:result.design?.chapters?.length||0,
        designPositions:(result.design?.chapters||[]).reduce((n,c)=>n+(c.items?.length||0),0),specSchedules:result.specPush?.payload?.length||0
      });
      return result;
    };

    Store.getState=async function projectionGetState(projectId){
      const pkg=Store.lastLocalPackage;
      if(!Store.isCloud()&&pkg&&String(pkg.projectId)===String(projectId)) return localStateFor(pkg);
      return originalGetState(projectId);
    };

    Store.__revexProjectionWrappedR19=true;
    return true;
  }

  async function provisionLocalSpec(){
    const pkg=Store.lastLocalPackage;
    if(!pkg||pkg.cloud!==false||!pkg.specPush?.payload?.length) return;
    const frame=document.getElementById('spec-frame');
    if(!frame?.contentWindow) return;
    let child;
    try{ child=frame.contentWindow; void child.location.href; }catch(_){ return; }
    const ST=child.SpecStore, SP=child.SpecSync;
    if(!ST||!SP) return setTimeout(provisionLocalSpec,120);
    const query=new URLSearchParams(location.search);
    const sid=safe(query.get('specProjectId'))||safe(pkg.project?.central?.specProjectId)||`spec_${pkg.projectId}`;
    const key=`revex.local.spec.${pkg.revision}.${sid}`;
    if(child.sessionStorage.getItem(key)==='ready') return;
    try{
      await ST.init();
      if(ST.isCloud()) return;
      const raw=JSON.parse(child.localStorage.getItem('liber.spec.v1')||'{}');
      raw.projects=raw.projects||{};
      raw.projects[sid]={
        ...(raw.projects[sid]||{}),id:sid,name:`${safe(pkg.project?.central?.documentTitle)||'REVEX Project'} — Specifications`,
        code:raw.projects[sid]?.code||'',linkedProjectId:pkg.projectId,linkedProjectName:safe(pkg.project?.central?.documentTitle),ownerId:'local',memberIds:[],
        settings:{divisionPerSchedule:true,showEmptyArticles:false},createdAt:raw.projects[sid]?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()
      };
      child.localStorage.setItem('liber.spec.v1',JSON.stringify(raw));
      child.localStorage.setItem('liber.spec.last',sid);
      child.dispatchEvent(new Event('liber-spec-change'));
      const parsed=SP.normalisePush(pkg.specPush.payload);
      const built=SP.build(parsed);
      const existing=await ST.listIn('items',sid);
      await SP.apply(ST,sid,built,existing,'REVEX Revit sync');
      child.sessionStorage.setItem(key,'ready');
      post('liber:revex-sync-progress',{stage:'local-spec-projected',schedules:pkg.specPush.payload.length,specProjectId:sid});
      const u=new URL(child.location.href);
      if(u.searchParams.get('specProjectId')!==sid) u.searchParams.set('specProjectId',sid);
      u.searchParams.set('revexLocalRevision',pkg.revision);
      child.location.replace(u.href);
    }catch(error){
      console.error('[REVEX] local Spec Book projection',error);
      post('liber:revex-sync-progress',{stage:'local-spec-projection-failed',error:String(error?.message||error)});
    }
  }

  function wireSpec(){
    const frame=document.getElementById('spec-frame');
    if(frame&&!frame.dataset.revexProjectionR19){
      frame.dataset.revexProjectionR19='1';
      frame.addEventListener('load',()=>setTimeout(provisionLocalSpec,80));
    }
    const tab=document.querySelector('[data-view="spec"]');
    if(tab&&!tab.dataset.revexProjectionR19){tab.dataset.revexProjectionR19='1';tab.addEventListener('click',()=>setTimeout(provisionLocalSpec,180));}
  }

  let lastAuth='';
  function reportAuth(){
    try{
      const signedIn=Boolean(Store.user?.uid);
      const cloud=Boolean(Store.isCloud?.());
      const sig=`${cloud}:${Store.user?.uid||''}`;
      if(sig!==lastAuth){lastAuth=sig;post('liber:revex-auth-state',{cloud,signedIn,email:Store.user?.email||null});}
    }catch(_){ }
  }

  function start(){
    const wait=()=>{
      if(!wrapStore()) return setTimeout(wait,50);
      wireSpec();reportAuth();
      setInterval(reportAuth,1200);
      setInterval(()=>{wireSpec();if(Store.lastLocalPackage)setLocalUi(Store.lastLocalPackage);},1600);
      console.log('[REVEX] projection integrity '+BUILD,{singleRevision:true,localSpec:true,designRecovery:true,viewerFilter:true});
    };
    wait();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start,{once:true}); else start();
})(window);
