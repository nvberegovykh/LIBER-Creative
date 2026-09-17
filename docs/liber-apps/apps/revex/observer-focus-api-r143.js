/* REVEX Observer / Focus API r143
 * Thin read-only projection over the current REVEX runtime owner.
 * No second viewer, no RVX reparsing, no direct Firestore lane, no Revit mutation.
 * Hidden focus workspaces are references + journals attached to the current project/revision.
 */
(function(root){
'use strict';
if(root.RevexObserver?.version==='20260915r143-focus1')return;

const VERSION='20260915r143-focus1';
const KEY='liber.revex.observer.focus.v1';
const MAX_FOCUS=64;
const MAX_EVENTS=256;
const now=()=>new Date().toISOString();
const clean=v=>String(v??'').trim();
const state=()=>root.__revexState||{};
const viewer=()=>root.__revexViewerR26Instance||root.__revexViewerR25Instance||root.__revexViewerR24Instance||root.__revexViewerR23Instance||null;
const store=()=>root.RevexStore||null;

function clone(value){
  if(value==null)return value;
  try{return structuredClone(value);}catch(_){try{return JSON.parse(JSON.stringify(value));}catch(__){return null;}}
}
function diag(level,stage,message,detail={}){
  try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'REVEX Observer r143',...detail});}catch(_){}
}
function projectIdentity(){
  const s=state();
  const project=s.project||s.currentProject||null;
  const projectId=clean(s.projectId||s.currentProjectId||project?.id||project?.projectId||'');
  const revision=clean(s.revision||s.currentRevision||s.viewerData?.revision||s.viewerData?.rev||project?.revision||'');
  return {projectId,revision,project:clone(project)};
}
function selectedIdentity(){
  const s=state(),v=viewer();
  const row=s.selectedBimObject||s.selectedElement||s.selection||v?.selectedRecord||v?.selected||null;
  if(!row)return null;
  return clone({
    elementId:row.elementId??row.id??row.revitElementId??null,
    uniqueId:row.uniqueId??row.revitUniqueId??null,
    category:row.category??null,
    family:row.family??row.familyName??null,
    type:row.type??row.typeName??null,
    name:row.name??null
  });
}
function sourceRows(){
  const s=state(),v=viewer();
  const candidates=[
    s.viewerData?.elements,s.viewerData?.rows,s.bimElements,s.elements,
    v?.records,v?.elements,v?.rows,v?.sourceState?.elements,v?.sourceState?.rows
  ];
  for(const c of candidates){
    if(Array.isArray(c))return c;
    if(c instanceof Map)return [...c.values()];
    if(c&&typeof c==='object'&&!Array.isArray(c)){
      const vals=Object.values(c);
      if(vals.length&&typeof vals[0]==='object')return vals;
    }
  }
  return [];
}
function rowIdentity(row){
  return clean(row?.uniqueId||row?.revitUniqueId||row?.elementId||row?.revitElementId||row?.id||'');
}
function matchRow(row,id){
  const q=clean(id);
  if(!q)return false;
  return [row?.uniqueId,row?.revitUniqueId,row?.elementId,row?.revitElementId,row?.id].some(v=>clean(v)===q);
}
function normalizeRow(row){
  if(!row)return null;
  const fields=['id','elementId','revitElementId','uniqueId','revitUniqueId','category','family','familyName','type','typeName','name','material','materials','bbox','bounds','transform','level','hostId','hostUniqueId','parentId','children','parameters','visible'];
  const out={};
  for(const k of fields)if(row[k]!==undefined)out[k]=clone(row[k]);
  out.identity=rowIdentity(row);
  return out;
}
function loadFocusMap(){
  try{return JSON.parse(localStorage.getItem(KEY)||'{}')||{};}catch(_){return {};}
}
function saveFocusMap(map){
  const entries=Object.entries(map).sort((a,b)=>String(b[1]?.updatedAt||'').localeCompare(String(a[1]?.updatedAt||''))).slice(0,MAX_FOCUS);
  const next=Object.fromEntries(entries);
  localStorage.setItem(KEY,JSON.stringify(next));
  return next;
}
function assertProject(focus){
  const p=projectIdentity();
  if(focus.projectId&&p.projectId&&focus.projectId!==p.projectId)throw new Error(`Observer focus ${focus.focusId} belongs to ${focus.projectId}, but current project is ${p.projectId}.`);
  return p;
}
function focusId(spec={}){
  const base=clean(spec.focusId||spec.name||spec.target||'focus').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'focus';
  return `${base}.${Date.now().toString(36)}`;
}
function pushEvent(focus,event){
  focus.events=Array.isArray(focus.events)?focus.events:[];
  focus.events.push({at:now(),...clone(event)});
  if(focus.events.length>MAX_EVENTS)focus.events=focus.events.slice(-MAX_EVENTS);
  focus.updatedAt=now();
  return focus;
}
function snapshot(){
  const s=state(),v=viewer(),p=projectIdentity();
  const runtimeOwners={
    viewer:v?{present:true,version:v.version||v.build||null,constructor:v.constructor?.name||null}: {present:false},
    store:!!store(),
    nativeRevit:!!(root.chrome?.webview||s.nativeRevitAvailable||s.revitAvailable)
  };
  return clone({
    schema:'liber.revex.observer.snapshot.v1',version:VERSION,at:now(),
    projectId:p.projectId,revision:p.revision,activeView:s.activeView||s.viewName||s.viewerData?.source?.viewName||null,
    selected:selectedIdentity(),viewerMode:s.viewerMode||s.bimMode||null,
    sectionBox:s.sectionBox||v?.sectionBox||null,camera:s.camera||v?.cameraState||null,
    runtimeOwners,diagnostics:s.browserDiagnostics?.slice?.(-20)||null
  });
}
function getElement(id){
  const rows=sourceRows();
  const row=rows.find(r=>matchRow(r,id));
  return normalizeRow(row);
}
function query(filter={}){
  const rows=sourceRows();
  const ids=new Set((filter.ids||[]).map(clean));
  const q=clean(filter.text).toLowerCase();
  const category=clean(filter.category).toLowerCase();
  const family=clean(filter.family).toLowerCase();
  const type=clean(filter.type).toLowerCase();
  const limit=Math.max(1,Math.min(Number(filter.limit)||200,2000));
  const out=[];
  for(const row of rows){
    if(ids.size&&![[row?.uniqueId,row?.revitUniqueId,row?.elementId,row?.revitElementId,row?.id].map(clean)].flat().some(x=>ids.has(x)))continue;
    if(category&&!clean(row?.category).toLowerCase().includes(category))continue;
    if(family&&!clean(row?.family||row?.familyName).toLowerCase().includes(family))continue;
    if(type&&!clean(row?.type||row?.typeName).toLowerCase().includes(type))continue;
    if(q){const hay=[row?.name,row?.category,row?.family,row?.familyName,row?.type,row?.typeName,row?.uniqueId,row?.elementId,row?.id].map(clean).join(' ').toLowerCase();if(!hay.includes(q))continue;}
    out.push(normalizeRow(row));
    if(out.length>=limit)break;
  }
  return out;
}
function graph(id,depth=1){
  const rows=sourceRows();
  const byIdentity=new Map();
  for(const row of rows){for(const key of [row?.uniqueId,row?.revitUniqueId,row?.elementId,row?.revitElementId,row?.id].map(clean).filter(Boolean))byIdentity.set(key,row);}
  const start=byIdentity.get(clean(id));
  if(!start)return null;
  const seen=new Set(),nodes=[],edges=[],queue=[{row:start,d:0}];
  function rels(row){
    const out=[];
    const push=(kind,v)=>{if(v==null)return;if(Array.isArray(v))v.forEach(x=>push(kind,x));else{const k=clean(typeof v==='object'?(v.uniqueId||v.elementId||v.id):v);if(k)out.push([kind,k]);}};
    push('host',row.hostId||row.hostUniqueId||row.host);
    push('parent',row.parentId||row.parentUniqueId||row.parent);
    push('child',row.children||row.childIds);
    push('dependency',row.dependencies||row.dependentIds||row.references);
    return out;
  }
  while(queue.length){
    const {row,d}=queue.shift();const rid=rowIdentity(row);if(!rid||seen.has(rid))continue;seen.add(rid);nodes.push(normalizeRow(row));
    if(d>=depth)continue;
    for(const [kind,target] of rels(row)){edges.push({from:rid,to:target,kind});const next=byIdentity.get(target);if(next&&!seen.has(rowIdentity(next)))queue.push({row:next,d:d+1});}
  }
  return {schema:'liber.revex.observer.graph.v1',root:rowIdentity(start),depth,nodes,edges};
}
function createFocus(spec={}){
  const p=projectIdentity();
  if(!p.projectId)throw new Error('No active REVEX project.');
  const map=loadFocusMap(),id=focusId(spec);
  const focus={
    schema:'liber.revex.observer.focus.v1',focusId:id,projectId:p.projectId,baseRevision:p.revision||null,
    name:clean(spec.name||spec.target||id),target:clean(spec.target||''),temporary:spec.temporary!==false,hidden:true,
    scope:clone(spec.scope||{elementIds:[],stableFaceRefs:[]}),protected:clone(spec.protected||[]),expectedDelta:clone(spec.expectedDelta||null),
    status:'ACTIVE',state:'S0',createdAt:now(),updatedAt:now(),events:[]
  };
  pushEvent(focus,{phase:'CREATE',snapshot:snapshot()});map[id]=focus;saveFocusMap(map);
  root.dispatchEvent?.(new CustomEvent('revex:observer-focus-created',{detail:clone(focus)}));
  return clone(focus);
}
function getFocus(id){const f=loadFocusMap()[clean(id)]||null;if(f)assertProject(f);return clone(f);}
function listFocus(){const p=projectIdentity();return Object.values(loadFocusMap()).filter(f=>!p.projectId||f.projectId===p.projectId).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))).map(clone);}
function updateFocus(id,patch={}){
  const map=loadFocusMap(),key=clean(id),f=map[key];if(!f)throw new Error(`Unknown observer focus: ${key}`);assertProject(f);
  for(const k of ['name','target','scope','protected','expectedDelta','state','status','candidate','notes'])if(patch[k]!==undefined)f[k]=clone(patch[k]);
  pushEvent(f,{phase:'UPDATE',patch:clone(patch),snapshot:patch.captureSnapshot?snapshot():undefined});map[key]=f;saveFocusMap(map);
  root.dispatchEvent?.(new CustomEvent('revex:observer-focus-changed',{detail:clone(f)}));return clone(f);
}
function recordStep(id,step={}){
  const map=loadFocusMap(),key=clean(id),f=map[key];if(!f)throw new Error(`Unknown observer focus: ${key}`);assertProject(f);
  const p=projectIdentity();
  const event={phase:'STEP',state:clean(step.state||f.state||''),label:clean(step.label||''),result:clean(step.result||'OBSERVED'),baseRevision:f.baseRevision,currentRevision:p.revision||null,expectedDelta:clone(step.expectedDelta||null),observedDelta:clone(step.observedDelta||null),evidence:clone(step.evidence||null),snapshot:step.captureSnapshot===false?undefined:snapshot()};
  if(step.state)f.state=clean(step.state);if(step.status)f.status=clean(step.status);pushEvent(f,event);map[key]=f;saveFocusMap(map);return clone(event);
}
function closeFocus(id,status='CLOSED'){
  const map=loadFocusMap(),key=clean(id),f=map[key];if(!f)return null;assertProject(f);f.status=clean(status)||'CLOSED';pushEvent(f,{phase:'CLOSE',status:f.status,snapshot:snapshot()});map[key]=f;saveFocusMap(map);return clone(f);
}
function select(ids){
  const list=(Array.isArray(ids)?ids:[ids]).map(clean).filter(Boolean);const v=viewer();
  if(v?.selectByIds)return v.selectByIds(list);
  if(v?.selectElements)return v.selectElements(list);
  if(v?.setSelection)return v.setSelection(list);
  try{root.dispatchEvent(new CustomEvent('revex:observer-select',{detail:{ids:list}}));}catch(_){}
  return {requested:list,delegated:false};
}
function preview(operation={}){
  const snap=snapshot();
  const focus=operation.focusId?getFocus(operation.focusId):null;
  const expectedRevision=clean(operation.expectedRevision||focus?.baseRevision||'');
  const currentRevision=clean(snap.revision||'');
  const reasons=[];
  if(expectedRevision&&currentRevision&&expectedRevision!==currentRevision)reasons.push(`Revision changed: expected ${expectedRevision}, current ${currentRevision}.`);
  if(focus&&focus.status!=='ACTIVE')reasons.push(`Focus ${focus.focusId} is ${focus.status}.`);
  const targets=(operation.targets||focus?.scope?.elementIds||[]).map(clean).filter(Boolean);
  const resolved=targets.map(id=>getElement(id)).filter(Boolean);
  return clone({schema:'liber.revex.observer.preview.v1',at:now(),focusId:focus?.focusId||null,operation:clean(operation.operation||operation.kind||''),expectedRevision:expectedRevision||null,currentRevision:currentRevision||null,targets,resolvedTargets:resolved,protectedInvariants:clone(operation.protectedInvariants||focus?.protected||[]),canProceed:reasons.length===0,reasons,mutationAvailable:false,note:'Read-only Observer r143: execution requires a separately registered bounded native fixer adapter.'});
}

const api={version:VERSION,snapshot,getElement,query,graph,getSelection:selectedIdentity,select,createFocus,getFocus,listFocus,updateFocus,recordStep,closeFocus,preview};
root.RevexObserver=Object.freeze(api);
diag('info','OBSERVER_READY','Observer / Focus API ready',{version:VERSION});
try{root.dispatchEvent(new CustomEvent('revex:observer-ready',{detail:{version:VERSION}}));}catch(_){}
})(window);
