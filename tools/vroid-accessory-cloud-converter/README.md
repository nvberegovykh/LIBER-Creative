# VRoid 2.14 Accessory Converter — test build

Zero local toolchain installs. Open `index.html` directly, double-click `OPEN.cmd`, or open the package in Pinokio.

## First test
1. Create a GitHub fine-grained personal access token restricted to the private repository `nvberegovykh/archive`.
2. Give that token only **Contents: Read and write** repository permission.
3. Paste it into the converter. The token exists only in page memory and is not stored by the app.
4. Select a `.unitypackage`, or a `.zip` containing exactly one `.unitypackage`.
5. Leave scale at `1.00` for the first run and click **Convert in private cloud**.
6. Save the generated `.xwear` files, then press **Delete transient private branch**.

The worker creates Pair / Left / Right variants when left/right mesh names can be recognized. For ThreeStarPierce, the neutral model's mirrored `L_01…05` and `R_01…05` objects are recognized.

## Boundaries
- Public code: `nvberegovykh/LIBER-Creative`, branch `vroid-accessory-cloud-converter`.
- Private transient inputs/outputs: `nvberegovykh/archive`, branches `vroid-job-*`.
- Target: VRoid Studio 2.14.0 XWear v2.
- Source copyright/license/ownership is not changed by conversion.
- This test build converts geometry and self-contained Standard material color/metallic/smoothness. lilToon-specific visual effects and texture channels are not redistributed by the converter yet.
- No GitHub Actions artifact storage is used; results are returned through the transient private branch.

Production `LIBER-Creative/main` is not part of this workflow.
