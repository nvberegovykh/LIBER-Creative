# Jericho PICT channel

The Jericho portal uses the existing LIBER Firebase Authentication project and a dedicated `jericho` Firestore database in `liber-apps-cca20`. It runs alongside REVEX without changing its data, rules, services, or project ownership. PICT means this application network; no external blockchain or public NFT contract is asserted.

## Running services

`jerichoApi` is a Node 22 HTTP function in `us-central1`. Its runtime service account is `jericho-channel@liber-apps-cca20.iam.gserviceaccount.com`. It has a database-specific conditional `roles/datastore.user` grant for `projects/liber-apps-cca20/databases/jericho` and Firebase Auth read access for token revocation checks. It has no service-account key file. Direct Firestore clients are denied by `firestore.rules`.

The endpoint requires verified Firebase email accounts for private operations. Public lookup returns a narrow allowlist and uses rate limits. CORS permits only the specified LIBER origins. No cookie-based mutation is accepted. Logs exclude request bodies, credentials, and identity evidence.

Profiles, declaration consent, artwork choices, optional unique nontransferable avatar records, hash-linked change receipts, image/QR downloads, owner-controlled time-limited access passes, exports, and membership closure are operational. A self-declared profile has a random opaque reference. A verified 27-digit JAP is issued only after a bound live Stripe Identity result returns verified adult identity evidence. Test sessions cannot issue live credentials.

Private negotiations use separate account-bound representatives, one-use invitation tokens stored as digests, version checks, a shared baseline, sealed corrections, frozen-package fingerprints, independent decisions, withdrawal, and exports. A caller cannot choose another side. Correction text is filtered from both the state and event log until both corrections exist. A proposed invitation records only the first party's consent; the second party's consent is set when that account accepts it. The retained local facilitator tool remains at `/negotiations/local`.

## Provider activation still required

The Stripe Identity application was submitted on 2026-11-05 and the operator reports that Stripe is reviewing it. `providerEnabled` remains false. Community profiles remain available; verified JAP issuance stays closed until review and live validation are complete. The restricted test key and test/live callback signing secrets are in Google Secret Manager. The live restricted-key creation is waiting at Stripe's authenticator-code security check; no live API key has yet been stored or bound.

The business operator must activate Stripe Identity, complete Stripe's business onboarding, accept its terms, and approve identity processing and costs. Keep credentials in Google Secret Manager, never this repository or chat. The integration uses `JERICHO_STRIPE_KEY` (a live restricted key with **Identity Verification Results: Write** and **Recent Detailed Verification Results: Read**, using the Dashboard's permission names) and `JERICHO_STRIPE_WEBHOOK_SECRET`. A general secret key cannot retrieve the required birth date. Production enrollment also requires `JERICHO_IDENTITY_LIVE_ENABLED=true`; leave it false while account review or external validation is incomplete.

After activation:

1. Store the live restricted Identity key as a Secret Manager version named `JERICHO_STRIPE_KEY`. Grant no payment, balance, payout, customer, file-image, or unrelated product permissions.
2. The live destination `we_1UYVnWJfDJuPadAFGnTqsWzd` is registered at `https://us-central1-liber-apps-cca20.cloudfunctions.net/jerichoApi/stripe-webhook` for the Identity `verified`, `requires_input`, `processing`, `canceled`, and explicitly selected `redacted` events. It uses API version `2026-10-28.endive`, matching the installed SDK. Its signing secret is stored as `JERICHO_STRIPE_WEBHOOK_SECRET` version 1. Both secrets must belong to the same activated live Stripe account.
3. Grant the Jericho runtime service account secret accessor on these two secrets only. Bind both secret versions to `jerichoApi`. Do not put key values in deployment command lines.
4. Deploy `jerichoMaintenance` using its scheduled definition in `index.js`, with the same runtime identity and secret bindings. It retries requested provider redactions daily and removes session bindings after completion. Review the scheduled invocation permissions and run it once before opening verification.
5. Verify the webhook signature path, retry behavior, provider session binding, live/result separation, expiration/renewal, adult-evidence checks, and provider redaction in a Stripe test environment. Then use an explicitly consenting adult for the first live end-to-end verification. No synthetic QA account should ever be represented as having passed live KYC.
6. Confirm current provider terms, allowed jurisdictions, notices, biometric-processing requirements, account-specific fees, retention, and incident response before setting `JERICHO_IDENTITY_LIVE_ENABLED=true`. The privacy notice explains the implemented feature boundaries; it is not a claim of universal legal compliance.

