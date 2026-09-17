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
const render=read('docs/liber-apps/apps/revex/render-agent.js');
const renderShadow=read('docs/liber-apps/apps/revex/render-selfhost-r54.js');
const workspace=read('docs/liber-apps/apps/revex/workspace-r51.js');
const broker=read('server/firebase-functions/index.js');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);
const forbid=(text,needle,label)=>assert(!text.includes(needle),label||`Forbidden ${needle}`);

forbid(loader,"loadScript('mobile-ux-r100.js",'retired mobile runtime must not be loaded');
forbid(loader,"loadScript('design-ux-r101.js",'retired design runtime must not be loaded');
must(loader,"ui-polish-r109.js?v=20260820r147-release1",'r110 responsive cache break must be loaded');
must(loader,"energy-diagnostics-r68.js?v=20260816r95-manual-identity1",'Energy diagnostics r95 must stay loaded');
must(loader,"energy-identity-en1-r89.js?v=20260820r147-release1",'current EN-1 identity amendment owner must stay loaded');
must(loader,"energy-replay-r95.js?v=20260816r95-single-owner1",'Energy replay must stay loaded');
must(loader,"viewer-interaction-r85-loader.js?v=20260816r98-live-edge2",'current viewer/live worker edge must stay loaded');

forbid(ui,'MutationObserver','responsive UI must not observe/rewrite runtime DOM state');
forbid(ui,'RevexStore','responsive UI must not own project data');
forbid(ui,'state.library','responsive UI must not rewrite Docs state');
forbid(ui,'sheetIndex=','responsive UI must not normalize Docs data');
forbid(ui,'stopImmediatePropagation','responsive UI must not steal desktop control events');
forbid(ui,'new THREE','responsive UI must not create another BIM renderer');
must(ui,'.view[hidden],.empty-view[hidden]{display:none!important}','hidden views must stay hidden even under legacy BIM !important CSS');
must(ui,'revex-r110-tab-icon','mobile tabs must use clear SVG icon wrappers');
must(ui,"bim:'<svg",'BIM icon must be an inline semantic SVG');
must(ui,"docs:'<svg",'Docs icon must be an inline semantic SVG');
must(ui,"energy:'<svg",'Energy icon must be an inline semantic SVG');
must(ui,'id="revex-r110-render"','mobile Render must be directly visible');
must(ui,'data-r109-proxy="render-button"','mobile Render must invoke desktop Render owner');
must(ui,'data-r109-proxy="sync-button"','mobile Import sync must proxy desktop sync');
must(ui,'data-r109-proxy="invite-project-button"','mobile Invite must proxy desktop Invite');
must(ui,'target.click()','mobile overflow actions must invoke existing desktop controls');
forbid(ui,'function ensureHelp','empty persistent top-bar help button must not return');

must(app,"$$('.main-nav [data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)))",'core desktop/mobile tab handler must remain the single navigation owner');
must(ui,"document.querySelectorAll('.main-nav [data-view]')",'responsive layer may annotate existing tabs');
forbid(ui,"showView('",'responsive layer must not own view switching');
for(const key of ['KeyW','KeyA','KeyS','KeyD'])must(ui,`'${key}'`,`touch Walk must feed ${key}`);
must(ui,'v.startWalkFrames?.()','touch Walk must use the existing viewer movement loop');
must(ui,'v.yaw-=dx*.0042','touch look must use existing viewer yaw');
must(ui,'v.look?.()','touch look must use existing viewer camera logic');

must(docs,"revexDocKind:'printing-set'",'Docs must publish printing-set records');
must(docs,'sheetIndex,createdAt:at','printing set must own its sheet index');
must(docs,'row.singlePageStoragePath=uploaded.path','each available sheet must retain its isolated PDF path');
must(docs,"isolated?'isolated-sheet-pdf':'document'",'sheet selection must prefer isolated single-page PDFs');
must(docs,'singlePageStoragePath:row.singlePageStoragePath||row.storagePath||null','legacy sheet records must project their existing PDF into the derived set view');
must(docs,'const printing=rows.filter(file=>file.revexDocKind===\'printing-set\').map','printing-set projection must work on copied render rows');
must(docs,"legacySheetProjection:'render-only'",'legacy sheet cleanup must be render-only, not a Firestore/state rewrite');
forbid(docs,"document.addEventListener('click'",'Docs must not own navigation through a global click interceptor');
forbid(docs,'stopImmediatePropagation','Docs must not steal core click events');
forbid(docs,'MutationObserver','Docs must not observe/rewrite the DOM continuously');
must(app,'class="docs-node whole','base Docs markup must retain the full-set entry');
must(app,'class="docs-node sheet','base Docs markup must retain linked sheet rows');

// Current Render is the project-authenticated Google broker. The preserved Qwen
// implementation remains a non-owning shadow and may not compete for default clicks.
must(render,"httpsCallable(functions, 'runRevexGoogleRender'",'Render must call the authenticated us-central1 server broker');
must(render,'Store.fileBlob(resultPath)','Render result must be read through authenticated project Storage');
for(const marker of ['GoogleAuthProvider','reauthenticateWithPopup','linkWithPopup','x-goog-user-project','google-ai-project'])
  forbid(render,marker,`current Render client must not retain user Google IAM/OAuth: ${marker}`);
must(renderShadow,'document.addEventListener(\'click\', interceptClick, true)','preserved Qwen shadow source must remain reviewable');
forbid(workspace,'render-selfhost-r54.js','retired self-host renderer must not compete with the current Google render owner');
must(loader,"render-touchups-r115.js?v=20260818r132-render-owner-guard1",'current Render presentation guard must load');
must(loader,"render-convergence-r126.js?v=20260818r129-freeze-guard1",'current Render interaction freeze guard must load');

must(broker,'exports.runRevexGoogleRender = onCall','Google Render callable export missing');
must(broker,'acceptGoogleRenderJob','broker must validate and atomically accept the controlled job');
must(broker,'transaction.create(refs.lease','one-shot Render lease must be create-only and race-safe');
must(broker,"String(job.createdBy || '') === uid",'controlled Render job must belong to the authenticated caller');
must(broker,'assertProjectAccess(projectId, uid, request.auth.token || {})','every project member/owner/custom-claim admin must pass the shared project access boundary');

console.log(JSON.stringify({
 schema:'liber.revex.r110.live-ui-render.v1',status:'PASSED',
 mobile:{sameDesktopOwners:true,hiddenIntegrity:true,semanticSvgTabs:true,directRender:true,touchWalkSharedViewer:true},
 docs:{linkedPrintingSetGroup:true,fullSet:true,isolatedSheetPdfs:true,legacyProjection:'render-only',globalClickInterceptor:false,stateRewrite:false},
 render:{serverBroker:true,oneShotLease:true,userGoogleIam:false,qwenShadowOnly:true,webviewCacheBreak:true},
 energy:{r95Diagnostics:true,r89Identity:true,r95Replay:true,liveWorkerEdge:true}
},null,2));
