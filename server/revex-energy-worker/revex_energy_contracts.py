#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Iterable, Mapping
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


SPECS: tuple[ArtifactSpec, ...] = (
    ArtifactSpec(ArtifactKind.PROJECT_IDENTITY, "REVIT-PROJECT-IDENTITY.json", ("revit-project-identity.json",), True),
    ArtifactSpec(ArtifactKind.PAGE_FACTS, "00_PAGE_FACTS.json", ("page-facts.json", "00_PAGE_FACTS_FINAL_TOUCHUPS_R125.json"), True),
    ArtifactSpec(ArtifactKind.SCHEDULE_EVIDENCE, "REVIT-SCHEDULE-EVIDENCE.json", (), True),
    ArtifactSpec(ArtifactKind.GBXML, "revit-energy.xml", ("energy.xml",), True),
    ArtifactSpec(ArtifactKind.WEATHER, "weather.epw", (), True),
    ArtifactSpec(ArtifactKind.BASELINE_OSM, "BASELINE_UPDATED_GEOMETRY.osm", (), required_for_complete=True),
    ArtifactSpec(ArtifactKind.PROPOSED_OSM, "PROPOSED_UPDATED_GEOMETRY.osm", (), required_for_complete=True),
    ArtifactSpec(ArtifactKind.EN1_WORKBOOK, "EN-1_READY_TO_INSERT.xlsx", (), required_for_complete=True),
    ArtifactSpec(ArtifactKind.EN1_PDF, "EN-1_READY_TO_INSERT.pdf"),
    ArtifactSpec(ArtifactKind.COMCHECK_CXL, "COMcheck_PROJECT_INPUT_READY.cxl", (), required_for_complete=True),
    ArtifactSpec(ArtifactKind.COMCHECK_REPORT, "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf", (), required_for_complete=True),
    ArtifactSpec(ArtifactKind.COMCHECK_RESULT, "COMcheck_BACKSTOP_RESULT.json", (), required_for_complete=True),
    ArtifactSpec(ArtifactKind.PIPELINE_RESULT, "energy-result.json"),
    ArtifactSpec(ArtifactKind.RELEASE_PACKAGE, "REVEX_ENERGY_RELEASE_PACKAGE.zip", ("REVEX_RECOVERY_PACKAGE.zip",)),
)

SPEC_BY_KIND = {spec.kind: spec for spec in SPECS}
NAME_TO_KIND = {
    name.lower(): spec.kind
    for spec in SPECS
    for name in spec.accepted_names
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

    @classmethod
    def from_path(cls, kind: ArtifactKind, path: Path) -> "ArtifactRef":
        path = Path(path).resolve()
        if not path.is_file():
            raise ContractError(f"{kind.value} artifact is missing: {path}")
        return cls(kind=kind, path=path, bytes=path.stat().st_size, sha256=_sha256(path))


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
        candidates: list[Path] = []
        for raw in payload.get("sourceArtifacts") or []:
            try:
                candidates.append(Path(str(raw)).resolve())
            except Exception:
                continue
        for key in ("pageFactsPath", "weatherPath", "gbxmlPath", "projectIdentityPath"):
            raw = payload.get(key)
            if raw:
                candidates.append(Path(str(raw)).resolve())
        bundle._index(candidates)
        return bundle

    def _index(self, paths: Iterable[Path]) -> None:
        for path in paths:
            if not path.is_file():
                continue
            kind = NAME_TO_KIND.get(path.name.lower())
            if kind is None:
                suffix = path.suffix.lower()
                if suffix == ".epw":
                    kind = ArtifactKind.WEATHER
                elif suffix in {".xml", ".gbxml"} and "energy" in path.name.lower():
                    kind = ArtifactKind.GBXML
            if kind is None:
                continue
            ref = ArtifactRef.from_path(kind, path)
            prior = self.artifacts.get(kind)
            if prior and prior.sha256 != ref.sha256:
                raise ContractError(f"multiple conflicting {kind.value} artifacts in one Engineering revision")
            self.artifacts[kind] = ref

    def require_sync_evidence(self) -> "EvidenceBundle":
        missing = [spec.kind.value for spec in SPECS if spec.required_for_sync and spec.kind not in self.artifacts]
        if missing:
            raise ContractError("Engineering evidence bundle is incomplete: " + ", ".join(missing))
        if not self.revision:
            raise ContractError("Engineering evidence bundle has no immutable revision id")
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
            kind = NAME_TO_KIND.get(path.name.lower())
            if kind is None:
                continue
            package.artifacts[kind] = ArtifactRef.from_path(kind, path)
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
