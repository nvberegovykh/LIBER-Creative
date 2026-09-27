import './diagnostics-r29.js?v=20260914r192-morning1';

(function(root){
  'use strict';
  const BUILD='20260812r40';
  const HARD_STOP=0.80;
  const QUALITY_TARGET=0.95;
  const Store=root.RevexStore;
  if(!Store||root.__revexEnergyContractR40)return;
  root.__revexEnergyContractR40=true;

  const $=(s,r=document)=>r.querySelector(s);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safe=v=>String(v||'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=v=>safe(v).replace(/\./g,'_');
  const pct=v=>Number.isFinite(Number(v))?`${(Number(v)*100).toFixed(1)}%`:'—';
  const projectId=()=>String(root.__revexState?.projectId||$('#project-select')?.value||new URLSearchParams(location.search).get('projectId')||'').trim();
  const readJson=async file=>{try{return JSON.parse(await file.text())}catch(error){throw new Error(`${file?.name||'JSON'} is not valid JSON: ${error.message}`)}};
  const integrity=manifest=>{
    const p=manifest?.publicationIntegrity||{};
    const ratios=Object.entries(p.ratios||{}).map(([k,v])=>[k,Number(v)]);
    const hardStop=Number(p.threshold||0);
    const qualityTarget=Number(p.qualityTarget||p.threshold||0);
    const lowest=ratios.length?Math.min(...ratios.map(([,v])=>v)):NaN;
    const belowQuality=ratios.filter(([,v])=>v<QUALITY_TARGET);
    return{ratios,hardStop,qualityTarget,lowest,belowQuality};
  };
  const publishable=manifest=>{
    const q=integrity(manifest);
    return manifest?.gbxmlStatus==='EXPORTED'&&q.hardStop>=HARD_STOP&&q.qualityTarget>=QUALITY_TARGET&&q.ratios.length>0&&q.ratios.every(([,v])=>Number.isFinite(v)&&v>=HARD_STOP&&v<=1);
  };
  const setStatus=(message,tone='')=>{const n=$('#energy-run-status');if(n){n.textContent=message;if(tone)n.dataset.tone=tone}};
  const setBadge=(message,tone='quiet')=>{const n=$('#energy-source-badge');if(n){n.textContent=message;n.dataset.tone=tone}};

  // The cloud bridge owns validation, immutable storage and publication.

  function renderSource(source){
    const manifest=source?.manifest;
    if(!manifest)return;
    const q=integrity(manifest),ok=publishable(manifest),review=ok&&q.belowQuality.length>0;
    setBadge(ok?(review?`Evidence ${pct(q.lowest)} · review`:'Evidence ready'):`Diagnostic ${pct(q.lowest)} · not published`,ok?(review?'quiet':'ready'):'blocked');
    const summary=$('#energy-source-summary');
    if(summary)summary.textContent=!ok
      ?`Engineering evidence is preserved for repair, but it does not clear the ≥80% hard-stop gate in every evidence domain. It is not published and managed processing will not start.`
      :review
        ?`Immutable Engineering evidence passed the 80% hard stop, but ${q.belowQuality.length} evidence domain(s) are below the 95% quality target. Managed processing continues; review this quality warning.`
        :'Immutable Engineering evidence and Weather file (.EPW) are attached. Revit writes are finished; downstream processing has no RVT return path.';
    const facts=$('#energy-source-facts');
    if(facts){
      const weather=manifest.weather||{},below=q.belowQuality.length?q.belowQuality.map(([k,v])=>`${k}: ${pct(v)}`).join(' · '):'None';
      facts.innerHTML=[
        ['Revision',source.revision||manifest.revision||'—'],
        ['Integrity hard stop','≥80.0% in every evidence domain'],
        ['Quality target','≥95.0% · warning below this level'],
        ['Lowest integrity',pct(q.lowest)],
        ['Below quality target',below],
        ['Weather file (.EPW)',weather.sourceFile||weather.file||'—'],
        ['Weather location',[weather.city,weather.stateProvince,weather.country].filter(Boolean).join(', ')||'—'],
        ['Post-export Revit writeback','None']
      ].map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    }
  }

  function renderResult(result){
    if(!result?.manifest)return;
    const complete=String(result.manifest.status||'').toUpperCase()==='COMPLETE';
    const summary=$('#energy-result-summary');
    if(summary)summary.textContent=complete
      ?`${result.manifest.resultRevision||result.revision||'Energy result'} completed. Filing PDFs are ready for later insertion.`
      :`${result.manifest.status||'Blocked'}: ${result.manifest.error||'Review the managed Energy diagnostics.'}`;
  }

  async function runManaged(source){
    const id=projectId(),revision=String(source?.revision||source?.manifest?.revision||'').trim();
    if(!id||!revision||!source?.cloud||!publishable(source.manifest))return;
    if(source.projectId!==id)return;
    if(root.__revexHostedEnergyReplayR95?.runHosted){await root.__revexHostedEnergyReplayR95.runHosted({auto:false});return;}
    try{
      setStatus('Managed REVEX Energy server: GeometryCo → Baseline/Proposed → OpenStudio/EnergyPlus → reports → EN-1…','busy');
      const job=await Store.runEnergyServer(id,revision),result=await Store.getEnergyResult(id);
      if(result)renderResult(result);
      const complete=String(result?.manifest?.status||job?.status||'').toUpperCase()==='COMPLETE';
      setStatus(complete?'Managed Energy package complete. Current project identity came from Revit Z pages; applicant and modeler remain blank.':(result?.manifest?.error||job?.message||'Managed Energy worker returned a reviewable result.'),complete?'good':'bad');
    }catch(error){setStatus(error?.message||'Managed REVEX Energy server failed.','bad')}
  }

  async function hydrate(){
    const id=projectId();
    if(!id)return;
    try{
      const source=await Store.getEngineeringState(id);
      if(!source?.manifest)return;
      renderSource(source);
      const result=await Store.getEnergyResult(id);
      const current=String(source.revision||source.manifest.revision||''),done=String(result?.manifest?.sourceEngineeringRevision||'');
      if(source.cloud&&current&&done!==current)await runManaged(source);
    }catch(error){console.warn('[REVEX r40] Energy hydrate',error)}
  }

  if(!root.chrome?.webview){
    document.addEventListener('change',event=>{
      const target=event.target;
      if(!(target instanceof HTMLInputElement)||!target.matches("input[data-liber-revex-energy-input='1']"))return;
      event.preventDefault();event.stopImmediatePropagation();
      const files=Array.from(target.files||[]);
      if(!files.length)return;
      const importProject=projectId(),importUid=Store.user?.uid;
      void(async()=>{
        try{
          setStatus('Importing Engineering evidence…','busy');
          const source=await Store.syncEngineeringPackage(files,importProject);
          if(projectId()!==importProject||Store.user?.uid!==importUid)return;
          renderSource(source);
          await runManaged(source);
        }catch(error){if(projectId()!==importProject||Store.user?.uid!==importUid)return;setBadge('Engineering Sync rejected','blocked');setStatus(error?.message||'Engineering Sync could not be imported.','bad')}
      })();
    },true);
    root.addEventListener('revex:energy-open',event=>{event.stopImmediatePropagation();void hydrate()});
    document.addEventListener('change',event=>{if(event.target?.id==='project-select')setTimeout(()=>void hydrate(),0)},true);
  }

  const rewrite=()=>{
    const view=$('#view-energy');if(!view)return;
    try{
      const walker=document.createTreeWalker(view,NodeFilter.SHOW_TEXT),nodes=[];
      while(walker.nextNode())nodes.push(walker.currentNode);
      nodes.forEach(node=>{
        const before=String(node.nodeValue||''),after=before
          .replace(/≥\s*98%/g,'≥80%')
          .replace(/>=\s*98%/g,'>=80%')
          .replace(/98%\s+publication(?:-integrity)?\s+gate/gi,'80% hard-stop gate')
          .replace(/Sub-98%/g,'Sub-80%');
        if(after!==before)node.nodeValue=after;
      });
    }catch(_){}
  };
  new MutationObserver(rewrite).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{rewrite();setTimeout(()=>void hydrate(),0)},{once:true});
  else{rewrite();setTimeout(()=>void hydrate(),0)}
  console.info('[REVEX] Energy contract '+BUILD,{hardStop:HARD_STOP,qualityTarget:QUALITY_TARGET,browserManaged:true});
})(window);
