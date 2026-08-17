(function(root){
'use strict';
const BUILD='20260817r107-viewer-safety1';
if(root.__revexViewerSafetyR107)return;
root.__revexViewerSafetyR107={build:BUILD,maxVerticesPerChunk:12000,autoIdleMs:5000};

const MAX_VERTICES_PER_CHUNK=12000;
const MAIN_THREAD_BUDGET_MS=4;
const AUTO_IDLE_MS=5000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
const now=()=>performance.now();
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'viewer safety r107',...detail})}catch(_){}}

// A tiny heartbeat is also the browser acceptance signal. If the main thread is ever
// monopolized by BIM work, maxGap records it and the r107 browser regression fails.
const heartbeat=root.__revexHeartbeatR107||(root.__revexHeartbeatR107={ticks:0,last:now(),maxGap:0});
if(!heartbeat.timer){heartbeat.timer=setInterval(()=>{const t=now(),gap=t-heartbeat.last;heartbeat.last=t;heartbeat.ticks+=1;if(gap>heartbeat.maxGap)heartbeat.maxGap=gap},200)}

async function waitViewerIdle(v,token,quiet=120){
  while(token===v.loadToken&&(v.__r75Interacting||now()-(v.__r75LastInteraction||0)<quiet))await sleep(32);
  return token===v.loadToken;
}

function alignedVertexChunk(remaining){
  if(remaining<=MAX_VERTICES_PER_CHUNK)return remaining;
  const bounded=MAX_VERTICES_PER_CHUNK-(MAX_VERTICES_PER_CHUNK%3);
  return Math.max(3,bounded);
}

async function parsePageBounded(v,url,rootGroup,seen,token){
  if(!await waitViewerIdle(v,token,120))return{elements:0,parts:0,vertices:0,chunks:0};
  const T=await import('three');
  const response=await v.fetchGeometry(url,'REVEX geometry page');
  if(typeof DecompressionStream==='undefined'){
    diag('WARN','VIEWER_R107_DECOMPRESSION','DecompressionStream is unavailable; falling back to the existing paged parser.');
    return v.__r107PreviousLoadRvxPageInto(url,rootGroup,seen,token);
  }
  const decompressed=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if(!await waitViewerIdle(v,token,120))return{elements:0,parts:0,vertices:0,chunks:0};
  const bytes=new Uint8Array(decompressed),view=new DataView(decompressed);
  let p=0,sliceStart=now();
  const u8=()=>view.getUint8(p++);
  const i32=()=>{const x=view.getInt32(p,true);p+=4;return x};
  const f64=()=>{const x=view.getFloat64(p,true);p+=8;return x};
  const magic=new TextDecoder().decode(bytes.subarray(0,8));p=8;
  if(!magic.startsWith('RVXSCN2'))throw new Error('REVEX geometry page has an invalid header.');
  const version=i32();if(version!==2)throw new Error(`Unsupported REVEX geometry version ${version}.`);
  let elements=0,parts=0,vertices=0,chunks=0;

  while(p<bytes.length){
    if(token!==v.loadToken)return{elements,parts,vertices,chunks};
    if(v.__r75Interacting){if(!await waitViewerIdle(v,token,90))return{elements,parts,vertices,chunks};sliceStart=now()}
    const record=u8();if(record===0)break;if(record!==1)throw new Error(`Unknown REVEX geometry record ${record}.`);
    const elementId=String(Math.trunc(f64())),partCount=i32(),row=v.byId.get(elementId);seen.add(elementId);
    for(let part=0;part<partCount;part++){
      const materialId=f64(),vertexCount=i32();
      if(vertexCount<0||vertexCount>50000000)throw new Error(`Invalid REVEX vertex count ${vertexCount}.`);
      const byteLength=vertexCount*6*4,partStart=p;
      if(partStart+byteLength>bytes.length)throw new Error('REVEX geometry page ended inside a mesh buffer.');
      let vertexOffset=0;
      while(vertexOffset<vertexCount){
        if(token!==v.loadToken)return{elements,parts,vertices,chunks};
        const chunkVertices=alignedVertexChunk(vertexCount-vertexOffset);
        const chunkBytes=chunkVertices*6*4;
        const sourceOffset=partStart+vertexOffset*6*4;
        // Binary records are not guaranteed to be Float32-aligned because the record
        // header contains a byte tag. Copy only this bounded batch into an aligned
        // buffer instead of duplicating the whole mesh part at once.
        const aligned=new Uint8Array(chunkBytes);
        aligned.set(new Uint8Array(decompressed,sourceOffset,chunkBytes));
        const floats=new Float32Array(aligned.buffer);
        const ib=new T.InterleavedBuffer(floats,6),g=new T.BufferGeometry();
        g.setAttribute('position',new T.InterleavedBufferAttribute(ib,3,0,false));
        g.setAttribute('normal',new T.InterleavedBufferAttribute(ib,3,3,false));
        g.computeBoundingSphere();
        const mesh=new T.Mesh(g,v.materialFor(materialId,row));
        mesh.name=`REVEX_${elementId}_${part}_${chunks}`;
        mesh.userData.revexElementId=elementId;
        mesh.frustumCulled=true;
        rootGroup.add(mesh);
        vertexOffset+=chunkVertices;chunks+=1;
        if(now()-sliceStart>=MAIN_THREAD_BUDGET_MS){await nextFrame();sliceStart=now();}
        if(v.__r75Interacting&&!await waitViewerIdle(v,token,90))return{elements,parts,vertices,chunks};
      }
      p=partStart+byteLength;parts+=1;vertices+=vertexCount;
    }
    elements+=1;
    if(now()-sliceStart>=MAIN_THREAD_BUDGET_MS){await nextFrame();sliceStart=now();}
  }
  return{elements,parts,vertices,chunks};
}

