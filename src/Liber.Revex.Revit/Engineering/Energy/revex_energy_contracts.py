#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Mapping
import hashlib
import json


class ArtifactKind(str, Enum):
    PROJECT_IDENTITY = "project_identity"
    PAGE_FACTS = "page_facts"
    SCHEDULE_EVIDENCE = "schedule_evidence"
    GBXML = "gbxml"
    WEATHER = "weather"
    BASELINE_OSM = "baseline_osm"
    PROPOSED_OSM = "proposed_osm"
    EN1_WORKBOOK = "en1_workbook"
    EN1_PDF = "en1_pdf"
    COMCHECK_CXL = "comcheck_cxl"
    COMCHECK_REPORT = "comcheck_report"
    COMCHECK_RESULT = "comcheck_result"
    PIPELINE_RESULT = "pipeline_result"
    RELEASE_PACKAGE = "release_package"


@dataclass(frozen=True)
class ArtifactSpec:
    kind: ArtifactKind
    canonical_name: str
    aliases: tuple[str, ...] = ()
    required_for_sync: bool = False
    required_for_complete: bool = False

    @property
    def accepted_names(self) -> tuple[str, ...]:
        return (self.canonical_name, *self.aliases)


# Output filenames are a public package boundary only. Internal evidence is resolved by role/capability.
SPECS: tuple[ArtifactSpec, ...] = (
    ArtifactSpec(ArtifactKind.PROJECT_IDENTITY, "REVIT-PROJECT-IDENTITY.json", required_for_sync=True),
    ArtifactSpec(ArtifactKind.PAGE_FACTS, "00_PAGE_FACTS.json", required_for_sync=True),
    ArtifactSpec(ArtifactKind.SCHEDULE_EVIDENCE, "REVIT-SCHEDULE-EVIDENCE.json", required_for_sync=True),
    ArtifactSpec(ArtifactKind.GBXML, "revit-energy.xml", required_for_sync=True),
    ArtifactSpec(ArtifactKind.WEATHER, "weather.epw", required_for_sync=True),
    ArtifactSpec(ArtifactKind.BASELINE_OSM, "BASELINE_UPDATED_GEOMETRY.osm", required_for_complete=True),
    ArtifactSpec(ArtifactKind.PROPOSED_OSM, "PROPOSED_UPDATED_GEOMETRY.osm", required_for_complete=True),
    ArtifactSpec(ArtifactKind.EN1_WORKBOOK, "EN-1_READY_TO_INSERT.xlsx", required_for_complete=True),
    ArtifactSpec(ArtifactKind.EN1_PDF, "EN-1_READY_TO_INSERT.pdf"),
    ArtifactSpec(ArtifactKind.COMCHECK_CXL, "COMcheck_PROJECT_INPUT_READY.cxl", required_for_complete=True),
    ArtifactSpec(ArtifactKind.COMCHECK_REPORT, "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf", required_for_complete=True),
    ArtifactSpec(ArtifactKind.COMCHECK_RESULT, "COMcheck_BACKSTOP_RESULT.json", required_for_complete=True),
    ArtifactSpec(ArtifactKind.PIPELINE_RESULT, "energy-result.json"),
    ArtifactSpec(ArtifactKind.RELEASE_PACKAGE, "REVEX_ENERGY_RELEASE_PACKAGE.zip", ("REVEX_RECOVERY_PACKAGE.zip",)),
)
SPEC_BY_KIND = {spec.kind: spec for spec in SPECS}
PACKAGE_NAME_TO_KIND = {name.lower(): spec.kind for spec in SPECS for name in spec.accepted_names}

ROLE_TO_KIND = {
    "revit-project-identity": ArtifactKind.PROJECT_IDENTITY,
    "revit-schedule-evidence": ArtifactKind.SCHEDULE_EVIDENCE,
    "gbxml": ArtifactKind.GBXML,
    "weather-epw": ArtifactKind.WEATHER,
}
REQUEST_PATH_TO_KIND = {
    "pageFactsPath": ArtifactKind.PAGE_FACTS,
    "gbxmlPath": ArtifactKind.GBXML,
    "weatherFile": ArtifactKind.WEATHER,
}


class ContractError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class ArtifactRef:
    kind: ArtifactKind
    path: Path
    bytes: int
    sha256: str
    role: str = ""

    @classmethod
    def from_path(cls, kind: ArtifactKind, path: Path, role: str = "") -> "ArtifactRef":
        path = Path(path).resolve()
        if not path.is_file():
            raise ContractError(f"{kind.value} artifact is missing: {path}")
        return cls(kind=kind, path=path, bytes=path.stat().st_size, sha256=_sha256(path), role=role)


