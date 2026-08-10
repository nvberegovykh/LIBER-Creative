(function(root){
  'use strict';
  const Store=root.RevexStore;
  if(!Store||Store.__revexFirestoreCompatR17) return;
  Store.__revexFirestoreCompatR17=true;

  const clone=(value)=>JSON.parse(JSON.stringify(value===undefined?null:value));
  const originalSetDoc=Store.api?.setDoc?.bind(Store.api);
  if(!originalSetDoc) return;

  function safeRows(rows){
    if(!Array.isArray(rows)) return rows;
    return rows.map((row,index)=>Array.isArray(row)
      ? { index, cells: row.map((cell)=>cell===undefined?null:cell) }
      : row);
  }

  function safeSpecPayload(payload){
    if(!Array.isArray(payload)) return payload;
    return payload.map((schedule)=>{
      if(!schedule||typeof schedule!=='object'||Array.isArray(schedule)) return schedule;
      return {
        ...schedule,
        rows:safeRows(schedule.rows)
      };
    });
  }

  Store.api.setDoc=async function revexFirestoreSafeSetDoc(ref,data,options){
    const path=String(ref?.path||'');
    const isRevexSpecSource=/\/sources\/revex-revit$/i.test(path)||/\/library\/revex_spec_source$/i.test(path);
    if(!isRevexSpecSource||!data||!Array.isArray(data.payload))
      return originalSetDoc(ref,data,options);

    const next=clone(data);
    next.payload=safeSpecPayload(next.payload);
    next.payloadEncoding='revex-firestore-rows-v1';
    next.rawPayloadStoragePath=next.storagePath||null;
    next.rawPayloadPreserved=true;
    return originalSetDoc(ref,next,options);
  };

  root.RevexFirestoreCompat={safeSpecPayload,safeRows};
  console.log('[REVEX] Firestore compatibility r17 enabled',{specRows:'objects-with-cells',rawPayloadPreserved:true});
})(window);
