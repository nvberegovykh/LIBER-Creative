#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where
} = require('firebase/firestore');

const projectId = process.env.REVEX_RULES_TEST_PROJECT || 'demo-revex-r49';

function projectPath(id, ...tail) {
  return ['projects', id, ...tail];
}

async function verifyProjectLane(db, project, lane, identity) {
  const ref = doc(db, ...projectPath(project, lane, identity));
  await assertSucceeds(setDoc(ref, { schema: `liber.revex.${lane}.qa.v1`, hidden: false }));
  await assertSucceeds(getDoc(ref));
  await assertSucceeds(updateDoc(ref, { hidden: true }));
  await assertSucceeds(deleteDoc(ref));
}

async function verifyAppendOnlyLane(db, project, lane, identity) {
  const ref = doc(db, ...projectPath(project, lane, identity));
  await assertSucceeds(setDoc(ref, { schema: `liber.revex.${lane}.qa.v1`, hidden: false }));
  await assertSucceeds(getDoc(ref));
  await assertFails(updateDoc(ref, { hidden: true }));
  await assertFails(deleteDoc(ref));
}

(async () => {
  let env;
  try {
    env = await initializeTestEnvironment({ projectId });
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'users', 'admin'), { role: 'admin' });
      await setDoc(doc(db, 'users', 'owner'), { role: 'user' });
      await setDoc(doc(db, 'users', 'member'), { role: 'user' });
      await setDoc(doc(db, 'users', 'outsider'), { role: 'user' });
      await setDoc(doc(db, 'users', 'self-promoted'), { role: 'admin' });
      await setDoc(doc(db, 'projects', 'alpha'), {
        name: 'Alpha', ownerId: 'owner', memberIds: ['owner', 'member'], status: 'Active'
      });
      await setDoc(doc(db, 'projects', 'alpha', 'library', 'revex_engineering'), {
        schema: 'liber.revex.engineering-sync.v1', revision: 'eng_alpha'
      });
      await setDoc(doc(db, 'projects', 'alpha', 'revexEnergyJobs', 'server_job'), {
        schema: 'liber.revex.energy-job.v1', status: 'RUNNING'
      });
      await setDoc(doc(db, 'projects', 'alpha', 'revexRenderJobs', 'server_render'), {
        schema: 'liber.revex.render-job.v1', status: 'RUNNING', leaseOwner: 'server'
      });
      await setDoc(doc(db, 'projects', 'beta'), {
        name: 'Beta', ownerId: 'other_owner', memberIds: ['other_owner'], status: 'Active'
      });
      await setDoc(doc(db, 'projects', 'beta', 'library', 'private'), { secret: true });
      await setDoc(doc(db, 'specProjects', 'spec_alpha'), {
        name: 'Alpha Spec Book', ownerId: 'owner', memberIds: ['owner'], linkedProjectId: 'alpha'
      });
      await setDoc(doc(db, 'specProjects', 'spec_alpha', 'sources', 'revex-revit'), {
        revision: 'bim_alpha', payloadEncoding: 'revex-storage-index-v1'
      });
      await setDoc(doc(db, 'chatConnections', 'owner_member'), {
        participants: ['owner', 'member'], admins: ['owner'], type: 'direct'
      });
      await setDoc(doc(db, 'chatConnections', 'project_alpha'), {
        schema: 'liber.revex.project-chat.v1', source: 'revex-project-chat',
        projectId: 'alpha', participants: ['owner', 'member'], memberIds: ['owner', 'member'],
        admins: ['owner'], type: 'project', keyRotationRequired: true
      });
      await setDoc(doc(db, 'chatMessages', 'owner_member', 'messages', 'seed'), {
        sender: 'owner', connId: 'owner_member', cipher: { iv: '00', data: '00' }
      });
      await setDoc(doc(db, 'chatMessages', 'project_alpha', 'messages', 'member_seed'), {
        sender: 'member', connId: 'project_alpha', cipher: { iv: '00', data: '00' }
      });
      await setDoc(doc(db, 'serverSecureState', 'owner', 'pushTokens', 'seed'), { token: 'server-only' });
      await setDoc(doc(db, 'secureChatIdentityRecoveryAudit', 'seed'), { uid: 'owner' });
    });

    const owner = env.authenticatedContext('owner').firestore();
    const member = env.authenticatedContext('member').firestore();
    const admin = env.authenticatedContext('admin', { revexAdmin: true }).firestore();
    const selfPromoted = env.authenticatedContext('self-promoted').firestore();
    const outsider = env.authenticatedContext('outsider').firestore();
    const anonymous = env.unauthenticatedContext().firestore();

    // Project Chat bindings and canonical candidate rooms are Admin-SDK owned.
    // A browser-created project must not smuggle an existing Secure Chat id into
    // the resolver, including when the browser identity has a platform admin role.
    await assertSucceeds(setDoc(doc(owner, 'projects', 'owner_clean_create'), {
      name: 'Owner clean create', ownerId: 'owner', memberIds: ['owner']
    }));
    for (const [client, label] of [[owner, 'owner'], [admin, 'admin']]) {
      for (const field of ['chatConnId', 'chatProjectSchema', 'chatSourceCandidate', 'chatUpdatedAt']) {
        await assertFails(setDoc(doc(client, 'projects', `forged_chat_binding_${label}_${field}`), {
          name: 'Forged chat binding', ownerId: 'owner', memberIds: ['owner'],
          [field]: field === 'chatConnId' ? 'victim_room' : 'attacker-controlled'
        }));
      }
    }
    const browserDirectRoom = doc(owner, 'chatConnections', 'owner_created_direct');
    await assertSucceeds(setDoc(browserDirectRoom, {
      participants: ['owner', 'member'], memberIds: ['owner', 'member'],
      admins: ['owner'], type: 'direct'
    }));
    await assertFails(setDoc(doc(owner, 'chatConnections', 'revex_project_beta'), {
      schema: 'liber.revex.project-chat.v1', source: 'revex-project-chat', projectId: 'beta',
      participants: ['owner'], memberIds: ['owner'], admins: ['owner'], type: 'project'
    }));
    await assertFails(updateDoc(browserDirectRoom, {
      schema: 'liber.revex.project-chat.v1', source: 'revex-project-chat', projectId: 'beta', type: 'project'
    }));

    for (const [label, db] of [['owner', owner], ['member', member], ['admin', admin]]) {
      await assertSucceeds(getDoc(doc(db, 'projects', 'alpha')));
      await assertSucceeds(getDoc(doc(db, 'projects', 'alpha', 'library', 'revex_engineering')));
      await assertSucceeds(getDocs(query(collection(db, 'projects'), where('memberIds', 'array-contains', label === 'admin' ? 'owner' : label))));
      await verifyProjectLane(db, 'alpha', 'library', `qa_${label}`);
      await verifyProjectLane(db, 'alpha', 'revexDesignItems', `qa_${label}`);
      await verifyProjectLane(db, 'alpha', 'revexIssues', `qa_${label}`);
      await verifyAppendOnlyLane(db, 'alpha', 'revexRevisions', `qa_${label}`);
      await verifyAppendOnlyLane(db, 'alpha', 'revexHistory', `qa_${label}`);
      const immutableLibrary = doc(db, 'projects', 'alpha', 'library', `revex_engineering_revision_qa_${label}`);
      await assertSucceeds(setDoc(immutableLibrary, { immutable: true, revision: `qa_${label}` }));
      await assertSucceeds(getDoc(immutableLibrary));
      await assertFails(updateDoc(immutableLibrary, { immutable: false }));
      await assertFails(deleteDoc(immutableLibrary));
      await assertSucceeds(getDoc(doc(db, 'projects', 'alpha', 'revexEnergyJobs', 'server_job')));
      await assertFails(setDoc(doc(db, 'projects', 'alpha', 'revexEnergyJobs', `forged_${label}`), { status: 'COMPLETE' }));
      await assertFails(updateDoc(doc(db, 'projects', 'alpha', 'revexEnergyJobs', 'server_job'), { status: 'COMPLETE' }));
      await assertSucceeds(getDoc(doc(db, 'projects', 'alpha', 'revexRenderJobs', 'server_render')));
      await assertFails(setDoc(doc(db, 'projects', 'alpha', 'revexRenderJobs', `forged_${label}`), { status: 'COMPLETE' }));
      await assertFails(updateDoc(doc(db, 'projects', 'alpha', 'revexRenderJobs', 'server_render'), { status: 'COMPLETE', leaseOwner: label }));
      await assertFails(deleteDoc(doc(db, 'projects', 'alpha', 'revexRenderJobs', 'server_render')));
      const renderId = `render_${label}_0123456789abcdef`;
      const controlledRender = doc(db, 'projects', 'alpha', 'revexRenders', renderId);
      await assertSucceeds(setDoc(controlledRender, {
        schema: 'liber.revex.google-render-job.v1', type: 'revex', hidden: true,
        revexKind: 'render', revexId: renderId, contextKind: 'view', contextLabel: 'QA viewport',
        elementId: null, designItemId: null, chapterId: null, revision: 'rev_alpha',
        renderLocation: null, sourceCamera: null, sourceRevision: 'rev_alpha',
        settings: { resolution: '1K', preserveGeometry: true },
        provider: 'google-gemini-server', model: 'gemini-3.1-flash-image', status: 'PREPARED',
        createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', createdBy: label
      }));
      await assertSucceeds(getDoc(controlledRender));
      await assertFails(updateDoc(controlledRender, { status: 'COMPLETE', resultPath: 'projects/alpha/revex/renders/forged/result.png' }));
      await assertFails(deleteDoc(controlledRender));
      await assertFails(setDoc(doc(db, 'projects', 'alpha', 'revexRenders', `render_forged_${label}_0123456789abcdef`), {
        schema: 'liber.revex.google-render-job.v1', type: 'revex', hidden: true,
        revexKind: 'render', revexId: `render_forged_${label}_0123456789abcdef`,
        provider: 'google-gemini-server', model: 'gemini-3.1-flash-image', status: 'PREPARED',
        sourceRevision: 'rev_alpha', createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z', createdBy: 'another-user', prompt: 'must not persist'
      }));
      await assertSucceeds(getDoc(doc(db, 'specProjects', 'spec_alpha')));
      await assertSucceeds(getDoc(doc(db, 'specProjects', 'spec_alpha', 'sources', 'revex-revit')));
      await assertSucceeds(setDoc(doc(db, 'specProjects', 'spec_alpha', 'items', `qa_${label}`), { finish: 'bronze' }));
      await assertSucceeds(deleteDoc(doc(db, 'specProjects', 'spec_alpha', 'items', `qa_${label}`)));
    }

    await assertSucceeds(updateDoc(doc(member, 'projects', 'alpha'), { status: 'Review' }));
    await assertFails(updateDoc(doc(member, 'projects', 'alpha'), { memberIds: ['member', 'outsider'] }));
    await assertFails(updateDoc(doc(member, 'projects', 'alpha'), { ownerId: 'member' }));
    await assertFails(updateDoc(doc(member, 'projects', 'alpha'), { chatConnId: 'attacker_room' }));
    await assertFails(updateDoc(doc(admin, 'projects', 'alpha'), { chatConnId: 'attacker_room' }));
    await assertFails(updateDoc(doc(member, 'specProjects', 'spec_alpha'), { linkedProjectId: 'beta' }));
    await assertSucceeds(updateDoc(doc(owner, 'projects', 'alpha'), { memberIds: ['owner', 'member'] }));
    await assertSucceeds(updateDoc(doc(admin, 'projects', 'alpha'), { memberIds: ['owner', 'member', 'new_member'] }));

    const consent = doc(member, 'projects', 'alpha', 'revexEnergyConsents', 'eng_alpha', 'approvers', 'member');
    await assertSucceeds(setDoc(consent, {
      schema: 'liber.revex.comcheck-consent.v1', approved: true,
      approvedByUid: 'member', projectId: 'alpha', sourceEngineeringRevision: 'eng_alpha',
      service: 'PNNL_COMCHECK_BACKSTOP', endpoint: 'https://legacy-comcheck.energycode.pnl.gov/CheckWeb/',
      scope: 'GENERATED_CURRENT_PROJECT_CXL_ONLY'
    }));
    await assertSucceeds(updateDoc(consent, {
      projectIdentityOverride: { city: 'Brooklyn', state: 'NY', zip: '11225' },
      projectIdentityOverrideAuthority: 'explicit-user-input-during-revision-scoped-comcheck-authorization'
    }));
    await assertFails(updateDoc(consent, { approved: false }));
    await assertFails(deleteDoc(consent));

    const ownerPublicKey = doc(owner, 'userPublicKeys', 'owner');
    await assertSucceeds(setDoc(ownerPublicKey, {
      uid: 'owner', publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      fingerprint: 'test-fingerprint', cryptoVersion: 'liber.secure-chat.identity-p256.v2',
      createdAt: '2026-08-20T00:00:00.000Z'
    }));
    await assertSucceeds(getDoc(doc(member, 'userPublicKeys', 'owner')));
    await assertFails(updateDoc(ownerPublicKey, { fingerprint: 'replacement' }));
    await assertFails(deleteDoc(ownerPublicKey));
    await assertFails(setDoc(doc(member, 'userPublicKeys', 'owner'), {
      uid: 'owner', publicJwk: {}, fingerprint: 'forged',
      cryptoVersion: 'liber.secure-chat.identity-p256.v2', createdAt: '2026-08-20T00:00:00.000Z'
    }));
    await assertFails(setDoc(doc(member, 'userPublicKeys', 'member'), {
      uid: 'member', publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      fingerprint: 'forged-lineage', cryptoVersion: 'liber.secure-chat.identity-p256.v2',
      createdAt: '2026-08-20T00:00:00.000Z', fingerprintLineage: ['attacker-controlled']
    }));
    for (const client of [owner, member, admin, outsider, anonymous]) {
      await assertFails(getDoc(doc(client, 'serverSecureState', 'owner', 'pushTokens', 'seed')));
      await assertFails(getDoc(doc(client, 'secureChatIdentityRecoveryAudit', 'seed')));
    }

    await assertSucceeds(getDoc(doc(owner, 'chatConnections', 'owner_member')));
    await assertSucceeds(getDoc(doc(member, 'chatMessages', 'owner_member', 'messages', 'seed')));
    await assertSucceeds(updateDoc(doc(owner, 'chatConnections', 'owner_member'), {
      groupKeyVersion: 'liber.secure-chat.group-key-envelopes.v1',
      groupKeyEpoch: 1,
      groupKeyParticipantDigest: 'digest',
      groupKeyIssuerUid: 'owner',
      groupKeyEnvelopes: { owner: { wrappedKey: { iv: '00', data: '00' } } },
      groupKeyHistory: { '1': { issuerUid: 'owner', envelopes: {} } },
      groupKeyRotatedAt: '2026-08-20T00:00:00.000Z',
      keyRotationRequired: false
    }));
    await assertFails(updateDoc(doc(member, 'chatConnections', 'owner_member'), { groupKeyEpoch: 2 }));
    await assertFails(updateDoc(doc(member, 'chatConnections', 'owner_member'), { keyRotationRequired: true }));
    await assertFails(getDoc(doc(admin, 'chatConnections', 'owner_member')));
    await assertFails(getDoc(doc(admin, 'chatMessages', 'owner_member', 'messages', 'seed')));
    await assertFails(getDoc(doc(outsider, 'chatConnections', 'owner_member')));
    await assertSucceeds(updateDoc(doc(owner, 'chatConnections', 'project_alpha'), {
      groupKeyVersion: 'liber.secure-chat.group-key-envelopes.v1',
      groupKeyEpoch: 'qa-epoch', groupKeyParticipantDigest: 'digest',
      groupKeyIssuerUid: 'owner', groupKeyEnvelopes: { owner: { wrappedKey: { iv: '00', data: '00' } } },
      groupKeyHistory: { 'qa-epoch': { issuerUid: 'owner', envelopes: {} } },
      groupKeyRotatedAt: '2026-08-20T00:00:00.000Z', keyRotationRequired: false
    }));
    await assertFails(updateDoc(doc(owner, 'chatConnections', 'project_alpha'), {
      participants: ['owner', 'member', 'outsider'], memberIds: ['owner', 'member', 'outsider']
    }));

    for (const denied of [outsider, anonymous]) {
      await assertFails(getDoc(doc(denied, 'projects', 'alpha')));
      await assertFails(getDoc(doc(denied, 'projects', 'alpha', 'library', 'revex_engineering')));
      await assertFails(setDoc(doc(denied, 'projects', 'alpha', 'revexIssues', 'forbidden'), { title: 'No' }));
      await assertFails(getDoc(doc(denied, 'specProjects', 'spec_alpha')));
      await assertFails(setDoc(doc(denied, 'specProjects', 'spec_alpha', 'sources', 'forbidden'), { revision: 'No' }));
    }
    await assertFails(getDoc(doc(member, 'projects', 'beta', 'library', 'private')));
    await assertFails(setDoc(doc(member, 'projects', 'beta', 'library', 'forbidden'), { secret: true }));
    // A writable users/{uid}.role in an unrelated preserved rules block cannot
    // become REVEX administrator authority. Only Firebase Auth custom claims do.
    await assertFails(getDoc(doc(selfPromoted, 'projects', 'alpha')));
    await assertFails(setDoc(doc(selfPromoted, 'projects', 'alpha', 'revexIssues', 'forbidden'), { title: 'No' }));
    await assertFails(updateDoc(doc(selfPromoted, 'users', 'self-promoted'), { role: 'admin' }));

    // Project Chat authorization follows the live project record, not the
    // denormalized connection arrays. Removal is immediate and does not delete
    // the room or its historical messages.
    await assertSucceeds(getDoc(doc(member, 'chatConnections', 'project_alpha')));
    await assertSucceeds(getDoc(doc(member, 'chatMessages', 'project_alpha', 'messages', 'member_seed')));
    await env.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), 'projects', 'alpha'), { memberIds: ['owner'] });
    });
    await assertFails(getDoc(doc(member, 'chatConnections', 'project_alpha')));
    await assertFails(getDoc(doc(member, 'chatMessages', 'project_alpha', 'messages', 'member_seed')));
    await assertFails(setDoc(doc(member, 'chatMessages', 'project_alpha', 'messages', 'after_removal'), {
      sender: 'member', connId: 'project_alpha', cipher: { iv: '00', data: '00' }
    }));
    await assertFails(deleteDoc(doc(member, 'chatMessages', 'project_alpha', 'messages', 'member_seed')));
    await assertSucceeds(getDoc(doc(owner, 'chatMessages', 'project_alpha', 'messages', 'member_seed')));
    await assertSucceeds(getDoc(doc(member, 'chatConnections', 'owner_member')),
      'ordinary non-project chat remains governed by explicit participants');

    const memberProjects = await getDocs(query(collection(member, 'projects'), where('memberIds', 'array-contains', 'member')));
    assert.equal(memberProjects.size, 0, 'removed member must disappear from live project queries');
    const ownerProjects = await getDocs(query(collection(owner, 'projects'), where('ownerId', '==', 'owner')));
    assert.equal(ownerProjects.size, 1);

    console.log(JSON.stringify({
      schema: 'liber.revex.live-rules-gate.v1',
      status: 'PASSED',
      exactLoadedRuleset: true,
      ownerFunctionalAccess: true,
      ordinaryProjectMemberFunctionalAccess: true,
      liberAdminFunctionalAccess: true,
      projectLibraryAndInteractionLanes: true,
      linkedSpecBookAccess: true,
      outsiderDenied: true,
      anonymousDenied: true,
      crossProjectDenied: true,
      ordinaryMemberAclEscalationDenied: true,
      immutableRevisionUpdateDeleteDenied: true,
      appendOnlyHistoryUpdateDeleteDenied: true,
      controlledRenderCreateOnce: true,
      renderStatusServerOwned: true,
      energyConsentScopeImmutable: true,
      secureChatNoGlobalAdminBypass: true,
      browserProjectChatBindingCreateDenied: true,
      browserProjectChatCandidatePreseedDenied: true,
      secureChatPublicKeyCreateOnce: true,
      secureChatGroupKeyAdminOnly: true
      ,staleProjectChatMembershipDenied: true
      ,userProfileAdminSelfEscalationDenied: true
    }, null, 2));
  } finally {
    if (env) await env.cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
