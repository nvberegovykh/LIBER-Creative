/* Event-driven package projection. It never rewrites the underlying files, BIM or specification decisions. */
const Core=window.RevexPackagesCore,Store=window.RevexStore;
const $=id=>document.getElementById(id),state=()=>window.__revexState||{};
const capture=()=>({projectId:state().projectId,uid:Store.user?.uid,activation:state().activationToken});
const current=o=>o.projectId&&o.uid&&JSON.stringify(o)===JSON.stringify(capture());
const esc=Core.escape;
let specBinding='',specOff=null;
let owner=null,config={},driveFiles=[],specItems=[],overrides={},catalog=null,unsubs=[],generation=0,timer=0,selected='',page=0,query='',usage='all',showHistory=false,busy=false;
const initialProject=new URLSearchParams(location.search).get('projectId');
const initialPackage=new URLSearchParams(location.search).get('package')||'';
const panel=$('view-packages');
panel.innerHTML=`<div class="packages-shell"><header class="packages-head"><div><div class="eyebrow">SITE · DESIGN · PROCUREMENT</div><h2>Project packages</h2><p>Drawings, specifications, selections and source files, arranged by trade. Links follow their original sources and keep each project's decisions together.</p></div><div class="packages-actions"><button class="button ghost" id="packages-rebuild">Arrange with WALLT</button><button class="button ghost" id="packages-drive-connect">Connect Drive</button><button class="button ghost" id="packages-drive-sync">Sync Drive</button><button class="button ghost" id="packages-export">Export index</button></div></header><div class="packages-status" id="packages-status" role="status" aria-live="polite">Choose a project to see its packages.</div><details class="packages-binding" id="packages-binding"><summary>Project folder and sync</summary><p class="packages-note">Keep this project's packages at LIBER-PROJECTS / client / project / 012_PACKAGES. Connect your Google account once per session to scan connected files and refresh Drive shortcuts and package indexes. REVEX sources update live while this project is open.</p><label for="packages-folder">Project's Google Drive folder</label><input id="packages-folder" placeholder="https://drive.google.com/drive/folders/…"><div class="packages-actions"><button class="button ghost" id="packages-save-folder">Save project folder</button><label><input type="checkbox" id="packages-auto"> Sync Drive after source changes</label><a id="packages-folder-link" class="button ghost" target="_blank" rel="noopener" hidden>Open packages folder</a></div></details><div id="packages-summary" class="packages-summary"></div><div class="packages-tools"><input id="packages-search" type="search" placeholder="Find a trade, file, format or position" aria-label="Search packages"><select id="packages-usage" aria-label="Package purpose"><option value="all">All uses</option><option value="site">On site</option><option value="design">Design</option><option value="procurement">Procurement</option></select><label><input id="packages-history" type="checkbox"> Include history</label><button id="packages-review" class="button ghost">Review unmatched</button></div><div id="packages-content"></div><p class="packages-note">Assignments use names, categories and connected folders. Shared full sets are reference material. Package membership does not confirm approval, quantities or readiness to order. Use the linked source revision and recorded selection status.</p></div>`;
const assignment=document.createElement('dialog');assignment.id='packages-assign';assignment.setAttribute('aria-labelledby','package-assign-title');document.body.append(assignment);
function status(message,error=false){$('packages-status').textContent=message;$('packages-status').dataset.error=String(error);}
function cancel(){generation++;specBinding='';specOff?.();specOff=null;clearTimeout(timer);for(const off of unsubs)off?.();unsubs=[];owner=null;config={};driveFiles=[];specItems=[];overrides={};catalog=null;selected='';page=0;busy=false;$('packages-drive-sync').disabled=false;assignment.close();$('packages-content').replaceChildren();$('packages-summary').replaceChildren();$('packages-folder').value='';$('packages-folder-link').hidden=true;status('Choose a project to see its packages.');}
function updateBinding(){
 $('packages-folder').value=config.driveProjectFolderId?'https://drive.google.com/drive/folders/'+config.driveProjectFolderId:'';
 $('packages-auto').checked=config.autoSync===true;
 const url=Core.safeUrl(config.drivePackagesUrl);$('packages-folder-link').hidden=!url;if(url)$('packages-folder-link').href=url;
}
async function loadDrivePages(o,cfg,attempt){
 const ids=Array.isArray(cfg.driveSourcePages)?cfg.driveSourcePages:[],rows=[];
 for(const id of ids){if(!current(o)||attempt!==generation)return;if(!/^revex_packages_(drive_|seed_)[a-zA-Z0-9_-]+$/.test(id))continue;const snap=await Store.api.getDoc(Store.api.doc(Store.db,'projects',o.projectId,'library',id));if(snap.exists())rows.push(...(snap.data().files||[]));}
 if(current(o)&&attempt===generation){driveFiles=rows;rebuild();}
}
async function bind(){
 const o=capture();if(!o.projectId||!o.uid)return;
 if(owner&&JSON.stringify(owner)===JSON.stringify(o)){schedule();return;}
 cancel();owner=o;const attempt=generation;
 selected=o.projectId===initialProject?initialPackage:'';
 status('Reading this project’s connected sources…');
 try{
  config=await Store.getPackageConfig(o.projectId);if(!current(o)||attempt!==generation)return;updateBinding();await loadDrivePages(o,config,attempt);
  unsubs.push(Store.subscribeKind(o.projectId,'packages-config',rows=>{if(!current(o))return;const next=rows.find(r=>r.id==='revex_packages_config')||{};const changed=next.driveSourceGeneration!==config.driveSourceGeneration;config=next;updateBinding();if(changed)void loadDrivePages(o,next,attempt).catch(e=>{if(current(o))status(e.message,true);});else schedule();},5));
  unsubs.push(Store.subscribeKind(o.projectId,'packages-assignment',rows=>{if(current(o)){overrides=Object.fromEntries(rows.map(r=>[r.key,r]));schedule();}},5000));
  unsubs.push(Store.subscribeLibraryFiles(o.projectId,()=>{if(current(o))schedule();}));
  await bindSpecifications(o,attempt);
  rebuild();
 }catch(e){if(current(o)&&attempt===generation)status(e.message,true);}
}
async function bindSpecifications(o,attempt){
 const sid=state().preferredSpecId||state().project?.revexSpecProjectId||'';if(!sid||sid===specBinding)return;
 specOff?.();specOff=null;specBinding=sid;specItems=[];
 try{const header=await Store.api.getDoc(Store.api.doc(Store.db,'specProjects',sid));if(!current(o)||attempt!==generation||specBinding!==sid)return;
  if(header.exists()&&header.data().linkedProjectId===o.projectId)specOff=Store.api.onSnapshot(Store.api.collection(Store.db,'specProjects',sid,'items'),snap=>{if(current(o)&&specBinding===sid){specItems=snap.docs.map(d=>({id:d.id,...d.data()}));schedule();}},e=>{if(current(o))status('Specification source is unavailable: '+e.message,true);});
 }catch(e){if(current(o)&&attempt===generation)status('Specification source is unavailable: '+e.message,true);}
}
function schedule(){clearTimeout(timer);timer=setTimeout(rebuild,180);}
function rebuild(){
 if(!owner||!current(owner))return;
 void bindSpecifications(owner,generation);
 const files=[...(state().library||[]).map(f=>({...f,key:'library:'+f.id})),...driveFiles];
 catalog=Core.build({project:{id:owner.projectId,name:state().project?.name||owner.projectId},files,positions:window.RevexDesignContext?.positions()||[],specifications:specItems,overrides});
 render();if(!busy)status(`${catalog.sourceCount.toLocaleString()} sources arranged into ${Core.CATALOG.length} packages. ${catalog.review.length} need assignment.${config.driveScannedAt?' Drive index: '+new Date(config.driveScannedAt).toLocaleString()+'.':''}${!window.RevexPackageDrive?.connected()?' Connect Drive to refresh its sources and indexes.':''}`);
 window.dispatchEvent(new CustomEvent('revex:packages-updated',{detail:{projectId:owner.projectId}}));
}
function filtered(rows){const q=Core.normalize(query);return rows.filter(i=>(showHistory||!i.archived)&&(usage==='all'||i.roles.includes(usage))&&(!q||Core.normalize([i.name,i.format,i.application,i.path,i.chapterTitle,i.reason].join(' ')).includes(q)));}
function render(){
 if(!catalog)return;
 $('packages-summary').innerHTML=`<span><strong>${catalog.packages.length}</strong> trades</span><span><strong>${catalog.sourceCount.toLocaleString()}</strong> sources</span><span><strong>${catalog.review.length}</strong> to review</span>`;
 const host=$('packages-content');
 if(!selected){host.innerHTML='<div class="packages-grid">'+catalog.packages.filter(p=>!query||Core.normalize(p.name).includes(Core.normalize(query))||filtered(p.items).length).map(p=>`<button class="package-card" data-package="${p.id}"><h3>${esc(p.name)}</h3><span class="package-count">${filtered(p.items).length}</span><small>related sources · ${p.procurementCount} for procurement</small><small>${p.activeCount?'Open linked files and positions':'Awaiting connected sources'}</small></button>`).join('')+'</div>';return;}
 const pack=catalog.packages.find(p=>p.id===selected),rows=filtered(selected==='review'?catalog.review:pack?.items||[]),pages=Math.max(1,Math.ceil(rows.length/60));page=Math.min(page,pages-1);
 const apps=['docs','design','spec','bim',...(selected==='hvac-fresh-air'||selected==='windows'||selected==='exterior-insulation-fireproofing'?['energy']:[])];
 host.innerHTML=`<div class="package-detail-head"><button class="button ghost" data-back>All packages</button><h3>${esc(pack?.name||'Needs assignment')}</h3><span>${rows.length} sources</span></div><nav class="package-apps" aria-label="Related applications">${apps.map(v=>`<a href="${esc(Core.appUrl(owner.projectId,v))}" data-view-link="${v}">${esc({docs:'Docs',design:'Design Book',spec:'Spec Book',bim:'BIM',energy:'Energy'}[v])}</a>`).join('')}</nav>${rows.length?`<div class="packages-table-wrap"><table class="packages-table"><thead><tr><th>Source</th><th>Quantity</th><th>Format / application</th><th>Use / status</th><th>Assignment</th></tr></thead><tbody>${rows.slice(page*60,page*60+60).map(i=>`<tr><td><button class="button ghost" data-source="${esc(i.key)}">${esc(i.name)}</button><small>${esc(i.path||i.folderPath||i.chapterTitle||'')}</small>${esc(i.description.slice(0,1600))}${i.sourceLink?'<small><a href="'+esc(i.sourceLink)+'" target="_blank" rel="noopener">Product / supplier</a></small>':''}</td><td>${esc([i.quantity,i.unit].filter(Boolean).join(' ')||'—')}</td><td>${esc(i.format)}<small>${esc(i.application)}</small></td><td>${esc(i.roles.join(' · '))}<small>${esc(i.archived?'Historical':i.status||'Source linked')}</small></td><td><button class="button ghost" data-assign="${esc(i.key)}">${i.manual?'Edit':'Assign'}</button><small>${esc(i.reason)}</small></td></tr>`).join('')}</tbody></table></div><div class="package-pagination"><button class="button ghost" data-page="-1" ${page===0?'disabled':''}>Previous</button><span>${page+1} / ${pages}</span><button class="button ghost" data-page="1" ${page===pages-1?'disabled':''}>Next</button></div>`:'<div class="packages-empty">No sources match this view yet. Connect this project’s Drive folder or assign a source from Review unmatched.</div>'}`;
}
async function openSource(key){
 const o=owner,item=catalog?.items.find(i=>i.key===key);if(!item||!current(o))return;
 if(item.kind==='position'){window.RevexDesignContext?.open(item.chapterId,item.id);return;}
 if(item.kind==='specification'){document.querySelector('[data-view="spec"]')?.click();status('Opened Spec Book. Position: '+item.name);return;}
 let url=item.url;
 if(!url&&item.storagePath){try{url=await Store.fileUrl(item.storagePath);}catch(e){status(e.message,true);return;}}
 if(!current(o))return;
 if(!url&&item.sourceFolderUrl)url=item.sourceFolderUrl;
 if(Core.safeUrl(url))window.open(url,'_blank','noopener');else status('The source is indexed by path. Connect Drive and sync to resolve its direct file link: '+(item.path||item.name));
}
function assign(key){
 const o=owner,item=catalog?.items.find(i=>i.key===key);if(!item||!current(o))return;
 if(item.conflict){status('This source names a different project. Correct the source connection before assigning it.',true);return;}
 assignment.innerHTML=`<h2 id="package-assign-title">Assign to packages</h2><p>${esc(item.name)}</p><p class="packages-note">Choose every trade that needs this source. Manual choices remain through later syncs.</p><form><div class="package-checks">${Core.CATALOG.map(p=>`<label><input type="checkbox" name="package" value="${p.id}" ${item.packageIds.includes(p.id)?'checked':''}>${esc(p.name)}</label>`).join('')}</div><div class="packages-actions"><button class="button ghost" type="button" data-cancel>Cancel</button><button class="button" type="submit">Save assignment</button></div><p role="status"></p></form>`;
 assignment.querySelector('[data-cancel]').onclick=()=>assignment.close();assignment.querySelector('form').onsubmit=async e=>{e.preventDefault();const ids=[...assignment.querySelectorAll('input:checked')].map(x=>x.value);if(!current(o))return;const b=assignment.querySelector('[type=submit]');b.disabled=true;try{await Store.savePackageAssignment(o.projectId,key,ids);if(current(o)){overrides[key]={packageIds:ids};assignment.close();rebuild();}}catch(error){if(current(o)){assignment.querySelector('[role=status]').textContent=error.message;b.disabled=false;}}};assignment.showModal();
}
$('packages-content').addEventListener('click',e=>{const b=e.target.closest('button,a');if(!b)return;if(b.dataset.package){selected=b.dataset.package;page=0;render();}else if(b.hasAttribute('data-back')){selected='';page=0;render();}else if(b.dataset.source)void openSource(b.dataset.source);else if(b.dataset.assign)assign(b.dataset.assign);else if(b.dataset.page){page+=Number(b.dataset.page);render();}else if(b.dataset.viewLink){e.preventDefault();document.querySelector('.main-nav [data-view="'+b.dataset.viewLink+'"]')?.click();}});
$('packages-search').oninput=e=>{query=e.target.value;page=0;render();};$('packages-usage').onchange=e=>{usage=e.target.value;page=0;render();};$('packages-history').onchange=e=>{showHistory=e.target.checked;page=0;render();};$('packages-review').onclick=()=>{selected='review';page=0;render();};
$('packages-rebuild').onclick=()=>{rebuild();status('WALLT arranged known source names, formats and categories. Manual assignments were preserved. Review unmatched for uncertain sources.');};
$('packages-export').onclick=()=>{if(!catalog)return;const pack=catalog.packages.find(p=>p.id===selected);const blob=new Blob([Core.packageHtml(catalog,pack)],{type:'text/html'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(pack?.name||'Project packages')+' - '+catalog.projectName+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),30000);};
$('packages-save-folder').onclick=async()=>{const o=owner;if(!o||!current(o))return;try{const id=window.RevexPackageDrive.folderId($('packages-folder').value);await window.RevexPackageDrive.validateProjectFolder(id,o);if(!current(o))return;await Store.savePackageConfig(o.projectId,{driveProjectFolderId:id,drivePackagesUrl:null,autoSync:$('packages-auto').checked});if(current(o)){config={...config,driveProjectFolderId:id};status('Project folder verified inside LIBER-PROJECTS. Press Sync Drive to populate packages.');}}catch(e){if(current(o))status(e.message,true);}};
$('packages-auto').onchange=async()=>{if(!owner||!current(owner))return;try{await Store.savePackageConfig(owner.projectId,{autoSync:$('packages-auto').checked});}catch(e){status(e.message,true);}};
$('packages-drive-connect').onclick=()=>window.RevexPackageDrive.connect().then(()=>status('Drive connected for this session. Press Sync Drive.')).catch(e=>status(e.message,true));
$('packages-drive-sync').onclick=()=>void syncDrive();
async function syncDrive(){const o=owner;if(!catalog||!o||!current(o)||busy)return;busy=true;$('packages-drive-sync').disabled=true;try{await window.RevexPackageDrive.sync({owner:o,config,catalog,getCatalog:()=>catalog,current:()=>current(o),progress:m=>{if(current(o))status(m);}});if(current(o))status('Drive packages updated. Source files retain their original locations and permissions.');}catch(e){if(current(o))status(e.message,true);}finally{if(current(o)){busy=false;$('packages-drive-sync').disabled=false;}}}
window.RevexPackages={getCatalog:()=>catalog,context:()=>catalog?{packageCount:catalog.packages.length,sourceCount:catalog.sourceCount,reviewCount:catalog.review.length,packages:catalog.packages.map(p=>({name:p.name,sources:p.activeCount,procurement:p.procurementCount}))}:null,open:()=>document.querySelector('[data-view="packages"]')?.click(),arrange:()=>{rebuild();window.RevexPackages.open();},sync:syncDrive,refreshDriveFiles:files=>{driveFiles=files;rebuild();}};
for(const name of ['revex:project-boundary','revex:auth-mode-changed'])window.addEventListener(name,cancel);
for(const name of ['revex:authoritative-project-bound','revex:packages-open'])window.addEventListener(name,()=>void bind());
for(const name of ['revex:source-revision-loaded','revex:package-sources-changed'])window.addEventListener(name,schedule);
if(Store.user?.uid&&state().projectId)void bind();
