import * as THREE from 'three';
const BUILD='20260811r28';
const NON_MODEL=/^(cameras?|views?|viewports?|sheets?|levels?|grids?|reference planes?|scope boxes?|project information|internal origin|survey point|project base point|sections?|elevations?|callouts?|lines?|model lines?|detail lines?|sketch lines?|analytical nodes?|reference points?|rooms?|spaces?|areas?)$/i;
const NON_PHYSICAL=/(room separation|space separation|area boundary|analytical|lighting.*area|electrical.*area|energy.*area|imported categories|dwg|dxf)/i;
const physicalRow=r=>!!(r?.bbox?.min&&r?.bbox?.max)&&!NON_MODEL.test(String(r.category||'').trim())&&!NON_PHYSICAL.test(String(r.category||''));
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));

function cleanTree(){
  const host=document.getElementById('element-tree'); if(!host)return;
  let hide=false; for(const node of [...host.children]){
    if(node.classList.contains('tree-group')){const label=String(node.textContent||'').split('·')[0].trim();hide=NON_MODEL.test(label)||NON_PHYSICAL.test(label);if(hide)node.remove();continue;}
    if(hide&&node.classList.contains('tree-item'))node.remove();
  }
  const rows=(window.__revexState?.viewerData?.elements||[]).filter(physicalRow),fact=document.querySelector('#model-facts .fact');
  if(fact){const strong=fact.querySelector('strong'),span=fact.querySelector('span');if(strong)strong.textContent=rows.length.toLocaleString();if(span)span.textContent='physical elements';}
}
function watchTree(){cleanTree();const host=document.getElementById('element-tree');if(host&&!host.__revexR28Observer){const obs=new MutationObserver(cleanTree);obs.observe(host,{childList:true,subtree:false});host.__revexR28Observer=obs;}}

