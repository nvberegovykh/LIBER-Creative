'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('docs/liber-apps/apps/revex/wallt-ui-r138.js','utf8');
const ui=fs.readFileSync('docs/liber-apps/apps/revex/ui-integrity.js','utf8');
new Function(source);

assert.ok(ui.includes("wallt-ui-r138.js?v=20260818r138-wallt-ui1"),'canonical UI owner does not load visible WALLT r138');
for(const marker of [
  "const BUILD='20260818r138-wallt-ui1'",
  "controlOwner:'wallt-control-plane'",
  'storageOwner:null',
  "open.id='revex-wallt-open'",
  "panel.id='revex-wallt-panel'",
  'data-wallt-mode="helper"',
  'data-wallt-mode="fixer"',
  "owner[mode](request)",
  "mode==='fixer'?'Fix current screen':'Explain this screen'",
  'registered reversible current-owner Fixer action',
  "safe-area-inset-bottom",
  "safe-area-inset-right",
  "@media(max-width:600px)",
  "event.key==='Escape'",
  "event.ctrlKey||event.metaKey",
  "newStorageOwner:false"
]) assert.ok(source.includes(marker),`visible WALLT UI missing ${marker}`);
for(const forbidden of [
  'firebase.firestore',
  'localStorage.setItem',
  'sessionStorage.setItem',
  'fetch(',
  'walltAgent.response',
  'runEnergyServer(',
  'commitBimOverlay('
]) assert.ok(!source.includes(forbidden),`visible WALLT UI became a competing owner: ${forbidden}`);

const listeners={};
const root={
  __revexState:{projectId:'P1',project:{name:'Project One'}},
  __revexWalltControl:{
    helper:async request=>({channel:'helper',plan:{assistant:`helper:${request}`},results:[]}),
    fixer:async request=>({channel:'fixer',plan:{assistant:`fixer:${request}`},results:[{type:'current:bim_refit_view',ok:true}]})
  },
  __revexBrowserDiagnostics:{emit(){}},
  addEventListener(type,fn){(listeners[type]||(listeners[type]=[])).push(fn);}
};
const document={
  readyState:'loading',
  getElementById(){return null;},
  querySelector(){return null;},
  querySelectorAll(){return[];},
  addEventListener(type,fn){(listeners[`document:${type}`]||(listeners[`document:${type}`]=[])).push(fn);},
  createElement(){return{};},
  head:{appendChild(){}},body:{appendChild(){}}
};
const context={window:root,document,console,setTimeout(){return 1;},clearTimeout(){}};
vm.runInNewContext(source,context,{filename:'wallt-ui-r138.js'});
const api=root.__revexWalltUiR138;
assert.equal(api.build,'20260818r138-wallt-ui1');
assert.equal(api.controlOwner,'wallt-control-plane');
assert.equal(api.storageOwner,null);
assert.equal(api.helper,true);assert.equal(api.fixer,true);
assert.equal(typeof api.run,'function');assert.equal(typeof api.setMode,'function');

console.log(JSON.stringify({
  REVEX_R138_WALLT_UI:'PASSED',
  visibleEntryPoint:true,
  helperAndFixerModes:true,
  usesExistingControlOwner:true,
  newAiBackend:false,
  newStorageOwner:false,
  mobileSafeArea:true
}));