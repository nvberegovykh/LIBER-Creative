(function(root){
  'use strict';
  const BUILD='20260816r93-live-job1';
  const HARD_STOP=0.80;
  const ENDPOINT='https://legacy-comcheck.energycode.pnl.gov/CheckWeb/';
  const active=root.__revexHostedEnergyReplayActive instanceof Map?root.__revexHostedEnergyReplayActive:new Map();
  root.__revexHostedEnergyReplayActive=active;
  const runtime=root.__revexHostedEnergyReplayState||{running:false,projectId:'',revision:'',startedAt:0,jobStatus:'',jobStage:''};
  root.__revexHostedEnergyReplayState=runtime;
  const clean=value=>String(value??'').trim();
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const projectId=()=>clean(root.__revexState?.projectId||new URLSearchParams(location.search).get('projectId'));
  const sourceRevisionOf=result=>clean(result?.manifest?.sourceEngineeringRevision||result?.manifest?.sourceRevision||result?.manifest?.engineeringRevision||result?.sourceRevision);
  const resultRevisionOf=result=>clean(result?.revision||result?.manifest?.resultRevision);

  function ownButton(running=true){
    const button=document.getElementById('energy-authorize-backstop');
    if(!button)return;
    if(running){
      button.disabled=true;
      button.textContent='Energy running…';
      button.dataset.revexR93Running='1';
    }else{
      button.disabled=false;
      button.textContent='Retry this published revision';
      delete button.dataset.revexR93Running;
    }
  }

  function post(stage,message,ok=false,detail={}){
    const payload={type:'liber:revex-managed-energy-status',build:BUILD,stage,message,ok:Boolean(ok),projectId:clean(detail.projectId||projectId()),revision:clean(detail.revision||runtime.revision),...detail};
    try{root.chrome?.webview?.postMessage(payload);}catch(_){}
    root.dispatchEvent(new CustomEvent('revex:managed-energy-status',{detail:payload}));
    const node=document.getElementById('energy-run-status');
    if(node){node.textContent=message;node.dataset.tone=ok?'good':stage==='BROKER_FAILED'?'bad':'busy';}
    if(runtime.running&&!['COMPLETE','BROKER_FAILED'].includes(stage)){
      ownButton(true);
      setTimeout(()=>runtime.running&&ownButton(true),350);
    }
  }

  function validSource(source){
    const manifest=source?.manifest||{};
    const binding=manifest.projectBinding||{};
    if(clean(binding.version)!=='active-revit-evidence-v1'||!clean(binding.identityEvidenceDigest)||!clean(binding.documentUniqueId)) return false;
    const ratios=Object.values(manifest.publicationIntegrity?.ratios||{}).map(Number).filter(Number.isFinite);
    const lowest=ratios.length?Math.min(...ratios):Number(manifest.publicationIntegrity?.lowestRatio||0);
    return lowest>=HARD_STOP;
  }

  function resultMatches(result,id,sourceRevision,expectedResultRevision){
    if(!result?.manifest)return false;
    return clean(result.projectId||result.manifest.projectId)===id&&sourceRevisionOf(result)===sourceRevision&&(!clean(expectedResultRevision)||resultRevisionOf(result)===clean(expectedResultRevision));
  }

  async function waitStore(timeoutMs=30000){
    const began=Date.now();
    while(Date.now()-began<timeoutMs){
      const Store=root.RevexStore;
      if(Store?.isCloud?.()&&Store?.user?.uid)return Store;
      await delay(100);
    }
    throw new Error('REVEX cloud session is not ready.');
  }

  async function waitExactResult(Store,id,sourceRevision,resultRevision){
    for(let attempt=1;attempt<=240;attempt+=1){
      const result=await Store.getEnergyResult(id);
      if(resultMatches(result,id,sourceRevision,resultRevision))return result;
      if(attempt===1||attempt%8===0)post('RESULT_WAIT',`Worker completed; binding exact result ${resultRevision} (${attempt}/240)…`,false,{projectId:id,revision:sourceRevision,resultRevision,attempt});
      await delay(2000);
    }
    throw new Error(`Exact Energy result ${resultRevision} did not become current within 8 minutes.`);
  }

  async function showConsent(Store,id,revision){
    const existing=await Store.getEnergyConsent(id,revision);
    if(existing)return existing;
    const dialog=document.getElementById('energy-consent-dialog');
    if(!dialog?.showModal)throw new Error('COMcheck authorization is required for this immutable revision.');
    const project=document.getElementById('energy-consent-project');if(project)project.textContent=id;
    const rev=document.getElementById('energy-consent-revision');if(rev)rev.textContent=revision;
    const endpoint=document.getElementById('energy-consent-endpoint');if(endpoint)endpoint.textContent=ENDPOINT;
    dialog.returnValue='';
    const approved=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='approve'),{once:true});dialog.showModal();});
    if(!approved)throw new Error('COMcheck authorization was not granted for this revision.');
    return Store.recordEnergyConsent(id,revision);
  }

  async function readJob(Store,id,revision){
    if(!Store?.api?.doc||!Store?.api?.getDoc||!Store?.db)return null;
    const snap=await Store.api.getDoc(Store.api.doc(Store.db,'projects',id,'revexEnergyJobs',revision));
    return snap?.exists?.()?snap.data():null;
  }

  function startLiveMonitor(Store,id,revision,startedAt){
    let busy=false,last='',ticks=0;
    const pulse=async()=>{
      if(busy||!runtime.running)return;
      busy=true;ticks+=1;
      try{
        const job=await readJob(Store,id,revision);
        const status=clean(job?.status).toUpperCase();
        const stage=clean(job?.stage);
        const signature=`${status}|${stage}`;
        runtime.jobStatus=status;runtime.jobStage=stage;
        const elapsed=Math.round((Date.now()-startedAt)/1000);
        if(status){
          if(signature!==last||ticks%3===0){
            last=signature;
            post('BROKER_JOB',`Published revision ${revision} is accepted by the broker · ${status}${stage?` / ${stage}`:''} · ${elapsed}s`,status==='COMPLETE',{projectId:id,revision,jobStatus:status,jobStage:stage,elapsedSeconds:elapsed});
          }
        }else if(ticks%3===0){
          post('BROKER_CONNECTING',`Published revision ${revision} is waiting for broker job acknowledgement · ${elapsed}s`,false,{projectId:id,revision,elapsedSeconds:elapsed});
        }
      }catch(error){
        if(ticks%6===0)post('BROKER_MONITOR',`Energy call is active; job-state probe is waiting (${Math.round((Date.now()-startedAt)/1000)}s).`,false,{projectId:id,revision,monitorError:clean(error?.message)});
      }finally{busy=false;}
    };
    void pulse();
    const timer=setInterval(pulse,5000);
    const buttonTimer=setInterval(()=>runtime.running&&ownButton(true),1000);
    return ()=>{clearInterval(timer);clearInterval(buttonTimer);};
  }

  function own(key,factory){
    if(active.has(key))return active.get(key);
    const task=Promise.resolve().then(factory).finally(()=>active.delete(key));
    active.set(key,task);return task;
  }

  async function runCurrent({auto=false}={}){
    const Store=await waitStore();
    const id=projectId();
    if(!id)throw new Error('Choose the REVEX project first.');
    const source=await Store.getEngineeringState(id);
    const revision=clean(source?.revision||source?.manifest?.revision);
    if(!revision||!validSource(source))throw new Error('Current Engineering revision is not eligible for managed Energy processing.');
    const key=`${id}:${revision}`;
    return own(key,async()=>{
      runtime.running=true;runtime.projectId=id;runtime.revision=revision;runtime.startedAt=Date.now();runtime.jobStatus='';runtime.jobStage='';
      ownButton(true);
      let stopMonitor=()=>{};
      try{
        const consent=await Store.getEnergyConsent(id,revision);
        if(auto&&!consent)return {ok:false,skipped:'no-consent'};
        if(!consent)await showConsent(Store,id,revision);
        const startedAt=runtime.startedAt=Date.now();
        post('BROKER_RUNNING',auto?`Starting automatic recovery of published revision ${revision}…`:`Starting published revision ${revision}…`,false,{projectId:id,revision,startedAt,auto});
        stopMonitor=startLiveMonitor(Store,id,revision,startedAt);
        const response=await Store.runEnergyServer(id,revision);
        const expected=clean(response?.resultRevision);
        if(!expected)throw new Error('Energy broker returned no exact resultRevision.');
        post('BROKER_PASSED',`Worker completed as ${expected}; binding that exact result…`,true,{projectId:id,revision,resultRevision:expected,startedAt,auto});
        const result=resultMatches(response?.result,id,revision,expected)?response.result:await waitExactResult(Store,id,revision,expected);
        const status=clean(result?.manifest?.status).toUpperCase();
        if(status!=='COMPLETE')throw new Error(result?.manifest?.error||`Energy result ${expected} status is ${status||'UNKNOWN'}.`);
        root.dispatchEvent(new CustomEvent('revex:managed-energy-result',{detail:{projectId:id,revision,resultRevision:expected,result,response}}));
        post('COMPLETE',`Energy chain complete for ${revision} as ${expected}.`,true,{projectId:id,revision,resultRevision:expected,startedAt,auto});
        return {ok:true,projectId:id,revision,resultRevision:expected,result,response};
      }catch(error){
        post('BROKER_FAILED',error?.message||'Managed Energy replay failed.',false,{projectId:id,revision,error:error?.stack||String(error),auto});
        throw error;
      }finally{
        stopMonitor();runtime.running=false;ownButton(false);
      }
    });
  }

  async function autoRecover(){
    try{
      if(runtime.running)return;
      const Store=await waitStore(12000);
      const id=projectId();if(!id)return;
      const source=await Store.getEngineeringState(id);
      const revision=clean(source?.revision||source?.manifest?.revision);
      if(!revision||!validSource(source))return;
      const result=await Store.getEnergyResult(id);
      if(clean(result?.manifest?.status).toUpperCase()!=='FAILED'||sourceRevisionOf(result)!==revision)return;
      const consent=await Store.getEnergyConsent(id,revision);if(!consent)return;
      const failureRevision=resultRevisionOf(result)||'failed';
      const onceKey=`revex.r93.autoreplay.${id}.${revision}.${failureRevision}`;
      try{if(sessionStorage.getItem(onceKey)==='1')return;sessionStorage.setItem(onceKey,'1');}catch(_){}
      post('AUTO_REPLAY',`Previous failure ${failureRevision} belongs to published revision ${revision}; starting one exact recovery execution.`,false,{projectId:id,revision,previousResultRevision:failureRevision});
      await runCurrent({auto:true});
    }catch(error){console.warn('[REVEX r93 auto replay]',error);}
  }

  function bind(){
    const button=document.getElementById('energy-authorize-backstop');
    if(button&&!button.dataset.revexR93Replay){
      button.dataset.revexR93Replay='1';
      button.onclick=()=>{void runCurrent({auto:false}).catch(()=>{});};
    }
  }

  root.__revexHostedEnergyReplayR93={build:BUILD,runCurrent,resultMatches,autoRecover};
  const install=()=>{bind();setTimeout(autoRecover,400);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
  root.addEventListener('revex:energy-open',()=>{bind();if(runtime.running)ownButton(true);else setTimeout(autoRecover,150);});
  root.addEventListener('revex:source-revision-loaded',()=>!runtime.running&&setTimeout(autoRecover,150));
  console.info('[REVEX] hosted Energy replay',BUILD,{hardStop:HARD_STOP,exactResultRevision:true,liveBrokerJob:true,buttonSingleOwnerDuringRun:true});
})(window);
