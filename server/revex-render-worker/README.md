# REVEX private renderer r54

Default REVEX image generation runs outside Revit and the Companion browser on a private Cloud Run GPU service.

- Model: `Qwen/Qwen-Image-Edit-2511`
- Immutable revision: `6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9`
- License: Apache-2.0
- Model origin: public Hugging Face repository, no HF account/token required
- Browser inference: none
- Worker ingress: authenticated only; the Firebase render broker is the invoker
- GPU concurrency: one inference at a time
- Source authority: clean snapshot of the current REVEX BIM viewport + exact camera metadata
- Geometry policy: rendering may change appearance, lighting and atmosphere; it must not alter BIM geometry
- Google Gemini: explicit fallback only

The public model is pinned by exact revision. A cold worker downloads that immutable revision and reuses the Hugging Face cache for its instance lifetime. `REVEX_MODEL_PATH` may later point at a private immutable cache without changing the approved model identity or requiring any end-user credential.

`DEPLOY_RENDER_SERVER.cmd` is the one-time infrastructure deployment entry point. It creates/verifies the private worker/broker identities, builds the worker, deploys the RTX PRO 6000 Cloud Run service with scale-to-zero, grants only the broker invocation access, and deploys the dedicated Firebase callable broker. End users continue to use their existing LIBER sign-in only.
