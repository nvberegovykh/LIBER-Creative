'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { GoogleAuth } = require('google-auth-library');
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

async function assertProjectAccess(projectId, uid) {
  const [snap, userSnap] = await Promise.all([
    db.doc(`projects/${projectId}`).get(),
    db.doc(`users/${uid}`).get()
  ]);
  if (!snap.exists) throw new HttpsError('not-found', 'REVEX project not found.');
  const data = snap.data() || {};
  const accessRole = projectAccessRole(data, userSnap.exists ? userSnap.data() || {} : {}, uid);
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

function workerErrorDetail(error) {
  const status = Number(error?.response?.status || error?.code || 0) || null;
  const body = error?.response?.data;
  const workerMessage = typeof body === 'string'
    ? body
    : String(body?.error || body?.message || error?.message || error || 'Unknown managed-worker error');
  return {
    stage: 'WORKER_REQUEST',
    status,
    message: workerMessage.slice(0, 4000),
    worker: 'revex-energy-worker-r49'
  };
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
  const uid = String(request.auth.uid);
  const access = await assertProjectAccess(projectId, uid);
  const project = access.project;
  brokerLog('ACCESS_VERIFIED', { correlationId, projectId, sourceRevision, accessRole: access.accessRole });

  const existing = await libraryDoc(projectId, ENERGY_CURRENT_ID).get();
  if (existing.exists) {
    const state = existing.data() || {};
    if (String(state?.manifest?.sourceEngineeringRevision || '') === sourceRevision &&
        String(state?.manifest?.pipelineVersion || '') === '0.8.19-r49' &&
        String(state?.manifest?.status || '').toUpperCase() === 'COMPLETE') {
      return { ok: true, reused: true, status: 'COMPLETE', sourceRevision, resultRevision: state.revision || state?.manifest?.resultRevision || '' };
    }
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

  const workerUrl = String(process.env.REVEX_ENERGY_WORKER_URL || '').replace(/\/+$/, '');
  if (!workerUrl) throw new HttpsError('internal', 'REVEX_ENERGY_WORKER_URL is not configured.');
  const bucketName = getStorage().bucket().name;
  const outputPrefix = `projects/${projectId}/revex/energy/server-results/${sourceRevision}`;
  const jobRef = db.doc(`projects/${projectId}/revexEnergyJobs/${sourceRevision}`);
  await jobRef.set({
    schema: 'liber.revex.energy-job.v1', projectId, sourceRevision, status: 'RUNNING',
    startedAt: FieldValue.serverTimestamp(), requestedBy: uid,
    worker: 'managed-openstudio-3.10', clientBuild: String(data.clientBuild || ''),
    correlationId, stage: 'WORKER_REQUEST',
    comcheckConsent: {
      schema: comcheckConsent.schema, service: comcheckConsent.service, endpoint: comcheckConsent.endpoint,
      scope: comcheckConsent.scope, approvedAt: comcheckConsent.approvedAt, approvedByUid: uid
    }
  }, { merge: true });

  try {
    brokerLog('WORKER_REQUEST_STARTED', { correlationId, projectId, sourceRevision, workerUrl });
    const googleAuth = new GoogleAuth();
    const client = await googleAuth.getIdTokenClient(workerUrl);
    const response = await client.request({
      url: `${workerUrl}/run`, method: 'POST', timeout: 3550000,
      data: {
        schema: 'liber.revex.energy-server-request.v1', projectId, sourceRevision,
        projectName: String(project.name || manifest?.sourceModel?.title || projectId),
        bucket: bucketName, outputPrefix,
        artifacts: artifacts.map((row) => ({ name: String(row.name || ''), path: String(row.path || ''), bytes: Number(row.bytes || 0), sha256: String(row.sha256 || '') })),
        projectSource: { name: String(project.name || ''), code: String(project.code || ''), filingPath: 'NYCECC_APPENDIX_CA_PRM' },
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
    if (resultManifest.schema !== 'liber.revex.energy-result.v1' ||
        String(resultManifest.pipelineVersion || '') !== '0.8.19-r49' ||
        resultManifest.revitWriteBack !== false || resultManifest.pdfInsertion !== false)
      throw new Error('Managed worker returned an invalid Energy authority boundary.');
    if (String(resultManifest.status || '').toUpperCase() === 'COMPLETE') {
      const resultArtifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
      const names = new Set(resultArtifacts.map((row) => String(row.name || '')));
      const required = [
        'BASELINE_UPDATED_GEOMETRY.osm',
        'PROPOSED_UPDATED_GEOMETRY.osm',
        'EN-1_READY_TO_INSERT.pdf',
        'COMcheck_PROJECT_INPUT_READY.cxl',
        'COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf',
        'COMcheck_BACKSTOP_RESULT.json'
      ];
      const missing = required.filter((name) => !names.has(name));
      const compiledOsmCount = resultArtifacts.filter((row) => row.kind === 'compiled-model' && /\.osm$/i.test(String(row.name || ''))).length;
      const corrupt = resultArtifacts.filter((row) => Number(row?.bytes || 0) <= 0 ||
        !/^[a-f0-9]{64}$/i.test(String(row?.sha256 || '')) || !String(row?.path || '').startsWith(`${outputPrefix}/artifacts/`));
      if (missing.length || corrupt.length || compiledOsmCount !== 2 || resultManifest?.comcheck?.officialDoeReport !== true) {
        throw new Error(`Managed worker violated the r49 completion contract: missing=${missing.join(',') || 'none'}; corrupt=${corrupt.map((row) => row?.name || '?').join(',') || 'none'}; compiledOsmCount=${compiledOsmCount}; officialBackstop=${resultManifest?.comcheck?.officialDoeReport === true}`);
      }
    }

    const resultRevision = assertProjectId(body.resultRevision || resultManifest.resultRevision || `energy_${Date.now()}`, 'resultRevision');
    const resultState = {
      schema: 'liber.revex.energy-state.v1', projectId, revision: resultRevision,
      sourceEngineeringRevision: sourceRevision, publishedAt: new Date().toISOString(),
      manifest: resultManifest, artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
      manifestUrl: body.manifestUrl || null, manifestPath: body.manifestPath || null,
      cloud: true, execution: 'managed-server', worker: 'OpenStudio-3.10/EnergyPlus + official COMcheck Backstop', requestedBy: uid
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
    batch.set(jobRef, {
      status: String(resultManifest.status || body.status || 'UNKNOWN').toUpperCase(), resultRevision,
      finishedAt: FieldValue.serverTimestamp(), error: resultManifest.error || body.error || null,
      stage: 'COMPLETE', correlationId
    }, { merge: true });
    await batch.commit();
    brokerLog('RESULT_PUBLISHED', { correlationId, projectId, sourceRevision, resultRevision, status: resultManifest.status || body.status || 'UNKNOWN' });
    return { ok: true, status: resultManifest.status || body.status || 'UNKNOWN', sourceRevision, resultRevision, error: resultManifest.error || body.error || null };
  } catch (error) {
    const detail = workerErrorDetail(error);
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
