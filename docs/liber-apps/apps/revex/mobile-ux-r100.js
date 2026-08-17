(function(root){
'use strict';
const BUILD='20260817r100-mobile-ux1';
if(root.__revexMobileUxR100)return;
root.__revexMobileUxR100={build:BUILD};
const Store=root.RevexStore;
const S=()=>root.__revexState||null;
const mobile=()=>root.matchMedia?.('(max-width: 860px)')?.matches===true;
const v=()=>root.__revexViewerR26Instance||null;
const text=value=>String(value??'').trim();
const byId=id=>document.getElementById(id);
const ICONS={bim:'◇',design:'✦',spec:'≡',docs:'▤',energy:'ϟ',chat:'◌',history:'↺'};
const LABELS={bim:'BIM',design:'Design Book',spec:'Spec Book',docs:'Docs',energy:'Energy',chat:'Chat',history:'History'};
const HELP=[
 ['bim','BIM','Inspect, walk, section and review the current synced model.'],
 ['design','Design Book','Choose finishes and design positions without detaching from Revit.'],
 ['spec','Spec Book','Read Revit schedules together with authored specification data.'],
 ['docs','Docs','Open each printing set as one linked group: full set plus individual sheets.'],
 ['energy','Energy','Review the managed engineering evidence and filing outputs.'],
 ['chat','Chat','Keep project conversation attached to the same REVEX project.'],
 ['history','History','See append-only source revisions, edits, issues and exports.']
];
let walkMovePointer=null,walkLookPointer=null,walkOrigin=null,walkLookLast=null,touchKeys=new Set(),docsNormalizing=false;

function diag(level,stage,message,detail={}){try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'mobile ux r100',...detail})}catch(_){}}

