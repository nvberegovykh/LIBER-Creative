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

const projectId = 'demo-revex-r43';

(async () => {
  let env;
  try {
  env = await initializeTestEnvironment({ projectId });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users', 'admin'), { role: 'admin' });
    await setDoc(doc(db, 'users', 'member'), { role: 'user' });
    await setDoc(doc(db, 'projects', 'alpha'), {
      name: 'Alpha', ownerId: 'owner', memberIds: ['owner', 'member'], status: 'Active'
    });
    await setDoc(doc(db, 'projects', 'alpha', 'library', 'revex_engineering'), { revision: 'eng_preserved' });
    await setDoc(doc(db, 'projects', 'beta'), {
      name: 'Beta', ownerId: 'other_owner', memberIds: ['other_owner'], status: 'Active'
    });
    await setDoc(doc(db, 'projects', 'beta', 'library', 'private'), { secret: true });
    await setDoc(doc(db, 'specProjects', 'spec_alpha'), {
      name: 'Alpha Spec Book', ownerId: 'owner', memberIds: ['owner'], linkedProjectId: 'alpha'
    });
    await setDoc(doc(db, 'specProjects', 'spec_alpha', 'items', 'door'), { finish: 'oak' });
  });

  const member = env.authenticatedContext('member').firestore();
  const owner = env.authenticatedContext('owner').firestore();
  const outsider = env.authenticatedContext('outsider').firestore();
  const admin = env.authenticatedContext('admin').firestore();
  const anonymous = env.unauthenticatedContext().firestore();

  await assertSucceeds(getDoc(doc(member, 'projects', 'alpha')));
  await assertSucceeds(getDoc(doc(member, 'projects', 'alpha', 'library', 'revex_engineering')));
  await assertSucceeds(setDoc(doc(member, 'projects', 'alpha', 'revexDesignItems', 'facade'), { decision: 'brick' }));
  await assertSucceeds(updateDoc(doc(member, 'projects', 'alpha'), { status: 'Review' }));
  await assertSucceeds(getDocs(query(collection(member, 'projects'), where('memberIds', 'array-contains', 'member'))));

  const memberIssue = doc(member, 'projects', 'alpha', 'revexIssues', 'member_issue');
  await assertSucceeds(setDoc(memberIssue, { title: 'Member issue', status: 'open', createdBy: 'member' }));
  await assertSucceeds(updateDoc(memberIssue, { status: 'review', dueDate: '2026-08-31' }));
  const memberIssueRead = await getDoc(memberIssue);
  assert.equal(memberIssueRead.data().status, 'review');

  await assertSucceeds(getDoc(doc(member, 'specProjects', 'spec_alpha')));
  await assertSucceeds(getDocs(query(collection(member, 'specProjects'), where('linkedProjectId', '==', 'alpha'))));
  await assertSucceeds(setDoc(doc(member, 'specProjects', 'spec_alpha', 'items', 'window'), { finish: 'bronze' }));
  await assertSucceeds(updateDoc(doc(member, 'specProjects', 'spec_alpha'), { name: 'Alpha Specifications' }));

  await assertFails(updateDoc(doc(member, 'projects', 'alpha'), { memberIds: ['member', 'outsider'] }));
  await assertFails(getDoc(doc(outsider, 'projects', 'alpha')));
  await assertFails(getDoc(doc(outsider, 'projects', 'alpha', 'library', 'revex_engineering')));
  await assertFails(setDoc(doc(outsider, 'projects', 'alpha', 'revexIssues', 'forbidden'), { title: 'No' }));
  await assertFails(getDoc(doc(member, 'projects', 'beta', 'library', 'private')));
  await assertFails(getDoc(doc(anonymous, 'projects', 'alpha')));

  const memberProjectQuery = await getDocs(query(collection(member, 'projects'), where('memberIds', 'array-contains', 'member')));
  assert.equal(memberProjectQuery.size, 1);
  const ownerProjectQuery = await getDocs(query(collection(owner, 'projects'), where('ownerId', '==', 'owner')));
  assert.equal(ownerProjectQuery.size, 1);

  await assertSucceeds(getDocs(collection(admin, 'projects')));
  await assertSucceeds(updateDoc(doc(admin, 'projects', 'alpha'), { memberIds: ['owner', 'member', 'new_member'] }));
  await assertSucceeds(deleteDoc(doc(owner, 'projects', 'alpha')));

  console.log('REVEX r43 project-member security rules QA passed:', {
    memberContentAccess: true,
    memberIssueWrite: true,
    linkedSpecAccess: true,
    aclProtected: true,
    outsiderDenied: true,
    crossProjectDenied: true,
    adminAccess: true
  });
  } finally {
    if (env) await env.cleanup();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
