const Store = window.RevexStore;
const $ = (selector) => document.querySelector(selector);
const BUILD = '20260817r123-package-download1';
let sourceState = null;
let resultState = null;
let unsubscribeSource = () => {};
let unsubscribeResult = () => {};
let boundProject = '';

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
  const summary = $('#energy-source-summary');
  const facts = $('#energy-source-facts');
  const authorize = $('#energy-authorize-backstop');
  const manifest = sourceState?.manifest;
  if (!manifest) {
    setBadge('No current Engineering Sync', 'quiet');
    summary.innerHTML = 'In the active Revit document, click <b>SYNC PROJECT</b>.';
    facts.innerHTML = '';
    authorize.hidden = true;
    setRun('Waiting for active-document Engineering evidence that clears the ≥80% hard-stop gate.');
    return;
  }
  if (!evidenceBindingValid(manifest)) {
    const legacyRevision = sourceState?.revision || manifest?.revision || 'legacy revision';
    setBadge('Re-sync required', 'quiet');
    summary.innerHTML = `Stored revision <b>${esc(legacyRevision)}</b> predates the verified active-Revit-document evidence contract and cannot run downstream Energy.`;
    facts.innerHTML = '<dt>Required action</dt><dd>Open the authoritative Revit model and click SYNC PROJECT. REVEX will not run this stale revision as a substitute.</dd>';
    authorize.hidden = true;
    setRun('This stored Engineering revision is not bound to verified active-Revit-document evidence. Create a fresh aligned revision with SYNC PROJECT.', 'bad');
    return;
  }
  const ratios = Object.values(manifest.publicationIntegrity?.ratios || {}).map(Number).filter(Number.isFinite);
  const lowest = ratios.length ? Math.min(...ratios) : Number(manifest.publicationIntegrity?.lowestRatio || 0);
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
  artifacts.innerHTML = [...rows].sort((a,b)=>rank(a)-rank(b)||clean(a.name).localeCompare(clean(b.name))).map((row) => {
    const filing = complete && rank(row) === 1;
    const failureEvidence = !complete && isFailureEvidence(row);
    const label = failureEvidence ? 'Failure evidence' : filing ? 'Ready to insert later' : row.kind || 'Energy evidence';
    const body = `<span>${esc(row.reviewName || row.name || 'Artifact')}</span><small>${esc(label)}${row.bytes ? ` · ${size(row.bytes)}` : ''}</small>`;
    const url=clean(row.url),name=clean(row.reviewName||row.name||'REVEX-artifact');
    return url ? `<a class="energy-artifact${filing?' is-filing':''}" href="${esc(url)}" data-download-url="${esc(url)}" data-download-name="${esc(name)}" download="${esc(name)}" role="button" style="cursor:pointer;touch-action:manipulation">${body}</a>` : `<div class="energy-artifact${filing?' is-filing':''}">${body}</div>`;
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
  const row=event.target.closest?.('#energy-artifacts .energy-artifact[data-download-url]');
  if(!row)return;
  event.preventDefault();
  void downloadArtifact(row.dataset.downloadUrl,row.dataset.downloadName);
});

async function hydrate() {
  const id = projectId();
  if (!Store || !id) { sourceState=null; resultState=null; renderSource(); renderResult(); return; }
  const [source,result] = await Promise.allSettled([Store.getEngineeringState(id),Store.getEnergyResult(id)]);
  sourceState = source.status === 'fulfilled' ? source.value : null;
  resultState = result.status === 'fulfilled' ? result.value : null;
  renderSource();
  renderResult();
}

function subscribe() {
  const id = projectId();
  if (id === boundProject) return;
  unsubscribeSource(); unsubscribeResult();
  boundProject = id;
  if (!id) return hydrate();
  unsubscribeSource = Store.subscribeEngineeringState?.(id, (value) => { sourceState=value; renderSource(); }) || (()=>{});
  unsubscribeResult = Store.subscribeEnergyResult?.(id, (value) => { resultState=value; renderResult(); }) || (()=>{});
  hydrate().catch((error)=>setRun(error.message || 'Energy state could not load.','bad'));
}

window.addEventListener('revex:energy-open', subscribe);
window.addEventListener('revex:authoritative-project-bound', subscribe);
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
