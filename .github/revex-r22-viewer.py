from pathlib import Path

root=Path('docs/liber-apps/apps/revex')
src=root/'viewer-r21.js'
dst=root/'viewer-r22.js'
t=src.read_text(encoding='utf-8')
t=t.replace("const BUILD='20260810r21'","const BUILD='20260810r22'",1)
t=t.replace("window.__revexViewerR21","window.__revexViewerR22")
t=t.replace("window.__revexViewerR21=true","window.__revexViewerR22=true")
t=t.replace("[REVEX r21]","[REVEX r22]")
t=t.replace("[REVEX r21 viewer]","[REVEX r22 viewer]")
t=t.replace("window.__revexViewerR21Instance=v","window.__revexViewerR22Instance=v;window.__revexViewerR21Instance=v")
t=t.replace("this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5))","this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.25))")

start=t.index('  registerFixed(root,target){')
end=t.index('\n  pruneFloating(',start)
registration=r'''  axisRotations(){
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
'''
t=t[:start]+registration+t[end:]

# Keep a material-name lookup so geometry that lacks an element id can still receive Revit graphic intent.
t=t.replace("this.model=null;this.bounds=null;this.data=null;this.byId=new Map();this.byUid=new Map();this.helper=null;","this.model=null;this.bounds=null;this.data=null;this.byId=new Map();this.byUid=new Map();this.materialByName=new Map();this.helper=null;")
load_marker="this.data=data;this.byId=new Map(rows.map(r=>[String(r.id),r]));this.byUid=new Map(rows.filter(r=>r.uniqueId).map(r=>[String(r.uniqueId),r]));const target=this.metaBounds();"
load_repl="this.data=data;this.byId=new Map(rows.map(r=>[String(r.id),r]));this.byUid=new Map(rows.filter(r=>r.uniqueId).map(r=>[String(r.uniqueId),r]));this.materialByName=new Map();for(const row of rows)for(const m of row.materials||[]){const k=String(m.name||'').trim().toLowerCase();if(k&&!this.materialByName.has(k))this.materialByName.set(k,{...m,row});}const target=this.metaBounds();"
t=t.replace(load_marker,load_repl)
old="const d=this.descriptor(row);if(!d)return;const arr=Array.isArray(n.material)?n.material:[n.material];"
new="let d=this.descriptor(row);const arr=Array.isArray(n.material)?n.material:[n.material];if(!d){for(const native of arr){const hit=this.materialByName.get(String(native?.name||'').trim().toLowerCase());if(hit){d=this.descriptor({...hit.row,materials:[hit]});break}}}if(!d)return;"
t=t.replace(old,new)

dst.write_text(t,encoding='utf-8')

index=root/'index.html';h=index.read_text(encoding='utf-8')
h=h.replace('viewer-r21.js?v=20260810r21','viewer-r22.js?v=20260810r22')
h=h.replace('20260810r21','20260810r22')
index.write_text(h,encoding='utf-8')

shell=root/'shell-integrity.js';s=shell.read_text(encoding='utf-8').replace("const BUILD='20260810r21';","const BUILD='20260810r22';")
shell.write_text(s,encoding='utf-8')
proj=root/'projection-integrity.js';p=proj.read_text(encoding='utf-8').replace("const BUILD='20260810r21';","const BUILD='20260810r22';")
proj.write_text(p,encoding='utf-8')

assert 'viewer-r22.js?v=20260810r22' in index.read_text(encoding='utf-8')
assert 'fitAnchors(anchors)' in dst.read_text(encoding='utf-8')
assert 'requestAnimationFrame(() => this.animate())' not in dst.read_text(encoding='utf-8')
