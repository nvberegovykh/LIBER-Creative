'use strict';

function normalizedUid(value) {
  return String(value || '').trim();
}

// Never grant a server role from mutable profile data.  The deployment
// migration grants trusted operators the Firebase Auth custom claim
// `liber_admin: true`; Firebase verifies that claim before onCall executes.
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

module.exports = { hasLiberAdminClaim, projectAccessRole };
