'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const viewer=read('docs/liber-apps/apps/revex/viewer-runtime-r75.js');
const runtime=read('docs/liber-apps/apps/revex/companion-runtime-r75.js');
const repair=read('docs/liber-apps/apps/revex/viewer-repair-r79.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const oldViewer=read('docs/liber-apps/apps/revex/viewer-r26.js');
const bridge=read('src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs');
const energyBridge=read('src/Liber.Revex.Revit/Services/EngineeringCompanionWebBridge.cs');
const managed=read('src/Liber.Revex.Revit/Engineering/Companion/native-managed-energy-bridge.js');
const diagnostics=read('docs/liber-apps/apps/revex/diagnostics-r29.js');
const energyDiagnostics=read('docs/liber-apps/apps/revex/energy-diagnostics-r68.js');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);

must(viewer,'targetFps:30','viewer performance target must stay explicit');
must(viewer,'proxyDuringInteraction:true','lightweight proxy must remain a valid interaction fallback');
must(viewer,'waitViewerIdle','geometry decode must yield to active orbit/pan');
must(viewer,"performance.now()-slice>5",'page parsing must use short cooperative slices');
must(viewer,'await nextFrame()','geometry decode must yield to rendering');
must(viewer,"cache:attempt===1?'force-cache':'default'",'immutable geometry must reuse local cache');
must(viewer,"proxyPreservedUntilComplete:true",'exact paged geometry must stay off-scene until complete');
must(viewer,'this.applyAppearances?.();rebuildInteractionProxy(this)','appearance must reproject after exact geometry promotion');
must(viewer,'appearanceFp(previous.get(key))!==appearanceFp(next.get(key))','appearance subscription must diff before touching mesh materials');
must(viewer,'scheduleAppearanceRows(this,changed)','appearance work must touch affected rows only');
must(viewer,'if(!node.isMesh)return','hidden meshes must stay indexed for restore');
must(viewer,'m.color.set(0xffffff)','texture must dominate design/model color');
must(viewer,'m.map=null','design color fallback must override model texture when no committed texture exists');
assert(!viewer.includes('setInterval('),'viewer runtime must not poll');
must(repair,'if(dt>42)slow++','legacy r79 file must keep measured adaptive-proxy semantics for compatibility');
must(repair,'if(!proxyMode&&slow>=3)','proxy fallback must be adaptive rather than unconditional');

must(runtime,'r75-provider-frame','material provider must be embedded in Properties');
must(runtime,"type:'liber:revex-integration-arm'",'embedded provider must arm user download interception');
assert(!runtime.includes('liber:revex-integration-open'),'separate provider browser window must not be used');
must(runtime,'Restore all hidden / deleted','unhide/restore-all control must be visible');
must(repair,"f.setDoc(f.doc(Store.db,'projects',projectId,'revexBimOverlays',row.id)",'legacy restore compatibility must use Store-supported writes');
assert(!repair.includes('writeBatch'),'legacy Restore All compatibility must not require unavailable Firestore writeBatch');

must(bridge,'DownloadStarting','native bridge must still intercept the user-triggered provider download');
must(bridge,'liber:revex-integration-file','download must return to originating Companion');
assert(!bridge.includes('ExecuteScriptAsync'),'provider bridge must never automate or scrape Architextures');

