(function(root){
'use strict';
const BUILD='20260817r101-design-ux1';
if(root.__revexDesignUxR101)return;
root.__revexDesignUxR101={build:BUILD};
const small=()=>root.matchMedia?.('(max-width: 860px)')?.matches===true;
const $=s=>document.querySelector(s);
const byId=id=>document.getElementById(id);
const GUIDE_KEY='liber.revex.guide.r101';
let guideBound=false;

function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'design ux r101',...detail})}catch(_){}}

function injectCss(){
 if(byId('revex-r101-design-css'))return;
 const style=document.createElement('style');
 style.id='revex-r101-design-css';
 style.textContent=`
:root{--r101-soft:rgba(255,255,255,.055);--r101-soft2:rgba(255,255,255,.085);--r101-glow:rgba(77,163,255,.12)}
html,body{background:#090c11!important}
body.revex-app{font-feature-settings:'ss01' 1,'cv05' 1}
.app-shell{background:radial-gradient(1100px 620px at 82% -8%,rgba(73,151,255,.075),transparent 60%),#090c11}
.topbar{border-bottom:1px solid var(--line)!important;background:rgba(11,14,19,.94)!important;backdrop-filter:blur(18px);box-shadow:0 8px 28px rgba(0,0,0,.16)}
.main-nav{border-bottom:1px solid var(--line)!important;background:rgba(12,15,20,.9)!important;backdrop-filter:blur(16px)}
.main-nav .revex-tabs{gap:3px}
.main-nav .revex-tabs button{border-radius:8px!important;transition:background .14s ease,border-color .14s ease,color .14s ease,transform .14s ease}
.main-nav .revex-tabs button:hover{background:var(--r101-soft);color:var(--tx)}
.main-nav .revex-tabs button.active{background:linear-gradient(180deg,rgba(77,163,255,.15),rgba(77,163,255,.065))!important;border-color:rgba(95,174,255,.22)!important;color:#b8d9ff!important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.02)}
#workspace{background:linear-gradient(180deg,rgba(255,255,255,.008),transparent 180px)}
.rail,.chapter-rail,.inspector,.docs-tree-wrap{background:linear-gradient(180deg,rgba(255,255,255,.016),transparent 170px),var(--panel)!important}
.inspector{box-shadow:inset 1px 0 rgba(255,255,255,.025)}
.button,.tool,.tool-select,.tool-field,.sp-btn,.sp-icon-btn,input,select,textarea{transition:border-color .14s ease,background .14s ease,color .14s ease,box-shadow .14s ease,transform .14s ease}
.button:hover,.sp-btn:hover{transform:translateY(-1px)}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:none!important;box-shadow:0 0 0 2px rgba(85,170,255,.23)!important;border-color:rgba(98,180,255,.56)!important}
.empty-card,.design-card,.energy-card,.docs-group details,.issue-row,.fact,.render-card,.drawer-card{box-shadow:0 14px 44px rgba(0,0,0,.12)}
.design-card,.energy-card,.docs-group details,.issue-row,.fact{border-color:rgba(255,255,255,.075)!important}
.design-card:hover,.docs-group details:hover{border-color:rgba(123,189,255,.22)!important}
.section-head,.docs-toolbar,.energy-head,.chat-head,.history-head,.spec-head{background:linear-gradient(90deg,rgba(255,255,255,.018),transparent 72%)}
.eyebrow{letter-spacing:.14em!important;color:#7f8a99!important}
.viewer-message,.viewer-help,.viewport-tools.viewer-controls{box-shadow:0 12px 36px rgba(0,0,0,.28)}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:999px}::-webkit-scrollbar-track{background:transparent}
#revex-guide-button{min-width:32px!important;width:32px!important;padding:0!important;font-size:0!important;display:grid;place-items:center}
#revex-guide-button:after{content:'?';font:700 12px/1 var(--mono);font-size:12px!important}
#revex-guide-button:hover:after{color:#b8d9ff}
#revex-mobile-guide:not([hidden]){display:grid!important;position:fixed;z-index:170;inset:0;place-items:center;padding:max(18px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(18px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left));background:rgba(4,6,9,.58);backdrop-filter:blur(8px)}
#revex-mobile-guide .revex-mobile-guide-card{width:min(780px,calc(100vw - 36px));max-height:min(82dvh,720px);overflow:auto;border:1px solid rgba(255,255,255,.11);border-radius:20px;background:linear-gradient(180deg,#171c25,#0e1218 66%);box-shadow:0 34px 110px rgba(0,0,0,.7);padding:20px}
#revex-mobile-guide .revex-mobile-guide-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
#revex-mobile-guide .revex-mobile-guide-head h2{margin:3px 0 5px;font-size:24px;letter-spacing:-.025em}
#revex-mobile-guide .revex-mobile-guide-head p{max-width:620px;margin:0;color:var(--tx-2);font-size:13px;line-height:1.5}
#revex-mobile-guide .revex-mobile-guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
#revex-mobile-guide .revex-mobile-guide-item{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;align-items:start;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.025);padding:10px}
#revex-mobile-guide .revex-mobile-guide-icon{display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(89,166,255,.20);border-radius:9px;background:rgba(77,163,255,.09);color:#a8d2ff;font:16px var(--mono)}
#revex-mobile-guide .revex-mobile-guide-item strong{display:block;font-size:12px}
#revex-mobile-guide .revex-mobile-guide-item small{display:block;margin-top:2px;color:var(--tx-3);font-size:10.5px;line-height:1.4}
#revex-mobile-guide .revex-mobile-guide-walk{margin-top:9px;border:1px solid rgba(89,166,255,.17);border-radius:10px;background:rgba(77,163,255,.06);padding:10px;color:var(--tx-2);font-size:11px;line-height:1.45}
#revex-mobile-guide .revex-mobile-guide-walk b{color:var(--tx)}
#revex-mobile-guide .revex-mobile-guide-done{width:100%;margin-top:12px;min-height:42px;border:1px solid #6fb4ff;border-radius:10px;background:#82c1ff;color:#07111b;font-weight:760}
.revex-r101-guide-principle{margin:0 0 12px;border-left:2px solid rgba(111,180,255,.72);padding:7px 0 7px 10px;color:var(--tx-2);font-size:11.5px;line-height:1.45}
.revex-r101-guide-principle strong{color:var(--tx)}
@media(max-width:860px){
 .app-shell{background:radial-gradient(680px 420px at 82% -6%,rgba(73,151,255,.09),transparent 60%),#090c11}
 .topbar,.main-nav{box-shadow:none}
 .main-nav .revex-tabs button:hover{transform:none}
 #revex-guide-button{display:none!important}
 #revex-mobile-guide:not([hidden]){align-items:end;place-items:stretch;padding:10px max(8px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}
 #revex-mobile-guide .revex-mobile-guide-card{width:100%;max-width:none;max-height:min(84dvh,680px);border-radius:18px;padding:16px}
 #revex-mobile-guide .revex-mobile-guide-head h2{font-size:21px}
 #revex-mobile-guide .revex-mobile-guide-grid{grid-template-columns:1fr 1fr}
 .design-content,.docs-toolbar,.energy-head,.chat-head,.history-head,.spec-head{padding-left:12px!important;padding-right:12px!important}
}
@media(max-width:520px){#revex-mobile-guide .revex-mobile-guide-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.button:hover,.sp-btn:hover{transform:none}}
`;
 document.head.appendChild(style);
}

