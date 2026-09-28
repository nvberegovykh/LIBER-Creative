'use strict';
const millis=value=>typeof value?.toMillis==='function'?value.toMillis():typeof value?.toDate==='function'?value.toDate().getTime():Number(value)||Date.parse(String(value||''))||0;
async function claimJob(db,ref,data,now=Date.now()){
 return db.runTransaction(async tx=>{
  const snap=await tx.get(ref),state=snap.exists?snap.data():{};
  const workerRunning=state.workerStatus==='RUNNING'&&(millis(state.workerLeaseExpiresAt)>now||millis(state.workerHeartbeatAt)>now-150000);
  const brokerRunning=state.status==='RUNNING'&&Number(state.brokerLeaseExpiresAt)>now;
  const completedWorkerStalled=state.workerStatus==='COMPLETE'&&millis(state.workerHeartbeatAt)>0&&now-millis(state.workerHeartbeatAt)>30000;
  if(workerRunning||(brokerRunning&&!completedWorkerStalled))return {claimed:false,status:'RUNNING',correlationId:state.correlationId||null};
  const base=`projects/${data.projectId}/revex/energy/server-results/${data.sourceRevision}`;
  const cachedPrefix=String(state.workerResponsePath||'').replace(/\/worker-response\.[a-f0-9]+\.json$/i,'');
  const recoverComplete=state.workerStatus==='COMPLETE'&&state.workerSourceCandidate===data.expectedWorkerSourceCandidate&&
    (cachedPrefix===base||new RegExp('^'+base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/runs/broker-[a-z0-9-]+$').test(cachedPrefix));
  const outputPrefix=recoverComplete?cachedPrefix:data.outputPrefix;
  tx.set(ref,{...data,outputPrefix,brokerLeaseExpiresAt:now+3650000},{merge:true});
  return {claimed:true,outputPrefix};
 });
}
async function updateOwnedJob(db,ref,correlationId,data){
 return db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists||snap.data().correlationId!==correlationId)return false;tx.set(ref,data,{merge:true});return true;});
}
function canReuseResult(state,sourceRevision,workerCandidate){return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(workerCandidate)&&String(state?.manifest?.sourceEngineeringRevision||'')===sourceRevision&&String(state?.manifest?.pipelineVersion||'')==='0.8.19-r49'&&String(state?.manifest?.sourceCandidate||'')===workerCandidate&&String(state?.manifest?.status||'').toUpperCase()==='COMPLETE';}
module.exports={claimJob,updateOwnedJob,canReuseResult};
