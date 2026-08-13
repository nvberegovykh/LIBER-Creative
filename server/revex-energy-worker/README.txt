REVEX MANAGED ENERGY WORKER — 0.8.19-r44 RELEASE BUNDLE

PRODUCTION BOUNDARY
Revit produces only the immutable Engineering Sync revision that clears >=80% in every evidence domain. The managed chain runs in private Cloud Run; it never writes results back to Revit and never inserts a filing PDF into the RVT.

ACCESS
The worker is private and only revex-energy-broker@liber-apps-cca20.iam.gserviceaccount.com may invoke it. The authenticated Firebase callable verifies the requesting user is the project owner, a project member, or a LIBER admin. Outsiders and cross-project artifact paths are rejected.

AUTOMATIC FLOW
Companion uploads the immutable revision -> broker verifies user/project/revision -> worker verifies hashes, gate and EPW -> reads only visible immutable Revit EN/Z page PDFs -> GeometryCo -> Baseline/Proposed OpenStudio 3.10 + EnergyPlus -> review package -> exact 16-page EN-1 PDF + workbook -> current-project COMcheck CXL + audit -> Storage/Firestore -> Companion.

IDENTITY AND FILING
Project identity comes only from current Revit Z pages. Current model/code/envelope/lighting facts come only from current EN pages. The approved EN-1 and COMcheck files are structure/enum templates; their project identity is cleared and regression-checked. Applicant and lead-modeler values remain blank. Professional execution is never fabricated.

RETRY
r44 retries an incomplete result for the same immutable Engineering revision once after Companion refresh. Do not rerun BIM + Books or SYNC ENGINEERING merely to retry the managed chain.

DEPLOY
Run PUBLISH_REVEX_R44.cmd from the LIBER_REVEX_0.8.19_SOURCE root. The publisher verifies hash-locked source and the restored COMcheck dependency, runs offline identity/filing QA, builds the immutable 0.8.19-r44 image, deploys the Firebase broker, removes non-broker Cloud Run invokers, and verifies the live services.
