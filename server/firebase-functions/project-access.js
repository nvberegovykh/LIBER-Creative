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

function normalizedRole(userData) {
  return String(userData?.role || '').trim().toLowerCase();
}

function projectAccessRole(projectData, userData, uid) {
  const identity = normalizedUid(uid);
  if (!identity) return null;
  if (normalizedRole(userData) === 'admin') return 'liber-admin';
  if (normalizedUid(projectData?.ownerId) === identity) return 'owner';
  const members = Array.isArray(projectData?.memberIds)
    ? projectData.memberIds.map(normalizedUid).filter(Boolean)
    : [];
  return members.includes(identity) ? 'member' : null;
}

function canUseProject(projectData, userData, uid) {
  return projectAccessRole(projectData, userData, uid) !== null;
}

function canMutateProjectAcl(projectData, userData, uid) {
  const role = projectAccessRole(projectData, userData, uid);
  return role === 'owner' || role === 'liber-admin';
}

function functionalAccessMatrix(projectData, userData, uid) {
  const role = projectAccessRole(projectData, userData, uid);
  return {
    role,
    operations: Object.fromEntries(PROJECT_FUNCTIONS.map((operation) => [operation, role !== null])),
    canMutateProjectAcl: role === 'owner' || role === 'liber-admin'
  };
}

module.exports = {
  PROJECT_FUNCTIONS,
  projectAccessRole,
  canUseProject,
  canMutateProjectAcl,
  functionalAccessMatrix
};
