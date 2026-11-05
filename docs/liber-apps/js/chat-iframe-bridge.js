/**
 * Legacy include retained for already-cached app pages.
 *
 * Every document owns its Firebase SDK and service. Sharing parent instances
 * races the child bootstrap and mixes Firestore references from different SDK
 * realms. The local Firebase SDK shares remembered sign-in through same-origin
 * persistence; no user, token, or Firebase object is copied across frames.
 *
 * Intentionally no parent-global assignment, observer, or polling timer here.
 */
