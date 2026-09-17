'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { GoogleAuth } = require('google-auth-library');
const { createHash } = require('node:crypto');
const { projectAccessRole } = require('./project-access');

initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 4 });

const db = getFirestore();
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const BROKER_SERVICE_ACCOUNT = process.env.REVEX_ENERGY_BROKER_SERVICE_ACCOUNT || 'revex-energy-broker@liber-apps-cca20.iam.gserviceaccount.com';
const ENERGY_HARD_STOP = 0.80;
const ENERGY_QUALITY_TARGET = 0.95;
const ENGINEERING_CURRENT_ID = 'revex_engineering';
const ENERGY_CURRENT_ID = 'revex_energy';
const COMCHECK_CONSENT_SCHEMA = 'liber.revex.comcheck-consent.v1';
const COMCHECK_SERVICE = 'PNNL_COMCHECK_BACKSTOP';
const COMCHECK_ENDPOINT = 'https://legacy-comcheck.energycode.pnl.gov/CheckWeb/';
const COMCHECK_SCOPE = 'GENERATED_CURRENT_PROJECT_CXL_ONLY';
const EN1_AMENDMENT_MODE = 'EN1_IDENTITY_AMENDMENT';
const SOURCE_CANDIDATE = String(process.env.REVEX_SOURCE_CANDIDATE || '').trim();
const GOOGLE_RENDER_MODEL = 'gemini-3.1-flash-image';
const GOOGLE_RENDER_SCHEMA = 'liber.revex.google-render-request.v1';
const GOOGLE_RENDER_JOB_SCHEMA = 'liber.revex.google-render-job.v1';
const GOOGLE_RENDER_RESOLUTIONS = new Set(['1K', '2K', '4K']);
const GOOGLE_RENDER_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const GOOGLE_RENDER_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const GOOGLE_RENDER_MAX_RESULT_BYTES = 32 * 1024 * 1024;
const GOOGLE_RENDER_MAX_PROMPT_BYTES = 24 * 1024;
const GOOGLE_RENDER_MAX_PROVIDER_RESPONSE_BYTES = 48 * 1024 * 1024;
const GOOGLE_RENDER_MAX_TEXT_BYTES = 8 * 1024;
const GOOGLE_RENDER_MAX_EDGE = 8192;
const GOOGLE_RENDER_MAX_PIXELS = 48 * 1024 * 1024;
const GOOGLE_RENDER_JOB_MAX_AGE_MS = 20 * 60 * 1000;
const GOOGLE_RENDER_SERVICE_ACCOUNT = process.env.REVEX_RENDER_BROKER_SERVICE_ACCOUNT || BROKER_SERVICE_ACCOUNT;
const GOOGLE_RENDER_QUOTA_PROJECT = String(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '').trim();

function brokerLog(stage, detail = {}) {
  console.log('[REVEX ENERGY BROKER]', JSON.stringify({
    at: new Date().toISOString(), stage, ...detail
  }));
}

function libraryDoc(projectId, id) {
  return db.doc(`projects/${projectId}/library/${id}`);
}

async function loadEngineeringRevision(projectId, sourceRevision, correlationId) {
  const canonicalRef = libraryDoc(projectId, `revex_engineering_revision_${sourceRevision}`);
  const canonicalSnap = await canonicalRef.get();
  if (canonicalSnap.exists) {
    return { data: canonicalSnap.data() || {}, source: 'library', ref: canonicalRef.path };
  }
  brokerLog('ENGINEERING_REVISION_NOT_FOUND', {
    correlationId, projectId, sourceRevision, canonicalRef: canonicalRef.path
  });
  throw new HttpsError('failed-precondition', 'The exact immutable Engineering Sync revision is not published.', {
    correlationId, projectId, sourceRevision, checked: [canonicalRef.path]
  });
}

function assertProjectId(value, label) {
  const text = String(value || '').trim();
  if (!PROJECT_ID_RE.test(text)) throw new HttpsError('invalid-argument', `${label} is invalid.`);
  return text;
}

function ratiosPass(manifest) {
  const p = manifest?.publicationIntegrity || {};
  const ratios = p?.ratios || {};
  if (Number(p.threshold || 0) < ENERGY_HARD_STOP) return false;
  if (Number(p.qualityTarget || p.threshold || 0) < ENERGY_QUALITY_TARGET) return false;
  const values = Object.values(ratios);
  return values.length > 0 && values.every((v) => Number(v) >= ENERGY_HARD_STOP);
}

