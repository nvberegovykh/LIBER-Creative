# Jericho Alliance implementation status

Prepared 5 November 2026. The website is a public proposal and demonstration. The identity service is a disabled integration candidate. It has not been deployed or exercised against live provider sessions.

## Existing infrastructure

The source owner is `nvberegovykh/LIBER-Creative`. GitHub Pages builds `main/docs`, while the actual liberpict.com domain is served by Firebase Hosting site `liber-apps-cca20`. Public publication uses a clone of the current Firebase release with a bounded file patch, preserving existing routing and unrelated files. The same Firebase project owns the existing LIBER account infrastructure. The `/ai` guide describes the read-only REVEX Observer. It does not provide website writes, KYC services, or blockchain mint authority.

## Delivered

- Public Declaration of Presence, SIP, JAP and legal-basis pages with three homepage footer links.
- Letter-size Gothic declaration, a 3:2 flag proposal, a sample pixel-art avatar, two card sides and a sample QR.
- Candidate Firebase callables for verification-session creation, an owner status view, limited reference lookup and owner revocation.
- Stripe webhook signature verification and server retrieval of the current session before issuance. Browser redirects cannot approve KYC. Test provider events cannot issue live credentials.
- Cryptographically random 27-digit references held as strings, transactional reservation, retry-safe duplicate callbacks, expiry and revocation.
- Separate NFT opt-in and a transactional job marked `blocked-network-configuration`. There is no minting adapter or deployed PICT contract in this release.

## Required before live enrollment

1. Identify the actual operating legal entity and approve membership terms, privacy notice, adult-only eligibility, assistance and appeal processes, retention schedule and responsible contacts. The checkbox in the candidate backend records adult self-attestation only. It does not independently verify age.
2. Activate Stripe Identity for that entity and approved use case. Configure the secret manager entries `JERICHO_STRIPE_KEY` and `JERICHO_STRIPE_WEBHOOK_SECRET`. Complete the provider's consent, biometric-data, processor, retention and deletion requirements. No paid verification has been initiated.
3. Provision the named Firestore database `jericho` within the existing project and apply `firebase/jericho.rules` to that database only. Configure least-privilege IAM, backups, monitored audit access, a deletion schedule and incident response. The shared default database must not inherit private identity records.
4. Register the intended web application with Firebase App Check. Integrate the existing LIBER Firebase session through the native callable SDK. The current public interface intentionally remains in prelaunch mode and has no live callables wired to its controls.
5. Use the provider's hosted verification URL, bind it to the authenticated account, test interrupted requests, repeated sessions, cancellation, redaction, revocation and retry races in a staging environment. Add server-side quotas and abuse protection beyond App Check before public use. Pin the Stripe webhook event version to the SDK's supported version.
6. Complete the authenticated owner experience, consent changes, approved disclosure requests, correction, redaction, credential renewal and account recovery. Implement the QR and personalized card generation against issued records. Only sample downloads exist today. Full identity retrieval, identity-photo access and agency disclosure are not implemented.
7. Resolve the dependency audit findings in the existing Firebase dependency tree before this service handles sensitive information. At preparation time the installed tree reported 12 advisories, including one critical and three high. The lockfile change adds Stripe only. The reported packages already occur in the baseline dependency tree. This task did not upgrade the shared Firebase stack.
8. Identify the actual PICT chain, RPC, chain identifier, finality policy, wallet custody model, deployed verified contract, authorized signer and fees. Implement idempotent mint submission, transaction reconciliation, recovery, transfer policy and revocation behavior. The system must never equate token ownership with current identity. Do not publish identity documents, personal fields or hashes derived from those fields on-chain. A token may itself be linkable and needs a privacy assessment.
9. Implement the per-person avatar generator and provenance record. The included fictional avatar is a design sample. Provider identity photos must not be silently reused for artwork. Obtain a distinct choice for any token publication and wallet linkage.
10. Complete provider integration tests, Firestore emulator security and concurrency tests, independent security review, jurisdiction-specific legal review and operational acceptance. Then deploy only the five `jericho*` functions and set `JERICHO_ENABLED=true`. An environment flag alone does not complete these steps.

## Data ownership and fields

`members/{firebaseUid}` is server-only and stores the provider-session reference, verification state, consent version, issuance dates, avatar seed and JAP reference. It contains no identity document image, document number, immigration case, birth date or address. The provider keeps the evidence under its controls and retention arrangements.

