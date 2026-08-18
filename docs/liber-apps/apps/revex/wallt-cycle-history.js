/* WALLT 24-hour cycle persistence adapter.
 * Mirrors meaningful Helper/Fixer cycle events into the existing REVEX project History owner.
 * Local wallt-control-plane storage remains the immediate/offline cache; this file creates no new database lane.
 */
(function(root){
  'use strict';
  const BUILD='20260818-wallt-cycle-history1';
  const WINDOW_MS=24*60*60*1000;
  const PERSIST_PHASES=new Set(['REQUEST','PLAN','COMPLETE','FAILED','ACTION_FAILED']);
  const seen=new Set();
  let queue=Promise.resolve();

  const clean=(value,max=6000)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
  const diag=(level,stage,message,detail={})=>{try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'WALLT cycle history adapter',build:BUILD,...detail})}catch(_){}};
  const jsonBounded=(value,max=48000)=>{
    try{
      const text=JSON.stringify(value??null);
      return text.length<=max?text:`${text.slice(0,max)}…`;
    }catch(_){return ''}
  };

  function historyEvent(row){
    const channel=clean(row?.channel,20)||'helper';
    const phase=clean(row?.phase,40)||'EVENT';
    return {
      id:`wallt_${clean(row?.id,180)||Date.now()}`,
      sourceRevision:clean(row?.revision,240)||null,
      kind:'wallt-cycle',
      operation:`${channel}:${phase.toLowerCase()}`,
      label:`WALLT ${channel} · ${phase}`,
      note:clean(row?.request,12000),
      relatedId:clean(row?.id,180)||null,
      snapshot:{
        schema:'liber.revex.wallt-history-event.v1',
        walltEventId:clean(row?.id,180)||null,
        at:clean(row?.at,80)||null,
        channel,
        phase,
        projectId:clean(row?.projectId,180)||null,
        revision:clean(row?.revision,240)||null,
        request:clean(row?.request,12000),
        detailJson:jsonBounded(row?.detail)
      }
    };
  }

  async function persist(row){
    if(!row||!PERSIST_PHASES.has(String(row.phase||'')))return null;
    const projectId=clean(row.projectId||root.__revexState?.projectId,180);
    const id=clean(row.id,180);
    if(!projectId||!id||seen.has(id))return null;
    const Store=root.RevexStore;
    if(typeof Store?.appendHistory!=='function'){
      diag('WARN','WALLT_HISTORY_WAIT','Project History owner is not ready; keeping this event in the local 24-hour WALLT cache.',{phase:row.phase,channel:row.channel});
      return null;
    }
    seen.add(id);
    try{
      const saved=await Store.appendHistory(projectId,historyEvent(row));
      diag('INFO','WALLT_HISTORY_SAVED','WALLT cycle event mirrored into existing REVEX project History.',{projectId,phase:row.phase,channel:row.channel,historyId:saved?.id||null});
      return saved;
    }catch(error){
      seen.delete(id);
      diag('WARN','WALLT_HISTORY_SAVE',error?.message||String(error),{projectId,phase:row.phase,channel:row.channel});
      return null;
    }
  }

  async function durableReport(projectId=root.__revexState?.projectId){
    projectId=clean(projectId,180);
    if(!projectId)throw new Error('Choose a REVEX project first.');
    const Store=root.RevexStore;
    if(typeof Store?.listHistory!=='function')throw new Error('REVEX project History owner is unavailable.');
    const cutoff=Date.now()-WINDOW_MS;
    const rows=(await Store.listHistory(projectId)||[]).filter((row)=>{
      if(row?.kind!=='wallt-cycle')return false;
      const time=Date.parse(row.createdAt||row.snapshot?.at||'');
      return Number.isFinite(time)&&time>=cutoff;
    });
    return {
      schema:'liber.revex.wallt-durable-24h-cycle-report.v1',
      generatedAt:new Date().toISOString(),
      windowHours:24,
      projectId,
      eventCount:rows.length,
      events:rows
    };
  }

  root.addEventListener('revex:wallt-cycle-event',(event)=>{
    const row=event?.detail;
    if(!row||!PERSIST_PHASES.has(String(row.phase||'')))return;
    queue=queue.then(()=>persist(row)).catch(()=>null);
  });

  root.__revexWalltCycleHistory=Object.freeze({
    build:BUILD,
    owner:'RevexStore.appendHistory',
    kind:'wallt-cycle',
    windowHours:24,
    persist,
    durableReport
  });
  diag('INFO','WALLT_HISTORY_READY','WALLT 24-hour cycles will mirror into the existing project History boundary.',{historyOwner:'RevexStore.appendHistory',newDatabaseOwner:false});
})(window);