async function assertProjectAccess(projectId, uid, authClaims = {}) {
  const snap = await db.doc(`projects/${projectId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'REVEX project not found.');
  const data = snap.data() || {};
  const accessRole = projectAccessRole(data, authClaims, uid);
  if (!accessRole)
    throw new HttpsError('permission-denied', 'You do not have access to this REVEX project.');
  return { project: { id: snap.id, ...data }, accessRole };
}

async function requireComcheckConsent(projectId, sourceRevision, uid) {
  const ref = db.doc(`projects/${projectId}/revexEnergyConsents/${sourceRevision}/approvers/${uid}`);
  const snap = await ref.get();
  if (!snap.exists)
    throw new HttpsError('failed-precondition', 'Authorize official COMcheck processing for this exact Engineering revision. No current-project CXL was transmitted.');
  const consent = snap.data() || {};
  const approvedAt = Date.parse(String(consent.approvedAt || ''));
  const valid = consent.schema === COMCHECK_CONSENT_SCHEMA && consent.approved === true &&
    String(consent.projectId || '') === projectId && String(consent.sourceEngineeringRevision || '') === sourceRevision &&
    String(consent.approvedByUid || '') === uid && consent.service === COMCHECK_SERVICE &&
    consent.endpoint === COMCHECK_ENDPOINT && consent.scope === COMCHECK_SCOPE &&
    Number.isFinite(approvedAt) && approvedAt <= Date.now() + 300000;
  if (!valid)
    throw new HttpsError('failed-precondition', 'The COMcheck authorization record does not match this authenticated user, project, revision, endpoint and CXL-only scope. No CXL was transmitted.');
  return { ...consent, recordPath: ref.path };
}

function workerErrorDetail(error, stage = 'WORKER_REQUEST') {
  const status = Number(error?.response?.status || error?.code || 0) || null;
  const body = error?.response?.data;
  const workerMessage = typeof body === 'string'
    ? body
    : String(body?.error || body?.message || error?.message || error || 'Unknown managed-worker error');
  return {
    stage,
    status,
    message: workerMessage.slice(0, 4000),
    worker: 'revex-energy-worker-r49'
  };
}

function bucketFromArtifactUrls(artifacts) {
  const buckets = new Set();
  for (const row of artifacts || []) {
    const raw = String(row?.url || '').trim();
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.hostname === 'firebasestorage.googleapis.com') {
        const match = parsed.pathname.match(/\/v0\/b\/([^/]+)\/o(?:\/|$)/i);
        if (match?.[1]) buckets.add(decodeURIComponent(match[1]));
      } else if (parsed.hostname === 'storage.googleapis.com') {
        const bucket = parsed.pathname.split('/').filter(Boolean)[0];
        if (bucket) buckets.add(decodeURIComponent(bucket));
      }
    } catch (_) {}
  }
  if (buckets.size > 1)
    throw new Error(`Immutable Engineering artifacts resolve to multiple storage buckets: ${[...buckets].join(', ')}`);
  return buckets.size === 1 ? [...buckets][0] : '';
}

function configuredStorageBucket() {
  const explicit = String(process.env.REVEX_STORAGE_BUCKET || '').trim();
  if (explicit) return explicit;
  try {
    const config = JSON.parse(String(process.env.FIREBASE_CONFIG || '{}'));
    return String(config?.storageBucket || '').trim();
  } catch (_) {
    return '';
  }
}

function resolveStorageBucket(artifacts) {
  const configuredBucket = configuredStorageBucket();
  if (!configuredBucket)
    throw new Error('REVEX Energy broker has no exact release-bound Firebase Storage bucket.');
  const artifactBucket = bucketFromArtifactUrls(artifacts);
  if (artifactBucket && artifactBucket !== configuredBucket)
    throw new Error(`Immutable Engineering artifact URLs reference ${artifactBucket}, outside the release-bound Storage bucket.`);
  return configuredBucket;
}

function renderLog(stage, detail = {}) {
  console.log('[REVEX GOOGLE RENDER BROKER]', JSON.stringify({
    at: new Date().toISOString(), stage, ...detail
  }));
}

function configuredProjectId() {
  if (GOOGLE_RENDER_QUOTA_PROJECT) return GOOGLE_RENDER_QUOTA_PROJECT;
  try {
    const config = JSON.parse(String(process.env.FIREBASE_CONFIG || '{}'));
    return String(config?.projectId || '').trim();
  } catch (_) {
    return '';
  }
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function boundedUtf8(value, maxBytes) {
  const text = String(value || '');
  if (utf8Bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function imageExtension(mimeType) {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 3 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (startOfFrame.has(marker) && length >= 7)
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    offset += length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') return null;
  if (buffer.readUInt32LE(4) + 8 > buffer.length) return null;
  const kind = buffer.subarray(12, 16).toString('ascii');
  if (kind === 'VP8X') {
    const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
    const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
    return { width, height };
  }
  if (kind === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a)
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  return null;
}

function imageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png') {
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
        buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') return jpegDimensions(buffer);
  if (mimeType === 'image/webp') return webpDimensions(buffer);
  return null;
}

function imageMagicMatches(buffer, mimeType) {
  const dimensions = imageDimensions(buffer, mimeType);
  return Boolean(dimensions && dimensions.width > 0 && dimensions.height > 0 &&
    dimensions.width <= GOOGLE_RENDER_MAX_EDGE && dimensions.height <= GOOGLE_RENDER_MAX_EDGE &&
    dimensions.width * dimensions.height <= GOOGLE_RENDER_MAX_PIXELS);
}

function decodeBoundedBase64Image(mimeTypeValue, base64Value, maxBytes, label) {
  const mimeType = String(mimeTypeValue || '').trim().toLowerCase();
  if (!GOOGLE_RENDER_MIME.has(mimeType))
    throw new HttpsError('invalid-argument', `${label} must be PNG, JPEG or WebP.`);
  const encoded = String(base64Value || '').trim();
  const maxEncoded = Math.ceil(maxBytes / 3) * 4 + 4;
  if (!encoded || encoded.length > maxEncoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new HttpsError('invalid-argument', `${label} encoding is invalid or exceeds ${maxBytes} bytes.`);
  const buffer = Buffer.from(encoded, 'base64');
  const canonical = buffer.toString('base64').replace(/=+$/, '');
  if (!buffer.length || buffer.length > maxBytes || canonical !== encoded.replace(/=+$/, '') || !imageMagicMatches(buffer, mimeType))
    throw new HttpsError('invalid-argument', `${label} is not a valid bounded ${mimeType} image.`);
  return { buffer, mimeType, extension: imageExtension(mimeType) };
}

function decodeViewportDataUrl(value) {
  const dataUrl = String(value || '');
  const maxEncoded = Math.ceil(GOOGLE_RENDER_MAX_SOURCE_BYTES / 3) * 4 + 128;
  if (!dataUrl || dataUrl.length > maxEncoded)
    throw new HttpsError('invalid-argument', 'The current viewport is empty or exceeds the 12 MiB render boundary.');
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) throw new HttpsError('invalid-argument', 'The current viewport must be a base64 PNG, JPEG or WebP image.');
  return decodeBoundedBase64Image(match[1], match[2], GOOGLE_RENDER_MAX_SOURCE_BYTES, 'The current viewport');
}

function sanitizedUsage(value) {
  const source = value && typeof value === 'object' ? value : {};
  const keys = ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount'];
  const usage = {};
  for (const key of keys) {
    const number = Number(source[key]);
    if (Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER) usage[key] = Math.floor(number);
  }
  return usage;
}

function renderFailure(error, stage) {
  const providerStatus = Number(error?.response?.status || 0) || null;
  const providerBody = error?.response?.data;
  const raw = error instanceof HttpsError
    ? error.message
    : providerBody?.error?.message || providerBody?.message || error?.message || String(error || 'Unknown Render failure');
  const code = error instanceof HttpsError ? error.code : providerStatus === 429 ? 'resource-exhausted' : 'internal';
  return {
    code,
    stage,
    providerStatus,
    message: boundedUtf8(raw, 1200) || 'REVEX Google Render failed.'
  };
}

function renderJobRefs(projectId, jobId) {
  return {
    job: db.doc(`projects/${projectId}/revexRenders/${jobId}`),
    lease: db.doc(`projects/${projectId}/revexRenderJobs/${jobId}`)
  };
}

async function acceptGoogleRenderJob(projectId, jobId, uid, sourceRevision, correlationId) {
  const refs = renderJobRefs(projectId, jobId);
  await db.runTransaction(async (transaction) => {
    const [jobSnap, leaseSnap] = await Promise.all([
      transaction.get(refs.job),
      transaction.get(refs.lease)
    ]);
    if (!jobSnap.exists)
      throw new HttpsError('failed-precondition', 'Create the controlled REVEX Render job before starting generation.');
    const job = jobSnap.data() || {};
    const createdAt = Date.parse(String(job.createdAt || ''));
    const age = Date.now() - createdAt;
    const controlled = job.schema === GOOGLE_RENDER_JOB_SCHEMA && job.type === 'revex' && job.hidden === true &&
      job.revexKind === 'render' && String(job.revexId || '') === jobId && String(job.createdBy || '') === uid &&
      String(job.provider || '') === 'google-gemini-server' && String(job.model || '') === GOOGLE_RENDER_MODEL &&
      String(job.status || '').toUpperCase() === 'PREPARED' && Number.isFinite(createdAt) && age >= -300000 && age <= GOOGLE_RENDER_JOB_MAX_AGE_MS;
    if (!controlled)
      throw new HttpsError('permission-denied', 'The Render job is not a fresh caller-owned controlled REVEX job.');
    if (String(job.sourceRevision || '') !== sourceRevision)
      throw new HttpsError('failed-precondition', 'The Render job no longer matches the captured BIM source revision.');
    if (leaseSnap.exists)
      throw new HttpsError('already-exists', 'This Render job was already accepted. Start a new Render for another attempt.');
    transaction.create(refs.lease, {
      schema: 'liber.revex.google-render-lease.v1', projectId, jobId,
      status: 'ACCEPTED', stage: 'ACCEPTED', requestedBy: uid,
      sourceRevision, correlationId, model: GOOGLE_RENDER_MODEL,
      sourceCandidate: SOURCE_CANDIDATE, acceptedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.set(refs.job, {
      status: 'ACCEPTED', stage: 'ACCEPTED', acceptedAt: FieldValue.serverTimestamp(),
      correlationId, updatedAt: FieldValue.serverTimestamp(), updatedBy: 'revex-google-render-broker'
    }, { merge: true });
  });
  return refs;
}

async function updateGoogleRenderJob(refs, patch) {
  const serverPatch = { ...patch, updatedAt: FieldValue.serverTimestamp() };
  const jobPatch = { ...serverPatch, updatedBy: 'revex-google-render-broker' };
  const batch = db.batch();
  batch.set(refs.lease, serverPatch, { merge: true });
  batch.set(refs.job, jobPatch, { merge: true });
  await batch.commit();
}

async function savePrivateRenderObject(bucket, path, image, metadata) {
  await bucket.file(path).save(image.buffer, {
    resumable: false,
    validation: 'crc32c',
    contentType: image.mimeType,
    metadata: {
      contentType: image.mimeType,
      cacheControl: 'private, max-age=0, no-store',
      metadata: Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value)]))
    }
  });
}

exports.runRevexEnergy = onCall({ timeoutSeconds: 3600, memory: '1GiB', concurrency: 4, serviceAccount: BROKER_SERVICE_ACCOUNT }, async (request) => {
  const correlationId = `broker-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  brokerLog('REQUEST_RECEIVED', { correlationId, authenticated: Boolean(request.auth?.uid) });
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in to REVEX before running Energy.');
  const data = request.data || {};
  if (data.schema !== 'liber.revex.energy-broker-request.v1')
    throw new HttpsError('invalid-argument', 'Unsupported REVEX Energy broker request.');

  const projectId = assertProjectId(data.projectId, 'projectId');
  const sourceRevision = assertProjectId(data.sourceRevision, 'sourceRevision');
  const mode = String(data.mode || 'FULL_PIPELINE').trim().toUpperCase();
  if (!['FULL_PIPELINE', EN1_AMENDMENT_MODE].includes(mode))
    throw new HttpsError('invalid-argument', 'Unsupported REVEX Energy execution mode.');
  const en1Amendment = mode === EN1_AMENDMENT_MODE;
  const uid = String(request.auth.uid);
  const access = await assertProjectAccess(projectId, uid, request.auth.token || {});
  const project = access.project;
  brokerLog('ACCESS_VERIFIED', { correlationId, projectId, sourceRevision, accessRole: access.accessRole });

  const existing = await libraryDoc(projectId, ENERGY_CURRENT_ID).get();
  const parentEnergy = existing.exists ? existing.data() || {} : null;
  if (existing.exists) {
    const state = parentEnergy;
    if (String(state?.manifest?.sourceEngineeringRevision || '') === sourceRevision &&
        String(state?.manifest?.pipelineVersion || '') === '0.8.19-r49' &&
        /^[a-f0-9]{40}$/i.test(String(state?.manifest?.sourceCandidate || '')) &&
        String(state?.manifest?.status || '').toUpperCase() === 'COMPLETE' && !en1Amendment) {
      return { ok: true, reused: true, status: 'COMPLETE', sourceRevision, resultRevision: state.revision || state?.manifest?.resultRevision || '' };
    }
  }
  if (en1Amendment) {
    const requestedParent = assertProjectId(data.parentResultRevision, 'parentResultRevision');
    if (!parentEnergy || String(parentEnergy?.manifest?.status || '').toUpperCase() !== 'COMPLETE' ||
        String(parentEnergy?.manifest?.sourceEngineeringRevision || '') !== sourceRevision ||
        String(parentEnergy?.revision || parentEnergy?.manifest?.resultRevision || '') !== requestedParent ||
        String(parentEnergy?.manifest?.resultRevision || '') !== requestedParent)
      throw new HttpsError('failed-precondition', 'Apply to EN-1 requires the exact current COMPLETE Energy result for this Engineering revision.');
  }

  const loadedEngineering = await loadEngineeringRevision(projectId, sourceRevision, correlationId);
  const engineering = loadedEngineering.data;
  const manifest = engineering.manifest || {};
  if (manifest.schema !== 'liber.revex.engineering-sync.v1' || manifest.architecture !== 'REVIT_EVIDENCE_GRAPH_V1')
    throw new HttpsError('failed-precondition', 'Engineering Sync architecture is incompatible.');
  if (String(manifest.projectId || '') !== projectId || String(manifest.revision || '') !== sourceRevision)
    throw new HttpsError('failed-precondition', 'Engineering Sync project/revision identity mismatch.');
  const binding = manifest.projectBinding || {};
  if (binding.version !== 'active-revit-evidence-v1' ||
      !['explicit-user-selection', 'stored-active-document'].includes(String(binding.source || '')) ||
      !String(binding.documentUniqueId || '').trim() || !String(binding.documentFingerprint || '').trim() ||
      !/^[a-f0-9]{64}$/i.test(String(binding.identityEvidenceDigest || ''))) {
    throw new HttpsError('failed-precondition', 'Engineering Sync is not bound to verified active-Revit-document evidence.');
  }
  if (!ratiosPass(manifest)) throw new HttpsError('failed-precondition', 'Engineering Sync did not preserve >=80% in every required evidence domain.');
  if (manifest.writeBackToRevitAfterExport !== false || manifest.pdfInsertion !== false)
    throw new HttpsError('failed-precondition', 'Engineering Sync authority boundary is invalid.');

  const comcheckConsent = await requireComcheckConsent(projectId, sourceRevision, uid);
  brokerLog('COMCHECK_CONSENT_VERIFIED', {
    correlationId, projectId, sourceRevision, approvedByUid: uid,
    approvedAt: comcheckConsent.approvedAt, consentRecord: comcheckConsent.recordPath
  });

  const artifacts = Array.isArray(engineering.artifacts) ? engineering.artifacts : [];
  const names = new Set(artifacts.map((row) => String(row.name || '').toLowerCase()));
  if (!names.has('engineering-sync.json') || !names.has('revit-project-identity.json') ||
      ![...names].some((n) => n.endsWith('.xml')) || ![...names].some((n) => n.endsWith('.epw')))
    throw new HttpsError('failed-precondition', 'Immutable Engineering Sync must contain its manifest, active-document identity, gbXML and verified EPW.');
  if (artifacts.some((row) => !row?.cloud || !row?.path))
    throw new HttpsError('failed-precondition', 'Engineering Sync contains an unpublished artifact.');
  if (artifacts.some((row) => Number(row?.bytes || 0) <= 0 || !/^[a-f0-9]{64}$/i.test(String(row?.sha256 || ''))))
    throw new HttpsError('failed-precondition', 'Engineering Sync contains an artifact without exact byte and SHA-256 transfer integrity.');
  const evidencePrefix = `projects/${projectId}/revex/engineering/revisions/${sourceRevision}/`;
  if (artifacts.some((row) => !String(row.path || '').startsWith(evidencePrefix)))
    throw new HttpsError('failed-precondition', 'Engineering Sync contains an artifact outside its immutable revision.');
  brokerLog('ENGINEERING_REVISION_VERIFIED', {
    correlationId, projectId, sourceRevision, artifacts: artifacts.length,
    revisionSource: loadedEngineering.source, revisionRef: loadedEngineering.ref
  });

  const amendmentId = en1Amendment ? assertProjectId(data.amendmentId, 'amendmentId') : '';
  const outputPrefix = en1Amendment
    ? `projects/${projectId}/revex/energy/server-results/${sourceRevision}/amendments/${amendmentId}`
    : `projects/${projectId}/revex/energy/server-results/${sourceRevision}`;
  const jobRef = db.doc(`projects/${projectId}/revexEnergyJobs/${sourceRevision}`);
  await jobRef.set({
    schema: 'liber.revex.energy-job.v1', projectId, sourceRevision, status: 'RUNNING',
    startedAt: FieldValue.serverTimestamp(), requestedBy: uid,
    worker: en1Amendment ? 'managed-en1-publication-amendment' : 'managed-openstudio-3.10', clientBuild: String(data.clientBuild || ''),
    mode, parentResultRevision: en1Amendment ? String(parentEnergy?.manifest?.resultRevision || '') : null,
    correlationId, stage: 'BROKER_PREPARE',
    comcheckConsent: {
      schema: comcheckConsent.schema, service: comcheckConsent.service, endpoint: comcheckConsent.endpoint,
      scope: comcheckConsent.scope, approvedAt: comcheckConsent.approvedAt, approvedByUid: uid
    }
  }, { merge: true });

  let failureStage = 'BROKER_PREPARE';
  try {
    const workerUrl = String(process.env.REVEX_ENERGY_WORKER_URL || '').replace(/\/+$/, '');
    if (!workerUrl) throw new Error('REVEX_ENERGY_WORKER_URL is not configured.');
    const bucketName = resolveStorageBucket(artifacts);
    brokerLog('STORAGE_BUCKET_RESOLVED', { correlationId, projectId, sourceRevision, bucketName, source: 'release-runtime-config' });
    failureStage = 'WORKER_REQUEST';
    await jobRef.set({ stage: failureStage, storageBucket: bucketName, workerUrl }, { merge: true });

    brokerLog('WORKER_REQUEST_STARTED', { correlationId, projectId, sourceRevision, workerUrl, bucketName });
    const googleAuth = new GoogleAuth();
    const client = await googleAuth.getIdTokenClient(workerUrl);
    const response = await client.request({
      url: `${workerUrl}/run`, method: 'POST', timeout: 3550000,
      data: {
        schema: 'liber.revex.energy-server-request.v1', projectId, sourceRevision,
        mode,
        projectName: String(project.name || manifest?.sourceModel?.title || projectId),
        bucket: bucketName, outputPrefix,
        artifacts: artifacts.map((row) => ({ name: String(row.name || ''), path: String(row.path || ''), bytes: Number(row.bytes || 0), sha256: String(row.sha256 || '') })),
        projectSource: {
          name: String(project.name || ''), code: String(project.code || ''), filingPath: 'NYCECC_APPENDIX_CA_PRM',
          identityOverride: comcheckConsent.projectIdentityOverride || {},
          en1Applicant: comcheckConsent.en1Applicant || {},
          en1Modeler: comcheckConsent.en1Modeler || {},
          identityOverridePolicy: 'USER_PROJECT_IDENTITY_ONLY_FILLS_MISSING_REVIT_FIELDS'
        },
        parentResult: en1Amendment ? {
          revision: String(parentEnergy?.revision || ''),
          manifest: parentEnergy?.manifest || {},
          artifacts: Array.isArray(parentEnergy?.artifacts) ? parentEnergy.artifacts : []
        } : null,
        comcheckConsent: {
          schema: comcheckConsent.schema, approved: true, projectId, sourceEngineeringRevision: sourceRevision,
          approvedByUid: uid, approvedAt: comcheckConsent.approvedAt, service: comcheckConsent.service,
          endpoint: comcheckConsent.endpoint, scope: comcheckConsent.scope
        }
      }
    });
    brokerLog('WORKER_REQUEST_COMPLETED', { correlationId, projectId, sourceRevision, httpStatus: Number(response.status || 200) });
    const body = response.data || {};
    if (body.schema !== 'liber.revex.energy-server-response.v1' || String(body.projectId || '') !== projectId || String(body.sourceRevision || '') !== sourceRevision)
      throw new Error('Managed worker returned an incompatible project/revision response.');
    const resultManifest = body.manifest || {};
    const workerSourceCandidate = String(resultManifest.sourceCandidate || '').trim();
    if (resultManifest.schema !== 'liber.revex.energy-result.v1' ||
        String(resultManifest.pipelineVersion || '') !== '0.8.19-r49' ||
        !/^[a-f0-9]{40}$/i.test(workerSourceCandidate) ||
        resultManifest.revitWriteBack !== false || resultManifest.pdfInsertion !== false)
      throw new Error('Managed worker returned an invalid Energy authority boundary.');
    if (en1Amendment) {
      const amendment = resultManifest.amendment || {};
      if (amendment.schema !== 'liber.revex.en1-identity-amendment.v1' ||
          amendment.mode !== EN1_AMENDMENT_MODE ||
          amendment.parentResultRevision !== String(parentEnergy?.manifest?.resultRevision || '') ||
          amendment.sourceEngineeringRevision !== sourceRevision ||
          amendment.geometryCoRerun !== false || amendment.openStudioRerun !== false ||
          amendment.energyPlusRerun !== false || amendment.comcheckRerun !== false ||
          amendment.projectIdentityChanged !== false || amendment.signatureSealChanged !== false)
        throw new Error('Managed worker violated the publication-only EN-1 amendment boundary.');
    }
    const pipelineStatus = String(resultManifest.status || body.status || 'UNKNOWN').toUpperCase();
    const pipelineError = String(resultManifest.error || body.error || `Energy pipeline status is ${pipelineStatus}.`).slice(0, 4000);
    brokerLog('WORKER_AUTHORITY_VERIFIED', {
      correlationId, projectId, sourceRevision, workerSourceCandidate,
      brokerSourceCandidate: SOURCE_CANDIDATE || null,
      pipelineVersion: resultManifest.pipelineVersion,
      pipelineStatus
    });
    if (pipelineStatus === 'COMPLETE') {
      const resultArtifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
      const names = new Set(resultArtifacts.map((row) => String(row.name || '')));
      const required = [
        'BASELINE_UPDATED_GEOMETRY.osm',
        'PROPOSED_UPDATED_GEOMETRY.osm',
        'EN-1_READY_TO_INSERT.xlsx',
        'COMcheck_PROJECT_INPUT_READY.cxl',
        'COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf',
        'COMcheck_BACKSTOP_RESULT.json'
      ];
      const missing = required.filter((name) => !names.has(name));
      const compiledOsmCount = resultArtifacts.filter((row) => row.kind === 'compiled-model' && /\.osm$/i.test(String(row.name || ''))).length;
      const corrupt = resultArtifacts.filter((row) => Number(row?.bytes || 0) <= 0 ||
        !/^[a-f0-9]{64}$/i.test(String(row?.sha256 || '')) || !String(row?.path || '').trim());
      if (en1Amendment) {
        const changedNames = new Set(['EN-1_READY_TO_INSERT.xlsx', 'EN-1_READY_TO_INSERT.pdf', 'REVEX_ENERGY_RELEASE_PACKAGE.zip']);
        const parentRows = Array.isArray(parentEnergy?.artifacts) ? parentEnergy.artifacts : [];
        const exactParent = (row) => parentRows.some((prior) =>
          String(prior?.name || '') === String(row?.name || '') && String(prior?.path || '') === String(row?.path || '') &&
          Number(prior?.bytes || 0) === Number(row?.bytes || 0) && String(prior?.sha256 || '').toLowerCase() === String(row?.sha256 || '').toLowerCase());
        for (const row of resultArtifacts) {
          const inAmendment = String(row?.path || '').startsWith(`${outputPrefix}/artifacts/`);
          if (inAmendment !== changedNames.has(String(row?.name || '')))
            corrupt.push(row);
          if (!inAmendment && !exactParent(row)) corrupt.push(row);
        }
        for (const prior of parentRows) {
          if (changedNames.has(String(prior?.name || ''))) continue;
          if (!resultArtifacts.some((row) => String(row?.name || '') === String(prior?.name || '') && exactParent(row)))
            corrupt.push(prior);
        }
      } else {
        corrupt.push(...resultArtifacts.filter((row) => !String(row?.path || '').startsWith(`${outputPrefix}/artifacts/`)));
      }
      if (missing.length || corrupt.length || compiledOsmCount !== 2 || resultManifest?.comcheck?.officialDoeReport !== true) {
        throw new Error(`Managed worker violated the r49 completion contract: missing=${missing.join(',') || 'none'}; corrupt=${corrupt.map((row) => row?.name || '?').join(',') || 'none'}; compiledOsmCount=${compiledOsmCount}; officialBackstop=${resultManifest?.comcheck?.officialDoeReport === true}`);
      }
    }

    const resultRevision = assertProjectId(body.resultRevision || resultManifest.resultRevision || `energy_${Date.now()}`, 'resultRevision');
    const resultState = {
      schema: 'liber.revex.energy-state.v1', projectId, revision: resultRevision,
      sourceEngineeringRevision: sourceRevision, publishedAt: new Date().toISOString(),
      manifest: resultManifest, artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
      manifestPath: body.manifestPath || null,
      cloud: true, execution: 'managed-server', worker: 'OpenStudio-3.10/EnergyPlus + official COMcheck Backstop',
      workerSourceCandidate, brokerSourceCandidate: SOURCE_CANDIDATE || null, requestedBy: uid,
      executionMode: mode, parentResultRevision: en1Amendment ? String(parentEnergy?.manifest?.resultRevision || '') : null
    };
    const resultRecord = {
      ...resultState,
      type: 'revex',
      hidden: true,
      revexKind: 'energy',
      updatedAt: resultState.publishedAt
    };
    const immutableResultRef = libraryDoc(projectId, `revex_energy_result_${resultRevision}`);
    const batch = db.batch();
    batch.set(immutableResultRef, {
      ...resultRecord, revexKind: 'energy-result', immutable: true
    }, { merge: false });
    batch.set(libraryDoc(projectId, ENERGY_CURRENT_ID), resultRecord, { merge: false });
    if (pipelineStatus === 'COMPLETE') {
      batch.set(jobRef, {
        status: 'COMPLETE', pipelineStatus, resultRevision,
        finishedAt: FieldValue.serverTimestamp(), error: null,
        stage: 'COMPLETE', correlationId
      }, { merge: true });
    } else {
      batch.set(jobRef, {
        status: 'FAILED', pipelineStatus, resultRevision,
        finishedAt: FieldValue.serverTimestamp(), error: pipelineError,
        stage: 'PIPELINE_TERMINAL', correlationId
      }, { merge: true });
    }
    await batch.commit();
    brokerLog(pipelineStatus === 'COMPLETE' ? 'RESULT_PUBLISHED' : 'PIPELINE_TERMINAL', {
      correlationId, projectId, sourceRevision, resultRevision, status: pipelineStatus,
      workerSourceCandidate, error: pipelineStatus === 'COMPLETE' ? null : pipelineError
    });
    return {
      ok: pipelineStatus === 'COMPLETE',
      status: pipelineStatus,
      sourceRevision,
      resultRevision,
      error: pipelineStatus === 'COMPLETE' ? null : pipelineError,
      message: pipelineStatus === 'COMPLETE' ? null : pipelineError
    };
  } catch (error) {
    const detail = workerErrorDetail(error, failureStage);
    console.error('[REVEX ENERGY BROKER]', JSON.stringify({ correlationId, projectId, sourceRevision, ...detail }), error);
    await jobRef.set({
      status: 'INFRASTRUCTURE_FAILED', finishedAt: FieldValue.serverTimestamp(),
      error: detail.message, stage: detail.stage, workerHttpStatus: detail.status, correlationId
    }, { merge: true });
    throw new HttpsError('internal', `Managed REVEX Energy execution failed at ${detail.stage}: ${detail.message}`, {
      correlationId, projectId, sourceRevision, ...detail
    });
  }
});

