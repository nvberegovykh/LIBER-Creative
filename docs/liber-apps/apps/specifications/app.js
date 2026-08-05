/* LIBER Specifications — UI controller */
(function () {
  'use strict';
  const MF = window.MasterFormat, SP = window.SpecSync, ST = window.SpecStore, PR = window.ScheduleParser;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nowISO = () => new Date().toISOString();

  const S = {
    sid: null, project: null, sections: [], items: [], inbox: [], history: [],
    activeSec: null, view: 'book', groupBy: 'none', sortBy: 'order',
    showRemoved: false, filter: '', gap: null, unsub: [], pending: null
  };

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

  /* ---------------- boot ---------------- */
  async function boot() {
    const mode = await ST.init();
    const b = $('#mode-badge');
    b.textContent = mode === 'cloud' ? 'synced' : 'local';
    b.className = 'sp-badge ' + mode;
    b.title = mode === 'cloud' ? 'Live Firestore sync with project participants' : 'Signed out — data stored on this device only';

    wireChrome();
    // Handoff from the browser extension: ?specUrl=&specTitle=  or  #add?url=&title=
    const qs = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, '').replace(/^add\?/, ''));
    const inUrl = qs.get('specUrl') || (location.hash.startsWith('#add') ? hash.get('url') : '');
    if (inUrl) S.pending = { url: inUrl, title: qs.get('specTitle') || hash.get('title') || '', note: qs.get('specNote') || hash.get('note') || '' };
    const forced = qs.get('specProjectId');
    if (forced) localStorage.setItem('liber.spec.last', forced);
    if (qs.get('demo')) return demoSeed();
    const last = localStorage.getItem('liber.spec.last');
    await renderProjects();
    if (last) { const p = await ST.getProject(last); if (p) return openProject(last); }
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

  function wireChrome() {
    $('#btn-home').onclick = () => { showView('projects'); renderProjects(); };
    $('#btn-import').onclick = () => S.sid ? importDialog() : toast('Open or create a project first');
    $('#btn-new-project').onclick = newProjectDialog;
    $('#btn-rail').onclick = () => $('#rail').classList.toggle('open');
    $('#btn-menu').onclick = menuDialog;
    $('#btn-sources').onclick = sourcesDialog;
    $('#btn-export').onclick = exportDialog;
    $('#btn-inbox').onclick = inboxDialog;
    $('#btn-history').onclick = () => S.sid ? historyDialog() : toast('Open a project first');
    $('#dr-close').onclick = closeDrawer;
    $('#scrim').onclick = () => { closeDrawer(); $('#rail').classList.remove('open'); };
    $('#rail-search').oninput = debounce((e) => { S.filter = e.target.value.trim().toLowerCase(); renderRail(); renderContent(); }, 200);
    $$('.sp-seg button').forEach((btn) => btn.onclick = () => {
      $$('.sp-seg button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active'); S.view = btn.dataset.view; renderContent();
    });
    $('#group-by').onchange = (e) => { S.groupBy = e.target.value; renderContent(); };
    $('#sort-by').onchange = (e) => { S.sortBy = e.target.value; renderContent(); };
    $('#show-removed').onchange = (e) => { S.showRemoved = e.target.checked; renderContent(); };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); closeDrawer(); return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || e.target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'z' && !typing && S.sid) {
        e.preventDefault(); e.shiftKey ? redoLast() : undoLast();
      }
    });
  }

  function showView(v) {
    $('#view-projects').hidden = v !== 'projects';
    $('#view-book').hidden = v !== 'book';
  }

  /* ---------------- projects ---------------- */
  async function renderProjects() {
    showView('projects');
    const list = await ST.listProjects();
    const host = $('#projects-list');
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
    S.unsub.forEach((u) => { try { u(); } catch (_) {} });
    S.unsub = [];
    S.sid = sid; localStorage.setItem('liber.spec.last', sid);
    S.project = await ST.getProject(sid);
    if (!S.project) { localStorage.removeItem('liber.spec.last'); return renderProjects(); }
    showView('book');
    $('#crumb').textContent = S.project.name + (S.project.linkedProjectName ? ' · ' + S.project.linkedProjectName : '');
    S.unsub.push(ST.subscribeProject(sid, (p) => { if (p) { S.project = p; } }));
    S.unsub.push(ST.subscribe('sections', sid, (rows) => { S.sections = rows; renderRail(); renderContent(); }));
    S.unsub.push(ST.subscribe('items', sid, (rows) => { S.items = rows; renderRail(); renderContent(); }));
    S.unsub.push(ST.subscribe('inbox', sid, (rows) => { S.inbox = rows.filter((r) => r.status !== 'done'); $('#inbox-count').textContent = S.inbox.length; }));
    S.unsub.push(ST.subscribe('history', sid, (rows) => {
      S.history = rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, ST.HISTORY_MAX);
      $('#history-count').textContent = S.history.filter((h) => !h.undone).length;
    }));
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
  const secNum = (s) => s.numberOverride || s.number;
  const secDiv = (s) => (secNum(s) ? String(secNum(s)).slice(0, 2) : (s.division || '01'));
  function itemsOf(secId) { return S.items.filter((i) => i.sectionId === secId); }

  function renderRail() {
    const host = $('#rail-tree');
    if (!S.sections.length) { host.innerHTML = `<p class="sp-empty">No sections yet.<br><button class="sp-btn sp-btn-sm" id="rail-imp">Import schedules</button></p>`; const b = $('#rail-imp'); if (b) b.onclick = importDialog; return; }
    const byDiv = new Map();
    sectionsSorted().forEach((s) => {
      const d = secDiv(s);
      if (!byDiv.has(d)) byDiv.set(d, []);
      byDiv.get(d).push(s);
    });
    const divs = [...byDiv.keys()].sort();
    host.innerHTML = divs.map((d) => `
      <div class="sp-div">
        <div class="sp-div-h"><b>${d}</b><span>${esc(MF.divisionTitle(d))}</span></div>
        ${byDiv.get(d).map((s) => {
          const n = itemsOf(s.id).filter((i) => S.showRemoved || i.status !== 'removed').length;
          const warn = s.needsMapping && !s.numberOverride;
          const g = gapCount(s.id);
          return `<div class="sp-sec ${S.activeSec === s.id ? 'active' : ''}" data-id="${s.id}">
            <code>${secNum(s) ? MF.fmt(secNum(s)) : '– – –'}</code>
            <span class="n">${esc(s.scheduleName)}</span>
            <span class="sp-pill ${warn || g ? 'warn' : ''}" title="${warn ? 'Needs a MasterFormat number' : g ? g + ' of ' + n + ' rows have blanks' : n + ' rows complete'}">${warn ? '!' : g ? g + '/' + n : n}</span></div>`;
        }).join('')}
      </div>`).join('');
    $$('.sp-sec', host).forEach((el) => el.onclick = () => {
      S.activeSec = el.dataset.id; $('#rail').classList.remove('open'); renderRail(); renderContent();
      $('#content').scrollTop = 0;
    });
    const issues = S.sections.filter((s) => s.needsMapping && !s.numberOverride).length + S.items.filter((i) => i.mismatch).length;
    $('#issue-count').textContent = issues;
  }

  /* ---------------- content ---------------- */
  function visibleItems(secId) {
    let list = itemsOf(secId).filter((i) => i.status !== 'deleted').filter((i) => S.showRemoved || i.status !== 'removed');
    if (S.filter) list = list.filter((i) => JSON.stringify(i).toLowerCase().includes(S.filter));
    if (S.gap) { const sec = S.sections.find((s) => s.id === secId) || {}; list = list.filter((i) => gapsOf(i, sec).includes(S.gap)); }
    const dir = (a, b, k) => String(a[k] == null ? '' : a[k]).localeCompare(String(b[k] == null ? '' : b[k]), undefined, { numeric: true });
    list.sort((a, b) => S.sortBy === 'order' ? (a.order || 0) - (b.order || 0)
      : S.sortBy === 'qty' ? (b.qty || 0) - (a.qty || 0)
      : S.sortBy === 'area' ? (b.area || 0) - (a.area || 0)
      : dir(a, b, S.sortBy === 'label' ? 'label' : 'mark'));
    return list;
  }

  function renderContent() {
    const host = $('#content');
    if (!S.sections.length) {
      host.innerHTML = `<p class="sp-empty">This project has no specifications yet.<br><br>
        <button class="sp-btn" id="c-imp">Batch-import Revit schedules</button></p>`;
      const b = $('#c-imp'); if (b) b.onclick = importDialog; return;
    }
    if (S.view === 'issues') return renderIssues(host);
    const list = S.activeSec ? [S.sections.find((s) => s.id === S.activeSec)].filter(Boolean) : sectionsSorted();
    host.innerHTML = attentionPanel() + list.map((s) => S.view === 'table' ? sectionTable(s) : sectionBook(s)).join('');
    wireContent(host);
    wireAttention(host);
  }

  /* ---------------- completeness / “needs attention” ----------------
   * Every blank the designer is expected to fill is a “gap”. Gaps are computed
   * live from the data (no extra bookkeeping), summarised at the top of the
   * project and clickable to filter the book down to exactly those rows. */
  const REQ_PRODUCT = [['manufacturer', 'Manufacturer'], ['model', 'Model'], ['finish', 'Finish'], ['links', 'Reference link']];
  const REQ_LOCATION = []; // rooms are a registry: only user-added columns count as placeholders

  function reqFor(sec) { return sec.kind === 'locations' ? REQ_LOCATION : REQ_PRODUCT; }

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

  function gapReport() {
    const secs = S.activeSec ? S.sections.filter((s) => s.id === S.activeSec) : S.sections;
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
    const unmapped = secs.filter((s) => s.needsMapping && !s.numberOverride);
    const emptyText = secs.filter((s) => s.kind !== 'locations' && !Object.values(s.body || {}).some((t) => String(t || '').trim()));
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
        ${s.title ? 'CSI mask: ' + esc(s.title) + ' · ' : ''}${itemsOf(s.id).filter((i) => i.status !== 'removed').length} items${(() => { const g = gapCount(s.id); return g ? ` · <b class="sp-warntx">${g} incomplete</b>` : ' · complete'; })()}
        ${s.kind === 'locations' ? ' · location registry (not printed as product spec)' : ''}
        <button class="sp-btn sp-btn-ghost sp-btn-sm" data-remap="${s.id}">Remap section</button>
      </div></div>`;
  }

  function sectionBook(s) {
    if (s.kind === 'locations') {
      return `<article class="sp-section" data-sec="${s.id}">${sectionHead(s)}
        <div class="sp-part"><div class="sp-part-h">LOCATION REGISTRY</div>${itemsTable(s)}</div></article>`;
    }
    const body = s.body || {};
    const parts = MF.SECTIONFORMAT.map((p) => `
      <div class="sp-part">
        <div class="sp-part-h">PART ${p.number} — ${p.title}</div>
        ${p.articles.map((a) => `
          <div class="sp-art">
            <div class="sp-art-h">${a.number} ${a.title}</div>
            ${a.itemTable ? itemsTable(s) : a.locationTable ? locationSummary(s) : `
            <div class="sp-art-body"><div class="sp-rich" contenteditable="true" data-sec="${s.id}" data-art="${a.number}"
                 data-ph="Write ${a.title.toLowerCase()}…">${esc(body[a.number] || '')}</div></div>`}
          </div>`).join('')}
      </div>`).join('');
    return `<article class="sp-section" data-sec="${s.id}">${sectionHead(s)}${parts}</article>`;
  }

  function sectionTable(s) {
    return `<article class="sp-section" data-sec="${s.id}">${sectionHead(s)}${itemsTable(s, true)}</article>`;
  }

  /* Base grid per section kind, then user columns appended. */
  function baseCols(s) {
    return s.kind === 'locations'
      ? [['mark', 'No.', 0], ['label', 'Room', 0], ['level', 'Level', 0], ['area', 'Area', 0], ['spec', 'Spec / links', 0]]
      : [['mark', 'Mark', 0], ['label', 'Type', 0], ['level', 'Level', 0], ['qty', 'Qty', 0],
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
        ${cols.map(([k, , ed]) => `<td${ed ? ` class="ed${gs.includes(k) ? ' blank' : ''}" data-cell="${i.id}" data-field="${k}"` : ''}>${cell(i, k)}</td>`).join('')}
        ${ucols.map((c) => `<td class="ed u${gs.includes('col:' + c.id) ? ' blank' : ''}" data-cell="${i.id}" data-col="${c.id}" data-type="${c.type}">${userCell(i, c)}</td>`).join('')}
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
    if (k === 'label') return esc(i.type || i.label || '') + (i.family && i.type ? `<div class="sp-sub">${esc(i.family)}</div>` : '');
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
    const unmapped = S.sections.filter((s) => s.needsMapping && !s.numberOverride);
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
    $$('[data-remap]', host).forEach((b) => b.onclick = (e) => { e.stopPropagation(); remapDialog(b.dataset.remap); });
    $$('[data-move]', host).forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      const it = S.items.find((i) => i.id === b.dataset.move); if (!it) return;
      const target = S.sections.find((s) => secNum(s) === it.itemSection);
      if (target) { await ST.setDocIn('items', S.sid, it.id, { sectionId: target.id, mismatch: false, updatedAt: nowISO() }); toast('Moved to ' + target.scheduleName); }
      else { const id = await createSectionFor(it.itemSection, it.itemSectionTitle); await ST.setDocIn('items', S.sid, it.id, { sectionId: id, mismatch: false, updatedAt: nowISO() }); toast('New section created'); }
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
  function openDrawer() { $('#drawer').hidden = false; $('#scrim').hidden = false; }
  function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }

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
    const sources = await ST.listIn('sources', S.sid);
    modal(`<h3>Sync sources</h3>
      <p style="font-size:13px;color:var(--tx-2);margin:0 0 10px">Spec text and links are yours; quantities, levels and types are owned by the model/sheet and refresh on every pull.</p>
      <div class="sp-links">${sources.length ? sources.map((s) => `<div class="sp-link">
        <span class="t">${esc(s.type)} · ${esc(s.url || s.label || '')}</span>
        <span class="sp-tag">${(s.lastSync || s.addedAt || '').slice(0, 16).replace('T', ' ')}</span>
        ${s.url ? `<button class="sp-btn sp-btn-sm sp-btn-ghost" data-pull="${s.id}">Pull</button>` : ''}
        <button class="sp-icon-btn sp-btn-sm" data-del="${s.id}">✕</button></div>`).join('') : '<p style="color:var(--tx-3);font-size:13px">No sources yet.</p>'}
      </div>
      <div class="sp-row" style="margin-top:12px"><label>Add Google Sheet</label><input id="sr-url" placeholder="https://docs.google.com/spreadsheets/d/…" /></div>
      <div class="sp-row"><label>Auto-pull while app is open</label><select id="sr-int">
        <option value="0">Off</option><option value="60">Every minute</option><option value="300" selected>Every 5 minutes</option><option value="900">Every 15 minutes</option></select></div>
      <div class="sp-sub">Model push endpoint (Revit / Atlantist)</div>
      <p style="font-size:12.5px;color:var(--tx-2)">Write parsed schedules to <code style="font-family:var(--mono)">specProjects/${esc(S.sid)}/sources/&lt;id&gt;</code> with
        <code style="font-family:var(--mono)">{type:'revit', payload:[{schedule, headers, rows}]}</code> — the app merges them live via realtime listeners.</p>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="sr-cancel">Close</button><button class="sp-btn" id="sr-add">Add source</button></div>`, (c) => {
      $('#sr-cancel', c).onclick = closeModal;
      $('#sr-add', c).onclick = async () => {
        const url = $('#sr-url', c).value.trim(); if (!url) return toast('Paste a sheet URL');
        await ST.addDocIn('sources', S.sid, { type: 'gsheet', url, autoSyncSec: +$('#sr-int', c).value, addedAt: nowISO() });
        closeModal(); startAutoSync(); toast('Source added');
      };
      $$('[data-pull]', c).forEach((b) => b.onclick = () => pullSource(sources.find((s) => s.id === b.dataset.pull)));
      $$('[data-del]', c).forEach((b) => b.onclick = async () => { await ST.deleteDocIn('sources', S.sid, b.dataset.del); closeModal(); toast('Source removed'); });
    });
  }

  async function pullSource(src) {
    if (!src || !src.url) return;
    try {
      const text = await SP.fetchSheet(src.url);
      const parsed = PR.parseCSVText(text, src.label || 'Sheet');
      const existing = await ST.listIn('items', S.sid);
      const res = await SP.apply(ST, S.sid, SP.build(parsed), existing, 'gsheet:' + src.id);
      await ST.setDocIn('sources', S.sid, src.id, { lastSync: nowISO(), lastResult: res }, true);
      toast(`Sheet synced · ${res.added} new, ${res.updated} updated`);
    } catch (e) { toast('Sync failed: ' + e.message, 5000); }
  }

  let autoTimer = null;
  async function startAutoSync() {
    clearInterval(autoTimer);
    const run = async () => {
      if (!S.sid || document.hidden) return;
      const sources = await ST.listIn('sources', S.sid);
      for (const s of sources) {
        if (s.type === 'gsheet' && s.autoSyncSec) {
          const last = s.lastSync ? Date.parse(s.lastSync) : 0;
          if (Date.now() - last > s.autoSyncSec * 1000) await pullSource(s);
        }
        if (s.type === 'revit' && s.payload && s.rev !== s.appliedRev) {
          const existing = await ST.listIn('items', S.sid);
          const res = await SP.apply(ST, S.sid, SP.build(SP.normalisePush(s.payload)), existing, 'revit:' + s.id);
          await ST.setDocIn('sources', S.sid, s.id, { appliedRev: s.rev, lastSync: nowISO(), lastResult: res }, true);
          toast('Model push merged · ' + res.added + ' new');
        }
      }
    };
    autoTimer = setInterval(run, 30000); run();
  }

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
  function exportDialog() {
    modal(`<h3>Export specification book</h3>
      <div class="sp-form">
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-print">Print / PDF — full CSI book</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-csv">CSV — flat item register</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-json">JSON — full data (round-trip)</button>
        <button class="sp-btn sp-btn-ghost sp-w" id="ex-md">Markdown — section outline</button>
      </div>
      <div class="sp-modal-actions"><button class="sp-btn sp-btn-ghost" id="ex-close">Close</button></div>`, (c) => {
      $('#ex-close', c).onclick = closeModal;
      $('#ex-print', c).onclick = () => { const a = S.activeSec; S.activeSec = null; renderContent(); setTimeout(() => { window.print(); S.activeSec = a; renderContent(); }, 200); };
      $('#ex-csv', c).onclick = () => {
        const rows = [['Section', 'CSI', 'Schedule', 'Mark', 'Family', 'Type', 'Level', 'Qty', 'Area', 'Manufacturer', 'Model', 'Finish', 'Status', 'Links', 'Notes']];
        sectionsSorted().forEach((s) => visibleItems(s.id).forEach((i) => {
          const sp = i.spec || {};
          rows.push([s.scheduleName, secNum(s) ? MF.fmt(secNum(s)) : '', i.sourceSchedule, i.mark, i.family, i.type, i.level, i.qty, i.area, sp.manufacturer, sp.model, sp.finish, sp.approval, (sp.links || []).map((l) => l.url).join(' '), sp.notes]);
        }));
        dl(rows.map((r) => r.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'specifications.csv', 'text/csv');
      };
      $('#ex-json', c).onclick = () => dl(JSON.stringify({ project: S.project, sections: S.sections, items: S.items }, null, 2), 'specifications.json', 'application/json');
      $('#ex-md', c).onclick = () => {
        let out = `# ${S.project.name}\n\n`;
        const divs = [...new Set(sectionsSorted().map(secDiv))].sort();
        divs.forEach((d) => {
          out += `\n## Division ${d} — ${MF.divisionTitle(d)}\n`;
          sectionsSorted().filter((s) => secDiv(s) === d).forEach((s) => {
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
        dl(out, 'specification-book.md', 'text/markdown');
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