function guide(){return byId('revex-mobile-guide')}
function markGuideDone(){try{localStorage.setItem(GUIDE_KEY,'1')}catch(_){};try{localStorage.setItem('liber.revex.mobile-guide.r100','1')}catch(_){}}
function hideGuide(mark=true){const g=guide();if(!g)return;if(mark)markGuideDone();g.hidden=true;document.body.classList.remove('sp-locked')}
function showGuide(manual=false){const g=guide();if(!g)return false;decorateGuide();g.hidden=false;document.body.classList.add('sp-locked');if(manual)diag('INFO','GUIDE_OPEN','REVEX quick guide opened manually.',{smallScreen:small()});return true}

function decorateGuide(){
 const g=guide();if(!g)return;
 const title=g.querySelector('#revex-mobile-guide-title');if(title)title.textContent='One project. Seven coordinated views.';
 const intro=g.querySelector('.revex-mobile-guide-head p');if(intro)intro.textContent='REVEX is an engineering project system presented like a design app: the source stays authoritative while each module exposes the part you need to review.';
 let principle=g.querySelector('.revex-r101-guide-principle');
 if(!principle){principle=document.createElement('p');principle.className='revex-r101-guide-principle';g.querySelector('.revex-mobile-guide-grid')?.insertAdjacentElement('beforebegin',principle)}
 if(principle)principle.innerHTML='<strong>Use it visually; trust it structurally.</strong> BIM, books, documents, energy and history remain tied to the same project/revision rules. This layer changes presentation and navigation only.';
 const walk=g.querySelector('.revex-mobile-guide-walk');
 if(walk)walk.innerHTML=small()?'<b>Small-screen Walk:</b> upper half looks around; lower half moves forward/back and strafes. No mobile-device detection is used — only viewport width.':'<b>Walk:</b> use mouse/drag to look and keyboard movement in the BIM viewport. On narrow windows REVEX automatically switches to the split-touch control.';
 const done=g.querySelector('.revex-mobile-guide-done');if(done)done.textContent='Enter project';
}

