'use strict';

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

module.exports = { projectAccessRole };
