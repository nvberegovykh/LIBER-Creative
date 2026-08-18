'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'../..');
const mobile=fs.readFileSync(path.join(root,'docs/liber-apps/apps/revex/mobile-safe-r128.js'),'utf8');
const loader=fs.readFileSync(path.join(root,'docs/liber-apps/apps/revex/render-convergence-r126.js'),'utf8');
new Function(mobile);
new Function(loader);
const required=[
  ['safe-area top','safe-area-inset-top'],
  ['safe-area right','safe-area-inset-right'],
  ['safe-area bottom','safe-area-inset-bottom'],
  ['safe-area left','safe-area-inset-left'],
  ['touch/standalone mobile detection','display-mode: standalone'],
  ['coarse pointer mobile detection','pointer:coarse'],
  ['landscape-width mobile detection','max-width:1024px'],
  ['Walk touch overlay','#revex-r122-walk-touch'],
  ['Design Book scroll','.design-view:not([hidden])'],
  ['Design Book pan-y','touch-action:pan-y'],
  ['Docs mobile stack','.docs-view:not([hidden])'],
  ['Docs explorer mobile stack','.docs-explorer'],
  ['Docs tree scrolling','.docs-tree-wrap'],
  ['Energy mobile scroll','.energy-view:not([hidden])'],
  ['Energy compact heading','.energy-head h1'],
  ['dynamic mobile body owner','revex-mobile-touch']
];
for(const [label,needle] of required){if(!mobile.includes(needle))throw new Error(`Missing ${label}: ${needle}`)}
if(!/overflow-y:auto!important/.test(mobile))throw new Error('Mobile views do not own vertical scrolling.');
if(!loader.includes("mobile-safe-r128.js?v=20260818r128-mobile-safe1"))throw new Error('r128 mobile layer is not loaded from final r126 convergence.');
if(loader.indexOf('loadMobileSafe();')<0)throw new Error('r128 mobile layer is not loaded immediately.');
for(const forbidden of['runRevexEnergy','SYNC ENGINEERING','GeometryCo','createRenderJob','runRevexRender']){
  if(mobile.includes(forbidden))throw new Error(`Presentation-only r128 unexpectedly touches runtime pipeline: ${forbidden}`);
}
console.log('PASS r128 mobile safety: iOS safe areas + Walk + Design scroll + Docs stack + Energy scroll; pipeline/data owners unchanged.');
