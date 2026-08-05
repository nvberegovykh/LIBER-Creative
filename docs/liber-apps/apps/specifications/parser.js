/* LIBER Specifications — Revit / spreadsheet schedule parser
 * Handles Revit "Export Schedule" CSV/TSV/XLSX quirks:
 *   - title row, blank separators, group header rows, group subtotals, grand total
 *   - missing column headers (Revit's "Export column headers" unchecked)
 *   - grouped/ungrouped, sorted/unsorted, itemized/non-itemized
 * Produces normalised rows + column role inference + stable fingerprints.
 */
(function (root) {
  'use strict';

  const LEVEL_RE = /^(cellar|basement|sub[- ]?cellar|ground|penthouse|roof|attic|mezzanine|garage|lobby|site|level\s*\w+|l\d+|b\d+|\d+(st|nd|rd|th)\s+floor|floor\s*\d+|fl\.?\s*\d+|pl\d+)\b/i;
  const AREA_RE = /^-?[\d,]+(?:\.\d+)?\s*(sf|sq\.?\s?ft\.?|ft²|sm|m²|sq\.?\s?m\.?)$/i;
  const NUM_RE = /^-?[\d,]+(?:\.\d+)?$/;
  const MARK_RE = /^[A-Z0-9][A-Z0-9.\-\/]{0,9}$/;
  const TOTAL_RE = /^(grand\s*total|total|subtotal)\b/i;
  const DIM_RE = /(\d+(?:\s*\d*\/\d+)?)\s*(?:"|''|in\b|mm\b|cm\b)/i;

  const clean = (v) => (v == null ? '' : String(v).replace(/^\uFEFF/, '').replace(/\u00a0/g, ' ').trim());
  const isEmptyRow = (r) => r.every((c) => clean(c) === '');
  const toNumber = (v) => {
    const m = clean(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  function splitCSV(text) {
    const delim = (() => {
      const head = text.split(/\r?\n/).slice(0, 5).join('\n');
      const counts = { ',': (head.match(/,/g) || []).length, '\t': (head.match(/\t/g) || []).length, ';': (head.match(/;/g) || []).length };
      return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ',';
    })();
    const rows = [];
    let row = [], cell = '', q = false, atFieldStart = true;
    const endsField = (ch) => ch === undefined || ch === delim || ch === '\n' || ch === '\r';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else if (endsField(text[i + 1])) q = false;
          else cell += c; // stray quote inside quoted field (e.g. 30" ) — keep literal
        } else cell += c;
      } else if (c === '"' && atFieldStart) { q = true; atFieldStart = false; }
      else if (c === delim) { row.push(cell); cell = ''; atFieldStart = true; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; atFieldStart = true; }
      else if (c === '\r') { /* skip */ }
      else { cell += c; atFieldStart = false; }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map(clean));
  }

  /** Trim trailing empty columns, keep max width. */
  function rectangularise(rows) {
    const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const grid = rows.map((r) => { const c = r.slice(); while (c.length < w) c.push(''); return c; });
    let last = 0;
    grid.forEach((r) => r.forEach((c, i) => { if (clean(c) !== '') last = Math.max(last, i); }));
    return grid.map((r) => r.slice(0, last + 1));
  }

  function looksLikeHeader(row, next) {
    const cells = row.map(clean);
    if (cells.some((c) => c === '')) return false;
    if (cells.some((c) => NUM_RE.test(c) || AREA_RE.test(c))) return false;
    if (!next) return false;
    // header if the following row has at least one numeric/area cell OR differs in shape
    return next.some((c) => NUM_RE.test(clean(c)) || AREA_RE.test(clean(c))) || cells.length > 1;
  }

  function classifyRow(row) {
    const cells = row.map(clean);
    const filled = cells.filter((c) => c !== '').length;
    if (filled === 0) return 'blank';
    if (TOTAL_RE.test(cells[0]) || cells.some((c) => TOTAL_RE.test(c))) return 'grandtotal';
    if (filled === 1) return 'group';
    // Revit group footer: "<Type>: <n>" style, or first cell + only a trailing number
    const lastFilledIdx = cells.reduce((a, c, i) => (c !== '' ? i : a), -1);
    const midEmpty = cells.slice(1, lastFilledIdx).every((c) => c === '');
    if (filled === 2 && midEmpty && (NUM_RE.test(cells[lastFilledIdx]) || AREA_RE.test(cells[lastFilledIdx]))) return 'subtotal';
    if (/:\s*\d+$/.test(cells[0]) && filled <= 2) return 'subtotal';
    return 'data';
  }

  function inferRoles(headers, dataRows) {
    const n = headers.length;
    const roles = [];
    for (let i = 0; i < n; i++) {
      const vals = dataRows.map((r) => clean(r[i])).filter((v) => v !== '');
      const h = clean(headers[i]).toLowerCase();
      const uniq = new Set(vals);
      const hit = (re) => vals.length && vals.filter((v) => re.test(v)).length / vals.length > 0.7;
      let role = 'param';
      if (/level|floor|story|storey/.test(h) || hit(LEVEL_RE)) role = 'level';
      else if (/area|sf|region/.test(h) || hit(AREA_RE)) role = 'area';
      else if (/count|qty|quantity|number of/.test(h) || (hit(NUM_RE) && vals.every((v) => Number.isInteger(toNumber(v))))) role = 'qty';
      else if (/mark|number|no\.|id|tag/.test(h) || (hit(MARK_RE) && uniq.size > vals.length * 0.6)) role = 'mark';
      else if (/family and type|type|family|product|model/.test(h) || vals.filter((v) => v.includes(':')).length > vals.length * 0.4) role = 'typeName';
      else if (/category|comments|description|name|room/.test(h)) role = /category/.test(h) ? 'category' : 'name';
      else if (uniq.size <= Math.max(1, Math.min(4, vals.length * 0.15))) role = 'category';
      else if (/cost|price/.test(h)) role = 'cost';
      roles.push(role);
    }
    // guarantee one label column
    if (!roles.includes('typeName')) {
      let best = -1, len = -1;
      for (let i = 0; i < n; i++) {
        if (['area', 'qty', 'cost'].includes(roles[i])) continue;
        const avg = dataRows.reduce((s, r) => s + clean(r[i]).length, 0) / Math.max(1, dataRows.length);
        if (avg > len) { len = avg; best = i; }
      }
      if (best >= 0) roles[best] = 'typeName';
    }
    return roles;
  }

  function fingerprint(parts) {
    const s = parts.map((p) => MasterFormatNorm(p)).join('|');
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ s.charCodeAt(i), 2246822519) + i) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 16);
  }
  const MasterFormatNorm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

  /**
   * Parse one grid (array of arrays) into a schedule object.
   * @param {string} fallbackName - file/sheet name used if no title row
   */
  function parseGrid(grid, fallbackName) {
    let rows = rectangularise(grid.map((r) => r.map(clean))).filter((r) => r.length);
    // title row: first non-empty row with exactly one filled cell
    let title = '';
    let i = 0;
    while (i < rows.length && isEmptyRow(rows[i])) i++;
    if (i < rows.length) {
      const cand = clean(rows[i][0]);
      const filled = rows[i].filter((c) => c !== '').length;
      const rest = rows.slice(i + 1);
      const hasWideRow = rest.some((r) => r.filter((c) => c !== '').length > 1);
      const repeatsBelow = rest.some((r) => clean(r[0]) === cand);
      const looksLikeGroup = LEVEL_RE.test(cand) || repeatsBelow;
      if (filled === 1 && cand && hasWideRow && !looksLikeGroup) { title = cand; i++; }
    }
    while (i < rows.length && isEmptyRow(rows[i])) i++;

    // headers
    let headers = null;
    const first = rows[i];
    const second = rows.slice(i + 1).find((r) => !isEmptyRow(r));
    if (first && looksLikeHeader(first, second) && classifyRow(first) === 'data') { headers = first.map(clean); i++; }

    const body = rows.slice(i);
    const dataRows = body.filter((r) => classifyRow(r) === 'data');
    const width = Math.max(headers ? headers.length : 0, ...body.map((r) => r.length), 1);
    if (!headers) headers = Array.from({ length: width }, (_, k) => 'Field ' + (k + 1));
    while (headers.length < width) headers.push('Field ' + (headers.length + 1));

    const roles = inferRoles(headers, dataRows);
    const roleIdx = (role) => roles.indexOf(role);

    const name = title || fallbackName || 'Schedule';
    const items = [];
    const groups = [];
    let currentGroup = '';
    const totals = [];

    for (const r of body) {
      const kind = classifyRow(r);
      if (kind === 'blank') continue;
      if (kind === 'group') { currentGroup = clean(r[0]); if (currentGroup && !groups.includes(currentGroup)) groups.push(currentGroup); continue; }
      if (kind === 'subtotal' || kind === 'grandtotal') { totals.push({ kind, label: clean(r[0]), value: clean(r.filter((c) => c !== '').pop()) }); continue; }

      const fields = {};
      headers.forEach((h, k) => { const v = clean(r[k]); if (v !== '') fields[h] = v; });

      const lvlCol = roleIdx('level');
      const level = (lvlCol >= 0 ? clean(r[lvlCol]) : '') || (LEVEL_RE.test(currentGroup) ? currentGroup : '');
      const groupLabel = currentGroup || level;
      const typeCol = roleIdx('typeName');
      const markCol = roleIdx('mark');
      const nameCol = roleIdx('name');
      const areaCol = roleIdx('area');
      const qtyCol = roleIdx('qty');
      const catCol = roleIdx('category');

      let label = typeCol >= 0 ? clean(r[typeCol]) : '';
      const nameVal = nameCol >= 0 ? clean(r[nameCol]) : '';
      if (!label) label = nameVal || (markCol >= 0 ? clean(r[markCol]) : '') || 'Item';
      // Revit "Family: Type" → split
      let family = '', type = label;
      const ci = label.indexOf(': ');
      if (ci > 0) { family = label.slice(0, ci).trim(); type = label.slice(ci + 2).trim(); }
      if (family && type && MasterFormatNorm(family) === MasterFormatNorm(type)) type = '';

      const item = {
        sourceSchedule: name,
        group: groupLabel,
        level,
        mark: markCol >= 0 ? clean(r[markCol]) : '',
        roomName: nameVal,
        family,
        type,
        label,
        category: catCol >= 0 ? clean(r[catCol]) : '',
        qty: qtyCol >= 0 ? toNumber(r[qtyCol]) : null,
        area: areaCol >= 0 ? toNumber(r[areaCol]) : null,
        areaUnit: areaCol >= 0 ? (clean(r[areaCol]).match(/[a-z²]+$/i) || [''])[0].toUpperCase() : '',
        size: (label.match(DIM_RE) || [''])[0],
        fields
      };
      item.key = fingerprint([name, item.mark || '', family, type || label, level]);
      items.push(item);
    }

    return { name, headers, roles, groups, items, totals, rowCount: items.length };
  }

  function parseCSVText(text, fallbackName) {
    return [parseGrid(splitCSV(text), fallbackName)];
  }

  async function parseFile(file) {
    const nameNoExt = file.name.replace(/\.[^.]+$/, '');
    const ext = (file.name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
    if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
      const text = await file.text();
      return parseCSVText(text, nameNoExt);
    }
    if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') {
      if (!root.XLSX) throw new Error('Spreadsheet engine not loaded');
      const buf = await file.arrayBuffer();
      const wb = root.XLSX.read(buf, { type: 'array' });
      return wb.SheetNames.map((sn) => {
        const grid = root.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: true, defval: '', raw: false });
        return parseGrid(grid, sn);
      }).filter((s) => s.items.length || s.rowCount);
    }
    throw new Error('Unsupported file type: .' + ext);
  }

  root.ScheduleParser = { parseFile, parseCSVText, parseGrid, splitCSV, fingerprint, classifyRow };
})(typeof window !== 'undefined' ? window : globalThis);
