#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  PROJECT_FUNCTIONS,
  projectAccessRole,
  canUseProject,
  canMutateProjectAcl,
  functionalAccessMatrix
} = require('./project-access');

const project = {
  id: 'revex_project_a',
  ownerId: 'owner-a',
  memberIds: ['owner-a', 'member-a']
};

const users = {
  owner: { uid: 'owner-a', profile: { role: 'user' } },
  member: { uid: 'member-a', profile: { role: 'user' } },
  admin: { uid: 'admin-a', profile: { revexAdmin: true } },
  selfPromoted: { uid: 'self-promoted-a', profile: {}, userDocument: { role: 'admin' } },
  outsider: { uid: 'outsider-a', profile: { role: 'user' } },
  anonymous: { uid: '', profile: {} },
  crossProjectMember: { uid: 'member-b', profile: { role: 'user' } }
};

function assertFullFunctionalParity(label, expectedRole) {
  const user = users[label];
  const matrix = functionalAccessMatrix(project, user.profile, user.uid);
  assert.equal(matrix.role, expectedRole, `${label} role must be ${expectedRole}`);
  for (const operation of PROJECT_FUNCTIONS) {
    assert.equal(matrix.operations[operation], true, `${label} must be allowed to ${operation}`);
  }
  assert.equal(canUseProject(project, user.profile, user.uid), true, `${label} must pass project access`);
  return matrix;
}

function assertDenied(label) {
  const user = users[label];
  const matrix = functionalAccessMatrix(project, user.profile, user.uid);
  assert.equal(matrix.role, null, `${label} must not receive a project role`);
  for (const operation of PROJECT_FUNCTIONS) {
    assert.equal(matrix.operations[operation], false, `${label} must be denied ${operation}`);
  }
  assert.equal(canUseProject(project, user.profile, user.uid), false, `${label} must fail project access`);
}

const owner = assertFullFunctionalParity('owner', 'owner');
const member = assertFullFunctionalParity('member', 'member');
const admin = assertFullFunctionalParity('admin', 'liber-admin');
assertDenied('outsider');
assertDenied('anonymous');
assertDenied('crossProjectMember');
assertDenied('selfPromoted');

assert.equal(canMutateProjectAcl(project, users.owner.profile, users.owner.uid), true);
assert.equal(canMutateProjectAcl(project, users.admin.profile, users.admin.uid), true);
assert.equal(canMutateProjectAcl(project, users.member.profile, users.member.uid), false,
  'Ordinary members must have full project functionality without being able to add outsiders or replace project ownership.');
assert.equal(projectAccessRole({ ownerId: 'someone-else', memberIds: ['member-b'] }, users.member.profile, users.member.uid), null,
  'Membership in one project must never grant access to another project.');

console.log(JSON.stringify({
  schema: 'liber.revex.project-access-gate.v1',
  status: 'PASSED',
  functionalOperations: PROJECT_FUNCTIONS,
  allowed: {
    owner: owner.role,
    ordinaryProjectMember: member.role,
    liberAdmin: admin.role
  },
  denied: ['outsider', 'anonymous', 'cross-project-member'],
  userProfileRoleIsNotAuthority: true,
  aclMutation: ['owner', 'liber-admin'],
  ordinaryMemberFunctionalParity: true
}, null, 2));
