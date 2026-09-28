# RFA conversion: automatic browser workflow

The required workflow is browser-only for designers. Manual Revit export is not the proposed product solution. Supported GLB/glTF, IFC, FBX, OBJ, STL and ZIP assets already import in the browser and persist as project-owned GLB placements.

RFA conversion remains unavailable until an Autodesk developer application is connected. The UI must state this plainly and must not claim that downloading an RFA has placed it.

The proposed implementation is Autodesk Automation for Revit running an app bundle that opens the family, evaluates the chosen type and exports tessellated geometry/materials to GLB. An RVX family record wraps that geometry with the original file hash, type, source product URL, units, materials and floor anchor. Cache privately by tenant, content hash, type and converter version. Place the result through the existing browser placement path. This is an implementation recommendation, not a deployed feature.

Autodesk Developer Support says Model Derivative does not directly translate RFA; Automation is the supported cloud route. Autodesk's current Free tier has monthly Automation limits and suspends usage at the cap unless the account opts into a paid offering. Check the actual developer hub entitlement after sign-in. Do not enroll in paid usage, assume a desktop subscription grants unlimited conversion, or promise unrestricted free conversion. No paid Autodesk service was enabled during this audit.

Visual placement does not reproduce Revit formulas, host relationships or parametric editing. Preserve original RFA provenance for future reconciliation; do not rename an RFA to GLB/RVX.

Primary references checked September 28, 2026:

- [Autodesk Developer Support: RFA requires Automation rather than direct Model Derivative translation](https://forums.autodesk.com/t5/revit-api-forum/how-to-translate-rfa-file-to-svf-format/m-p/13414911/highlight/true)
- [Autodesk: APS Free tier, monthly caps and paid opt-in](https://aps.autodesk.com/blog/aps-business-model-evolution)
