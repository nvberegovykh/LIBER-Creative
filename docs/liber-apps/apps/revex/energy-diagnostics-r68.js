(function(root){
  'use strict';
  const BUILD='20260816r95-manual-identity1';
  const failureName=/02_GEOMETRYCO\.log|FAILURE_(?:REPORT\.json|SUMMARY\.txt)|REVEX-ENERGY-PIPELINE\.jsonl|NATIVE_CHECK_|eplusout\.err|REVEX_OPENSTUDIO_RUN\.log/i;
  const clean=v=>String(v??'').trim();
  const esc=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const state=()=>root.__revexState||{};
  const projectId=()=>clean(state().projectId||new URLSearchParams(location.search).get('projectId'));
  let running=false,lastStaleSig='',lastHistoricalSig='',managedStage='',managedRevision='';
  const requiredIdentityFallback=new Set();
  let identitySubmitGuardInstalled=false;
  const identityFieldIds={title:'energy-identity-title',address:'energy-identity-address',city:'energy-identity-city',state:'energy-identity-state',zip:'energy-identity-zip'};

  function Store(){return root.RevexStore;}
  function diagnostic(level,stage,message,detail={}){
    try{root.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'energy diagnostics r95',...detail});}catch(_){}
  }
  async function artifactUrl(row){
    if(row?.url)return row.url;
    const store=Store();
    if(row?.storagePath&&store?.fileUrl)return store.fileUrl(row.storagePath);
    if(row?.path&&store?.fileUrl)return store.fileUrl(row.path);
    return null;
  }
  function sourceRevisionOf(result){
    const m=result?.manifest||{};
    return clean(m.sourceEngineeringRevision||m.sourceRevision||m.engineeringRevision||result?.sourceRevision);
  }
  function currentRevisionOf(source){return clean(source?.revision||source?.manifest?.revision);}
  function exactErrorFromText(text){
    const lines=String(text||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
    const preferred=[...lines].reverse().find(line=>/^ERROR\s*:/i.test(line)||/CompileError|PipelineError|ValidationError|native check failed|ambiguous|could not|cannot|missing|mismatch/i.test(line));
    return (preferred||lines.at(-1)||'').replace(/^ERROR\s*:\s*/i,'').slice(0,900);
  }
  function ensureBox(){
    const host=document.getElementById('energy-artifacts');
    if(!host)return null;
    let box=document.getElementById('energy-exact-failure');
    if(!box){box=document.createElement('section');box.id='energy-exact-failure';box.className='energy-exact-failure';host.insertAdjacentElement('beforebegin',box);}
    return box;
  }

  function ensureIdentityOverrideFields(){
    const dialog=document.getElementById('energy-consent-dialog');
    const form=dialog?.querySelector('form');
    if(!dialog||!form)return;
    if(!document.getElementById('energy-identity-override')){
      const block=document.createElement('fieldset');
      block.id='energy-identity-override';
      block.style.cssText='margin:14px 0 10px;padding:12px;border:1px solid rgba(255,255,255,.14);border-radius:9px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px 10px';
      block.innerHTML=`<legend style="padding:0 6px">Project identity fallback</legend>
        <div style="grid-column:1/-1;font-size:12px;opacity:.72">Only fill what REVEX failed to resolve. These values are revision-scoped and may fill missing project identity fields only; they cannot overwrite identity already established by active-Revit evidence.</div>
        <label style="display:grid;gap:4px"><span>Project title</span><input id="energy-identity-title" autocomplete="off" placeholder="leave blank if already correct"></label>
        <label style="display:grid;gap:4px"><span>Street address</span><input id="energy-identity-address" autocomplete="street-address" placeholder="leave blank if already correct"></label>
        <label style="display:grid;gap:4px"><span>City / borough</span><input id="energy-identity-city" autocomplete="address-level2" placeholder="e.g. Brooklyn"></label>
        <label style="display:grid;gap:4px"><span>State</span><input id="energy-identity-state" autocomplete="address-level1" maxlength="32" placeholder="NY"></label>
        <label style="display:grid;gap:4px"><span>ZIP</span><input id="energy-identity-zip" inputmode="numeric" autocomplete="postal-code" maxlength="10" placeholder="11225"></label>`;
      const note=form.querySelector('.energy-consent-note');
      if(note)note.insertAdjacentElement('beforebegin',block);else form.appendChild(block);
      diagnostic('INFO','ENERGY_IDENTITY_FALLBACK_READY','Revision-scoped manual project identity fallback is available in the COMcheck authorization dialog.');
    }
    renderRequiredIdentityNote();
  }
  function collectIdentityOverride(){
    const out={};
    for(const [key,id] of Object.entries(identityFieldIds)){
      let value=clean(document.getElementById(id)?.value).replace(/\s+/g,' ');
      if(!value)continue;
      if(key==='state')value=value.toUpperCase();
      out[key]=value.slice(0,key==='zip'?10:200);
    }
    return out;
  }
  function renderRequiredIdentityNote(){
    const block=document.getElementById('energy-identity-override');
    if(!block)return;
    let note=document.getElementById('energy-identity-required-note');
    if(!requiredIdentityFallback.size){if(note)note.remove();return;}
    if(!note){note=document.createElement('div');note.id='energy-identity-required-note';note.style.cssText='grid-column:1/-1;padding:8px 10px;border-radius:7px;background:rgba(255,71,119,.12);font-size:12px';block.appendChild(note);}
    note.textContent=`Required to recover this published revision: ${[...requiredIdentityFallback].join(', ')}. The authorization form will not close until these fields are entered.`;
  }
  function updateRequiredIdentityFallback(message){
    const match=clean(message).match(/project identity is incomplete[^:]*:\s*([^\n]+)/i);
    if(!match)return;
    const allowed=new Set(Object.keys(identityFieldIds));
    const next=match[1].split(',').map(value=>clean(value).toLowerCase()).filter(value=>allowed.has(value));
    if(!next.length)return;
    requiredIdentityFallback.clear();next.forEach(value=>requiredIdentityFallback.add(value));
    ensureIdentityOverrideFields();renderRequiredIdentityNote();
  }
  function ensureIdentitySubmitGuard(){
    if(identitySubmitGuardInstalled)return;
    const form=document.getElementById('energy-consent-dialog')?.querySelector('form');
    if(!form)return;
    identitySubmitGuardInstalled=true;
    form.addEventListener('submit',event=>{
      if(event.submitter?.value!=='approve'||!requiredIdentityFallback.size)return;
      const missing=[...requiredIdentityFallback].filter(key=>!clean(document.getElementById(identityFieldIds[key])?.value));
      if(!missing.length)return;
      event.preventDefault();
      document.getElementById(identityFieldIds[missing[0]])?.focus?.();
      renderRequiredIdentityNote();
      diagnostic('WARN','ENERGY_IDENTITY_FALLBACK_REQUIRED',`Authorization remains open until required project identity is supplied: ${missing.join(', ')}`,{missing});
    },true);
  }
  function consentRevisionId(value){return clean(value).replace(/[^a-zA-Z0-9._-]+/g,'_').slice(0,120).replace(/\./g,'_');}
  function installConsentIdentityPersistence(){
    const store=Store();
    if(!store?.recordEnergyConsent||store.recordEnergyConsent.__revexIdentityFallbackR89)return;
    const original=store.recordEnergyConsent.bind(store);
    const wrapped=async function(projectId,sourceRevision){
      const consent=await original(projectId,sourceRevision);
      const identityOverride=collectIdentityOverride();
      if(!Object.keys(identityOverride).length)return consent;
      if(identityOverride.zip&&!/^\d{5}(?:-\d{4})?$/.test(identityOverride.zip))throw new Error('Project identity ZIP must be 5 digits or ZIP+4.');
      if(identityOverride.state&&!/^[A-Z][A-Z .-]{1,31}$/.test(identityOverride.state))throw new Error('Project identity state is invalid.');
      const revision=consentRevisionId(sourceRevision),uid=clean(store.user?.uid);
      if(!store.isCloud?.()||!store.api?.doc||!store.api?.setDoc||!store.db||!uid||!projectId||!revision)throw new Error('REVEX cloud session is required to attach the identity fallback to this authorization.');
      const ref=store.api.doc(store.db,'projects',projectId,'revexEnergyConsents',revision,'approvers',uid);
      const patch=store.toFirestorePlain?store.toFirestorePlain({
        projectIdentityOverride:identityOverride,
        projectIdentityOverrideAuthority:'explicit-user-input-during-revision-scoped-comcheck-authorization',
        projectIdentityOverrideRecordedAt:new Date().toISOString()
      }):{
        projectIdentityOverride:identityOverride,
        projectIdentityOverrideAuthority:'explicit-user-input-during-revision-scoped-comcheck-authorization',
        projectIdentityOverrideRecordedAt:new Date().toISOString()
      };
      const options=store.toFirestorePlain?store.toFirestorePlain({merge:true}):{merge:true};
      await store.api.setDoc(ref,patch,options);
      diagnostic('INFO','ENERGY_IDENTITY_FALLBACK_RECORDED','Manual project identity fallback was attached to this immutable Engineering revision.',{projectId,revision,fields:Object.keys(identityOverride)});
      return {...consent,...patch};
    };
    wrapped.__revexIdentityFallbackR89=true;
    wrapped.__revexOriginal=original;
    store.recordEnergyConsent=wrapped;
  }

  function setRetryPolicy(source,result){
    const button=document.getElementById('energy-authorize-backstop');
    if(!button)return;
    const current=currentRevisionOf(source),failedRevision=sourceRevisionOf(result);
    const failed=clean(result?.manifest?.status).toUpperCase()==='FAILED';
    const same=failed&&current&&failedRevision&&failedRevision===current;
    button.disabled=false;
    if(same){
      button.textContent='Retry this published revision';
      button.title='Re-run this immutable Engineering revision after a server-side repair. Revit evidence is reused exactly; no Revit export or re-sync is started.';
      button.dataset.revexReplay='published-revision';
    }else{
      button.textContent='Authorize this revision';
      button.removeAttribute('title');
      delete button.dataset.revexReplay;
    }
  }
  function clearStaleFailureUi(current,failedRevision,box){
    box.hidden=true;box.innerHTML='';requiredIdentityFallback.clear();renderRequiredIdentityNote();
    const run=document.getElementById('energy-run-status');
    if(run&&run.dataset.tone==='bad'){
      run.textContent=current?`Current Engineering revision ${current} is ready for managed processing.`:'Current Engineering revision is ready for managed processing.';
      run.dataset.tone='quiet';
    }
    const sig=`${current}|${failedRevision}`;
    if(sig!==lastStaleSig){
      lastStaleSig=sig;
      diagnostic('INFO','ENERGY_STALE_FAILURE_IGNORED','An older Energy failure was not shown as the status of the current Engineering revision.',{currentRevision:current,failedRevision});
    }
  }
  function replayOwnsRevision(current){
    if(!current||managedRevision!==current)return false;
    return ['CONSENT_REQUIRED','CONSENT_RECORDED','BROKER_RUNNING','BROKER_STARTING','BROKER_PASSED','RESULT_WAIT','CLOUD_UPLOAD_PASSED','BROKER_JOB'].includes(managedStage);
  }
  function hidePreviousFailureDuringReplay(current,box){
    box.hidden=true;box.innerHTML='';
    const run=document.getElementById('energy-run-status');
    if(run&&run.dataset.tone==='bad')run.dataset.tone='quiet';
    const sig=`${current}|${managedStage}`;
    if(sig!==lastHistoricalSig){
      lastHistoricalSig=sig;
      diagnostic('INFO','ENERGY_PREVIOUS_FAILURE_SUPPRESSED','The previous failed attempt is suppressed while this published revision is being replayed.',{currentRevision:current,managedStage});
    }
  }
  async function inspect(mode='historical'){
    if(running)return;
    const id=projectId(),store=Store();
    if(!id||!store?.getEnergyResult||!store?.getEngineeringState)return;
    running=true;
    try{
      const [source,result]=await Promise.all([store.getEngineeringState(id),store.getEnergyResult(id)]);
      setRetryPolicy(source,result);
      const current=currentRevisionOf(source),failedRevision=sourceRevisionOf(result);
      const status=clean(result?.manifest?.status).toUpperCase();
      const box=ensureBox();
      if(!box)return;
      if(status==='FAILED'&&current&&failedRevision&&failedRevision!==current){clearStaleFailureUi(current,failedRevision,box);return;}
      if(status!=='FAILED'){box.hidden=true;box.innerHTML='';requiredIdentityFallback.clear();renderRequiredIdentityNote();return;}
      if(replayOwnsRevision(current)&&mode!=='current-failure'){hidePreviousFailureDuringReplay(current,box);return;}
      const rows=(Array.isArray(result?.artifacts)?result.artifacts:[]).filter(row=>failureName.test(clean(row?.name))||clean(row?.kind).toLowerCase()==='diagnostic');
      const geometry=rows.find(row=>/02_GEOMETRYCO\.log/i.test(clean(row?.name)))||null;
      const links=[];
      for(const row of rows.slice(0,10)){
        const url=await artifactUrl(row).catch(()=>null);
        if(url)links.push(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(row.name||'failure evidence')}</a>`);
      }
      let exact=clean(result?.manifest?.error||'Energy worker failed.');
      if(geometry){
        try{
          const url=await artifactUrl(geometry);
          if(url){const response=await fetch(url,{cache:'no-store'});if(response.ok){const text=await response.text();const parsed=exactErrorFromText(text);if(parsed)exact=parsed;}}
        }catch(error){diagnostic('WARN','ENERGY_FAILURE_LOG_READ',error?.message||String(error));}
      }
      const currentFailure=mode==='current-failure';
      if(currentFailure||sameCurrentFailure(source,result))updateRequiredIdentityFallback(exact);
      ensureIdentitySubmitGuard();
      box.hidden=false;
      box.innerHTML=`<div class="eyebrow">${currentFailure?'EXACT WORKER FAILURE':'PREVIOUS ATTEMPT FAILURE'}</div><strong>${esc(result?.manifest?.failureContext?.failedStage||'Energy pipeline')}</strong><p>${esc(exact)}</p>${links.length?`<div class="energy-exact-failure-links">${links.join('')}</div>`:''}<small>${currentFailure?'This failure was returned by the current replay.':'This is preserved evidence from the previous attempt; it is not a new failure on page load.'} Immutable Engineering revision ${esc(failedRevision||'—')} can be replayed without regenerating Revit evidence.</small>`;
      const run=document.getElementById('energy-run-status');
      if(run&&exact){
        if(currentFailure){run.textContent=`${result?.manifest?.failureContext?.failedStage||'Energy'}: ${exact}`;run.dataset.tone='bad';}
        else if(run.dataset.tone==='bad'){run.textContent='Previous attempt failed. Retry published revision to run the repaired server chain.';run.dataset.tone='quiet';}
      }
      if(currentFailure){diagnostic('ERROR','ENERGY_EXACT_FAILURE',exact,{projectId:id,revision:failedRevision,artifactCount:rows.length,replayable:sameCurrentFailure(source,result)});}
      else{const sig=`${failedRevision}|${exact}`;if(sig!==lastHistoricalSig){lastHistoricalSig=sig;diagnostic('INFO','ENERGY_PREVIOUS_FAILURE_AVAILABLE','Preserved failure evidence from the previous attempt is available; no new worker failure occurred on page load.',{projectId:id,revision:failedRevision,artifactCount:rows.length});}}
    }catch(error){diagnostic('WARN','ENERGY_DIAGNOSTICS',error?.message||String(error));}
    finally{running=false;}
  }
  function sameCurrentFailure(source,result){
    const current=currentRevisionOf(source),failedRevision=sourceRevisionOf(result);
    return clean(result?.manifest?.status).toUpperCase()==='FAILED'&&!!current&&current===failedRevision;
  }
  function install(){
    if(root.__revexEnergyDiagnosticsR68)return;
    ensureIdentityOverrideFields();installConsentIdentityPersistence();ensureIdentitySubmitGuard();
    root.__revexEnergyDiagnosticsR68={build:BUILD,inspect,requiredIdentityFallback};
    root.addEventListener('revex:energy-open',()=>setTimeout(()=>inspect('historical'),0));
    root.addEventListener('revex:managed-energy-status',event=>{
      const stage=clean(event.detail?.stage).toUpperCase(),revision=clean(event.detail?.revision);
      if(stage)managedStage=stage;if(revision)managedRevision=revision;
      if(stage==='CONSENT_REQUIRED'){ensureIdentityOverrideFields();installConsentIdentityPersistence();ensureIdentitySubmitGuard();}
      if(stage==='BROKER_FAILED'){updateRequiredIdentityFallback(event.detail?.message||'');setTimeout(()=>inspect('current-failure'),250);}
      else if(['BROKER_RUNNING','BROKER_STARTING','BROKER_JOB','BROKER_PASSED','RESULT_WAIT','CLOUD_UPLOAD_PASSED','CONSENT_REQUIRED','CONSENT_RECORDED'].includes(stage))setTimeout(()=>inspect('historical'),150);
    });
    root.addEventListener('revex:managed-energy-result',()=>setTimeout(()=>inspect(managedStage==='BROKER_FAILED'?'current-failure':'historical'),0));
    root.addEventListener('revex:source-revision-loaded',()=>setTimeout(()=>inspect('historical'),0));
    if(!document.getElementById('view-energy')?.hidden)setTimeout(()=>inspect('historical'),0);
  }
  const wait=()=>{if(Store()&&root.__revexState){install();return;}setTimeout(wait,50);};
  wait();
})(window);
