const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto').webcrypto;
const Core=require('../docs/liber-apps/apps/revex/packages-core.js');
test('Drive bridge reconciles shortcuts idempotently and preserves originals and manual files',async()=>{
 const folder='application/vnd.google-apps.folder',shortcut='application/vnd.google-apps.shortcut',events={},docs=new Map(),files=new Map();let catalog,serial=0,mutations=0;
 const put=(id,data)=>files.set(id,{id,capabilities:{canAddChildren:true},...data});
 put(Core.ROOT_ID,{name:'LIBER-PROJECTS',mimeType:folder,parents:[]});put('projectfolder01',{name:'79 Winthrop Street',mimeType:folder,parents:[Core.ROOT_ID]});
 put('source-file01',{name:'Windows.pdf',mimeType:'application/pdf',parents:['projectfolder01'],webViewLink:'https://drive.google.com/file/d/source-file01/view'});
 put('foreign-file01',{name:'87 Winthrop Street HVAC.pdf',mimeType:'application/pdf',parents:['projectfolder01']});
 put('package-root01',{name:Core.FOLDER,mimeType:folder,parents:['projectfolder01']});put('windowsfolder1',{name:'WINDOWS',mimeType:folder,parents:['package-root01']});
 put('seed-index01',{name:'00_PACKAGE.html',mimeType:'text/html',parents:['windowsfolder1'],content:'<!doctype html><!-- liber.revex.procurement-packages.v1 -->seed'});
 put('manual-link01',{name:'Manual reference',mimeType:shortcut,parents:['windowsfolder1'],shortcutDetails:{targetId:'foreign-file01'}});
 const api={doc:(_, ...p)=>p.join('/'),getDoc:async r=>({exists:()=>docs.has(r),data:()=>docs.get(r)}),setDoc:async(r,v,options)=>docs.set(r,options?.merge?{...docs.get(r),...v}:v),deleteDoc:async r=>docs.delete(r),runTransaction:async(_,fn)=>fn({get:api?.getDoc,set:(r,v,o)=>api.setDoc(r,v,o)})};
 const Store={api,db:{},user:{uid:'u1'},isCloud:()=>true,toFirestorePlain:v=>JSON.parse(JSON.stringify(v))};
 const root={RevexPackagesCore:Core,RevexStore:Store,__revexState:{projectId:'p1',project:{name:'79 Winthrop Street'},activationToken:1},addEventListener:(n,f)=>events[n]=f,google:{accounts:{oauth2:{hasGrantedAllScopes:()=>true,initTokenClient:o=>({requestAccessToken:()=>o.callback({access_token:'synthetic-test-only',expires_in:3600})})}}}};
 const context={window:root,document:{hidden:false,addEventListener:()=>{}},crypto,TextEncoder,Headers,URL,URLSearchParams,Blob,AbortSignal,setTimeout,clearTimeout,setInterval:()=>0,fetch:async(url,options)=>{
  const u=new URL(url),id=u.pathname.match(/\/files\/([^/]+)$/)?.[1],method=options.method||'GET';
  if(method==='GET'&&id){const f=files.get(id);return new Response(u.searchParams.get('alt')==='media'?f.content:JSON.stringify(f),{status:200});}
  if(method==='GET'){const parent=u.searchParams.get('q').match(/^'([^']+)' in parents/)[1];return new Response(JSON.stringify({files:[...files.values()].filter(f=>!f.trashed&&f.parents?.includes(parent))}));}
  mutations++;if(u.pathname.startsWith('/upload/')){files.get(id).content=options.body;return new Response(JSON.stringify({id}));}
  const data=JSON.parse(options.body);if(method==='POST'){const id='generated-'+(++serial);put(id,data);return new Response(JSON.stringify(files.get(id)));}Object.assign(files.get(id),data);return new Response(JSON.stringify(files.get(id)));
 }};
 vm.createContext(context);for(const name of ['packages-store.js','packages-drive.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../docs/liber-apps/apps/revex',name),'utf8'),context);
 root.RevexPackages={refreshDriveFiles:f=>{catalog=Core.build({project:{id:'p1',name:'79 Winthrop Street'},files:f});}};
 await root.RevexPackageDrive.connect();const owner={projectId:'p1',uid:'u1',activation:1},config={driveProjectFolderId:'projectfolder01'},sync=()=>root.RevexPackageDrive.sync({owner,config,catalog,getCatalog:()=>catalog,current:()=>root.__revexState.projectId==='p1',progress:()=>{}});
 await sync();const count=files.size;await sync();assert.equal(files.size,count,'Repeated sync duplicated files');
 const generated=()=>[...files.values()].filter(f=>f.mimeType===shortcut&&f.appProperties?.revexPackages==='v1'&&!f.trashed);assert.equal(generated().length,1);assert.equal(generated()[0].shortcutDetails.targetId,'source-file01');assert.equal(files.get('seed-index01').appProperties.revexPackages,'v1','Seed index was not safely adopted');assert(!files.get('manual-link01').trashed);assert(!files.get('foreign-file01').trashed);
 files.get('source-file01').name='Appliances.pdf';await sync();assert.equal(generated().length,1);assert.equal(generated()[0].appProperties.packageId,'appliances');assert.equal(files.get('source-file01').name,'Appliances.pdf');assert(!files.get('manual-link01').trashed);
 const before=mutations;root.__revexState.projectId='p2';await assert.rejects(sync,/Project changed/);assert.equal(mutations,before,'Stale project wrote to Drive');
 // Commit-last source pointer survives an interrupted replacement.
 const previous=await Store.getPackageConfig('p1');let checks=0;await assert.rejects(Store.savePackageDriveSources('p1',[...Array(160)].map((_,i)=>({id:String(i)})),()=>++checks<3),/Project changed/);assert.equal((await Store.getPackageConfig('p1')).driveSourceGeneration,previous.driveSourceGeneration);
});
