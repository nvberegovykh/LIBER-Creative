'use strict';

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
  if (trustedAdminClaims(authClaims)) return 'liber-admin';
  if (normalizedUid(projectData?.ownerId) === identity) return 'owner';
  const members = Array.isArray(projectData?.memberIds)
    ? projectData.memberIds.map(normalizedUid).filter(Boolean)
    : [];
  return members.includes(identity) ? 'member' : null;
}

module.exports = { trustedAdminClaims, projectAccessRole };
