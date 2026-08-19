(function(root){
'use strict';
const BUILD='20260819r140-mobile-convergence1';
if(root.__revexMobileConvergenceR140)return;
root.__revexMobileConvergenceR140={build:BUILD,presentationOnly:true,owner:'all-mobile-layout',floatingControls:false,inFlowPanels:true};

const byId=id=>document.getElementById(id);
const mobile=()=>document.body?.classList.contains('revex-mobile-touch')||root.matchMedia?.('(max-width:860px)')?.matches===true||(Number(navigator.maxTouchPoints||0)>0&&root.matchMedia?.('(max-width:1024px)')?.matches===true);
const TAB_ICONS={bim:'◇',design:'✦',spec:'≡',docs:'▤',energy:'ϟ',chat:'◌',history:'↺'};
const TOOL_ICONS={'fit-model':'⌖','detail-toggle':'▱','section-toggle':'⌗','walk-toggle':'↟'};
const moved=new Map();
let designTitleObserver=null,designInspectorObserver=null,bimInspectorObserver=null;

function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'mobile convergence r140',...detail})}catch(_){}}
function css(){
 if(byId('revex-r140-mobile-css'))return;
 const s=document.createElement('style');s.id='revex-r140-mobile-css';s.textContent=`
body.revex-mobile-touch #r139-design-selector-toggle,body.revex-mobile-touch #r139-design-properties-toggle{display:none!important}
body.revex-mobile-touch .main-nav .revex-tabs button:before,body.revex-mobile-touch .viewport-tools.viewer-controls .tool:before{content:none!important;display:none!important}
body.revex-mobile-touch .r140-icon{display:inline-grid!important;place-items:center!important;width:20px!important;height:20px!important;font:16px/1 system-ui,-apple-system,"Segoe UI Symbol","Arial Unicode MS",sans-serif!important;pointer-events:none!important}
body.revex-mobile-touch .viewport-tools.viewer-controls .r140-icon{width:18px!important;height:18px!important;font-size:14px!important}
body.revex-mobile-touch #workspace{min-height:0!important;height:100%!important;overflow:hidden!important}
body.revex-mobile-touch #workspace>.view:not([hidden]),body.revex-mobile-touch #workspace>.empty-view:not([hidden]){box-sizing:border-box!important;width:100%!important;max-width:100vw!important;min-width:0!important;height:100%!important;min-height:0!important}
body.revex-mobile-touch #view-design:not([hidden]),body.revex-mobile-touch #view-docs:not([hidden]),body.revex-mobile-touch #view-energy:not([hidden]),body.revex-mobile-touch #view-history:not([hidden]){display:block!important;overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch!important;overscroll-behavior-y:contain!important;touch-action:pan-y!important;padding-bottom:max(18px,var(--r133-safe-bottom,0px))!important}
body.revex-mobile-touch #view-spec:not([hidden]),body.revex-mobile-touch #view-chat:not([hidden]){display:block!important;overflow:hidden!important}
body.revex-mobile-touch #view-spec iframe,body.revex-mobile-touch #view-chat iframe,body.revex-mobile-touch #chat-frame{display:block!important;width:100%!important;max-width:100%!important;height:100%!important;min-height:0!important;border:0!important}
body.revex-mobile-touch #view-bim.bim-view:not([hidden]){display:block!important;height:100%!important;overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch!important;padding-bottom:max(16px,var(--r133-safe-bottom,0px))!important}
body.revex-mobile-touch #view-bim>.viewport-wrap{display:block!important;width:100%!important;height:max(56dvh,340px)!important;min-height:340px!important;max-height:680px!important;border-right:0!important;border-bottom:1px solid var(--line)!important}
body.revex-mobile-touch .r140-mobile-details{display:block!important;width:100%!important;margin:0!important;border:0!important;border-bottom:1px solid var(--line)!important;background:var(--panel,#101319)!important}
body.revex-mobile-touch .r140-mobile-details>summary{list-style:none!important;display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:center!important;gap:10px!important;min-height:44px!important;padding:9px max(12px,var(--r133-safe-right,0px)) 9px max(12px,var(--r133-safe-left,0px))!important;color:var(--tx,#eef2f7)!important;font:650 11px/1.25 system-ui,sans-serif!important;cursor:pointer!important;user-select:none!important}
body.revex-mobile-touch .r140-mobile-details>summary::-webkit-details-marker{display:none!important}
body.revex-mobile-touch .r140-mobile-details>summary:after{content:'⌄';font:15px/1 system-ui,sans-serif!important;color:var(--tx-3,#8793a1)!important;transition:transform .14s ease!important}
body.revex-mobile-touch .r140-mobile-details[open]>summary:after{transform:rotate(180deg)!important}
body.revex-mobile-touch .r140-mobile-details>summary small{display:block!important;margin-top:2px!important;color:var(--tx-3,#8793a1)!important;font:8px/1.2 var(--mono,ui-monospace)!important;letter-spacing:.08em!important;text-transform:uppercase!important}
body.revex-mobile-touch .r140-mobile-details>.r140-details-body{display:block!important;min-width:0!important;max-width:100%!important;padding:0!important}
body.revex-mobile-touch .r140-mobile-details .rail,body.revex-mobile-touch .r140-mobile-details .chapter-rail,body.revex-mobile-touch .r140-mobile-details .inspector{position:static!important;display:block!important;width:100%!important;max-width:100%!important;height:auto!important;min-height:0!important;max-height:52dvh!important;overflow:auto!important;border:0!important;padding:10px max(12px,var(--r133-safe-right,0px)) max(14px,var(--r133-safe-bottom,0px)) max(12px,var(--r133-safe-left,0px))!important;box-shadow:none!important}
body.revex-mobile-touch #r140-design-selector .chapter-rail>.sp-rail-head{display:none!important}
body.revex-mobile-touch #r140-design-selector #chapter-list{display:grid!important;margin:0!important;padding:2px 0 8px!important}
body.revex-mobile-touch #r140-design-editor #design-inspector{max-height:none!important;overflow:visible!important;background:transparent!important}
body.revex-mobile-touch #view-design>.design-content{width:100%!important;max-width:100%!important;min-height:0!important;height:auto!important;overflow:visible!important;padding:12px max(12px,var(--r133-safe-right,0px)) 20px max(12px,var(--r133-safe-left,0px))!important}
body.revex-mobile-touch #view-design .design-lanes{grid-template-columns:1fr!important;max-width:100%!important}
body.revex-mobile-touch #view-design .design-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;max-width:100%!important}
body.revex-mobile-touch #view-docs .docs-toolbar{position:static!important;display:flex!important;flex-wrap:wrap!important;min-width:0!important;overflow:visible!important}
body.revex-mobile-touch #view-docs .docs-actions{display:flex!important;flex-wrap:wrap!important;width:100%!important;overflow:visible!important}
body.revex-mobile-touch #view-docs .docs-explorer{display:block!important;height:auto!important;min-height:0!important;overflow:visible!important}
body.revex-mobile-touch #view-docs .docs-tree-wrap{display:block!important;max-height:34dvh!important;overflow:auto!important;border-right:0!important;border-bottom:1px solid var(--line)!important}
body.revex-mobile-touch #view-docs .docs-preview{display:block!important;height:58dvh!important;min-height:360px!important;overflow:hidden!important}
body.revex-mobile-touch #view-energy .energy-layout,body.revex-mobile-touch #view-energy .energy-fields{grid-template-columns:1fr!important;max-width:100%!important}
body.revex-mobile-touch #view-history{padding-left:max(10px,var(--r133-safe-left,0px))!important;padding-right:max(10px,var(--r133-safe-right,0px))!important}
body.revex-mobile-touch #revex-wallt-open.r140-wallt-docked{position:static!important;inset:auto!important;z-index:auto!important;display:inline-grid!important;place-items:center!important;flex:0 0 34px!important;width:34px!important;min-width:34px!important;height:32px!important;min-height:32px!important;margin:0!important;padding:0!important;border-radius:8px!important;font-size:0!important;box-shadow:none!important;backdrop-filter:none!important}
body.revex-mobile-touch #revex-wallt-open.r140-wallt-docked:after{content:none!important;display:none!important}
body.revex-mobile-touch #revex-wallt-open.r140-wallt-docked .r140-wallt-mark{display:inline!important;font:17px/1 system-ui,sans-serif!important;letter-spacing:0!important}
body.revex-mobile-touch #revex-wallt-panel{left:max(7px,var(--r133-safe-left,0px))!important;right:max(7px,var(--r133-safe-right,0px))!important;bottom:max(7px,var(--r133-safe-bottom,0px))!important;width:auto!important;max-height:calc(100dvh - max(14px,var(--r133-safe-top,0px)) - max(14px,var(--r133-safe-bottom,0px)))!important}
body.revex-mobile-touch .section-controls:not([hidden]){max-height:calc(100% - 54px)!important;overflow:auto!important}
@media(max-width:390px){body.revex-mobile-touch #view-design .design-grid{grid-template-columns:1fr!important}}
`;
 document.head.appendChild(s);
}
function iconSpan(icon){const span=document.createElement('span');span.className='r140-icon';span.setAttribute('aria-hidden','true');span.textContent=icon;return span}
function inlineIcons(){
 for(const button of document.querySelectorAll('.main-nav [data-view]')){if(!button.querySelector('.r140-icon'))button.prepend(iconSpan(TAB_ICONS[button.dataset.view]||'·'))}
 for(const [id,icon] of Object.entries(TOOL_ICONS)){const button=byId(id);if(button&&!button.querySelector('.r140-icon'))button.prepend(iconSpan(icon))}
}
function savePosition(node,key){if(!node||moved.has(key))return;moved.set(key,{node,parent:node.parentNode,next:node.nextSibling})}
function restore(key){const row=moved.get(key);if(!row)return;const{node,parent,next}=row;if(parent){if(next&&next.parentNode===parent)parent.insertBefore(node,next);else parent.appendChild(node)}moved.delete(key)}
function detailsShell(id,title,subtitle=''){
 let d=byId(id);if(d)return d;d=document.createElement('details');d.id=id;d.className='r140-mobile-details';const s=document.createElement('summary');s.innerHTML=`<span><b class="r140-summary-title"></b><small class="r140-summary-subtitle"></small></span>`;s.querySelector('.r140-summary-title').textContent=title;s.querySelector('.r140-summary-subtitle').textContent=subtitle;const body=document.createElement('div');body.className='r140-details-body';d.append(s,body);return d
}
function setSummary(id,title,subtitle){const d=byId(id);if(!d)return;const t=d.querySelector('.r140-summary-title'),s=d.querySelector('.r140-summary-subtitle');if(t)t.textContent=title;if(s)s.textContent=subtitle||''}
function installDesign(){
 const view=byId('view-design'),rail=view?.querySelector(':scope>.chapter-rail'),content=view?.querySelector(':scope>.design-content'),inspector=byId('design-inspector');if(!view||!rail||!content||!inspector)return;
 savePosition(rail,'design-rail');savePosition(inspector,'design-inspector');
 let selector=byId('r140-design-selector');if(!selector){selector=detailsShell('r140-design-selector','Design selector','Choose chapter / schedule');view.insertBefore(selector,content)}
 if(rail.parentNode!==selector.querySelector('.r140-details-body'))selector.querySelector('.r140-details-body').appendChild(rail);
 let editor=byId('r140-design-editor');if(!editor){editor=detailsShell('r140-design-editor','Position editor','Select a Design Book position');view.insertBefore(editor,content)}
 if(inspector.parentNode!==editor.querySelector('.r140-details-body'))editor.querySelector('.r140-details-body').appendChild(inspector);
 const sync=()=>{const chapter=String(byId('chapter-title')?.textContent||'Design Book').trim()||'Design Book';setSummary('r140-design-selector','Design selector',chapter);const pos=String(inspector.querySelector('h2')?.textContent||'Select a position').trim()||'Select a position';setSummary('r140-design-editor','Position editor',pos);if(pos&&!/^select a position$/i.test(pos))editor.open=true};sync();
 if(!designTitleObserver&&byId('chapter-title')){designTitleObserver=new MutationObserver(sync);designTitleObserver.observe(byId('chapter-title'),{childList:true,subtree:true,characterData:true})}
 if(!designInspectorObserver){designInspectorObserver=new MutationObserver(sync);designInspectorObserver.observe(inspector,{childList:true,subtree:true,characterData:true})}
 const list=byId('chapter-list');if(list&&!list.dataset.r140Bound){list.dataset.r140Bound='1';list.addEventListener('click',()=>setTimeout(()=>{selector.open=false;sync()},0))}
}
function installBim(){
 const view=byId('view-bim'),rail=view?.querySelector(':scope>.rail'),viewport=view?.querySelector(':scope>.viewport-wrap'),inspector=byId('bim-inspector');if(!view||!rail||!viewport||!inspector)return;
 savePosition(rail,'bim-rail');savePosition(inspector,'bim-inspector');
 let nav=byId('r140-bim-navigator');if(!nav){nav=detailsShell('r140-bim-navigator','Model navigator','Search, hidden elements, model tree');viewport.insertAdjacentElement('afterend',nav)}
 if(rail.parentNode!==nav.querySelector('.r140-details-body'))nav.querySelector('.r140-details-body').appendChild(rail);
 let props=byId('r140-bim-properties');if(!props){props=detailsShell('r140-bim-properties','Selection properties','Revit identity, materials, parameters, issues');nav.insertAdjacentElement('afterend',props)}
 if(inspector.parentNode!==props.querySelector('.r140-details-body'))props.querySelector('.r140-details-body').appendChild(inspector);
 const sync=()=>{const name=String(inspector.querySelector('h2')?.textContent||'No element selected').trim()||'No element selected';setSummary('r140-bim-properties','Selection properties',name);if(!/^no element selected$/i.test(name))props.open=true};sync();
 if(!bimInspectorObserver){bimInspectorObserver=new MutationObserver(sync);bimInspectorObserver.observe(inspector,{childList:true,subtree:true,characterData:true})}
}
function dockWallt(){const open=byId('revex-wallt-open'),top=document.querySelector('.topbar');if(!open||!top)return;savePosition(open,'wallt-open');if(open.parentNode!==top)top.appendChild(open);open.classList.add('r140-wallt-docked');if(!open.querySelector('.r140-wallt-mark')){open.textContent='';const mark=document.createElement('span');mark.className='r140-wallt-mark';mark.textContent='✦';open.appendChild(mark)}open.setAttribute('aria-label','Open WALLT Helper / Fixer');open.title='WALLT Helper / Fixer'}
function removeR139Artifacts(){byId('r139-design-selector-toggle')?.remove();byId('r139-design-properties-toggle')?.remove();byId('revex-r139-mobile-design-css')?.remove()}
function restoreDesktop(){
 for(const id of['r140-design-selector','r140-design-editor','r140-bim-navigator','r140-bim-properties'])byId(id)?.remove();
 for(const key of['design-rail','design-inspector','bim-rail','bim-inspector'])restore(key);
 const open=byId('revex-wallt-open');if(open){open.classList.remove('r140-wallt-docked');open.querySelector('.r140-wallt-mark')?.remove();open.textContent='✦ WALLT'}restore('wallt-open');
}
function apply(){
 inlineIcons();removeR139Artifacts();
 if(!mobile()){restoreDesktop();return}
 installDesign();installBim();dockWallt();
}
function install(){css();apply();root.addEventListener('resize',()=>setTimeout(apply,0),{passive:true});root.addEventListener('orientationchange',()=>setTimeout(apply,80),{passive:true});root.addEventListener('revex:source-revision-loaded',()=>setTimeout(apply,0));document.querySelectorAll('.main-nav [data-view]').forEach(b=>b.addEventListener('click',()=>setTimeout(apply,0)));setTimeout(apply,350);diag('INFO','MOBILE_CONVERGENCE_R140','One final mobile presentation owner installed. No persistent floating controls; module rails and inspectors are in-flow and reachable.',{allModules:true,design:'in-flow selector+editor',bim:'in-flow navigator+properties',docs:'single flow',energy:'single flow',spec:'full iframe',chat:'full iframe',history:'single flow',wallt:'topbar dock'})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
