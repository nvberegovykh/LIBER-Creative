# REVEX r54 self-hosted render acceptance

The default render path is accepted only when all of the following remain true:

1. The browser captures the clean current REVEX BIM viewport and camera, then returns control immediately to the UI event loop. It never loads model weights or performs GPU inference.
2. The existing authenticated LIBER/Firebase session creates the project render job; there is no Hugging Face sign-in, token field, account selector, or model-provider permission prompt.
3. The broker verifies project membership, writes the source snapshot under the same project/job namespace, and invokes a private Cloud Run service with a Google identity token.
4. The worker resolves only `Qwen/Qwen-Image-Edit-2511` revision `6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9`, explicitly without a HF token. A future `REVEX_MODEL_PATH` may supply the same immutable bytes from a private cache.
5. The worker refuses an undersized/non-CUDA GPU, loads directly with `device_map="cuda"`, serializes inference, and reports progress through the existing render job.
6. Gemini/Nano Banana remains available only as an explicit fallback. Rendair routing must not return.
7. BIM presentation changes are additive. Element selection/tree data, reversible hide/delete/restore, six-face section box, Fit/Model/Walk, exact source revision behavior, and clean render capture remain functional.
8. Rooms/Spaces and other spatial analytical objects remain invisible in the BIM presentation layer.
9. The accepted-gbXML Energy regression remains locked: an export meeting the >=80% publication floor may carry strict-review warnings below the 95% target, but only the legacy `REVIT_TO_GBXML_GEOMETRY_INTEGRITY_FAILED` marker is reconciled to review severity. Below-floor geometry or unrelated fatal errors remain fatal.

Automated guard: `.github/scripts/verify-revex-r54-selfhost-render.js`.