function scheduleSafeAuto(v){
  if(!v||v.__r107AutoTimer||v.detailLoaded||v.detailLoading||!v.active||!v.sourceState?.modelUrl)return;
  v.__r107AutoTimer=setTimeout(()=>{
    v.__r107AutoTimer=0;
    const run=()=>{
      if(!v.active||v.detailLoaded||v.detailLoading||!v.sourceState?.modelUrl)return;
      if(v.__r75Interacting){scheduleSafeAuto(v);return;}
      v.__r107AutoPermit=true;
      Promise.resolve(v.loadDetailed(true)).catch(error=>diag('WARN','VIEWER_R107_AUTO_DETAIL',error?.message||String(error)));
    };
    if(typeof root.requestIdleCallback==='function')root.requestIdleCallback(run,{timeout:1600});else setTimeout(run,0);
  },AUTO_IDLE_MS);
}

function patchViewer(v){
  if(!v||v.__r107Safety||!v.__r75||typeof v.loadDetailed!=='function'||typeof v.loadRvxPageInto!=='function')return false;
  v.__r107Safety=true;
  clearTimeout(v.__r75DetailTimer);
  v.__r107PreviousLoadRvxPageInto=v.loadRvxPageInto.bind(v);
  v.loadRvxPageInto=function(url,group,seen,token){return parsePageBounded(this,url,group,seen,token)};

  const previousDetailed=v.loadDetailed.bind(v);
  v.__r107PreviousLoadDetailed=previousDetailed;
  v.loadDetailed=async function(...args){
    const t=now(),userIntent=t<(this.__r107UserDetailUntil||0),autoPermit=!!this.__r107AutoPermit;
    if(!userIntent&&!autoPermit){scheduleSafeAuto(this);return false;}
    this.__r107AutoPermit=false;
    if(this.__r107AutoTimer){clearTimeout(this.__r107AutoTimer);this.__r107AutoTimer=0;}
    return previousDetailed(...args);
  };

  const detail=document.getElementById('detail-toggle');
  if(detail&&!detail.dataset.revexR107Intent){
    detail.dataset.revexR107Intent='1';
    const arm=()=>{v.__r107UserDetailUntil=now()+1200;v.__r107AutoPermit=true;if(v.__r107AutoTimer){clearTimeout(v.__r107AutoTimer);v.__r107AutoTimer=0;}};
    detail.addEventListener('pointerdown',arm,true);detail.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')arm()},true);
  }

  const priorSetActive=v.setActive?.bind(v);
  if(priorSetActive){v.setActive=function(active){const result=priorSetActive(active);if(active)scheduleSafeAuto(this);else if(this.__r107AutoTimer){clearTimeout(this.__r107AutoTimer);this.__r107AutoTimer=0;}return result}}
  scheduleSafeAuto(v);
  diag('INFO','VIEWER_R107','Bounded exact-BIM parser installed: oversized mesh parts are triangle-chunked and exact detail waits for a responsive idle window.',{maxVerticesPerChunk:MAX_VERTICES_PER_CHUNK,autoIdleMs:AUTO_IDLE_MS});
  return true;
}

let attempts=0;
const timer=setInterval(()=>{
  attempts+=1;
  const viewer=root.__revexViewerR26Instance||null;
  if(patchViewer(viewer)||attempts>300)clearInterval(timer);
},50);
root.addEventListener('revex:viewer-host-ready',()=>queueMicrotask(()=>patchViewer(root.__revexViewerR26Instance)));
root.addEventListener('revex:source-revision-loaded',()=>setTimeout(()=>{const v=root.__revexViewerR26Instance;if(patchViewer(v))scheduleSafeAuto(v);else if(v)scheduleSafeAuto(v)},0));
console.info('[REVEX] viewer safety '+BUILD,{mainThreadBudgetMs:MAIN_THREAD_BUDGET_MS,maxVerticesPerChunk:MAX_VERTICES_PER_CHUNK,exactGeometry:'preserved-bounded-idle'});
})(window);
