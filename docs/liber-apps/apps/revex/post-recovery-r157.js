(function(root){
'use strict';
const BUILD='20260824r157-ui-guard1';
root.__REVEX_POST_RECOVERY_R157__={build:BUILD,walltChatSurface:'hidden-runtime-preserved',responsivePolicy:'module-scoped'};
const activeView=()=>String(document.querySelector('.main-nav [data-view].active')?.dataset?.view||'').trim();
function closeWalltSurface(){const open=document.getElementById('revex-wallt-open'),panel=document.getElementById('revex-wallt-panel');if(panel)panel.hidden=true;if(open)open.setAttribute('aria-expanded','false')}
function sync(){const chat=activeView()==='chat';document.body.classList.toggle('revex-r157-chat-active',chat);if(chat)closeWalltSurface()}
function css(){if(document.getElementById('revex-r157-ui-guard-css'))return;const style=document.createElement('style');style.id='revex-r157-ui-guard-css';style.textContent='body.revex-r157-chat-active #revex-wallt-open,body.revex-r157-chat-active #revex-wallt-panel,body.revex-r157-chat-active #revex-r142-wallt-menu{display:none!important}';document.head.appendChild(style)}
function install(){css();sync();document.querySelectorAll('.main-nav [data-view]').forEach(button=>button.addEventListener('click',()=>queueMicrotask(sync)));const nav=document.querySelector('.main-nav');if(nav)new MutationObserver(sync).observe(nav,{subtree:true,attributes:true,attributeFilter:['class']});root.addEventListener('popstate',sync);console.log('[REVEX] post-recovery '+BUILD,root.__REVEX_POST_RECOVERY_R157__)}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