function install(v){
  if(v.__revexR28)return;v.__revexR28=true;
  v.renderer.toneMapping=THREE.NoToneMapping;v.renderer.toneMappingExposure=1;

  v.fitBounds=function(root,target){
    const source=new THREE.Box3().setFromObject(root);if(source.isEmpty())return null;
    const ss=source.getSize(new THREE.Vector3()),ts=target.getSize(new THREE.Vector3());
    const ratios=[ts.x/Math.max(ss.x,1e-9),ts.y/Math.max(ss.y,1e-9),ts.z/Math.max(ss.z,1e-9)].filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b);
    const scale=ratios[1]||1,sc=source.getCenter(new THREE.Vector3()),tc=target.getCenter(new THREE.Vector3()),offset=tc.clone().sub(sc.multiplyScalar(scale));
    return{matrix:new THREE.Matrix4().identity(),scale,offset,rms:0,method:'identity-bounds'};
  };
  v.registerFixed=function(root,target){
    root.position.set(0,0,0);root.quaternion.identity();root.scale.setScalar(1);root.updateMatrixWorld(true);
    const anchors=[];root.traverse(n=>{if(!n.isMesh||anchors.length>=256)return;const row=this.elementForNode(n),tb=this.box(row);if(!tb)return;const sb=new THREE.Box3().setFromObject(n);if(!sb.isEmpty())anchors.push({source:sb.getCenter(new THREE.Vector3()),target:tb.getCenter(new THREE.Vector3())})});
    const diag=Math.max(target.getSize(new THREE.Vector3()).length(),1e-6);let fit=null,method='identity-bounds';
    if(anchors.length>=12){const anchored=this.fitAnchors(anchors);if(anchored&&anchored.rms/diag<.015){fit=anchored;method='element-anchors'}}
    if(!fit)fit=this.fitBounds(root,target);if(!fit)return;
    root.quaternion.setFromRotationMatrix(fit.matrix);root.scale.setScalar(fit.scale);root.position.copy(fit.offset);root.updateMatrixWorld(true);
    const e=new THREE.Euler().setFromRotationMatrix(fit.matrix,'YXZ');console.info('[REVEX r28] deterministic FBX registration',{method,anchors:anchors.length,scale:fit.scale,rms:fit.rms,yawDeg:Math.round(THREE.MathUtils.radToDeg(e.y)*100)/100});
  };
  v.pruneFloating=function(root,target){
    const size=target.getSize(new THREE.Vector3()),pad=Math.max(size.length()*.035,1.5),keep=target.clone().expandByScalar(pad);let hidden=0;root.updateMatrixWorld(true);
    root.traverse(n=>{if(!n.isMesh)return;const text=this.keyText(n),row=this.elementForNode(n);if(/\b(camera|grid|level|reference plane|scope box|section marker|elevation marker|model line|detail line|sketch line|reference point|room separation|space separation|area boundary|analytical|dwg|dxf|import)\b/i.test(text)||(row&&!physicalRow(row))){n.visible=false;hidden++;return}const b=new THREE.Box3().setFromObject(n);if(!b.isEmpty()&&!b.intersectsBox(keep)){n.visible=false;hidden++;}});
    if(hidden)console.info('[REVEX r28] hidden nonphysical/outlier FBX nodes',{hidden});
  };
  v.applyMaterials=function(root){
    let exact=0,nativeKept=0;root.updateMatrixWorld(true);root.traverse(n=>{if(!n.isMesh||!n.visible)return;const row=this.elementForNode(n),d=row?this.descriptor(row):null,native=(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean),srcs=native.length?native:[null],next=[];for(const src of srcs){let color,opacity;if(d?.c){color=d.c.clone();opacity=Math.max(.04,Math.min(1,d.o??1));exact++;}else{color=src?.color?.isColor?src.color.clone():new THREE.Color(0xb7bcc2);opacity=Math.max(.04,Math.min(1,Number.isFinite(src?.opacity)?src.opacity:1));nativeKept++;}next.push(new THREE.MeshLambertMaterial({color,opacity,transparent:opacity<.995,depthWrite:opacity>.62,side:THREE.DoubleSide}));}for(const m of native)m.dispose?.();n.material=Array.isArray(n.material)?next:next[0];});console.info('[REVEX r28] solid material pass',{exact,nativeKept,transparency:true,pbr:false});
  };
  v.buildOutlineOverlay=async function(root){
    if(this.__r28Outline){this.scene.remove(this.__r28Outline);this.__r28Outline.geometry?.dispose?.();this.__r28Outline.material?.dispose?.();this.__r28Outline=null}if(!root)return;
    root.updateMatrixWorld(true);const pts=[],cap=360000,meshes=[];root.traverse(n=>{if(n.isMesh&&n.visible)meshes.push(n)});let processed=0;
    for(const n of meshes){const pc=n.geometry?.attributes?.position?.count||0;if(!pc||pc>70000)continue;let e=null;try{e=new THREE.EdgesGeometry(n.geometry,38);const a=e.getAttribute('position');for(let i=0;i<a.count&&pts.length/3<cap;i++){const p=new THREE.Vector3(a.getX(i),a.getY(i),a.getZ(i)).applyMatrix4(n.matrixWorld);pts.push(p.x,p.y,p.z)}}catch(_){}finally{e?.dispose?.()}if(++processed%48===0)await nextFrame();if(pts.length/3>=cap)break;}
    if(!pts.length)return;const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));const m=new THREE.LineBasicMaterial({color:0x353b42,transparent:true,opacity:.62,depthWrite:false});const line=new THREE.LineSegments(g,m);line.name='REVEX_R28_SOLID_EDGES';line.renderOrder=2;this.__r28Outline=line;this.scene.add(line);this.requestRender();console.info('[REVEX r28] batched solid edges',{vertices:pts.length/3,processed});
  };

  const oldLoad=v.loadDetailed.bind(v);v.loadDetailed=async function(...args){const ok=await oldLoad(...args);if(ok){setTimeout(()=>this.buildOutlineOverlay(this.model),0);watchTree();}return ok;};
  if(v.sourceState?.modelUrl){v.detailLoaded=false;v.detailLoading=false;setTimeout(()=>v.loadDetailed(),40);}
  watchTree();
  console.info('[REVEX] viewer r28 hotfix installed',{deterministicAxes:true,identityBoundsFallback:true,solid:true,transparency:true,edges:true,physicalTree:true});
}
function wait(){const v=window.__revexViewerR26Instance||window.__revexViewerR27Instance||window.__revexViewerR28Instance;if(!v){setTimeout(wait,30);return}install(v)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{watchTree();wait()},{once:true});else{watchTree();wait()}