function injectCss(){
 if(byId('revex-r100-mobile-css'))return;
 const style=document.createElement('style');
 style.id='revex-r100-mobile-css';
 style.textContent=`
.view[hidden],.empty-view[hidden]{display:none!important}
#revex-mobile-actions,#revex-mobile-actions-menu,#revex-mobile-guide,.revex-walk-touch{display:none}
@media(max-width:860px){
 html,body{width:100%;max-width:100vw;overscroll-behavior:none}
 .app-shell,.topbar,.main-nav,#workspace{width:100%;max-width:100vw;min-width:0}
 .topbar{overflow:visible!important;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(9,12,17,.96)!important;backdrop-filter:blur(18px)}
 .topbar #rail-toggle{flex:0 0 34px!important;width:34px!important;min-width:34px!important}
 .topbar .brand{flex:0 0 auto!important;max-width:58px!important;overflow:hidden!important}
 .topbar .brand strong{font-size:12px!important;letter-spacing:.08em}
 .topbar .project-picker{flex:1 1 0!important;min-width:0!important;width:auto!important;overflow:hidden}
 .topbar .project-picker select{width:100%!important;min-width:0!important;max-width:100%!important;text-overflow:ellipsis}
 #revex-mobile-actions{display:inline-grid;place-items:center;flex:0 0 34px;width:34px;height:34px;border:1px solid var(--line-2);border-radius:9px;background:var(--panel-2);color:var(--tx);font:18px/1 var(--mono);padding:0}
 #revex-mobile-actions-menu{position:fixed;z-index:120;top:calc(max(8px,env(safe-area-inset-top)) + 44px);right:max(8px,env(safe-area-inset-right));display:grid;min-width:184px;padding:6px;border:1px solid var(--line-2);border-radius:12px;background:rgba(13,16,22,.98);box-shadow:0 18px 58px rgba(0,0,0,.58);backdrop-filter:blur(18px)}
 #revex-mobile-actions-menu[hidden]{display:none!important}
 #revex-mobile-actions-menu button{min-height:40px;border:0;border-radius:8px;background:transparent;color:var(--tx-2);padding:0 10px;text-align:left;font:11px var(--mono)}
 #revex-mobile-actions-menu button:hover,#revex-mobile-actions-menu button:focus-visible{background:var(--panel-2);color:var(--tx);outline:0}
 .main-nav{display:block!important;overflow:hidden!important;min-height:44px!important;padding:5px 6px!important;background:rgba(11,14,19,.96)!important;border-bottom:1px solid rgba(255,255,255,.07);backdrop-filter:blur(18px)}
 .main-nav .revex-tabs{display:grid!important;grid-template-columns:repeat(7,minmax(0,1fr))!important;gap:3px!important;width:100%!important;max-width:100%!important;min-width:0!important;overflow:hidden!important}
 .main-nav .revex-tabs button{position:relative;display:grid!important;place-items:center!important;min-width:0!important;width:100%!important;height:34px!important;min-height:34px!important;padding:0!important;border:1px solid transparent!important;border-radius:9px!important;background:transparent!important;color:var(--tx-3)!important;font-size:0!important;line-height:1!important;touch-action:manipulation}
 .main-nav .revex-tabs button:before{content:attr(data-revex-icon);font:16px/1 var(--mono);letter-spacing:0}
 .main-nav .revex-tabs button.active{border-color:rgba(89,166,255,.28)!important;background:linear-gradient(180deg,rgba(82,164,255,.18),rgba(82,164,255,.08))!important;color:#a8d2ff!important;box-shadow:inset 0 0 0 1px rgba(89,166,255,.07),0 4px 18px rgba(0,0,0,.18)}
 .main-nav .utility,.main-nav .nav-spacer{display:none!important}
 .viewport-tools.viewer-controls{z-index:26!important;left:7px!important;right:7px!important;top:7px!important;display:grid!important;grid-template-columns:repeat(4,32px) minmax(58px,1fr) 42px 62px!important;gap:4px!important;width:auto!important;max-width:none!important;overflow:hidden!important;padding:4px!important;border:1px solid rgba(255,255,255,.09)!important;border-radius:11px!important;background:rgba(11,14,19,.82)!important;box-shadow:0 10px 32px rgba(0,0,0,.30)!important;backdrop-filter:blur(14px)}
 .viewport-tools .tool{width:32px!important;min-width:32px!important;height:30px!important;min-height:30px!important;padding:0!important;display:grid;place-items:center;font-size:0!important;background:transparent!important}
 .viewport-tools .tool:before{content:attr(data-revex-icon);font:14px/1 var(--mono)}
 .viewport-tools .tool-select{width:100%!important;max-width:none!important;min-width:0!important;padding:0 5px!important;font-size:9px!important}
 .viewport-tools .tool-field{min-width:0!important;width:100%!important;justify-content:center!important;padding:0 3px!important;overflow:hidden!important}
 .viewport-tools .tool-field span,.viewport-tools .tool-field b{display:none!important}
 .viewport-tools .tool-field input[type=number]{width:34px!important;text-align:center!important;padding:0!important}
 .viewport-tools .tool-field input[type=range]{width:52px!important;min-width:0!important}
 .viewer-message{max-width:calc(100% - 28px)!important}
 .viewer-help{display:none!important}
 .revex-walk-touch{position:absolute;z-index:20;inset:45px 0 0;display:block;pointer-events:none;touch-action:none}
 .revex-walk-touch[hidden]{display:none!important}
 .revex-walk-look,.revex-walk-move{position:absolute;left:0;right:0;pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none}
 .revex-walk-look{top:0;height:48%;background:linear-gradient(180deg,rgba(77,163,255,.035),transparent 52%)}
 .revex-walk-look:after{content:'LOOK';position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:3px 7px;border:1px solid rgba(255,255,255,.09);border-radius:999px;background:rgba(9,12,17,.34);color:rgba(255,255,255,.38);font:8px var(--mono);letter-spacing:.16em;pointer-events:none}
 .revex-walk-move{bottom:0;height:52%;background:linear-gradient(0deg,rgba(8,11,16,.34),transparent 76%)}
 .revex-walk-pad{position:absolute;left:50%;top:54%;width:112px;height:112px;transform:translate(-50%,-50%);border:1px solid rgba(255,255,255,.12);border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.035) 0 42%,rgba(255,255,255,.018) 44% 69%,transparent 70%);box-shadow:inset 0 0 36px rgba(0,0,0,.18);pointer-events:none}
 .revex-walk-pad:before,.revex-walk-pad:after{content:'';position:absolute;background:rgba(255,255,255,.08)}
 .revex-walk-pad:before{left:50%;top:12px;bottom:12px;width:1px}.revex-walk-pad:after{top:50%;left:12px;right:12px;height:1px}
 .revex-walk-knob{position:absolute;left:50%;top:54%;width:44px;height:44px;transform:translate(-50%,-50%);border:1px solid rgba(132,196,255,.38);border-radius:50%;background:rgba(77,163,255,.16);box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:none;transition:opacity .12s ease}
 .revex-walk-move:not(.active) .revex-walk-knob{opacity:.48}
 .revex-walk-caption{position:absolute;bottom:max(9px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);color:rgba(255,255,255,.42);font:8px var(--mono);letter-spacing:.12em;white-space:nowrap;pointer-events:none}
 #revex-mobile-guide{position:fixed;z-index:160;inset:0;display:grid;align-items:end;padding:12px max(10px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));background:rgba(4,6,9,.52);backdrop-filter:blur(6px)}
 #revex-mobile-guide[hidden]{display:none!important}
 .revex-mobile-guide-card{max-height:min(78dvh,650px);overflow:auto;border:1px solid var(--line-2);border-radius:18px;background:linear-gradient(180deg,#151a22,#0e1218);box-shadow:0 28px 90px rgba(0,0,0,.66);padding:17px}
 .revex-mobile-guide-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.revex-mobile-guide-head h2{margin:3px 0 4px;font-size:20px}.revex-mobile-guide-head p{margin:0;color:var(--tx-2);font-size:12px}.revex-mobile-guide-close{width:34px;height:34px;flex:0 0 34px;border:1px solid var(--line-2);border-radius:9px;background:transparent;color:var(--tx);font-size:18px}
 .revex-mobile-guide-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.revex-mobile-guide-item{display:grid;grid-template-columns:30px minmax(0,1fr);gap:8px;align-items:start;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.025);padding:9px}.revex-mobile-guide-icon{display:grid;place-items:center;width:30px;height:30px;border:1px solid rgba(89,166,255,.20);border-radius:8px;background:rgba(77,163,255,.09);color:#a8d2ff;font:15px var(--mono)}.revex-mobile-guide-item strong{display:block;font-size:11px}.revex-mobile-guide-item small{display:block;margin-top:2px;color:var(--tx-3);font-size:9.5px;line-height:1.35}
 .revex-mobile-guide-walk{margin-top:9px;border:1px solid rgba(89,166,255,.17);border-radius:10px;background:rgba(77,163,255,.06);padding:10px;color:var(--tx-2);font-size:10.5px}.revex-mobile-guide-walk b{color:var(--tx)}
 .revex-mobile-guide-done{width:100%;margin-top:11px;min-height:40px;border:1px solid var(--acc-2);border-radius:10px;background:var(--acc-2);color:#07111b;font-weight:750}
 .docs-group.printing-set{border-top-color:rgba(89,166,255,.18)}.docs-group.printing-set>h3{color:var(--tx)}.docs-node.whole{font-weight:650}.docs-node.sheet b{min-width:44px}.docs-node.sheet small{opacity:.74}
}
@media(max-width:390px){
 .topbar .brand{max-width:42px!important}.topbar .brand strong{font-size:10px!important}
 .viewport-tools.viewer-controls{grid-template-columns:repeat(4,30px) minmax(52px,1fr) 38px 54px!important;gap:3px!important}
 .viewport-tools .tool{width:30px!important;min-width:30px!important}.revex-mobile-guide-grid{grid-template-columns:1fr}
}
`;
 document.head.appendChild(style);
}

