(function(root){
  'use strict';
  const Store=root.RevexStore;
  if(!Store||Store.__revexFirestoreCompatR17) return;
  Store.__revexFirestoreCompatR17=true;

  const clone=(value)=>JSON.parse(JSON.stringify(value===undefined?null:value));
  const originalSetDoc=Store.api?.setDoc?.bind(Store.api);
  if(!originalSetDoc) return;

  function rowObject(headers,row,index){
    if(!Array.isArray(row)) return row;
    const out={__row:index};
    const names=Array.isArray(headers)?headers:[];
    row.forEach((cell,column)=>{
      let key=String(names[column]||`Column ${column+1}`).trim()||`Column ${column+1}`;
      // Firestore map keys may contain arbitrary strings, but duplicate schedule
      // headers would otherwise overwrite each other. Keep every cell losslessly.
      if(Object.prototype.hasOwnProperty.call(out,key)) key=`${key} [${column+1}]`;
      out[key]=cell===undefined?null:cell;
    });
    return out;
  }

  function safeSpecPayload(payload){
    if(!Array.isArray(payload)) return payload;
    return payload.map((schedule)=>{
      if(!schedule||typeof schedule!=='object'||Array.isArray(schedule)) return schedule;
      const headers=Array.isArray(schedule.headers)?schedule.headers:[];
      return {
        ...schedule,
        rows:Array.isArray(schedule.rows)
          ? schedule.rows.map((row,index)=>rowObject(headers,row,index))
          : schedule.rows
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
    next.payloadEncoding='revex-firestore-row-objects-v1';
    next.rawPayloadStoragePath=next.storagePath||null;
    next.rawPayloadPreserved=true;
    return originalSetDoc(ref,next,options);
  };

  root.RevexFirestoreCompat={safeSpecPayload,rowObject};
  console.log('[REVEX] Firestore compatibility r17 enabled',{specRows:'header-keyed-row-objects',rawPayloadPreserved:true});
})(window);
