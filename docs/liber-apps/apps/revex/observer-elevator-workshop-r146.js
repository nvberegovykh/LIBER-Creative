/* REVEX elevator isolated workshop r148
 * Sequential proving lane for the elevator family. Each state is a detached RFA
 * artifact; none of these candidates is loaded back into the active project.
 */
(function(root){
'use strict';
if(root.RevexElevatorWorkshop?.version==='20260915r148-workshop3')return;

const VERSION='20260915r148-workshop3';
const pending=new Map();
const clean=v=>String(v??'').trim();
const clone=v=>{try{return structuredClone(v)}catch(_){try{return JSON.parse(JSON.stringify(v))}catch(__){return null}}};
const requestId=()=>`elevator-workshop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const observer=()=>root.RevexObserver||null;
const elevator=()=>root.RevexObserverElevator||null;
const native=()=>root.chrome?.webview||null;

function receive(event){
  const payload=event?.data;
  if(!payload||payload.type!=='liber:revex-observer-elevator-workshop-result-r146')return;
  const item=pending.get(clean(payload.requestId));
  if(!item)return;
  clearTimeout(item.timer);pending.delete(clean(payload.requestId));
  if(!payload.ok){item.reject(new Error(payload.message||'Elevator workshop transition failed.'));return;}
  item.resolve(payload.result);
}
if(native()?.addEventListener)native().addEventListener('message',receive);

function execute(payload){
  const bridge=native();
  if(!bridge?.postMessage)return Promise.reject(new Error('Native REVEX workshop bridge is unavailable.'));
  const id=requestId();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Elevator workshop transition timed out.'));},120000);
    pending.set(id,{resolve,reject,timer});
    bridge.postMessage({
      type:'liber:revex-observer-elevator-workshop-r146',
      requestId:id,
      ...payload
    });
  });
}

function context(input={}){
  const O=observer();
  const focus=input.focus||O?.getFocus?.(input.focusId)||null;
  const focusId=clean(input.focusId||focus?.focusId);
  const elementId=Number(input.elementId||focus?.scope?.elementIds?.[0]);
  const plan=input.plan||input.analysis?.geometricPlan||focus?.candidate?.analysis?.geometricPlan||null;
  return {focus,focusId,elementId,plan};
}

function geometryPayload(plan,sourceCandidatePath,includeCabLeft=false){
  const aperture=plan?.targetAperture||null;
  const proposed=plan?.proposed||null;
  if(!sourceCandidatePath)throw new Error('Workshop transition requires a verified source candidate path.');
  if(!aperture?.elementId)throw new Error('Workshop transition requires the proven existing aperture element.');
  if(!Array.isArray(aperture.outwardNormal)||!Array.isArray(aperture.viewerRight))throw new Error('Workshop transition requires the proven face basis.');
  if(!Number.isFinite(Number(proposed?.clearLeftU))||!Number.isFinite(Number(proposed?.clearRightU))||!Number.isFinite(Number(proposed?.doorHeightFt)))
    throw new Error('Workshop transition requires measured clear-opening coordinates and door height.');
  const payload={
    internalElementId:Number(aperture.elementId),
    sourceCandidatePath,
    planeAxis:aperture.planeAxis,
    planeCoordFt:Number(aperture.planeCoordFt),
    outwardNormal:clone(aperture.outwardNormal),
    viewerRight:clone(aperture.viewerRight),
    clearLeftUFt:Number(proposed.clearLeftU),
    clearRightUFt:Number(proposed.clearRightU),
    doorHeightFt:Number(proposed.doorHeightFt)
  };
  if(includeCabLeft){
    if(!Number.isFinite(Number(proposed?.cabLeftU)))throw new Error('Single-panel proof requires the measured cab-left pocket boundary.');
    payload.cabLeftUFt=Number(proposed.cabLeftU);
  }
  return payload;
}

function recordPass(O,focusId,state,label,result,extra={}){
  O.recordStep(focusId,{
    state,label,result:'PASS',
    evidence:{
      baselinePath:result.baselinePath,
      candidatePath:result.candidatePath,
      baselineSha256:result.baselineSha256,
      candidateSha256:result.candidateSha256,
      deletedElementIds:clone(result.deletedElementIds),
      addedElementIds:clone(result.addedElementIds),
      before:clone(result.before),after:clone(result.after),evidence:clone(result.evidence),
      ...clone(extra)
    }
  });
}

async function runS3(input={}){
  const O=observer();
  if(!O)throw new Error('REVEX Observer API is not loaded.');
  const {focusId,elementId,plan}=context(input);
  if(!focusId)throw new Error('S3 requires an Observer focusId.');
  if(!Number.isFinite(elementId)||elementId<=0)throw new Error('S3 requires the selected project elevator elementId.');
  if(plan?.status!=='READY_FOR_OPENING_PREVIEW')throw new Error(`S3 blocked by plan status: ${plan?.status||'missing'}.`);
  const glass=[...(plan?.glassCandidateIds||[])].map(Number).filter(x=>Number.isFinite(x)&&x>0);
  if(glass.length!==1)throw new Error(`S3 requires exactly one proven rear-glass filler; observed ${glass.length}.`);

  O.recordStep(focusId,{state:'S2',label:'workshop-baseline-requested',result:'OBSERVED',evidence:{strategy:plan.strategy,aperture:clone(plan.targetAperture),glassElementId:glass[0]}});

  let result;
  try{
    result=await execute({focusId,elementId,internalElementId:glass[0],action:'retire-rear-glass'});
  }catch(error){
    O.recordStep(focusId,{state:'S2',label:'workshop-retire-rear-glass',result:'FAILED',evidence:{message:error.message}});
    throw error;
  }

  O.updateFocus(focusId,{
    state:'S3',
    candidate:{kind:'isolated-rfa-workshop',strategy:plan.strategy,baselinePath:result.baselinePath,candidatePath:result.candidatePath,baselineSha256:result.baselineSha256,candidateSha256:result.candidateSha256,retiredInternalElementId:glass[0],next:'S4 infill excess existing aperture while preserving one right-aligned opening'},
    notes:'S3 exists only in the temp workshop family. The active project family was not reloaded or replaced.'
  });
  recordPass(O,focusId,'S3','retire-rear-glass',result);

  const output={focus:O.getFocus(focusId),plan:clone(plan),workshop:clone(result)};
  try{root.dispatchEvent(new CustomEvent('revex:observer-elevator-s3-ready',{detail:clone(output)}));}catch(_){}
  return output;
}

async function runS4(input={}){
  const O=observer();
  if(!O)throw new Error('REVEX Observer API is not loaded.');
  const {focusId,elementId,plan}=context(input);
  const sourceCandidatePath=clean(input.workshop?.candidatePath||input.focus?.candidate?.candidatePath);
  if(!focusId)throw new Error('S4 requires an Observer focusId.');
  if(!Number.isFinite(elementId)||elementId<=0)throw new Error('S4 requires the project elevator elementId.');
  const geometry=geometryPayload(plan,sourceCandidatePath,false);

  O.recordStep(focusId,{state:'S3.1',label:'right-opening-infill-requested',result:'OBSERVED',evidence:clone(geometry)});
  let result;
  try{
    result=await execute({focusId,elementId,action:'infill-right-opening',...geometry});
  }catch(error){
    O.recordStep(focusId,{state:'S3',label:'workshop-infill-right-opening',result:'FAILED',evidence:{message:error.message}});
    throw error;
  }

  O.updateFocus(focusId,{
    state:'S4',
    candidate:{kind:'isolated-rfa-workshop',strategy:plan.strategy,baselinePath:result.baselinePath,candidatePath:result.candidatePath,baselineSha256:result.baselineSha256,candidateSha256:result.candidateSha256,apertureElementId:geometry.internalElementId,addedInfillElementIds:clone(result.addedElementIds),next:'S5 add right-aligned entrance frame against the surviving opening'},
    notes:'S4 is still an isolated workshop RFA. The active Revit project remains untouched.'
  });
  recordPass(O,focusId,'S4','infill-right-opening',result);

  const output={focus:O.getFocus(focusId),plan:clone(plan),workshop:clone(result),previous:clone(input.workshop)};
  try{root.dispatchEvent(new CustomEvent('revex:observer-elevator-s4-ready',{detail:clone(output)}));}catch(_){}
  return output;
}

async function runS5(input={}){
  const O=observer();
  if(!O)throw new Error('REVEX Observer API is not loaded.');
  const {focusId,elementId,plan}=context(input);
  const sourceCandidatePath=clean(input.workshop?.candidatePath||input.focus?.candidate?.candidatePath);
  if(!focusId)throw new Error('S5 requires an Observer focusId.');
  if(!Number.isFinite(elementId)||elementId<=0)throw new Error('S5 requires the project elevator elementId.');
  const geometry=geometryPayload(plan,sourceCandidatePath,false);

  O.recordStep(focusId,{state:'S4.1',label:'right-frame-requested',result:'OBSERVED',evidence:clone(geometry)});
  let result;
  try{
    result=await execute({focusId,elementId,action:'build-right-frame',...geometry});
  }catch(error){
    O.recordStep(focusId,{state:'S4',label:'workshop-build-right-frame',result:'FAILED',evidence:{message:error.message}});
    throw error;
  }

  O.updateFocus(focusId,{
    state:'S5',
    candidate:{kind:'isolated-rfa-workshop',strategy:plan.strategy,baselinePath:result.baselinePath,candidatePath:result.candidatePath,baselineSha256:result.baselineSha256,candidateSha256:result.candidateSha256,frameElementIds:clone(result.addedElementIds),next:'S6 add one car panel and prove its full left-pocket retreat'},
    notes:'S5 creates only the three-piece right-side frame in the isolated candidate.'
  });
  recordPass(O,focusId,'S5','build-right-frame',result);

  const output={focus:O.getFocus(focusId),plan:clone(plan),workshop:clone(result),previous:clone(input.workshop)};
  try{root.dispatchEvent(new CustomEvent('revex:observer-elevator-s5-ready',{detail:clone(output)}));}catch(_){}
  return output;
}

async function runS6(input={}){
  const O=observer();
  if(!O)throw new Error('REVEX Observer API is not loaded.');
  const {focusId,elementId,plan}=context(input);
  const sourceCandidatePath=clean(input.workshop?.candidatePath||input.focus?.candidate?.candidatePath);
  if(!focusId)throw new Error('S6 requires an Observer focusId.');
  if(!Number.isFinite(elementId)||elementId<=0)throw new Error('S6 requires the project elevator elementId.');
  const geometry=geometryPayload(plan,sourceCandidatePath,true);

  O.recordStep(focusId,{state:'S5.1',label:'single-car-panel-requested',result:'OBSERVED',evidence:clone(geometry)});
  let result;
  try{
    result=await execute({focusId,elementId,action:'build-single-car-panel',...geometry});
  }catch(error){
    O.recordStep(focusId,{state:'S5',label:'workshop-build-single-car-panel',result:'FAILED',evidence:{message:error.message}});
    throw error;
  }

  O.updateFocus(focusId,{
    state:'S6',
    candidate:{kind:'isolated-rfa-workshop',strategy:plan.strategy,baselinePath:result.baselinePath,candidatePath:result.candidatePath,baselineSha256:result.baselineSha256,candidateSha256:result.candidateSha256,carPanelElementIds:clone(result.addedElementIds),next:'S7 derive one landing-side panel per stop from the same measured opening'},
    notes:'S6 contains one car panel only. Native workshop evidence proves its closed geometry and the left-pocket retreat envelope before any landing panel is added.'
  });
  recordPass(O,focusId,'S6','build-single-car-panel',result,{cabLeftUFt:geometry.cabLeftUFt});

  const output={focus:O.getFocus(focusId),plan:clone(plan),workshop:clone(result),previous:clone(input.workshop)};
  try{root.dispatchEvent(new CustomEvent('revex:observer-elevator-s6-ready',{detail:clone(output)}));}catch(_){}
  return output;
}

async function proveS3(options={}){
  const E=elevator();
  if(!E)throw new Error('REVEX elevator Observer planner is not loaded.');
  const observed=await E.start(options);
  return runS3(observed);
}
async function proveS4(options={}){const observed=await proveS3(options);return runS4(observed);}
async function proveS5(options={}){const s4=await proveS4(options);return runS5(s4);}
async function proveS6(options={}){const s5=await proveS5(options);return runS6(s5);}

root.RevexElevatorWorkshop=Object.freeze({version:VERSION,runS3,runS4,runS5,runS6,proveS3,proveS4,proveS5,proveS6});
try{root.__revexBrowserDiagnostics?.emit?.('INFO','ELEVATOR_WORKSHOP_READY','Isolated elevator workshop r148 ready through S6',{initiator:'observer-elevator-workshop-r146'});}catch(_){}
})(window);
