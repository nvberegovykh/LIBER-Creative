#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const worker = read('server/revex-report-functions/index.js');
const pdfWorker = read('server/revex-report-functions/pdf-text-worker.js');
const deploy = read('server/revex-report-functions/deploy-current.ps1');
const pkg = JSON.parse(read('server/revex-report-functions/package.json'));
const lock = JSON.parse(read('server/revex-report-functions/package-lock.json'));
const {
  MAX_PDF_BYTES,
  MAX_TEXT_BYTES,
  MAX_PROJECT_DOC_TOTAL_BYTES,
  MAX_PDF_PAGES,
  PDF_PARSE_TIMEOUT_MS,
  MAX_PROJECT_DOC_CANDIDATES,
  canonicalProjectLibraryPath,
  projectDocumentPolicy,
  verifyProjectDocumentPayload,
  verifyProjectDocumentBytes
} = require('../../server/revex-report-functions/report-security.js');

assert.equal(pkg.dependencies['pdf-parse'], '2.4.5');
assert.equal(pkg.overrides['pdfjs-dist'], '5.4.296');
assert.equal(pkg.overrides.uuid, '11.1.1');
assert.equal(lock.lockfileVersion, 3);
for (const [relative, version] of [
  ['node_modules/firebase-admin', '14.2.0'],
  ['node_modules/firebase-functions', '7.3.2'],
  ['node_modules/pdf-lib', '1.17.1'],
  ['node_modules/pdf-parse', '2.4.5'],
  ['node_modules/pdfjs-dist', '5.4.296'],
  ['node_modules/uuid', '11.1.1']
]) {
  assert.equal(lock.packages[relative]?.version, version, `Lockfile drift: ${relative}`);
  assert.match(String(lock.packages[relative]?.integrity || ''), /^sha512-/, `Lockfile integrity missing: ${relative}`);
}
for (const marker of [
  "const { Worker } = require('node:worker_threads')",
  "path.join(__dirname, 'pdf-text-worker.js')",
  'const ownedBytes = Uint8Array.from(bytes)',
  'new Worker(PDF_WORKER_PATH, { resourceLimits: PDF_WORKER_RESOURCE_LIMITS })',
  'await worker.terminate()',
  '[ownedBytes.buffer]',
  'maxPages: MAX_PDF_PAGES, maxTextChars: MAX_DOC_TEXT',
  'attemptedCandidates >= MAX_PROJECT_DOC_CANDIDATES',
  'attemptedCandidates += 1',
  'else text = verifiedText',
  'canonicalProjectLibraryPath(projectId, row?.storagePath)',
  'const [metadata] = await liveFile.getMetadata()',
  "bucket().file(policy.path, { generation: policy.generation })",
  "versionedFile.download({ validation: 'crc32c' })",
  "String(currentMetadata?.generation || '') !== policy.generation",
  "errorCode:REPORT_FAILURE_CODE,incidentId",
  "new HttpsError('internal',REPORT_FAILURE_MESSAGE,{errorCode:REPORT_FAILURE_CODE,incidentId:incidentFrom(error)})"
]) assert.ok(worker.includes(marker), `Report security boundary missing: ${marker}`);
for (const marker of [
  "const { PDFParse } = require('pdf-parse')",
  'new PDFParse({ data: message.bytes, isEvalSupported: false, stopAtErrors: true })',
  'parser.getText({ first: maxPages })',
  'await parser.destroy()',
  'parentPort.close()'
]) assert.ok(pdfWorker.includes(marker), `Isolated PDF worker boundary missing: ${marker}`);
assert.equal(MAX_PROJECT_DOC_CANDIDATES, 32);
assert.equal(MAX_PDF_PAGES, 48);
assert.equal(PDF_PARSE_TIMEOUT_MS, 15000);
assert.ok(!worker.includes('await pdfParse(bytes)'), 'legacy pdf-parse v1 execution remains');
assert.ok(!worker.includes('Promise.race('), 'same-isolate timeout is not a hard PDF parser boundary');
assert.ok(!worker.includes("else text = bytes.toString('utf8')"), 'validated text is decoded again through permissive Buffer semantics');
assert.ok(!worker.includes("new HttpsError('internal',String(error"), 'callable exposes a raw backend error');
assert.ok(!worker.includes("status:'FAILED',runId,error:String(error"), 'report job exposes a raw backend error');
for (const marker of [
  "npm ci --ignore-scripts --no-audit --no-fund",
  "npm audit --omit=dev --audit-level=high",
  "pdf-parse/package.json",
  "pdfjs-dist/package.json",
  "uuid/package.json",
  "pdf-parse@2.4.5",
  "pdfjs-dist@5.4.296",
  "uuid@11.1.1",
  "Join-Path $Source 'pdf-text-worker.js'",
  "Join-Path $Source 'package-lock.json'",
  "Syntax-check isolated Report PDF parser"
]) assert.ok(deploy.includes(marker), `Report deploy dependency gate missing: ${marker}`);