function installIcons(){
 for(const button of document.querySelectorAll('.main-nav [data-view]')){
   const name=button.dataset.view;
   button.dataset.revexIcon=ICONS[name]||'·';
   const label=LABELS[name]||button.textContent.trim();
   button.setAttribute('aria-label',label);
   button.title=label;
 }
 const controls={
   'fit-model':['⌖','Fit model'],
   'detail-toggle':['▱','Model detail'],
   'section-toggle':['⌗','Section box'],
   'walk-toggle':['↟','Walk']
 };
 for(const [id,[icon,label]] of Object.entries(controls)){
   const button=byId(id);if(!button)continue;button.dataset.revexIcon=icon;button.setAttribute('aria-label',label);button.title=label;
 }
}

function ensureActions(){
 const top=document.querySelector('.topbar');if(!top)return;
 let trigger=byId('revex-mobile-actions');
 if(!trigger){
   trigger=document.createElement('button');trigger.id='revex-mobile-actions';trigger.type='button';trigger.setAttribute('aria-label','More REVEX actions');trigger.setAttribute('aria-expanded','false');trigger.textContent='⋯';
   const newButton=byId('new-project-button');(newButton?.parentElement===top?newButton:top.lastElementChild)?.insertAdjacentElement?.('afterend',trigger);if(!trigger.isConnected)top.appendChild(trigger);
   trigger.addEventListener('click',event=>{event.stopPropagation();toggleActions()});
 }
 let menu=byId('revex-mobile-actions-menu');
 if(!menu){
   menu=document.createElement('div');menu.id='revex-mobile-actions-menu';menu.hidden=true;menu.innerHTML='<button type="button" data-r100-action="invite">Invite to project</button><button type="button" data-r100-action="render">Open Render</button><button type="button" data-r100-action="sync">Import sync package</button><button type="button" data-r100-action="help">Quick guide</button>';
   document.body.appendChild(menu);
   menu.addEventListener('click',event=>{const button=event.target.closest('button[data-r100-action]');if(!button)return;runAction(button.dataset.r100Action)});
   document.addEventListener('click',event=>{if(menu.hidden||event.target.closest('#revex-mobile-actions,#revex-mobile-actions-menu'))return;toggleActions(false)},true);
 }
}
function toggleActions(force){const menu=byId('revex-mobile-actions-menu'),trigger=byId('revex-mobile-actions');if(!menu||!trigger)return;const open=typeof force==='boolean'?force:menu.hidden;menu.hidden=!open;trigger.setAttribute('aria-expanded',String(open))}
function runAction(action){toggleActions(false);if(action==='invite')byId('invite-project-button')?.click();else if(action==='render')byId('render-button')?.click();else if(action==='sync')byId('revex-sync-upload')?.click();else if(action==='help')showGuide(true)}

