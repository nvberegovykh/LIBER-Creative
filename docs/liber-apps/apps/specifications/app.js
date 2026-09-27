import { bookFilename, printBookDocument } from '../revex/book-structure.js?v=20260914r193-books1';
/* LIBER Specifications — UI controller */
(function () {
  'use strict';
  const MF = window.MasterFormat, SP = window.SpecSync, ST = window.SpecStore, PR = window.ScheduleParser;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowISO = () => new Date().toISOString();

  const S = {
    sid: null, epoch: 0, project: null, sections: [], items: [], inbox: [], history: [],
    activeSec: null, view: 'book', groupBy: 'none', sortBy: 'order',
    showRemoved: false, filter: '', gap: null, unsub: [], pending: null,
    loaded: { sections: false, items: false }, readErrors: {}, syncError: ''
  };
  let projectListGeneration = 0;

  /* ---------------- utils ---------------- */
  let toastT;
  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms || 2600);
  }
  function modal(html, onMount) {
    const m = $('#modal'), c = $('#modal-card');
    c.innerHTML = html; m.hidden = false;
    m.onclick = (e) => { if (e.target === m) closeModal(); };
    if (onMount) onMount(c);
    return c;
  }
  function closeModal() { $('#modal').hidden = true; $('#modal-card').innerHTML = ''; }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms || 250); }; }
  const num = (v) => (v == null || v === '' ? '' : v);
  function sourceQuantity(item) {
    const entries=Object.entries(item.fields||{}),quantity=entries.find(([key])=>/^(?:total\s+)?(?:qty\.?|quantity|count|number of)(?:$|\s|\()/i.test(String(key).trim()));
    if(quantity)return quantity[1]??'';
    return String(item.source||'').startsWith('revit:')&&entries.length?'':num(item.qty);
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    const qs = new URLSearchParams(location.search);
    const embedded = qs.get('embedded') === '1';
    document.body.classList.toggle('embedded', embedded);
    if (embedded) document.title = 'Spec Book — REVEX';
    const mode = await ST.init();
    const b = $('#mode-badge');
    b.textContent = mode === 'cloud' ? 'connected' : 'local';
    b.className = 'sp-badge ' + mode;
    b.title = mode === 'cloud' ? 'Connected to project storage. Source coverage is shown inside the book.' : 'Data stored on this device only';

    wireChrome();
    // Handoff from the browser extension: ?specUrl=&specTitle=  or  #add?url=&title=
    const hash = new URLSearchParams(location.hash.replace(/^#/, '').replace(/^add\?/, ''));
    const inUrl = qs.get('specUrl') || (location.hash.startsWith('#add') ? hash.get('url') : '');
    if (inUrl) S.pending = { url: inUrl, title: qs.get('specTitle') || hash.get('title') || '', note: qs.get('specNote') || hash.get('note') || '' };
    const forced = qs.get('specProjectId');
    if (forced) localStorage.setItem('liber.spec.last', forced);
    if (qs.get('demo')) return demoSeed();
    const last = localStorage.getItem('liber.spec.last');
    await renderProjects();
    if (last) return openProject(last);
  }

  /** ?demo=1 — seed a local project from bundled sample Revit exports (evaluation only). */
  async function demoSeed() {
    let sid = localStorage.getItem('liber.spec.demo');
    if (!sid) {
      sid = await ST.createProject({ name: '87 Winthrop St — Specifications', code: 'LIB-2026-087' });
      localStorage.setItem('liber.spec.demo', sid);
      const files = ['../../samples/APPLIANCES-SCHEDULE.csv', '../../samples/Room-Schedule-2.csv'];
      let parsed = [];
      for (const f of files) {
        try { parsed = parsed.concat(PR.parseCSVText(await (await fetch(f)).text(), f.split('/').pop().replace('.csv', ''))); } catch (e) { console.warn(f, e); }
      }
      if (parsed.length) await SP.apply(ST, sid, SP.build(parsed), [], 'demo');
    }
    await openProject(sid);
  }

  /* ---- session state: closing the app and reopening it must land you back
     where you were, exactly like the chat app does ---- */
  const UIKEY = 'liber.spec.ui';
  function saveUI() {
    if (!S.sid) return;
    try {
      const all = JSON.parse(localStorage.getItem(UIKEY) || '{}');
      all[S.sid] = { view: S.view, sec: S.activeSec, group: S.groupBy, sort: S.sortBy,
        showRemoved: S.showRemoved, gap: S.gap, scroll: ($('#content') || {}).scrollTop || 0, at: Date.now() };
      localStorage.setItem(UIKEY, JSON.stringify(all));
    } catch (_) {}
  }
  function loadUI(sid) {
    try { return (JSON.parse(localStorage.getItem(UIKEY) || '{}'))[sid] || null; } catch (_) { return null; }
  }
  function restoreUI(sid) {
    const u = loadUI(sid); if (!u) return;
    S.view = u.view || 'book';
    S.activeSec = u.sec || null;
    S.groupBy = u.group || 'none'; S.sortBy = u.sort || 'order';
    S.showRemoved = !!u.showRemoved; S.gap = u.gap || null;
    $$('.sp-seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
    const g = $('#group-by'); if (g) g.value = S.groupBy;
    const so = $('#sort-by'); if (so) so.value = S.sortBy;
    const sr = $('#show-removed'); if (sr) sr.checked = S.showRemoved;
    const epoch = S.epoch;
    if (u.scroll) setTimeout(() => { const c = $('#content'); if (c && S.sid === sid && S.epoch === epoch) c.scrollTop = u.scroll; }, 120);
  }

  /** Params handed over while the app is already mounted (shell reuses the iframe). */
  function applyHandoff(params) {
    if (!params) return;
    if (params.specUrl) {
      const p = { url: params.specUrl, title: params.specTitle || '', note: params.specNote || '' };
      if (S.sid) addLinkFlow(p); else S.pending = p;
    }
    if (params.specProjectId && params.specProjectId !== S.sid) {
      localStorage.setItem('liber.spec.last', params.specProjectId);
      openProject(params.specProjectId).then(() => applyDeepView(params));
      return;
    }
    applyDeepView(params);
  }
  function applyDeepView(params) {
    if (params.view) { S.view = params.view; $$('.sp-seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view)); }
    if (params.section) S.activeSec = params.section;
    if (params.view || params.section) { renderRail(); renderContent(); }
    if (params.item) openItem(params.item);
  }

  function wireChrome() {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || ![window, window.parent, window.top].includes(e.source)) return;
      const d = e.data;
      if (d && d.type === 'liber:app-params') applyHandoff(d.params || {});
    });
    window.addEventListener('pagehide', saveUI);
    document.addEventListener('visibilitychange', saveUI);
    window.addEventListener('blur', saveUI);
    $('#btn-home').onclick = () => { showView('projects'); renderProjects(); };
    $('#btn-import').onclick = () => S.sid ? importDialog() : toast('Open or create a project first');
    $('#btn-new-project').onclick = newProjectDialog;
    $('#btn-rail').onclick = () => setRail(!$('#rail').classList.contains('open'));
    $('#btn-menu').onclick = menuDialog;
    $('#btn-sources').onclick = sourcesDialog;
    $('#btn-export').onclick = exportDialog;
    $('#btn-inbox').onclick = inboxDialog;
    $('#btn-history').onclick = () => S.sid ? historyDialog() : toast('Open a project first');
    $('#dr-close').onclick = closeDrawer;
    $('#scrim').onclick = () => { closeDrawer(); setRail(false); };
    window.addEventListener('resize', () => { if (window.innerWidth > 860) setRail(false); measureHeader(); });
    measureHeader();
    $('#rail-search').oninput = debounce((e) => { S.filter = e.target.value.trim().toLowerCase(); renderRail(); renderContent(); }, 200);
    $('#content').addEventListener('scroll', debounce(saveUI, 400));
    $$('.sp-seg button').forEach((btn) => btn.onclick = () => {
      $$('.sp-seg button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active'); S.view = btn.dataset.view; renderContent(); saveUI();
    });
    $('#group-by').onchange = (e) => { S.groupBy = e.target.value; renderContent(); saveUI(); };
    $('#sort-by').onchange = (e) => { S.sortBy = e.target.value; renderContent(); saveUI(); };
    $('#show-removed').onchange = (e) => { S.showRemoved = e.target.checked; renderContent(); saveUI(); };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); closeDrawer(); setRail(false); return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || e.target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'z' && !typing && S.sid) {
        e.preventDefault(); e.shiftKey ? redoLast() : undoLast();
      }
    });
  }

  function showView(v) {
    projectListGeneration++;
    if (v === 'projects') {
      S.epoch++;
      S.unsub.forEach(unsubscribe => { try { unsubscribe(); } catch (_) {} });
      S.unsub = [];
      S.sid = null;
    }
    $('#view-projects').hidden = v !== 'projects';
    $('#view-book').hidden = v !== 'book';
  }

  /* ---------------- projects ---------------- */
  async function renderProjects() {
    showView('projects');
    const generation = projectListGeneration, owner = ST.captureProjectListOwner();
    const current = () => generation === projectListGeneration && owner.isCurrent();
    const host = $('#projects-list');
    let list;
    try { list = await ST.listProjects(); }
    catch (error) {
      if (!current()) return;
      $('#projects-empty').hidden = true;
      host.innerHTML = `<div class="sp-card" role="alert"><h3>Could not load specification projects</h3><p>${esc(error?.message || 'Please retry.')}</p><button type="button" class="sp-btn" data-retry-projects>Retry</button></div>`;
      $('[data-retry-projects]', host).onclick = renderProjects;
      console.error('[Specifications] Project list failed', error);
      return;
    }
    if (!current()) return;
    $('#projects-empty').hidden = list.length > 0;
    host.innerHTML = list.map((p) => `
      <div class="sp-card" data-id="${p.id}">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.code || '')}${p.linkedProjectName ? ' · linked to ' + esc(p.linkedProjectName) : ''}</p>
        <div class="sp-meta">
          <span class="sp-tag">${p.lastImportAt ? 'imported ' + p.lastImportAt.slice(0, 10) : 'no imports'}</span>
          <span class="sp-tag">${(p.memberIds || []).length + 1} participant(s)</span>
        </div>
      </div>`).join('');
    $$('.sp-card', host).forEach((c) => c.onclick = () => openProject(c.dataset.id));
    $('#crumb').textContent = '';
  }

  async function newProjectDialog() {
    const tracker = await ST.listTrackerProjects();
    modal(`<h3>New specification project</h3>
      <div class="sp-form">
        <div class="sp-row"><label>Project name</label><input id="np-name" placeholder="87 Winthrop St — Specifications" /></div>
        <div class="sp-row"><label>Project code</label><input id="np-code" placeholder="LIB-2026-087" /></div>
        <div class="sp-row"><label>Link to Project Tracker</label>
          <select id="np-link"><option value="">Independent (only me + invited)</option>${tracker.map((t) => `<option value="${t.id}">${esc(t.name || t.title || t.id)}</option>`).join('')}</select>
          <span class="hint">Linked specs inherit the tracker project's participants and admins automatically.</span>
        </div>
      </div>
      <div class="sp-modal-actions">
        <button class="sp-btn sp-btn-ghost" id="np-cancel">Cancel</button>
        <button class="sp-btn" id="np-create">Create</button>
      </div>`, (c) => {
      $('#np-cancel', c).onclick = closeModal;
      $('#np-create', c).onclick = async () => {
        const id = await ST.createProject({ name: $('#np-name', c).value || 'Project Specifications', code: $('#np-code', c).value, linkedProjectId: $('#np-link', c).value || null });
        closeModal(); await openProject(id); toast('Project created — import your schedules');
      };
    });
  }

  async function openProject(sid) {
    saveUI();
    projectListGeneration++;
    const openGeneration = ++S.epoch;
    const owner = ST.captureProjectListOwner();
    const current = () => S.sid === sid && S.epoch === openGeneration && owner.isCurrent();
    S.unsub.forEach((u) => { try { u(); } catch (_) {} });
    S.unsub = [];
    clearInterval(autoTimer);
    closeDrawer(); closeModal();
    Object.assign(S, { project: null, sections: [], items: [], inbox: [], history: [], activeSec: null,
      view: 'book', groupBy: 'none', sortBy: 'order', showRemoved: false, filter: '', gap: null,
      loaded: { sections: false, items: false }, readErrors: {}, syncError: '' });
    $('#rail-search').value = ''; $('#group-by').value = 'none'; $('#sort-by').value = 'order';
    $('#show-removed').checked = false; $('#inbox-count').textContent = '0'; $('#history-count').textContent = '0';
    $$('.sp-seg button').forEach(b => b.classList.toggle('active', b.dataset.view === 'book'));
    S.sid = sid; localStorage.setItem('liber.spec.last', sid);
    sourceStatus();
    showView('book'); $('#crumb').textContent = 'Opening specification project…';
    renderRail(); renderContent();
    const fail = kind => error => {
      if (!current()) return;
      S.readErrors[kind] = error?.code === 'permission-denied' ? 'Project access could not be verified. Check your sign-in and retry.' : 'Project records could not be loaded. Check your connection and retry.';
      renderRail(); renderContent();
    };
    let project;
    try { project = await ST.getProject(sid); }
    catch (error) { fail('project')(error); return; }
    if (!current()) return;
    S.project = project;
    if (!S.project) { localStorage.removeItem('liber.spec.last'); return renderProjects(); }
    $('#crumb').textContent = S.project.name + (S.project.linkedProjectName ? ' · ' + S.project.linkedProjectName : '');
    restoreUI(sid);
    S.unsub.push(ST.subscribeProject(sid, (p) => {
      if (!current()) return;
      if (!p) { fail('project')({ code: 'permission-denied' }); return; }
      const recovering = !!S.readErrors.project; S.project = p; delete S.readErrors.project; if (recovering) renderContent();
    }, fail('project')));
    S.unsub.push(ST.subscribe('sections', sid, (rows) => {
      if (!current()) return; S.sections = rows; S.loaded.sections = true; delete S.readErrors.sections;
      if (S.activeSec && !rows.some(row => row.id === S.activeSec)) S.activeSec = null;
      renderRail(); renderContent();
    }, fail('sections')));
    S.unsub.push(ST.subscribe('items', sid, (rows) => { if (!current()) return; S.items = rows; S.loaded.items = true; delete S.readErrors.items; renderRail(); renderContent(); }, fail('items')));
    S.unsub.push(ST.subscribe('inbox', sid, (rows) => { if (!current()) return; const recovering = !!S.readErrors.inbox; delete S.readErrors.inbox; S.inbox = rows.filter((r) => r.status !== 'done'); $('#inbox-count').textContent = S.inbox.length; if (recovering) renderContent(); }, fail('inbox')));
    S.unsub.push(ST.subscribe('history', sid, (rows) => {
      if (!current()) return;
      const recovering = !!S.readErrors.history; delete S.readErrors.history; S.history = rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, ST.HISTORY_MAX);
      $('#history-count').textContent = S.history.filter((h) => !h.undone).length;
      if (recovering) renderContent();
    }, fail('history')));
    renderRail(); renderContent();
    startAutoSync();
    if (S.pending) { const p = S.pending; S.pending = null; addLinkFlow(p); }
    // deep links: ?view=table|issues  &item=<key>  &section=<id>
    const q = new URLSearchParams(location.search);
    if (q.get('view')) { S.view = q.get('view'); $$('.sp-seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view)); renderContent(); }
    if (q.get('section')) { S.activeSec = q.get('section'); renderRail(); renderContent(); }
    if (q.get('item')) {
      const want = q.get('item'); let tries = 0;
      const t = setInterval(() => { if (S.items.some((x) => x.id === want)) { clearInterval(t); openItem(want); } else if (++tries > 30) clearInterval(t); }, 100);
    }
  }

  /* ---------------- rail ---------------- */
  function sectionsSorted() {
    return S.sections.slice().sort((a, b) => {
      const da = a.numberOverride || a.number || 'zz', db2 = b.numberOverride || b.number || 'zz';
      return String(da).localeCompare(String(db2)) || (a.order || 0) - (b.order || 0);
    });
  }
  let mappingRows=null,mappingCache=new Map();
  function inferredMapping(s) {
    if(mappingRows!==S.items){mappingRows=S.items;mappingCache=new Map();}
    if(mappingCache.has(s.id))return mappingCache.get(s.id);
    const profiles=itemsOf(s.id).filter(i=>!['removed','deleted'].includes(i.status)).map(i=>String(i.fields?.Type||i.type||i.label||'').trim());
    let result=null;
    if(/structural.*(?:framing|column)/i.test(s.scheduleName||'')&&profiles.length&&profiles.every(value=>/^(?:W|S|C|MC)\d+(?:\.\d+)?\s*[xX]\s*\d|^HSS\s*\d/i.test(value)))result={number:'051200',title:'Structural Steel Framing'};
    else if(/framing/i.test(s.scheduleName||'')&&profiles.length&&profiles.every(value=>/^\d{3,4}[STU]\d{3}-\d{2,3}/i.test(value)))result={number:'054000',title:'Cold-Formed Metal Framing'};
    else if(/structural connections/i.test(s.scheduleName||''))result={number:null,title:'Structural connections — section review needed',division:'05',needsMapping:true};
    else if(/structural.*framing/i.test(s.scheduleName||'')&&s.number==='061000'&&!profiles.every(value=>/wood|timber|lumber|\bLVL\b|\bGLULAM\b/i.test(value)))result={number:null,title:'Mixed structural profiles — section review needed',division:'05',needsMapping:true};
    mappingCache.set(s.id,result);return result;
  }
  const secNum = s => s.numberOverride || (inferredMapping(s)?inferredMapping(s).number:s.number);
  const secDiv = s => secNum(s)?String(secNum(s)).slice(0,2):(inferredMapping(s)?.division||s.division||'01');
  const needsMapping = s => !isReferenceSection(s)&&!s.numberOverride&&Boolean(inferredMapping(s)?.needsMapping||s.needsMapping);
  function isSourceHeader(item) {
    const fields=Object.entries(item.fields||{}).filter(([,value])=>String(value??'').trim());
    return String(item.source||'').startsWith('revit:')&&fields.length>=2&&fields.every(([key,value])=>String(key).trim().toLocaleLowerCase()===String(value).trim().toLocaleLowerCase());
  }
  function itemsOf(secId) { return S.items.filter(i=>i.sectionId===secId&&!isSourceHeader(i)); }

  function isReferenceSection(s) {
    if (s.bookRole) return s.bookRole === 'reference';
    return s.kind === 'locations' || /revision schedule|analytical|calculation|(?:^|\b)(?:area|zoning|FAR)(?:\b|$)|energy (?:analysis|model summary)|code (?:analysis|compliance)|drawing list|(?:sheet|view) list|building story|project information|job applications|progress inspections|estimated quantities|thermal bridges|^EN envelope|^DOT standards/i.test(s.scheduleName || '');
  }
  function specificationSections() { return sectionsSorted().filter(s=>!isReferenceSection(s)); }
  function sectionOverview() {
    const specifications=specificationSections(),references=S.sections.length-specifications.length;
    return `<section class="sp-book-overview"><div class="sp-sec-num">SPEC BOOK · ${esc(S.project?.name||'Project')}</div><h2>Project specifications</h2><p>${specifications.length} specification sections · ${references} reference schedules preserved separately</p><div class="sp-section-index">${specifications.map(s=>`<button type="button" data-select-section="${esc(s.id)}"><small>${secNum(s)?MF.fmt(secNum(s)):'Needs section number'}</small><strong>${esc(s.scheduleName)}</strong><span>${itemsOf(s.id).filter(i=>!['removed','deleted'].includes(i.status)).length} positions</span></button>`).join('')||'<p>No product specification sections yet. Import a product schedule or include a reference schedule as a specification.</p>'}</div><p class="sp-muted">Choose a section to review its positions and write the specification. Revit calculations, drawing lists, rooms and revision registers are under Reference schedules.</p></section>`;
  }
  function wireSectionIndex(host) { $$('[data-select-section]',host).forEach(button=>button.onclick=()=>{S.activeSec=button.dataset.selectSection;renderRail();renderContent();$('#content').scrollTop=0;saveUI();}); }

  function renderRail() {
    const host = $('#rail-tree');
    if (Object.keys(S.readErrors).length) { host.innerHTML = '<p class="sp-empty">Project records need attention.</p>'; return; }
    if (!S.loaded.sections || !S.loaded.items) { host.innerHTML = '<p class="sp-empty" role="status">Loading sections and positions…</p>'; return; }
    if (!S.sections.length) { host.innerHTML = `<p class="sp-empty">No sections yet.<br><button class="sp-btn sp-btn-sm" id="rail-imp">Import schedules</button></p>`; const b = $('#rail-imp'); if (b) b.onclick = importDialog; return; }
    const byDiv = new Map();
    specificationSections().forEach((s) => {
      const d = secDiv(s);
      if (!byDiv.has(d)) byDiv.set(d, []);
      byDiv.get(d).push(s);
    });
    const divs = [...byDiv.keys()].sort();
    const referenceOpen = $('#sp-reference-schedules')?.open || S.sections.some(s=>s.id===S.activeSec&&isReferenceSection(s));
    host.innerHTML = '<button type="button" class="sp-btn sp-btn-ghost sp-w" id="sp-book-overview">All specification sections</button>' + divs.map((d) => `
      <div class="sp-div">
        <div class="sp-div-h"><b>${d}</b><span>${esc(MF.divisionTitle(d))}</span></div>
        ${byDiv.get(d).map((s) => {
          const n = itemsOf(s.id).filter((i) => S.showRemoved || i.status !== 'removed').length;
          const warn = needsMapping(s);
          const g = gapCount(s.id);
          return `<div class="sp-sec ${S.activeSec === s.id ? 'active' : ''}" data-id="${s.id}">
            <code>${secNum(s) ? MF.fmt(secNum(s)) : '– – –'}</code>
            <span class="n">${esc(s.scheduleName)}</span>
            <span class="sp-pill ${warn || g ? 'warn' : ''}" title="${warn ? 'Needs a MasterFormat number' : g ? g + ' of ' + n + ' rows still have blanks' : n + ' rows, all complete'}">${warn ? '!' : g ? '!' + g : n}</span></div>`;
        }).join('')}
      </div>`).join('');
    const reference=S.sections.filter(isReferenceSection);
    if(reference.length) host.insertAdjacentHTML('beforeend',`<details id="sp-reference-schedules" ${referenceOpen?'open':''}><summary>Reference schedules (${reference.length})</summary><p class="sp-muted">Source registers and calculations. No product fields are required.</p>${reference.map(s=>`<div class="sp-sec ${S.activeSec===s.id?'active':''}" data-id="${esc(s.id)}"><span class="n">${esc(s.scheduleName)}</span><span class="sp-pill">${itemsOf(s.id).filter(i=>i.status!=='removed').length}</span></div>`).join('')}</details>`);
    $('#sp-book-overview').onclick=()=>{S.activeSec=null;S.filter='';S.gap=null;$('#rail-search').value='';renderRail();renderContent();saveUI();};
    $$('.sp-sec', host).forEach((el) => el.onclick = () => {
      if (window.innerWidth <= 860) setRail(false);
      S.activeSec = el.dataset.id; renderRail(); renderContent();
      $('#content').scrollTop = 0; saveUI();
    });
    const issues = S.sections.filter(needsMapping).length + S.items.filter((i) => i.mismatch&&!isReferenceSection(S.sections.find(s=>s.id===i.sectionId)||{})).length;
    $('#issue-count').textContent = issues;
  }

  /* ---------------- content ---------------- */
  function visibleItems(secId, ignoreFilters = false) {
    let list = itemsOf(secId).filter((i) => i.status !== 'deleted').filter((i) => S.showRemoved || i.status !== 'removed');
    if (S.filter && !ignoreFilters) list = list.filter((i) => JSON.stringify(i).toLowerCase().includes(S.filter));
    if (S.gap && !ignoreFilters) { const sec = S.sections.find((s) => s.id === secId) || {}; list = list.filter((i) => gapsOf(i, sec).includes(S.gap)); }
    const dir = (a, b, k) => String(a[k] == null ? '' : a[k]).localeCompare(String(b[k] == null ? '' : b[k]), undefined, { numeric: true });
    list.sort((a, b) => S.sortBy === 'order' ? (a.order || 0) - (b.order || 0)
      : S.sortBy === 'qty' ? (Number(sourceQuantity(b)) || 0) - (Number(sourceQuantity(a)) || 0)
      : S.sortBy === 'area' ? (b.area || 0) - (a.area || 0)
      : dir(a, b, S.sortBy === 'label' ? 'label' : 'mark'));
    return list;
  }

  function renderContent() {
    const host = $('#content');
    if (Object.keys(S.readErrors).length) {
      host.innerHTML = `<div class="sp-empty" role="alert"><p>${esc(Object.values(S.readErrors)[0])}</p><p>Saved records have not been replaced with an empty book.</p><button class="sp-btn" id="sp-retry-load">Retry loading this book</button></div>`;
      $('#sp-retry-load').onclick = () => openProject(S.sid); return;
    }
    if (!S.project || !S.loaded.sections || !S.loaded.items) { host.innerHTML = '<p class="sp-empty" role="status">Loading specification records…</p>'; return; }
    if (S.activeSec && !S.sections.some(section => section.id === S.activeSec)) S.activeSec = null;
    if (!S.sections.length) {
      host.innerHTML = `<div class="sp-empty"><p>No specification sections are stored in this book.</p><p>${S.project.linkedProjectId ? 'This book is linked to a REVEX project. Check its published sources before importing another copy.' : 'This is an independent book. Other books with the same name can contain different records.'}</p><p>${S.items.length ? esc(S.items.length) + ' stored positions need their section links restored.' : 'Local files and Drive folders appear here only after their sources have been linked and merged.'}</p><button class="sp-btn" id="c-sync">Check synced sources</button> <button class="sp-btn sp-btn-ghost" id="c-imp">Import schedules</button> <button class="sp-btn sp-btn-ghost" id="c-projects">Other specification books</button></div>`;
      $('#c-imp').onclick = importDialog; $('#c-sync').onclick = sourcesDialog; $('#c-projects').onclick = renderProjects; return;
    }
    if (S.view === 'issues') return renderIssues(host);
    if (!S.activeSec && !S.filter && !S.gap) { host.innerHTML=sectionOverview();wireSectionIndex(host);return; }

    const list = S.activeSec ? [S.sections.find((s) => s.id === S.activeSec)].filter(Boolean) : sectionsSorted();
    const ambiguous = list.reduce((count, section) => count + (section.identityReviewCount || 0), 0);
    const identityNotice = ambiguous ? `<p class="sp-empty" style="padding:12px;text-align:left">${ambiguous} source rows have repeated identifiers. Each row is retained separately. When these rows change, previous versions and their notes remain available under “Show removed” for review.</p>` : '';
    host.innerHTML = identityNotice + attentionPanel() + list.map((s) => S.view === 'table' ? sectionTable(s) : sectionBook(s)).join('');
    wireContent(host);
    wireAttention(host);
  }

  /* ---------------- completeness / “needs attention” ----------------
   * Every blank the designer is expected to fill is a “gap”. Gaps are computed
   * live from the data (no extra bookkeeping), summarised at the top of the
   * project and clickable to filter the book down to exactly those rows. */
  const REQ_PRODUCT = [['manufacturer', 'Manufacturer'], ['model', 'Model'], ['finish', 'Finish'], ['links', 'Reference link']];
  const REQ_LOCATION = []; // rooms are a registry: only user-added columns count as placeholders

  function reqFor(sec) { return isReferenceSection(sec) ? REQ_LOCATION : REQ_PRODUCT; }

  const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

  /** Gap keys for one row, e.g. ['manufacturer','col:c8x1a']. */
  function gapsOf(i, sec) {
    if (i.status === 'removed' || i.status === 'deleted') return [];
    const sp = i.spec || {};
    const out = [];
    reqFor(sec || {}).forEach(([k]) => { if (isBlank(k === 'links' ? sp.links : sp[k])) out.push(k); });
    userCols(sec || {}).forEach((c) => { if (isBlank((sp.custom || {})[c.id])) out.push('col:' + c.id); });
    if (i.mismatch) out.push('mismatch');
    return out;
  }

  function gapReport(scope) {
    const secs = scope || (S.activeSec ? S.sections.filter((s) => s.id === S.activeSec) : S.sections);
    const labels = new Map(); const counts = new Map();
    let rows = 0, complete = 0, withGaps = 0;
    secs.forEach((sec) => {
      const lbl = new Map(reqFor(sec));
      userCols(sec).forEach((c) => lbl.set('col:' + c.id, c.label));
      lbl.set('mismatch', 'Wrong division');
      itemsOf(sec.id).filter((i) => i.status !== 'removed' && i.status !== 'deleted').forEach((i) => {
        rows++;
        const g = gapsOf(i, sec);
        if (!g.length) { complete++; return; }
        withGaps++;
        g.forEach((k) => { counts.set(k, (counts.get(k) || 0) + 1); if (!labels.has(k)) labels.set(k, lbl.get(k) || k); });
      });
    });
    const unmapped = secs.filter(needsMapping);
    const emptyText = secs.filter((s) => !isReferenceSection(s) && !Object.values(s.body || {}).some((t) => String(t || '').trim()));
    const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n, label: labels.get(k) }));
    return { rows, complete, withGaps, chips, unmapped, emptyText, pct: rows ? Math.round((complete / rows) * 100) : 0 };
  }

  function gapCount(secId) {
    const sec = S.sections.find((s) => s.id === secId) || {};
    return itemsOf(secId).filter((i) => i.status !== 'removed' && i.status !== 'deleted' && gapsOf(i, sec).length).length;
  }

  function attentionPanel() {
    const r = gapReport();
    if (!r.rows && !r.unmapped.length) return '';
    const scope = S.activeSec ? (S.sections.find((s) => s.id === S.activeSec) || {}).scheduleName : 'whole project';
    const chips = r.chips.map((c) => `<button class="sp-chip${S.gap === c.k ? ' on' : ''}" data-gap="${esc(c.k)}">
        <b>${c.n}</b> missing ${esc(String(c.label).toLowerCase())}</button>`).join('');
    const extra = [
      r.unmapped.length ? `<button class="sp-chip warn" data-goissues="1"><b>${r.unmapped.length}</b> unmapped section${r.unmapped.length > 1 ? 's' : ''}</button>` : '',
      r.emptyText.length ? `<button class="sp-chip warn" data-emptytext="1"><b>${r.emptyText.length}</b> section${r.emptyText.length > 1 ? 's' : ''} with no spec text</button>` : ''
    ].join('');
    return `<section class="sp-attn${r.withGaps || r.unmapped.length ? '' : ' done'}" id="attn">
      <div class="sp-attn-top">
        <div>
          <div class="sp-attn-h">Needs attention · <span class="sp-muted">${esc(scope)}</span></div>
          <div class="sp-attn-sub">${r.complete} of ${r.rows} rows fully specified · ${r.withGaps} still have blanks</div>
        </div>
        <div class="sp-attn-pct"><b>${r.pct}%</b><span>complete</span></div>
      </div>
      <div class="sp-bar"><i style="width:${r.pct}%"></i></div>
      <div class="sp-chips">${chips || '<span class="sp-muted">No blank placeholders left.</span>'}${extra}</div>
      ${S.gap ? `<div class="sp-attn-filter">Showing only rows missing <b>${esc(r.chips.concat([{ k: S.gap, label: S.gap }]).find((c) => c.k === S.gap).label)}</b>
        <button class="sp-btn sp-btn-ghost sp-btn-sm" id="gap-clear">Show all rows</button></div>` : ''}
    </section>`;
  }

  function wireAttention(host) {
    $$('[data-gap]', host).forEach((b) => b.onclick = () => { S.gap = S.gap === b.dataset.gap ? null : b.dataset.gap; renderContent(); $('#content').scrollTop = 0; });
    const cl = $('#gap-clear', host); if (cl) cl.onclick = () => { S.gap = null; renderContent(); };
    const gi = $('[data-goissues]', host); if (gi) gi.onclick = () => { S.view = 'issues'; $$('.sp-seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'issues')); renderContent(); };
    const et = $('[data-emptytext]', host); if (et) et.onclick = () => {
      const r = gapReport(); const first = r.emptyText[0];
      if (!first) return;
      S.view = 'book'; S.activeSec = first.id;
      $$('.sp-seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'book'));
      renderRail(); renderContent(); $('#content').scrollTop = 0;
      toast(`${r.emptyText.length} section${r.emptyText.length > 1 ? 's' : ''} with no spec text — showing “${first.scheduleName}”`, 4000);
    };
  }

  function sectionHead(s) {
    const n = secNum(s);
    return `<div class="sp-sec-head">
      <div class="sp-sec-num">${n ? 'SECTION ' + MF.fmt(n) : 'SECTION — UNMAPPED'} · DIVISION ${secDiv(s)} — ${esc(MF.divisionTitle(secDiv(s))).toUpperCase()}</div>
      <h2 class="sp-sec-title">${esc(s.scheduleName)}</h2>
      <div class="sp-sec-sub">
        ${(inferredMapping(s)?.title||s.title) ? 'Classification: ' + esc(s.numberOverride?s.title:(inferredMapping(s)?.title||s.title)) + ' · ' : ''}${itemsOf(s.id).filter((i) => i.status !== 'removed').length} items${(() => { const g = gapCount(s.id); return g ? ` · <b class="sp-warntx">${g} incomplete</b>` : ' · complete'; })()}
        ${isReferenceSection(s) ? ' · reference schedule' : ''}
        <button class="sp-btn sp-btn-ghost sp-btn-sm" data-book-role="${s.id}">${isReferenceSection(s)?'Include as specification':'Move to reference schedules'}</button>
        <button class="sp-btn sp-btn-ghost sp-btn-sm" data-remap="${s.id}">Remap section</button>
        <button class="sp-btn sp-btn-ghost sp-btn-sm" data-share="${s.id}">Share / export</button>
      </div></div>`;
  }

  function nativeScheduleTable(s) {
    const p = s.nativePresentation;
    if (!p || p.schema !== 'liber.revit.schedule.presentation.v1') return '';
    const headerRows = Array.isArray(p.header?.rows) ? p.header.rows : [];
    const bodyRows = Array.isArray(p.body?.rows) ? p.body.rows : [];
    const visibleFields = (Array.isArray(p.fields) ? p.fields : []).filter((field) => !field.hidden);
    const widths = visibleFields.map((field) => Math.max(64, Math.min(420, Number(field.sheetColumnWidth || 0) * 96 || 120)));

    const renderRows = (rows, tag) => rows.map((row) => `<tr>${(Array.isArray(row.cells) ? row.cells : []).map((cell) => {
      const merge = cell.merge;
      if (merge && (Number(cell.columnIndex) !== Number(merge.left) || Number(row.rowIndex) !== Number(merge.top))) return '';
      const colSpan = merge ? Math.max(1, Number(merge.right) - Number(merge.left) + 1) : 1;
      const rowSpan = merge ? Math.max(1, Number(merge.bottom) - Number(merge.top) + 1) : 1;
      return `<${tag}${colSpan > 1 ? ` colspan="${colSpan}"` : ''}${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ''}>${esc(cell.text || '')}</${tag}>`;
    }).join('')}</tr>`).join('');

    const sortSummary = (Array.isArray(p.sortGroups) ? p.sortGroups : [])
      .map((group) => [group.fieldId, group.sortOrder].filter(Boolean).join(' · ')).filter(Boolean).join(' / ');
    return `<div class="sp-native-schedule" data-source-schedule="${esc(s.sourceScheduleId || p.scheduleUniqueId || '')}">
      <div class="sp-native-head"><b>Authoritative Revit schedule</b><span>Native columns, grouping, itemization and row order</span>${sortSummary ? `<span>Sort/group: ${esc(sortSummary)}</span>` : ''}</div>
      <div class="sp-tablewrap"><table class="sp-table sp-native-table">
        ${widths.length ? `<colgroup>${widths.map((width) => `<col style="width:${width}px">`).join('')}</colgroup>` : ''}
        ${headerRows.length ? `<thead>${renderRows(headerRows, 'th')}</thead>` : ''}
        <tbody>${renderRows(bodyRows, 'td') || `<tr><td><span class="sp-muted">No native Revit body rows.</span></td></tr>`}</tbody>
      </table></div>
    </div>`;
  }

  function sourceDisclosure(s) { const source=nativeScheduleTable(s);return source?`<details class="sp-source-disclosure"><summary>View original Revit schedule</summary>${source}</details>`:''; }
  function sectionBook(s) {
    const body=s.body||{},reference=isReferenceSection(s),hasText=Object.values(body).some(value=>String(value||'').trim());
    if(reference) return `<article class="sp-section sp-reference-section" data-sec="${s.id}">${sectionHead(s)}${nativeScheduleTable(s)}<details class="sp-source-disclosure" ${!s.nativePresentation?'open':''}><summary>Notes and linked records</summary>${itemsTable(s)}</details></article>`;
    const parts=MF.SECTIONFORMAT.map(part=>`<div class="sp-part"><div class="sp-part-h">PART ${part.number} — ${part.title}</div>${part.articles.filter(article=>!article.itemTable).map(article=>`<div class="sp-art"><div class="sp-art-h">${article.number} ${article.title}</div><div class="sp-art-body"><div class="sp-rich" contenteditable="true" data-sec="${s.id}" data-art="${article.number}" data-ph="Write ${article.title.toLowerCase()}…">${esc(body[article.number]||'')}</div></div></div>`).join('')}</div>`).join('');
    return `<article class="sp-section" data-sec="${s.id}">${sectionHead(s)}<div class="sp-part"><div class="sp-part-h">PRODUCTS &amp; SELECTIONS</div>${itemsTable(s)}</div><details class="sp-authored-spec" ${hasText?'open':''}><summary>${hasText?'Written specification':'Write the specification'} · General, Products, Execution</summary>${parts}</details>${sourceDisclosure(s)}</article>`;
  }
  function sectionTable(s) { return `<article class="sp-section" data-sec="${s.id}">${sectionHead(s)}${itemsTable(s,true)}${sourceDisclosure(s)}</article>`; }

  /* Base grid per section kind, then user columns appended. */
  function baseCols(s) {
    return s.kind === 'locations'
      ? [['mark', 'No.', 0], ['label', 'Room', 0], ['level', 'Level', 0], ['area', 'Area', 0], ['spec', 'Spec / links', 0]]
      : [['mark', 'Mark', 0], ['label', 'Type', 0], ['level', 'Level', 0], ['qty', 'Qty', 0], ['sourceDetails', 'Source properties', 0],
         ['manufacturer', 'Manufacturer', 1], ['model', 'Model', 1], ['finish', 'Finish', 1], ['spec', 'Status / links', 0]];
  }
  const userCols = (s) => (s.columns || []).filter((c) => c && c.id);

  function itemsTable(s, wide) {
    const list = visibleItems(s.id);
    const cols = baseCols(s);
    const ucols = userCols(s);
    const span = cols.length + ucols.length;
    const groups = new Map();
    list.forEach((i) => {
      const k = S.groupBy === 'none' ? '' : (i[S.groupBy] || (S.groupBy === 'itemSection' ? (i.itemSection ? MF.fmt(i.itemSection) : 'unmapped') : '—'));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    const rows = [...groups.entries()].map(([g, arr]) => {
      const head = g ? `<tr class="sp-grouprow"><td colspan="${span + 1}">${esc(g)} · ${arr.length}</td></tr>` : '';
      return head + arr.map((i) => { const gs = gapsOf(i, s); return `<tr data-item="${i.id}" class="${i.status === 'removed' ? 'removed' : ''}${gs.length ? ' hasgap' : ''}">
        ${cols.map(([k, label, ed]) => `<td data-label="${esc(label)}"${ed ? ` class="ed${gs.includes(k) ? ' blank' : ''}" data-cell="${i.id}" data-field="${k}"` : ''}>${cell(i, k)}</td>`).join('')}
        ${ucols.map((c) => `<td data-label="${esc(c.label)}" class="ed u${gs.includes('col:' + c.id) ? ' blank' : ''}" data-cell="${i.id}" data-col="${c.id}" data-type="${c.type}">${userCell(i, c)}</td>`).join('')}
        <td class="sp-rowend"><button class="sp-icon" data-open="${i.id}" title="Open item">⤢</button></td>
      </tr>`; }).join('');
    }).join('');
    const empty = list.length ? '' : `<tr><td colspan="${span + 1}"><span class="sp-muted">No rows yet.</span></td></tr>`;
    return `<div class="sp-tablewrap"><table class="sp-table"><thead><tr>
        ${cols.map(([, t]) => `<th>${t}</th>`).join('')}
        ${ucols.map((c) => `<th class="u"><button class="sp-colh" data-colmenu="${c.id}" data-sec="${s.id}">${esc(c.label)} <span class="sp-coltype">${esc(c.type)}</span></button></th>`).join('')}
        <th class="sp-rowend"><button class="sp-icon" data-addcol="${s.id}" title="Add column">+</button></th>
      </tr></thead><tbody>${rows}${empty}</tbody></table></div>
      <div class="sp-tablefoot">
        <button class="sp-btn sp-btn-ghost sp-btn-sm" data-addrow="${s.id}">+ Add row</button>
        <button class="sp-btn sp-btn-ghost sp-btn-sm" data-addcol="${s.id}">+ Add column</button>
        <span class="sp-muted">Click a cell to edit · paste or drop an image into an image cell · Ctrl+Z undoes</span>
      </div>`;
  }

  function cell(i, k) {
    const sp = i.spec || {};
    if (k === 'spec') {
      const links = (sp.links || []).length;
      return `${sp.approval && sp.approval !== 'draft' ? `<span class="sp-tag ok">${esc(sp.approval)}</span>` : '<span class="sp-tag">draft</span>'}`
        + (links ? `<span class="sp-tag link">${links} link${links > 1 ? 's' : ''}</span>` : '<span class="sp-tag miss">no link</span>')
        + (i.mismatch ? '<span class="sp-tag bad">cross-division</span>' : '')
        + (i.source === 'manual' ? '<span class="sp-tag">manual</span>' : '');
    }
    if (['manufacturer', 'model', 'finish'].includes(k)) return esc(sp[k] || '') || '<span class="sp-ph">—</span>';
    if (k === 'area') return i.area != null ? esc(i.area + ' ' + (i.areaUnit || '')) : '';
    if (k === 'label') { const sourceName=i.fields?.Item||i.fields?.Product;return esc(sourceName||i.type||i.label||'')+(sourceName&&i.fields?.Notes?`<div class="sp-sub">${esc(i.fields.Notes)}</div>`:i.family&&i.type?`<div class="sp-sub">${esc(i.family)}</div>`:''); }
    if (k === 'qty') return esc([sourceQuantity(i),i.fields?.Unit||i.quantityUnit||''].filter(value=>value!==''&&value!=null).join(' '));
    if (k === 'sourceDetails') return Object.entries(i.fields||{}).filter(([key,value])=>value!=null&&value!==''&&!/^(?:mark|type|item|product|family|level|qty|quantity|unit)$/i.test(key)).map(([key,value])=>`<div class="sp-source-property"><small>${esc(key)}: </small><span>${esc(value)}</span></div>`).join('')||'—';
    return esc(num(i[k]));
  }

  /** A user-defined column cell: text / number / link / image / select. */
  function userCell(i, c) {
    const v = ((i.spec || {}).custom || {})[c.id];
    if (c.type === 'image') {
      const imgs = Array.isArray(v) ? v : (v ? [v] : []);
      return `<div class="sp-imgs">${imgs.map((im, ix) => `<span class="sp-thumb"><img src="${esc(im.url)}" alt="${esc(im.name || '')}" loading="lazy" data-img="${esc(im.url)}" /><button class="sp-x" data-imgdel="${ix}" title="Remove">×</button></span>`).join('')}
        <button class="sp-drop" data-imgadd="1" title="Add image — click, paste or drop">＋</button></div>`;
    }
    if (c.type === 'link') {
      const links = Array.isArray(v) ? v : (v ? [v] : []);
      return links.length
        ? `<div class="sp-cellinks">${links.map((l, ix) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || hostOf(l.url) || l.url)}</a><button class="sp-x" data-linkdel="${ix}">×</button>`).join('')}<button class="sp-plus" data-linkadd="1">＋</button></div>`
        : `<button class="sp-plus" data-linkadd="1">＋ link</button>`;
    }
    return (v == null || v === '') ? '<span class="sp-ph">—</span>' : esc(v);
  }

  function locationSummary(s) {
    const locSecs = S.sections.filter((x) => x.kind === 'locations');
    const levels = [...new Set(itemsOf(s.id).map((i) => i.level).filter(Boolean))];
    const rooms = locSecs.flatMap((x) => itemsOf(x.id));
    return `<div class="sp-art-body"><div class="sp-rich" contenteditable="true" data-sec="${s.id}" data-art="3.6" data-ph="Installation locations…">${esc((s.body || {})['3.6'] || '')}</div>
      <p style="font-size:12px;color:var(--tx-2);margin:6px 0 0">Occurs on: ${levels.length ? levels.map((l) => `<span class="sp-tag">${esc(l)}</span>`).join('') : '—'}${rooms.length ? ` · room registry available (${rooms.length} rooms)` : ''}</p></div>`;
  }

  function renderIssues(host) {
    const unmapped = S.sections.filter(needsMapping);
    const mism = S.items.filter((i) => i.mismatch && i.status !== 'removed');
    const removed = S.items.filter((i) => i.status === 'removed');
    host.innerHTML = `<div class="sp-section">
      <div class="sp-sec-head"><div class="sp-sec-num">QUALITY CONTROL</div><h2 class="sp-sec-title">Issues &amp; mapping gaps</h2></div>
      <div class="sp-part"><div class="sp-part-h">Sections needing a MasterFormat number (${unmapped.length})</div>
        ${unmapped.length ? unmapped.map((s) => `<div class="sp-link"><span class="t">${esc(s.scheduleName)}</span><button class="sp-btn sp-btn-sm" data-remap="${s.id}">Map</button></div>`).join('') : '<p class="sp-empty">All sections mapped.</p>'}</div>
      <div class="sp-part"><div class="sp-part-h">Items whose content belongs to another division (${mism.length})</div>
        ${mism.length ? `<div class="sp-tablewrap"><table class="sp-table"><thead><tr><th>Item</th><th>In section</th><th>Suggested</th><th></th></tr></thead><tbody>
          ${mism.slice(0, 200).map((i) => { const s = S.sections.find((x) => x.id === i.sectionId) || {}; return `<tr data-item="${i.id}"><td>${esc(i.label)}</td><td>${esc(s.scheduleName || '')}</td><td>${i.itemSection ? MF.fmt(i.itemSection) + ' ' + esc(i.itemSectionTitle || '') : '—'}</td><td><button class="sp-btn sp-btn-sm sp-btn-ghost" data-move="${i.id}">Move</button></td></tr>`; }).join('')}
        </tbody></table></div>` : '<p class="sp-empty">No cross-division items.</p>'}</div>
      <div class="sp-part"><div class="sp-part-h">Removed from source but kept (${removed.length})</div>
        ${removed.length ? removed.slice(0, 100).map((i) => `<div class="sp-link"><span class="t">${esc(i.label)} — ${esc(i.sourceSchedule || '')}</span><span class="sp-tag">${(i.removedAt || '').slice(0, 10)}</span></div>`).join('') : '<p class="sp-empty">Nothing removed.</p>'}</div>
    </div>`;
    wireContent(host);
  }

  function wireContent(host) {
    $$('[data-book-role]',host).forEach(button=>button.onclick=async()=>{const sid=S.sid,epoch=S.epoch,section=S.sections.find(s=>s.id===button.dataset.bookRole);if(!section)return;button.disabled=true;try{await ST.setDocIn('sections',sid,section.id,{bookRole:isReferenceSection(section)?'specification':'reference',updatedAt:nowISO()});if(S.sid===sid&&S.epoch===epoch)toast('Book organization saved. Source rows and notes are preserved.');}catch(error){if(S.sid===sid&&S.epoch===epoch){button.disabled=false;toast(error.message);}}});

    $$('[data-remap]', host).forEach((b) => b.onclick = (e) => { e.stopPropagation(); remapDialog(b.dataset.remap); });
    $$('[data-move]', host).forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const it = S.items.find((i) => i.id === b.dataset.move); if (!it) return;
      const target = S.sections.find((s) => secNum(s) === it.itemSection);
      if (target) { await ST.setDocIn('items', S.sid, it.id, { sectionId: target.id, mismatch: false, updatedAt: nowISO() }); toast('Moved to ' + target.scheduleName); }
      else { const id = await createSectionFor(it.itemSection, it.itemSectionTitle); await ST.setDocIn('items', S.sid, it.id, { sectionId: id, mismatch: false, updatedAt: nowISO() }); toast('New section created'); }
    });
    $$('[data-share]', host).forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      S.activeSec = b.dataset.share; renderRail(); renderContent(); exportDialog();
      const sel = $('#ex-scope'); if (sel) sel.value = 'sec';
    });
    $$('[data-open]', host).forEach((b) => b.onclick = (e) => { e.stopPropagation(); openItem(b.dataset.open); });
    $$('[data-addcol]', host).forEach((b) => b.onclick = (e) => { e.stopPropagation(); addColumnDialog(b.dataset.addcol); });
    $$('[data-addrow]', host).forEach((b) => b.onclick = (e) => { e.stopPropagation(); addRow(b.dataset.addrow); });
    $$('[data-colmenu]', host).forEach((b) => b.onclick = (e) => { e.stopPropagation(); columnDialog(b.dataset.sec, b.dataset.colmenu); });
    $$('img[data-img]', host).forEach((im) => im.onclick = (e) => { e.stopPropagation(); lightbox(im.dataset.img); });
    wireCells(host);
    $$('.sp-rich', host).forEach((el) => {
      el.addEventListener('blur', async () => {
        const s = S.sections.find((x) => x.id === el.dataset.sec); if (!s) return;
        const body = { ...(s.body || {}) };
        if (String(body[el.dataset.art] || '') === el.innerText.trim()) return;
        body[el.dataset.art] = el.innerText.trim();
        await applyEdits(`Edit ${el.dataset.art} — ${s.scheduleName}`, [{ kind: 'sections', id: s.id, patch: { body, userEdited: true } }]);
      });
    });
  }

  /* ---------------- spreadsheet-style cells ---------------- */
  const cellVal = (i, td) => td.dataset.col
    ? ((i.spec || {}).custom || {})[td.dataset.col]
    : (i.spec || {})[td.dataset.field];

  /** Persist one cell. Everything routes through applyEdits so it is reversible. */
  async function writeCell(td, value) {
    const i = S.items.find((x) => x.id === td.dataset.cell); if (!i) return;
    const spec = { ...(i.spec || {}) };
    let label;
    if (td.dataset.col) {
      spec.custom = { ...(spec.custom || {}) };
      spec.custom[td.dataset.col] = value;
      const sec = S.sections.find((s) => s.id === i.sectionId) || {};
      const col = userCols(sec).find((c) => c.id === td.dataset.col) || {};
      label = `${col.label || 'Column'} — ${i.label || i.mark || 'row'}`;
    } else {
      spec[td.dataset.field] = value;
      label = `${td.dataset.field} — ${i.label || i.mark || 'row'}`;
    }
    await applyEdits(label, [{ kind: 'items', id: i.id, patch: { spec } }]);
  }

  function wireCells(host) {
    $$('td.ed', host).forEach((td) => {
      const type = td.dataset.type || 'text';
      if (type === 'image') return wireImageCell(td);
      if (type === 'link') {
        const i = S.items.find((x) => x.id === td.dataset.cell);
        const add = $('[data-linkadd]', td);
        if (add) add.onclick = (e) => { e.stopPropagation(); cellLinkDialog(td); };
        $$('[data-linkdel]', td).forEach((b) => b.onclick = async (e) => {
          e.stopPropagation();
          const cur = cellVal(i, td); const arr = Array.isArray(cur) ? cur.slice() : (cur ? [cur] : []);
          arr.splice(Number(b.dataset.linkdel), 1); await writeCell(td, arr);
        });
        $$('a', td).forEach((a) => a.onclick = (e) => e.stopPropagation());
        return;
      }
      td.onclick = (e) => {
        if (td.classList.contains('editing')) return;
        e.stopPropagation(); startCellEdit(td, type);
      };
    });
  }

  function startCellEdit(td, type) {
    const i = S.items.find((x) => x.id === td.dataset.cell); if (!i) return;
    const cur = cellVal(i, td);
    td.classList.add('editing');
    td.innerHTML = `<input class="sp-cellin" type="${type === 'number' ? 'number' : 'text'}" value="${esc(cur == null ? '' : cur)}" />`;
    const inp = $('input', td);
    inp.focus(); inp.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const v = type === 'number' ? (inp.value === '' ? '' : Number(inp.value)) : inp.value;
      td.classList.remove('editing');
      if (save && String(v) !== String(cur == null ? '' : cur)) await writeCell(td, v);
      else renderContent();
    };
    inp.onblur = () => finish(true);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Tab') { finish(true); }
    };
  }

  /* ----- image cells: click / paste / drop ----- */
  function wireImageCell(td) {
    const i = S.items.find((x) => x.id === td.dataset.cell); if (!i) return;
    const pick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = () => addImages(td, Array.from(inp.files || []));
      inp.click();
    };
    const add = $('[data-imgadd]', td);
    if (add) add.onclick = (e) => { e.stopPropagation(); pick(); };
    $$('[data-imgdel]', td).forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const cur = cellVal(i, td); const arr = Array.isArray(cur) ? cur.slice() : (cur ? [cur] : []);
      arr.splice(Number(b.dataset.imgdel), 1); await writeCell(td, arr);
    });
    td.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); td.classList.add('over'); };
    td.ondragleave = () => td.classList.remove('over');
    td.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation(); td.classList.remove('over');
      const files = Array.from(e.dataTransfer.files || []).filter((f) => /^image\//.test(f.type));
      if (files.length) return addImages(td, files);
      const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (url && /^https?:/.test(url)) addImageUrls(td, [url]);
    };
    td.tabIndex = 0;
    td.onpaste = (e) => {
      const items = Array.from((e.clipboardData || {}).items || []);
      const files = items.filter((x) => x.kind === 'file' && /^image\//.test(x.type)).map((x) => x.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); return addImages(td, files); }
      const txt = (e.clipboardData || {}).getData ? e.clipboardData.getData('text') : '';
      if (txt && /^https?:\/\/\S+$/.test(txt.trim())) { e.preventDefault(); addImageUrls(td, [txt.trim()]); }
    };
  }

  async function addImages(td, files) {
    if (!files.length) return;
    const i = S.items.find((x) => x.id === td.dataset.cell); if (!i) return;
    toast(`Uploading ${files.length} image${files.length > 1 ? 's' : ''}…`, 4000);
    const out = [];
    for (const f of files) {
      try { out.push(await ST.uploadImage(S.sid, f, i.id)); }
      catch (e) { toast('Image failed: ' + (e.message || e), 5000); }
    }
    if (!out.length) return;
    const cur = cellVal(i, td); const arr = Array.isArray(cur) ? cur.slice() : (cur ? [cur] : []);
    await writeCell(td, arr.concat(out));
    if (out.some((o) => o.inline)) toast('Stored inline (Storage unavailable)', 4000);
  }

  async function addImageUrls(td, urls) {
    const i = S.items.find((x) => x.id === td.dataset.cell); if (!i) return;
    const cur = cellVal(i, td); const arr = Array.isArray(cur) ? cur.slice() : (cur ? [cur] : []);
    await writeCell(td, arr.concat(urls.map((u) => ({ url: u, name: hostOf(u) }))));
  }

  function lightbox(url) {
    modal(`<div class="sp-lightbox"><img src="${esc(url)}" alt="" /></div>
      <div class="sp-modal-actions"><a class="sp-btn sp-btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">Open original</a>
      <button class="sp-btn" id="lb-close">Close</button></div>`, (c) => { $('#lb-close', c).onclick = closeModal; });
  }

  function cellLinkDialog(td) {
    const i = S.items.find((x) => x.id === td.dataset.cell); if (!i) return;
    modal(`<h3>Add link</h3>
      <div class="sp-form">
        <div class="sp-row"><label>URL</label><input id="cl-url" placeholder="https://…" /></div>
        <div class="sp-row"><label>Label</label><input id="cl-title" placeholder="Product page, cut sheet, submittal…" /></div>
      </div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="cl-cancel">Cancel</button><button class="sp-btn" id="cl-ok">Add</button></div>`, (c) => {
      $('#cl-cancel', c).onclick = closeModal;
      $('#cl-ok', c).onclick = async () => {
        const url = $('#cl-url', c).value.trim(); if (!url) return toast('URL required');
        const cur = cellVal(i, td); const arr = Array.isArray(cur) ? cur.slice() : (cur ? [cur] : []);
        arr.push({ url, title: $('#cl-title', c).value.trim() || hostOf(url) });
        closeModal(); await writeCell(td, arr);
      };
      setTimeout(() => $('#cl-url', c).focus(), 30);
    });
  }

  /* ---------------- columns & rows ---------------- */
  function addColumnDialog(secId) {
    modal(`<h3>Add column</h3>
      <div class="sp-form">
        <div class="sp-row"><label>Column name</label><input id="ac-label" placeholder="e.g. Cut sheet, Photo, Lead time" /></div>
        <div class="sp-row"><label>Type</label><select id="ac-type">
          <option value="text">Text</option><option value="number">Number</option>
          <option value="link">Link(s)</option><option value="image">Image(s)</option>
        </select><span class="hint">Image and link columns accept several values per row. Images can be dropped or pasted straight into the cell.</span></div>
      </div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="ac-cancel">Cancel</button><button class="sp-btn" id="ac-ok">Add column</button></div>`, (c) => {
      $('#ac-cancel', c).onclick = closeModal;
      $('#ac-ok', c).onclick = async () => {
        const s = S.sections.find((x) => x.id === secId); if (!s) return;
        const label = $('#ac-label', c).value.trim() || 'Column';
        const col = { id: 'c' + Math.random().toString(36).slice(2, 8), label, type: $('#ac-type', c).value };
        closeModal();
        await applyEdits(`Add column “${label}”`, [{ kind: 'sections', id: secId, patch: { columns: userCols(s).concat([col]) } }]);
        toast('Column added');
      };
      setTimeout(() => $('#ac-label', c).focus(), 30);
    });
  }

  function columnDialog(secId, colId) {
    const s = S.sections.find((x) => x.id === secId); if (!s) return;
    const cols = userCols(s); const col = cols.find((c) => c.id === colId); if (!col) return;
    modal(`<h3>Column — ${esc(col.label)}</h3>
      <div class="sp-form">
        <div class="sp-row"><label>Name</label><input id="cd-label" value="${esc(col.label)}" /></div>
        <div class="sp-row"><label>Type</label><select id="cd-type">
          ${['text', 'number', 'link', 'image'].map((t) => `<option value="${t}"${t === col.type ? ' selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="sp-row"><label>Order</label><div class="sp-inline">
          <button class="sp-btn sp-btn-ghost sp-btn-sm" id="cd-left">← move left</button>
          <button class="sp-btn sp-btn-ghost sp-btn-sm" id="cd-right">move right →</button>
        </div></div>
      </div>
      <div class="sp-modal-actions">
        <button class="sp-btn sp-btn-ghost bad" id="cd-del">Delete column</button>
        <button class="sp-btn sp-btn-ghost" id="cd-cancel">Cancel</button>
        <button class="sp-btn" id="cd-ok">Save</button>
      </div>`, (c) => {
      const save = async (next, label) => { closeModal(); await applyEdits(label, [{ kind: 'sections', id: secId, patch: { columns: next } }]); };
      const move = (dir) => {
        const ix = cols.findIndex((x) => x.id === colId); const to = ix + dir;
        if (to < 0 || to >= cols.length) return;
        const next = cols.slice(); next.splice(to, 0, next.splice(ix, 1)[0]);
        save(next, `Reorder column “${col.label}”`);
      };
      $('#cd-left', c).onclick = () => move(-1);
      $('#cd-right', c).onclick = () => move(1);
      $('#cd-cancel', c).onclick = closeModal;
      $('#cd-del', c).onclick = () => save(cols.filter((x) => x.id !== colId), `Delete column “${col.label}”`);
      $('#cd-ok', c).onclick = () => save(cols.map((x) => x.id === colId
        ? { ...x, label: $('#cd-label', c).value.trim() || x.label, type: $('#cd-type', c).value } : x), `Edit column “${col.label}”`);
    });
  }

  /** Manual row: never touched or pruned by re-imports. */
  async function addRow(secId) {
    const s = S.sections.find((x) => x.id === secId); if (!s) return;
    const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const order = (itemsOf(secId).reduce((m, i) => Math.max(m, i.order || 0), 0) || 0) + 1;
    const patch = {
      sectionId: secId, sourceSchedule: s.scheduleName, source: 'manual', status: 'active',
      mark: '', label: 'New item', type: 'New item', level: '', qty: null, order,
      spec: SP.emptySpec(), createdAt: nowISO()
    };
    await applyEdits('Add row', [{ kind: 'items', id, patch, before: null, created: true }]);
    setTimeout(() => openItem(id), 60);
  }

  /* ---------------- reversible edits ---------------- */
  function snapOf(kind, id, patch) {
    const cur = (kind === 'items' ? S.items : S.sections).find((x) => x.id === id) || {};
    const before = {};
    Object.keys(patch).forEach((k) => { before[k] = (cur[k] === undefined ? null : cur[k]); });
    return before;
  }

  /** Write + record an undoable history entry (capped at 50 per project by the store). */
  async function applyEdits(label, ops, opts) {
    const rec = ops.map((o) => ({
      kind: o.kind, id: o.id, created: !!o.created,
      before: o.created ? null : (o.before !== undefined ? o.before : snapOf(o.kind, o.id, o.patch)),
      after: o.patch
    }));
    for (const o of ops) await ST.setDocIn(o.kind, S.sid, o.id, { ...o.patch, updatedAt: nowISO() });
    if (!(opts && opts.silent)) { try { await ST.logEdit(S.sid, { label, ops: rec }); } catch (e) { console.warn('history', e); } }
  }

  async function toggleEntry(h) {
    const ops = h.ops || [];
    if (!h.undone) {
      for (const o of ops.slice().reverse()) {
        if (o.created) await ST.deleteDocIn(o.kind, S.sid, o.id);
        else await ST.setDocIn(o.kind, S.sid, o.id, { ...(o.before || {}), updatedAt: nowISO() });
      }
    } else {
      for (const o of ops) await ST.setDocIn(o.kind, S.sid, o.id, { ...(o.after || {}), updatedAt: nowISO() });
    }
    await ST.setDocIn('history', S.sid, h.id, { undone: !h.undone, undoneAt: nowISO(), undoneBy: ST.me().uid });
    toast(h.undone ? 'Redone' : 'Reverted: ' + (h.label || 'edit'));
  }

  async function undoLast() {
    const h = S.history.find((x) => !x.undone);
    if (!h) return toast('Nothing to undo');
    await toggleEntry(h);
  }
  async function redoLast() {
    const done = S.history.filter((x) => x.undone);
    const h = done[0];
    if (!h) return toast('Nothing to redo');
    await toggleEntry(h);
  }

  function historyDialog() {
    const rows = S.history.length ? S.history.map((h) => `<div class="sp-hrow${h.undone ? ' undone' : ''}">
        <div class="t"><b>${esc(h.label || 'Edit')}</b>
          <span class="sp-muted">${esc(h.byName || '')} · ${new Date(h.at).toLocaleString()} · ${(h.ops || []).length} change${(h.ops || []).length > 1 ? 's' : ''}${h.undone ? ' · reverted' : ''}</span></div>
        <button class="sp-btn sp-btn-sm ${h.undone ? '' : 'sp-btn-ghost'}" data-h="${h.id}">${h.undone ? 'Redo' : 'Undo'}</button>
      </div>`).join('') : '<p class="sp-empty">No edits recorded yet.</p>';
    modal(`<h3>Edit history</h3>
      <p class="hint">The last ${ST.HISTORY_MAX} changes in this project, newest first. Any entry can be reverted or re-applied independently — Ctrl+Z undoes the newest, Ctrl+Shift+Z re-applies it.</p>
      <div class="sp-list">${rows}</div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="h-close">Close</button></div>`, (c) => {
      $('#h-close', c).onclick = closeModal;
      $$('[data-h]', c).forEach((b) => b.onclick = async () => {
        const h = S.history.find((x) => x.id === b.dataset.h); if (!h) return;
        b.disabled = true; await toggleEntry(h); closeModal(); historyDialog();
      });
    });
  }

  async function createSectionFor(number, title) {
    const id = 'sec_' + String(number);
    await ST.setDocIn('sections', S.sid, id, {
      scheduleName: (title || 'Section') + ' (' + MF.fmt(number) + ')', kind: 'spec',
      number, title: title || '', division: String(number).slice(0, 2), needsMapping: false,
      order: 999, body: {}, userMapped: true, updatedAt: nowISO()
    }, true);
    return id;
  }

  function remapDialog(secId) {
    const s = S.sections.find((x) => x.id === secId); if (!s) return;
    modal(`<h3>Map “${esc(s.scheduleName)}” to MasterFormat</h3>
      <div class="sp-form">
        <div class="sp-row"><label>Search sections</label><input id="rm-q" class="sp-inp" placeholder="appliance, tile, lighting, 09…" /></div>
        <div class="sp-row"><label>Section</label><select id="rm-sel" size="8" style="min-height:180px"></select></div>
        <div class="sp-row"><label>Or type a number manually</label><input id="rm-manual" placeholder="e.g. 113100" /></div>
        <div class="sp-row"><label>Displayed division/section title</label><input id="rm-name" value="${esc(s.scheduleName)}" />
          <span class="hint">The schedule name stays the visible heading; the CSI number drives ordering and the mask.</span></div>
      </div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="rm-cancel">Cancel</button><button class="sp-btn" id="rm-ok">Apply</button></div>`, (c) => {
      const sel = $('#rm-sel', c);
      const fill = (t) => { sel.innerHTML = MF.search(t).map((x) => `<option value="${x.number}">${MF.fmt(x.number)} — ${esc(x.title)}</option>`).join(''); };
      fill(s.scheduleName); $('#rm-q', c).oninput = (e) => fill(e.target.value);
      $('#rm-cancel', c).onclick = closeModal;
      $('#rm-ok', c).onclick = async () => {
        const manual = $('#rm-manual', c).value.replace(/\D/g, '');
        const number = manual || sel.value;
        if (!number) return toast('Pick a section');
        const found = MF.SECTIONS.find((x) => x.number === number);
        await ST.setDocIn('sections', S.sid, secId, {
          numberOverride: number, number, title: found ? found.title : '', division: number.slice(0, 2),
          scheduleName: $('#rm-name', c).value || s.scheduleName, needsMapping: false, userMapped: true, updatedAt: nowISO()
        }, true);
        closeModal(); toast('Mapped to ' + MF.fmt(number));
      };
    });
  }

  /* ---------------- item drawer ---------------- */
  /* One scrim serves the section rail and the item drawer; it is the tap-away
   * target on phones, so its visibility must track both. */
  function syncScrim() {
    const on = !$('#drawer').hidden || $('#rail').classList.contains('open');
    $('#scrim').hidden = !on;
    document.body.classList.toggle('sp-locked', on);
  }
  function setRail(open) { $('#rail').classList.toggle('open', !!open); syncScrim(); }
  function openDrawer() { $('#drawer').hidden = false; syncScrim(); }
  function closeDrawer() { $('#drawer').hidden = true; syncScrim(); }

  /** Header height drives the sticky toolbar offset — measure it instead of guessing. */
  function measureHeader() {
    const h = $('.sp-header');
    if (h) document.documentElement.style.setProperty('--hh', h.offsetHeight + 'px');
  }

  function openItem(id) {
    const i = S.items.find((x) => x.id === id); if (!i) return;
    const sp = { ...SP.emptySpec(), ...(i.spec || {}) };
    const sec = S.sections.find((x) => x.id === i.sectionId) || {};
    $('#dr-title').textContent = i.type || i.label || i.mark || 'Item';
    $('#dr-sub').textContent = [sec.scheduleName, secNum(sec) ? MF.fmt(secNum(sec)) : '', i.mark, i.level].filter(Boolean).join(' · ');
    const locked = i.lockedFields || [];
    $('#dr-body').innerHTML = `
      <div class="sp-form">
        <div class="sp-2col">
          <div class="sp-row"><label>Manufacturer</label><input data-f="manufacturer" value="${esc(sp.manufacturer)}" placeholder="e.g. Bosch" /></div>
          <div class="sp-row"><label>Model / product</label><input data-f="model" value="${esc(sp.model)}" placeholder="e.g. HGI8056UC" /></div>
        </div>
        <div class="sp-2col">
          <div class="sp-row"><label>Finish</label><input data-f="finish" value="${esc(sp.finish)}" placeholder="e.g. stainless" /></div>
          <div class="sp-row"><label>Color / code</label><input data-f="color" value="${esc(sp.color)}" placeholder="e.g. RAL 9016" /></div>
        </div>
        <div class="sp-2col">
          <div class="sp-row"><label>Reference standard</label><input data-f="standard" value="${esc(sp.standard)}" placeholder="ASTM / ANSI / NFPA…" /></div>
          <div class="sp-row"><label>Status</label><select data-f="approval">
            ${['draft', 'specified', 'submitted', 'approved', 'installed', 'substituted'].map((o) => `<option ${sp.approval === o ? 'selected' : ''}>${o}</option>`).join('')}
          </select></div>
        </div>
        <div class="sp-row"><label>Specifier notes</label><textarea data-f="notes" placeholder="Performance requirements, substitutions, installation notes…">${esc(sp.notes)}</textarea></div>
        <div class="sp-row"><label>Tags</label><input data-f="tags" value="${esc((sp.tags || []).join(', '))}" placeholder="long-lead, owner-supplied" /></div>
      </div>

      <div class="sp-sub">Reference links (${(sp.links || []).length})</div>
      <div class="sp-links" id="dr-links">${(sp.links || []).map((l, k) => `
        <div class="sp-link">
          <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(l.url))}&sz=32" alt="" />
          <a class="t" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.url)}</a>
          <button class="sp-icon-btn sp-btn-sm" data-rmlink="${k}">✕</button>
        </div>`).join('') || '<p style="color:var(--tx-3);font-size:13px;margin:0">No links yet. Use the browser extension button on any product page, or add one manually.</p>'}
      </div>
      <button class="sp-btn sp-btn-ghost sp-btn-sm" id="dr-addlink" style="margin-top:8px">Add link</button>

      <div class="sp-sub">Source data (owned by Revit / sheet)</div>
      <dl class="sp-kv">
        ${['family', 'type', 'category', 'level', 'group', 'mark', 'qty', 'area', 'size', 'sourceSchedule', 'source', 'status'].filter((k) => i[k] != null && i[k] !== '').map((k) => `<dt>${k}</dt><dd>${esc(i[k])}${i.areaUnit && k === 'area' ? ' ' + esc(i.areaUnit) : ''}</dd>`).join('')}
        ${Object.entries(i.fields || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      </dl>
      <label class="sp-check" style="margin-top:10px"><input type="checkbox" id="dr-lock" ${locked.length ? 'checked' : ''} />
        Freeze source fields (re-imports will not overwrite this row)</label>
      ${i.source === 'manual' ? '<button class="sp-btn sp-btn-ghost sp-btn-sm bad" id="dr-delete" style="margin-top:12px">Delete row</button>' : ''}
      <div style="height:20px"></div>`;
    openDrawer();

    const save = debounce(async () => {
      const spec = { ...sp };
      $$('#dr-body [data-f]').forEach((el) => {
        const f = el.dataset.f;
        spec[f] = f === 'tags' ? el.value.split(',').map((s) => s.trim()).filter(Boolean) : el.value;
      });
      if (JSON.stringify(spec) === JSON.stringify({ ...SP.emptySpec(), ...(i.spec || {}) })) return;
      await applyEdits(`Edit ${i.type || i.label || i.mark || 'item'}`,
        [{ kind: 'items', id, patch: { spec, updatedBy: ST.me().email || ST.me().uid } }]);
    }, 500);
    $$('#dr-body [data-f]').forEach((el) => { el.oninput = save; el.onchange = save; });
    $('#dr-lock').onchange = async (e) => {
      await ST.setDocIn('items', S.sid, id, { lockedFields: e.target.checked ? SP.SOURCE_FIELDS : [] });
      toast(e.target.checked ? 'Row frozen against re-import' : 'Row unfrozen');
    };
    $('#dr-addlink').onclick = () => addLinkDialog(id);
    $$('[data-rmlink]').forEach((b) => b.onclick = async () => {
      const links = (sp.links || []).slice(); links.splice(+b.dataset.rmlink, 1);
      await applyEdits('Remove link', [{ kind: 'items', id, patch: { spec: { ...sp, links } } }]); openItem(id);
    });
    const del = $('#dr-delete');
    if (del) del.onclick = async () => {
      closeDrawer();
      await applyEdits(`Delete row — ${i.type || i.label || i.mark || 'item'}`,
        [{ kind: 'items', id, patch: { status: 'deleted' }, before: { status: i.status || 'active' } }]);
      toast('Row deleted — undo from History');
    };
  }
  const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return ''; } };

  function addLinkDialog(itemId, preset) {
    preset = preset || {};
    modal(`<h3>Add reference link</h3>
      <div class="sp-form">
        <div class="sp-row"><label>URL</label><input id="al-url" value="${esc(preset.url || '')}" placeholder="https://…" /></div>
        <div class="sp-row"><label>Title</label><input id="al-title" value="${esc(preset.title || '')}" placeholder="Product page / cut sheet" /></div>
        <div class="sp-row"><label>Kind</label><select id="al-kind">${['product page', 'cut sheet', 'submittal', 'warranty', 'installation', 'image', 'other'].map((k) => `<option>${k}</option>`).join('')}</select></div>
        <div class="sp-row"><label>Note</label><input id="al-note" value="${esc(preset.note || '')}" /></div>
      </div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="al-cancel">Cancel</button><button class="sp-btn" id="al-ok">Add</button></div>`, (c) => {
      $('#al-cancel', c).onclick = closeModal;
      $('#al-ok', c).onclick = async () => {
        const it = S.items.find((x) => x.id === itemId); if (!it) return closeModal();
        const sp = { ...SP.emptySpec(), ...(it.spec || {}) };
        sp.links = (sp.links || []).concat([{ url: $('#al-url', c).value, title: $('#al-title', c).value, kind: $('#al-kind', c).value, note: $('#al-note', c).value, addedAt: nowISO(), addedBy: ST.me().email || '' }]);
        await applyEdits('Add link', [{ kind: 'items', id: itemId, patch: { spec: sp } }]);
        closeModal(); toast('Link added'); openItem(itemId);
      };
    });
  }

  /** Extension entry: choose target item, then attach. */
  function addLinkFlow(preset) {
    const opts = S.items.filter((i) => i.status !== 'removed').slice(0, 4000);
    modal(`<h3>Add page to a specification item</h3>
      <p style="font-size:13px;color:var(--tx-2);margin:0 0 10px">${esc(preset.title || preset.url)}</p>
      <div class="sp-form">
        <div class="sp-row"><label>Find item</label><input id="af-q" placeholder="type mark, product, room…" /></div>
        <div class="sp-row"><select id="af-sel" size="10" style="min-height:210px"></select></div>
      </div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="af-cancel">Cancel</button><button class="sp-btn" id="af-ok">Attach link</button></div>`, (c) => {
      const sel = $('#af-sel', c);
      const fill = (q) => {
        const t = (q || '').toLowerCase();
        sel.innerHTML = opts.filter((i) => !t || (i.label + i.mark + i.family + i.level).toLowerCase().includes(t))
          .slice(0, 300).map((i) => { const s = S.sections.find((x) => x.id === i.sectionId) || {}; return `<option value="${i.id}">${esc((secNum(s) ? MF.fmt(secNum(s)) + ' · ' : '') + (i.mark ? i.mark + ' · ' : '') + (i.type || i.label) + (i.level ? ' · ' + i.level : ''))}</option>`; }).join('');
      };
      fill(preset.title); if (!sel.options.length) fill('');
      $('#af-q', c).oninput = (e) => fill(e.target.value);
      $('#af-cancel', c).onclick = closeModal;
      $('#af-ok', c).onclick = async () => {
        if (!sel.value) return toast('Pick an item');
        const it = S.items.find((x) => x.id === sel.value);
        const sp = { ...SP.emptySpec(), ...(it.spec || {}) };
        sp.links = (sp.links || []).concat([{ url: preset.url, title: preset.title || preset.url, kind: 'product page', note: preset.note || '', addedAt: nowISO(), addedBy: ST.me().email || '' }]);
        await ST.setDocIn('items', S.sid, it.id, { spec: sp, updatedAt: nowISO() });
        closeModal(); toast('Attached to ' + (it.type || it.label));
        try { if (window.opener) window.close(); } catch (_) {}
      };
    });
  }

  /* ---------------- import ---------------- */
  function importDialog() {
    modal(`<h3>Batch import schedules</h3>
      <div class="sp-drop" id="im-drop">Drop Revit schedule exports here<br><span style="font-size:12px">CSV / TXT / XLSX — every sheet becomes a section</span><br><br>
        <button class="sp-btn sp-btn-ghost sp-btn-sm" id="im-pick">Choose files</button>
        <input type="file" id="im-file" multiple accept=".csv,.txt,.tsv,.xlsx,.xls" hidden />
      </div>
      <div class="sp-row" style="margin-top:10px"><label>…or pull from a Google Sheet</label>
        <input id="im-url" placeholder="https://docs.google.com/spreadsheets/d/…" />
        <span class="hint">Sheet must be link-shared as Viewer. Each import merges — your spec text and links are never overwritten.</span></div>
      <div id="im-preview"></div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="im-cancel">Close</button>
        <button class="sp-btn sp-btn-ghost" id="im-pull">Pull sheet</button>
        <button class="sp-btn" id="im-go" disabled>Import</button></div>`, (c) => {
      let parsed = [];
      const drop = $('#im-drop', c), file = $('#im-file', c), prev = $('#im-preview', c);
      $('#im-cancel', c).onclick = closeModal;
      $('#im-pick', c).onclick = () => file.click();
      file.onchange = () => handle(Array.from(file.files));
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hot'); }));
      drop.addEventListener('drop', (e) => handle(Array.from(e.dataTransfer.files)));
      $('#im-pull', c).onclick = async () => {
        const url = $('#im-url', c).value.trim(); if (!url) return toast('Paste a sheet URL');
        try {
          toast('Fetching sheet…');
          const text = await SP.fetchSheet(url);
          parsed = parsed.concat(PR.parseCSVText(text, 'Sheet'));
          await ST.addDocIn('sources', S.sid, { type: 'gsheet', url, addedAt: nowISO(), addedBy: ST.me().email || '' });
          render();
        } catch (e) { toast(e.message, 5000); }
      };

      async function handle(files) {
        for (const f of files) {
          try { parsed = parsed.concat(await PR.parseFile(f)); }
          catch (e) { toast(f.name + ': ' + e.message, 4000); }
        }
        render();
      }
      function render() {
        parsed = parsed.filter((s) => s.items.length);
        $('#im-go', c).disabled = !parsed.length;
        if (!parsed.length) { prev.innerHTML = ''; return; }
        prev.innerHTML = `<div class="sp-sub">Detected ${parsed.length} schedule(s)</div>
          <div class="sp-tablewrap"><table class="sp-table"><thead><tr><th>Schedule</th><th>Rows</th><th>CSI mask</th><th>Kind</th></tr></thead><tbody>
          ${parsed.map((s, k) => { const loc = MF.isLocationSchedule(s.name); const cl = MF.classify(s.name, s.items.slice(0, 20).map((i) => i.label).join(' '));
            return `<tr><td>${esc(s.name)}</td><td>${s.items.length}</td><td>${loc ? '— (locations)' : (cl.number ? MF.fmt(cl.number) + ' ' + esc(cl.title) : '<span class="sp-tag bad">needs mapping</span>')}</td><td>${loc ? 'location registry' : 'product spec'}</td></tr>`; }).join('')}
          </tbody></table></div>`;
      }
      $('#im-go', c).onclick = async () => {
        $('#im-go', c).disabled = true; $('#im-go', c).textContent = 'Importing…';
        const built = SP.build(parsed, S.project.settings || {});
        const existing = await ST.listIn('items', S.sid);
        const res = await SP.apply(ST, S.sid, built, existing, 'upload');
        closeModal();
        toast(`${res.added} added · ${res.updated} updated · ${res.removed} marked removed`, 4200);
      };
    });
  }

  /* ---------------- sources / sync ---------------- */
  async function sourcesDialog() {
    if (!S.sid || !S.project) return toast('Open a specification project first.');
    const { sid, assertCurrent } = captureSyncOwner();
    let sources;
    try { sources = await ST.listIn('sources', sid); }
    catch (error) {
      try { assertCurrent(); } catch (_) { return; }
      sourceStatus('Source records could not be loaded. Existing specification rows are preserved.');
      modal('<h3>Sources could not be loaded</h3><p role="alert">Check your connection and project access, then retry. Existing specification rows are preserved.</p><div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="sr-cancel">Close</button><button class="sp-btn" id="sr-load-retry">Retry source list</button></div>', c => {
        $('#sr-cancel', c).onclick = closeModal;
        $('#sr-load-retry', c).onclick = () => { try { assertCurrent(); void sourcesDialog(); } catch (_) { closeModal(); } };
      });
      return;
    }
    assertCurrent();
    const sourceName = s => s.label || s.name || s.payload?.[0]?.schedule || s.url || 'Revit model';
    const sourceType = s => ({ revit: 'Revit schedule', 'revit-manifest': 'Revit model', gsheet: 'Google Sheet', upload: 'Uploaded file' }[s.type] || 'Source');
    modal(`<div class="sp-source-heading"><h3>Sync sources</h3>
      <p>Your specification text and links stay intact. Model and spreadsheet values refresh from their sources.</p>
      <input id="sr-filter" aria-label="Find a source" placeholder="Find a source…" /></div>
      <div class="sp-source-scroll"><div class="sp-links">${sources.length ? sources.map((s) => `<div class="sp-link" data-source-row>
        <span class="t"><strong>${esc(sourceName(s))}</strong><small>${esc(sourceType(s))} · ${esc(s.payloadHydrationError || s.lastError || (s.retired ? 'Replaced by a newer source' : s.type === 'revit' && s.rev ? (s.rev === s.appliedRev ? 'Up to date' : 'Update pending') : s.type === 'revit-manifest' ? 'Model source index' : 'Connected'))}</small></span>
        <span class="sp-source-actions">
        <span class="sp-tag">${(s.lastSync || s.addedAt || '').slice(0, 16).replace('T', ' ')}</span>
        ${s.url ? `<button class="sp-btn sp-btn-sm sp-btn-ghost" data-pull="${s.id}">Refresh</button>` : ''}
        <button class="sp-icon-btn sp-btn-sm" data-del="${s.id}" aria-label="Remove source: ${esc(sourceName(s))}">✕</button></span></div>`).join('') : '<p class="sp-muted">No sources yet.</p>'}
      </div>
      <p id="sr-no-results" class="sp-muted" hidden>No matching sources.</p>
      <details id="sr-add-panel" class="sp-source-add"><summary>Add a Google Sheet</summary>
      <div class="sp-row"><label for="sr-url">Sheet link</label><input id="sr-url" placeholder="https://docs.google.com/spreadsheets/d/…" /></div>
      <div class="sp-row"><label for="sr-int">Refresh while app is open</label><select id="sr-int">
        <option value="0">Off</option><option value="60">Every minute</option><option value="300" selected>Every 5 minutes</option><option value="900">Every 15 minutes</option></select></div>
      <p>Keep confidential sheets restricted. You can also import an exported XLSX or CSV from the book.</p></details></div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="sr-cancel">Close</button><button class="sp-btn sp-btn-ghost" id="sr-retry">Refresh schedules</button><button class="sp-btn" id="sr-add">Add source</button></div>`, (c) => {
      $('#sr-cancel', c).onclick = closeModal;
      $('#sr-filter', c).oninput = e => {
        const term = e.target.value.trim().toLocaleLowerCase(); let visible = 0;
        $$('[data-source-row]', c).forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase().includes(term); if (!row.hidden) visible++; });
        $('#sr-no-results', c).hidden = !term || visible > 0;
      };
      $('#sr-retry', c).onclick = async () => {
        const button = $('#sr-retry', c); button.disabled = true; button.textContent = 'Refreshing…';
        try { assertCurrent(); await runSourceSync({ force: true }); assertCurrent(); await sourcesDialog(); }
        catch (error) { toast(error.message, 5000); }
        finally { button.disabled = false; button.textContent = 'Refresh schedules'; }
      };
      $('#sr-add', c).onclick = async () => {
        const url = $('#sr-url', c).value.trim();
        if (!url) { $('#sr-add-panel', c).open = true; $('#sr-url', c).focus(); $('#sr-add-panel', c).scrollIntoView({ block: 'nearest' }); return; }
        assertCurrent();
        await ST.addDocIn('sources', sid, { type: 'gsheet', url, autoSyncSec: +$('#sr-int', c).value, addedAt: nowISO() });
        assertCurrent();
        closeModal(); startAutoSync(); toast('Source added');
      };
      $$('[data-pull]', c).forEach((b) => b.onclick = () => pullSource(sources.find((s) => s.id === b.dataset.pull)));
      $$('[data-del]', c).forEach((b) => b.onclick = async () => { assertCurrent(); await ST.deleteDocIn('sources', sid, b.dataset.del); assertCurrent(); closeModal(); toast('Source removed'); });
    });
  }

  function captureSyncOwner() {
    const sid = S.sid, generation = S.epoch, owner = ST.captureProjectListOwner();
    const assertCurrent = () => {
      owner.assertCurrent();
      if (!sid || S.sid !== sid || S.epoch !== generation) throw new Error('The active specification project changed.');
    };
    return { sid, assertCurrent };
  }

  async function pullSource(src) {
    if (!src || !src.url) return;
    const { sid, assertCurrent } = captureSyncOwner();
    try {
      assertCurrent();
      const text = await SP.fetchSheet(src.url);
      assertCurrent();
      const parsed = PR.parseCSVText(text, src.label || 'Sheet');
      const existing = await ST.listIn('items', sid);
      assertCurrent();
      const res = await SP.apply(ST, sid, SP.build(parsed), existing, 'gsheet:' + src.id, { assertCurrent });
      assertCurrent();
      await ST.setDocIn('sources', sid, src.id, { lastSync: nowISO(), lastResult: res }, true);
      assertCurrent();
      toast(`Sheet synced · ${res.added} new, ${res.updated} updated`);
      return { ok: true };
    } catch (e) {
      try { assertCurrent(); } catch (_) { return { cancelled: true }; }
      sourceStatus('Sheet sync failed. Existing specification rows are preserved.');
      toast('Sync failed: ' + e.message, 5000); return { ok: false };
    }
  }

  let autoTimer = null, autoRun = null, autoPending = false;
  function sourceStatus(message = '') {
    S.syncError = message;
    const badge = $('#mode-badge');
    badge.textContent = message ? 'sync needs attention' : ST.isCloud() ? 'connected' : 'local';
    badge.title = message || (ST.isCloud() ? 'Connected to project storage. Source coverage is shown inside the book.' : 'Data stored on this device only');
    badge.classList.toggle('warn', !!message);
  }
  async function runSourceSync({ force = false } = {}) {
    if (autoRun) {
      if (force) { const { assertCurrent } = captureSyncOwner(); await autoRun; assertCurrent(); return runSourceSync({ force: true }); }
      autoPending = true; return autoRun;
    }
    if (!S.sid || document.hidden) return;
    const { sid, assertCurrent } = captureSyncOwner();
    autoRun = (async () => {
      assertCurrent();
      const sources = await ST.listIn('sources', sid);
      assertCurrent();
      let items = null, completed = 0, failed = 0;
      for (const s of sources) {
        assertCurrent();
        if (s.retired) continue;
        if (s.type === 'gsheet' && (force || s.autoSyncSec)) {
          const last = s.lastSync ? Date.parse(s.lastSync) : 0;
          if (force || Date.now() - last > s.autoSyncSec * 1000) {
            const result = await pullSource(s); if (result?.ok === false) failed++;
          }
        }
        if (s.type === 'revit' && s.rev && (force || s.rev !== s.appliedRev || s.appliedMergeSchema !== 'liber.spec.source-merge.v4')) {
          try {
            assertCurrent();
            if (s.payloadHydrationError) throw new Error(s.payloadHydrationError);
            if (!Array.isArray(s.payload) || !s.payload.length) {
              if (s.payloadEncoding === 'revex-storage-index-v1') throw new Error('The schedule package could not be read. Previous rows are preserved.');
              continue; // package summary documents are not schedule sources
            }
            if (!items) {
              const existing = await ST.listIn('items', sid);
              assertCurrent();
              items = new Map(existing.map(item => [item.id, item]));
            }
            const res = await SP.apply(ST, sid, SP.build(SP.normalisePush(s.payload)), [...items.values()], 'revit:' + s.id, {
              assertCurrent,
              onWrites: writes => writes.forEach(r => items.set(r.id, { ...items.get(r.id), ...r.data, id: r.id }))
            });
            assertCurrent();
            await ST.setDocIn('sources', sid, s.id, { appliedRev: s.rev, appliedPresentationSchema: 'liber.revit.schedule.presentation.v1', appliedMergeSchema: 'liber.spec.source-merge.v4', lastSync: nowISO(), lastResult: res, lastError: null }, true);
            assertCurrent();
            completed++;
          } catch (error) {
            assertCurrent();
            failed++;
            console.warn('[Spec sync]', s.id, error);
            await ST.setDocIn('sources', sid, s.id, { lastError: String(error.message || error).slice(0,400) }, true);
            assertCurrent();
            toast('One schedule needs attention. Open Sync sources to retry.', 5000);
          }
        }
      }
      assertCurrent();
      sourceStatus(failed ? `${failed} schedules need attention. Open Sync sources to retry; existing rows are preserved.` : '');
      if (completed) toast(`${completed} Revit schedules updated. Your notes and links are preserved.`);
    })().catch(error => {
      try { assertCurrent(); sourceStatus('Source sync could not finish. Open Sync sources to retry; existing rows are preserved.'); } catch (_) {}
      console.warn('[Spec sync] stopped', error.message);
    }).finally(() => {
      autoRun = null;
      if (autoPending) { autoPending = false; void runSourceSync(); }
    });
    return autoRun;
  }
  function startAutoSync() {
    clearInterval(autoTimer);
    autoTimer = setInterval(() => { if (!autoRun) void runSourceSync(); }, 30000);
    void runSourceSync();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void runSourceSync(); });

  /* ---------------- inbox (extension queue) ---------------- */
  function inboxDialog() {
    modal(`<h3>Link inbox (${S.inbox.length})</h3>
      <p style="font-size:13px;color:var(--tx-2)">Pages sent from the browser extension that still need an item.</p>
      <div class="sp-links">${S.inbox.length ? S.inbox.map((r) => `<div class="sp-link">
        <span class="t">${esc(r.title || r.url)}</span>
        <button class="sp-btn sp-btn-sm" data-assign="${r.id}">Assign</button>
        <button class="sp-icon-btn sp-btn-sm" data-drop="${r.id}">✕</button></div>`).join('') : '<p class="sp-empty">Inbox empty.</p>'}</div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="ib-close">Close</button></div>`, (c) => {
      $('#ib-close', c).onclick = closeModal;
      $$('[data-assign]', c).forEach((b) => b.onclick = () => {
        const r = S.inbox.find((x) => x.id === b.dataset.assign); closeModal();
        addLinkFlow({ url: r.url, title: r.title, note: r.note });
        ST.setDocIn('inbox', S.sid, r.id, { status: 'done' }, true);
      });
      $$('[data-drop]', c).forEach((b) => b.onclick = async () => { await ST.deleteDocIn('inbox', S.sid, b.dataset.drop); closeModal(); });
    });
  }

  /* ---------------- export ---------------- */
  /* ---------------- share & export ----------------
   * Everything a designer wants to hand over: a real .xlsx (one sheet per
   * schedule + a completeness summary), CSV, the printed CSI book, or a
   * WhatsApp share. On phones the file goes straight into the native share
   * sheet (WhatsApp included); on desktop it downloads and WhatsApp Web opens
   * with the message pre-typed so the file just needs attaching. */

  const SHEET_EXTRA = [['approval', 'Status'], ['links', 'Links'], ['notes', 'Notes']];

  function xlText(i, k, sec) {
    const sp = i.spec || {};
    if (k === 'links') return (sp.links || []).map((l) => l.url).join('\n');
    if (k === 'approval') return sp.approval || 'draft';
    if (k === 'notes') return sp.notes || '';
    if (['manufacturer', 'model', 'finish'].includes(k)) return sp[k] || '';
    if (k === 'label') return i.fields?.Item || i.fields?.Product || i.type || i.label || '';
    if (k === 'sourceDetails') return Object.entries(i.fields||{}).map(([key,value])=>`${key}: ${value??''}`).join('\n');
    if (k === 'area') return i.area == null ? '' : i.area;
    if (k === 'qty') {
      const value=sourceQuantity(i),text=String(value??'').trim();
      // Excel stores at most 15 significant digits. Keep longer values as literal text.
      return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)&&text.replace(/^[+-]?0*|\./g,'').length<=15?Number(text):value;
    }
    if (k === 'quantityUnit') return i.fields?.Unit||i.quantityUnit||'';
    if (k.slice(0, 4) === 'col:') {
      const v = (sp.custom || {})[k.slice(4)];
      if (Array.isArray(v)) return v.map((x) => x && (x.url || x.name) || x).join('\n');
      return v == null ? '' : v;
    }
    return i[k] == null ? '' : i[k];
  }

  function sheetFor(s) {
    const cols = baseCols(s).filter(([k]) => k !== 'spec').concat(s.kind==='locations'?[['sourceDetails','Source properties']]:[['quantityUnit','Unit']]).concat(SHEET_EXTRA)
      .concat(userCols(s).map((c) => ['col:' + c.id, c.label]));
    const rows = [cols.map(([, t]) => t)];
    visibleItems(s.id,true).forEach((i) => rows.push(cols.map(([k]) => xlText(i, k, s))));
    return rows;
  }

  function summaryRows(secs) {
    const r = gapReport(secs);
    const out = [
      [S.project ? S.project.name : 'Specifications'],
      ['Code', S.project ? (S.project.code || '') : ''],
      ['Generated', new Date().toLocaleString()],
      ['Completeness', r.pct + '%'],
      ['Rows', r.rows], ['Fully specified', r.complete], ['With blanks', r.withGaps],
      [],
      ['NEEDS ATTENTION'],
      ...r.chips.map((c) => [c.label, c.n + ' missing']),
      ...(r.unmapped.length ? [['Unmapped sections', r.unmapped.map((x) => x.scheduleName).join(', ')]] : []),
      ...(r.emptyText.length ? [['Sections with no spec text', r.emptyText.map((x) => x.scheduleName).join(', ')]] : []),
      [],
      ['SECTION', 'CSI', 'ROWS', 'INCOMPLETE']
    ];
    secs.forEach((s) => out.push([s.scheduleName, secNum(s) ? MF.fmt(secNum(s)) : 'unmapped', visibleItems(s.id,true).length, gapCount(s.id)]));
    return out;
  }

  const safeName = (t) => String(t || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, '-').slice(0, 31);

  /** Real .xlsx via the SheetJS build already loaded by this app. */
  function workbookBlob(secs) {
    const X = window.XLSX;
    if (!X) return null;
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(summaryRows(secs)), 'Summary');
    const used = new Set(['summary']);
    secs.forEach((s) => {
      const base = safeName(s.scheduleName).replace(/^'+|'+$/g,'').trim() || 'Section';
      let n=base,index=2;while(used.has(n.toLocaleLowerCase())){const suffix=` (${index++})`;n=base.slice(0,31-suffix.length)+suffix;}used.add(n.toLocaleLowerCase());
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(sheetFor(s)), n);
    });
    for(const name of wb.SheetNames)for(const cell of Object.values(wb.Sheets[name]))if(typeof cell?.v==='string'&&cell.v.length>32767)throw new Error('A cell exceeds Excel’s text limit. Use CSV to preserve the complete text.');
    return new Blob([X.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function csvBlob(secs) {
    const rows = [['Section', 'CSI', 'Schedule', 'Mark', 'Family', 'Type', 'Level', 'Qty', 'Area', 'Manufacturer', 'Model', 'Finish', 'Status', 'Links', 'Notes', 'Source properties']];
    secs.forEach((s) => visibleItems(s.id,true).forEach((i) => {
      const sp = i.spec || {};
      rows.push([s.scheduleName, secNum(s) ? MF.fmt(secNum(s)) : '', i.sourceSchedule, i.mark, i.family, xlText(i,'label',s), i.level, xlText(i,'qty',s), i.area,
        sp.manufacturer, sp.model, sp.finish, sp.approval, (sp.links || []).map((l) => l.url).join(' '), sp.notes,xlText(i,'sourceDetails',s)]);
    }));
    return new Blob(['\uFEFF'+rows.map(r=>r.map(value=>{let text=String(value??'');if(typeof value!=='number'&&/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';}).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  }

  /** Deep link back into the platform shell, opening this project (and section). */
  function shareLink(secId) {
    const base = 'https://liberpict.com/liber-apps/';
    const q = ['returnTo=specifications', 'specProjectId=' + encodeURIComponent(S.sid)];
    if (secId) { q.push('section=' + encodeURIComponent(secId)); q.push('view=table'); }
    return base + '?' + q.join('&');
  }

  function waText(secs, secId) {
    const r = gapReport();
    const top = r.chips.slice(0, 4).map((c) => `${c.n} missing ${String(c.label).toLowerCase()}`).join(', ');
    return `*${S.project ? S.project.name : 'Specifications'}*\n`
      + (secId ? `Section: ${secs[0] ? secs[0].scheduleName : ''}\n` : `Spec book · ${secs.length} sections\n`)
      + `${r.pct}% complete (${r.complete}/${r.rows} rows fully specified)\n`
      + (top ? `Needs attention: ${top}\n` : '')
      + `\nOpen in LIBER: ${shareLink(secId)}`;
  }

  /** Native share sheet (WhatsApp/Telegram/Mail) with the file attached; graceful fallbacks. */
  async function shareOut(blob, filename, text) {
    const file = (window.File) ? new File([blob], filename, { type: blob.type }) : null;
    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename, text });
        closeModal(); toast('Shared'); return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') { toast('Share cancelled'); return; }
      console.warn('share failed', e);
    }
    saveBlob(blob, filename);
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    closeModal(); toast(filename + ' downloaded — attach it in WhatsApp', 5000);
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportDialog() {
    const sec = S.activeSec ? S.sections.find((s) => s.id === S.activeSec) : null;
    modal(`<h3>Share &amp; export</h3>
      <div class="sp-form">
        <div class="sp-row"><label>What</label><select id="ex-scope">
          <option value="all">Whole spec book — ${S.sections.length} sections</option>
          ${sec ? `<option value="sec">This section only — ${esc(sec.scheduleName)}</option>` : ''}
        </select><span class="hint">Excel exports one sheet per schedule plus a “Summary” sheet listing every blank that still needs a designer.</span></div>
      </div>
      <div class="sp-sub">Send</div>
      <div class="sp-form">
        <button class="sp-btn sp-w" id="ex-wa-x">Share spreadsheet (WhatsApp, Mail…)</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-wa-t">WhatsApp — status summary + link</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-copy">Copy shareable link</button>
      </div>
      <div class="sp-sub">Download</div>
      <div class="sp-form">
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-xlsx">Excel (.xlsx) — sheet per schedule</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-csv">CSV — flat item register</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-print">Print / PDF — specification sections</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-md">Markdown — section outline</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-json">JSON — full data (round-trip)</button>
      </div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="ex-close">Close</button></div>`, (c) => {
      const scope = () => $('#ex-scope', c).value === 'sec' && sec ? [sec] : sectionsSorted();
      const scopeId = () => ($('#ex-scope', c).value === 'sec' && sec ? sec.id : null);
      const stem = () => ((S.project && (S.project.code || S.project.name)) || 'specifications').replace(/[^\w\-]+/g, '-')
        + ($('#ex-scope', c).value === 'sec' && sec ? '-' + safeName(sec.scheduleName).replace(/[^\w\-]+/g, '-') : '-spec-book');
      const wb = () => { try{const b = workbookBlob(scope()); if (!b) toast('Spreadsheet engine still loading — try again'); return b;}catch(error){toast(error.message||'Excel export failed. Retry or use CSV.',6000);return null;} };

      $('#ex-close', c).onclick = closeModal;
      $('#ex-wa-x', c).onclick = async () => { const b = wb(); if (b) await shareOut(b, stem() + '.xlsx', waText(scope(), scopeId())); };
      $('#ex-wa-t', c).onclick = () => { window.open('https://wa.me/?text=' + encodeURIComponent(waText(scope(), scopeId())), '_blank', 'noopener'); closeModal(); };
      $('#ex-copy', c).onclick = async () => {
        const link = shareLink(scopeId());
        try { await navigator.clipboard.writeText(link); toast('Link copied'); }
        catch (_) { prompt('Copy this link', link); }
      };
      $('#ex-xlsx', c).onclick = () => { const b = wb(); if (b) { const filename=stem()+'.xlsx';saveBlob(b,filename);closeModal();toast('Exported '+filename); } };
      $('#ex-csv', c).onclick = () => { saveBlob(csvBlob(scope()), stem() + '.csv'); closeModal(); toast('Exported CSV'); };
      $('#ex-print', c).onclick = () => {
        const selected=scopeId()?scope():scope().filter(s=>!isReferenceSection(s));
        const previous={filter:S.filter,gap:S.gap}; S.filter='';S.gap=null;
        let html;try{html=selected.map(sectionBook).join('');}finally{Object.assign(S,previous);}
        const fragment=document.createElement('div');fragment.innerHTML=html;
        fragment.querySelectorAll('button,.sp-source-disclosure,.sp-tablefoot,.sp-sec-sub,.sp-rowend').forEach(node=>node.remove());
        fragment.querySelectorAll('.sp-art').forEach(article=>{if(!article.querySelector('.sp-rich')?.textContent.trim())article.remove();});
        fragment.querySelectorAll('.sp-part').forEach(part=>{if(!part.querySelector('.sp-art,.sp-table'))part.remove();});
        fragment.querySelectorAll('.sp-authored-spec').forEach(details=>{details.querySelector('summary')?.remove();details.replaceWith(...details.childNodes);});
        fragment.querySelectorAll('.sp-sec-head').forEach(head=>{const label=document.createElement('p');label.className='sp-print-project';label.textContent=bookFilename('Spec Book',S.project?.linkedProjectName||S.project?.name);head.prepend(label);});
        const css=`@page{size:A4 landscape;margin:13mm}*{box-sizing:border-box}body{font:11px/1.5 Arial,sans-serif;color:#18212b;margin:0}h1{font-size:22px}h2{font-size:20px}a{color:#255866}.sp-section{break-before:page}.sp-section:first-child{break-before:auto}.sp-sec-head{border-bottom:2px solid #253c47;padding-bottom:10px;margin-bottom:18px;break-after:avoid}.sp-sec-num{font-size:10px;color:#586573}.sp-table{width:100%;border-collapse:collapse;table-layout:fixed}.sp-table th,.sp-table td{border-bottom:1px solid #ccd4da;padding:9px 7px;text-align:left;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}.sp-table th{font-size:10px}.sp-table tr{break-inside:avoid}.sp-part-h{font-weight:bold;margin:20px 0 12px}.sp-art{break-inside:avoid;margin:12px 0}.sp-art-h{font-weight:bold}.sp-rich{white-space:pre-wrap}.sp-native-head{font-size:10px;margin-bottom:10px}.sp-native-head span{margin-left:10px}.sp-tag{font-size:10px;margin-right:6px}.sp-thumb img{max-width:100px;max-height:80px}.sp-muted{color:#586573}.sp-source-property{margin-bottom:7px}.sp-source-property small{display:block;color:#586573;font-size:9px}.sp-source-property span{display:block}.sp-print-project{font-size:10px;color:#586573;margin:0 0 12px}.sp-table:has(th:nth-child(9)):not(:has(th:nth-child(10))) :is(th,td):nth-child(1){width:5%}.sp-table:has(th:nth-child(9)):not(:has(th:nth-child(10))) :is(th,td):nth-child(2){width:16%}.sp-table:has(th:nth-child(9)):not(:has(th:nth-child(10))) :is(th,td):nth-child(3){width:7%}.sp-table:has(th:nth-child(9)):not(:has(th:nth-child(10))) :is(th,td):nth-child(4){width:5%}.sp-table:has(th:nth-child(9)):not(:has(th:nth-child(10))) :is(th,td):nth-child(5){width:22%}`;
        try{printBookDocument({title:bookFilename('Spec Book',S.project?.linkedProjectName||S.project?.name),html:fragment.innerHTML||'<p>No specification sections included.</p>',css});closeModal();}catch(error){toast(error.message);}
      };
      $('#ex-json', c).onclick = () => dl(JSON.stringify({ project: S.project, sections: S.sections, items: S.items }, null, 2), stem() + '.json', 'application/json');
      $('#ex-md', c).onclick = () => {
        let out = `# ${S.project.name}\n\n`;
        const secs = scope();
        const divs = [...new Set(secs.map(secDiv))].sort();
        divs.forEach((d) => {
          out += `\n## Division ${d} — ${MF.divisionTitle(d)}\n`;
          secs.filter((s) => secDiv(s) === d).forEach((s) => {
            out += `\n### ${secNum(s) ? MF.fmt(secNum(s)) : '— — —'} ${s.scheduleName}\n`;
            MF.SECTIONFORMAT.forEach((p) => {
              out += `\n**PART ${p.number} — ${p.title}**\n`;
              p.articles.forEach((a) => {
                if (a.itemTable) {
                  out += `\n${a.number} ${a.title}\n\n| Mark | Type | Level | Qty | Manufacturer | Model |\n|---|---|---|---|---|---|\n`;
                  visibleItems(s.id).forEach((i) => { const sp = i.spec || {}; out += `| ${i.mark || ''} | ${i.type || i.label} | ${i.level || ''} | ${i.qty == null ? '' : i.qty} | ${sp.manufacturer || ''} | ${sp.model || ''} |\n`; });
                } else {
                  const t = (s.body || {})[a.number];
                  if (t) out += `\n${a.number} ${a.title}\n${t}\n`;
                }
              });
            });
          });
        });
        dl(out, stem() + '.md', 'text/markdown');
      };
    });
  }

  function dl(text, name, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000); closeModal(); toast('Exported ' + name);
  }

  /* ---------------- overflow menu ---------------- */
  function menuDialog() {
    modal(`<h3>${esc(S.project ? S.project.name : 'Specifications')}</h3>
      <div class="sp-form">
        <button class="sp-btn sp-btn-ghost sp-w" id="mn-sources">Sync sources</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="mn-inbox">Link inbox</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="mn-export">Export</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="mn-projects">All projects</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="mn-ext">Browser extension setup</button>
        ${S.project ? `<button class="sp-btn sp-btn-ghost sp-w" id="mn-del" style="border-color:#5a2530;color:#ff9a9a">Delete this spec project</button>` : ''}
      </div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="mn-close">Close</button></div>`, (c) => {
      $('#mn-close', c).onclick = closeModal;
      $('#mn-sources', c).onclick = () => { closeModal(); sourcesDialog(); };
      $('#mn-inbox', c).onclick = () => { closeModal(); inboxDialog(); };
      $('#mn-export', c).onclick = () => { closeModal(); exportDialog(); };
      $('#mn-projects', c).onclick = () => { closeModal(); renderProjects(); };
      $('#mn-ext', c).onclick = () => { closeModal(); extensionDialog(); };
      const d = $('#mn-del', c);
      if (d) d.onclick = async () => { if (!confirm('Delete this specification project and all its sections/items?')) return; await ST.deleteProject(S.sid); S.sid = null; localStorage.removeItem('liber.spec.last'); closeModal(); renderProjects(); };
    });
  }

  function extensionDialog() {
    const origin = location.origin + location.pathname.replace(/index\.html$/, '');
    modal(`<h3>Browser extension</h3>
      <p style="font-size:13px;color:var(--tx-2)">The “Add to Specifications” extension opens this dialog with the current tab's URL, so no separate login is needed — it reuses your Liber session.</p>
      <div class="sp-row"><label>Handoff URL used by the extension</label>
        <input readonly value="${esc(origin.replace(/apps\/specifications\/$/, ''))}index.html?returnTo=specifications&amp;specUrl=…&amp;specTitle=…" /></div>
      <div class="sp-row"><label>Current spec project id</label><input readonly value="${esc(S.sid || '')}" /></div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="ex2-close">Close</button></div>`, (c) => { $('#ex2-close', c).onclick = closeModal; });
  }

  let booted = false;
  const start = () => { if (booted) return; booted = true; boot().then(startAutoSync); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
