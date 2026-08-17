'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onInit } = require('firebase-functions/v2/core');
const { setGlobalOptions } = require('firebase-functions/v2');
const { projectAccessRole } = require('./project-access');

setGlobalOptions({ region: 'us-central1', maxInstances: 4 });

let db = null;
let FieldValue = null;
let storage = null;
let GoogleAuth = null;

onInit(() => {
  const { getApps, initializeApp } = require('firebase-admin/app');
  if (!getApps().length) initializeApp();
  const firestore = require('firebase-admin/firestore');
  const storageApi = require('firebase-admin/storage');
  db = firestore.getFirestore();
  FieldValue = firestore.FieldValue;
  storage = storageApi.getStorage();
  GoogleAuth = require('google-auth-library').GoogleAuth;
});

const PROJECT_RE = /^[A-Za-z0-9._-]{1,160}$/;
const JOB_RE = /^[A-Za-z0-9_-]{1,160}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/i;
const RENDER_BROKER_SERVICE_ACCOUNT = process.env.REVEX_RENDER_BROKER_SERVICE_ACCOUNT || 'revex-render-broker@liber-apps-cca20.iam.gserviceaccount.com';
const RENDER_WORKER_URL = String(process.env.REVEX_RENDER_WORKER_URL || '').replace(/\/+$/, '');
const STORAGE_BUCKET = String(process.env.REVEX_STORAGE_BUCKET || '').replace(/^gs:\/\//i, '').replace(/\/$/, '').trim();
const SOURCE_MAX_BYTES = 24 * 1024 * 1024;
const BUILD = '20260817r113-render-broker1';

function runtimeServices() {
  if (!db || !FieldValue || !storage || !GoogleAuth) {
    throw new HttpsError('unavailable', 'REVEX render broker runtime initialization is not complete. Retry the render request.');
  }
  return { db, FieldValue, storage, GoogleAuth };
}

function safeId(value, regex, label) {
  const text = String(value || '').trim();
  if (!regex.test(text)) throw new HttpsError('invalid-argument', `${label} is invalid.`);
  return text;
}

function decodeImageDataUrl(value) {
  const text = String(value || '');
  const match = text.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new HttpsError('invalid-argument', 'The REVEX viewport snapshot is not a supported image data URL.');
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!bytes.length || bytes.length > SOURCE_MAX_BYTES)
    throw new HttpsError('invalid-argument', 'The REVEX viewport snapshot is empty or exceeds the 24 MiB render-input limit.');
  return { bytes, contentType: match[1].toLowerCase() };
}

async function assertProjectAccess(projectId, uid) {
  const { db } = runtimeServices();
  const [projectSnap, userSnap] = await Promise.all([
    db.doc(`projects/${projectId}`).get(),
    db.doc(`users/${uid}`).get()
  ]);
  if (!projectSnap.exists) throw new HttpsError('not-found', 'REVEX project not found.');
  const role = projectAccessRole(projectSnap.data() || {}, userSnap.exists ? userSnap.data() || {} : {}, uid);
  if (!role) throw new HttpsError('permission-denied', 'You do not have access to this REVEX project.');
  return role;
}

