(function(root){
  'use strict';
  const BUILD='20260812r41';
  if(root.__revexR41Live)return;
  root.__revexR41Live=true;

  const requiredStore=['resolveSpecProject','ensureSpecProject','listDesignEdits','saveDesignEdit','listChapterEdits','saveChapterEdit','listLibrary','listHistory','appendHistory','listBimOverlays','commitBimOverlay','listDerivedPlans','saveDerivedPlan'];

  function claim(buttonId,handler){
    const button=document.getElementById(buttonId);
    if(!button||button.dataset.revexR41Owner)return;
    button.dataset.revexR41Owner='1';
    document.addEventListener('click',(event)=>{
      const hit=event.target?.closest?.('#'+buttonId);
      if(!hit)return;
      const viewer=root.__revexViewerR26Instance;
      if(!viewer)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handler(viewer,hit,event);
    },true);
  }

  function bindViewerOwnership(){
    const viewer=root.__revexViewerR26Instance;
    if(!viewer)return false;

    claim('fit-model',(v)=>v.fit?.());
    claim('fit-model-rail',(v)=>v.fit?.());
    claim('section-toggle',(v,button)=>{
      v.section=v.section||{enabled:false,minX:0,maxX:1,minY:0,maxY:1,minZ:0,maxZ:1};
      v.section.enabled=!v.section.enabled;
      button.classList.toggle('active',v.section.enabled);
      button.setAttribute('aria-expanded',String(v.section.enabled));
      const controls=document.getElementById('section-controls');
      if(controls)controls.hidden=!v.section.enabled;
      v.sectionApply?.();
    });
    claim('walk-toggle',(v,button)=>{
      const on=!button.classList.contains('active');
      button.classList.toggle('active',on);
      const controls=document.getElementById('walk-controls');
      if(controls)controls.hidden=!on;
      v.walkOn?.(on);
    });
    return true;
  }

  function verify(){
    const store=root.RevexStore||{};
    const missing=requiredStore.filter((name)=>typeof store[name]!=='function');
    const viewer=root.__revexViewerR26Instance;
    console.info('[REVEX] live coherence '+BUILD,{
      storeContract:missing.length===0,
      missingStoreMethods:missing,
      viewerReady:Boolean(viewer),
      exactInstancePicking:Boolean(viewer?.pick),
      sectionBox:Boolean(viewer?.sectionBox&&viewer?.sectionApply),
      singleControlOwner:true
    });
  }

  function start(){
    let tries=0;
    const tick=()=>{
      tries+=1;
      if(bindViewerOwnership()||tries>80){verify();return;}
      setTimeout(tick,125);
    };
    tick();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})(window);
