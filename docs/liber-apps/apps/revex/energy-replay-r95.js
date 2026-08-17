(function(root){
  'use strict';
  const BUILD='20260817r116-final-energy1';
  const HARD_STOP=0.80;
  const WORKER_FRESH_MS=150000;
  const active=root.__revexManagedEnergyActive instanceof Map?root.__revexManagedEnergyActive:new Map();
  root.__revexManagedEnergyActive=active;
  const runtime=root.__revexHostedEnergyRuntime||{running:false,projectId:'',revision:'',startedAt:0,owner:''};
  root.__revexHostedEnergyRuntime=runtime;
  const clean=v=>String(v??'').trim();
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const projectId=()=>clean(root.__revexState?.projectId||new URLSearchParams(location.search).get('projectId'));
  const sourceRevisionOf=result=>clean(result?.manifest?.sourceEngineeringRevision||result?.manifest?.sourceRevision||result?.manifest?.engineeringRevision||result?.sourceRevision);
  const resultRevisionOf=result=>clean(result?.revision||result?.manifest?.resultRevision);
  function diagnostic(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'energy replay r95',...detail});}catch(_){} }
  function epochMs(value){
    try{if(typeof value?.toMillis==='function')return Number(value.toMillis())||0;if(typeof value?.toDate==='function')return Number(value.toDate()?.getTime?.())||0;}catch(_){}
    const direct=Date.parse(String(value||''));return Number.isFinite(direct)?direct:0;
  }
  function workerState(job){
    const status=clean(job?.workerStatus).toUpperCase();
    const stage=clean(job?.workerStage);
    const heartbeatMs=epochMs(job?.workerHeartbeatAt);
    const fresh=status==='RUNNING'&&heartbeatMs>0&&Date.now()-heartbeatMs<=WORKER_FRESH_MS;
    return {status,stage,heartbeatMs,fresh,failure:clean(job?.workerFailure),pipelineStatus:clean(job?.workerPipelineStatus).toUpperCase(),sourceCandidate:clean(job?.workerSourceCandidate)};
  }
  function pipelineTerminal(status){
    const value=clean(status).toUpperCase();
    return Boolean(value)&&!['RUNNING','COMPLETE','INFRASTRUCTURE_FAILED'].includes(value);
  }
  function exactJobError(job,status){
    const worker=workerState(job);
    const stage=clean(job?.stage)||worker.stage||'ENERGY_PIPELINE';
    const detail=clean(job?.error)||worker.failure||`Energy pipeline status is ${clean(status)||worker.pipelineStatus||'UNKNOWN'}.`;
    const http=job?.workerHttpStatus?` [HTTP ${job.workerHttpStatus}]`:'';
    return `${stage}${http}: ${detail}`;
  }

  function sourceValid(source){
    const manifest=source?.manifest||{},binding=manifest.projectBinding||{};
    if(clean(binding.version)!=='active-revit-evidence-v1'||!clean(binding.identityEvidenceDigest)||!clean(binding.documentUniqueId))return false;
    const ratios=Object.values(manifest.publicationIntegrity?.ratios||{}).map(Number).filter(Number.isFinite);
    const lowest=ratios.length?Math.min(...ratios):Number(manifest.publicationIntegrity?.lowestRatio||0);
    return lowest>=HARD_STOP;
  }
  function exactResult(result,id,revision,expected=''){
    if(!result?.manifest)return false;
    return clean(result.projectId||result.manifest.projectId)===id&&sourceRevisionOf(result)===revision&&(!clean(expected)||resultRevisionOf(result)===clean(expected));
  }
  function setButton(running){
    const button=document.getElementById('energy-authorize-backstop');
    if(!button)return;
    button.disabled=Boolean(running);
    button.textContent=running?'Energy running…':'Retry this published revision';
    if(running)button.dataset.revexEnergyRunning='1';else delete button.dataset.revexEnergyRunning;
  }
  function post(stage,message,ok=false,detail={}){
    const payload={type:'liber:revex-managed-energy-status',build:BUILD,stage,message,ok:Boolean(ok),projectId:clean(detail.projectId||runtime.projectId||projectId()),revision:clean(detail.revision||runtime.revision),...detail};
    try{root.chrome?.webview?.postMessage(payload);}catch(_){}
    root.dispatchEvent(new CustomEvent('revex:managed-energy-status',{detail:payload}));
    const node=document.getElementById('energy-run-status');
    if(node){node.textContent=message;node.dataset.tone=ok?'good':stage==='BROKER_FAILED'?'bad':'busy';}
  }
  async function StoreReady(timeoutMs=30000){
    const started=Date.now();
    while(Date.now()-started<timeoutMs){const Store=root.RevexStore;if(Store?.isCloud?.()&&Store?.user?.uid)return Store;await sleep(100);}
    throw new Error('REVEX cloud session is not ready.');
  }
  async function readSource(Store,id){return Store.getEngineeringState(id);}
  async function readJob(Store,id,revision){
    if(!Store?.api?.doc||!Store?.api?.getDoc||!Store?.db)return null;
    const snap=await Store.api.getDoc(Store.api.doc(Store.db,'projects',id,'revexEnergyJobs',revision));
    return snap?.exists?.()?snap.data():null;
  }
  async function waitExactResult(Store,id,revision,resultRevision){
    for(let attempt=1;attempt<=240;attempt+=1){
      const result=await Store.getEnergyResult(id);
      if(exactResult(result,id,revision,resultRevision))return result;
      if(attempt===1||attempt%8===0)post('RESULT_WAIT',`Worker finished; binding exact Energy result ${resultRevision} (${attempt}/240)…`,false,{projectId:id,revision,resultRevision,attempt});
      await sleep(2000);
    }
    throw new Error(`Exact Energy result ${resultRevision} did not become current within 8 minutes.`);
  }

  async function followExistingJob(Store,id,revision){
    const key=`${id}:${revision}`;
    const existing=active.get(key);
    if(existing&&runtime.owner!=='job-monitor')return existing;
    if(existing)return existing;
    const task=(async()=>{
      runtime.running=true;runtime.owner='job-monitor';runtime.projectId=id;runtime.revision=revision;runtime.startedAt=Date.now();setButton(true);
      let recoveryPromise=null,lastRecoveryAt=0;
      const recover=reason=>{
        if(recoveryPromise||Date.now()-lastRecoveryAt<15000)return;
        lastRecoveryAt=Date.now();
        diagnostic('WARN','ENERGY_DURABLE_RECOVERY',`Re-entering the Energy broker to recover ${revision}: ${reason}`,{projectId:id,revision,reason});
        recoveryPromise=Promise.resolve().then(()=>Store.runEnergyServer(id,revision)).catch(error=>{
          diagnostic('WARN','ENERGY_DURABLE_RECOVERY_EDGE',error?.message||String(error),{projectId:id,revision,reason});
          return null;
        }).finally(()=>{recoveryPromise=null;});
      };
      try{
        for(let attempt=1;;attempt+=1){
          const job=await readJob(Store,id,revision);
          const status=clean(job?.status).toUpperCase(),stage=clean(job?.stage),resultRevision=clean(job?.resultRevision),worker=workerState(job);
          const elapsed=Math.round((Date.now()-runtime.startedAt)/1000);
          const workerLabel=worker.status?` · worker ${worker.status}${worker.stage?` / ${worker.stage}`:''}`:'';
          post('BROKER_JOB',`Published revision ${revision} · broker ${status||'WAITING'}${stage?` / ${stage}`:''}${workerLabel} · ${elapsed}s`,status==='COMPLETE',{projectId:id,revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus,resultRevision,elapsedSeconds:elapsed,attempt});
          if(status==='COMPLETE'){
            const result=resultRevision?await waitExactResult(Store,id,revision,resultRevision):await Store.getEnergyResult(id);
            if(!exactResult(result,id,revision,resultRevision)||clean(result?.manifest?.status).toUpperCase()!=='COMPLETE')throw new Error('Broker job completed but the exact immutable Energy result is not COMPLETE.');
            root.dispatchEvent(new CustomEvent('revex:managed-energy-result',{detail:{projectId:id,revision,resultRevision:resultRevisionOf(result),result}}));
            post('COMPLETE',`Energy chain complete for ${revision} as ${resultRevisionOf(result)}.`,true,{projectId:id,revision,resultRevision:resultRevisionOf(result)});
            return {ok:true,result};
          }
          // Filing/input blocks and other pipeline terminal states are not transport recovery.
          // Surface them immediately; Retry explicitly re-enters the broker under current worker source.
          if(pipelineTerminal(status))throw new Error(exactJobError(job,status));
          if(worker.status==='FAILED')throw new Error(worker.failure||exactJobError(job,status));
          if(worker.status==='COMPLETE'){
            post('WORKER_FINALIZING',`Energy worker completed ${revision}; finalizing the strict REVEX package through the broker…`,false,{projectId:id,revision,workerStatus:worker.status,workerStage:worker.stage});
            recover('worker completed after callable transport loss');
            await sleep(3000);continue;
          }
          if(worker.status==='RUNNING'){
            if(worker.fresh){
              if(status==='FAILED'||status==='INFRASTRUCTURE_FAILED')post('WORKER_RECOVERING',`Broker transport dropped, but the Energy worker is alive for ${revision}; preserving the run and waiting for the final package.`,false,{projectId:id,revision,jobStatus:status,workerStatus:worker.status,workerStage:worker.stage});
              await sleep(5000);continue;
            }
            post('WORKER_LEASE_STALE',`Energy worker heartbeat became stale for ${revision}; safely reacquiring the same immutable revision.`,false,{projectId:id,revision,workerStatus:worker.status,workerStage:worker.stage});
            recover('worker heartbeat stale');
            await sleep(5000);continue;
          }
          if(status==='FAILED'||status==='INFRASTRUCTURE_FAILED')throw new Error(exactJobError(job,status));
          // No arbitrary browser recovery deadline: a live worker is governed by the verified
          // 3500/3600-second server limits and durable heartbeat/lease, not a UI loop counter.
          await sleep(5000);
        }
      }finally{
        runtime.running=false;runtime.owner='';setButton(false);
        if(active.get(key)===task)active.delete(key);
      }
    })();
    active.set(key,task);return task;
  }

  async function recoverTransportFailure(Store,id,revision,error){
    const job=await readJob(Store,id,revision).catch(()=>null);if(!job)throw error;
    const status=clean(job.status).toUpperCase(),worker=workerState(job);
    if(pipelineTerminal(status))throw new Error(exactJobError(job,status));
    if(worker.status==='FAILED')throw new Error(worker.failure||exactJobError(job,status));
    if(worker.status==='COMPLETE'||(worker.status==='RUNNING'&&worker.fresh)||status==='RUNNING'){
      diagnostic('WARN','ENERGY_TRANSPORT_RECOVERY',`Callable transport ended while ${revision} remains recoverable.`,{projectId:id,revision,jobStatus:status,workerStatus:worker.status,workerStage:worker.stage,originalError:error?.message||String(error)});
      post('BROKER_REATTACH',worker.status==='COMPLETE'?`Energy worker already completed ${revision}; finalizing cached package.`:`Energy worker for ${revision} is still alive; reattached without restarting it.`,false,{projectId:id,revision,jobStatus:status,workerStatus:worker.status,workerStage:worker.stage});
      return followExistingJob(Store,id,revision);
    }
    throw error;
  }

  async function showConsent(Store,id,revision){
    const dialog=document.getElementById('energy-consent-dialog');
    if(!dialog?.showModal)throw new Error('Revision-scoped COMcheck authorization dialog is unavailable.');
    const project=document.getElementById('energy-consent-project');if(project)project.textContent=id;
    const rev=document.getElementById('energy-consent-revision');if(rev)rev.textContent=revision;
    const endpoint=document.getElementById('energy-consent-endpoint');if(endpoint)endpoint.textContent='https://legacy-comcheck.energycode.pnl.gov/CheckWeb/';
    dialog.returnValue='';
    const approved=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='approve'),{once:true});dialog.showModal();});
    if(!approved)throw new Error('COMcheck authorization was not granted for this revision.');
    return Store.recordEnergyConsent(id,revision);
  }
  function own(key,factory){if(active.has(key))return active.get(key);const task=Promise.resolve().then(factory).finally(()=>{if(active.get(key)===task)active.delete(key)});active.set(key,task);return task;}

  async function runHosted({auto=false,forcePrompt=false}={}){
    const Store=await StoreReady();
    const id=projectId();if(!id)throw new Error('Choose the REVEX project first.');
    const source=await readSource(Store,id),revision=clean(source?.revision||source?.manifest?.revision);
    if(!revision)throw new Error('No published Engineering revision exists for the selected REVEX project.');
    if(!sourceValid(source))throw new Error(`Published Engineering revision ${revision} is not eligible for Energy processing.`);
    const key=`${id}:${revision}`;
    return own(key,async()=>{
      runtime.running=true;runtime.owner='hosted';runtime.projectId=id;runtime.revision=revision;runtime.startedAt=Date.now();setButton(true);
      let pulse=null;
      try{
        let consent=await Store.getEnergyConsent(id,revision);
        if(auto&&!consent)return {ok:false,skipped:'no-consent'};
        if(forcePrompt||!consent)consent=await showConsent(Store,id,revision);
        post('BROKER_STARTING',`Published Engineering revision ${revision} found. Starting its exact managed Energy chain…`,false,{projectId:id,revision,auto});
        pulse=setInterval(async()=>{
          try{const job=await readJob(Store,id,revision),status=clean(job?.status).toUpperCase(),stage=clean(job?.stage),worker=workerState(job),elapsed=Math.round((Date.now()-runtime.startedAt)/1000);post('BROKER_JOB',`Published revision ${revision} · broker ${status||'CONNECTING'}${stage?` / ${stage}`:''}${worker.status?` · worker ${worker.status}`:''} · ${elapsed}s`,status==='COMPLETE',{projectId:id,revision,jobStatus:status,jobStage:stage,workerStatus:worker.status,workerStage:worker.stage,workerPipelineStatus:worker.pipelineStatus,elapsedSeconds:elapsed});}catch(error){diagnostic('WARN','ENERGY_JOB_POLL',error?.message||String(error));}
        },5000);
        let response;
        try{response=await Store.runEnergyServer(id,revision);}catch(error){return recoverTransportFailure(Store,id,revision,error);}
        if(response?.ok===false)throw new Error(response?.message||response?.error||`Energy pipeline status is ${clean(response?.status)||'UNKNOWN'}.`);
        const expected=clean(response?.resultRevision);
        if(!expected)throw new Error('Energy broker completed without returning an exact resultRevision.');
        post('BROKER_PASSED',`Managed worker returned exact result ${expected}; verifying immutable result state…`,true,{projectId:id,revision,resultRevision:expected});
        const result=exactResult(response?.result,id,revision,expected)?response.result:await waitExactResult(Store,id,revision,expected);
        const status=clean(result?.manifest?.status).toUpperCase();
        if(status!=='COMPLETE')throw new Error(result?.manifest?.error||`Energy result ${expected} status is ${status||'UNKNOWN'}.`);
        root.dispatchEvent(new CustomEvent('revex:managed-energy-result',{detail:{projectId:id,revision,resultRevision:expected,result,response}}));
        post('COMPLETE',`Energy chain complete for ${revision} as ${expected}.`,true,{projectId:id,revision,resultRevision:expected});
        return {ok:true,projectId:id,revision,resultRevision:expected,result,response};
      }catch(error){post('BROKER_FAILED',error?.message||'Managed Energy chain failed.',false,{projectId:id,revision,error:error?.stack||String(error),auto});throw error;}
      finally{if(pulse)clearInterval(pulse);runtime.running=false;runtime.owner='';setButton(false);}
    });
  }

  async function activateRetry(){
    const Store=await StoreReady(),id=projectId();if(!id)throw new Error('Choose the REVEX project first.');
    const source=await readSource(Store,id),revision=clean(source?.revision||source?.manifest?.revision);if(!revision)throw new Error('No published Engineering revision exists for the selected REVEX project.');
    const key=`${id}:${revision}`;
    if(active.has(key))return active.get(key);
    const job=await readJob(Store,id,revision),status=clean(job?.status).toUpperCase(),worker=workerState(job);
    if(status==='RUNNING'||status==='COMPLETE'||(worker.status==='RUNNING'&&worker.fresh)||(worker.status==='COMPLETE'&&!pipelineTerminal(status)))return followExistingJob(Store,id,revision);
    const native=root.__revexManagedEnergyBridge;
    if(typeof native?.authorizeCurrentRevision==='function'){
      runtime.running=true;runtime.owner='native-delegate';runtime.projectId=id;runtime.revision=revision;runtime.startedAt=Date.now();setButton(true);
      diagnostic('INFO','ENERGY_NATIVE_DELEGATE',`Retry delegated to the single native managed-Energy owner for ${revision}.`,{projectId:id,revision,previousJobStatus:status,workerStatus:worker.status,workerSourceCandidate:worker.sourceCandidate});
      try{return await native.authorizeCurrentRevision();}
      finally{runtime.running=false;runtime.owner='';setButton(false);}
    }
    return runHosted({auto:false,forcePrompt:true});
  }

  async function autoRecover(){
    try{
      if(runtime.running)return;
      const Store=await StoreReady(30000),id=projectId();if(!id)return;
      const source=await readSource(Store,id),revision=clean(source?.revision||source?.manifest?.revision);if(!revision||!sourceValid(source))return;
      const key=`${id}:${revision}`;if(active.has(key))return;
      const job=await readJob(Store,id,revision),jobStatus=clean(job?.status).toUpperCase(),worker=workerState(job);
      if(jobStatus==='RUNNING'||jobStatus==='COMPLETE'||(worker.status==='RUNNING'&&worker.fresh)||(worker.status==='COMPLETE'&&!pipelineTerminal(jobStatus))){
        post('BROKER_REATTACH',`Published revision ${revision} has a recoverable Energy job; reattaching without a duplicate launch.`,false,{projectId:id,revision,jobStatus,workerStatus:worker.status,workerStage:worker.stage});
        await followExistingJob(Store,id,revision);return;
      }
      if(pipelineTerminal(jobStatus)||worker.status==='FAILED'){
        const exact=exactJobError(job,jobStatus);
        setButton(false);post('RETRY_READY',`${exact} The immutable Engineering revision is preserved; Retry runs it under the current worker source.`,false,{projectId:id,revision,jobStatus,workerStatus:worker.status,workerStage:worker.stage});
        return;
      }
      const result=await Store.getEnergyResult(id),status=clean(result?.manifest?.status).toUpperCase();
      if(status==='FAILED'&&sourceRevisionOf(result)===revision){setButton(false);post('RETRY_READY',`Published revision ${revision} is preserved. Retry opens its authorization/identity form; no Revit re-export is required.`,false,{projectId:id,revision});}
    }catch(error){diagnostic('ERROR','ENERGY_REATTACH',error?.message||String(error));}
  }

  root.addEventListener('revex:managed-energy-status',event=>{
    const detail=event.detail||{},stage=clean(detail.stage).toUpperCase(),revision=clean(detail.revision),id=clean(detail.projectId||projectId());
    if(revision){runtime.revision=revision;runtime.projectId=id;}
    if(['VALIDATING','CLOUD_UPLOAD_PASSED','CONSENT_REQUIRED','CONSENT_RECORDED','BROKER_RUNNING','BROKER_STARTING','RESULT_WAIT','BROKER_PASSED','BROKER_REATTACH','WORKER_RECOVERING','WORKER_FINALIZING','WORKER_LEASE_STALE'].includes(stage)){
      runtime.running=true;if(!runtime.owner)runtime.owner='observed-native';setButton(true);
    }else if(['COMPLETE','BROKER_FAILED','EVIDENCE_ONLY','RETRY_READY'].includes(stage)){
      runtime.running=false;if(runtime.owner==='observed-native')runtime.owner='';setButton(false);
    }
  });

  document.addEventListener('click',event=>{
    const target=event.target?.closest?.('button');if(target?.id!=='energy-authorize-backstop')return;
    event.preventDefault();event.stopImmediatePropagation();
    if(runtime.running){setButton(true);return;}
    void activateRetry().catch(error=>diagnostic('ERROR','ENERGY_RETRY',error?.message||String(error)));
  },true);

  root.__revexHostedEnergyReplayR95={build:BUILD,activateRetry,runHosted,autoRecover,followExistingJob,exactResult,workerState,pipelineTerminal,exactJobError};
  const install=()=>{if(runtime.running)setButton(true);setTimeout(autoRecover,350);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
  root.addEventListener('revex:energy-open',()=>setTimeout(autoRecover,150));
  root.addEventListener('revex:source-revision-loaded',()=>setTimeout(autoRecover,150));
  console.info('[REVEX] Energy r116',{singleFlight:'shared-native-hosted',durableWorkerHeartbeat:true,cachedWorkerCompletion:true,sourceBoundCache:true,blockedPipelineTerminal:true,preflightBeforeSimulation:true,transportLossIsNotFinalFailure:true,uiRecoveryDeadline:'none-while-worker-live',hardStop:HARD_STOP});
})(window);
