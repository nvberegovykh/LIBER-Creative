(function(root){
'use strict';
const BUILD='20260817r109-presentation1';
if(root.__revexUiPolishR109)return;
root.__revexUiPolishR109={build:BUILD,presentationOnly:true};
const byId=id=>document.getElementById(id);
const small=()=>root.matchMedia?.('(max-width:860px)')?.matches===true;
const ICON={bim:'◇',design:'✦',spec:'≡',docs:'▤',energy:'ϟ',chat:'◌',history:'↺'};
const LABEL={bim:'BIM',design:'Design Book',spec:'Spec Book',docs:'Docs',energy:'Energy',chat:'Chat',history:'History'};
const GUIDE_KEY='liber.revex.ui-guide.r109';

function injectCss(){
 if(byId('revex-r109-ui'))return;
 const style=document.createElement('style');style.id='revex-r109-ui';style.textContent=`
:root{--r109-line:rgba(255,255,255,.08);--r109-soft:rgba(255,255,255,.045);--r109-blue:rgba(83,163,255,.16)}
html,body{max-width:100%;overflow-x:hidden}
body.revex-app{background:#090c11}
.app-shell,.topbar,.main-nav,#workspace{box-sizing:border-box;min-width:0;max-width:100%}
.topbar,.main-nav{width:100%;overflow:hidden}
.topbar{gap:7px;border-bottom:1px solid var(--r109-line);background:rgba(10,13,18,.96)}
.main-nav{gap:6px;border-bottom:1px solid var(--r109-line);background:rgba(10,13,18,.94)}
.main-nav .revex-tabs{min-width:0;max-width:100%}
.main-nav [data-view]{border-radius:8px;min-width:0}
.main-nav [data-view].active{background:var(--r109-blue);border-color:rgba(100,180,255,.24);color:#b9dcff}
.rail,.chapter-rail,.inspector,.docs-tree-wrap{border-color:var(--r109-line)}
.empty-card,.design-card,.energy-card,.issue-row,.fact,.docs-group details{border-color:var(--r109-line);box-shadow:0 16px 44px rgba(0,0,0,.13)}
.button,.tool,.tool-select,.tool-field,input,select,textarea{border-radius:8px}
#revex-r109-help{min-width:32px;width:32px;padding:0;font-size:0}
#revex-r109-help:after{content:'?';font:700 12px/1 var(--mono)}
#revex-r109-guide[hidden]{display:none!important}
#revex-r109-guide{position:fixed;z-index:9999;inset:0;display:grid;place-items:center;padding:18px;background:rgba(3,5,8,.62)}
#revex-r109-guide-card{width:min(680px,calc(100vw - 36px));max-height:min(80dvh,680px);overflow:auto;border:1px solid rgba(255,255,255,.12);border-radius:18px;background:#11161e;box-shadow:0 30px 100px rgba(0,0,0,.65);padding:18px}
#revex-r109-guide-card header{display:flex;align-items:start;justify-content:space-between;gap:14px;margin-bottom:12px}
#revex-r109-guide-card h2{margin:0 0 5px;font-size:21px}
#revex-r109-guide-card p{margin:0;color:var(--tx-2);font-size:12px;line-height:1.5}
#revex-r109-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.revex-r109-guide-item{border:1px solid var(--r109-line);border-radius:10px;background:var(--r109-soft);padding:10px}
.revex-r109-guide-item b{display:block;margin-bottom:3px;font-size:11px}.revex-r109-guide-item small{color:var(--tx-3);font-size:10px;line-height:1.4}
#revex-r109-guide-close,#revex-r109-guide-done{border:1px solid var(--r109-line);border-radius:9px;background:var(--panel-2);color:var(--tx)}
#revex-r109-guide-close{width:32px;height:32px}#revex-r109-guide-done{width:100%;min-height:40px;margin-top:11px}
@media(max-width:860px){
 html,body,.app-shell{width:100%;max-width:100vw}
 .topbar{padding-left:max(6px,env(safe-area-inset-left));padding-right:max(6px,env(safe-area-inset-right));flex-wrap:nowrap}
 .topbar .brand{flex:0 0 54px;max-width:54px;overflow:hidden}.topbar .brand .sp-crumb{display:none}
 .topbar .project-picker{flex:1 1 0;min-width:0;max-width:none;overflow:hidden}.topbar .project-picker>span{display:none}.topbar .project-picker select{width:100%;min-width:0;max-width:100%;text-overflow:ellipsis}
 .topbar #new-project-button{flex:0 0 34px;width:34px;min-width:34px;padding:0;font-size:0}.topbar #new-project-button:after{content:'+';font-size:19px}
 .topbar .sync-indicator,.topbar #sync-button,.topbar .project-id-badge{display:none!important}
 .main-nav{display:block;padding:5px 6px;overflow:hidden}
 .main-nav .revex-tabs{display:grid!important;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;width:100%;overflow:hidden}
 .main-nav [data-view]{height:34px;min-height:34px;width:100%;padding:0!important;display:grid;place-items:center;font-size:0!important;overflow:hidden}
 .main-nav [data-view]:before{content:attr(data-r109-icon);font:15px/1 var(--mono)}
 .main-nav .nav-spacer,.main-nav .utility{display:none!important}
 .viewport-tools.viewer-controls{left:7px!important;right:7px!important;max-width:calc(100% - 14px)!important;width:auto!important;overflow:auto!important;overscroll-behavior-x:contain}
 .viewport-tools.viewer-controls .tool,.viewport-tools.viewer-controls .tool-select,.viewport-tools.viewer-controls .tool-field{flex:0 0 auto}
 .rail,.chapter-rail,.inspector,.docs-tree-wrap{min-width:0;max-width:100%}
 .design-content,.docs-toolbar,.energy-head,.chat-head,.history-head,.spec-head{padding-left:10px!important;padding-right:10px!important}
 #revex-r109-guide{align-items:end;padding:10px max(8px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}
 #revex-r109-guide-card{width:100%;max-width:none;border-radius:17px}#revex-r109-guide-grid{grid-template-columns:1fr 1fr}
}
@media(max-width:500px){#revex-r109-guide-grid{grid-template-columns:1fr}}
`;
 document.head.appendChild(style);
}

function annotateTabs(){
 document.querySelectorAll('.main-nav [data-view]').forEach(button=>{
  const view=button.dataset.view||'';button.dataset.r109Icon=ICON[view]||'·';
  const label=LABEL[view]||button.textContent.trim();button.setAttribute('aria-label',label);button.title=label;
 });
}
function ensureHelp(){
 const nav=document.querySelector('.main-nav');if(!nav||byId('revex-r109-help'))return;
 const button=document.createElement('button');button.id='revex-r109-help';button.type='button';button.className='utility button ghost compact';button.setAttribute('aria-label','REVEX quick guide');button.title='Quick guide';button.addEventListener('click',()=>showGuide(false));
 const render=byId('render-button');if(render?.parentElement===nav)render.insertAdjacentElement('afterend',button);else nav.appendChild(button);
}
function ensureGuide(){
 if(byId('revex-r109-guide'))return;
 const wrap=document.createElement('div');wrap.id='revex-r109-guide';wrap.hidden=true;wrap.innerHTML=`<section id="revex-r109-guide-card" role="dialog" aria-modal="true" aria-labelledby="revex-r109-guide-title"><header><div><h2 id="revex-r109-guide-title">REVEX Companion</h2><p>One project, coordinated BIM, Design Book, Spec Book, Docs, Energy, Chat and History.</p></div><button id="revex-r109-guide-close" type="button" aria-label="Close">×</button></header><div id="revex-r109-guide-grid"><div class="revex-r109-guide-item"><b>BIM</b><small>Inspect the current synced model. Model review does not detach from Revit.</small></div><div class="revex-r109-guide-item"><b>Design Book</b><small>Review and develop project selections attached to their source positions.</small></div><div class="revex-r109-guide-item"><b>Spec Book</b><small>Read Revit-derived schedules with authored specification data.</small></div><div class="revex-r109-guide-item"><b>Docs</b><small>Open coordinated project documents and printing sets.</small></div><div class="revex-r109-guide-item"><b>Energy</b><small>Review the managed Engineering run and filing outputs.</small></div><div class="revex-r109-guide-item"><b>History</b><small>See revision and review history without replacing source evidence.</small></div></div><button id="revex-r109-guide-done" type="button">Got it</button></section>`;
 document.body.appendChild(wrap);byId('revex-r109-guide-close').onclick=()=>hideGuide(true);byId('revex-r109-guide-done').onclick=()=>hideGuide(true);wrap.addEventListener('click',e=>{if(e.target===wrap)hideGuide(true)});
}
function showGuide(mark){const g=byId('revex-r109-guide');if(!g)return;g.hidden=false;if(mark)try{localStorage.setItem(GUIDE_KEY,'1')}catch(_){} }
function hideGuide(mark){const g=byId('revex-r109-guide');if(g)g.hidden=true;if(mark)try{localStorage.setItem(GUIDE_KEY,'1')}catch(_){} }
function maybeFirstGuide(){let done=true;try{done=localStorage.getItem(GUIDE_KEY)==='1'}catch(_){}if(done)return;setTimeout(()=>{if(!document.hidden)showGuide(false)},700)}
function start(){injectCss();annotateTabs();ensureHelp();ensureGuide();maybeFirstGuide();try{root.__revexBrowserDiagnostics?.emit?.('INFO','UI_POLISH_R109','Presentation-only REVEX UI layer installed.',{initiator:'ui polish r109',mobile:small(),logicHooks:false})}catch(_){} }
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})(window);
