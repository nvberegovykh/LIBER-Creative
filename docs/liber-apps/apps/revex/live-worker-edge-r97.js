(function(root){
  'use strict';
  const BUILD='20260816r97-live-worker-edge1';
  if(root.__revexLiveWorkerEdgeR97)return;
  root.__revexLiveWorkerEdgeR97={build:BUILD};

  const clean=value=>String(value??'').trim();
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const projectId=()=>clean(root.__revexState?.projectId||new URLSearchParams(location.search).get('projectId'));
  function diagnostic(level,stage,message,detail={}){
    try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'live worker edge r97',...detail});}catch(_){}
  }
  function post(stage,message,ok=false,detail={}){
    const payload={type:'liber:revex-managed-energy-status',build:BUILD,stage,message,ok:Boolean(ok),projectId:clean(detail.projectId||projectId()),revision:clean(detail.revision),...detail};
    try{root.chrome?.webview?.postMessage(payload);}catch(_){}
    try{root.dispatchEvent(new CustomEvent('revex:managed-energy-status',{detail:payload}));}catch(_){}
    const node=document.getElementById('energy-run-status');
    if(node){node.textContent=message;node.dataset.tone=ok?'good':stage==='BROKER_FAILED'?'bad':'busy';}
  }
  async function StoreReady(timeoutMs=30000){
    const started=Date.now();
    while(Date.now()-started<timeoutMs){const Store=root.RevexStore;if(Store?.isCloud?.()&&Store?.user?.uid)return Store;await sleep(100);}
    throw new Error('REVEX cloud session is not ready.');
  }
  async function context(Store){
    const id=projectId();
    if(!id)return null;
    const source=await Store.getEngineeringState(id);
    const revision=clean(source?.revision||source?.manifest?.revision);
    return revision?{id,revision,source}:null;
  }
  async function readJob(Store,id,revision){
    if(!Store?.api?.doc||!Store?.api?.getDoc||!Store?.db)return null;
    const snap=await Store.api.getDoc(Store.api.doc(Store.db,'projects',id,'revexEnergyJobs',revision));
    return snap?.exists?.()?snap.data():null;
  }
  function exactJobError(job,status){
    const stage=clean(job?.stage)||'WORKER_REQUEST';
    const detail=clean(job?.error)||`Energy broker job status is ${status||'UNKNOWN'}.`;
    return `${stage}: ${detail}`;
  }

  // WebView2 can produce synthetic keyboard events without a key. The legacy viewer
  // blindly called toLowerCase() on event.key, which detached unrelated UI behavior.
  // Ignore only malformed key-less events before they reach the viewer; normal keyboard
  // navigation is untouched.
  function installKeyboardGuard(){
    if(root.__revexR97KeyboardGuard)return;
    root.__revexR97KeyboardGuard=true;
    const guard=event=>{
      if(typeof event?.key==='string')return;
      event.stopImmediatePropagation?.();
      diagnostic('WARN','VIEWER_KEY_EVENT_IGNORED','Ignored a malformed WebView keyboard event with no key.');
    };
    root.addEventListener('keydown',guard,true);
    root.addEventListener('keyup',guard,true);
  }

  async function recoverCallableFailure(error){
    let Store,ctx;
    try{Store=await StoreReady(5000);ctx=await context(Store);}catch(_){return null;}
    if(!ctx)return null;
    let job=null;
    try{job=await readJob(Store,ctx.id,ctx.revision);}catch(readError){diagnostic('WARN','ENERGY_JOB_READ_AFTER_CALLABLE',readError?.message||String(readError));return null;}
    const status=clean(job?.status).toUpperCase();
    const stage=clean(job?.stage);
    if(status==='RUNNING'){
      diagnostic('WARN','ENERGY_CALLABLE_EDGE_DROPPED','The callable edge ended while the exact server job is still RUNNING; reattaching instead of launching another execution.',{projectId:ctx.id,revision:ctx.revision,jobStage:stage,originalError:error?.message||String(error)});
      post('BROKER_REATTACH',`Server job for ${ctx.revision} is still RUNNING${stage?` / ${stage}`:''}; reattached without restarting it.`,false,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage});
      const follow=root.__revexHostedEnergyReplayR95?.followExistingJob;
      if(typeof follow==='function')return follow(Store,ctx.id,ctx.revision);
      return {ok:false,reattached:true};
    }
    if(status==='FAILED'||status==='INFRASTRUCTURE_FAILED'){
      const exact=exactJobError(job,status);
      diagnostic('ERROR','ENERGY_JOB_EXACT_FAILURE',exact,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerHttpStatus:job?.workerHttpStatus||null,originalError:error?.message||String(error)});
      post('BROKER_FAILED',exact,false,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerHttpStatus:job?.workerHttpStatus||null});
      const raised=new Error(exact);raised.name='RevexEnergyJobError';raised.job=job;throw raised;
    }
    return null;
  }

  async function wrapNativeBridge(){
    for(let attempt=0;attempt<160;attempt+=1){
      const bridge=root.__revexManagedEnergyBridge;
      if(typeof bridge?.authorizeCurrentRevision==='function'){
        if(bridge.authorizeCurrentRevision.__revexR97LiveJobRecovery)return true;
        const original=bridge.authorizeCurrentRevision.bind(bridge);
        const wrapped=async function(...args){
          try{return await original(...args);}
          catch(error){
            const recovered=await recoverCallableFailure(error);
            if(recovered)return recovered;
            throw error;
          }
        };
        wrapped.__revexR97LiveJobRecovery=true;
        wrapped.__revexOriginal=original;
        bridge.authorizeCurrentRevision=wrapped;
        diagnostic('INFO','ENERGY_NATIVE_EDGE_R97','Native managed-Energy retry now preserves and follows the exact Firestore job if the callable transport drops.');
        return true;
      }
      await sleep(100);
    }
    diagnostic('WARN','ENERGY_NATIVE_EDGE_R97','Native managed-Energy bridge was not available for live-job wrapping.');
    return false;
  }

  async function surfaceExistingJob(){
    try{
      const Store=await StoreReady(5000),ctx=await context(Store);if(!ctx)return;
      const job=await readJob(Store,ctx.id,ctx.revision);if(!job)return;
      const status=clean(job.status).toUpperCase(),stage=clean(job.stage);
      if(status==='RUNNING'){
        diagnostic('INFO','ENERGY_JOB_REATTACH_R97',`Found RUNNING job for ${ctx.revision}; attaching to it without a duplicate launch.`,{projectId:ctx.id,revision:ctx.revision,jobStage:stage});
        const follow=root.__revexHostedEnergyReplayR95?.followExistingJob;
        if(typeof follow==='function')void follow(Store,ctx.id,ctx.revision).catch(error=>recoverCallableFailure(error).catch(()=>{}));
        return;
      }
      if(status==='FAILED'||status==='INFRASTRUCTURE_FAILED'){
        const exact=exactJobError(job,status);
        post('BROKER_FAILED',exact,false,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerHttpStatus:job?.workerHttpStatus||null});
        diagnostic('ERROR','ENERGY_JOB_EXACT_FAILURE',exact,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerHttpStatus:job?.workerHttpStatus||null});
      }
    }catch(error){diagnostic('WARN','ENERGY_JOB_RECOVERY_R97',error?.message||String(error));}
  }

  installKeyboardGuard();
  const install=()=>{void wrapNativeBridge();setTimeout(()=>void surfaceExistingJob(),500);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
  root.addEventListener('revex:energy-open',()=>{void wrapNativeBridge();setTimeout(()=>void surfaceExistingJob(),150);});
  root.addEventListener('revex:source-revision-loaded',()=>{void wrapNativeBridge();setTimeout(()=>void surfaceExistingJob(),150);});
  console.info('[REVEX] live worker edge r97',{callableFailure:'read-exact-job-and-reattach',duplicateLaunch:'blocked',malformedViewerKey:'ignored-only',qaHardStop:'unchanged'});
})(window);
