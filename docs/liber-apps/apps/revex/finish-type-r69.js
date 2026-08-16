(function(root){
  'use strict';
  const BUILD='20260816r69-finish-type1';
  const state=()=>root.__revexState||{};
  const Store=()=>root.RevexStore;
  const clone=value=>JSON.parse(JSON.stringify(value===undefined?null:value));
  const text=value=>String(value??'').trim();
  const norm=value=>text(value).toLowerCase().replace(/\s+/g,' ');

  if(root.__revexFinishTypeR69)return;
  root.__revexFinishTypeR69={build:BUILD};

  function diagnostic(level,stage,message,detail={}){
    try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'finish type r69',...detail});}catch(_){}
  }

  function typeKey(row){
    const uid=text(row?.typeUniqueId||row?.typeId||row?.revitTypeUniqueId);
    if(uid)return `uid:${uid}`;
    const category=norm(row?.category||row?.categoryKey);
    const family=norm(row?.family||row?.familyName);
    const type=norm(row?.type||row?.typeName||row?.name);
    return category&&type?`text:${category}|${family}|${type}`:'';
  }

  function sameTypeRows(element){
    const key=typeKey(element);
    if(!key)return [];
    return (state().viewerData?.elements||[]).filter(row=>typeKey(row)===key);
  }

  function stableKey(row){return text(row?.uniqueId||row?.id);}

  function currentOverlay(row){
    const s=state();
    const key=stableKey(row);
    return s.bimOverlays?.get?.(key)||s.bimOverlays?.get?.(text(row?.id))||null;
  }

  function replaceOverlay(row){
    const s=state();
    if(!s.bimOverlays||!row)return;
    const key=stableKey(row);
    for(const [mapKey,value] of s.bimOverlays){
      if(stableKey(value)===key||text(value?.elementId||value?.id)===text(row?.elementId||row?.id))s.bimOverlays.delete(mapKey);
    }
    s.bimOverlays.set(key||text(row.id),row);
  }

  function finishInput(inspector){
    const labels=[...inspector.querySelectorAll('label')];
    const label=labels.find(node=>/\bfinish\s*color\b/i.test(node.textContent||''));
    if(label){
      const input=label.querySelector('input');
      if(input)return input;
    }
    const inputs=[...inspector.querySelectorAll('input')];
    return inputs.find(input=>/finish/i.test(input.id||'')&&/color/i.test(input.id||''))||inputs.find(input=>input.type==='color')||null;
  }

  function generalCommitButton(inspector){
    return [...inspector.querySelectorAll('button')].find(button=>/^\s*commit\s+overlay\s*$/i.test(button.textContent||''))||null;
  }

  function wrapGeneralOverlayCommit(){
    const store=Store();
    if(!store?.commitBimOverlay)return false;
    if(store.commitBimOverlay.__revexFinishTypeR69)return true;
    const original=store.commitBimOverlay.bind(store);
    const wrapped=async function(projectId,element,patch,meta={}){
      if(meta?.operation==='finish-type')return original(projectId,element,patch,meta);
      const next=clone(patch||{});
      // Finish is type-level design intent. Never let the generic element-overlay
      // action silently commit a color for only one instance. Opacity/transform/
      // visibility remain valid per-instance overlays.
      if(next.material&&Object.prototype.hasOwnProperty.call(next.material,'color')){
        delete next.material.color;
        if(!Object.keys(next.material).length)delete next.material;
      }
      return original(projectId,element,next,meta);
    };
    wrapped.__revexFinishTypeR69=true;
    wrapped.__revexOriginal=original;
    store.commitBimOverlay=wrapped;
    return true;
  }

  async function applyFinishToType(button,element,input){
    const s=state(),store=Store();
    if(!s.projectId||!element||!store?.commitBimOverlay)return;
    const color=text(input?.value);
    if(!/^#[0-9a-f]{6}$/i.test(color)){
      diagnostic('ERROR','FINISH_TYPE','Finish color is not a valid six-digit color.',{color});
      return;
    }
    const rows=sameTypeRows(element);
    if(!rows.length){
      diagnostic('ERROR','FINISH_TYPE','Selected element has no stable Revit type identity.');
      return;
    }
    const old=button.textContent;
    button.disabled=true;
    let completed=0;
    try{
      for(let start=0;start<rows.length;start+=6){
        const batch=rows.slice(start,start+6);
        const results=await Promise.all(batch.map(async row=>{
          const before=currentOverlay(row)||{};
          const result=await store.commitBimOverlay(s.projectId,row,{
            material:{...(before.material||{}),color}
          },{
            operation:'finish-type',
            sourceRevision:s.cloudState?.revision||null,
            label:`Finish · ${row.category||'BIM'} · ${row.family||''} ${row.type||row.typeName||''}`.replace(/\s+/g,' ').trim(),
            affectedViews:[],
            camera:null,
            snapshot:null,
            note:`REVEX type finish color ${color}; applied to ${rows.length} current Revit instance(s) sharing the same type identity. Authoritative RVT geometry remains unchanged.`
          });
          if(result?.overlay)replaceOverlay(result.overlay);
          completed+=1;
          button.textContent=`Applying finish ${completed}/${rows.length}…`;
          return result;
        }));
        void results;
      }
      root.__revexViewerR26Instance?.setOverlays?.([...s.bimOverlays.values()]);
      root.dispatchEvent(new CustomEvent('revex:bim-overlays-changed',{detail:{overlays:[...s.bimOverlays.values()]}}));
      diagnostic('INFO','FINISH_TYPE',`Finish color ${color} committed to ${rows.length} same-type element(s).`,{typeKey:typeKey(element),count:rows.length,color});
      button.textContent=`Applied to ${rows.length} same-type element${rows.length===1?'':'s'}`;
      setTimeout(()=>{if(button.isConnected){button.textContent=old;button.disabled=false;}},1400);
    }catch(error){
      button.disabled=false;button.textContent=old;
      diagnostic('ERROR','FINISH_TYPE_FAILED',error?.message||String(error),{completed,total:rows.length,typeKey:typeKey(element)});
      throw error;
    }
  }

  function patchInspector(element=state().selectedElement){
    wrapGeneralOverlayCommit();
    const inspector=document.getElementById('bim-inspector');
    if(!inspector||!element)return;
    const input=finishInput(inspector);
    if(!input)return;
    const existing=inspector.querySelector('[data-revex-finish-type-r69]');
    const rows=sameTypeRows(element);
    const key=typeKey(element);
    if(existing){
      existing.dataset.typeKey=key;
      const note=existing.querySelector('[data-finish-type-count]');
      if(note)note.textContent=rows.length?`${rows.length} current Revit instance${rows.length===1?'':'s'} share this type.`:'No stable same-type set found.';
      return;
    }

    const general=generalCommitButton(inspector);
    if(general)general.textContent='Commit transform / opacity';
    const box=document.createElement('div');
    box.dataset.revexFinishTypeR69='1';
    box.dataset.typeKey=key;
    box.className='review-bim-controls finish-type-r69';
    box.innerHTML=`<button class="button" type="button" data-finish-type-commit>Apply finish color to all same type</button><small class="muted" data-finish-type-count>${rows.length?`${rows.length} current Revit instance${rows.length===1?'':'s'} share this type.`:'No stable same-type set found.'}</small>`;
    const button=box.querySelector('[data-finish-type-commit]');
    button.disabled=!rows.length;
    button.addEventListener('click',event=>{
      event.preventDefault();event.stopImmediatePropagation();
      void applyFinishToType(button,state().selectedElement||element,finishInput(inspector)).catch(()=>{});
    });
    const anchor=general?.parentElement===inspector?general:general;
    if(anchor)anchor.insertAdjacentElement('afterend',box);else input.closest('label')?.insertAdjacentElement('afterend',box)||inspector.appendChild(box);
  }

  root.addEventListener('revex:bim-selection',event=>setTimeout(()=>patchInspector(event.detail?.element),0));
  root.addEventListener('revex:bim-overlays-changed',()=>setTimeout(()=>patchInspector(),0));
  let tries=0;
  const timer=setInterval(()=>{
    tries+=1;wrapGeneralOverlayCommit();patchInspector();
    if(tries>80)clearInterval(timer);
  },125);
  diagnostic('INFO','FINISH_TYPE_RUNTIME','Finish color is a separate same-Revit-type commit; generic overlay commit excludes color.',{build:BUILD});
})(window);