const valid = 'projects/alpha/library/record_in/docs/manual.pdf';
assert.equal(canonicalProjectLibraryPath('alpha', valid), valid);
assert.equal(canonicalProjectLibraryPath('alpha', 'projects/alpha/library/revex/revisions/r1/A101.pdf'), 'projects/alpha/library/revex/revisions/r1/A101.pdf');
for (const hostile of [
  'projects/beta/library/record_in/docs/secret.pdf',
  'projects/alpha/revex/energy/results/secret.pdf',
  'projects/alpha/library/../beta/secret.pdf',
  'projects/alpha/library/record_in//secret.pdf',
  'projects\\alpha\\library\\record_in\\secret.pdf',
  'https://firebasestorage.googleapis.com/v0/b/bucket/o/projects%2Fbeta%2Fsecret.pdf?token=secret',
  'storage://projects/alpha/library/record_in/docs/manual.pdf'
]) assert.equal(canonicalProjectLibraryPath('alpha', hostile), '', `hostile path accepted: ${hostile}`);

const pdfBytes = Buffer.from('%PDF-1.7\n%%EOF', 'ascii');
const pdfMetadata = { size:String(pdfBytes.length), contentType:'application/pdf', generation:'123' };
const policy = projectDocumentPolicy('alpha', { storagePath:valid, name:'manual.pdf' }, pdfMetadata, 0);
assert.equal(policy.size, pdfBytes.length);
assert.equal(verifyProjectDocumentBytes(policy, pdfBytes), pdfBytes);
assert.throws(() => projectDocumentPolicy('alpha', { storagePath:valid, name:'manual.pdf' }, { ...pdfMetadata, size:String(MAX_PDF_BYTES + 1) }, 0), /byte boundary/);
assert.throws(() => projectDocumentPolicy('alpha', { storagePath:valid, name:'manual.pdf' }, { ...pdfMetadata, contentType:'text/plain' }, 0), /content type/);
assert.throws(() => projectDocumentPolicy('alpha', { storagePath:valid, name:'manual.txt' }, pdfMetadata, 0), /extension/);
assert.throws(() => projectDocumentPolicy('alpha', { storagePath:valid, name:'manual.pdf' }, pdfMetadata, MAX_PROJECT_DOC_TOTAL_BYTES), /aggregate/);
assert.throws(() => verifyProjectDocumentBytes(policy, Buffer.from('not a pdf')), /inspected Storage generation|file-signature/);

const textPath = 'projects/alpha/library/record_in/docs/notes.txt';
const textBytes = Buffer.from('bounded project notes', 'utf8');
const textPolicy = projectDocumentPolicy('alpha', { storagePath:textPath, name:'notes.txt' }, {
  size:String(textBytes.length), contentType:'text/plain; charset=utf-8', generation:'124'
}, 0);
assert.equal(verifyProjectDocumentBytes(textPolicy, textBytes), textBytes);
const verifiedText = verifyProjectDocumentPayload(textPolicy, textBytes);
assert.equal(verifiedText.bytes, textBytes);
assert.equal(verifiedText.text, 'bounded project notes');
assert.throws(() => projectDocumentPolicy('alpha', { storagePath:textPath, name:'notes.txt' }, {
  size:String(MAX_TEXT_BYTES + 1), contentType:'text/plain', generation:'125'
}, 0), /byte boundary/);
const binary = Buffer.alloc(textBytes.length);binary[0] = 0;
assert.throws(() => verifyProjectDocumentBytes(textPolicy, binary), /binary NUL/);

const tailPath = 'projects/alpha/library/record_in/docs/tail.txt';
const tailBytes = Buffer.alloc(70000, 0x61);
const tailPolicy = projectDocumentPolicy('alpha', { storagePath:tailPath, name:'tail.txt' }, {
  size:String(tailBytes.length), contentType:'text/plain', generation:'126'
}, 0);
const nulTail = Buffer.from(tailBytes);nulTail[nulTail.length - 1] = 0;
assert.throws(() => verifyProjectDocumentPayload(tailPolicy, nulTail), /binary NUL/);
const invalidUtf8Tail = Buffer.from(tailBytes);invalidUtf8Tail[invalidUtf8Tail.length - 1] = 0xff;
assert.throws(() => verifyProjectDocumentPayload(tailPolicy, invalidUtf8Tail), /not valid UTF-8/);

console.log(JSON.stringify({
  REVEX_REPORT_SECURITY: 'PASSED',
  pdfParse:'2.4.5', pdfJs:'5.4.296', evalSupported:false,
  isolatedParserWorker:true, workerTimeoutMs:PDF_PARSE_TIMEOUT_MS,
  maxAttemptedCandidates:MAX_PROJECT_DOC_CANDIDATES,
  projectStorageBoundary:'exact-project-library-record_in-or-revex',
  generationBoundDownload:true, checksumValidation:true,
  wholeBufferFatalUtf8:true, clientErrors:'fixed-code-plus-incident-id',
  maxPdfBytes:MAX_PDF_BYTES, maxTextBytes:MAX_TEXT_BYTES,
  maxAggregateBytes:MAX_PROJECT_DOC_TOTAL_BYTES,
  hostileCrossProjectPathsDenied:true
}));
