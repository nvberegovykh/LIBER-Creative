#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import revex_cloud_project as cloud_project

HERE = Path(__file__).resolve().parent


def _clear_project_env() -> dict[str, str | None]:
    keys = ("REVEX_VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT")
    prior = {key: os.environ.get(key) for key in keys}
    for key in keys:
        os.environ.pop(key, None)
    return prior


def _restore(prior: dict[str, str | None]) -> None:
    for key, value in prior.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def main() -> None:
    prior = _clear_project_env()
    try:
        os.environ["REVEX_VERTEX_PROJECT"] = "liber-apps-cca20"
        assert cloud_project.resolve_vertex_project() == "liber-apps-cca20"

        # REVEX application ids are not legal Google Cloud project ids and can never
        # become a Vertex routing fallback. ADC must supply the actual cloud project.
        os.environ["REVEX_VERTEX_PROJECT"] = "revex_mspgzb7h_729b2936bfaa"
        with patch("google.auth.default", return_value=(object(), "liber-apps-cca20")):
            assert cloud_project.resolve_vertex_project() == "liber-apps-cca20"

        os.environ.pop("REVEX_VERTEX_PROJECT", None)
        os.environ["GOOGLE_CLOUD_PROJECT"] = "other-valid-project1"
        with patch("google.auth.default", return_value=(object(), "ignored-project1")):
            assert cloud_project.resolve_vertex_project() == "other-valid-project1"

        _clear_project_env()
        with patch("google.auth.default", return_value=(object(), "adc-project-123")):
            assert cloud_project.resolve_vertex_project() == "adc-project-123"

        with patch("google.auth.default", return_value=(object(), None)):
            try:
                cloud_project.resolve_vertex_project()
            except RuntimeError as exc:
                assert "Google Cloud project" in str(exc)
            else:
                raise AssertionError("missing Vertex project must fail closed")
    finally:
        _restore(prior)

    content_agent = (HERE / "revex_identity_content_agent.py").read_text(encoding="utf-8")
    assert "from revex_cloud_project import resolve_vertex_project" in content_agent
    assert "project = resolve_vertex_project()" in content_agent
    assert 'or ""' not in content_agent.split("def _run_content_agent", 1)[1].split("location =", 1)[0]

    for script_name in ("DEPLOY_ENERGY_WORKER_ONLY_R69.ps1", "DEPLOY_ENERGY_CURRENT.ps1"):
        text = (HERE / script_name).read_text(encoding="utf-8")
        assert '$VertexProject = $ProjectId' in text, script_name
        assert '$VertexLocation = "global"' in text, script_name
        assert "REVEX_VERTEX_PROJECT=$VertexProject" in text, script_name
        assert "REVEX_VERTEX_LOCATION=$VertexLocation" in text, script_name
        assert "Live worker Vertex AI project" in text, script_name

    for path in (HERE / "revex_cloud_project.py", HERE / "revex_identity_content_agent.py"):
        upper = path.read_text(encoding="utf-8").upper()
        assert "250 MIDWOOD" not in upper
        assert "79 WINTHROP" not in upper

    print("REVEX_R98_VERTEX_PROJECT_BINDING=PASSED")


if __name__ == "__main__":
    main()
