'use strict';

const PROJECT_FUNCTIONS = Object.freeze([
  'read',
  'create-project-content',
  'update-project-content',
  'delete-project-content',
  'filter',
  'visibility',
  'design-book',
  'spec-book',
  'chat',
  'history',
  'sync-bim-books',
  'sync-engineering',
  'run-render',
  'run-energy'
]);

function normalizedUid(value) {
  return String(value || '').trim();
}

function trustedAdminClaims(authClaims) {
  return authClaims?.revexAdmin === true ||
    String(authClaims?.role || '').trim().toLowerCase() === 'admin';
}

function projectAccessRole(projectData, authClaims, uid) {
  const identity = normalizedUid(uid);
  if (!identity) return null;
  // Administrator authority comes only from Firebase Auth custom claims. User
  // profile documents are client data and must never be an authorization root.
  if (trustedAdminClaims(authClaims)) return 'liber-admin';
  if (normalizedUid(projectData?.ownerId) === identity) return 'owner';
  const members = Array.isArray(projectData?.memberIds)
    ? projectData.memberIds.map(normalizedUid).filter(Boolean)
    : [];
  return members.includes(identity) ? 'member' : null;
}

function canUseProject(projectData, authClaims, uid) {
  return projectAccessRole(projectData, authClaims, uid) !== null;
}

function canMutateProjectAcl(projectData, authClaims, uid) {
  const role = projectAccessRole(projectData, authClaims, uid);
  return role === 'owner' || role === 'liber-admin';
}

function functionalAccessMatrix(projectData, authClaims, uid) {
  const role = projectAccessRole(projectData, authClaims, uid);
  return {
    role,
    operations: Object.fromEntries(PROJECT_FUNCTIONS.map((operation) => [operation, role !== null])),
    canMutateProjectAcl: role === 'owner' || role === 'liber-admin'
  };
}

module.exports = {
  PROJECT_FUNCTIONS,
  trustedAdminClaims,
  projectAccessRole,
  canUseProject,
  canMutateProjectAcl,
  functionalAccessMatrix
};
