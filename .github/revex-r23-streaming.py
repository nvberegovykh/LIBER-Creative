from pathlib import Path
import re
root=Path('docs/liber-apps/apps/revex')
src=root/'viewer-r22.js';dst=root/'viewer-r23.js'
t=src.read_text(encoding='utf-8')
t=t.replace("const BUILD='20260810r22'","const BUILD='20260810r23'",1)
t=t.replace("window.__revexViewerR22","window.__revexViewerR23")
t=t.replace("window.__revexViewerR22=true","window.__revexViewerR23=true")
t=t.replace("window.__revexViewerR22Instance=v;window.__revexViewerR21Instance=v","window.__revexViewerR23Instance=v;window.__revexViewerR22Instance=v;window.__revexViewerR21Instance=v")
t=t.replace("[REVEX r22]","[REVEX r23]").replace("[REVEX r22 viewer]","[REVEX r23 viewer]")
t=t.replace("this.walkFrame=0;this.lastStep=0;this.renderFrame=0;this.spatial=null;","this.walkFrame=0;this.lastStep=0;this.renderFrame=0;this.spatial=null;this.loadToken=0;")
start=t.index('  async load(state){')
end=t.index('\n  proxy(rows){',start)
load=r'''  async load(state){
    const token=++this.loadToken,msg=$('#viewer-message');if(msg){msg.hidden=false;msg.classList.remove('fallback');msg.textContent='Loading BIM index…'}
    const source=await Store.fetchJson(state.viewerUrl);if(token!==this.loadToken)return;
    const rows=(source?.elements||[]).filter(usableRow),data={...source,elements:rows};this.data=data;this.byId=new Map(rows.map(r=>[String(r.id),r]));this.byUid=new Map(rows.filter(r=>r.uniqueId).map(r=>[String(r.uniqueId),r]));this.materialByName=new Map();for(const row of rows)for(const m of row.materials||[]){const k=String(m.name||'').trim().toLowerCase();if(k&&!this.materialByName.has(k))this.materialByName.set(k,{...m,row});}
    const target=this.metaBounds();this.clear();this.bounds=target;
    let preview=false;if(target&&rows.length){this.model=this.proxy(rows);this.scene.add(this.model);this.sectionApply();this.fit();this.floors();this.requestRender();preview=true;if(msg)msg.textContent='Loading detailed BIM geometry…'}
    if(!state.modelUrl){if(msg)msg.hidden=true;console.info('[REVEX] viewer '+BUILD,{elements:rows.length,levels:data.levels?.length||0,mode:'metadata-proxy',onDemand:true,idleFramePersistent:true});return;}
    let obj=null;try{obj=await new Promise((res,rej)=>new FBXLoader().load(state.modelUrl,res,p=>{if(msg&&p.total)msg.textContent=`Loading detailed BIM geometry · ${Math.round(p.loaded/p.total*100)}%`;},rej))}catch(e){console.warn('[REVEX r23] FBX fallback',e)}
    if(token!==this.loadToken){obj?.traverse?.(n=>{n.geometry?.dispose?.();(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean).forEach(m=>m.dispose?.())});return;}
    if(obj){const old=this.model;if(old){this.scene.remove(old);old.traverse(n=>{n.geometry?.dispose?.();(Array.isArray(n.material)?n.material:[n.material]).filter(Boolean).forEach(m=>m.dispose?.())})}const reg=new THREE.Group();reg.add(obj);this.model=reg;if(target)this.registerFixed(reg,target);if(target)this.pruneFloating(reg,target);this.bounds=target||new THREE.Box3().setFromObject(reg);this.applyMaterials(reg);this.scene.add(reg);this.sectionApply();if(!preview)this.fit();this.floors();this.requestRender()}
    if(msg)msg.hidden=true;console.info('[REVEX] viewer '+BUILD,{elements:rows.length,levels:data.levels?.length||0,mode:obj?'fbx':'metadata-proxy',streamingPreview:true,onDemand:true,idleFramePersistent:true,walkSharedScene:true});
  }
'''
t=t[:start]+load+t[end:]
# cache Three loader resources during the persistent session
if 'THREE.Cache.enabled=true;' not in t:
    t=t.replace("window.__revexViewerR23=true;","window.__revexViewerR23=true;THREE.Cache.enabled=true;")
dst.write_text(t,encoding='utf-8')
index=root/'index.html';h=index.read_text(encoding='utf-8').replace('20260810r22','20260810r23').replace('viewer-r22.js?v=20260810r23','viewer-r23.js?v=20260810r23');index.write_text(h,encoding='utf-8')
for name in ('shell-integrity.js','projection-integrity.js'):
    p=root/name;s=p.read_text(encoding='utf-8');s=re.sub(r"const BUILD='20260810r\d+';","const BUILD='20260810r23';",s,count=1);p.write_text(s,encoding='utf-8')
assert 'viewer-r23.js?v=20260810r23' in index.read_text(encoding='utf-8')
assert 'streamingPreview:true' in dst.read_text(encoding='utf-8')
assert 'requestAnimationFrame(() => this.animate())' not in dst.read_text(encoding='utf-8')
