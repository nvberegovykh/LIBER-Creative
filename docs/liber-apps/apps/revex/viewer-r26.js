import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
const BUILD='20260813r49', Store=window.RevexStore;
const $=(s,r=document)=>r.querySelector(s);
if(!Store||window.__revexViewerR26){}else{
window.__revexViewerR26=true;THREE.Cache.enabled=true;
const PALETTE={walls:0xd6d2c8,doors:0x9f724f,windows:0x86b7cf,floors:0x9b968c,roofs:0x8e8884,ceilings:0xb8b3aa,stairs:0x9f927e,furniture:0x927f6f,casework:0x927358,'structural-columns':0x858b90,'structural-framing':0x858b90,'mechanical-equipment':0x6f8d8e,'lighting-fixtures':0xc6ae71,'plumbing-fixtures':0xaabac0,site:0x7c8d70,other:0x969a9e};
const NON_MODEL=/^(cameras?|views?|viewports?|sheets?|levels?|grids?|reference planes?|scope boxes?|project information|internal origin|survey point|project base point|sections?|elevations?|callouts?|lines?|model lines?|detail lines?|sketch lines?|analytical nodes?|reference points?|rooms?|spaces?|areas?)$/i;
const NON_PHYSICAL=/(room separation|space separation|area boundary|analytical|lighting.*area|electrical.*area|energy.*area|imported categories|dwg|dxf)/i;
const usableRow=r=>r?.proxyEligible!==false&&!!(r?.bbox?.min&&r?.bbox?.max)&&!NON_MODEL.test(String(r.category||'').trim())&&!NON_PHYSICAL.test(String(r.category||''));
class StreamBytes{
  constructor(reader){this.reader=reader;this.chunk=null;this.offset=0;this.done=false;}
  async readExact(n){const out=new Uint8Array(n);let p=0;while(p<n){if(!this.chunk||this.offset>=this.chunk.length){const next=await this.reader.read();if(next.done)throw new Error(`Unexpected end of REVEX geometry stream (${p}/${n} bytes).`);this.chunk=next.value;this.offset=0;}const take=Math.min(n-p,this.chunk.length-this.offset);out.set(this.chunk.subarray(this.offset,this.offset+take),p);this.offset+=take;p+=take;}return out;}
  async u8(){return (await this.readExact(1))[0];}
  async i32(){const b=await this.readExact(4);return new DataView(b.buffer).getInt32(0,true);}
  async f64(){const b=await this.readExact(8);return new DataView(b.buffer).getFloat64(0,true);}
}
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
class Viewer{
  constructor(host){
    this.host=host;this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0x101319);this.camera=new THREE.PerspectiveCamera(50,1,.01,1e8);
    this.embedded=!!window.chrome?.webview;
    this.renderer=new THREE.WebGLRenderer({antialias:!this.embedded,powerPreference:this.embedded?'default':'high-performance'});this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,this.embedded?1:1.25));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.05;this.renderer.localClippingEnabled=true;host.append(this.renderer.domElement);
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.enableDamping=false;this.controls.screenSpacePanning=true;this.controls.mouseButtons.LEFT=THREE.MOUSE.ROTATE;this.controls.mouseButtons.MIDDLE=THREE.MOUSE.PAN;this.controls.mouseButtons.RIGHT=THREE.MOUSE.PAN;this.controls.addEventListener('change',()=>this.requestRender());
    this.scene.add(new THREE.HemisphereLight(0xdbe9f5,0x28323b,2.0));const sun=new THREE.DirectionalLight(0xffffff,2.0);sun.position.set(18,28,14);this.scene.add(sun);
    this.model=null;this.bounds=null;this.data=null;this.byId=new Map();this.byUid=new Map();this.materialByName=new Map();this.materialById=new Map();this.materialCache=new Map();this.helper=null;this.section={enabled:false,x:1,y:1,z:1};this.walk=false;this.floor=0;this.eye=5.5;this.yaw=0;this.pitch=0;this.keys=new Set();this.drag=false;this.last=null;this.walkFrame=0;this.lastStep=0;this.renderFrame=0;this.spatial=null;this.loadToken=0;this.active=true;this.sourceState=null;this.detailLoaded=false;this.detailLoading=false;this.proxyReady=false;
    this.ray=new THREE.Raycaster();this.pointer=new THREE.Vector2();this.overlays=new Map();this.editGroups=new Map();this.elementNodes=new Map();this.overlayRevision='';
    this.renderer.domElement.addEventListener('click',e=>{if(!this.walk)this.pick(e)});
    this.renderer.domElement.addEventListener('pointerdown',e=>{if(this.walk){this.drag=true;this.last=[e.clientX,e.clientY];this.renderer.domElement.setPointerCapture?.(e.pointerId)}});
    this.renderer.domElement.addEventListener('pointermove',e=>{if(!this.walk||!this.drag||!this.last)return;const dx=e.clientX-this.last[0],dy=e.clientY-this.last[1];this.last=[e.clientX,e.clientY];this.yaw-=dx*.004;this.pitch=Math.max(-1.35,Math.min(1.35,this.pitch-dy*.003));this.look();this.requestRender()});
    this.renderer.domElement.addEventListener('pointerup',()=>{this.drag=false;this.last=null});
    addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(this.walk&&'wasdqe'.includes(k)){this.keys.add(k);e.preventDefault();this.startWalkFrames()}});
    addEventListener('keyup',e=>{this.keys.delete(e.key.toLowerCase())});
    new ResizeObserver(()=>this.resize()).observe(host);this.resize();
  }
  requestRender(){if(this.renderFrame||document.hidden||!this.active)return;this.renderFrame=requestAnimationFrame(()=>{this.renderFrame=0;this.renderer.render(this.scene,this.camera);this.updatePins()})}
  resize(){const w=Math.max(this.host.clientWidth,1),h=Math.max(this.host.clientHeight,1);this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.requestRender()}
  setActive(active){this.active=!!active;if(!this.active){this.walk=false;this.keys.clear();if(this.walkFrame){cancelAnimationFrame(this.walkFrame);this.walkFrame=0}}else this.requestRender();if(this.sourceState?.modelUrl&&!this.detailLoaded&&!this.detailLoading)setTimeout(()=>this.loadDetailed(),this.active?20:180)}
  raw(v){const p=v||[0,0,0];return new THREE.Vector3(+p[0]||0,+p[2]||0,-(+p[1]||0))}
  box(row){if(!row?.bbox?.min||!row?.bbox?.max)return null;const b=new THREE.Box3();b.makeEmpty();for(const x of[row.bbox.min[0],row.bbox.max[0]])for(const y of[row.bbox.min[1],row.bbox.max[1]])for(const z of[row.bbox.min[2],row.bbox.max[2]])b.expandByPoint(this.raw([x,y,z]));return b}
  metaBounds(){const b=new THREE.Box3();b.makeEmpty();for(const r of this.data?.elements||[]){const x=this.box(r);if(x)b.union(x)}return b.isEmpty()?null:b}
  keyText(n){return `${n?.name||''} ${n?.parent?.name||''}`.toLowerCase()}
  elementForNode(n){const key=this.keyText(n);for(const id of key.match(/\b\d{4,}\b/g)||[]){const hit=this.byId.get(String(+id));if(hit)return hit}for(const token of key.split(/[^a-z0-9-]+/i)){if(token.length<16)continue;const hit=this.byUid.get(token)||this.byUid.get(token.toLowerCase());if(hit)return hit}return null}

  axisRotations(){
    if(this._axisRotations)return this._axisRotations;
    const axes=[new THREE.Vector3(1,0,0),new THREE.Vector3(-1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,-1,0),new THREE.Vector3(0,0,1),new THREE.Vector3(0,0,-1)],out=[];
    for(const x of axes)for(const y of axes){if(Math.abs(x.dot(y))>.001)continue;const z=new THREE.Vector3().crossVectors(x,y);if(z.lengthSq()<.9)continue;out.push(new THREE.Matrix4().makeBasis(x,y,z));}
    this._axisRotations=out;return out;
  }
  fitAnchors(anchors){
    if(anchors.length<3)return null;let best=null;
    for(const matrix of this.axisRotations()){
      const src=anchors.map(a=>a.source.clone().applyMatrix4(matrix)),sc=new THREE.Vector3(),tc=new THREE.Vector3();
      src.forEach(p=>sc.add(p));anchors.forEach(a=>tc.add(a.target));sc.multiplyScalar(1/src.length);tc.multiplyScalar(1/src.length);
      let numerator=0,denominator=0;for(let i=0;i<src.length;i++){const a=src[i].clone().sub(sc),b=anchors[i].target.clone().sub(tc);numerator+=a.dot(b);denominator+=a.lengthSq();}
      const scale=denominator>1e-9?numerator/denominator:1;if(!Number.isFinite(scale)||scale<=1e-9)continue;
      const offset=tc.clone().sub(sc.clone().multiplyScalar(scale));let sum=0;for(let i=0;i<src.length;i++)sum+=src[i].clone().multiplyScalar(scale).add(offset).distanceToSquared(anchors[i].target);
      const rms=Math.sqrt(sum/src.length);if(!best||rms<best.rms)best={matrix:matrix.clone(),scale,offset,rms};
    }
    return best;
  }
  fitBounds(root,target){
    const source=new THREE.Box3().setFromObject(root),corners=[];for(const x of[source.min.x,source.max.x])for(const y of[source.min.y,source.max.y])for(const z of[source.min.z,source.max.z])corners.push(new THREE.Vector3(x,y,z));
    const ts=target.getSize(new THREE.Vector3());let best=null;
    for(const matrix of this.axisRotations()){
      const box=new THREE.Box3();box.makeEmpty();corners.forEach(p=>box.expandByPoint(p.clone().applyMatrix4(matrix)));const ss=box.getSize(new THREE.Vector3());
      const ratios=[ts.x/Math.max(ss.x,1e-9),ts.y/Math.max(ss.y,1e-9),ts.z/Math.max(ss.z,1e-9)].filter(v=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b);const scale=ratios[1]||1;
      const error=Math.abs(Math.log(Math.max(ts.x,1e-9)/Math.max(ss.x*scale,1e-9)))+Math.abs(Math.log(Math.max(ts.y,1e-9)/Math.max(ss.y*scale,1e-9)))+Math.abs(Math.log(Math.max(ts.z,1e-9)/Math.max(ss.z*scale,1e-9)));
      const sc=box.getCenter(new THREE.Vector3()),tc=target.getCenter(new THREE.Vector3()),offset=tc.clone().sub(sc.multiplyScalar(scale));if(!best||error<best.rms)best={matrix:matrix.clone(),scale,offset,rms:error};
    }
    return best;
  }
  registerFixed(root,target){
    root.position.set(0,0,0);root.quaternion.identity();root.scale.setScalar(1);root.updateMatrixWorld(true);
    const anchors=[];root.traverse(n=>{if(!n.isMesh||anchors.length>=192)return;const row=this.elementForNode(n),tb=this.box(row);if(!tb)return;const sb=new THREE.Box3().setFromObject(n);if(!sb.isEmpty())anchors.push({source:sb.getCenter(new THREE.Vector3()),target:tb.getCenter(new THREE.Vector3())})});
    const fit=this.fitAnchors(anchors)||this.fitBounds(root,target);if(!fit)return;
    root.quaternion.setFromRotationMatrix(fit.matrix);root.scale.setScalar(fit.scale);root.position.copy(fit.offset);root.updateMatrixWorld(true);
    console.info('[REVEX] Revit/FBX registration',{anchors:anchors.length,scale:fit.scale,rms:fit.rms,quaternion:[root.quaternion.x,root.quaternion.y,root.quaternion.z,root.quaternion.w]});
  }

  pruneFloating(root,target){const size=target.getSize(new THREE.Vector3()),pad=Math.max(size.length()*.05,2),keep=target.clone().expandByScalar(pad);let hidden=0;root.updateMatrixWorld(true);root.traverse(n=>{if(!n.isMesh)return;const name=this.keyText(n);if(/\b(camera|cameras|grid|grids|level|levels|reference plane|scope box|section marker|elevation marker|model line|detail line|sketch line|reference point)\b/.test(name)){n.visible=false;hidden++;return}const b=new THREE.Box3().setFromObject(n);if(!b.isEmpty()&&!b.intersectsBox(keep)){n.visible=false;hidden++;}});if(hidden)console.info('[REVEX] hidden non-model/outlier FBX nodes',{hidden})}
  descriptor(r){if(!r)return null;const mats=(r.materials||[]).filter(m=>Array.isArray(m.color)&&m.color.length>=3);const m=mats.find(x=>String(x.name||'').trim())||mats[0];let c=null,o=1,name='';if(m){c=new THREE.Color();c.setRGB((+m.color[0]||0)/255,(+m.color[1]||0)/255,(+m.color[2]||0)/255,THREE.SRGBColorSpace);o=Math.max(.05,1-(+m.transparency||0)/100);name=m.name||''}else{c=new THREE.Color(PALETTE[r.categoryKey]||PALETTE.other);if(r.categoryKey==='windows')o=.48}return{c,o,name,row:r}}
  materialFor(materialId,row){const id=String(Math.trunc(+materialId||-1)),cacheKey=id!=='-1'?`m:${id}`:`c:${row?.categoryKey||'other'}`;if(this.materialCache.has(cacheKey))return this.materialCache.get(cacheKey);const hit=this.materialById.get(id);const d=hit?this.descriptor({...row,materials:[hit.material]}):this.descriptor(row)||{c:new THREE.Color(PALETTE.other),o:1};const opacity=Math.max(.04,Math.min(1,d.o??1));const m=new THREE.MeshStandardMaterial({color:d.c||new THREE.Color(PALETTE.other),roughness:.68,metalness:.04,opacity,transparent:opacity<.995,depthWrite:opacity>.72,side:row?.categoryKey==='windows'?THREE.DoubleSide:THREE.FrontSide});this.materialCache.set(cacheKey,m);return m;}
  buildSpatial(){const target=this.bounds;if(!target)return;const size=target.getSize(new THREE.Vector3()),cell=Math.max(size.x,size.y,size.z)/24||1,min=target.min.clone(),map=new Map();const key=p=>`${Math.floor((p.x-min.x)/cell)},${Math.floor((p.y-min.y)/cell)},${Math.floor((p.z-min.z)/cell)}`;for(const r of this.data?.elements||[]){const b=this.box(r);if(!b)continue;const c=b.getCenter(new THREE.Vector3()),k=key(c);if(!map.has(k))map.set(k,[]);map.get(k).push(r)}this.spatial={cell,min,map,key}}
  nearestRow(point){if(!this.spatial)return null;const {cell,min,map}=this.spatial,ix=Math.floor((point.x-min.x)/cell),iy=Math.floor((point.y-min.y)/cell),iz=Math.floor((point.z-min.z)/cell);let best=null,d=Infinity;for(let radius=0;radius<=2&&!best;radius++)for(let x=ix-radius;x<=ix+radius;x++)for(let y=iy-radius;y<=iy+radius;y++)for(let z=iz-radius;z<=iz+radius;z++){const rows=map.get(`${x},${y},${z}`)||[];for(const r of rows){const b=this.box(r);if(!b)continue;const q=b.distanceToPoint(point);if(q<d){d=q;best=r}}}return best}
  applyMaterials(root){this.buildSpatial();let mapped=0;root.updateMatrixWorld(true);root.traverse(n=>{if(!n.isMesh||!n.visible)return;let row=this.elementForNode(n);if(!row){const b=new THREE.Box3().setFromObject(n);if(!b.isEmpty())row=this.nearestRow(b.getCenter(new THREE.Vector3()))}let d=this.descriptor(row);const arr=Array.isArray(n.material)?n.material:[n.material];if(!d){for(const native of arr){const hit=this.materialByName.get(String(native?.name||'').trim().toLowerCase());if(hit){d=this.descriptor({...hit.row,materials:[hit]});break}}}if(!d)return;const next=arr.filter(Boolean).map(m=>{const x=m.clone?.()||m;if(x.color&&d.c)x.color.copy(d.c);x.opacity=d.o;x.transparent=d.o<.995;if('roughness'in x)x.roughness=Math.max(.35,Math.min(.9,x.roughness??.62));if('metalness'in x)x.metalness=Math.min(x.metalness??0,.25);x.needsUpdate=true;return x});if(next.length)n.material=Array.isArray(n.material)?next:next[0];mapped++});console.info('[REVEX] Revit material mapping',{mapped})}
  disposeObject(root,{disposeMaterials=true}={}){if(!root)return;const seen=new Set();root.traverse?.(n=>{n.geometry?.dispose?.();if(!disposeMaterials)return;for(const m of(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean)){if(seen.has(m))continue;seen.add(m);m.dispose?.()}})}
  clearEditGroups(){
    for(const group of this.editGroups.values()){
      this.resetEditGroup(group);
      for(const node of group.userData.revexNodes||[]){
        const parent=node.userData.revexOriginalParent;
        if(parent?.attach)parent.attach(node);
        delete node.userData.revexOriginalParent;
        delete node.userData.revexBaseMaterials;
      }
      this.scene.remove(group);
      group.clear();
    }
    this.editGroups.clear();this.elementNodes.clear();
  }
  clear(){this.clearEditGroups();if(this.model){this.scene.remove(this.model);this.disposeObject(this.model);this.model=null}if(this.helper){this.scene.remove(this.helper);this.helper=null}this.materialCache.clear()}
  async load(state,preloadedSource=null){
    const token=++this.loadToken,msg=$('#viewer-message');this.sourceState=state||null;this.detailLoaded=false;this.detailLoading=false;this.proxyReady=false;
    if(msg){msg.hidden=false;msg.classList.remove('fallback');msg.textContent='Loading BIM index…'}
    const source=preloadedSource||await Store.fetchJson(state?.viewerUrl);if(token!==this.loadToken)return;
    const rows=(source?.elements||[]).filter(usableRow),data={...source,elements:rows};this.data=data;this.byId=new Map(rows.map(r=>[String(r.id),r]));this.byUid=new Map();for(const r of rows){if(r.uniqueId){this.byUid.set(String(r.uniqueId),r);this.byUid.set(String(r.uniqueId).toLowerCase(),r)}}this.materialByName=new Map();this.materialById=new Map();this.materialCache=new Map();for(const row of rows)for(const m of row.materials||[]){const k=String(m.name||'').trim().toLowerCase();if(k&&!this.materialByName.has(k))this.materialByName.set(k,{...m,row});const id=String(m.id??'');if(id&&!this.materialById.has(id))this.materialById.set(id,{material:m,row});}
    const target=this.metaBounds();this.clear();this.bounds=target;this.buildSpatial();
    if(target&&rows.length){this.model=this.proxy(rows);this.scene.add(this.model);this.proxyReady=true;this.indexElementNodes(this.model);this.applyOverlays();this.sectionApply();this.fit();this.floors();this.requestRender()}
    const detailButton=$('#detail-toggle');if(detailButton){detailButton.disabled=!state?.modelUrl;detailButton.textContent=state?.modelUrl?'Loading…':'No model';detailButton.classList.toggle('active',Boolean(state?.modelUrl))}
    if(msg){msg.hidden=!state?.modelUrl;msg.textContent=state?.modelUrl?'Loading exact Revit geometry…':'BIM index ready.'}
    console.info('[REVEX] viewer '+BUILD,{elements:rows.length,levels:data.levels?.length||0,mode:'metadata-index',exactGeometry:state?.modelFormat||data?.geometry?.displayFormat||null,onDemand:true,embedded:this.embedded});
    if(state?.modelUrl)setTimeout(()=>{if(token===this.loadToken)this.loadDetailed()},this.active?24:180);
  }
  async loadDetailed(){
    if(this.detailLoaded||this.detailLoading||!this.sourceState?.modelUrl)return this.detailLoaded;
    const token=this.loadToken,msg=$('#viewer-message'),button=$('#detail-toggle');this.detailLoading=true;if(button){button.disabled=true;button.textContent='Loading…';button.classList.add('active')}if(msg){msg.hidden=false;msg.classList.remove('fallback');msg.textContent='Loading exact Revit geometry…'}
    try{
      await new Promise(resolve=>setTimeout(resolve,16));
      const format=this.sourceState?.modelFormat||this.data?.geometry?.displayFormat||(String(this.sourceState.modelUrl).includes('rvxmesh')?'rvxmesh-gzip':'fbx');
      let root=null,stats=null;
      let installedProgressively=false;
      if(format==='rvxmesh-gzip-pages'){
        const pages=(this.sourceState?.modelPages||[]).filter(page=>page?.url);
        if(!pages.length)throw new Error('The paged BIM revision has no immutable geometry page URLs.');
        ({root,stats}=await this.loadRvxPages(pages,token,msg,(staging,pageStats)=>{
          if(installedProgressively||token!==this.loadToken)return;
          const old=this.model;this.clearEditGroups();if(old){this.scene.remove(old);this.disposeObject(old,{disposeMaterials:this.proxyReady})}
          this.model=staging;this.scene.add(staging);this.proxyReady=false;installedProgressively=true;this.indexElementNodes(staging);this.applyOverlays();this.sectionApply();this.requestRender();
          if(msg)msg.textContent=`Current revision visible · loading ${pageStats.total-pageStats.loaded} remaining geometry page(s) in background…`;
        }));
      }else if(format==='rvxmesh-gzip'){
        try{({root,stats}=await this.loadRvxMesh(this.sourceState.modelUrl,token,msg));}
        catch(e){console.warn('[REVEX r26] RVX mesh load failed',e);if(this.sourceState?.fallbackModelUrl){if(msg)msg.textContent='Native stream unavailable; loading compatibility geometry…';({root,stats}=await this.loadFbx(this.sourceState.fallbackModelUrl,token,msg));}else throw e;}
      }else ({root,stats}=await this.loadFbx(this.sourceState.modelUrl,token,msg));
      if(token!==this.loadToken){this.disposeObject(root);return false}
      if(!root)throw new Error('Detailed BIM geometry could not be parsed.');
      if(!installedProgressively){const old=this.model;this.clearEditGroups();if(old){this.scene.remove(old);this.disposeObject(old,{disposeMaterials:this.proxyReady})}this.model=root;this.scene.add(root)}
      this.bounds=this.metaBounds()||new THREE.Box3().setFromObject(root);this.indexElementNodes(this.scene);this.applyOverlays();this.sectionApply();this.floors();this.detailLoaded=true;this.proxyReady=false;this.requestRender();if(msg)msg.hidden=true;if(button){button.classList.add('active');button.textContent='Model'}window.dispatchEvent(new CustomEvent('revex:viewer-mode',{detail:{mode:stats?.format||format,stats}}));console.info('[REVEX] exact BIM '+BUILD,stats||{});return true;
    }catch(e){console.warn('[REVEX r26] detail load',e);if(msg){msg.hidden=false;msg.classList.add('fallback');msg.textContent='Exact BIM geometry could not load. The physical metadata model remains available.'}if(button){button.classList.remove('active');button.textContent='Retry'}return false}
    finally{this.detailLoading=false;if(button)button.disabled=!this.sourceState?.modelUrl}
  }
  async loadRvxMesh(url,token,msg){
    if(typeof DecompressionStream==='undefined')throw new Error('This browser does not support streaming gzip decompression.');
    const response=await this.fetchGeometry(url,'REVEX geometry');
    const reader=response.body.pipeThrough(new DecompressionStream('gzip')).getReader(),bytes=new StreamBytes(reader),decoder=new TextDecoder();
    const magic=decoder.decode(await bytes.readExact(8));if(!magic.startsWith('RVXSCN2'))throw new Error('REVEX geometry stream has an invalid header.');const version=await bytes.i32();if(version!==2)throw new Error(`Unsupported REVEX geometry version ${version}.`);
    const root=new THREE.Group();root.name='REVEX_EXACT_MODEL';let elements=0,parts=0,vertices=0;const expected=Number(this.data?.geometry?.highDetail?.elements||0),seen=new Set();
    while(true){if(token!==this.loadToken){await reader.cancel();return{root:null,stats:null}}const type=await bytes.u8();if(type===0)break;if(type!==1)throw new Error(`Unknown REVEX geometry record ${type}.`);const elementId=String(Math.trunc(await bytes.f64())),partCount=await bytes.i32(),row=this.byId.get(elementId);seen.add(elementId);for(let i=0;i<partCount;i++){const materialId=await bytes.f64(),vertexCount=await bytes.i32();if(vertexCount<0||vertexCount>50000000)throw new Error(`Invalid REVEX vertex count ${vertexCount}.`);const raw=await bytes.readExact(vertexCount*6*4),floats=new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4),ib=new THREE.InterleavedBuffer(floats,6),g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.InterleavedBufferAttribute(ib,3,0,false));g.setAttribute('normal',new THREE.InterleavedBufferAttribute(ib,3,3,false));g.computeBoundingSphere();const mesh=new THREE.Mesh(g,this.materialFor(materialId,row));mesh.name=`REVEX_${elementId}`;mesh.userData.revexElementId=elementId;mesh.frustumCulled=true;root.add(mesh);parts++;vertices+=vertexCount;}elements++;if(elements%24===0){if(msg)msg.textContent=`Loading exact Revit geometry · ${elements.toLocaleString()}${expected?` / ${expected.toLocaleString()}`:''} elements`;await nextFrame();}}
    const missingRows=(this.data?.elements||[]).filter(r=>!seen.has(String(r.id)));if(missingRows.length){const fallback=this.proxy(missingRows);fallback.name='REVEX_MISSING_GEOMETRY_PROXY';fallback.userData.revexFallbackOnly=true;root.add(fallback);console.warn('[REVEX r26] exact geometry missing for physical metadata rows; retaining bounded fallback only for those rows',{missing:missingRows.length,total:this.data?.elements?.length||0});}
    return{root,stats:{format:'rvxmesh',elements,parts,vertices,triangles:Math.floor(vertices/3),missing:missingRows.length,coverage:(this.data?.elements?.length||0)?elements/(this.data.elements.length):1,streamed:true}};
  }
  async loadRvxPages(pages,token,msg,onFirst){
    const root=new THREE.Group();root.name='REVEX_CURRENT_PAGED_MODEL';const seen=new Set();let elements=0,parts=0,vertices=0;
    for(let index=0;index<pages.length;index++){
      if(token!==this.loadToken)return{root:null,stats:null};
      const page=pages[index];if(msg)msg.textContent=`Loading current BIM geometry · page ${index+1} / ${pages.length}`;
      const parsed=await this.loadRvxPageInto(page.url,root,seen,token);elements+=parsed.elements;parts+=parsed.parts;vertices+=parsed.vertices;
      if(index===0)onFirst?.(root,{loaded:1,total:pages.length});
      if(this.active)await nextFrame();else await new Promise(resolve=>setTimeout(resolve,120));
    }
    const missingRows=(this.data?.elements||[]).filter(row=>!seen.has(String(row.id)));if(missingRows.length){const fallback=this.proxy(missingRows);fallback.name='REVEX_PAGED_MISSING_GEOMETRY_PROXY';fallback.userData.revexFallbackOnly=true;root.add(fallback);console.warn('[REVEX r49] paged geometry retained bounded fallback only for unsupported physical rows',{missing:missingRows.length,total:this.data?.elements?.length||0});}
    return{root,stats:{format:'rvxmesh-pages',pages:pages.length,elements,parts,vertices,triangles:Math.floor(vertices/3),missing:missingRows.length,coverage:(this.data?.elements?.length||0)?elements/this.data.elements.length:1,streamed:true,backgroundContinued:true}};
  }
  async fetchGeometry(url,label){let last=null;for(let attempt=1;attempt<=3;attempt++){try{const response=await fetch(url,{cache:'no-store'});if(response.ok&&response.body)return response;last=new Error(`${label} fetch failed (${response.status}).`)}catch(error){last=error}if(attempt<3)await new Promise(resolve=>setTimeout(resolve,attempt*350));}throw last||new Error(`${label} fetch failed.`)}
  async loadRvxPageInto(url,root,seen,token){
    if(typeof DecompressionStream==='undefined')throw new Error('This browser does not support streaming gzip decompression.');
    const response=await this.fetchGeometry(url,'REVEX geometry page');
    const reader=response.body.pipeThrough(new DecompressionStream('gzip')).getReader(),bytes=new StreamBytes(reader),decoder=new TextDecoder();
    const magic=decoder.decode(await bytes.readExact(8));if(!magic.startsWith('RVXSCN2'))throw new Error('REVEX geometry page has an invalid header.');const version=await bytes.i32();if(version!==2)throw new Error(`Unsupported REVEX geometry version ${version}.`);
    let elements=0,parts=0,vertices=0;
    while(true){if(token!==this.loadToken){await reader.cancel();return{elements,parts,vertices}}const type=await bytes.u8();if(type===0)break;if(type!==1)throw new Error(`Unknown REVEX geometry record ${type}.`);const elementId=String(Math.trunc(await bytes.f64())),partCount=await bytes.i32(),row=this.byId.get(elementId);seen.add(elementId);for(let i=0;i<partCount;i++){const materialId=await bytes.f64(),vertexCount=await bytes.i32();if(vertexCount<0||vertexCount>50000000)throw new Error(`Invalid REVEX vertex count ${vertexCount}.`);const raw=await bytes.readExact(vertexCount*6*4),floats=new Float32Array(raw.buffer,raw.byteOffset,raw.byteLength/4),ib=new THREE.InterleavedBuffer(floats,6),g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.InterleavedBufferAttribute(ib,3,0,false));g.setAttribute('normal',new THREE.InterleavedBufferAttribute(ib,3,3,false));g.computeBoundingSphere();const mesh=new THREE.Mesh(g,this.materialFor(materialId,row));mesh.name=`REVEX_${elementId}`;mesh.userData.revexElementId=elementId;mesh.frustumCulled=true;root.add(mesh);parts++;vertices+=vertexCount;}elements++;}
    return{elements,parts,vertices};
  }
  async loadFbx(url,token,msg){
    let obj=await new Promise((res,rej)=>new FBXLoader().load(url,res,p=>{if(msg&&p.total)msg.textContent=`Loading compatibility geometry · ${Math.round(p.loaded/p.total*100)}%`;},rej));if(token!==this.loadToken)return{root:null,stats:null};let meshCount=0,vertexCount=0;obj.traverse(n=>{if(!n.isMesh)return;meshCount++;vertexCount+=n.geometry?.attributes?.position?.count||0});const root=new THREE.Group();root.add(obj);const target=this.bounds;if(target)this.registerFixed(root,target);if(meshCount<4000&&target)this.pruneFloating(root,target);if(meshCount<3500)this.applyMaterials(root);return{root,stats:{format:'fbx',meshCount,vertices:vertexCount,streamed:false}};
  }


  stableKey(row){return String(row?.uniqueId||row?.id||'')}
  cameraState(){return{position:this.camera.position.toArray(),quaternion:this.camera.quaternion.toArray(),fov:this.camera.fov,target:this.controls?.target?.toArray?.()||null,walk:this.walk,floor:this.floor,eye:this.eye}}
  snapshot(){try{this.renderer.render(this.scene,this.camera);return this.renderer.domElement.toDataURL('image/png')}catch(_){return ''}}
  setOverlays(rows){this.overlays=new Map((rows||[]).map(o=>[String(o.uniqueId||o.elementId||o.id),o]));this.applyOverlays()}
  indexElementNodes(root){this.elementNodes=new Map();root?.traverse?.(n=>{if(!n.isMesh||!n.visible)return;const explicit=String(n.userData?.revexElementId||''),row=(explicit&&this.byId.get(explicit))||this.elementForNode(n);if(!row)return;const key=this.stableKey(row);if(!key)return;if(!this.elementNodes.has(key))this.elementNodes.set(key,[]);this.elementNodes.get(key).push(n);});}
  ensureEditGroup(row){const key=this.stableKey(row);if(!key)return null;if(this.editGroups.has(key))return this.editGroups.get(key);const nodes=this.elementNodes.get(key)||[];if(!nodes.length)return null;const box=this.box(row);if(!box)return null;const center=box.getCenter(new THREE.Vector3());const group=new THREE.Group();group.name='REVEX_EDIT_'+key;group.position.copy(center);this.scene.add(group);nodes.forEach(n=>{if(!n.userData.revexBaseMaterials)n.userData.revexBaseMaterials=(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean);if(!n.userData.revexOriginalParent)n.userData.revexOriginalParent=n.parent;group.attach(n)});group.userData.revexBaseCenter=center.clone();group.userData.revexNodes=nodes;this.editGroups.set(key,group);return group;}
  resetEditGroup(group){const c=group?.userData?.revexBaseCenter;if(!group||!c)return;group.position.copy(c);group.rotation.set(0,0,0);group.scale.set(1,1,1);group.visible=true;for(const n of group.userData.revexNodes||[]){const base=n.userData.revexBaseMaterials;if(base?.length){const current=(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean);for(const material of current)if(material.userData?.revexOverlayMaterial)material.dispose?.();n.material=Array.isArray(n.material)?[...base]:base[0]}}}
  applyOverlayTo(row,overlay){const group=this.ensureEditGroup(row);if(!group)return false;this.resetEditGroup(group);const tr=overlay?.transform||{};const delta=this.raw([+tr.x||0,+tr.y||0,+tr.z||0]);group.position.add(delta);group.rotation.y=(+tr.rotateZ||0)*Math.PI/180;group.visible=!(overlay?.hidden||overlay?.deleted);const color=overlay?.material?.color,opacity=overlay?.material?.opacity;if(color||opacity!=null){for(const n of group.userData.revexNodes||[]){const base=n.userData.revexBaseMaterials||[];const next=base.map(source=>{const m=source.clone?.()||source;m.userData={...(m.userData||{}),revexOverlayMaterial:true};if(color&&m.color)m.color.set(color);if(opacity!=null){m.opacity=Math.max(.05,Math.min(1,+opacity));m.transparent=m.opacity<.995}m.needsUpdate=true;return m});if(next.length)n.material=Array.isArray(n.material)?next:next[0]}}return true;}
  applyOverlays(){if(!this.data)return;for(const [key,group] of this.editGroups)this.resetEditGroup(group);for(const row of this.data.elements||[]){const key=this.stableKey(row),overlay=this.overlays.get(key)||this.overlays.get(String(row.id));if(overlay)this.applyOverlayTo(row,overlay)}this.requestRender()}
  canTransform(row){return Boolean(this.elementNodes.get(this.stableKey(row))?.length)}
  captureTopPlan(levelName=''){try{const rows=(this.data?.elements||[]).filter(r=>usableRow(r)&&(!levelName||String(r.level||'')===String(levelName)));const box=new THREE.Box3();box.makeEmpty();rows.forEach(r=>{const b=this.box(r);if(b)box.union(b)});if(box.isEmpty()){if(this.bounds)box.copy(this.bounds);else return ''}const size=box.getSize(new THREE.Vector3()),c=box.getCenter(new THREE.Vector3()),aspect=Math.max(this.host.clientWidth,1)/Math.max(this.host.clientHeight,1),half=Math.max(size.x,size.z)*.58;const cam=new THREE.OrthographicCamera(-half*aspect,half*aspect,half,-half,-100000,100000);cam.position.set(c.x,box.max.y+Math.max(size.y,10)+10,c.z);cam.up.set(0,0,-1);cam.lookAt(c.x,c.y,c.z);this.renderer.render(this.scene,cam);const png=this.renderer.domElement.toDataURL('image/png');this.requestRender();return png}catch(e){console.warn('[REVEX r26] plan capture',e);this.requestRender();return ''}}
  proxy(rows){const root=new THREE.Group(),geometry=new THREE.BoxGeometry(1,1,1),materials=new Map();for(const r of rows){const d=this.descriptor(r),key=d?.name||r.typeUniqueId||r.categoryKey||'other';if(!materials.has(key))materials.set(key,new THREE.MeshStandardMaterial({color:d?.c||PALETTE.other,roughness:.75,opacity:d?.o??.9,transparent:(d?.o??1)<.995}));const b=this.box(r);if(!b)continue;const mesh=new THREE.Mesh(geometry,materials.get(key)),center=b.getCenter(new THREE.Vector3()),size=b.getSize(new THREE.Vector3()).max(new THREE.Vector3(.02,.02,.02));mesh.position.copy(center);mesh.scale.copy(size);mesh.name=`REVEX_PROXY_${r.id}`;mesh.userData.revexElementId=String(r.id);root.add(mesh)}return root}
  fit(box=this.bounds){if(!box||box.isEmpty())return;this.walk=false;this.keys.clear();this.controls.enabled=true;const c=box.getCenter(new THREE.Vector3()),s=Math.max(box.getSize(new THREE.Vector3()).length(),.1);this.controls.target.copy(c);this.camera.position.copy(c).add(new THREE.Vector3(s*.58,s*.45,s*.58));this.camera.near=Math.max(s/10000,.01);this.camera.far=Math.max(s*20,2000);this.camera.updateProjectionMatrix();this.camera.lookAt(c);this.requestRender()}
  select(r){if(this.helper)this.scene.remove(this.helper);const g=this.editGroups.get(this.stableKey(r));const b=g?new THREE.Box3().setFromObject(g):this.box(r);if(!b||b.isEmpty())return;this.helper=new THREE.Box3Helper(b,0xff2f6e);this.scene.add(this.helper);this.requestRender()}
  pick(e){if(!this.model)return;const rect=this.renderer.domElement.getBoundingClientRect();this.pointer.set((e.clientX-rect.left)/rect.width*2-1,-((e.clientY-rect.top)/rect.height*2-1));this.ray.setFromCamera(this.pointer,this.camera);const h=this.ray.intersectObject(this.model,true).find(x=>x.object.visible!==false);if(!h)return;let node=h.object,best=null;while(node&&!best){const id=String(node.userData?.revexElementId||'');if(id)best=this.byId.get(id)||null;node=node.parent}if(!best)best=this.nearestRow(h.point);if(best)this.selectAndRoute(best)}
  selectAndRoute(r){this.select(r);let btn=$(`.tree-item[data-element-id="${CSS.escape(String(r.id))}"]`);if(!btn){const q=$('#element-search');if(q){q.value=String(r.id);q.dispatchEvent(new Event('input',{bubbles:true}));btn=$(`.tree-item[data-element-id="${CSS.escape(String(r.id))}"]`)}}btn?.click()}
  floors(){const s=$('#walk-floor'),ls=this.data?.levels||[];if(!s)return;s.innerHTML='<option value="">Floor</option>'+ls.map(l=>`<option value="${+l.elevation||0}">${String(l.name||'Level').replace(/[&<>]/g,'')}</option>`).join('');if(ls.length){const f=ls.find(l=>/1st|first|ground|level 1/i.test(l.name||''))||ls[0];s.value=String(+f.elevation||0);this.floor=+f.elevation||0}}
  walkOn(on){if(!this.bounds)return;this.walk=on;this.controls.enabled=!on;this.keys.clear();if(on){const target=this.controls.target.clone(),dir=new THREE.Vector3();this.camera.getWorldDirection(dir);this.camera.position.set(target.x,this.floor+this.eye,target.z);this.yaw=Math.atan2(-dir.x,-dir.z);this.pitch=Math.asin(Math.max(-1,Math.min(1,dir.y)));this.look()}else{this.controls.target.copy(this.camera.position.clone().add(new THREE.Vector3(-Math.sin(this.yaw)*12,0,-Math.cos(this.yaw)*12)));this.controls.update()}this.requestRender()}
  look(){const d=new THREE.Vector3(-Math.sin(this.yaw)*Math.cos(this.pitch),Math.sin(this.pitch),-Math.cos(this.yaw)*Math.cos(this.pitch));this.camera.lookAt(this.camera.position.clone().add(d))}
  startWalkFrames(){if(this.walkFrame||!this.walk)return;this.lastStep=performance.now();const tick=now=>{this.walkFrame=0;if(!this.walk||!this.keys.size){this.requestRender();return}const dt=Math.min((now-this.lastStep)/1000,.05);this.lastStep=now;this.step(dt);this.renderer.render(this.scene,this.camera);this.updatePins();this.walkFrame=requestAnimationFrame(tick)};this.walkFrame=requestAnimationFrame(tick)}
  step(dt){const speed=Math.max((this.bounds?.getSize(new THREE.Vector3()).length()||40)/55,2),f=new THREE.Vector3(-Math.sin(this.yaw),0,-Math.cos(this.yaw)),r=new THREE.Vector3(Math.cos(this.yaw),0,-Math.sin(this.yaw)),m=new THREE.Vector3();if(this.keys.has('w'))m.add(f);if(this.keys.has('s'))m.sub(f);if(this.keys.has('d'))m.add(r);if(this.keys.has('a'))m.sub(r);if(this.keys.has('q'))m.y--;if(this.keys.has('e'))m.y++;if(m.lengthSq()){m.normalize().multiplyScalar(speed*dt);this.camera.position.add(m);if(!this.keys.has('q')&&!this.keys.has('e'))this.camera.position.y=this.floor+this.eye;this.look()}}
  updatePins(){const host=$('#issue-pins');if(!host)return;const w=this.host.clientWidth,h=this.host.clientHeight;host.querySelectorAll('.issue-pin').forEach(pin=>{if(this.walk){pin.hidden=true;return}const uid=String(pin.dataset.uniqueId||''),id=String(pin.dataset.elementId||'');const row=(uid&&this.byUid.get(uid))||(id&&this.byId.get(id));const g=row?this.editGroups.get(this.stableKey(row)):null;const b=g?new THREE.Box3().setFromObject(g):this.box(row);if(!b||b.isEmpty()){pin.hidden=true;return}const p=b.getCenter(new THREE.Vector3()).project(this.camera),visible=p.z>=-1&&p.z<=1&&Math.abs(p.x)<=1.08&&Math.abs(p.y)<=1.08;pin.hidden=!visible;if(!visible)return;pin.style.left=`${(p.x*.5+.5)*w}px`;pin.style.top=`${(-p.y*.5+.5)*h}px`})}
  sectionApply(){if(!this.model)return;let p=[];if(this.section.enabled&&this.bounds){const b=this.bounds,s=b.getSize(new THREE.Vector3()),x=b.min.x+s.x*this.section.x,z=b.min.z+s.z*this.section.y,y=b.min.y+s.y*this.section.z;p=[new THREE.Plane(new THREE.Vector3(-1,0,0),x),new THREE.Plane(new THREE.Vector3(0,0,-1),z),new THREE.Plane(new THREE.Vector3(0,-1,0),y)]}this.model.traverse(n=>{if(!n.isMesh)return;(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean).forEach(m=>{m.clippingPlanes=p;m.needsUpdate=true})});this.requestRender()}
}
let v=null;
function sourceStateFrom(detail={}){return detail.localPackage||detail.cloudState||window.__revexState?.cloudState||null}
async function loadFromApp(detail={}){if(!v)return;const source=detail.viewerData||window.__revexState?.viewerData||null,state=sourceStateFrom(detail);if(!source||!state)return;try{await v.load(state,source)}catch(e){console.warn('[REVEX r26 viewer]',e);const msg=$('#viewer-message');if(msg){msg.hidden=false;msg.classList.add('fallback');msg.textContent='BIM index could not load. Design Book and project data remain available.'}}}
function bind(){const host=window.__revexViewerHostR21||$('#viewer');if(!host)return false;if(host.id!=='viewer')return false;v=new Viewer(host);v.setActive(!$('#view-bim')?.hidden);window.__revexViewerR26Instance=v;$('#fit-model')?.addEventListener('click',()=>v.fit());$('#fit-model-rail')?.addEventListener('click',()=>v.fit());$('#detail-toggle')?.addEventListener('click',()=>v.loadDetailed());$('#walk-toggle')?.addEventListener('click',e=>{const on=!e.currentTarget.classList.contains('active');e.currentTarget.classList.toggle('active',on);$('#walk-controls').hidden=!on;v.walkOn(on)});$('#walk-floor')?.addEventListener('change',e=>{v.floor=+e.target.value||0;if(v.walk){v.camera.position.y=v.floor+v.eye;v.requestRender()}});$('#walk-height')?.addEventListener('input',e=>{v.eye=Math.max(2.5,Math.min(9,+e.target.value||5.5));if(v.walk){v.camera.position.y=v.floor+v.eye;v.requestRender()}});$('#walk-fov')?.addEventListener('input',e=>{v.camera.fov=Math.max(30,Math.min(90,+e.target.value||55));v.camera.updateProjectionMatrix();const label=$('#walk-fov-value');if(label)label.textContent=`${Math.round(v.camera.fov)}°`;v.requestRender()});$('#section-toggle')?.addEventListener('click',e=>{v.section.enabled=!v.section.enabled;e.currentTarget.classList.toggle('active',v.section.enabled);e.currentTarget.setAttribute('aria-expanded',String(v.section.enabled));$('#section-controls').hidden=!v.section.enabled;v.sectionApply()});for(const [id,k]of[['section-x','x'],['section-y','y'],['section-z','z']])$('#'+id)?.addEventListener('input',e=>{v.section[k]=(+e.target.value||0)/100;v.sectionApply()});$('#section-reset')?.addEventListener('click',()=>{v.section.x=v.section.y=v.section.z=1;for(const id of['section-x','section-y','section-z'])$('#'+id).value='100';v.sectionApply()});document.addEventListener('click',e=>{const b=e.target.closest?.('.tree-item[data-element-id]');if(b){const r=v.byId.get(String(b.dataset.elementId));if(r)v.select(r)}},true);window.addEventListener('revex:source-revision-loaded',e=>loadFromApp(e.detail||{}));setTimeout(()=>loadFromApp({viewerData:window.__revexState?.viewerData,cloudState:window.__revexState?.cloudState}),0);return true}
const start=()=>{if(bind())return;const fn=()=>{if(bind())window.removeEventListener('revex:viewer-host-ready',fn)};window.addEventListener('revex:viewer-host-ready',fn);setTimeout(()=>bind(),5200)};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
console.log('[REVEX] viewer '+BUILD,{singleRenderer:true,fixedAxes:true,onDemand:true,exactGeometryPrimary:true,walkSharedScene:true,materialIntent:true,duplicateStateFetch:false});
}