function ensureGuide(){
 let guide=byId('revex-mobile-guide');if(guide)return guide;
 guide=document.createElement('div');guide.id='revex-mobile-guide';guide.hidden=true;guide.setAttribute('role','dialog');guide.setAttribute('aria-modal','true');guide.setAttribute('aria-labelledby','revex-mobile-guide-title');
 guide.innerHTML=`<section class="revex-mobile-guide-card"><header class="revex-mobile-guide-head"><div><div class="eyebrow">REVEX COMPANION</div><h2 id="revex-mobile-guide-title">One project. Seven linked views.</h2><p>The model stays the source; these views are different ways to review the same project.</p></div><button class="revex-mobile-guide-close" type="button" aria-label="Close quick guide">×</button></header><div class="revex-mobile-guide-grid">${HELP.map(([id,label,copy])=>`<div class="revex-mobile-guide-item"><span class="revex-mobile-guide-icon">${ICONS[id]}</span><span><strong>${label}</strong><small>${copy}</small></span></div>`).join('')}</div><div class="revex-mobile-guide-walk"><b>Mobile Walk:</b> use the upper half of the viewport to look around. Drag in the lower half to move forward/back and strafe.</div><button class="revex-mobile-guide-done" type="button">Got it</button></section>`;
 document.body.appendChild(guide);
 const close=()=>hideGuide(true);guide.querySelector('.revex-mobile-guide-close').addEventListener('click',close);guide.querySelector('.revex-mobile-guide-done').addEventListener('click',close);guide.addEventListener('click',event=>{if(event.target===guide)close()});return guide;
}
function showGuide(manual=false){const guide=ensureGuide();guide.hidden=false;document.body.classList.add('sp-locked');if(manual)toggleActions(false)}
function hideGuide(mark=false){const guide=ensureGuide();guide.hidden=true;document.body.classList.remove('sp-locked');if(mark)try{localStorage.setItem('liber.revex.mobile-guide.r100','1')}catch(_){}}
function maybeGuide(){if(!mobile())return;let done=false;try{done=localStorage.getItem('liber.revex.mobile-guide.r100')==='1'}catch(_){}if(!done)setTimeout(()=>{if(mobile()&&!document.hidden)showGuide(false)},900)}