`providerSessions/{sessionId}` binds callbacks to the enrollment attempt. `references/{27DigitId}` contains the minimal public projection. `tokenJobs/{firebaseUid}` is a private outbox. None of these collections allow direct browser reads or writes.

Public verification returns reference, private-credential type, issuer, status and dates. A reference is not authentication. Officer and carrier requests need a purpose-specific authorization process, verified requestor, jurisdiction, exact field scope, decision, expiry, disclosure audit and restrictions on onward use. An agency label or email domain alone grants no access. The public page presents this as proposed governance, not an operational disclosure service.

The proposed one-year credential lifetime and adult-only initial enrollment are implementation defaults for operator review. No unique-person guarantee exists across multiple LIBER accounts. KYC is one input to a documented identity assurance process, not a universal legal certification.

## Legal sources and scope

The declaration preserves voluntary association, lawful petition, due process, mutual aid and environmental stewardship. It rewrites asserted statehood as a constitutional aspiration and excludes claims that a community card resolves immigration cases or grants citizenship. Personal birth dates, private residential addresses, named appointments without documented acceptance, alcohol requirements and expulsion claims were omitted from the public covenant.

New state admission from within New York requires the legislature's consent and Congress under Article IV, Section 3. Association recognition does not establish statehood. The public proposal does not verify the claimed New York recognition. [U.S. Constitution](https://www.archives.gov/founding-docs/constitution-transcript)

A New York not-for-profit corporation requires the applicable incorporation filing and any purpose-specific approvals. A landing page alone does not perform those filings. [New York Department of State](https://dos.ny.gov/certificate-incorporation-domestic-not-profit-corporations-0)

REAL ID applies to qualifying state-issued credentials. Section 37.17 addresses surface fields such as name, birth date, gender, number, facial photograph, principal residence, signature, dates and jurisdiction. Copying those fields into JAP would not authorize a private issuer or confer compliance. An artistic avatar cannot replace the required facial photograph. [USAGov](https://www.usa.gov/real-id), [6 CFR Part 37](https://www.govinfo.gov/link/cfr/6/37?link-type=pdf&year=mostrecent), [6 CFR 37.17 current mirror](https://www.law.cornell.edu/cfr/text/6/37.17)

New York CPL 140.50 governs specific stops and has a restriction on certain electronic identity recording after stops in large cities. It supplies no universal list of fields for an openly searchable private database. [NY Senate](https://www.nysenate.gov/legislation/laws/CPL/140.50)

New York GBL 899-bb requires reasonable safeguards and appropriate disposal for covered private information. [NY Senate](https://www.nysenate.gov/legislation/laws/GBS/899-BB)

NIST SP 800-63A-4, final July 2025, is a reference for proofing and enrollment controls. No NIST assurance-level certification or compliance claim has been made. [NIST](https://csrc.nist.gov/pubs/sp/800/63/a/4/final)

Provider design follows session reuse, idempotency, signed webhooks and restricted access to results. [Stripe sessions](https://docs.stripe.com/identity/verification-sessions), [Stripe result access](https://docs.stripe.com/identity/access-verification-results)

The legal review covers a limited U.S./New York foundation. No worldwide identification or travel acceptance assessment is complete. Individual immigration outcomes require the competent agencies, courts and qualified counsel.

## Verification

Five Node tests cover reference format, public data projection, concurrent duplicate callbacks in an in-memory transactional model, session binding, revocation and NFT opt-in. This model is not a Firestore emulator test. The module loaded with installed dependencies and passed syntax checks.

The public pages passed headless Edge/Playwright checks at 1440 × 1000 and 390 × 844, including invalid and valid-format lookup input, honest prelaunch messaging, sample reveal, avatar backdrop changes and horizontal overflow checks. Browser plugin was not available. No live KYC, blockchain transaction, private-record disclosure or jurisdictional recognition was tested.

## Artwork and printing

The built-in image generation tool refined the supplied flag into a 3:2 white flag with lavender and rose forms, cyan/purple/dark sweeping curves, a crimson four-point star, a green/lime central emblem and a hollow circle. It is a community adoption proposal. The sample avatar prompt requested an original Terraria-like pixel adventurer with dark hair, an emerald coat, lavender scarf and a rose accent on a transparent background. No government seal or issuer designation was added.

Print the declaration on US Letter at actual size. Card PDF pages are 85.60 × 53.98 mm and contain a front and back specimen. Printing those tiny PDF pages on Letter stock requires positioning and duplex alignment in the print application. The PNG card images are also provided.