exports.runRevexGoogleRender = onCall({
  region: 'us-central1',
  timeoutSeconds: 540,
  memory: '2GiB',
  concurrency: 2,
  maxInstances: 4,
  serviceAccount: GOOGLE_RENDER_SERVICE_ACCOUNT
}, async (request) => {
  const correlationId = `render-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const uid = String(request.auth?.uid || '');
  renderLog('REQUEST_RECEIVED', { correlationId, authenticated: Boolean(uid) });
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to LIBER Apps before rendering.');
  if (!/^[a-f0-9]{40}$/i.test(SOURCE_CANDIDATE))
    throw new HttpsError('failed-precondition', 'The Google Render broker is not bound to an exact release source.');

  const data = request.data || {};
  if (data.schema !== GOOGLE_RENDER_SCHEMA)
    throw new HttpsError('invalid-argument', 'Unsupported REVEX Google Render request.');
  const projectId = assertProjectId(data.projectId, 'projectId');
  const jobId = assertProjectId(data.jobId, 'jobId');
  if (!jobId.startsWith('render_')) throw new HttpsError('invalid-argument', 'jobId is not a controlled REVEX Render identity.');
  const sourceRevision = String(data.sourceRevision || '').trim();
  if (sourceRevision && !PROJECT_ID_RE.test(sourceRevision))
    throw new HttpsError('invalid-argument', 'sourceRevision is invalid.');
  const prompt = String(data.prompt || '').trim();
  if (!prompt || utf8Bytes(prompt) > GOOGLE_RENDER_MAX_PROMPT_BYTES)
    throw new HttpsError('invalid-argument', 'The refined Render prompt is empty or exceeds 24 KiB.');
  const resolution = String(data.resolution || '').trim().toUpperCase();
  if (!GOOGLE_RENDER_RESOLUTIONS.has(resolution))
    throw new HttpsError('invalid-argument', 'Render resolution must be 1K, 2K or 4K.');

  const access = await assertProjectAccess(projectId, uid, request.auth.token || {});
  renderLog('ACCESS_VERIFIED', { correlationId, projectId, jobId, accessRole: access.accessRole });
  const source = decodeViewportDataUrl(data.imageDataUrl);
  const refs = await acceptGoogleRenderJob(projectId, jobId, uid, sourceRevision, correlationId);
  let stage = 'ACCEPTED';
  try {
    const bucketName = configuredStorageBucket();
    const quotaProject = configuredProjectId();
    if (!bucketName) throw new HttpsError('failed-precondition', 'The Render broker Storage bucket is not configured.');
    if (!quotaProject) throw new HttpsError('failed-precondition', 'The Render broker Google Cloud quota project is not configured.');
    const bucket = getStorage().bucket(bucketName);
    const prefix = `projects/${projectId}/revex/renders/${jobId}`;
    const sourcePath = `${prefix}/source.${source.extension}`;
    const sourceSha256 = createHash('sha256').update(source.buffer).digest('hex');

    stage = 'UPLOADING_SOURCE';
    await updateGoogleRenderJob(refs, { status: 'RUNNING', stage, resolution });
    await savePrivateRenderObject(bucket, sourcePath, source, {
      projectId, jobId, requestedBy: uid, kind: 'render-source', sha256: sourceSha256,
      sourceCandidate: SOURCE_CANDIDATE
    });

    stage = 'GENERATING';
    await updateGoogleRenderJob(refs, { status: 'RUNNING', stage });
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const authClient = await auth.getClient();
    const providerResponse = await authClient.request({
      url: `https://generativelanguage.googleapis.com/v1/models/${GOOGLE_RENDER_MODEL}:generateContent`,
      method: 'POST',
      timeout: 510000,
      maxContentLength: GOOGLE_RENDER_MAX_PROVIDER_RESPONSE_BYTES,
      maxBodyLength: GOOGLE_RENDER_MAX_PROVIDER_RESPONSE_BYTES,
      headers: {
        'x-goog-user-project': quotaProject,
        'Content-Type': 'application/json'
      },
      data: {
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inline_data: { mime_type: source.mimeType, data: source.buffer.toString('base64') } }
        ] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          responseFormat: { image: { aspectRatio: '16:9', imageSize: resolution } }
        }
      }
    });
    const response = providerResponse?.data || {};
    if (utf8Bytes(JSON.stringify(response)) > GOOGLE_RENDER_MAX_PROVIDER_RESPONSE_BYTES)
      throw new Error('Google Render response exceeded the 48 MiB broker boundary.');
    let imagePart = null;
    const responseText = [];
    for (const candidate of Array.isArray(response.candidates) ? response.candidates : []) {
      for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
        if (part?.text) responseText.push(String(part.text));
        const inline = part?.inlineData || part?.inline_data;
        if (!imagePart && inline?.data) imagePart = inline;
      }
    }
    if (!imagePart) throw new Error('Gemini returned no generated image. Start a new Render with a refined instruction.');
    const result = decodeBoundedBase64Image(
      imagePart.mimeType || imagePart.mime_type || 'image/png',
      imagePart.data,
      GOOGLE_RENDER_MAX_RESULT_BYTES,
      'The generated Render result'
    );
    const text = boundedUtf8(responseText.join('\n').trim(), GOOGLE_RENDER_MAX_TEXT_BYTES);
    const usage = sanitizedUsage(response.usageMetadata);
    const resultPath = `${prefix}/result.${result.extension}`;
    const resultSha256 = createHash('sha256').update(result.buffer).digest('hex');

    stage = 'UPLOADING_RESULT';
    await updateGoogleRenderJob(refs, { status: 'RUNNING', stage });
    await savePrivateRenderObject(bucket, resultPath, result, {
      projectId, jobId, requestedBy: uid, kind: 'render-result', sha256: resultSha256,
      model: GOOGLE_RENDER_MODEL, resolution, sourceCandidate: SOURCE_CANDIDATE
    });

    stage = 'COMPLETE';
    await updateGoogleRenderJob(refs, {
      status: 'COMPLETE', stage, resultPath, resultMimeType: result.mimeType,
      resultBytes: result.buffer.length, resultSha256, sourceBytes: source.buffer.length,
      sourceSha256, usage, model: GOOGLE_RENDER_MODEL, resolution,
      completedAt: FieldValue.serverTimestamp(), error: FieldValue.delete()
    });
    renderLog('COMPLETE', {
      correlationId, projectId, jobId, model: GOOGLE_RENDER_MODEL, resolution,
      sourceBytes: source.buffer.length, resultBytes: result.buffer.length
    });
    return {
      ok: true,
      status: 'COMPLETE',
      projectId,
      jobId,
      resultPath,
      resultMimeType: result.mimeType,
      model: GOOGLE_RENDER_MODEL,
      resolution,
      usage,
      text
    };
  } catch (error) {
    const failure = renderFailure(error, stage);
    renderLog('FAILED', { correlationId, projectId, jobId, ...failure });
    await updateGoogleRenderJob(refs, {
      status: 'FAILED', stage: failure.stage,
      error: { code: failure.code, message: failure.message, providerStatus: failure.providerStatus },
      failedAt: FieldValue.serverTimestamp()
    }).catch((statusError) => renderLog('STATUS_WRITE_FAILED', {
      correlationId, projectId, jobId, message: boundedUtf8(statusError?.message || statusError, 600)
    }));
    if (error instanceof HttpsError) throw error;
    throw new HttpsError(failure.code, `REVEX Google Render failed at ${failure.stage}: ${failure.message}`, {
      correlationId, projectId, jobId, stage: failure.stage, providerStatus: failure.providerStatus
    });
  }
});
