import './diagnostics-r29.js?v=20260813r45';

(function(root){
  'use strict';
  const BUILD='20260812r40';
  const HARD_STOP=0.80;
  const QUALITY_TARGET=0.95;
  const Store=root.RevexStore;
  if(!Store||root.__revexEnergyContractR40)return;
  root.__revexEnergyContractR40=true;

  const $=(s,r=document)=>r.querySelector(s);
  const plain=v=>JSON.parse(JSON.stringify(v===undefined?null:v));
  const safe=v=>String(v||'').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120)||'file';
  const docId=v=>safe(v).replace(/\./g,'_');
  const pct=v=>Number.isFinite(Number(v))?`${(Number(v)*100).toFixed(1)}%`:'—';
  const projectId=()=>String(root.__revexState?.projectId||$('#project-select')?.value||new URLSearchParams(location.search).get('projectId')||'').trim();
  const readJson=async file=>{try{return JSON.parse(await file.text())}catch(error){throw new Error(`${file?.name||'JSON'} is not valid JSON: ${error.message}`)}};
  const integrity=manifest=>{
    const p=manifest?.publicationIntegrity||{};
    const ratios=Object.entries(p.ratios||{}).map(([k,v])=>[k,Number(v)]).filter(([,v])=>Number.isFinite(v));
    const hardStop=Number(p.threshold||0);
    const qualityTarget=Number(p.qualityTarget||p.threshold||0);
    const lowest=ratios.length?Math.min(...ratios.map(([,v])=>v)):NaN;
    const belowQuality=ratios.filter(([,v])=>v<QUALITY_TARGET);
    return{ratios,hardStop,qualityTarget,lowest,belowQuality};
  };
  const publishable=manifest=>{
    const q=integrity(manifest);
    return manifest?.gbxmlStatus==='EXPORTED'&&q.hardStop>=HARD_STOP&&q.qualityTarget>=QUALITY_TARGET&&q.ratios.length>0&&q.ratios.every(([,v])=>v>=HARD_STOP);
  };
  const setStatus=(message,tone='')=>{const n=$('#energy-run-status');if(n){n.textContent=message;if(tone)n.dataset.tone=tone}};
  const setBadge=(message,tone='quiet')=>{const n=$('#energy-source-badge');if(n){n.textContent=message;n.dataset.tone=tone}};

  Store.syncEngineeringPackage=async function(fileList,preferredProjectId){
    const files=Array.from(fileList||[]);
    const manifestFile=files.find(f=>String(f.name||'').toLowerCase()==='engineering-sync.json')||null;
    const gbxmlFile=files.find(f=>/\.xml$/i.test(f.name))||null;
    const weatherFile=files.find(f=>/\.epw$/i.test(f.name))||null;
    if(!manifestFile||!gbxmlFile||!weatherFile)throw new Error('The Engineering Sync evidence must include engineering-sync.json, the Revit gbXML, and the selected EPW weather file.');
    const manifest=await readJson(manifestFile);
    if(manifest?.schema!=='liber.revex.engineering-sync.v1'||manifest?.architecture!=='REVIT_EVIDENCE_GRAPH_V1')throw new Error('This is not a compatible REVIT_EVIDENCE_GRAPH_V1 Engineering Sync revision.');
    const q=integrity(manifest);
    if(q.hardStop<HARD_STOP||!q.ratios.length||q.ratios.some(([,v])=>v<HARD_STOP))throw new Error('Energy Sync requires at least 80% integrity in every required Revit evidence domain.');
    if(q.qualityTarget<QUALITY_TARGET)throw new Error('Energy Sync is missing the 80% hard-stop / 95% quality-target integrity contract.');
    if(manifest.writeBackToRevitAfterExport!==false||manifest.pdfInsertion!==false)throw new Error('The Engineering Sync authority boundary is invalid.');
    const id=preferredProjectId||manifest.projectId||null;
    if(!id)throw new Error('Choose a LIBER project before importing Engineering Sync.');
    if(manifest.projectId&&String(manifest.projectId)!==String(id))throw new Error('The Engineering Sync revision belongs to a different REVEX project.');
    const revision=docId(manifest.revision||`eng_${Date.now()}`);
    const at=new Date().toISOString();
    const localArtifacts=files.map((file,index)=>({name:file.name,bytes:file.size||0,kind:index===0?'manifest':'engineering-evidence',url:URL.createObjectURL(file),cloud:false}));
    const state={schema:'liber.revex.engineering-state.v1',projectId:id,revision,syncedAt:at,manifest,artifacts:localArtifacts,cloud:false,writeBackToRevitAfterExport:false,pdfInsertion:false};
    try{localStorage.setItem(`liber.revex.engineering.${id}`,JSON.stringify({...state,artifacts:localArtifacts.map(({url,...row})=>row),localOnly:true}))}catch(_){}
    if(!this.isCloud?.())return state;
    if(!this.fs?.storage)throw new Error('LIBER Storage is not available in this session.');
    const base=`projects/${id}/revex/engineering/revisions/${revision}`,artifacts=[];
    for(let index=0;index<files.length;index++){
      const file=files[index],uploaded=await this.uploadFile(`${base}/${String(index+1).padStart(3,'0')}_${safe(file.name)}`,file);
      artifacts.push({name:file.name,bytes:file.size||0,kind:index===0?'manifest':'engineering-evidence',url:uploaded.url,path:uploaded.path,cloud:true});
    }
    const cloudState=plain({...state,artifacts,cloud:true,syncedBy:this.user?.uid||null});
    await this.api.setDoc(this.api.doc(this.db,'projects',id,'revex','engineering'),cloudState,plain({merge:false}));
    await this.api.setDoc(this.api.doc(this.db,'projects',id,'revexEngineeringRevisions',revision),cloudState,plain({merge:false}));
    return cloudState;
  };

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
      ].map(([k,v])=>`<dt>${String(k)}</dt><dd>${String(v)}</dd>`).join('');
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
    try{
      setStatus('Managed REVEX Energy server: GeometryCo → compiled Baseline/Proposed OSM → OpenStudio/EnergyPlus → official Backstop COMcheck → EN-1…','busy');
      const job=await Store.runEnergyServer(id,revision),result=await Store.getEnergyResult(id);
      if(result)renderResult(result);
      const complete=String(result?.manifest?.status||job?.status||'').toUpperCase()==='COMPLETE';
      setStatus(complete?'Managed Energy package complete with compiled OSMs, official Backstop COMcheck report, and EN-1. Current project identity came from Revit Z pages; applicant and modeler remain blank.':(result?.manifest?.error||job?.message||'Managed Energy worker returned a reviewable result.'),complete?'good':'bad');
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
      void(async()=>{
        try{
          setStatus('Importing Engineering evidence…','busy');
          const source=await Store.syncEngineeringPackage(files,projectId());
          renderSource(source);
          await runManaged(source);
        }catch(error){setBadge('Engineering Sync rejected','blocked');setStatus(error?.message||'Engineering Sync could not be imported.','bad')}
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
