// Presentation policy only. Source identities and saved decisions remain intact.
export const REFERENCE_DIVISIONS = new Set(['FACADE','MAIN LOBBY','STAIRWELL','TYPICAL CORRIDORS','APARTMENT INTERIORS','KITCHENS','MAIN BATHROOM','GUEST BATHROOM','POWDER ROOM','COMMON CELLAR','LANDSCAPING','ROOFTOP']);
export function hasSelection(source, edit = {}) {
  const item = { ...source, ...edit };
  return Boolean(item.source || item.images?.length || (item.status && !['Not Selected','Archived'].includes(item.status)) ||
    (String(item.description || '').trim() && (!source.revit || item.description !== source.description)));
}
export function isBookDivision(chapter, chapterEdit = {}, edits = new Map()) {
  if (chapterEdit.bookVisibility === 'included') return true;
  if (chapterEdit.bookVisibility === 'source') return false;
  if (chapter.sourceKind === 'revex-overlay-archive') return false;
  if (REFERENCE_DIVISIONS.has(String(chapter.title || '').trim().toUpperCase())) return true;
  if (!['approved-reference','revit-model-fallback'].includes(chapter.sourceKind)) return true;
  return Boolean(['inspiration','renders','versionImages'].some(key => chapterEdit[key]?.length || chapter[key]?.length) ||
    (chapter.items || []).some(item => hasSelection(item, edits.get(item.id))));
}
export function bookDivisionItems(chapter, chapterEdit = {}, edits = new Map()) {
  const inferred=['approved-reference','revit-model-fallback'].includes(chapter.sourceKind)&&!REFERENCE_DIVISIONS.has(String(chapter.title||'').trim().toUpperCase());
  return inferred&&chapterEdit.bookVisibility!=='included'?(chapter.items||[]).filter(item=>hasSelection(item,edits.get(item.id))):(chapter.items||[]);
}
export function bookFilename(kind, project, date = new Date()) {
  const name = String(project || 'Project').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0,100) || 'Project';
  return `${kind} - ${name} - ${date.toISOString().slice(0,10)}`;
}
export const BOOK_PRINT_CSS = `
@page{size:A4 landscape;margin:13mm}*{box-sizing:border-box}body{margin:0;background:#fff;color:#18212b;font:12px/1.5 Arial,sans-serif}h1,h2,h3,p{margin:0 0 8px}button{font:inherit;color:inherit;border:0;padding:0;background:none;text-align:left}a{color:#255866;text-decoration:none;overflow-wrap:anywhere}.book-print-title{font-size:20px;margin-bottom:14px}.design-book-summary{color:#586573}.design-book-division{break-before:page;padding:0}.design-book-division:first-child{break-before:auto}.design-book-division-head{display:flex;justify-content:space-between;gap:20px;border-bottom:2px solid #253c47;padding:0 0 10px;margin-bottom:16px;break-after:avoid}.design-book-division-head small{display:block;color:#586573}.design-book-position-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.design-book-position{border:1px solid #d5dce0;padding:14px;break-inside:avoid;min-width:0;overflow-wrap:anywhere}.design-book-position h3{font-size:14px}.design-book-position-body{display:flex;gap:14px}.design-book-position-body>div{min-width:0;flex:1}.design-book-image{width:120px;height:100px;object-fit:contain;flex:none}.design-book-notes{white-space:pre-wrap;overflow-wrap:anywhere}.book-position-meta{display:flex;gap:12px;margin-top:10px;font-size:11px;color:#586573}.book-lane{margin-bottom:16px;break-inside:avoid}.book-lane-images{display:flex;flex-wrap:wrap;gap:10px}.book-lane img{width:180px;height:110px;object-fit:contain}.book-empty-image{color:#82909a;font-size:11px}.book-source-notice,.design-book-actions{display:none} .status-chip{font-size:11px}.design-book-position small{display:block;color:#586573}
`;
export function printBookDocument({title, html, css = BOOK_PRINT_CSS}) {
  // A dedicated document owns its title even when REVEX is nested in LIBER Apps.
  const target = window.open('', '_blank');
  if (!target) throw new Error('Allow the print window for this site, then try again.');
  const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  target.document.open();
  target.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${css}</style></head><body>${html}</body></html>`);
  target.document.close();
  target.opener = null;
  Promise.race([Promise.all([...target.document.images].map(img => img.complete ? Promise.resolve() : new Promise(resolve=>{img.onload=img.onerror=resolve;}))),new Promise(resolve=>setTimeout(resolve,10000))])
    .then(()=>target.document.fonts?.ready).then(()=>{if(!target.closed){target.focus();target.print();}});
  return target;
}
