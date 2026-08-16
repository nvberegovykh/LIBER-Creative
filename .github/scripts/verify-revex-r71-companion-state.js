'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const state=read('docs/liber-apps/apps/revex/appearance-state-r75.js');
const runtime=read('docs/liber-apps/apps/revex/companion-runtime-r75.js');
const sw=read('docs/liber-apps/sw.js');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);

must(ui,'__revexR71CanonicalViewerState','canonical Store state must still install before app hydration');
must(ui,'delete next.material','geometry/visibility commits must not carry appearance');
must(ui,"next.visibility=visibility",'visibility must persist as one canonical state');
must(ui,"loadScript('appearance-state-r75.js?v=20260816r75-appearance1'",'single appearance state owner must load');
must(ui,"loadScript('companion-runtime-r75.js?v=20260816r75-companion1'",'single properties/filter owner must load');
assert(!ui.includes("loadScript('appearance-r70.js"),'deprecated r70 runtime must not load');
assert(!ui.includes("loadScript('companion-state-r71.js"),'deprecated r71 state poller must not load');
assert(!ui.includes("loadScript('model-filter-r71.js"),'deprecated r71 filter poller must not load');
assert(!ui.includes("loadScript('docs-pages-r68.js"),'main-thread PDF splitter must not load');
assert(ui.indexOf('installCanonicalOverlayStore();') < ui.indexOf('function updateProjectId'), 'canonical Store wrapper must install synchronously before DOM/project binding');

must(state,"Store.subscribeKind(projectId,'bim-appearance'",'appearance must live-subscribe by project');
must(state,'s.bimAppearances=new Map()','project switching must clear stale appearance');
must(state,"root.__revexViewerR26Instance?.setAppearances?.([])",'stale finish must leave viewport immediately');
must(state,"root.addEventListener('revex:authoritative-project-bound'",'authoritative project binding must drive appearance ownership');
must(state,'Store.saveBimAppearance=save','appearance persistence must have one owner');
must(state,"revexKind:'bim-appearance'",'appearance remains separate from geometry overlays');
assert(!state.includes('setInterval('),'appearance state owner must be event-driven, not polling');

must(runtime,'function installFilter()','Family/Type filter must have one runtime owner');
must(runtime,"const rows=S()?.viewerData?.elements||[]",'filter must resolve against complete model index');
must(runtime,"search.dispatchEvent(new Event('input',{bubbles:true}))",'filter must bridge through full-index core render');
must(runtime,'new MutationObserver(()=>queueMicrotask(exactFilter))','exact filtering may observe tree replacement without polling');
must(runtime,'function restoreAll()','global visibility restore must exist');
must(runtime,'for(let offset=0;offset<after.length;offset+=400)','restore-all must use bounded Firestore batches');
must(runtime,"operation:'restore-all'",'restore-all must emit one history operation');
must(runtime,"<iframe class=\"r75-provider-frame\"",'Architextures editor must live inside BIM properties');
must(runtime,"type:'liber:revex-integration-arm'",'embedded provider must arm user-download interception without opening a new window');
must(runtime,'https://architextures.org/create','embedded provider must use official Architextures Create editor');
must(runtime,'handleFile(new File([blob]','user-triggered provider download must auto-apply');
assert(!runtime.includes('setInterval('),'consolidated properties/filter runtime must be event-driven');
assert(!runtime.includes('liber:revex-integration-open'),'properties integration must not open a separate provider browser window');

must(sw,"return await fetch(request, { cache: 'no-store' })",'REVEX runtime assets must remain network-authoritative');
console.log(JSON.stringify({schema:'liber.revex.r75-companion-state-qa.v1',status:'PASSED',owners:{visibility:'canonical-store',appearance:'appearance-state-r75',propertiesAndFilter:'companion-runtime-r75'},polling:false,restoreAll:'batched',materials:'embedded-properties',docs:'native-pdf-page-navigation'},null,2));
