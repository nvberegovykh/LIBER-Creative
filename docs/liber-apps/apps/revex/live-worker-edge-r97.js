(function(root){
  'use strict';
  const BUILD='20260816r97-live-worker-edge2';
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
  async function readJobAfterCallable(Store,id,revision,error){
    const generic=/functions\/internal|\binternal\b/i.test(clean(error?.message||error));
    const attempts=generic?12:1;
    let job=null;
    for(let attempt=0;attempt<attempts;attempt+=1){
      try{job=await readJob(Store,id,revision);}catch(readError){
        diagnostic('WARN','ENERGY_JOB_READ_AFTER_CALLABLE',readError?.message||String(readError));
        return null;
      }
      if(job&&clean(job.status))return job;
      if(attempt+1<attempts)await sleep(500);
    }
    return job;
  }
  function exactJobError(job,status){
    const stage=clean(job?.stage)||'WORKER_REQUEST';
    const detail=clean(job?.error)||`Energy broker job status is ${status||'UNKNOWN'}.`;
    const http=job?.workerHttpStatus?` [HTTP ${job.workerHttpStatus}]`:'';
    return `${stage}${http}: ${detail}`;
  }
  function exactResult(result,id,revision,resultRevision=''){
    if(!result?.manifest)return false;
    const manifest=result.manifest;
    const resultProject=clean(result.projectId||manifest.projectId);
    const sourceRevision=clean(manifest.sourceEngineeringRevision||manifest.sourceRevision||manifest.engineeringRevision||result.sourceRevision);
    const actual=clean(result.revision||manifest.resultRevision);
    return resultProject===id&&sourceRevision===revision&&(!clean(resultRevision)||actual===clean(resultRevision));
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

  async function followAuthoritativeJob(Store,ctx,job,reason='reattach'){
    const status=clean(job?.status).toUpperCase();
    const stage=clean(job?.stage);
    const resultRevision=clean(job?.resultRevision);
    const follow=root.__revexHostedEnergyReplayR95?.followExistingJob;
    if(typeof follow==='function')return follow(Store,ctx.id,ctx.revision);

    // Fallback only if the hosted follower is unavailable. COMPLETE is still accepted
    // only when the exact immutable result is already current and bound to this source.
    if(status==='COMPLETE'){
      const result=await Store.getEnergyResult(ctx.id);
      if(!exactResult(result,ctx.id,ctx.revision,resultRevision)||clean(result?.manifest?.status).toUpperCase()!=='COMPLETE')
        throw new Error(`Broker job completed as ${resultRevision||'<missing result revision>'}, but its exact immutable Energy result is not current.`);
      root.dispatchEvent(new CustomEvent('revex:managed-energy-result',{detail:{projectId:ctx.id,revision:ctx.revision,resultRevision:clean(result.revision||result.manifest?.resultRevision),result}}));
      post('COMPLETE',`Energy chain complete for ${ctx.revision} as ${clean(result.revision||result.manifest?.resultRevision)}.`,true,{projectId:ctx.id,revision:ctx.revision,resultRevision:clean(result.revision||result.manifest?.resultRevision),recoveredFrom:reason});
      return {ok:true,recovered:true,result};
    }
    return {ok:false,reattached:true,projectId:ctx.id,revision:ctx.revision};
  }

  async function recoverCallableFailure(error){
    let Store,ctx;
    try{Store=await StoreReady(5000);ctx=await context(Store);}catch(_){return null;}
    if(!ctx)return null;
    const job=await readJobAfterCallable(Store,ctx.id,ctx.revision,error);
    if(!job)return null;
    const status=clean(job?.status).toUpperCase();
    const stage=clean(job?.stage);
    if(status==='RUNNING'||status==='COMPLETE'){
      const completed=status==='COMPLETE';
      diagnostic(completed?'INFO':'WARN',completed?'ENERGY_CALLABLE_EDGE_COMPLETED':'ENERGY_CALLABLE_EDGE_DROPPED',completed
        ?'The callable edge ended after the exact server job already completed; recovering the published result instead of reporting a false failure.'
        :'The callable edge ended while the exact server job is still RUNNING; reattaching instead of launching another execution.',
        {projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,resultRevision:clean(job.resultRevision),originalError:error?.message||String(error)});
      post(completed?'BROKER_RECOVERED_COMPLETE':'BROKER_REATTACH',completed
        ?`Server job for ${ctx.revision} already completed as ${clean(job.resultRevision)||'an exact result'}; recovering that result.`
        :`Server job for ${ctx.revision} is still RUNNING${stage?` / ${stage}`:''}; reattached without restarting it.`,completed,
        {projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,resultRevision:clean(job.resultRevision)});
      return followAuthoritativeJob(Store,ctx,job,'callable-edge');
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
      if(status==='RUNNING'||status==='COMPLETE'){
        diagnostic('INFO',status==='COMPLETE'?'ENERGY_JOB_COMPLETE_R97':'ENERGY_JOB_REATTACH_R97',status==='COMPLETE'
          ?`Found COMPLETE job for ${ctx.revision}; binding its exact immutable result.`
          :`Found RUNNING job for ${ctx.revision}; attaching to it without a duplicate launch.`,
          {projectId:ctx.id,revision:ctx.revision,jobStage:stage,resultRevision:clean(job.resultRevision)});
        void followAuthoritativeJob(Store,ctx,job,'page-load').catch(error=>diagnostic('ERROR','ENERGY_JOB_FOLLOW_R97',error?.message||String(error)));
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
  console.info('[REVEX] live worker edge r97',{callableFailure:'read-exact-job-and-reattach-or-complete',duplicateLaunch:'blocked',malformedViewerKey:'ignored-only',qaHardStop:'unchanged'});
})(window);
