const $=selector=>document.querySelector(selector),state=()=>window.__revexState||{};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const identity=()=>({project:state().projectId,uid:window.RevexStore?.user?.uid,activation:state().activationToken,position:state().selectedDesign?.id,version:$('.design-version-card.active')?.getAttribute('data-design-version')||''});
let captured,generation=0;
const dialog=document.createElement('dialog');dialog.id='design-product-sourcing';dialog.setAttribute('aria-labelledby','design-sourcing-title');
dialog.innerHTML='<header><div><small>PRODUCT SOURCING</small><h2 id="design-sourcing-title">Find products for this position</h2></div><button type="button" class="button ghost" data-close>Close</button></header><p data-context></p><form><label for="design-sourcing-brief">Product brief</label><textarea id="design-sourcing-brief" rows="4" maxlength="4000" placeholder="Product, dimensions, material, style, budget and region…"></textarea><p class="muted">Searches public catalogues and the broader market. Include product requirements here; keep private project details out of the search brief.</p><button type="submit" class="button" data-research>Find alternatives</button></form><p data-status role="status" aria-live="polite"></p><div data-research-result></div>';
document.body.append(dialog);
const css=document.createElement('style');css.textContent='#design-product-sourcing{box-sizing:border-box;width:min(760px,calc(100vw - 20px));max-height:90dvh;overflow:auto;padding:22px;border:1px solid var(--line-2);border-radius:14px;background:var(--panel,#13161b);color:var(--tx,#e8ecf2)}#design-product-sourcing::backdrop{background:#000b}#design-product-sourcing header{display:flex;justify-content:space-between;gap:16px}#design-product-sourcing h2{margin:6px 0}#design-product-sourcing textarea{box-sizing:border-box;width:100%;margin:8px 0;resize:vertical;font:inherit;padding:10px}#design-product-sourcing p{font-size:12px;line-height:1.7}#design-product-sourcing [data-status]{color:var(--tx-2)}.sourcing-answer{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 system-ui}.sourcing-source-list{display:grid;gap:10px;margin:20px 0}.sourcing-source{border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}.sourcing-source>a{display:block;font-size:13px;overflow-wrap:anywhere;color:var(--acc-2);margin-bottom:10px}.sourcing-source button{font-size:12px}.sourcing-support{margin-top:10px;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.sourcing-search-suggestions{border:0;width:100%;height:150px;background:transparent}.sourcing-support a{color:var(--acc-2);margin-right:8px}';document.head.append(css);
const node=selector=>dialog.querySelector(selector),same=()=>captured&&JSON.stringify(identity())===JSON.stringify(captured.identity);
function close(){generation++;dialog.close();node('[data-research]').disabled=false;}
node('[data-close]').onclick=close;dialog.addEventListener('cancel',()=>{generation++;});
window.addEventListener('revex:source-products',()=>{
 if(!state().selectedDesign)return;
 captured={identity:identity(),source:$('#design-source')?.value||''};generation++;
 const selected=state().selectedDesign;
 node('[data-context]').textContent=`${selected.chapterTitle||'Design Book'} · ${selected.label}`;
 node('#design-sourcing-brief').value=String(selected.label||'')+(selected.candidateMaterials?.length?' · Materials: '+selected.candidateMaterials.slice(0,5).join(', '):'');
 node('[data-status]').textContent='Review the product brief, then search. Results only enter your draft when you choose a source.';
 node('[data-research-result]').replaceChildren();node('[data-research]').disabled=false;if(!dialog.open)dialog.showModal();
});
node('form').onsubmit=async event=>{
 event.preventDefault();if(!same())return close();const question=node('#design-sourcing-brief').value.trim();if(!question)return;
 const run=++generation;node('[data-research]').disabled=true;node('[data-status]').textContent='Searching catalogue sources and independent alternatives…';node('[data-research-result]').replaceChildren();
 try{
  const result=await window.RevexProjectAssistant.request({mode:'sourcing',projectId:captured.identity.project,requestId:crypto.randomUUID(),question,context:{totalPositions:0,includedPositions:[]}});
  if(run!==generation||!dialog.open||!same())return;
  const sources=(result.sources||[]).filter(source=>{try{return new URL(source.url).protocol==='https:';}catch{return false;}});
  node('[data-status]').textContent=sources.length?`${sources.length} source pages found. Review the product details before using a link.${result.attempts>1?' Search broadened beyond the initial catalogues.':''}`:result.answer;
  if(!sources.length)return;
  let answer=esc(result.answer);
  for(const support of result.groundingSupports||[]){if(!support.text||!support.sourceKeys?.length)continue;const segment=esc(support.text),citations=support.sourceKeys.map(key=>{const source=sources.find(x=>x.key===key);return source?` <a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">[${Number(key)+1}]</a>`:'';}).join('');answer=answer.replace(segment,segment+citations);}
  // Format a small, escaped Markdown subset; clickable sources come only from grounding metadata.
  answer=answer.replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g,'$1').replace(/^#{1,4}\s+(.+)$/gm,'<h3>$1</h3>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/^\s*\*\s+/gm,'• ');
  const host=node('[data-research-result]');host.innerHTML=`<p class="muted">Research candidates. Confirm dimensions, availability and applicable requirements from the linked technical documents before approval.</p><div class="sourcing-answer">${answer}</div>`;
  const suggestions=document.createElement('iframe');suggestions.className='sourcing-search-suggestions';suggestions.title='Google Search suggestions';suggestions.setAttribute('sandbox','allow-popups allow-popups-to-escape-sandbox');suggestions.srcdoc='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src https: data:; script-src \'none\'; style-src \'unsafe-inline\' https:;"></head><body>'+String(result.searchSuggestions||'')+'</body></html>';host.append(suggestions);
  const links=document.createElement('div');links.className='sourcing-source-list';links.innerHTML=sources.map(source=>`<div class="sourcing-source"><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">[${Number(source.key)+1}] ${esc(source.title)}</a><button type="button" class="button ghost" data-use-source="${esc(source.key)}">Use link in working draft</button></div>`).join('');host.append(links);
  links.querySelectorAll('[data-use-source]').forEach(button=>button.onclick=()=>{
   const input=$('#design-source'),source=sources.find(s=>s.key===button.dataset.useSource);
   if(!same()){node('[data-status]').textContent='The active position or version changed. Reopen sourcing for the current draft.';return;}
   if(!input||input.disabled){node('[data-status]').textContent='Choose an editable working version before applying a source link.';return;}
   if(input.value!==captured.source){node('[data-status]').textContent='Your source link changed while researching. It has been preserved. Reopen sourcing to continue.';return;}
   input.value=source.url;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));close();input.focus();
  });
 }catch(error){if(run===generation&&same())node('[data-status]').textContent=String(error.message||'Product search failed. Retry your brief.');}
 finally{if(run===generation)node('[data-research]').disabled=false;}
};
for(const event of ['revex:project-boundary','revex:auth-mode-changed'])window.addEventListener(event,()=>{close();captured=null;node('[data-research-result]').replaceChildren();node('#design-sourcing-brief').value='';});
