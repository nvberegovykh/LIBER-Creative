'use strict';

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_DOC_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PDF_PAGES = 48;
const PDF_PARSE_TIMEOUT_MS = 15 * 1000;
const MAX_PROJECT_DOC_CANDIDATES = 32;

const TEXT_TYPES = Object.freeze({
  txt: new Set(['text/plain', 'application/octet-stream']),
  md: new Set(['text/plain', 'text/markdown', 'application/octet-stream']),
  csv: new Set(['text/plain', 'text/csv', 'application/csv', 'application/octet-stream']),
  json: new Set(['application/json', 'text/json', 'text/plain', 'application/octet-stream'])
});

function canonicalProjectLibraryPath(projectId, value) {
  const project = String(projectId || '').trim();
  const raw = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(project) || !raw || raw.length > 1024) return '';
  if (/[:?#\\\x00-\x1f]/.test(raw) || raw.includes('//') || /%(?:2e|2f|5c)/i.test(raw)) return '';
  const prefix = `projects/${project}/library/`;
  if (!raw.startsWith(prefix)) return '';
  const tail = raw.slice(prefix.length);
  if (!(tail.startsWith('record_in/') || tail.startsWith('revex/'))) return '';
  const segments = tail.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return '';
  return raw;
}

function extension(value) {
  const match = String(value || '').trim().match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function projectDocumentPolicy(projectId, row, metadata, currentTotalBytes = 0) {
  const path = canonicalProjectLibraryPath(projectId, row?.storagePath);
  if (!path) throw new Error('Document Storage path is outside the exact project Library boundary.');
  const pathName = path.split('/').pop() || '';
  const name = String(row?.name || pathName).trim();
  if (!name || name.length > 260 || /[\\/\x00-\x1f]/.test(name)) throw new Error('Document display name is invalid.');
  const kind = extension(pathName);
  if (!['pdf', 'txt', 'md', 'csv', 'json'].includes(kind) || extension(name) !== kind)
    throw new Error('Document name and object extension do not match an extractable type.');

  const size = Number(metadata?.size);
  const maxBytes = kind === 'pdf' ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes)
    throw new Error(`Document exceeds the ${kind === 'pdf' ? 'PDF' : 'text'} extraction byte boundary.`);
  if (!Number.isSafeInteger(currentTotalBytes) || currentTotalBytes < 0 || currentTotalBytes + size > MAX_PROJECT_DOC_TOTAL_BYTES)
    throw new Error('Project document extraction aggregate byte boundary reached.');

  const contentEncoding = String(metadata?.contentEncoding || '').trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') throw new Error('Encoded Storage objects are not accepted for document extraction.');
  const contentType = String(metadata?.contentType || '').split(';', 1)[0].trim().toLowerCase();
  const typeAllowed = kind === 'pdf' ? contentType === 'application/pdf' : TEXT_TYPES[kind].has(contentType);
  if (!typeAllowed) throw new Error('Document Storage content type does not match its extension.');
  const generation = String(metadata?.generation || '').trim();
  if (!/^[1-9][0-9]{0,30}$/.test(generation)) throw new Error('Document Storage generation is missing or invalid.');
  return Object.freeze({ path, name, kind, size, maxBytes, contentType, generation });
}

function verifyProjectDocumentPayload(policy, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (!policy || bytes.length !== policy.size || bytes.length > policy.maxBytes)
    throw new Error('Downloaded document bytes do not match the inspected Storage generation.');
  let text = null;
  if (policy.kind === 'pdf') {
    if (bytes.length < 8 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-')
      throw new Error('PDF object failed its file-signature boundary.');
  } else {
    if (bytes.includes(0)) throw new Error('Text object contains a binary NUL signature.');
    try {
      // Decode the complete bounded object exactly once. The caller consumes this
      // same string, so no permissive Buffer.toString() pass can reinterpret a tail
      // that was not covered by the fatal UTF-8 validation.
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      throw new Error('Text object is not valid UTF-8.');
    }
  }
  return Object.freeze({ bytes, text });
}

function verifyProjectDocumentBytes(policy, value) {
  return verifyProjectDocumentPayload(policy, value).bytes;
}

module.exports = Object.freeze({
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
});
