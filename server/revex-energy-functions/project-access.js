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
  'run-energy'
]);

function normalizedUid(value) {
  return String(value || '').trim();
}

// Admin authorization is a verified Firebase Auth custom claim.  Never trust
// `users/{uid}.role`: users historically could update that document, so it is
// display/profile data only and cannot grant server-side project authority.
function hasLiberAdminClaim(tokenClaims) {
  return tokenClaims?.liber_admin === true;
}

function projectAccessRole(projectData, tokenClaims, uid) {
  const identity = normalizedUid(uid);
  if (!identity) return null;
  if (hasLiberAdminClaim(tokenClaims)) return 'liber-admin';
  if (normalizedUid(projectData?.ownerId) === identity) return 'owner';
  const members = Array.isArray(projectData?.memberIds)
    ? projectData.memberIds.map(normalizedUid).filter(Boolean)
    : [];
  return members.includes(identity) ? 'member' : null;
}

function canUseProject(projectData, tokenClaims, uid) {
  return projectAccessRole(projectData, tokenClaims, uid) !== null;
}

function canMutateProjectAcl(projectData, tokenClaims, uid) {
  const role = projectAccessRole(projectData, tokenClaims, uid);
  return role === 'owner' || role === 'liber-admin';
}

function functionalAccessMatrix(projectData, tokenClaims, uid) {
  const role = projectAccessRole(projectData, tokenClaims, uid);
  return {
    role,
    operations: Object.fromEntries(PROJECT_FUNCTIONS.map((operation) => [operation, role !== null])),
    canMutateProjectAcl: role === 'owner' || role === 'liber-admin'
  };
}

module.exports = {
  PROJECT_FUNCTIONS,
  hasLiberAdminClaim,
  projectAccessRole,
  canUseProject,
  canMutateProjectAcl,
  functionalAccessMatrix
};
