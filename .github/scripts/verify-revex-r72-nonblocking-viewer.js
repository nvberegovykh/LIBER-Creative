'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const viewer=read('docs/liber-apps/apps/revex/viewer-runtime-r75.js');
const runtime=read('docs/liber-apps/apps/revex/companion-runtime-r75.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const oldViewer=read('docs/liber-apps/apps/revex/viewer-r26.js');
const bridge=read('src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs');
const energyBridge=read('src/Liber.Revex.Revit/Services/EngineeringCompanionWebBridge.cs');
const managed=read('src/Liber.Revex.Revit/Engineering/Companion/native-managed-energy-bridge.js');
const diagnostics=read('docs/liber-apps/apps/revex/diagnostics-r29.js');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);

must(viewer,'targetFps:30','viewer performance target must stay explicit');
must(viewer,'proxyDuringInteraction:true','lightweight proxy must be the interaction fallback');
must(viewer,'waitViewerIdle','geometry decode must yield to active orbit/pan');
must(viewer,"performance.now()-slice>5",'page parsing must use short cooperative slices');
must(viewer,'await nextFrame()','geometry decode must yield to rendering');
must(viewer,"cache:attempt===1?'force-cache':'default'",'immutable geometry must reuse local cache');
must(viewer,"proxyPreservedUntilComplete:true",'exact paged geometry must stay off-scene until complete');
must(viewer,'switchInteractionProxy(v,true)','orbit must switch to the lightweight proxy immediately');
must(viewer,'switchInteractionProxy(v,false)','idle state must return to exact geometry');
must(viewer,'this.applyAppearances?.();rebuildInteractionProxy(this)','appearance must reproject after exact geometry promotion');
must(viewer,'appearanceFp(previous.get(key))!==appearanceFp(next.get(key))','appearance subscription must diff before touching mesh materials');
must(viewer,'scheduleAppearanceRows(this,changed)','appearance work must touch affected rows only');
must(viewer,'if(!node.isMesh)return','hidden meshes must stay indexed for restore');
must(viewer,'m.color.set(0xffffff)','texture must dominate design/model color');
must(viewer,'m.map=null','design color fallback must override model texture when no committed texture exists');
assert(!viewer.includes('setInterval('),'viewer runtime must not poll');

must(runtime,'r75-provider-frame','material provider must be embedded in Properties');
must(runtime,"type:'liber:revex-integration-arm'",'embedded provider must arm user download interception');
assert(!runtime.includes('liber:revex-integration-open'),'separate provider browser window must not be used');
must(runtime,'Restore all hidden / deleted','unhide/restore-all control must be visible');
must(runtime,'offset+=400','restore-all persistence must be batched');

must(bridge,'DownloadStarting','native bridge must still intercept the user-triggered provider download');
must(bridge,'liber:revex-integration-file','download must return to originating Companion');
assert(!bridge.includes('ExecuteScriptAsync'),'provider bridge must never automate or scrape Architextures');

must(energyBridge,'SetVirtualHostNameToFolderMapping','managed Energy must read the committed local revision without file-input transport');
must(energyBridge,'revex-engineering.local','managed Energy virtual host must be private and deterministic');
must(energyBridge,'bridge?.processUrls','native handoff must invoke URL-based revision ingestion');
must(managed,'async function processUrls(entries)','managed bridge must rebuild the File set from immutable URLs');
must(managed,"parsed.hostname !== VIRTUAL_HOST",'managed bridge must reject other URL origins');
must(managed,"names.includes('engineering-sync.json')",'native URL handoff must verify manifest before processing');
must(managed,"names.some(name => name.endsWith('.xml'))",'native URL handoff must verify Revit gbXML before processing');

must(diagnostics,'DEDUPE_MS','browser diagnostics must be deduplicated');
must(diagnostics,'repeatCount','duplicate evidence must be counted rather than spammed');

must(ui,"loadScript('viewer-runtime-r75.js?v=20260816r75-viewer1'",'r75 viewer must load');
must(ui,"loadScript('companion-runtime-r75.js?v=20260816r75-companion1'",'r75 Companion runtime must load');
assert(!ui.includes("loadScript('viewer-runtime-r72.js"),'r72 viewer runtime must no longer load');
assert(!ui.includes("loadScript('material-modal-r72.js"),'r72 provider window runtime must no longer load');
assert(!ui.includes("loadScript('docs-pages-r68.js"),'main-thread PDF splitter must no longer load');

must(oldViewer,'this.model=this.proxy(rows)','base viewer must retain immediate metadata proxy');
must(oldViewer,'if(state?.modelUrl)setTimeout','base auto detail call remains intercepted by r75 wrapper');
console.log(JSON.stringify({schema:'liber.revex.r75-viewer-qa.v1',status:'PASSED',viewer:{targetFps:30,interactionPreemptsDetail:true,proxyDuringOrbit:true,exactSwapOnlyAfterComplete:true,incrementalAppearance:true,hiddenRestorable:true},materials:{embeddedProperties:true,userDownloadAutoApply:true,separateWindow:false},energy:{immutableVirtualHost:true,fileInputRaceRemoved:true},diagnostics:{deduplicated:true},docs:{mainThreadSplitterDisabled:true}},null,2));
