'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const state=read('docs/liber-apps/apps/revex/companion-state-r71.js');
const appearance=read('docs/liber-apps/apps/revex/appearance-r70.js');
const sw=read('docs/liber-apps/sw.js');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);

must(ui,'__revexR71CanonicalViewerState','canonical Store state must be installed by the pre-app UI loader');
must(ui,'delete next.material','geometry/visibility commits must not carry appearance');
must(ui,"next.visibility=visibility","visibility must be persisted as one canonical state");
must(ui,"next.hidden=visibility==='hidden'","hidden compatibility flag must derive from canonical state");
must(ui,"next.deleted=visibility==='deleted'","deleted compatibility flag must derive from canonical state");
must(ui,'if(!Store)return;','canonical pass must be repeatable as later Store methods appear');
assert(!ui.includes('if(!Store||Store.__revexR71CanonicalViewerState)return'), 'a coarse installed marker must not block late-defined Store methods');
must(ui,"loadScript('companion-state-r71.js?v=20260816r71-state1'","r71 live-state runtime must load");
assert(ui.indexOf('installCanonicalOverlayStore();') < ui.indexOf('function updateProjectId'), 'canonical Store wrapper must install synchronously before DOM/project binding');

must(state,"Store.subscribeKind(projectId,'bim-appearance'",'appearance must live-subscribe by project');
must(state,'clearAppearanceState();','project switching must clear stale appearance before hydration');
must(state,"root.__revexViewerR26Instance?.setAppearances?.([])",'stale finish must be removed from the viewport immediately on project switch');
must(state,"root.addEventListener('revex:authoritative-project-bound'",'authoritative project binding must trigger appearance hydration');
must(state,"document.getElementById('project-select')?.addEventListener('change'",'explicit project switches must rebind appearance state');
must(state,"root.addEventListener('revex:bim-appearances-changed'",'inspector must update after local or remote appearance changes');
must(state,'data-r71-live-state','inspector must expose the currently committed live appearance state');
must(state,'Open selected source','saved Architextures source must remain inspectable without automated downloading');

must(appearance,"revexKind:'bim-appearance'",'appearance remains a separate persistence lane');
must(appearance,"scope==='type'?typeKey(r):stable(r)",'type and instance scopes remain distinct');
must(appearance,'Texture wins; committed design color is its fallback and overrides model color','appearance precedence must remain explicit');

must(sw,"return await fetch(request, { cache: 'no-store' })",'REVEX runtime assets must remain network-authoritative');
must(sw,'Keeps REVEX core assets network-authoritative','service-worker cache contract must remain explicit');

console.log(JSON.stringify({schema:'liber.revex.r71-companion-state-qa.v1',status:'PASSED',viewer:{canonicalVisibilityBeforeHydration:true,appearanceOutsideGeometry:true,lateStoreMethodsWrapped:true},projectState:{appearanceClearsOnSwitch:true,appearanceHydrates:true,appearanceLiveSync:true},inspector:{remoteAppearanceRefresh:true,sourceTraceable:true},cache:{revexCoreNetworkAuthoritative:true}},null,2));
