(function(root){
  'use strict';
  const BUILD='20260816r94-exact-job1';
  const HARD_STOP=0.80;
  const active=root.__revexHostedEnergyActive instanceof Map?root.__revexHostedEnergyActive:new Map();
  root.__revexHostedEnergyActive=active;
  const runtime=root.__revexHostedEnergyRuntime||{running:false,projectId:'',revision:'',startedAt:0};
  root.__revexHostedEnergyRuntime=runtime;
  let syncLaunchIntent=null;
  const clean=v=>String(v??'').trim();
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const projectId=()=>clean(root.__revexState?.projectId||new URLSearchParams(location.search).get('projectId'));
  const sourceRevisionOf=result=>clean(result?.manifest?.sourceEngineeringRevision||result?.manifest?.sourceRevision||result?.manifest?.engineeringRevision||result?.sourceRevision);
  const resultRevisionOf=result=>clean(result?.revision||result?.manifest?.resultRevision);
  function diagnostic(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'energy replay r94',...detail});}catch(_){} }
  function sourceValid(source){
    const manifest=source?.manifest||{};
    const binding=manifest.projectBinding||{};
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
    if(runtime.running&&!['COMPLETE','BROKER_FAILED'].includes(stage))setButton(true);
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
    const key=`follow:${id}:${revision}`;
    if(active.has(key))return active.get(key);
    const task=(async()=>{
      runtime.running=true;runtime.projectId=id;runtime.revision=revision;runtime.startedAt=Date.now();setButton(true);
      try{
        for(let attempt=1;attempt<=720;attempt+=1){
          const job=await readJob(Store,id,revision);
          const status=clean(job?.status).toUpperCase();
          const stage=clean(job?.stage);
          const resultRevision=clean(job?.resultRevision);
          const elapsed=Math.round((Date.now()-runtime.startedAt)/1000);
          post('BROKER_JOB',`Published revision ${revision} · broker ${status||'WAITING'}${stage?` / ${stage}`:''} · ${elapsed}s`,status==='COMPLETE',{projectId:id,revision,jobStatus:status,jobStage:stage,resultRevision,elapsedSeconds:elapsed});
          if(status==='COMPLETE'){
            const result=resultRevision?await waitExactResult(Store,id,revision,resultRevision):await Store.getEnergyResult(id);
            if(!exactResult(result,id,revision,resultRevision)||clean(result?.manifest?.status).toUpperCase()!=='COMPLETE')throw new Error('Broker job completed but the exact immutable Energy result is not COMPLETE.');
            root.dispatchEvent(new CustomEvent('revex:managed-energy-result',{detail:{projectId:id,revision,resultRevision:resultRevisionOf(result),result}}));
            post('COMPLETE',`Energy chain complete for ${revision} as ${resultRevisionOf(result)}.`,true,{projectId:id,revision,resultRevision:resultRevisionOf(result)});
            return {ok:true,result};
          }
          if(status==='FAILED'||status==='INFRASTRUCTURE_FAILED')throw new Error(clean(job?.error)||`Energy broker job status is ${status}.`);
          await sleep(5000);
        }
        throw new Error('Energy broker job exceeded the one-hour managed runtime window.');
      }finally{runtime.running=false;setButton(false);active.delete(key);}
    })();
    active.set(key,task);return task;
  }
  function own(key,factory){if(active.has(key))return active.get(key);const task=Promise.resolve().then(factory).finally(()=>active.delete(key));active.set(key,task);return task;}
  async function runExact({auto=false}={}){
    const Store=await StoreReady();
    const id=projectId();if(!id)throw new Error('Choose the REVEX project first.');
    const source=await readSource(Store,id);
    const revision=clean(source?.revision||source?.manifest?.revision);
    if(!revision)throw new Error('No published Engineering revision exists for the selected REVEX project.');
    if(!sourceValid(source))throw new Error(`Published Engineering revision ${revision} is not eligible for Energy processing.`);
    const key=`run:${id}:${revision}`;
    return own(key,async()=>{
      runtime.running=true;runtime.projectId=id;runtime.revision=revision;runtime.startedAt=Date.now();setButton(true);
      let pulse=null;
      try{
        const consent=await Store.getEnergyConsent(id,revision);
        if(!consent){
          if(auto)return {ok:false,skipped:'no-consent'};
          throw new Error(`Published revision ${revision} has no COMcheck authorization. Launch SYNC ENGINEERING to authorize its downstream chain.`);
        }
        post('BROKER_STARTING',`Published Engineering revision ${revision} found. Starting its exact managed Energy chain…`,false,{projectId:id,revision,auto});
        pulse=setInterval(async()=>{
          if(!runtime.running)return;
          try{
            const job=await readJob(Store,id,revision),status=clean(job?.status).toUpperCase(),stage=clean(job?.stage),elapsed=Math.round((Date.now()-runtime.startedAt)/1000);
            post('BROKER_JOB',`Published revision ${revision} · broker ${status||'CONNECTING'}${stage?` / ${stage}`:''} · ${elapsed}s`,status==='COMPLETE',{projectId:id,revision,jobStatus:status,jobStage:stage,elapsedSeconds:elapsed});
          }catch(error){diagnostic('WARN','ENERGY_JOB_POLL',error?.message||String(error));}
        },5000);
        const response=await Store.runEnergyServer(id,revision);
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
      finally{if(pulse)clearInterval(pulse);runtime.running=false;setButton(false);}
    });
  }
  async function autoRecover(){
    try{
      if(runtime.running)return;
      const Store=await StoreReady(30000),id=projectId();if(!id)return;
      const source=await readSource(Store,id),revision=clean(source?.revision||source?.manifest?.revision);if(!revision||!sourceValid(source))return;
      const job=await readJob(Store,id,revision),jobStatus=clean(job?.status).toUpperCase();
      if(jobStatus==='RUNNING'){post('BROKER_REATTACH',`Published revision ${revision} already has a RUNNING broker job; reattaching to it.`,false,{projectId:id,revision});await followExistingJob(Store,id,revision);return;}
      const result=await Store.getEnergyResult(id),status=clean(result?.manifest?.status).toUpperCase();
      if(status==='COMPLETE'&&sourceRevisionOf(result)===revision)return;
      if(status!=='FAILED'||sourceRevisionOf(result)!==revision)return;
      const consent=await Store.getEnergyConsent(id,revision);if(!consent)return;
      post('AUTO_REPLAY',`Published revision ${revision} has a preserved failed result and valid authorization; starting one recovery execution.`,false,{projectId:id,revision,previousResultRevision:resultRevisionOf(result)});
      await runExact({auto:true});
    }catch(error){diagnostic('ERROR','ENERGY_AUTO_RECOVERY',error?.message||String(error));}
  }
  function approveSyncLaunchConsent(detail){
    const id=clean(detail?.projectId),revision=clean(detail?.revision);if(!id||!revision)return;
    syncLaunchIntent={projectId:id,revision,expires:Date.now()+90000};
    diagnostic('INFO','ENERGY_SYNC_LAUNCH_INTENT',`SYNC ENGINEERING is the explicit authorization action for ${revision}.`,{projectId:id,revision});
  }
  function closeConsentFromSyncLaunch(detail){
    if(!syncLaunchIntent||Date.now()>syncLaunchIntent.expires)return;
    const id=clean(detail?.projectId),revision=clean(detail?.revision);
    if(id!==syncLaunchIntent.projectId||revision!==syncLaunchIntent.revision)return;
    let attempts=0;
    const timer=setInterval(()=>{
      attempts+=1;
      const dialog=document.getElementById('energy-consent-dialog');
      if(dialog?.open){dialog.returnValue='approve';dialog.close('approve');clearInterval(timer);diagnostic('INFO','ENERGY_SYNC_LAUNCH_AUTHORIZED',`SYNC ENGINEERING authorization advanced revision ${revision} without a second user click.`,{projectId:id,revision});}
      else if(attempts>=250)clearInterval(timer);
    },20);
  }
  root.addEventListener('revex:managed-energy-status',event=>{
    const detail=event.detail||{},stage=clean(detail.stage).toUpperCase();
    if(stage==='CLOUD_UPLOAD_PASSED')approveSyncLaunchConsent(detail);
    if(stage==='CONSENT_REQUIRED')closeConsentFromSyncLaunch(detail);
  });
  document.addEventListener('click',event=>{
    const target=event.target?.closest?.('button');if(target?.id!=='energy-authorize-backstop')return;
    event.preventDefault();event.stopImmediatePropagation();
    if(runtime.running){setButton(true);return;}
    void runExact({auto:false}).catch(()=>{});
  },true);
  root.__revexHostedEnergyReplayR94={build:BUILD,runExact,autoRecover,followExistingJob,exactResult};
  const install=()=>{if(runtime.running)setButton(true);setTimeout(autoRecover,350);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
  root.addEventListener('revex:energy-open',()=>{if(runtime.running)setButton(true);else setTimeout(autoRecover,150);});
  root.addEventListener('revex:source-revision-loaded',()=>!runtime.running&&setTimeout(autoRecover,150));
  console.info('[REVEX] hosted Energy replay',BUILD,{hardStop:HARD_STOP,exactResultRevision:true,liveBrokerJob:true,reattachRunningJob:true,syncLaunchIsAuthorization:true});
})(window);