function ensureWalkTouch(){
 const wrap=document.querySelector('#view-bim .viewport-wrap');if(!wrap)return null;
 let overlay=byId('revex-walk-touch');if(overlay)return overlay;
 overlay=document.createElement('div');overlay.id='revex-walk-touch';overlay.className='revex-walk-touch';overlay.hidden=true;overlay.innerHTML='<div class="revex-walk-look" aria-label="Drag to look around"></div><div class="revex-walk-move" aria-label="Drag to walk"><div class="revex-walk-pad"></div><div class="revex-walk-knob"></div><div class="revex-walk-caption">DRAG TO MOVE · RELEASE TO STOP</div></div>';
 wrap.appendChild(overlay);
 const look=overlay.querySelector('.revex-walk-look'),move=overlay.querySelector('.revex-walk-move');
 look.addEventListener('pointerdown',onLookDown);look.addEventListener('pointermove',onLookMove);look.addEventListener('pointerup',onLookUp);look.addEventListener('pointercancel',onLookUp);
 move.addEventListener('pointerdown',onMoveDown);move.addEventListener('pointermove',onMoveMove);move.addEventListener('pointerup',onMoveUp);move.addEventListener('pointercancel',onMoveUp);
 return overlay;
}
function syncWalkTouch(){const viewer=v(),overlay=ensureWalkTouch();if(!overlay)return;const on=mobile()&&Boolean(viewer?.walk)&&!byId('view-bim')?.hidden;overlay.hidden=!on;if(!on)clearTouchMove();}
function onLookDown(event){const viewer=v();if(!viewer?.walk)return;walkLookPointer=event.pointerId;walkLookLast=[event.clientX,event.clientY];event.currentTarget.setPointerCapture?.(event.pointerId);event.preventDefault();event.stopPropagation()}
function onLookMove(event){const viewer=v();if(!viewer?.walk||event.pointerId!==walkLookPointer||!walkLookLast)return;const dx=event.clientX-walkLookLast[0],dy=event.clientY-walkLookLast[1];walkLookLast=[event.clientX,event.clientY];viewer.yaw-=dx*.0042;viewer.pitch=Math.max(-1.35,Math.min(1.35,viewer.pitch-dy*.0034));viewer.look?.();viewer.requestRender?.();event.preventDefault();event.stopPropagation()}
function onLookUp(event){if(event.pointerId!==walkLookPointer)return;walkLookPointer=null;walkLookLast=null;event.preventDefault();event.stopPropagation()}
function setTouchKeys(next){const viewer=v();if(!viewer?.keys)return;for(const key of touchKeys)viewer.keys.delete(key);touchKeys=new Set(next);for(const key of touchKeys)viewer.keys.add(key);if(touchKeys.size)viewer.startWalkFrames?.()}
function updateKnob(dx,dy){const move=byId('revex-walk-touch')?.querySelector('.revex-walk-move'),knob=move?.querySelector('.revex-walk-knob');if(!move||!knob)return;const max=42,len=Math.hypot(dx,dy)||1,scale=Math.min(1,max/len);knob.style.transform=`translate(calc(-50% + ${Math.round(dx*scale)}px),calc(-50% + ${Math.round(dy*scale)}px))`;move.classList.add('active')}
function onMoveDown(event){const viewer=v();if(!viewer?.walk)return;walkMovePointer=event.pointerId;walkOrigin=[event.clientX,event.clientY];event.currentTarget.setPointerCapture?.(event.pointerId);updateKnob(0,0);setTouchKeys([]);event.preventDefault();event.stopPropagation()}
function onMoveMove(event){if(event.pointerId!==walkMovePointer||!walkOrigin)return;const dx=event.clientX-walkOrigin[0],dy=event.clientY-walkOrigin[1],dead=10,keys=[];if(dy<-dead)keys.push('w');else if(dy>dead)keys.push('s');if(dx<-dead)keys.push('a');else if(dx>dead)keys.push('d');setTouchKeys(keys);updateKnob(dx,dy);event.preventDefault();event.stopPropagation()}
function clearTouchMove(){const viewer=v();if(viewer?.keys)for(const key of touchKeys)viewer.keys.delete(key);touchKeys.clear();walkMovePointer=null;walkOrigin=null;const move=byId('revex-walk-touch')?.querySelector('.revex-walk-move'),knob=move?.querySelector('.revex-walk-knob');move?.classList.remove('active');if(knob)knob.style.transform='translate(-50%,-50%)'}
function onMoveUp(event){if(event.pointerId!==walkMovePointer)return;clearTouchMove();event.preventDefault();event.stopPropagation()}
function bindWalk(){
 document.addEventListener('click',event=>{
   const button=event.target.closest?.('#walk-toggle');if(!button||!mobile())return;const viewer=v();if(!viewer)return;
   event.preventDefault();event.stopImmediatePropagation();const on=!viewer.walk;viewer.walkOn?.(on);button.classList.toggle('active',on);button.setAttribute('aria-pressed',String(on));const controls=byId('walk-controls');if(controls)controls.hidden=!on;syncWalkTouch();diag('INFO','MOBILE_WALK_TOGGLE',on?'Mobile Walk enabled.':'Mobile Walk disabled.',{splitTouch:true});
 },true);
 root.addEventListener('revex:source-revision-loaded',()=>setTimeout(()=>{ensureWalkTouch();syncWalkTouch()},0));
 root.addEventListener('resize',syncWalkTouch);
 const button=byId('walk-toggle');if(button)new MutationObserver(syncWalkTouch).observe(button,{attributes:true,attributeFilter:['class']});
 const bim=byId('view-bim');if(bim)new MutationObserver(syncWalkTouch).observe(bim,{attributes:true,attributeFilter:['hidden']});
}

