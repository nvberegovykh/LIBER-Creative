'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onInit } = require('firebase-functions/v2/core');
const { setGlobalOptions } = require('firebase-functions/v2');
const { projectAccessRole } = require('./project-access');

setGlobalOptions({ region: 'us-central1', maxInstances: 4 });

// Firebase discovers exported functions by loading this module during deploy. Keep
// expensive Admin/Google client modules out of global discovery and initialize them
// only in the deployed runtime. This follows Firebase's onInit deployment-timeout
// guidance and makes broker discovery deterministic on slower Windows/CI hosts.
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
const RENDER_BROKER_SERVICE_ACCOUNT = process.env.REVEX_RENDER_BROKER_SERVICE_ACCOUNT || 'revex-render-broker@liber-apps-cca20.iam.gserviceaccount.com';
const RENDER_WORKER_URL = String(process.env.REVEX_RENDER_WORKER_URL || '').replace(/\/+$/, '');
const SOURCE_MAX_BYTES = 24 * 1024 * 1024;
const BUILD = '20260816r64-render-broker2';

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
  if (!jobSnap.exists) throw new HttpsError('failed-precondition', 'Create the REVEX render job before dispatching it.');
  const existing = jobSnap.data() || {};
  if (existing.createdBy && String(existing.createdBy) !== uid && accessRole !== 'owner' && accessRole !== 'liber-admin')
    throw new HttpsError('permission-denied', 'This render job belongs to another project member.');
  if (!RENDER_WORKER_URL)
    throw new HttpsError('failed-precondition', 'The private REVEX GPU renderer has not been deployed yet.');

  const source = decodeImageDataUrl(body.sourceImageDataUrl);
  const bucket = runtime.storage.bucket();
  const base = `projects/${projectId}/revex/renders/${jobId}`;
  const sourcePath = `${base}/source.${source.contentType.endsWith('jpeg') ? 'jpg' : source.contentType.split('/')[1]}`;
  const resultPath = `${base}/result.jpg`;
  const sourceFile = bucket.file(sourcePath);

  await setJob(projectId, jobId, {
    status: 'UPLOADING_SOURCE',
    stage: 'broker',
    correlationId,
    requestedBy: uid,
    accessRole,
    provider: 'revex-selfhosted',
    model: 'Qwen/Qwen-Image-Edit-2511',
    modelRevision: '6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9'
  });
  await sourceFile.save(source.bytes, {
    resumable: false,
    contentType: source.contentType,
    metadata: {
      cacheControl: 'private,max-age=31536000,immutable',
      metadata: { revexJobId: jobId, revexSource: 'clean-bim-viewport' }
    }
  });
  await setJob(projectId, jobId, { status: 'DISPATCHED', stage: 'worker', sourcePath });

  try {
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
        bucket: bucket.name,
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
    const result = response.data || {};
    if (result.schema !== 'liber.revex.render-worker-response.v1' || result.ok !== true ||
        String(result.projectId || '') !== projectId || String(result.jobId || '') !== jobId)
      throw new Error('Private REVEX render worker returned an incompatible response.');
    await setJob(projectId, jobId, {
      status: 'COMPLETE',
      stage: 'complete',
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
    const detail = typeof error?.response?.data === 'string'
      ? error.response.data
      : (error?.response?.data?.error || error?.message || String(error));
    const message = String(detail || 'Private REVEX render worker failed.').slice(0, 3000);
    await setJob(projectId, jobId, { status: 'FAILED', stage: 'failed', error: message });
    throw new HttpsError('internal', message, { correlationId, projectId, jobId });
  }
});
