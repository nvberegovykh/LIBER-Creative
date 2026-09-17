#!/usr/bin/env node
'use strict';

// Source-bound, dry-run-by-default cleanup for legacy server-minted Firebase
// download tokens. It never deletes an object or rewrites Firestore records.
// Existing path fields (and the Daily Report client's authenticated legacy-path
// derivation) remain the compatibility boundary after a token is revoked.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SOURCE_RE = /^[a-f0-9]{40}$/;
const TOKEN_METADATA_KEY = 'firebaseStorageDownloadTokens';
const TARGETS = [
  { kind: 'energy-server-results', pattern: /^projects\/[^/]+\/revex\/energy\/server-results\// },
  { kind: 'daily-reports', pattern: /^projects\/[^/]+\/revex\/daily-reports\// }
];

function parseArgs(argv) {
  const options = { apply: false, confirmRevoke: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') { options.apply = true; continue; }
    if (arg === '--confirm-revoke') { options.confirmRevoke = true; continue; }
    if (arg === '--project' || arg === '--bucket' || arg === '--source') {
      const value = String(argv[index + 1] || '').trim();
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function exactBucket(projectId, value) {
  const bucket = String(value || '').trim().replace(/^gs:\/\//, '').replace(/\/$/, '');
  const allowed = new Set([`${projectId}.appspot.com`, `${projectId}.firebasestorage.app`]);
  if (!allowed.has(bucket)) throw new Error('The selected bucket is not an exact Firebase bucket for --project.');
  return bucket;
}

function currentSource() {
  const root = path.resolve(__dirname, '../..');
  return String(execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  })).trim().toLowerCase();
}

function targetKind(objectName) {
  const match = TARGETS.find((target) => target.pattern.test(objectName));
  return match ? match.kind : '';
}

async function assertCredentialProject(projectId) {
  const { GoogleAuth } = require('google-auth-library');
  const credentialProject = String(await new GoogleAuth().getProjectId() || '').trim();
  if (!credentialProject) throw new Error('Application Default Credentials do not expose a project binding.');
  if (credentialProject !== projectId) throw new Error('Application Default Credentials are bound to a different project.');
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const projectId = String(options.project || '').trim();
  const sourceCandidate = String(options.source || '').trim().toLowerCase();
  if (!PROJECT_RE.test(projectId)) throw new Error('--project is missing or invalid.');
  if (!SOURCE_RE.test(sourceCandidate)) throw new Error('--source must be the exact 40-character release commit SHA.');
  if (sourceCandidate !== currentSource()) throw new Error('--source does not match the checked-out release source.');
  if (options.apply && !options.confirmRevoke)
    throw new Error('--apply requires the separate --confirm-revoke safety acknowledgement.');
  if (!options.apply && options.confirmRevoke)
    throw new Error('--confirm-revoke is valid only together with --apply.');

  const bucketName = exactBucket(projectId, options.bucket);
  await assertCredentialProject(projectId);
  const { applicationDefault, initializeApp } = require('firebase-admin/app');
  const { getStorage } = require('firebase-admin/storage');
  const app = initializeApp({
    credential: applicationDefault(), projectId, storageBucket: bucketName
  }, `revex-token-revocation-${process.pid}`);
  const bucket = getStorage(app).bucket(bucketName);
  const counts = {
    scannedTargetObjects: 0,
    legacyTokenObjects: 0,
    changedObjects: 0,
    byKind: Object.fromEntries(TARGETS.map((target) => [target.kind, 0]))
  };

  let pageToken = '';
  do {
    const query = { prefix: 'projects/', autoPaginate: false, maxResults: 1000 };
    if (pageToken) query.pageToken = pageToken;
    const [files, nextQuery] = await bucket.getFiles(query);
    for (const file of files) {
      const kind = targetKind(String(file.name || ''));
      if (!kind) continue;
      counts.scannedTargetObjects += 1;
      const [metadata] = await file.getMetadata();
      const customMetadata = { ...(metadata.metadata || {}) };
      if (!String(customMetadata[TOKEN_METADATA_KEY] || '').trim()) continue;
      counts.legacyTokenObjects += 1;
      counts.byKind[kind] += 1;
      if (!options.apply) continue;

      const metageneration = Number(metadata.metageneration);
      if (!Number.isSafeInteger(metageneration) || metageneration < 1)
        throw new Error('A target object has no usable metageneration precondition. No unsafe update was attempted.');
      delete customMetadata[TOKEN_METADATA_KEY];
      customMetadata.revexAccess = 'firebase-authenticated-path-only';
      customMetadata.revexDownloadTokenRevokedBySource = sourceCandidate;
      await file.setMetadata({
        cacheControl: 'private, max-age=0, no-store',
        metadata: customMetadata
      }, { ifMetagenerationMatch: metageneration });
      counts.changedObjects += 1;
    }
    pageToken = String(nextQuery?.pageToken || '');
  } while (pageToken);

  console.log(JSON.stringify({
    REVEX_LEGACY_DOWNLOAD_TOKEN_REVOCATION: options.apply ? 'APPLIED' : 'DRY_RUN',
    projectId,
    bucket: bucketName,
    sourceCandidate,
    ...counts,
    objectsDeleted: 0,
    firestoreRecordsChanged: 0
  }));
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`REVEX legacy download-token revocation failed: ${String(error?.message || error)}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, exactBucket, targetKind };
