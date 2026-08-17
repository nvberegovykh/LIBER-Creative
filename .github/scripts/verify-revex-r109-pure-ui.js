'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/\r\n/g,'\n');
const loader=read('docs/liber-apps/apps/revex/ui-integrity.js');
const ui=read('docs/liber-apps/apps/revex/ui-polish-r109.js');
const docs=read('docs/liber-apps/apps/revex/sync-docs-r24.js');
const app=read('docs/liber-apps/apps/revex/app.js');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);
const forbid=(text,needle,label)=>assert(!text.includes(needle),label||`Forbidden ${needle}`);

// Stable working runtime remains authoritative. Responsive UI is one thin layer only.
forbid(loader,"loadScript('mobile-ux-r100.js",'retired mobile runtime must not be loaded');
forbid(loader,"loadScript('design-ux-r101.js",'retired design runtime must not be loaded');
must(loader,"ui-polish-r109.js?v=20260817r109-pure-ui2",'pure UI cache-broken layer must be loaded');
must(loader,"energy-diagnostics-r68.js?v=20260816r95-manual-identity1",'Energy diagnostics r95 must stay loaded');
must(loader,"energy-identity-en1-r89.js?v=20260816r89-en1-identity1",'EN-1 identity must stay loaded');
must(loader,"energy-replay-r95.js?v=20260816r95-single-owner1",'Energy replay must stay loaded');
must(loader,"viewer-interaction-r85-loader.js?v=20260816r98-live-edge2",'current viewer/live worker edge must stay loaded');

// Mobile must reuse desktop owners, not create a second app state/viewer/tab engine.
forbid(ui,'MutationObserver','responsive UI must not observe/rewrite runtime DOM state');
forbid(ui,'RevexStore','responsive UI must not own project data');
forbid(ui,'state.library','responsive UI must not rewrite Docs state');
forbid(ui,'sheetIndex=','responsive UI must not normalize Docs data');
forbid(ui,'stopImmediatePropagation','responsive UI must not steal desktop control events');
forbid(ui,'new THREE','responsive UI must not create another BIM renderer');
must(ui,'data-r109-proxy="sync-button"','mobile Import sync must proxy desktop sync');
must(ui,'data-r109-proxy="invite-project-button"','mobile Invite must proxy desktop Invite');
must(ui,'data-r109-proxy="render-button"','mobile Render must proxy desktop Render');
must(ui,'target.click()','mobile actions must invoke existing desktop controls');

// Same desktop tab buttons remain the navigation owner.
must(app,"$$('.main-nav [data-view]').forEach((button) => button.classList.toggle('active'",'core desktop tab owner must remain');
must(ui,"document.querySelectorAll('.main-nav [data-view]')",'mobile may annotate existing tabs');
forbid(ui,"showView('",'responsive layer must not own view switching');

// Touch Walk is an input adapter for the existing viewer state.
for(const key of ['KeyW','KeyA','KeyS','KeyD'])must(ui,`'${key}'`,`touch Walk must feed ${key}`);
must(ui,'v.startWalkFrames?.()','touch Walk must use the existing viewer movement loop');
must(ui,'v.yaw-=dx*.0042','touch look must use existing viewer yaw');
must(ui,'v.look?.()','touch look must use existing viewer camera logic');

// Docs stays one linked printing-set group: full PDF + real single-sheet PDFs.
must(docs,"revexDocKind:'printing-set'",'Docs must publish printing-set records');
must(docs,'sheetIndex,createdAt:at','printing set must own its sheet index');
must(docs,'row.singlePageStoragePath=uploaded.path','each available sheet must retain its isolated PDF path');
must(docs,"mode:'isolated-sheet-pdf'",'sheet selection must support isolated single-page PDFs');
must(app,'class="docs-node whole','core Docs must render the full-set PDF in the same revision group');
must(app,'class="docs-node sheet','core Docs must render linked sheet rows beneath the full set');

console.log(JSON.stringify({
 schema:'liber.revex.r109.pure-responsive-ui.v1',status:'PASSED',
 mobile:{sameDesktopOwners:true,compactTabs:true,utilityProxies:true,touchWalkSharedViewer:true},
 docs:{linkedPrintingSetGroup:true,fullSet:true,isolatedSheetPdfs:true,stateRewrite:false},
 energy:{r95Diagnostics:true,r89Identity:true,r95Replay:true,liveWorkerEdge:true}
},null,2));
