# VRoid 2.14 Accessory Converter — test build 2

Zero local toolchain installs. Double-click `OPEN.cmd` for a temporary localhost shell, or open the package through Pinokio.

## First connection
The main converter no longer exposes an access-token field. Press **Connect GitHub** and use the small setup dialog:

1. **Open GitHub key setup** opens GitHub's official fine-grained-token form with resource owner `nvberegovykh`, a 7-day test expiry, and **Contents: Read and write** prefilled.
2. GitHub does not expose selected-repository choice as a supported URL-prefill parameter. Choose **Repository access → Only select repositories → archive**.
3. Press **Generate token** on GitHub and copy it.
4. Back in the converter press **Paste copied key & connect**. If clipboard access is blocked, use **Paste manually**.
5. After verification the visible field is cleared. The key remains only in the JavaScript memory of that tab: no cookies, localStorage, registry entry, environment variable, or config file is used. **Forget access** drops it immediately.

Official GitHub token template behavior is documented at:
https://docs.github.com/en/enterprise-cloud@latest/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters

## Conversion test
1. Select a `.unitypackage`, or a `.zip` containing exactly one `.unitypackage`.
2. Leave scale at `1.00` for the first run and click **Convert in private cloud**.
3. Save the generated `.xwear` files.
4. Press **Delete transient private branch** after saving results.

The worker creates Pair / Left / Right variants when left/right mesh names can be recognized. For ThreeStarPierce, the neutral model's mirrored `L_01…05` and `R_01…05` objects are recognized.

## Boundaries
- Public code: `nvberegovykh/LIBER-Creative`, branch `vroid-accessory-cloud-converter`.
- Private transient inputs/outputs: `nvberegovykh/archive`, branches `vroid-job-*`.
- Target: VRoid Studio 2.14.0 XWear v2.
- Source copyright/license/ownership is not changed by conversion.
- This test build converts geometry and self-contained Standard material color/metallic/smoothness. lilToon-specific visual effects and texture channels are not redistributed by the converter yet.
- No GitHub Actions artifact storage, Unity editor, GPU runner, Blender, VPM, local Python, or local Node is required.
- Current private compute is a small standard Linux GitHub Actions job using Node + assimpjs. It still counts as normal private-repository Actions usage according to the account's GitHub plan; there is no separate GPU/Unity cost in this path.

Production `LIBER-Creative/main` is not part of this workflow.

## Verified gates
- Public clean-room XWear writer self-test: PASS, GitHub Actions run `34508904785`.
- Private worker transport + conversion + private result publishing: PASS, run `34509912518`.
- `OPEN.cmd` starts only a temporary loopback HTTP shell using Windows PowerShell/.NET and opens the page in your browser; it installs nothing.
