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
  ['Energy active scroll','.energy-view:not([hidden])'],
  ['Energy compact title','.energy-head h1'],
  ['touch scroll gesture','touch-action:pan-y']
])need(label,needle);
if(!ui.includes("mobile-safe-r133.js?v=20260818r133-mobile-safe1"))throw new Error('ui-integrity does not load r133.');
if(ui.indexOf("render-convergence-r126.js?v=20260818r129-freeze-guard1")>ui.indexOf("mobile-safe-r133.js?v=20260818r133-mobile-safe1"))throw new Error('r133 must load after r129 Render convergence.');
if(!render.includes("BUILD='20260818r129-freeze-guard1'"))throw new Error('r129 Render freeze-guard was not preserved.');
for(const forbidden of['runRevexEnergy','SYNC ENGINEERING','GeometryCo','runRevexRender','createRenderJob','saveBimAppearance']){
  if(mobile.includes(forbidden))throw new Error(`r133 presentation layer mutates protected runtime: ${forbidden}`);
}
console.log('PASS r133: iPhone safe areas, Walk touch visibility, Design scroll, Docs stack/scroll and Energy scroll; r129 Render + Energy runtime preserved.');
