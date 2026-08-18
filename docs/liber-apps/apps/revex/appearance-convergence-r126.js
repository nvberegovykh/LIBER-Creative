(function(root){
'use strict';
const BUILD='20260817r126-appearance-convergence1';
if(root.__revexAppearanceConvergenceR126)return;
root.__revexAppearanceConvergenceR126={build:BUILD,precedence:['instance-uv','type-texture','design-color-fallback','revit-material']};
const Store=root.RevexStore;
const S=()=>root.__revexState||null;
const t=v=>String(v??'').trim();
const n=v=>t(v).toLowerCase().replace(/\s+/g,' ');
const cp=v=>JSON.parse(JSON.stringify(v===undefined?null:v));
const stable=r=>t(r?.uniqueId||r?.elementId||r?.id);
const typeKey=r=>t(r?.typeUniqueId||r?.typeId||r?.revitTypeUniqueId)?`uid:${t(r.typeUniqueId||r.typeId||r.revitTypeUniqueId)}`:`text:${n(r?.category)}|${n(r?.family)}|${n(r?.type||r?.typeName||r?.revitType||r?.name)}`;
const appearanceKey=(scope,row)=>`${scope}:${scope==='type'?typeKey(row):stable(row)}`;
const doc=v=>t(v).replace(/[^a-zA-Z0-9._-]+/g,'_').replace(/\./g,'_').slice(0,120)||'x';
let patchedViewer=null,originalViewerSet=null,originalSave=null,installAttempts=0,fileBusy=false;
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'appearance convergence r126',...detail})}catch(_){}}
function plain(value){const safe=cp(value);return typeof Store?.toFirestorePlain==='function'?Store.toFirestorePlain(safe):safe}
function typeRecord(row,map=S()?.bimAppearances){if(!row||!map)return null;return map.get(`type:${typeKey(row)}`)||null}
function instanceRecord(row,map=S()?.bimAppearances){if(!row||!map)return null;return map.get(`instance:${stable(row)}`)||null}
function effectiveTexture(row,map=S()?.bimAppearances){
 const type=typeRecord(row,map),inst=instanceRecord(row,map);
 const own=inst?.texture?.assetUrl?inst.texture:null;
 const source=own||type?.texture||null;
 if(!source?.assetUrl)return null;
 const uv=inst?.uv||null;
 return uv?{...source,repeatX:uv.repeatX??source.repeatX??1,repeatY:uv.repeatY??source.repeatY??1,rotation:uv.rotation??source.rotation??0}:source;
}
function runtimeRows(rows){
 const canonical=(rows||[]).map(cp),map=new Map(canonical.filter(r=>r?.scope&&r?.scopeKey).map(r=>[`${r.scope}:${r.scopeKey}`,r]));
 return canonical.map(row=>{
   if(row?.scope!=='instance'||!row.uv)return row;
   const type=map.get(`type:${typeKey(row)}`),source=row.texture?.assetUrl?row.texture:type?.texture;
   if(!source?.assetUrl)return row;
   return {...row,texture:{...source,repeatX:row.uv.repeatX??source.repeatX??1,repeatY:row.uv.repeatY??source.repeatY??1,rotation:row.uv.rotation??source.rotation??0},__runtimeUvInherited:true};
 });
}
function restoreCanonicalState(rows){
 const s=S();if(!s)return;s.bimAppearances=new Map((rows||[]).filter(r=>r?.scope&&r?.scopeKey).map(r=>[`${r.scope}:${r.scopeKey}`,r]));
}
function patchViewer(){
 const v=root.__revexViewerR26Instance;if(!v||v===patchedViewer||typeof v.setAppearances!=='function')return false;
 patchedViewer=v;originalViewerSet=v.setAppearances.bind(v);
 v.setAppearances=function(rows){
   const canonical=(rows||[]).map(cp),runtime=runtimeRows(canonical),result=originalViewerSet(runtime);
   const restore=()=>restoreCanonicalState(canonical);restore();queueMicrotask(restore);setTimeout(restore,60);setTimeout(restore,260);
   return result;
 };
 diag('INFO','APPEARANCE_VIEWER_R126','Viewer appearance merge patched for instance UV over type texture.',{});
 return true;
}
function mergePatch(before,patch){
 const out={...(before||{}),...cp(patch)};
 if(Object.prototype.hasOwnProperty.call(patch||{},'texture'))out.texture=patch.texture==null?null:{...(before?.texture||{}),...cp(patch.texture)};
 if(Object.prototype.hasOwnProperty.call(patch||{},'uv'))out.uv=patch.uv==null?null:{...(before?.uv||{}),...cp(patch.uv)};
 return out;
}
async function saveAppearance(projectId,row,scope,patch){
 if(!projectId||!row)throw new Error('Project and BIM element are required.');
 const scopeKey=scope==='type'?typeKey(row):stable(row);if(!scopeKey)throw new Error('The selected BIM scope has no stable Revit identity.');
 const s=S(),mapKey=`${scope}:${scopeKey}`,before=s?.bimAppearances?.get?.(mapKey)||null,at=new Date().toISOString();
 const merged=mergePatch(before,patch||{});
 const after={...merged,id:`${scope}_${doc(scopeKey)}`,revexId:`${scope}_${doc(scopeKey)}`,type:'revex',hidden:true,revexKind:'bim-appearance',scope,scopeKey,elementId:row.id??null,uniqueId:row.uniqueId||null,category:row.category||'',family:row.family||'',revitType:row.type||row.typeName||'',typeUniqueId:row.typeUniqueId||row.typeId||null,sourceRevision:s?.cloudState?.revision||null,updatedAt:at,updatedBy:Store.user?.uid||'local'};
 if(!Store.isCloud?.()){
   const key=`liber.revex.bim-appearance.${projectId}`,all=JSON.parse(localStorage.getItem(key)||'{}');all[mapKey]=after;localStorage.setItem(key,JSON.stringify(all));
 }else{
   const f=Store.api;if(!f?.setDoc||!Store.db)throw new Error('REVEX appearance persistence is not connected.');
   // Serialize through the exact Firestore SDK realm. This avoids the iframe/custom
   // Object rejection seen when records cross parent/child Window prototypes.
   const payload=plain(after),options=plain({merge:false});
   await f.setDoc(f.doc(Store.db,'projects',projectId,'library',`revex_appearance_${doc(`${scope}_${scopeKey}`)}`),payload,options);
 }
 const rows=[...(s?.bimAppearances?.values?.()||[])].filter(r=>`${r.scope}:${r.scopeKey}`!==mapKey);rows.push(after);restoreCanonicalState(rows);root.__revexViewerR26Instance?.setAppearances?.(rows);root.dispatchEvent(new CustomEvent('revex:bim-appearances-changed',{detail:{projectId,appearances:rows,source:'r126-save'}}));
 try{const affected=scope==='type'?(s?.viewerData?.elements||[]).filter(x=>typeKey(x)===scopeKey).map(x=>x.id):[row.id];await Store.appendHistory?.(projectId,{sourceRevision:after.sourceRevision,kind:'bim-appearance',operation:`appearance-${scope}`,label:`Finish · ${scope==='type'?'same type':'instance'} · ${row.category||'BIM'}`,affectedElementIds:affected,before,after,note:'Appearance only. Precedence: instance UV → type texture → design color fallback → Revit/model material.'})}catch(_){}
 return after;
}
function installSave(){if(!Store||typeof Store.saveBimAppearance!=='function')return false;if(Store.saveBimAppearance.__r126)return true;originalSave=Store.saveBimAppearance;saveAppearance.__r126=true;saveAppearance.__previous=originalSave;Store.saveBimAppearance=saveAppearance;return true}
function previewAppearance(row,scope,patch){
 const s=S(),v=root.__revexViewerR26Instance;if(!s||!v||!row)return;const key=appearanceKey(scope,row),rows=[...(s.bimAppearances?.values?.()||[])].filter(r=>`${r.scope}:${r.scopeKey}`!==key),before=s.bimAppearances?.get?.(key)||{};rows.push({...mergePatch(before,patch),scope,scopeKey:scope==='type'?typeKey(row):stable(row),elementId:row.id??null,uniqueId:row.uniqueId||null,category:row.category||'',family:row.family||'',revitType:row.type||row.typeName||'',typeUniqueId:row.typeUniqueId||row.typeId||null,enabled:true,__preview:true});v.setAppearances(rows);
}
function dataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result||''));r.onerror=()=>reject(r.error||new Error('Could not read texture image.'));r.readAsDataURL(file)})}
async function uploadTexture(file){
 if(!file||!/^image\/(png|jpeg|webp)$/i.test(file.type||''))throw new Error('Use a PNG, JPG or WebP texture image.');
 const s=S();if(!s?.projectId)throw new Error('Choose a REVEX project first.');
 if(Store.isCloud?.()&&Store.uploadLibraryFile){const saved=await Store.uploadLibraryFile(s.projectId,file,'record_in/materials/architextures',{revexDocKind:'finish-texture',provider:'architextures',sourceUrl:'https://architextures.org/create'});let url=saved.url||saved.localUrl||null;if(!url&&saved.storagePath)url=await Store.fileUrl?.(saved.storagePath);if(!url)throw new Error('Texture upload completed without a readable project URL.');return{provider:'architextures',sourceUrl:'https://architextures.org/create',assetUrl:url,assetPath:saved.storagePath||null,assetName:file.name,repeatX:1,repeatY:1,rotation:0}}
 return{provider:'architextures',sourceUrl:'https://architextures.org/create',assetUrl:await dataUrl(file),assetPath:null,assetName:file.name,repeatX:1,repeatY:1,rotation:0};
}
async function applyTextureFile(file){
 if(fileBusy)return;fileBusy=true;const row=S()?.selectedElement,box=document.querySelector('#bim-inspector [data-r75-finish]');
 try{if(!row)throw new Error('Select a BIM element first.');const scope=box?.querySelector('[data-r75-scope]')?.value||'instance',previewUrl=await dataUrl(file),preview={provider:'architextures',sourceUrl:'https://architextures.org/create',assetUrl:previewUrl,assetName:file.name,repeatX:1,repeatY:1,rotation:0};previewAppearance(row,scope,{enabled:true,texture:preview});const texture=await uploadTexture(file);await Store.saveBimAppearance(S().projectId,row,scope,{enabled:true,texture});diag('INFO','MATERIAL_APPLIED_R126','Texture applied without short-lived blob URLs.',{scope,name:file.name})}finally{fileBusy=false;syncPanel()}
}
function fileFromDataUrl(name,url){const match=String(url||'').match(/^data:([^;,]+);base64,(.+)$/);if(!match)throw new Error('Provider returned an invalid material download.');const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));return new File([bytes],name||'architextures.png',{type:match[1]||'image/png'})}
function uvFromPanel(box){return{repeatX:Math.max(.01,+box.querySelector('[data-r75-rx]')?.value||1),repeatY:Math.max(.01,+box.querySelector('[data-r75-ry]')?.value||1),rotation:+box.querySelector('[data-r75-rot]')?.value||0}}
function syncPanel(){
 const box=document.querySelector('#bim-inspector [data-r75-finish]'),row=S()?.selectedElement;if(!box||!row)return;const scope=box.querySelector('[data-r75-scope]')?.value||'instance';
 const tex=effectiveTexture(row),inst=instanceRecord(row),type=typeRecord(row),mapping=scope==='instance'?(inst?.uv||tex||null):(type?.texture||null);
 if(scope==='instance'&&tex){for(const x of box.querySelectorAll('.r75-mapping input'))x.disabled=false;const set=(sel,val)=>{const node=box.querySelector(sel);if(node&&document.activeElement!==node)node.value=String(val)};set('[data-r75-rx]',mapping?.repeatX??1);set('[data-r75-ry]',mapping?.repeatY??1);set('[data-r75-rot]',mapping?.rotation??0);const name=box.querySelector('[data-r75-name]');if(name&&document.activeElement!==name)name.textContent=`${tex.assetName||'Type texture'} · instance UV`;}
 const live=box.querySelector('[data-r75-live]');if(live&&!box.contains(document.activeElement))live.textContent=tex?'Texture → design color fallback → Revit/model color. Instance UV remains local over type textures.':'Design color fallback → Revit/model color.';
}
function bindDom(){
 document.addEventListener('change',event=>{const input=event.target?.closest?.('#bim-inspector [data-r75-file]');if(!input)return;event.preventDefault();event.stopImmediatePropagation();const file=input.files?.[0];input.value='';if(file)void applyTextureFile(file).catch(error=>diag('ERROR','MATERIAL_APPLY_R126',error.message||String(error)))},true);
 for(const type of['input','change'])document.addEventListener(type,event=>{const node=event.target?.closest?.('#bim-inspector [data-r75-rx],#bim-inspector [data-r75-ry],#bim-inspector [data-r75-rot]');if(!node)return;const box=node.closest('[data-r75-finish]'),row=S()?.selectedElement,scope=box?.querySelector('[data-r75-scope]')?.value||'instance';if(scope!=='instance'||!row||!effectiveTexture(row))return;event.stopImmediatePropagation();const uv=uvFromPanel(box);if(type==='input')previewAppearance(row,'instance',{enabled:true,uv});else void Store.saveBimAppearance(S().projectId,row,'instance',{enabled:true,uv}).catch(error=>diag('ERROR','BIM_UV_SAVE_R126',error.message||String(error)))},true);
 document.addEventListener('change',event=>{if(event.target?.matches?.('#bim-inspector [data-r75-scope]'))setTimeout(syncPanel,0)},true);
 root.addEventListener('revex:bim-selection',()=>setTimeout(syncPanel,60));root.addEventListener('revex:bim-appearances-changed',()=>setTimeout(syncPanel,0));
 try{root.chrome?.webview?.addEventListener?.('message',event=>{const data=event.data||{};if(data.type!=='liber:revex-integration-material-r126'||data.provider!=='architextures')return;try{void applyTextureFile(fileFromDataUrl(data.name,data.dataUrl)).catch(error=>diag('ERROR','MATERIAL_PROVIDER_R126',error.message||String(error)))}catch(error){diag('ERROR','MATERIAL_PROVIDER_R126',error.message||String(error))}})}catch(_){}
}
function css(){if(document.getElementById('revex-r126-appearance-css'))return;const s=document.createElement('style');s.id='revex-r126-appearance-css';s.textContent=`
body.r75-material-open{--revex-inspector:clamp(300px,36vw,520px)!important}.bim-view,.viewport-wrap,.inspector{min-width:0!important}.inspector{max-width:100vw!important;overflow:auto!important;overscroll-behavior:contain}.r75-finish,.r75-provider,.r75-provider-foot,.r75-provider-head{min-width:0;max-width:100%}.r75-provider-frame{max-width:100%}.r75-finish input,.r75-finish select,.r75-finish button{max-width:100%}
@media(max-width:1180px){body.r75-material-open{--revex-inspector:clamp(290px,34vw,420px)!important}.r75-finish-grid,.r75-mapping{grid-template-columns:1fr!important}}
@media(max-width:860px){body.r75-material-open{--revex-inspector:100%!important}.bim-view>.inspector{width:100%!important;max-width:100vw!important;padding:12px!important}.r75-provider{grid-template-rows:auto minmax(320px,55dvh) auto!important}.r75-provider-foot{grid-template-columns:1fr!important}.r75-filter{grid-template-columns:1fr!important}}
`;
document.head.appendChild(s)}
function install(){if(!Store)return false;css();patchViewer();if(!installSave())return false;bindDom();syncPanel();diag('INFO','APPEARANCE_CONVERGENCE_R126','Appearance stack converged.',{precedence:'instance UV > type texture > design color fallback > Revit/model',blobPreview:false,crossRealmPlain:true,responsiveInspector:true});return true}
const timer=setInterval(()=>{installAttempts++;patchViewer();if(install()||installAttempts>160)clearInterval(timer)},50);
root.addEventListener('revex:source-revision-loaded',()=>setTimeout(()=>{patchViewer();syncPanel()},0));
})(window);
