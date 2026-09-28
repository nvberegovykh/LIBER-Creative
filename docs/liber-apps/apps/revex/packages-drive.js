/* Google Drive projection: in-memory OAuth, bounded project scan, source shortcuts, owned indexes.
 * No source moves, content rewriting, ACL changes, or unattended credential storage. */
(function(root){
 'use strict';
 const Core=root.RevexPackagesCore,Store=root.RevexStore;
 const CLIENT_ID='165400046589-ijaucmn2eovfmqof1rhjr46bk34j2o67.apps.googleusercontent.com';
 const SCOPE='https://www.googleapis.com/auth/drive';
 const MIME_FOLDER='application/vnd.google-apps.folder',MIME_SHORTCUT='application/vnd.google-apps.shortcut';
 const fields='id,name,mimeType,parents,modifiedTime,webViewLink,size,trashed,shortcutDetails,appProperties,capabilities(canEdit,canAddChildren)';
 let credential=null,boundary=0,connecting=null,autoTimer=0,lastProjection='';
 const uid=()=>Store.user?.uid||'';
 const connected=()=>!!credential&&credential.uid===uid()&&credential.expires>Date.now()+60000;
 function clear(){credential=null;boundary++;clearTimeout(autoTimer);lastProjection='';}
 root.addEventListener('revex:auth-mode-changed',clear);
 root.addEventListener('revex:project-boundary',()=>{clearTimeout(autoTimer);lastProjection='';});
 async function loadGoogle(){if(root.google?.accounts?.oauth2)return;await new Promise((resolve,reject)=>{let s=document.querySelector('script[data-revex-drive-google]');if(s)return reject(Error('Google connection is still loading. Try again shortly.'));s=document.createElement('script');s.dataset.revexDriveGoogle='1';s.src='https://accounts.google.com/gsi/client';s.onload=resolve;s.onerror=()=>{s.remove();reject(Error('Google connection could not load.'));};document.head.append(s);});}
 void loadGoogle().catch(()=>{});
 function connect(){
  if(connected())return Promise.resolve();if(connecting)return connecting;if(!uid())return Promise.reject(Error('Sign in to REVEX first.'));
  if(!root.google?.accounts?.oauth2){void loadGoogle().catch(()=>{});return Promise.reject(Error('Google connection is loading. Press Connect Drive again.'));}
  const account=uid(),generation=boundary;
  connecting=new Promise((resolve,reject)=>{
   const client=root.google.accounts.oauth2.initTokenClient({client_id:CLIENT_ID,scope:SCOPE,include_granted_scopes:false,callback:r=>{
    if(account!==uid()||generation!==boundary)return reject(Error('Account changed. Connect Drive again.'));
    if(r.error||!r.access_token||!root.google.accounts.oauth2.hasGrantedAllScopes(r,SCOPE))return reject(Error('Google Drive permission was not granted.'));
    credential={uid:account,token:r.access_token,expires:Date.now()+Number(r.expires_in||0)*1000};resolve();
   },error_callback:()=>reject(Error('Google Drive connection was cancelled or blocked.'))});client.requestAccessToken({prompt:'select_account'});
  }).finally(()=>{connecting=null;});return connecting;
 }
 function folderId(value){const s=String(value||'').trim();let id=s;if(/^https:/i.test(s)){const u=new URL(s);if(u.hostname!=='drive.google.com')throw Error('Use a Google Drive folder link.');id=u.pathname.match(/\/folders\/([\w-]+)/)?.[1]||'';}if(!/^[\w-]{10,180}$/.test(id))throw Error('Enter this project’s Google Drive folder link.');return id;}
 const qval=value=>String(value).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
 async function request(path,options={},guard=()=>true){
  if(!guard())throw Error('Project changed; Drive sync stopped.');if(!connected())throw Error('Reconnect Drive to continue syncing.');
  const c=credential;
  const headers=new Headers(options.headers||{});headers.set('Authorization','Bearer '+c.token);if(options.body&&!(options.body instanceof Blob)&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const response=await fetch('https://www.googleapis.com/'+path,{...options,headers,signal:AbortSignal.timeout(60000)});
  if(!guard()||credential!==c)throw Error('Project or Google account changed; Drive sync stopped.');
  if(!response.ok){const text=await response.text();let message=text;try{message=JSON.parse(text)?.error?.message||text;}catch{}if(response.status===401)credential=null;throw Error('Drive '+response.status+': '+message.slice(0,300));}
  if(options.rawText)return response.text();
  return response.status===204?{}:response.json();
 }
 async function list(parent,guard){const rows=[];let next='';do{const q=new URLSearchParams({q:`'${qval(parent)}' in parents and trashed = false`,pageSize:'1000',fields:'nextPageToken,files('+fields+')',supportsAllDrives:'true',includeItemsFromAllDrives:'true',...(next?{pageToken:next}:{})});const result=await request('drive/v3/files?'+q,{},guard);rows.push(...result.files||[]);next=result.nextPageToken||'';}while(next);return rows;}
 async function validateProjectFolder(id,o){
  const guard=()=>root.__revexState?.projectId===o.projectId&&uid()===o.uid&&root.__revexState?.activationToken===o.activation;
  if(id===Core.ROOT_ID)throw Error('Choose a project folder inside LIBER-PROJECTS, not LIBER-PROJECTS itself.');
  const origin=await request('drive/v3/files/'+encodeURIComponent(id)+'?supportsAllDrives=true&fields='+encodeURIComponent(fields),{},guard);
  if(origin.mimeType!==MIME_FOLDER)throw Error('The selected item is not a folder.');
  if(!origin.capabilities?.canAddChildren)throw Error('This Google account cannot create packages in the project folder.');
  let frontier=origin.parents||[],seen=new Set([id]),found=false;
  for(let depth=0;frontier.length&&depth<12;depth++){
   if(frontier.includes(Core.ROOT_ID)){found=true;break;}const next=[];
   for(const parent of frontier){if(seen.has(parent))continue;seen.add(parent);const meta=await request('drive/v3/files/'+encodeURIComponent(parent)+'?supportsAllDrives=true&fields=id,parents',{},guard);next.push(...meta.parents||[]);}frontier=next;
  }
  if(!found)throw Error('The project folder must be inside the connected LIBER-PROJECTS root.');
  const normalize=s=>Core.normalize(s).replace(/\bstreet\b/g,'st').replace(/\bavenue\b/g,'ave').replace(/\broad\b/g,'rd');
  if(normalize(origin.name)!==normalize(root.__revexState?.project?.name))throw Error('Folder name does not match the active project. Use its exact project folder.');
  return origin;
 }
 async function ensureFolder(parent,name,guard){
  const existing=(await list(parent,guard)).filter(f=>f.name===name&&f.mimeType===MIME_FOLDER);
  if(existing.length>1)throw Error('Several '+name+' folders exist. Resolve the duplicate folders before syncing.');
  if(existing.length)return existing[0];
  return request('drive/v3/files?supportsAllDrives=true&fields='+encodeURIComponent(fields),{method:'POST',body:JSON.stringify({name,mimeType:MIME_FOLDER,parents:[parent],appProperties:{revexPackages:'v1'}})},guard);
 }
 async function scan(folder,guard,progress){
  const queue=[{id:folder,path:''}],visited=new Set(),files=[];
  while(queue.length){if(visited.size>=1500||files.length>=25000)throw Error('Project scan exceeded its bound. No source index was replaced. Narrow connected folders.');
   const parent=queue.shift();if(visited.has(parent.id))continue;visited.add(parent.id);
   for(const f of await list(parent.id,guard)){
    if(f.name===Core.FOLDER||/^\.|desktop\.ini$/i.test(f.name)||/_backup$/i.test(f.name))continue;
    const path=[parent.path,f.name].filter(Boolean).join('/');
    if(f.mimeType===MIME_FOLDER){if(!/(^|\/)(?:archive|\d+_archive|backup)(?:\/|$)/i.test(path))queue.push({id:f.id,path});continue;}
    if(f.mimeType===MIME_SHORTCUT)continue; // Do not escape the bound project through shortcut targets.
    files.push({id:f.id,key:'drive:'+f.id,name:f.name,path,mimeType:f.mimeType,url:f.webViewLink||'',modifiedTime:f.modifiedTime,size:f.size||null,source:'drive'});
   }
   if(visited.size%10===0)progress(`Reading Drive source metadata… ${files.length} files in ${visited.size} folders.`);
  }
  return files;
 }
 async function uploadIndex(folder,name,html,existing,guard,properties){
  let file=existing.find(f=>f.name===name&&f.appProperties?.revexPackages==='v1');
  const seeded=existing.find(f=>f.name===name&&f.mimeType==='text/html'&&!f.appProperties?.revexPackages);
  if(!file&&seeded){
   const content=await request('drive/v3/files/'+seeded.id+'?alt=media&supportsAllDrives=true',{rawText:true},guard);
   if(content.startsWith('<!doctype html><!-- liber.revex.procurement-packages.v1 -->')){file=seeded;await request('drive/v3/files/'+file.id+'?supportsAllDrives=true',{method:'PATCH',body:JSON.stringify({appProperties:{revexPackages:'v1',...properties}})},guard);}
  }
  if(!file){const collision=existing.find(f=>f.name===name);if(collision)name='REVEX_'+name;file=existing.find(f=>f.name===name&&f.appProperties?.revexPackages==='v1');}
  if(!file)file=await request('drive/v3/files?supportsAllDrives=true&fields=id,name',{method:'POST',body:JSON.stringify({name,mimeType:'text/html',parents:[folder],appProperties:{revexPackages:'v1',...properties}})},guard);
  await request('upload/drive/v3/files/'+file.id+'?uploadType=media&supportsAllDrives=true',{method:'PATCH',headers:{'Content-Type':'text/html; charset=utf-8'},body:html},guard);
  return file;
 }
 async function claim(projectId,guard){
  const api=Store.api,ref=api.doc(Store.db,'projects',projectId,'library','revex_packages_lock'),id=crypto.randomUUID();
  if(!api.runTransaction)throw Error('Shared sync lock is unavailable. Reload REVEX.');
  await api.runTransaction(Store.db,async tx=>{const snap=await tx.get(ref);if(!guard())throw Error('Project changed.');if(snap.exists()&&snap.data().expiresAt>Date.now())throw Error('Another collaborator is syncing these packages. Try again shortly.');tx.set(ref,Store.toFirestorePlain({type:'revex',hidden:true,revexKind:'packages-lock',id,expiresAt:Date.now()+20*60000}));});
  return async()=>api.runTransaction(Store.db,async tx=>{const snap=await tx.get(ref);if(snap.data()?.id===id)tx.set(ref,Store.toFirestorePlain({expiresAt:0}),Store.toFirestorePlain({merge:true}));});
 }
 async function sync({owner,config,catalog,getCatalog,current:guard,progress}){
  if(!connected())throw Error('Press Connect Drive first.');if(!config.driveProjectFolderId)throw Error('Set this project’s Drive folder under Project folder and sync.');
  const release=await claim(owner.projectId,guard);
  try{
   await validateProjectFolder(config.driveProjectFolderId,owner);progress('Reading connected Drive files…');
   const files=await scan(config.driveProjectFolderId,guard,progress);await Store.savePackageDriveSources(owner.projectId,files,guard);
   if(!guard())throw Error('Project changed.');root.RevexPackages.refreshDriveFiles(files);catalog=getCatalog();
   const target=await ensureFolder(config.driveProjectFolderId,Core.FOLDER,guard),children=await list(target.id,guard);
   const common=await ensureFolder(target.id,'00_PROJECT_REFERENCES',guard),folderLinks=new Map();
   const referenceRows=catalog.items.filter(i=>i.common&&!i.archived),groups=[{id:'common',name:'Project references',folder:common,items:referenceRows},...catalog.packages.map(p=>({...p,items:p.items.filter(i=>!i.common)}))];
   for(const [index,group] of groups.entries()){
    progress(`Syncing ${index+1}/${groups.length}: ${group.name}`);
    const folder=group.folder||children.find(f=>f.name===group.name&&f.mimeType===MIME_FOLDER)||await ensureFolder(target.id,group.name,guard),entries=await list(folder.id,guard),desired=new Set();
    folderLinks.set(group.id,'https://drive.google.com/drive/folders/'+folder.id);
    for(const item of group.items.filter(i=>i.source==='drive'&&!i.archived&&i.id&&!i.review)){
     desired.add(item.id);if(entries.some(f=>f.mimeType===MIME_SHORTCUT&&f.shortcutDetails?.targetId===item.id))continue;
     await request('drive/v3/files?supportsAllDrives=true&fields=id',{method:'POST',body:JSON.stringify({name:item.name,mimeType:MIME_SHORTCUT,parents:[folder.id],shortcutDetails:{targetId:item.id},appProperties:{revexPackages:'v1',sourceId:item.id,packageId:group.id}})},guard);
    }
    // Only our obsolete shortcuts are retired; original documents and manually added content stay intact.
    for(const f of entries.filter(f=>f.mimeType===MIME_SHORTCUT&&f.appProperties?.revexPackages==='v1'&&!desired.has(f.shortcutDetails?.targetId)))await request('drive/v3/files/'+f.id+'?supportsAllDrives=true',{method:'PATCH',body:JSON.stringify({trashed:true})},guard);
    const fullGroup=group.id==='common'?group:catalog.packages.find(p=>p.id===group.id);
    await uploadIndex(folder.id,'00_PACKAGE.html',Core.packageHtml(catalog,fullGroup),entries,guard,{packageId:group.id});
   }
   await uploadIndex(target.id,'00_PACKAGES.html',Core.packageHtml(catalog,null,undefined,p=>folderLinks.get(p.id)),await list(target.id,guard),guard,{packageId:'index'});
   if(!guard())throw Error('Project changed.');
   await Store.savePackageConfig(owner.projectId,{drivePackagesUrl:target.webViewLink||'https://drive.google.com/drive/folders/'+target.id,drivePackagesFolderId:target.id,driveSyncedAt:new Date().toISOString(),syncVersion:Core.VERSION});
   lastProjection=fingerprint(catalog);
  }finally{await release().catch(()=>{});}
 }
 function fingerprint(catalog){return JSON.stringify(catalog.items.map(i=>[i.key,i.name,i.modifiedAt,i.packageIds,i.status,i.archived,i.quantity,i.unit,i.description,i.sourceLink]));}
 // Debounced source events, no DOM polling or per-frame work. A visible session and unexpired consent are required.
 root.addEventListener('revex:packages-updated',()=>{clearTimeout(autoTimer);if(!connected())return;autoTimer=setTimeout(async()=>{
  const s=root.__revexState,catalog=root.RevexPackages?.getCatalog();if(!s?.projectId||!catalog||document.hidden||fingerprint(catalog)===lastProjection)return;
  const projectId=s.projectId,account=uid(),cfg=await Store.getPackageConfig(projectId).catch(()=>null);
  if(cfg?.autoSync&&s.projectId===projectId&&account===uid())void root.RevexPackages.sync();
 },5000);});
 // Drive itself does not emit REVEX events. Refresh external edits while an opted-in session is visible.
 const refreshIfEnabled=async()=>{if(!connected()||document.hidden)return;const s=root.__revexState,project=s?.projectId,account=uid();if(!project)return;const cfg=await Store.getPackageConfig(project).catch(()=>null);if(cfg?.autoSync&&s.projectId===project&&uid()===account)void root.RevexPackages?.sync();};
 setInterval(refreshIfEnabled,15*60*1000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshIfEnabled();});
 root.RevexPackageDrive={connect,connected,folderId,validateProjectFolder,sync};
})(window);