async function setJob(projectId, jobId, patch) {
  const { db, FieldValue } = runtimeServices();
  await db.doc(`projects/${projectId}/revexRenders/${jobId}`).set({
    ...patch,
    brokerBuild: BUILD,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

function renderErrorDetail(error, stage) {
  const body = error?.response?.data;
  const detail = typeof body === 'string' ? body : (body?.error || body?.message || error?.message || String(error));
  return {
    stage,
    status: Number(error?.response?.status || 0) || null,
    message: String(detail || 'Private REVEX render failed.').slice(0, 3000)
  };
}

exports.runRevexRender = onCall({
  timeoutSeconds: 3600,
  memory: '1GiB',
  concurrency: 4,
  serviceAccount: RENDER_BROKER_SERVICE_ACCOUNT
}, async (request) => {
  const runtime = runtimeServices();
  const correlationId = `render-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in to REVEX before rendering.');
  const body = request.data || {};
  if (body.schema !== 'liber.revex.render-broker-request.v1')
    throw new HttpsError('invalid-argument', 'Unsupported REVEX render request.');

  const projectId = safeId(body.projectId, PROJECT_RE, 'projectId');
  const jobId = safeId(body.jobId, JOB_RE, 'jobId');
  const uid = String(request.auth.uid);
  const accessRole = await assertProjectAccess(projectId, uid);
  const jobRef = runtime.db.doc(`projects/${projectId}/revexRenders/${jobId}`);
  const jobSnap = await jobRef.get();
  let existing = jobSnap.exists ? (jobSnap.data() || {}) : null;

  if (!existing) {
    existing = {
      createdBy: uid,
      provider: 'revex-selfhosted',
      model: 'Qwen/Qwen-Image-Edit-2511',
      status: 'queued',
      brokerCreated: true
    };
    await jobRef.set({
      ...existing,
      createdAt: runtime.FieldValue.serverTimestamp(),
      updatedAt: runtime.FieldValue.serverTimestamp(),
      brokerBuild: BUILD
    }, { merge: true });
  }

  if (existing.createdBy && String(existing.createdBy) !== uid && accessRole !== 'owner' && accessRole !== 'liber-admin')
    throw new HttpsError('permission-denied', 'This render job belongs to another project member.');

  await setJob(projectId, jobId, {
    status: 'RUNNING',
    stage: 'BROKER_PREPARE',
    correlationId,
    requestedBy: uid,
    accessRole,
    provider: 'revex-selfhosted',
    model: 'Qwen/Qwen-Image-Edit-2511',
    modelRevision: '6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9'
  });

  let failureStage = 'BROKER_PREPARE';
  try {
    if (!RENDER_WORKER_URL) throw new Error('REVEX_RENDER_WORKER_URL is not configured.');
    if (!BUCKET_RE.test(STORAGE_BUCKET)) throw new Error('REVEX_STORAGE_BUCKET is not configured with a valid Firebase Storage bucket.');

    const source = decodeImageDataUrl(body.sourceImageDataUrl);
    const bucket = runtime.storage.bucket(STORAGE_BUCKET);
    const base = `projects/${projectId}/revex/renders/${jobId}`;
    const sourcePath = `${base}/source.${source.contentType.endsWith('jpeg') ? 'jpg' : source.contentType.split('/')[1]}`;
    const resultPath = `${base}/result.jpg`;
    const sourceFile = bucket.file(sourcePath);

    failureStage = 'UPLOAD_SOURCE';
    await setJob(projectId, jobId, { status: 'UPLOADING_SOURCE', stage: failureStage, storageBucket: STORAGE_BUCKET });
    await sourceFile.save(source.bytes, {
      resumable: false,
      contentType: source.contentType,
      metadata: {
        cacheControl: 'private,max-age=31536000,immutable',
        metadata: { revexJobId: jobId, revexSource: 'clean-bim-viewport' }
      }
    });

    failureStage = 'WORKER_REQUEST';
    await setJob(projectId, jobId, { status: 'DISPATCHED', stage: failureStage, sourcePath, workerUrl: RENDER_WORKER_URL });
    const auth = new runtime.GoogleAuth();
    const client = await auth.getIdTokenClient(RENDER_WORKER_URL);
    const response = await client.request({
      url: `${RENDER_WORKER_URL}/run`,
      method: 'POST',
      timeout: 3550000,
      data: {
        schema: 'liber.revex.render-worker-request.v1',
        projectId,
        jobId,
        bucket: STORAGE_BUCKET,
        sourcePath,
        resultPath,
        prompt: String(body.prompt || '').slice(0, 12000),
        seed: Number.isFinite(Number(body.seed)) ? Number(body.seed) : 0,
        settings: {
          resolution: ['1K', '2K', '4K'].includes(String(body?.settings?.resolution || '').toUpperCase())
            ? String(body.settings.resolution).toUpperCase() : '1K',
          preserveGeometry: true,
          sourceRevision: String(body?.settings?.sourceRevision || '').slice(0, 200)
        }
      }
    });

    failureStage = 'WORKER_RESPONSE';
    const result = response.data || {};
    if (result.schema !== 'liber.revex.render-worker-response.v1' || result.ok !== true ||
        String(result.projectId || '') !== projectId || String(result.jobId || '') !== jobId)
      throw new Error('Private REVEX render worker returned an incompatible response.');

    await setJob(projectId, jobId, {
      status: 'COMPLETE',
      stage: 'COMPLETE',
      resultUrl: result.resultUrl || null,
      resultPath: result.resultPath || resultPath,
      resultBytes: Number(result.resultBytes || 0),
      resultWidth: Number(result.width || 0),
      resultHeight: Number(result.height || 0),
      inferenceSeconds: Number(result.inferenceSeconds || 0),
      completedAt: runtime.FieldValue.serverTimestamp()
    });
    return {
      ok: true,
      schema: 'liber.revex.render-broker-response.v1',
      projectId,
      jobId,
      provider: 'revex-selfhosted',
      model: result.model,
      modelRevision: result.modelRevision,
      resultUrl: result.resultUrl,
      resultPath: result.resultPath,
      width: result.width,
      height: result.height,
      inferenceSeconds: result.inferenceSeconds
    };
  } catch (error) {
    const detail = renderErrorDetail(error, failureStage);
    console.error('[REVEX RENDER BROKER]', JSON.stringify({ correlationId, projectId, jobId, ...detail }), error);
    await setJob(projectId, jobId, {
      status: 'FAILED', stage: detail.stage, error: detail.message,
      workerHttpStatus: detail.status, correlationId
    }).catch(() => {});
    const code = error instanceof HttpsError && error.code ? error.code : 'internal';
    throw new HttpsError(code, `REVEX render failed at ${detail.stage}: ${detail.message}`, {
      correlationId, projectId, jobId, ...detail
    });
  }
});
