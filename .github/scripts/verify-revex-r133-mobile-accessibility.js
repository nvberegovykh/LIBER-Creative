'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'../..');
const mobile=fs.readFileSync(path.join(root,'docs/liber-apps/apps/revex/mobile-safe-r133.js'),'utf8');
const ui=fs.readFileSync(path.join(root,'docs/liber-apps/apps/revex/ui-integrity.js'),'utf8');
const render=fs.readFileSync(path.join(root,'docs/liber-apps/apps/revex/render-convergence-r126.js'),'utf8');
new Function(mobile);
new Function(ui);
const need=(label,needle)=>{if(!mobile.includes(needle))throw new Error(`r133 missing ${label}: ${needle}`)};
for(const [label,needle] of [
  ['current build',"const BUILD='20260819r133-mobile-safe2'"],
  ['Dynamic Island top safe-area','safe-area-inset-top'],
  ['right safe-area','safe-area-inset-right'],
  ['home indicator safe-area','safe-area-inset-bottom'],
  ['left safe-area','safe-area-inset-left'],
  ['installed PWA detection','display-mode: standalone'],
  ['touch/coarse detection','pointer:coarse'],
  ['iPhone landscape width coverage','max-width:1024px'],
  ['existing r122 Walk surface','#revex-r122-walk-touch'],
  ['Design Book active scroll','.design-view:not([hidden])'],
  ['Docs active stack','.docs-view:not([hidden])'],
  ['Docs explorer split','.docs-explorer'],
  ['Docs content-height tree','grid-template-rows:auto minmax(0,1fr)'],
  ['Docs bounded tree height','max-height:min(36dvh,320px)'],
  ['Docs width clamp','.docs-explorer>*{min-width:0!important;max-width:100%!important}'],
  ['Energy active scroll','.energy-view:not([hidden])'],
  ['Energy compact title','.energy-head h1'],
  ['touch scroll gesture','touch-action:pan-y']
])need(label,needle);
if(!ui.includes("mobile-safe-r133.js?v=20260819r133-mobile-safe2"))throw new Error('ui-integrity does not load current r133 Docs sizing repair.');
if(ui.indexOf("render-convergence-r126.js?v=20260818r129-freeze-guard1")>ui.indexOf("mobile-safe-r133.js?v=20260819r133-mobile-safe2"))throw new Error('r133 must load after r129 Render convergence.');
if(!render.includes("BUILD='20260818r129-freeze-guard1'"))throw new Error('r129 Render freeze-guard was not preserved.');
for(const forbidden of['runRevexEnergy','SYNC ENGINEERING','GeometryCo','runRevexRender','createRenderJob','saveBimAppearance']){
  if(mobile.includes(forbidden))throw new Error(`r133 presentation layer mutates protected runtime: ${forbidden}`);
}
console.log('PASS r133: safe areas, Walk visibility, Design scroll, content-height Docs tree/preview and Energy scroll; r129 Render + Energy runtime preserved.');
