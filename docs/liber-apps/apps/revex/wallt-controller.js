/* Contextual assistance uses the current project and canonical Design Book owner. */
const byId=id=>document.getElementById(id);
const state=()=>window.__revexState||{};
const owner=()=>({uid:window.RevexStore?.user?.uid||'',project:state().projectId||'',activation:state().activationToken});
const current=o=>o.project&&o.uid&&JSON.stringify(o)===JSON.stringify(owner());
let generation=0,results=[],lastPrompt='',requestId='';
window.RevexProjectAssistant={async request(data){
 const f=window.firebaseModular,service=window.firebaseService;
 if(!f?.httpsCallable||!service?.app)throw new Error('WALLT is unavailable. Reload and retry.');
 return (await f.httpsCallable(f.getFunctions(service.app,'us-central1'),'askRevexProject',{timeout:80000})(data)).data;
}};
const button=document.createElement('button');button.id='revex-wallt-open';button.type='button';button.className='button ghost compact';button.textContent='✦';button.title='WALLT · Helper & Fixer';button.setAttribute('aria-label','WALLT · Helper & Fixer');button.setAttribute('aria-haspopup','dialog');
document.querySelector('.topbar')?.append(button);
const dialog=document.createElement('dialog');dialog.id='revex-wallt-dialog';dialog.setAttribute('aria-labelledby','revex-wallt-title');
dialog.innerHTML='<header><div><div class="eyebrow">PROJECT ASSISTANT</div><h2 id="revex-wallt-title">Ask WALLT</h2></div><button type="button" class="button ghost" data-close aria-label="Close WALLT">Close</button></header><p id="revex-wallt-context"></p><form><label for="revex-wallt-question">Find a position or ask about this project</label><textarea id="revex-wallt-question" rows="4" maxlength="6000" placeholder="Which exterior doors still need a selection?"></textarea><div class="wallt-actions"><button type="submit" class="button" id="revex-wallt-ask">Ask WALLT</button><button type="button" class="button ghost" id="revex-wallt-retry" hidden>Retry</button></div></form><p id="revex-wallt-status" role="status" aria-live="polite"></p><div id="revex-wallt-answer"></div><div id="revex-wallt-matches"></div>';
document.body.append(dialog);
let mode='helper';
dialog.querySelector('.eyebrow').textContent='YOUR PROJECT COMPANION';
byId('revex-wallt-title').textContent='✦ WALLT';
dialog.querySelector('label[for="revex-wallt-question"]').textContent='What would you like to do?';
byId('revex-wallt-question').placeholder='Ask about this view, find something, or describe what feels wrong…';
const modes=document.createElement('div');modes.className='wallt-modes';modes.innerHTML='<button type="button" data-mode="helper" aria-pressed="true">Helper</button><button type="button" data-mode="fixer" aria-pressed="false">Fixer</button>';
dialog.querySelector('header').after(modes);
const shortcuts=document.createElement('div');shortcuts.className='wallt-shortcuts';shortcuts.innerHTML='<button type="button" data-wall-action="explain">Explain this screen</button><button type="button" data-wall-action="products">Source products · NYC</button><button type="button" data-wall-action="assets">Place a model</button><button type="button" data-wall-action="energy">Review Energy</button><button type="button" data-wall-action="packages">Arrange packages</button>';
byId('revex-wallt-context').after(shortcuts);
const repairs=document.createElement('section');repairs.className='wallt-repairs';repairs.hidden=true;repairs.innerHTML='<p data-health></p><div class="wallt-shortcuts"><button type="button" data-fix="fit">Reset model view</button><button type="button" data-fix="reload">Reload model geometry</button><button type="button" data-fix="energy">Review failed calculation</button></div><small>Choose a repair to apply it. Project decisions and source geometry stay intact.</small>';
shortcuts.after(repairs);
function activeView(){return document.querySelector('.main-nav [data-view].active')?.dataset.view||'bim';}
function contextLabel(){const s=state(),selection=activeView()==='design'?s.selectedDesign?.label:s.selectedElement?.name;return [s.project?.name||s.project?.title||'Select a project',activeView().toUpperCase(),selection].filter(Boolean).join(' · ');}
function health(){const v=window.__revexViewerR26Instance;repairs.querySelector('[data-health]').textContent=!state().projectId?'Select a project to check its current view.':!v?.data?'The model has not loaded. Try reloading its geometry.':!v.detailLoaded?'The model index is available; exact geometry is still loading or needs a retry.':`Model geometry is loaded (${v.data.elements?.length?.toLocaleString()||0} elements). Describe another issue below, or choose a view repair.`;}
modes.addEventListener('click',event=>{const b=event.target.closest('[data-mode]');if(!b)return;mode=b.dataset.mode;modes.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));repairs.hidden=mode!=='fixer';shortcuts.hidden=mode==='fixer';byId('revex-wallt-ask').textContent=mode==='fixer'?'Help diagnose':'Ask WALLT';if(mode==='fixer')health();});
function showView(view){document.querySelector(`.main-nav [data-view="${view}"]`)?.click();byId('revex-wallt-context').textContent=contextLabel();}
shortcuts.addEventListener('click',event=>{const action=event.target.closest('[data-wall-action]')?.dataset.wallAction;if(!action)return;
 if(action==='explain'){byId('revex-wallt-question').value=`Explain what I can do in the ${activeView()} view and the next useful step.`;ask(byId('revex-wallt-question').value);}
 if(action==='packages'){window.RevexPackages?.arrange();dialog.close();}
 if(action==='energy'){showView('energy');dialog.close();}
 if(action==='assets'){showView('bim');dialog.close();document.getElementById('revex-r157-assets-open')?.click();}
 if(action==='products'){if(!state().selectedDesign){showView('design');byId('revex-wallt-status').textContent='Select a Design Book position, then choose “Source products · NYC”.';return;}dialog.close();window.dispatchEvent(new CustomEvent('revex:source-products'));}
});
repairs.addEventListener('click',async event=>{const b=event.target.closest('[data-fix]');if(!b)return;const captured=owner(),v=window.__revexViewerR26Instance;if(!current(captured))return;
 if(b.dataset.fix==='energy'){showView('energy');dialog.close();return;}
 b.disabled=true;try{if(b.dataset.fix==='fit'){v?.measurement?.setActive(false);v?.fit();byId('revex-wallt-status').textContent='Model view reset.';}else{if(!state().cloudState?.viewerUrl)throw Error('No synced model is available to reload.');await v.load(state().cloudState,state().viewerData);if(current(captured))byId('revex-wallt-status').textContent='Model index reloaded. Exact geometry will finish in the background.';}}catch(e){if(current(captured))byId('revex-wallt-status').textContent=e.message;}finally{b.disabled=false;if(current(captured))health();}
});
const style=document.createElement('style');style.textContent='#revex-wallt-dialog{width:min(680px,calc(100vw - 24px));max-height:88dvh;box-sizing:border-box;overflow:auto;background:var(--panel,#10151d);color:var(--text,#eef2f7);border:1px solid var(--line,#34404e);border-radius:16px;padding:20px}#revex-wallt-dialog::backdrop{background:#000a}#revex-wallt-dialog header,.wallt-actions{display:flex;justify-content:space-between;align-items:center;gap:12px}#revex-wallt-dialog h2{margin:5px 0}#revex-wallt-dialog textarea{display:block;box-sizing:border-box;width:100%;margin:10px 0;min-height:110px;font:inherit;resize:vertical;padding:10px}#revex-wallt-answer{white-space:pre-wrap;line-height:1.6;overflow-wrap:anywhere}#revex-wallt-matches{display:grid;gap:8px;margin-top:14px}#revex-wallt-matches button{text-align:left;white-space:normal}#revex-wallt-context,#revex-wallt-status{font-size:13px;line-height:1.5;color:var(--muted,#acb8c6)}';document.head.append(style);
function reset(){generation++;results=[];lastPrompt='';requestId='';dialog.close();byId('revex-wallt-answer').textContent='';byId('revex-wallt-matches').replaceChildren();byId('revex-wallt-question').value='';byId('revex-wallt-status').textContent='';byId('revex-wallt-ask').disabled=false;byId('revex-wallt-retry').hidden=true;}
button.addEventListener('click',()=>{if(dialog.open){dialog.close();return;}byId('revex-wallt-context').textContent=contextLabel();health();dialog.show();byId('revex-wallt-question').focus();});
dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();dialog.close();button.focus();}});
dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>{generation++;byId('revex-wallt-ask').disabled=false;});
async function ask(prompt,retry=false){
 const captured=owner(),attempt=++generation;
 if(!current(captured)){byId('revex-wallt-status').textContent='Sign in and select a project first.';return;}
 if(!prompt.trim())return;if(!retry||!requestId)requestId=crypto.randomUUID();lastPrompt=prompt;
 byId('revex-wallt-ask').disabled=true;byId('revex-wallt-retry').hidden=true;byId('revex-wallt-status').textContent='Reading the current project…';
 const all=window.RevexDesignContext?.positions()||[],words=prompt.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>2);
 const compact=all.map((p,index)=>({key:String(index),chapterId:p.chapterId,id:p.id,chapter:p.chapterTitle,label:p.label,status:p.status||'Not Selected',description:String(p.description||'').slice(0,1200),source:String(p.source||'').slice(0,600),locations:(p.revit?.locations||p.revit?.levels||[]),category:p.revit?.category||'',family:p.revit?.family||'',type:p.revit?.type||''}));
 const selectedId=state().selectedDesign?.id;
 const ranked=compact.map(p=>({p,score:(String(p.id)===String(selectedId)?100:0)+words.reduce((n,w)=>n+(JSON.stringify(p).toLowerCase().includes(w)?1:0),0)})).sort((a,b)=>b.score-a.score).slice(0,100).map(x=>x.p);
 const context={project:state().project?.name||state().project?.title||captured.project,activeView:activeView(),assistantMode:mode,packages:window.RevexPackages?.context()||null,availableActions:['Open BIM, Design Book, Spec Book, Docs, Packages, Energy or History','Arrange trade packages from connected files and positions using the Arrange packages button; uncertain matches need review','Reset model view','Reload exact geometry','Place an IFC, GLB, FBX, OBJ or STL model through Assets','Source products deliverable to NYC for a selected Design Book position'],runtime:{modelLoaded:!!window.__revexViewerR26Instance?.detailLoaded,selectedFloor:document.getElementById('walk-floor')?.selectedOptions[0]?.textContent||'',sourceRepair:window.__revexEnergySourceRepair?.projectId===captured.project?window.__revexEnergySourceRepair.message:null},selectedPosition:activeView()==='design'?selectedId||null:null,selectedElement:state().selectedElement?{name:state().selectedElement.name,id:state().selectedElement.id,category:state().selectedElement.category}:null,totalPositions:all.length,includedPositions:ranked};
 try{
  const parsed=await window.RevexProjectAssistant.request({projectId:captured.project,requestId,question:prompt,context});
  if(!current(captured)||attempt!==generation||!dialog.open)return;
  byId('revex-wallt-answer').textContent=String(parsed.answer||'No answer was returned.');
  results=(Array.isArray(parsed.matches)?[...new Set(parsed.matches.map(String))]:[]).slice(0,12).map(key=>ranked.find(p=>p.key===key)).filter(Boolean);
  byId('revex-wallt-matches').replaceChildren(...results.map(p=>{const b=document.createElement('button');b.type='button';b.className='button ghost';b.textContent=p.label+' · '+p.chapter;b.addEventListener('click',()=>{if(current(captured)&&window.RevexDesignContext.open(p.chapterId,p.id))dialog.close();});return b;}));
  byId('revex-wallt-status').textContent=`Used ${ranked.length} of ${all.length} positions${ranked.length<all.length?' ranked by your question':''}. Select a result to review or edit it.`;
 }catch(error){if(current(captured)&&attempt===generation){if(['functions/unavailable','functions/failed-precondition'].includes(error.code))requestId='';byId('revex-wallt-status').textContent=error.name==='AbortError'?'WALLT took too long. Retry your question.':String(error.message||error);byId('revex-wallt-retry').hidden=false;}}
 finally{if(current(captured)&&attempt===generation)byId('revex-wallt-ask').disabled=false;}
}
dialog.querySelector('form').addEventListener('submit',e=>{e.preventDefault();ask(byId('revex-wallt-question').value);});
byId('revex-wallt-retry').addEventListener('click',()=>ask(lastPrompt,true));
for(const name of ['revex:project-boundary','revex:auth-mode-changed'])window.addEventListener(name,reset);
