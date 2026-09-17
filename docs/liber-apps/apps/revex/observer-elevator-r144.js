/* REVEX Observer elevator lab r145
 * First real Observer focus: a single right-aligned sliding elevator entrance.
 * Uses the current RVX/project selection plus a read-only native family inspection.
 * No model mutation is performed here.
 */
(function(root){
'use strict';
if(root.RevexObserverElevator?.version==='20260915r145-elevator-plan1')return;

const VERSION='20260915r145-elevator-plan1';
const pending=new Map();
const clean=v=>String(v??'').trim();
const observer=()=>root.RevexObserver||null;
const native=()=>root.chrome?.webview||null;
const id=()=>`elevator-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const clone=v=>{try{return structuredClone(v)}catch(_){try{return JSON.parse(JSON.stringify(v))}catch(__){return null}}};
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const inches=ft=>Number.isFinite(ft)?Math.round(ft*12*1000)/1000:null;

function selectedElementId(){
  const row=observer()?.getSelection?.();
  const value=row?.elementId??row?.revitElementId??row?.id??null;
  const number=Number(value);
  return Number.isFinite(number)&&number>0?number:null;
}

function textOf(node){
  return [node?.name,node?.class,node?.kind,node?.category,
    ...Object.keys(node?.parameters||{}),...Object.values(node?.parameters||{}),
    ...Object.keys(node?.associations||{}),...Object.values(node?.associations||{})]
    .map(clean).join(' ').toLowerCase();
}

function bbox(node){
  const a=node?.bboxMinFt,b=node?.bboxMaxFt;
  if(!Array.isArray(a)||!Array.isArray(b)||a.length<3||b.length<3)return null;
  const min=a.map(Number),max=b.map(Number);
  if([...min,...max].some(v=>!Number.isFinite(v)))return null;
  return {min,max,dx:max[0]-min[0],dy:max[1]-min[1],dz:max[2]-min[2],cx:(min[0]+max[0])/2,cy:(min[1]+max[1])/2,cz:(min[2]+max[2])/2};
}

function familyParam(result,name){
  const row=(result?.familyParameters||[]).find(p=>clean(p?.name).toLowerCase()===clean(name).toLowerCase());
  return row?num(row.value):null;
}

function largest(rows,score){
  return rows.reduce((best,row)=>!best||score(row)>score(best)?row:best,null);
}

function deriveSingleRightPlan(result){
  const nodes=Array.isArray(result?.nodes)?result.nodes:[];
  const forms=nodes.filter(n=>n.kind==='generic-form'&&bbox(n));
  const solids=forms.filter(n=>clean(n?.parameters?.IsSolid).toLowerCase()==='true');
  const voids=forms.filter(n=>clean(n?.parameters?.IsSolid).toLowerCase()==='false');

  const cabCandidates=solids.filter(n=>{
    const b=bbox(n),t=textOf(n);
    return /elevator car|cab|car/.test(t)&&b.dx>3&&b.dy>3&&b.dz>6;
  });
  const cab=largest(cabCandidates,n=>{const b=bbox(n);return b.dx*b.dy*b.dz;});
  if(!cab)return {status:'WAITING_EVIDENCE',reason:'Could not identify the native cab body from the family graph.'};
  const cb=bbox(cab);

  // The existing panoramic opposite-side aperture is the safest target: it is
  // already a thin, door-height void at a cab boundary. Prefer reusing it over
  // cutting a second hole into the cab.
  const apertureCandidates=voids.filter(n=>{
    const b=bbox(n);
    const thin=Math.min(b.dx,b.dy);
    const broad=Math.max(b.dx,b.dy);
    return thin>0&&thin<=0.20&&broad>=3&&b.dz>=6&&b.dz<=9;
  }).map(n=>{
    const b=bbox(n);
    const distances=[
      {axis:'x',side:'min',d:Math.abs(b.cx-cb.min[0])},
      {axis:'x',side:'max',d:Math.abs(b.cx-cb.max[0])},
      {axis:'y',side:'min',d:Math.abs(b.cy-cb.min[1])},
      {axis:'y',side:'max',d:Math.abs(b.cy-cb.max[1])}
    ].sort((a,b)=>a.d-b.d);
    return {node:n,box:b,boundary:distances[0]};
  }).filter(x=>x.boundary.d<=0.30);
  const aperture=largest(apertureCandidates,x=>Math.max(x.box.dx,x.box.dy)*x.box.dz);
  if(!aperture)return {status:'WAITING_EVIDENCE',reason:'No reusable thin opposite-side cab aperture was proven.'};

  let normal;
  if(aperture.boundary.axis==='x')normal=[aperture.boundary.side==='max'?1:-1,0,0];
  else normal=[0,aperture.boundary.side==='max'?1:-1,0];
  // Viewer-right while standing outside the face and looking into the cab.
  const right=[-normal[1],normal[0],0];
  const dot=(x,y)=>x[0]*y[0]+x[1]*y[1]+x[2]*y[2];
  const cabCorners=[
    [cb.min[0],cb.min[1],0],[cb.min[0],cb.max[1],0],
    [cb.max[0],cb.min[1],0],[cb.max[0],cb.max[1],0]
  ];
  const us=cabCorners.map(p=>dot(p,right));
  const cabLeftU=Math.min(...us),cabRightU=Math.max(...us);

  const clear=familyParam(result,'Clear Opening');
  const frame=familyParam(result,'Frame Width');
  const doorHeight=familyParam(result,'_Elevator Door Height');
  if(!(clear>0)||!(frame>0)||!(doorHeight>0))return {status:'WAITING_EVIDENCE',reason:'Clear Opening, Frame Width, or Door Height is unresolved.'};

  const rightOuterU=cabRightU;
  const clearRightU=rightOuterU-frame;
  const clearLeftU=clearRightU-clear;
  const leftOuterU=clearLeftU-frame;
  const pocketAvailable=leftOuterU-cabLeftU;
  const minimumPanelWidth=clear;
  const pocketMargin=pocketAvailable-minimumPanelWidth;

  const planeCoord=aperture.boundary.axis==='x'
    ? (aperture.boundary.side==='max'?cb.max[0]:cb.min[0])
    : (aperture.boundary.side==='max'?cb.max[1]:cb.min[1]);

  const existingApertureWidth=aperture.boundary.axis==='x'?aperture.box.dy:aperture.box.dx;
  const existingGlass=solids.filter(n=>{
    const b=bbox(n),t=textOf(n);
    if(!/glass/.test(t))return false;
    const nearPlane=aperture.boundary.axis==='x'?Math.abs(b.cx-planeCoord):Math.abs(b.cy-planeCoord);
    const overlapZ=Math.min(b.max[2],aperture.box.max[2])-Math.max(b.min[2],aperture.box.min[2]);
    return nearPlane<=0.35&&overlapZ>5;
  });

  return {
    status:pocketMargin>=0?'READY_FOR_OPENING_PREVIEW':'BLOCKED_POCKET',
    strategy:'reuse-existing-opposite-side-panoramic-aperture',
    reason:'The family already contains a large thin door-height void on the opposite cab boundary; reusing it minimizes topology change and leaves the primary host untouched.',
    cab:{elementId:cab.id,bboxMinFt:cb.min,bboxMaxFt:cb.max,widthAlongDoorFt:cabRightU-cabLeftU},
    targetAperture:{elementId:aperture.node.id,bboxMinFt:aperture.box.min,bboxMaxFt:aperture.box.max,widthFt:existingApertureWidth,planeAxis:aperture.boundary.axis,planeSide:aperture.boundary.side,planeCoordFt:planeCoord,outwardNormal:normal,viewerRight:right},
    glassCandidateIds:existingGlass.map(n=>n.id),
    proposed:{
      clearOpeningFt:clear,
      frameWidthFt:frame,
      doorHeightFt:doorHeight,
      cabLeftU,cabRightU,rightOuterU,clearRightU,clearLeftU,leftOuterU,
      pocketAvailableFt:pocketAvailable,
      minimumPanelWidthFt:minimumPanelWidth,
      pocketMarginFt:pocketMargin,
      clearOpeningIn:inches(clear),frameWidthIn:inches(frame),doorHeightIn:inches(doorHeight),
      pocketAvailableIn:inches(pocketAvailable),minimumPanelWidthIn:inches(minimumPanelWidth),pocketMarginIn:inches(pocketMargin)
    },
    sequence:[
      'S2 observe/identify existing rear aperture and glass filler',
      'S3 retire only the rear glass filler; regenerate and observe',
      'S4 add cab-wall infill so the surviving clear opening is right-aligned; regenerate and observe',
      'S5 add right-aligned frame; regenerate and observe',
      'S6 add one sliding car panel sized from measured overlap and pocket; regenerate and observe',
      'S7 add the landing-side single panel per stop; verify stop visibility one stop at a time',
      'S8 add a separate adjacent-project-wall cutter without moving the primary host',
      'S9 retire the original front entrance only after the new side passes project verification'
    ]
  };
}

function summarizeInspection(result){
  const nodes=Array.isArray(result?.nodes)?result.nodes:[];
  const edges=Array.isArray(result?.edges)?result.edges:[];
  const familyParameters=Array.isArray(result?.familyParameters)?result.familyParameters:[];
  const match=(re)=>nodes.filter(n=>re.test(textOf(n)));
  const params=(re)=>familyParameters.filter(p=>re.test(clean(p?.name).toLowerCase()));
  const hostNodes=nodes.filter(n=>n.kind==='wall'||/wall edge|host/.test(textOf(n)));
  const entranceNodes=match(/door|opening|frame|lobby|sill|head/);
  const railNodes=match(/rail|wheel guide/);
  const carNodes=match(/car|cab/);
  const visibilityNodes=match(/visibility for \d+ stops|visible/);
  const openingParams=params(/clear opening|door width|door height|door offset|centerline of opening|frame|car offset/);
  const rightSignals=match(/right/);
  const leftSignals=match(/left/);
  const geometricPlan=deriveSingleRightPlan(result);
  return {
    schema:'liber.revex.observer.elevator-analysis.v2',
    family:{
      name:result?.instance?.family||'',
      type:result?.instance?.type||'',
      placementType:result?.familyPlacementType||result?.instance?.placementType||'',
      category:result?.familyCategory||''
    },
    counts:clone(result?.counts||{}),
    graph:{nodes:nodes.length,edges:edges.length},
    hostNodeIds:hostNodes.map(n=>n.id),
    entranceNodeIds:entranceNodes.map(n=>n.id),
    railNodeIds:railNodes.map(n=>n.id),
    carNodeIds:carNodes.map(n=>n.id),
    visibilityNodeIds:visibilityNodes.map(n=>n.id),
    rightSignalNodeIds:rightSignals.map(n=>n.id),
    leftSignalNodeIds:leftSignals.map(n=>n.id),
    openingParameters:openingParams.map(p=>({name:p.name,value:p.value,formula:p.formula,isInstance:p.isInstance})),
    warnings:clone(result?.warnings||[]),
    geometricPlan,
    target:{
      entranceCount:1,
      alignment:'right edge of cab when viewed from landing side',
      panelCount:1,
      slideDirection:'left into remaining cab-wall pocket',
      preserve:['primary host identity','cab extents except required opening/infill','rails and guides','stop elevations','existing project identity']
    }
  };
}

function inspectFamily(elementId,focusId){
  const bridge=native();
  if(!bridge?.postMessage)return Promise.reject(new Error('Native REVEX Observer bridge is unavailable; open this focus inside the REVEX Revit add-in.'));
  const requestId=id();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Native family inspection timed out.'));},45000);
    pending.set(requestId,{resolve,reject,timer,focusId,elementId});
    bridge.postMessage({
      type:'liber:revex-observer-family-inspect-r144',
      requestId,focusId,elementId
    });
  });
}

function receive(event){
  const payload=event?.data;
  if(!payload||payload.type!=='liber:revex-observer-family-inspection-r144')return;
  const item=pending.get(clean(payload.requestId));
  if(!item)return;
  clearTimeout(item.timer);pending.delete(clean(payload.requestId));
  if(!payload.ok){item.reject(new Error(payload.message||'Native family inspection failed.'));return;}
  item.resolve(payload.result);
}

if(native()?.addEventListener)native().addEventListener('message',receive);

async function start(options={}){
  const O=observer();
  if(!O)throw new Error('REVEX Observer API is not loaded.');
  const elementId=Number(options.elementId||selectedElementId());
  if(!Number.isFinite(elementId)||elementId<=0)throw new Error('Select the elevator family instance in BIM first, or provide elementId.');

  const focus=O.createFocus({
    name:options.name||'elevator.single-right',
    target:'single right-aligned sliding elevator entrance',
    temporary:true,
    scope:{elementIds:[String(elementId)],stableFaceRefs:[]},
    protected:[
      'project identity',
      'primary Revit host identity',
      'cab extents except the required entrance opening/infill',
      'rails and wheel guides',
      'stop elevations',
      'existing family parameter semantics unless a later state explicitly replaces them'
    ],
    expectedDelta:{
      entranceCount:1,
      panelCount:1,
      alignment:'right',
      slideDirection:'left',
      hostMutation:false,
      preferredOpeningStrategy:'reuse-existing-opposite-side-panoramic-aperture'
    }
  });

  O.recordStep(focus.focusId,{
    state:'S0',label:'focus-created',result:'OBSERVED',
    evidence:{selected:O.getSelection?.(),elementId}
  });

  let inspection;
  try{
    inspection=await inspectFamily(elementId,focus.focusId);
  }catch(error){
    O.recordStep(focus.focusId,{state:'S0',label:'native-family-inspection',result:'FAILED',evidence:{message:error.message}});
    throw error;
  }

  const analysis=summarizeInspection(inspection);
  const plan=analysis.geometricPlan;
  O.updateFocus(focus.focusId,{
    state:'S1',
    candidate:{kind:'family-inspection+geometric-plan',elementId,analysis},
    notes:'Deep native family graph captured read-only. Planner prefers reuse of the existing opposite-side panoramic aperture; no transaction and no save.'
  });
  O.recordStep(focus.focusId,{
    state:'S1',label:'deep-family-graph',result:'PASS',
    evidence:{analysis,instance:inspection.instance,familyDocumentTitle:inspection.familyDocumentTitle}
  });
  O.recordStep(focus.focusId,{
    state:'S1.1',label:'single-right-plan',result:plan?.status==='READY_FOR_OPENING_PREVIEW'?'PASS':'WAITING',
    evidence:{plan}
  });

  const preview=O.preview({
    focusId:focus.focusId,
    operation:'elevator.plan-single-right',
    targets:[String(elementId)],
    protectedInvariants:focus.protected
  });

  const output={focus:O.getFocus(focus.focusId),inspection,analysis,plan,preview};
  try{root.dispatchEvent(new CustomEvent('revex:observer-elevator-ready',{detail:clone(output)}));}catch(_){}
  return output;
}

function analyze(result){return summarizeInspection(result);}
function plan(result){return deriveSingleRightPlan(result);}

root.RevexObserverElevator=Object.freeze({version:VERSION,start,inspectFamily,analyze,plan});
try{root.__revexBrowserDiagnostics?.emit?.('INFO','OBSERVER_ELEVATOR_READY','Elevator Observer lab ready',{initiator:'observer-elevator-r145'});}catch(_){}
})(window);
