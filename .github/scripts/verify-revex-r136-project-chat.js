'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('docs/liber-apps/apps/revex/chat-convergence-r136.js','utf8');
const ui=fs.readFileSync('docs/liber-apps/apps/revex/ui-integrity.js','utf8');
new Function(source);

assert.ok(ui.includes("chat-convergence-r136.js?v=20260818r136-project-chat1"),'canonical UI owner does not load r136 Chat');
assert.ok(!ui.includes('function installChatProjectGuard'),'legacy inline Chat owner still exists');
assert.ok(source.includes("owner:'secure-chat'"),'Secure Chat must remain the storage/message owner');
assert.ok(source.includes("Project changed while Chat connection was resolving."),'async project race guard is missing');
assert.ok(source.includes('Blocked a cross-project Chat connection'),'server project mismatch guard is missing');
assert.ok(source.includes("sessionStorage.removeItem('liber_revex_chat_draft')"),'legacy cross-project draft is not cleared');

let deferredResolve=null;
const state={projectId:'A',chatConnId:'',chatLoaded:false,chatProjectId:'',selectedContext:'Wall A'};
const originalCalls=[];
const Store={
  async ensureProjectChat(projectId){
    originalCalls.push(projectId);
    if(projectId==='A')return new Promise(resolve=>{deferredResolve=resolve;});
    if(projectId==='M')return {connId:'wrong',projectId:'OTHER'};
    return {connId:`conn-${projectId}`,projectId};
  }
};
const rootListeners={};
const frameListeners={};
const frame={
  dataset:{},_src:'about:blank',contentWindow:{postMessage(){}},
  addEventListener(type,fn){(frameListeners[type]||(frameListeners[type]=[])).push(fn);},
  getAttribute(name){return name==='src'?this._src:null;},
  set src(value){this._src=String(value);},get src(){return this._src;}
};
const placeholder={hidden:false,textContent:''};
const tab={addEventListener(){},classList:{contains(){return false;}}};
const document={
  readyState:'complete',
  getElementById(id){if(id==='chat-frame')return frame;if(id==='chat-placeholder')return placeholder;return null;},
  querySelector(sel){return sel==='[data-view="chat"]'?tab:null;},
  addEventListener(){}
};
const session={liber_revex_chat_draft:'OLD'};
const sessionStorage={removeItem(k){delete session[k];},setItem(k,v){session[k]=v;},getItem(k){return session[k]??null;}};
const context={
  window:null,document,sessionStorage,console,location:{origin:'https://liberpict.com'},
  setTimeout(fn){fn();return 1;},clearTimeout(){},
};
const root={
  __revexState:state,RevexStore:Store,__revexBrowserDiagnostics:{emit(){}},
  addEventListener(type,fn){(rootListeners[type]||(rootListeners[type]=[])).push(fn);}
};
context.window=root;
vm.runInNewContext(source,context,{filename:'chat-convergence-r136.js'});

assert.equal(root.__revexChatConvergenceR136.build,'20260818r136-project-chat1');
assert.equal(Store.ensureProjectChat.__revexR136,true,'Store resolver was not wrapped');

(async()=>{
  const stale=Store.ensureProjectChat('A');
  assert.equal(typeof deferredResolve,'function','project A resolution did not become pending');
  state.projectId='B';
  deferredResolve({connId:'conn-A',projectId:'A'});
  await assert.rejects(stale,/Project changed while Chat connection was resolving/);
  assert.notEqual(state.chatConnId,'conn-A','stale project A connection leaked into project B');

  for(const fn of rootListeners['revex:authoritative-project-bound']||[])fn({detail:{projectId:'B'}});
  assert.equal(state.chatConnId,'','project-boundary reset did not clear connection');
  assert.equal(state.chatLoaded,false,'project-boundary reset did not clear loaded flag');
  assert.equal(state.chatProjectId,'B','project-boundary reset did not bind B');
  assert.equal(frame.src,'about:blank','project-boundary reset did not clear iframe');
  assert.equal(sessionStorage.getItem('liber_revex_chat_draft'),null,'legacy draft leaked across project boundary');

  const b=await Store.ensureProjectChat('B');
  assert.equal(b.connId,'conn-B');
  assert.equal(b.projectId,'B');
  assert.equal(state.chatConnId,'conn-B');
  assert.equal(frame.dataset.revexProjectId,'B');

  state.projectId='M';state.chatProjectId='M';
  await assert.rejects(Store.ensureProjectChat('M'),/Blocked a cross-project Chat connection/);

  state.projectId='B';state.chatProjectId='B';frame.dataset.revexProjectId='A';frame.src='https://liberpict.com/liber-apps/apps/secure-chat/index.html?connId=conn-A';
  for(const fn of frameListeners.load||[])fn();
  assert.equal(frame.src,'about:blank','iframe load guard allowed a different project');
  assert.equal(frame.dataset.revexChatLoaded,'0');

  assert.deepEqual(originalCalls,['A','B','M']);
  console.log(JSON.stringify({REVEX_R136_PROJECT_CHAT:'PASSED',staleAsyncConnectionBlocked:true,serverProjectMismatchBlocked:true,projectBoundaryResetsIframe:true,secureChatRemainsOwner:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});