(function(root){
'use strict';
const BUILD='20260819r141-chat-embed1';
if(root.__revexChatEmbedR141)return;
root.__revexChatEmbedR141={build:BUILD,secureChatOwner:true,compat:'revex-compat-r141'};
const byId=id=>document.getElementById(id);
function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'chat embed r141',...detail})}catch(_){}}
function inject(){
 const frame=byId('chat-frame');if(!frame||!frame.contentDocument)return false;
 try{
  const doc=frame.contentDocument,win=frame.contentWindow;if(!doc||!win)return false;
  const path=String(win.location?.pathname||'');if(!/\/liber-apps\/apps\/secure-chat\//.test(path))return false;
  if(doc.querySelector('script[data-revex-chat-r141]'))return true;
  const script=doc.createElement('script');script.dataset.revexChatR141='1';script.src='revex-compat-r141.js?v=20260819r141-revex-chat-compat1';script.async=false;
  script.onload=()=>diag('INFO','CHAT_EMBED_R141','Secure Chat compatibility loaded into active REVEX project iframe.',{projectId:String(root.__revexState?.projectId||''),frameProjectId:String(frame.dataset.revexProjectId||'')});
  script.onerror=()=>diag('ERROR','CHAT_EMBED_R141','Secure Chat compatibility could not load.',{});
  doc.head.appendChild(script);return true;
 }catch(error){diag('WARN','CHAT_EMBED_R141',error?.message||String(error),{});return false}
}
function install(){const frame=byId('chat-frame');if(!frame)return;frame.addEventListener('load',()=>setTimeout(inject,0));setTimeout(inject,0);root.addEventListener('revex:authoritative-project-bound',()=>setTimeout(inject,80));}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
