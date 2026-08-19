(function(root){
'use strict';
const BUILD='20260819r139-mobile-design1';
if(root.__revexMobileDesignR139)return;
root.__revexMobileDesignR139={build:BUILD,presentationOnly:true,designSelector:'expandable',designProperties:'drawer',inlineIcons:true};

const byId=id=>document.getElementById(id);
const mobile=()=>document.body?.classList.contains('revex-mobile-touch')||root.matchMedia?.('(max-width:860px)')?.matches===true||(Number(navigator.maxTouchPoints||0)>0&&root.matchMedia?.('(max-width:1024px)')?.matches===true);
const TAB_ICONS={bim:'◇',design:'✦',spec:'≡',docs:'▤',energy:'ϟ',chat:'◌',history:'↺'};
const TOOL_ICONS={'fit-model':'⌖','detail-toggle':'▱','section-toggle':'⌗','walk-toggle':'↟'};
let observer=null;

function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'mobile design r139',...detail})}catch(_){}}
function css(){
 if(byId('revex-r139-mobile-design-css'))return;
 const s=document.createElement('style');s.id='revex-r139-mobile-design-css';s.textContent=`
body.revex-mobile-touch .main-nav .revex-tabs button:before,body.revex-mobile-touch .viewport-tools.viewer-controls .tool:before{content:none!important;display:none!important}
body.revex-mobile-touch .r139-mobile-icon{display:inline-grid!important;place-items:center!important;font-family:system-ui,-apple-system,"Segoe UI Symbol","Arial Unicode MS",sans-serif!important;font-size:16px!important;line-height:1!important;width:20px!important;height:20px!important;pointer-events:none!important}
body.revex-mobile-touch .viewport-tools.viewer-controls .r139-mobile-icon{font-size:14px!important;width:18px!important;height:18px!important}
body.revex-mobile-touch #view-design.design-view:not([hidden]){display:grid!important;grid-template-columns:1fr!important;grid-template-rows:auto minmax(0,1fr)!important;height:100%!important;min-height:0!important;overflow:hidden!important;position:relative!important}
body.revex-mobile-touch #view-design>.chapter-rail{grid-row:1!important;position:relative!important;width:100%!important;max-width:100%!important;min-width:0!important;min-height:46px!important;height:auto!important;max-height:46px!important;overflow:hidden!important;padding:0!important;border-right:0!important;border-bottom:1px solid var(--line)!important;background:rgba(10,13,18,.96)!important;backdrop-filter:blur(16px)!important;z-index:30!important;transition:max-height .16s ease!important}
body.revex-mobile-touch #view-design>.chapter-rail[data-r139-open="1"]{max-height:min(52dvh,440px)!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch!important}
body.revex-mobile-touch #view-design>.chapter-rail>.sp-rail-head{display:none!important}
body.revex-mobile-touch #r139-design-selector-toggle{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:center!important;gap:10px!important;width:100%!important;min-height:46px!important;padding:8px max(12px,var(--r133-safe-right,0px)) 8px max(12px,var(--r133-safe-left,0px))!important;border:0!important;border-radius:0!important;background:transparent!important;color:var(--tx)!important;text-align:left!important;font:inherit!important;cursor:pointer!important}
body.revex-mobile-touch #r139-design-selector-toggle strong{display:block!important;min-width:0!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;font-size:12px!important}
body.revex-mobile-touch #r139-design-selector-toggle small{display:block!important;color:var(--tx-3)!important;font-size:8px!important;letter-spacing:.08em!important;text-transform:uppercase!important;margin-bottom:2px!important}
body.revex-mobile-touch #r139-design-selector-toggle b{font-size:16px!important;font-weight:400!important;transition:transform .16s ease!important}
body.revex-mobile-touch #view-design>.chapter-rail[data-r139-open="1"] #r139-design-selector-toggle b{transform:rotate(180deg)!important}
body.revex-mobile-touch #view-design #chapter-list{display:none!important;padding:4px max(8px,var(--r133-safe-right,0px)) max(12px,var(--r133-safe-bottom,0px)) max(8px,var(--r133-safe-left,0px))!important}
body.revex-mobile-touch #view-design>.chapter-rail[data-r139-open="1"] #chapter-list{display:grid!important}
body.revex-mobile-touch #view-design>.design-content{grid-row:2!important;height:100%!important;min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important;-webkit-overflow-scrolling:touch!important;overscroll-behavior-y:contain!important;touch-action:pan-y!important;padding:12px max(12px,var(--r133-safe-right,0px)) max(74px,var(--r133-safe-bottom,0px)) max(12px,var(--r133-safe-left,0px))!important}
body.revex-mobile-touch #view-design>.design-content .design-lanes{grid-template-columns:1fr!important;max-width:100%!important}
body.revex-mobile-touch #view-design>.design-content .design-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;max-width:100%!important}
body.revex-mobile-touch #design-inspector{display:none!important;position:fixed!important;z-index:70!important;left:max(8px,var(--r133-safe-left,0px))!important;right:max(8px,var(--r133-safe-right,0px))!important;bottom:max(8px,var(--r133-safe-bottom,0px))!important;width:auto!important;max-width:none!important;max-height:min(62dvh,560px)!important;overflow:auto!important;-webkit-overflow-scrolling:touch!important;border:1px solid var(--line-2)!important;border-radius:14px!important;background:rgba(13,17,23,.98)!important;box-shadow:0 22px 70px rgba(0,0,0,.58)!important;padding:14px!important}
body.revex-mobile-touch #design-inspector[data-r139-open="1"]{display:block!important}
body.revex-mobile-touch #r139-design-properties-toggle{display:none;position:fixed!important;z-index:71!important;right:max(10px,var(--r133-safe-right,0px))!important;bottom:max(10px,var(--r133-safe-bottom,0px))!important;min-height:36px!important;padding:0 12px!important;border:1px solid var(--line-2)!important;border-radius:10px!important;background:rgba(15,20,27,.94)!important;color:var(--tx)!important;font:10px/1 system-ui,sans-serif!important;box-shadow:0 10px 30px rgba(0,0,0,.36)!important}
body.revex-mobile-touch #view-design:not([hidden])~#r139-design-properties-toggle,body.revex-mobile-touch #r139-design-properties-toggle[data-r139-visible="1"]{display:block!important}
body.revex-mobile-touch #design-inspector[data-r139-open="1"]+#r139-design-properties-toggle{background:var(--acc-2,#8fc5ff)!important;color:#07111b!important}
@media(max-width:390px){body.revex-mobile-touch #view-design>.design-content .design-grid{grid-template-columns:1fr!important}}
`;
 document.head.appendChild(s);
}

