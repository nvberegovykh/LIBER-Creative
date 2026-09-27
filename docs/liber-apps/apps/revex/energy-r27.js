const Store = window.RevexStore;
const $ = (selector) => document.querySelector(selector);
const BUILD = '20260817r123-package-download1';
let sourceState = null;
let resultState = null;
let unsubscribeSource = () => {};
let unsubscribeResult = () => {};
let boundProject = '';
let sourceError='',resultError='',hydration=0,previewRows=[];
let importSequence=0;
const refresh=document.createElement('button');refresh.id='energy-refresh';refresh.type='button';refresh.className='button ghost';refresh.textContent='Refresh Energy';
const warning=document.createElement('p');warning.id='energy-read-error';warning.setAttribute('role','status');warning.hidden=true;
$('#view-energy')?.prepend(warning);$('#view-energy')?.prepend(refresh);
refresh.addEventListener('click',()=>void hydrate());
function readWarning(){warning.hidden=!sourceError&&!resultError;warning.textContent=[sourceError&&`Engineering evidence could not refresh: ${sourceError}`,resultError&&`Energy results could not refresh: ${resultError}`].filter(Boolean).join(' · ')+(sourceError||resultError?' Use Refresh Energy to retry. Any previous result remains visible.':'');}

const clean = (value) => String(value ?? '').trim();
const state = () => window.__revexState || {};
const projectId = () => clean(state().projectId || new URLSearchParams(location.search).get('projectId'));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const size = (value) => { const n=Number(value||0); return !n?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`; };
const evidenceBindingValid = (manifest) => {
  const binding = manifest?.projectBinding || {};
  return clean(binding.version) === 'active-revit-evidence-v1' &&
    Boolean(clean(binding.identityEvidenceDigest)) && Boolean(clean(binding.documentUniqueId));
};

function setRun(message, tone = '') {
  const node = $('#energy-run-status');
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
}

function setBadge(text, tone = 'quiet') {
  const node = $('#energy-source-badge');
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

function renderSource() {
  if($('#energy-project-gate'))$('#energy-project-gate').hidden=Boolean(projectId());
  const summary = $('#energy-source-summary');
  const facts = $('#energy-source-facts');
  const authorize = $('#energy-authorize-backstop');
  const manifest = sourceState?.manifest;
  if (!manifest) {
    if(sourceError){setBadge('Evidence unavailable','quiet');summary.textContent='The current evidence could not be read.';facts.innerHTML='';authorize.hidden=true;return;}
    setBadge('No current Engineering Sync', 'quiet');
    summary.innerHTML = 'In the active Revit document, click <b>SYNC ENGINEERING</b>.';
    facts.innerHTML = '';
    authorize.hidden = true;
    setRun('Waiting for active-document Engineering evidence that clears the ≥80% hard-stop gate.');
    return;
  }
  if (!evidenceBindingValid(manifest)) {
    const legacyRevision = sourceState?.revision || manifest?.revision || 'legacy revision';
    setBadge('Re-sync required', 'quiet');
    summary.innerHTML = `Stored revision <b>${esc(legacyRevision)}</b> predates the verified active-Revit-document evidence contract and cannot run downstream Energy.`;
    facts.innerHTML = '<dt>Required action</dt><dd>Open the authoritative Revit model and click SYNC ENGINEERING. REVEX will not run this stale revision as a substitute.</dd>';
    authorize.hidden = true;
    setRun('This stored Engineering revision is not bound to verified active-Revit-document evidence. Create a fresh SYNC ENGINEERING revision.', 'bad');
    return;
  }
  const ratios = Object.values(manifest.publicationIntegrity?.ratios || {}).map(Number);
  if(manifest.gbxmlStatus!=='EXPORTED'||!(Number(manifest.publicationIntegrity?.threshold)>=.8)||!(Number(manifest.publicationIntegrity?.qualityTarget)>=.95)||!ratios.length||ratios.some(value=>!Number.isFinite(value)||value<.8||value>1)){
    setBadge('Evidence needs repair','blocked');summary.textContent='This revision does not satisfy every required evidence check. Re-sync the active Revit model after resolving its export diagnostics.';facts.replaceChildren();authorize.hidden=true;setRun('Energy processing is blocked for this evidence revision.','bad');return;
  }
  const lowest = Math.min(...ratios);
  const belowQuality = lowest < .95;
  setBadge(belowQuality ? 'Evidence ready · review flag' : 'Evidence ready', belowQuality ? 'quiet' : 'ready');
  summary.textContent = belowQuality
    ? 'Immutable active-Revit evidence passed the 80% hard stop; managed processing may continue, with sub-95% evidence explicitly flagged for review.'
    : 'Immutable active-Revit evidence passed the hard stop and 95% review-quality target.';
  const binding = manifest.projectBinding || {};
  const digest = clean(binding.identityEvidenceDigest);
  const rows = [
    ['Revision', sourceState.revision || manifest.revision],
    ['Model', manifest.sourceModel?.title || '—'],
    ['Project', sourceState.projectId || manifest.projectId || '—'],
    ['Identity evidence', `Active Revit T/Z/title pages · ${digest ? `${digest.slice(0,16)}…` : '—'}`],
    ['Engine', manifest.engine || '—'],
    ['Integrity hard stop', '≥80.0% in every evidence domain'],
    ['Quality target', '≥95.0% · warning below this level'],
    ['Lowest integrity', lowest ? `${(lowest*100).toFixed(1)}%` : '—'],
    ['Weather file (.EPW)', manifest.weather?.sourceFile || manifest.weather?.file || '—'],
    ['Weather location', [manifest.weather?.city, manifest.weather?.stateProvince, manifest.weather?.country].filter(Boolean).join(', ') || '—'],
    ['Revit writes', 'Spaces · EADM · EN/Energy tags'],
    ['Post-export writeback', 'None']
  ];
  facts.innerHTML = rows.map(([key,value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
  authorize.hidden = false;
}

function isFailureEvidence(row) {
  const name = clean(row?.name);
  return clean(row?.kind).toLowerCase() === 'diagnostic' ||
    /02_GEOMETRYCO\.log|FAILURE_(?:REPORT\.json|SUMMARY\.txt)|REVEX-ENERGY-PIPELINE\.jsonl|NATIVE_CHECK_|eplusout\.err|REVEX_OPENSTUDIO_RUN\.log/i.test(name);
}

function renderResult() {
  const summary = $('#energy-result-summary');
  const artifacts = $('#energy-artifacts');
  const manifest = resultState?.manifest;
  if (!manifest) {
    if(resultError){summary.textContent='Energy results could not be read.';artifacts.innerHTML='<div class="energy-empty">Refresh to retry loading the current result.</div>';return;}
    summary.textContent = 'No result yet.';
    artifacts.innerHTML = '<div class="energy-empty">The current revision’s OSMs, simulations, COMcheck/CXL, PRM review package, and EN-1 will appear here.</div>';
    return;
  }
  const complete = clean(manifest.status).toUpperCase() === 'COMPLETE';
  const failedStage = clean(manifest.failureContext?.failedStage);
  summary.textContent = complete
    ? `${manifest.resultRevision || resultState.revision} completed from Engineering revision ${manifest.sourceEngineeringRevision || manifest.sourceRevision || '—'}.`
    : `${manifest.status || 'BLOCKED'}${failedStage ? ` at ${failedStage}` : ''}: ${manifest.error || 'Failure evidence is preserved below.'}`;
  const allRows = Array.isArray(resultState.artifacts) ? resultState.artifacts : [];
  // COMPLETE results expose only the clean user-facing contract. CXL, COMcheck engine JSON,
  // and other integrity evidence remain in the immutable result but are intentionally hidden.
  // Failed runs keep diagnostic rows visible regardless of userVisible so exact failures remain inspectable.
  const rows = complete ? allRows.filter((row) => row?.userVisible !== false) : allRows;
  const rank = (row) => {
    if (!complete && isFailureEvidence(row)) return 0;
    if (/EN-1_READY_TO_INSERT\.pdf|COMcheck_READY_TO_INSERT\.pdf/i.test(row.name||'')) return 1;
    if (/\.pdf$/i.test(row.name||'')) return 2;
    if (/\.osm$/i.test(row.name||'')) return 3;
    return 4;
  };
  previewRows = [...rows].sort((a,b)=>rank(a)-rank(b)||clean(a.name).localeCompare(clean(b.name)));
  artifacts.innerHTML = previewRows.map((row,index) => {
    const filing = complete && rank(row) === 1;
    const failureEvidence = !complete && isFailureEvidence(row);
    const label = failureEvidence ? 'Failure evidence' : filing ? 'Ready to insert later' : row.kind || 'Energy evidence';
    const body = `<span>${esc(row.reviewName || row.name || 'Artifact')}</span><small>${esc(label)}${row.bytes ? ` · ${size(row.bytes)}` : ''}</small>`;
    const url=clean(row.url),name=clean(row.reviewName||row.name||'REVEX-artifact');
    return url ? `<div class="energy-artifact-row"><a class="energy-artifact${filing?' is-filing':''}" href="${esc(url)}" data-download-url="${esc(url)}" data-download-name="${esc(name)}" download="${esc(name)}" style="cursor:pointer;touch-action:manipulation">${body}<small>Download</small></a>${/\.(pdf|png|jpe?g|webp|txt|json|csv|log|err|xml|md)$/i.test(name)?`<button class="button ghost" type="button" data-energy-preview="${index}">View</button>`:''}</div>` : `<div class="energy-artifact${filing?' is-filing':''}">${body}</div>`;
  }).join('') || '<div class="energy-empty">The result manifest contains no downloadable artifact index.</div>';
}

async function downloadArtifact(url,name){
  if(!url)return;
  try{
    const response=await fetch(url,{cache:'no-store',credentials:'omit'});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const blob=await response.blob(),objectUrl=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=objectUrl;a.download=name||'REVEX-artifact';a.style.display='none';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
  }catch(_){
    const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener';document.body.appendChild(a);a.click();a.remove();
  }
}

document.addEventListener('click',(event)=>{
  const preview=event.target.closest?.('[data-energy-preview]');
  if(preview){
    const artifact=previewRows[Number(preview.dataset.energyPreview)];if(!artifact?.url)return;
    let dialog=$('#energy-preview-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='energy-preview-dialog';dialog.className='energy-preview-dialog';dialog.innerHTML='<header><strong id="energy-preview-title"></strong><button type="button" class="button ghost" id="energy-preview-close">Close</button></header><iframe id="energy-preview-frame" title="Energy document viewer"></iframe>';document.body.append(dialog);$('#energy-preview-close').onclick=()=>dialog.close();}
    $('#energy-preview-title').textContent=artifact.reviewName||artifact.name||'Energy document';dialog.showModal();
    window.__revexDocumentViewer.show($('#energy-preview-frame'),{url:artifact.url,file:{...artifact,id:artifact.storagePath||artifact.name,mimeType:artifact.mimeType}});return;
  }
  const row=event.target.closest?.('#energy-artifacts .energy-artifact[data-download-url]');
  if(!row)return;
  event.preventDefault();
  void downloadArtifact(row.dataset.downloadUrl,row.dataset.downloadName);
});

function resetProjectBoundary() {
  ++importSequence;
  if($('#energy-import-package'))$('#energy-import-package').disabled=false;
  ++hydration;sourceError='';resultError='';previewRows=[];readWarning();
  unsubscribeSource(); unsubscribeResult();
  unsubscribeSource = () => {}; unsubscribeResult = () => {};
  boundProject = ''; sourceState = null; resultState = null;
  renderSource(); renderResult();
}

const importButton=$('#energy-import-package'),importInput=$('#revex-energy-sync-upload');
if(window.chrome?.webview){if(importButton)importButton.hidden=true;if($('#energy-import-help'))$('#energy-import-help').hidden=true;}
else if(importButton&&importInput){
  importButton.addEventListener('click',()=>importInput.click());
  importInput.addEventListener('change',async()=>{
    const files=Array.from(importInput.files||[]);if(!files.length)return;
    const sequence=++importSequence,id=projectId(),uid=Store.user?.uid;
    const current=()=>sequence===importSequence&&id===projectId()&&uid===Store.user?.uid;
    importButton.disabled=true;
    try{
      if(!id)throw new Error('Choose the project that owns this Engineering export.');
      setRun('Verifying and importing Engineering evidence…','busy');
      const imported=await Store.syncEngineeringPackage(files,id);if(!current())return;
      sourceState=imported;sourceError='';renderSource();
      if(!imported.cloud){setRun('Evidence is available locally. Sign in and import it to run managed Energy.');return;}
      const replay=window.__revexHostedEnergyReplayR95;
      if(!replay?.runHosted)throw new Error('The Energy controller is still loading. Reload, then use Authorize & run on this preserved revision.');
      importButton.disabled=false;
      await replay.runHosted({auto:false});
    }catch(error){if(current()){setRun(error.message||'Engineering import failed. Retry with the complete package.','bad');if(!sourceState)setBadge('Engineering Sync rejected','blocked');}}
    finally{if(current()){importButton.disabled=false;importInput.value='';}}
  });
}

async function hydrate() {
  const run=++hydration;refresh.disabled=true;
  const id = projectId();
  if (!Store || !id) { sourceState=null; resultState=null; renderSource(); renderResult();refresh.disabled=false; return; }
  const [source,result] = await Promise.allSettled([Store.getEngineeringState(id),Store.getEnergyResult(id)]);
  if(run!==hydration)return;refresh.disabled=false;
  if (projectId() !== id || (boundProject && boundProject !== id)) return;
  sourceError=source.status==='rejected'?source.reason?.message||'Connection failed':'';
  resultError=result.status==='rejected'?result.reason?.message||'Connection failed':'';
  if(source.status==='fulfilled')sourceState=source.value;
  if(result.status==='fulfilled')resultState=result.value;
  readWarning();
  renderSource();
  renderResult();
}

function subscribe() {
  const id = projectId();
  if (id === boundProject) return;
  unsubscribeSource(); unsubscribeResult();
  boundProject = id;
  if (!id) return hydrate();
  const current = () => id === boundProject && id === projectId();
  unsubscribeSource = Store.subscribeEngineeringState?.(id, (value) => { if(!current())return;sourceState=value;sourceError='';readWarning(); renderSource(); },error=>{if(current()){sourceError=error.message||'Connection failed';readWarning();renderSource();}}) || (()=>{});
  unsubscribeResult = Store.subscribeEnergyResult?.(id, (value) => { if(!current())return;resultState=value;resultError='';readWarning(); renderResult(); },error=>{if(current()){resultError=error.message||'Connection failed';readWarning();renderResult();}}) || (()=>{});
  hydrate().catch((error)=>setRun(error.message || 'Energy state could not load.','bad'));
}

window.addEventListener('revex:energy-open', subscribe);
window.addEventListener('revex:authoritative-project-bound', subscribe);
window.addEventListener('revex:project-boundary', resetProjectBoundary);
window.addEventListener('revex:managed-energy-status', (event) => {
  const detail = event.detail || {};
  if (detail.projectId && detail.projectId !== projectId()) return;
  setRun(detail.message || detail.stage || 'Managed Energy update', detail.ok ? 'good' : (detail.stage === 'BROKER_FAILED' ? 'bad' : 'busy'));
  if (detail.stage === 'CLOUD_UPLOAD_PASSED' || detail.stage === 'BROKER_FAILED') hydrate();
});
window.addEventListener('revex:managed-energy-result', (event) => {
  if (event.detail?.projectId !== projectId()) return;
  resultState = event.detail.result;
  renderResult();
});
$('#project-select')?.addEventListener('change', () => { boundProject=''; setTimeout(subscribe,0); });

renderSource();
renderResult();
if (!$('#view-energy')?.hidden) subscribe();
console.info('[REVEX] Energy UI', { build: BUILD, execution: 'private-worker-authenticated-broker', consent: 'per-immutable-revision', staleEvidenceRuns: 'blocked', failureEvidence: 'preserved-and-ranked', completeUserOutput: 'exact-nine-visible' });
