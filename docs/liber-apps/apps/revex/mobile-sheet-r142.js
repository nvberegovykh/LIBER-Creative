(function(root){
'use strict';
const BUILD='20260819r142-mobile-sheet1';
if(root.__revexMobileSheetR142)return;
root.__revexMobileSheetR142={build:BUILD,presentationOnly:true,reusesExistingNodes:true,docsOwner:'r133',chatOwner:'secure-chat'};
const byId=id=>document.getElementById(id);
const mobile=()=>document.body?.classList.contains('revex-mobile-touch')||root.matchMedia?.('(max-width:860px)')?.matches===true;
const moved=new Map();
let currentView='';
let currentPane='';

function remember(node,key){if(!node||moved.has(key))return;moved.set(key,{node,parent:node.parentNode,next:node.nextSibling});}
function rememberedNode(key,fallback){return moved.get(key)?.node||fallback||null;}
function restore(key){const row=moved.get(key);if(!row)return;const{node,parent,next}=row;if(parent){if(next&&next.parentNode===parent)parent.insertBefore(node,next);else parent.appendChild(node);}moved.delete(key);}
function css(){if(byId('revex-r142-mobile-sheet-css'))return;const s=document.createElement('style');s.id='revex-r142-mobile-sheet-css';s.textContent=`
.viewport-wrap{min-width:0!important;max-width:100%!important}
.viewport-tools.viewer-controls{box-sizing:border-box!important;max-width:calc(100% - 24px)!important;overflow-x:auto!important;overflow-y:hidden!important;scrollbar-width:none}
.viewport-tools.viewer-controls::-webkit-scrollbar{display:none}
@media(max-width:860px){
 body.revex-mobile-touch #workspace,body.revex-mobile-touch #workspace>.view{width:100%!important;max-width:100vw!important;min-width:0!important;box-sizing:border-box!important}
 body.revex-mobile-touch #view-bim.bim-view:not([hidden]){display:block!important;position:relative!important;height:100%!important;min-height:0!important;overflow:hidden!important;padding:0!important}
 body.revex-mobile-touch #view-bim>.viewport-wrap{display:block!important;width:100%!important;height:100%!important;min-height:0!important;max-height:none!important;border:0!important}
 body.revex-mobile-touch #view-design.design-view:not([hidden]){display:block!important;height:100%!important;min-height:0!important;overflow:hidden!important;padding:0!important}
 body.revex-mobile-touch #view-design>.design-content{display:block!important;width:100%!important;height:100%!important;min-height:0!important;max-width:100%!important;overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch!important;padding:12px max(12px,var(--r133-safe-right,0px)) calc(54px + max(12px,var(--r133-safe-bottom,0px))) max(12px,var(--r133-safe-left,0px))!important}
 body.revex-mobile-touch #view-design .design-lanes{grid-template-columns:1fr!important;max-width:100%!important}
 body.revex-mobile-touch #view-design .design-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;max-width:100%!important}
 body.revex-mobile-touch #revex-r142-sheet{display:block!important;position:fixed!important;z-index:9400!important;left:max(4px,var(--r133-safe-left,0px))!important;right:max(4px,var(--r133-safe-right,0px))!important;bottom:max(4px,var(--r133-safe-bottom,0px))!important;width:auto!important;max-width:none!important;min-width:0!important;border:1px solid var(--line-2)!important;border-radius:13px!important;background:rgba(13,17,23,.985)!important;box-shadow:0 16px 60px rgba(0,0,0,.55)!important;overflow:hidden!important}
 body.revex-mobile-touch #revex-r142-sheet[hidden]{display:none!important}
 body.revex-mobile-touch #revex-r142-sheet-tabs{display:grid!important;grid-template-columns:1fr 1fr 42px!important;min-height:40px!important;border-bottom:0 solid var(--line)!important}
 body.revex-mobile-touch #revex-r142-sheet[data-open="1"] #revex-r142-sheet-tabs{border-bottom-width:1px!important}
 body.revex-mobile-touch #revex-r142-sheet-tabs button{min-width:0!important;min-height:40px!important;border:0!important;border-right:1px solid var(--line)!important;border-radius:0!important;background:transparent!important;color:var(--tx-2)!important;font:600 10px/1.1 system-ui,sans-serif!important;padding:0 9px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}
 body.revex-mobile-touch #revex-r142-sheet-tabs button.active{background:rgba(255,255,255,.045)!important;color:var(--tx)!important}
 body.revex-mobile-touch #revex-r142-sheet-close{border-right:0!important;font-size:17px!important;font-weight:400!important}
 body.revex-mobile-touch #revex-r142-sheet-body{display:none!important;max-height:min(58dvh,560px)!important;overflow:auto!important;-webkit-overflow-scrolling:touch!important;overscroll-behavior:contain!important}
 body.revex-mobile-touch #revex-r142-sheet[data-open="1"] #revex-r142-sheet-body{display:block!important}
 body.revex-mobile-touch #revex-r142-sheet-body>.rail,body.revex-mobile-touch #revex-r142-sheet-body>.chapter-rail,body.revex-mobile-touch #revex-r142-sheet-body>.inspector{display:block!important;position:static!important;inset:auto!important;width:100%!important;max-width:100%!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;border:0!important;border-radius:0!important;box-shadow:none!important;padding:10px 12px 14px!important;background:transparent!important}
 body.revex-mobile-touch #revex-r142-sheet-body>.revex-selection-open{position:static!important;inset:auto!important;padding-top:10px!important}
 body.revex-mobile-touch #revex-r142-sheet-body .revex-selection-close{display:none!important}
 body.revex-mobile-touch #view-chat.chat-view:not([hidden]){display:grid!important;grid-template-rows:minmax(0,1fr)!important;width:100%!important;max-width:100%!important;min-width:0!important;height:100%!important;overflow:hidden!important}
 body.revex-mobile-touch #view-chat>.chat-head{display:none!important}
 body.revex-mobile-touch #view-chat>.chat-frame-wrap{width:100%!important;max-width:100%!important;min-width:0!important;height:100%!important;min-height:0!important;overflow:hidden!important}
 body.revex-mobile-touch #chat-frame{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;height:100%!important;min-height:0!important;border:0!important}
 body.revex-mobile-touch #revex-wallt-open{display:none!important}
 body.revex-mobile-touch #view-design .design-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}
}
@media(max-width:390px){body.revex-mobile-touch #view-design .design-grid{grid-template-columns:1fr!important}}
`;
document.head.appendChild(s);}
function sheet(){let s=byId('revex-r142-sheet');if(s)return s;s=document.createElement('section');s.id='revex-r142-sheet';s.hidden=true;s.dataset.open='0';s.setAttribute('aria-label','Mobile module panel');s.innerHTML='<div id="revex-r142-sheet-tabs"><button type="button" id="revex-r142-sheet-a"></button><button type="button" id="revex-r142-sheet-b"></button><button type="button" id="revex-r142-sheet-close" aria-label="Close panel">×</button></div><div id="revex-r142-sheet-body"></div>';document.body.appendChild(s);byId('revex-r142-sheet-a').onclick=()=>openPane('a');byId('revex-r142-sheet-b').onclick=()=>openPane('b');byId('revex-r142-sheet-close').onclick=closePane;return s;}
function config(view){
 if(view==='bim')return {
  a:{label:'Model',node:rememberedNode('bim-rail',document.querySelector('#view-bim>.rail')),key:'bim-rail'},
  b:{label:'Properties',node:rememberedNode('bim-inspector',byId('bim-inspector')),key:'bim-inspector'}
 };
 if(view==='design')return {
  a:{label:'Selector',node:rememberedNode('design-rail',document.querySelector('#view-design>.chapter-rail')),key:'design-rail'},
  b:{label:'Position',node:rememberedNode('design-inspector',byId('design-inspector')),key:'design-inspector'}
 };
 return null;
}
function restoreView(view){if(view==='bim'){restore('bim-rail');restore('bim-inspector');}if(view==='design'){restore('design-rail');restore('design-inspector');}}
function moveConfigured(view){
 const s=sheet(),body=byId('revex-r142-sheet-body');
 if(currentView&&currentView!==view){restoreView(currentView);closePane();}
 const c=config(view);if(!c||!body){s.hidden=true;return;}
 for(const p of Object.values(c)){if(!p.node)continue;remember(p.node,p.key);}
 byId('revex-r142-sheet-a').textContent=c.a.label;byId('revex-r142-sheet-b').textContent=c.b.label;s.hidden=false;currentView=view;
}
function openPane(which){if(!mobile())return;const c=config(currentView),s=sheet(),body=byId('revex-r142-sheet-body');if(!c||!c[which]?.node)return;const pane=c[which];body.replaceChildren(pane.node);s.dataset.open='1';currentPane=which;byId('revex-r142-sheet-a').classList.toggle('active',which==='a');byId('revex-r142-sheet-b').classList.toggle('active',which==='b');}
function closePane(){const s=sheet();s.dataset.open='0';currentPane='';byId('revex-r142-sheet-a').classList.remove('active');byId('revex-r142-sheet-b').classList.remove('active');}
function restoreAll(){closePane();restoreView('bim');restoreView('design');sheet().hidden=true;currentView='';}
function activeView(){const b=document.querySelector('.main-nav [data-view].active');return String(b?.dataset?.view||'');}
function sync(){if(!mobile()){restoreAll();return;}const v=activeView();if(v==='bim'||v==='design')moveConfigured(v);else{restoreAll();}}
function ensureWalltMenu(){const menu=byId('revex-r109-actions-menu');if(!menu||byId('revex-r142-wallt-menu'))return;const b=document.createElement('button');b.type='button';b.id='revex-r142-wallt-menu';b.textContent='WALLT Helper / Fixer';b.addEventListener('click',()=>{menu.hidden=true;byId('revex-r109-actions')?.setAttribute('aria-expanded','false');byId('revex-wallt-open')?.click();});menu.appendChild(b);}
function install(){css();sheet();sync();ensureWalltMenu();document.querySelectorAll('.main-nav [data-view]').forEach(b=>b.addEventListener('click',()=>setTimeout(()=>{sync();ensureWalltMenu();},0)));root.addEventListener('resize',()=>setTimeout(sync,0),{passive:true});root.addEventListener('orientationchange',()=>setTimeout(sync,80),{passive:true});root.addEventListener('revex:source-revision-loaded',()=>setTimeout(sync,0));setTimeout(()=>{sync();ensureWalltMenu();},350);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
