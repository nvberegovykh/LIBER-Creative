'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const viewer=read('docs/liber-apps/apps/revex/viewer-runtime-r72.js');
const modal=read('docs/liber-apps/apps/revex/material-modal-r72.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const oldViewer=read('docs/liber-apps/apps/revex/viewer-r26.js');
const bridge=read('src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);

must(viewer,'targetFps:30','viewer performance target must be explicit');
must(viewer,'v.applyOverlayPatch=function','visibility/restore must have an O(affected-element) optimistic path');
must(viewer,'fingerprint(a)===fingerprint(b)','overlay subscription updates must diff before touching render nodes');
must(viewer,'for(const key of keys)','overlay changes must iterate changed overlay keys rather than every model element');
must(viewer,'wrapped.__r72Optimistic=true','cloud persistence must not block visual restore/hide feedback');
must(viewer,"cache:attempt===1?'force-cache':'default'",'immutable geometry reload must reuse local browser cache');
must(viewer,'performance.now()-slice>7','page parsing must yield inside long geometry work');
must(viewer,'await yieldFrame()','geometry decode must yield back to rendering');
must(viewer,'const meshBytes=decompressed.slice(p,p+byteLength)','unaligned stream mesh buffers must be copied to aligned ArrayBuffers');
assert(!viewer.includes('new Float32Array(decompressed,p,'),'unaligned Float32Array views are forbidden');
must(viewer,'node.userData.r70base?.length','r72 must recover the original pre-r70 material rather than stacking appearance clones');
must(viewer,'v.__r72RowsByType','same-type appearance must use a prebuilt type index');
must(viewer,'scheduleAppearanceRows(this,changed)','appearance changes must touch only affected instance/type rows');
must(viewer,'if(!node.isMesh)return','hidden meshes must remain indexed so Restore cannot lose them');

must(modal,'[data-r70-box]{display:none!important}','legacy finish button block must be hidden');
must(modal,"document.createElement('dialog')",'finish integration must keep one Companion modal endpoint');
must(modal,'https://architextures.org/create','Architextures Create must be the material provider endpoint');
must(modal,"type:'liber:revex-integration-open'",'Material click must invoke the native provider browser endpoint');
must(modal,"m.type==='liber:revex-integration-file'",'Companion must receive the user-downloaded material image');
must(modal,"await persist(activeElement,activeScope,{enabled:true,texture})",'downloaded texture must auto-apply without a second Apply button');
must(modal,'Object.defineProperty(img,\'src\'','legacy preview IMG requests must be neutralized');
must(modal,'Repeat X','texture mapping controls must remain available');
must(modal,'Rotation °','texture rotation control must remain available');
assert(!modal.includes('data-r72-frame'),'Architextures must not be embedded as a fragile iframe');
assert(!modal.includes('Open separately'),'old external-site detour must not return');
assert(!modal.includes('Browse Architextures</button>'),'old external-button stack must not return');

must(bridge,'liber:revex-integration-open','native bridge must accept one provider-open message');
must(bridge,'EnsureCoreWebView2Async(origin.CoreWebView2.Environment)','owned provider browser must share the Companion WebView2 environment/profile');
must(bridge,'DownloadStarting','native bridge must intercept only the user-triggered download');
must(bridge,'liber:revex-integration-file','download must return to the originating Companion');
must(bridge,'ReturnTarget','child provider WebView must return results to the origin WebView');
must(bridge,'IsArchitexturesUri','provider URL must be allowlisted');
must(bridge,'MaxMaterialBytes','provider download must be size bounded');
must(bridge,'providerWindow.Close','provider window must close after successful material handoff');
assert(!bridge.includes('ExecuteScriptAsync'),'provider bridge must never automate or scrape the provider site');

must(ui,"loadScript('viewer-runtime-r72.js?v=20260816r72-nonblocking1'",'nonblocking runtime must load');
must(ui,"loadScript('material-modal-r72.js?v=20260816r72-material-modal2'",'owned material-browser runtime must load with a fresh cache token');
must(ui,'targetFps:30','UI contract must retain the 30 FPS target');

must(oldViewer,'installedProgressively','existing lightweight-first progressive geometry path must remain available');
must(oldViewer,'Current revision visible · loading','first valid geometry must remain usable while later pages load');

console.log(JSON.stringify({schema:'liber.revex.r72.1-nonblocking-viewer-qa.v1',status:'PASSED',viewer:{targetFps:30,optimisticShadowPatches:true,incrementalVisibility:true,incrementalAppearance:true,cooperativePageDecode:true,immutableGeometryCache:true,hiddenNodesRestorable:true},materials:{singleModalEndpoint:true,ownedProviderWebView:true,sharedWebViewProfile:true,architexturesCreate:true,userDownloadIntercept:true,autoApply:true,mappingControls:true,providerAutomation:false,legacyButtonStackHidden:true}},null,2));
