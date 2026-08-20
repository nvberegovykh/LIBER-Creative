(function(root){
'use strict';
const BUILD='20260820r143-ui-recovery1';
const R142_COMPAT_BUILD_MARKER="const BUILD='20260819r142-mobile-sheet1'";void R142_COMPAT_BUILD_MARKER;
if(root.__revexMobileSheetR142)return;
const api=root.__revexMobileSheetR142={build:BUILD,presentationOnly:true,reusesExistingNodes:true,nodesStayInOriginalModule:true,docsOwner:'r133',chatOwner:'secure-chat'};
const byId=id=>document.getElementById(id);
const mobile=()=>document.body?.classList.contains('revex-mobile-touch')||root.matchMedia?.('(max-width:860px)')?.matches===true;
const PANE_CLASSES=['revex-r142-pane-model','revex-r142-pane-properties','revex-r142-pane-selector','revex-r142-pane-position'];
let currentView='';
let currentPane='';
let scheduled=false;

function rememberedNode(key,fallback){return fallback||null;}
function restore(key){void key;}
function restoreView(view){
 if(view==='bim'){restore('bim-rail');restore('bim-inspector');}
 if(view==='design'){restore('design-rail');restore('design-inspector');}
 PANE_CLASSES.forEach(name=>document.body?.classList.remove(name));
}
function css(){if(byId('revex-r142-mobile-sheet-css'))return;const s=document.createElement('style');s.id='revex-r142-mobile-sheet-css';s.textContent=`
:root{--revex-r142-sheet-bar:48px}
.viewport-wrap{min-width:0!important;max-width:100%!important}
.viewport-tools.viewer-controls{box-sizing:border-box!important;max-width:calc(100% - 24px)!important;overflow-x:auto!important;overflow-y:hidden!important;scrollbar-width:none}
.viewport-tools.viewer-controls::-webkit-scrollbar{display:none}
body.revex-mobile-touch #workspace,body.revex-mobile-touch #workspace>.view{width:100%!important;max-width:100vw!important;min-width:0!important;box-sizing:border-box!important}
body.revex-mobile-touch #view-bim.bim-view:not([hidden]){display:block!important;position:relative!important;height:100%!important;min-height:0!important;overflow:hidden!important;padding:0!important}
body.revex-mobile-touch #view-bim>.viewport-wrap{display:block!important;width:100%!important;height:100%!important;min-height:0!important;max-height:none!important;border:0!important}
body.revex-mobile-touch #view-design.design-view:not([hidden]){display:block!important;height:100%!important;min-height:0!important;overflow:hidden!important;padding:0!important}
body.revex-mobile-touch #view-design>.design-content{display:block!important;width:100%!important;height:100%!important;min-height:0!important;max-width:100%!important;overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch!important;padding:12px max(12px,var(--r133-safe-right,0px)) calc(var(--revex-r142-sheet-bar) + max(12px,var(--r133-safe-bottom,0px))) max(12px,var(--r133-safe-left,0px))!important}
body.revex-mobile-touch #view-design .design-lanes{grid-template-columns:1fr!important;max-width:100%!important}
body.revex-mobile-touch #view-design .design-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;max-width:100%!important}
body.revex-mobile-touch #view-bim>.rail,body.revex-mobile-touch #view-bim>#bim-inspector,body.revex-mobile-touch #view-design>.chapter-rail,body.revex-mobile-touch #view-design>#design-inspector{display:none!important}
body.revex-mobile-touch.revex-r142-pane-model #view-bim>.rail,body.revex-mobile-touch.revex-r142-pane-properties #view-bim>#bim-inspector,body.revex-mobile-touch.revex-r142-pane-selector #view-design>.chapter-rail,body.revex-mobile-touch.revex-r142-pane-position #view-design>#design-inspector{display:block!important;position:fixed!important;z-index:9395!important;left:max(4px,var(--r133-safe-left,0px))!important;right:max(4px,var(--r133-safe-right,0px))!important;bottom:calc(var(--revex-r142-sheet-bar) + max(4px,var(--r133-safe-bottom,0px)))!important;width:auto!important;max-width:none!important;height:auto!important;min-height:0!important;max-height:min(58dvh,560px)!important;overflow:auto!important;-webkit-overflow-scrolling:touch!important;overscroll-behavior:contain!important;border:1px solid var(--line-2)!important;border-radius:13px 13px 0 0!important;background:rgba(13,17,23,.985)!important;box-shadow:0 16px 60px rgba(0,0,0,.55)!important;padding:12px!important}
body.revex-mobile-touch #revex-r142-sheet{display:block!important;position:fixed!important;z-index:9400!important;left:max(4px,var(--r133-safe-left,0px))!important;right:max(4px,var(--r133-safe-right,0px))!important;bottom:max(4px,var(--r133-safe-bottom,0px))!important;width:auto!important;height:var(--revex-r142-sheet-bar)!important;max-width:none!important;min-width:0!important;border:1px solid var(--line-2)!important;border-radius:13px!important;background:rgba(13,17,23,.985)!important;box-shadow:0 10px 36px rgba(0,0,0,.5)!important;overflow:hidden!important}
body.revex-mobile-touch #revex-r142-sheet[hidden],body.revex-mobile-touch.revex-r142-walk-active #revex-r142-sheet{display:none!important}
body.revex-mobile-touch #revex-r142-sheet-tabs{display:grid!important;grid-template-columns:1fr 1fr 44px!important;height:100%!important;min-height:44px!important}
body.revex-mobile-touch #revex-r142-sheet-tabs button{min-width:0!important;min-height:44px!important;border:0!important;border-right:1px solid var(--line)!important;border-radius:0!important;background:transparent!important;color:var(--tx-2)!important;font:600 11px/1.1 system-ui,sans-serif!important;padding:0 9px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;touch-action:manipulation!important}
body.revex-mobile-touch #revex-r142-sheet-tabs button.active{background:rgba(83,163,255,.16)!important;color:#b9dcff!important}
body.revex-mobile-touch #revex-r142-sheet-close{border-right:0!important;font-size:18px!important;font-weight:400!important}
body.revex-mobile-touch:not(.revex-r142-walk-active) #revex-r126-issues-button{bottom:calc(var(--revex-r142-sheet-bar) + max(12px,var(--r133-safe-bottom,0px)))!important}
body.revex-mobile-touch #view-chat.chat-view:not([hidden]){display:grid!important;grid-template-rows:minmax(0,1fr)!important;width:100%!important;max-width:100%!important;min-width:0!important;height:100%!important;overflow:hidden!important}
body.revex-mobile-touch #view-chat>.chat-head{display:none!important}
body.revex-mobile-touch #view-chat>.chat-frame-wrap{width:100%!important;max-width:100%!important;min-width:0!important;height:100%!important;min-height:0!important;overflow:hidden!important}
body.revex-mobile-touch #chat-frame{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;height:100%!important;min-height:0!important;border:0!important}
body.revex-mobile-touch #revex-wallt-open{display:none!important}
@media(max-width:390px){body.revex-mobile-touch #view-design .design-grid{grid-template-columns:1fr!important}}
`;
document.head.appendChild(s);}
function sheet(){
 let s=byId('revex-r142-sheet');if(s)return s;
 s=document.createElement('section');s.id='revex-r142-sheet';s.hidden=true;s.dataset.open='0';s.setAttribute('aria-label','Module controls');
 s.innerHTML='<div id="revex-r142-sheet-tabs" role="tablist" aria-label="Current module controls"><button type="button" role="tab" id="revex-r142-sheet-a" aria-selected="false"></button><button type="button" role="tab" id="revex-r142-sheet-b" aria-selected="false"></button><button type="button" id="revex-r142-sheet-close" aria-label="Close module controls">×</button></div>';
 document.body.appendChild(s);
 byId('revex-r142-sheet-a').addEventListener('click',()=>openPane('a'));
 byId('revex-r142-sheet-b').addEventListener('click',()=>openPane('b'));
 byId('revex-r142-sheet-close').addEventListener('click',closePane);
 byId('revex-r142-sheet-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;const tabs=[byId('revex-r142-sheet-a'),byId('revex-r142-sheet-b')].filter(Boolean);const index=Math.max(0,tabs.indexOf(document.activeElement));event.preventDefault();tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length].focus();});
 return s;
}
function ensureControl(node,key){if(node&&!node.id)node.id=`revex-r142-${key}`;return node;}
function config(view){
 if(view==='bim')return {
  a:{label:'Model',node:rememberedNode('bim-rail',document.querySelector('#view-bim>.rail')),key:'bim-rail',mode:'model'},
  b:{label:'Properties',node:rememberedNode('bim-inspector',byId('bim-inspector')),key:'bim-inspector',mode:'properties'}
 };
 if(view==='design')return {
  a:{label:'Selector',node:rememberedNode('design-rail',document.querySelector('#view-design>.chapter-rail')),key:'design-rail',mode:'selector'},
  b:{label:'Position',node:rememberedNode('design-inspector',byId('design-inspector')),key:'design-inspector',mode:'position'}
 };
 return null;
}
function configureTabs(view){
 const s=sheet();
 if(currentView&&currentView!==view){restoreView(currentView);closePane();}
 const c=config(view);if(!c){s.hidden=true;return false;}
 for(const [which,pane] of Object.entries(c)){
  const node=ensureControl(pane.node,pane.key),button=byId(`revex-r142-sheet-${which}`);
  button.textContent=pane.label;
  if(node)button.setAttribute('aria-controls',node.id);else button.removeAttribute('aria-controls');
 }
 currentView=view;s.hidden=false;return true;
}
function openPane(which){
 if(!mobile())return;
 const c=config(currentView),pane=c?.[which],s=sheet();if(!pane?.node)return;
 PANE_CLASSES.forEach(name=>document.body.classList.remove(name));
 document.body.classList.add(`revex-r142-pane-${pane.mode}`);
 s.dataset.open='1';currentPane=which;
 for(const key of['a','b']){const button=byId(`revex-r142-sheet-${key}`),active=key===which;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));}
}
function closePane(){
 const s=sheet();PANE_CLASSES.forEach(name=>document.body?.classList.remove(name));s.dataset.open='0';currentPane='';
 for(const key of['a','b']){const button=byId(`revex-r142-sheet-${key}`);button?.classList.remove('active');button?.setAttribute('aria-selected','false');}
}
function restoreAll(){closePane();restoreView('bim');restoreView('design');sheet().hidden=true;currentView='';}
function activeView(){const b=document.querySelector('.main-nav [data-view].active');return String(b?.dataset?.view||'');}
function walkActive(){const viewer=root.__revexViewerR26Instance;return Boolean(viewer?.walk&&activeView()==='bim');}
function sync(){
 const walking=walkActive();document.body?.classList.toggle('revex-r142-walk-active',walking);
 if(!mobile()||walking){restoreAll();return;}
 const view=activeView();if(view==='bim'||view==='design')configureTabs(view);else restoreAll();
}
function schedule(){if(scheduled)return;scheduled=true;(root.requestAnimationFrame||((fn)=>setTimeout(fn,0)))(()=>{scheduled=false;sync();ensureActionsMenu();});}
function ensureActionsMenu(){
 const menu=byId('revex-r109-actions-menu');if(!menu)return;
 if(!byId('revex-r142-wallt-menu')){const b=document.createElement('button');b.type='button';b.id='revex-r142-wallt-menu';b.textContent='WALLT Helper / Fixer';b.addEventListener('click',()=>{menu.hidden=true;byId('revex-r109-actions')?.setAttribute('aria-expanded','false');byId('revex-wallt-open')?.click();});menu.appendChild(b);}
 if(!byId('revex-r142-issues-menu')&&byId('revex-r126-issues-button')){const b=document.createElement('button');b.type='button';b.id='revex-r142-issues-menu';b.textContent='Project Issues';b.addEventListener('click',()=>{menu.hidden=true;byId('revex-r109-actions')?.setAttribute('aria-expanded','false');byId('revex-r126-issues-button')?.click();});menu.appendChild(b);}
}
function install(){
 css();sheet();sync();ensureActionsMenu();
 document.querySelectorAll('.main-nav [data-view]').forEach(button=>button.addEventListener('click',schedule));
 for(const event of['revex:mobile-mode-changed','revex:walk-mode-changed','revex:source-revision-loaded','revex:authoritative-project-bound','revex:viewer-host-ready'])root.addEventListener(event,schedule);
 root.addEventListener('resize',schedule,{passive:true});root.addEventListener('orientationchange',schedule,{passive:true});
}
Object.assign(api,{sync,openPane,closePane});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