must(energyBridge,"input[data-liber-revex-native-managed-energy='1']",'managed Energy must own a private native-only FileList');
must(energyBridge,'DOM.setFileInputFiles','native host must bind exact immutable local files into the private input');
must(energyBridge,'bridge.processInput(files)','explicit Engineering handoff must invoke managed ingestion directly');
must(energyBridge,'input.remove();','private transfer input must be ephemeral');
const ensureStart=energyBridge.indexOf('public static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeAsync');
const coreStart=energyBridge.indexOf('private static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeCoreAsync');
assert(ensureStart>=0&&coreStart>ensureStart,'managed bridge ensure method must be isolatable');
const ensureBody=energyBridge.slice(ensureStart,coreStart);
assert(!ensureBody.includes('TryResumeLatestEngineeringRevisionAsync'),'opening/ensuring Companion must never resume an Engineering revision');
must(ensureBody,'return await EnsureManagedEnergyBridgeCoreAsync(web);','managed bridge ensure must be initialization-only');
assert(!energyBridge.includes('SetVirtualHostNameToFolderMapping'),'local Engineering handoff must not depend on browser virtual-host fetch');
assert(!energyBridge.includes('processUrls(entries)'),'local Engineering handoff must not use URL ingestion');
must(managed,'async function processInput(fileList)','managed bridge must ingest the native FileList directly');
must(managed,'async function waitForCloudStore(Store','managed ingestion must wait for authenticated cloud Store readiness');
must(managed,'Store?.isCloud?.() && Store?.user?.uid','cloud auth, not DOM readiness, must gate immutable publication');
must(managed,'await waitForCloudStore(Store, projectId, revision, startedAt)','explicit processInput must keep the preserved FileList alive until cloud auth is ready');
must(managed,"Engineering Sync is missing engineering-sync.json",'managed bridge must verify manifest before cloud publication');
must(managed,'Store.runEnergyServer(projectId, revision)','published revision replay must use project/revision server primitive');
assert(!managed.includes('async function processUrls('),'failed virtual-host URL ingestion must be removed, not left as a dead alternative');
assert(!managed.includes('VIRTUAL_HOST'),'failed virtual-host authority must not remain in the managed bridge');
assert(!managed.includes('fetch(parsed.href'),'managed local handoff must not reintroduce browser networking');

must(energyDiagnostics,'ENERGY_STALE_FAILURE_IGNORED','old Energy failures must be revision-scoped');
must(energyDiagnostics,'failedRevision!==current','failure UI must compare result revision with current Engineering revision');
must(energyDiagnostics,'Retry this published revision','current failed revision must remain replayable after server repair');
must(energyDiagnostics,'no Revit export or re-sync is started','published revision replay must remain independent from Revit');

must(diagnostics,'DEDUPE_MS','browser diagnostics must be deduplicated');
must(diagnostics,'repeatCount','duplicate evidence must be counted rather than spammed');

must(ui,"loadScript('viewer-runtime-r75.js?v=20260816r75-viewer1'",'r75 viewer must load');
must(ui,"loadScript('companion-runtime-r75.js?v=20260816r75-companion1'",'r75 Companion runtime must load');
must(ui,"energy-diagnostics-r68.js?v=20260816r87-energy-replay1",'revision-scoped replay diagnostics must load');
assert(!ui.includes("loadScript('viewer-runtime-r72.js"),'r72 viewer runtime must no longer load');
assert(!ui.includes("loadScript('material-modal-r72.js"),'r72 provider window runtime must no longer load');
assert(!ui.includes("loadScript('docs-pages-r68.js"),'main-thread PDF splitter must no longer load');

must(oldViewer,'this.model=this.proxy(rows)','base viewer must retain immediate metadata fallback while exact geometry builds');
must(oldViewer,'if(state?.modelUrl)setTimeout','base auto detail call remains intercepted by r75 wrapper');
console.log(JSON.stringify({schema:'liber.revex.r87-viewer-energy-qa.v1',status:'PASSED',viewer:{targetFps:30,interactionPreemptsDetail:true,adaptiveProxy:true,exactSwapOnlyAfterComplete:true,incrementalAppearance:true,hiddenRestorable:true},materials:{embeddedProperties:true,userDownloadAutoApply:true,separateWindow:false},energy:{privateManagedFileList:true,cloudAuthGated:true,virtualHostFetchRemoved:true,deadUrlPathRemoved:true,entryInitializationOnly:true,publishedRevisionReplay:true,staleFailureRevisionScoped:true},diagnostics:{deduplicated:true},docs:{mainThreadSplitterDisabled:true}},null,2));
