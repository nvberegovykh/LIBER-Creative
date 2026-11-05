(function(root){
 'use strict';
 const viewerUrl=new URL('document-viewer.html',document.currentScript.src).href;
 const pending=new Map();let selectionSequence=0;
 const owner=()=>{const s=root.__revexState||{};return `${root.RevexStore?.user?.uid||''}:${s.projectId||''}:${s.activationToken||''}`;};
 function beginSelection(){const sequence=++selectionSequence,identity=owner();return()=>sequence===selectionSequence&&identity===owner();}
 function show(frame,selection){
  for(const previous of pending.keys())if(!previous.isConnected)pending.delete(previous);
  if(frame?.id==='docs-frame'){const explorer=document.querySelector('.docs-explorer');explorer.dataset.documentSelected='true';explorer.dataset.filesOpen='false';document.getElementById('docs-files-toggle')?.setAttribute('aria-expanded','false');}
  if(!frame||!selection?.url)return;const file=selection.file||{},data={url:selection.url,name:file.name||'',mime:file.mimeType||file.contentType||'',title:selection.title||file.revitViewName||file.printingSetName||file.name||'Document',page:selection.page||1,identity:[owner(),file.id||selection.url,file.revision||'',selection.sourcePage||''].join(':')};
  pending.set(frame,{owner:owner(),data});frame.hidden=false;
  if(frame.src!==viewerUrl){frame.dataset.viewerReady='';frame.src=viewerUrl;}else if(frame.dataset.viewerReady==='1')frame.contentWindow?.postMessage({type:'revex-document-open',document:data},location.origin);
 }
 root.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.data?.type!=='revex-document-ready')return;
  for(const [frame,value] of pending){if(frame.contentWindow!==event.source||value.owner!==owner())continue;frame.dataset.viewerReady='1';event.source.postMessage({type:'revex-document-open',document:value.data},location.origin);}
 });
 function filesOpen(open){document.querySelector('.docs-explorer').dataset.filesOpen=String(open);document.getElementById('docs-files-toggle').setAttribute('aria-expanded',String(open));}
 const files=document.createElement('button');files.id='docs-files-toggle';files.className='button ghost';files.type='button';files.textContent='Files';files.setAttribute('aria-controls','docs-tree');files.setAttribute('aria-expanded','false');document.querySelector('.docs-toolbar>div:first-child')?.append(files);files.onclick=()=>filesOpen(document.querySelector('.docs-explorer').dataset.filesOpen!=='true');
 root.addEventListener('keydown',event=>{if(event.key==='Escape')filesOpen(false);});
 root.addEventListener('revex:project-boundary',()=>{++selectionSequence;for(const frame of pending.keys()){frame.src='about:blank';frame.dataset.viewerReady='';}pending.clear();const explorer=document.querySelector('.docs-explorer');delete explorer.dataset.documentSelected;filesOpen(false);document.getElementById('energy-preview-dialog')?.close();});
 root.__revexDocumentViewer={show,beginSelection};
})(window);
