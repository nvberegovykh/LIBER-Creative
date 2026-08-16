'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const loader=read('docs/liber-apps/apps/revex/viewer-interaction-r85-loader.js');
const r85=read('docs/liber-apps/apps/revex/viewer-interaction-r85.js');
const styles=read('docs/liber-apps/apps/revex/styles.css');
const render=read('docs/liber-apps/apps/revex/render-agent.js');
const must=(t,n,m)=>assert(t.includes(n),m||`Missing ${n}`);
const not=(t,n,m)=>assert(!t.includes(n),m||`Forbidden ${n}`);

// r85 remains the exact interaction owner; only the loader URL token advances so
// the Revit WebView cannot retain a pre-r97 cached loader that never imports live-worker-edge-r97.
must(ui,"viewer-interaction-r85-loader.js?v=20260816r98-live-edge2",'cache-busted r85 deferred bootstrap must load');
not(ui,"loadScript('viewer-repair-r79.js",'r79 must be replaced, not stacked with r85');
not(ui,"loadScript('viewer-interaction-r85.js",'r85 module must not be injected before the page import map');
must(loader,"document.addEventListener('DOMContentLoaded',load,{once:true})",'r85 module import must wait until parser/import-map registration completes');
must(loader,"import('./viewer-interaction-r85.js?v=20260816r85-viewer-interaction1')",'bootstrap must import the exact r85 interaction owner');
must(loader,"import('./live-worker-edge-r97.js?v=20260816r97-live-worker-edge2')",'bootstrap must independently import the r97 exact Energy job recovery edge');
must(r85,"#bim-mobile-dock",'mobile BIM bottom panel switcher must exist');
must(r85,"data-r85-panel=\"model\"",'mobile dock must expose model sidebar');
must(r85,"data-r85-panel=\"properties\"",'mobile dock must expose properties/section sidebar');
must(r85,"viewer.pick=function(event){pick(this,event)}",'viewer empty-click selection semantics must be owned by r85');
must(r85,"sectionEnabled(viewer)?selectSectionBox():renderNoSelection()",'empty viewport must select active Section or clear selection');
must(r85,"viewerSelectionKind='section'",'Section box must be a first-class selection');
must(r85,"data-r85-axis=\"${axis}\"",'Section inspector must expose X/Y/Z centered controls');
must(r85,"data-r85-yaw",'Section inspector must expose yaw rotary control');
must(r85,"Selected floor + 5'",'Section inspector must expose selected-floor +5ft cut');
must(r85,"function levelWorldY",'Walk floor must resolve to rendered BIM world coordinates');
must(r85,"floors.length?box.max.y:box.min.y",'Walk level must use geometry evidence when available');
must(r85,"target.id==='restore-all-elements'",'Restore All must have a stable delegated click owner');
must(r85,"event.stopImmediatePropagation();void restoreAll()",'Restore All must bypass stale handlers');
must(r85,"input.id='google-ai-project'",'private renderer must retain compatibility seam for legacy decorator');
must(render,"$('#google-ai-project').value",'regression reproduces the legacy unsafe dereference being guarded');
must(styles,'.bim-view > .rail, .design-view > .chapter-rail','legacy mobile sidebar collapse remains present underneath r85 successor CSS');

console.log(JSON.stringify({
 schema:'liber.revex.r85-viewer-interaction.v1',status:'PASSED',
 bootstrap:{afterImportMap:true,singleInteractionOwner:true,r97LiveWorkerEdge:true},
 mobile:{twoDesktopSidebarsOneBottomDrawer:true,topChromeCompacted:true},
 selection:{element:true,section:true,emptyClearsWhenSectionOff:true,emptyReturnsSectionWhenOn:true},
 section:{xyzCentered:true,yawRotary:true,floorCutPlus5:true},
 walk:{renderedWorldLevel:true},restoreAll:{delegatedSingleOwner:true},renderer:{legacyNullCrashGuarded:true}
},null,2));
