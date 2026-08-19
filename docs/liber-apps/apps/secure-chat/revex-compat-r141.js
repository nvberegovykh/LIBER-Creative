(function(root){
'use strict';
const BUILD='20260819r141-revex-chat-compat1';
if(root.__liberRevexChatCompatR141)return;
const api=root.__liberRevexChatCompatR141={build:BUILD,secureChatOwner:true,plaintextStorage:false,legacyCryptoCandidates:true,embeddedMobile:true};
const embedded=()=>root.parent&&root.parent!==root;
const coarse=()=>root.matchMedia?.('(pointer:coarse)')?.matches===true||Number(navigator.maxTouchPoints||0)>0;
const revexMobile=()=>embedded()&&(root.matchMedia?.('(max-width:1024px)')?.matches===true||coarse());
const uniq=list=>[...new Set((list||[]).map(v=>String(v||'').trim()).filter(Boolean))];

function css(){
 if(document.getElementById('revex-chat-r141-css'))return;
 const s=document.createElement('style');s.id='revex-chat-r141-css';s.textContent=`
body.revex-embedded-mobile,body.revex-embedded-mobile #chat-app{width:100%!important;max-width:100%!important;height:100dvh!important;min-height:100dvh!important;overflow:hidden!important}
body.revex-embedded-mobile #chat-app.chat-app{display:block!important;grid-template-columns:none!important;position:relative!important}
body.revex-embedded-mobile .sidebar{position:fixed!important;z-index:60!important;left:0!important;right:0!important;top:0!important;width:100%!important;max-width:100%!important;height:auto!important;min-height:76px!important;max-height:min(58dvh,520px)!important;border-right:0!important;border-bottom:1px solid rgba(255,255,255,.1)!important;background:#0d1117!important;overflow:visible!important}
body.revex-embedded-mobile .sidebar-header{min-height:46px!important;height:46px!important;padding:max(5px,env(safe-area-inset-top)) 8px 4px!important;box-sizing:content-box!important}
body.revex-embedded-mobile .sidebar-header h2{font-size:14px!important;margin:0!important}body.revex-embedded-mobile .sidebar-header #new-connection-btn{display:none!important}
body.revex-embedded-mobile .mobile-sidebar-tip{display:flex!important;width:100%!important;min-height:30px!important;height:30px!important;align-items:center!important;justify-content:center!important;gap:7px!important;border:0!important;border-top:1px solid rgba(255,255,255,.06)!important;background:#0d1117!important;color:#99a4b2!important;font-size:10px!important}
body.revex-embedded-mobile .connections-panel{display:none!important;position:relative!important;width:100%!important;max-height:calc(min(58dvh,520px) - 76px)!important;overflow-y:auto!important;overflow-x:hidden!important;background:#0d1117!important;border-top:1px solid rgba(255,255,255,.07)!important;padding-bottom:8px!important}
body.revex-embedded-mobile .sidebar.open .connections-panel,body.revex-embedded-mobile #chat-app.mobile-menu-open .sidebar .connections-panel{display:block!important}
body.revex-embedded-mobile .mobile-quick-actions{display:flex!important}body.revex-embedded-mobile .chat-category-tabs{overflow-x:auto!important;white-space:nowrap!important}
body.revex-embedded-mobile .main{position:fixed!important;z-index:1!important;left:0!important;right:0!important;top:76px!important;bottom:0!important;width:100%!important;max-width:100%!important;min-width:0!important;height:auto!important;overflow:hidden!important;border:0!important}
body.revex-embedded-mobile #chat-app.mobile-menu-open .main{pointer-events:none!important;filter:brightness(.74)!important}
body.revex-embedded-mobile .chat-header{min-width:0!important;padding-left:10px!important;padding-right:8px!important}body.revex-embedded-mobile .chat-header-title-wrap{min-width:0!important}body.revex-embedded-mobile #chat-top-title{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}
body.revex-embedded-mobile .messages{min-width:0!important;width:100%!important;padding-left:10px!important;padding-right:10px!important;overflow-x:hidden!important}
body.revex-embedded-mobile .message{max-width:min(88%,680px)!important;overflow-wrap:anywhere!important}
body.revex-embedded-mobile .composer{left:0!important;right:0!important;width:100%!important;max-width:100%!important;min-width:0!important;padding-left:max(7px,env(safe-area-inset-left))!important;padding-right:max(7px,env(safe-area-inset-right))!important;padding-bottom:max(7px,env(safe-area-inset-bottom))!important}
body.revex-embedded-mobile #message-input{min-width:0!important;width:100%!important}
body.revex-embedded-mobile .call-overlay,body.revex-embedded-mobile .recording-preview-overlay,body.revex-embedded-mobile #msg-context-overlay{max-width:100vw!important}
`;
 document.head.appendChild(s);
}

function installMobile(app){
 if(!revexMobile())return;
 document.body.classList.add('revex-embedded-mobile');css();
 if(!app.__revexR141OriginalMobileViewport){
   app.__revexR141OriginalMobileViewport=app.isMobileViewport?.bind(app);
   app.isMobileViewport=function(){return revexMobile()||Boolean(this.__revexR141OriginalMobileViewport?.())};
 }
 try{app.setMobileMenuOpen?.(false)}catch(_){ }
 try{app.syncMobileComposerLayout?.()}catch(_){ }
 try{app.refreshFloatingPanelsPositions?.()}catch(_){ }
}

function connectionRow(app,connId){return (app.connections||[]).find(c=>c&&c.id===connId)||null}
async function fetchConnection(app,connId){
 const local=connectionRow(app,connId);if(local)return local;
 try{const snap=await firebase.getDoc(firebase.doc(app.db,'chatConnections',connId));return snap.exists()?{id:snap.id,...(snap.data()||{})}:null}catch(_){return null}
}
function participantSalt(app,row){try{return app.computeConnKey?.(app.getConnParticipants?.(row||{})||[])||''}catch(_){return''}}
function legacySalts(row){
 const out=[];for(const field of['cryptoLegacySalts','legacyCryptoSalts','legacyKeySalts','keyHistory']){
   const v=row?.[field];if(Array.isArray(v))out.push(...v);else if(typeof v==='string')out.push(v)
 }
 return uniq(out)
}
async function addKey(list,factory){try{const k=await factory();if(k)list.push(k)}catch(_){ }}

function installCrypto(app){
 if(app.__revexR141Crypto)return;app.__revexR141Crypto=true;
 const originalSalts=app.getConnSaltForConn?.bind(app);
 const originalCandidates=app.getFallbackKeyCandidatesForConn?.bind(app);
 if(typeof originalSalts!=='function'||typeof originalCandidates!=='function')return;
 app.getConnSaltForConn=async function(connId){
   const base=await originalSalts(connId);const row=await fetchConnection(this,connId);const parts=Array.isArray(base?.parts)?base.parts:(this.getConnParticipants?.(row||{})||[]);
   const pSalt=participantSalt(this,row||{participants:parts});
   return {...(base||{}),parts,participantSalt:pSalt,legacySalts:uniq([...legacySalts(row),row?.legacyKey,row?.previousKey])};
 };
 app.getFallbackKeyCandidatesForConn=async function(connId){
   const out=[];try{out.push(...(await originalCandidates(connId)||[]))}catch(_){ }
   const info=await this.getConnSaltForConn(connId);const parts=uniq(info?.parts||[]);const me=String(this.currentUser?.uid||'').trim();
   const salts=uniq([info?.stableSalt,info?.participantSalt,info?.connIdSalt,connId,...(info?.legacySalts||[])]);
   const crypto=root.chatCrypto; if(!crypto)return out;
   for(const salt of salts){
     await addKey(out,()=>crypto.deriveChatKey(`${salt}|liber_secure_chat_conn_stable_v1`));
     if(parts.length>2)await addKey(out,()=>crypto.deriveChatKey(`${parts.slice().sort().join('|')}|${salt}|liber_group_fallback_v2`));
     // A project resolver may expand an old 1:1 thread into a project group. Try each
     // surviving participant as the legacy peer so those historical messages remain readable.
     for(const peer of parts.filter(uid=>uid&&uid!==me).slice(0,12)){
       if(typeof crypto.deriveFallbackSharedAesKey==='function')await addKey(out,()=>crypto.deriveFallbackSharedAesKey(me,peer,salt));
       await addKey(out,()=>crypto.deriveChatKey(`${[me,peer].sort().join('|')}|${salt}|liber_secure_chat_fallback_v1`));
     }
   }
   return out;
 };
 try{app._fallbackKeyCandidatesCache?.clear?.()}catch(_){ }
}

function install(app){installCrypto(app);installMobile(app);root.addEventListener('resize',()=>{if(revexMobile())installMobile(app);else document.body.classList.remove('revex-embedded-mobile')},{passive:true});console.info('[LIBER Chat] REVEX compatibility '+BUILD,{crypto:'legacy candidates preserved',embeddedMobile:revexMobile()})}
let tries=0;const wait=()=>{const app=root.secureChatApp;if(app){install(app);return}if(tries++<120)setTimeout(wait,50)};wait();
})(window);