function isLinkedSheetRecord(row){
 if(!row||row.revexDocKind==='printing-set')return false;
 const kind=text(row.revexDocKind).toLowerCase(),source=text(row.source).toLowerCase();
 const hasParent=Boolean(row.parentPrintingSetId||row.printingSetId||row.printingSetName);
 const hasSheet=Boolean(row.sheetNumber||row.sheetName||row.page||row.pageNumber||row.sheetPage);
 return hasParent&&hasSheet&&(/sheet|page/.test(kind)||/printing|revit/.test(source));
}
function pageNumber(row){return Number(row.page??row.pageNumber??row.sheetPage??1)||1}
function parentFor(row,printing){
 const pid=text(row.parentPrintingSetId||row.printingSetId),pname=text(row.printingSetName),rev=text(row.revision);
 return printing.find(parent=>{
   if(rev&&text(parent.revision)&&text(parent.revision)!==rev)return false;
   if(pid&&text(parent.printingSetId)===pid)return true;
   return pname&&text(parent.printingSetName)===pname;
 })||null;
}
function normalizeDocs(){
 const state=S();if(!state?.library?.length||docsNormalizing)return false;
 const printing=state.library.filter(row=>row.revexDocKind==='printing-set');if(!printing.length)return false;
 let changed=false;const linked=new Set();
 for(const row of state.library){if(!isLinkedSheetRecord(row))continue;const parent=parentFor(row,printing);if(!parent)continue;const p=pageNumber(row),pages=Array.isArray(parent.sheetIndex)?parent.sheetIndex:(parent.sheetIndex=[]);let sheet=pages.find(x=>Number(x.page)===p||text(x.sheetNumber)===text(row.sheetNumber));if(!sheet){sheet={page:p,sheetNumber:row.sheetNumber||'',sheetName:row.sheetName||row.name||'Sheet',currentRevision:row.currentRevision||null};pages.push(sheet);changed=true}const storage=row.singlePageStoragePath||row.storagePath||null,url=row.singlePageUrl||row.url||row.localUrl||null,local=row.singlePageLocalUrl||row.localUrl||null;if(storage&&!sheet.singlePageStoragePath){sheet.singlePageStoragePath=storage;changed=true}if(url&&!sheet.singlePageUrl){sheet.singlePageUrl=url;changed=true}if(local&&!sheet.singlePageLocalUrl){sheet.singlePageLocalUrl=local;changed=true}linked.add(row);}
 if(linked.size){state.library=state.library.filter(row=>!linked.has(row));changed=true}
 if(changed){docsNormalizing=true;const search=byId('docs-search');setTimeout(()=>{docsNormalizing=false;search?.dispatchEvent(new Event('input',{bubbles:true}))},0);diag('INFO','DOCS_LINKED_SHEETS',`Linked ${linked.size} standalone sheet record(s) back into their printing-set group.`,{linked:linked.size})}
 return changed;
}
async function fileUrl(path){if(!path)return null;try{return await Store?.fileUrl?.(path)}catch(_){return null}}
async function selectSheet(button){
 const state=S();if(!state)return;normalizeDocs();const file=state.library.find(row=>String(row.id)===String(button.dataset.docId));if(!file)return;const page=Number(button.dataset.page)||1,sheet=(file.sheetIndex||[]).find(row=>Number(row.page)===page)||null;if(!sheet)return;
 const isolated=sheet.singlePageLocalUrl||sheet.singlePageUrl||await fileUrl(sheet.singlePageStoragePath);const base=isolated||file.localUrl||file.url||await fileUrl(file.storagePath);if(!base)return;
 state.docSelection={file,page,sheet,url:base,isolatedSheetUrl:isolated||null,mode:isolated?'isolated-sheet-pdf':'printing-set-page'};
 const frame=byId('docs-frame'),empty=byId('docs-empty'),title=byId('docs-preview-title'),meta=byId('docs-preview-meta');if(title)title.textContent=`${sheet.sheetNumber||`Page ${page}`} · ${sheet.sheetName||''}`;if(meta)meta.textContent=[file.revision?`REVEX ${file.revision}`:null,sheet.currentRevision?`Sheet revision ${sheet.currentRevision}`:null,isolated?'linked single-sheet PDF':`page ${page} of full set`].filter(Boolean).join(' · ');if(frame){frame.src=isolated?base:`${base}#page=${page}`;frame.hidden=false}if(empty)empty.hidden=true;const copy=byId('docs-copy-ref'),open=byId('docs-open-external');if(copy)copy.disabled=false;if(open)open.disabled=false;document.querySelectorAll('.docs-node.active').forEach(node=>node.classList.remove('active'));button.classList.add('active');
}
function bindDocs(){
 const host=byId('docs-tree');if(!host)return;
 const normalizeSoon=()=>setTimeout(normalizeDocs,0);new MutationObserver(normalizeSoon).observe(host,{childList:true,subtree:true});
 document.addEventListener('click',event=>{const button=event.target.closest?.('.docs-node.sheet');if(!button)return;event.preventDefault();event.stopImmediatePropagation();void selectSheet(button)},true);
 root.addEventListener('revex:source-revision-loaded',normalizeSoon);normalizeSoon();
}

