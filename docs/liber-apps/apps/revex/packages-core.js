/* One deterministic, metadata-only package catalogue shared by REVEX and its Drive bridge.
 * Source files, approval decisions, BIM geometry and specification quantities remain authoritative. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RevexPackagesCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '20260928-packages1';
  const FOLDER = '012_PACKAGES';
  const ROOT_ID = '19xjC4G4Bko8ZiN4-xA7947xOpXFkh5jP';
  // Names reproduce the supplied contractor package template, including its Structural heading.
  const definitions = [
    ['APPLIANCES', 'appliance|refrigerator|dishwasher|cooktop|oven|washer|dryer|range hood', '11'],
    ['BACKYARD LANDSCAPING', 'landscap|planting|backyard|garden|irrigation', '32'],
    ['BATHROOM VANITIES', 'vanit', '12'],
    ['BRICK VENEER', 'brick|veneer|masonry facade', '04'],
    ['CMU & WATERPROOFING', 'cmu|concrete masonry|waterproof|dampproof', '04|07'],
    ['COMPOUND & PAINTING', 'painting|paint finish|joint compound|skim coat', '09'],
    ['CONCRETE SLABS', 'concrete slab|slab on|slab plan|concrete floor', '03'],
    ['COUNTERTOPS', 'countertop|worktop|backsplash|stone top', '12'],
    ['DEMOLITION & ASBESTOS REMOVAL', 'demolition|asbestos|abatement', '02'],
    ['ELECTRICAL FIXTURES', 'light fixture|lighting|luminaire|chandelier|sconce|pendant light', '26'],
    ['EXCAVATION', 'excavation|earthwork|shoring|underpinning|support of excavation', '31'],
    ['EXTERIOR DOORS', 'exterior door|entry door|entrance door|patio door|balcony door|storefront door', '08'],
    ['EXTERIOR INSULATION & FIREPROOFING', 'exterior insulation|fireproof|firestop|continuous insulation|mineral wool', '07'],
    ['FENCE', 'fence|fencing|site gate', '32'],
    ['FIRE ALARM', 'fire alarm|smoke detector|alarm panel', '28'],
    ['FOUNDATION', 'foundation|footing|pile cap|foundation wall', '03|31'],
    ['FRAMING INTERIOR', 'interior framing|metal stud|partition framing|wood stud', '06|09'],
    ['FRAMING STRUCTURAL', 'structural framing|joist|wood framing|framing plan|truss|lumber', '06'],
    ['HIGH VOLTAGE SYSTEMS', 'electrical plan|electrical riser|power distribution|panelboard|high voltage|switchgear|electrical service', '26'],
    ['HVAC & FRESH AIR', 'hvac|fresh air|mechanical|air condition|ventilation|heat pump|air handler|ductwork', '23'],
    ['INTERIOR DOORS', 'interior door|pocket door|closet door|bedroom door|bathroom door', '08'],
    ['INTERIOR GLASSWORK', 'interior glass|shower glass|glass partition|shower enclosure|mirror', '08'],
    ['INTERIOR INSULATION', 'interior insulation|acoustic insulation|sound insulation|batt insulation', '07|09'],
    ['KITCHENS', 'kitchen|cabinetry|kitchen cabinet', '12'],
    ['LOW VOLTAGE SYSTEMS', 'low voltage|intercom|security camera|data cabling|telecom|access control', '27|28'],
    ['MAILBOX', 'mailbox|mail box|parcel locker', '10'],
    ['MEDICINE CABINETS', 'medicine cabinet', '10'],
    ['MEP', '\\bmep\\b|mechanical electrical plumbing', '21|22|23|26'],
    ['METAL PANELS', 'metal panel|aluminum panel|aluminium panel|metal cladding', '07'],
    ['PAVERS INSTALLATION', 'paver|paving stone', '32'],
    ['PLUMBING', 'plumbing|sanitary|domestic water|water heater|plumbing riser', '22'],
    ['PLUMBING FIXTURES', 'plumbing fixture|faucet|toilet|lavatory|bathtub|showerhead|sink|tub filler', '22'],
    ['ROADWAY', 'roadway|asphalt|road paving', '32'],
    ['ROOFING', 'roofing|roof membrane|roof drain|roof detail|roof plan', '07'],
    ['ROOFTOP PAVERS', 'roof.*paver|paver.*roof|pedestal paver', '07|32'],
    ['ROOFTOP TERRACES', 'roof.*terrace|terrace.*roof|roof deck', '07|32'],
    ['SHEETROCK', 'sheetrock|drywall|gypsum|wallboard', '09'],
    ['SIDEWALK & CURB', 'sidewalk|curb|kerb', '32'],
    ['SIGNAGE', 'signage|wayfinding|exit sign|address sign', '10'],
    ['SPRINKLER', 'sprinkler|fire suppression|standpipe', '21'],
    ['STEELWORK & STAIRCASE', 'steelwork|structural steel|steel beam|stair|railing|handrail|guardrail', '05'],
    ['STUCCO', 'stucco|eifs|exterior plaster', '07|09'],
    ['Structural', 'structural|structure|load bearing|shear wall|beam|column', '03|05|06'],
    ['TILE', '\\btile\\b|tiling|porcelain|ceramic|grout', '09'],
    ['WATER MAIN & SEWER INSTALLATION', 'water main|sewer|site utility|site utilities|water service', '33'],
    ['WINDOWS', 'window|fenestration|glazing|curtain wall', '08'],
    ['WOOD FLOORING', 'wood floor|hardwood|engineered wood|parquet', '09']
  ];
  const slug = text => String(text).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const CATALOG = definitions.map(([name, pattern, csi]) => ({ id: slug(name), name, pattern, csi: csi.split('|') }));
  const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const safeUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function formatOf(row) {
    const name = String(row.name || row.title || ''), mime = String(row.mimeType || row.mime_type || '').toLowerCase();
    const ext = (name.match(/\.([a-z0-9]{1,10})$/i)?.[1] || '').toLowerCase();
    const native = { 'application/vnd.google-apps.document': ['Google Doc','Google Docs','document'], 'application/vnd.google-apps.spreadsheet': ['Google Sheet','Google Sheets','schedule'], 'application/vnd.google-apps.presentation': ['Google Slides','Google Slides','design'] };
    if (native[mime]) { const [format, application, kind] = native[mime]; return {format, application, kind, ext}; }
    const types = [
      [/^(pdf)$/, /pdf/, 'PDF', 'Docs · PDF viewer', 'document'],
      [/^(xlsx?|csv|tsv|ods)$/, /spreadsheet|excel|csv/, 'Spreadsheet', 'Excel / Google Sheets', 'schedule'],
      [/^(docx?|rtf|odt|txt)$/, /word|text\/plain/, 'Document', 'Word / Google Docs', 'document'],
      [/^(rvt|rfa)$/, /x-revit/, 'Revit', 'Autodesk Revit', 'model'],
      [/^(ifc|glb|gltf|obj|fbx|stl)$/, /model\//, '3D model', 'REVEX BIM / source application', 'model'],
      [/^(dwg|dxf|dgn)$/, /acad|autocad/, 'CAD drawing', 'AutoCAD / CAD viewer', 'drawing'],
      [/^(png|jpe?g|webp|gif|tiff?|heic)$/, /^image\//, 'Image', 'Design Book / image viewer', 'image'],
      [/^(pptx?|odp)$/, /presentation|powerpoint/, 'Presentation', 'PowerPoint / Google Slides', 'design'],
      [/^(zip|7z|rar)$/, /zip|compressed/, 'Archive', 'Download and extract', 'archive'],
      [/^(mp4|mov|webm)$/, /^video\//, 'Video', 'Video player', 'video'],
      [/^(osm|idf|gbxml|cxl|epw)$/, /x-energy/, 'Energy model', 'Energy / OpenStudio / COMcheck', 'energy']
      ,[/^(json|xml|yaml|yml)$/, /application\/(json|xml)/, 'Structured data', 'Source application / data viewer', 'data']
    ];
    const found = types.find(([e,m]) => e.test(ext) || m.test(mime));
    return found ? { format: ext.toUpperCase() || found[2], application: found[3], kind: found[4], ext } : {format: ext.toUpperCase() || 'Unknown', application:'Original application', kind:'unknown', ext};
  }
  function archived(row) { return Boolean(row.retired || row.archivedFromRevit || /\.\d{4}\.(rvt|rfa)$/i.test(row.name||'') || /^(removed|archived|superseded)$/i.test(row.status || '') || /(^|[\\/ _])(archive|archived|backup|backups)([\\/ _.-]|$)/i.test(row.path || row.folderPath || '')); }
  function address(text) { return normalize(text).match(/\b(\d{1,5})\s+([a-z]+)\s+(street|st|avenue|ave|road|rd)\b/); }
  function classify(row, project = {}, override) {
    const own = address(project.name), source = address(row.name || row.label || row.title);
    if (own && source && (own[1] !== source[1] || own[2] !== source[2])) return {packageIds:[],reason:'Different project address in source name',review:true,conflict:true};
    if (override && Array.isArray(override.packageIds)) return {packageIds:[...new Set(override.packageIds)].filter(id=>CATALOG.some(p=>p.id===id)),reason:'Manual assignment',review:false,manual:true};
    const primary = normalize([row.name || row.label || row.title, row.category, row.revit?.category, row.sourceSchedule, row.spec?.tags?.join?.(' ')].filter(Boolean).join(' '));
    const path = normalize(row.path || row.folderPath);
    const scopedReference=(ids,reason)=>({packageIds:ids,reason,review:false,common:true});
    if(/\benergy|gbxml|comcheck|rescheck|теплотех/.test(primary+' '+path))return scopedReference(['mep','hvac-fresh-air','windows','exterior-doors','exterior-insulation-fireproofing','roofing','high-voltage-systems','electrical-fixtures'],'Energy / envelope reference');
    if(/\brcp\b|reflected ceiling/.test(primary))return scopedReference(['sheetrock','electrical-fixtures','hvac-fresh-air','sprinkler','fire-alarm'],'Coordinated ceiling reference');
    if(/soil report|geotech/.test(primary))return scopedReference(['excavation','foundation'],'Geotechnical reference');
    if(/\bstr\b|конструк/.test(primary))return scopedReference(['structural','framing-structural','steelwork-staircase','foundation','concrete-slabs'],'Structural reference');
    const hits = CATALOG.filter(p => new RegExp(p.pattern, 'i').test(primary));
    if (hits.length) return {packageIds:hits.map(p=>p.id),reason:'Matched source name or category',review:false};
    const pathHits = CATALOG.filter(p => new RegExp(p.pattern, 'i').test(path));
    if (pathHits.length) return {packageIds:pathHits.map(p=>p.id),reason:'Matched source folder',review:false};
    // Whole sets are explicitly common references, never inferred trade scope or approval.
    if (/architectural|архитектур|full set|filing set|design book|specification book|spec book|site plan|survey|general notes|floor plans?|as built|elevations|construction document review/.test(primary)) return {packageIds:CATALOG.map(p=>p.id),reason:'Shared project reference',review:false,common:true};
    if (/\b(door|doors)\b/.test(primary)) return {packageIds:[],suggested:['interior-doors','exterior-doors'],reason:'Door location is unclear',review:true};
    return {packageIds:[],reason:'No reliable trade match; assign a package',review:true};
  }
  function roles(row, format) {
    const text=normalize([row.name,row.label,row.title,row.category].join(' ')), out=new Set(['design']);
    if (/plan|drawing|detail|installation|manual|safety|inspection|as built/.test(text) || ['drawing','model'].includes(format.kind)) out.add('site');
    if (/quote|quotation|proposal|submittal|purchase|invoice|product|spec|schedule|takeoff|cut sheet|datasheet|warranty|selection/.test(text) || row.kind==='position' || row.kind==='specification') out.add('procurement');
    return [...out];
  }
  function details(row) {
    const fields=row.fields||{},entry=Object.entries(fields).find(([k])=>/^(?:total\s+)?(?:qty\.?|quantity|count|number of)(?:$|\s|\()/i.test(k.trim()));
    const quantity=entry?entry[1]:(String(row.source||'').startsWith('revit:')&&Object.keys(fields).length?'':row.qty??row.quantity??'');
    return {quantity:String(quantity??''),unit:String(fields.Unit||row.quantityUnit||row.unit||''),description:String(row.description||row.spec?.description||''),sourceLink:safeUrl(row.source||row.spec?.url),status:String(row.status||row.selectionStatus||'Source linked')};
  }
  function build({project,files=[],positions=[],specifications=[],overrides={},generatedAt=new Date().toISOString()}) {
    const seen=new Set(), items=[],review=[];
    const add=(row,kind)=>{
      const key=String(row.key || `${kind}:${row.id || row.relativePath || row.path || row.name}`);
      if(seen.has(key))return;seen.add(key);
      const normalized={...row,kind,key,name:String(row.name||row.label||row.title||'Untitled source')};
      const format=kind==='file'?formatOf(normalized):{format:kind==='position'?'Design position':'Specification',application:kind==='position'?'Design Book':'Spec Book',kind};
      const match=classify(normalized,project,overrides[key]);
      if(kind==='file'&&!match.conflict&&!match.manual&&match.review&&/\.(rvt|ifc)$/i.test(normalized.name)&&address(normalized.name))Object.assign(match,{packageIds:CATALOG.map(p=>p.id),common:true,review:false,reason:'Shared project model'});
      if(format.kind==='unknown'&&!match.manual&&!match.conflict){match.review=true;match.reason='Unrecognized format; verify the source application and package';}
      const item={...normalized,...details(row),format:format.format,application:format.application,formatKind:format.kind,roles:roles(normalized,format),...match,archived:archived(row),url:safeUrl(row.webViewLink||row.url||row.downloadUrl),modifiedAt:row.modifiedTime||row.updatedAt||null};
      items.push(item);if(item.review&&!item.archived)review.push(item);
    };
    files.filter(f=>!f.trashed&&!f.deleted&&!String(f.folderPath||f.path||'').split(/[\\/]/).includes(FOLDER)&&!/(?:^|[\\/])(\.git|node_modules|revit_temp)(?:[\\/]|$)/i.test(f.path||f.folderPath||'')&&!/\.(tmp|log|bak|lock|slog|dmp)$/i.test(f.name||'')).forEach(f=>add(f,'file'));
    positions.forEach(p=>add(p,'position'));specifications.filter(s=>!s.retired).forEach(s=>add(s,'specification'));
    const packages=CATALOG.map(p=>{const rows=items.filter(i=>i.packageIds.includes(p.id));return {...p,items:rows,activeCount:rows.filter(i=>!i.archived).length,procurementCount:rows.filter(i=>!i.archived&&i.roles.includes('procurement')).length};});
    return {schema:'liber.revex.procurement-packages.v1',version:VERSION,projectId:project.id,projectName:project.name,generatedAt,folder:FOLDER,packages,review,sourceCount:items.length,items};
  }
  function appUrl(projectId,view,packageId) { const q=new URLSearchParams({projectId,view});if(packageId)q.set('package',packageId);return 'https://liberpict.com/liber-apps/apps/revex/index.html?'+q; }
  function packageHtml(catalog, pack, resolveUrl = item=>item.url||(catalog.projectId?appUrl(catalog.projectId,item.kind==='position'?'design':item.kind==='specification'?'spec':'packages',pack?.id):''), folderUrl = p=>encodeURIComponent(p.name)+'/00_PACKAGE.html') {
    const rows=pack?pack.items:catalog.items, title=pack?pack.name:'Project packages';
    const link=(url,label)=>url?`<a href="${escape(url)}" target="_blank" rel="noopener">${escape(label)}</a>`:escape(label);
    return `<!doctype html><!-- liber.revex.procurement-packages.v1 --><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(catalog.projectName)}</title><style>body{font:15px/1.5 system-ui;margin:32px auto;padding:0 20px;max-width:1120px;color:#20302e;background:#f5f7f4}h1{font-size:30px}a{color:#205e52}nav{display:flex;gap:16px;flex-wrap:wrap}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;text-align:left;border-bottom:1px solid #dde3df;overflow-wrap:anywhere}small{color:#63726c}.muted{color:#64736d}@media(max-width:600px){body{padding:0 12px;margin:18px auto}td,th{padding:8px;font-size:12px}}</style><h1>${escape(title)}</h1><p>${escape(catalog.projectName)} · Site / Design / Procurement</p><nav>${catalog.projectId?['packages','design','spec','docs','bim','energy'].map(v=>link(appUrl(catalog.projectId,v,pack?.id),v==='packages'?'Live packages':v)).join(''):''}</nav><p class="muted">Index generated ${escape(catalog.generatedAt)}. Links retain their original sources. Classification is guidance, not confirmation of approval or suitability for construction. Review source revision and procurement decisions before ordering.</p>${!pack?`<ul>${catalog.packages.map(p=>`<li>${link(folderUrl(p),p.name)} — ${p.activeCount} sources</li>`).join('')}</ul>`:''}<table><thead><tr><th>Source</th><th>Quantity</th><th>Format / application</th><th>Use</th><th>Status</th></tr></thead><tbody>${rows.map(i=>`<tr><td>${link(resolveUrl(i),i.name)}<br><small>${escape(i.path||i.folderPath||i.chapterTitle||i.reason)}</small><br>${escape(i.description.slice(0,1600))}${i.sourceLink?'<br>'+link(i.sourceLink,'Product / supplier'):''}</td><td>${escape([i.quantity,i.unit].filter(Boolean).join(' ')||'—')}</td><td>${escape(i.format)}<br><small>${escape(i.application)}</small></td><td>${escape(i.roles.join(' / '))}</td><td>${escape(i.archived?'Historical':i.review?'Needs assignment':i.common?'Shared reference':i.status||'Source linked')}</td></tr>`).join('')}</tbody></table><p>${rows.length} source references. Files may belong to several packages. Unknown formats and ambiguous names remain in review.</p></html>`;
  }
  return {VERSION,FOLDER,ROOT_ID,CATALOG,normalize,slug,safeUrl,escape,formatOf,classify,archived,build,appUrl,packageHtml,details};
});
