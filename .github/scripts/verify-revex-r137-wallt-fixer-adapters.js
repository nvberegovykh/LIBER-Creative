'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const controlSource=fs.readFileSync('docs/liber-apps/apps/revex/wallt-control-plane.js','utf8');
const adapterSource=fs.readFileSync('docs/liber-apps/apps/revex/wallt-fixer-adapters-r137.js','utf8');
const ui=fs.readFileSync('docs/liber-apps/apps/revex/ui-integrity.js','utf8');
new Function(controlSource);new Function(adapterSource);
assert.ok(ui.includes("wallt-control-plane.js?v=20260818-wallt-control2"),'current WALLT control2 is not loaded');
assert.ok(ui.includes("wallt-fixer-adapters-r137.js?v=20260818r137-fixer-adapters1"),'r137 Fixer adapters are not loaded');
assert.ok(controlSource.includes("const adapterName = type.slice(0, separator)"),'adapter:action routing missing');
assert.ok(controlSource.includes("Registered fixer actions (use the exact adapter:action type)"),'Fixer prompt does not advertise executable action names');

const listeners={};
const local={};
const nodes=new Map();
const makeNode=(id)=>({id,dataset:{},hidden:false,value:'',classList:{contains(name){return id==='tab-docs'&&name==='active';},add(){},remove(){}},dispatchEvent(){},click(){this.clicked=(this.clicked||0)+1;},focus(){},scrollIntoView(){},addEventListener(){}});
for(const id of ['docs-search','chat-frame','chat-placeholder'])nodes.set(id,makeNode(id));
const docsTab=makeNode('tab-docs');docsTab.dataset.view='docs';
const currentTab=docsTab;
let overlayCount=0,renderCount=0,fitCount=0,chatReset=null,resizeCount=0;
const state={projectId:'P1',cloudState:{revision:'R1'},library:[{id:'set',revexDocKind:'printing-set',sheetIndex:[]},{id:'legacy',revexDocKind:'printing-sheet'}],bimOverlays:new Map([['a',{id:'a'}]])};
const root={
  __revexState:state,
  __revexBrowserDiagnostics:{snapshot(){return[];},emit(){}},
  __revexDocsPagesR115:{build:'docs',legacySheet:r=>r.revexDocKind==='printing-sheet',projectRows(rows){return rows.filter(r=>r.revexDocKind!=='printing-sheet');}},
  __revexChatConvergenceR136:{reset(projectId,reason){chatReset={projectId,reason};}},
  __revexViewerR26Instance:{setOverlays(rows){overlayCount=rows.length;},requestRender(){renderCount++;},fit(){fitCount++;}},
  __revexMobileSafeR133:{build:'mobile'},
  addEventListener(type,fn){(listeners[type]||(listeners[type]=[])).push(fn);},
  dispatchEvent(event){if(event.type==='resize')resizeCount++;for(const fn of listeners[event.type]||[])fn(event);},
  chrome:null,
};
const document={
  readyState:'complete',head:{appendChild(){}},
  getElementById(id){return nodes.get(id)||null;},
  querySelector(sel){if(sel==='.main-nav [data-view].active')return currentTab;if(sel==='[data-view="chat"]')return makeNode('tab-chat');return null;},
  querySelectorAll(sel){if(sel==='script[data-revex-runtime]')return[];return[];},
  createElement(){return makeNode('created');},
  addEventListener(){}
};
const context={window:root,document,navigator:{onLine:true},location:{origin:'https://liberpict.com'},localStorage:{getItem(k){return local[k]??null;},setItem(k,v){local[k]=v;},removeItem(k){delete local[k];}},sessionStorage:{removeItem(){}},console,CSS:{escape:v=>String(v)},performance:{now:()=>1},CustomEvent:class CustomEvent{constructor(type,init={}){this.type=type;this.detail=init.detail;}},Event:class Event{constructor(type,init={}){this.type=type;this.bubbles=!!init.bubbles;}},setTimeout(fn){fn();return 1;},clearTimeout(){},setInterval(fn){fn();return 1;},clearInterval(){}};
root.Event=context.Event;
vm.runInNewContext(controlSource,context,{filename:'wallt-control-plane.js'});
vm.runInNewContext(adapterSource,context,{filename:'wallt-fixer-adapters-r137.js'});

(async()=>{
  assert.equal(root.__revexWalltControl.build,'20260818-wallt-control2');
  assert.equal(root.__revexWalltFixerAdaptersR137.registered,true);
  const actions=root.__revexWalltFixerAdaptersR137.actions;
  assert.ok(actions.includes('current:docs_reassert_owner'));
  assert.ok(actions.includes('current:chat_reset_active_project'));
  assert.ok(actions.includes('current:bim_reapply_overlays'));

  let result=await root.__revexWalltControl.execute('fixer',[{type:'current:docs_reassert_owner'}],'repair docs');
  assert.equal(result[0].ok,true);assert.equal(result[0].result.foldedDetachedRows,1);
  result=await root.__revexWalltControl.execute('fixer',[{type:'current:bim_reapply_overlays'}],'repair overlays');
  assert.equal(result[0].ok,true);assert.equal(overlayCount,1);assert.ok(renderCount>0);
  result=await root.__revexWalltControl.execute('fixer',[{type:'current:bim_refit_view'}],'repair camera');
  assert.equal(result[0].ok,true);assert.equal(fitCount,1);
  result=await root.__revexWalltControl.execute('fixer',[{type:'current:chat_reset_active_project'}],'repair chat');
  assert.equal(result[0].ok,true);assert.deepEqual(chatReset,{projectId:'P1',reason:'wallt-fixer-current'});
  result=await root.__revexWalltControl.execute('fixer',[{type:'current:mobile_reapply_constraints'}],'repair mobile');
  assert.equal(result[0].ok,true);assert.equal(resizeCount,1);
  await assert.rejects(root.__revexWalltControl.execute('fixer',[{type:'current:arbitrary_dom_mutation'}],'bad'),/not registered/);

  const report=root.__revexWalltControl.cycleReport();
  assert.equal(report.windowHours,24);assert.ok(report.events.some(r=>r.channel==='fixer'&&r.phase==='ACTION_OK'));
  console.log(JSON.stringify({REVEX_R137_WALLT_FIXER_ADAPTERS:'PASSED',adapterRouting:'adapter:action',boundedCurrentOwnerRepairs:true,arbitraryMutationRejected:true,cycleLedgerHours:24}));
})().catch(error=>{console.error(error);process.exitCode=1;});