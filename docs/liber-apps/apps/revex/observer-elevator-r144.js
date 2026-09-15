/* REVEX Observer elevator lab r144
 * First real Observer focus: a single right-aligned sliding elevator entrance.
 * Uses the current RVX/project selection plus a read-only native family inspection.
 * No model mutation is performed here.
 */
(function(root){
'use strict';
if(root.RevexObserverElevator?.version==='20260915r144-elevator1')return;

const VERSION='20260915r144-elevator1';
const pending=new Map();
const clean=v=>String(v??'').trim();
const observer=()=>root.RevexObserver||null;
const native=()=>root.chrome?.webview||null;
const id=()=>`elevator-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const clone=v=>{try{return structuredClone(v)}catch(_){try{return JSON.parse(JSON.stringify(v))}catch(__){return null}}};

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
  return {
    schema:'liber.revex.observer.elevator-analysis.v1',
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
    target:{
      entranceCount:1,
      alignment:'right edge of cab when viewed from landing side',
      panelCount:1,
      slideDirection:'left into remaining cab-wall pocket',
      preserve:['primary host identity','cab extents except required opening','rails and guides','stop elevations','existing project identity']
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
      'cab extents except the required entrance opening',
      'rails and wheel guides',
      'stop elevations',
      'existing family parameter semantics unless a later state explicitly replaces them'
    ],
    expectedDelta:{
      entranceCount:1,
      panelCount:1,
      alignment:'right',
      slideDirection:'left',
      hostMutation:false
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
  O.updateFocus(focus.focusId,{
    state:'S1',
    candidate:{kind:'family-inspection',elementId,analysis},
    notes:'Deep native family graph captured read-only through Document.EditFamily; no transaction and no save.'
  });
  O.recordStep(focus.focusId,{
    state:'S1',label:'deep-family-graph',result:'PASS',
    evidence:{analysis,instance:inspection.instance,familyDocumentTitle:inspection.familyDocumentTitle}
  });

  const preview=O.preview({
    focusId:focus.focusId,
    operation:'elevator.plan-single-right',
    targets:[String(elementId)],
    protectedInvariants:focus.protected
  });

  const output={focus:O.getFocus(focus.focusId),inspection,analysis,preview};
  try{root.dispatchEvent(new CustomEvent('revex:observer-elevator-ready',{detail:clone(output)}));}catch(_){}
  return output;
}

function analyze(result){return summarizeInspection(result);}

root.RevexObserverElevator=Object.freeze({version:VERSION,start,inspectFamily,analyze});
try{root.__revexBrowserDiagnostics?.emit?.('INFO','OBSERVER_ELEVATOR_READY','Elevator Observer lab ready',{initiator:'observer-elevator-r144'});}catch(_){}
})(window);
