(function(root){
  'use strict';
  if(root.__revexSpecSourceCompatR49) return;
  root.__revexSpecSourceCompatR49=true;
  const Store=root.SpecStore;
  if(!Store||typeof Store.listIn!=='function') return;

  const originalListIn=Store.listIn.bind(Store);
  const cache=new Map();
  const forcedRefresh=new Set();

  function revexStore(){
    try{return root.parent?.RevexStore||root.top?.RevexStore||null;}catch(_){return null;}
  }

  async function packageJson(source){
    const storagePath=String(source?.storagePath||'').trim();
    const legacyUrl=String(source?.payloadUrl||'').trim();
    const key=storagePath?`storage://${storagePath}`:legacyUrl;
    if(!key) return null;
    if(cache.has(key)) return cache.get(key);
    const promise=(async()=>{
      const bridge=revexStore();
      const url=storagePath
        ? await bridge?.fileUrl?.(storagePath)
        : (typeof bridge?.assertEphemeralUrl==='function'?bridge.assertEphemeralUrl(legacyUrl,'legacy Spec payload'):legacyUrl);
      if(!url)throw new Error('REVEX schedule package has no authenticated Storage path.');
      const response=await fetch(url,{cache:'no-store'});
      if(!response.ok) throw new Error(`REVEX schedule package returned ${response.status}.`);
      return response.json();
    })();
    cache.set(key,promise);
    try{return await promise;}catch(error){cache.delete(key);throw error;}
  }

  async function hydrate(source){
    if(!source||source.type!=='revit'||source.retired||Array.isArray(source.payload)&&source.payload.length) return source;
    if(source.payloadEncoding!=='revex-storage-index-v1'||(!source.storagePath&&!source.payloadUrl)) return source;
    try{
      const pack=await packageJson(source);
      const schedules=Array.isArray(pack?.payload)?pack.payload:[];
      const index=Number(source.payloadIndex);
      let schedule=Number.isInteger(index)&&index>=0?schedules[index]:null;
      if(!schedule&&source.sourceScheduleId){
        schedule=schedules.find((row)=>String(row?.sourceScheduleId||row?.presentation?.scheduleUniqueId||'')===String(source.sourceScheduleId));
      }
      if(!schedule) throw new Error(`Schedule ${source.sourceScheduleId||source.id||''} is missing from its immutable REVEX package.`);
      const refreshKey=String(source.id||source.sourceScheduleId||source.payloadIndex||'');
      const needsOneRefresh=!!refreshKey&&String(source.appliedRev||'')===String(source.rev||'')&&!forcedRefresh.has(refreshKey);
      if(needsOneRefresh) forcedRefresh.add(refreshKey);
      return {
        ...source,
        payload:[schedule],
        payloadHydratedFrom:source.storagePath?`storage://${source.storagePath}`:source.payloadUrl,
        ...(needsOneRefresh?{appliedRev:'__revex-r49-native-presentation-refresh__'}:{})
      };
    }catch(error){
      console.error('[REVEX Spec] source hydration failed',source.id,error);
      return {...source,payloadHydrationError:String(error?.message||error)};
    }
  }

  Store.listIn=async function listInWithRevexPayload(kind,sid){
    const rows=await originalListIn(kind,sid);
    if(kind!=='sources'||!Array.isArray(rows)) return rows;
    return Promise.all(rows.map(hydrate));
  };

  console.info('[REVEX Spec] r49 source compatibility active',{perSchedulePayload:true,nativePresentation:true,repairPriorEmptyPayload:true});
})(window);