function iconSpan(icon){const span=document.createElement('span');span.className='r139-mobile-icon';span.setAttribute('aria-hidden','true');span.textContent=icon;return span}
function inlineIcons(){
 for(const button of document.querySelectorAll('.main-nav [data-view]')){
  if(!button.querySelector('.r139-mobile-icon'))button.prepend(iconSpan(TAB_ICONS[button.dataset.view]||'·'));
 }
 for(const [id,icon] of Object.entries(TOOL_ICONS)){
  const button=byId(id);if(button&&!button.querySelector('.r139-mobile-icon'))button.prepend(iconSpan(icon));
 }
}
function selectorLabel(){const title=String(byId('chapter-title')?.textContent||'Design Book').trim()||'Design Book';const label=byId('r139-design-selector-label');if(label)label.textContent=title}
function closeSelector(){const rail=document.querySelector('#view-design>.chapter-rail');if(rail){rail.dataset.r139Open='0';byId('r139-design-selector-toggle')?.setAttribute('aria-expanded','false')}}
function ensureDesignSelector(){
 const rail=document.querySelector('#view-design>.chapter-rail'),list=byId('chapter-list');if(!rail||!list)return;
 let button=byId('r139-design-selector-toggle');
 if(!button){button=document.createElement('button');button.id='r139-design-selector-toggle';button.type='button';button.setAttribute('aria-expanded','false');button.innerHTML='<span><small>Design selector</small><strong id="r139-design-selector-label">Design Book</strong></span><b aria-hidden="true">⌄</b>';rail.insertBefore(button,list);button.addEventListener('click',()=>{const open=rail.dataset.r139Open==='1';rail.dataset.r139Open=open?'0':'1';button.setAttribute('aria-expanded',String(!open))})}
 if(!list.dataset.r139Bound){list.dataset.r139Bound='1';list.addEventListener('click',event=>{if(event.target.closest?.('button,[role="button"],a,.chapter-item'))setTimeout(()=>{selectorLabel();closeSelector()},0)})}
 selectorLabel();
}
function ensurePropertiesDrawer(){
 const inspector=byId('design-inspector'),view=byId('view-design');if(!inspector||!view)return;
 let toggle=byId('r139-design-properties-toggle');
 if(!toggle){toggle=document.createElement('button');toggle.id='r139-design-properties-toggle';toggle.type='button';toggle.textContent='Properties';document.body.appendChild(toggle);toggle.addEventListener('click',()=>{const open=inspector.dataset.r139Open==='1';inspector.dataset.r139Open=open?'0':'1';toggle.textContent=open?'Properties':'Close';toggle.setAttribute('aria-expanded',String(!open))})}
 const sync=()=>{const visible=mobile()&&!view.hidden;toggle.dataset.r139Visible=visible?'1':'0';if(!visible){inspector.dataset.r139Open='0';toggle.textContent='Properties';toggle.setAttribute('aria-expanded','false')}};
 sync();document.querySelectorAll('.main-nav [data-view]').forEach(b=>{if(!b.dataset.r139DesignBound){b.dataset.r139DesignBound='1';b.addEventListener('click',()=>setTimeout(sync,0))}});root.addEventListener('resize',sync,{passive:true});
}
function watchTitle(){const title=byId('chapter-title');if(!title||observer)return;observer=new MutationObserver(selectorLabel);observer.observe(title,{childList:true,subtree:true,characterData:true})}
function install(){css();inlineIcons();ensureDesignSelector();ensurePropertiesDrawer();watchTitle();root.addEventListener('resize',()=>{inlineIcons();ensureDesignSelector()},{passive:true});root.addEventListener('revex:source-revision-loaded',()=>setTimeout(()=>{inlineIcons();ensureDesignSelector();selectorLabel()},0));diag('INFO','MOBILE_DESIGN_R139','Mobile Design restored to selector + scroll body + properties drawer; icons are inline and font-independent.',{selector:'expandable',designScrollOwner:'design-content',properties:'drawer',inlineIcons:true})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