function markViewVisibility(){
 // r85 intentionally used display:grid!important for the BIM view on mobile; that
 // overrode the HTML hidden state and made the BIM viewport appear to ignore tab changes.
 for(const view of document.querySelectorAll('.view[hidden]'))view.style.removeProperty('display');
}
function bindViewRefresh(){
 const workspace=byId('workspace');if(workspace)new MutationObserver(()=>{markViewVisibility();syncWalkTouch();normalizeDocs()}).observe(workspace,{subtree:true,attributes:true,attributeFilter:['hidden']});
 document.querySelectorAll('.main-nav [data-view]').forEach(button=>button.addEventListener('click',()=>{toggleActions(false);setTimeout(()=>{markViewVisibility();syncWalkTouch();normalizeDocs()},0)}));
}

function install(){injectCss();installIcons();ensureActions();ensureGuide();ensureWalkTouch();bindViewRefresh();bindWalk();bindDocs();markViewVisibility();syncWalkTouch();maybeGuide();diag('INFO','MOBILE_UX_R100','REVEX mobile UI, tab visibility, split-touch Walk and linked Docs sheet groups installed.',{mobile:mobile()})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
console.log('[REVEX] mobile UX '+BUILD,{tabs:'7-icon-fixed-width',walk:'upper-look+lower-move',docs:'full-set+linked-pages',guide:'first-mobile-launch',dataModel:'unchanged'});
})(window);
