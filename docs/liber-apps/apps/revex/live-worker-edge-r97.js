(function(root){
  'use strict';
  const BUILD='20260817r116-live-worker-edge2';
  const WORKER_FRESH_MS=150000;
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
  function epochMs(value){
    try{if(typeof value?.toMillis==='function')return Number(value.toMillis())||0;if(typeof value?.toDate==='function')return Number(value.toDate()?.getTime?.())||0;}catch(_){}
    const direct=Date.parse(String(value||''));return Number.isFinite(direct)?direct:0;
  }
  function workerState(job){
    const hosted=root.__revexHostedEnergyReplayR95?.workerState;
    if(typeof hosted==='function')return hosted(job);
    const status=clean(job?.workerStatus).toUpperCase(),stage=clean(job?.workerStage),heartbeatMs=epochMs(job?.workerHeartbeatAt);
    return {status,stage,heartbeatMs,fresh:status==='RUNNING'&&heartbeatMs>0&&Date.now()-heartbeatMs<=WORKER_FRESH_MS,failure:clean(job?.workerFailure),pipelineStatus:clean(job?.workerPipelineStatus).toUpperCase()};
  }
  function pipelineTerminal(status){
    const hosted=root.__revexHostedEnergyReplayR95?.pipelineTerminal;
    if(typeof hosted==='function')return hosted(status);
    const value=clean(status).toUpperCase();
    return Boolean(value)&&!['RUNNING','COMPLETE','INFRASTRUCTURE_FAILED'].includes(value);
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
    const generic=/functions\/internal|\binternal\b|econnreset|socket|network/i.test(clean(error?.message||error));
    const attempts=generic?12:1;
    let job=null;
    for(let attempt=0;attempt<attempts;attempt+=1){
      try{job=await readJob(Store,id,revision);}catch(readError){
        diagnostic('WARN','ENERGY_JOB_READ_AFTER_CALLABLE',readError?.message||String(readError));
        return null;
      }
      if(job&&(clean(job.status)||clean(job.workerStatus)))return job;
      if(attempt+1<attempts)await sleep(500);
    }
    return job;
  }
  function exactJobError(job,status){
    const hosted=root.__revexHostedEnergyReplayR95?.exactJobError;
    if(typeof hosted==='function')return hosted(job,status);
    const worker=workerState(job);
    if(worker.status==='FAILED'&&worker.failure)return `${worker.stage||'WORKER_FAILED'}: ${worker.failure}`;
    const stage=clean(job?.stage)||worker.stage||'ENERGY_PIPELINE';
    const detail=clean(job?.error)||worker.failure||`Energy broker job status is ${status||worker.pipelineStatus||'UNKNOWN'}.`;
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
    if(pipelineTerminal(status))throw new Error(exactJobError(job,status));
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
    const status=clean(job?.status).toUpperCase(),stage=clean(job?.stage),worker=workerState(job);
    if(pipelineTerminal(status)||worker.status==='FAILED'){
      const exact=exactJobError(job,status);
      diagnostic('ERROR','ENERGY_JOB_EXACT_FAILURE',exact,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus,workerHttpStatus:job?.workerHttpStatus||null,originalError:error?.message||String(error)});
      post('BROKER_FAILED',exact,false,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus,workerHttpStatus:job?.workerHttpStatus||null});
      const raised=new Error(exact);raised.name='RevexEnergyJobError';raised.job=job;throw raised;
    }
    const durable=worker.status==='COMPLETE'||(worker.status==='RUNNING'&&worker.fresh);
    if(status==='RUNNING'||status==='COMPLETE'||durable){
      const completed=status==='COMPLETE'||worker.status==='COMPLETE';
      diagnostic(completed?'INFO':'WARN',completed?'ENERGY_CALLABLE_EDGE_COMPLETED':'ENERGY_CALLABLE_EDGE_DROPPED',completed
        ?'The callable edge ended after the exact worker completed; recovering/finalizing the cached result instead of reporting a false failure.'
        :'The callable edge ended while the exact Energy worker is still alive; following its durable heartbeat instead of launching another execution.',
        {projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus,resultRevision:clean(job.resultRevision),originalError:error?.message||String(error)});
      post(completed?'WORKER_FINALIZING':'WORKER_RECOVERING',completed
        ?`Energy worker completed ${ctx.revision}; finalizing its cached strict package.`
        :`Energy worker for ${ctx.revision} is still alive${worker.stage?` / ${worker.stage}`:''}; preserving the run despite broker transport loss.`,false,
        {projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus,resultRevision:clean(job.resultRevision)});
      return followAuthoritativeJob(Store,ctx,job,'callable-edge');
    }
    if(status==='FAILED'||status==='INFRASTRUCTURE_FAILED'){
      const exact=exactJobError(job,status);
      diagnostic('ERROR','ENERGY_JOB_EXACT_FAILURE',exact,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerHttpStatus:job?.workerHttpStatus||null,originalError:error?.message||String(error)});
      post('BROKER_FAILED',exact,false,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerHttpStatus:job?.workerHttpStatus||null});
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
        diagnostic('INFO','ENERGY_NATIVE_EDGE_R116','Native managed-Energy edge now distinguishes broker transport loss from terminal pipeline status and source-bound cached output.');
        return true;
      }
      await sleep(100);
    }
    diagnostic('WARN','ENERGY_NATIVE_EDGE_R116','Native managed-Energy bridge was not available for durable live-job wrapping.');
    return false;
  }

  async function surfaceExistingJob(){
    try{
      const Store=await StoreReady(5000),ctx=await context(Store);if(!ctx)return;
      const job=await readJob(Store,ctx.id,ctx.revision);if(!job)return;
      const status=clean(job.status).toUpperCase(),stage=clean(job.stage),worker=workerState(job);
      if(pipelineTerminal(status)||worker.status==='FAILED'){
        const exact=exactJobError(job,status);
        post('RETRY_READY',`${exact} The immutable Engineering revision is preserved; Retry runs it under the current worker source.`,false,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus,workerHttpStatus:job?.workerHttpStatus||null});
        diagnostic('WARN','ENERGY_JOB_TERMINAL_R116',exact,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus});
        return;
      }
      if(status==='RUNNING'||status==='COMPLETE'||worker.status==='COMPLETE'||(worker.status==='RUNNING'&&worker.fresh)){
        diagnostic('INFO',status==='COMPLETE'?'ENERGY_JOB_COMPLETE_R116':'ENERGY_JOB_REATTACH_R116',status==='COMPLETE'
          ?`Found COMPLETE job for ${ctx.revision}; binding its exact immutable result.`
          :`Found recoverable Energy execution for ${ctx.revision}; following it without a duplicate launch.`,
          {projectId:ctx.id,revision:ctx.revision,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus,resultRevision:clean(job.resultRevision)});
        void followAuthoritativeJob(Store,ctx,job,'page-load').catch(error=>diagnostic('ERROR','ENERGY_JOB_FOLLOW_R116',error?.message||String(error)));
        return;
      }
      if(status==='FAILED'||status==='INFRASTRUCTURE_FAILED'){
        const exact=exactJobError(job,status);
        post('BROKER_FAILED',exact,false,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerHttpStatus:job?.workerHttpStatus||null});
        diagnostic('ERROR','ENERGY_JOB_EXACT_FAILURE',exact,{projectId:ctx.id,revision:ctx.revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerHttpStatus:job?.workerHttpStatus||null});
      }
    }catch(error){diagnostic('WARN','ENERGY_JOB_RECOVERY_R116',error?.message||String(error));}
  }

  installKeyboardGuard();
  const install=()=>{void wrapNativeBridge();setTimeout(()=>void surfaceExistingJob(),500);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
  root.addEventListener('revex:energy-open',()=>{void wrapNativeBridge();setTimeout(()=>void surfaceExistingJob(),150);});
  root.addEventListener('revex:source-revision-loaded',()=>{void wrapNativeBridge();setTimeout(()=>void surfaceExistingJob(),150);});
  console.info('[REVEX] live worker edge r116',{callableFailure:'worker-heartbeat-aware',pipelineTerminal:'not-recoverable',duplicateLaunch:'lease-guarded',cachedCompletion:'source-bound',malformedViewerKey:'ignored-only',qaHardStop:'unchanged'});
})(window);
