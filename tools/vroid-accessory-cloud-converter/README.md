# VRoid 2.14 Accessory Cloud Converter

Zero local Unity/Blender/Python/Node installs. Open `index.html` or `OPEN.cmd`; Pinokio can open the same HTML.

## Authority model

- Public code authority: `nvberegovykh/LIBER-Creative`, branch `vroid-accessory-cloud-converter`.
- Private worker authority: `nvberegovykh/archive`, branch `vroid-cloud-worker`.
- Source accessories and outputs never enter the public repository. Each conversion uses a transient private `vroid-job-*` branch.
- The browser token is held only in page memory. No localStorage/cookies.
- Recommended fine-grained token: only `nvberegovykh/archive`, `Contents: read/write`. `Secrets: read/write` is optional and only needed for the one-time cloud Unity activation panel.
- The worker fetches the official XWear Packager at runtime through its VPM feed; the proprietary XWear Packager is not copied into this public project.
- The browser deletes the transient branch after verified output download. GitHub may retain unreachable Git objects until repository garbage collection, so branch deletion is not a cryptographic erase guarantee.

## One-time Unity CI activation

Unity's editor requires an activated license even when it runs only in cloud CI. GameCI's current flow uses `UNITY_EMAIL`, `UNITY_PASSWORD`, plus `UNITY_LICENSE` for Personal or `UNITY_SERIAL` for Pro. If your previous local Unity run activated a Personal license, Windows normally stores the tiny license file at `C:\ProgramData\Unity\Unity_lic.ulf`. Selecting that file in the converter does not install Unity.

The converter encrypts secret values with GitHub's repository public key in-browser and sends them directly to the GitHub Actions Secrets API. They are not committed.
