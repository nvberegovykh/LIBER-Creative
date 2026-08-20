'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const {
  MAX_PROJECT_DOC_TOTAL_BYTES,
  MAX_PDF_PAGES,
  PDF_PARSE_TIMEOUT_MS,
  MAX_PROJECT_DOC_CANDIDATES,
  canonicalProjectLibraryPath,
  projectDocumentPolicy,
  verifyProjectDocumentPayload
} = require('./report-security');

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 4 });

const db = getFirestore();
const storage = getStorage();
const BUILD = '20260820r147-report-isolation1';
const NYC_TZ = 'America/New_York';
const PROJECT_RE = /^[A-Za-z0-9._-]{1,160}$/;
const INACTIVE = new Set(['resolved','closed','completed','complete','done','cancelled','canceled','deleted','archived']);
const MAX_REVISIONS = 240;
const MAX_DOCS = 16;
const MAX_DOC_TEXT = 100000;
const MAX_GROUNDING_CHARS = 90000;
const MAX_DIFFS_PER_DAY = 2000;
const REPORT_FAILURE_CODE = 'REVEX_REPORT_FAILED';
const REPORT_FAILURE_MESSAGE = 'REVEX report generation failed. Try again or contact support.';
const PDF_WORKER_PATH = path.join(__dirname, 'pdf-text-worker.js');
const PDF_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 64,
  codeRangeSizeMb: 64,
  stackSizeMb: 8
});

