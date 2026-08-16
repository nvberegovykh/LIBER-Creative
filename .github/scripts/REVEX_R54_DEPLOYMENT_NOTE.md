# r54 deployment boundary

Infrastructure administrator actions are intentionally separate from end-user rendering.

`server/revex-render-worker/DEPLOY_RENDER_SERVER.cmd` may require an already-authenticated Google Cloud CLI and Firebase CLI session. Those are deployment credentials only. They are never requested by REVEX users and are never copied into the render service.

After deployment, the normal path is: existing LIBER sign-in → project-scoped render job → authenticated Firebase broker → private Cloud Run GPU → project Storage result. The Qwen model origin is public and exact-revision pinned, so no Hugging Face login/token is part of either the client or worker contract.
