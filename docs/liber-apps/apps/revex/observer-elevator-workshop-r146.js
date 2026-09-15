/* REVEX elevator isolated workshop r146
 * Develops the elevator and Observer together without loading a candidate family
 * back into the active Revit project. The first bounded transition retires only
 * the proven rear glass filler in a detached temp family copy.
 */
(function(root){
'use strict';
if(root.RevexElevatorWorkshop?.version==='20260915r146-workshop1')return;

const VERSION='20260915r146-workshop1';
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
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Elevator workshop transition timed out.'));},90000);
    pending.set(id,{resolve,reject,timer});
    bridge.postMessage({
      type:'liber:revex-observer-elevator-workshop-r146',
      requestId:id,
      ...payload
    });
  });
}

async function runS3(input={}){
  const O=observer();
  if(!O)throw new Error('REVEX Observer API is not loaded.');
  const focusId=clean(input.focusId||input.focus?.focusId);
  const elementId=Number(input.elementId||input.focus?.scope?.elementIds?.[0]);
  const plan=input.plan||input.analysis?.geometricPlan||input.focus?.candidate?.analysis?.geometricPlan||null;
  if(!focusId)throw new Error('S3 requires an Observer focusId.');
  if(!Number.isFinite(elementId)||elementId<=0)throw new Error('S3 requires the selected project elevator elementId.');
  if(plan?.status!=='READY_FOR_OPENING_PREVIEW')throw new Error(`S3 blocked by plan status: ${plan?.status||'missing'}.`);
  const glass=[...(plan?.glassCandidateIds||[])].map(Number).filter(x=>Number.isFinite(x)&&x>0);
  if(glass.length!==1)throw new Error(`S3 requires exactly one proven rear-glass filler; observed ${glass.length}.`);

  O.recordStep(focusId,{
    state:'S2',label:'workshop-baseline-requested',result:'OBSERVED',
    evidence:{strategy:plan.strategy,aperture:clone(plan.targetAperture),glassElementId:glass[0]}
  });

  let result;
  try{
    result=await execute({
      focusId,
      elementId,
      internalElementId:glass[0],
      action:'retire-rear-glass'
    });
  }catch(error){
    O.recordStep(focusId,{state:'S2',label:'workshop-retire-rear-glass',result:'FAILED',evidence:{message:error.message}});
    throw error;
  }

  O.updateFocus(focusId,{
    state:'S3',
    candidate:{
      kind:'isolated-rfa-workshop',
      strategy:plan.strategy,
      baselinePath:result.baselinePath,
      candidatePath:result.candidatePath,
      baselineSha256:result.baselineSha256,
      candidateSha256:result.candidateSha256,
      retiredInternalElementId:glass[0],
      next:'S4 infill excess existing aperture while preserving one right-aligned opening'
    },
    notes:'S3 exists only in the temp workshop family. The active project family was not reloaded or replaced.'
  });
  O.recordStep(focusId,{
    state:'S3',label:'retire-rear-glass',result:'PASS',
    evidence:{
      baselinePath:result.baselinePath,
      candidatePath:result.candidatePath,
      baselineSha256:result.baselineSha256,
      candidateSha256:result.candidateSha256,
      deletedElementIds:clone(result.deletedElementIds),
      before:clone(result.before),after:clone(result.after),evidence:clone(result.evidence)
    }
  });

  const output={focus:O.getFocus(focusId),plan:clone(plan),workshop:clone(result)};
  try{root.dispatchEvent(new CustomEvent('revex:observer-elevator-s3-ready',{detail:clone(output)}));}catch(_){}
  return output;
}

async function proveS3(options={}){
  const E=elevator();
  if(!E)throw new Error('REVEX elevator Observer planner is not loaded.');
  const observed=await E.start(options);
  return runS3(observed);
}

root.RevexElevatorWorkshop=Object.freeze({version:VERSION,runS3,proveS3});
try{root.__revexBrowserDiagnostics?.emit?.('INFO','ELEVATOR_WORKSHOP_READY','Isolated elevator workshop r146 ready',{initiator:'observer-elevator-workshop-r146'});}catch(_){}
})(window);