`deploy-identity.ps1` performs the secret-specific grants, binds explicit secret versions, deploys the private maintenance endpoint, grants invocation to the Jericho service account, configures its daily 09:00 UTC authenticated scheduler call, and requests an initial run. It always leaves public verification closed. After running, inspect the scheduler's successful response and verify that an unauthenticated request to maintenance is rejected. The script contains no credentials.

Only successful live verification can issue a number. A callback retrieves current provider state, checks the stored attempt/session binding, checks the current account, and performs transactional idempotent issuance. Birth date is explicitly expanded as `verified_outputs.dob` only on first issuance for that session. Ordinary refreshes and callback replays do not request sensitive results again after Stripe's recent-results access window. Replayed callbacks cannot extend an existing credential. Renewal requires a new verified session. Identity documents and biometrics stay with Stripe; only verified name/date of birth, minimal provider references, and status are retained here for optional scoped sharing.

Stripe removes session metadata on redaction. The retained session binding therefore identifies redactions even when the purpose and attempt metadata have been erased. Both public references are revoked and local identity fields cleared. Closing membership requests redaction of every stored attempt, including earlier canceled/renewal sessions; maintenance retries until all have completed.

## Retention and deletion

TTL policies are enabled on `expireAt` for `limits` (one day), `shares` (chosen 1h/24h/7d), `invites` (7d), `rooms` (one year after activity), and `receipts` (one year). All access paths check logical expiration immediately. Physical TTL cleanup is asynchronous. Closed profile references remain as minimal revocation tombstones. Closing a profile preserves the other participant's shared negotiation until its ordinary retention limit, and removes active sharing grants. Provider redaction is queued durably in the closed member record.

The operator may access server records; the product makes no end-to-end-encryption claim. Agency requests are handled by the operator under valid authority. The sharing UI implements a member's voluntary disclosure to a confirmed recipient email, not automated verification of government agency authority.

## Tests and deployment

`npm test` requires an isolated Firestore emulator via `FIRESTORE_EMULATOR_HOST`; tests abort without it and use `demo-jericho` and `demo-jericho-identity`. Tests cover consent, injected identity claims, lookup minimization, access binding/revocation/expiration, live-result-only issuance, idempotency, role enforcement, concealed corrections, immutable terms, independent refusal, invitation rotation, and closure. The provider suite uses synthetic responses and real Stripe signature verification to test explicit DOB expansion, rejection of forged signatures/test events/substituted bindings/suspended accounts, replay handling without sensitive rereads, canceled-session retries, metadata-free redaction, and cleanup of all attempts. These isolated tests do not claim actual Stripe sandbox or live verification.

The production account/browser QA uses temporary synthetic accounts, never real member identities. It exercises sign-in, saved profiles, image downloads, QR resolution, sharing, two-account negotiation, and closure, then deletes its own synthetic accounts and records. KYC-provider and real Google-popup onboarding require their own authorized live validation.

On 2026-11-05 all 14 isolated backend tests passed and the published two-account workflow passed again after the identity-handler changes. Separately, actual Stripe test-mode hosted flows returned verified success and `document_unverified_other` failure; cancellation also succeeded. The restricted test key created sessions and retrieved explicitly expanded DOB. Stripe delivered signed processing, verified, requires-input, and canceled callbacks to a temporary test-only receiver, with HTTP 200 and verified signatures; a forged signature received HTTP 400. The receiver never had an issuance path. It was removed afterward, its Stripe endpoint disabled, and its access to the test secrets revoked. Redaction was requested for all four synthetic Stripe sessions; the provider still reported `processing` at the last check, so completed provider deletion is not claimed. Test fixtures and these checks are not live KYC or live JAP issuance.

Hosting is Firebase Hosting on `liber-apps-cca20`; a GitHub Pages build alone does not update `liberpict.com`. Publication clones the current live version, updates only the named Jericho files, verifies that all unrelated file hashes remain unchanged, checks a preview, and promotes that exact version with rollback on failed byte verification. Preserve the existing root homepage and REVEX routes.

The new service dependency audit reported zero advisories on 2026-11-05. `rimraf`, `glob`, and `minimatch` overrides resolve inherited moderate advisories; run the emulator and cloud smoke checks after future dependency updates.

Primary integration documentation: [Stripe Identity sessions](https://docs.stripe.com/identity/verification-sessions), [Firebase Auth](https://firebase.google.com/docs/auth/web/google-signin), [Firestore IAM](https://docs.cloud.google.com/firestore/native/docs/security/iam), [Firestore TTL](https://firebase.google.com/docs/firestore/ttl).
