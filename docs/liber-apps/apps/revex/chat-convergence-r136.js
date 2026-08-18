(function(root){
'use strict';
const BUILD='20260818r136-project-chat1';
if(root.__revexChatConvergenceR136)return;
const api=root.__revexChatConvergenceR136={build:BUILD,owner:'secure-chat',projectIsolated:true,storageOwner:'secure-chat'};
const byId=id=>document.getElementById(id);
const state=()=>root.__revexState||null;
let installedStore=false,boundProject='';
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'chat convergence r136',...detail})}catch(_){}}
function clearDrafts(){try{sessionStorage.removeItem('liber_revex_chat_draft')}catch(_){} }
function reset(projectId='',reason='project-boundary'){
 const s=state(),frame=byId('chat-frame'),previous=String(s?.chatProjectId||boundProject||'').trim();
 boundProject=String(projectId||'').trim();
 if(s){s.chatConnId='';s.chatLoaded=false;s.chatProjectId=boundProject;}
 clearDrafts();
 if(frame){frame.dataset.revexProjectId=boundProject;frame.dataset.revexChatLoaded='0';if(frame.getAttribute('src')!=='about:blank')frame.src='about:blank';}
 const placeholder=byId('chat-placeholder');if(placeholder){placeholder.hidden=false;placeholder.textContent=boundProject?'Connecting the project conversation…':'Choose a project to open Chat.'}
 diag('INFO','CHAT_PROJECT_RESET','Project Chat runtime reset at the project identity boundary.',{previousProjectId:previous,projectId:boundProject,reason});
}
function current(projectId){const s=state();return Boolean(projectId&&s&&String(s.projectId||'')===String(projectId));}
function installStoreGuard(){
 const Store=root.RevexStore;if(!Store?.ensureProjectChat)return false;
 if(Store.ensureProjectChat.__revexR136){installedStore=true;return true;}
 const original=Store.ensureProjectChat.bind(Store);
 const wrapped=async function(projectId){
   projectId=String(projectId||'').trim();
   if(!projectId)throw new Error('Choose a REVEX project before opening Chat.');
   if(!current(projectId))throw new Error('Project changed before Chat connection resolution started.');
   const s=state();
   if(s?.chatProjectId&&String(s.chatProjectId)!==projectId)reset(projectId,'connection-project-change');
   const frame=byId('chat-frame');if(frame)frame.dataset.revexProjectId=projectId;
   const result=await original(projectId);
   if(!current(projectId))throw new Error('Project changed while Chat connection was resolving.');
   const connId=String(result?.connId||'').trim();
   if(!connId)throw new Error('Project Chat service returned no connection identity.');
   const returnedProject=String(result?.projectId||result?.linkedProjectId||'').trim();
   if(returnedProject&&returnedProject!==projectId)throw new Error(`Blocked a cross-project Chat connection: expected ${projectId}, received ${returnedProject}.`);
   if(s){s.chatProjectId=projectId;s.chatConnId=connId;}
   if(frame)frame.dataset.revexProjectId=projectId;
   return {...result,connId,projectId};
 };
 wrapped.__revexR136=true;wrapped.__revexOriginal=original;Store.ensureProjectChat=wrapped;installedStore=true;
 diag('INFO','CHAT_STORE_R136','Project Chat connection resolver is activation-scoped.',{serverProjectMismatch:'fail-closed'});
 return true;
}
function installFrameGuard(){
 const frame=byId('chat-frame');if(!frame||frame.dataset.revexR136)return false;frame.dataset.revexR136='1';
 frame.addEventListener('load',()=>{
   const s=state(),expected=String(s?.projectId||''),bound=String(frame.dataset.revexProjectId||'');
   if(!expected||bound!==expected){frame.dataset.revexChatLoaded='0';if(frame.getAttribute('src')!=='about:blank')frame.src='about:blank';diag('WARN','CHAT_FRAME_BOUNDARY','Blocked a Chat iframe load outside the active project boundary.',{expectedProjectId:expected,boundProjectId:bound});return;}
   frame.dataset.revexChatLoaded='1';
   const context=String(s?.selectedContext||'');
   if(context){try{frame.contentWindow?.postMessage({type:'liber:revex-chat-context',context,projectId:expected},location.origin)}catch(_){}}
   const placeholder=byId('chat-placeholder');if(placeholder)placeholder.hidden=true;
 });
 return true;
}
function bind(){
 installStoreGuard();installFrameGuard();
 const initial=String(state()?.projectId||'').trim();boundProject=initial;if(state())state().chatProjectId=initial;
 root.addEventListener('revex:authoritative-project-bound',event=>{const projectId=String(event?.detail?.projectId||'').trim();if(projectId!==boundProject)reset(projectId,'authoritative-project-bound');else{boundProject=projectId;if(state())state().chatProjectId=projectId;}});
 root.addEventListener('revex:native-project-binding',event=>{const projectId=String(event?.detail?.projectId||'').trim();if(projectId&&boundProject&&projectId!==boundProject)reset(projectId,'native-project-binding');});
 document.querySelector('[data-view="chat"]')?.addEventListener('click',()=>{const projectId=String(state()?.projectId||'').trim();if(projectId&&boundProject&&projectId!==boundProject)reset(projectId,'chat-open-boundary-audit');});
 diag('INFO','CHAT_R136','Project-isolated Chat boundary installed.',{secureChatStorageOwner:true,crossProjectConnection:'fail-closed',asyncResolutionGuard:true});
}
Object.assign(api,{reset,installStoreGuard,current});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
})(window);
