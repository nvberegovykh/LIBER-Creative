const Store = window.RevexStore;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let sourceState = null;
let resultState = null;
let sourceBusy = false;
let resultBusy = false;
let lastSourceRevision = '';
let lastResultRevision = '';

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

function renderSource() {
  const summary = $('#energy-source-summary');
  const facts = $('#energy-source-facts');
  if (!sourceState?.manifest) {
    setBadge('No Energy Sync', 'quiet');
    summary.innerHTML = 'In Revit, choose <b>ENERGY SYNC TO COMPANION</b>.';
    facts.innerHTML = '';
    setRun('Waiting for a published ≥98% Energy Sync revision.');
    return;
  }
  const manifest = sourceState.manifest;
  setBadge(manifest.gbxmlStatus === 'EXPORTED' ? 'Evidence ready' : manifest.gbxmlStatus || 'Energy Sync', manifest.gbxmlStatus === 'EXPORTED' ? 'ready' : 'blocked');
  summary.textContent = 'Immutable Energy evidence is attached to this Project ID. Design Book, Spec Book content, printing sets and sheet PDFs were not modified.';
  const rows = [
    ['Revision', sourceState.revision || manifest.revision],
    ['Model', manifest.sourceModel?.title || '—'],
    ['Engine', manifest.engine || '—'],
    ['Architecture', manifest.architecture || '—'],
    ['Publication integrity', '≥98% in every evidence domain'],
    ['Revit writes', 'Spaces · EADM · EN/Energy tags'],
    ['Post-export writeback', 'None']
  ];
  facts.innerHTML = rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
  setRun('Ready. Choose the exact LaGuardia TMY3 EPW, then run the Companion-side package.');
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
  const ranked = [...rows].sort((a, b) => {
    const rank = (row) => /EN-1_READY_TO_INSERT\.pdf|COMcheck_READY_TO_INSERT\.pdf/i.test(row.name || '') ? 0 : /\.pdf$/i.test(row.name || '') ? 1 : 2;
    return rank(a) - rank(b) || String(a.name || '').localeCompare(String(b.name || ''));
  });
  artifacts.innerHTML = ranked.length ? ranked.map((row) => {
    const filing = /EN-1_READY_TO_INSERT\.pdf|COMcheck_READY_TO_INSERT\.pdf/i.test(row.name || '');
    const label = filing ? 'Ready to insert' : (row.kind || 'Energy output');
    const body = `<span>${esc(row.name || 'Artifact')}</span><small>${esc(label)}${row.bytes ? ` · ${bytes(row.bytes)}` : ''}</small>`;
    return row.url ? `<a class="energy-artifact${filing ? ' is-filing' : ''}" href="${esc(row.url)}" target="_blank" rel="noopener">${body}</a>` : `<div class="energy-artifact${filing ? ' is-filing' : ''}">${body}</div>`;
  }).join('') : '<div class="energy-empty">No downloadable artifacts were attached to this result.</div>';
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
  } catch (error) {
    setBadge('Energy Sync rejected', 'blocked');
    setRun(error.message || 'Energy Sync could not be imported.', 'bad');
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

function dataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function runEnergy(event) {
  event.preventDefault();
  if (!sourceState?.manifest) return setRun('Run ENERGY SYNC TO COMPANION from Revit first.', 'bad');
  const weather = $('#energy-weather')?.files?.[0];
  if (!weather || !/\.epw$/i.test(weather.name)) return setRun('Choose the exact LaGuardia TMY3 .epw file.', 'bad');
  if (!window.chrome?.webview?.postMessage) return setRun('Open this project from the REVEX Revit add-in to run the local Energy worker.', 'bad');
  const button = $('#energy-run');
  button.disabled = true;
  setRun('Reading local inputs. Revit will not be accessed during this run…', 'busy');
  try {
    window.chrome.webview.postMessage({
      type: 'liber:revex-energy-run',
      projectId: projectId(),
      projectName: state().project?.name || state().project?.title || sourceState.manifest?.sourceModel?.title || 'REVEX Energy',
      sourceEngineeringRevision: sourceState.revision,
      weatherFileName: weather.name,
      weatherDataUrl: await dataUrl(weather),
      openStudioCli: $('#energy-openstudio').value.trim(),
      standardVersion: $('#energy-standard').value,
      applicant: {},
      sealDataUrl: ''
    });
    setRun('Energy worker started outside Revit. GeometryCo and both EnergyPlus runs may take several minutes.', 'busy');
  } catch (error) {
    button.disabled = false;
    setRun(error.message || 'Energy package could not start.', 'bad');
  }
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
function showSpecSection(section = 'book', updateRoute = true) {
  const selected = section === 'energy' ? 'energy' : 'book';
  $$('[data-spec-section]').forEach((button) => {
    const active = button.dataset.specSection === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('[data-spec-panel]').forEach((panel) => { panel.hidden = panel.dataset.specPanel !== selected; });
  const specStatus = $('#spec-status');
  if (specStatus) specStatus.hidden = selected === 'energy';
  if (updateRoute && projectId()) {
    const url = new URL(location.href);
    url.searchParams.set('view', 'spec');
    if (selected === 'energy') url.searchParams.set('specSection', 'energy');
    else url.searchParams.delete('specSection');
    history.replaceState(null, '', `${url.pathname}?${url.searchParams}`);
  }
  if (selected === 'energy') hydrate();
}

$$('[data-spec-section]').forEach((button) => button.addEventListener('click', () => showSpecSection(button.dataset.specSection || 'book')));
$('#energy-run-form')?.addEventListener('submit', runEnergy);
window.addEventListener('revex:spec-section-route', (event) => showSpecSection(event.detail?.section || 'book', false));
window.addEventListener('revex:energy-open', () => showSpecSection('energy'));
$('#project-select')?.addEventListener('change', () => setTimeout(() => { if (!$('#spec-energy-section')?.hidden) hydrate(); }, 0));
window.chrome?.webview?.addEventListener?.('message', (event) => {
  const message = event.data || {};
  if (message.type !== 'liber:revex-energy-status') return;
  const button = $('#energy-run');
  if (button && !['running', 'busy'].includes(String(message.stage || '').toLowerCase())) button.disabled = false;
  setRun(message.message || message.stage || 'Energy update', message.ok ? 'good' : (['running', 'busy'].includes(String(message.stage || '').toLowerCase()) ? 'busy' : 'bad'));
});

renderSource();
renderResult();
showSpecSection(new URLSearchParams(location.search).get('specSection') === 'energy' ? 'energy' : 'book', false);
