# Jericho PICT channel

The Jericho portal uses the existing LIBER Firebase Authentication project and a dedicated `jericho` Firestore database in `liber-apps-cca20`. It runs alongside REVEX without changing its data, rules, services, or project ownership. PICT means this application network; no external blockchain or public NFT contract is asserted.

## Running services

`jerichoApi` is a Node 22 HTTP function in `us-central1`. Its runtime service account is `jericho-channel@liber-apps-cca20.iam.gserviceaccount.com`. It has a database-specific conditional `roles/datastore.user` grant for `projects/liber-apps-cca20/databases/jericho` and Firebase Auth read access for token revocation checks. It has no service-account key file. Direct Firestore clients are denied by `firestore.rules`.

The endpoint requires verified Firebase email accounts for private operations. Public lookup returns a narrow allowlist and uses rate limits. CORS permits only the specified LIBER origins. No cookie-based mutation is accepted. Logs exclude request bodies, credentials, and identity evidence.

Profiles, declaration consent, artwork choices, optional unique nontransferable avatar records, hash-linked change receipts, image/QR downloads, owner-controlled time-limited access passes, exports, and membership closure are operational. A self-declared profile has a random opaque reference. A verified 27-digit JAP is issued only after a bound live Stripe Identity result returns verified adult identity evidence. Test sessions cannot issue live credentials.

Private negotiations use separate account-bound representatives, one-use invitation tokens stored as digests, version checks, a shared baseline, sealed corrections, frozen-package fingerprints, independent decisions, withdrawal, and exports. A caller cannot choose another side. Correction text is filtered from both the state and event log until both corrections exist. A proposed invitation records only the first party's consent; the second party's consent is set when that account accepts it. The retained local facilitator tool remains at `/negotiations/local`.

## Provider activation still required

The deployed service has no Stripe Identity account credentials. `providerEnabled` is false. It accepts community profiles but does not collect identity documents or issue verified JAP numbers. This is the one external production dependency that source code cannot replace.

The business operator must activate Stripe Identity, complete Stripe's business onboarding, accept its terms, and approve identity processing and costs. Keep credentials in Google Secret Manager, never this repository or chat. The integration uses `JERICHO_STRIPE_KEY` (live restricted or secret key with Identity permissions) and `JERICHO_STRIPE_WEBHOOK_SECRET`.

After activation:

1. Store the live Identity key as a Secret Manager version named `JERICHO_STRIPE_KEY`.
2. Register `https://us-central1-liber-apps-cca20.cloudfunctions.net/jerichoApi/stripe-webhook` for the `identity.verification_session.*` events. Store its signing secret as `JERICHO_STRIPE_WEBHOOK_SECRET`. These must belong to the same activated live Stripe account.
3. Grant the Jericho runtime service account secret accessor on these two secrets only. Bind both secret versions to `jerichoApi`. Do not put key values in deployment command lines.
4. Deploy `jerichoMaintenance` using its scheduled definition in `index.js`, with the same runtime identity and secret bindings. It retries requested provider redactions daily and removes session bindings after completion. Review the scheduled invocation permissions and run it once before opening verification.
5. Verify the webhook signature path, retry behavior, provider session binding, live/result separation, expiration/renewal, adult-evidence checks, and provider redaction in a Stripe test environment. Then use an explicitly consenting adult for the first live end-to-end verification. No synthetic QA account should ever be represented as having passed live KYC.
6. Confirm current provider terms, allowed jurisdictions, notices, biometric-processing requirements, account-specific fees, retention, and incident response before activating document processing. The privacy notice explains the implemented feature boundaries; it is not a claim of universal legal compliance.

Only successful live verification can issue a number. A callback retrieves current provider state, checks the stored attempt/session binding, checks the current account, and performs transactional idempotent issuance. Replayed callbacks cannot extend an existing credential. Renewal requires a new verified session. Identity documents and biometrics stay with Stripe; only verified name/date of birth, minimal provider references, and status are retained here for optional scoped sharing.

## Retention and deletion

TTL policies are enabled on `expireAt` for `limits` (one day), `shares` (chosen 1h/24h/7d), `invites` (7d), `rooms` (one year after activity), and `receipts` (one year). All access paths check logical expiration immediately. Physical TTL cleanup is asynchronous. Closed profile references remain as minimal revocation tombstones. Closing a profile preserves the other participant's shared negotiation until its ordinary retention limit, and removes active sharing grants. Provider redaction is queued durably in the closed member record.

The operator may access server records; the product makes no end-to-end-encryption claim. Agency requests are handled by the operator under valid authority. The sharing UI implements a member's voluntary disclosure to a confirmed recipient email, not automated verification of government agency authority.

## Tests and deployment

`npm test` requires an isolated Firestore emulator via `FIRESTORE_EMULATOR_HOST`; tests abort without it and use project `demo-jericho`. Tests cover consent, injected identity claims, lookup minimization, access binding/revocation/expiration, live-result-only issuance, idempotency, role enforcement, concealed corrections, immutable terms, independent refusal, invitation rotation, and closure.

The production account/browser QA uses temporary synthetic accounts, never real member identities. It exercises sign-in, saved profiles, image downloads, QR resolution, sharing, two-account negotiation, and closure, then deletes its own synthetic accounts and records. KYC-provider and real Google-popup onboarding require their own authorized live validation.

Hosting is Firebase Hosting on `liber-apps-cca20`; a GitHub Pages build alone does not update `liberpict.com`. Publication clones the current live version, updates only the named Jericho files, verifies that all unrelated file hashes remain unchanged, checks a preview, and promotes that exact version with rollback on failed byte verification. Preserve the existing root homepage and REVEX routes.

The new service dependency audit reported zero advisories on 2026-11-05. `rimraf`, `glob`, and `minimatch` overrides resolve inherited moderate advisories; run the emulator and cloud smoke checks after future dependency updates.

Primary integration documentation: [Stripe Identity sessions](https://docs.stripe.com/identity/verification-sessions), [Firebase Auth](https://firebase.google.com/docs/auth/web/google-signin), [Firestore IAM](https://docs.cloud.google.com/firestore/native/docs/security/iam), [Firestore TTL](https://firebase.google.com/docs/firestore/ttl).
