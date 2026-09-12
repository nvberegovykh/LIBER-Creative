# VRoid 2.14 Accessory Converter — R2.6.2

Clean-room Unity-package → XWear v2 conversion for VRoid Studio 2.14.0. The private worker reconstructs the accessory from the source FBX/prefab, preserves creator logical object boundaries, fitting transforms, skinning/bind poses, and translates supported source motion into VRM1 SpringBone metadata.

Produced by ChatGPT 5.6 Sol

## Use

1. Open `OPEN.cmd` (or the Pinokio package) and connect the temporary browser session to the private `nvberegovykh/archive` worker repository.
2. Select a `.unitypackage`, or a `.zip` containing exactly one `.unitypackage`.
3. Convert in private cloud, inspect the generated preview, then save Pair / Left / Right `.xwear` variants as applicable.
4. Delete the transient private `vroid-job-*` branch after verified download.

The browser keeps the GitHub credential only in the JavaScript memory of that tab; no converter token is written to localStorage, cookies, registry, environment variables, or a config file.

## R2.6.2 behavior

- Preserves creator static-vs-skinned renderer identity rather than trusting unstable `_04` / `_05` names. This fixes the ThreeStarPierce floating-star failure without deleting any source object: a raw static mesh is mapped to a static prefab renderer slot, and the skinned mesh is mapped to the corresponding skinned slot.
- Emits real XWear `SkinnedMeshRenderer` resources with per-vertex weights, bone references, and bind poses. Static objects remain `MeshFilter` resources and carry no fake skin payload.
- Uses `Earring_Root` as the fitting/rig origin for the adaptive hierarchy.
- Treats the ear attachment as the constrained/root region and allows motion only along the downstream source bone branches. Source `EarringL##`, `EarringR##`, and `EarringRU##` naming is classified explicitly so a right-hand chain cannot leak into a Left-only export.
- Converts source VRC PhysBone-like settings to VRM1 SpringBone approximately: stiffness uses the stronger source pull/stiffness term, drag is derived from spring, gravity and joint radius are preserved where available. Source `immobile` has no direct VRM1 equivalent and is not fabricated.
- Keeps the R2.5.2 XWear mesh binary fix: bone weights → bind poses → submeshes.

## Real ThreeStarPierce validation

Production worker run `34664398106` completed successfully with `errors: []` using the established fit: scale `1.17`, offset `(0.0159, 0.2277, 0.0319)`, rotation `(-0.9, -56.95, -1.29)` degrees.

- Left: 5 logical objects, 1 skinned object, 1 spring / 4 joints. SHA-256 `eb7be96852be54cc1613eb3af6e185e8ba3a8c9402f757ac6bd90e93b4c746e7`.
- Pair: 10 logical objects, 2 skinned objects, 3 springs / 11 joints. SHA-256 `479d34e3766266bc675789c1bc7d9a42d4da87996fa6ffbeb0d1d3b5cadb1f67`.
- Right: 5 logical objects, 1 skinned object, 2 springs / 7 joints. SHA-256 `0df6751cdfb5681041919b0c07d56d422bec2e06b7b6c634727436bb6ad3ca0c`.

For the dynamic meshes, the real run validated weight count == vertex count and bind-pose count == bone count (Left 1176/1176 weights with 6 bind poses; Right 3398/3398 with 9 bind poses). The worker also validates that Left/Right spring references do not cross sides.

## Boundaries

Public code: `nvberegovykh/LIBER-Creative`, branch `vroid-accessory-cloud-converter`. Private transient inputs/outputs: `nvberegovykh/archive`, branches `vroid-job-*`. Private worker authority: `nvberegovykh/archive:vroid-cloud-worker`.

The conversion path is schema-, binary-, hierarchy-, and worker-validated. It does **not** run VRoid Studio itself, so the final visual/import check should still be performed locally in VRoid Studio 2.14.0. Shader-specific source effects are approximated by self-contained material values; source copyright/license/ownership is unchanged.
