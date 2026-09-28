# RFA assets without a separate conversion service

Use supplier-provided GLB/glTF, IFC, FBX, OBJ or STL when available. REVEX imports those locally in the browser and stores a self-contained GLB with a project-owned placement record. Saved assets can be placed again without downloading or converting the original family again.

For RFA-only content, the practical route using an existing Revit license is a one-time export of each required family type from a 3D view, followed by the same browser import. Autodesk documents OBJ/STL export from the family workflow. Confirm units and size in the REVEX preview. Include companion material/texture files with OBJ, or package one model and its resources in a ZIP. STL carries geometry only.

An RVX family should ultimately be a reusable asset record around that geometry, with the original family/type identity, source product URL, units, material references and placement anchor. It should not be a renamed RFA or promise native Revit behavior. The current placed-asset record provides normalized geometry, integrity hash, provider, floor, pose and source model revision; a full cross-project family catalogue and automated native converter are future work.

Browser placement is visual geometry. It does not reproduce Revit formulas, editable type parameters, host relationships or wall cuts. Those still belong to the original RFA/Revit workflow.

No paid APS or ODA service was connected. APS has a capped free tier, which is not an unlimited production conversion entitlement; ODA BimRv requires a paid membership/module. Existing application storage and hosting costs still apply. Do not repurpose a named-user desktop Revit installation as a shared public conversion service without confirming the applicable Autodesk terms.

Primary references checked September 28, 2026:

- [Autodesk: converting an RFA through a 3D export](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-do-I-convert-an-RFA-file-to-a-STEP-file-without-using-Revit-software.html)
- [Autodesk: export an OBJ file](https://help.autodesk.com/cloudhelp/2023/ENU/RevitLT-DocumentPresent/files/GUID-47381321-3EB4-4E41-B7CC-41AC915EE16D.htm)
- [APS free and paid tiers](https://www.autodesk.com/products/autodesk-platform-services/overview)
- [ODA BimRv licensing](https://www.opendesign.com/faq/bimrv)
