(function(root){
  'use strict';
  if(root.__revexSpecSourceCompatR49) return;
  root.__revexSpecSourceCompatR49=true;
  const Store=root.SpecStore;
  if(!Store||typeof Store.listIn!=='function') return;

  const originalListIn=Store.listIn.bind(Store);
  const cache=new Map();

  async function packageJson(url){
    const key=String(url||'').trim();
    if(!key) return null;
    if(cache.has(key)) return cache.get(key);
    const promise=(async()=>{
      const response=await fetch(key,{cache:'no-store'});
      if(!response.ok) throw new Error(`REVEX schedule package returned ${response.status}.`);
      return response.json();
    })();
    cache.set(key,promise);
    while(cache.size>6) cache.delete(cache.keys().next().value);
    try{return await promise;}catch(error){cache.delete(key);throw error;}
  }

  async function hydrate(source){
    if(!source||source.type!=='revit'||source.retired||Array.isArray(source.payload)&&source.payload.length) return source;
    if(source.payloadEncoding!=='revex-storage-index-v1'||!source.payloadUrl) return source;
    try{
      const pack=await packageJson(source.payloadUrl);
      const schedules=Array.isArray(pack?.payload)?pack.payload:[];
      const index=Number(source.payloadIndex);
      let schedule=Number.isInteger(index)&&index>=0?schedules[index]:null;
      const scheduleId=row=>String(row?.sourceScheduleId||row?.presentation?.scheduleUniqueId||'');
      if(schedule&&source.sourceScheduleId&&scheduleId(schedule)!==String(source.sourceScheduleId)) schedule=null;
      if(!schedule&&source.sourceScheduleId){
        schedule=schedules.find((row)=>String(row?.sourceScheduleId||row?.presentation?.scheduleUniqueId||'')===String(source.sourceScheduleId));
      }
      if(!schedule) throw new Error(`Schedule ${source.sourceScheduleId||source.id||''} is missing from its immutable REVEX package.`);
      const needsOneRefresh=String(source.appliedRev||'')===String(source.rev||'')&&(source.appliedPresentationSchema!=='liber.revit.schedule.presentation.v1'||source.appliedMergeSchema!=='liber.spec.source-merge.v4');
      return {
        ...source,
        payload:[schedule],
        payloadHydratedFrom:source.payloadUrl,
        ...(needsOneRefresh?{appliedRev:'__revex-r49-native-presentation-refresh__'}:{})
      };
    }catch(error){
      console.error('[REVEX Spec] source hydration failed',source.id,error);
      // A failed download is not an empty schedule. Preserve all previously imported rows.
      return {...source,payload:null,payloadHydrationError:String(error?.message||error)};
    }
  }

  Store.listIn=async function listInWithRevexPayload(kind,sid){
    const rows=await originalListIn(kind,sid);
    if(kind!=='sources'||!Array.isArray(rows)) return rows;
    return Promise.all(rows.map(hydrate));
  };

  console.info('[REVEX Spec] r49 source compatibility active',{perSchedulePayload:true,nativePresentation:true,repairPriorEmptyPayload:true});
})(window);
