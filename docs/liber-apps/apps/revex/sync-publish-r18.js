(function(root){
  'use strict';
  const BUILD='20260810r18';
  if(root.__revexSyncPublishR18Loaded) return;
  root.__revexSyncPublishR18Loaded=true;

  const started=performance.now();
  const Store=root.RevexStore;
  let timer=0;

  function post(stage,detail={}){
    const payload={type:'liber:revex-sync-progress',build:BUILD,stage,elapsedMs:Math.round(performance.now()-started),...detail};
    try{ root.chrome?.webview?.postMessage(payload); }catch(_){ }
    console.log('[REVEX publish]',stage,detail);
  }

  function plain(value){
    return JSON.parse(JSON.stringify(value===undefined?null:value));
  }

  function rowObject(headers,row,index){
    if(!Array.isArray(row)) return sanitizeNested(row,false);
    const out={__row:index};
    const names=Array.isArray(headers)?headers:[];
    row.forEach((cell,column)=>{
      const base=String(names[column]||`Column ${column+1}`).trim()||`Column ${column+1}`;
      let key=base;
      let suffix=2;
      while(Object.prototype.hasOwnProperty.call(out,key)) key=`${base} [${suffix++}]`;
      out[key]=sanitizeNested(cell,false);
    });
    return out;
  }

  function sanitizeNested(value,parentIsArray){
    if(Array.isArray(value)){
      const items=value.map((item)=>sanitizeNested(item,true));
      // Firestore forbids an array directly inside another array. Preserve the
      // nested sequence as a map when that situation appears unexpectedly.
      return parentIsArray?{__revexArray:true,items}:items;
    }
    if(value&&typeof value==='object'){
      const out={};
      Object.entries(value).forEach(([key,item])=>{ if(item!==undefined) out[key]=sanitizeNested(item,false); });
      return out;
    }
    return value===undefined?null:value;
  }

  function safeSpecSource(data){
    const next=plain(data);
    if(!Array.isArray(next?.payload)) return next;
    next.payload=next.payload.map((schedule)=>{
      if(!schedule||typeof schedule!=='object'||Array.isArray(schedule)) return sanitizeNested(schedule,false);
      const headers=Array.isArray(schedule.headers)?schedule.headers:[];
      const safe={...schedule};
      safe.headers=sanitizeNested(headers,false);
      safe.rows=Array.isArray(schedule.rows)
        ? schedule.rows.map((row,index)=>rowObject(headers,row,index))
        : sanitizeNested(schedule.rows,false);
      return sanitizeNested(safe,false);
    });
    next.payloadEncoding='revex-firestore-row-objects-v2';
    next.rawPayloadStoragePath=next.storagePath||next.rawPayloadStoragePath||null;
    next.rawPayloadPreserved=Boolean(next.rawPayloadStoragePath);
    return next;
  }

  function install(){
    if(!Store?.api?.setDoc||!Store?.api?.uploadBytes) return false;
    if(Store.__revexSyncPublishR18Installed) return true;
    Store.__revexSyncPublishR18Installed=true;

    const originalSetDoc=Store.api.setDoc.bind(Store.api);
    Store.api.setDoc=async function revexSafeSetDoc(ref,data,options){
      const path=String(ref?.path||'');
      const isSpec=/\/sources\/revex-revit$/i.test(path)||/\/library\/revex_spec_source$/i.test(path);
      if(!isSpec) return originalSetDoc(ref,data,options);
      const next=safeSpecSource(data);
      post('spec-write-start',{path,payloadSchedules:Array.isArray(next.payload)?next.payload.length:0});
      try{
        const result=await originalSetDoc(ref,next,options);
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
      post('upload-start',{path,bytes});
      try{
        const result=await originalUploadBytes(ref,file,metadata);
        post('upload-complete',{path,bytes,uploadMs:Math.round(performance.now()-t0)});
        return result;
      }catch(error){
        post('upload-failed',{path,bytes,uploadMs:Math.round(performance.now()-t0),error:String(error?.message||error)});
        throw error;
      }
    };

    post('publish-runtime-ready',{cloud:Boolean(Store.isCloud?.()),user:Boolean(Store.user?.uid)});
    return true;
  }

  function wait(){
    if(install()) return;
    clearTimeout(timer);
    timer=setTimeout(wait,50);
  }

  wait();
})(window);
