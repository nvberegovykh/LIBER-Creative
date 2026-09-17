'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const read=file=>fs.readFileSync(file,'utf8').replace(/\r\n?/g,'\n');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const index=read('docs/liber-apps/apps/revex/index.html');
const experience=read('docs/liber-apps/apps/revex/experience-r144.js');
const viewer=read('docs/liber-apps/apps/revex/viewer-interaction-r85.js');
const viewerLoader=read('docs/liber-apps/apps/revex/viewer-interaction-r85-loader.js');
const review=read('docs/liber-apps/apps/revex/review-integrity-r50.js');
const docs=read('docs/liber-apps/apps/revex/docs-pages-r115.js');
const docsGuard=read('docs/liber-apps/apps/revex/docs-convergence-r126.js');
const family=read('docs/liber-apps/apps/revex/blocks-palette-r126.js');
const wallt=read('docs/liber-apps/apps/revex/wallt-ui-r138.js');
const mobileSheet=read('docs/liber-apps/apps/revex/mobile-sheet-r142.js');
const history=read('docs/liber-apps/apps/revex/history-r24.js');
const daily=read('docs/liber-apps/apps/revex/history-daily-r126.js');
const uiPolish=read('docs/liber-apps/apps/revex/ui-polish-r109.js');
const energyReview=read('docs/liber-apps/apps/revex/energy-agent-review.js');
const specApp=read('docs/liber-apps/apps/specifications/app.js');
const runtime=read('docs/liber-apps/apps/revex/runtime.js');
const specStyles=read('docs/liber-apps/apps/specifications/styles.css');
const nativeWindow=read('src/Liber.Revex.Revit/UI/RendairWindow.cs');
const luminance=hex=>{const channels=hex.match(/[0-9a-f]{2}/gi).map(value=>parseInt(value,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return .2126*channels[0]+.7152*channels[1]+.0722*channels[2]};
const contrast=(a,b)=>{const first=luminance(a),second=luminance(b);return(Math.max(first,second)+.05)/(Math.min(first,second)+.05)};

// Syntax-check the classic-script presentation owners. The module viewer is
// parsed separately by CI with `node --input-type=module --check`.
for(const [name,source] of Object.entries({experience,docs,docsGuard,family,wallt,mobileSheet,history,daily,uiPolish,specApp,runtime}))assert.doesNotThrow(()=>new Function(source),`${name} has invalid syntax`);

// Evaluate only the viewer's pure contracts. DOM ready stays pending so no
// renderer installation or THREE operation runs in this unit test.
const root={RevexStore:{},addEventListener(){},matchMedia(){return{matches:false,addEventListener(){}};}};
const document={readyState:'loading',addEventListener(){}};
const viewerContext={window:root,document,console,setTimeout(){return 0;},queueMicrotask(){},requestAnimationFrame(){}};
vm.runInNewContext(viewer.replace(/^import[^\n]+\n/,''),viewerContext,{filename:'viewer-interaction-r85.js'});
const measure=root.__revexViewerInteractionR85;
assert.ok(measure,'viewer interaction contract did not install');

assert.equal(measure.formatArchitecturalDistance(5),'5′-0″','whole feet');
assert.equal(measure.formatArchitecturalDistance(5.5),'5′-6″','feet and inches');
assert.equal(measure.formatArchitecturalDistance(5+6.5/12),'5′-6 1/2″','fractional inches');
assert.equal(measure.formatArchitecturalDistance(1+11.98/12),'2′-0″','fractional rounding carries into the next foot');
const a={id:'a'},b={id:'b'},c={id:'c'};
const first=measure.nextMeasureState({points:[]},a);assert.equal(first.complete,false);assert.equal(first.points.length,1);assert.equal(first.points[0],a);
const second=measure.nextMeasureState(first,b);assert.equal(second.complete,true);assert.equal(second.points.length,2);assert.equal(second.points[0],a);assert.equal(second.points[1],b);
const third=measure.nextMeasureState(second,c);assert.equal(third.complete,false);assert.equal(third.points.length,1);assert.equal(third.points[0],c,'third click begins a new exact two-point measure');
assert.equal(measure.nextMeasureState({points:[]},b).points[0],b,'reset returns to first-point state');

// Exact Revit elements are emitted as one mesh part per material. Exercise a
// closed cube whose six faces are six independent/open parts so cut ownership
// cannot accidentally regress to per-material point-in-mesh tests.
const p=(x,y,z)=>({x,y,z}),tri=(a,b,c)=>[a,b,c];
const cubeParts=[
  [tri(p(0,0,0),p(0,1,0),p(0,1,1)),tri(p(0,0,0),p(0,1,1),p(0,0,1))],
  [tri(p(1,0,0),p(1,0,1),p(1,1,1)),tri(p(1,0,0),p(1,1,1),p(1,1,0))],
  [tri(p(0,0,0),p(0,0,1),p(1,0,1)),tri(p(0,0,0),p(1,0,1),p(1,0,0))],
  [tri(p(0,1,0),p(1,1,0),p(1,1,1)),tri(p(0,1,0),p(1,1,1),p(0,1,1))],
  [tri(p(0,0,0),p(1,0,0),p(1,1,0)),tri(p(0,0,0),p(1,1,0),p(0,1,0))],
  [tri(p(0,0,1),p(0,1,1),p(1,1,1)),tri(p(0,0,1),p(1,1,1),p(1,0,1))],
];
assert.equal(measure.pointInsideTriangleParts(cubeParts,p(.5,.5,.5)),true,'multi-material composite solid did not own its cut sample');
assert.equal(measure.pointInsideTriangleParts(cubeParts,p(-1,.2,.2)),false,'outside point was accepted by a multi-part solid');

assert.equal(measure.measureGeometryAuthority({model:{name:'REVEX_PROXY_ROOT'},detailLoaded:false,detailLoading:true}).ready,false,'metadata proxy unlocked precise Measure');
assert.equal(measure.measureGeometryAuthority({model:{name:'REVEX_CURRENT_PAGED_MODEL'},detailLoaded:false,detailLoading:true}).ready,false,'partial exact pages unlocked precise Measure');
assert.equal(measure.measureGeometryAuthority({model:{name:'REVEX_CURRENT_PAGED_MODEL'},detailLoaded:true,detailLoading:false}).ready,true,'complete exact pages did not unlock Measure');
assert.equal(measure.measureGeometryAuthority({model:{name:''},detailLoaded:true,detailLoading:false,sourceState:{modelFormat:'rvxmesh-gzip'}}).ready,false,'FBX fallback inherited an exact source label');
const fallbackRoot={name:'REVEX_MISSING_GEOMETRY_PROXY',userData:{revexFallbackOnly:true},parent:null};
assert.equal(measure.nonAuthoritativeMeasureObject({name:'REVEX_PROXY_42',userData:{},parent:fallbackRoot},fallbackRoot),true,'fallback hit was accepted for precise Measure');
assert.equal(measure.nonAuthoritativeMeasureObject({name:'REVEX_PENDING_FAMILY_42',userData:{revexPendingFamily:true},parent:null},null),true,'pending family preview was accepted for precise Measure');

const lower={distanceToPoint:p=>p.x,normal:{dot:d=>d.x}};
const upper={distanceToPoint:p=>3-p.x,normal:{dot:d=>-d.x}};
const sectionViewer={__reviewSection:{enabled:true},__r85ActiveClipPlanes:[lower],model:{}};
const hits=measure.visibleRayHits(sectionViewer,[
  {distance:1,point:{x:-1},object:{}},
  {distance:8,point:{x:1},object:{}},
]);
assert.equal(hits.length,1,'clipped-away ray candidate survived');
assert.equal(hits[0].distance,8,'nearest surviving visible candidate changed');
assert.equal(JSON.stringify(measure.activeRayInterval({origin:{x:-2},direction:{x:1}},[lower,upper])),JSON.stringify({entry:2,exit:5}),'active clip interval must use rendered plane orientation');
assert.equal(JSON.stringify(measure.activeRayInterval({origin:{x:1},direction:{x:1}},[lower,upper])),JSON.stringify({entry:0,exit:2}),'camera-inside interval must expose the exit cut boundary');

const cut={distance:3,row:{id:'cut-wall'},syntheticCut:true};
const behind={distance:8,row:{id:'behind-object'}};
const front={distance:2,row:{id:'visible-front'}};
assert.equal(measure.mergeCutOccluder([behind],cut)[0],cut,'object behind a visible cut face won selection');
assert.equal(measure.mergeCutOccluder([behind,front],cut)[0],front,'a visible object in front of the cut face must remain selectable');
for(const marker of ['function pointInsideClosedMesh','function syntheticCutHit','cutBoundary:entering?\'entry\':\'exit\'','visibleSurfaceHits(viewer,viewer.ray.intersectObject'])assert.ok(viewer.includes(marker),`section cut owner missing ${marker}`);

assert.ok(viewer.includes("button.id='measure-toggle'"),'Measure is not discoverable in the BIM toolbar');
assert.ok(viewer.includes('role="status" aria-live="polite"'),'Measure does not expose a polite live result');
assert.ok(viewer.includes('#revex-r144-measure-status button{min-width:44px;min-height:44px}'),'Measure mobile actions are smaller than 44px');
assert.ok(viewerLoader.includes("viewer-interaction-r85.js?v=20260820r147-release1"),'current Measure/section owner is not cache-busted');
assert.ok(review.includes("if (id === 'section-toggle' && window.__revexViewerInteractionR85) return"),'legacy review capture still blocks the deterministic r85 Section owner');
assert.ok(viewer.includes("if(enabled){if(S()?.viewerSelectionKind!=='section')selectSectionBox()}"),'Section state does not remain deterministic when a cached legacy capture delegates through the patched viewer');
assert.ok(ui.includes("review-integrity-r50.js?v=20260820r147-release1"),'delegating review runtime is not cache-busted');
assert.ok(ui.includes("blocks-palette-r126.js?v=20260820r147-release1"),'family insertion recovery is not cache-busted');

assert.ok(docs.includes('<details class="docs-disclosure"'),'Docs sets are not expandable/collapsible');
assert.ok(docs.includes('liber.revex.docs-disclosures.v1.'),'Docs disclosure is not project-scoped');
assert.ok(docs.includes('.slice(-80)'),'Docs disclosure storage is not bounded');
assert.ok(docs.includes("revex:docs-selection"),'Docs selection does not signal the mobile viewer sheet');
for(const source of [docs,docsGuard,family])assert.ok(!source.includes('setInterval('),'Docs/family lifecycle polling returned');
assert.ok(docs.includes("revex:docs-r115-ready"),'Docs canonical owner does not emit a lifecycle-ready signal');
assert.ok(docsGuard.includes("revex:docs-r115-ready"),'Docs convergence does not bind the lifecycle-ready signal');
assert.ok(docsGuard.includes("details:not([data-r115-disclosure])"),'Docs convergence mistakes canonical disclosures for legacy DOM');

assert.ok(family.includes("button.hidden=false;button.disabled=!hosted()"),'family insertion is hidden instead of discoverable');
for(const marker of ['data-family-browse','data-family-insert disabled','Placement context','aria-live="polite"',"revex:walk-mode-changed"])assert.ok(family.includes(marker),`family flow missing ${marker}`);
assert.ok(family.includes("Family insertion is available in the REVEX Revit add-in"),'browser-only family state is unexplained');

assert.ok(wallt.includes('function chatActive()'),'WALLT does not identify Chat');
assert.ok(wallt.includes('open.hidden=chat'),'WALLT direct entry remains over Chat');
assert.ok(wallt.includes('mobileMenu.hidden=chat'),'WALLT mobile entry remains over Chat');
assert.ok(mobileSheet.includes('syncAvailability'),'mobile actions menu does not reconcile WALLT availability');

assert.ok(experience.includes("button.textContent='Sync project'"),'top-level sync affordance is not consolidated');
assert.ok(experience.includes('@media(prefers-reduced-motion:reduce)'),'reduced-motion contract missing');
assert.ok(experience.includes(':focus-visible'),'keyboard focus treatment missing');
assert.ok(experience.includes('min-height:44px'),'mobile target contract missing');
assert.ok(experience.includes('SCENE DIRECTION'),'Render visual hierarchy missing');
for(const leaked of ['}.docs-node{min-height:58px','}.energy-card{padding:15px','}.render-google-config{grid-template-columns:minmax(0,1fr) 96px','}.topbar .brand strong{font-size:16px'])assert.ok(!experience.includes(leaked),`mobile-only presentation selector leaked onto desktop: ${leaked}`);
for(const [foreground,background,label] of [['#f2f5f8','#090d12','primary text'],['#aeb9c8','#090d12','muted text'],['#4d9cff','#07111d','primary action'],['#69afff','#090d12','focus ring']])assert.ok(contrast(foreground,background)>=4.5,`${label} contrast is below WCAG AA`);
assert.ok(history.includes('Reset selection'),'selection transform has no dedicated reset action');
assert.ok(!history.includes("Selected floor + 5'"),'selection transform incorrectly exposes a section-floor action');
for(const [source,marker,label] of [
  [uiPolish,"wrap.addEventListener('keydown'",'Quick Guide keyboard close'],
  [uiPolish,"if(e.key==='Escape')",'Quick Guide Escape handling'],
  [daily,'dailyInvoker=document.activeElement||button','Daily Reports focus capture'],
  [daily,"modal.addEventListener('keydown'",'Daily Reports Escape handling'],
  [energyReview,'role="dialog" aria-modal="true"','Energy OSM dialog semantics'],
  [energyReview,'viewerReturnFocus=document.activeElement','Energy OSM focus return'],
  [specApp,"c.setAttribute('role', 'dialog')",'Spec dialog semantics'],
  [specApp,'modalInvoker = document.activeElement','Spec dialog focus capture'],
  [runtime,'inviteInvoker=document.activeElement','Invite focus capture'],
  [experience,"const visible=node=>Boolean(node?.isConnected&&!node.hidden&&node.getClientRects?.().length)",'Docs actions visible focus fallback'],
  [experience,"if(event==='revex:mobile-mode-changed')setDocsActions(false,true)",'Docs actions responsive close'],
  [energyReview,'viewerGeneration++','Energy OSM stale async guard'],
  [uiPolish,'function restoreUiFocus','Quick Guide visible focus fallback'],
  [specApp,"[$('#btn-menu'), $('#btn-home'), $('.sp-seg button.active'), $('#content')].find(visible)",'Spec embedded visible focus fallback']
])assert.ok(source.includes(marker),`${label} is missing`);

for(const [name,source] of Object.entries({experience,viewer,family,wallt,specStyles})){
  assert.ok(!source.includes('gradient'),`${name} reintroduced gradients`);
  assert.ok(!source.includes('backdrop-filter'),`${name} reintroduced glass blur`);
  assert.ok(!source.includes('text-shadow'),`${name} reintroduced glow`);
}

const uiBuild=(ui.match(/const BUILD=['"]([^'"]+)['"]/)||[])[1];
const indexBuild=(index.match(/ui-integrity\.js\?v=([^"']+)/)||[])[1];
assert.equal(indexBuild,uiBuild,'root UI cache key drifted from the final owner');
assert.ok(ui.indexOf("experience-r144.js?v=20260820r147-release1")>ui.indexOf("mobile-sheet-r142.js?v=20260820r147-release1"),'r144 must be the final presentation owner');
assert.ok(nativeWindow.includes('_diagnosticsColumn.Width = visible ? new GridLength(370) : new GridLength(0)'),'diagnostics disclosure does not allocate a non-overlapping column');
assert.ok(nativeWindow.includes('_diagnosticsPanel.Visibility = Visibility.Collapsed'),'diagnostics must remain hidden by default');

console.log(JSON.stringify({
  REVEX_R144_EXPERIENCE:'PASSED',
  measure:{points:2,architecturalPrecision:'1/16in',thirdClick:'new-measure',mobileTargets:44},
  sectionPicking:{clippedRejected:true,syntheticCutOccludesBehind:true,visibleFrontWins:true,cameraInsideExit:true},
  docs:{nativeDisclosure:true,projectPersistence:true,boundedKeys:80,polling:false,mobileViewerSheet:true},
  family:{discoverable:true,explicitInsert:true,browserExplanation:true,polling:false},
  presentation:{solidSurfaces:true,glass:false,gradients:false,reducedMotion:true,focusVisible:true,contrast:'WCAG-AA'},
  accessibility:{dialogEscapeAndFocusReturn:true,visibleFallbacks:true},
  wallt:{chatExcluded:true,mobileElsewhere:true},diagnostics:{nonOverlapping:true,defaultHidden:true}
}));
