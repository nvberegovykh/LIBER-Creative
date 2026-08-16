(function(root){
  'use strict';
  const BUILD='20260816r71-state1';
  const Store=root.RevexStore;
  if(!Store||root.__revexCompanionStateR71)return;
  root.__revexCompanionStateR71={build:BUILD};

  const state=()=>root.__revexState||null;
  const text=value=>String(value??'').trim();
  const norm=value=>text(value).toLowerCase().replace(/\s+/g,' ');
  const stable=row=>text(row?.uniqueId||row?.elementId||row?.id);
  const typeKey=row=>text(row?.typeUniqueId||row?.typeId||row?.revitTypeUniqueId)
    ?`uid:${text(row.typeUniqueId||row.typeId||row.revitTypeUniqueId)}`
    :`text:${norm(row?.category)}|${norm(row?.family)}|${norm(row?.type||row?.typeName||row?.name)}`;
  const appearanceKey=(scope,key)=>`${scope}:${key}`;
  const cloud=()=>!!(Store.isCloud?.()&&Store.api&&Store.db&&Store.user?.uid);
  let unsubscribeAppearance=null;
  let activeProject='';
  let generation=0;

  function diagnostic(level,stage,message,detail={}){
    try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'companion state r71',...detail});}catch(_){}
  }

  function formatWhen(value){
    if(!value)return'';
    const date=value?.toDate?value.toDate():new Date(value);
    return Number.isNaN(date?.getTime?.())?'':date.toLocaleString();
  }

  function architexturesSourceUrl(value){
    const url=text(value);
    return /^https:\/\/(www\.)?architextures\.org\//i.test(url)?url:'';
  }

  function architexturesEditUrl(value){
    const url=architexturesSourceUrl(value);
    const match=url.match(/^https:\/\/(?:www\.)?architextures\.org\/(?:textures|create)\/(\d+)/i);
    return match?`https://architextures.org/create/${match[1]}`:'';
  }

  async function listAppearances(projectId){
    if(!projectId)return[];
    if(typeof Store.listBimAppearances==='function')return Store.listBimAppearances(projectId);
    if(!cloud()){
      try{return Object.values(JSON.parse(localStorage.getItem(`liber.revex.bim-appearance.${projectId}`)||'{}'));}catch(_){return[];}
    }
    const f=Store.api;
    const query=f.query(f.collection(Store.db,'projects',projectId,'library'),f.where('revexKind','==','bim-appearance'),f.limit(5000));
    const snap=await f.getDocs(query);
    return snap.docs.map(doc=>({id:doc.id,...doc.data()}));
  }

  function syncInspector(){
    const s=state(),element=s?.selectedElement,box=document.querySelector('#bim-inspector [data-r70-box]');
    if(!element||!box||box.contains(document.activeElement))return;
    const scope=box.querySelector('[data-r70-scope]')?.value||'instance';
    const key=scope==='type'?typeKey(element):stable(element);
    const row=s.bimAppearances?.get?.(appearanceKey(scope,key))||{};
    const set=(selector,value)=>{const node=box.querySelector(selector);if(node&&document.activeElement!==node)node.value=String(value);};
    const useColor=box.querySelector('[data-r70-use-color]');
    if(useColor)useColor.checked=!!row.color;
    set('[data-r70-color]',/^#[0-9a-f]{6}$/i.test(text(row.color))?row.color:'#8f96a3');
    set('[data-r70-opacity]',row.opacity??1);
    set('[data-r70-source]',row.texture?.sourceUrl||'');
    set('[data-r70-rx]',row.texture?.repeatX??1);
    set('[data-r70-ry]',row.texture?.repeatY??1);
    set('[data-r70-rot]',row.texture?.rotation??0);
    const preview=box.querySelector('[data-r70-preview]');
    if(preview){preview.hidden=!row.texture?.assetUrl;if(row.texture?.assetUrl)preview.src=row.texture.assetUrl;else preview.removeAttribute('src');}
    let live=box.querySelector('[data-r71-live-state]');
    if(!live){live=document.createElement('small');live.dataset.r71LiveState='1';live.className='muted';box.appendChild(live);}
    const when=formatWhen(row.updatedAt);
    live.textContent=when?`Live project appearance · ${when}`:'No committed appearance at this scope.';
    syncSourceButtons(box);
  }

  function publishAppearanceRows(projectId,rows,source){
    const s=state();
    if(!s||s.projectId!==projectId)return;
    s.bimAppearances=new Map((rows||[]).filter(row=>row?.scope&&row?.scopeKey).map(row=>[appearanceKey(row.scope,row.scopeKey),row]));
    const values=[...s.bimAppearances.values()];
    root.__revexViewerR26Instance?.setAppearances?.(values);
    root.dispatchEvent(new CustomEvent('revex:bim-appearances-changed',{detail:{projectId,appearances:values,source}}));
    setTimeout(syncInspector,0);
  }

  function clearAppearanceState(){
    const s=state();
    if(s)s.bimAppearances=new Map();
    root.__revexViewerR26Instance?.setAppearances?.([]);
  }

  async function attach(projectId){
    projectId=text(projectId);
    const token=++generation;
    try{unsubscribeAppearance?.();}catch(_){}
    unsubscribeAppearance=null;
    activeProject=projectId;
    clearAppearanceState();
    if(!projectId)return;

    if(typeof Store.subscribeKind==='function'&&cloud()){
      try{
        unsubscribeAppearance=Store.subscribeKind(projectId,'bim-appearance',rows=>{
          if(token!==generation||activeProject!==projectId)return;
          publishAppearanceRows(projectId,rows,'live');
        },5000);
      }catch(error){diagnostic('WARN','BIM_APPEARANCE_SUBSCRIBE',error?.message||String(error),{projectId});}
    }

    try{
      const rows=await listAppearances(projectId);
      if(token!==generation||activeProject!==projectId)return;
      publishAppearanceRows(projectId,rows,'hydrate');
    }catch(error){diagnostic('ERROR','BIM_APPEARANCE_HYDRATE',error?.message||String(error),{projectId});}
  }

  function syncSourceButtons(box){
    if(!box)return;
    const source=box.querySelector('[data-r70-source]');
    if(!source)return;
    const sourceUrl=architexturesSourceUrl(source.value);
    const editUrl=architexturesEditUrl(source.value);
    const open=box.querySelector('[data-r71-open-source]');
    const edit=box.querySelector('[data-r71-edit-source]');
    if(open)open.disabled=!sourceUrl;
    if(edit)edit.disabled=!editUrl;
  }

  function bindSourceOpen(){
    const box=document.querySelector('#bim-inspector [data-r70-box]');
    if(!box)return;
    const source=box.querySelector('[data-r70-source]');
    if(!source)return;
    if(!box.querySelector('[data-r71-open-source]')){
      const button=document.createElement('button');
      button.type='button';button.className='button ghost compact';button.dataset.r71OpenSource='1';button.textContent='Open selected source';
      button.addEventListener('click',()=>{const url=architexturesSourceUrl(source.value);if(url)root.open(url,'_blank','noopener');});
      source.insertAdjacentElement('afterend',button);
    }
    if(!box.querySelector('[data-r71-edit-source]')){
      const button=document.createElement('button');
      button.type='button';button.className='button ghost compact';button.dataset.r71EditSource='1';button.textContent='Edit in Architextures';
      button.addEventListener('click',()=>{const url=architexturesEditUrl(source.value);if(url)root.open(url,'_blank','noopener');});
      box.querySelector('[data-r71-open-source]')?.insertAdjacentElement('afterend',button);
    }
    if(!source.dataset.r71SourceBound){source.dataset.r71SourceBound='1';source.addEventListener('input',()=>syncSourceButtons(box));}
    syncSourceButtons(box);
  }

  function currentProject(){return text(state()?.projectId||document.getElementById('project-select')?.value);}
  function start(){
    root.addEventListener('revex:authoritative-project-bound',event=>attach(event.detail?.projectId||currentProject()));
    root.addEventListener('revex:source-revision-loaded',()=>{const id=currentProject();if(id&&id!==activeProject)attach(id);});
    root.addEventListener('revex:bim-selection',()=>setTimeout(()=>{syncInspector();bindSourceOpen();},40));
    root.addEventListener('revex:bim-appearances-changed',()=>setTimeout(syncInspector,0));
    document.getElementById('project-select')?.addEventListener('change',event=>attach(event.target.value));
    let tries=0;
    const timer=setInterval(()=>{
      tries+=1;
      const id=currentProject();
      if(id&&id!==activeProject)attach(id);
      syncInspector();bindSourceOpen();
      if(tries>100)clearInterval(timer);
    },150);
    const initial=currentProject();if(initial)attach(initial);
    diagnostic('INFO','COMPANION_STATE_R71','Canonical visibility installed before hydration; BIM appearance now hydrates and live-syncs per project.',{build:BUILD});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})(window);