@dataclass
class EvidenceBundle:
    revision: str
    project_id: str
    artifacts: dict[ArtifactKind, ArtifactRef] = field(default_factory=dict)

    @classmethod
    def from_request(cls, request_path: Path) -> "EvidenceBundle":
        request_path = Path(request_path).resolve()
        payload = json.loads(request_path.read_text(encoding="utf-8"))
        bundle = cls(
            revision=str(payload.get("revision") or payload.get("sourceEngineeringRevision") or "").strip(),
            project_id=str(payload.get("projectId") or payload.get("project") or "").strip(),
        )

        local_paths: list[Path] = []
        for raw in payload.get("sourceArtifacts") or []:
            try:
                local_paths.append(Path(str(raw)).resolve())
            except Exception:
                continue
        by_name = {path.name.casefold(): path for path in local_paths if path.is_file()}

        # Direct request fields are typed capabilities produced by the worker boundary.
        for key, kind in REQUEST_PATH_TO_KIND.items():
            raw = payload.get(key)
            if raw:
                bundle._add(kind, Path(str(raw)), role=f"request:{key}")

        # Immutable Engineering manifest declares source evidence by semantic role.
        manifest_raw = payload.get("engineeringManifestPath")
        if manifest_raw:
            manifest_path = Path(str(manifest_raw)).resolve()
            if not manifest_path.is_file():
                raise ContractError(f"Engineering manifest is missing: {manifest_path}")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest_revision = str(manifest.get("revision") or "").strip()
            manifest_project = str(manifest.get("projectId") or "").strip()
            if manifest_revision and manifest_revision != bundle.revision:
                raise ContractError("Engineering manifest revision does not match the Energy request")
            if manifest_project and manifest_project != bundle.project_id:
                raise ContractError("Engineering manifest project does not match the Energy request")
            for row in manifest.get("artifacts") or []:
                role = str(row.get("role") or "").strip().casefold()
                kind = ROLE_TO_KIND.get(role)
                if kind is None:
                    continue
                declared_name = Path(str(row.get("name") or "")).name.casefold()
                local = by_name.get(declared_name)
                if local is None:
                    raise ContractError(f"Engineering capability {role} is declared but its local artifact is missing")
                ref = bundle._add(kind, local, role=role)
                expected_bytes = int(row.get("bytes") or 0)
                expected_hash = str(row.get("sha256") or "").strip().casefold()
                if expected_bytes and ref.bytes != expected_bytes:
                    raise ContractError(f"Engineering capability {role} failed byte-count integrity")
                if expected_hash and ref.sha256.casefold() != expected_hash:
                    raise ContractError(f"Engineering capability {role} failed SHA-256 integrity")
        return bundle

    def _add(self, kind: ArtifactKind, path: Path, role: str = "") -> ArtifactRef:
        ref = ArtifactRef.from_path(kind, path, role=role)
        prior = self.artifacts.get(kind)
        if prior and prior.sha256 != ref.sha256:
            raise ContractError(f"conflicting {kind.value} capabilities in one Engineering revision")
        self.artifacts[kind] = ref
        return ref

    def require_sync_evidence(self) -> "EvidenceBundle":
        missing = [spec.kind.value for spec in SPECS if spec.required_for_sync and spec.kind not in self.artifacts]
        if missing:
            raise ContractError("Engineering evidence bundle is incomplete: " + ", ".join(missing))
        if not self.revision:
            raise ContractError("Engineering evidence bundle has no immutable revision id")
        if not self.project_id:
            raise ContractError("Engineering evidence bundle has no project id")
        return self


@dataclass
class FilingPackage:
    root: Path
    artifacts: dict[ArtifactKind, ArtifactRef] = field(default_factory=dict)

    @classmethod
    def discover(cls, root: Path) -> "FilingPackage":
        root = Path(root).resolve()
        package = cls(root=root)
        if not root.is_dir():
            return package
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            kind = PACKAGE_NAME_TO_KIND.get(path.name.casefold())
            if kind is None:
                continue
            package.artifacts[kind] = ArtifactRef.from_path(kind, path, role="package-output")
        return package

    def require_complete(self) -> "FilingPackage":
        missing = [spec.kind.value for spec in SPECS if spec.required_for_complete and spec.kind not in self.artifacts]
        if missing:
            raise ContractError("Energy filing package is incomplete: " + ", ".join(missing))
        return self

    def canonical_names(self) -> Mapping[str, str]:
        return {kind.value: ref.path.name for kind, ref in self.artifacts.items()}


DEFAULT_MISSING_VT = 0.45


def required_complete_names() -> set[str]:
    return {spec.canonical_name for spec in SPECS if spec.required_for_complete}
