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
const button=document.createElement('button');button.id='revex-wallt-open';button.type='button';button.className='button ghost compact';button.textContent='Ask WALLT';button.setAttribute('aria-haspopup','dialog');
document.querySelector('.topbar')?.append(button);
const dialog=document.createElement('dialog');dialog.id='revex-wallt-dialog';dialog.setAttribute('aria-labelledby','revex-wallt-title');
dialog.innerHTML='<header><div><div class="eyebrow">PROJECT ASSISTANT</div><h2 id="revex-wallt-title">Ask WALLT</h2></div><button type="button" class="button ghost" data-close aria-label="Close WALLT">Close</button></header><p id="revex-wallt-context"></p><form><label for="revex-wallt-question">Find a position or ask about this project</label><textarea id="revex-wallt-question" rows="4" maxlength="6000" placeholder="Which exterior doors still need a selection?"></textarea><div class="wallt-actions"><button type="submit" class="button" id="revex-wallt-ask">Ask WALLT</button><button type="button" class="button ghost" id="revex-wallt-retry" hidden>Retry</button></div></form><p id="revex-wallt-status" role="status" aria-live="polite"></p><div id="revex-wallt-answer"></div><div id="revex-wallt-matches"></div>';
document.body.append(dialog);
const style=document.createElement('style');style.textContent='#revex-wallt-dialog{width:min(680px,calc(100vw - 24px));max-height:88dvh;box-sizing:border-box;overflow:auto;background:var(--panel,#10151d);color:var(--text,#eef2f7);border:1px solid var(--line,#34404e);border-radius:16px;padding:20px}#revex-wallt-dialog::backdrop{background:#000a}#revex-wallt-dialog header,.wallt-actions{display:flex;justify-content:space-between;align-items:center;gap:12px}#revex-wallt-dialog h2{margin:5px 0}#revex-wallt-dialog textarea{display:block;box-sizing:border-box;width:100%;margin:10px 0;min-height:110px;font:inherit;resize:vertical;padding:10px}#revex-wallt-answer{white-space:pre-wrap;line-height:1.6;overflow-wrap:anywhere}#revex-wallt-matches{display:grid;gap:8px;margin-top:14px}#revex-wallt-matches button{text-align:left;white-space:normal}#revex-wallt-context,#revex-wallt-status{font-size:13px;line-height:1.5;color:var(--muted,#acb8c6)}';document.head.append(style);
function reset(){generation++;results=[];lastPrompt='';requestId='';dialog.close();byId('revex-wallt-answer').textContent='';byId('revex-wallt-matches').replaceChildren();byId('revex-wallt-question').value='';byId('revex-wallt-status').textContent='';byId('revex-wallt-ask').disabled=false;byId('revex-wallt-retry').hidden=true;}
button.addEventListener('click',()=>{const s=state();byId('revex-wallt-context').textContent=[s.project?.name||s.project?.title||'Select a project',s.selectedDesign?.label||s.selectedElement?.name||'Whole project'].join(' · ');dialog.showModal();byId('revex-wallt-question').focus();});
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
 const context={project:state().project?.name||state().project?.title||captured.project,selectedPosition:selectedId||null,selectedElement:state().selectedElement?{name:state().selectedElement.name,id:state().selectedElement.id,category:state().selectedElement.category}:null,totalPositions:all.length,includedPositions:ranked};
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
