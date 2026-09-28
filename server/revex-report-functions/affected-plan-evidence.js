'use strict';

const { TextDecoder } = require('node:util');
const LEGACY_SOURCES = new Set([
  'compatibility-empty-for-pre-0.8.4-import',
  'compatibility-empty-for-pre-0.8.4-retry'
]);
const MESSAGES = Object.freeze({
  'not-found': 'Affected-plan evidence is missing. Report incomplete; no replacement report was published.',
  'permission-denied': 'The report service cannot access affected-plan evidence. Report incomplete; retry after service access is restored.',
  'read-unavailable': 'Affected-plan evidence could not be read. Report incomplete; retry when the service is available.',
  'malformed': 'Affected-plan evidence is malformed or truncated. Report incomplete; recover the original immutable revision before retrying.',
  'unsupported-schema': 'Affected-plan evidence uses an unsupported format. Report incomplete; update the reader before retrying.',
  'revision-mismatch': 'Affected-plan evidence does not belong to the requested revision. Report incomplete; recover the matching immutable evidence.',
  'annotation-incomplete': 'One or more affected plans could not be read or annotated. Report incomplete; no replacement report was published.'
});

class AffectedPlanEvidenceError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES['read-unavailable']);
    this.name = 'AffectedPlanEvidenceError';
    this.code = code;
    this.evidenceStatus = 'INCOMPLETE';
    this.publicCode = ['permission-denied', 'read-unavailable'].includes(code) ? 'unavailable' : 'failed-precondition';
  }
}

function parseJsonBytes(bytes) {
  // Accept the explicit UTF-8 BOM written by native historical exporters,
  // but reject invalid UTF-8 rather than silently changing evidence bytes.
  const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function readFailure(error) {
  const code = error?.code, status = Number(error?.statusCode ?? error?.status ?? code);
  if (status === 404 || code === 'storage/object-not-found') return new AffectedPlanEvidenceError('not-found');
  if (status === 401 || status === 403 || code === 'storage/unauthorized' || code === 'permission-denied')
    return new AffectedPlanEvidenceError('permission-denied');
  // Raw SDK error messages can include URLs, tokens or identifiers. They are
  // intentionally not copied into user-facing jobs, logs or callable errors.
  return new AffectedPlanEvidenceError('read-unavailable');
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validId(value) { return (typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && value.length > 0); }
function validRect(rect) {
  return object(rect) && ['left', 'bottom', 'right', 'top'].every(key =>
    typeof rect[key] === 'number' && Number.isFinite(rect[key]) && rect[key] >= 0 && rect[key] <= 1) &&
    rect.left <= rect.right && rect.bottom <= rect.top;
}
function malformed() { throw new AffectedPlanEvidenceError('malformed'); }

function validateAffectedManifest(manifest, revision) {
  if (!object(manifest) || !Array.isArray(manifest.views)) malformed();
  const v1 = manifest.schema === 'liber.revex.affected-plan-views.v1';
  const v2 = manifest.schema === 'liber.revex.affected-plan-views.v2';
  if (!v1 && !v2) throw new AffectedPlanEvidenceError('unsupported-schema');
  if (manifest.revision != null && String(manifest.revision) !== String(revision))
    throw new AffectedPlanEvidenceError('revision-mismatch');
  if (LEGACY_SOURCES.has(manifest.source)) {
    if (!v1 || manifest.views.length !== 0 || manifest.changedElementCount !== 0 || manifest.hadDeletion !== false) malformed();
    return { manifest, evidence: { status: 'LEGACY_NOT_AVAILABLE', viewCount: 0, source: manifest.source } };
  }
  if (v2 && (!Number.isSafeInteger(manifest.changedElementCount) || manifest.changedElementCount < 0 ||
      typeof manifest.hadDeletion !== 'boolean' || typeof manifest.revision !== 'string')) malformed();
  for (const view of manifest.views) {
    if (!object(view) || !(validId(view.id) || typeof view.uniqueId === 'string' || typeof view.name === 'string') ||
        !(typeof view.pdf === 'string' && view.pdf.length > 0 || typeof view.fileName === 'string' && view.fileName.length > 0)) malformed();
    if (v2 && (!Array.isArray(view.changedElementIds) || !Array.isArray(view.changedRegions) || !Array.isArray(view.unlocatedChangedElementIds))) malformed();
    if (view.changedElementIds !== undefined && (!Array.isArray(view.changedElementIds) || !view.changedElementIds.every(validId))) malformed();
    if (view.unlocatedChangedElementIds !== undefined && (!Array.isArray(view.unlocatedChangedElementIds) || !view.unlocatedChangedElementIds.every(validId))) malformed();
    if (view.changedRegions !== undefined && (!Array.isArray(view.changedRegions) || view.changedRegions.some(region =>
      !object(region) || !validId(region.elementId) || !validRect(region.normalizedRect)))) malformed();
  }
  // v1 native PDFs remain supported even though their old contract had no
  // cloud rectangles. Absence of rectangles must not claim complete clouding.
  const missingLegacyClouds = v1 && manifest.views.some(view => !Array.isArray(view.changedRegions));
  return { manifest, evidence: { status: missingLegacyClouds ? 'LEGACY_CLOUDS_NOT_AVAILABLE' : 'AVAILABLE', viewCount: manifest.views.length } };
}

async function loadAffectedPlanEvidence(readBytes, path, revision) {
  let bytes;
  try { bytes = await readBytes(path); } catch (error) { throw readFailure(error); }
  let manifest;
  try { manifest = parseJsonBytes(bytes); } catch { throw new AffectedPlanEvidenceError('malformed'); }
  return validateAffectedManifest(manifest, revision);
}

function assertAnnotatedPlans(plans) {
  if (plans.some(plan => plan.status !== 'ANNOTATED')) throw new AffectedPlanEvidenceError('annotation-incomplete');
}

module.exports = { parseJsonBytes, loadAffectedPlanEvidence, validateAffectedManifest, assertAnnotatedPlans, AffectedPlanEvidenceError };
