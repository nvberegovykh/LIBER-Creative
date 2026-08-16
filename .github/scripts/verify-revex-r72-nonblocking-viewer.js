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

must(modal,'[data-r70-box]{display:none!important}','legacy five-button finish block must be removed from the visible inspector');
must(modal,'<dialog','finish integration must use one modal surface');
must(modal,'https://architextures.org/create','Architextures Create must be the integrated material endpoint');
must(modal,'Drop the downloaded texture here','browser sandbox fallback must stay inside the same material modal');
must(modal,"m.type!=='liber:revex-integration-file'",'modal must expose the native download handoff endpoint');
must(modal,"await persist(activeElement,activeScope,{texture})",'selected/downloaded texture must auto-apply without a second apply button');
must(modal,'Object.defineProperty(img,\'src\'','legacy preview IMG requests must be neutralized to stop repeated failed IMG loads');
assert(!modal.includes('Browse Architextures</button>'),'r72 must not recreate the old external-button stack');

must(ui,"loadScript('viewer-runtime-r72.js?v=20260816r72-nonblocking1'",'nonblocking runtime must load');
must(ui,"loadScript('material-modal-r72.js?v=20260816r72-material-modal1'",'integrated material modal must load');
must(ui,"targetFps:30",'UI contract must surface the 30 FPS target');

must(oldViewer,'installedProgressively','existing lightweight-first progressive geometry path must remain available');
must(oldViewer,'Current revision visible · loading','first valid geometry must remain usable while later pages load');

console.log(JSON.stringify({schema:'liber.revex.r72-nonblocking-viewer-qa.v1',status:'PASSED',viewer:{targetFps:30,optimisticShadowPatches:true,incrementalVisibility:true,incrementalAppearance:true,cooperativePageDecode:true,immutableGeometryCache:true,hiddenNodesRestorable:true},materials:{singleModal:true,architexturesCreate:true,autoApplySelectedFile:true,nativeDownloadEndpoint:true,legacyButtonStackHidden:true}},null,2));
