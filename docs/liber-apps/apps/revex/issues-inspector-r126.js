(function(root){
'use strict';
const BUILD='20260817r126-empty-selection-issues1';
if(root.__revexIssuesInspectorR126)return;
root.__revexIssuesInspectorR126={build:BUILD};
const S=()=>root.__revexState||null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lower=v=>String(v??'').trim().toLowerCase().replace(/[\s_-]+/g,' ');
const INACTIVE=new Set(['resolved','closed','completed','complete','done','cancelled','canceled','deleted','archived']);
const active=row=>!INACTIVE.has(lower(row?.status||'open'));
function focus(issue){
 const v=root.__revexViewerR26Instance;if(!v)return;
 const row=(issue?.anchorUniqueId&&v.byUid?.get?.(String(issue.anchorUniqueId)))||(issue?.anchorElementId&&v.byId?.get?.(String(issue.anchorElementId)));
 if(row){v.selectAndRoute?.(row);v.select?.(row,true)}
}
function render(){
 const s=S(),host=document.getElementById('bim-inspector');if(!host||s?.selectedElement)return;
 const rows=(s?.issues||[]).filter(active).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
 host.innerHTML=`<div class="eyebrow">PROJECT COORDINATION</div><h2>Active issues · ${rows.length}</h2><p class="muted">No BIM element selected — showing every active issue in this project.</p><div class="issue-list" data-r126-empty-issues>${rows.length?rows.map(issue=>`<button type="button" class="issue-row r126-empty-issue" data-id="${esc(issue.id||'')}"><strong>${esc(issue.title||'Issue')}</strong><small>${esc(String(issue.status||'open').replace(/_/g,' '))}${issue.anchorLabel?` · ${esc(issue.anchorLabel)}`:''}</small>${issue.body?`<p>${esc(issue.body)}</p>`:''}</button>`).join(''):'<p class="muted">No active issues.</p>'}</div>`;
 host.querySelectorAll('.r126-empty-issue').forEach(button=>button.addEventListener('click',()=>{const issue=rows.find(row=>String(row.id||'')===String(button.dataset.id||''));if(issue)focus(issue)}));
}
function install(){
 root.addEventListener('revex:issues-r126-changed',()=>queueMicrotask(render));
 root.addEventListener('revex:source-revision-loaded',()=>setTimeout(render,0));
 root.addEventListener('revex:authoritative-project-bound',()=>setTimeout(render,0));
 root.addEventListener('revex:bim-selection',event=>{if(!event.detail?.element)setTimeout(render,0)});
 const style=document.createElement('style');style.id='revex-r126-empty-issues-css';style.textContent='.r126-empty-issue{width:100%;color:inherit;text-align:left;cursor:pointer}.r126-empty-issue:hover{border-color:var(--line-2);background:rgba(255,255,255,.035)}';document.head.appendChild(style);
 setTimeout(render,0);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})(window);