function bindGuide(){
 const g=guide();if(!g||guideBound)return Boolean(g);guideBound=true;decorateGuide();
 g.querySelector('.revex-mobile-guide-close')?.addEventListener('click',()=>hideGuide(true));
 g.querySelector('.revex-mobile-guide-done')?.addEventListener('click',()=>hideGuide(true));
 g.addEventListener('click',event=>{if(event.target===g)hideGuide(true)});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!g.hidden){event.preventDefault();hideGuide(false)}},true);
 return true;
}

function ensureDesktopGuideButton(){
 const nav=$('.main-nav');if(!nav)return;
 let button=byId('revex-guide-button');if(button)return;
 button=document.createElement('button');button.id='revex-guide-button';button.type='button';button.className='utility sp-btn sp-btn-ghost sp-btn-sm';button.setAttribute('aria-label','REVEX quick guide');button.title='Quick guide';
 const render=byId('render-button');if(render?.parentElement===nav)render.insertAdjacentElement('afterend',button);else nav.appendChild(button);
 button.addEventListener('click',()=>showGuide(true));
}

function firstLaunch(){
 let done=false;try{done=localStorage.getItem(GUIDE_KEY)==='1'}catch(_){}
 if(done)return;
 setTimeout(()=>{if(document.hidden)return;if(!showGuide(false))setTimeout(()=>showGuide(false),500)},700);
}

function annotateTabs(){
 const hints={bim:'Model',design:'Selections',spec:'Specifications',docs:'Documents',energy:'Engineering',chat:'Coordination',history:'Revision history'};
 document.querySelectorAll('.main-nav [data-view]').forEach(button=>{const name=button.dataset.view;if(!button.title||button.title===button.textContent.trim())button.title=hints[name]||button.textContent.trim()});
}

function start(){
 injectCss();ensureDesktopGuideButton();annotateTabs();
 let tries=0;const wait=()=>{if(bindGuide()){firstLaunch();return}if(tries++<30)setTimeout(wait,60);else diag('WARN','GUIDE_BIND','Existing REVEX guide shell was not available.',{})};wait();
 root.matchMedia?.('(max-width: 860px)')?.addEventListener?.('change',()=>{decorateGuide();annotateTabs()});
 diag('INFO','DESIGN_UX_R101','Design-app presentation layer installed without changing REVEX engineering/data behavior.',{responsive:'viewport-width-only',guide:'all-screen-sizes'});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
console.log('[REVEX] design UX '+BUILD,{guide:'desktop+small-screen',smallScreen:'viewport-only',engineeringSemantics:'unchanged'});
})(window);
