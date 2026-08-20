# REVEX / LIBER Creative release-readiness record

Date: 2026-08-20
Branch: `agent/revex-release-recovery-20260820`
Base commit: `fa2715f`
Status: local release candidate complete; no remote push, merge, production deployment, database mutation, or Revit installation performed.

## Outcome

The release candidate repairs the reported Revit Space failure path, restores the canonical Energy runtime route, makes BIM/Spec/current-revision publication atomic, hardens project Chat and Secure Chat, adds preserved Firestore and Storage access deployment, and fixes the desktop/mobile UI visibility and accessibility regressions. Existing project records, immutable revisions, message history, published Chat fingerprints, and installed add-in rollback data are preserved.

## Engineering changes

### Revit, gbXML and Energy

- The failure shield never calls `DeleteElements` for Spaces. It suppresses the modal by rolling back only the owning REVEX transaction and records `authoritativeSpacesDeleted=0`.
- Space metadata repair is allowed only when the native Space supplies positive solid/volume, identity, level/phase, location, area, faces, and vertical bounds. Unsafe Spaces remain untouched and use source-geometry fallback.
- The recorded failure population is modeled exactly as six batches: 24, 27, 31, 31, 34 and 11, totaling 158 authoritative Spaces.
- The Cloud worker now routes through `revex_energy_pipeline_current.py`; the previous production entrypoint bypassed that guarded facade and reached the implementation directly.
- Revision-scoped user identity completion for missing city/state/ZIP is accepted only after authorization; identity is never fabricated.
- The 91.7% source integrity shown in the supplied run remains above the 80% hard stop and below the 95% quality target. It is preserved as a visible quality warning, not incorrectly converted into either a fatal failure or a perfect score.

### Synchronization and versioning

- Revit schedule sources, immutable BIM revision, and current project pointer publish in one Firestore batch. The current pointer is last in the compatibility fallback, so a failed publish cannot expose a mixed BIM/Spec revision.
- The browser continuously reconciles Firebase Auth state. Offline/signed-out publications retain a project/revision pending marker and are removed only after successful cloud publication.
- Engineering revisions and project history remain append-only; Energy and report job results remain server-owned.
- Existing version shadows, manual Docs, Full Set-linked pages, affected plans, Design Book overlays, and Chat history are preserved.

### Secure Chat, project access and UI

- Project Chat participants are exactly project owner/member identities. Global admins are not silently enrolled, an arbitrary user-created room cannot claim a known project ID, and browser code cannot rewrite project-Chat membership.
- Direct messages use P-256 ECDH + HKDF + AES-GCM. Group/project rooms use a random AES key wrapped independently for each current participant and retain immutable epoch history. Membership changes require an admin rotation; removed users receive no new envelope.
- Device private keys are non-exportable WebCrypto keys stored in IndexedDB. Existing local identities migrate once while preserving the published public-key fingerprint.
- New encrypted attachments use authenticated Firebase Storage SDK reads and `storage://` references; no permanent download token is minted. Legacy tokenized attachments remain decrypt-only compatible.
- Public browser configuration is allowlisted. Browser admin/master/provider credentials, direct Mailgun/OpenAI secrets, configurable token-exfiltration endpoints, static TURN credentials, and plaintext Chat previews are disabled.
- Firestore and Storage rules are patched into the exact preserved live ruleset. The Storage publisher creates an immutable validated ruleset, changes only the selected release, verifies its source SHA, and restores the prior ruleset if verification fails.
- All seven REVEX tabs now have persistent SVG icons and labels, tab semantics, roving keyboard focus, 44 px touch targets, safe-area handling, and stable desktop/mobile layout. WPF diagnostics are collapsed by default instead of consuming a fixed third column; the WebView has a 720 px minimum center lane.

## Local verification completed

All locally runnable gates passed:

- canonical current release contract;
- recorded current-generation and platform-connections contracts;
- Revit Space recovery: 158 preserved, zero deleted, rollback-only modal contract, Dynamo embedded-code parity;
- Energy r95 project-identity consumer boundary and preserved r125 touchups;
- r49 active-Revit package, immutable revision, schedule, viewer and managed-Energy handoff;
- desktop/mobile UI r99, r126, r133, r134, r135, r136, r137, r138, r142 and r143;
- project Chat isolation, Secure Chat direct/group crypto, Storage merge/access and browser credential boundaries;
- JavaScript and Python syntax, release JSON and workflow YAML parsing, and `git diff --check`;
- Firebase Functions production dependency audit: 0 known vulnerabilities (0 low/moderate/high/critical).

## Mandatory external release gates

These gates are encoded in CI/finalization but could not execute in this Linux sandbox:

1. GitHub CI must run the Firestore + Storage emulators with their behavioral access matrices. Local execution was blocked because the Firebase CLI/rules test dependency was unavailable and network installation was not permitted.
2. The production Energy Docker image must build and run its Chrome/Selenium COMcheck proof. Docker, Chrome and Selenium are not installed here.
3. Windows CI must parse every PowerShell controller and compile the Revit 2026 add-in against the CI Revit API surface. PowerShell, .NET SDK and Revit are not installed here.
4. Rendered implementation QA must run in WebView2/a real browser with WebGL. The available cloud browser blocks local workspace URLs and its inspected live session had WebGL disabled.
5. A real Revit 2026 acceptance run must reopen the exact active model, run one fresh **SYNC ENGINEERING**, prove all 158 Space failures are suppressed without deletion, and complete the same-revision Energy package.
6. The live AI proxy must be verified to reject missing/invalid Firebase ID tokens. The client now supplies the token, but the proxy implementation is outside this repository.

No release should be described as production-complete until all six gates pass on the exact source commit.

## Release sequence

1. Review this branch and open a PR without squashing away the immutable release evidence.
2. Require the `REVEX current single-source finalization` workflow to pass, including emulator, Docker and Windows jobs.
3. Merge the exact approved source to `main`.
4. On the authorized Windows/Revit workstation, run `FINALIZE_REVEX.cmd`. Production automatically selects the web app's configured `liber-apps-cca20.firebasestorage.app` release and leaves the legacy Storage release untouched; optional launcher arguments are forwarded for other project configurations.
5. The finalizer stages the Energy candidate, verifies the live Companion, preserves/patches Firestore and Storage rules, deploys source-bound Project Chat/report functions, cuts the Energy broker only after verification, and atomically installs the add-in while retaining the previous installation as a timestamped shadow.
6. Reopen Revit 2026 and run one fresh **SYNC ENGINEERING**. Archive the finalizer log, Revit diagnostics, immutable Engineering revision, Energy package and CI source SHA together.

## Known operating constraints

- A participant must open Secure Chat once to publish their device identity before an admin can include them in a group-key rotation.
- Identity publication is create-once and currently single-device/TOFU. A separately authenticated multi-device enrollment and recovery ceremony remains a future security feature; silent key replacement is intentionally blocked.
- Very high group-key rotation counts should eventually move epoch history from the connection document to an append-only subcollection before approaching Firestore's document-size limit.
- Old tokenized attachments stay readable for migration; new writes do not create tokens. A separate authorized migration can copy old objects to token-free references after production access verification.

## Rollback and preservation

- Revit Space transactions roll back without element deletion.
- The prior installed add-in and manifest are retained as timestamped shadows and restored on failed atomic installation.
- Firestore/Storage publishers patch only marked blocks in downloaded live rules; Storage restores the previous ruleset on failed post-release verification.
- Immutable Engineering/BIM/History records are never rewritten. An orphan immutable record is recoverable; a current pointer is never advanced before its sources exist.
- Project Chat membership repair never deletes historical messages or legacy crypto salts.