function log(stage, detail = {}) {
  console.log('[REVEX REPORT]', JSON.stringify({ at: new Date().toISOString(), build: BUILD, stage, ...detail }));
}
function errorDetail(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 120),
    message: String(error?.message || error || 'Unknown failure.').slice(0, 3000),
    stack: String(error?.stack || '').slice(0, 12000)
  };
}
function incidentFrom(error) {
  const value = String(error?.incidentId || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) ? value : crypto.randomUUID();
}
function reportFailure(incidentId) {
  const failure = new Error(REPORT_FAILURE_MESSAGE);
  failure.name = 'RevexReportFailure';
  failure.code = REPORT_FAILURE_CODE;
  failure.incidentId = incidentId;
  return failure;
}
function safe(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 140) || 'x'; }
function assertId(value, label) {
  const text = String(value || '').trim();
  if (!PROJECT_RE.test(text)) throw new HttpsError('invalid-argument', `${label} is invalid.`);
  return text;
}
function lower(value) { return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ' '); }
function activeIssue(issue) { return !INACTIVE.has(lower(issue?.status || 'open')); }
function dateValue(value) {
  if (!value) return new Date(0);
  if (typeof value.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}
function nycDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: NYC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(dateValue(value));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
function localTime(value) {
  return new Intl.DateTimeFormat('en-US', { timeZone: NYC_TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(dateValue(value));
}
function round(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : value; }
function deepStable(value) {
  if (Array.isArray(value)) return value.map(deepStable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = deepStable(value[key]);
  return out;
}
function jsonHash(value) { return crypto.createHash('sha256').update(JSON.stringify(deepStable(value))).digest('hex'); }
function cleanParam(row) {
  const name = String(row?.name || row?.label || row?.definition || '').trim();
  if (/\b(last changed|edited by|worksharing|timestamp|last saved|modified by|created by)\b/i.test(name)) return null;
  return { id: row?.id ?? null, name, value: row?.value ?? row?.valueString ?? row?.formatted ?? null, unit: row?.unit ?? row?.spec ?? null };
}
function elementComparable(row) {
  return {
    category: row?.category || '', categoryKey: row?.categoryKey || '',
    family: row?.family || '', familyUniqueId: row?.familyUniqueId || null,
    type: row?.type || '', typeUniqueId: row?.typeUniqueId || null,
    level: row?.level || '', levelId: row?.levelId ?? null,
    hostUniqueId: row?.hostUniqueId || null, hostId: row?.hostId ?? null,
    geometryRole: row?.geometryRole || 'physical',
    bbox: row?.bbox ? { min: (row.bbox.min || []).map(round), max: (row.bbox.max || []).map(round), unit: row.bbox.unit || '' } : null,
    materials: (row?.materials || []).map(m => ({ id: m.id ?? null, uniqueId: m.uniqueId || null, name: m.name || '', color: m.color || null, transparency: m.transparency ?? null, shininess: m.shininess ?? null, smoothness: m.smoothness ?? null })).sort((a,b)=>String(a.uniqueId||a.id||a.name).localeCompare(String(b.uniqueId||b.id||b.name))),
    parameters: (row?.parameters || []).map(cleanParam).filter(Boolean).sort((a,b)=>`${a.name}|${a.id}`.localeCompare(`${b.name}|${b.id}`))
  };
}
function elementKey(row) { return String(row?.uniqueId || row?.id || '').trim(); }
function fieldChanges(before, after) {
  const fields = [];
  for (const key of ['category','family','type','level','hostUniqueId','geometryRole']) if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) fields.push(key);
  if (jsonHash(before?.bbox || null) !== jsonHash(after?.bbox || null)) fields.push('geometry/location');
  if (jsonHash(before?.materials || []) !== jsonHash(after?.materials || [])) fields.push('materials');
  if (jsonHash(before?.parameters || []) !== jsonHash(after?.parameters || [])) fields.push('parameters');
  return fields;
}
function diffViewer(previous, current, revision) {
  const before = new Map((previous?.elements || []).map(row => [elementKey(row), row]).filter(([k])=>k));
  const after = new Map((current?.elements || []).map(row => [elementKey(row), row]).filter(([k])=>k));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];
  for (const key of keys) {
    const a = before.get(key), b = after.get(key);
    if (!a && b) changes.push({ kind:'added', revision, elementId:b.id ?? null, uniqueId:b.uniqueId || null, category:b.category || '', family:b.family || '', type:b.type || '', level:b.level || '', fields:['added'], before:null, after:elementComparable(b) });
    else if (a && !b) changes.push({ kind:'removed', revision, elementId:a.id ?? null, uniqueId:a.uniqueId || null, category:a.category || '', family:a.family || '', type:a.type || '', level:a.level || '', fields:['removed'], before:elementComparable(a), after:null });
    else {
      const ca = elementComparable(a), cb = elementComparable(b);
      if (jsonHash(ca) !== jsonHash(cb)) changes.push({ kind:'modified', revision, elementId:b.id ?? a.id ?? null, uniqueId:b.uniqueId || a.uniqueId || null, category:b.category || a.category || '', family:b.family || a.family || '', type:b.type || a.type || '', level:b.level || a.level || '', fields:fieldChanges(ca, cb), before:ca, after:cb });
    }
    if (changes.length >= MAX_DIFFS_PER_DAY) break;
  }
  return changes;
}
function bucket() {
  const configured = String(process.env.REVEX_STORAGE_BUCKET || '').trim();
  if (!configured) throw new Error('REVEX Report has no exact release-bound Firebase Storage bucket.');
  return storage.bucket(configured);
}
async function readBytes(path) { const [data] = await bucket().file(path).download(); return data; }
async function readJson(path) { return JSON.parse((await readBytes(path)).toString('utf8')); }
async function exists(path) { const [ok] = await bucket().file(path).exists(); return ok; }
async function uploadPrivate(path, bytes, contentType, metadata = {}) {
  const file = bucket().file(path);
  await file.save(bytes, {
    resumable:false,
    contentType,
    metadata:{
      cacheControl:'private, max-age=0, no-store',
      metadata:{ revexAccess:'firebase-authenticated-path-only', revexBuild:BUILD, ...metadata }
    }
  });
  return { path, bytes:bytes.length, sha256:crypto.createHash('sha256').update(bytes).digest('hex') };
}
function trustedAdminClaims(authClaims) {
  return authClaims?.revexAdmin === true || String(authClaims?.role || '').trim().toLowerCase() === 'admin';
}
async function projectAccess(projectId, uid, authClaims = {}) {
  const projectSnap = await db.doc(`projects/${projectId}`).get();
  if (!projectSnap.exists) throw new HttpsError('not-found','REVEX project not found.');
  const project = projectSnap.data() || {};
  const allowed = String(project.ownerId||'')===uid || (project.memberIds||[]).map(String).includes(uid) || trustedAdminClaims(authClaims);
  if (!allowed) throw new HttpsError('permission-denied','You do not have access to this REVEX project.');
  return { id:projectSnap.id, ...project };
}
async function revisions(projectId) {
  const snap = await db.collection(`projects/${projectId}/revexRevisions`).orderBy('syncedAt','asc').limit(MAX_REVISIONS).get();
  return snap.docs.map(d=>({id:d.id,...d.data()}));
}
async function activeIssues(projectId) {
  const snap = await db.collection(`projects/${projectId}/revexIssues`).limit(3000).get();
  return snap.docs.map(d=>({id:d.id,...d.data()})).filter(activeIssue).sort((a,b)=>String(a.status||'').localeCompare(String(b.status||''))||String(a.title||'').localeCompare(String(b.title||'')));
}
async function libraryFiles(projectId) {
  const snap = await db.collection(`projects/${projectId}/library`).limit(5000).get();
  return snap.docs.map(d=>({id:d.id,...d.data()}));
}
async function affectedPlanRows(projectId, revision, library = null) {
  const rows = library || await libraryFiles(projectId);
  return rows.filter(row=>row.type==='file'&&row.revexDocKind==='affected-revit-plan'&&String(row.revision||'')===String(revision));
}
async function waitAffectedPlanRows(projectId, revision, expectedCount) {
  if (!expectedCount) return [];
  for (let attempt=0; attempt<12; attempt++) {
    const rows = await affectedPlanRows(projectId, revision);
    if (rows.length >= expectedCount) return rows;
    await new Promise(resolve=>setTimeout(resolve, 5000));
  }
  return affectedPlanRows(projectId, revision);
}
async function parseBoundedPdf(bytes) {
  // Uint8Array.from creates an owned backing store. Transfer detaches that exact
  // allocation from the Cloud Function isolate instead of cloning or sharing a
  // pooled Storage Buffer with the untrusted PDF parser.
  const ownedBytes = Uint8Array.from(bytes);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const worker = new Worker(PDF_WORKER_PATH, { resourceLimits: PDF_WORKER_RESOURCE_LIMITS });
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      worker.removeAllListeners();
    };
    const finishFromWorker = (error, text = '') => {
      if (settled) return;
      settled = true;
      clear();
      // The worker destroys PDFParse before posting either result and closes its
      // only MessagePort immediately afterward; no forced termination is needed.
      if (error) reject(error);
      else resolve(text);
    };
    const terminateAndReject = async error => {
      if (settled) return;
      settled = true;
      clear();
      try {
        await worker.terminate();
      } catch (terminationError) {
        error.terminationDetail = errorDetail(terminationError);
      }
      reject(error);
    };
    worker.once('message', message => {
      if (message?.ok === true) return finishFromWorker(null, String(message.text || ''));
      const error = new Error('PDF text extraction failed inside the isolated parser.');
      error.parserDetail = message?.error || null;
      finishFromWorker(error);
    });
    worker.once('error', workerError => {
      const error = new Error('The isolated PDF parser could not complete.');
      error.workerDetail = errorDetail(workerError);
      void terminateAndReject(error);
    });
    worker.once('exit', code => {
      if (!settled) void terminateAndReject(new Error(`The isolated PDF parser exited before completion (code ${code}).`));
    });
    timer = setTimeout(() => {
      const error = new Error(`PDF text extraction exceeded ${PDF_PARSE_TIMEOUT_MS} ms and was terminated.`);
      void terminateAndReject(error);
    }, PDF_PARSE_TIMEOUT_MS);
    timer.unref?.();
    try {
      worker.postMessage(
        { bytes: ownedBytes, maxPages: MAX_PDF_PAGES, maxTextChars: MAX_DOC_TEXT },
        [ownedBytes.buffer]
      );
    } catch (postError) {
      const error = new Error('The isolated PDF parser could not accept its transferred payload.');
      error.workerDetail = errorDetail(postError);
      void terminateAndReject(error);
    }
  });
}
async function downloadProjectDocument(projectId, row, currentTotalBytes) {
  const path = canonicalProjectLibraryPath(projectId, row?.storagePath);
  if (!path) throw new Error('Document Storage path is outside the exact project Library boundary.');
  const liveFile = bucket().file(path);
  const [metadata] = await liveFile.getMetadata();
  const policy = projectDocumentPolicy(projectId, row, metadata, currentTotalBytes);
  // Bind the download to the exact generation that was inspected for size/type.
  const versionedFile = bucket().file(policy.path, { generation: policy.generation });
  const [downloaded] = await versionedFile.download({ validation: 'crc32c' });
  const document = verifyProjectDocumentPayload(policy, downloaded);
  const [currentMetadata] = await liveFile.getMetadata();
  if (String(currentMetadata?.generation || '') !== policy.generation)
    throw new Error('Document Storage generation changed during extraction.');
  return { policy, bytes: document.bytes, text: document.text };
}
async function extractProjectDocs(projectId) {
  const rows = await libraryFiles(projectId), docs=[];let totalBytes=0, attemptedCandidates=0;
  for (const row of rows) {
    if (docs.length >= MAX_DOCS) break;
    if (row.type !== 'file' || !row.storagePath) continue;
    if (attemptedCandidates >= MAX_PROJECT_DOC_CANDIDATES) break;
    attemptedCandidates += 1;
    const candidateName = String(row.name || '').slice(0,260);
    try {
      const { policy, bytes, text: verifiedText } = await downloadProjectDocument(projectId, row, totalBytes);let text='';
      totalBytes += policy.size;
      if (policy.kind === 'pdf') text = await parseBoundedPdf(bytes);
      else text = verifiedText;
      text = text.replace(/\0/g,'').replace(/[ \t]+/g,' ').slice(0,MAX_DOC_TEXT).trim();
      if (text) docs.push({ name:policy.name, id:row.id, revision:row.revision||null, text });
    } catch (error) { log('DOC_EXTRACT_SKIPPED',{projectId,name:candidateName,failure:errorDetail(error),parserDetail:error?.parserDetail||error?.workerDetail||null}); }
    if (totalBytes >= MAX_PROJECT_DOC_TOTAL_BYTES) break;
  }
  return docs;
}
function parseJsonLoose(text) {
  const raw=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim();
  try{return JSON.parse(raw)}catch(_){}
  const a=raw.indexOf('{'),b=raw.lastIndexOf('}');if(a>=0&&b>a){try{return JSON.parse(raw.slice(a,b+1))}catch(_){}}
  return null;
}
async function walltGround(changes, docs) {
  if (!changes.length || !docs.length) return { status:'DETERMINISTIC_ONLY', reason:changes.length?'No extractable project documents were available for grounding.':'No model changes to analyze.', items:[] };
  const projectId=String(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT||'liber-apps-cca20');
  const base=String(process.env.REVEX_WALLT_PROXY_URL||`https://europe-west1-${projectId}.cloudfunctions.net/openaiProxy`).replace(/\/+$/,'');
  const auth=String(process.env.REVEX_WALLT_PROXY_AUTH||'');
  const sourceText=docs.map(d=>`SOURCE: ${d.name}\n${d.text}`).join('\n\n').slice(0,MAX_GROUNDING_CHARS);
  const compact=changes.slice(0,300).map(c=>({number:c.number,kind:c.kind,category:c.category,family:c.family,type:c.type,level:c.level,fields:c.fields,elementId:c.elementId}));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
  try {
    const response=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Proxy-Auth':auth}:{})},body:JSON.stringify({model:String(process.env.REVEX_WALLT_MODEL||'gpt-4.1'),instructions:[
      'You are WALLT acting as a revision-documentation analyst for an architectural project.',
      'The deterministic REVEX element delta is authoritative. Do not invent model changes.',
      'Ground requirements ONLY in the supplied project-document excerpts. Never invent a code section, citation, requirement, or source.',
      'If a change has no explicit supporting requirement in the supplied excerpts, return an empty support array for it.',
      'Return ONLY JSON: {"items":[{"number":1,"summary":"...","support":[{"sourceName":"...","requirement":"paraphrase supported by source","relevance":"..."}]}]}.'
    ].join('\n'),input:[{role:'user',content:`MODEL CHANGES:\n${JSON.stringify(compact)}\n\nPROJECT DOCUMENT EXCERPTS:\n${sourceText}`}]}),signal:controller.signal});
    const json=await response.json().catch(()=>({}));if(!response.ok)throw new Error(json?.error?.message||json?.message||`WALLT HTTP ${response.status}`);
    const output=typeof json.output_text==='string'?json.output_text:(json.output||[]).flatMap(x=>x.content||[]).map(x=>typeof x.text==='string'?x.text:x.text?.value||'').join('\n');
    const parsed=parseJsonLoose(output);if(!parsed||!Array.isArray(parsed.items))throw new Error('WALLT returned no compatible grounded JSON.');
    const allowed=new Set(changes.map(c=>Number(c.number))),sourceNames=new Set(docs.map(d=>d.name));
    const items=parsed.items.filter(x=>allowed.has(Number(x.number))).map(x=>({number:Number(x.number),summary:String(x.summary||'').slice(0,800),support:(Array.isArray(x.support)?x.support:[]).filter(s=>sourceNames.has(String(s.sourceName||''))).map(s=>({sourceName:String(s.sourceName),requirement:String(s.requirement||'').slice(0,1200),relevance:String(s.relevance||'').slice(0,1200)}))}));
    return {status:'GROUNDED',items,sourceDocuments:docs.map(d=>d.name)};
  } catch(error) {
    const incidentId=crypto.randomUUID();
    log('WALLT_GROUNDING_FAILED',{incidentId,failure:errorDetail(error)});
    return {status:'DETERMINISTIC_ONLY',reason:'WALLT grounding unavailable for this report.',errorCode:'REVEX_WALLT_GROUNDING_UNAVAILABLE',incidentId,items:[]};
  }
  finally{clearTimeout(timer)}
}
function wrap(text, width=90) {
  const words=String(text||'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean),out=[];let line='';
  for(const word of words){const next=line?`${line} ${word}`:word;if(next.length>width&&line){out.push(line);line=word}else line=next}if(line)out.push(line);return out;
}
async function makeDailyPdf(report) {
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin=42,pageSize=[612,792];let page=pdf.addPage(pageSize),y=750;
  const addPage=()=>{page=pdf.addPage(pageSize);y=750};
  const line=(value,size=9,isBold=false,indent=0)=>{for(const row of wrap(value,Math.max(35,95-indent/5))){if(y<48)addPage();page.drawText(row,{x:margin+indent,y,size,font:isBold?bold:font,color:rgb(.12,.14,.17)});y-=size+4}};
  line('REVEX DAILY REVISION REPORT',15,true);line(`${report.projectName||report.projectId} · ${report.day} · America/New_York`,10);y-=6;
  line('MODEL UPDATES AFTER SYNCHRONIZATION',11,true);if(!report.changes.length)line('No model updates recorded for this day.',9);for(const c of report.changes){line(`${c.number}. ${c.kind.toUpperCase()} · ${[c.category,c.family,c.type,c.level].filter(Boolean).join(' · ')}`,9,true);line(`Changed: ${(c.fields||[]).join(', ')||c.kind}`,8,false,12);const g=report.grounding?.items?.find(x=>Number(x.number)===Number(c.number));for(const s of g?.support||[]){line(`Support — ${s.sourceName}: ${s.requirement}`,8,false,12)}}
  y-=8;line('OPEN / ACTIVE ISSUES',11,true);if(!report.openIssues.length)line('No open issues.',9);for(const issue of report.openIssues){line(`• ${issue.title||'Issue'} · ${issue.status||'open'}${issue.assigneeNames?.length?` · ${issue.assigneeNames.join(', ')}`:''}`,9,true);if(issue.body)line(issue.body,8,false,12)}
  y-=8;line('AFFECTED NATIVE REVIT PLANS',11,true);if(!report.annotatedPlans.length)line('No affected plan exports for this day.',9);for(const plan of report.annotatedPlans)line(`• ${plan.name||plan.viewName||'Plan'}${plan.changeNumbers?.length?` · changes ${plan.changeNumbers.join(', ')}`:''}`,9);
  y-=8;line('AUDIT PROVENANCE',11,true);line(`Revisions: ${report.revisions.map(r=>r.revision).join(', ')||'none'}`,8);line(`Grounding: ${report.grounding?.status||'DETERMINISTIC_ONLY'}${report.grounding?.reason?` · ${report.grounding.reason}`:''}`,8);
  return Buffer.from(await pdf.save());
}
function cloudPoints(rect,w,h) {
  const pad=8,left=Math.max(10,rect.left*w-pad),right=Math.min(w-10,rect.right*w+pad),bottom=Math.max(10,rect.bottom*h-pad),top=Math.min(h-10,rect.top*h+pad),points=[];
  const step=Math.max(7,Math.min(15,Math.min(right-left,top-bottom)/5||9));
  for(let x=left;x<=right;x+=step){points.push([x,bottom],[x,top])}
  for(let y=bottom+step;y<top;y+=step){points.push([left,y],[right,y])}
  return {points,left,right,bottom,top};
}
async function annotatePlan(bytes, view, changeByElement, projectId, revision, day) {
  const pdf=await PDFDocument.load(bytes),font=await pdf.embedFont(StandardFonts.HelveticaBold),page=pdf.getPages()[0],w=page.getWidth(),h=page.getHeight(),numbers=new Set();
  for(const region of view.changedRegions||[]){const change=changeByElement.get(String(region.elementId));if(!change||!region.normalizedRect)continue;numbers.add(change.number);const c=cloudPoints(region.normalizedRect,w,h);for(const [x,y] of c.points)page.drawCircle({x,y,size:4.5,borderColor:rgb(.82,.08,.12),borderWidth:1.2,opacity:.85});const bx=Math.min(w-20,c.right+10),by=Math.min(h-20,c.top+10);page.drawCircle({x:bx,y:by,size:9,color:rgb(.95,.95,.95),borderColor:rgb(.82,.08,.12),borderWidth:1.5});page.drawText(String(change.number),{x:bx-3.5,y:by-3.5,size:8,font,color:rgb(.72,.05,.08)})}
  page.drawText(`REVEX ${day} · ${revision}`,{x:18,y:12,size:6,font,color:rgb(.45,.45,.48)});
  return {bytes:Buffer.from(await pdf.save()),changeNumbers:[...numbers].sort((a,b)=>a-b)};
}
async function annotatePlans(projectId, revision, manifest, changes, day) {
  const rows=await waitAffectedPlanRows(projectId,revision,(manifest?.views||[]).length),byName=new Map(rows.map(r=>[String(r.revitViewUniqueId||r.revitViewId||r.revitViewName||''),r])),byFile=new Map(rows.map(r=>[String(r.name||'').split(' · ')[0],r]));
  const changeByElement=new Map(changes.filter(c=>c.elementId!=null).map(c=>[String(c.elementId),c])),out=[];
  for(const view of manifest?.views||[]){
    let row=byName.get(String(view.uniqueId||view.id||view.name||''));
    if(!row)row=rows.find(r=>String(r.revitViewName||'')===String(view.name||''))||byFile.get(String(view.fileName||''));
    if(!row?.storagePath){out.push({viewName:view.name||'',status:'SOURCE_PLAN_UNAVAILABLE',changeNumbers:[]});continue}
    try{
      const source=await downloadProjectDocument(projectId,row,0);
      if(source.policy.kind!=='pdf')throw new Error('Affected-plan source is not a bounded PDF object.');
      const annotated=await annotatePlan(source.bytes,view,changeByElement,projectId,revision,day);
      const path=`projects/${projectId}/revex/daily-reports/${day}/plans/${safe(revision)}_${safe(view.name||view.id)}_CLOUDS.pdf`;
      const uploaded=await uploadPrivate(path,annotated.bytes,'application/pdf',{revexDocKind:'daily-report-affected-plan',sourceRevision:revision});
      out.push({name:view.name||row.revitViewName||'Affected plan',viewName:view.name||'',sourceRevision:revision,sourceStoragePath:source.policy.path,...uploaded,status:'ANNOTATED',changeNumbers:annotated.changeNumbers,unlocatedChangedElementIds:view.unlocatedChangedElementIds||[]});
    }catch(error){const incidentId=crypto.randomUUID();log('PLAN_ANNOTATION_FAILED',{projectId,revision,viewName:String(view.name||'').slice(0,260),incidentId,failure:errorDetail(error)});out.push({viewName:view.name||'',sourceRevision:revision,status:'ANNOTATION_FAILED',errorCode:'REVEX_PLAN_ANNOTATION_FAILED',incidentId,changeNumbers:[]})}
  }
  return out;
}
async function buildReport(projectId, triggerRevision='') {
  const all=await revisions(projectId);if(!all.length)throw new Error('No REVEX model revisions are published.');const target=all.find(r=>r.id===triggerRevision||String(r.revision||'')===triggerRevision)||all[all.length-1],day=nycDay(target.syncedAt||target.createdAt),dayRows=all.filter(r=>nycDay(r.syncedAt||r.createdAt)===day),changes=[];const manifests=[];
  for(const rev of dayRows){const index=all.findIndex(x=>x.id===rev.id),prev=index>0?all[index-1]:null,currentViewer=await readJson(`projects/${projectId}/revex/revisions/${rev.id}/viewer-model.json`),previousViewer=prev&&await exists(`projects/${projectId}/revex/revisions/${prev.id}/viewer-model.json`)?await readJson(`projects/${projectId}/revex/revisions/${prev.id}/viewer-model.json`):{elements:[]},delta=diffViewer(previousViewer,currentViewer,rev.id);changes.push(...delta.map(c=>({...c,syncedAt:rev.syncedAt||rev.createdAt})));let manifest={views:[]};try{manifest=await readJson(`projects/${projectId}/revex/revisions/${rev.id}/affected-plan-views.json`)}catch(_){}manifests.push({revision:rev.id,manifest})}
  changes.splice(MAX_DIFFS_PER_DAY);changes.forEach((c,i)=>{c.number=i+1});const open=await activeIssues(projectId),projectSnap=await db.doc(`projects/${projectId}`).get(),project=projectSnap.data()||{},userIds=[...new Set(open.flatMap(issue=>{const raw=issue.assigneeIds||issue.assigneeId||issue.assignedTo||[];return(Array.isArray(raw)?raw:[raw]).map(String).filter(Boolean)}))],names=new Map();for(const uid of userIds){try{const snap=await db.doc(`users/${uid}`).get(),u=snap.data()||{};names.set(uid,u.username||u.displayName||u.email||uid)}catch(_){names.set(uid,uid)}}const openIssues=open.map(issue=>({...issue,assigneeNames:(Array.isArray(issue.assigneeIds)?issue.assigneeIds:[issue.assigneeId||issue.assignedTo]).filter(Boolean).map(uid=>names.get(String(uid))||String(uid))}));const docs=await extractProjectDocs(projectId),grounding=await walltGround(changes,docs),annotatedPlans=[];for(const entry of manifests){const revChanges=changes.filter(c=>c.revision===entry.revision);annotatedPlans.push(...await annotatePlans(projectId,entry.revision,entry.manifest,revChanges,day))}
  const report={schema:'liber.revex.daily-report.v1',build:BUILD,projectId,projectName:project.name||project.title||projectId,day,timeZone:NYC_TZ,generatedAt:new Date().toISOString(),triggerRevision:target.id,revisions:dayRows.map(r=>({revision:r.id,syncedAt:r.syncedAt||r.createdAt,localTime:localTime(r.syncedAt||r.createdAt)})),changes,openIssues,annotatedPlans,grounding,technicalHistoryIncluded:false,sourceAuthority:{modelUpdates:'immutable viewer-model delta after successful synchronization',issues:'projects/{project}/revexIssues active statuses',plans:'native Revit affected plan exports',history:'audit provenance only'}};
  const pdf=await makeDailyPdf(report),jsonBytes=Buffer.from(JSON.stringify(report,null,2),'utf8'),base=`projects/${projectId}/revex/daily-reports/${day}`,pdfUpload=await uploadPrivate(`${base}/REVEX_DAILY_REPORT_${day}.pdf`,pdf,'application/pdf',{revexDocKind:'daily-report'}),jsonUpload=await uploadPrivate(`${base}/REVEX_DAILY_REPORT_${day}.json`,jsonBytes,'application/json',{revexDocKind:'daily-report-evidence'});report.pdf=pdfUpload;report.evidence=jsonUpload;
  const record={type:'revex',hidden:true,revexKind:'daily-report',revexId:`daily_${day}`,projectId,day,timeZone:NYC_TZ,updatedAt:new Date().toISOString(),latestRevision:target.id,revisionCount:dayRows.length,changeCount:changes.length,openIssueCount:openIssues.length,affectedPlanCount:annotatedPlans.filter(p=>p.status==='ANNOTATED').length,pdfPath:pdfUpload.path,evidencePath:jsonUpload.path,groundingStatus:grounding.status,technicalHistoryIncluded:false};await db.doc(`projects/${projectId}/library/revex_daily_report_${safe(day)}`).set(record,{merge:false});log('REPORT_COMPLETE',{projectId,day,changes:changes.length,issues:openIssues.length,plans:record.affectedPlanCount,grounding:grounding.status});return report;
}
async function buildWithLock(projectId, revision) {
  const lock=db.doc(`projects/${projectId}/revexReportJobs/${safe(revision||'current')}`),runId=crypto.randomUUID();
  try {
    await lock.set({
      schema:'liber.revex.report-job.v1',status:'RUNNING',runId,revision,
      startedAt:FieldValue.serverTimestamp(),build:BUILD,
      error:FieldValue.delete(),errorCode:FieldValue.delete(),incidentId:FieldValue.delete()
    },{merge:true});
    const report=await buildReport(projectId,revision);
    await lock.set({
      status:'COMPLETE',runId,day:report.day,completedAt:FieldValue.serverTimestamp(),
      changeCount:report.changes.length,openIssueCount:report.openIssues.length,
      affectedPlanCount:report.annotatedPlans.filter(p=>p.status==='ANNOTATED').length,
      error:FieldValue.delete(),errorCode:FieldValue.delete(),incidentId:FieldValue.delete()
    },{merge:true});
    return report;
  } catch(error) {
    const incidentId=crypto.randomUUID();
    log('REPORT_FAILED',{projectId,revision,runId,incidentId,failure:errorDetail(error)});
    try {
      await lock.set({
        status:'FAILED',runId,errorCode:REPORT_FAILURE_CODE,incidentId,
        error:FieldValue.delete(),failedAt:FieldValue.serverTimestamp()
      },{merge:true});
    } catch(stateError) {
      log('REPORT_FAILURE_STATE_WRITE_FAILED',{projectId,revision,runId,incidentId,failure:errorDetail(stateError)});
    }
    throw reportFailure(incidentId);
  }
}
exports.documentRevexRevision = onDocumentCreated({document:'projects/{projectId}/revexRevisions/{revision}',timeoutSeconds:540,memory:'2GiB'},async event=>{const projectId=String(event.params.projectId||''),revision=String(event.params.revision||'');try{await buildWithLock(projectId,revision)}catch(error){log('TRIGGER_FAILED',{projectId,revision,errorCode:REPORT_FAILURE_CODE,incidentId:incidentFrom(error)})}});
exports.finalizeRevexDailyReport = onCall({timeoutSeconds:540,memory:'2GiB',concurrency:2},async request=>{if(!request.auth?.uid)throw new HttpsError('unauthenticated','Sign in to REVEX.');const projectId=assertId(request.data?.projectId,'projectId'),revision=assertId(request.data?.revision||'current','revision');await projectAccess(projectId,String(request.auth.uid),request.auth.token||{});try{const report=await buildWithLock(projectId,revision==='current'?'':revision);return{ok:true,schema:'liber.revex.daily-report-response.v1',build:BUILD,day:report.day,changeCount:report.changes.length,openIssueCount:report.openIssues.length,affectedPlanCount:report.annotatedPlans.filter(p=>p.status==='ANNOTATED').length,pdfPath:report.pdf?.path||null,groundingStatus:report.grounding?.status||'DETERMINISTIC_ONLY'}}catch(error){throw new HttpsError('internal',REPORT_FAILURE_MESSAGE,{errorCode:REPORT_FAILURE_CODE,incidentId:incidentFrom(error)})}});
exports._test={nycDay,activeIssue,elementComparable,diffViewer,fieldChanges,parseJsonLoose};
