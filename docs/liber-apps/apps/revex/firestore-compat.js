(function(root){
  'use strict';
  const Store=root.RevexStore;
  if(!Store||Store.__revexFirestoreCompatR18Installed) return;

  const clone=(value)=>JSON.parse(JSON.stringify(value===undefined?null:value));
  const firestorePlain=(value)=>typeof Store.toFirestorePlain==='function'?Store.toFirestorePlain(value):clone(value);
  const post=(stage,detail={})=>{
    try{ root.chrome?.webview?.postMessage({type:'liber:revex-sync-progress',stage,build:'20260813r48',...detail}); }catch(_){ }
    console.log('[REVEX publish]',stage,detail);
  };

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
    if(!Store.api?.setDoc||!Store.api?.uploadBytes) return false;

    const originalSetDoc=Store.api.setDoc.bind(Store.api);
    Store.api.setDoc=async function revexFirestoreSafeSetDoc(ref,data,options){
      const path=String(ref?.path||'');
      const isRevexSpecSource=/\/sources\/revex-revit$/i.test(path)||/\/library\/revex_spec_source$/i.test(path);
      const isRevexLibrary=/^projects\/[^/]+\/library\/revex_/i.test(path);
      if(!isRevexSpecSource&&!isRevexLibrary)return originalSetDoc(ref,data,options);
      const nextOptions=options===undefined?undefined:firestorePlain(options);
      if(!isRevexSpecSource||!data||!Array.isArray(data.payload))
        return originalSetDoc(ref,firestorePlain(data),nextOptions);

      const next=firestorePlain(data);
      next.payload=safeSpecPayload(next.payload);
      next.payloadEncoding='revex-firestore-row-objects-v2';
      next.rawPayloadStoragePath=next.storagePath||next.rawPayloadStoragePath||null;
      next.rawPayloadPreserved=Boolean(next.rawPayloadStoragePath);
      post('spec-write-start',{path,payloadSchedules:next.payload.length});
      try{
        const result=await originalSetDoc(ref,firestorePlain(next),nextOptions);
        post('spec-write-complete',{path});
        return result;
      }catch(error){
        post('spec-write-failed',{path,error:String(error?.message||error)});
        throw error;
      }
    };

    const originalUploadBytes=Store.api.uploadBytes.bind(Store.api);
    Store.api.uploadBytes=async function revexObservedUpload(ref,file,metadata){
      const path=String(ref?.fullPath||ref?._location?.path_||file?.name||'upload');
      const bytes=Number(file?.size||0);
      const t0=performance.now();
      const nextMetadata=/^projects\/[^/]+\/(?:library\/revex|revex\/)/i.test(path)&&metadata!==undefined?firestorePlain(metadata):metadata;
      post('upload-start',{path,bytes});
      try{
        const result=await originalUploadBytes(ref,file,nextMetadata);
        post('upload-complete',{path,bytes,uploadMs:Math.round(performance.now()-t0)});
        return result;
      }catch(error){
        post('upload-failed',{path,bytes,uploadMs:Math.round(performance.now()-t0),error:String(error?.message||error)});
        throw error;
      }
    };

    Store.__revexFirestoreCompatR18Installed=true;
    root.RevexFirestoreCompat={safeSpecPayload,rowObject,sanitize};
    post('firestore-compat-ready',{nestedArrays:'sanitized',rawPayloadPreserved:true});
    return true;
  }

  function waitForFirebase(){
    if(install()) return;
    setTimeout(waitForFirebase,50);
  }

  waitForFirebase();
})(window);
