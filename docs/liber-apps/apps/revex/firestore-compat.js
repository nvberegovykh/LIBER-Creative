(function(root){
  'use strict';
  const Store=root.RevexStore;
  if(!Store||Store.__revexFirestoreCompatR18Installed) return;

  const clone=(value)=>JSON.parse(JSON.stringify(value===undefined?null:value));

  function sanitize(value,parentIsArray){
    if(Array.isArray(value)){
      const items=value.map((item)=>sanitize(item,true));
      return parentIsArray?{__revexArray:true,items}:items;
    }
    if(value&&typeof value==='object'){
      const out={};
      Object.entries(value).forEach(([key,item])=>{
        if(item!==undefined) out[key]=sanitize(item,false);
      });
      return out;
    }
    return value===undefined?null:value;
  }

  function rowObject(headers,row,index){
    if(!Array.isArray(row)) return sanitize(row,false);
    const out={__row:index};
    const names=Array.isArray(headers)?headers:[];
    row.forEach((cell,column)=>{
      const base=String(names[column]||`Column ${column+1}`).trim()||`Column ${column+1}`;
      let key=base;
      let suffix=2;
      while(Object.prototype.hasOwnProperty.call(out,key)) key=`${base} [${suffix++}]`;
      out[key]=sanitize(cell,false);
    });
    return out;
  }

  function safeSpecPayload(payload){
    if(!Array.isArray(payload)) return sanitize(payload,false);
    return payload.map((schedule)=>{
      if(!schedule||typeof schedule!=='object'||Array.isArray(schedule)) return sanitize(schedule,false);
      const headers=Array.isArray(schedule.headers)?schedule.headers:[];
      const next={...schedule};
      next.headers=sanitize(headers,false);
      next.rows=Array.isArray(schedule.rows)
        ? schedule.rows.map((row,index)=>rowObject(headers,row,index))
        : sanitize(schedule.rows,false);
      return sanitize(next,false);
    });
  }

  function install(){
    if(Store.__revexFirestoreCompatR18Installed) return true;
    if(!Store.api?.setDoc) return false;

    const originalSetDoc=Store.api.setDoc.bind(Store.api);
    Store.api.setDoc=async function revexFirestoreSafeSetDoc(ref,data,options){
      const path=String(ref?.path||'');
      const isRevexSpecSource=/\/sources\/revex-revit$/i.test(path)||/\/library\/revex_spec_source$/i.test(path);
      if(!isRevexSpecSource||!data||!Array.isArray(data.payload))
        return originalSetDoc(ref,data,options);

      const next=clone(data);
      next.payload=safeSpecPayload(next.payload);
      next.payloadEncoding='revex-firestore-row-objects-v2';
      next.rawPayloadStoragePath=next.storagePath||next.rawPayloadStoragePath||null;
      next.rawPayloadPreserved=Boolean(next.rawPayloadStoragePath);
      return originalSetDoc(ref,next,options);
    };

    Store.__revexFirestoreCompatR18Installed=true;
    root.RevexFirestoreCompat={safeSpecPayload,rowObject,sanitize};
    console.log('[REVEX] Firestore compatibility r18 enabled',{specRows:'header-keyed-row-objects',nestedArrays:'sanitized',rawPayloadPreserved:true});
    try{ root.chrome?.webview?.postMessage({type:'liber:revex-sync-progress',stage:'firestore-compat-ready',build:'20260810r18'}); }catch(_){ }
    return true;
  }

  function waitForFirebase(){
    if(install()) return;
    setTimeout(waitForFirebase,50);
  }

  waitForFirebase();
})(window);
