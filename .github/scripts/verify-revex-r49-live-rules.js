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
      await setDoc(doc(db, 'projects', 'alpha'), {
        name: 'Alpha', ownerId: 'owner', memberIds: ['owner', 'member'], status: 'Active'
      });
      await setDoc(doc(db, 'projects', 'alpha', 'library', 'revex_engineering'), {
        schema: 'liber.revex.engineering-sync.v1', revision: 'eng_alpha'
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
    });

    const owner = env.authenticatedContext('owner').firestore();
    const member = env.authenticatedContext('member').firestore();
    const admin = env.authenticatedContext('admin').firestore();
    const outsider = env.authenticatedContext('outsider').firestore();
    const anonymous = env.unauthenticatedContext().firestore();

    for (const [label, db] of [['owner', owner], ['member', member], ['admin', admin]]) {
      await assertSucceeds(getDoc(doc(db, 'projects', 'alpha')));
      await assertSucceeds(getDoc(doc(db, 'projects', 'alpha', 'library', 'revex_engineering')));
      await assertSucceeds(getDocs(query(collection(db, 'projects'), where('memberIds', 'array-contains', label === 'admin' ? 'owner' : label))));
      await verifyProjectLane(db, 'alpha', 'library', `qa_${label}`);
      await verifyProjectLane(db, 'alpha', 'revexDesignItems', `qa_${label}`);
      await verifyProjectLane(db, 'alpha', 'revexIssues', `qa_${label}`);
      await verifyProjectLane(db, 'alpha', 'revexHistory', `qa_${label}`);
      await verifyProjectLane(db, 'alpha', 'revexEnergyJobs', `qa_${label}`);
      await verifyProjectLane(db, 'alpha', 'revexEnergyConsents', `qa_${label}`);
      await assertSucceeds(getDoc(doc(db, 'specProjects', 'spec_alpha')));
      await assertSucceeds(getDoc(doc(db, 'specProjects', 'spec_alpha', 'sources', 'revex-revit')));
      await assertSucceeds(setDoc(doc(db, 'specProjects', 'spec_alpha', 'items', `qa_${label}`), { finish: 'bronze' }));
      await assertSucceeds(deleteDoc(doc(db, 'specProjects', 'spec_alpha', 'items', `qa_${label}`)));
    }

    await assertSucceeds(updateDoc(doc(member, 'projects', 'alpha'), { status: 'Review' }));
    await assertFails(updateDoc(doc(member, 'projects', 'alpha'), { memberIds: ['member', 'outsider'] }));
    await assertFails(updateDoc(doc(member, 'projects', 'alpha'), { ownerId: 'member' }));
    await assertFails(updateDoc(doc(member, 'specProjects', 'spec_alpha'), { linkedProjectId: 'beta' }));
    await assertSucceeds(updateDoc(doc(owner, 'projects', 'alpha'), { memberIds: ['owner', 'member'] }));
    await assertSucceeds(updateDoc(doc(admin, 'projects', 'alpha'), { memberIds: ['owner', 'member', 'new_member'] }));

    for (const denied of [outsider, anonymous]) {
      await assertFails(getDoc(doc(denied, 'projects', 'alpha')));
      await assertFails(getDoc(doc(denied, 'projects', 'alpha', 'library', 'revex_engineering')));
      await assertFails(setDoc(doc(denied, 'projects', 'alpha', 'revexIssues', 'forbidden'), { title: 'No' }));
      await assertFails(getDoc(doc(denied, 'specProjects', 'spec_alpha')));
      await assertFails(setDoc(doc(denied, 'specProjects', 'spec_alpha', 'sources', 'forbidden'), { revision: 'No' }));
    }
    await assertFails(getDoc(doc(member, 'projects', 'beta', 'library', 'private')));
    await assertFails(setDoc(doc(member, 'projects', 'beta', 'library', 'forbidden'), { secret: true }));

    const memberProjects = await getDocs(query(collection(member, 'projects'), where('memberIds', 'array-contains', 'member')));
    assert.equal(memberProjects.size, 1);
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
      ordinaryMemberAclEscalationDenied: true
    }, null, 2));
  } finally {
    if (env) await env.cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
