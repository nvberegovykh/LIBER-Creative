# REVEX r98 Vertex project binding

`projectId` in a REVEX Engineering revision is the REVEX application/Firestore project identity. It is **not** a Google Cloud project id and must never be used as a Vertex AI routing fallback.

Managed AI routing is now resolved independently through:

1. `REVEX_VERTEX_PROJECT` (explicit deployment binding),
2. standard Google Cloud project environment variables,
3. Application Default Credentials project metadata.

The canonical worker deployment binds `REVEX_VERTEX_PROJECT` to the deployment `ProjectId` (`liber-apps-cca20` in production) and verifies the live Cloud Run environment before declaring PASS. The current-session repair can update only these environment variables on the already deployed worker image; it does not rebuild the image, redeploy the broker, touch Revit, change GeometryCo, or relax any QA threshold.
