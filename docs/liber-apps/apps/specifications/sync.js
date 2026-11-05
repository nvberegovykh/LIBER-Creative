/* LIBER Specifications — import / merge / external sync
 * Field ownership model (conflict resolution):
 *   SOURCE-OWNED (Revit / Atlantist / sheet): level, mark, family, type, category, qty, area, size, fields
 *   SPEC-OWNED   (app users):                 spec.* (manufacturer, model, finish, notes, links, status, tags)
 * Nothing is destroyed on re-import: vanished rows become status "removed" and stay linkable.
 */
(function (root) {
  'use strict';
  const MF = () => root.MasterFormat;
  const nowISO = () => new Date().toISOString();
  const SOURCE_FIELDS = ['level', 'group', 'mark', 'roomName', 'family', 'type', 'label', 'category', 'qty', 'area', 'areaUnit', 'size', 'fields', 'sourceSchedule', 'sourceRowIdentity'];

  function sectionIdFor(scheduleName) {
    return 'sec_' + MF().norm(scheduleName).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  }

  /** Build sections + items from parsed schedules, applying the CSI mask. */
  function build(schedules, opts) {
    opts = opts || {};
    const sections = [], items = [];
    schedules.forEach((sch, idx) => {
      const isLoc = MF().isLocationSchedule(sch.name);
      const sample = sch.items.slice(0, 25).map((i) => i.label + ' ' + i.category).join(' ');
      const cls = isLoc ? { number: null, title: null, division: '01' } : MF().classify(sch.name, sample);
      const secId = sectionIdFor(sch.name);
      sections.push({
        id: secId,
        data: {
          scheduleName: sch.name,
          kind: isLoc ? 'locations' : 'spec',
          number: cls.number || null,
          title: cls.title || null,
          division: cls.division || null,
          needsMapping: !isLoc && (!cls.number || cls.needsMapping),
          order: (idx + 1) * 10,
          headers: sch.headers,
          originalHeaders: sch.originalHeaders || sch.headers,
          roles: sch.roles,
          groups: sch.groups,
          totals: sch.totals,
          sourceScheduleId: sch.sourceScheduleId || null,
          nativePresentation: sch.presentation || null,
          nativeSchedule: sch.presentation?.schema === 'liber.revit.schedule.presentation.v1',
          identityReviewCount: sch.identityReviewCount || 0,
          body: {},
          updatedAt: nowISO()
        }
      });
      sch.items.forEach((it, k) => {
        const icls = isLoc ? null : MF().classify(it.label + ' ' + it.category, sch.name);
        items.push({
          id: it.key,
          data: {
            ...pick(it, SOURCE_FIELDS),
            sectionId: secId,
            kind: isLoc ? 'location' : 'item',
            order: (k + 1) * 10,
            itemSection: icls && icls.number ? icls.number : null,
            itemSectionTitle: icls && icls.title ? icls.title : null,
            mismatch: !!(icls && icls.number && cls.number && icls.division !== cls.division),
            status: 'active',
            updatedAt: nowISO()
          }
        });
      });
    });
    if (new Set(items.map(item => item.id)).size !== items.length || new Set(sections.map(section => section.id)).size !== sections.length) {
      throw new Error('These schedules contain conflicting identifiers. Import them as separate sources so every row is preserved.');
    }
    return { sections, items };
  }

  function pick(o, keys) { const r = {}; keys.forEach((k) => { if (o[k] !== undefined) r[k] = o[k]; }); return r; }

  /**
   * Merge a build result into a project, preserving spec-owned data.
   * @returns {added, updated, removed, sections}
   */
  async function apply(store, sid, built, existingItems, sourceLabel, options = {}) {
    const current = options.assertCurrent || (() => {});
    current();
    const byId = new Map((existingItems || []).map((i) => [i.id, i]));
    const seen = new Set();
    const writes = [];
    let added = 0, updated = 0;
    const priorAmbiguous = new Set((existingItems || []).filter(item => item.source === sourceLabel && item.sourceRowIdentity?.legacyKey).map(item => item.sourceRowIdentity.legacyKey));
    // Correcting a column role must not detach authored content from an unchanged row.
    // Reuse only a unique source identity or an exact, unique active source record.
    const exactKey = item => JSON.stringify([item.sourceSchedule || '', Object.entries(item.fields || {}).sort(([a], [b]) => a.localeCompare(b))]);
    const aliases = new Map(), exactRows = new Map(), incomingCounts = new Map();
    for (const item of existingItems || []) {
      if (!sourceLabel || item.source !== sourceLabel || item.status === 'removed') continue;
      if (item.sourceParserKey) { const rows = aliases.get(item.sourceParserKey) || []; rows.push(item); aliases.set(item.sourceParserKey, rows); }
      if (item.fields && Object.keys(item.fields).length) { const key = exactKey(item), rows = exactRows.get(key) || []; rows.push(item); exactRows.set(key, rows); }
    }
    for (const rec of built.items) { const key = exactKey(rec.data); incomingCounts.set(key, (incomingCounts.get(key) || 0) + 1); }

    for (const original of built.items) {
      let rec = original;
      if (!rec.data.sourceRowIdentity && priorAmbiguous.has(rec.id)) {
        const resolved = root.ScheduleParser.contentIdentity(rec.data.fields, rec.id);
        rec = { id: resolved.key, data: { ...rec.data, sourceRowIdentity: resolved.identity } };
      }
      if (!byId.has(rec.id)) {
        const parserKey = rec.id, key = exactKey(rec.data), candidates = aliases.get(parserKey) || [];
        const exact = incomingCounts.get(key) === 1 ? (exactRows.get(key) || []) : [];
        const matched = candidates.length === 1 ? candidates[0] : (exact.length === 1 ? exact[0] : null);
        if (matched && !seen.has(matched.id)) rec = { id: matched.id, data: { ...rec.data, sourceParserKey: parserKey } };
      }
      seen.add(rec.id);
      const prev = byId.get(rec.id);
      if (!prev) {
        added++;
        writes.push({ id: rec.id, data: { ...rec.data, spec: emptySpec(), createdAt: nowISO(), source: sourceLabel } });
      } else {
        const locked = prev.lockedFields || [];
        const patch = { ...rec.data, source: sourceLabel };
        locked.forEach((f) => delete patch[f]);
        // never clobber user content
        delete patch.spec;
        if (prev.itemSection) delete patch.itemSection; // keep manual remap
        if (prev.status === 'removed') patch.status = 'active';
        // Timestamps describe changes; they must not manufacture a change on every pull.
        const fields = Object.keys(patch).filter(k => k !== 'updatedAt');
        if (JSON.stringify(pick(prev, fields)) !== JSON.stringify(pick(patch, fields))) {
          updated++;
          writes.push({ id: rec.id, data: patch });
        }
      }
    }
    const removed = [];
    for (const [id, prev] of byId) {
      if (seen.has(id)) continue;
      if (!sourceLabel || prev.source !== sourceLabel) continue; // only retire rows owned by this exact source
      if (prev.status === 'removed') continue;
      removed.push(id);
      writes.push({ id, data: { status: 'removed', removedAt: nowISO() } });
    }

    current();
    await store.bulkSet('items', sid, writes, { assertCurrent: current });
    current();
    // sections: merge, never overwrite user-edited body / mapping
    const existingSections = await store.listIn('sections', sid);
    current();
    const secById = new Map(existingSections.map((s) => [s.id, s]));
    for (const s of built.sections) {
      const prev = secById.get(s.id);
      const data = { ...s.data };
      if (prev) {
        if (prev.body && Object.keys(prev.body).length) delete data.body;
        if (prev.numberOverride || prev.userMapped) { delete data.number; delete data.title; delete data.division; }
        if (prev.order) delete data.order;
      }
      const fields = Object.keys(data).filter(k => k !== 'updatedAt');
      if (!prev || JSON.stringify(pick(prev, fields)) !== JSON.stringify(pick(data, fields))) {
        current();
        await store.setDocIn('sections', sid, s.id, data, true);
      }
    }
    current();
    if (writes.length) await store.updateProject(sid, { lastImportAt: nowISO(), lastImportSource: sourceLabel || 'upload' });
    current();
    options.onWrites?.(writes);
    return { added, updated, removed: removed.length };
  }

  const emptySpec = () => ({ manufacturer: '', model: '', finish: '', color: '', standard: '', notes: '', tags: [], links: [], approval: 'draft' });

  /* ---------- Google Sheets (Drive) pull ---------- */
  function parseSheetUrl(url) {
    const id = (String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || null;
    const gid = (String(url).match(/[#&?]gid=(\d+)/) || [])[1] || null;
    return { id, gid };
  }
  function gvizCsv(id, gid, sheetName) {
    const base = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`;
    if (gid) return base + '&gid=' + gid;
    if (sheetName) return base + '&sheet=' + encodeURIComponent(sheetName);
    return base;
  }
  async function fetchSheet(url, sheetName) {
    const { id, gid } = parseSheetUrl(url);
    if (!id) throw new Error('Not a Google Sheets URL');
    const res = await fetch(gvizCsv(id, gid, sheetName), { credentials: 'omit' });
    if (!res.ok) throw new Error('Sheet not reachable (' + res.status + '). For a private sheet, keep its sharing restricted and import an exported XLSX or CSV file.');
    const text = await res.text();
    if (/^\s*<!DOCTYPE/i.test(text)) throw new Error('This importer cannot read the private sheet. Keep its sharing restricted and import an exported XLSX or CSV file.');
    return text;
  }

  /* ---------- Revit / Atlantist ingest contract ----------
   * Any external agent (Dynamo, pyRevit, Atlantist server) writes to
   *   specProjects/{sid}/sources/{srcId}  { type:'revit', payload:[{schedule, headers, rows}], rev, pushedAt }
   * The app picks it up through onSnapshot and merges with the same rules.
   */
  function normalisePush(payload) {
    return (payload || []).map((p) => {
      const rows = (p.rows || []).map((r) => Array.isArray(r) ? r : (p.headers || []).map((h) => r[h]));
      const headers = Array.isArray(p.headers) && p.headers.length ? p.headers : null;
      const grid = headers ? rows : [[p.schedule || 'Schedule'], ...rows];
      const parsed = root.ScheduleParser.parseGrid(grid, p.schedule || 'Schedule', headers);
      parsed.sourceScheduleId = p.sourceScheduleId || p.presentation?.scheduleUniqueId || null;
      parsed.presentation = p.presentation || null;
      return parsed;
    });
  }

  root.SpecSync = { build, apply, emptySpec, fetchSheet, parseSheetUrl, gvizCsv, normalisePush, sectionIdFor, SOURCE_FIELDS };
})(typeof window !== 'undefined' ? window : globalThis);
