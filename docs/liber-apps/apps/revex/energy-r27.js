import './energy-contract-r40.js?v=20260812r40';
import './revex-r41-live.js?v=20260812r41';

const Store = window.RevexStore;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let sourceState = null;
let resultState = null;
let sourceBusy = false;
let resultBusy = false;
let serverBusy = false;
let lastSourceRevision = '';
let lastResultRevision = '';
const ENERGY_HARD_STOP = 0.80;
const ENERGY_QUALITY_TARGET = 0.95;

function state() { return window.__revexState || {}; }
function projectId() { return String(state().projectId || new URLSearchParams(location.search).get('projectId') || '').trim(); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function bytes(value) {
  const size = Number(value || 0);
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
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
function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
}
function integrityState(manifest) {
  const publication = manifest?.publicationIntegrity || {};
  const ratios = Object.entries(publication.ratios || {})
    .map(([key, value]) => [key, Number(value)])
    .filter(([, value]) => Number.isFinite(value));
  const hardStop = Number(publication.threshold || ENERGY_HARD_STOP);
  const qualityTarget = Number(publication.qualityTarget || Math.max(hardStop, ENERGY_QUALITY_TARGET));
  const lowest = ratios.length ? Math.min(...ratios.map(([, value]) => value)) : NaN;
  const belowQuality = ratios.filter(([, value]) => value < qualityTarget);
  return { ratios, hardStop, qualityTarget, lowest, belowQuality };
}

function renderSource() {
  const summary = $('#energy-source-summary');
  const facts = $('#energy-source-facts');
  const gate = $('#energy-project-gate');
  const id = projectId();
  if (gate) gate.hidden = Boolean(id);
  if (!id) {
    sourceState = null;
    setBadge('Choose project', 'quiet');
    summary.innerHTML = 'Create or choose the same REVEX project used by Design. Then click <b>SYNC ENGINEERING</b> in Revit; the full downstream Energy chain runs automatically after the ≥80% hard-stop gate. Results below 95% continue with a visible quality warning; sub-80% evidence is preserved for repair and is not published.';
    facts.innerHTML = '';
    setRun('Choose or create a REVEX project to begin Engineering Sync.');
    return;
  }
  if (!sourceState?.manifest) {
    setBadge('Ready for Engineering Sync', 'quiet');
    summary.innerHTML = 'Project connected. In Revit Engineering, click <b>SYNC ENGINEERING</b>. Revit evidence will attach here automatically and the downstream pipeline will continue without a second button.';
    facts.innerHTML = '';
    setRun('Waiting for an Engineering Sync revision that clears the ≥80% hard-stop gate. Results below 95% will be flagged for review.');
    return;
  }
  const manifest = sourceState.manifest;
  const integrity = integrityState(manifest);
  const exported = manifest.gbxmlStatus === 'EXPORTED';
  const publishable = exported &&
    integrity.hardStop >= ENERGY_HARD_STOP &&
    integrity.qualityTarget >= ENERGY_QUALITY_TARGET &&
    integrity.ratios.length > 0 &&
    integrity.ratios.every(([, value]) => value >= ENERGY_HARD_STOP);
  const reviewRequired = publishable && integrity.belowQuality.length > 0;
  setBadge(
    publishable ? (reviewRequired ? `Evidence ${pct(integrity.lowest)} · review` : 'Evidence ready') : `Diagnostic ${pct(integrity.lowest)} · not published`,
    publishable ? (reviewRequired ? 'quiet' : 'ready') : 'blocked'
  );
  summary.textContent = !publishable
    ? `Engineering evidence is preserved for repair, but it does not clear the ≥${pct(ENERGY_HARD_STOP)} hard-stop gate in every evidence domain. It is not published and managed processing will not start.`
    : reviewRequired
      ? `Immutable Engineering evidence passed the ${pct(integrity.hardStop)} hard stop, but ${integrity.belowQuality.length} evidence domain(s) are below the ${pct(integrity.qualityTarget)} quality target. Managed processing continues; review this quality warning.`
      : 'Immutable Engineering evidence and Weather file (.EPW) are attached. Revit writes are finished; downstream GeometryCo/EnergyPlus work has no RVT return path.';
  const weather = manifest.weather || {};
  const weatherLocation = [weather.city, weather.stateProvince, weather.country].filter(Boolean).join(', ') || '—';
  const belowQualityText = integrity.belowQuality.length
    ? integrity.belowQuality.map(([key, value]) => `${key}: ${pct(value)}`).join(' · ')
    : 'None';
  const rows = [
    ['Revision', sourceState.revision || manifest.revision],
    ['Model', manifest.sourceModel?.title || '—'],
    ['Engine', manifest.engine || '—'],
    ['Architecture', manifest.architecture || '—'],
    ['Integrity hard stop', `≥${pct(integrity.hardStop)} in every evidence domain`],
    ['Quality target', `≥${pct(integrity.qualityTarget)} · warning below this level`],
    ['Lowest integrity', pct(integrity.lowest)],
    ['Below quality target', belowQualityText],
    ['Weather file (.EPW)', weather.sourceFile || weather.file || '—'],
    ['Weather location', weatherLocation],
    ['Revit writes', 'Spaces · EADM · EN/Energy tags'],
    ['Post-export writeback', 'None']
  ];
  facts.innerHTML = rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
  setRun(
    !publishable
      ? `Diagnostic only: this revision is preserved but blocked below the ≥${pct(ENERGY_HARD_STOP)} hard-stop gate.`
      : reviewRequired
        ? `Quality warning: evidence below ${pct(integrity.qualityTarget)} is being processed because every domain cleared the ${pct(integrity.hardStop)} hard stop.`
        : 'Engineering evidence attached. The managed REVEX Energy server is processing this immutable revision; the workstation is no longer part of the simulation environment.',
    !publishable ? 'bad' : (reviewRequired ? 'busy' : '')
  );
}

async function runManagedServerForSource() {
  const id = projectId();
  const revision = String(sourceState?.revision || sourceState?.manifest?.revision || '').trim();
  if (!id || !revision || serverBusy) return;
  if (!sourceState?.cloud) {
    setRun('Engineering evidence is preserved locally, but managed Energy processing requires a signed-in REVEX cloud session.', 'bad');
    return;
  }
  const integrity = integrityState(sourceState?.manifest);
  const publishable = sourceState?.manifest?.gbxmlStatus === 'EXPORTED' &&
    integrity.hardStop >= ENERGY_HARD_STOP &&
    integrity.qualityTarget >= ENERGY_QUALITY_TARGET &&
    integrity.ratios.length > 0 &&
    integrity.ratios.every(([, value]) => value >= ENERGY_HARD_STOP);
  if (!publishable) {
    setRun(`Diagnostic only: every Engineering evidence domain must clear the ≥${pct(ENERGY_HARD_STOP)} hard-stop gate before managed processing can start.`, 'bad');
    return;
  }
  const existingSource = String(resultState?.manifest?.sourceEngineeringRevision || '').trim();
  if (existingSource === revision && String(resultState?.manifest?.status || '').toUpperCase() === 'COMPLETE') {
    setRun('Managed Energy package already complete for this Engineering revision.', 'good');
    return;
  }
  serverBusy = true;
  setRun('Managed REVEX Energy server: GeometryCo → Baseline/Proposed → OpenStudio/EnergyPlus → reports → EN-1…', 'busy');
  try {
    const job = await Store.runEnergyServer(id, revision);
    resultState = await Store.getEnergyResult(id);
    lastResultRevision = resultState?.revision || resultState?.manifest?.resultRevision || '';
    renderResult();
    const complete = String(resultState?.manifest?.status || job?.status || '').toUpperCase() === 'COMPLETE';
    setRun(complete ? 'Managed Energy package complete. EN-1 is prepared with identity/signature/seal fields intentionally blank.' : (resultState?.manifest?.error || job?.message || 'Managed Energy worker returned a reviewable result.'), complete ? 'good' : 'bad');
  } catch (error) {
    setRun(error?.message || 'Managed REVEX Energy server failed.', 'bad');
  } finally { serverBusy = false; }
}

function renderResult() {
  const summary = $('#energy-result-summary');
  const artifacts = $('#energy-artifacts');
  if (!resultState?.manifest) {
    summary.textContent = 'No result yet.';
    artifacts.innerHTML = '<div class="energy-empty">The Baseline/Proposed review package and filing PDFs will appear here.</div>';
    return;
  }
  const manifest = resultState.manifest;
  const complete = String(manifest.status || '').toUpperCase() === 'COMPLETE';
  summary.textContent = complete
    ? `${manifest.resultRevision || resultState.revision} completed. PDFs are standalone and ready for later insertion.`
    : `${manifest.status || 'Blocked'}: ${manifest.error || 'Review the pipeline logs.'}`;
  const rows = Array.isArray(resultState.artifacts) ? resultState.artifacts : [];
  const groups = [
    ['filing-input', 'Filing'],
    ['review-report', 'Reports / review package'],
    ['simulation-output', 'Original simulation reports'],
    ['compiled-model', 'Compiled OSM models'],
    ['original-model', 'Original Revit-derived OSM'],
    ['source-evidence', 'Source evidence'],
    ['reference-only', 'Approved references'],
    ['diagnostic', 'Diagnostics'],
  ];
  const byKind = new Map(groups.map(([kind]) => [kind, []]));
  for (const row of rows) {
    const kind = String(row.kind || 'diagnostic');
    (byKind.get(kind) || byKind.get('diagnostic')).push(row);
  }
  const renderArtifact = (row) => {
    const filing = /EN-1_READY_TO_INSERT\.pdf/i.test(row.name || '');
    const cxlReady = /COMcheck_PROJECT_INPUT_READY\.cxl/i.test(row.name || '');
    const label = filing ? 'Ready to insert' : cxlReady ? 'Ready for COMcheck Web / review' : (row.kind || 'Energy output');
    const relative = String(row.relativePath || '').replace(/\\/g, '/');
    const detail = [label, relative && relative !== row.name ? relative : '', row.bytes ? bytes(row.bytes) : ''].filter(Boolean).join(' · ');
    const body = `<span>${esc(row.name || 'Artifact')}</span><small>${esc(detail)}</small>`;
    const cls = `energy-artifact${filing || cxlReady ? ' is-filing' : ''}`;
    return row.url ? `<a class="${cls}" href="${esc(row.url)}" target="_blank" rel="noopener">${body}</a>` : `<div class="${cls}">${body}</div>`;
  };
  const grouped = groups.map(([kind, title]) => {
    const items = (byKind.get(kind) || []).sort((a, b) => {
      const rank = (row) => /EN-1_READY_TO_INSERT\.pdf/i.test(row.name || '') ? 0 : /COMcheck_PROJECT_INPUT_READY\.cxl/i.test(row.name || '') ? 1 : /\.pdf$/i.test(row.name || '') ? 2 : 3;
      return rank(a) - rank(b) || String(a.relativePath || a.name || '').localeCompare(String(b.relativePath || b.name || ''));
    });
    if (!items.length) return '';
    return `<section class="energy-artifact-group" data-kind="${esc(kind)}"><h4>${esc(title)}</h4><div class="energy-artifact-group-list">${items.map(renderArtifact).join('')}</div></section>`;
  }).join('');
  artifacts.innerHTML = grouped || '<div class="energy-empty">No downloadable artifacts were attached to this result.</div>';
}

async function importSource(files) {
  if (sourceBusy) return;
  sourceBusy = true;
  try {
    const manifestFile = [...files].find((file) => file.name.toLowerCase() === 'engineering-sync.json');
    if (manifestFile) {
      const probe = JSON.parse(await manifestFile.text());
      if (probe.revision && probe.revision === lastSourceRevision) return;
    }
    setBadge('Importing evidence…', 'quiet');
    sourceState = await Store.syncEngineeringPackage(files, projectId());
    lastSourceRevision = sourceState.revision || sourceState.manifest?.revision || '';
    renderSource();
    void runManagedServerForSource();
  } catch (error) {
    setBadge('Engineering Sync rejected', 'blocked');
    setRun(error.message || 'Engineering Sync could not be imported.', 'bad');
  } finally { sourceBusy = false; }
}

async function importResult(files) {
  if (resultBusy) return;
  resultBusy = true;
  try {
    const manifestFile = [...files].find((file) => file.name.toLowerCase() === 'energy-result.json');
    if (manifestFile) {
      const probe = JSON.parse(await manifestFile.text());
      if (probe.resultRevision && probe.resultRevision === lastResultRevision) return;
    }
    resultState = await Store.publishEnergyResult(files, projectId());
    lastResultRevision = resultState.revision || resultState.manifest?.resultRevision || '';
    renderResult();
    setRun(resultState.manifest?.status === 'COMPLETE' ? 'Energy package complete. Filing PDFs are ready to insert later.' : (resultState.manifest?.error || 'Energy package stopped with a reviewable result.'), resultState.manifest?.status === 'COMPLETE' ? 'good' : 'bad');
  } catch (error) {
    setRun(error.message || 'Energy result could not be published.', 'bad');
  } finally { resultBusy = false; }
}

async function hydrate() {
  const id = projectId();
  if (!id || !Store) { sourceState = null; resultState = null; renderSource(); renderResult(); return; }
  try {
    [sourceState, resultState] = await Promise.all([Store.getEngineeringState(id), Store.getEnergyResult(id)]);
    lastSourceRevision = sourceState?.revision || sourceState?.manifest?.revision || '';
    lastResultRevision = resultState?.revision || resultState?.manifest?.resultRevision || '';
  } catch (_) { sourceState = null; resultState = null; }
  renderSource();
  renderResult();
  const currentSource = String(sourceState?.revision || sourceState?.manifest?.revision || '').trim();
  const resultSource = String(resultState?.manifest?.sourceEngineeringRevision || '').trim();
  if (sourceState?.cloud && currentSource && resultSource !== currentSource) setTimeout(() => { void runManagedServerForSource(); }, 0);
}

const sourceInput = $('#revex-energy-sync-upload');
const resultInput = $('#revex-energy-result-upload');
if (sourceInput) {
  sourceInput.dataset.liberRevexEnergyHandlerReady = '1';
  sourceInput.addEventListener('change', () => { if (sourceInput.files?.length) importSource(sourceInput.files); });
}
if (resultInput) {
  resultInput.dataset.liberRevexEnergyHandlerReady = '1';
  resultInput.addEventListener('change', () => { if (resultInput.files?.length) importResult(resultInput.files); });
}
window.addEventListener('revex:energy-open', hydrate);
$('#project-select')?.addEventListener('change', () => setTimeout(hydrate, 0));
window.chrome?.webview?.addEventListener?.('message', (event) => {
  const message = event.data || {};
  if (message.type !== 'liber:revex-energy-status') return;
  setRun(message.message || message.stage || 'Energy update', message.ok ? 'good' : (['running', 'busy'].includes(String(message.stage || '').toLowerCase()) ? 'busy' : 'bad'));
});

renderSource();
renderResult();
if (!$('#view-energy')?.hidden) hydrate();
