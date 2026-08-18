'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('docs/liber-apps/apps/revex/docs-pages-r115.js','utf8');
const ui=fs.readFileSync('docs/liber-apps/apps/revex/ui-integrity.js','utf8');

const root={
  RevexStore:{subscribeLibraryFiles(){}},
  __revexState:{projectId:'docs-qa',library:[]},
  addEventListener(){},
  __revexBrowserDiagnostics:{emit(){}},
};
const document={
  readyState:'complete',
  getElementById(){return null;},
  querySelector(){return null;},
  createElement(){return{dataset:{},addEventListener(){}};},
  head:{appendChild(){}},
};
const context={
  window:root,document,console,
  setTimeout(){return 0;},
  clearTimeout(){},
  queueMicrotask(fn){fn();},
  requestAnimationFrame(fn){fn();},
  URL:{createObjectURL(){return'blob:qa';}},
  File:class File{},
  fetch:async()=>{throw new Error('network must not be used by Docs projection QA');},
};
vm.runInNewContext(source,context,{filename:'docs-pages-r115.js'});

const api=root.__revexDocsPagesR115;
assert.ok(api,'canonical Docs owner did not install');
assert.equal(api.build,'20260818r134-docs-linked-pages1');
assert.equal(api.fullSetAuthority,true);
assert.equal(api.legacySheetProjection,true);
assert.equal(typeof api.projectRows,'function');
assert.equal(typeof api.orderedSheets,'function');
assert.ok(ui.includes("docs-pages-r115.js?v=20260818r134-docs-linked-pages1"),'current UI owner does not load the linked-page Docs build');
assert.ok(source.includes('const rows=projectRows(s.library)'),'canonical Docs renderer does not consume the projected library');

const fullSet={
  id:'permit-r2',revexDocKind:'printing-set',printingSetId:'permit',printingSetName:'Permit Set',revision:'r2',createdAt:'2026-08-18T12:00:00Z',
  storagePath:'sets/permit-r2.pdf',sheetIndex:[
    {page:3,sheetUniqueId:'u3',sheetNumber:'A-103',sheetName:'Third'},
    {page:1,sheetUniqueId:'u1',sheetNumber:'A-101',sheetName:'First'},
    {page:2,sheetUniqueId:'u2',sheetNumber:'A-102',sheetName:'Second'},
  ],
};
const priorSet={
  id:'permit-r1',revexDocKind:'printing-set',printingSetId:'permit',printingSetName:'Permit Set',revision:'r1',createdAt:'2026-08-17T12:00:00Z',
  storagePath:'sets/permit-r1.pdf',sheetIndex:[{page:1,sheetUniqueId:'old-u1',sheetNumber:'A-101',sheetName:'Old First'}],
};
const duplicateLegacy={
  id:'legacy-u2',revexDocKind:'printing-sheet',printingSetId:'permit',printingSetName:'Permit Set',revision:'r2',
  page:2,sheetUniqueId:'u2',sheetNumber:'A-102',sheetName:'Second',storagePath:'legacy/pages/A-102.pdf',size:1234,
};
const missingLegacy={
  id:'legacy-u4',revexDocKind:'revit-printing-sheet',printingSetId:'permit',printingSetName:'Permit Set',revision:'r2',
  page:4,sheetUniqueId:'u4',sheetNumber:'A-104',sheetName:'Fourth',storagePath:'legacy/pages/A-104.pdf',size:2345,
};
const wrongRevisionLegacy={
  id:'legacy-old',revexDocKind:'printing-set-sheet',printingSetId:'permit',printingSetName:'Permit Set',revision:'r1',
  page:2,sheetUniqueId:'old-u2',sheetNumber:'A-102',sheetName:'Old Second',storagePath:'legacy/pages/old-A-102.pdf',size:999,
};
const folderLegacy={
  id:'legacy-folder',folderPath:'record_out/printing_sets/sheets/permit',printingSetId:'permit',printingSetName:'Permit Set',revision:'r2',
  page:5,sheetUniqueId:'u5',sheetNumber:'A-105',sheetName:'Fifth',storagePath:'legacy/pages/A-105.pdf',size:3456,
};
const manualIn={id:'manual-in',revexDocKind:'manual',folderPath:'record_in/client',name:'Survey.pdf'};
const manualOut={id:'manual-out',revexDocKind:'manual',folderPath:'record_out/consultant',name:'Narrative.pdf'};
const affected={id:'affected',revexDocKind:'affected-revit-plan',folderPath:'record_out/affected_plans',name:'Level 1.pdf'};

const input=[fullSet,duplicateLegacy,manualIn,missingLegacy,priorSet,wrongRevisionLegacy,manualOut,folderLegacy,affected];
const projected=api.projectRows(input);

assert.equal(projected.some(api.legacySheet),false,'legacy standalone sheet survived as a top-level Docs row');
assert.ok(projected.some(row=>row.id==='manual-in'),'Record In manual document was lost');
assert.ok(projected.some(row=>row.id==='manual-out'),'Record Out manual document was lost');
assert.ok(projected.some(row=>row.id==='affected'),'affected authoritative plan was lost');

const current=projected.find(row=>row.id==='permit-r2');
const old=projected.find(row=>row.id==='permit-r1');
assert.ok(current&&old,'printing-set parents were lost');
assert.deepEqual(api.orderedSheets(current).map(row=>Number(row.page)),[1,2,3,4,5],'current Full Set children are not in source-page order');
assert.deepEqual(api.orderedSheets(old).map(row=>Number(row.page)),[1,2],'legacy page was attached to the wrong printing-set revision');

const page2=api.orderedSheets(current).find(row=>Number(row.page)===2);
assert.equal(page2.singlePageStoragePath,'legacy/pages/A-102.pdf','matching legacy child did not enrich the parent sheetIndex');
assert.equal(page2.legacyLibraryId,'legacy-u2');
assert.equal(page2.derivedFromFullSet,true,'linked child lost Full Set authority');
const page4=api.orderedSheets(current).find(row=>Number(row.page)===4);
assert.equal(page4.singlePageStoragePath,'legacy/pages/A-104.pdf');
assert.equal(page4.derivedFromFullSet,true);
const page5=api.orderedSheets(current).find(row=>Number(row.page)===5);
assert.equal(page5.legacyLibraryId,'legacy-folder','folder-shaped legacy sheet was not folded into its parent');

assert.equal(fullSet.sheetIndex, current.sheetIndex,'projection must remain attached to the live parent object so local page derivation survives re-render');

console.log(JSON.stringify({
  REVEX_R134_DOCS_LINKED_PAGES:'PASSED',
  topLevelRows:projected.length,
  currentFullSetPages:api.orderedSheets(current).length,
  previousRevisionPages:api.orderedSheets(old).length,
  detachedLegacyRows:projected.filter(api.legacySheet).length,
  manualDocsPreserved:true,
  affectedPlansPreserved:true,
  linkedChildrenDerivedFromFullSet:true,
}));