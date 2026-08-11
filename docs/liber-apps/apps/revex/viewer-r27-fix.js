import * as THREE from 'three';
const BUILD='20260811r27';
const wait=()=>{
  const v=window.__revexViewerR26Instance;
  if(!v){setTimeout(wait,20);return;}
  if(v.__revexR27)return;
  v.__revexR27=true;
  v.renderer.toneMapping=THREE.NoToneMapping;
  v.renderer.toneMappingExposure=1;

  // FBX compatibility registration is allowed to rotate only around the vertical
  // axis. The former 24-axis search could choose a geometrically equivalent
  // upside-down fit. Native RVX geometry is already Revit X,Y,Z -> THREE X,Z,-Y.
  v.axisRotations=function(){
    if(this._r27AxisRotations)return this._r27AxisRotations;
    this._r27AxisRotations=[0,Math.PI/2,Math.PI,Math.PI*1.5]
      .map(a=>new THREE.Matrix4().makeRotationY(a));
    return this._r27AxisRotations;
  };
  v._axisRotations=null;

  // Controlled Revit-like Solid viewport: material identity + transparency are
  // preserved, but PBR/tone mapping is intentionally removed.
  v.materialFor=function(materialId,row){
    const id=String(Math.trunc(+materialId||-1));
    const cacheKey=id!=='-1'?`solid:${id}`:`solid:${row?.categoryKey||'other'}`;
    if(this.materialCache.has(cacheKey))return this.materialCache.get(cacheKey);
    const hit=this.materialById.get(id);
    const d=hit?this.descriptor({...row,materials:[hit.material]}):this.descriptor(row);
    const color=d?.c||new THREE.Color(0x969a9e);
    const opacity=Math.max(.04,Math.min(1,d?.o??1));
    const m=new THREE.MeshLambertMaterial({
      color,opacity,transparent:opacity<.995,depthWrite:opacity>.72,side:THREE.DoubleSide
    });
    this.materialCache.set(cacheKey,m);
    return m;
  };
  v.applyMaterials=function(root){
    this.buildSpatial();let mapped=0;
    root.updateMatrixWorld(true);
    root.traverse(n=>{
      if(!n.isMesh||!n.visible)return;
      let row=this.elementForNode(n);
      if(!row){const b=new THREE.Box3().setFromObject(n);if(!b.isEmpty())row=this.nearestRow(b.getCenter(new THREE.Vector3()));}
      let d=this.descriptor(row);
      const old=(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean);
      if(!d){for(const m of old){const hit=this.materialByName.get(String(m?.name||'').trim().toLowerCase());if(hit){d=this.descriptor({...hit.row,materials:[hit]});break;}}}
      const color=d?.c||new THREE.Color(0x969a9e),opacity=Math.max(.04,Math.min(1,d?.o??1));
      const make=()=>new THREE.MeshLambertMaterial({color,opacity,transparent:opacity<.995,depthWrite:opacity>.72,side:THREE.DoubleSide});
      const next=(old.length?old:[null]).map(make);
      old.forEach(m=>m.dispose?.());
      n.material=Array.isArray(n.material)?next:next[0];mapped++;
    });
    console.info('[REVEX r27] controlled solid material postprocess',{mapped,transparencyPreserved:true,pbr:false});
  };

  v.buildOutlineOverlay=async function(root){
    const token=(this._r27OutlineToken=(this._r27OutlineToken||0)+1);
    if(this._r27Outline){this.scene.remove(this._r27Outline);this._r27Outline.geometry?.dispose?.();this._r27Outline.material?.dispose?.();this._r27Outline=null;}
    if(!root)return;
    root.updateMatrixWorld(true);
    const points=[],maxVertices=550000,skip=/^(furniture|casework|lighting-fixtures|mechanical-equipment|plumbing-fixtures)$/i;
    const meshes=[];root.traverse(n=>{if(n.isMesh&&n.visible)meshes.push(n);});
    let processed=0;
    for(const n of meshes){
      if(token!==this._r27OutlineToken)return;
      const row=this.elementForNode(n)||(n.userData?.revexElementId&&this.byId.get(String(n.userData.revexElementId)));
      if(skip.test(String(row?.categoryKey||'')))continue;
      const pc=n.geometry?.attributes?.position?.count||0;if(!pc||pc>90000)continue;
      let edges;
      try{
        edges=new THREE.EdgesGeometry(n.geometry,32);
        const a=edges.getAttribute('position');
        for(let i=0;i<a.count&&points.length/3<maxVertices;i++){
          const p=new THREE.Vector3(a.getX(i),a.getY(i),a.getZ(i)).applyMatrix4(n.matrixWorld);
          points.push(p.x,p.y,p.z);
        }
      }catch(_){ }finally{edges?.dispose?.();}
      processed++;
      if(processed%36===0)await new Promise(r=>requestAnimationFrame(r));
      if(points.length/3>=maxVertices)break;
    }
    if(token!==this._r27OutlineToken||!points.length)return;
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
    const m=new THREE.LineBasicMaterial({color:0x303740,transparent:true,opacity:.72,depthTest:true,depthWrite:false});
    const lines=new THREE.LineSegments(g,m);lines.name='REVEX_SOLID_OUTLINES';lines.renderOrder=3;
    this._r27Outline=lines;this.scene.add(lines);this.requestRender();
    console.info('[REVEX r27] solid outlines',{lineVertices:points.length/3,processedMeshes:processed});
  };

  const originalLoadDetailed=v.loadDetailed.bind(v);
  v.loadDetailed=async function(...args){
    const ok=await originalLoadDetailed(...args);
    if(ok&&this.model){
      this.renderer.toneMapping=THREE.NoToneMapping;
      this.applyMaterials(this.model);
      await this.buildOutlineOverlay(this.model);
      this.requestRender();
    }
    return ok;
  };
  const originalApplyOverlays=v.applyOverlays.bind(v);
  v.applyOverlays=function(...args){const r=originalApplyOverlays(...args);if(this.detailLoaded&&this.model)setTimeout(()=>this.buildOutlineOverlay(this.model),0);return r;};

  // Remove authoring-only element rows from the visual navigator as they arrive.
  const cleanTree=()=>document.querySelectorAll('#element-tree .tree-item').forEach(el=>{
    const t=(el.textContent||'').trim();
    if(/^(model lines?|detail lines?|room separation|space separation|areas?)\b/i.test(t))el.hidden=true;
  });
  new MutationObserver(cleanTree).observe(document.querySelector('#element-tree')||document.body,{childList:true,subtree:true});
  cleanTree();

  // If compatibility geometry was already loaded before the hotfix attached,
  // reload it once through the upright registration path without reloading project data.
  if(v.detailLoaded&&v.sourceState?.modelUrl){v.detailLoaded=false;v.detailLoading=false;setTimeout(()=>v.loadDetailed(),0);}
  console.info('[REVEX] viewer '+BUILD,{uprightCompatibility:true,solidViewport:true,transparency:true,batchedOutlines:true});
};
wait();
