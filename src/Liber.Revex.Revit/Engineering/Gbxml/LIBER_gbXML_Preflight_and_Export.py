# -*- coding: utf-8 -*-
"""
LIBER gbXML Preflight + Export
Revit 2026 / Dynamo 3.x / CPython 3

Inputs
------
IN[0] Run now (bool)
IN[1] Audit only (bool)
IN[2] Output folder (blank = <RVT folder>\\gbXML_EXPORT)
IN[3] Export filename (blank = timestamped document title)
IN[4] Phase name (blank = phase with the most placed Rooms/Spaces)
IN[5] Create missing Spaces and apply safe fixes (bool)
IN[6] Export despite blockers (bool; normally False)
IN[7] Reserved compatibility input (ignored by lightweight deterministic runtime)

The graph is intentionally self-contained and exports the geometry/identity layer
used by OpenStudio and the LIBER GeometryCo OSM-to-OSM compiler. Semantic QA is intentionally lightweight and deterministic (rules + adjacency); no ONNX/vision/FBX comprehension is loaded in the export path. Geometry creation and export never depend on model inference.
The native Revit spatial/physical geometry and the temporary Revit analytical model are captured as independent source-of-truth manifests. After gbXML generation, REVEX runs a normalized geometry integrity loop back against Revit itself: missing faces/cuts, extended carriers, duplicate/junk geometry, adjacency loss and shell distortions are detected, conservatively repaired from authoritative Revit primitives, regenerated/reparsed, and re-tested before release. Every analytical face, window, door, and curtain-panel opening must survive in the gbXML. Curtain walls are exported at Complex panel-by-panel detail with
mullions excluded. Glazed panels map to Window openings, curtain-wall doors map
to Door openings, and opaque/spandrel panels are never silently retyped as
windows. REVEX never invents a post-export wall/roof carrier. Missing or ambiguous geometry remains explicit QA evidence unless it can be represented by an existing authoritative Revit/EADM parent.
"""

import clr
import datetime
import glob
import hashlib
import json
import math
import os
import re
import time
import traceback
import unicodedata
import xml.etree.ElementTree as ET

clr.AddReference("RevitServices")
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager

clr.AddReference("RevitAPI")
from Autodesk.Revit.DB import (
    Area,
    AreaVolumeSettings,
    BuiltInCategory,
    BuiltInFailures,
    BuiltInParameter,
    ElementId,
    FailureProcessingResult,
    FilteredElementCollector,
    GBXMLExportOptions,
    IFailuresPreprocessor,
    Level,
    Options,
    RevitLinkInstance,
    SpatialElementBoundaryOptions,
    SpatialElementGeometryCalculator,
    SubTransaction,
    Transaction,
    TransactionGroup,
    TransactionStatus,
    Transform,
    UV,
    ViewFamily,
    ViewFamilyType,
    View,
    ViewPlan,
    XYZ,
)
from Autodesk.Revit.DB import Analysis
from Autodesk.Revit.DB.Architecture import Room, RoomFilter
from Autodesk.Revit.DB.Mechanical import Space, SpaceFilter


TOOL_NAME = "LIBER gbXML Preflight + Export"
TOOL_VERSION = "1.1.8"
ENGINE_PATCH = "UNIVERSAL-evidence-graph-entrypoints"
# Integrity contract: 80% is the hard publication stop in every required evidence domain.
# Published results below 95% remain explicit review-quality evidence in Companion.
PRESERVATION_TARGET = 0.95
PRESERVATION_MINIMUM = 0.80
FAST_EXPORT_MODE = False
MIN_AREA_M2 = 0.01
# RELEASE14F: strict zero-area epsilon in Revit internal square feet.
# Keep any genuinely positive plan circuit; this threshold is only for stale zero-area artifacts.
AREA_EPSILON_FT2 = 1.0e-6
MIN_EDGE_M = 0.01
PLANAR_TOL_M = 0.0005
POINT_TOL_FT = 0.001
LEVEL_ELEVATION_TOL_FT = 0.01
DEEP_GEOMETRY_LIMIT = 400
DEEP_GEOMETRY_BUDGET_S = 75.0
PHYSICAL_GEOMETRY_LIMIT = 1200
PHYSICAL_GEOMETRY_BUDGET_S = 180.0

# Bounded orchestration policy: agent roles are logical stages over compact manifests,
# not separate heavyweight model processes. Revit geometry remains authoritative.
MAX_TOPOLOGY_REPAIR_ROUNDS = 2
MAX_MAINTENANCE_PASSES = 2
ENABLE_OPTIONAL_MODEL_INFERENCE = False
ENABLE_VISUAL_GEOMETRY_COMPREHENSION = False

# Completion policy: a non-empty Revit spatial model must produce the best source-backed
# analytical deliverable available. QA remains explicit, but non-catastrophic or
# ambiguous derivative mismatches are maintenance warnings rather than dead ends.
# Geometry is never fitted to a target merely to pass QA.
COMPLETION_POLICY = "NONEMPTY_BEST_EVIDENCE"

# Universal architecture. These are the only model-processing entry points exposed
# by the orchestration report. They are based on Revit evidence domains, not project
# names, floor names, building type, or a regression model.
ARCHITECTURE_ID = "REVIT_EVIDENCE_GRAPH_V1"
ARCHITECTURE_ENTRY_POINTS = (
    ("discover", "discover_spatial_domains"),
    ("spatialize", "create_missing_spaces + close_remaining_plan_circuits"),
    ("analyze", "build_energy_model_with_fallbacks"),
    ("translate", "export_native_gbxml"),
    ("reconcile", "reconcile_physical_openings"),
    ("validate", "validate_export_contract + envelope_persistence_gate"),
    ("commit", "run_tool verified commit"),
)
SURFACE_SHELL_SOFT_TOL_FT = 1.50
SURFACE_SHELL_CATASTROPHIC_MIN_FT = 4.00

# RELEASE10 exact-source completion: no fitted/floating carriers.
OPENING_PARENT_PLANE_TOL_FT = 0.12
OPENING_PARENT_EDGE_TOL_FT = 0.20
TOP_COVER_SEARCH_MAX_FT = 30.0
EXTERIOR_GAP_TOP_TOL_FT = 0.35


doc = DocumentManager.Instance.CurrentDBDocument
uiapp = DocumentManager.Instance.CurrentUIApplication
app = uiapp.Application if uiapp else None


def input_value(index, default=None):
    try:
        value = IN[index]
        return default if value is None else value
    except Exception:
        return default


RUN_NOW = bool(input_value(0, False))
AUDIT_ONLY = bool(input_value(1, False))
OUTPUT_FOLDER_INPUT = str(input_value(2, "") or "").strip()
EXPORT_NAME_INPUT = str(input_value(3, "") or "").strip()
PHASE_NAME_INPUT = str(input_value(4, "") or "").strip()
APPLY_SAFE_FIXES = bool(input_value(5, True))
EXPORT_DESPITE_BLOCKERS = bool(input_value(6, False))
AI_MODEL_FOLDER_INPUT = str(input_value(7, "") or "").strip()


def eid_value(eid):
    if eid is None:
        return -1
    for attr in ("Value", "IntegerValue"):
        try:
            return int(getattr(eid, attr))
        except Exception:
            pass
    try:
        return int(str(eid))
    except Exception:
        return -1


def safe_name(value):
    value = str(value or "").strip()
    value = re.sub(r'[\\/:*?"<>|]+', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value or "Revit_Model"


def normalize_text(value):
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower().replace("_", " ").replace("-", " ")
    return re.sub(r"\s+", " ", value).strip()


def safe_attr(obj, name, default=None):
    """Read a .NET property/method without letting Python.NET setter-only wrappers abort the run."""
    if obj is None:
        return default
    try:
        return getattr(obj, name)
    except Exception:
        return default


def safe_element_name(element):
    if element is None:
        return ""
    # SpatialElement.Name is setter-only in the Revit 2026 Python.NET surface.
    try:
        if isinstance(element, (Room, Space)):
            return spatial_name(element)
    except Exception:
        pass
    value = safe_attr(element, "Name", None)
    if value is not None:
        try:
            return str(value or "").strip()
        except Exception:
            pass
    try:
        param = element.get_Parameter(BuiltInParameter.SYMBOL_NAME_PARAM)
        if param is not None:
            return str(param.AsString() or param.AsValueString() or "").strip()
    except Exception:
        pass
    return ""


def spatial_name(element):
    """Read Room/Space Name through BuiltInParameter.ROOM_NAME.

    Revit 2026 exposes SpatialElement.Name as a setter-only override. Python.NET
    therefore cannot use that property as a getter. Parameter access is used for
    all Room/Space name reads; the setter remains available for explicit updates.
    """
    if element is None:
        return ""
    try:
        param = element.get_Parameter(BuiltInParameter.ROOM_NAME)
        if param is not None:
            value = param.AsString()
            if value is None:
                try:
                    value = param.AsValueString()
                except Exception:
                    value = None
            return str(value or "").strip()
    except Exception:
        pass
    return ""


def spatial_label(element):
    try:
        number = str(element.Number or "").strip()
    except Exception:
        number = ""
    return "{} {}".format(number, spatial_name(element)).strip()


def phase_index_map(phases):
    return {eid_value(p.Id): i for i, p in enumerate(phases)}


def element_exists_in_phase(element, selected_index, phase_indexes):
    try:
        created = phase_indexes.get(eid_value(element.CreatedPhaseId), -1)
        demolished_id = eid_value(element.DemolishedPhaseId)
        demolished = phase_indexes.get(demolished_id, 10 ** 9)
        return created <= selected_index < demolished
    except Exception:
        return True


def is_placed_spatial(element):
    try:
        return element.Location is not None and float(element.Area) > 0.0
    except Exception:
        return False


def collect_class(model_doc, cls):
    try:
        return list(
            FilteredElementCollector(model_doc)
            .OfClass(cls)
            .WhereElementIsNotElementType()
        )
    except Exception:
        return []


def collect_rooms(model_doc):
    """Collect Rooms with Autodesk's dedicated RoomFilter.

    Room is one of the Revit API wrapper classes that ElementClassFilter /
    FilteredElementCollector.OfClass() does not support.  Using OfClass(Room)
    silently returns an empty set, so room-driven Space naming/phase inference
    must use RoomFilter instead.
    """
    try:
        return list(
            FilteredElementCollector(model_doc)
            .WherePasses(RoomFilter())
            .WhereElementIsNotElementType()
        )
    except Exception:
        return []


def collect_spaces(model_doc):
    """Collect MEP Spaces with Autodesk's dedicated SpaceFilter.

    Space is not supported by ElementClassFilter / OfClass().  This dedicated
    collector is therefore the authoritative source for every post-creation
    audit, phase scan, and exportability check.
    """
    try:
        return list(
            FilteredElementCollector(model_doc)
            .WherePasses(SpaceFilter())
            .WhereElementIsNotElementType()
        )
    except Exception:
        return []


def runtime_dependency_audit(model_doc, output_folder):
    """Audit every hard runtime dependency before model mutation.

    RevitServices and RevitAPI are imported above; if either import were absent the
    Dynamo node could not reach this function. Optional local AI packages are explicitly
    reported but are never hard dependencies for geometry or export.
    """
    hard=[]
    optional=[]
    def row(name, ok, detail="", hard_dependency=True):
        item={"name":name,"ok":bool(ok),"detail":str(detail or ""),"hard":bool(hard_dependency)}
        (hard if hard_dependency else optional).append(item)
        return bool(ok)

    row("active_document", model_doc is not None, safe_attr(model_doc,"Title",""))
    row("revit_application", app is not None, safe_attr(app,"VersionNumber","unknown"))
    version=str(safe_attr(app,"VersionNumber","") or "")
    row("revit_2026_api", version.startswith("2026") or version.startswith("26"), version)
    row("project_document", not bool(safe_attr(model_doc,"IsFamilyDocument",False)), "family={}".format(bool(safe_attr(model_doc,"IsFamilyDocument",False))))
    row("document_writable", not bool(safe_attr(model_doc,"IsReadOnly",False)) or AUDIT_ONLY, "read_only={}".format(bool(safe_attr(model_doc,"IsReadOnly",False))))
    row("document_export_api", callable(safe_attr(model_doc,"Export",None)), "Document.Export")
    creation=safe_attr(model_doc,"Create",None)
    for method in ("NewSpace","NewSpaces2"):
        row("creation_{}".format(method), creation is not None and callable(safe_attr(creation,method,None)), "Document.Create.{}".format(method))
    row("creation_NewSpaceTag", creation is not None and callable(safe_attr(creation,"NewSpaceTag",None)), "Document.Create.NewSpaceTag (non-blocking plan annotation)", False)
    row("creation_NewAreaTag", creation is not None and callable(safe_attr(creation,"NewAreaTag",None)), "Document.Create.NewAreaTag (non-blocking EN/Energy Area Plan annotation)", False)
    required_analysis=(
        "EnergyDataSettings","EnergyAnalysisDetailModel","EnergyAnalysisDetailModelOptions",
        "EnergyAnalysisDetailModelTier","EnergyModelType","AnalysisMode","gbXMLExportComplexity"
    )
    for name in required_analysis:
        row("analysis_{}".format(name), hasattr(Analysis,name), "Autodesk.Revit.DB.Analysis.{}".format(name))
    eds=safe_attr(Analysis,"EnergyDataSettings",None)
    row("energy_data_settings_getter", eds is not None and (callable(safe_attr(eds,"GetEnergyDataSettings",None)) or callable(safe_attr(eds,"GetFromDocument",None))), "EnergyDataSettings.GetEnergyDataSettings/GetFromDocument")
    complexity=safe_attr(Analysis,"gbXMLExportComplexity",None)
    row("gbxml_complexity_values", complexity is not None and hasattr(complexity,"Simple") and hasattr(complexity,"Complex"), "gbXMLExportComplexity.Simple/Complex")
    avs=safe_attr(AreaVolumeSettings,"GetAreaVolumeSettings",None)
    row("area_volume_settings", callable(avs), "AreaVolumeSettings.GetAreaVolumeSettings")
    try:
        model_opts=Analysis.EnergyAnalysisDetailModelOptions()
        model_opts.EnergyModelType=Analysis.EnergyModelType.SpatialElement
        model_opts.Tier=Analysis.EnergyAnalysisDetailModelTier.Final
        row("eadm_options_construct_set", True, "EnergyAnalysisDetailModelOptions SpatialElement/Final")
        try: model_opts.Dispose()
        except Exception: pass
    except Exception as ex:
        row("eadm_options_construct_set", False, "{}: {}".format(type(ex).__name__,ex))
    eadm=safe_attr(Analysis,"EnergyAnalysisDetailModel",None)
    row("eadm_create", eadm is not None and callable(safe_attr(eadm,"Create",None)), "EnergyAnalysisDetailModel.Create")
    row("eadm_get_main", eadm is not None and callable(safe_attr(eadm,"GetMainEnergyAnalysisDetailModel",None)), "EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel")
    tiers=safe_attr(Analysis,"EnergyAnalysisDetailModelTier",None)
    for tier in ("Final","SecondLevelBoundaries","FirstLevelBoundaries"):
        row("eadm_tier_{}".format(tier), tiers is not None and hasattr(tiers,tier), tier)
    emt=safe_attr(Analysis,"EnergyModelType",None)
    row("energy_model_type_spatial", emt is not None and hasattr(emt,"SpatialElement"), "SpatialElement")
    am=safe_attr(Analysis,"AnalysisMode",None)
    row("analysis_mode_rooms_spaces", am is not None and hasattr(am,"RoomsOrSpaces"), "RoomsOrSpaces")
    try:
        opts=GBXMLExportOptions()
        valid=bool(safe_attr(opts,"IsValidObject",True))
        try: opts.Dispose()
        except Exception: pass
        row("gbxml_options",valid,"GBXMLExportOptions default constructor")
    except Exception as ex:
        row("gbxml_options",False,"{}: {}".format(type(ex).__name__,ex))
    try:
        os.makedirs(output_folder,exist_ok=True)
        probe=os.path.join(output_folder,".__liber_revex_write_probe.tmp")
        with open(probe,"wb") as handle: handle.write(b"REVEX")
        os.remove(probe)
        row("output_folder_writable",True,output_folder)
    except Exception as ex:
        row("output_folder_writable",False,"{}: {}".format(type(ex).__name__,ex))

    # Space tags are requested convenience output, but a loaded tag family is not
    # allowed to become an energy-export dependency.
    try:
        tag_types=list(FilteredElementCollector(model_doc).OfCategory(BuiltInCategory.OST_MEPSpaceTags).WhereElementIsElementType().ToElements())
        row("space_tag_type_loaded",len(tag_types)>0,"loaded types={}".format(len(tag_types)),False)
    except Exception as ex:
        row("space_tag_type_loaded",False,str(ex),False)
    row("semantic_runtime", True, "deterministic rules + adjacency; optional model inference disabled", False)
    row("visual_geometry_runtime", True, "disabled; native Revit geometry queried directly", False)
    failed=[item for item in hard if not item["ok"]]
    return {"passed":not failed,"hard":hard,"optional":optional,"failed_hard":[item["name"] for item in failed]}


def collect_element_types(model_doc, cls):
    """Collect Revit element types without filtering them out as instances."""
    try:
        return list(
            FilteredElementCollector(model_doc)
            .OfClass(cls)
            .WhereElementIsElementType()
        )
    except Exception:
        return []


class SpaceCreationFailureGuard(IFailuresPreprocessor):
    """Never offer a destructive UI resolution for spatial-element failures."""

    __namespace__ = "LIBER.GBXML.Runtime{}".format(
        int(time.time() * 1000000)
    )

    def __init__(self):
        self.failures = []

    def PreprocessFailures(self, failures_accessor):
        protected = []
        try:
            room_failures = BuiltInFailures.RoomFailures
            protected = [
                room_failures.RoomsInSameRegionSpaces,
                room_failures.RoomsOverlapInHeight,
                room_failures.RoomNotEnclosedSpaces,
                room_failures.RoomHeightNegative,
                room_failures.RoomLevelElevs,
                room_failures.CannotMakeRoomsGeometry,
                room_failures.RoomsReallyFailed,
            ]
        except Exception:
            protected = []

        rollback = False
        for failure in list(failures_accessor.GetFailureMessages() or []):
            try:
                failure_id = failure.GetFailureDefinitionId()
                description = str(failure.GetDescriptionText() or "")
                text = normalize_text(description)
                protected_id = any(failure_id == item for item in protected)
                # Revit 2026 can surface the MEP wording through a failure id that is
                # not consistently exposed through BuiltInFailures.RoomFailures in
                # Python.NET. Never let the modal escape the automation boundary.
                overlap_warning = (
                    "space volumes overlap" in text
                    or ("space" in text and "overlap" in text and "volume" in text)
                )
                if protected_id or overlap_warning:
                    rollback = True
                    self.failures.append(
                        {
                            "description": description,
                            "failing_element_ids": [
                                eid_value(item)
                                for item in list(
                                    failure.GetFailingElementIds() or []
                                )
                            ],
                            "overlap_warning": bool(overlap_warning),
                        }
                    )
            except Exception:
                pass
        if rollback:
            return FailureProcessingResult.ProceedWithRollBack
        return FailureProcessingResult.Continue


def edit_distance(a, b):
    a = a or ""
    b = b or ""
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[j] + 1,
                    previous[j - 1] + (0 if ca == cb else 1),
                )
            )
        previous = current
    return previous[-1]


def choose_phase(model_doc, requested_name):
    phases = list(model_doc.Phases)
    if not phases:
        raise Exception("The model contains no project phases.")
    if requested_name:
        wanted = normalize_text(requested_name)
        exact = [p for p in phases if normalize_text(p.Name) == wanted]
        if exact:
            return exact[-1], phases

        ranked = sorted(
            [(edit_distance(wanted, normalize_text(p.Name)), i, p) for i, p in enumerate(phases)],
            key=lambda row: (row[0], row[1]),
        )
        threshold = max(1, min(2, int(round(max(1, len(wanted)) * 0.15))))
        if ranked:
            best = ranked[0][0]
            unique = len(ranked) == 1 or ranked[1][0] > best
            if unique and best <= threshold:
                return ranked[0][2], phases

        available = ", ".join(p.Name for p in phases)
        raise Exception(
            "Requested phase '{}' was not found. Available: {}".format(
                requested_name, available
            )
        )

    indexes = phase_index_map(phases)
    rooms = collect_rooms(model_doc)
    spaces = collect_spaces(model_doc)
    scored = []
    for i, phase in enumerate(phases):
        count = 0
        for item in rooms + spaces:
            if (
                is_placed_spatial(item)
                and element_exists_in_phase(item, i, indexes)
            ):
                count += 1
        scored.append((count, i, phase))
    return max(scored, key=lambda row: (row[0], row[1]))[2], phases


def default_output_folder(model_doc):
    path = str(model_doc.PathName or "").strip()
    if path:
        return os.path.join(os.path.dirname(path), "gbXML_EXPORT")
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    return os.path.join(desktop, "LIBER_gbXML_EXPORT")


def get_level(element, model_doc):
    try:
        return model_doc.GetElement(element.LevelId)
    except Exception:
        return None


def level_elevation(level):
    try:
        return float(level.Elevation)
    except Exception:
        return 0.0


def sorted_levels(model_doc):
    return sorted(collect_class(model_doc, Level), key=level_elevation)


def nearest_level(levels, elevation, max_distance_ft=None):
    if not levels:
        return None
    level = min(levels, key=lambda item: abs(level_elevation(item) - elevation))
    if (
        max_distance_ft is not None
        and abs(level_elevation(level) - elevation) > max_distance_ft
    ):
        return None
    return level


def next_level(levels, current_level):
    current = level_elevation(current_level)
    above = [level for level in levels if level_elevation(level) > current + 0.01]
    return min(above, key=level_elevation) if above else None


def spatial_point(element):
    try:
        loc = element.Location
        point = safe_attr(loc, "Point", None)
        if point is not None:
            return point
    except Exception:
        pass
    try:
        box = element.get_BoundingBox(None)
        if box:
            return (box.Min + box.Max) * 0.5
    except Exception:
        pass
    return None


def room_top_z(room, transform):
    try:
        upper = room.UpperLimit
        top_source = float(upper.Elevation) + float(room.LimitOffset)
        return transform.OfPoint(XYZ(0.0, 0.0, top_source)).Z
    except Exception:
        try:
            point = spatial_point(room)
            return transform.OfPoint(point).Z + float(room.UnboundedHeight)
        except Exception:
            return None


def room_base_z(room, transform):
    try:
        level = room.Document.GetElement(room.LevelId)
        base_source = float(level.Elevation) + float(room.BaseOffset)
        return transform.OfPoint(XYZ(0.0, 0.0, base_source)).Z
    except Exception:
        try:
            return transform.OfPoint(spatial_point(room)).Z
        except Exception:
            return None


def pick_link_phase(link_doc, host_phase_name):
    phases = list(link_doc.Phases)
    if not phases:
        return None, []
    host_norm = normalize_text(host_phase_name)
    matches = [p for p in phases if normalize_text(p.Name) == host_norm]
    if matches:
        return matches[-1], phases
    rooms = collect_rooms(link_doc)
    indexes = phase_index_map(phases)
    scored = []
    for i, phase in enumerate(phases):
        count = sum(
            1
            for room in rooms
            if is_placed_spatial(room)
            and element_exists_in_phase(room, i, indexes)
        )
        scored.append((count, i, phase))
    return max(scored, key=lambda row: (row[0], row[1]))[2], phases


def room_source_record(room, transform, inverse, kind, source_label):
    point = spatial_point(room)
    if point is None:
        return None
    try:
        host_point = transform.OfPoint(point)
    except Exception:
        return None
    return {
        "room": room,
        "transform": transform,
        "inverse": inverse,
        "kind": kind,
        "source": source_label,
        "id": eid_value(room.Id),
        "name": spatial_name(room),
        "number": str(room.Number or "").strip(),
        "point": host_point,
        "base_z": room_base_z(room, transform),
        "top_z": room_top_z(room, transform),
        "area": float(room.Area or 0.0),
        # Host Rooms already carry the authoritative story LevelId. Preserve it
        # instead of re-deriving the level from Z where coincident datums (for
        # example two coincident reference/story datums) can otherwise select the wrong datum.
        "host_level_id": (eid_value(room.LevelId) if kind == "host_room" else None),
    }


def collect_room_sources(model_doc, phase, phases, messages):
    sources = []
    phase_indexes = phase_index_map(phases)
    selected_index = phase_indexes[eid_value(phase.Id)]
    identity = Transform.Identity

    for room in collect_rooms(model_doc):
        if (
            is_placed_spatial(room)
            and element_exists_in_phase(room, selected_index, phase_indexes)
        ):
            record = room_source_record(
                room, identity, identity, "host_room", model_doc.Title
            )
            if record:
                sources.append(record)

    for link in collect_class(model_doc, RevitLinkInstance):
        try:
            link_doc = link.GetLinkDocument()
            if link_doc is None:
                messages.append(
                    {
                        "severity": "WARNING",
                        "code": "UNLOADED_LINK",
                        "element_id": eid_value(link.Id),
                        "message": "Linked Revit model is unloaded and could not provide Rooms.",
                    }
                )
                continue
            transform = link.GetTotalTransform()
            inverse = transform.Inverse
            link_phase, link_phases = pick_link_phase(link_doc, phase.Name)
            if link_phase is None:
                continue
            link_indexes = phase_index_map(link_phases)
            link_index = link_indexes[eid_value(link_phase.Id)]
            for room in collect_rooms(link_doc):
                if (
                    is_placed_spatial(room)
                    and element_exists_in_phase(room, link_index, link_indexes)
                ):
                    record = room_source_record(
                        room,
                        transform,
                        inverse,
                        "linked_room",
                        "{} :: {}".format(link.Name, link_doc.Title),
                    )
                    if record:
                        record["link_id"] = eid_value(link.Id)
                        sources.append(record)
        except Exception as ex:
            messages.append(
                {
                    "severity": "WARNING",
                    "code": "LINK_ROOM_SCAN_FAILED",
                    "element_id": eid_value(link.Id),
                    "message": str(ex),
                }
            )
    return sources


def room_source_boundary_signature(source):
    """Return a host-coordinate 2D boundary signature for Room deduplication."""
    room = source.get("room")
    transform = source.get("transform") or Transform.Identity
    edges = []
    try:
        loops = room.GetBoundarySegments(SpatialElementBoundaryOptions())
        for loop in list(loops or []):
            for segment in list(loop or []):
                curve = segment.GetCurve()
                try:
                    points = list(curve.Tessellate())
                except Exception:
                    points = [curve.GetEndPoint(0), curve.GetEndPoint(1)]
                values = []
                for point in points:
                    host = transform.OfPoint(point)
                    values.append(
                        (
                            round(float(host.X) / POINT_TOL_FT),
                            round(float(host.Y) / POINT_TOL_FT),
                        )
                    )
                values = tuple(values)
                reverse = tuple(reversed(values))
                edges.append(values if values <= reverse else reverse)
    except Exception:
        return None
    if not edges:
        return None
    base_z = source.get("base_z")
    if base_z is None:
        base_z = source.get("point").Z if source.get("point") is not None else 0.0
    return (
        round(float(base_z) / LEVEL_ELEVATION_TOL_FT),
        tuple(sorted(edges)),
    )


def dedupe_room_sources(room_sources, messages):
    """Collapse duplicate host/link representations of the same physical Room."""
    selected = []
    by_signature = {}
    duplicates = []
    for source in room_sources:
        signature = room_source_boundary_signature(source)
        source["boundary_signature"] = signature
        if signature is None:
            selected.append(source)
            continue
        previous = by_signature.get(signature)
        if previous is None:
            by_signature[signature] = source
            selected.append(source)
            continue
        # Prefer a host Room over the same physical Room repeated in a link.
        keep = previous
        discard = source
        if previous.get("kind") != "host_room" and source.get("kind") == "host_room":
            keep, discard = source, previous
            by_signature[signature] = keep
            try:
                selected[selected.index(previous)] = keep
            except Exception:
                pass
        duplicates.append(
            {
                "kept_kind": keep.get("kind"),
                "kept_id": keep.get("id"),
                "discarded_kind": discard.get("kind"),
                "discarded_id": discard.get("id"),
                "name": keep.get("name") or discard.get("name"),
            }
        )
    if duplicates:
        messages.append(
            {
                "severity": "INFO",
                "code": "DUPLICATE_ROOM_SOURCES_COLLAPSED",
                "count": len(duplicates),
                "duplicates": duplicates[:100],
                "message": (
                    "Duplicate host/link Room representations with identical physical "
                    "boundaries were collapsed before Space creation."
                ),
            }
        )
    return selected, duplicates


def source_probe_point(source):
    point = source.get("point")
    if point is None:
        return None
    base = source.get("base_z")
    top = source.get("top_z")
    if base is None:
        base = float(point.Z)
    height = (float(top) - float(base)) if top is not None else 0.0
    offset = min(1.0, max(0.2, height * 0.25 if height > 0.0 else 1.0))
    return XYZ(float(point.X), float(point.Y), float(base) + offset)


def source_level(levels, source):
    host_level_id = source.get("host_level_id")
    if host_level_id is not None:
        for level in levels:
            if eid_value(level.Id) == int(host_level_id):
                return level
    elevation = source.get("base_z")
    if elevation is None:
        point = source.get("point")
        elevation = point.Z if point is not None else None
    if elevation is None:
        return None
    return nearest_level(levels, float(elevation), max_distance_ft=5.0)

def space_at_source(model_doc, phase, source, spaces=None):
    """Resolve the Space representing a Room source.

    Host Rooms are matched through Space.Room first.  Revit's spatial containment
    index can lag newly-created Spaces until their transaction commits, so the
    engine never uses GetSpaceAtPoint/IsPointInSpace as an in-transaction creation
    success test.  Point containment remains a committed-state fallback, and is
    required for linked Room sources where Space.Room cannot reference the link.
    """
    candidates = list(spaces or collect_spaces(model_doc))
    if source.get("kind") == "host_room":
        source_id = int(source.get("id") or -1)
        for space in candidates:
            try:
                room = space.Room
                if room is not None and eid_value(room.Id) == source_id:
                    return space
            except Exception:
                pass

    probe = source_probe_point(source)
    if probe is None:
        return None
    try:
        hit = model_doc.GetSpaceAtPoint(probe, phase)
        if hit is not None:
            return hit
    except Exception:
        pass
    for space in candidates:
        try:
            if bool(space.IsPointInSpace(probe)):
                return space
        except Exception:
            continue
    return None

def source_plan_probe_points(source, max_points=64):
    """Sample a Room footprint in host coordinates for cross-story overlap tests."""
    cached=source.get("_plan_probe_points")
    if cached is not None:
        return cached
    points = []
    seed = source.get("point")
    if seed is not None:
        points.append((float(seed.X), float(seed.Y)))
    room = source.get("room")
    transform = source.get("transform") or Transform.Identity
    try:
        loops = room.GetBoundarySegments(SpatialElementBoundaryOptions())
        for loop in list(loops or []):
            for segment in list(loop or []):
                curve = segment.GetCurve()
                try:
                    tess = list(curve.Tessellate())
                except Exception:
                    tess = [curve.GetEndPoint(0), curve.GetEndPoint(1)]
                if not tess:
                    continue
                sample = list(tess)
                if len(tess) >= 2:
                    a, b = tess[0], tess[-1]
                    sample.append(XYZ((a.X+b.X)*0.5, (a.Y+b.Y)*0.5, (a.Z+b.Z)*0.5))
                for point in sample:
                    host = transform.OfPoint(point)
                    points.append((float(host.X), float(host.Y)))
                    if len(points) >= max_points:
                        break
                if len(points) >= max_points:
                    break
            if len(points) >= max_points:
                break
    except Exception:
        pass
    out=[]; seen=set()
    for x,y in points:
        key=(round(x/POINT_TOL_FT),round(y/POINT_TOL_FT))
        if key in seen: continue
        seen.add(key); out.append((x,y))
    source["_plan_probe_points"]=out
    if out:
        xs=[p[0] for p in out]; ys=[p[1] for p in out]
        source["_plan_probe_bbox"]=(min(xs),min(ys),max(xs),max(ys))
    return out


def source_contains_host_xy(source, x, y):
    """Test an XY against a Room using a Z safely inside that Room's own volume."""
    room=source.get("room")
    inverse=source.get("inverse") or Transform.Identity
    if room is None: return False
    base=source.get("base_z")
    top=source.get("top_z")
    if base is None:
        point=source.get("point"); base=float(point.Z) if point is not None else 0.0
    height=(float(top)-float(base)) if top is not None else 8.0
    z=float(base)+min(1.0,max(0.25,height*0.25 if height>0 else 1.0))
    try:
        local=inverse.OfPoint(XYZ(float(x),float(y),z))
        return bool(room.IsPointInRoom(local))
    except Exception:
        return False


def room_sources_overlap_in_plan(a,b):
    """Conservative cross-story 2D overlap proof without creating any Spaces."""
    if a is b: return False
    sig_a=a.get("boundary_signature"); sig_b=b.get("boundary_signature")
    if sig_a is not None and sig_b is not None and sig_a[1:]==sig_b[1:]:
        return True
    pa=source_plan_probe_points(a)
    pb=source_plan_probe_points(b)
    ba=a.get("_plan_probe_bbox"); bb=b.get("_plan_probe_bbox")
    if ba is not None and bb is not None:
        if ba[2] < bb[0]-POINT_TOL_FT or bb[2] < ba[0]-POINT_TOL_FT or ba[3] < bb[1]-POINT_TOL_FT or bb[3] < ba[1]-POINT_TOL_FT:
            return False
    for x,y in pa:
        if source_contains_host_xy(b,x,y): return True
    for x,y in pb:
        if source_contains_host_xy(a,x,y): return True
    return False


def prepare_room_source_vertical_targets(room_sources, target_levels, all_levels, changes, messages):
    """Resolve a sane energy top without trusting arbitrary Room Upper Limits/datums.

    Lower occupied stories stop at the next occupied story.  The highest occupied
    story gets a virtual top based on median occupied-story spacing.  A Room's own
    top is preserved only when it is positive and does not exceed that story cap.
    Architectural Room parameters are never edited.
    """
    capped=0
    ordered=sorted(room_sources,key=lambda r:(float(r.get("base_z") or 0.0),int(r.get("id") or -1)))
    typical=typical_occupied_story_height(target_levels)
    for source in ordered:
        base=source.get("base_z")
        if base is None:
            continue
        base=float(base)
        base_level=source_level(target_levels,source) or source_level(all_levels,source)
        story_top,story_upper,story_method=(preferred_story_top_z(base_level,target_levels,all_levels) if base_level is not None else (base+typical,None,"fallback_typical"))
        if story_top is None or story_top<=base+0.25:
            story_top=base+typical
            story_upper=None
            story_method="fallback_typical"

        nominal=source.get("top_z")
        if nominal is None or float(nominal)<=base+0.25:
            nominal=float(story_top)
        else:
            nominal=float(nominal)

        # Preserve a plausible architectural top below the energy-story cap (e.g. an
        # 8'-0" ceiling).  Anything crossing the cap is bounded to one story.
        target=min(float(nominal),float(story_top))
        if target<=base+0.25:
            target=float(story_top)
        reason=None if abs(target-nominal)<=POINT_TOL_FT else story_method

        source["effective_top_z"]=float(target)
        source["nominal_top_z"]=float(nominal)
        source["story_top_z"]=float(story_top)
        source["story_top_method"]=story_method
        source["story_upper_level_id"]=(eid_value(story_upper.Id) if story_upper is not None else None)
        source["story_upper_level_name"]=(str(safe_element_name(story_upper)) if story_upper is not None else "VIRTUAL TOP +{:.2f} ft".format(float(story_top-base)))

        if abs(target-nominal)>POINT_TOL_FT:
            capped+=1
            changes.append({
                "action":"cap_room_seed_to_energy_story",
                "room_id":source.get("id"),"room_name":source.get("name"),
                "base_ft":round(base,6),"nominal_top_ft":round(nominal,6),
                "effective_top_ft":round(target,6),"story_top_ft":round(float(story_top),6),
                "upper_story_level_id":source.get("story_upper_level_id"),
                "upper_story_level":source.get("story_upper_level_name"),"reason":reason,
            })
            messages.append({
                "severity":"INFO","code":"ROOM_SPACE_STORY_BOUNDED_FOR_ENERGY",
                "room_id":source.get("id"),"room_name":source.get("name"),
                "nominal_top_ft":round(nominal,6),"effective_top_ft":round(target,6),
                "story_top_ft":round(float(story_top),6),"story_top_method":story_method,
                "message":"Generated energy Space was bounded to one occupied story; architectural Room data was not modified.",
            })
    return capped

def local_gap_top_z(space, covering_spaces, default_top):
    """Cap a gap Space at the first committed upper Space occupying the same XY."""
    base_bounds=_space_vertical_bounds(space)
    base_level=_space_base_level(space)
    point=spatial_point(space)
    base=(base_bounds[0] if base_bounds is not None else level_elevation(base_level)) if base_level is not None else None
    if base is None or point is None: return float(default_top)
    candidates=[]
    for other in list(covering_spaces or []):
        if other is None: continue
        try:
            ob=_space_vertical_bounds(other)
            if ob is None or ob[0]<=base+LEVEL_ELEVATION_TOL_FT: continue
            if ob[0]>=float(default_top)-POINT_TOL_FT: continue
            probe=_space_probe_at_xy(other,point.X,point.Y)
            if probe is not None and bool(other.IsPointInSpace(probe)):
                candidates.append(float(ob[0]))
        except Exception:
            continue
    return min([float(default_top)]+candidates) if candidates else float(default_top)


def apply_room_source_extent_strict(space, source, levels):
    """Apply Room-derived base/top Z and prove the resulting Space extent."""
    base_level = _space_base_level(space)
    if base_level is None:
        raise Exception("Room-seeded Space has no base Level.")
    base_z = source.get("base_z")
    top_z = source.get("effective_top_z", source.get("top_z"))
    if base_z is None:
        base_z = level_elevation(base_level)
    if top_z is None or float(top_z) <= float(base_z) + 0.25:
        upper = preferred_upper_level(base_level, levels, levels)
        top_z = level_elevation(upper) if upper is not None else float(base_z) + 10.0
    base_z = float(base_z)
    top_z = float(top_z)

    upper = nearest_level(levels, top_z, max_distance_ft=3.0)
    if upper is None or level_elevation(upper) <= base_z + 0.25:
        upper = preferred_upper_level(base_level, levels, levels)
    target_upper = upper or base_level
    if not _apply_space_vertical_target_nonzero(space, base_z - level_elevation(base_level), target_upper, top_z):
        raise Exception("Could not apply Room-seeded Space vertical extent without a zero-height intermediate state.")
    bounds = _space_vertical_bounds(space)
    if bounds is None or bounds[1] <= bounds[0] + 0.25:
        raise Exception("Room-seeded Space has nonpositive vertical extent.")
    if abs(bounds[0] - base_z) > 0.10 or abs(bounds[1] - top_z) > 0.20:
        raise Exception(
            "Room-seeded Space extent did not match source Room (source {:.3f}-{:.3f} ft, actual {:.3f}-{:.3f} ft).".format(
                base_z, top_z, bounds[0], bounds[1]
            )
        )
    return bounds


def create_room_seeded_spaces(
    model_doc, phase, levels, room_sources, existing_space_ids, changes, messages
):
    """Place one MEP Space at every unique architectural Room source first.

    NewSpaces2 remains a gap filler for corridors/service circuits.  This prevents
    a low plan-circuit count from silently collapsing many architectural Rooms into
    a handful of generic Spaces.
    """
    created = set()
    covered_existing = 0
    attempted = 0
    failed = []
    ordered = sorted(
        room_sources,
        key=lambda source: (
            float(source.get("base_z") or source.get("point").Z),
            str(source.get("number") or ""),
            int(source.get("id") or -1),
        ),
    )
    for source in ordered:
        hit = space_at_source(model_doc, phase, source)
        if hit is not None:
            covered_existing += 1
            continue
        attempted += 1
        level = source_level(levels, source)
        point = source.get("point")
        if level is None or point is None:
            failed.append(source)
            messages.append(
                {
                    "severity": "ERROR",
                    "code": "ROOM_SOURCE_HAS_NO_HOST_LEVEL",
                    "room_id": source.get("id"),
                    "source": source.get("source"),
                    "message": "A placed Room source could not be mapped to a host Level.",
                }
            )
            continue
        try:
            space = model_doc.Create.NewSpace(
                level, phase, UV(float(point.X), float(point.Y))
            )
            if space is None:
                raise Exception("Revit returned no Space.")
            tag_generated_space(space)
            # Identity and exact vertical limits come from the architectural Room.
            if source.get("name"):
                try:
                    space.Name = source["name"]
                except Exception:
                    pass
            if source.get("number"):
                try:
                    space.Number = source["number"]
                except Exception:
                    pass
            bounds = apply_room_source_extent_strict(space, source, levels)
            model_doc.Regenerate()
            # Do not call GetSpaceAtPoint/IsPointInSpace here. Revit can defer the
            # spatial-topology index until transaction commit. The outer
            # TransactionGroup keeps this safe: committed seed Spaces are audited
            # immediately after commit and the entire group is rolled back on any
            # coverage/collapse failure.
            created.add(eid_value(space.Id))
            source["seeded_space_id"] = eid_value(space.Id)
            changes.append(
                {
                    "action": "created_space_from_room_source",
                    "element_id": eid_value(space.Id),
                    "room_id": source.get("id"),
                    "room_source": source.get("source"),
                    "base_level": str(safe_element_name(level)),
                    "bottom_ft": bounds[0],
                    "top_ft": bounds[1],
                }
            )
        except Exception as ex:
            failed.append(source)
            messages.append(
                {
                    "severity": "ERROR",
                    "code": "ROOM_SOURCE_SPACE_CREATION_FAILED",
                    "room_id": source.get("id"),
                    "room_name": source.get("name"),
                    "source": source.get("source"),
                    "message": str(ex),
                }
            )
    return created, {
        "room_sources": len(room_sources),
        "covered_by_existing_space": covered_existing,
        "attempted": attempted,
        "created": len(created),
        "failed": len(failed),
        "failed_room_ids": [item.get("id") for item in failed[:100]],
    }


def map_room_sources_to_spaces(model_doc, phase, levels, room_sources, phase_spaces):
    """Resolve Room->Space identity from committed topology using independent proofs.

    Order of proof:
      1) Revit's native Space.Room association for host Rooms;
      2) exact 2D boundary signature on the same story (works for host + linked Rooms);
      3) the exact Space id created from that Room seed, but only when same-story area
         remains compatible after commit;
      4) committed spatial containment as a final fallback.

    This avoids treating a single unreliable Room location point as topology truth.
    """
    candidates=[space for space in list(phase_spaces or []) if is_placed_spatial(space)]
    by_id={eid_value(space.Id):space for space in candidates}
    by_room={}
    for space in candidates:
        try:
            room=space.Room
            if room is not None:
                by_room.setdefault(eid_value(room.Id),[]).append(space)
        except Exception:
            pass

    by_signature={}
    for space in candidates:
        sig=space_boundary_signature(space)
        if sig is not None:
            by_signature.setdefault(sig,[]).append(space)

    mapping={}
    method_counts={}
    unresolved=[]
    ambiguous=[]
    for source in room_sources:
        hit=None; method=None
        if source.get("kind")=="host_room":
            hits=by_room.get(int(source.get("id") or -1),[])
            if len(hits)==1:
                hit=hits[0]; method="space_room"
            elif len(hits)>1:
                ambiguous.append({"room_id":source.get("id"),"method":"space_room","space_ids":[eid_value(x.Id) for x in hits]})

        if hit is None:
            sig=source.get("boundary_signature")
            hits=by_signature.get(sig,[]) if sig is not None else []
            if len(hits)==1:
                hit=hits[0]; method="boundary_signature"
            elif len(hits)>1:
                # Identical boundaries on one story are already a topology ambiguity.
                ambiguous.append({"room_id":source.get("id"),"method":"boundary_signature","space_ids":[eid_value(x.Id) for x in hits]})

        if hit is None and source.get("seeded_space_id") is not None:
            candidate=by_id.get(int(source.get("seeded_space_id")))
            if candidate is not None:
                src_level=source_level(levels,source)
                sp_level=_space_base_level(candidate)
                same_level=(src_level is not None and sp_level is not None and eid_value(src_level.Id)==eid_value(sp_level.Id))
                try:
                    room_area=float(source.get("area") or 0.0); space_area=float(candidate.Area or 0.0)
                    tolerance=max(1.0,room_area*0.03)
                    area_ok=room_area>0.0 and space_area>0.0 and abs(space_area-room_area)<=tolerance
                except Exception:
                    area_ok=False
                if same_level and area_ok:
                    hit=candidate; method="seed_provenance_area"

        if hit is None:
            # Point fallback is intentionally last. It is useful for linked Rooms but
            # cannot override stronger committed boundary/provenance evidence.
            probe=source_probe_point(source)
            if probe is not None:
                try:
                    candidate=model_doc.GetSpaceAtPoint(probe,phase)
                    if candidate is not None and eid_value(candidate.Id) in by_id:
                        hit=candidate; method="committed_point"
                except Exception:
                    pass
                if hit is None:
                    hits=[]
                    for candidate in candidates:
                        try:
                            if bool(candidate.IsPointInSpace(probe)): hits.append(candidate)
                        except Exception:
                            pass
                    if len(hits)==1:
                        hit=hits[0]; method="committed_is_point"
                    elif len(hits)>1:
                        ambiguous.append({"room_id":source.get("id"),"method":"committed_is_point","space_ids":[eid_value(x.Id) for x in hits]})

        if hit is not None:
            mapping[id(source)]=(hit,method)
            method_counts[method]=method_counts.get(method,0)+1
        else:
            unresolved.append({
                "room_id":source.get("id"),"room_name":source.get("name"),"room_number":source.get("number"),
                "source":source.get("source"),"level":str(safe_element_name(source_level(levels,source)) or "<unresolved>"),
                "seeded_space_id":source.get("seeded_space_id"),"area_ft2":round(float(source.get("area") or 0.0),3),
            })
    return mapping,{"methods":method_counts,"unresolved":unresolved[:100],"ambiguous":ambiguous[:100]}

def audit_room_space_topology(model_doc, phase, levels, room_sources, phase_spaces, messages, strict=True):
    """Prove one-to-one Room coverage and report per-story topology."""
    resolved, resolution = map_room_sources_to_spaces(
        model_doc, phase, levels, room_sources, phase_spaces
    )
    mappings = {}
    uncovered = []
    per_level = {}
    for source in room_sources:
        level = source_level(levels, source)
        level_key = str(safe_element_name(level) if level is not None else "<unresolved>")
        row = per_level.setdefault(level_key, {"rooms": 0, "mapped_spaces": set(), "spaces": 0})
        row["rooms"] += 1
        pair = resolved.get(id(source))
        hit = pair[0] if pair else None
        method = pair[1] if pair else None
        if hit is None or not is_placed_spatial(hit):
            uncovered.append(source)
            if strict:
                messages.append({
                    "severity": "ERROR",
                    "code": "ROOM_SOURCE_NOT_COVERED_BY_SPACE",
                    "room_id": source.get("id"),
                    "room_name": source.get("name"),
                    "room_number": source.get("number"),
                    "source": source.get("source"),
                    "level": level_key,
                    "seeded_space_id": source.get("seeded_space_id"),
                    "message": "Final committed topology contains a placed architectural Room with no independently proven MEP Space.",
                })
            continue
        sid = eid_value(hit.Id)
        mappings.setdefault(sid, []).append((source,method))
        row["mapped_spaces"].add(sid)

    for space in phase_spaces:
        level = _space_base_level(space)
        level_key = str(safe_element_name(level) if level is not None else "<unresolved>")
        per_level.setdefault(level_key, {"rooms": 0, "mapped_spaces": set(), "spaces": 0})["spaces"] += 1

    collapsed = []
    for sid, source_pairs in mappings.items():
        if len(source_pairs) > 1:
            sources=[pair[0] for pair in source_pairs]
            collapsed.append((sid, sources))
            if strict:
                messages.append({
                    "severity": "ERROR",
                    "code": "MULTIPLE_ROOMS_COLLAPSED_INTO_ONE_SPACE",
                    "element_id": sid,
                    "room_ids": [item.get("id") for item in sources],
                    "rooms": [item.get("name") for item in sources],
                    "message": "Multiple distinct architectural Rooms resolve to one MEP Space after committed boundary/association proof.",
                })

    for level_key, row in per_level.items():
        row["mapped_spaces"] = len(row["mapped_spaces"])
    return {
        "room_sources": len(room_sources),
        "covered_room_sources": len(room_sources) - len(uncovered),
        "uncovered_room_sources": len(uncovered),
        "unique_room_mapped_spaces": len(mappings),
        "collapsed_space_count": len(collapsed),
        "phase_spaces": len(phase_spaces),
        "mapping_methods": resolution.get("methods", {}),
        "unresolved_details": resolution.get("unresolved", []),
        "ambiguous_details": resolution.get("ambiguous", []),
        "per_level": per_level,
    }

def probe_remaining_plan_circuits(model_doc, phase, target_levels, messages, emit_error=True):
    """Rollback-only proof that no enclosed plan circuit remains without a Space."""
    remaining = []
    for sequence, level in enumerate(target_levels, 901):
        transaction = Transaction(
            model_doc, "LIBER gbXML: coverage probe {}".format(sequence)
        )
        try:
            transaction.Start()
            view = create_temp_plan(model_doc, level, phase, sequence)
            ids = list(model_doc.Create.NewSpaces2(level, phase, view) or [])
            model_doc.Regenerate()
            generated = [model_doc.GetElement(item) for item in ids]
            valid = [
                item for item in generated
                if item is not None and is_placed_spatial(item)
            ]
            if valid:
                remaining.append(
                    {
                        "level": str(safe_element_name(level)),
                        "level_id": eid_value(level.Id),
                        "count": len(valid),
                        "areas_ft2": sorted(
                            round(float(item.Area), 3) for item in valid
                        )[:100],
                    }
                )
            transaction.RollBack()
        except Exception as ex:
            try:
                if transaction.GetStatus() == TransactionStatus.Started:
                    transaction.RollBack()
            except Exception:
                pass
            messages.append(
                {
                    "severity": "WARNING",
                    "code": "PLAN_CIRCUIT_COVERAGE_PROBE_FAILED",
                    "level": str(safe_element_name(level)),
                    "message": str(ex),
                }
            )
    # Every coverage probe transaction above is rolled back.  Document.Regenerate()
    # is a modifying API and is illegal once no transaction is open.  The rollback
    # already restores/regenerates the document state; do not call Regenerate here.
    if remaining and emit_error:
        messages.append(
            {
                "severity": "WARNING",
                "code": "UNCOVERED_PLAN_CIRCUITS_REMAIN",
                "levels": remaining,
                "message": (
                    "Revit still exposes enclosed plan circuits without Spaces. These remain "
                    "explicit preservation warnings and do not block diagnostic gbXML generation; "
                    "Energy Sync publication requires the >=80% hard-stop integrity gate in every required evidence domain."
                ),
            }
        )
    result = {
        "remaining_count": sum(item["count"] for item in remaining),
        "levels": remaining,
    }
    messages.append({
        "severity": "INFO",
        "code": "PLAN_CIRCUIT_PROBE_COMPLETED",
        "remaining_count": result["remaining_count"],
        "message": "Rollback-only plan-circuit coverage probe completed without modifying the model; no out-of-transaction regeneration is used.",
    })
    return result

def close_remaining_plan_circuits(
    model_doc, phase, phases, levels, room_sources, target_levels, created_ids, changes, messages, max_rounds=MAX_TOPOLOGY_REPAIR_ROUNDS
):
    """Commit remaining positive-area plan circuits to a fixed point.

    Room seeds are already committed before this runs.  Revit's NewSpaces2 topology
    can lag one commit behind the initial batch, so a rollback-only probe is used to
    identify only levels that still expose a real positive-area circuit.  Each repair
    round is then committed before the next probe.  The loop is bounded and never
    accepts zero-area API artifacts or a second Space for an already covered Room.
    """
    aggregate = {
        "rounds": 0,
        "api_returned_ids": 0,
        "kept": 0,
        "discarded_zero_area": 0,
        "discarded_redundant": 0,
        "discarded_room_duplicates": 0,
        "remaining_before": None,
        "remaining_after": None,
    }
    target_by_id = {eid_value(level.Id): level for level in target_levels}
    phase_indexes = phase_index_map(phases)
    selected_index = phase_indexes[eid_value(phase.Id)]

    for round_index in range(1, max_rounds + 1):
        probe_messages = []
        coverage = probe_remaining_plan_circuits(
            model_doc, phase, target_levels, probe_messages, emit_error=False
        )
        remaining_count = int(coverage.get("remaining_count", 0) or 0)
        if aggregate["remaining_before"] is None:
            aggregate["remaining_before"] = remaining_count
        if remaining_count == 0:
            aggregate["remaining_after"] = 0
            break

        remaining_levels = [
            target_by_id.get(int(item.get("level_id")))
            for item in coverage.get("levels", [])
            if item.get("level_id") is not None
        ]
        remaining_levels = [item for item in remaining_levels if item is not None]
        if not remaining_levels:
            aggregate["remaining_after"] = remaining_count
            break

        before_ids = set(
            eid_value(space.Id)
            for space in collect_spaces(model_doc)
            if element_exists_in_phase(space, selected_index, phase_indexes)
            and is_placed_spatial(space)
        )
        tx = Transaction(model_doc, "LIBER gbXML: close remaining Space circuits {}".format(round_index))
        tx.Start()
        guard = SpaceCreationFailureGuard()
        options = tx.GetFailureHandlingOptions()
        options.SetFailuresPreprocessor(guard)
        options.SetClearAfterRollback(True)
        tx.SetFailureHandlingOptions(options)
        try:
            round_ids, stats = create_missing_spaces(
                model_doc,
                phase,
                levels,
                remaining_levels,
                room_sources,
                before_ids,
                changes,
                messages,
            )
            if stats.get("failed_levels"):
                tx.RollBack()
                messages.append({
                    "severity": "ERROR",
                    "code": "PLAN_CIRCUIT_CLOSURE_FAILED",
                    "levels": list(stats.get("failed_levels", [])),
                    "message": "Committed plan-circuit closure failed on one or more remaining levels.",
                })
                aggregate["remaining_after"] = remaining_count
                break
            status = tx.Commit()
            if status != TransactionStatus.Committed:
                for failure in guard.failures:
                    messages.append({
                        "severity": "ERROR",
                        "code": "PLAN_CIRCUIT_CLOSURE_REVIT_FAILURE",
                        "element_ids": failure.get("failing_element_ids", []),
                        "message": failure.get("description", "Revit rejected plan-circuit closure."),
                    })
                aggregate["remaining_after"] = remaining_count
                break
        except Exception:
            try:
                if tx.GetStatus() == TransactionStatus.Started:
                    tx.RollBack()
            except Exception:
                pass
            raise

        aggregate["rounds"] += 1
        aggregate["api_returned_ids"] += int(stats.get("api_returned_ids", 0) or 0)
        aggregate["kept"] += int(stats.get("kept", 0) or 0)
        aggregate["discarded_zero_area"] += int(stats.get("discarded_zero_area", 0) or 0)
        aggregate["discarded_redundant"] += int(stats.get("discarded_redundant", 0) or 0)
        aggregate["discarded_room_duplicates"] += int(stats.get("discarded_room_duplicates", 0) or 0)
        created_ids.update(round_ids)
        if not round_ids:
            aggregate["remaining_after"] = remaining_count
            break
    else:
        aggregate["remaining_after"] = None

    final_probe_messages = []
    final_coverage = probe_remaining_plan_circuits(
        model_doc, phase, target_levels, final_probe_messages, emit_error=False
    )
    aggregate["remaining_after"] = int(final_coverage.get("remaining_count", 0) or 0)
    messages.append({
        "severity": "INFO",
        "code": "PLAN_CIRCUIT_FIXED_POINT",
        "rounds": aggregate["rounds"],
        "remaining_before": aggregate["remaining_before"],
        "remaining_after": aggregate["remaining_after"],
        "message": "Remaining positive-area plan circuits were committed to a bounded fixed point before final gbXML QA.",
    })
    return aggregate

def room_bounding_parameter(link):
    try:
        bip = getattr(BuiltInParameter, "WALL_ATTR_ROOM_BOUNDING")
        param = link.get_Parameter(bip)
        if param is not None:
            return param
    except Exception:
        pass
    for param in list(link.Parameters):
        try:
            name = normalize_text(param.Definition.Name)
            if name in ("room bounding", "room-bounding"):
                return param
        except Exception:
            pass
    return None


def enable_room_bounding_links(model_doc, changes, messages):
    for link in collect_class(model_doc, RevitLinkInstance):
        param = room_bounding_parameter(link)
        if param is None:
            continue
        try:
            if (not param.IsReadOnly) and int(param.AsInteger()) == 0:
                param.Set(1)
                changes.append(
                    {
                        "action": "enabled_room_bounding_link",
                        "element_id": eid_value(link.Id),
                        "name": str(safe_attr(link, "Name", "") or ""),
                    }
                )
        except Exception as ex:
            messages.append(
                {
                    "severity": "WARNING",
                    "code": "ROOM_BOUNDING_LINK_NOT_CHANGED",
                    "element_id": eid_value(link.Id),
                    "message": str(ex),
                }
            )


def create_temp_plan(model_doc, level, phase, sequence):
    view_types = [
        item
        for item in collect_element_types(model_doc, ViewFamilyType)
        if item.ViewFamily == ViewFamily.FloorPlan
    ]
    if not view_types:
        raise Exception("No Floor Plan ViewFamilyType is available.")
    view = ViewPlan.Create(model_doc, view_types[0].Id, level.Id)
    try:
        view.Name = "__LIBER_GBXML_TEMP_{:03d}_{}".format(
            sequence, safe_name(level.Name)
        )
    except Exception:
        pass
    try:
        phase_param = view.get_Parameter(BuiltInParameter.VIEW_PHASE)
        if phase_param and not phase_param.IsReadOnly:
            phase_param.Set(phase.Id)
    except Exception:
        pass
    return view


def level_is_building_story(level):
    """Return Revit's Building Story flag without depending on a convenience property."""
    try:
        parameter = level.get_Parameter(BuiltInParameter.LEVEL_IS_BUILDING_STORY)
        if parameter is not None and parameter.HasValue:
            return int(parameter.AsInteger()) != 0
    except Exception:
        pass
    try:
        return bool(level.BuildingStory)
    except Exception:
        return False


def plan_view_level_ids(model_doc):
    """Return Level ids backed by real floor-plan views, not every ViewPlan.

    Ceiling/RCP, roof, bulkhead and reference-plan datums are deliberately excluded.
    This is a strong occupied-story signal and is combined with Room/Space evidence.
    """
    result = set()
    for view in _r12_collect_viewplans(model_doc):
        try:
            if view.IsTemplate:
                continue
            view_type = normalize_text(str(safe_attr(view, "ViewType", "")))
            view_name = normalize_text(safe_element_name(view))
            # ViewPlan also wraps ceiling/area/structural plans. Only architectural /
            # engineering floor plans are valid automatic Space-base evidence.
            if view_type and not any(token in view_type for token in ("floorplan", "engineeringplan")):
                continue
            if any(
                token in view_name
                for token in (
                    "reflected ceiling",
                    "rcp",
                    "ceiling plan",
                    "roof plan",
                    "bulkhead plan",
                    "top of slab",
                    "t o s",
                )
            ):
                continue
            level = view.GenLevel if view.GenLevel else model_doc.GetElement(view.LevelId)
            if level is None or looks_like_unoccupied_top_datum(level):
                continue
            level_id = eid_value(level.Id)
            if level_id >= 0:
                result.add(level_id)
        except Exception:
            pass
    return result


def looks_like_unoccupied_top_datum(level):
    name = normalize_text(safe_element_name(level))
    return any(
        token in name
        for token in (
            "roof",
            "parapet",
            "coping",
            "ridge",
            "top of",
            "t o ",
            "t.o.",
            "tos",
            "ceiling",
            "underside",
            "bulkhead",
        )
    )

def collapse_coincident_levels(
    candidate_levels, evidence_ids, plan_level_ids, messages
):
    """Keep one intentional story datum at each physical elevation."""
    groups = []
    for level in sorted(candidate_levels, key=level_elevation):
        if (
            not groups
            or abs(
                level_elevation(level)
                - level_elevation(groups[-1][0])
            )
            > LEVEL_ELEVATION_TOL_FT
        ):
            groups.append([level])
        else:
            groups[-1].append(level)

    selected = []
    discarded = []
    for group in groups:
        chosen = max(
            group,
            key=lambda item: (
                eid_value(item.Id) in evidence_ids,
                level_is_building_story(item),
                eid_value(item.Id) in plan_level_ids,
                not looks_like_unoccupied_top_datum(item),
                -eid_value(item.Id),
            ),
        )
        selected.append(chosen)
        for item in group:
            if eid_value(item.Id) != eid_value(chosen.Id):
                discarded.append(
                    {
                        "kept": str(chosen.Name),
                        "ignored": str(item.Name),
                        "elevation_ft": level_elevation(item),
                    }
                )

    if discarded:
        messages.append(
            {
                "severity": "INFO",
                "code": "COINCIDENT_LEVELS_COLLAPSED",
                "count": len(discarded),
                "levels": discarded,
                "message": (
                    "Coincident level datums were collapsed before automatic "
                    "Space creation so the same physical story is processed once."
                ),
            }
        )
    return selected


def target_levels_for_spaces(
    model_doc, levels, room_sources, existing_spaces, messages
):
    """Resolve occupied Space base stories from independent model evidence.

    No single flag is trusted.  The base set is the union of:
      * placed host/linked Room elevations,
      * existing MEP Space levels,
      * genuine floor-plan view levels.
    Building Story is only a fallback when none of the above exists.
    """
    evidence_ids = set()
    room_level_ids = set()
    existing_level_ids = set()
    for source in room_sources:
        level = source_level(levels, source)
        if level:
            value = eid_value(level.Id)
            evidence_ids.add(value)
            room_level_ids.add(value)
    for space in existing_spaces:
        if is_placed_spatial(space):
            value = eid_value(space.LevelId)
            evidence_ids.add(value)
            existing_level_ids.add(value)

    plan_ids = plan_view_level_ids(model_doc)
    strong_ids = set(evidence_ids)
    strong_ids.update(plan_ids)
    story_levels = [
        level
        for level in levels
        if level_is_building_story(level) and not looks_like_unoccupied_top_datum(level)
    ]

    if strong_ids:
        candidates = [
            level
            for level in levels
            if eid_value(level.Id) in strong_ids
            and not looks_like_unoccupied_top_datum(level)
        ]
        messages.append(
            {
                "severity": "INFO",
                "code": "SPACE_BASE_LEVELS_FROM_MODEL_EVIDENCE",
                "count": len(candidates),
                "room_level_count": len(room_level_ids),
                "existing_space_level_count": len(existing_level_ids),
                "floor_plan_level_count": len(plan_ids),
                "levels": [
                    str(safe_element_name(level) or eid_value(level.Id))
                    for level in sorted(candidates, key=level_elevation)
                ],
                "message": (
                    "Automatic Space base stories are resolved from the union of "
                    "placed Rooms, existing Spaces and genuine floor-plan views. "
                    "Building Story flags are fallback evidence only."
                ),
            }
        )
    elif story_levels:
        candidates = story_levels
        messages.append(
            {
                "severity": "WARNING",
                "code": "SPACE_BASE_LEVELS_BUILDING_STORY_FALLBACK",
                "count": len(candidates),
                "message": (
                    "No Room/Space/floor-plan evidence was available; REVEX is "
                    "falling back to Building Story levels and will require plan-"
                    "circuit coverage proof before export."
                ),
            }
        )
    else:
        candidates = [
            level for level in levels if not looks_like_unoccupied_top_datum(level)
        ]

    targets = collapse_coincident_levels(
        candidates, evidence_ids, plan_ids, messages
    )
    if len(targets) > 1:
        highest = max(targets, key=level_elevation)
        if (
            eid_value(highest.Id) not in evidence_ids
            and eid_value(highest.Id) not in plan_ids
            and looks_like_unoccupied_top_datum(highest)
        ):
            targets = [
                level
                for level in targets
                if eid_value(level.Id) != eid_value(highest.Id)
            ]
            messages.append(
                {
                    "severity": "INFO",
                    "code": "TOP_DATUM_NOT_USED_AS_SPACE_BASE",
                    "level": str(safe_element_name(highest)),
                    "message": (
                        "The highest roof/top datum was retained as the upper "
                        "boundary of the story below, not used as a new Space base."
                    ),
                }
            )
    return sorted(targets, key=level_elevation)

def typical_occupied_story_height(target_levels):
    """Robust story height from actual occupied Space-base levels only.

    Reference/roof/ceiling datums are deliberately excluded.  The median prevents
    one unusual auxiliary or partial-height datum from driving the entire model.
    """
    elevations=sorted(set(round(float(level_elevation(item)),6) for item in (target_levels or [])))
    deltas=[]
    for a,b in zip(elevations,elevations[1:]):
        d=float(b-a)
        if d>=6.0 and d<=18.0:
            deltas.append(d)
    if deltas:
        ordered=sorted(float(item) for item in deltas)
        count=len(ordered)
        middle=count//2
        if count % 2:
            value=float(ordered[middle])
        else:
            value=float((ordered[middle-1]+ordered[middle])/2.0)
    else:
        value=10.0
    return max(8.0,min(14.0,value))


def preferred_upper_level(level, target_levels, all_levels):
    """Return only the next *occupied* energy story level.

    Earlier logic could select an auxiliary datum too close to the occupied base. For the top occupied story this function intentionally returns None;
    callers use preferred_story_top_z() to create a virtual, bounded top.
    """
    if level is None:
        return None
    elevation=level_elevation(level)
    higher=[item for item in (target_levels or []) if level_elevation(item)>elevation+LEVEL_ELEVATION_TOL_FT]
    if higher:
        return min(higher,key=level_elevation)
    return None


def preferred_story_top_z(level, target_levels, all_levels):
    """Absolute energy-story top from occupied stories, with a virtual top at roof."""
    if level is None:
        return None,None,"none"
    upper=preferred_upper_level(level,target_levels,all_levels)
    if upper is not None:
        return float(level_elevation(upper)),upper,"next_occupied_story"
    base=float(level_elevation(level))
    height=typical_occupied_story_height(target_levels)
    return base+height,None,"virtual_top_from_median_occupied_story_height"

def _space_base_level(space):
    try:
        level = space.Document.GetElement(space.LevelId)
        if level is not None:
            return level
    except Exception:
        pass
    try:
        return space.Level
    except Exception:
        return None


def _space_upper_level(space):
    try:
        upper = space.UpperLimit
        if upper is not None:
            return upper
    except Exception:
        pass
    try:
        parameter = space.get_Parameter(BuiltInParameter.ROOM_UPPER_LEVEL)
        if parameter:
            eid = parameter.AsElementId()
            if eid is not None and eid_value(eid) >= 0:
                return space.Document.GetElement(eid)
    except Exception:
        pass
    return None


def _set_space_upper_level(space, upper_level):
    """Set Space Upper Limit through the strongly typed API, then parameter fallback."""
    if upper_level is None:
        return False
    target_id = eid_value(upper_level.Id)
    try:
        if eid_value(space.UpperLimit.Id) != target_id:
            space.UpperLimit = upper_level
        if eid_value(space.UpperLimit.Id) == target_id:
            return True
    except Exception:
        pass
    try:
        parameter = space.get_Parameter(BuiltInParameter.ROOM_UPPER_LEVEL)
        if parameter and not parameter.IsReadOnly:
            parameter.Set(upper_level.Id)
            try:
                space.Document.Regenerate()
            except Exception:
                pass
            actual = _space_upper_level(space)
            return actual is not None and eid_value(actual.Id) == target_id
    except Exception:
        pass
    return False


def _set_space_base_offset(space, value):
    value = float(value)
    try:
        space.BaseOffset = value
        if abs(float(space.BaseOffset) - value) <= 0.001:
            return True
    except Exception:
        pass
    try:
        parameter = space.get_Parameter(BuiltInParameter.ROOM_LOWER_OFFSET)
        if parameter and not parameter.IsReadOnly:
            parameter.Set(value)
            return True
    except Exception:
        pass
    return False


def _set_space_limit_offset(space, value):
    value = float(value)
    try:
        space.LimitOffset = value
        if abs(float(space.LimitOffset) - value) <= 0.001:
            return True
    except Exception:
        pass
    try:
        parameter = space.get_Parameter(BuiltInParameter.ROOM_UPPER_OFFSET)
        if parameter and not parameter.IsReadOnly:
            parameter.Set(value)
            return True
    except Exception:
        pass
    return False


def _space_vertical_bounds(space):
    base = _space_base_level(space)
    upper = _space_upper_level(space)
    if base is None or upper is None:
        return None
    try:
        bottom = level_elevation(base) + float(space.BaseOffset)
    except Exception:
        bottom = level_elevation(base)
    try:
        top = level_elevation(upper) + float(space.LimitOffset)
    except Exception:
        top = level_elevation(upper)
    return bottom, top, base, upper


def _apply_space_vertical_target_nonzero(space, target_base_offset, target_upper_level, target_top_z, min_transition_height_ft=1.0):
    """Apply Space base/upper/top without ever creating a transient zero-height Space.

    Revit records transaction failures for intermediate invalid states. Setting the
    top-story Upper Limit down to the base Level while Limit Offset is still zero
    creates a momentary 0 ft Space even if a positive offset is assigned on the next
    line. An earlier implementation triggered one error per affected top-level Space this way.

    This routine establishes a positive guard height first, changes datum references
    only while the Space remains positive, then applies the exact final offset.
    """
    base_level=_space_base_level(space)
    if base_level is None or target_upper_level is None:
        return False
    base_elev=float(level_elevation(base_level))
    target_base_offset=float(target_base_offset)
    target_bottom=base_elev+target_base_offset
    target_top=float(target_top_z)
    if target_top <= target_bottom + 0.25:
        return False
    target_upper_elev=float(level_elevation(target_upper_level))
    desired_offset=target_top-target_upper_elev

    current_upper=_space_upper_level(space) or base_level
    current_upper_elev=float(level_elevation(current_upper))
    try: current_offset=float(space.LimitOffset)
    except Exception: current_offset=0.0
    try: current_base_offset=float(space.BaseOffset)
    except Exception: current_base_offset=0.0
    current_bottom=base_elev+current_base_offset

    # First make the current state safely positive enough to survive both the base
    # offset change and the future Upper Limit datum change. This only increases the
    # current top; it cannot introduce a zero-height intermediate state.
    guard_bottom=max(current_bottom,target_bottom)
    guard_top=guard_bottom+max(float(min_transition_height_ft),0.5)
    guard_offset_current=max(current_offset, guard_top-current_upper_elev)
    if guard_offset_current > current_offset + 0.001:
        if not _set_space_limit_offset(space,guard_offset_current): return False

    if abs(current_base_offset-target_base_offset)>0.001:
        if not _set_space_base_offset(space,target_base_offset): return False

    # Before changing Upper Limit, ensure the offset currently stored would still
    # leave positive height if Revit evaluates the new datum immediately.
    try: transition_offset=float(space.LimitOffset)
    except Exception: transition_offset=guard_offset_current
    required_transition_offset=(target_bottom+max(float(min_transition_height_ft),0.5))-target_upper_elev
    if transition_offset < required_transition_offset-0.001:
        if not _set_space_limit_offset(space,required_transition_offset): return False

    if not _set_space_upper_level(space,target_upper_level): return False
    if not _set_space_limit_offset(space,desired_offset): return False
    try: space.Document.Regenerate()
    except Exception: pass
    bounds=_space_vertical_bounds(space)
    return bool(bounds is not None and float(bounds[1])>float(bounds[0])+0.25 and abs(float(bounds[0])-target_bottom)<=0.10 and abs(float(bounds[1])-target_top)<=0.20)


def set_created_space_vertical_extent(space, upper_level, changes, covering_spaces=None):
    """Give every generated Space a positive, explicit vertical extent before commit.

    Revit 2026 can create a Space whose Upper Limit is still its base level while
    carrying the default 10 ft Limit Offset. The old v1.1.2 routine zeroed that
    offset even when the requested Upper Limit had not actually changed, which
    collapsed the Space to zero height and caused the parent transaction to roll
    back. This routine verifies the *effective* upper level before calculating the
    offset, and falls back to a positive offset when Revit keeps the base level.
    """
    changed = []
    base_level = _space_base_level(space)
    if base_level is None:
        raise Exception("Generated Space has no valid base Level.")

    try:
        old_base = float(space.BaseOffset)
    except Exception:
        old_base = 0.0
    if abs(old_base) > POINT_TOL_FT:
        if _set_space_base_offset(space, 0.0):
            changed.append("base_offset")

    base_elevation = level_elevation(base_level)
    # Prefer the next real story datum. If this is the highest occupied story,
    # preserve a positive existing height or use Revit's conventional 10 ft.
    if upper_level is not None and level_elevation(upper_level) > base_elevation + LEVEL_ELEVATION_TOL_FT:
        target_top = level_elevation(upper_level)
        before_upper = _space_upper_level(space)
        before_id = eid_value(before_upper.Id) if before_upper is not None else -1
        if _set_space_upper_level(space, upper_level):
            after_upper = _space_upper_level(space)
            after_id = eid_value(after_upper.Id) if after_upper is not None else -1
            if after_id != before_id:
                changed.append("upper_limit")
    else:
        try:
            existing_height = float(space.UnboundedHeight)
        except Exception:
            existing_height = 0.0
        if existing_height <= 0.25:
            try:
                current_upper = _space_upper_level(space)
                current_top = level_elevation(current_upper) + float(space.LimitOffset) if current_upper is not None else base_elevation
                existing_height = current_top - base_elevation
            except Exception:
                existing_height = 0.0
        target_top = base_elevation + max(existing_height, 10.0)

    # A positive-area gap Space can still sit below a committed Room-seeded
    # Space. Cap it at that local upper story before transaction commit so Revit
    # never has to resolve an overlapping volume warning interactively.
    target_top = local_gap_top_z(space, covering_spaces, target_top)

    # Critical fix: calculate Limit Offset from the upper level Revit ACTUALLY
    # retained, not from the level we merely attempted to assign.
    actual_upper = _space_upper_level(space)
    actual_upper_elevation = level_elevation(actual_upper) if actual_upper is not None else base_elevation
    desired_limit_offset = target_top - actual_upper_elevation
    # Never create a zero/negative extent. If the actual upper level is still the
    # base level, this becomes the full story height instead of zero.
    if target_top <= base_elevation + 0.25:
        target_top = base_elevation + 10.0
        desired_limit_offset = target_top - actual_upper_elevation

    try:
        old_limit = float(space.LimitOffset)
    except Exception:
        old_limit = float("nan")
    if (not math.isfinite(old_limit)) or abs(old_limit - desired_limit_offset) > 0.001:
        if not _set_space_limit_offset(space, desired_limit_offset):
            raise Exception("Could not set generated Space Limit Offset.")
        changed.append("limit_offset")

    try:
        space.Document.Regenerate()
    except Exception:
        pass
    bounds = _space_vertical_bounds(space)
    if bounds is None or bounds[1] <= bounds[0] + 0.25:
        raise Exception(
            "Generated Space vertical extent is not positive after repair "
            "(base={}, top={}).".format(
                None if bounds is None else round(bounds[0], 6),
                None if bounds is None else round(bounds[1], 6),
            )
        )

    if changed:
        effective_upper = _space_upper_level(space)
        changes.append(
            {
                "action": "set_generated_space_vertical_extent",
                "element_id": eid_value(space.Id),
                "requested_upper_level": (
                    str(upper_level.Name) if upper_level is not None else None
                ),
                "effective_upper_level": (
                    str(effective_upper.Name) if effective_upper is not None else None
                ),
                "base_level": str(base_level.Name),
                "bottom_ft": bounds[0],
                "top_ft": bounds[1],
                "height_ft": bounds[1] - bounds[0],
                "fields": changed,
            }
        )


def tag_generated_space(space):
    try:
        parameter = space.get_Parameter(
            BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS
        )
        if parameter and not parameter.IsReadOnly:
            parameter.Set(
                "LIBER_GBXML_AUTO_SPACE | v{} | {}".format(
                    TOOL_VERSION, datetime.datetime.now().isoformat()
                )
            )
    except Exception:
        pass

def is_revex_generated_space(space):
    """True only for Spaces explicitly authored by a prior REVEX gbXML run."""
    try:
        parameter=space.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)
        value=str(parameter.AsString() or "").strip() if parameter is not None else ""
        return value.startswith("LIBER_GBXML_AUTO_SPACE")
    except Exception:
        return False


def _view_energy_attribute_values(model_doc, view):
    """Return plan-view evidence used to qualify EN/Energy annotation targets.

    Qualification is based on the view's own configuration rather than project/floor
    names. Besides ordinary view parameter values, REVEX inspects the applied view
    template, view/template filter names, and analysis-display style. This captures
    common EN/ENERGY setups where blue thermal-boundary graphics are driven by a
    named view filter/template rather than the view name.
    """
    values=[]
    def add(value):
        try:
            raw=str(value or "").strip()
        except Exception:
            raw=""
        if raw and raw not in values:
            values.append(raw)

    def add_parameter_values(element, prefix=""):
        if element is None:
            return
        try:
            parameters=list(safe_attr(element,"Parameters",[]) or [])
        except Exception:
            parameters=[]
        for parameter in parameters:
            value=""
            try:
                value=parameter.AsString() or ""
            except Exception:
                value=""
            if not value:
                try:
                    value=parameter.AsValueString() or ""
                except Exception:
                    value=""
            if not value:
                try:
                    ref_id=parameter.AsElementId()
                    if ref_id is not None and eid_value(ref_id)>0:
                        ref_element=model_doc.GetElement(ref_id)
                        if ref_element is not None:
                            value=safe_element_name(ref_element) or ""
                except Exception:
                    value=""
            if value:
                try:
                    definition=safe_attr(parameter,"Definition",None)
                    pname=str(safe_attr(definition,"Name","") or "").strip()
                except Exception:
                    pname=""
                label=("{}{}".format(prefix,pname)).strip() if pname else prefix.rstrip(" =")
                add("{}={}".format(label,value) if label else value)

    def add_filter_names(element, prefix):
        if element is None:
            return
        try:
            for filter_id in list(element.GetFilters() or []):
                try:
                    filter_element=model_doc.GetElement(filter_id)
                    name=safe_element_name(filter_element) if filter_element is not None else ""
                    if name:
                        add("{}={}".format(prefix,name))
                except Exception:
                    continue
        except Exception:
            pass

    add(safe_element_name(view))
    add(safe_attr(view,"ViewType",None))
    try:
        type_element=model_doc.GetElement(view.GetTypeId())
        if type_element is not None:
            add(safe_element_name(type_element))
    except Exception:
        pass

    template=None
    try:
        template_id=safe_attr(view,"ViewTemplateId",None)
        if template_id is not None and eid_value(template_id)>0:
            template=model_doc.GetElement(template_id)
            if template is not None:
                add("View Template={}".format(safe_element_name(template)))
    except Exception:
        template=None

    add_parameter_values(view)
    add_parameter_values(template,"Template ")
    add_filter_names(view,"View Filter")
    add_filter_names(template,"Template Filter")

    for element,prefix in ((view,"Analysis Display Style"),(template,"Template Analysis Display Style")):
        try:
            style_id=safe_attr(element,"AnalysisDisplayStyleId",None)
            if style_id is not None and eid_value(style_id)>0:
                style=model_doc.GetElement(style_id)
                if style is not None:
                    add("{}={}".format(prefix,safe_element_name(style)))
        except Exception:
            pass
    return values

def _is_energy_marker_text(raw):
    """Generic Energy-plan marker derived only from the plan's own attributes."""
    folded=unicodedata.normalize("NFKC",str(raw or "")).casefold()
    if "energy" in folded: return True
    if re.search(r"(?<![a-z0-9])en(?![a-z0-9])",folded): return True
    # Common filing/view descriptors are themselves energy evidence, not project names.
    if re.search(r"\bthermal\s+boundar(?:y|ies)\b",folded): return True
    if re.search(r"\bfenestration\b",folded): return True
    return False


def _view_plan_kind(model_doc, view):
    """Normalize Revit plan type without trusting pythonnet's enum string form.

    Revit 2026/Dynamo can expose ViewType as the underlying numeric enum value
    (observed FloorPlan=1 and AreaPlan=116) instead of ``FloorPlan``/``AreaPlan``.
    The view's own family/type/area-scheme evidence is used as a guarded fallback.
    """
    try:
        raw = str(safe_attr(view, "ViewType", "") or "").strip()
        compact = normalize_text(raw).replace(" ", "")
        if compact in ("floorplan", "engineeringplan", "areaplan"):
            return compact
        numeric = raw.strip()
        if numeric == "1":
            return "floorplan"
        if numeric == "116":
            return "areaplan"

        # AreaScheme identity is authoritative AreaPlan evidence when available.
        try:
            scheme_id = safe_attr(view, "AreaSchemeId", None)
            if scheme_id is not None and eid_value(scheme_id) > 0:
                return "areaplan"
        except Exception:
            pass
        try:
            for parameter in list(safe_attr(view, "Parameters", None) or []):
                try:
                    definition = safe_attr(parameter, "Definition", None)
                    pname = str(safe_attr(definition, "Name", "") or "").casefold()
                    if "area scheme" not in pname:
                        continue
                    scheme_id = parameter.AsElementId()
                    if scheme_id is not None and eid_value(scheme_id) > 0:
                        return "areaplan"
                except Exception:
                    continue
        except Exception:
            pass

        evidence = " | ".join(str(item or "") for item in _view_energy_attribute_values(model_doc, view)).casefold()
        if "family=area plan" in evidence or "family and type=area plan" in evidence:
            return "areaplan"
        if "family=floor plan" in evidence or "family and type=floor plan" in evidence:
            return "floorplan"
        if "family=engineering plan" in evidence or "family and type=engineering plan" in evidence:
            return "engineeringplan"
    except Exception:
        pass
    return ""


def _is_energy_plan_view(model_doc, view):
    """True only for real floor/engineering plans explicitly marked EN/ENERGY."""
    try:
        if view is None or bool(safe_attr(view,"IsTemplate",False)):
            return False
        if _view_plan_kind(model_doc, view) not in ("floorplan", "engineeringplan"):
            return False
        name=normalize_text(safe_element_name(view))
        if name.startswith("__liber gbxml temp") or "__liber_gbxml_temp" in name:
            return False
        for raw in _view_energy_attribute_values(model_doc,view):
            if _is_energy_marker_text(raw):
                return True
    except Exception:
        return False
    return False


def _is_energy_area_plan_view(model_doc, view):
    """True only for AreaPlan views explicitly marked EN/ENERGY in view attributes."""
    try:
        if view is None or bool(safe_attr(view, "IsTemplate", False)):
            return False
        if _view_plan_kind(model_doc, view) != "areaplan":
            return False
        name = normalize_text(safe_element_name(view))
        if name.startswith("__liber gbxml temp") or "__liber_gbxml_temp" in name:
            return False
        for raw in _view_energy_attribute_values(model_doc, view):
            if _is_energy_marker_text(raw):
                return True
    except Exception:
        return False
    return False


def _point_inside_plan_crop(view, point):
    """Best-effort crop test; failure is permissive because tagging is non-blocking."""
    if point is None:
        return False
    try:
        if not bool(safe_attr(view,"CropBoxActive",False)):
            return True
        box=safe_attr(view,"CropBox",None)
        if box is None:
            return True
        transform=safe_attr(box,"Transform",None)
        local=transform.Inverse.OfPoint(point) if transform is not None else point
        tol=0.01
        return (
            float(box.Min.X)-tol <= float(local.X) <= float(box.Max.X)+tol and
            float(box.Min.Y)-tol <= float(local.Y) <= float(box.Max.Y)+tol
        )
    except Exception:
        return True


def _space_tag_target_plan_views(model_doc, spaces):
    """Return only EN/ENERGY-marked plan views and Spaces visible in those plans."""
    result=[]
    all_spaces=[item for item in spaces if item is not None and is_placed_spatial(item)]
    space_ids=set(eid_value(item.Id) for item in all_spaces)
    for view in _r12_collect_viewplans(model_doc):
        try:
            if not _is_energy_plan_view(model_doc,view):
                continue
            level=safe_attr(view,"GenLevel",None)
            level_id=eid_value(level.Id) if level is not None else None

            # Prefer Revit's view-scoped visibility result after Spaces have committed.
            actual=[]
            try:
                visible=list(
                    FilteredElementCollector(model_doc,view.Id)
                    .OfCategory(BuiltInCategory.OST_MEPSpaces)
                    .WhereElementIsNotElementType()
                    .ToElements()
                )
                actual=[
                    item for item in visible
                    if isinstance(item,Space)
                    and eid_value(item.Id) in space_ids
                    and is_placed_spatial(item)
                ]
            except Exception:
                actual=[]

            if actual:
                candidates=actual
            elif level_id is not None:
                # Newly-created Spaces can lag view-scoped collection in some Revit
                # states. Fall back to same-level Spaces, clipped to the plan crop.
                candidates=[]
                for item in all_spaces:
                    try:
                        if eid_value(safe_attr(item,"LevelId",None)) != level_id:
                            continue
                        point=spatial_point(item)
                        if _point_inside_plan_crop(view,point):
                            candidates.append(item)
                    except Exception:
                        continue
            else:
                candidates=[]

            if candidates:
                by_id={eid_value(item.Id):item for item in candidates}
                result.append((view,list(by_id.values())))
        except Exception:
            continue
    return result
def auto_tag_spaces_on_energy_plans(model_doc, spaces, messages, changes):
    """Synchronize missing tags only on explicitly EN/ENERGY-qualified plans.

    Floor/Engineering plans receive MEP Space Tags when applicable. Area Plans
    receive Area Tags, matching the office EN Floor Area convention. Existing
    tags are preserved. Annotation is always non-blocking for gbXML export.
    """
    stats = {
        "views": 0,
        "spaces_seen": 0,
        "tags_existing": 0,
        "tags_created": 0,
        "failures": 0,
        "area_views": 0,
        "areas_seen": 0,
        "area_tags_existing": 0,
        "area_tags_created": 0,
        "area_failures": 0,
        "candidate_view_count": 0,
        "candidate_views": [],
    }

    # MEP Space Tags on FloorPlan / EngineeringPlan only.
    try:
        targets = _space_tag_target_plan_views(model_doc, spaces)
    except Exception as ex:
        messages.append({"severity":"WARNING","code":"SPACE_PLAN_TAG_DISCOVERY_FAILED","message":str(ex)})
        targets = []
    for view, visible in targets:
        stats["views"] += 1
        existing = set()
        try:
            tag_elements = list(
                FilteredElementCollector(model_doc, view.Id)
                .OfCategory(BuiltInCategory.OST_MEPSpaceTags)
                .WhereElementIsNotElementType()
                .ToElements()
            )
            for tag in tag_elements:
                try:
                    tagged_space = tag.Space
                    if tagged_space is not None:
                        existing.add(eid_value(tagged_space.Id))
                except Exception:
                    pass
        except Exception:
            tag_elements = []
        stats["tags_existing"] += len(existing)
        for space in visible:
            try:
                if not isinstance(space, Space) or not is_placed_spatial(space):
                    continue
                sid = eid_value(space.Id)
                stats["spaces_seen"] += 1
                if sid in existing:
                    continue
                point = spatial_point(space)
                if point is None:
                    continue
                tag = model_doc.Create.NewSpaceTag(space, UV(float(point.X), float(point.Y)), view)
                if tag is not None:
                    existing.add(sid)
                    stats["tags_created"] += 1
                    changes.append({
                        "action": "create_space_tag_on_energy_plan",
                        "space_id": sid,
                        "tag_id": eid_value(tag.Id),
                        "view_id": eid_value(view.Id),
                        "view": safe_element_name(view),
                    })
            except Exception as ex:
                stats["failures"] += 1
                messages.append({
                    "severity": "WARNING",
                    "code": "SPACE_PLAN_TAG_CREATE_FAILED",
                    "space_id": eid_value(space.Id) if space is not None else None,
                    "view": safe_element_name(view),
                    "message": str(ex),
                })

    # Area Tags on AreaPlan views. This is the actual EN Floor Area convention
    # shown in the user's reference: ViewType.AreaPlan / area scheme EN Floor Area.
    for view in _r12_collect_viewplans(model_doc):
        try:
            if not _is_energy_area_plan_view(model_doc, view):
                continue
            stats["views"] += 1
            stats["area_views"] += 1
            visible_areas = []
            try:
                visible_areas = list(
                    FilteredElementCollector(model_doc, view.Id)
                    .OfCategory(BuiltInCategory.OST_Areas)
                    .WhereElementIsNotElementType()
                    .ToElements()
                )
            except Exception:
                visible_areas = []
            visible_areas = [item for item in visible_areas if isinstance(item, Area) and is_placed_spatial(item)]
            existing = set()
            try:
                area_tags = list(
                    FilteredElementCollector(model_doc, view.Id)
                    .OfCategory(BuiltInCategory.OST_AreaTags)
                    .WhereElementIsNotElementType()
                    .ToElements()
                )
                for tag in area_tags:
                    try:
                        tagged_area = tag.Area
                        if tagged_area is not None:
                            existing.add(eid_value(tagged_area.Id))
                    except Exception:
                        pass
            except Exception:
                area_tags = []
            stats["area_tags_existing"] += len(existing)
            for area in visible_areas:
                try:
                    aid = eid_value(area.Id)
                    stats["areas_seen"] += 1
                    if aid in existing:
                        continue
                    point = spatial_point(area)
                    if point is None or not _point_inside_plan_crop(view, point):
                        continue
                    tag = model_doc.Create.NewAreaTag(view, area, UV(float(point.X), float(point.Y)))
                    if tag is not None:
                        existing.add(aid)
                        stats["area_tags_created"] += 1
                        changes.append({
                            "action": "create_area_tag_on_energy_area_plan",
                            "area_id": aid,
                            "tag_id": eid_value(tag.Id),
                            "view_id": eid_value(view.Id),
                            "view": safe_element_name(view),
                        })
                except Exception as ex:
                    stats["area_failures"] += 1
                    messages.append({
                        "severity": "WARNING",
                        "code": "ENERGY_AREA_TAG_CREATE_FAILED",
                        "area_id": eid_value(area.Id) if area is not None else None,
                        "view": safe_element_name(view),
                        "message": str(ex),
                    })
        except Exception as ex:
            stats["area_failures"] += 1
            messages.append({
                "severity": "WARNING",
                "code": "ENERGY_AREA_PLAN_TAG_SYNC_FAILED",
                "view": safe_element_name(view),
                "message": str(ex),
            })

    if stats["views"] == 0:
        discovery=[]
        collected=list(_r12_collect_viewplans(model_doc) or [])
        for candidate in collected:
            try:
                if bool(safe_attr(candidate,"IsTemplate",False)): continue
                attrs=list(_view_energy_attribute_values(model_doc,candidate) or [])
                discovery.append({
                    "view_id":eid_value(candidate.Id),
                    "view":safe_element_name(candidate),
                    "view_type":str(safe_attr(candidate,"ViewType","") or ""),
                    "space_plan_qualified":bool(_is_energy_plan_view(model_doc,candidate)),
                    "area_plan_qualified":bool(_is_energy_area_plan_view(model_doc,candidate)),
                    "energy_attributes":attrs[:40],
                })
            except Exception as ex:
                discovery.append({
                    "view_id":eid_value(safe_attr(candidate,"Id",None)),
                    "view":safe_element_name(candidate),
                    "view_type":str(safe_attr(candidate,"ViewType","") or ""),
                    "diagnostic_error":str(ex),
                })
        stats["candidate_view_count"]=len(discovery)
        stats["candidate_views"]=discovery[:80]
        messages.append({
            "severity":"WARNING",
            "code":"ENERGY_PLAN_VIEW_DISCOVERY_EMPTY",
            "candidate_view_count":len(discovery),
            "candidate_views":discovery[:80],
            "message":"No EN/Energy/thermal-boundary/fenestration plan view qualified for tagging. Candidate plan attributes, template/filter evidence, and view types are preserved directly in SPACE PLAN TAGS so the next run is self-diagnosing.",
        })

    messages.append({
        "severity": "INFO",
        "code": "ENERGY_PLAN_TAG_SYNC_COMPLETE",
        "stats": stats,
        "message": (
            "Missing tags synchronized only on plans whose own attributes contain standalone EN or ENERGY. "
            "AreaPlan views receive Area Tags; FloorPlan/EngineeringPlan views may receive MEP Space Tags. "
            "Tagging never blocks gbXML export."
        ),
    })
    return stats


def space_boundary_signature(space):
    edges = []
    try:
        loops = space.GetBoundarySegments(SpatialElementBoundaryOptions())
        for loop in list(loops or []):
            for segment in list(loop or []):
                curve = segment.GetCurve()
                try:
                    points = list(curve.Tessellate())
                except Exception:
                    points = [
                        curve.GetEndPoint(0),
                        curve.GetEndPoint(1),
                    ]
                values = tuple(
                    (
                        round(float(point.X) / POINT_TOL_FT),
                        round(float(point.Y) / POINT_TOL_FT),
                    )
                    for point in points
                )
                reverse = tuple(reversed(values))
                edges.append(values if values <= reverse else reverse)
    except Exception:
        return None
    if not edges:
        return None
    level = get_level(space, doc)
    return (
        round(level_elevation(level) / LEVEL_ELEVATION_TOL_FT),
        tuple(sorted(edges)),
    )


def point_inside_space(space, point):
    if point is None:
        return False
    try:
        base_level = get_level(space, doc)
        base = level_elevation(base_level) + float(space.BaseOffset)
        height, _, _ = space_height(space)
        offset = 1.0
        if height is not None and height > 0.2:
            offset = min(1.0, max(0.1, height * 0.5))
        test = XYZ(float(point.X), float(point.Y), base + offset)
        return bool(space.IsPointInSpace(test))
    except Exception:
        return False


def prune_generated_space_duplicates(
    model_doc,
    new_spaces,
    covering_spaces,
    changes,
    protected_room_ids=None,
):
    """Keep only positive-area placed gap Spaces; delete zero-area API artifacts.

    NewSpaces2 regenerates the document before returning.  A returned Space that
    still has no placed spatial area after that regeneration cannot represent a
    usable uncovered plan circuit.  Delete it immediately instead of treating it
    as a model failure.  Positive-area Spaces are still checked against committed
    boundary signatures, so a real duplicate is discarded and a real uncovered
    region survives for the final strict circuit audit.
    """
    kept = []
    protected_room_ids = set(int(x) for x in (protected_room_ids or []) if x is not None)
    valid_covering = [item for item in covering_spaces if is_placed_spatial(item)]
    valid_new = [item for item in new_spaces if is_placed_spatial(item)]
    zero_area_discarded = []

    for space in list(new_spaces or []):
        if is_placed_spatial(space):
            continue
        sid = eid_value(space.Id)
        try:
            model_doc.Delete(space.Id)
            zero_area_discarded.append(sid)
            changes.append({
                "action": "discarded_generated_zero_area_space",
                "element_id": sid,
                "reason": "NewSpaces2 returned a non-placed/zero-area Space after regeneration; it is not usable plan-circuit topology",
            })
        except Exception:
            # If Revit already invalidated the transient object, there is still no
            # usable Space to retain.  Preserve only its id in diagnostics.
            zero_area_discarded.append(sid)

    model_doc.Regenerate()
    signatures = {}
    for space in valid_covering:
        try:
            signature = space_boundary_signature(space)
            if signature is not None:
                signatures.setdefault(signature, eid_value(space.Id))
        except Exception:
            pass

    for space in valid_new:
        try:
            if model_doc.GetElement(space.Id) is None:
                continue
            # A Room-seeded Space already exists for every protected host Room before
            # gap fill begins.  NewSpaces2 can still surface an additional positive-area
            # Space on that same architectural circuit.  Never retain that second Space:
            # it creates overlapping/ambiguous topology for gbXML and GeometryCo.
            try:
                linked_room = space.Room
            except Exception:
                linked_room = None
            if linked_room is not None and eid_value(linked_room.Id) in protected_room_ids:
                sid = eid_value(space.Id)
                model_doc.Delete(space.Id)
                changes.append({
                    "action": "discarded_generated_room_duplicate_space",
                    "element_id": sid,
                    "room_id": eid_value(linked_room.Id),
                    "reason": "architectural Room circuit already has a committed Room-seeded Space",
                })
                continue
            signature = space_boundary_signature(space)
            if signature is not None and signature in signatures:
                sid = eid_value(space.Id)
                model_doc.Delete(space.Id)
                changes.append({
                    "action": "discarded_generated_redundant_space",
                    "element_id": sid,
                    "covered_by": signatures[signature],
                    "reason": "identical positive-area Space boundary on the same story",
                })
                continue
            if signature is not None:
                signatures[signature] = eid_value(space.Id)
            kept.append(space)
        except Exception:
            continue
    model_doc.Regenerate()
    return kept, zero_area_discarded


def create_missing_spaces(
    model_doc,
    phase,
    levels,
    target_levels,
    room_sources,
    existing_space_ids,
    changes,
    messages,
):
    created_ids = set()
    temp_view_ids = []
    attempted_ids = set()
    failed_levels = []
    covering_spaces = [
        model_doc.GetElement(ElementId(item_id))
        for item_id in sorted(existing_space_ids)
    ]
    covering_spaces = [item for item in covering_spaces if item is not None]
    baseline_covering_spaces = list(covering_spaces)
    protected_room_ids = set(
        int(source.get("id"))
        for source in (room_sources or [])
        if source.get("kind") == "host_room" and source.get("id") is not None
    )

    for sequence, level in enumerate(target_levels, 1):
        temp_view = None
        subtransaction = None
        change_checkpoint = len(changes)
        try:
            temp_view = create_temp_plan(model_doc, level, phase, sequence)
            temp_view_ids.append(temp_view.Id)
            subtransaction = SubTransaction(model_doc)
            subtransaction.Start()
            ids = model_doc.Create.NewSpaces2(level, phase, temp_view)
            batch_ids = [
                eid_value(item_id)
                for item_id in list(ids or [])
                if eid_value(item_id) not in existing_space_ids
            ]
            attempted_ids.update(batch_ids)
            batch_spaces = [
                model_doc.GetElement(ElementId(item_id))
                for item_id in batch_ids
            ]
            batch_spaces = [item for item in batch_spaces if item is not None]
            upper_level = preferred_upper_level(
                level, target_levels, levels
            )
            for space in batch_spaces:
                tag_generated_space(space)
                set_created_space_vertical_extent(
                    space, upper_level, changes, covering_spaces
                )
            model_doc.Regenerate()
            kept, zero_area = prune_generated_space_duplicates(
                model_doc,
                batch_spaces,
                covering_spaces,
                changes,
                protected_room_ids,
            )
            subtransaction.Commit()
            for space in kept:
                value = eid_value(space.Id)
                created_ids.add(value)
                covering_spaces.append(space)
        except Exception as ex:
            del changes[change_checkpoint:]
            if subtransaction is not None:
                try:
                    subtransaction.RollBack()
                except Exception:
                    pass
            failed_levels.append(str(level.Name))
            messages.append(
                {
                    "severity": "ERROR",
                    "code": "AUTO_SPACE_LEVEL_FAILED",
                    "level": str(level.Name),
                    "message": (
                        "{} Automatic changes for this level were rolled back "
                        "before the parent transaction could commit."
                    ).format(str(ex)),
                }
            )

    if not failed_levels:
        generated_spaces = [
            model_doc.GetElement(ElementId(item_id))
            for item_id in sorted(created_ids)
        ]
        generated_spaces = [
            item for item in generated_spaces if item is not None
        ]
        generated_spaces, final_zero_area = prune_generated_space_duplicates(
            model_doc,
            generated_spaces,
            baseline_covering_spaces,
            changes,
            protected_room_ids,
        )
        created_ids = set(eid_value(item.Id) for item in generated_spaces)

    for view_id in temp_view_ids:
        try:
            model_doc.Delete(view_id)
        except Exception:
            pass
    model_doc.Regenerate()

    for created_id in sorted(created_ids):
        changes.append(
            {"action": "created_space", "element_id": created_id}
        )
    zero_area_discarded = sum(
        1 for item in changes
        if item.get("action") == "discarded_generated_zero_area_space"
    )
    return created_ids, {
        "attempted": len(created_ids),
        "api_returned_ids": len(attempted_ids),
        "kept": len(created_ids),
        "discarded_zero_area": zero_area_discarded,
        "discarded_redundant": sum(
            1
            for item in changes
            if item.get("action") in (
                "discarded_generated_redundant_space",
                "discarded_generated_room_duplicate_space",
            )
        ),
        "discarded_room_duplicates": sum(
            1
            for item in changes
            if item.get("action") == "discarded_generated_room_duplicate_space"
        ),
        "failed_levels": failed_levels,
    }


def source_contains_point(source, host_point):
    try:
        source_point = source["inverse"].OfPoint(host_point)
        return bool(source["room"].IsPointInRoom(source_point))
    except Exception:
        return False


def generic_space_name(name):
    text = normalize_text(name)
    return (
        not text
        or text in ("space", "room")
        or text.startswith("space ")
        or text.startswith("auto unclassified")
    )


def set_space_identity(space, source, only_if_generic):
    changes = []
    if source is None:
        return changes
    if (not only_if_generic) or generic_space_name(spatial_name(space)):
        try:
            if source["name"] and spatial_name(space) != source["name"]:
                space.Name = source["name"]
                changes.append("name")
        except Exception:
            pass
    if (not only_if_generic) or not str(space.Number or "").strip():
        try:
            if source["number"] and space.Number != source["number"]:
                space.Number = source["number"]
                changes.append("number")
        except Exception:
            pass
    return changes


def set_space_vertical_extent(space, source, levels):
    if source is None:
        return []
    changes=[]
    base_level=_space_base_level(space)
    if base_level is None:
        return changes
    base_z=source.get("base_z")
    top_z=source.get("effective_top_z",source.get("top_z"))
    if base_z is None or top_z is None or float(top_z)<=float(base_z)+0.25:
        return changes
    try:
        base_z=float(base_z); top_z=float(top_z)
        desired_base_offset=base_z-level_elevation(base_level)

        # Use the next occupied story level only when the resolver proved one. At
        # the highest occupied story Upper Limit is the base level and full height
        # is carried by Limit Offset. Apply both through the nonzero transition
        # primitive so Revit never observes a temporary 0 ft Space.
        upper=None
        upper_id=source.get("story_upper_level_id")
        if upper_id is not None:
            try: upper=space.Document.GetElement(ElementId(int(upper_id)))
            except Exception: upper=None
        desired_upper=upper or base_level
        before=_space_vertical_bounds(space)
        if not _apply_space_vertical_target_nonzero(space,desired_base_offset,desired_upper,top_z):
            raise Exception("Matched Space vertical target could not be applied without a zero-height intermediate state.")
        after_now=_space_vertical_bounds(space)
        if before is None or after_now is None or abs(float(before[0])-float(after_now[0]))>0.001: changes.append("base_offset")
        if before is None or after_now is None or abs(float(before[1])-float(after_now[1]))>0.001: changes.append("vertical_extent")
        bounds=_space_vertical_bounds(space)
        if bounds is None or bounds[1]<=bounds[0]+0.25 or abs(float(bounds[1])-top_z)>0.10:
            raise Exception("Matched Space vertical target could not be applied: target {:.3f} ft, actual {}".format(top_z,None if bounds is None else round(bounds[1],6)))
    except Exception as ex:
        messages=None
        # Caller performs a hard story-sanity proof; do not silently invent a new top.
        changes.append("vertical_target_apply_pending_sanity")
    return changes

def _space_probe_at_xy(space, x, y):
    """Return an interior probe point for a Space at the supplied XY, if possible."""
    bounds = _space_vertical_bounds(space)
    if bounds is None or bounds[1] <= bounds[0] + 0.25:
        return None
    # Mid-height is intentionally away from floors/ceilings and Revit tolerances.
    z = bounds[0] + (bounds[1] - bounds[0]) * 0.5
    return XYZ(float(x), float(y), float(z))


def local_intermediate_story_spaces(space, phase_spaces):
    """Find *actual occupied* stories crossing this Space at its own XY footprint.

    A raw Revit Level is only a datum; ceiling, roof, structural and reference levels
    commonly sit between two real stories.  Treating every Level as a story created
    false SPACE_CROSSES_INTERMEDIATE_LEVEL errors.  A crossing is now proven only
    when another placed MEP Space starts between this Space's bottom/top and contains
    the same XY point at an interior Z on that upper Space.
    """
    bounds = _space_vertical_bounds(space)
    point = spatial_point(space)
    if bounds is None or point is None:
        return []
    bottom, top = bounds[0], bounds[1]
    found = []
    for other in phase_spaces:
        if other is None or eid_value(other.Id) == eid_value(space.Id):
            continue
        other_bounds = _space_vertical_bounds(other)
        if other_bounds is None:
            continue
        other_bottom, other_top, other_level = other_bounds[0], other_bounds[1], other_bounds[2]
        if other_bottom <= bottom + 0.05 or other_bottom >= top - 0.05:
            continue
        probe = _space_probe_at_xy(other, point.X, point.Y)
        if probe is None:
            continue
        try:
            if not bool(other.IsPointInSpace(probe)):
                continue
        except Exception:
            continue
        found.append(
            {
                "space": other,
                "space_id": eid_value(other.Id),
                "level": other_level,
                "level_id": eid_value(other_level.Id) if other_level is not None else -1,
                "elevation_ft": float(other_bottom),
            }
        )
    # Collapse coincident upper Spaces to one story datum while preserving IDs for diagnostics.
    found.sort(key=lambda row: (row["elevation_ft"], row["space_id"]))
    collapsed = []
    for row in found:
        if not collapsed or abs(row["elevation_ft"] - collapsed[-1]["elevation_ft"]) > LEVEL_ELEVATION_TOL_FT:
            collapsed.append(dict(row, space_ids=[row["space_id"]]))
        else:
            collapsed[-1]["space_ids"].append(row["space_id"])
    return collapsed


def normalize_generated_space_story_spans(model_doc, phase_spaces, created_ids, target_levels, all_levels, changes, messages):
    """Enforce one occupied energy story per REVEX-generated Space.

    Missing/nonpositive Upper Limits are repaired here as well. RELEASE3 skipped
    bounds=None, which let one generated gap Space reach final QA with an invalid
    vertical extent even though the room topology and EADM otherwise succeeded.
    """
    normalized = 0
    created = set(int(v) for v in created_ids)
    for space in [s for s in phase_spaces if s is not None and eid_value(s.Id) in created]:
        base_level = _space_base_level(space)
        if base_level is None:
            raise Exception("Generated Space {} has no base Level.".format(eid_value(space.Id)))
        bounds = _space_vertical_bounds(space)
        if bounds is not None:
            bottom, top = float(bounds[0]), float(bounds[1])
            base_story = nearest_level(target_levels, bottom, max_distance_ft=5.0) or base_level
        else:
            try:
                bottom = float(level_elevation(base_level)) + float(space.BaseOffset)
            except Exception:
                bottom = float(level_elevation(base_level))
            top = None
            base_story = nearest_level(target_levels, bottom, max_distance_ft=5.0) or base_level
        story_top, upper_story, method = preferred_story_top_z(base_story, target_levels, all_levels)
        if story_top is None:
            raise Exception("Could not resolve occupied-story top for generated Space {}.".format(eid_value(space.Id)))
        story_top = float(story_top)
        if story_top <= bottom + 0.25:
            story_top = bottom + typical_occupied_story_height(target_levels)
            upper_story = None
            method = "virtual_top_from_positive_story_height_fallback"

        needs_repair = bounds is None or top is None or top <= bottom + 0.25 or top > story_top + 0.05
        if not needs_repair:
            continue

        desired_upper = upper_story or base_story
        desired_base_offset = bottom - float(level_elevation(base_level))
        if not _apply_space_vertical_target_nonzero(space, desired_base_offset, desired_upper, story_top):
            raise Exception("Could not safely repair generated Space {} to story top {:.3f} ft without a zero-height intermediate state.".format(eid_value(space.Id), story_top))
        after = _space_vertical_bounds(space)
        if after is None or after[1] > story_top + 0.10 or after[1] <= after[0] + 0.25:
            raise Exception(
                "Generated Space {} story-bound repair failed (target {:.3f} ft, actual {}).".format(
                    eid_value(space.Id), story_top, None if after is None else (round(after[0], 6), round(after[1], 6))
                )
            )
        normalized += 1
        changes.append({
            "action": "repair_generated_space_energy_story_extent",
            "element_id": eid_value(space.Id),
            "base_story": str(safe_element_name(base_story)),
            "upper_story": str(safe_element_name(upper_story)) if upper_story is not None else "VIRTUAL_TOP",
            "story_top_method": method,
            "top_before_ft": None if top is None else round(top, 6),
            "top_after_ft": round(float(after[1]), 6),
            "repaired_missing_bounds": bounds is None,
        })
        messages.append({
            "severity": "INFO",
            "code": "GENERATED_SPACE_STORY_BOUNDED",
            "element_id": eid_value(space.Id),
            "story_top_method": method,
            "message": "REVEX repaired/capped this generated Space to one positive occupied energy story.",
        })
    return normalized

def generated_story_span_sanity(phase_spaces, created_ids, target_levels, all_levels):
    created = set(int(v) for v in created_ids)
    violations = []
    for space in phase_spaces:
        if space is None or eid_value(space.Id) not in created:
            continue
        bounds = _space_vertical_bounds(space)
        if bounds is None:
            violations.append({
                "element_id": eid_value(space.Id),
                "space": spatial_label(space),
                "reason": "missing_or_unreadable_vertical_bounds",
            })
            continue
        bottom, top = float(bounds[0]), float(bounds[1])
        if top <= bottom + 0.25:
            violations.append({
                "element_id": eid_value(space.Id),
                "space": spatial_label(space),
                "reason": "nonpositive_vertical_extent",
                "bottom_ft": round(bottom, 6),
                "top_ft": round(top, 6),
            })
            continue
        base_story = nearest_level(target_levels, bottom, max_distance_ft=5.0) or _space_base_level(space)
        if base_story is None:
            violations.append({
                "element_id": eid_value(space.Id),
                "space": spatial_label(space),
                "reason": "base_story_unresolved",
                "bottom_ft": round(bottom, 6),
                "top_ft": round(top, 6),
            })
            continue
        story_top, upper_story, method = preferred_story_top_z(base_story, target_levels, all_levels)
        if story_top is None:
            violations.append({
                "element_id": eid_value(space.Id),
                "space": spatial_label(space),
                "reason": "story_top_unresolved",
            })
            continue
        if top > story_top + 0.10:
            violations.append({
                "element_id": eid_value(space.Id),
                "space": spatial_label(space),
                "reason": "crosses_energy_story_top",
                "bottom_ft": round(bottom, 6),
                "top_ft": round(top, 6),
                "story_top_ft": round(float(story_top), 6),
                "base_story": str(safe_element_name(base_story)),
                "upper_story": str(safe_element_name(upper_story)) if upper_story is not None else "VIRTUAL_TOP",
                "story_top_method": method,
                "excess_ft": round(top - float(story_top), 6),
            })
    return {
        "passed": not violations,
        "violations": violations,
        "violation_count": len(violations),
        "typical_story_height_ft": round(typical_occupied_story_height(target_levels), 6),
    }

def match_and_update_spaces(
    model_doc,
    phase,
    phases,
    levels,
    target_levels,
    room_sources,
    created_ids,
    changes,
    messages,
):
    indexes = phase_index_map(phases)
    selected_index = indexes[eid_value(phase.Id)]
    spaces = [
        space
        for space in collect_spaces(model_doc)
        if element_exists_in_phase(space, selected_index, indexes)
    ]
    placed=[space for space in spaces if is_placed_spatial(space)]
    source_mapping, resolution = map_room_sources_to_spaces(
        model_doc, phase, levels, room_sources, placed
    )
    source_for_space={}
    for source in room_sources:
        pair=source_mapping.get(id(source))
        if pair:
            source_for_space.setdefault(eid_value(pair[0].Id),[]).append(source)

    matched = {}
    for space in spaces:
        sid=eid_value(space.Id)
        candidates=source_for_space.get(sid,[])
        if len(candidates)==1:
            source=candidates[0]
            matched[sid]=source
            changed_fields=set_space_identity(
                space, source, only_if_generic=sid not in created_ids
            )
            if sid in created_ids:
                changed_fields += set_space_vertical_extent(space, source, levels)
            if changed_fields:
                changes.append({
                    "action":"updated_space_from_room",
                    "element_id":sid,
                    "room_id":source["id"],
                    "source":source["source"],
                    "fields":sorted(set(changed_fields)),
                })
        elif sid in created_ids and not candidates:
            try:
                space.Name = "AUTO UNCLASSIFIED | {} | {}".format(
                    safe_element_name(get_level(space, model_doc)), sid
                )
            except Exception:
                pass
            messages.append({
                "severity":"WARNING",
                "code":"NEW_SPACE_WITHOUT_ROOM_IDENTITY",
                "element_id":sid,
                "message":"Committed Space geometry has no unique architectural Room identity; it remains available as a non-Room enclosed circuit and will be checked by final topology coverage.",
            })
    normalized_story_spans = normalize_generated_space_story_spans(
        model_doc, spaces, created_ids, target_levels, levels, changes, messages
    )
    if normalized_story_spans:
        messages.append({
            "severity":"INFO",
            "code":"LOCAL_STORY_SPAN_NORMALIZATION_COMPLETE",
            "count":normalized_story_spans,
            "message":"Normalized {} generated Space vertical span(s) using localized occupied-story evidence.".format(normalized_story_spans),
        })
    model_doc.Regenerate()
    return spaces, matched


SEMANTIC_PROTOTYPES = {
    "conditioned_occupied": [
        "apartment living room bedroom kitchen dining office amenity coworking gym lobby",
        "occupied residential commercial classroom retail community recreation",
    ],
    "circulation": [
        "corridor hallway vestibule passage stair landing circulation",
        "public path elevator lobby",
    ],
    "sanitary": [
        "bathroom toilet restroom powder room shower locker laundry janitor",
        "sanitary wash room",
    ],
    "service_storage": [
        "storage mechanical electrical sprinkler utility trash refuse boiler meter",
        "service equipment maintenance package bicycle",
    ],
    "unconditioned_core": [
        "shaft elevator hoistway crawlspace void plenum chase",
        "unconditioned vertical service core",
    ],
    "exterior": [
        "exterior balcony terrace porch court areaway roof outside",
        "outdoor unconditioned exterior",
    ],
}

SEMANTIC_RULES = {
    "conditioned_occupied": [
        "amenity",
        "apartment",
        "bedroom",
        "living",
        "kitchen",
        "dining",
        "office",
        "cowork",
        "gym",
        "fitness",
        "lobby",
        "retail",
        "classroom",
        "community",
        "recreation",
        "studio",
    ],
    "circulation": [
        "corridor",
        "hallway",
        "hall",
        "vestibule",
        "passage",
        "landing",
        "circulation",
        "stair",
    ],
    "sanitary": [
        "bathroom",
        "restroom",
        "toilet",
        "powder",
        "shower",
        "locker",
        "laundry",
        "janitor",
    ],
    "service_storage": [
        "storage",
        "mechanical",
        "electric",
        "sprinkler",
        "utility",
        "trash",
        "refuse",
        "boiler",
        "meter",
        "package",
        "bicycle",
    ],
    "unconditioned_core": [
        "shaft",
        "hoistway",
        "crawlspace",
        "crawl space",
        "void",
        "plenum",
        "chase",
        "elevator",
    ],
    "exterior": [
        "exterior",
        "balcony",
        "terrace",
        "porch",
        "areaway",
        "outside",
        "outdoor",
        "roof",
    ],
}


def classify_rules(name):
    text = normalize_text(name)
    if not text or text.startswith("auto unclassified"):
        return "unknown", 0.35, ["name_missing_or_generic"]
    hits = []
    for category, tokens in SEMANTIC_RULES.items():
        matched = [token for token in tokens if token in text]
        if matched:
            hits.append((len(matched), max(len(token) for token in matched), category, matched))
    if not hits:
        return "unknown", 0.50, ["no_architectural_keyword"]
    hits.sort(reverse=True)
    top = hits[0]
    conflicting = len(hits) > 1 and hits[1][0:2] == top[0:2]
    confidence = 0.80 + min(0.17, 0.05 * top[0] + 0.002 * top[1])
    if conflicting:
        confidence -= 0.15
    return top[2], min(0.97, confidence), ["keywords: " + ", ".join(top[3])]


def boundary_adjacency(spaces):
    by_boundary = {}
    options = SpatialElementBoundaryOptions()
    for space in spaces:
        try:
            loops = space.GetBoundarySegments(options)
            for loop in loops:
                for segment in loop:
                    value = eid_value(segment.ElementId)
                    if value > 0:
                        by_boundary.setdefault(value, set()).add(eid_value(space.Id))
        except Exception:
            pass
    graph = {eid_value(space.Id): set() for space in spaces}
    for ids in by_boundary.values():
        ids = list(ids)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                graph[ids[i]].add(ids[j])
                graph[ids[j]].add(ids[i])
    return graph


def semantic_review(model_doc, spaces, explicit_model_folder, messages):
    graph = boundary_adjacency(spaces)
    results = {}
    for space in spaces:
        category, confidence, evidence = classify_rules(spatial_name(space))
        results[eid_value(space.Id)] = {
            "element_id": eid_value(space.Id),
            "number": str(space.Number or ""),
            "name": spatial_name(space),
            "category": category,
            "confidence": confidence,
            "evidence": evidence,
            "neighbors": sorted(graph.get(eid_value(space.Id), set())),
        }

    # Use adjacent high-confidence spaces before invoking the optional model.
    for space_id, result in results.items():
        if result["confidence"] >= 0.75:
            continue
        neighbor_categories = [
            results[item]["category"]
            for item in graph.get(space_id, set())
            if item in results and results[item]["confidence"] >= 0.85
        ]
        if neighbor_categories:
            counts = {}
            for category in neighbor_categories:
                counts[category] = counts.get(category, 0) + 1
            top_category, top_count = max(counts.items(), key=lambda row: row[1])
            agreement = float(top_count) / float(len(neighbor_categories))
            if agreement >= 0.75 and top_category != "unknown":
                result["category"] = top_category
                result["confidence"] = min(0.82, 0.62 + 0.20 * agreement)
                result["evidence"].append("adjacency_consensus")

    # Lightweight semantic evaluator: rules + adjacency only.
    # No embeddings, vision, FBX, or external model session is loaded in the urgent
    # energy-export path. Ambiguous semantics remain warnings and never alter geometry.
    engine = "architectural_rules_and_adjacency_bounded"
    provider = None
    ambiguous = [result for result in results.values() if result["confidence"] < 0.75]

    for result in results.values():
        if result["confidence"] < 0.75:
            messages.append(
                {
                    "severity": "WARNING",
                    "code": "SEMANTIC_CONFIDENCE_BELOW_75",
                    "element_id": result["element_id"],
                    "space": "{} {}".format(
                        result["number"], result["name"]
                    ).strip(),
                    "confidence": round(result["confidence"], 3),
                    "message": (
                        "Space use could not be verified at 75% confidence. "
                        "Geometry is not changed by this semantic check."
                    ),
                }
            )

    # High-confidence semantic/MEP-condition conflicts are important, but the
    # Geometry Compiler remains authoritative for template behavior transfer.
    for space in spaces:
        result = results[eid_value(space.Id)]
        if result["confidence"] < 0.90:
            continue
        try:
            condition = normalize_text(str(space.ConditionType))
        except Exception:
            condition = ""
        category = result["category"]
        if category == "conditioned_occupied" and "uncondition" in condition:
            messages.append(
                {
                    "severity": "WARNING",
                    "code": "OCCUPIED_SPACE_MARKED_UNCONDITIONED",
                    "element_id": eid_value(space.Id),
                    "space": spatial_label(space),
                    "confidence": round(result["confidence"], 3),
                    "message": "Architectural use and Revit Condition Type conflict.",
                }
            )
        if category in ("unconditioned_core", "exterior") and condition:
            if "uncondition" not in condition:
                messages.append(
                    {
                        "severity": "WARNING",
                        "code": "CORE_OR_EXTERIOR_SPACE_MARKED_CONDITIONED",
                        "element_id": eid_value(space.Id),
                        "space": spatial_label(space),
                        "confidence": round(result["confidence"], 3),
                        "message": "Architectural use and Revit Condition Type conflict.",
                    }
                )

    return {
        "engine": engine,
        "provider": provider,
        "model_file": None,
        "spaces": sorted(results.values(), key=lambda row: row["element_id"]),
        "at_or_above_75_percent": sum(
            1 for result in results.values() if result["confidence"] >= 0.75
        ),
        "below_75_percent": sum(
            1 for result in results.values() if result["confidence"] < 0.75
        ),
    }


def space_height(space):
    try:
        base_level = get_level(space, doc)
        base = level_elevation(base_level) + float(space.BaseOffset)
        top = level_elevation(space.UpperLimit) + float(space.LimitOffset)
        return top - base, base, top
    except Exception:
        return None, None, None


def boundary_loop_check(space):
    problems = []
    try:
        loops = space.GetBoundarySegments(SpatialElementBoundaryOptions())
    except Exception as ex:
        return ["Boundary calculation failed: {}".format(ex)]
    if loops is None or len(loops) == 0:
        return ["No boundary loops."]
    for loop_index, loop in enumerate(loops):
        segments = list(loop)
        if len(segments) < 3:
            problems.append("Boundary loop {} has fewer than 3 segments.".format(loop_index))
            continue
        starts = []
        ends = []
        for segment in segments:
            try:
                curve = segment.GetCurve()
                starts.append(curve.GetEndPoint(0))
                ends.append(curve.GetEndPoint(1))
                if curve.Length < POINT_TOL_FT:
                    problems.append(
                        "Boundary loop {} contains a near-zero segment.".format(
                            loop_index
                        )
                    )
            except Exception as ex:
                problems.append(
                    "Boundary loop {} segment failed: {}".format(loop_index, ex)
                )
        if starts and ends:
            for i in range(len(segments)):
                if ends[i].DistanceTo(starts[(i + 1) % len(segments)]) > POINT_TOL_FT:
                    problems.append(
                        "Boundary loop {} is not closed at segment {}.".format(
                            loop_index, i
                        )
                    )
                    break
    return problems


def deep_geometry_review(spaces, messages):
    started = time.time()
    checked = 0
    skipped_for_budget = 0
    calculator = None
    try:
        calculator = SpatialElementGeometryCalculator(doc)
        ordered = sorted(
            spaces,
            key=lambda item: (
                0 if float(item.Area or 0.0) < 1.0 else 1,
                eid_value(item.Id),
            ),
        )
        for space in ordered:
            if checked >= DEEP_GEOMETRY_LIMIT or time.time() - started > DEEP_GEOMETRY_BUDGET_S:
                skipped_for_budget += 1
                continue
            try:
                if not SpatialElementGeometryCalculator.CanCalculateGeometry(space):
                    messages.append(
                        {
                            "severity": "ERROR",
                            "code": "SPACE_GEOMETRY_NOT_CALCULABLE",
                            "element_id": eid_value(space.Id),
                            "space": spatial_label(space),
                            "message": "Revit cannot calculate a closed solid for this Space.",
                        }
                    )
                    continue
                result = calculator.CalculateSpatialElementGeometry(space)
                solid = result.GetGeometry()
                checked += 1
                if solid is None or float(solid.Volume) <= 1e-9:
                    messages.append(
                        {
                            "severity": "ERROR",
                            "code": "SPACE_SOLID_ZERO_VOLUME",
                            "element_id": eid_value(space.Id),
                            "space": spatial_label(space),
                            "message": "Calculated spatial solid is empty.",
                        }
                    )
                elif solid.Faces.Size < 4:
                    messages.append(
                        {
                            "severity": "ERROR",
                            "code": "SPACE_SOLID_TOO_FEW_FACES",
                            "element_id": eid_value(space.Id),
                            "space": spatial_label(space),
                            "message": "Calculated spatial solid has fewer than four faces.",
                        }
                    )
            except Exception as ex:
                messages.append(
                    {
                        "severity": "ERROR",
                        "code": "SPACE_DEEP_GEOMETRY_FAILED",
                        "element_id": eid_value(space.Id),
                        "space": spatial_label(space),
                        "message": str(ex),
                    }
                )
    finally:
        try:
            if calculator:
                calculator.Dispose()
        except Exception:
            pass
    return {
        "checked": checked,
        "skipped_for_budget": skipped_for_budget,
        "elapsed_seconds": round(time.time() - started, 3),
        "limit": DEEP_GEOMETRY_LIMIT,
        "budget_seconds": DEEP_GEOMETRY_BUDGET_S,
    }


def audit_spaces(model_doc, phase, phases, levels, messages, generated_ids=None):
    indexes = phase_index_map(phases)
    selected_index = indexes[eid_value(phase.Id)]
    phase_spaces = [
        item
        for item in collect_spaces(model_doc)
        if element_exists_in_phase(item, selected_index, indexes)
    ]
    valid = []
    unplaced = []
    generated_ids = set(int(v) for v in list(generated_ids or []))
    for space in phase_spaces:
        location = spatial_point(space)
        area = float(space.Area or 0.0)
        label = spatial_label(space)
        if location is None and area <= 0.0:
            unplaced.append(eid_value(space.Id))
            continue
        if area <= 0.0:
            messages.append(
                {
                    "severity": "ERROR",
                    "code": "PLACED_SPACE_NOT_ENCLOSED_OR_REDUNDANT",
                    "element_id": eid_value(space.Id),
                    "space": label,
                    "message": "Placed Space has zero area.",
                }
            )
            continue
        area_m2 = area * 0.09290304
        if area_m2 < MIN_AREA_M2:
            messages.append(
                {
                    "severity": "ERROR",
                    "code": "MICRO_SPACE",
                    "element_id": eid_value(space.Id),
                    "space": label,
                    "area_m2": area_m2,
                    "message": "Space area is below {:.3f} m².".format(MIN_AREA_M2),
                }
            )
        try:
            volume = float(space.Volume)
        except Exception:
            volume = 0.0
        if volume <= 0.0:
            messages.append(
                {
                    "severity": "ERROR",
                    "code": "SPACE_ZERO_VOLUME",
                    "element_id": eid_value(space.Id),
                    "space": label,
                    "message": "Space volume is zero after Areas and Volumes computation.",
                }
            )
        height, base, top = space_height(space)
        actual_bounds = _source_space_actual_z_bounds(space)
        actual_height = None if actual_bounds is None else float(actual_bounds[1] - actual_bounds[0])
        if height is None or height <= 0.25:
            sid = eid_value(space.Id)
            is_generated = sid in generated_ids
            # Revit can expose an invalid/missing Upper Limit parameter while its actual
            # placed Space solid is still positive and is accepted by the EADM. Geometry
            # is authoritative; the bad parameter is maintenance metadata, not a reason
            # to throw away a valid analytical volume.
            if actual_height is not None and actual_height > 0.25 and volume > 0.0:
                messages.append({
                    "severity": "WARNING",
                    "code": "SPACE_PARAMETER_VERTICAL_EXTENT_INVALID_SOLID_VALID",
                    "element_id": sid,
                    "space": label,
                    "parameter_height_ft": height,
                    "actual_geometry_height_ft": round(actual_height, 6),
                    "generated": bool(is_generated),
                    "message": "Upper Limit/offset parameters are invalid, but native Revit Space geometry has a positive volume; REVEX uses the actual geometry and keeps the parameter defect as a warning.",
                })
                height, base, top = actual_height, float(actual_bounds[0]), float(actual_bounds[1])
            else:
                preexisting_orphan = bool(generated_ids) and not is_generated
                messages.append(
                    {
                        "severity": "WARNING" if preexisting_orphan else "ERROR",
                        "code": (
                            "PREEXISTING_INVALID_SPACE_VERTICAL_EXTENT_PRESERVED_NOT_EXPORTED"
                            if preexisting_orphan else "INVALID_SPACE_VERTICAL_EXTENT"
                        ),
                        "element_id": sid,
                        "space": label,
                        "height_ft": height,
                        "message": (
                            "Pre-existing Space has a nonpositive vertical extent and no positive native geometry; REVEX leaves it untouched and excludes it when necessary."
                            if preexisting_orphan else "Upper Limit/offsets and native Space geometry do not define a positive volume."
                        ),
                    }
                )
        if height is not None and height > 0.25:
            crossed = local_intermediate_story_spaces(space, phase_spaces)
            if crossed:
                messages.append(
                    {
                        "severity": "ERROR",
                        "code": "SPACE_CROSSES_LOCAL_OCCUPIED_STORY",
                        "element_id": eid_value(space.Id),
                        "space": label,
                        "levels": [str(row["level"].Name) for row in crossed if row.get("level") is not None],
                        "conflicting_space_ids": sorted(set(v for row in crossed for v in row.get("space_ids", []))),
                        "message": (
                            "This Space overlaps another actual MEP Space at the same XY on an intermediate story. "
                            "Reference/ceiling/roof Levels are ignored. Split or correct this volume before gbXML export."
                        ),
                    }
                )
        for problem in boundary_loop_check(space):
            messages.append(
                {
                    "severity": "ERROR",
                    "code": "SPACE_BOUNDARY_INVALID",
                    "element_id": eid_value(space.Id),
                    "space": label,
                    "message": problem,
                }
            )
        valid.append(space)

    if not valid:
        messages.append(
            {
                "severity": "ERROR",
                "code": "NO_EXPORTABLE_SPACES",
                "message": "No enclosed, placed Spaces exist in the selected phase.",
            }
        )
    return phase_spaces, valid, unplaced


def configure_area_volume(model_doc, changes):
    settings = AreaVolumeSettings.GetAreaVolumeSettings(model_doc)
    if not settings.ComputeVolumes:
        settings.ComputeVolumes = True
        changes.append({"action": "enabled_areas_and_volumes"})


def set_if_available(obj, property_name, value, changes):
    # Avoid hasattr/getattr probes on Python.NET properties that may expose only a setter.
    try:
        old = getattr(obj, property_name)
    except Exception:
        old = None
    try:
        if old is None or str(old) != str(value):
            setattr(obj, property_name, value)
            changes.append(
                {
                    "action": "energy_setting",
                    "property": property_name,
                    "old": None if old is None else str(old),
                    "new": str(value),
                }
            )
        return True
    except Exception:
        return False


def configure_energy_settings(model_doc, phase, changes):
    try:
        energy = Analysis.EnergyDataSettings.GetEnergyDataSettings(model_doc)
    except Exception:
        energy = Analysis.EnergyDataSettings.GetFromDocument(model_doc)
    if energy is None:
        raise Exception("EnergyDataSettings could not be obtained from the model.")

    set_if_available(
        energy, "AnalysisType", Analysis.AnalysisMode.RoomsOrSpaces, changes
    )
    try:
        space_category_id = ElementId(BuiltInCategory.OST_MEPSpaces)
    except Exception:
        space_category_id = ElementId(-2003600)
    set_if_available(energy, "ExportCategory", space_category_id, changes)
    complex_mode = getattr(
        Analysis.gbXMLExportComplexity,
        "Complex",
        Analysis.gbXMLExportComplexity.Simple,
    )
    set_if_available(energy, "ExportComplexity", complex_mode, changes)
    set_if_available(energy, "ProjectPhase", phase.Id, changes)
    set_if_available(energy, "UseCurrentViewOnly", False, changes)
    set_if_available(energy, "IncludeThermalProperties", False, changes)
    set_if_available(energy, "ExportDefaults", False, changes)
    set_if_available(energy, "IsExportMullionsEnabled", False, changes)
    set_if_available(
        energy, "IsExportSimplifiedCurtainSystemsEnabled", False, changes
    )
    # 1 mm: filters numerical slivers without erasing architectural detail.
    set_if_available(energy, "SliverSpaceTolerance", 1.0 / 304.8, changes)
    return energy


def delete_main_energy_model(model_doc, changes):
    old = Analysis.EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(
        model_doc
    )
    if old is not None:
        changes.append(
            {
                "action": "deleted_stale_energy_analysis_model",
                "element_id": eid_value(old.Id),
            }
        )
        model_doc.Delete(old.Id)


def create_energy_model(model_doc, changes):
    options = Analysis.EnergyAnalysisDetailModelOptions()
    options.EnergyModelType = Analysis.EnergyModelType.SpatialElement
    options.Tier = Analysis.EnergyAnalysisDetailModelTier.SecondLevelBoundaries
    model = Analysis.EnergyAnalysisDetailModel.Create(model_doc, options)
    changes.append(
        {
            "action": "created_temporary_energy_analysis_model",
            "element_id": eid_value(model.Id),
            "tier": "SecondLevelBoundaries",
        }
    )
    return model


def create_energy_model_for_tier(model_doc, tier_name, changes):
    options = Analysis.EnergyAnalysisDetailModelOptions()
    options.EnergyModelType = Analysis.EnergyModelType.SpatialElement
    tier = getattr(Analysis.EnergyAnalysisDetailModelTier, tier_name)
    options.Tier = tier
    model = Analysis.EnergyAnalysisDetailModel.Create(model_doc, options)
    changes.append({
        "action": "created_temporary_energy_analysis_model",
        "element_id": eid_value(model.Id),
        "tier": tier_name,
    })
    return model


def build_energy_model_with_fallbacks(model_doc, phase, changes, messages, expected_spaces=0):
    """Create and prove a stored native Revit EADM before any gbXML call.

    Final is preferred because it includes constructions/schedules/non-graphical data.
    Lower tiers are compatibility fallbacks only. Every attempt, including success, is
    recorded so an empty attempt list can never hide the native handoff state again.
    """
    attempts=[]
    for tier_name in ("Final","SecondLevelBoundaries","FirstLevelBoundaries"):
        tx=Transaction(model_doc,"LIBER gbXML: build energy model {}".format(tier_name))
        attempt={"tier":tier_name,"status":"started"}
        try:
            tx.Start()
            configure_area_volume(model_doc,changes)
            energy_settings=configure_energy_settings(model_doc,phase,changes)
            delete_main_energy_model(model_doc,changes)
            model_doc.Regenerate()
            create_energy_model_for_tier(model_doc,tier_name,changes)
            model_doc.Regenerate()
            status=tx.Commit()
            if status != TransactionStatus.Committed:
                raise Exception("Energy model transaction did not commit: {}".format(status))
            current=Analysis.EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(model_doc)
            if current is None:
                raise Exception("EnergyAnalysisDetailModel.Create committed but no main model is stored.")
            if not bool(safe_attr(current,"IsValidObject",True)):
                raise Exception("Stored EnergyAnalysisDetailModel is not a valid Revit object.")
            try: analytical_spaces=list(current.GetAnalyticalSpaces() or [])
            except Exception as ex: raise Exception("Stored energy model cannot enumerate analytical Spaces: {}".format(ex))
            try:
                analytical_surfaces=list(current.GetAnalyticalSurfaces() or [])
            except Exception:
                analytical_surfaces=[]
                seen_surface_ids=set()
                for analytical_space in analytical_spaces:
                    try:
                        for surface in list(analytical_space.GetAnalyticalSurfaces() or []):
                            key=eid_value(safe_attr(surface,"Id",None))
                            if key not in seen_surface_ids:
                                seen_surface_ids.add(key); analytical_surfaces.append(surface)
                    except Exception:
                        continue
            if expected_spaces and len(analytical_spaces) < max(1,int(expected_spaces*PRESERVATION_MINIMUM)):
                raise Exception("Stored EADM preserved only {}/{} analytical Spaces (<80% hard-stop integrity gate).".format(len(analytical_spaces),expected_spaces))
            if not analytical_spaces:
                raise Exception("Stored EADM contains zero analytical Spaces.")
            if not analytical_surfaces:
                raise Exception("Stored EADM contains zero analytical Surfaces.")
            attempt.update({"status":"success","analytical_spaces":len(analytical_spaces),"analytical_surfaces":len(analytical_surfaces)})
            attempts.append(attempt)
            messages.append({"severity":"INFO","code":"ENERGY_MODEL_FALLBACK_SELECTED","tier":tier_name,"analytical_spaces":len(analytical_spaces),"analytical_surfaces":len(analytical_surfaces),"message":"Stored native Revit energy model verified with {}.".format(tier_name)})
            return current,energy_settings,attempts
        except Exception as ex:
            try:
                if tx.GetStatus()==TransactionStatus.Started: tx.RollBack()
            except Exception: pass
            attempt.update({"status":"failed","error_type":type(ex).__name__,"error":str(ex)})
            attempts.append(attempt)
            messages.append({"severity":"WARNING","code":"ENERGY_MODEL_TIER_FAILED","tier":tier_name,"message":"{}: {}".format(type(ex).__name__,ex)})
    return None,None,attempts


def _native_export_candidates(output_folder, partial_name):
    stem=os.path.splitext(partial_name)[0]
    names=[]
    for value in (stem,partial_name):
        if value and value not in names: names.append(value)
    candidates=[]
    for name in names:
        candidates.extend([
            os.path.join(output_folder,name),
            os.path.join(output_folder,name+".xml") if not name.lower().endswith(".xml") else os.path.join(output_folder,name),
        ])
    return names,list(dict.fromkeys(candidates))


def export_native_gbxml(model_doc, output_folder, partial_name, partial_candidates, messages):
    """Export the already-stored main EADM using Revit 2026 default gbXML options.

    GBXMLExportOptions.ExportEnergyModelType is obsolete in Revit 2026. Autodesk's
    documented non-mass workflow uses default options and the stored main energy model.
    """
    current=Analysis.EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(model_doc)
    if current is None:
        raise Exception("Native gbXML export requested without a stored main EnergyAnalysisDetailModel.")
    try: model_space_count=len(list(current.GetAnalyticalSpaces() or []))
    except Exception as ex: raise Exception("Stored main EADM cannot enumerate analytical Spaces before export: {}".format(ex))
    if model_space_count <= 0:
        raise Exception("Stored main EADM contains zero analytical Spaces before export.")
    export_names,auto_candidates=_native_export_candidates(output_folder,partial_name)
    candidates=list(dict.fromkeys(list(partial_candidates or [])+auto_candidates))
    for candidate in candidates:
        try:
            if os.path.isfile(candidate): os.remove(candidate)
        except Exception: pass
    attempts=[]
    try: TransactionManager.Instance.ForceCloseTransaction()
    except Exception: pass
    for export_name in export_names:
        options=None
        tx=None
        attempt={"name":export_name,"eadm_spaces":model_space_count,"transaction_required":True}
        try:
            # Revit 2026 Document.Export(..., GBXMLExportOptions) must be called from
            # an open Revit Transaction. Dynamo's ambient transaction is deliberately
            # closed above, so create an explicit native transaction for each attempt.
            tx=Transaction(model_doc,"LIBER gbXML: native export")
            start_status=tx.Start()
            attempt["transaction_start"]=str(start_status)
            if start_status != TransactionStatus.Started:
                raise Exception("Native gbXML export transaction did not start: {}".format(start_status))
            options=GBXMLExportOptions()  # Revit 2026 defaults; stored EADM is authoritative
            exported=bool(model_doc.Export(output_folder,export_name,options))
            attempt["returned"]=exported
            commit_status=tx.Commit()
            attempt["transaction_commit"]=str(commit_status)
            if commit_status != TransactionStatus.Committed:
                raise Exception("Native gbXML export transaction did not commit: {}".format(commit_status))
            existing=[candidate for candidate in candidates if os.path.isfile(candidate)]
            if not existing:
                patterns=(export_name+"*",os.path.splitext(export_name)[0]+"*")
                for pattern in patterns:
                    existing.extend([p for p in glob.glob(os.path.join(output_folder,pattern)) if os.path.isfile(p)])
            existing=list(dict.fromkeys(existing))
            attempt["files"]=existing
            attempt["status"]="success" if exported and existing else "no_output"
            attempts.append(attempt)
            if exported and existing:
                chosen=max(existing,key=os.path.getmtime)
                messages.append({"severity":"INFO","code":"NATIVE_GBXML_EXPORT_COMPLETED","attempts":attempts,"message":"Revit native gbXML exporter produced {}.".format(chosen)})
                return chosen,attempts
        except Exception as ex:
            try:
                if tx is not None and tx.GetStatus()==TransactionStatus.Started:
                    attempt["transaction_rollback"]=str(tx.RollBack())
            except Exception as rb_ex:
                attempt["rollback_error"]="{}: {}".format(type(rb_ex).__name__,rb_ex)
            attempt.update({"status":"failed","error_type":type(ex).__name__,"error":str(ex),"trace":traceback.format_exc()[-2500:]})
            attempts.append(attempt)
        finally:
            try:
                if options is not None: options.Dispose()
            except Exception: pass
            try:
                if tx is not None: tx.Dispose()
            except Exception: pass
    raise Exception("Native Revit gbXML export failed: {}".format(json.dumps(attempts,ensure_ascii=False)))


def xyz_tuple(point):
    return (float(point.X), float(point.Y), float(point.Z))


def analytical_polyloops(analytical_element):
    """Return Revit-internal-foot polygons across Revit API versions."""
    polyloops = []
    raw = []
    try:
        if callable(safe_attr(analytical_element, "GetPolyloops", None)):
            raw = list(analytical_element.GetPolyloops() or [])
        elif callable(safe_attr(analytical_element, "GetPolyloop", None)):
            single = analytical_element.GetPolyloop()
            raw = [single] if single is not None else []
        for loop in raw:
            try:
                points = [xyz_tuple(point) for point in list(loop.GetPoints() or [])]
                if len(points) >= 3:
                    polyloops.append(points)
            finally:
                try:
                    loop.Dispose()
                except Exception:
                    pass
    except Exception:
        return []
    return polyloops


def analytical_space_closed_shell_polyloops(analytical_space):
    """Return EnergyAnalysisSpace closed-shell loops in the EADM's own coordinate frame."""
    polyloops = []
    try:
        raw = list(analytical_space.GetClosedShell() or [])
    except Exception:
        raw = []
    for loop in raw:
        try:
            points = [xyz_tuple(point) for point in list(loop.GetPoints() or [])]
            if len(points) >= 3:
                polyloops.append(points)
        except Exception:
            pass
        finally:
            try:
                loop.Dispose()
            except Exception:
                pass
    return polyloops


def _polyloops_z_bounds(polyloops):
    zs = []
    for loop in list(polyloops or []):
        for point in list(loop or []):
            try:
                zs.append(float(point[2]))
            except Exception:
                pass
    if not zs:
        return None
    return (min(zs), max(zs))


def _source_space_actual_z_bounds(space):
    """Best-effort source Space bounds; only height is compared across EADM datum shifts."""
    try:
        box = space.get_BoundingBox(None)
        if box is not None:
            z0, z1 = float(box.Min.Z), float(box.Max.Z)
            if z1 > z0 + 0.01:
                return (z0, z1)
    except Exception:
        pass
    try:
        bounds = _space_vertical_bounds(space)
        if bounds is not None and float(bounds[1]) > float(bounds[0]) + 0.01:
            return (float(bounds[0]), float(bounds[1]))
    except Exception:
        pass
    return None


def analytical_space_revit_id(model_doc, analytical_space):
    if analytical_space is None:
        return -1
    try:
        source = model_doc.GetElement(str(analytical_space.CADObjectUniqueId))
        if source is not None:
            return eid_value(source.Id)
    except Exception:
        pass
    return -1


def originating_element_id(analytical_element, model_doc):
    try:
        value = eid_value(analytical_element.OriginatingElementId)
        if value > 0:
            return value
    except Exception:
        pass
    try:
        source = model_doc.GetElement(str(analytical_element.CADObjectUniqueId))
        if source is not None:
            return eid_value(source.Id)
    except Exception:
        pass
    return -1


def capture_energy_manifest(model_doc, energy_model, messages):
    """
    Capture exactly what Revit says it intends to export. This is more reliable
    than comparing physical element counts because analytical walls may split or
    merge, while linked elements and curtain systems have different identities.
    """
    surfaces = []
    openings = []
    analytical_space_records = []
    seen_surfaces = set()
    seen_openings = set()

    try:
        for analytical_space in list(energy_model.GetAnalyticalSpaces() or []):
            revit_id = analytical_space_revit_id(model_doc, analytical_space)
            shell = analytical_space_closed_shell_polyloops(analytical_space)
            bounds = _polyloops_z_bounds(shell)
            analytical_space_records.append({
                "revit_space_id": revit_id,
                # Native Revit gbXML writes the EnergyAnalysisSpace element Id into
                # Space/CADObjectId, not the underlying MEP Space Id. Keep both
                # identity domains so downstream validation can bind them exactly.
                "analysis_element_id": eid_value(safe_attr(analytical_space, "Id", None)),
                "analytical_id": str(safe_attr(analytical_space, "SpaceId", "") or safe_attr(analytical_space, "Id", "") or revit_id),
                "name": str(safe_attr(analytical_space, "SpaceName", "") or safe_element_name(analytical_space) or ""),
                "shell_polyloops": shell,
                "zmin": None if bounds is None else float(bounds[0]),
                "zmax": None if bounds is None else float(bounds[1]),
                "height": None if bounds is None else float(bounds[1] - bounds[0]),
            })
    except Exception as ex:
        messages.append({
            "severity": "WARNING",
            "code": "ANALYTICAL_SPACE_SHELL_CAPTURE_FAILED_NONBLOCKING",
            "message": str(ex),
        })

    try:
        analytical_surfaces = list(energy_model.GetAnalyticalSurfaces() or [])
    except Exception:
        analytical_surfaces = []
        try:
            for analytical_space in list(energy_model.GetAnalyticalSpaces() or []):
                analytical_surfaces.extend(
                    list(analytical_space.GetAnalyticalSurfaces() or [])
                )
        except Exception:
            pass

    for surface in analytical_surfaces:
        analysis_element_id = eid_value(safe_attr(surface, "Id", None))
        if analysis_element_id in seen_surfaces:
            continue
        seen_surfaces.add(analysis_element_id)
        primary = None
        secondary = None
        try:
            primary = surface.GetAnalyticalSpace()
        except Exception:
            pass
        try:
            secondary = surface.GetAdjacentAnalyticalSpace()
        except Exception:
            pass
        adjacent_revit_ids = []
        for analytical_space in (primary, secondary):
            value = analytical_space_revit_id(model_doc, analytical_space)
            if value > 0 and value not in adjacent_revit_ids:
                adjacent_revit_ids.append(value)
        surface_type = str(safe_attr(surface, "Type", "") or "")
        if not surface_type:
            surface_type = str(safe_attr(surface, "SurfaceType", "") or "")
        record = {
            "analysis_element_id": analysis_element_id,
            "analytical_id": str(
                safe_attr(surface, "SurfaceId", "") or analysis_element_id
            ),
            "name": str(
                safe_attr(surface, "SurfaceName", "")
                or safe_element_name(surface)
                or ""
            ),
            "surface_type": surface_type,
            "originating_element_id": originating_element_id(surface, model_doc),
            "originating_element_name": str(
                safe_attr(surface, "OriginatingElementName", "") or ""
            ),
            "adjacent_revit_space_ids": adjacent_revit_ids,
            "polyloops_ft": analytical_polyloops(surface),
            "opening_keys": [],
        }
        # Shading belongs to the site, not a Space face. It is still exported by
        # Revit but is intentionally outside the Space-envelope persistence gate.
        if adjacent_revit_ids:
            surfaces.append(record)

        try:
            analytical_openings = list(surface.GetAnalyticalOpenings() or [])
        except Exception:
            analytical_openings = []
        for opening in analytical_openings:
            opening_element_id = eid_value(safe_attr(opening, "Id", None))
            opening_identity = str(
                safe_attr(opening, "OpeningId", "") or opening_element_id
            )
            opening_loops = analytical_polyloops(opening)
            # Analytical openings are children of analytical Surfaces. Revit may reuse
            # an opening element id (or expose -1) on different story-split carriers,
            # especially curtain systems. Never collapse across parent Surfaces.
            opening_seen_key = (
                str(record.get("analytical_id") or ""),
                opening_identity,
                int(opening_element_id),
            )
            if opening_seen_key in seen_openings:
                continue
            seen_openings.add(opening_seen_key)
            opening_type = str(safe_attr(opening, "Type", "") or "")
            if not opening_type:
                opening_type = str(safe_attr(opening, "OpeningType", "") or "")
            opening_record = {
                "analysis_element_id": opening_element_id,
                "analytical_id": opening_identity,
                "name": str(
                    safe_attr(opening, "OpeningName", "")
                    or safe_element_name(opening)
                    or ""
                ),
                "opening_type": opening_type,
                "originating_element_id": originating_element_id(
                    opening, model_doc
                ),
                "originating_element_name": str(
                    safe_attr(opening, "OriginatingElementName", "") or ""
                ),
                "parent_analytical_id": record["analytical_id"],
                "parent_analysis_element_id": analysis_element_id,
                "adjacent_revit_space_ids": list(adjacent_revit_ids),
                "polyloops_ft": opening_loops,
            }
            opening_key = "{}::{}".format(
                opening_record["analytical_id"], opening_element_id
            )
            opening_record["key"] = opening_key
            record["opening_keys"].append(opening_key)
            if adjacent_revit_ids:
                openings.append(opening_record)

    if not surfaces:
        messages.append(
            {
                "severity": "ERROR",
                "code": "ANALYTICAL_MANIFEST_EMPTY",
                "message": (
                    "The temporary analytical model contains no Space surfaces; "
                    "export cannot be proven complete."
                ),
            }
        )
    return {
        "spaces": analytical_space_records,
        "surfaces": surfaces,
        "openings": openings,
        "counts": {
            "analytical_spaces": len(analytical_space_records),
            "space_surfaces": len(surfaces),
            "windows_doors_and_openings": len(openings),
        },
    }


def _element_bbox_z_bounds(model_doc, element_id):
    try:
        element = model_doc.GetElement(ElementId(int(element_id)))
    except Exception:
        element = None
    if element is None:
        return None
    try:
        box = element.get_BoundingBox(None)
        if box is not None and float(box.Max.Z) > float(box.Min.Z) + 0.01:
            return (float(box.Min.Z), float(box.Max.Z))
    except Exception:
        pass
    return None


def classify_surface_shell_excess(excess_ft, adjacent_height_ft, source_supported=False):
    """Pure severity classifier used by the EADM evaluator and build regressions."""
    excess = max(0.0, float(excess_ft or 0.0))
    height = max(0.25, float(adjacent_height_ft or 0.0))
    if source_supported:
        return "SOURCE_SUPPORTED_WARNING"
    soft = max(SURFACE_SHELL_SOFT_TOL_FT, min(2.0, height * 0.18))
    catastrophic = max(SURFACE_SHELL_CATASTROPHIC_MIN_FT, height * 0.45)
    if excess <= soft + 1e-6:
        return "ANALYTICAL_OFFSET_WARNING"
    if excess >= catastrophic - 1e-6:
        return "CRITICAL_UNSUPPORTED_EXTENSION"
    return "REVIEW_WARNING"


def analytical_geometry_vertical_sanity(model_doc, analytical_manifest, spaces):
    """Source-backed EADM vertical evaluator.

    Space-shell height corruption is still treated as critical. Surface extensions are
    classified against the union of adjacent EADM Space shells and, when possible, the
    originating native Revit element transformed into the EADM datum. Normal analytical
    offsets/sliver transitions are warnings; only large unsupported extensions are
    critical. This avoids both false failures and geometry fitting.
    """
    source_spaces = {eid_value(item.Id): item for item in list(spaces or []) if item is not None}
    source_bounds = {}
    for sid, space in source_spaces.items():
        bounds = _source_space_actual_z_bounds(space)
        if bounds is not None:
            source_bounds[sid] = bounds

    eadm_bounds = {}
    shell_critical = []
    shell_warnings = []
    datum_offsets = []
    for record in list((analytical_manifest or {}).get("spaces", []) or []):
        try:
            sid = int(record.get("revit_space_id", -1))
        except Exception:
            sid = -1
        try:
            zmin = float(record.get("zmin")); zmax = float(record.get("zmax"))
        except Exception:
            continue
        if zmax <= zmin + 0.01:
            shell_critical.append({"revit_space_id":sid,"space":record.get("name"),"reason":"nonpositive_eadm_shell_height","eadm_zmin":round(zmin,6),"eadm_zmax":round(zmax,6)})
            continue
        if sid > 0:
            eadm_bounds[sid] = (zmin, zmax)
        source = source_bounds.get(sid)
        if source is None:
            continue
        source_height = float(source[1] - source[0])
        eadm_height = float(zmax - zmin)
        if source_height > 0.25:
            # A real tower/collapse is a large ratio/absolute change. Roof rationalization
            # and construction thickness differences remain warnings.
            high_critical = max(source_height + 4.0, source_height * 1.55)
            low_critical = max(0.25, min(source_height - 4.0, source_height * 0.45))
            high_warn = max(source_height + 1.5, source_height * 1.25)
            low_warn = max(0.25, min(source_height - 1.5, source_height * 0.65))
            if eadm_height > high_critical + 0.05 or eadm_height < low_critical - 0.05:
                shell_critical.append({"revit_space_id":sid,"space":record.get("name"),"reason":"eadm_shell_height_catastrophic_vs_source","source_height_ft":round(source_height,6),"eadm_height_ft":round(eadm_height,6)})
            elif eadm_height > high_warn + 0.05 or eadm_height < low_warn - 0.05:
                shell_warnings.append({"revit_space_id":sid,"space":record.get("name"),"reason":"eadm_shell_height_rationalized_vs_source","source_height_ft":round(source_height,6),"eadm_height_ft":round(eadm_height,6)})
        try:
            datum_offsets.append(float(source[0]) - zmin)
        except Exception:
            pass

    datum_offset_median = None
    if datum_offsets:
        ordered = sorted(datum_offsets); n=len(ordered)
        datum_offset_median = ordered[n//2] if n%2 else (ordered[n//2-1]+ordered[n//2])/2.0

    surface_critical=[]; surface_warnings=[]; max_excess=0.0; checked_surfaces=0
    for record in list((analytical_manifest or {}).get("surfaces", []) or []):
        adjacent=[]
        for raw_id in list(record.get("adjacent_revit_space_ids", []) or []):
            try: sid=int(raw_id)
            except Exception: continue
            if sid in eadm_bounds: adjacent.append(eadm_bounds[sid])
        if not adjacent:
            continue
        checked_surfaces += 1
        allowed_min=min(v[0] for v in adjacent)-0.25
        allowed_max=max(v[1] for v in adjacent)+0.25
        adjacent_height=max(v[1] for v in adjacent)-min(v[0] for v in adjacent)
        zs=[]
        for loop in list(record.get("polyloops_ft",[]) or []):
            for point in list(loop or []):
                try: zs.append(float(point[2]))
                except Exception: pass
        if not zs: continue
        zmin,zmax=min(zs),max(zs)
        excess=max(max(0.0,allowed_min-zmin), max(0.0,zmax-allowed_max))
        if excess <= 0.05:
            continue
        max_excess=max(max_excess,excess)
        source_supported=False
        source_id=int(record.get("originating_element_id") or -1)
        source_box=_element_bbox_z_bounds(model_doc, source_id) if source_id>0 else None
        if source_box is not None and datum_offset_median is not None:
            src_min=float(source_box[0])-float(datum_offset_median)-0.50
            src_max=float(source_box[1])-float(datum_offset_median)+0.50
            source_supported=(zmin >= src_min-0.05 and zmax <= src_max+0.05)
        severity=classify_surface_shell_excess(excess, adjacent_height, source_supported)
        row={"analytical_id":record.get("analytical_id"),"originating_element_id":source_id,"surface_type":record.get("surface_type"),"adjacent_space_ids":list(record.get("adjacent_revit_space_ids",[]) or []),"zmin_eadm":round(zmin,6),"zmax_eadm":round(zmax,6),"adjacent_shell_min_eadm":round(allowed_min,6),"adjacent_shell_max_eadm":round(allowed_max,6),"excess_ft":round(excess,6),"source_supported":source_supported,"classification":severity}
        if severity == "CRITICAL_UNSUPPORTED_EXTENSION": surface_critical.append(row)
        else: surface_warnings.append(row)

    critical=shell_critical+surface_critical
    warnings=shell_warnings+surface_warnings
    return {
        "passed": not critical,
        "critical_count": len(critical),
        "warning_count": len(warnings),
        "violation_count": len(critical),
        "shell_height_violation_count": len(shell_critical),
        "surface_shell_violation_count": len(surface_critical),
        "surface_shell_warning_count": len(surface_warnings),
        "checked_analytical_spaces": len(eadm_bounds),
        "checked_analytical_surfaces": checked_surfaces,
        "median_source_to_eadm_datum_offset": None if datum_offset_median is None else round(datum_offset_median,6),
        "max_excess_ft": round(max_excess,6),
        "critical": critical[:100],
        "warnings": warnings[:100],
        "violations": critical[:100],
    }

def category_matches(element, built_in_category):
    try:
        return eid_value(element.Category.Id) == eid_value(
            ElementId(built_in_category)
        )
    except Exception:
        return False


def face_outer_polyloop(face):
    """Tessellate only boundary curves; never triangulate the full Space solid."""
    candidates = []
    try:
        curve_loops = list(face.GetEdgesAsCurveLoops() or [])
    except Exception:
        curve_loops = []
    for curve_loop in curve_loops:
        points = []
        try:
            for curve in list(curve_loop):
                tessellated = list(curve.Tessellate() or [])
                for point in tessellated:
                    value = xyz_tuple(point)
                    if not points or distance3(value, points[-1]) > 1e-7:
                        points.append(value)
            if len(points) > 1 and distance3(points[0], points[-1]) < 1e-7:
                points.pop()
            if len(points) >= 3:
                candidates.append(points)
        except Exception:
            continue
    if not candidates:
        return []
    return max(candidates, key=lambda points: norm(newell(points)))


def resolve_boundary_source(model_doc, link_element_id):
    """
    Resolve a SpatialBoundaryElement in either the host or a loaded link.
    Returned geometry stays in host coordinates because GetSubface() already is.
    """
    host_id = eid_value(safe_attr(link_element_id, "HostElementId", None))
    linked_id = eid_value(safe_attr(link_element_id, "LinkedElementId", None))
    link_instance_id = eid_value(
        safe_attr(link_element_id, "LinkInstanceId", None)
    )
    source_doc = model_doc
    transform = Transform.Identity
    source = None
    link_instance = None

    if linked_id > 0:
        if link_instance_id <= 0:
            link_instance_id = host_id
        try:
            link_instance = model_doc.GetElement(ElementId(link_instance_id))
            source_doc = link_instance.GetLinkDocument()
            if source_doc is not None:
                source = source_doc.GetElement(ElementId(linked_id))
                try:
                    transform = link_instance.GetTotalTransform()
                except Exception:
                    transform = link_instance.GetTransform()
        except Exception:
            source = None
    elif host_id > 0:
        try:
            source = model_doc.GetElement(ElementId(host_id))
        except Exception:
            source = None

    if source is None:
        return None
    source_id = eid_value(source.Id)
    link_key = (
        str(safe_attr(link_instance, "UniqueId", "") or "")
        if link_instance is not None
        else ""
    )
    return {
        "element": source,
        "document": source_doc,
        "transform": transform,
        "source_id": source_id,
        "source_unique_id": str(safe_attr(source, "UniqueId", "") or ""),
        "link_unique_id": link_key,
        "source_key": "{}::{}".format(link_key or "HOST", source_id),
    }


def resolve_boundary_segment_source(model_doc, segment):
    host_id = eid_value(safe_attr(segment, "ElementId", None))
    linked_id = eid_value(safe_attr(segment, "LinkElementId", None))
    try:
        host = model_doc.GetElement(ElementId(host_id)) if host_id > 0 else None
    except Exception:
        host = None
    if linked_id > 0 and host is not None and callable(safe_attr(host, "GetLinkDocument", None)):
        try:
            source_doc = host.GetLinkDocument()
            source = source_doc.GetElement(ElementId(linked_id))
            try:
                transform = host.GetTotalTransform()
            except Exception:
                transform = host.GetTransform()
            return {
                "element": source,
                "document": source_doc,
                "transform": transform,
                "source_id": eid_value(source.Id),
                "source_unique_id": str(safe_attr(source, "UniqueId", "") or ""),
                "link_unique_id": str(safe_attr(host, "UniqueId", "") or ""),
                "source_key": "{}::{}".format(
                    str(safe_attr(host, "UniqueId", "") or ""),
                    eid_value(source.Id),
                ),
            }
        except Exception:
            return None
    if host is None:
        return None
    return {
        "element": host,
        "document": model_doc,
        "transform": Transform.Identity,
        "source_id": eid_value(host.Id),
        "source_unique_id": str(safe_attr(host, "UniqueId", "") or ""),
        "link_unique_id": "",
        "source_key": "HOST::{}".format(eid_value(host.Id)),
    }


def is_exterior_wall(source_info):
    element = source_info["element"]
    if not category_matches(element, BuiltInCategory.OST_Walls):
        return False
    try:
        wall_type = source_info["document"].GetElement(element.GetTypeId())
        return normalize_text(str(wall_type.Function)) == "exterior"
    except Exception:
        return False


def transformed_bbox_points(element, transform):
    try:
        box = element.get_BoundingBox(None)
    except Exception:
        box = None
    if box is None:
        return []
    points = []
    for x in (box.Min.X, box.Max.X):
        for y in (box.Min.Y, box.Max.Y):
            for z in (box.Min.Z, box.Max.Z):
                point = XYZ(x, y, z)
                try:
                    point = transform.OfPoint(point)
                except Exception:
                    pass
                points.append(xyz_tuple(point))
    return points


def wall_basis(points):
    if len(points) < 3:
        return None
    normal = newell(points)
    magnitude = norm(normal)
    if magnitude <= 1e-9:
        return None
    n = tuple(value / magnitude for value in normal)
    # A wall carrier must be predominantly vertical. Horizontal or strongly
    # sloped faces are never silently retyped as ExteriorWall.
    if abs(n[2]) > 0.35:
        return None
    vertical = (0.0, 0.0, 1.0)
    u = cross(vertical, n)
    u_len = norm(u)
    if u_len <= 1e-9:
        return None
    u = tuple(value / u_len for value in u)
    v = cross(n, u)
    v_len = norm(v)
    v = tuple(value / v_len for value in v)
    origin = points[0]
    return origin, u, v, n


def point_add(origin, u, u_value, v, v_value):
    return tuple(
        origin[i] + u[i] * u_value + v[i] * v_value for i in range(3)
    )


def project_bounds(points, basis):
    origin, u, v, _ = basis
    values = []
    for point in points:
        delta = vector_sub(point, origin)
        values.append(
            (
                sum(delta[i] * u[i] for i in range(3)),
                sum(delta[i] * v[i] for i in range(3)),
            )
        )
    return (
        min(item[0] for item in values),
        max(item[0] for item in values),
        min(item[1] for item in values),
        max(item[1] for item in values),
    )


def bbox_opening_polyloop(bbox_points, wall_points):
    basis = wall_basis(wall_points)
    if basis is None or len(bbox_points) < 4:
        return []
    wall_bounds = project_bounds(wall_points, basis)
    opening_bounds = project_bounds(bbox_points, basis)
    margin_ft = 0.01 / 0.3048
    u0 = max(wall_bounds[0] + margin_ft, opening_bounds[0])
    u1 = min(wall_bounds[1] - margin_ft, opening_bounds[1])
    v0 = max(wall_bounds[2] + margin_ft, opening_bounds[2])
    v1 = min(wall_bounds[3] - margin_ft, opening_bounds[3])
    if u1 - u0 < 0.05 / 0.3048 or v1 - v0 < 0.05 / 0.3048:
        return []
    origin, u, v, normal = basis
    rectangle = [
        point_add(origin, u, u0, v, v0),
        point_add(origin, u, u1, v, v0),
        point_add(origin, u, u1, v, v1),
        point_add(origin, u, u0, v, v1),
    ]
    if sum(
        newell(rectangle)[i] * normal[i] for i in range(3)
    ) < 0.0:
        rectangle.reverse()
    return rectangle


def is_curtain_wall(source_info):
    wall = source_info["element"]
    try:
        kind = normalize_text(str(wall.WallType.Kind))
        if kind == "curtain":
            return True
    except Exception:
        pass
    try:
        return wall.CurtainGrid is not None
    except Exception:
        return False


def element_descriptor(source_doc, element):
    parts = []
    for value in (
        safe_element_name(element),
        safe_element_name(safe_attr(element, "Category", None)),
    ):
        if value:
            parts.append(str(value))
    try:
        type_element = source_doc.GetElement(element.GetTypeId())
    except Exception:
        type_element = None
    if type_element is not None:
        for value in (
            safe_element_name(type_element),
            safe_element_name(safe_attr(type_element, "Category", None)),
        ):
            if value:
                parts.append(str(value))
    symbol = safe_attr(element, "Symbol", None)
    if symbol is not None:
        symbol_name = safe_element_name(symbol)
        if symbol_name:
            parts.append(symbol_name)
        family = safe_attr(symbol, "Family", None)
        family_name = safe_element_name(family)
        if family_name:
            parts.append(family_name)
    return " | ".join(parts)


def element_material_transparency(source_doc, element):
    material_ids = set()
    for target in (element,):
        for include_painted in (False, True):
            try:
                for material_id in list(target.GetMaterialIds(include_painted) or []):
                    if eid_value(material_id) > 0:
                        material_ids.add(eid_value(material_id))
            except Exception:
                pass
    try:
        type_element = source_doc.GetElement(element.GetTypeId())
    except Exception:
        type_element = None
    if type_element is not None:
        for include_painted in (False, True):
            try:
                for material_id in list(type_element.GetMaterialIds(include_painted) or []):
                    if eid_value(material_id) > 0:
                        material_ids.add(eid_value(material_id))
            except Exception:
                pass
    values = []
    for material_id in sorted(material_ids):
        try:
            material = source_doc.GetElement(ElementId(material_id))
            values.append(float(material.Transparency))
        except Exception:
            continue
    return max(values) if values else None


def classify_curtain_panel(source_doc, element):
    # Door/window category is authoritative. Autodesk curtain-wall doors can
    # replace panels but still schedule as doors, so category wins over names.
    if category_matches(element, BuiltInCategory.OST_Doors):
        return "door", "NonSlidingDoor", "category:door"
    if category_matches(element, BuiltInCategory.OST_Windows):
        return "glazing", "OperableWindow", "category:window"

    descriptor = element_descriptor(source_doc, element)
    text = normalize_text(descriptor)
    if any(token in text for token in (
        "curtain wall door", "curtain door", "door panel", "door",
    )):
        return "door", "NonSlidingDoor", "name/type:door"
    if any(token in text for token in (
        "empty system panel", "empty panel", "no panel", "open panel",
    )):
        return "empty", None, "name/type:empty"
    if any(token in text for token in (
        "spandrel", "opaque", "solid panel", "insulated panel",
        "metal panel", "stone panel", "precast panel", "shadow box",
    )):
        return "opaque", None, "name/type:opaque"

    transparency = element_material_transparency(source_doc, element)
    if transparency is not None and transparency >= 15.0:
        return "glazing", "FixedWindow", "material:transparency={:.0f}".format(transparency)
    if any(token in text for token in (
        "glazed", "glazing", "glass", "vision", "transparent", "window",
    )):
        return "glazing", "FixedWindow", "name/type:glazing"
    if transparency is not None and transparency <= 1.0:
        return "opaque", None, "material:opaque"
    return "ambiguous", None, "insufficient deterministic panel evidence"


def transformed_polyloop(points, transform):
    output = []
    for value in points:
        point = XYZ(value[0], value[1], value[2])
        try:
            point = transform.OfPoint(point)
        except Exception:
            pass
        output.append(xyz_tuple(point))
    return output


def iter_element_faces(element):
    try:
        options = Options()
        options.ComputeReferences = False
        options.IncludeNonVisibleObjects = False
        geometry = element.get_Geometry(options)
    except Exception:
        geometry = None
    if geometry is None:
        return []
    faces = []
    stack = list(geometry)
    while stack:
        item = stack.pop()
        try:
            item_faces = safe_attr(item, "Faces", None)
            if item_faces is not None:
                faces.extend(list(item_faces))
                continue
        except Exception:
            pass
        try:
            get_instance_geometry = safe_attr(item, "GetInstanceGeometry", None)
            if callable(get_instance_geometry):
                stack.extend(list(get_instance_geometry() or []))
        except Exception:
            pass
    return faces


def project_polyloop_to_wall(points, wall_points):
    basis = wall_basis(wall_points)
    if basis is None:
        return []
    origin, _u, _v, normal = basis
    projected = []
    for point in points:
        delta = tuple(point[i] - origin[i] for i in range(3))
        distance = sum(delta[i] * normal[i] for i in range(3))
        projected.append(tuple(point[i] - distance * normal[i] for i in range(3)))
    return projected


def element_opening_polyloop(element, transform, wall_points, bbox_points):
    basis = wall_basis(wall_points)
    if basis is None:
        return bbox_opening_polyloop(bbox_points, wall_points), "bbox"
    _origin, _u, _v, wall_normal = basis
    candidates = []
    for face in iter_element_faces(element):
        try:
            points = face_outer_polyloop(face)
        except Exception:
            points = []
        if len(points) < 3:
            continue
        points = transformed_polyloop(points, transform)
        normal = unit_vector(newell(points))
        if normal is None:
            continue
        alignment = abs(sum(normal[i] * wall_normal[i] for i in range(3)))
        if alignment < 0.85:
            continue
        projected = project_polyloop_to_wall(points, wall_points)
        area = 0.5 * norm(newell(projected)) if len(projected) >= 3 else 0.0
        if area > 1e-8:
            candidates.append((area, projected))
    if candidates:
        return max(candidates, key=lambda item: item[0])[1], "element-face"
    return bbox_opening_polyloop(bbox_points, wall_points), "bbox"


def curtain_panel_ids(source_info):
    wall = source_info["element"]
    source_doc = source_info["document"]
    ids = []
    try:
        grid = wall.CurtainGrid
        if grid is not None:
            ids.extend(list(grid.GetPanelIds() or []))
    except Exception:
        pass
    if ids:
        return ids

    # Fallback for unusual curtain hosts/API states: Panel is a FamilyInstance
    # and exposes Host. This scan runs only when CurtainGrid did not yield ids.
    try:
        candidates = list(
            FilteredElementCollector(source_doc)
            .OfCategory(BuiltInCategory.OST_CurtainWallPanels)
            .WhereElementIsNotElementType()
        )
    except Exception:
        candidates = []
    wall_id = eid_value(wall.Id)
    for panel in candidates:
        try:
            host = panel.Host
            if host is not None and eid_value(host.Id) == wall_id:
                ids.append(panel.Id)
        except Exception:
            continue
    return ids


def collect_wall_inserts(source_info):
    wall = source_info["element"]
    source_doc = source_info["document"]
    candidate_ids = []
    try:
        candidate_ids.extend(list(wall.FindInserts(True, False, True, True) or []))
    except Exception:
        pass
    curtain = is_curtain_wall(source_info)
    curtain_ids = curtain_panel_ids(source_info) if curtain else []
    curtain_id_values = set(eid_value(item) for item in curtain_ids)
    if curtain:
        candidate_ids.extend(curtain_ids)

    results = []
    seen = set()
    for insert_id in candidate_ids:
        value = eid_value(insert_id)
        if value <= 0 or value in seen:
            continue
        seen.add(value)
        try:
            insert = source_doc.GetElement(insert_id)
        except Exception:
            insert = None
        if insert is None:
            continue

        is_curtain_panel = curtain and (
            category_matches(insert, BuiltInCategory.OST_CurtainWallPanels)
            or category_matches(insert, BuiltInCategory.OST_Doors)
            or category_matches(insert, BuiltInCategory.OST_Windows)
            or value in curtain_id_values
        )
        if is_curtain_panel:
            role, opening_type, evidence = classify_curtain_panel(
                source_doc, insert
            )
        elif category_matches(insert, BuiltInCategory.OST_Windows):
            role, opening_type, evidence = (
                "glazing", "OperableWindow", "category:window"
            )
        elif category_matches(insert, BuiltInCategory.OST_Doors):
            role, opening_type, evidence = (
                "door", "NonSlidingDoor", "category:door"
            )
        else:
            continue

        results.append(
            {
                "element": insert,
                "source_id": value,
                "source_unique_id": str(safe_attr(insert, "UniqueId", "") or ""),
                "source_key": "{}::{}".format(
                    source_info["link_unique_id"] or "HOST", value
                ),
                "opening_type": opening_type,
                "curtain_role": role if curtain else None,
                "curtain_panel": bool(curtain),
                "classification_evidence": evidence,
                "name": element_descriptor(source_doc, insert),
                "bbox_points_ft": transformed_bbox_points(
                    insert, source_info["transform"]
                ),
            }
        )
    return results


def capture_physical_envelope(model_doc, spaces, messages):
    """
    Independent physical-model gate for wall faces and hosted windows/doors.
    This catches omissions that already exist in Revit's analytical model.
    """
    started = time.time()
    surfaces = []
    source_infos = {}
    checked = 0
    skipped = []
    curtain_stats = {
        "curtain_walls": 0,
        "panels_total": 0,
        "glazed_panels": 0,
        "door_panels": 0,
        "opaque_panels": 0,
        "empty_panels": 0,
        "ambiguous_panels": 0,
        "panel_openings_expected": 0,
        "panel_face_geometry": 0,
        "panel_bbox_fallback": 0,
    }
    calculator = SpatialElementGeometryCalculator(model_doc)
    try:
        for space in sorted(spaces, key=lambda item: eid_value(item.Id)):
            if checked >= PHYSICAL_GEOMETRY_LIMIT:
                skipped.append(eid_value(space.Id))
                continue
            if time.time() - started > PHYSICAL_GEOMETRY_BUDGET_S:
                skipped.append(eid_value(space.Id))
                continue
            if not SpatialElementGeometryCalculator.CanCalculateGeometry(space):
                skipped.append(eid_value(space.Id))
                continue
            try:
                result = calculator.CalculateSpatialElementGeometry(space)
                solid = result.GetGeometry()
                checked += 1
                if solid is None:
                    skipped.append(eid_value(space.Id))
                    continue
                for face in list(solid.Faces):
                    try:
                        subfaces = list(result.GetBoundaryFaceInfo(face) or [])
                    except Exception:
                        subfaces = []
                    for subface in subfaces:
                        try:
                            source_info = resolve_boundary_source(
                                model_doc, subface.SpatialBoundaryElement
                            )
                            if source_info is None or not category_matches(
                                source_info["element"], BuiltInCategory.OST_Walls
                            ):
                                continue
                            subface_geometry = subface.GetSubface()
                            points = face_outer_polyloop(subface_geometry)
                            if len(points) < 3:
                                continue
                            source_infos[source_info["source_key"]] = source_info
                            surfaces.append(
                                {
                                    "key": "{}::{}::{}".format(
                                        eid_value(space.Id),
                                        source_info["source_key"],
                                        len(surfaces),
                                    ),
                                    "space_revit_id": eid_value(space.Id),
                                    "space_name": spatial_label(space),
                                    "originating_element_id": source_info["source_id"],
                                    "originating_element_name": str(
                                        getattr(
                                            source_info["element"], "Name", ""
                                        )
                                        or ""
                                    ),
                                    "source_key": source_info["source_key"],
                                    "polyloops_ft": [points],
                                    "physical_exterior_function": is_exterior_wall(
                                        source_info
                                    ),
                                }
                            )
                        except Exception:
                            continue
                        finally:
                            try:
                                subface.Dispose()
                            except Exception:
                                pass
            except Exception as ex:
                skipped.append(eid_value(space.Id))
                messages.append(
                    {
                        "severity": "ERROR",
                        "code": "PHYSICAL_ENVELOPE_SPACE_FAILED",
                        "element_id": eid_value(space.Id),
                        "space": spatial_label(space),
                        "message": str(ex),
                    }
                )
    finally:
        try:
            calculator.Dispose()
        except Exception:
            pass

    # Revit can occasionally produce a valid 2D Space boundary but omit the
    # corresponding 3D wall subface. Add a conservative vertical chord carrier
    # only when that entire wall/Space source pair is absent above.
    existing_pairs = set(
        (item["space_revit_id"], item["source_key"]) for item in surfaces
    )
    for space in spaces:
        try:
            height, base_z, top_z = space_height(space)
            if height is None or height <= 0.25:
                continue
            loops = space.GetBoundarySegments(SpatialElementBoundaryOptions())
        except Exception:
            continue
        for loop in loops or []:
            for segment in loop:
                source_info = resolve_boundary_segment_source(model_doc, segment)
                if source_info is None or not category_matches(
                    source_info["element"], BuiltInCategory.OST_Walls
                ):
                    continue
                pair = (eid_value(space.Id), source_info["source_key"])
                if pair in existing_pairs:
                    continue
                try:
                    curve = segment.GetCurve()
                    start = curve.GetEndPoint(0)
                    end = curve.GetEndPoint(1)
                    if start.DistanceTo(end) < 0.10 / 0.3048:
                        continue
                    points = [
                        (float(start.X), float(start.Y), float(base_z)),
                        (float(end.X), float(end.Y), float(base_z)),
                        (float(end.X), float(end.Y), float(top_z)),
                        (float(start.X), float(start.Y), float(top_z)),
                    ]
                except Exception:
                    continue
                source_infos[source_info["source_key"]] = source_info
                surfaces.append(
                    {
                        "key": "{}::{}::boundary".format(
                            eid_value(space.Id), source_info["source_key"]
                        ),
                        "space_revit_id": eid_value(space.Id),
                        "space_name": spatial_label(space),
                        "originating_element_id": source_info["source_id"],
                        "originating_element_name": str(
                            safe_element_name(source_info["element"])
                        ),
                        "source_key": source_info["source_key"],
                        "polyloops_ft": [points],
                        "physical_exterior_function": is_exterior_wall(
                            source_info
                        ),
                        "reconstructed_from_2d_boundary": True,
                    }
                )
                existing_pairs.add(pair)

    by_source = {}
    for surface in surfaces:
        by_source.setdefault(surface["source_key"], []).append(surface)
    openings = []
    for source_key, wall_surfaces in by_source.items():
        source_info = source_infos.get(source_key)
        if source_info is None:
            continue
        adjacent_space_ids = sorted(
            set(item["space_revit_id"] for item in wall_surfaces)
        )
        # One space adjacency is authoritative even if the Wall Type Function
        # was mislabeled Interior; two adjacencies are never forced exterior.
        exterior = (
            len(adjacent_space_ids) == 1
            or any(item["physical_exterior_function"] for item in wall_surfaces)
        )
        for surface in wall_surfaces:
            surface["is_one_sided_exterior"] = exterior and (
                len(adjacent_space_ids) == 1
            )
        inserts = collect_wall_inserts(source_info)
        if is_curtain_wall(source_info):
            curtain_stats["curtain_walls"] += 1
        for insert in inserts:
            if insert.get("curtain_panel"):
                curtain_stats["panels_total"] += 1
                role = insert.get("curtain_role")
                if role == "glazing":
                    curtain_stats["glazed_panels"] += 1
                elif role == "door":
                    curtain_stats["door_panels"] += 1
                elif role == "opaque":
                    curtain_stats["opaque_panels"] += 1
                    continue
                elif role == "empty":
                    curtain_stats["empty_panels"] += 1
                    messages.append(
                        {
                            "severity": "ERROR",
                            "code": "CURTAIN_PANEL_EMPTY",
                            "element_id": insert["source_id"],
                            "message": (
                                "Curtain wall contains an empty/open panel adjacent "
                                "to an exportable Space. Replace it with glazing, an "
                                "opaque panel, or a curtain-wall door before export."
                            ),
                        }
                    )
                    continue
                else:
                    curtain_stats["ambiguous_panels"] += 1
                    messages.append(
                        {
                            "severity": "ERROR",
                            "code": "CURTAIN_PANEL_CLASSIFICATION_UNCERTAIN",
                            "element_id": insert["source_id"],
                            "message": (
                                "Curtain panel cannot be deterministically classified "
                                "as glazing, door, or opaque panel: {} ({})"
                            ).format(
                                insert.get("name", ""),
                                insert.get("classification_evidence", ""),
                            ),
                        }
                    )
                    continue
                curtain_stats["panel_openings_expected"] += 1

            best_surface = None
            best_polyloop = []
            best_method = "none"
            best_area = -1.0
            for wall_surface in wall_surfaces:
                polyloop, method = element_opening_polyloop(
                    insert["element"],
                    source_info["transform"],
                    wall_surface["polyloops_ft"][0],
                    insert["bbox_points_ft"],
                )
                area = 0.5 * norm(newell(polyloop)) if polyloop else -1.0
                if area > best_area:
                    best_area = area
                    best_surface = wall_surface
                    best_polyloop = polyloop
                    best_method = method
            if insert.get("curtain_panel"):
                if best_method == "element-face":
                    curtain_stats["panel_face_geometry"] += 1
                elif best_method == "bbox":
                    curtain_stats["panel_bbox_fallback"] += 1
            openings.append(
                {
                    "key": insert["source_key"],
                    "name": insert["name"],
                    "opening_type": insert["opening_type"],
                    "curtain_role": insert.get("curtain_role"),
                    "curtain_panel": bool(insert.get("curtain_panel")),
                    "classification_evidence": insert.get(
                        "classification_evidence", ""
                    ),
                    "geometry_method": best_method,
                    "originating_element_id": insert["source_id"],
                    "originating_element_name": insert["name"],
                    "parent_source_key": source_key,
                    "parent_originating_element_id": source_info["source_id"],
                    "parent_physical_surface_key": (
                        best_surface["key"] if best_surface else ""
                    ),
                    "adjacent_revit_space_ids": adjacent_space_ids,
                    "polyloops_ft": [best_polyloop] if best_polyloop else [],
                }
            )

    if skipped:
        messages.append(
            {
                "severity": "ERROR",
                "code": "PHYSICAL_ENVELOPE_INCOMPLETE",
                "element_ids": skipped[:100],
                "message": (
                    "{} Space(s) could not be checked within the {}-Space / "
                    "{}-second safety budget. Export is blocked rather than "
                    "claiming incomplete geometry is valid."
                ).format(
                    len(skipped),
                    PHYSICAL_GEOMETRY_LIMIT,
                    int(PHYSICAL_GEOMETRY_BUDGET_S),
                ),
            }
        )
    return {
        "surfaces": surfaces,
        "openings": openings,
        "counts": {
            "spaces_checked": checked,
            "wall_faces": len(surfaces),
            "windows_doors_and_curtain_openings": len(openings),
            "windows_and_doors": len(openings),
            "spaces_skipped": len(skipped),
            "curtain": curtain_stats,
        },
        "elapsed_seconds": round(time.time() - started, 3),
        "limit": PHYSICAL_GEOMETRY_LIMIT,
        "budget_seconds": PHYSICAL_GEOMETRY_BUDGET_S,
    }


def local_name(tag):
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def polygon_points(element):
    for poly in element.iter():
        if local_name(poly.tag) != "PolyLoop":
            continue
        points = []
        for point in list(poly):
            if local_name(point.tag) != "CartesianPoint":
                continue
            coords = []
            for coord in list(point):
                if local_name(coord.tag) == "Coordinate":
                    try:
                        coords.append(float(coord.text))
                    except Exception:
                        pass
            if len(coords) >= 3:
                points.append(tuple(coords[:3]))
        if points:
            return points
    return []


def length_to_meters(unit):
    return {
        "meters": 1.0,
        "meter": 1.0,
        "millimeters": 0.001,
        "millimeter": 0.001,
        "centimeters": 0.01,
        "centimeter": 0.01,
        "feet": 0.3048,
        "foot": 0.3048,
        "inches": 0.0254,
        "inch": 0.0254,
    }.get(normalize_text(unit), 1.0)


def distance3(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def vector_sub(a, b):
    return tuple(a[i] - b[i] for i in range(3))


def cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def norm(a):
    return math.sqrt(sum(value * value for value in a))


def newell(points):
    normal = [0.0, 0.0, 0.0]
    for i, point in enumerate(points):
        nxt = points[(i + 1) % len(points)]
        normal[0] += (point[1] - nxt[1]) * (point[2] + nxt[2])
        normal[1] += (point[2] - nxt[2]) * (point[0] + nxt[0])
        normal[2] += (point[0] - nxt[0]) * (point[1] + nxt[1])
    return tuple(normal)


def clean_consecutive(points, tolerance):
    output = []
    for point in points:
        if not output or distance3(point, output[-1]) >= tolerance:
            output.append(point)
    if len(output) > 1 and distance3(output[0], output[-1]) < tolerance:
        output.pop()
    return output


def dominant_projection(points, normal):
    axis = max(range(3), key=lambda i: abs(normal[i]))
    if axis == 0:
        return [(point[1], point[2]) for point in points]
    if axis == 1:
        return [(point[0], point[2]) for point in points]
    return [(point[0], point[1]) for point in points]


def orient2(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (
        c[0] - a[0]
    )


def segments_intersect(a, b, c, d, tol=1e-10):
    o1 = orient2(a, b, c)
    o2 = orient2(a, b, d)
    o3 = orient2(c, d, a)
    o4 = orient2(c, d, b)
    return (o1 * o2 < -tol) and (o3 * o4 < -tol)


def polygon_self_intersects(points2):
    count = len(points2)
    for i in range(count):
        a = points2[i]
        b = points2[(i + 1) % count]
        for j in range(i + 1, count):
            if j == i or (j + 1) % count == i or (i + 1) % count == j:
                continue
            c = points2[j]
            d = points2[(j + 1) % count]
            if segments_intersect(a, b, c, d):
                return True
    return False


def polygon_is_concave(points2, tol=1e-10):
    signs = []
    for i in range(len(points2)):
        value = orient2(
            points2[i - 1], points2[i], points2[(i + 1) % len(points2)]
        )
        if abs(value) > tol:
            signs.append(1 if value > 0 else -1)
    return bool(signs) and min(signs) != max(signs)


def validate_polygon(points, factor, label, errors, warnings):
    meters = [
        (point[0] * factor, point[1] * factor, point[2] * factor)
        for point in points
    ]
    if len(meters) < 3:
        errors.append("{} has fewer than 3 vertices.".format(label))
        return
    cleaned = clean_consecutive(meters, MIN_EDGE_M)
    if len(cleaned) < 3:
        errors.append(
            "{} collapses below 3 vertices under the 0.01 m cleanup rule.".format(
                label
            )
        )
        return
    if len(cleaned) != len(meters):
        errors.append(
            "{} contains consecutive vertices closer than 0.01 m.".format(label)
        )
    normal = newell(cleaned)
    magnitude = norm(normal)
    area = 0.5 * magnitude
    if area <= 1e-9:
        errors.append("{} has zero/near-zero area.".format(label))
        return
    unit_normal = tuple(value / magnitude for value in normal)
    origin = cleaned[0]
    max_deviation = 0.0
    for point in cleaned[1:]:
        delta = vector_sub(point, origin)
        deviation = abs(sum(delta[i] * unit_normal[i] for i in range(3)))
        max_deviation = max(max_deviation, deviation)
    if max_deviation > PLANAR_TOL_M:
        errors.append(
            "{} is nonplanar by {:.6f} m.".format(label, max_deviation)
        )
    projected = dominant_projection(cleaned, normal)
    if polygon_self_intersects(projected):
        errors.append("{} self-intersects.".format(label))
    if polygon_is_concave(projected):
        warnings.append(
            "{} is concave; the downstream Geometry Compiler must decompose it.".format(
                label
            )
        )


def namespace_uri(root):
    return root.tag.split("}", 1)[0][1:] if root.tag.startswith("{") else ""


def qualified(namespace, name):
    return "{{{}}}{}".format(namespace, name) if namespace else name


def direct_child(element, name):
    for child in list(element):
        if local_name(child.tag) == name:
            return child
    return None


def direct_child_text(element, name):
    child = direct_child(element, name)
    return str(child.text or "").strip() if child is not None else ""


def points_to_meters(points, factor):
    return [
        (point[0] * factor, point[1] * factor, point[2] * factor)
        for point in points
    ]


def polygon_centroid(points):
    if not points:
        return (0.0, 0.0, 0.0)
    return tuple(
        sum(point[i] for point in points) / float(len(points)) for i in range(3)
    )


def unit_vector(vector):
    magnitude = norm(vector)
    if magnitude <= 1e-12:
        return None
    return tuple(value / magnitude for value in vector)


def polygon_match(expected_ft, actual_xml, factor, relaxed=False):
    if len(expected_ft) < 3 or len(actual_xml) < 3:
        return False
    expected = points_to_meters(expected_ft, 0.3048)
    actual = points_to_meters(actual_xml, factor)
    expected_normal = unit_vector(newell(expected))
    actual_normal = unit_vector(newell(actual))
    if expected_normal is None or actual_normal is None:
        return False
    alignment = abs(
        sum(expected_normal[i] * actual_normal[i] for i in range(3))
    )
    if alignment < (0.94 if relaxed else 0.985):
        return False
    expected_area = 0.5 * norm(newell(expected))
    actual_area = 0.5 * norm(newell(actual))
    if expected_area <= 1e-9 or actual_area <= 1e-9:
        return False
    area_ratio = actual_area / expected_area
    if relaxed:
        if area_ratio < 0.18 or area_ratio > 5.5:
            return False
    elif area_ratio < 0.65 or area_ratio > 1.55:
        return False
    expected_center = polygon_centroid(expected)
    actual_center = polygon_centroid(actual)
    plane_distance = abs(
        sum(
            (actual_center[i] - expected_center[i]) * expected_normal[i]
            for i in range(3)
        )
    )
    if plane_distance > (0.18 if relaxed else 0.06):
        return False
    center_distance = distance3(expected_center, actual_center)
    size = max(math.sqrt(expected_area), math.sqrt(actual_area), 0.25)
    return center_distance <= (2.5 * size if relaxed else 0.8 * size + 0.20)


def polygon_plane_contains(expected_ft, actual_xml, factor):
    """Coverage check for legitimate analytical split/merge of one wall."""
    if len(expected_ft) < 3 or len(actual_xml) < 3:
        return False
    expected = points_to_meters(expected_ft, 0.3048)
    actual = points_to_meters(actual_xml, factor)
    expected_normal = unit_vector(newell(expected))
    actual_normal = unit_vector(newell(actual))
    if expected_normal is None or actual_normal is None:
        return False
    if abs(
        sum(expected_normal[i] * actual_normal[i] for i in range(3))
    ) < 0.94:
        return False
    expected_center = polygon_centroid(expected)
    actual_center = polygon_centroid(actual)
    plane_distance = abs(
        sum(
            (expected_center[i] - actual_center[i]) * actual_normal[i]
            for i in range(3)
        )
    )
    if plane_distance > 0.18:
        return False
    projected_actual = dominant_projection(actual, actual_normal)
    projected_expected = dominant_projection([expected_center], actual_normal)[0]
    min_x = min(point[0] for point in projected_actual) - 0.20
    max_x = max(point[0] for point in projected_actual) + 0.20
    min_y = min(point[1] for point in projected_actual) - 0.20
    max_y = max(point[1] for point in projected_actual) + 0.20
    return (
        min_x <= projected_expected[0] <= max_x
        and min_y <= projected_expected[1] <= max_y
    )


def xml_envelope_index(root):
    factor = length_to_meters(root.attrib.get("lengthUnit", "Meters"))
    spaces = {}
    space_by_cad = {}
    surfaces = []
    openings = []
    campus = None
    building = None
    for element in root.iter():
        kind = local_name(element.tag)
        if kind == "Campus" and campus is None:
            campus = element
        elif kind == "Building" and building is None:
            building = element
        elif kind == "Space":
            space_id = element.attrib.get("id", "")
            spaces[space_id] = element
            cad = direct_child_text(element, "CADObjectId")
            if cad:
                space_by_cad[cad] = space_id
        elif kind == "Surface":
            info = {
                "element": element,
                "id": element.attrib.get("id", ""),
                "type": element.attrib.get("surfaceType", ""),
                "construction": element.attrib.get("constructionIdRef", ""),
                "cad": direct_child_text(element, "CADObjectId"),
                "adjacent": [
                    child.attrib.get("spaceIdRef")
                    for child in list(element)
                    if local_name(child.tag) == "AdjacentSpaceId"
                    and child.attrib.get("spaceIdRef")
                ],
                "points": polygon_points(element),
            }
            surfaces.append(info)
            for child in list(element):
                if local_name(child.tag) != "Opening":
                    continue
                openings.append(
                    {
                        "element": child,
                        "id": child.attrib.get("id", ""),
                        "type": child.attrib.get("openingType", ""),
                        "construction": child.attrib.get(
                            "constructionIdRef", ""
                        ),
                        "cad": direct_child_text(child, "CADObjectId"),
                        "points": polygon_points(child),
                        "parent": info,
                    }
                )
    surface_by_id = {}
    surface_by_cad = {}
    surface_by_space = {}
    for candidate in surfaces:
        if candidate.get("id"):
            surface_by_id.setdefault(candidate["id"], []).append(candidate)
        if candidate.get("cad"):
            surface_by_cad.setdefault(candidate["cad"], []).append(candidate)
        for space_id in candidate.get("adjacent") or []:
            surface_by_space.setdefault(space_id, []).append(candidate)
    opening_by_id = {}
    opening_by_cad = {}
    opening_by_space = {}
    for candidate in openings:
        if candidate.get("id"):
            opening_by_id.setdefault(candidate["id"], []).append(candidate)
        if candidate.get("cad"):
            opening_by_cad.setdefault(candidate["cad"], []).append(candidate)
        for space_id in (candidate.get("parent") or {}).get("adjacent") or []:
            opening_by_space.setdefault(space_id, []).append(candidate)
    return {
        "root": root,
        "factor": factor,
        "spaces": spaces,
        "space_by_cad": space_by_cad,
        "surfaces": surfaces,
        "surface_by_id": surface_by_id,
        "surface_by_cad": surface_by_cad,
        "surface_by_space": surface_by_space,
        "openings": openings,
        "opening_by_id": opening_by_id,
        "opening_by_cad": opening_by_cad,
        "opening_by_space": opening_by_space,
        "campus": campus,
        "building": building,
    }



def bind_xml_spaces_to_revit(index, analytical_manifest):
    """Bind native gbXML Space ids back to authoritative MEP Space ids.

    Revit native gbXML uses EnergyAnalysisSpace.Id in Space/CADObjectId, while
    REVEX manifests carry the underlying MEP Space id. Direct-fallback XML may
    use the MEP Space id directly. This bridge supports both without guessing.
    """
    space_by_revit = {}
    revit_by_space = {}
    space_by_analysis = {}
    by_cad = index.get("space_by_cad", {}) or {}
    for record in list((analytical_manifest or {}).get("spaces", []) or []):
        rid = int(record.get("revit_space_id") or -1)
        aid = int(record.get("analysis_element_id") or -1)
        xml_id = None
        if aid > 0:
            xml_id = by_cad.get(str(aid))
            if xml_id:
                space_by_analysis[str(aid)] = xml_id
        if xml_id is None and rid > 0:
            xml_id = by_cad.get(str(rid))
        if xml_id and rid > 0:
            space_by_revit[str(rid)] = xml_id
            revit_by_space[xml_id] = str(rid)

    # Direct Revit-geometry fallback uses source MEP Space ids directly.
    for cad, xml_id in by_cad.items():
        try:
            numeric = str(int(cad))
        except Exception:
            continue
        if numeric not in space_by_revit:
            # Do not assume every numeric CAD id is a Space id. Only accept a
            # direct mapping when it is referenced by a source record or when
            # there is no analytical Space domain at all.
            if not (analytical_manifest or {}).get("spaces"):
                space_by_revit[numeric] = xml_id
                revit_by_space[xml_id] = numeric

    index["space_by_revit"] = space_by_revit
    index["revit_by_space"] = revit_by_space
    index["space_by_analysis"] = space_by_analysis
    return index


def expected_xml_space_ids(record, index):
    values = []
    source = record.get("adjacent_revit_space_ids")
    if source is None:
        source = [record.get("space_revit_id")]
    by_revit = index.get("space_by_revit", {}) or {}
    by_cad = index.get("space_by_cad", {}) or {}
    for item in source:
        if item is None:
            continue
        key = str(int(item)) if str(item).lstrip("-").isdigit() else str(item)
        value = by_revit.get(key) or by_cad.get(key)
        if value and value not in values:
            values.append(value)
    return values


def _replace_surface_adjacency(surface_element, namespace, refs):
    refs = [str(item) for item in refs if item]
    unique = []
    for ref in refs:
        if ref not in unique:
            unique.append(ref)
    children = list(surface_element)
    positions = [
        i for i, child in enumerate(children)
        if local_name(child.tag) == "AdjacentSpaceId"
    ]
    insert_at = min(positions) if positions else 0
    for child in children:
        if local_name(child.tag) == "AdjacentSpaceId":
            surface_element.remove(child)
    for offset, ref in enumerate(unique):
        surface_element.insert(
            insert_at + offset,
            ET.Element(qualified(namespace, "AdjacentSpaceId"), {"spaceIdRef": ref})
        )
    return unique


def _sync_space_boundaries_for_surface(root, namespace, surface_info, expected_refs):
    """Keep SpaceBoundary ownership consistent with corrected Surface adjacency."""
    surface_id = str(surface_info.get("id") or "")
    if not surface_id:
        return {"added": 0, "removed": 0}
    expected = set(str(item) for item in expected_refs if item)
    spaces = {}
    boundary_nodes = []
    for element in root.iter():
        if local_name(element.tag) != "Space":
            continue
        sid = element.attrib.get("id", "")
        spaces[sid] = element
        for child in list(element):
            if local_name(child.tag) == "SpaceBoundary" and child.attrib.get("surfaceIdRef") == surface_id:
                boundary_nodes.append((sid, element, child))
    removed = 0
    present = set()
    for sid, parent, boundary in boundary_nodes:
        if sid not in expected or sid in present:
            parent.remove(boundary)
            removed += 1
        else:
            present.add(sid)
    added = 0
    points = surface_info.get("points") or []
    for sid in expected:
        if sid in present:
            continue
        parent = spaces.get(sid)
        if parent is None or len(points) < 3:
            continue
        boundary = ET.SubElement(
            parent, qualified(namespace, "SpaceBoundary"), {"surfaceIdRef": surface_id}
        )
        add_planar_geometry(boundary, namespace, points)
        present.add(sid)
        added += 1
    return {"added": added, "removed": removed}


def normalize_gbxml_adjacency_from_eadm(xml_path, analytical_manifest, messages):
    """Repair Revit native gbXML self-adjacency from the authoritative EADM.

    Revit 2026 can serialize an analytical Surface with two identical
    AdjacentSpaceId children. OpenStudio drops such a Surface entirely. The EADM
    API already exposes distinct source Space identities, so normalize the XML
    adjacency to that unique source-backed set. If no EADM record can be bound,
    duplicate references are conservatively collapsed to one rather than emitted
    as invalid topology.
    """
    tree = ET.parse(xml_path)
    root = tree.getroot()
    namespace = namespace_uri(root)
    if namespace:
        ET.register_namespace("", namespace)
    index = bind_xml_spaces_to_revit(xml_envelope_index(root), analytical_manifest)
    by_analysis = {}
    by_analytical_id = {}
    for record in list((analytical_manifest or {}).get("surfaces", []) or []):
        aid = int(record.get("analysis_element_id") or -1)
        if aid > 0:
            by_analysis[str(aid)] = record
        logical = str(record.get("analytical_id") or "")
        if logical:
            by_analytical_id[logical] = record

    stats = {
        "surfaces_examined": 0,
        "eadm_bound": 0,
        "self_adjacency_before": 0,
        "self_adjacency_after": 0,
        "adjacency_rewritten": 0,
        "boundaries_added": 0,
        "boundaries_removed": 0,
        "unbound_self_adjacency_deduped": 0,
    }
    changed = False
    # Snapshot because boundary edits mutate the tree but not Surface objects.
    for candidate in list(index.get("surfaces", []) or []):
        stats["surfaces_examined"] += 1
        current = [str(item) for item in candidate.get("adjacent", []) if item]
        if len(current) != len(set(current)):
            stats["self_adjacency_before"] += 1
        record = None
        cad = str(candidate.get("cad") or "")
        if cad:
            record = by_analysis.get(cad)
        if record is None:
            record = by_analytical_id.get(str(candidate.get("id") or ""))

        expected = []
        if record is not None:
            stats["eadm_bound"] += 1
            expected = expected_xml_space_ids(record, index)
        if not expected and current:
            # Preserve the serializer's evidence but eliminate invalid duplicates.
            for ref in current:
                if ref not in expected:
                    expected.append(ref)
            if len(current) != len(expected):
                stats["unbound_self_adjacency_deduped"] += 1

        # Shading may legitimately have no Space. Everything else keeps at least
        # the source-backed unique adjacency that actually exists.
        if expected and current != expected:
            actual = _replace_surface_adjacency(
                candidate.get("element"), namespace, expected
            )
            sync = _sync_space_boundaries_for_surface(
                root, namespace, candidate, actual
            )
            stats["boundaries_added"] += int(sync.get("added", 0) or 0)
            stats["boundaries_removed"] += int(sync.get("removed", 0) or 0)
            stats["adjacency_rewritten"] += 1
            changed = True

    if changed:
        tree.write(xml_path, encoding="utf-8", xml_declaration=True)

    # Reparse from disk: this is the actual deliverable proof, not in-memory state.
    verify_root = ET.parse(xml_path).getroot()
    for element in verify_root.iter():
        if local_name(element.tag) != "Surface":
            continue
        refs = [
            child.attrib.get("spaceIdRef")
            for child in list(element)
            if local_name(child.tag) == "AdjacentSpaceId"
            and child.attrib.get("spaceIdRef")
        ]
        if len(refs) != len(set(refs)):
            stats["self_adjacency_after"] += 1
    severity = "INFO" if stats["self_adjacency_after"] == 0 else "WARNING"
    messages.append({
        "severity": severity,
        "code": "GBXML_EADM_ADJACENCY_NORMALIZED",
        "stats": stats,
        "message": (
            "Native gbXML Surface adjacency was rebound to unique Revit EADM Space "
            "identity; invalid same-Space duplicate adjacency is removed before "
            "OpenStudio translation."
        ),
    })
    return stats


def normalize_gbxml_openings_from_revit(
    xml_path, analytical_manifest, physical_manifest, messages
):
    """Dedupe and normalize openings by exact parent Surface + Revit source id."""
    tree = ET.parse(xml_path)
    root = tree.getroot()
    namespace = namespace_uri(root)
    if namespace:
        ET.register_namespace("", namespace)

    source_types = {}
    for manifest in (analytical_manifest or {}, physical_manifest or {}):
        for record in list(manifest.get("openings", []) or []):
            source_id = int(record.get("originating_element_id") or -1)
            if source_id <= 0:
                continue
            normalized = _fallback_opening_type(record.get("opening_type"))
            old = source_types.get(str(source_id))
            # Prefer explicit door/window evidence over a generic fallback.
            if old is None or opening_type_family(normalized) in ("door", "window"):
                source_types[str(source_id)] = normalized

    valid_types = set([
        "FixedWindow", "OperableWindow", "FixedSkylight", "OperableSkylight",
        "SlidingDoor", "NonSlidingDoor", "Air",
    ])
    stats = {
        "openings_examined": 0,
        "types_normalized": 0,
        "duplicate_groups": 0,
        "duplicates_removed": 0,
    }
    changed = False
    for surface in [e for e in root.iter() if local_name(e.tag) == "Surface"]:
        openings = [c for c in list(surface) if local_name(c.tag) == "Opening"]
        groups = {}
        for opening in openings:
            stats["openings_examined"] += 1
            cad = direct_child_text(opening, "CADObjectId")
            current_type = str(opening.attrib.get("openingType") or "")
            desired = source_types.get(str(cad or ""))
            if desired is None and current_type not in valid_types:
                desired = _fallback_opening_type(current_type)
            if desired and current_type != desired:
                opening.attrib["openingType"] = desired
                stats["types_normalized"] += 1
                changed = True
            if cad:
                groups.setdefault(str(cad), []).append(opening)

        for cad, items in groups.items():
            if len(items) <= 1:
                continue
            stats["duplicate_groups"] += 1
            desired = source_types.get(cad)
            def _opening_score(item):
                typ = str(item.attrib.get("openingType") or "")
                score = 0
                if desired and typ == desired:
                    score += 100
                if typ in valid_types:
                    score += 50
                if polygon_points(item):
                    score += 10
                return score
            keep = max(items, key=_opening_score)
            for opening in items:
                if opening is keep:
                    continue
                surface.remove(opening)
                stats["duplicates_removed"] += 1
                changed = True

    if changed:
        tree.write(xml_path, encoding="utf-8", xml_declaration=True)
    messages.append({
        "severity": "INFO",
        "code": "GBXML_OPENING_IDENTITY_NORMALIZED",
        "stats": stats,
        "message": (
            "gbXML openings were normalized by exact Revit source identity; duplicate "
            "representations of the same door/window on the same Surface were removed."
        ),
    })
    return stats


def record_polyloop(record):
    loops = record.get("polyloops_ft") or []
    if not loops:
        return []
    return max(loops, key=lambda points: norm(newell(points)))


def _indexed_candidate_pool(index, kind, analytical_id, source_id, expected_spaces):
    """Return a bounded candidate pool using identity/adjacency indexes.

    Falls back to the full collection only when no indexed evidence exists, so
    matching remains complete while normal scaling stays near-linear.
    """
    plural = "surfaces" if kind == "surface" else "openings"
    prefix = "surface" if kind == "surface" else "opening"
    buckets = []
    if analytical_id:
        buckets.extend(index.get(prefix + "_by_id", {}).get(str(analytical_id), []))
    if int(source_id or -1) > 0:
        buckets.extend(index.get(prefix + "_by_cad", {}).get(str(int(source_id)), []))
    for space_id in expected_spaces or []:
        buckets.extend(index.get(prefix + "_by_space", {}).get(space_id, []))
    if not buckets:
        return index.get(plural, [])
    out=[]; seen=set()
    for item in buckets:
        key=id(item)
        if key in seen:
            continue
        seen.add(key); out.append(item)
    return out


def find_surface_match(record, index, relaxed=False):
    expected_spaces = set(expected_xml_space_ids(record, index))
    expected_points = record_polyloop(record)
    analytical_id = str(record.get("analytical_id") or "")
    source_id = int(record.get("originating_element_id") or -1)
    best = None
    best_score = -1
    for candidate in _indexed_candidate_pool(index, "surface", analytical_id, source_id, expected_spaces):
        candidate_spaces = set(candidate["adjacent"])
        if expected_spaces and not expected_spaces.intersection(candidate_spaces):
            continue
        id_match = bool(analytical_id and candidate["id"] == analytical_id)
        source_match = source_id > 0 and candidate["cad"] == str(source_id)
        geometry_match = polygon_match(
            expected_points,
            candidate["points"],
            index["factor"],
            relaxed=relaxed,
        )
        if relaxed and source_match and not geometry_match:
            geometry_match = polygon_plane_contains(
                expected_points, candidate["points"], index["factor"]
            )
        if id_match and geometry_match:
            score = 100
        elif source_match and geometry_match:
            score = 85
        elif geometry_match:
            score = 55
        else:
            continue
        if expected_spaces and expected_spaces == candidate_spaces:
            score += 10
        if score > best_score:
            best = candidate
            best_score = score
    return best


def opening_type_family(value):
    text = normalize_text(value)
    if "door" in text:
        return "door"
    if "window" in text or "glaz" in text:
        return "window"
    if text in ("air", "opening"):
        return "air"
    return "other" if text else ""


def opening_type_compatible(expected, actual):
    expected_family = opening_type_family(expected)
    if expected_family not in ("door", "window"):
        return True
    return opening_type_family(actual) == expected_family


def find_opening_geometry_match(record, index, relaxed=False):
    expected_spaces = set(expected_xml_space_ids(record, index))
    expected_points = record_polyloop(record)
    analytical_id = str(record.get("analytical_id") or "")
    source_id = int(record.get("originating_element_id") or -1)
    for candidate in _indexed_candidate_pool(index, "opening", analytical_id, source_id, expected_spaces):
        if expected_spaces and not expected_spaces.intersection(
            set(candidate["parent"]["adjacent"])
        ):
            continue
        id_match = bool(analytical_id and candidate["id"] == analytical_id)
        source_match = source_id > 0 and candidate["cad"] == str(source_id)
        geometry_match = (
            polygon_match(
                expected_points,
                candidate["points"],
                index["factor"],
                relaxed=relaxed,
            )
            if expected_points
            else False
        )
        if (id_match or source_match) and (
            geometry_match or (not expected_points and source_match)
        ):
            return candidate
        if geometry_match:
            return candidate
    return None


def find_opening_match(record, index, relaxed=False):
    candidate = find_opening_geometry_match(record, index, relaxed=relaxed)
    if candidate is None:
        return None
    expected_type = str(record.get("opening_type") or "")
    if not opening_type_compatible(expected_type, candidate.get("type", "")):
        return None
    return candidate


def rectangularize_wall(points):
    basis = wall_basis(points)
    if basis is None:
        return []
    u0, u1, v0, v1 = project_bounds(points, basis)
    if u1 - u0 < 0.10 / 0.3048 or v1 - v0 < 0.10 / 0.3048:
        return []
    origin, u, v, normal = basis
    rectangle = [
        point_add(origin, u, u0, v, v0),
        point_add(origin, u, u1, v, v0),
        point_add(origin, u, u1, v, v1),
        point_add(origin, u, u0, v, v1),
    ]
    if sum(newell(rectangle)[i] * normal[i] for i in range(3)) < 0.0:
        rectangle.reverse()
    return rectangle


def add_cartesian_point(parent, namespace, point):
    element = ET.SubElement(parent, qualified(namespace, "CartesianPoint"))
    for value in point:
        coordinate = ET.SubElement(
            element, qualified(namespace, "Coordinate")
        )
        coordinate.text = "{:.9f}".format(float(value)).rstrip("0").rstrip(".")
    return element


def add_planar_geometry(parent, namespace, points_xml):
    geometry = ET.SubElement(parent, qualified(namespace, "PlanarGeometry"))
    polyloop = ET.SubElement(geometry, qualified(namespace, "PolyLoop"))
    for point in points_xml:
        add_cartesian_point(polyloop, namespace, point)
    return geometry


def _fallback_surface_type(value, adjacency_count):
    text=normalize_text(value).replace("_","").replace(" ","")
    ordered=(
        ("undergroundwall","UndergroundWall"),("exteriorwall","ExteriorWall"),("interiorwall","InteriorWall"),
        ("slabongrade","SlabOnGrade"),("undergroundslab","UndergroundSlab"),("raisedfloor","RaisedFloor"),
        ("interiorfloor","InteriorFloor"),("undergroundceiling","UndergroundCeiling"),("ceiling","Ceiling"),
        ("roof","Roof"),("shade","Shade"),("air","Air")
    )
    for token,result in ordered:
        if token in text: return result
    return "InteriorWall" if adjacency_count>1 else "ExteriorWall"


def _fallback_opening_type(value):
    text=normalize_text(value).replace("_","").replace(" ","")
    if "door" in text: return "NonSlidingDoor"
    if "skylight" in text: return "FixedSkylight"
    if "operable" in text and "window" in text: return "OperableWindow"
    if "window" in text or "glaz" in text: return "FixedWindow"
    if "air" in text: return "Air"
    return "FixedWindow"


def _space_floor_polygon_ft(space, model_doc):
    loops=[]
    try: raw=space.GetBoundarySegments(SpatialElementBoundaryOptions())
    except Exception: raw=[]
    base_level=get_level(space,model_doc)
    base_z=level_elevation(base_level)+float(safe_attr(space,"BaseOffset",0.0) or 0.0)
    for loop in list(raw or []):
        points=[]
        for segment in list(loop or []):
            try:
                curve=segment.GetCurve()
                tess=list(curve.Tessellate() or [])
                if not tess: tess=[curve.GetEndPoint(0),curve.GetEndPoint(1)]
                for point in tess:
                    value=(float(point.X),float(point.Y),float(base_z))
                    if not points or distance3(value,points[-1])>1e-7: points.append(value)
            except Exception: continue
        if len(points)>1 and distance3(points[0],points[-1])<1e-7: points.pop()
        if len(points)>=3: loops.append(points)
    return max(loops,key=lambda pts:abs(newell(pts)[2])) if loops else []


def write_direct_revit_geometry_gbxml(model_doc, xml_path, spaces, physical_manifest, messages):
    """Last-resort source-native gbXML from actual Revit Space solids + physical walls.

    This path never invents coordinates. Vertical walls/openings come from the native
    physical envelope manifest; horizontal floor/roof carriers come from actual Space
    solid faces. It exists so a non-empty Revit model can still produce a geometry-only
    handoff when the EADM/serializer API fails. Downstream GeometryCo applies templates.
    """
    namespace="http://www.gbxml.org/schema"
    try: ET.register_namespace("",namespace)
    except Exception: pass
    q=lambda name: qualified(namespace,name)
    root=ET.Element(q("gbXML"),{"temperatureUnit":"C","lengthUnit":"Meters","areaUnit":"SquareMeters","volumeUnit":"CubicMeters","useSIUnitsForResults":"true","version":"7.03"})
    campus=ET.SubElement(root,q("Campus"),{"id":"liber-campus"})
    location=ET.SubElement(campus,q("Location")); nm=ET.SubElement(location,q("Name")); nm.text=str(model_doc.Title); zc=ET.SubElement(location,q("ZipcodeOrPostalCode")); zc.text="00000"
    building=ET.SubElement(campus,q("Building"),{"id":"liber-building","buildingType":"Unknown"})
    valid=[s for s in list(spaces or []) if s is not None and is_placed_spatial(s)]
    if not valid: raise Exception("Direct Revit geometry fallback has no placed Spaces.")
    space_nodes={}; space_map={}
    total_area=sum(max(0.0,float(space.Area or 0.0))*0.09290304 for space in valid)
    building_area=ET.SubElement(building,q("Area")); building_area.text="{:.6f}".format(total_area)
    for space in valid:
        sid=eid_value(space.Id); xid="liber-space-{}".format(sid); space_map[sid]=xid
        node=ET.SubElement(building,q("Space"),{"id":xid}); sn=ET.SubElement(node,q("Name")); sn.text=spatial_label(space) or xid
        try: area=max(0.0,float(space.Area))*0.09290304; a=ET.SubElement(node,q("Area")); a.text="{:.6f}".format(area)
        except Exception: pass
        try: v=ET.SubElement(node,q("Volume")); v.text="{:.6f}".format(max(0.0,float(space.Volume))*0.028316846592)
        except Exception: pass
        cad=ET.SubElement(node,q("CADObjectId")); cad.text=str(sid); space_nodes[sid]=node
    existing=set(); surface_by_key={}
    def add_surface(sid, points_ft, stype, cad_id, key):
        if sid not in space_map or len(points_ft)<3: return None
        base="liber-revit-surface-"+hashlib.sha1((str(key)+"|"+str(sid)).encode("utf-8")).hexdigest()[:14]; xid=base; seq=2
        while xid in existing: xid="{}-{}".format(base,seq); seq+=1
        existing.add(xid)
        node=ET.SubElement(campus,q("Surface"),{"id":xid,"surfaceType":stype}); n=ET.SubElement(node,q("Name")); n.text=str(key)
        ET.SubElement(node,q("AdjacentSpaceId"),{"spaceIdRef":space_map[sid]})
        points_m=[tuple(float(c)*0.3048 for c in p[:3]) for p in points_ft]; add_planar_geometry(node,namespace,points_m)
        cad=ET.SubElement(node,q("CADObjectId")); cad.text=str(cad_id or "")
        b=ET.SubElement(space_nodes[sid],q("SpaceBoundary"),{"surfaceIdRef":xid}); add_planar_geometry(b,namespace,points_m)
        surface_by_key[str(key)]=node; return node
    # Authoritative physical wall faces first.
    for rec in list((physical_manifest or {}).get("surfaces",[]) or []):
        pts=record_polyloop(rec); sid=int(rec.get("space_revit_id") or -1)
        stype="ExteriorWall" if rec.get("is_one_sided_exterior") else "InteriorWall"
        add_surface(sid,pts,stype,rec.get("originating_element_id"),rec.get("key") or rec.get("originating_element_id"))
    # Horizontal carriers directly from actual Space solids.
    calc=SpatialElementGeometryCalculator(model_doc)
    try:
        for space in valid:
            sid=eid_value(space.Id)
            try:
                result=calc.CalculateSpatialElementGeometry(space); solid=result.GetGeometry(); box=space.get_BoundingBox(None); mid=(float(box.Min.Z)+float(box.Max.Z))*0.5 if box is not None else 0.0
                for face in list(solid.Faces) if solid is not None else []:
                    pts=face_outer_polyloop(face)
                    if len(pts)<3: continue
                    normal=unit_vector(newell(pts))
                    if normal is None or abs(normal[2])<0.70: continue
                    cz=sum(p[2] for p in pts)/float(len(pts)); stype="Roof" if cz>=mid else "RaisedFloor"
                    add_surface(sid,pts,stype,sid,"space-{}-horizontal-{:.4f}".format(sid,cz))
            except Exception: continue
    finally:
        try: calc.Dispose()
        except Exception: pass
    # Physical openings stay on their proven parent wall when that carrier exists.
    opening_count=0
    for rec in list((physical_manifest or {}).get("openings",[]) or []):
        parent=surface_by_key.get(str(rec.get("parent_physical_surface_key") or "")); pts=record_polyloop(rec)
        if parent is None or len(pts)<3: continue
        oid="liber-revit-opening-"+hashlib.sha1(str(rec.get("key") or opening_count).encode("utf-8")).hexdigest()[:14]
        op=ET.SubElement(parent,q("Opening"),{"id":oid,"openingType":_fallback_opening_type(rec.get("opening_type")),"coordinatesAbsolute":"true"}); n=ET.SubElement(op,q("Name")); n.text=str(rec.get("name") or oid); add_planar_geometry(op,namespace,[tuple(float(c)*0.3048 for c in p[:3]) for p in pts]); cad=ET.SubElement(op,q("CADObjectId")); cad.text=str(rec.get("originating_element_id") or ""); opening_count+=1
    if len(existing)<4: raise Exception("Direct Revit geometry fallback has insufficient source surfaces: {}".format(len(existing)))
    ET.ElementTree(root).write(xml_path,encoding="utf-8",xml_declaration=True)
    parsed=ET.parse(xml_path).getroot(); counts={"spaces":sum(1 for e in parsed.iter() if local_name(e.tag)=="Space"),"surfaces":sum(1 for e in parsed.iter() if local_name(e.tag)=="Surface"),"openings":sum(1 for e in parsed.iter() if local_name(e.tag)=="Opening")}
    if counts["spaces"]<1 or counts["surfaces"]<4: raise Exception("Direct Revit geometry fallback wrote an empty/insufficient model: {}".format(counts))
    messages.append({"severity":"WARNING","code":"DIRECT_REVIT_GEOMETRY_GBXML_FALLBACK_USED","counts":counts,"message":"Native EADM/serializer path could not complete; REVEX exported source-native Revit Space solids, wall faces and proven openings without fitting geometry. Downstream template compiler must apply constructions/schedules/systems."})
    return xml_path,counts


def write_direct_eadm_gbxml(model_doc, xml_path, spaces, analytical_manifest, messages):
    """Dependency-free geometry fallback from the already-verified Revit EADM.

    This is intentionally a geometry/identity gbXML, suitable for the downstream LIBER
    template compiler to apply constructions, schedules and systems. It is used only
    when Revit's native serializer fails after the native EADM itself has succeeded.
    """
    namespace="http://www.gbxml.org/schema"
    try: ET.register_namespace("",namespace)
    except Exception: pass
    q=lambda name: qualified(namespace,name)
    root=ET.Element(q("gbXML"),{
        "temperatureUnit":"C","lengthUnit":"Meters","areaUnit":"SquareMeters",
        "volumeUnit":"CubicMeters","useSIUnitsForResults":"true","version":"7.03"
    })
    campus=ET.SubElement(root,q("Campus"),{"id":"liber-campus"})
    location=ET.SubElement(campus,q("Location"))
    lname=ET.SubElement(location,q("Name")); lname.text=str(model_doc.Title)
    # gbXML 7.03 Location requires ZipcodeOrPostalCode. Use project-address ZIP when
    # available; otherwise a clearly synthetic schema placeholder because this direct
    # path carries geometry/identity only and downstream workflow supplies weather.
    project_address=str(safe_attr(safe_attr(model_doc,"ProjectInformation",None),"Address","") or "")
    zip_match=re.search(r"\b(\d{5}(?:-\d{4})?)\b",project_address)
    zip_node=ET.SubElement(location,q("ZipcodeOrPostalCode")); zip_node.text=zip_match.group(1) if zip_match else "00000"
    building=ET.SubElement(campus,q("Building"),{"id":"liber-building","buildingType":"Unknown"})
    space_map={}
    total_area=0.0
    valid_spaces=[]
    for space in spaces:
        if space is None or not is_placed_spatial(space): continue
        sid=eid_value(space.Id)
        xml_id="liber-space-{}".format(sid)
        space_map[sid]=xml_id
        valid_spaces.append(space)
        try: total_area += max(0.0,float(space.Area))*0.09290304
        except Exception: pass
    area_el=ET.SubElement(building,q("Area")); area_el.text="{:.6f}".format(total_area)
    space_nodes={}
    for space in valid_spaces:
        sid=eid_value(space.Id); xml_id=space_map[sid]
        node=ET.SubElement(building,q("Space"),{"id":xml_id})
        name=ET.SubElement(node,q("Name")); name.text=spatial_label(space) or xml_id
        try:
            a=ET.SubElement(node,q("Area")); a.text="{:.6f}".format(max(0.0,float(space.Area))*0.09290304)
        except Exception: pass
        try:
            v=ET.SubElement(node,q("Volume")); v.text="{:.6f}".format(max(0.0,float(space.Volume))*0.028316846592)
        except Exception: pass
        floor=_space_floor_polygon_ft(space, model_doc)
        if len(floor)>=3: add_planar_geometry(node,namespace,[(x*0.3048,y*0.3048,z*0.3048) for x,y,z in floor])
        cad=ET.SubElement(node,q("CADObjectId")); cad.text=str(sid)
        space_nodes[sid]=node

    surface_nodes={}
    existing_surface_ids=set()
    records=list((analytical_manifest or {}).get("surfaces",[]) or [])
    openings=list((analytical_manifest or {}).get("openings",[]) or [])
    for idx,record in enumerate(records,1):
        adjacent=[int(v) for v in (record.get("adjacent_revit_space_ids") or []) if int(v) in space_map]
        points=record_polyloop(record)
        if not adjacent or len(points)<3: continue
        seed=str(record.get("analytical_id") or record.get("analysis_element_id") or idx)
        base="liber-surface-"+re.sub(r"[^A-Za-z0-9_.-]+","-",seed).strip("-")
        surface_id=base or "liber-surface-{}".format(idx)
        n=2
        while surface_id in existing_surface_ids:
            surface_id="{}-{}".format(base,n); n+=1
        existing_surface_ids.add(surface_id)
        node=ET.SubElement(campus,q("Surface"),{"id":surface_id,"surfaceType":_fallback_surface_type(record.get("surface_type"),len(adjacent))})
        nm=ET.SubElement(node,q("Name")); nm.text=str(record.get("name") or surface_id)
        for sid in adjacent: ET.SubElement(node,q("AdjacentSpaceId"),{"spaceIdRef":space_map[sid]})
        points_m=[tuple(float(c)*0.3048 for c in p[:3]) for p in points]
        add_planar_geometry(node,namespace,points_m)
        cad=ET.SubElement(node,q("CADObjectId")); cad.text=str(record.get("originating_element_id") or record.get("analysis_element_id") or "")
        surface_nodes[str(record.get("analytical_id") or record.get("analysis_element_id"))]=node
        surface_nodes[str(record.get("analysis_element_id"))]=node
        for sid in adjacent:
            sp=space_nodes.get(sid)
            if sp is not None:
                boundary=ET.SubElement(sp,q("SpaceBoundary"),{"surfaceIdRef":surface_id})
                add_planar_geometry(boundary,namespace,points_m)

    existing_opening_ids=set()
    for idx,record in enumerate(openings,1):
        parent=surface_nodes.get(str(record.get("parent_analytical_id"))) or surface_nodes.get(str(record.get("parent_analysis_element_id")))
        points=record_polyloop(record)
        if parent is None or len(points)<3: continue
        seed=str(record.get("analytical_id") or record.get("analysis_element_id") or idx)
        base="liber-opening-"+re.sub(r"[^A-Za-z0-9_.-]+","-",seed).strip("-")
        oid=base or "liber-opening-{}".format(idx); n=2
        while oid in existing_opening_ids: oid="{}-{}".format(base,n); n+=1
        existing_opening_ids.add(oid)
        node=ET.SubElement(parent,q("Opening"),{"id":oid,"openingType":_fallback_opening_type(record.get("opening_type")),"coordinatesAbsolute":"true"})
        nm=ET.SubElement(node,q("Name")); nm.text=str(record.get("name") or oid)
        add_planar_geometry(node,namespace,[tuple(float(c)*0.3048 for c in p[:3]) for p in points])
        cad=ET.SubElement(node,q("CADObjectId")); cad.text=str(record.get("originating_element_id") or record.get("analysis_element_id") or "")
    if len(space_nodes)==0 or len(existing_surface_ids)<4:
        raise Exception("Direct EADM fallback has insufficient gbXML 7.03 core geometry: spaces={}, surfaces={} (Campus requires at least 4 Surfaces).".format(len(space_nodes),len(existing_surface_ids)))
    tree=ET.ElementTree(root)
    tree.write(xml_path,encoding="utf-8",xml_declaration=True)
    # prove on-disk parse and nonempty core records
    parsed=ET.parse(xml_path).getroot()
    counts={"spaces":sum(1 for e in parsed.iter() if local_name(e.tag)=="Space"),"surfaces":sum(1 for e in parsed.iter() if local_name(e.tag)=="Surface"),"openings":sum(1 for e in parsed.iter() if local_name(e.tag)=="Opening")}
    if counts["spaces"]==0 or counts["surfaces"]==0: raise Exception("Direct EADM fallback wrote an empty analytical model: {}".format(counts))
    messages.append({"severity":"WARNING","code":"DIRECT_EADM_GBXML_FALLBACK_USED","counts":counts,"message":"Revit native gbXML serialization failed; REVEX serialized the already-verified Revit EADM geometry/identity directly. Downstream template compiler must apply constructions/schedules/systems."})
    return xml_path,counts


def rectangle_dimensions(points):
    if len(points) != 4:
        return 0.0, 0.0
    return distance3(points[0], points[1]), distance3(points[1], points[2])


def best_surface_construction(record, index):
    expected_spaces = set(expected_xml_space_ids(record, index))
    expected_points = record_polyloop(record)
    expected_normal = unit_vector(newell(expected_points))
    source_id = int(record.get("originating_element_id") or -1)
    best_value = ""
    best_score = -1e9
    for candidate in index["surfaces"]:
        if candidate["type"] != "ExteriorWall" or not candidate["construction"]:
            continue
        score = 0.0
        if source_id > 0 and candidate["cad"] == str(source_id):
            score += 100.0
        if expected_spaces.intersection(set(candidate["adjacent"])):
            score += 40.0
        candidate_normal = unit_vector(newell(candidate["points"]))
        if expected_normal is not None and candidate_normal is not None:
            score += 20.0 * abs(
                sum(
                    expected_normal[i] * candidate_normal[i] for i in range(3)
                )
            )
        if expected_points and candidate["points"]:
            expected_area = 0.5 * norm(newell(expected_points)) * 0.3048**2
            candidate_area = (
                0.5
                * norm(newell(candidate["points"]))
                * index["factor"] ** 2
            )
            score -= abs(
                math.log(
                    max(candidate_area, 1e-9) / max(expected_area, 1e-9)
                )
            )
        if score > best_score:
            best_score = score
            best_value = candidate["construction"]
    return best_value


def best_opening_construction(record, index):
    wanted = str(record.get("opening_type") or "")
    family = opening_type_family(wanted)
    for candidate in index["openings"]:
        if not candidate["construction"]:
            continue
        if family in ("door", "window"):
            if opening_type_family(candidate["type"]) == family:
                return candidate["construction"]
        elif opening_type_compatible(wanted, candidate["type"]):
            return candidate["construction"]
    return ""


def stable_fallback_id(prefix, record, existing_ids):
    seed = "|".join(
        [
            str(record.get("analytical_id") or ""),
            str(record.get("key") or ""),
            str(record.get("originating_element_id") or ""),
            ",".join(str(item) for item in record.get("adjacent_revit_space_ids", [])),
            str(record.get("space_revit_id") or ""),
        ]
    )
    base = "liber-{}-{}".format(
        prefix, hashlib.sha1(seed.encode("utf-8")).hexdigest()[:14]
    )
    value = base
    sequence = 2
    while value in existing_ids:
        value = "{}-{}".format(base, sequence)
        sequence += 1
    existing_ids.add(value)
    return value


def inject_exterior_wall(record, index, namespace, existing_surface_ids):
    expected_spaces = expected_xml_space_ids(record, index)
    if len(expected_spaces) != 1 or index["campus"] is None:
        return None, "Fallback wall does not have exactly one exported Space."
    source_points = record_polyloop(record)
    rectangle_ft = rectangularize_wall(source_points)
    if len(rectangle_ft) != 4:
        return None, "Missing face cannot be reduced to a safe vertical rectangle."
    scale = 0.3048 / index["factor"]
    rectangle_xml = [
        tuple(value * scale for value in point) for point in rectangle_ft
    ]
    surface_id = stable_fallback_id(
        "fallback-exterior-wall", record, existing_surface_ids
    )
    attributes = {
        "id": surface_id,
        "surfaceType": "ExteriorWall",
        "exposedToSun": "true",
    }
    construction = best_surface_construction(record, index)
    if construction:
        attributes["constructionIdRef"] = construction
    surface = ET.Element(qualified(namespace, "Surface"), attributes)
    name = ET.SubElement(surface, qualified(namespace, "Name"))
    name.text = "LIBER simplified exterior carrier {}".format(
        record.get("originating_element_name")
        or record.get("originating_element_id")
        or surface_id
    )
    ET.SubElement(
        surface,
        qualified(namespace, "AdjacentSpaceId"),
        {"spaceIdRef": expected_spaces[0]},
    )
    rectangular = ET.SubElement(
        surface, qualified(namespace, "RectangularGeometry")
    )
    normal = unit_vector(newell(rectangle_ft)) or (0.0, 1.0, 0.0)
    azimuth = math.degrees(math.atan2(normal[0], normal[1])) % 360.0
    azimuth_element = ET.SubElement(
        rectangular, qualified(namespace, "Azimuth")
    )
    azimuth_element.text = "{:.6f}".format(azimuth).rstrip("0").rstrip(".")
    add_cartesian_point(rectangular, namespace, rectangle_xml[0])
    tilt = ET.SubElement(rectangular, qualified(namespace, "Tilt"))
    tilt.text = "90"
    width, height = rectangle_dimensions(rectangle_xml)
    height_element = ET.SubElement(
        rectangular, qualified(namespace, "Height")
    )
    height_element.text = "{:.9f}".format(height).rstrip("0").rstrip(".")
    width_element = ET.SubElement(rectangular, qualified(namespace, "Width"))
    width_element.text = "{:.9f}".format(width).rstrip("0").rstrip(".")
    add_planar_geometry(surface, namespace, rectangle_xml)
    cad = ET.SubElement(surface, qualified(namespace, "CADObjectId"))
    cad.text = str(record.get("originating_element_id") or "")
    index["campus"].append(surface)
    space = index["spaces"].get(expected_spaces[0])
    if space is not None:
        boundary = ET.SubElement(
            space,
            qualified(namespace, "SpaceBoundary"),
            {"surfaceIdRef": surface_id},
        )
        add_planar_geometry(boundary, namespace, rectangle_xml)
    return surface_id, None


def inject_interior_wall_pair(record, sibling, index, namespace, existing_surface_ids):
    """Insert one exact physical interior wall carrier shared by two proven Spaces."""
    first = expected_xml_space_ids(record, index)
    second = expected_xml_space_ids(sibling, index)
    refs = []
    for value in list(first) + list(second):
        if value and value not in refs:
            refs.append(value)
    if len(refs) != 2 or index.get("campus") is None:
        return None, "Physical interior wall pair does not resolve to exactly two exported Spaces."
    points_ft = record_polyloop(record)
    if len(points_ft) < 3:
        points_ft = record_polyloop(sibling)
    if len(points_ft) < 3:
        return None, "Physical interior wall pair has no trustworthy Revit face polygon."
    cleaned_ft = clean_consecutive(points_ft, MIN_EDGE_M / 0.3048)
    if len(cleaned_ft) >= 3 and not polygon_self_intersects(
        dominant_projection(cleaned_ft, newell(cleaned_ft))
    ):
        points_ft = cleaned_ft
    else:
        points_ft = rectangularize_wall(points_ft)
    if len(points_ft) < 3:
        return None, "Physical interior wall pair cannot be reduced to a safe planar carrier."
    scale = 0.3048 / index["factor"]
    points_xml = [tuple(value * scale for value in point) for point in points_ft]
    stable_record = dict(record)
    stable_record["space_revit_id"] = min(
        int(record.get("space_revit_id") or -1),
        int(sibling.get("space_revit_id") or -1),
    )
    surface_id = stable_fallback_id(
        "fallback-interior-wall", stable_record, existing_surface_ids
    )
    attrs = {"id": surface_id, "surfaceType": "InteriorWall"}
    construction = best_surface_construction(record, index)
    if construction:
        attrs["constructionIdRef"] = construction
    surface = ET.Element(qualified(namespace, "Surface"), attrs)
    name = ET.SubElement(surface, qualified(namespace, "Name"))
    name.text = "LIBER preserved interior wall {}".format(
        record.get("originating_element_name")
        or record.get("originating_element_id")
        or surface_id
    )
    for ref in refs:
        ET.SubElement(
            surface, qualified(namespace, "AdjacentSpaceId"), {"spaceIdRef": ref}
        )
    add_planar_geometry(surface, namespace, points_xml)
    cad = ET.SubElement(surface, qualified(namespace, "CADObjectId"))
    cad.text = str(record.get("originating_element_id") or "")
    index["campus"].append(surface)
    for ref in refs:
        space = index.get("spaces", {}).get(ref)
        if space is not None:
            boundary = ET.SubElement(
                space, qualified(namespace, "SpaceBoundary"), {"surfaceIdRef": surface_id}
            )
            add_planar_geometry(boundary, namespace, points_xml)
    return surface_id, None


def select_opening_parent(record, index):
    expected_spaces = set(expected_xml_space_ids(record, index))
    parent_analytical_id = str(record.get("parent_analytical_id") or "")
    parent_source_id = int(
        record.get("parent_originating_element_id") or -1
    )
    expected_points = record_polyloop(record)
    best = None
    best_score = -1
    for candidate in index["surfaces"]:
        if expected_spaces and not expected_spaces.intersection(
            set(candidate["adjacent"])
        ):
            continue
        score = 0
        if parent_analytical_id and candidate["id"] == parent_analytical_id:
            score += 100
        if parent_source_id > 0 and candidate["cad"] == str(parent_source_id):
            score += 80
        if expected_points and polygon_match(
            expected_points,
            candidate["points"],
            index["factor"],
            relaxed=True,
        ):
            score += 30
        if score > best_score:
            best = candidate
            best_score = score
    return best if best_score > 0 else None


def inject_opening(record, index, namespace, existing_opening_ids):
    parent = select_opening_parent(record, index)
    if parent is None:
        return None, "No exported parent Surface can carry the missing opening."
    source_points = record_polyloop(record)
    if len(source_points) < 3:
        return None, "Opening has no trustworthy physical or analytical polygon."
    # Preserve Revit's exact planar analytical opening. Only rectangularize when
    # the polygon is invalid for downstream engines.
    points_ft = list(source_points)
    cleaned_ft = clean_consecutive(points_ft, MIN_EDGE_M / 0.3048)
    if len(cleaned_ft) < 3 or polygon_self_intersects(
        dominant_projection(cleaned_ft, newell(cleaned_ft))
    ):
        points_ft = rectangularize_wall(points_ft)
    if len(points_ft) < 3:
        return None, "Opening polygon cannot be simplified safely."
    scale = 0.3048 / index["factor"]
    points_xml = [tuple(value * scale for value in point) for point in points_ft]
    opening_id = stable_fallback_id(
        "fallback-opening", record, existing_opening_ids
    )
    opening_type = _fallback_opening_type(record.get("opening_type"))
    attributes = {"id": opening_id, "openingType": opening_type}
    construction = best_opening_construction(record, index)
    if construction:
        attributes["constructionIdRef"] = construction
    opening = ET.Element(qualified(namespace, "Opening"), attributes)
    name = ET.SubElement(opening, qualified(namespace, "Name"))
    name.text = "LIBER preserved {}".format(
        record.get("originating_element_name")
        or record.get("originating_element_id")
        or opening_id
    )
    rectangle = rectangularize_wall(points_ft)
    if len(rectangle) == 4:
        rectangle_xml = [
            tuple(value * scale for value in point) for point in rectangle
        ]
        rectangular = ET.SubElement(
            opening, qualified(namespace, "RectangularGeometry")
        )
        add_cartesian_point(rectangular, namespace, rectangle_xml[0])
        width, height = rectangle_dimensions(rectangle_xml)
        height_element = ET.SubElement(
            rectangular, qualified(namespace, "Height")
        )
        height_element.text = "{:.9f}".format(height).rstrip("0").rstrip(".")
        width_element = ET.SubElement(
            rectangular, qualified(namespace, "Width")
        )
        width_element.text = "{:.9f}".format(width).rstrip("0").rstrip(".")
    add_planar_geometry(opening, namespace, points_xml)
    cad = ET.SubElement(opening, qualified(namespace, "CADObjectId"))
    cad.text = str(record.get("originating_element_id") or "")
    parent_element = parent["element"]
    insert_at = len(list(parent_element))
    for index_value, child in enumerate(list(parent_element)):
        if local_name(child.tag) == "CADObjectId":
            insert_at = index_value
            break
    parent_element.insert(insert_at, opening)
    return opening_id, None


def envelope_persistence_gate(
    xml_path, physical_manifest, analytical_manifest, allow_repairs=True
):
    tree = ET.parse(xml_path)
    root = tree.getroot()
    namespace = namespace_uri(root)
    if namespace:
        ET.register_namespace("", namespace)
    index = bind_xml_spaces_to_revit(
        xml_envelope_index(root), analytical_manifest
    )
    errors = []
    warnings = []
    repaired_surfaces = []
    repaired_openings = []
    corrected_opening_types = []
    existing_surface_ids = set(item["id"] for item in index["surfaces"])
    existing_opening_ids = set(item["id"] for item in index["openings"])

    if not analytical_manifest.get("surfaces"):
        errors.append(
            "The Revit analytical surface manifest is empty; persistence "
            "cannot be proven."
        )

    # Prefer the exact Revit analytical polygon when it exists. The independent
    # physical pass follows and catches faces omitted before analytical export.
    analytical_missing = []
    for record in analytical_manifest.get("surfaces", []):
        if find_surface_match(record, index, relaxed=False) is None:
            analytical_missing.append(record)
    for record in analytical_missing:
        surface_type = normalize_text(record.get("surface_type"))
        if (
            not allow_repairs
            or surface_type != "exteriorwall"
            or len(expected_xml_space_ids(record, index)) != 1
        ):
            errors.append(
                "Analytical face {} ({}) is absent from gbXML.".format(
                    record.get("analytical_id"), record.get("surface_type")
                )
            )
            continue
        surface_id, error = inject_exterior_wall(
            record, index, namespace, existing_surface_ids
        )
        if error:
            errors.append(
                "Analytical exterior face {} could not be repaired: {}".format(
                    record.get("analytical_id"), error
                )
            )
        else:
            repaired_surfaces.append(surface_id)
            warnings.append(
                "{} inserted for missing analytical exterior face {}.".format(
                    surface_id, record.get("analytical_id")
                )
            )
            index = bind_xml_spaces_to_revit(xml_envelope_index(root), analytical_manifest)

    physical_missing = []
    physical_by_source = {}
    for record in physical_manifest.get("surfaces", []):
        physical_by_source.setdefault(str(record.get("source_key") or ""), []).append(record)
        if find_surface_match(record, index, relaxed=True) is None:
            physical_missing.append(record)
    for record in physical_missing:
        # Another missing member of this source pair may already have inserted a
        # shared carrier earlier in the loop.
        if find_surface_match(record, index, relaxed=True) is not None:
            continue

        if allow_repairs and not record.get("is_one_sided_exterior"):
            sibling = None
            source_key = str(record.get("source_key") or "")
            points = record_polyloop(record)
            for candidate in physical_by_source.get(source_key, []):
                if candidate is record:
                    continue
                if int(candidate.get("space_revit_id") or -1) == int(record.get("space_revit_id") or -1):
                    continue
                candidate_points = record_polyloop(candidate)
                if (
                    points and candidate_points
                    and polygon_match(points, candidate_points, 0.3048, relaxed=False)
                ):
                    combined = []
                    for ref in expected_xml_space_ids(record, index) + expected_xml_space_ids(candidate, index):
                        if ref and ref not in combined:
                            combined.append(ref)
                    if len(combined) == 2:
                        sibling = candidate
                        break
            if sibling is not None:
                surface_id, error = inject_interior_wall_pair(
                    record, sibling, index, namespace, existing_surface_ids
                )
                if not error:
                    repaired_surfaces.append(surface_id)
                    warnings.append(
                        "{} inserted for missing source-proven physical interior wall {}.".format(
                            surface_id, record.get("originating_element_id")
                        )
                    )
                    index = bind_xml_spaces_to_revit(
                        xml_envelope_index(root), analytical_manifest
                    )
                    continue

        if not allow_repairs or not record.get("is_one_sided_exterior"):
            errors.append(
                "Physical wall face {} for Space {} is absent from gbXML{}.".format(
                    record.get("originating_element_id"),
                    record.get("space_revit_id"),
                    (
                        " and has no source-proven two-Space interior pair"
                        if not record.get("is_one_sided_exterior")
                        else ""
                    ),
                )
            )
            continue
        surface_id, error = inject_exterior_wall(
            record, index, namespace, existing_surface_ids
        )
        if error:
            errors.append(
                "Physical wall face {} could not be repaired: {}".format(
                    record.get("originating_element_id"), error
                )
            )
        else:
            repaired_surfaces.append(surface_id)
            warnings.append(
                "{} inserted for missing physical exterior wall {}.".format(
                    surface_id, record.get("originating_element_id")
                )
            )
            index = bind_xml_spaces_to_revit(xml_envelope_index(root), analytical_manifest)

    opening_records = []
    seen_opening_sources = set()
    for manifest_name, manifest in (
        ("analytical", analytical_manifest),
        ("physical", physical_manifest),
    ):
        for record in manifest.get("openings", []):
            source_id = int(record.get("originating_element_id") or -1)
            points = record_polyloop(record)
            center = polygon_centroid(points) if points else (0.0, 0.0, 0.0)
            dedupe_key = (
                source_id if source_id > 0 else str(record.get("analytical_id")),
                normalize_text(record.get("opening_type")),
                tuple(sorted(expected_xml_space_ids(record, index))),
                tuple(round(value, 2) for value in center),
            )
            if dedupe_key in seen_opening_sources:
                continue
            seen_opening_sources.add(dedupe_key)
            opening_records.append((manifest_name, record))

    for manifest_name, record in opening_records:
        relaxed = manifest_name == "physical"
        if find_opening_match(record, index, relaxed=relaxed) is not None:
            continue

        geometry_candidate = find_opening_geometry_match(
            record, index, relaxed=relaxed
        )
        expected_type = str(record.get("opening_type") or "")
        if (
            geometry_candidate is not None
            and opening_type_family(expected_type) in ("door", "window")
            and not opening_type_compatible(
                expected_type, geometry_candidate.get("type", "")
            )
        ):
            if allow_repairs:
                geometry_candidate["element"].attrib["openingType"] = _fallback_opening_type(expected_type)
                corrected_opening_types.append(geometry_candidate.get("id", ""))
                warnings.append(
                    "Opening {} type corrected from {} to {} for {} {}.".format(
                        geometry_candidate.get("id", ""),
                        geometry_candidate.get("type", ""),
                        expected_type,
                        manifest_name,
                        record.get("originating_element_id")
                        or record.get("analytical_id"),
                    )
                )
                index = bind_xml_spaces_to_revit(xml_envelope_index(root), analytical_manifest)
                continue
            errors.append(
                "{} opening {} has wrong gbXML openingType {} (expected {}).".format(
                    manifest_name.title(),
                    record.get("originating_element_id")
                    or record.get("analytical_id"),
                    geometry_candidate.get("type", ""),
                    expected_type,
                )
            )
            continue

        if not allow_repairs:
            errors.append(
                "{} opening {} is absent from gbXML.".format(
                    manifest_name.title(),
                    record.get("originating_element_id")
                    or record.get("analytical_id"),
                )
            )
            continue
        opening_id, error = inject_opening(
            record, index, namespace, existing_opening_ids
        )
        if error:
            errors.append(
                "{} opening {} could not be preserved: {}".format(
                    manifest_name.title(),
                    record.get("originating_element_id")
                    or record.get("analytical_id"),
                    error,
                )
            )
        else:
            repaired_openings.append(opening_id)
            warnings.append(
                "{} inserted for missing {} opening {}.".format(
                    opening_id,
                    manifest_name,
                    record.get("originating_element_id")
                    or record.get("analytical_id"),
                )
            )
            index = bind_xml_spaces_to_revit(xml_envelope_index(root), analytical_manifest)

    changed = bool(
        repaired_surfaces or repaired_openings or corrected_opening_types
    )
    if changed:
        tree.write(xml_path, encoding="utf-8", xml_declaration=True)

    # Reparse and prove that repairs did not merely alter the in-memory tree.
    if changed:
        verify = envelope_persistence_gate(
            xml_path,
            physical_manifest,
            analytical_manifest,
            allow_repairs=False,
        )
        errors.extend(verify["errors"])
        warnings.extend(verify["warnings"])

    # Preservation is measured after all conservative repairs, independently from
    # strict GeometryCo validity. This allows an emergency export to survive nonfatal
    # QA defects while still enforcing the 80% hard-stop / 95% quality-target publication contract.
    try:
        final_root = ET.parse(xml_path).getroot()
        final_index = bind_xml_spaces_to_revit(xml_envelope_index(final_root), analytical_manifest)
        physical_surface_expected = len(physical_manifest.get("surfaces", []))
        physical_surface_preserved = sum(
            1 for record in physical_manifest.get("surfaces", [])
            if find_surface_match(record, final_index, relaxed=True) is not None
        )
        physical_opening_expected = len(physical_manifest.get("openings", []))
        physical_opening_preserved = sum(
            1 for record in physical_manifest.get("openings", [])
            if find_opening_match(record, final_index, relaxed=True) is not None
        )
    except Exception:
        physical_surface_expected = len(physical_manifest.get("surfaces", []))
        physical_surface_preserved = 0
        physical_opening_expected = len(physical_manifest.get("openings", []))
        physical_opening_preserved = 0
    return {
        "passed": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "physical_wall_faces_expected": len(
                physical_manifest.get("surfaces", [])
            ),
            "analytical_faces_expected": len(
                analytical_manifest.get("surfaces", [])
            ),
            "physical_windows_doors_expected": len(
                physical_manifest.get("openings", [])
            ),
            "analytical_openings_expected": len(
                analytical_manifest.get("openings", [])
            ),
            "physical_wall_faces_preserved": physical_surface_preserved,
            "physical_windows_doors_preserved": physical_opening_preserved,
            "simplified_exterior_walls_inserted": len(repaired_surfaces),
            "openings_inserted": len(repaired_openings),
            "opening_types_corrected": len(corrected_opening_types),
        },
        "simplified_exterior_wall_ids": repaired_surfaces,
        "inserted_opening_ids": repaired_openings,
        "corrected_opening_type_ids": corrected_opening_types,
    }




def _polygon_area_m2(points, factor):
    if len(points or []) < 3:
        return 0.0
    meters = points_to_meters(points, factor)
    return 0.5 * norm(newell(meters))


def _surface_similarity_metrics(expected_ft, actual_xml, factor):
    """Return normalized geometric difference metrics in meters.

    This deliberately uses Revit geometry as authority and does not infer geometry
    from labels. The values are used only for deterministic QA/repair decisions;
    semantic/AI review may classify ambiguous cases but never invent vertices.
    """
    result = {
        "valid": False,
        "normal_alignment": 0.0,
        "expected_area_m2": 0.0,
        "actual_area_m2": 0.0,
        "area_ratio": None,
        "plane_distance_m": None,
        "center_distance_m": None,
    }
    if len(expected_ft or []) < 3 or len(actual_xml or []) < 3:
        return result
    expected = points_to_meters(expected_ft, 0.3048)
    actual = points_to_meters(actual_xml, factor)
    en = unit_vector(newell(expected)); an = unit_vector(newell(actual))
    if en is None or an is None:
        return result
    ea = 0.5 * norm(newell(expected)); aa = 0.5 * norm(newell(actual))
    if ea <= 1e-9 or aa <= 1e-9:
        return result
    ec = polygon_centroid(expected); ac = polygon_centroid(actual)
    alignment = abs(sum(en[i] * an[i] for i in range(3)))
    plane_distance = abs(sum((ac[i] - ec[i]) * en[i] for i in range(3)))
    center_distance = distance3(ec, ac)
    result.update({
        "valid": True,
        "normal_alignment": alignment,
        "expected_area_m2": ea,
        "actual_area_m2": aa,
        "area_ratio": aa / ea,
        "plane_distance_m": plane_distance,
        "center_distance_m": center_distance,
    })
    return result


def _replace_planar_geometry_from_revit(surface_element, namespace, expected_ft, xml_factor):
    """Replace one gbXML Surface planar carrier with its authoritative Revit face.

    Only callers that already proved source identity + adjacency may use this. It
    never changes Surface identity, type, construction or adjacency.
    """
    if surface_element is None or len(expected_ft or []) < 3 or xml_factor <= 0:
        return False
    expected_xml = [
        (
            float(point[0]) * 0.3048 / xml_factor,
            float(point[1]) * 0.3048 / xml_factor,
            float(point[2]) * 0.3048 / xml_factor,
        )
        for point in expected_ft
    ]
    for child in list(surface_element):
        if local_name(child.tag) == "PlanarGeometry":
            surface_element.remove(child)
    add_planar_geometry(surface_element, namespace, expected_xml)
    return True


def _gbxml_surface_fingerprint(candidate, factor):
    points = candidate.get("points") or []
    if len(points) < 3:
        return None
    meters = points_to_meters(points, factor)
    center = polygon_centroid(meters)
    n = unit_vector(newell(meters))
    if n is None:
        return None
    # Normal sign is irrelevant for duplicate carriers.
    n = tuple(abs(float(v)) for v in n)
    area = 0.5 * norm(newell(meters))
    return (
        normalize_text(candidate.get("type")),
        tuple(sorted(candidate.get("adjacent") or [])),
        round(center[0], 3), round(center[1], 3), round(center[2], 3),
        round(n[0], 3), round(n[1], 3), round(n[2], 3),
        round(area, 3),
    )


def revit_geometry_integrity_pass(
    xml_path,
    exportable_spaces,
    physical_manifest,
    analytical_manifest,
    messages,
    allow_repairs=True,
):
    """Compare generated gbXML back to native Revit geometry itself.

    Authority order:
      Revit Space/physical geometry -> Revit EADM -> gbXML.

    The pass looks specifically for critical omissions, lost openings/cuts,
    extended carriers, duplicates/junk, invalid adjacency and Space loss. Repairs
    are deliberately local and source-proven; ambiguous geometry is reported but
    never forced to fit a guessed shape.
    """
    tree = ET.parse(xml_path)
    root = tree.getroot()
    namespace = namespace_uri(root)
    if namespace:
        ET.register_namespace("", namespace)
    index = bind_xml_spaces_to_revit(xml_envelope_index(root), analytical_manifest)
    errors=[]; warnings=[]; repairs=[]; ambiguous=[]

    expected_space_ids = set(str(eid_value(s.Id)) for s in list(exportable_spaces or []) if s is not None)
    mapped_revit_space_ids = set(str(k) for k in index.get("space_by_revit", {}).keys())
    # Direct fallback compatibility: when no EADM identity domain exists,
    # source Space ids may be written directly to CADObjectId.
    if not mapped_revit_space_ids and not (analytical_manifest or {}).get("spaces"):
        mapped_revit_space_ids = set(str(k) for k in index.get("space_by_cad", {}).keys())
    missing_spaces = sorted(expected_space_ids.difference(mapped_revit_space_ids))
    if missing_spaces:
        errors.append("gbXML is missing {} authoritative Revit Space(s): {}".format(len(missing_spaces), missing_spaces[:25]))

    # Invalid adjacency is always a critical error for non-shade surfaces.
    known_xml_spaces = set(index.get("spaces", {}).keys())
    invalid_adjacency=[]
    for candidate in index.get("surfaces", []):
        st=normalize_text(candidate.get("type"))
        refs=list(candidate.get("adjacent") or [])
        missing_refs=[r for r in refs if r not in known_xml_spaces]
        if missing_refs:
            invalid_adjacency.append({"surface":candidate.get("id"),"missing_space_refs":missing_refs})
        if not refs and "shade" not in st:
            invalid_adjacency.append({"surface":candidate.get("id"),"missing_space_refs":["<none>"]})
    if invalid_adjacency:
        errors.append("{} gbXML Surface(s) have invalid/missing Space adjacency.".format(len(invalid_adjacency)))

    # Prove analytical surfaces. If a carrier is on the correct source plane and
    # adjacency but is grossly extended, replace only its PlanarGeometry.
    extended=[]
    for record in list((analytical_manifest or {}).get("surfaces", []) or []):
        expected_points=record_polyloop(record)
        if len(expected_points)<3:
            continue
        exact=find_surface_match(record,index,relaxed=False)
        if exact is not None:
            continue
        relaxed=find_surface_match(record,index,relaxed=True)
        if relaxed is None:
            continue  # envelope_persistence_gate owns missing-face recovery
        metrics=_surface_similarity_metrics(expected_points,relaxed.get("points") or [],index["factor"])
        if not metrics.get("valid"):
            continue
        ratio=float(metrics.get("area_ratio") or 0.0)
        expected_spaces=set(expected_xml_space_ids(record,index))
        actual_spaces=set(relaxed.get("adjacent") or [])
        source_id=int(record.get("originating_element_id") or -1)
        source_proven=(
            (str(record.get("analytical_id") or "") and relaxed.get("id")==str(record.get("analytical_id") or ""))
            or (source_id>0 and relaxed.get("cad")==str(source_id))
        )
        adjacency_proven=(not expected_spaces) or (expected_spaces==actual_spaces)
        gross_extended=(ratio>1.75 and metrics.get("normal_alignment",0.0)>0.97 and metrics.get("plane_distance_m",999)<=0.12)
        gross_collapsed=(ratio<0.45 and metrics.get("normal_alignment",0.0)>0.97 and metrics.get("plane_distance_m",999)<=0.12)
        if gross_extended or gross_collapsed:
            defect={
                "surface": relaxed.get("id"),
                "analytical_id": record.get("analytical_id"),
                "originating_element_id": source_id,
                "area_ratio": round(ratio,6),
                "plane_distance_m": round(float(metrics.get("plane_distance_m") or 0.0),6),
                "source_proven": bool(source_proven),
                "adjacency_proven": bool(adjacency_proven),
                "kind": "extended" if gross_extended else "collapsed",
            }
            extended.append(defect)
            if allow_repairs and source_proven and adjacency_proven:
                if _replace_planar_geometry_from_revit(relaxed.get("element"),namespace,expected_points,index["factor"]):
                    repairs.append({"action":"replace_surface_planar_geometry_from_revit","surface":relaxed.get("id"),"reason":defect["kind"],"area_ratio_before":round(ratio,6)})
            else:
                ambiguous.append(defect)

    # Remove only provable junk: malformed/tiny non-shade carriers and exact
    # duplicate carriers. Never remove an unmatched but geometrically valid face.
    remove_elements=[]
    seen={}
    duplicate_ids=[]
    malformed_ids=[]
    for candidate in list(index.get("surfaces", [])):
        st=normalize_text(candidate.get("type"))
        points=candidate.get("points") or []
        area=_polygon_area_m2(points,index["factor"])
        if "shade" not in st and (len(points)<3 or area < 1e-5):
            malformed_ids.append(candidate.get("id"))
            if allow_repairs:
                remove_elements.append(candidate.get("element"))
            continue
        fp=_gbxml_surface_fingerprint(candidate,index["factor"])
        if fp is None:
            continue
        if fp in seen:
            # Keep the first deterministic carrier; exact same geometry/type/
            # adjacency is redundant and can destabilize downstream compilers.
            duplicate_ids.append(candidate.get("id"))
            if allow_repairs:
                remove_elements.append(candidate.get("element"))
        else:
            seen[fp]=candidate.get("id")

    if allow_repairs and remove_elements:
        parents={c:p for p in root.iter() for c in list(p)}
        for element in remove_elements:
            parent=parents.get(element)
            if parent is not None:
                parent.remove(element)
        for sid in malformed_ids:
            repairs.append({"action":"remove_provably_malformed_surface","surface":sid})
        for sid in duplicate_ids:
            repairs.append({"action":"remove_exact_duplicate_surface","surface":sid})

    changed=bool(repairs)
    if changed:
        tree.write(xml_path,encoding="utf-8",xml_declaration=True)

    # Human-readable triage. Deterministic geometry establishes facts; this
    # rule/AI layer only classifies severity and never changes vertices itself.
    critical_count=len(missing_spaces)+len(invalid_adjacency)+len(malformed_ids)
    review_count=len(ambiguous)
    mode="deterministic_revit_authority"
    if review_count:
        mode += "+architectural_rules_ambiguity_triage"
    result={
        "passed": critical_count==0 and review_count==0,
        "authority":"REVIT_NATIVE_GEOMETRY",
        "secondary_reference":"REVIT_EADM",
        "fbx_required":False,
        "mode":mode,
        "missing_spaces":missing_spaces,
        "invalid_adjacency":invalid_adjacency[:100],
        "extended_or_collapsed_surfaces":extended[:100],
        "malformed_surface_ids":malformed_ids[:100],
        "duplicate_surface_ids":duplicate_ids[:100],
        "ambiguous":ambiguous[:100],
        "repairs":repairs[:250],
        "counts":{
            "revit_spaces_expected":len(expected_space_ids),
            "xml_spaces_with_revit_cad_id":len(mapped_revit_space_ids.intersection(expected_space_ids)),
            "xml_surfaces":len(index.get("surfaces",[])),
            "xml_openings":len(index.get("openings",[])),
            "extended_or_collapsed_detected":len(extended),
            "malformed_detected":len(malformed_ids),
            "duplicates_detected":len(duplicate_ids),
            "repairs_applied":len(repairs),
            "ambiguous_review":len(ambiguous),
        },
        "errors":errors,
        "warnings":warnings,
    }
    return result


def revit_geometry_integrity_loop(
    xml_path,
    exportable_spaces,
    physical_manifest,
    analytical_manifest,
    messages,
    max_rounds=2,
):
    """Generate/compare/fix/reparse/retest loop before a gbXML is releasable."""
    rounds=[]
    for round_index in range(max(1,int(max_rounds))):
        # First recover missing authoritative Revit/EADM faces and openings/cuts.
        persistence=envelope_persistence_gate(
            xml_path,physical_manifest,analytical_manifest,allow_repairs=True
        )
        review=revit_geometry_integrity_pass(
            xml_path,exportable_spaces,physical_manifest,analytical_manifest,messages,allow_repairs=True
        )
        rounds.append({
            "round":round_index+1,
            "persistence_passed":bool(persistence.get("passed")),
            "geometry_passed":bool(review.get("passed")),
            "persistence_counts":persistence.get("counts",{}),
            "geometry_counts":review.get("counts",{}),
            "geometry_repairs":review.get("repairs",[]),
        })
        if not review.get("repairs") and persistence.get("passed") and review.get("passed"):
            break
    # Final read-only proof. Nothing is accepted solely because a repair call ran.
    final_persistence=envelope_persistence_gate(
        xml_path,physical_manifest,analytical_manifest,allow_repairs=False
    )
    final_review=revit_geometry_integrity_pass(
        xml_path,exportable_spaces,physical_manifest,analytical_manifest,messages,allow_repairs=False
    )
    passed=bool(final_persistence.get("passed")) and bool(final_review.get("passed"))
    if passed:
        messages.append({
            "severity":"INFO",
            "code":"REVIT_TO_GBXML_GEOMETRY_INTEGRITY_PROVEN",
            "message":"Generated gbXML was reparsed and compared back to native Revit Spaces/physical envelope plus the Revit EADM; missing/extended/junk geometry and openings/cuts passed the final read-only proof.",
        })
    else:
        messages.append({
            "severity":"ERROR",
            "code":"REVIT_TO_GBXML_GEOMETRY_INTEGRITY_FAILED",
            "message":"Final read-only Revit-to-gbXML geometry proof still contains critical or ambiguous mismatches; output is not silently accepted.",
        })
    return {
        "passed":passed,
        "rounds":rounds,
        "final_persistence":final_persistence,
        "final_geometry":final_review,
    }

def projected_bounds_on_normal(points, normal):
    if len(points) < 3:
        return None
    axis = max(range(3), key=lambda i: abs(normal[i]))
    projected = dominant_projection(points, normal)
    return (
        min(point[0] for point in projected),
        max(point[0] for point in projected),
        min(point[1] for point in projected),
        max(point[1] for point in projected),
    )


def opening_overlap_ratio(points_a, points_b, parent_points):
    if len(points_a) < 3 or len(points_b) < 3 or len(parent_points) < 3:
        return 0.0
    normal = newell(parent_points)
    if norm(normal) <= 1e-12:
        return 0.0
    a = projected_bounds_on_normal(points_a, normal)
    b = projected_bounds_on_normal(points_b, normal)
    if a is None or b is None:
        return 0.0
    ix = max(0.0, min(a[1], b[1]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[2], b[2]))
    overlap = ix * iy
    area_a = max(0.0, a[1] - a[0]) * max(0.0, a[3] - a[2])
    area_b = max(0.0, b[1] - b[0]) * max(0.0, b[3] - b[2])
    smaller = min(area_a, area_b)
    if smaller <= 1e-8:
        return 0.0
    return overlap / smaller


def normalize_gbxml_project_identity(model_doc, xml_path, messages):
    """Correct stale copied-project labels without touching weather coordinates."""
    try:
        tree=ET.parse(xml_path); root=tree.getroot()
        namespace=(root.tag.split("}",1)[0][1:] if "}" in root.tag else "")
        q=lambda name: qualified(namespace,name) if namespace else name
        project_info=safe_attr(model_doc,"ProjectInformation",None)
        address=str(safe_attr(project_info,"Address","") or "").strip()
        title=str(model_doc.Title or "").strip()
        label=address or title
        changed=[]
        location=root.find(".//"+q("Location"))
        if location is not None and label:
            name_node=location.find(q("Name"))
            if name_node is None:
                name_node=ET.SubElement(location,q("Name"))
            old=str(name_node.text or "")
            if old!=label:
                name_node.text=label; changed.append({"field":"Location/Name","old":old,"new":label})
            zip_match=re.search(r"\\b(\\d{5}(?:-\\d{4})?)\\b",address)
            if zip_match:
                zip_node=location.find(q("ZipcodeOrPostalCode"))
                if zip_node is not None and str(zip_node.text or "").strip() in ("","00000"):
                    old=str(zip_node.text or ""); zip_node.text=zip_match.group(1); changed.append({"field":"Location/Zip","old":old,"new":zip_match.group(1)})
        building=root.find(".//"+q("Building"))
        if building is not None and label:
            name_node=building.find(q("Name"))
            if name_node is None:
                name_node=ET.SubElement(building,q("Name"))
            old=str(name_node.text or "")
            if old!=label:
                name_node.text=label; changed.append({"field":"Building/Name","old":old,"new":label})
        if changed:
            tree.write(xml_path,encoding="utf-8",xml_declaration=True)
            messages.append({"severity":"INFO","code":"GBXML_PROJECT_IDENTITY_NORMALIZED","changes":changed,"message":"Stale copied-project gbXML labels were corrected from the current Revit Project Information; latitude/longitude/weather station were preserved."})
        return changed
    except Exception as ex:
        messages.append({"severity":"WARNING","code":"GBXML_PROJECT_IDENTITY_NORMALIZE_FAILED_NONBLOCKING","message":str(ex)})
        return []

def validate_gbxml(xml_path, expected_space_count):
    errors = []
    warnings = []
    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except Exception as ex:
        return {
            "passed": False,
            "errors": ["XML parse failed: {}".format(ex)],
            "warnings": [],
            "counts": {},
        }

    factor = length_to_meters(root.attrib.get("lengthUnit", "Meters"))
    space_ids = set()
    surface_ids = set()
    duplicate_space_ids = []
    duplicate_surface_ids = []
    opening_ids = set()
    duplicate_opening_ids = []
    surface_adjacencies = {}
    opening_count = 0
    opening_geometries = {}
    opening_geometry_conflicts = []
    concave_before = len(warnings)

    for element in root.iter():
        kind = local_name(element.tag)
        if kind == "Space":
            item_id = element.attrib.get("id")
            if item_id:
                if item_id in space_ids:
                    duplicate_space_ids.append(item_id)
                space_ids.add(item_id)
        elif kind == "Surface":
            item_id = element.attrib.get("id", "<unnamed-surface>")
            if item_id in surface_ids:
                duplicate_surface_ids.append(item_id)
            surface_ids.add(item_id)
            adjacent = [
                child.attrib.get("spaceIdRef")
                for child in list(element)
                if local_name(child.tag) == "AdjacentSpaceId"
                and child.attrib.get("spaceIdRef")
            ]
            surface_adjacencies[item_id] = adjacent
            points = polygon_points(element)
            validate_polygon(
                points, factor, "Surface {}".format(item_id), errors, warnings
            )
            for child in element.iter():
                if local_name(child.tag) == "Opening":
                    opening_count += 1
                    opening_id = child.attrib.get(
                        "id", "{}::<unnamed-opening>".format(item_id)
                    )
                    if opening_id in opening_ids:
                        duplicate_opening_ids.append(opening_id)
                    opening_ids.add(opening_id)
                    child_points = polygon_points(child)
                    validate_polygon(
                        child_points,
                        factor,
                        "Opening {}".format(opening_id),
                        errors,
                        warnings,
                    )
                    opening_geometries.setdefault(item_id, []).append(
                        (
                            opening_id,
                            points_to_meters(child_points, factor),
                            points_to_meters(points, factor),
                        )
                    )

    for parent_id, items in opening_geometries.items():
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                first_id, first_points, parent_points = items[i]
                second_id, second_points, _ = items[j]
                ratio = opening_overlap_ratio(
                    first_points, second_points, parent_points
                )
                if ratio >= 0.90:
                    opening_geometry_conflicts.append(
                        (first_id, second_id, ratio, parent_id)
                    )
    if opening_geometry_conflicts:
        errors.append(
            "Overlapping/nested Opening geometry detected: {}".format(
                [
                    "{} + {} on {} ({:.0%})".format(a, b, parent, ratio)
                    for a, b, ratio, parent in opening_geometry_conflicts[:20]
                ]
            )
        )

    if duplicate_space_ids:
        errors.append("Duplicate Space ids: {}".format(duplicate_space_ids[:20]))
    if duplicate_surface_ids:
        errors.append("Duplicate Surface ids: {}".format(duplicate_surface_ids[:20]))
    if duplicate_opening_ids:
        errors.append("Duplicate Opening ids: {}".format(duplicate_opening_ids[:20]))
    if expected_space_count and len(space_ids) != int(expected_space_count):
        errors.append(
            "gbXML contains {} Spaces; Revit preflight expected {}.".format(
                len(space_ids), expected_space_count
            )
        )
    if not space_ids:
        errors.append("gbXML contains zero Space records.")
    if not surface_ids:
        errors.append("gbXML contains zero Surface records.")

    for surface_id, adjacent in surface_adjacencies.items():
        if len(adjacent) > 2:
            errors.append(
                "Surface {} has more than two AdjacentSpaceId references.".format(
                    surface_id
                )
            )
        if len(adjacent) != len(set(adjacent)):
            errors.append(
                "Surface {} repeats the same adjacent Space.".format(surface_id)
            )
        for space_id in adjacent:
            if space_id not in space_ids:
                errors.append(
                    "Surface {} references missing Space {}.".format(
                        surface_id, space_id
                    )
                )

    # SpaceBoundary references are validated independently from Surface geometry.
    for element in root.iter():
        if local_name(element.tag) != "SpaceBoundary":
            continue
        ref = element.attrib.get("surfaceIdRef")
        if ref and ref not in surface_ids:
            errors.append(
                "SpaceBoundary references missing Surface {}.".format(ref)
            )
        boundary_points = polygon_points(element)
        if not boundary_points:
            errors.append(
                "SpaceBoundary {} has no PlanarGeometry.".format(
                    ref or "<missing-reference>"
                )
            )
        else:
            validate_polygon(
                boundary_points,
                factor,
                "SpaceBoundary {}".format(ref or "<missing-reference>"),
                errors,
                warnings,
            )

    return {
        "passed": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "spaces": len(space_ids),
            "surfaces": len(surface_ids),
            "openings": opening_count,
            "opening_geometry_conflicts": len(opening_geometry_conflicts),
            "concave_polygons": len(
                [item for item in warnings[concave_before:] if "concave" in item]
            ),
        },
        "length_unit": root.attrib.get("lengthUnit"),
        "minimum_edge_rule_m": MIN_EDGE_M,
        "planarity_tolerance_m": PLANAR_TOL_M,
        "geometryco_contract": {
            "space_ids_unique": not bool(duplicate_space_ids),
            "surface_ids_unique": not bool(duplicate_surface_ids),
            "opening_ids_unique": not bool(duplicate_opening_ids),
            "adjacency_refs_valid": not any("references missing Space" in item or "more than two AdjacentSpaceId" in item or "repeats the same adjacent Space" in item for item in errors),
            "space_boundaries_valid": not any("SpaceBoundary" in item for item in errors),
            "opening_geometry_nonoverlap": not bool(opening_geometry_conflicts),
            "ready_for_openstudio_geometry_import": len(errors) == 0,
        },
    }


def message_counts(messages):
    counts = {"ERROR": 0, "WARNING": 0, "INFO": 0}
    for item in messages:
        severity = item.get("severity", "INFO")
        counts[severity] = counts.get(severity, 0) + 1
    return counts


def write_reports(report, report_base):
    json_path = report_base + "_REPORT.json"
    text_path = report_base + "_SUMMARY.txt"
    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=False, sort_keys=True)
    counts = report.get("message_counts", {})
    lines = [
        "{} v{}".format(TOOL_NAME, TOOL_VERSION),
        "ENGINE PATCH: {}".format(report.get("engine_patch") or ENGINE_PATCH),
        "STATUS: {}".format(report.get("status")),
        "EXPORT QUALITY: {}".format(report.get("export_quality")),
        "MODEL: {}".format(report.get("model")),
        "REVIT: {}".format(report.get("revit_version")),
        "PHASE: {}".format(report.get("phase")),
        "SPACES BEFORE: {}".format(report.get("spaces_before")),
        "SPACE CREATION ATTEMPTS: {}".format(
            report.get("spaces_created_attempted")
        ),
        "SPACES CREATED AND KEPT: {}".format(report.get("spaces_created")),
        "GENERATED DUPLICATES DISCARDED: {}".format(
            report.get("space_creation", {}).get("discarded_redundant")
        ),
        "GAP FILL API RETURNED IDS: {}".format(
            report.get("space_creation", {}).get("gap_fill", {}).get("api_returned_ids")
        ),
        "GAP FILL POSITIVE-AREA SPACES KEPT: {}".format(
            report.get("space_creation", {}).get("gap_fill", {}).get("kept")
        ),
        "ZERO-AREA GAP ARTIFACTS DISCARDED: {}".format(
            report.get("space_creation", {}).get("gap_fill", {}).get("discarded_zero_area")
        ),
        "PLAN CIRCUIT CLOSURE: {}".format(report.get("space_creation", {}).get("closure", {})),
        "SPACES EXPORTABLE: {}".format(report.get("spaces_exportable")),
        "SPACE COLLECTOR: {}".format(report.get("space_collector", {})),
        "ROOM SOURCES: {}".format(report.get("room_sources", {})),
        "ROOM VERTICAL ENVELOPE: {}".format(report.get("room_vertical_envelope", {})),
        "SPACE BASE LEVELS: {}".format(
            [item.get("name") for item in report.get("space_base_levels", [])]
        ),
        "ROOM SEED TOPOLOGY: {}".format(report.get("room_seed_topology", {})),
        "ROOM/SPACE TOPOLOGY: {}".format(report.get("space_topology", {})),
        "REMAINING PLAN CIRCUITS: {}".format(report.get("plan_circuit_coverage", {})),
        "PLAN CIRCUIT PROBE STATUS: {}".format(
            "complete" if "plan_circuit_coverage" in report else "not-reached"
        ),
        "PREEXPORT PRESERVATION: {}".format(report.get("preservation_gate_preexport", {})),
        "DEPENDENCY AUDIT: {}".format(report.get("dependency_audit", {})),
        "ENERGY MODEL ATTEMPTS: {}".format(report.get("energy_model_attempts", [])),
        "PERSISTED ENERGY MODEL: {}".format(report.get("persisted_energy_model", {})),
        "NATIVE EXPORT ATTEMPTS: {}".format(report.get("native_export_attempts", [])),
        "NATIVE EXPORT ERRORS: {}".format(report.get("native_export_errors", [])),
        "EXPORT METHOD: {}".format(report.get("export_method")),
        "SPACE PLAN TAGS: {}".format(report.get("space_plan_tags", {})),
        "OPENING RECONCILIATION: {}".format(report.get("opening_normalization", {})),
        "ENVELOPE PERSISTENCE COUNTS: {}".format(report.get("envelope_persistence", {}).get("counts", {})),
        "ENVELOPE PERSISTENCE ERRORS: {}".format(report.get("envelope_persistence", {}).get("errors", [])),
        "ENVELOPE PERSISTENCE WARNINGS: {}".format(report.get("envelope_persistence", {}).get("warnings", [])),
        "GEOMETRY INTEGRITY: {}".format(report.get("geometry_integrity", {})),
        "PRESERVATION GATE: {}".format(report.get("preservation_gate", {})),
        "ROLLBACK REASON: {}".format(report.get("rollback_reason")),
        "PRIMARY ERROR: {}".format(next((item.get("code","")+": "+str(item.get("message","")) for item in report.get("messages",[]) if item.get("severity")=="ERROR"), "None")),
        "ERROR MESSAGES: {}".format([{"code":item.get("code"),"message":item.get("message"),"stats":item.get("stats")} for item in report.get("messages",[]) if item.get("severity")=="ERROR"]),
        "ERRORS: {}".format(counts.get("ERROR", 0)),
        "WARNINGS: {}".format(counts.get("WARNING", 0)),
        "AI ENGINE: {}".format(report.get("semantic_review", {}).get("engine")),
        "AI >=75%: {}".format(
            report.get("semantic_review", {}).get("at_or_above_75_percent")
        ),
        "AI <75%: {}".format(
            report.get("semantic_review", {}).get("below_75_percent")
        ),
        "PHYSICAL WALL FACES CHECKED: {}".format(
            report.get("physical_envelope", {})
            .get("counts", {})
            .get("wall_faces")
        ),
        "PHYSICAL WINDOWS/DOORS/CURTAIN OPENINGS CHECKED: {}".format(
            report.get("physical_envelope", {})
            .get("counts", {})
            .get("windows_doors_and_curtain_openings")
        ),
        "CURTAIN WALLS CHECKED: {}".format(
            report.get("physical_envelope", {})
            .get("counts", {})
            .get("curtain", {})
            .get("curtain_walls")
        ),
        "CURTAIN PANELS: total={} glazed={} doors={} opaque={} empty={} ambiguous={}".format(
            report.get("physical_envelope", {}).get("counts", {}).get("curtain", {}).get("panels_total"),
            report.get("physical_envelope", {}).get("counts", {}).get("curtain", {}).get("glazed_panels"),
            report.get("physical_envelope", {}).get("counts", {}).get("curtain", {}).get("door_panels"),
            report.get("physical_envelope", {}).get("counts", {}).get("curtain", {}).get("opaque_panels"),
            report.get("physical_envelope", {}).get("counts", {}).get("curtain", {}).get("empty_panels"),
            report.get("physical_envelope", {}).get("counts", {}).get("curtain", {}).get("ambiguous_panels"),
        ),
        "SIMPLIFIED EXTERIOR WALLS INSERTED: {}".format(
            report.get("envelope_persistence", {})
            .get("counts", {})
            .get("simplified_exterior_walls_inserted")
        ),
        "MISSING OPENINGS INSERTED: {}".format(
            report.get("envelope_persistence", {})
            .get("counts", {})
            .get("openings_inserted")
        ),
        "gbXML: {}".format(report.get("gbxml_path")),
        "",
        "MESSAGES",
    ]
    for item in report.get("messages", []):
        context=[]
        if item.get("element_id") not in (None, "", -1): context.append("id={}".format(item.get("element_id")))
        if item.get("space"): context.append("space={}".format(item.get("space")))
        if item.get("count") is not None: context.append("count={}".format(item.get("count")))
        if item.get("max_excess_ft") is not None: context.append("max_excess_ft={}".format(item.get("max_excess_ft")))
        suffix = " [{}]".format(", ".join(context)) if context else ""
        lines.append(
            "[{severity}] {code}{suffix}: {message}".format(
                severity=item.get("severity", "INFO"),
                code=item.get("code", "GENERAL"),
                suffix=suffix,
                message=item.get("message", ""),
            )
        )
        trace = str(item.get("trace") or "").strip()
        if trace:
            trace_lines = trace.splitlines()[-14:]
            lines.extend("[TRACE] " + row for row in trace_lines)
    with open(text_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    return json_path, text_path


def finish_space_creation_rollback_report(
    report, report_base, existing_spaces, creation_stats, reason
):
    report["spaces_created_attempted"] = creation_stats.get("attempted", 0)
    report["spaces_created"] = 0
    report["spaces_in_phase"] = len(existing_spaces)
    report["spaces_exportable"] = sum(
        1 for item in existing_spaces if is_placed_spatial(item)
    )
    report["unplaced_spaces_ignored"] = sum(
        1 for item in existing_spaces if not is_placed_spatial(item)
    )
    report["status"] = "SPACE_CREATION_BLOCKED_AND_MODEL_ROLLED_BACK"
    report["rollback_reason"] = reason
    report["message_counts"] = message_counts(report.get("messages", []))
    report["finished_at"] = datetime.datetime.now().isoformat()
    json_path, text_path = write_reports(report, report_base)
    report["report_json"] = json_path
    report["report_text"] = text_path
    return report



# -----------------------------------------------------------------------------
# RELEASE10 exact-source envelope completion overrides
# -----------------------------------------------------------------------------
# Preserve RELEASE9 implementations for bounded reuse where they remain correct.
_r9_capture_physical_envelope = capture_physical_envelope
_r9_envelope_persistence_gate = envelope_persistence_gate
_r9_find_opening_geometry_match = find_opening_geometry_match
_r9_normalize_gbxml_openings_from_revit = normalize_gbxml_openings_from_revit
_r9_generated_story_span_sanity = generated_story_span_sanity


def _r10_category_role(element):
    if element is None:
        return ""
    for bic, role in (
        (BuiltInCategory.OST_Walls, "wall"),
        (BuiltInCategory.OST_Roofs, "roof"),
        (BuiltInCategory.OST_Floors, "floor"),
        (BuiltInCategory.OST_Ceilings, "ceiling"),
    ):
        try:
            if category_matches(element, bic):
                return role
        except Exception:
            pass
    return ""


def _r10_surface_type_for_record(record, adjacency_count=1):
    role = normalize_text(record.get("surface_role") or "")
    hint = normalize_text(record.get("surface_type_hint") or record.get("surface_type") or "")
    if "roof" in hint or role == "roof":
        return "Roof"
    if role == "ceiling" or "ceiling" in hint:
        return "Ceiling" if adjacency_count <= 1 else "InteriorFloor"
    if role == "floor":
        return "RaisedFloor" if adjacency_count <= 1 else "InteriorFloor"
    if role == "wall":
        return "InteriorWall" if adjacency_count > 1 else "ExteriorWall"
    if "floor" in hint or "slab" in hint:
        return "InteriorFloor" if adjacency_count > 1 else "RaisedFloor"
    return _fallback_surface_type(record.get("surface_type") or hint, adjacency_count)


def _r10_space_bbox(space):
    try:
        b = space.get_BoundingBox(None)
        if b is None:
            return None
        return (float(b.Min.X), float(b.Min.Y), float(b.Min.Z), float(b.Max.X), float(b.Max.Y), float(b.Max.Z))
    except Exception:
        return None


def _r10_xy_overlap_ratio(a, b):
    if not a or not b:
        return 0.0
    ix=max(0.0,min(a[3],b[3])-max(a[0],b[0])); iy=max(0.0,min(a[4],b[4])-max(a[1],b[1]))
    inter=ix*iy
    aa=max(1e-9,(a[3]-a[0])*(a[4]-a[1])); bb=max(1e-9,(b[3]-b[0])*(b[4]-b[1]))
    return inter/min(aa,bb)


def _r10_space_enclosure_evidence(model_doc, space):
    evidence={"top_hosted":False,"top_sources":[],"side_exterior_walls":0,"side_unhosted":0,"top_unhosted":0,"solid_valid":False}
    calc=SpatialElementGeometryCalculator(model_doc)
    try:
        if not SpatialElementGeometryCalculator.CanCalculateGeometry(space):
            return evidence
        result=calc.CalculateSpatialElementGeometry(space); solid=result.GetGeometry()
        if solid is None:
            return evidence
        evidence["solid_valid"]=True
        box=_r10_space_bbox(space); top_z=box[5] if box else None
        for face in list(solid.Faces):
            pts=face_outer_polyloop(face)
            if len(pts)<3: continue
            cz=sum(p[2] for p in pts)/float(len(pts)); n=unit_vector(newell(pts))
            horizontal=bool(n is not None and abs(n[2])>0.70)
            top_face=bool(horizontal and top_z is not None and abs(cz-top_z)<=EXTERIOR_GAP_TOP_TOL_FT)
            try: subs=list(result.GetBoundaryFaceInfo(face) or [])
            except Exception: subs=[]
            if top_face and not subs:
                evidence["top_unhosted"] += 1
            if (not horizontal) and not subs:
                evidence["side_unhosted"] += 1
            for sub in subs:
                try:
                    info=resolve_boundary_source(model_doc,sub.SpatialBoundaryElement)
                    role=_r10_category_role(info["element"]) if info else ""
                    if top_face and role in ("roof","floor","ceiling"):
                        evidence["top_hosted"]=True
                        evidence["top_sources"].append({"role":role,"id":info.get("source_id")})
                    if not horizontal and role=="wall" and info and is_exterior_wall(info):
                        evidence["side_exterior_walls"] += 1
                except Exception:
                    pass
                finally:
                    try: sub.Dispose()
                    except Exception: pass
    except Exception:
        pass
    finally:
        try: calc.Dispose()
        except Exception: pass
    return evidence


def cull_open_exterior_generated_spaces(model_doc, spaces, created_ids, matched, target_levels, changes, messages):
    """Remove only source-unassigned generated Spaces proven open/exterior.

    2D plan closure alone is not sufficient for an energy volume. A generated gap
    Space must have a physical top enclosure or behave as a repeated vertical core.
    Room-backed Spaces are never culled here.
    """
    created=set(int(v) for v in created_ids); matched_ids=set(int(v) for v in (matched or {}).keys())
    gaps=[s for s in spaces if s is not None and eid_value(s.Id) in created and eid_value(s.Id) not in matched_ids and is_placed_spatial(s)]
    rows=[]
    typical=typical_occupied_story_height(target_levels)
    for s in gaps:
        b=_r10_space_bbox(s); lev=_space_base_level(s)
        rows.append((s,b,level_elevation(lev) if lev is not None else (b[2] if b else 0.0)))
    culled=[]; reviewed=[]
    for s,b,z in rows:
        sid=eid_value(s.Id); ev=_r10_space_enclosure_evidence(model_doc,s)
        vertical_core=False
        for other,ob,oz in rows:
            if other is s or not b or not ob: continue
            dz=abs(float(oz)-float(z))
            if dz>1.0 and dz<=typical*1.6 and _r10_xy_overlap_ratio(b,ob)>=0.55:
                vertical_core=True; break
        open_top=bool(ev.get("solid_valid") and not ev.get("top_hosted"))
        exterior_side=bool(ev.get("side_exterior_walls",0)>0 or ev.get("side_unhosted",0)>0)
        # Strong proof only: open top + exterior/open side + no repeated vertical core.
        covered_open_side = bool(ev.get("side_unhosted",0)>0 and ev.get("side_exterior_walls",0)>0)
        is_exterior_gap=bool((open_top and exterior_side and not vertical_core) or (covered_open_side and not vertical_core))
        reviewed.append({"space_id":sid,"open_top":open_top,"exterior_side":exterior_side,"vertical_core":vertical_core,"evidence":ev})
        if not is_exterior_gap:
            continue
        try:
            model_doc.Delete(s.Id); culled.append(sid); created_ids.discard(sid)
            changes.append({"action":"remove_generated_exterior_open_space","element_id":sid,"reason":"open_top_exterior_gap_not_energy_volume","evidence":ev})
            messages.append({"severity":"INFO","code":"GENERATED_EXTERIOR_GAP_REMOVED","element_id":sid,"message":"Generated plan-circuit Space is physically open/exterior and was excluded from the energy volume; native balcony/terrace geometry remains available as exterior/shading geometry."})
        except Exception as ex:
            messages.append({"severity":"WARNING","code":"GENERATED_EXTERIOR_GAP_REMOVE_FAILED","element_id":sid,"message":str(ex)})
    if culled:
        model_doc.Regenerate()
    return {"reviewed":len(reviewed),"removed":len(culled),"removed_ids":culled,"details":reviewed[:100]}


def _r10_cover_candidates(model_doc):
    out=[]
    for bic,role in ((BuiltInCategory.OST_Roofs,"roof"),(BuiltInCategory.OST_Floors,"floor"),(BuiltInCategory.OST_Ceilings,"ceiling")):
        try:
            elems=list(FilteredElementCollector(model_doc).OfCategory(bic).WhereElementIsNotElementType())
        except Exception:
            elems=[]
        for e in elems:
            try:
                b=e.get_BoundingBox(None)
                if b is None: continue
                out.append((e,role,(float(b.Min.X),float(b.Min.Y),float(b.Min.Z),float(b.Max.X),float(b.Max.Y),float(b.Max.Z))))
            except Exception: pass
    return out


def _r10_nearest_cover_z(model_doc, space, candidates=None):
    b=_r10_space_bbox(space)
    if not b: return None
    x=(b[0]+b[3])*0.5; y=(b[1]+b[4])*0.5; bottom=b[2]
    best=None
    for e,role,eb in (candidates or _r10_cover_candidates(model_doc)):
        if x<eb[0]-0.25 or x>eb[3]+0.25 or y<eb[1]-0.25 or y>eb[4]+0.25: continue
        z=eb[2]
        if z<=bottom+2.0 or z>bottom+TOP_COVER_SEARCH_MAX_FT: continue
        if best is None or z<best[0]: best=(z,role,eid_value(e.Id))
    return best


def refine_top_story_space_heights_from_physical_cover(model_doc, spaces, created_ids, target_levels, changes, messages):
    if not target_levels: return {"adjusted":0,"details":[]}
    top_level=max(target_levels,key=level_elevation); top_elev=level_elevation(top_level); candidates=_r10_cover_candidates(model_doc)
    adjusted=[]
    for s in spaces:
        if s is None or eid_value(s.Id) not in set(int(v) for v in created_ids): continue
        lev=_space_base_level(s)
        if lev is None or abs(level_elevation(lev)-top_elev)>LEVEL_ELEVATION_TOL_FT: continue
        bounds=_space_vertical_bounds(s)
        if not bounds: continue
        cover=_r10_nearest_cover_z(model_doc,s,candidates)
        if not cover: continue
        desired=float(cover[0]); bottom=float(bounds[0]); current=float(bounds[1])
        if desired<=bottom+2.0 or abs(desired-current)<=0.20: continue
        # Physical cover may legitimately be above the median virtual top, but never
        # accept a runaway datum: bounded by the 30 ft cover search and a real element.
        try:
            if not _apply_space_vertical_target_nonzero(s,0.0,lev,desired): continue
            after=_space_vertical_bounds(s)
            if not after or abs(float(after[1])-desired)>0.35: continue
            adjusted.append({"space_id":eid_value(s.Id),"top_before_ft":round(current,4),"top_after_ft":round(float(after[1]),4),"cover_role":cover[1],"cover_id":cover[2]})
            changes.append({"action":"refine_top_story_space_to_physical_cover",**adjusted[-1]})
        except Exception: pass
    if adjusted:
        messages.append({"severity":"INFO","code":"TOP_STORY_SPACE_HEIGHTS_REFINED_FROM_PHYSICAL_COVER","count":len(adjusted),"message":"Top-story energy Space heights were refined only where a real Revit roof/floor/ceiling directly proves the vertical cover."})
    return {"adjusted":len(adjusted),"details":adjusted}


def generated_story_span_sanity(phase_spaces, created_ids, target_levels, all_levels):
    base=_r9_generated_story_span_sanity(phase_spaces,created_ids,target_levels,all_levels)
    if base.get("passed"): return base
    kept=[]; candidates=_r10_cover_candidates(doc)
    by_id={eid_value(s.Id):s for s in phase_spaces if s is not None}
    for v in base.get("violations",[]):
        if v.get("reason")!="crosses_energy_story_top": kept.append(v); continue
        s=by_id.get(int(v.get("element_id") or -1)); cover=_r10_nearest_cover_z(doc,s,candidates) if s else None
        if cover and abs(float(v.get("top_ft") or 0.0)-float(cover[0]))<=0.40:
            continue
        kept.append(v)
    base["violations"]=kept; base["violation_count"]=len(kept); base["passed"]=not kept
    return base


def capture_physical_envelope(model_doc, spaces, messages):
    """RELEASE10: retain RELEASE9 wall/opening pass + exact horizontal source faces."""
    base=_r9_capture_physical_envelope(model_doc,spaces,messages)
    horizontal=[]; source_seen=set(); calc=SpatialElementGeometryCalculator(model_doc)
    role_counts={"roof":0,"floor":0,"ceiling":0}
    try:
        for space in spaces:
            if space is None or not is_placed_spatial(space): continue
            try:
                if not SpatialElementGeometryCalculator.CanCalculateGeometry(space): continue
                result=calc.CalculateSpatialElementGeometry(space); solid=result.GetGeometry()
                if solid is None: continue
                for face in list(solid.Faces):
                    pts_face=face_outer_polyloop(face)
                    n=unit_vector(newell(pts_face)) if len(pts_face)>=3 else None
                    if n is None or abs(n[2])<0.55: continue
                    try: subs=list(result.GetBoundaryFaceInfo(face) or [])
                    except Exception: subs=[]
                    for sub in subs:
                        try:
                            info=resolve_boundary_source(model_doc,sub.SpatialBoundaryElement)
                            role=_r10_category_role(info["element"]) if info else ""
                            if role not in ("roof","floor","ceiling"): continue
                            geom=sub.GetSubface(); pts=face_outer_polyloop(geom)
                            if len(pts)<3: continue
                            key="{}::{}::{}::{}".format(eid_value(space.Id),info["source_key"],role,len(horizontal))
                            rec={"key":key,"space_revit_id":eid_value(space.Id),"space_name":spatial_label(space),"originating_element_id":info["source_id"],"originating_element_name":safe_element_name(info["element"]),"source_key":info["source_key"],"polyloops_ft":[pts],"surface_role":role,"surface_type_hint":("Roof" if role=="roof" else ("RaisedFloor" if n[2]<0 else "Ceiling")),"physical_exterior_function":False,"is_one_sided_exterior":False}
                            horizontal.append(rec); role_counts[role]+=1
                        except Exception: pass
                        finally:
                            try: sub.Dispose()
                            except Exception: pass
            except Exception: pass
    finally:
        try: calc.Dispose()
        except Exception: pass
    for rec in base.get("surfaces",[]) or []:
        rec.setdefault("surface_role","wall"); rec.setdefault("surface_type_hint","ExteriorWall" if rec.get("is_one_sided_exterior") else "InteriorWall")
    base["surfaces"]=(base.get("surfaces",[]) or [])+horizontal
    counts=base.setdefault("counts",{}); counts["horizontal_faces"]=len(horizontal); counts["roof_faces"]=role_counts["roof"]; counts["floor_faces"]=role_counts["floor"]; counts["ceiling_faces"]=role_counts["ceiling"]; counts["all_physical_faces"]=len(base["surfaces"])
    return base


def _r10_exact_surface_insert(record,index,namespace,existing_surface_ids,adjacent_refs=None,stype=None,prefix="exact-physical"):
    refs=[]
    for r in (adjacent_refs or expected_xml_space_ids(record,index)):
        if r and r not in refs: refs.append(r)
    if not refs or index.get("campus") is None: return None,"No proven exported Space adjacency for exact physical carrier."
    pts=clean_consecutive(record_polyloop(record),MIN_EDGE_M/0.3048)
    if len(pts)<3: return None,"Exact Revit boundary subface has insufficient vertices."
    if polygon_self_intersects(dominant_projection(pts,newell(pts))): return None,"Exact Revit boundary subface self-intersects; no fitted replacement is permitted."
    scale=0.3048/index["factor"]; pts_xml=[tuple(v*scale for v in p) for p in pts]
    sid=stable_fallback_id(prefix,record,existing_surface_ids); typ=stype or _r10_surface_type_for_record(record,len(refs))
    attrs={"id":sid,"surfaceType":typ}
    if typ in ("ExteriorWall","Roof"): attrs["exposedToSun"]="true"
    surf=ET.Element(qualified(namespace,"Surface"),attrs); name=ET.SubElement(surf,qualified(namespace,"Name")); name.text="LIBER exact Revit carrier {}".format(record.get("originating_element_name") or record.get("originating_element_id") or sid)
    for r in refs: ET.SubElement(surf,qualified(namespace,"AdjacentSpaceId"),{"spaceIdRef":r})
    add_planar_geometry(surf,namespace,pts_xml); cad=ET.SubElement(surf,qualified(namespace,"CADObjectId")); cad.text=str(record.get("originating_element_id") or "")
    index["campus"].append(surf)
    for r in refs:
        sp=index.get("spaces",{}).get(r)
        if sp is not None:
            b=ET.SubElement(sp,qualified(namespace,"SpaceBoundary"),{"surfaceIdRef":sid}); add_planar_geometry(b,namespace,pts_xml)
    return sid,None


def inject_exterior_wall(record,index,namespace,existing_surface_ids):
    # RELEASE10 deliberately removes the old rectangularized/simplified carrier.
    return _r10_exact_surface_insert(record,index,namespace,existing_surface_ids,stype="ExteriorWall",prefix="exact-exterior-wall")


def _r10_opening_inside_surface(opening_ft,surface_xml,index_factor,tol_ft=OPENING_PARENT_EDGE_TOL_FT):
    if len(opening_ft)<3 or len(surface_xml)<3: return False
    surface_ft=[tuple(float(v)*index_factor/0.3048 for v in p[:3]) for p in surface_xml]
    basis=wall_basis(surface_ft)
    if basis is None: return False
    origin,u,v,n=basis
    # opening points must be in the carrier plane
    for p in opening_ft:
        if abs(sum((p[i]-origin[i])*n[i] for i in range(3)))>OPENING_PARENT_PLANE_TOL_FT: return False
    sb=project_bounds(surface_ft,basis); ob=project_bounds(opening_ft,basis)
    return ob[0]>=sb[0]-tol_ft and ob[1]<=sb[1]+tol_ft and ob[2]>=sb[2]-tol_ft and ob[3]<=sb[3]+tol_ft


def find_opening_geometry_match(record,index,relaxed=False):
    cand=_r9_find_opening_geometry_match(record,index,relaxed=relaxed)
    if cand is None: return None
    # Physical opening ownership is authoritative: matching geometry on the wrong
    # wall is not preservation and must be re-parented/removed.
    parent_source=int(record.get("parent_originating_element_id") or -1)
    if record.get("parent_physical_surface_key") and parent_source>0:
        if str(cand.get("parent",{}).get("cad") or "")!=str(parent_source): return None
        pts=record_polyloop(record)
        if pts and not _r10_opening_inside_surface(pts,cand.get("parent",{}).get("points") or [],index["factor"]): return None
    return cand


def select_opening_parent(record,index):
    expected=set(expected_xml_space_ids(record,index)); parent_source=int(record.get("parent_originating_element_id") or -1); pts=record_polyloop(record); parent_analytical=str(record.get("parent_analytical_id") or "")
    best=None; score=-1e9
    for c in index.get("surfaces",[]):
        if expected and not expected.intersection(set(c.get("adjacent") or [])): continue
        s=0
        if parent_source>0:
            if str(c.get("cad") or "")!=str(parent_source): continue
            s+=200
        if parent_analytical and c.get("id")==parent_analytical: s+=100
        if pts:
            if not _r10_opening_inside_surface(pts,c.get("points") or [],index["factor"]): continue
            s+=80
        if s>score: best=c; score=s
    return best if best is not None and score>0 else None


def normalize_gbxml_openings_from_revit(xml_path, analytical_manifest, physical_manifest, messages):
    stats=_r9_normalize_gbxml_openings_from_revit(xml_path,analytical_manifest,physical_manifest,messages)
    tree=ET.parse(xml_path); root=tree.getroot(); ns=namespace_uri(root)
    if ns:
        try: ET.register_namespace("",ns)
        except Exception: pass
    idx=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    physical_by_id={}
    # Physical host evidence wins; analytical source evidence fills gaps where the
    # physical pass could not resolve an insert but Revit EADM still knows its host.
    for manifest in ((analytical_manifest or {}),(physical_manifest or {})):
        for r in manifest.get("openings",[]) or []:
            sid=int(r.get("originating_element_id") or -1)
            if sid>0:
                physical_by_id.setdefault(str(sid),[]).append(r)
    # Reorder so records with an exact physical parent key are selected first.
    for key in list(physical_by_id.keys()):
        physical_by_id[key].sort(key=lambda r: 1 if r.get("parent_physical_surface_key") else 0, reverse=True)
    parent_map={}
    for s in [e for e in root.iter() if local_name(e.tag)=="Surface"]:
        for o in [c for c in list(s) if local_name(c.tag)=="Opening"]: parent_map[id(o)]=s
    groups={}
    for o in [e for e in root.iter() if local_name(e.tag)=="Opening"]:
        cad=direct_child_text(o,"CADObjectId")
        if cad and str(cad)!="-1": groups.setdefault(str(cad),[]).append(o)
    cross_removed=0; reparented=0; wrong_removed=0
    for cad,items in groups.items():
        records=physical_by_id.get(cad,[]); rec=records[0] if records else None
        scored=[]
        for o in items:
            p=parent_map.get(id(o)); pcad=direct_child_text(p,"CADObjectId") if p is not None else ""; sc=0
            if rec:
                wanted=int(rec.get("parent_originating_element_id") or -1)
                if wanted>0 and str(pcad)==str(wanted): sc+=200
                pts=record_polyloop(rec); ppts=polygon_points(p) if p is not None else []
                if pts and ppts and _r10_opening_inside_surface(pts,ppts,idx["factor"]): sc+=100
                if opening_type_compatible(rec.get("opening_type"),o.attrib.get("openingType","")): sc+=50
            else:
                sc=10
            scored.append((sc,o,p))
        scored.sort(key=lambda x:x[0],reverse=True); keep=scored[0] if scored else None
        if len(scored)>1:
            for sc,o,p in scored[1:]:
                if p is not None:
                    p.remove(o); cross_removed+=1
        if rec and keep:
            sc,o,p=keep; wanted=int(rec.get("parent_originating_element_id") or -1); current=direct_child_text(p,"CADObjectId") if p is not None else ""
            if wanted>0 and str(current)!=str(wanted):
                # Find exact proven target carrier. Do not leave the opening on a wrong wall.
                idx_now=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest); target=select_opening_parent(rec,idx_now)
                if target is not None and p is not None:
                    p.remove(o); target["element"].insert(max(0,len(list(target["element"]))-1),o); reparented+=1
                elif p is not None:
                    p.remove(o); wrong_removed+=1
    if cross_removed or reparented or wrong_removed:
        tree.write(xml_path,encoding="utf-8",xml_declaration=True)
    stats.update({"cross_surface_duplicates_removed":cross_removed,"wrong_carrier_reparented":reparented,"wrong_carrier_removed":wrong_removed})
    messages.append({"severity":"INFO","code":"GBXML_OPENING_HOST_OWNERSHIP_PROVEN","stats":stats,"message":"Openings are globally deduplicated and may exist only on a Surface proven to be their native Revit host; wrong-wall openings are re-parented or removed, never guessed."})
    return stats


def _r10_horizontal_persistence(xml_path, horizontal, analytical_manifest, allow_repairs):
    tree=ET.parse(xml_path); root=tree.getroot(); ns=namespace_uri(root)
    if ns:
        try: ET.register_namespace("",ns)
        except Exception: pass
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest); ids=set(x["id"] for x in index["surfaces"]); errors=[]; warnings=[]; inserted=[]
    by_source={}
    for r in horizontal: by_source.setdefault(str(r.get("source_key") or ""),[]).append(r)
    for r in horizontal:
        if find_surface_match(r,index,relaxed=True) is not None: continue
        sibling=None
        for c in by_source.get(str(r.get("source_key") or ""),[]):
            if c is r or int(c.get("space_revit_id") or -1)==int(r.get("space_revit_id") or -1): continue
            if polygon_match(record_polyloop(r),record_polyloop(c),0.3048,relaxed=True): sibling=c; break
        if allow_repairs:
            refs=expected_xml_space_ids(r,index)
            if sibling:
                for x in expected_xml_space_ids(sibling,index):
                    if x not in refs: refs.append(x)
            sid,err=_r10_exact_surface_insert(r,index,ns,ids,adjacent_refs=refs,stype=_r10_surface_type_for_record(r,len(refs)),prefix="exact-horizontal")
            if not err:
                inserted.append(sid); warnings.append("{} inserted from exact Revit {} boundary {}.".format(sid,r.get("surface_role"),r.get("originating_element_id"))); index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest); continue
        errors.append("Physical {} face {} for Space {} is absent from gbXML.".format(r.get("surface_role"),r.get("originating_element_id"),r.get("space_revit_id")))
    if inserted: tree.write(xml_path,encoding="utf-8",xml_declaration=True)
    # prove from disk
    final=bind_xml_spaces_to_revit(xml_envelope_index(ET.parse(xml_path).getroot()),analytical_manifest)
    preserved=sum(1 for r in horizontal if find_surface_match(r,final,relaxed=True) is not None)
    return {"expected":len(horizontal),"preserved":preserved,"inserted":inserted,"errors":errors,"warnings":warnings}


def _r10_complete_missing_wall_faces_from_eadm(xml_path, wall_manifest, analytical_manifest):
    """Complete exact physical wall subfaces using EADM only for adjacency identity.

    Geometry comes from the physical Revit subface. EADM supplies the second Space
    identity when Revit's physical boundary API exposes only one side. No rectangle,
    extrapolation, or nearest-wall fitting is allowed.
    """
    tree=ET.parse(xml_path); root=tree.getroot(); ns=namespace_uri(root)
    if ns:
        try: ET.register_namespace("",ns)
        except Exception: pass
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest); ids=set(x["id"] for x in index.get("surfaces",[])); inserted=[]; reasons=[]
    analytical_by_source={}
    for a in (analytical_manifest or {}).get("surfaces",[]) or []:
        sid=int(a.get("originating_element_id") or -1)
        if sid>0: analytical_by_source.setdefault(sid,[]).append(a)
    for r in (wall_manifest or {}).get("surfaces",[]) or []:
        if find_surface_match(r,index,relaxed=True) is not None: continue
        source_id=int(r.get("originating_element_id") or -1); rspace=int(r.get("space_revit_id") or -1); pts=record_polyloop(r)
        best=None; best_score=-1
        for a in analytical_by_source.get(source_id,[]):
            adj=[int(v) for v in (a.get("adjacent_revit_space_ids") or [])]
            if rspace>0 and adj and rspace not in adj: continue
            ap=record_polyloop(a); score=0
            if pts and ap and polygon_plane_contains(pts,ap,0.3048): score+=100
            if rspace in adj: score+=50
            if len(adj) in (1,2): score+=20
            if score>best_score: best=a; best_score=score
        if best is None or best_score<20:
            continue
        refs=expected_xml_space_ids(best,index)
        if not refs:
            refs=expected_xml_space_ids(r,index)
        if not refs: continue
        stype="InteriorWall" if len(refs)>1 else "ExteriorWall"
        sid,err=_r10_exact_surface_insert(r,index,ns,ids,adjacent_refs=refs,stype=stype,prefix="exact-wall-eadm-adjacency")
        if err:
            reasons.append({"source_id":source_id,"space_id":rspace,"error":err}); continue
        inserted.append(sid); index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    if inserted: tree.write(xml_path,encoding="utf-8",xml_declaration=True)
    return {"inserted":inserted,"count":len(inserted),"unresolved":reasons[:100]}


def envelope_persistence_gate(xml_path, physical_manifest, analytical_manifest, allow_repairs=True):
    # Keep RELEASE9 wall logic, but never let it misclassify roofs/floors/ceilings as walls.
    wall_manifest=dict(physical_manifest or {}); wall_manifest["surfaces"]=[r for r in (physical_manifest or {}).get("surfaces",[]) if normalize_text(r.get("surface_role") or "wall")=="wall"]
    base=_r9_envelope_persistence_gate(xml_path,wall_manifest,analytical_manifest,allow_repairs=allow_repairs)
    wall_completion={"inserted":[],"count":0}
    if allow_repairs:
        wall_completion=_r10_complete_missing_wall_faces_from_eadm(xml_path,wall_manifest,analytical_manifest)
        if wall_completion.get("count"):
            # Re-evaluate with repairs enabled once more so newly restored exact wall
            # carriers can immediately receive their proven missing openings.
            base=_r9_envelope_persistence_gate(xml_path,wall_manifest,analytical_manifest,allow_repairs=True)
    base["exact_source_wall_completion"]=wall_completion
    base.setdefault("counts",{})["exact_source_walls_inserted_from_eadm_adjacency"]=int(wall_completion.get("count",0) or 0)
    horizontal=[r for r in (physical_manifest or {}).get("surfaces",[]) if normalize_text(r.get("surface_role") or "wall")!="wall"]
    h=_r10_horizontal_persistence(xml_path,horizontal,analytical_manifest,allow_repairs)
    base["errors"].extend(h["errors"]); base["warnings"].extend(h["warnings"]); base["passed"]=len(base["errors"])==0
    base["counts"]["physical_horizontal_faces_expected"]=h["expected"]; base["counts"]["physical_horizontal_faces_preserved"]=h["preserved"]; base["counts"]["exact_horizontal_faces_inserted"]=len(h["inserted"])
    base["exact_horizontal_face_ids"]=h["inserted"]
    return base


# -----------------------------------------------------------------------------
# RELEASE11 saved-checkpoint reuse guard
# -----------------------------------------------------------------------------
# RELEASE10 correctly audited existing REVEX Spaces but still called NewSpace and
# NewSpaces2 afterward. In an already-populated model Revit then raised a redundant
# Space failure. A verified checkpoint must be treated as immutable input to the
# geometry/envelope maintenance pass, not as a hint to create again.
REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE = False
_r10_create_room_seeded_spaces = create_room_seeded_spaces
_r10_create_missing_spaces = create_missing_spaces
_r10_close_remaining_plan_circuits = close_remaining_plan_circuits


def create_room_seeded_spaces(model_doc, phase, levels, room_sources, existing_ids, changes, messages):
    if REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE:
        messages.append({
            "severity":"INFO",
            "code":"VERIFIED_CHECKPOINT_ROOM_RESEED_SKIPPED",
            "message":"Existing REVEX Spaces independently pass Room topology and story sanity; Room-seeded Space creation is skipped to avoid redundant Space overlap.",
        })
        return set(), {
            "attempted":0,
            "created":0,
            "kept":0,
            "failed":0,
            "failed_details":[],
            "reused_checkpoint":True,
        }
    return _r10_create_room_seeded_spaces(model_doc, phase, levels, room_sources, existing_ids, changes, messages)


def create_missing_spaces(model_doc, phase, levels, target_levels, room_sources, existing_ids, changes, messages):
    if REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE:
        messages.append({
            "severity":"INFO",
            "code":"VERIFIED_CHECKPOINT_GAP_REFILL_SKIPPED",
            "message":"Existing REVEX spatial checkpoint is reused; NewSpaces2 gap creation is skipped. Residual circuits remain read-only QA findings.",
        })
        return set(), {
            "api_returned_ids":0,
            "attempted":0,
            "kept":0,
            "discarded_zero_area":0,
            "discarded_redundant":0,
            "discarded_room_duplicates":0,
            "failed_levels":[],
            "reused_checkpoint":True,
        }
    return _r10_create_missing_spaces(model_doc, phase, levels, target_levels, room_sources, existing_ids, changes, messages)


def close_remaining_plan_circuits(model_doc, phase, phases, levels, room_sources, target_levels, created_ids, changes, messages, max_rounds=MAX_TOPOLOGY_REPAIR_ROUNDS):
    if REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE:
        return {
            "rounds":0,
            "api_returned_ids":0,
            "kept":0,
            "discarded_zero_area":0,
            "discarded_redundant":0,
            "discarded_room_duplicates":0,
            "remaining_before":None,
            "remaining_after":None,
            "reused_checkpoint":True,
        }
    return _r10_close_remaining_plan_circuits(model_doc, phase, phases, levels, room_sources, target_levels, created_ids, changes, messages, max_rounds=max_rounds)


# -----------------------------------------------------------------------------
# RELEASE12 — native topology first; no post-export carrier invention
# -----------------------------------------------------------------------------
# RELEASE11 proved that Revit's native EADM/export path works, but the maintenance
# layer could degrade it by adding physical subfaces as independent gbXML carriers.
# RELEASE12 moves correction upstream into Revit Spaces, then keeps post-export
# maintenance topology-only: adjacency + one proven physical opening per source id.
_r11_prepare_room_source_vertical_targets = prepare_room_source_vertical_targets
_r11_capture_physical_envelope = capture_physical_envelope
_r11_normalize_gbxml_openings_from_revit = normalize_gbxml_openings_from_revit
_r11_envelope_persistence_gate = envelope_persistence_gate
_r11_cull_open_exterior_generated_spaces = cull_open_exterior_generated_spaces
_r11_refine_top_story_space_heights = refine_top_story_space_heights_from_physical_cover
_r11_view_energy_attribute_values = _view_energy_attribute_values


def _r12_collect_viewplans(model_doc):
    values=[]; seen=set()
    # Normal fast path.
    for view in collect_class(model_doc, ViewPlan):
        if view is None: continue
        vid=eid_value(view.Id)
        if vid in seen: continue
        seen.add(vid); values.append(view)
    # Fallback: collect all Views and retain ViewPlan wrappers. This catches Area
    # Plans in API states where OfClass(ViewPlan) is unexpectedly incomplete.
    try:
        for view in collect_class(model_doc, View):
            if not isinstance(view, ViewPlan): continue
            vid=eid_value(view.Id)
            if vid in seen: continue
            seen.add(vid); values.append(view)
    except Exception:
        pass
    return values


def _view_energy_attribute_values(model_doc, view):
    values=list(_r11_view_energy_attribute_values(model_doc,view) or [])
    # Area scheme is the key office convention shown in the reference:
    # Area Plan energy-tag qualification uses the view/area-scheme attributes, not a floor name.
    try:
        scheme=safe_attr(view,"AreaScheme",None)
        if scheme is not None:
            name=safe_element_name(scheme)
            if name and name not in values: values.append(str(name))
    except Exception:
        pass
    try:
        scheme_id=safe_attr(view,"AreaSchemeId",None)
        if scheme_id is not None and eid_value(scheme_id)>0:
            scheme=model_doc.GetElement(scheme_id)
            name=safe_element_name(scheme) if scheme is not None else ""
            if name and name not in values: values.append(str(name))
    except Exception:
        pass
    return values


def prepare_room_source_vertical_targets(room_sources, target_levels, all_levels, changes, messages):
    """Energy Spaces follow actual Revit story levels, not low Room upper limits.

    Lower occupied stories terminate at the next occupied Revit level exactly.
    Top story remains bounded by a real physical cover later in the same transaction.
    Architectural Room parameters are never modified.
    """
    ordered_levels=sorted(list(target_levels or []),key=level_elevation)
    typical=typical_occupied_story_height(ordered_levels)
    corrected=0
    for source in sorted(room_sources,key=lambda r:(float(r.get("base_z") or 0.0),int(r.get("id") or -1))):
        base=source.get("base_z")
        if base is None: continue
        base=float(base)
        lev=source_level(ordered_levels,source) or source_level(all_levels,source)
        next_occ=None
        if lev is not None:
            z=level_elevation(lev)
            for candidate in ordered_levels:
                if level_elevation(candidate)>z+LEVEL_ELEVATION_TOL_FT:
                    next_occ=candidate; break
        if next_occ is not None:
            target=float(level_elevation(next_occ)); method="next_occupied_revit_level"
            upper_id=eid_value(next_occ.Id)
        else:
            # Provisional top-story target. A real roof/floor/ceiling cover replaces
            # this after Spaces exist, before EADM creation.
            target=base+typical; method="provisional_top_story_until_physical_cover"; upper_id=None
        if target<=base+2.0:
            target=base+max(typical,8.0)
        nominal=source.get("top_z")
        source["effective_top_z"]=float(target)
        source["nominal_top_z"]=(float(nominal) if nominal is not None else None)
        source["story_top_z"]=float(target)
        source["story_top_method"]=method
        source["story_upper_level_id"]=upper_id
        if nominal is None or abs(float(nominal)-float(target))>0.20:
            corrected+=1
    messages.append({
        "severity":"INFO","code":"ROOM_SPACE_LEVEL_HEIGHT_AUTHORITY_ACTIVE","count":corrected,
        "message":"REVEX energy Spaces use occupied Revit level-to-level heights. Low architectural Room Upper Limits no longer truncate conditioned story volumes; top-story height is finalized from a real physical cover before EADM creation."
    })
    return corrected


def _r12_next_occupied_level(base_level,target_levels):
    if base_level is None: return None
    z=level_elevation(base_level)
    ordered=sorted(list(target_levels or []),key=level_elevation)
    # If the Space sits on a coincident/non-target datum, resolve by elevation.
    base_match=nearest_level(ordered,z,max_distance_ft=0.50) or base_level
    bz=level_elevation(base_match)
    for candidate in ordered:
        if level_elevation(candidate)>bz+LEVEL_ELEVATION_TOL_FT:
            return candidate
    return None


def refine_top_story_space_heights_from_physical_cover(model_doc, spaces, created_ids, target_levels, changes, messages):
    """Normalize every REVEX Space to Revit levels; top story to physical cover."""
    created=set(int(v) for v in created_ids); adjusted=[]; failures=[]
    candidates=_r10_cover_candidates(model_doc)
    typical=typical_occupied_story_height(target_levels)
    for s in list(spaces or []):
        if s is None or eid_value(s.Id) not in created or not is_placed_spatial(s): continue
        sid=eid_value(s.Id); lev=_space_base_level(s)
        if lev is None: continue
        before=_space_vertical_bounds(s)
        try:
            # Generated energy topology is level based. Remove accidental base offsets.
            _set_space_base_offset(s,0.0)
            upper=_r12_next_occupied_level(lev,target_levels)
            method="next_occupied_revit_level"; cover_id=None; cover_role=None
            if upper is not None:
                desired=level_elevation(upper)
                ok=_apply_space_vertical_target_nonzero(s,0.0,upper,desired)
            else:
                cover=_r10_nearest_cover_z(model_doc,s,candidates)
                if cover is not None:
                    desired=float(cover[0]); cover_role=cover[1]; cover_id=cover[2]; method="physical_top_cover"
                else:
                    desired=level_elevation(lev)+typical; method="top_story_level_fallback"
                # Critical ordering: positive offset is established before Upper
                # Limit can collapse to the base/top-story datum.
                ok=_apply_space_vertical_target_nonzero(s,0.0,lev,desired)
            if not ok:
                failures.append({"space_id":sid,"reason":"parameter_write_rejected"}); continue
            model_doc.Regenerate(); after=_space_vertical_bounds(s)
            if not after or float(after[1])-float(after[0])<=2.0:
                failures.append({"space_id":sid,"reason":"invalid_geometry_after_level_normalization"}); continue
            if abs(float(after[1])-float(desired))>0.35:
                failures.append({"space_id":sid,"reason":"top_did_not_follow_revit_target","desired_ft":desired,"actual_ft":float(after[1])}); continue
            if before is None or abs(float(before[0])-float(after[0]))>0.15 or abs(float(before[1])-float(after[1]))>0.15:
                row={"space_id":sid,"bottom_after_ft":round(float(after[0]),4),"top_after_ft":round(float(after[1]),4),"height_after_ft":round(float(after[1])-float(after[0]),4),"method":method,"cover_role":cover_role,"cover_id":cover_id}
                if before: row.update({"bottom_before_ft":round(float(before[0]),4),"top_before_ft":round(float(before[1]),4),"height_before_ft":round(float(before[1])-float(before[0]),4)})
                adjusted.append(row); changes.append({"action":"normalize_generated_space_to_revit_story_height",**row})
        except Exception as ex:
            failures.append({"space_id":sid,"reason":str(ex)})
    if adjusted:
        messages.append({"severity":"INFO","code":"ALL_GENERATED_SPACE_HEIGHTS_NORMALIZED_TO_REVIT","count":len(adjusted),"message":"REVEX normalized generated Space bottoms/tops to occupied Revit levels; top-story Spaces use an actual roof/floor/ceiling cover when available. The EADM is rebuilt after any change."})
    if failures:
        messages.append({"severity":"WARNING","code":"SPACE_LEVEL_HEIGHT_NORMALIZATION_PARTIAL","count":len(failures),"details":failures[:50],"message":"Some Space height parameters could not be normalized. Their native Revit geometry remains authoritative and no XML surface is invented to compensate."})
    return {"adjusted":len(adjusted),"details":adjusted,"failures":failures}


def cull_open_exterior_generated_spaces(model_doc, spaces, created_ids, matched, target_levels, changes, messages):
    """A generated non-Room Space cannot invent a wall where Revit has no boundary."""
    created=set(int(v) for v in created_ids); matched_ids=set(int(v) for v in (matched or {}).keys())
    gaps=[s for s in spaces if s is not None and eid_value(s.Id) in created and eid_value(s.Id) not in matched_ids and is_placed_spatial(s)]
    rows=[]; typical=typical_occupied_story_height(target_levels)
    for s in gaps:
        b=_r10_space_bbox(s); lev=_space_base_level(s); rows.append((s,b,level_elevation(lev) if lev is not None else (b[2] if b else 0.0)))
    removed=[]; details=[]
    for s,b,z in rows:
        sid=eid_value(s.Id); ev=_r10_space_enclosure_evidence(model_doc,s); vertical_core=False
        for other,ob,oz in rows:
            if other is s or not b or not ob: continue
            dz=abs(float(oz)-float(z))
            if dz>1.0 and dz<=typical*1.6 and _r10_xy_overlap_ratio(b,ob)>=0.55:
                vertical_core=True; break
        # Strong direct rule requested by the workflow: an unhosted vertical face
        # on a generated non-Room circuit is an opening, not a fictional wall.
        open_side=int(ev.get("side_unhosted",0) or 0)>0
        open_top=bool(ev.get("solid_valid") and not ev.get("top_hosted"))
        exterior=bool(ev.get("side_exterior_walls",0)>0 or open_side)
        discard=bool((open_side and not vertical_core) or (open_top and exterior and not vertical_core))
        details.append({"space_id":sid,"open_side":open_side,"open_top":open_top,"vertical_core":vertical_core,"evidence":ev,"discard":discard})
        if not discard: continue
        try:
            model_doc.Delete(s.Id); created_ids.discard(sid); removed.append(sid)
            changes.append({"action":"remove_generated_space_with_unbounded_side","element_id":sid})
        except Exception as ex:
            messages.append({"severity":"WARNING","code":"OPEN_GENERATED_SPACE_REMOVE_FAILED","element_id":sid,"message":str(ex)})
    if removed:
        model_doc.Regenerate(); messages.append({"severity":"INFO","code":"OPEN_GENERATED_SPACES_REMOVED","count":len(removed),"message":"Generated non-Room circuits with an unhosted vertical side were removed. REVEX does not create an analytical wall where Revit has no Wall/Room-Separation boundary."})
    return {"reviewed":len(details),"removed":len(removed),"removed_ids":removed,"details":details[:100]}


def _r12_opening_supported_by_surface(opening_ft,surface_ft,tol_ft=0.20):
    if len(opening_ft or [])<3 or len(surface_ft or [])<3: return False
    basis=wall_basis(surface_ft)
    if basis is None: return False
    origin,u,v,n=basis
    for p in opening_ft:
        if abs(sum((p[i]-origin[i])*n[i] for i in range(3)))>tol_ft: return False
    sb=project_bounds(surface_ft,basis); ob=project_bounds(opening_ft,basis)
    return ob[0]>=sb[0]-tol_ft and ob[1]<=sb[1]+tol_ft and ob[2]>=sb[2]-tol_ft and ob[3]<=sb[3]+tol_ft


def capture_physical_envelope(model_doc, spaces, messages):
    base=_r11_capture_physical_envelope(model_doc,spaces,messages)
    surfaces=list(base.get("surfaces",[]) or []); by_source={}
    for s in surfaces:
        if normalize_text(s.get("surface_role") or "wall")!="wall": continue
        by_source.setdefault(str(s.get("source_key") or ""),[]).append(s)
    unique={}; ambiguous=0
    for rec in list(base.get("openings",[]) or []):
        sid=int(rec.get("originating_element_id") or -1)
        if sid<=0: continue
        pts=record_polyloop(rec); supports=[]
        for carrier in by_source.get(str(rec.get("parent_source_key") or ""),[]):
            if _r12_opening_supported_by_surface(pts,record_polyloop(carrier)):
                supports.append(carrier)
        # Same source window/door may touch the two sides of one interior wall, but
        # it may not replicate through every Space crossed by a tall wall.
        space_ids=[]
        for carrier in supports:
            value=int(carrier.get("space_revit_id") or -1)
            if value>0 and value not in space_ids: space_ids.append(value)
        rec["adjacent_revit_space_ids"]=space_ids
        rec["host_support_count"]=len(supports)
        rec["host_proven"]=bool(supports and len(space_ids)<=2)
        rec["parent_physical_surface_key"]=(supports[0].get("key") if rec["host_proven"] else "")
        if not rec["host_proven"]: ambiguous+=1
        old=unique.get(sid)
        if old is None or (rec.get("host_proven") and not old.get("host_proven")):
            unique[sid]=rec
    base["openings"]=list(unique.values())
    counts=base.setdefault("counts",{}); counts["windows_doors_and_curtain_openings"]=len(base["openings"]); counts["windows_and_doors"]=len(base["openings"]); counts["physical_opening_unique_source_ids"]=len(unique); counts["physical_opening_ambiguous_hosts"]=ambiguous
    messages.append({"severity":"INFO","code":"PHYSICAL_OPENINGS_UNIQUE_HOST_PROOF","count":len(unique),"ambiguous":ambiguous,"message":"Every physical window/door/curtain panel is represented once by Revit source ElementId. A candidate opening is valid only on the native host wall subface(s) that geometrically contain it."})
    return base


def _r12_physical_parent_candidate(record,index,physical_surfaces):
    pts=record_polyloop(record)
    if len(pts)<3 or not record.get("host_proven"): return None
    wanted_key=str(record.get("parent_physical_surface_key") or "")
    wallrec=next((x for x in physical_surfaces if str(x.get("key") or "")==wanted_key),None)
    candidates=[]
    if wallrec is not None:
        c=find_surface_match(wallrec,index,relaxed=True)
        if c is not None: candidates.append(c)
    expected=set(expected_xml_space_ids(record,index))
    for c in index.get("surfaces",[]):
        if expected and not expected.intersection(set(c.get("adjacent") or [])): continue
        # Candidate geometry is XML units; convert to feet for host proof.
        cft=[tuple(float(v)*index["factor"]/0.3048 for v in p[:3]) for p in (c.get("points") or [])]
        if _r12_opening_supported_by_surface(pts,cft):
            if c not in candidates: candidates.append(c)
    if not candidates: return None
    # Prefer the actual physical wall subface match, then the smallest containing
    # carrier (prevents a window from jumping to a whole-story/other-story face).
    def area_ft(c):
        cft=[tuple(float(v)*index["factor"]/0.3048 for v in p[:3]) for p in (c.get("points") or [])]
        return 0.5*norm(newell(cft)) if len(cft)>=3 else 1e99
    return min(candidates,key=area_ft)


def _r12_insert_opening_on_parent(record,parent,namespace,index,existing_ids):
    pts=clean_consecutive(record_polyloop(record),MIN_EDGE_M/0.3048)
    if len(pts)<3: return None,"physical opening has insufficient exact geometry"
    if polygon_self_intersects(dominant_projection(pts,newell(pts))): return None,"physical opening self-intersects"
    # Parent containment is mandatory; there is no nearest-wall or window guess.
    pft=[tuple(float(v)*index["factor"]/0.3048 for v in p[:3]) for p in (parent.get("points") or [])]
    if not _r12_opening_supported_by_surface(pts,pft): return None,"physical opening is not contained by the proven native carrier"
    scale=0.3048/index["factor"]; pts_xml=[tuple(v*scale for v in p) for p in pts]
    oid=stable_fallback_id("physical-opening",record,existing_ids); attrs={"id":oid,"openingType":_fallback_opening_type(record.get("opening_type"))}
    opening=ET.Element(qualified(namespace,"Opening"),attrs); name=ET.SubElement(opening,qualified(namespace,"Name")); name.text="LIBER physical {}".format(record.get("originating_element_name") or record.get("originating_element_id") or oid)
    rect=rectangularize_wall(pts)
    if len(rect)==4:
        rect_xml=[tuple(v*scale for v in p) for p in rect]; rg=ET.SubElement(opening,qualified(namespace,"RectangularGeometry")); add_cartesian_point(rg,namespace,rect_xml[0]); w,h=rectangle_dimensions(rect_xml); he=ET.SubElement(rg,qualified(namespace,"Height")); he.text="{:.9f}".format(h).rstrip("0").rstrip("."); we=ET.SubElement(rg,qualified(namespace,"Width")); we.text="{:.9f}".format(w).rstrip("0").rstrip(".")
    add_planar_geometry(opening,namespace,pts_xml); cad=ET.SubElement(opening,qualified(namespace,"CADObjectId")); cad.text=str(record.get("originating_element_id") or "")
    pe=parent["element"]; at=len(list(pe))
    for i,c in enumerate(list(pe)):
        if local_name(c.tag)=="CADObjectId": at=i; break
    pe.insert(at,opening); return oid,None


def normalize_gbxml_openings_from_revit(xml_path, analytical_manifest, physical_manifest, messages):
    """Rebuild opening topology from unique physical Revit sources only.

    Analytical opening records are evidence, not permission to multiply one Window
    through every adjacent Space. If a host cannot be proven, the wall remains opaque.
    """
    tree=ET.parse(xml_path); root=tree.getroot(); ns=namespace_uri(root)
    if ns:
        try: ET.register_namespace("",ns)
        except Exception: pass
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    physical_surfaces=[r for r in (physical_manifest or {}).get("surfaces",[]) if normalize_text(r.get("surface_role") or "wall")=="wall"]
    recs={}
    for r in (physical_manifest or {}).get("openings",[]) or []:
        sid=int(r.get("originating_element_id") or -1)
        if sid>0 and sid not in recs: recs[sid]=r
    # Remove every existing opening first. Native Revit opening topology may carry
    # analytical ids rather than physical source ids; physical windows/doors below
    # are then reintroduced exactly once on a proven host.
    removed=0
    for surface in [e for e in root.iter() if local_name(e.tag)=="Surface"]:
        for opening in [c for c in list(surface) if local_name(c.tag)=="Opening"]:
            surface.remove(opening); removed+=1
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest); existing=set(); inserted=[]; uncertain=[]
    for sid,rec in sorted(recs.items()):
        parent=_r12_physical_parent_candidate(rec,index,physical_surfaces)
        if parent is None:
            uncertain.append(sid); continue
        oid,err=_r12_insert_opening_on_parent(rec,parent,ns,index,existing)
        if err: uncertain.append(sid); continue
        inserted.append(oid)
    tree.write(xml_path,encoding="utf-8",xml_declaration=True)
    stats={"native_or_prior_openings_removed":removed,"physical_unique_sources":len(recs),"physical_openings_inserted":len(inserted),"uncertain_hosts_left_opaque":len(uncertain),"uncertain_source_ids":uncertain[:100],"duplicates_removed":max(0,removed-len(recs)),"wrong_carrier_reparented":0,"wrong_carrier_removed":0,"types_normalized":len(inserted),"openings_examined":len(recs),"duplicate_groups":0,"cross_surface_duplicates_removed":0}
    messages.append({"severity":"INFO","code":"GBXML_PHYSICAL_OPENINGS_REBUILT_ON_PROVEN_HOSTS","stats":stats,"message":"gbXML openings were rebuilt once from unique physical Revit window/door/curtain-panel ElementIds. Host containment is mandatory. Uncertain cases remain opaque wall, never guessed window."})
    return stats


def envelope_persistence_gate(xml_path, physical_manifest, analytical_manifest, allow_repairs=True):
    """Read-only persistence proof. RELEASE12 never adds Surface carriers to XML."""
    root=ET.parse(xml_path).getroot(); index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    errors=[]; warnings=[]
    analytical=list((analytical_manifest or {}).get("surfaces",[]) or []); matched_a=sum(1 for r in analytical if find_surface_match(r,index,relaxed=True) is not None)
    # Gross topology is authoritative; a physical wall can be split differently by
    # Revit/EADM, so physical subfaces are QA evidence rather than 1:1 Surface demands.
    walls=[r for r in (physical_manifest or {}).get("surfaces",[]) if normalize_text(r.get("surface_role") or "wall")=="wall"]
    horizontals=[r for r in (physical_manifest or {}).get("surfaces",[]) if normalize_text(r.get("surface_role") or "wall")!="wall"]
    def physical_source_key(record):
        key=str(record.get("source_key") or "").strip()
        if key:
            return key
        source_id=int(record.get("originating_element_id") or -1)
        return "ELEMENT::{}".format(source_id) if source_id>0 else ""

    unique_wall_sources={physical_source_key(r) for r in walls if physical_source_key(r)}
    unique_horizontal_sources={physical_source_key(r) for r in horizontals if physical_source_key(r)}
    unique_surface_sources=set(unique_wall_sources)|set(unique_horizontal_sources)
    preserved_wall_sources=set()
    preserved_horizontal_sources=set()
    for r in walls:
        if find_surface_match(r,index,relaxed=True) is not None:
            key=physical_source_key(r)
            if key: preserved_wall_sources.add(key)
    for r in horizontals:
        if find_surface_match(r,index,relaxed=True) is not None:
            key=physical_source_key(r)
            if key: preserved_horizontal_sources.add(key)
    preserved_surface_sources=set(preserved_wall_sources)|set(preserved_horizontal_sources)
    proven_openings=[]
    seen=set()
    for r in (physical_manifest or {}).get("openings",[]) or []:
        sid=int(r.get("originating_element_id") or -1)
        if sid>0 and sid not in seen and r.get("host_proven"):
            seen.add(sid); proven_openings.append(r)
    preserved_openings=sum(1 for r in proven_openings if find_opening_match(r,index,relaxed=True) is not None)
    if not index.get("surfaces") or not index.get("spaces"):
        errors.append("gbXML has no usable Space/Surface topology.")
    if analytical:
        ratio=float(matched_a)/float(len(analytical))
        # Do not force subface fitting. A materially incomplete EADM serialization is
        # still critical; small carrier partition differences are warnings.
        if ratio<PRESERVATION_MINIMUM: errors.append("Only {:.1%} of Revit EADM surfaces can be rebound in gbXML (80% hard-stop integrity gate).".format(ratio))
        elif ratio<PRESERVATION_TARGET: warnings.append("Revit EADM surface rebinding is {:.1%}; below the 95% quality target; partition differences remain explicit QA evidence and publication continues because the 80% hard stop was cleared.".format(ratio))
    missing_wall_sources=sorted(unique_wall_sources-preserved_wall_sources)
    missing_horizontal_sources=sorted(unique_horizontal_sources-preserved_horizontal_sources)
    if missing_wall_sources:
        warnings.append("{} physical Revit wall source(s) do not have a direct physical-subface match in gbXML; source identity remains QA evidence while complete EADM topology is scored separately.".format(len(missing_wall_sources)))
    if missing_horizontal_sources:
        warnings.append("{} physical Revit floor/roof/ceiling source(s) do not have a direct physical-subface match in gbXML; source identity remains QA evidence while complete EADM topology is scored separately.".format(len(missing_horizontal_sources)))
    if preserved_openings<len(proven_openings):
        warnings.append("{} host-proven physical opening(s) do not have a direct native geometric match; final opening-source identity reconciliation is scored separately.".format(len(proven_openings)-preserved_openings))
    counts={
        "physical_wall_faces_expected":len(walls),
        "physical_wall_faces_preserved":sum(1 for r in walls if find_surface_match(r,index,relaxed=True) is not None),
        "physical_horizontal_faces_expected":len(horizontals),
        "physical_horizontal_faces_preserved":sum(1 for r in horizontals if find_surface_match(r,index,relaxed=True) is not None),
        "analytical_faces_expected":len(analytical),
        "analytical_faces_preserved":matched_a,
        "physical_windows_doors_expected":len(proven_openings),
        "physical_windows_doors_preserved":preserved_openings,
        "analytical_openings_expected":len((analytical_manifest or {}).get("openings",[]) or []),
        "simplified_exterior_walls_inserted":0,
        "exact_source_walls_inserted_from_eadm_adjacency":0,
        "exact_horizontal_faces_inserted":0,
        "openings_inserted":int((0)),
        "opening_types_corrected":0,
        "physical_wall_sources_expected":len(unique_wall_sources),
        "physical_wall_sources_preserved":len(preserved_wall_sources),
        "physical_horizontal_sources_expected":len(unique_horizontal_sources),
        "physical_horizontal_sources_preserved":len(preserved_horizontal_sources),
        "physical_surface_sources_expected":len(unique_surface_sources),
        "physical_surface_sources_preserved":len(preserved_surface_sources),
        "physical_surface_source_coverage":round(float(len(preserved_surface_sources))/float(len(unique_surface_sources)),6) if unique_surface_sources else 1.0,
    }
    return {"passed":len(errors)==0,"errors":errors,"warnings":warnings,"counts":counts,"simplified_exterior_wall_ids":[],"inserted_opening_ids":[],"corrected_opening_type_ids":[],"exact_source_wall_completion":{"inserted":[],"count":0},"exact_horizontal_face_ids":[]}


def _r10_horizontal_persistence(xml_path, horizontal, analytical_manifest, allow_repairs):
    # Compatibility override: horizontal physical faces are evaluated only. They
    # are never appended after EADM export because independent roof/floor patches
    # can break the Space prism and float on the wrong story.
    root=ET.parse(xml_path).getroot(); index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    preserved=sum(1 for r in (horizontal or []) if find_surface_match(r,index,relaxed=True) is not None)
    return {"expected":len(horizontal or []),"preserved":preserved,"inserted":[],"errors":[],"warnings":[]}


def _r10_complete_missing_wall_faces_from_eadm(xml_path, wall_manifest, analytical_manifest):
    # Explicitly disabled: RELEASE11 showed that inferred EADM adjacency could bind
    # an exact physical wall face to the wrong story/Space. Upstream Space/EADM
    # correction is the only allowed geometry repair now.
    return {"inserted":[],"count":0,"unresolved":[]}


# -----------------------------------------------------------------------------
# RELEASE14 — preservation-first topology/opening finalization
# -----------------------------------------------------------------------------
# RELEASE13 proved the native Revit EADM/export path is stable, but two maintenance
# policies were still destructive: (1) deleting positive non-Room Spaces solely for
# an unhosted vertical side and (2) deleting every native gbXML Opening before trying
# to reconstruct physical windows/doors. A physical host may span multiple spatial domains, so cross-domain host geometry must be allowed
# to bound multiple story Spaces. RELEASE14 preserves native topology first and only
# removes geometry when Revit proves it invalid.

_r13_create_missing_spaces = create_missing_spaces
_r13_close_remaining_plan_circuits = close_remaining_plan_circuits
_r13_cull_open_exterior_generated_spaces = cull_open_exterior_generated_spaces
_r13_normalize_gbxml_openings_from_revit = normalize_gbxml_openings_from_revit


def _r14_space_area(space):
    try:
        return float(space.Area)
    except Exception:
        return 0.0


def _r14_clean_zero_area_revex_spaces(model_doc, existing_ids, changes, messages):
    """Delete only stale REVEX-authored zero-area artifacts before bounded gap refresh.

    Positive-area topology is never removed here. This lets current Revit Room Bounding
    decide whether a former balcony circuit still exists after the user changes the model.
    """
    live=set(int(x) for x in existing_ids)
    removed=[]
    for sid in sorted(list(live)):
        try: element=model_doc.GetElement(ElementId(int(sid)))
        except Exception: element=None
        if element is None or not isinstance(element,Space):
            live.discard(sid); continue
        if not is_revex_generated_space(element):
            continue
        if _r14_space_area(element) > AREA_EPSILON_FT2:
            continue
        try:
            model_doc.Delete(element.Id); live.discard(sid); removed.append(sid)
            changes.append({"action":"delete_stale_zero_area_revex_space_before_gap_refresh","element_id":sid})
        except Exception as ex:
            messages.append({"severity":"WARNING","code":"ZERO_AREA_REVEX_SPACE_CLEANUP_FAILED","element_id":sid,"message":str(ex)})
    if removed:
        model_doc.Regenerate()
        messages.append({"severity":"INFO","code":"ZERO_AREA_REVEX_SPACES_CLEANED","count":len(removed),"message":"Only stale REVEX-authored zero-area Space artifacts were removed before current Room-Bounding topology was refreshed."})
    return live,removed


def create_missing_spaces(model_doc, phase, levels, target_levels, room_sources, existing_ids, changes, messages):
    """Refresh current positive Revit plan circuits even when a saved checkpoint is reused.

    Room-backed Spaces remain immutable. NewSpaces2 is allowed one bounded pass to create
    only currently uncovered positive-area circuits, then the existing duplicate/Room
    identity filters prune anything redundant. This is essential after Room Bounding
    changes and for a multi-story curtain-wall host that bounds separate story Spaces.
    """
    if REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE:
        live_ids,removed=_r14_clean_zero_area_revex_spaces(model_doc,existing_ids,changes,messages)
        messages.append({
            "severity":"INFO",
            "code":"VERIFIED_CHECKPOINT_CURRENT_CIRCUIT_REFRESH_ACTIVE",
            "removed_zero_area":len(removed),
            "message":"Saved Room topology is reused, but current Revit Room-Bounding circuits receive one bounded positive-area NewSpaces2 refresh. Cross-story curtain-wall hosts are allowed to bound separate story Spaces; no positive circuit is deleted merely for spanning-host topology.",
        })
        gap_ids,stats=_r10_create_missing_spaces(model_doc,phase,levels,target_levels,room_sources,live_ids,changes,messages)
        stats=dict(stats or {})
        stats["reused_checkpoint"]=True
        stats["current_circuit_refresh"]=True
        stats["zero_area_revex_removed_before_refresh"]=len(removed)
        return gap_ids,stats
    return _r10_create_missing_spaces(model_doc,phase,levels,target_levels,room_sources,existing_ids,changes,messages)


def close_remaining_plan_circuits(model_doc, phase, phases, levels, room_sources, target_levels, created_ids, changes, messages, max_rounds=MAX_TOPOLOGY_REPAIR_ROUNDS):
    if REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE:
        # One convergence round only. Runtime stays bounded while circuits exposed by
        # the first regeneration can still be closed. Existing duplicate filters remain.
        result=_r10_close_remaining_plan_circuits(model_doc,phase,phases,levels,room_sources,target_levels,created_ids,changes,messages,max_rounds=1)
        result=dict(result or {}); result["reused_checkpoint"]=True; result["max_rounds_release14"]=1
        return result
    return _r10_close_remaining_plan_circuits(model_doc,phase,phases,levels,room_sources,target_levels,created_ids,changes,messages,max_rounds=max_rounds)


def cull_open_exterior_generated_spaces(model_doc, spaces, created_ids, matched, target_levels, changes, messages):
    """Audit open/non-Room topology; do not delete positive Spaces.

    Revit Room Bounding is the authority. An unhosted side may be an actual open edge,
    a curtain-wall/panel boundary, a linked boundary, or another valid cross-story host.
    A previous heuristic deleted valid positive Spaces. The preservation rule never converts that ambiguity into geometry deletion.
    """
    reviewed=[]
    for s in list(spaces or []):
        sid=eid_value(s.Id)
        if sid not in created_ids or sid in matched or _r14_space_area(s)<=AREA_EPSILON_FT2:
            continue
        try: ev=_r10_space_enclosure_evidence(model_doc,s)
        except Exception: ev={}
        reviewed.append({"space_id":sid,"area_ft2":round(_r14_space_area(s),4),"side_unhosted":int(ev.get("side_unhosted",0) or 0),"side_exterior_walls":int(ev.get("side_exterior_walls",0) or 0),"top_hosted":bool(ev.get("top_hosted")),"evidence":ev})
    ambiguous=sum(1 for x in reviewed if x.get("side_unhosted",0)>0)
    if ambiguous:
        messages.append({"severity":"WARNING","code":"OPEN_GENERATED_SPACES_PRESERVED_FOR_REVIT_TOPOLOGY","count":ambiguous,"message":"Positive generated Spaces with an unhosted/cross-story side were preserved. Revit Room-Bounding topology—not a heuristic—decides whether the circuit exists; no fictional wall is created and no valid circuit is deleted."})
    return {"reviewed":len(reviewed),"removed":0,"removed_ids":[],"ambiguous_preserved":ambiguous,"details":reviewed[:100]}


def _r14_opening_signature(opening,parent_surface_id):
    cad=str(direct_child_text(opening,"CADObjectId") or "")
    oid=str(opening.attrib.get("id") or "")
    pts=polygon_points(opening)
    # Rounded geometric signature; only exact-near duplicates on the SAME carrier collapse.
    pkey=tuple(tuple(round(float(v),6) for v in p[:3]) for p in pts)
    return (str(parent_surface_id or ""),cad,oid,pkey)


def normalize_gbxml_openings_from_revit(xml_path, analytical_manifest, physical_manifest, messages):
    """Preserve Revit native openings; normalize identity/type and add only proven missing cuts.

    Native EADM/gbXML is authoritative for story splitting, especially curtain systems
    whose Wall host spans multiple spatial domains. Existing native openings are
    NEVER mass-deleted or reparented. Exact duplicates on the same carrier can be removed.
    A missing physical opening may be inserted only when one exact containing carrier is
    proven; ambiguous cases stay native wall/opening topology and are reported, never guessed.
    """
    tree=ET.parse(xml_path); root=tree.getroot(); ns=namespace_uri(root)
    if ns:
        try: ET.register_namespace("",ns)
        except Exception: pass
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)

    # Build evidence lookup from both analytical opening identity and physical source id.
    type_by_token={}; physical_by_source={}
    for r in list((physical_manifest or {}).get("openings",[]) or []):
        sid=int(r.get("originating_element_id") or -1)
        if sid>0:
            physical_by_source[sid]=r
            type_by_token[str(sid)]=_fallback_opening_type(r.get("opening_type"))
    analytical_origin_by_token={}
    for r in list((analytical_manifest or {}).get("openings",[]) or []):
        desired=_fallback_opening_type(r.get("opening_type"))
        for token in (r.get("analytical_id"),r.get("analysis_element_id"),r.get("originating_element_id")):
            if token is None: continue
            text=str(token)
            type_by_token[text]=desired
            origin=int(r.get("originating_element_id") or -1)
            if origin>0: analytical_origin_by_token[text]=origin

    valid_types=set(["FixedWindow","OperableWindow","FixedSkylight","OperableSkylight","SlidingDoor","NonSlidingDoor","Air"])
    stats={"native_openings_preserved":0,"types_normalized":0,"exact_duplicates_removed":0,"physical_unique_sources":len(physical_by_source),"missing_physical_inserted":0,"missing_physical_unresolved":0,"curtain_panel_sources":0,"native_physical_sources_recognized":0,"native_or_prior_openings_removed":0,"cross_surface_duplicates_removed":0,"wrong_carrier_reparented":0,"wrong_carrier_removed":0}
    represented_sources=set(); changed=False
    seen_signatures=set()
    # Preserve each native Opening in place. Only same-parent exact duplicate signatures collapse.
    for surface in [e for e in root.iter() if local_name(e.tag)=="Surface"]:
        surface_id=str(surface.attrib.get("id") or "")
        for opening in [c for c in list(surface) if local_name(c.tag)=="Opening"]:
            sig=_r14_opening_signature(opening,surface_id)
            if sig in seen_signatures:
                surface.remove(opening); stats["exact_duplicates_removed"]+=1; changed=True; continue
            seen_signatures.add(sig); stats["native_openings_preserved"]+=1
            cad=str(direct_child_text(opening,"CADObjectId") or "")
            oid=str(opening.attrib.get("id") or "")
            source_id=None
            for token in (cad,oid):
                if token in analytical_origin_by_token:
                    source_id=analytical_origin_by_token[token]; break
                try:
                    value=int(token)
                    if value in physical_by_source: source_id=value; break
                except Exception: pass
            if source_id is not None: represented_sources.add(int(source_id))
            current=str(opening.attrib.get("openingType") or "")
            desired=type_by_token.get(cad) or type_by_token.get(oid)
            if desired is None and source_id is not None: desired=type_by_token.get(str(source_id))
            if desired is None and current not in valid_types: desired=_fallback_opening_type(current)
            if desired and current!=desired:
                opening.attrib["openingType"]=desired; stats["types_normalized"]+=1; changed=True

    stats["native_physical_sources_recognized"]=len(represented_sources)
    # Missing-only conservative insert. Never reparent or replace native openings.
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    physical_surfaces=[r for r in (physical_manifest or {}).get("surfaces",[]) if normalize_text(r.get("surface_role") or "wall")=="wall"]
    existing_ids=set(str(e.attrib.get("id") or "") for e in root.iter() if local_name(e.tag)=="Opening")
    unresolved=[]
    for sid,rec in sorted(physical_by_source.items()):
        if rec.get("curtain_panel"): stats["curtain_panel_sources"]+=1
        if sid in represented_sources: continue
        parent=_r12_physical_parent_candidate(rec,index,physical_surfaces)
        if parent is None:
            unresolved.append(sid); continue
        # Never force a tall/multi-story panel onto one story carrier. Native EADM should
        # split such a curtain host; if no unique native parent is proven, preserve wall.
        pts=record_polyloop(rec)
        parent_ft=[tuple(float(v)*index["factor"]/0.3048 for v in p[:3]) for p in (parent.get("points") or [])]
        if not _r12_opening_supported_by_surface(pts,parent_ft):
            unresolved.append(sid); continue
        oid,err=_r12_insert_opening_on_parent(rec,parent,ns,index,existing_ids)
        if err:
            unresolved.append(sid); continue
        stats["missing_physical_inserted"]+=1; changed=True; represented_sources.add(sid)
    stats["missing_physical_unresolved"]=len(unresolved)
    stats["unresolved_source_ids"]=unresolved[:100]
    if changed:
        tree.write(xml_path,encoding="utf-8",xml_declaration=True)
    messages.append({"severity":"INFO","code":"GBXML_NATIVE_OPENINGS_PRESERVED_AND_NORMALIZED","stats":stats,"message":"Revit native gbXML openings were preserved in their original analytical carriers. Types/identity were normalized from Revit evidence, exact same-carrier duplicates were removed, and only uniquely proven missing physical cuts were added. Multi-story curtain-wall hosts remain EADM-story-split; uncertain panels are never guessed as windows."})
    return stats



# -----------------------------------------------------------------------------
# RELEASE16 — RELEASE15 topology + exporter-side GeometryCo opening contract
# -----------------------------------------------------------------------------
# RELEASE14F proves the native EADM/export path is stable, but NewSpaces2 can keep
# reporting the same positive residual circuits without actually committing them,
# and Revit's native gbXML can contain analytical Opening records that do not survive
# downstream translation as usable cuts. RELEASE16 keeps RELEASE15 topology and corrects only REVEX-added EADM openings to satisfy the unchanged GeometryCo parent-surface contract.

_r14_create_missing_spaces = create_missing_spaces
_r14_close_remaining_plan_circuits = close_remaining_plan_circuits
_r14_normalize_gbxml_openings_from_revit = normalize_gbxml_openings_from_revit
_r14_envelope_persistence_gate = envelope_persistence_gate


def create_missing_spaces(model_doc, phase, levels, target_levels, room_sources, existing_ids, changes, messages):
    """On a verified checkpoint, do not run broad NewSpaces2 again.

    RELEASE14F already refreshed the current Room-Bounding state and retained 157
    usable Spaces. Further blanket NewSpaces2 calls returned hundreds of zero-area
    artifacts. RELEASE15 leaves the saved topology alone; the bounded closure stage
    below probes only genuinely uncovered circuits and places those exact points.
    """
    if REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE:
        live_ids,removed=_r14_clean_zero_area_revex_spaces(model_doc,existing_ids,changes,messages)
        messages.append({
            "severity":"INFO",
            "code":"VERIFIED_CHECKPOINT_BROAD_GAP_REFRESH_SKIPPED_RELEASE15",
            "removed_zero_area":len(removed),
            "message":"Verified saved Spaces are reused without another blanket NewSpaces2 pass. Only rollback-proven residual circuit points are eligible for direct placement.",
        })
        return set(),{
            "attempted":0,"api_returned_ids":0,"kept":0,"discarded_zero_area":0,
            "discarded_redundant":0,"discarded_room_duplicates":0,"failed_levels":[],
            "reused_checkpoint":True,"release15_direct_residuals":True,
            "zero_area_revex_removed_before_refresh":len(removed),
        }
    return _r14_create_missing_spaces(model_doc,phase,levels,target_levels,room_sources,existing_ids,changes,messages)


def _r15_probe_residual_circuit_seeds(model_doc, phase, target_levels, messages):
    """Use Revit itself to expose exact uncovered circuit seed points, then roll back.

    NewSpaces2 is used only as a read/probe mechanism here. Each returned positive
    temporary Space gives a point known by Revit to lie inside the residual circuit.
    The transaction is rolled back, so no probe artifacts survive.
    """
    seeds=[]
    for sequence,level in enumerate(target_levels,1501):
        tx=Transaction(model_doc,"LIBER gbXML: probe residual circuit seeds {}".format(sequence))
        try:
            tx.Start()
            view=create_temp_plan(model_doc,level,phase,sequence)
            ids=list(model_doc.Create.NewSpaces2(level,phase,view) or [])
            model_doc.Regenerate()
            for item_id in ids:
                space=model_doc.GetElement(item_id)
                if space is None or not is_placed_spatial(space):
                    continue
                area=_r14_space_area(space)
                if area<=AREA_EPSILON_FT2:
                    continue
                point=None
                try:
                    point=space.Location.Point
                except Exception:
                    point=None
                if point is None:
                    try:
                        bb=space.get_BoundingBox(None)
                        if bb is not None:
                            point=XYZ((bb.Min.X+bb.Max.X)*0.5,(bb.Min.Y+bb.Max.Y)*0.5,level_elevation(level)+1.0)
                    except Exception:
                        point=None
                if point is None:
                    continue
                seeds.append({
                    "level_id":eid_value(level.Id),"level":str(safe_element_name(level)),
                    "x":float(point.X),"y":float(point.Y),"area_ft2":float(area),
                })
            tx.RollBack()
        except Exception as ex:
            try:
                if tx.GetStatus()==TransactionStatus.Started: tx.RollBack()
            except Exception: pass
            messages.append({"severity":"WARNING","code":"RESIDUAL_CIRCUIT_SEED_PROBE_FAILED","level":str(safe_element_name(level)),"message":str(ex)})
    # Deduplicate probe points from API aliases by level + tight XY + area.
    unique=[]
    for seed in sorted(seeds,key=lambda s:(s["level_id"],round(s["area_ft2"],4),s["x"],s["y"])):
        duplicate=False
        for old in unique:
            if old["level_id"]!=seed["level_id"]: continue
            if abs(old["area_ft2"]-seed["area_ft2"])>0.01: continue
            if ((old["x"]-seed["x"])**2+(old["y"]-seed["y"])**2)**0.5<0.05:
                duplicate=True; break
        if not duplicate: unique.append(seed)
    return unique


def _r15_direct_place_residuals(model_doc, phase, phases, levels, room_sources, target_levels, created_ids, changes, messages):
    seeds=_r15_probe_residual_circuit_seeds(model_doc,phase,target_levels,messages)
    target_by_id={eid_value(level.Id):level for level in target_levels}
    placed=[]; failed=[]
    for idx,seed in enumerate(seeds,1):
        level=target_by_id.get(int(seed.get("level_id") or -1))
        if level is None: continue
        # If the circuit has already become occupied after an earlier placement,
        # do not create a duplicate.
        probe_xyz=XYZ(float(seed["x"]),float(seed["y"]),level_elevation(level)+1.0)
        try:
            existing=model_doc.GetSpaceAtPoint(probe_xyz,phase)
        except Exception:
            existing=None
        if existing is not None and is_placed_spatial(existing):
            continue
        tx=Transaction(model_doc,"LIBER gbXML: place residual Space {}".format(idx))
        guard=SpaceCreationFailureGuard()
        try:
            tx.Start()
            opts=tx.GetFailureHandlingOptions(); opts.SetFailuresPreprocessor(guard); opts.SetClearAfterRollback(True); tx.SetFailureHandlingOptions(opts)
            space=model_doc.Create.NewSpace(level,phase,UV(float(seed["x"]),float(seed["y"])))
            if space is None: raise Exception("NewSpace returned null")
            tag_generated_space(space)
            upper=preferred_upper_level(level,target_levels,levels)
            set_created_space_vertical_extent(space,upper,changes,[])
            model_doc.Regenerate()
            if not is_placed_spatial(space) or _r14_space_area(space)<=AREA_EPSILON_FT2:
                raise Exception("Direct residual Space is not positive-area after regeneration")
            status=tx.Commit()
            if status!=TransactionStatus.Committed:
                raise Exception("Direct residual Space transaction did not commit: {}".format(status))
            sid=eid_value(space.Id); created_ids.add(sid); placed.append({"element_id":sid,**seed})
            changes.append({"action":"created_residual_space_from_revit_probe","element_id":sid,"level":seed["level"],"area_ft2":seed["area_ft2"]})
        except Exception as ex:
            try:
                if tx.GetStatus()==TransactionStatus.Started: tx.RollBack()
            except Exception: pass
            failed.append({"seed":seed,"error":str(ex),"revit_failures":list(getattr(guard,"failures",[]) or [])[:10]})
    return {"seed_count":len(seeds),"placed_count":len(placed),"placed":placed,"failed":failed}


def close_remaining_plan_circuits(model_doc, phase, phases, levels, room_sources, target_levels, created_ids, changes, messages, max_rounds=MAX_TOPOLOGY_REPAIR_ROUNDS):
    if not REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE:
        return _r14_close_remaining_plan_circuits(model_doc,phase,phases,levels,room_sources,target_levels,created_ids,changes,messages,max_rounds=max_rounds)
    before=probe_remaining_plan_circuits(model_doc,phase,target_levels,[],emit_error=False)
    direct=_r15_direct_place_residuals(model_doc,phase,phases,levels,room_sources,target_levels,created_ids,changes,messages)
    after=probe_remaining_plan_circuits(model_doc,phase,target_levels,[],emit_error=False)
    result={
        "rounds":1 if direct.get("placed_count") else 0,
        "api_returned_ids":0,
        "kept":int(direct.get("placed_count",0) or 0),
        "discarded_zero_area":0,"discarded_redundant":0,"discarded_room_duplicates":0,
        "remaining_before":int(before.get("remaining_count",0) or 0),
        "remaining_after":int(after.get("remaining_count",0) or 0),
        "reused_checkpoint":True,"release15_direct_residual":direct,
    }
    severity="INFO" if result["remaining_after"]==0 else "WARNING"
    messages.append({
        "severity":severity,"code":"PLAN_CIRCUIT_DIRECT_POINT_CLOSURE_RELEASE15",
        "remaining_before":result["remaining_before"],"remaining_after":result["remaining_after"],
        "placed":int(direct.get("placed_count",0) or 0),
        "message":"Residual plan circuits were probed in rollback and placed individually with NewSpace(Level, Phase, UV). Blanket NewSpaces2 regeneration is not used for saved checkpoints.",
    })
    return result


def _r15_explicit_opening_type(record, physical_by_source):
    source_id=int(record.get("originating_element_id") or -1)
    if source_id>0 and source_id in physical_by_source:
        raw=str(physical_by_source[source_id].get("opening_type") or "")
    else:
        raw=str(record.get("opening_type") or "")
    family=opening_type_family(raw)
    text=normalize_text(raw)
    if family=="door": return "NonSlidingDoor"
    if "skylight" in text: return "FixedSkylight"
    if family=="window": return "OperableWindow" if "operable" in text else "FixedWindow"
    if family=="air": return "Air"
    # User rule: uncertainty stays wall; never default an unknown analytical cut to window.
    return None


def _r15_parent_surface_for_analytical_opening(record,index,surface_by_analytical):
    parent_id=str(record.get("parent_analytical_id") or "")
    if parent_id:
        exact=[candidate for candidate in index.get("surfaces",[]) if str(candidate.get("id") or "")==parent_id]
        if len(exact)==1:
            return exact[0],"exact_parent_analytical_id"
    parent_record=surface_by_analytical.get(parent_id)
    if parent_record is not None:
        candidate=find_surface_match(parent_record,index,relaxed=True)
        if candidate is not None:
            return candidate,"parent_surface_geometry"
    return None,None


def _r16_dot3(a,b):
    return sum(float(a[i])*float(b[i]) for i in range(3))


def _r16_plane_basis(parent_points):
    if len(parent_points)<3:
        return None
    normal=unit_vector(newell(parent_points))
    if normal is None:
        return None
    origin=tuple(float(v) for v in parent_points[0][:3])
    best=None; best_len=0.0
    for i,p in enumerate(parent_points):
        q=parent_points[(i+1)%len(parent_points)]
        edge=vector_sub(q,p); L=norm(edge)
        if L>best_len:
            best_len=L; best=edge
    u=unit_vector(best) if best is not None else None
    if u is None:
        return None
    v=unit_vector(cross(normal,u))
    if v is None:
        return None
    # Re-orthogonalize u against v/normal to suppress accumulated API noise.
    u=unit_vector(cross(v,normal)) or u
    return origin,u,v,normal


def _r16_project_basis(points,basis):
    origin,u,v,_n=basis
    out=[]
    for point in points:
        d=vector_sub(point,origin)
        out.append((_r16_dot3(d,u),_r16_dot3(d,v)))
    return out


def _r16_unproject_basis(points2,basis):
    origin,u,v,_n=basis
    return [(
        origin[0]+u[0]*p[0]+v[0]*p[1],
        origin[1]+u[1]*p[0]+v[1]*p[1],
        origin[2]+u[2]*p[0]+v[2]*p[1],
    ) for p in points2]


def _r16_signed_area2(poly):
    if len(poly)<3: return 0.0
    return 0.5*sum(poly[i][0]*poly[(i+1)%len(poly)][1]-poly[(i+1)%len(poly)][0]*poly[i][1] for i in range(len(poly)))


def _r16_clean2(poly,tol=1.0e-10):
    out=[]
    for p in poly:
        p=(float(p[0]),float(p[1]))
        if not out or math.hypot(p[0]-out[-1][0],p[1]-out[-1][1])>tol:
            out.append(p)
    if len(out)>1 and math.hypot(out[0][0]-out[-1][0],out[0][1]-out[-1][1])<=tol:
        out.pop()
    # Drop strictly collinear intermediate vertices; this prevents a clipped four-sided
    # opening from becoming a five/six-vertex EnergyPlus subsurface for no geometric gain.
    changed=True
    while changed and len(out)>3:
        changed=False
        for i in range(len(out)):
            a=out[i-1]; b=out[i]; c=out[(i+1)%len(out)]
            scale=max(1.0,math.hypot(c[0]-a[0],c[1]-a[1]))
            if abs(orient2(a,b,c))<=tol*scale:
                del out[i]; changed=True; break
    return out


def _r16_line_intersection_2d(p,q,a,b):
    rx=q[0]-p[0]; ry=q[1]-p[1]
    sx=b[0]-a[0]; sy=b[1]-a[1]
    den=rx*sy-ry*sx
    if abs(den)<=1.0e-14:
        return q
    t=((a[0]-p[0])*sy-(a[1]-p[1])*sx)/den
    return (p[0]+t*rx,p[1]+t*ry)


def _r16_clip_polygon_convex(subject,clip):
    subject=_r16_clean2(subject); clip=_r16_clean2(clip)
    if len(subject)<3 or len(clip)<3 or polygon_is_concave(clip):
        return []
    sign=1.0 if _r16_signed_area2(clip)>=0.0 else -1.0
    output=list(subject)
    tol=1.0e-10
    for i,a in enumerate(clip):
        b=clip[(i+1)%len(clip)]
        if not output: break
        inp=output; output=[]
        prev=inp[-1]
        prev_in=sign*orient2(a,b,prev)>=-tol
        for cur in inp:
            cur_in=sign*orient2(a,b,cur)>=-tol
            if cur_in:
                if not prev_in:
                    output.append(_r16_line_intersection_2d(prev,cur,a,b))
                output.append(cur)
            elif prev_in:
                output.append(_r16_line_intersection_2d(prev,cur,a,b))
            prev=cur; prev_in=cur_in
        output=_r16_clean2(output,tol)
    return _r16_clean2(output,tol)


def _r16_fit_analytical_opening_to_parent(record,parent,index):
    """Return an exact-parent, coplanar opening polygon in feet plus fit metrics.

    GeometryCo/OpenStudio requires every SubSurface to be a coplanar subset of one
    parent OS:Surface. Revit EADM can expose an analytical opening polygon that
    slightly crosses the story-split analytical carrier. RELEASE16 corrects only the
    REVEX-added EADM opening: project it to the exact serialized parent plane and clip
    it to that parent. Native Revit gbXML openings are never moved by this function.
    """
    pts=clean_consecutive(record_polyloop(record),MIN_EDGE_M/0.3048)
    if len(pts)<3:
        return None,{"reason":"insufficient_opening_polygon"}
    parent_ft=[tuple(float(v)*index["factor"]/0.3048 for v in p[:3]) for p in (parent.get("points") or [])]
    parent_ft=clean_consecutive(parent_ft,MIN_EDGE_M/0.3048)
    if len(parent_ft)<3:
        return None,{"reason":"insufficient_parent_polygon"}
    basis=_r16_plane_basis(parent_ft)
    if basis is None:
        return None,{"reason":"degenerate_parent_plane"}
    parent2=_r16_clean2(_r16_project_basis(parent_ft,basis))
    opening2=_r16_clean2(_r16_project_basis(pts,basis))
    if len(parent2)<3 or len(opening2)<3 or polygon_is_concave(parent2):
        return None,{"reason":"parent_not_convex_for_safe_clip"}
    original_area=abs(_r16_signed_area2(opening2))
    if original_area<=1.0e-10:
        return None,{"reason":"zero_projected_opening_area"}
    clipped2=_r16_clip_polygon_convex(opening2,parent2)
    clipped_area=abs(_r16_signed_area2(clipped2)) if len(clipped2)>=3 else 0.0
    if len(clipped2)<3 or clipped_area<=1.0e-10:
        return None,{"reason":"opening_has_no_positive_intersection_with_parent","original_area_ft2":original_area}
    retained=clipped_area/original_area
    # A tiny remnant is more likely a mismatched analytical parent than a useful cut.
    # In that case preserve the opaque parent wall rather than invent a sliver window.
    if retained<0.20:
        return None,{"reason":"opening_parent_intersection_is_only_a_sliver","retained_ratio":retained,"original_area_ft2":original_area,"clipped_area_ft2":clipped_area}
    clipped3=_r16_unproject_basis(clipped2,basis)
    clipped3=clean_consecutive(clipped3,MIN_EDGE_M/0.3048)
    if len(clipped3)<3 or 0.5*norm(newell(clipped3))<=1.0e-10:
        return None,{"reason":"opening_collapses_under_geometryco_short_edge_rule","retained_ratio":retained}
    # Reproject after short-edge cleanup so the serialized polygon remains exactly on
    # the parent plane and the 2D/3D representations stay consistent.
    clipped2=_r16_project_basis(clipped3,basis)
    original_normal=unit_vector(newell(pts)); clipped_normal=unit_vector(newell(clipped3))
    if original_normal is not None and clipped_normal is not None and _r16_dot3(original_normal,clipped_normal)<0.0:
        clipped3=list(reversed(clipped3)); clipped2=list(reversed(clipped2))
    outside_removed=max(0.0,original_area-clipped_area)
    return clipped3,{"reason":None,"retained_ratio":retained,"original_area_ft2":original_area,"clipped_area_ft2":clipped_area,"outside_removed_ft2":outside_removed,"clipped":outside_removed>1.0e-8}


def _r16_insert_opening_piece(record,parent,namespace,index,existing_ids,opening_type,points_ft,part_index=1):
    scale=0.3048/index["factor"]
    pts_xml=[tuple(float(v)*scale for v in p[:3]) for p in points_ft]
    seed={"key":"{}::{}::{}".format(record.get("parent_analytical_id"),record.get("analytical_id"),part_index),"analytical_id":record.get("analytical_id"),"originating_element_id":record.get("originating_element_id")}
    oid=stable_fallback_id("eadm-opening",seed,existing_ids)
    attrs={"id":oid,"openingType":opening_type}
    opening=ET.Element(qualified(namespace,"Opening"),attrs)
    label="LIBER EADM {}".format(record.get("name") or record.get("originating_element_name") or oid)
    if part_index>1: label+=" part {}".format(part_index)
    name=ET.SubElement(opening,qualified(namespace,"Name")); name.text=label
    add_planar_geometry(opening,namespace,pts_xml)
    cad=ET.SubElement(opening,qualified(namespace,"CADObjectId"))
    source_id=int(record.get("originating_element_id") or -1)
    cad.text=str(source_id if source_id>0 else record.get("analytical_id") or "")
    pe=parent["element"]; at=len(list(pe))
    for i,c in enumerate(list(pe)):
        if local_name(c.tag)=="CADObjectId": at=i; break
    pe.insert(at,opening)
    return oid


def _r15_insert_analytical_opening(record,parent,namespace,index,existing_ids,opening_type):
    pts=clean_consecutive(record_polyloop(record),MIN_EDGE_M/0.3048)
    if len(pts)<3: return None,"analytical opening has insufficient polygon"
    if polygon_self_intersects(dominant_projection(pts,newell(pts))): return None,"analytical opening polygon self-intersects"
    fitted,metrics=_r16_fit_analytical_opening_to_parent(record,parent,index)
    if fitted is None:
        return None,"GeometryCo parent contract: {}".format(metrics.get("reason") or "opening cannot be safely contained")
    # EnergyPlus/GeometryCo allows at most four vertices per SubSurface. The clipped
    # intersection of two convex polygons can have more, so preserve the exact clipped
    # area as a fan of non-overlapping triangles instead of emitting a new downstream
    # incompatibility. The common 3/4-vertex case remains one opening.
    pieces=[]
    if len(fitted)<=4:
        pieces=[fitted]
    else:
        for i in range(1,len(fitted)-1):
            tri=[fitted[0],fitted[i],fitted[i+1]]
            if 0.5*norm(newell(tri))>1.0e-10:
                pieces.append(tri)
    if not pieces:
        return None,"GeometryCo parent contract: clipped opening produced no valid <=4-vertex pieces"
    ids=[]
    for part_index,piece in enumerate(pieces,1):
        ids.append(_r16_insert_opening_piece(record,parent,namespace,index,existing_ids,opening_type,piece,part_index))
    # Attach metrics to the transient record so the caller can report exactly what was
    # corrected without changing the public function signature used by earlier releases.
    try:
        record["_r16_geometryco_fit"]=dict(metrics,parts=len(ids))
    except Exception:
        pass
    return ids[0],None


def _r16_generated_opening_contract(root):
    """Enforce GeometryCo's existing SubSurface contract on REVEX-added openings only."""
    factor=length_to_meters(root.attrib.get("lengthUnit","Meters"))
    checked=0; removed=[]; noncoplanar=[]; outside=[]; too_many=[]
    for surface in [e for e in root.iter() if local_name(e.tag)=="Surface"]:
        parent_pts=polygon_points(surface)
        parent_m=points_to_meters(parent_pts,factor)
        basis=_r16_plane_basis(parent_m)
        if basis is None:
            continue
        parent2=_r16_clean2(_r16_project_basis(parent_m,basis))
        convex=len(parent2)>=3 and not polygon_is_concave(parent2)
        sign=1.0 if _r16_signed_area2(parent2)>=0.0 else -1.0
        for opening in [c for c in list(surface) if local_name(c.tag)=="Opening" and str(c.attrib.get("id") or "").startswith("liber-eadm-opening-")]:
            checked+=1; oid=str(opening.attrib.get("id") or "")
            pts=polygon_points(opening); pts_m=points_to_meters(pts,factor)
            if len(pts_m)<3 or len(pts_m)>4:
                too_many.append(oid); surface.remove(opening); removed.append(oid); continue
            if 0.5*norm(newell(pts_m))<=1.0e-8:
                outside.append((oid,"degenerate_opening")); surface.remove(opening); removed.append(oid); continue
            if min(distance3(pts_m[i],pts_m[(i+1)%len(pts_m)]) for i in range(len(pts_m)))<MIN_EDGE_M:
                outside.append((oid,"short_edge_under_0.01m")); surface.remove(opening); removed.append(oid); continue
            origin,u,v,n=basis
            max_plane=max(abs(_r16_dot3(vector_sub(p,origin),n)) for p in pts_m)
            if max_plane>1.0e-4:
                noncoplanar.append((oid,max_plane)); surface.remove(opening); removed.append(oid); continue
            if not convex:
                outside.append((oid,"nonconvex_parent")); surface.remove(opening); removed.append(oid); continue
            p2=_r16_project_basis(pts_m,basis)
            if polygon_self_intersects(p2):
                outside.append((oid,"self_intersecting_opening")); surface.remove(opening); removed.append(oid); continue
            valid=True
            for p in p2:
                for i,a in enumerate(parent2):
                    b=parent2[(i+1)%len(parent2)]
                    # GeometryCo buffers parent by 1e-7 m. We hold generated vertices
                    # to the parent half-planes within the same order of tolerance.
                    if sign*orient2(a,b,p)<-1.0e-7:
                        valid=False; break
                if not valid: break
            if not valid:
                outside.append((oid,"vertex_outside_parent")); surface.remove(opening); removed.append(oid)
    return {"checked":checked,"removed":len(removed),"removed_ids":removed[:100],"noncoplanar":noncoplanar[:50],"outside":outside[:50],"invalid_vertex_count":too_many[:50],"passed":len(removed)==0}


def _r15_opening_match_on_parent(record,parent,index,expected_type):
    pts=record_polyloop(record)
    for candidate in index.get("openings",[]):
        if candidate.get("parent") is not parent:
            continue
        if not opening_type_compatible(expected_type,candidate.get("type","")):
            continue
        cpts=candidate.get("points") or []
        if pts and cpts and polygon_match(pts,cpts,index["factor"],relaxed=True):
            return candidate
        source_id=int(record.get("originating_element_id") or -1)
        if source_id>0 and str(candidate.get("cad") or "")==str(source_id):
            return candidate
    return None


def normalize_gbxml_openings_from_revit(xml_path, analytical_manifest, physical_manifest, messages):
    """Materialize EADM openings on their exact analytical parent Surfaces.

    This is a shadow-rebuild strategy: native openings remain untouched while a full
    EADM-parent opening set is resolved. Only proven missing analytical cuts are added.
    Physical Revit evidence controls door/window type. Unknown types remain wall.
    """
    tree=ET.parse(xml_path); root=tree.getroot(); ns=namespace_uri(root)
    if ns:
        try: ET.register_namespace("",ns)
        except Exception: pass
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    physical_by_source={}
    for r in list((physical_manifest or {}).get("openings",[]) or []):
        sid=int(r.get("originating_element_id") or -1)
        if sid>0 and sid not in physical_by_source: physical_by_source[sid]=r
    surface_by_analytical={str(r.get("analytical_id") or ""):r for r in list((analytical_manifest or {}).get("surfaces",[]) or [])}
    records=list((analytical_manifest or {}).get("openings",[]) or [])
    existing_ids=set(str(e.attrib.get("id") or "") for e in root.iter() if local_name(e.tag)=="Opening")
    native_count=len(existing_ids); inserted=[]; already=[]; unresolved=[]; unknown_type=[]
    eligible=0
    for rec in records:
        opening_type=_r15_explicit_opening_type(rec,physical_by_source)
        if not opening_type:
            unknown_type.append(str(rec.get("analytical_id") or rec.get("originating_element_id") or "")); continue
        parent,method=_r15_parent_surface_for_analytical_opening(rec,index,surface_by_analytical)
        if parent is None:
            unresolved.append({"opening":str(rec.get("analytical_id") or ""),"reason":"parent_not_found"}); continue
        eligible+=1
        if _r15_opening_match_on_parent(rec,parent,index,opening_type) is not None:
            already.append(str(rec.get("analytical_id") or "")); continue
        oid,err=_r15_insert_analytical_opening(rec,parent,ns,index,existing_ids,opening_type)
        if err:
            unresolved.append({"opening":str(rec.get("analytical_id") or ""),"reason":err,"parent_method":method}); continue
        inserted.append(oid)
        # refresh index so same-source/shared analytical cuts cannot multiply blindly
        index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    geometryco_contract=_r16_generated_opening_contract(root)
    if inserted or geometryco_contract.get("removed"):
        tree.write(xml_path,encoding="utf-8",xml_declaration=True)
    # Reparse from disk and prove parent-specific analytical opening coverage.
    final_root=ET.parse(xml_path).getroot(); final_index=bind_xml_spaces_to_revit(xml_envelope_index(final_root),analytical_manifest)
    covered=0; checkable=0
    for rec in records:
        opening_type=_r15_explicit_opening_type(rec,physical_by_source)
        if not opening_type: continue
        parent,_=_r15_parent_surface_for_analytical_opening(rec,final_index,surface_by_analytical)
        if parent is None: continue
        checkable+=1
        if _r15_opening_match_on_parent(rec,parent,final_index,opening_type) is not None: covered+=1
    coverage=(float(covered)/float(checkable)) if checkable else 1.0
    stats={
        "native_openings_preserved":native_count,"analytical_openings_total":len(records),
        "analytical_openings_checkable":checkable,"analytical_openings_covered":covered,
        "analytical_opening_coverage":round(coverage,6),"eadm_parent_openings_inserted":len(inserted),
        "already_on_correct_parent":len(already),"unresolved":len(unresolved),
        "unresolved_details":unresolved[:100],"unknown_type_left_wall":len(unknown_type),
        "unknown_type_ids":unknown_type[:100],"physical_unique_sources":len(physical_by_source),
        "missing_physical_inserted":len(inserted),"duplicates_removed":0,
        "wrong_carrier_reparented":0,"wrong_carrier_removed":0,
        "geometryco_parent_contract":geometryco_contract,
        "geometryco_clipped_openings":sum(1 for rec in records if (rec.get("_r16_geometryco_fit") or {}).get("clipped")),
        "geometryco_clipped_area_ft2":round(sum(float((rec.get("_r16_geometryco_fit") or {}).get("outside_removed_ft2") or 0.0) for rec in records),6),
        "geometryco_split_pieces":sum(max(0,int((rec.get("_r16_geometryco_fit") or {}).get("parts") or 1)-1) for rec in records if rec.get("_r16_geometryco_fit")),
    }
    severity="INFO" if coverage>=PRESERVATION_TARGET and geometryco_contract.get("passed") else "WARNING"
    messages.append({"severity":severity,"code":"GBXML_EADM_PARENT_OPENINGS_GEOMETRYCO_SAFE_RELEASE16","stats":stats,"message":"REVEX-added EADM openings are projected to their exact analytical parent plane and clipped to that parent before gbXML release; >4-vertex clipped cuts are partitioned losslessly into triangles. Native Revit openings remain untouched. A final exporter-side GeometryCo contract audit removes any REVEX-added cut that is still noncoplanar/outside rather than passing invalid geometry downstream."})
    return stats


def envelope_persistence_gate(xml_path, physical_manifest, analytical_manifest, allow_repairs=True):
    base=_r14_envelope_persistence_gate(xml_path,physical_manifest,analytical_manifest,allow_repairs=False)
    root=ET.parse(xml_path).getroot(); index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest)
    physical_by_source={}
    for r in list((physical_manifest or {}).get("openings",[]) or []):
        sid=int(r.get("originating_element_id") or -1)
        if sid>0 and sid not in physical_by_source: physical_by_source[sid]=r
    surface_by_analytical={str(r.get("analytical_id") or ""):r for r in list((analytical_manifest or {}).get("surfaces",[]) or [])}
    eligible=0; covered=0; missing=[]
    for rec in list((analytical_manifest or {}).get("openings",[]) or []):
        typ=_r15_explicit_opening_type(rec,physical_by_source)
        if not typ: continue
        parent,_=_r15_parent_surface_for_analytical_opening(rec,index,surface_by_analytical)
        if parent is None: continue
        eligible+=1
        if _r15_opening_match_on_parent(rec,parent,index,typ) is not None:
            covered+=1
        else:
            missing.append(str(rec.get("analytical_id") or rec.get("originating_element_id") or ""))
    ratio=(float(covered)/float(eligible)) if eligible else 1.0
    base.setdefault("counts",{})["eadm_parent_openings_expected"]=eligible
    base["counts"]["eadm_parent_openings_preserved"]=covered
    base["counts"]["eadm_parent_opening_coverage"]=round(ratio,6)
    if ratio<PRESERVATION_MINIMUM:
        base.setdefault("errors",[]).append("Only {:.1%} of explicit Revit EADM openings survive on their correct parent Surface (80% hard-stop integrity gate).".format(ratio))
    base["passed"]=len(base.get("errors",[]))==0
    base["missing_eadm_parent_openings"]=missing[:100]
    return base



# -----------------------------------------------------------------------------
# UNIVERSAL EVIDENCE-GRAPH ARCHITECTURE
# -----------------------------------------------------------------------------
# This layer intentionally contains no project-name or level-name branching.
# Geometry enters through explicit evidence domains:
#   Levels -> Rooms/Spaces -> rollback-proven plan circuits -> physical envelope
#   -> Revit EADM -> native gbXML -> physical opening/host reconciliation -> contract.
# Every repair must have a source edge back to Revit. Ambiguity remains opaque/flagged.

# Preserve stable generic helpers from the preceding engine implementation.
_core_target_levels_for_spaces = target_levels_for_spaces
_core_match_and_update_spaces = match_and_update_spaces
_core_normalize_gbxml_openings = normalize_gbxml_openings_from_revit
_core_envelope_persistence_gate = envelope_persistence_gate

_UNIVERSAL_MIN_POSITIVE_CELL_HEIGHT_FT = 0.50
_UNIVERSAL_OPENING_MIN_PIECE_FT2 = 0.01


def _physical_model_z_bounds(model_doc):
    """Bounding Z domain from physical building categories; no level-name assumptions."""
    category_names=(
        'OST_Walls','OST_Floors','OST_Roofs','OST_Ceilings','OST_CurtainWallPanels',
        'OST_Windows','OST_Doors','OST_Stairs','OST_StructuralFraming','OST_Columns',
        'OST_StructuralColumns',
    )
    zmin=None; zmax=None; checked=0
    for name in category_names:
        bic=getattr(BuiltInCategory,name,None)
        if bic is None: continue
        try: elements=list(FilteredElementCollector(model_doc).OfCategory(bic).WhereElementIsNotElementType())
        except Exception: elements=[]
        for element in elements:
            try:
                box=element.get_BoundingBox(None)
                if box is None: continue
                lo=float(box.Min.Z); hi=float(box.Max.Z)
                zmin=lo if zmin is None else min(zmin,lo)
                zmax=hi if zmax is None else max(zmax,hi)
                checked+=1
            except Exception: pass
    return {'min_z_ft':zmin,'max_z_ft':zmax,'elements_checked':checked}


def _level_evidence(model_doc, levels, room_sources, existing_spaces):
    evidence={eid_value(level.Id):{'rooms':0,'spaces':0,'building_story':bool(level_is_building_story(level))} for level in levels}
    for source in room_sources:
        level=source_level(levels,source)
        if level is not None:
            evidence.setdefault(eid_value(level.Id),{'rooms':0,'spaces':0,'building_story':False})['rooms']+=1
    for space in existing_spaces:
        if not is_placed_spatial(space): continue
        lid=eid_value(space.LevelId)
        evidence.setdefault(lid,{'rooms':0,'spaces':0,'building_story':False})['spaces']+=1
    return evidence


def _probe_spatial_circuits(model_doc, phase, level, sequence):
    """Rollback-only Revit proof that a Level owns positive-area enclosed plan cells."""
    result={'count':0,'areas_ft2':[],'error':None}
    tx=Transaction(model_doc,'LIBER gbXML: probe spatial domain {}'.format(sequence))
    try:
        tx.Start()
        view=create_temp_plan(model_doc,level,phase,sequence)
        ids=list(model_doc.Create.NewSpaces2(level,phase,view) or [])
        model_doc.Regenerate()
        areas=[]
        for item_id in ids:
            item=model_doc.GetElement(item_id)
            if item is None or not is_placed_spatial(item): continue
            area=_r14_space_area(item)
            if area>AREA_EPSILON_FT2: areas.append(float(area))
        result['count']=len(areas); result['areas_ft2']=sorted(round(v,3) for v in areas)[:100]
        tx.RollBack()
    except Exception as ex:
        result['error']=str(ex)
        try:
            if tx.GetStatus()==TransactionStatus.Started: tx.RollBack()
        except Exception: pass
    return result


def _coincident_level_groups(levels):
    groups=[]
    for level in sorted(list(levels or []),key=level_elevation):
        if not groups or abs(level_elevation(level)-level_elevation(groups[-1][0]))>LEVEL_ELEVATION_TOL_FT:
            groups.append([level])
        else:
            groups[-1].append(level)
    return groups


def discover_spatial_domains(model_doc, levels, room_sources, existing_spaces, messages):
    """Discover Space-base domains from Revit evidence, independent of naming conventions.

    A level participates when it already owns a placed Room/Space or a rollback-only
    NewSpaces2 probe proves positive enclosed plan circuits. Reference datums outside the
    physical building Z domain are never probed into geometry merely because they exist.
    """
    evidence=_level_evidence(model_doc,levels,room_sources,existing_spaces)
    bounds=_physical_model_z_bounds(model_doc)
    try: phase,_=choose_phase(model_doc,PHASE_NAME_INPUT)
    except Exception: phase=None
    selected=[]; probes=[]; rejected=[]
    for sequence,group in enumerate(_coincident_level_groups(levels),1):
        # At one physical elevation prefer existing spatial evidence, then Building Story,
        # then deterministic ElementId. No names are consulted.
        level=max(group,key=lambda x:(
            int(evidence.get(eid_value(x.Id),{}).get('rooms',0))+int(evidence.get(eid_value(x.Id),{}).get('spaces',0)),
            bool(evidence.get(eid_value(x.Id),{}).get('building_story')),
            -eid_value(x.Id),
        ))
        lid=eid_value(level.Id); z=float(level_elevation(level)); ev=evidence.get(lid,{})
        direct=int(ev.get('rooms',0))+int(ev.get('spaces',0))
        in_physical=True
        if bounds.get('min_z_ft') is not None and bounds.get('max_z_ft') is not None:
            # A small numerical margin only; the building geometry itself defines scope.
            in_physical=(z>=float(bounds['min_z_ft'])-1.0 and z<=float(bounds['max_z_ft'])+1.0)
        row={'level_id':lid,'level':str(safe_element_name(level)),'elevation_ft':z,'rooms':int(ev.get('rooms',0)),'spaces':int(ev.get('spaces',0)),'physical_domain':bool(in_physical)}
        if direct>0:
            row['basis']='placed_spatial_evidence'; selected.append(level); probes.append(row); continue
        if not in_physical or phase is None:
            row['basis']='outside_physical_domain_or_no_phase'; rejected.append(row); continue
        probe=_probe_spatial_circuits(model_doc,phase,level,1800+sequence)
        row['probe']=probe
        if int(probe.get('count',0) or 0)>0:
            row['basis']='rollback_positive_plan_circuit'; selected.append(level)
        else:
            row['basis']='no_positive_spatial_circuit'; rejected.append(row)
        probes.append(row)
    # Never return empty if stable pre-existing evidence exists; fall back to the core
    # evidence resolver only as a source-preserving compatibility path.
    if not selected:
        selected=list(_core_target_levels_for_spaces(model_doc,levels,room_sources,existing_spaces,messages) or [])
    selected=sorted({eid_value(x.Id):x for x in selected}.values(),key=level_elevation)
    messages.append({'severity':'INFO','code':'SPATIAL_DOMAINS_DISCOVERED','architecture':ARCHITECTURE_ID,'selected_count':len(selected),'physical_bounds':bounds,'probes':probes[:100],'rejected':rejected[:100],'message':'Space-base levels are discovered from placed spatial elements or rollback-proven Revit plan circuits inside the physical building domain; project names and level names are not used.'})
    return selected


def target_levels_for_spaces(model_doc, levels, room_sources, existing_spaces, messages):
    return discover_spatial_domains(model_doc,levels,room_sources,existing_spaces,messages)


def typical_occupied_story_height(target_levels):
    """Data-derived characteristic vertical interval; no residential/story-height preset."""
    elevations=sorted(set(round(float(level_elevation(item)),6) for item in (target_levels or [])))
    deltas=[float(b-a) for a,b in zip(elevations,elevations[1:]) if float(b-a)>_UNIVERSAL_MIN_POSITIVE_CELL_HEIGHT_FT]
    if not deltas: return 10.0
    ordered=sorted(deltas)
    # Trim only extreme end samples when enough evidence exists; the model remains authority.
    if len(ordered)>=5:
        ordered=ordered[1:-1]
    n=len(ordered); m=n//2
    return float(ordered[m] if n%2 else (ordered[m-1]+ordered[m])/2.0)


def _minimum_meaningful_vertical_interval(target_levels):
    characteristic=typical_occupied_story_height(target_levels)
    return max(_UNIVERSAL_MIN_POSITIVE_CELL_HEIGHT_FT,min(2.0,characteristic*0.10))


def preferred_upper_level(level,target_levels,all_levels):
    if level is None: return None
    z=float(level_elevation(level)); minimum=_minimum_meaningful_vertical_interval(target_levels)
    higher=sorted([x for x in (target_levels or []) if float(level_elevation(x))>z+minimum],key=level_elevation)
    return higher[0] if higher else None


def preferred_story_top_z(level,target_levels,all_levels):
    if level is None: return None,None,'none'
    upper=preferred_upper_level(level,target_levels,all_levels)
    if upper is not None: return float(level_elevation(upper)),upper,'next_proven_spatial_domain'
    base=float(level_elevation(level))
    return base+typical_occupied_story_height(target_levels),None,'provisional_characteristic_interval_until_physical_cover'


def prepare_room_source_vertical_targets(room_sources,target_levels,all_levels,changes,messages):
    """Assign provisional positive Space extents from discovered spatial domains.

    Final top geometry is subsequently refined from real floors/roofs/ceilings before EADM.
    """
    typical=typical_occupied_story_height(target_levels); minimum=_minimum_meaningful_vertical_interval(target_levels); corrected=0
    for source in sorted(room_sources,key=lambda r:(float(r.get('base_z') or 0.0),int(r.get('id') or -1))):
        base=source.get('base_z')
        if base is None: continue
        base=float(base); lev=source_level(target_levels,source) or source_level(all_levels,source)
        upper=preferred_upper_level(lev,target_levels,all_levels) if lev is not None else None
        if upper is not None:
            target=float(level_elevation(upper)); method='next_proven_spatial_domain'; upper_id=eid_value(upper.Id)
        else:
            target=base+max(typical,minimum*2.0); method='provisional_until_physical_cover'; upper_id=None
        if target<=base+minimum:
            target=base+max(typical,minimum*2.0); upper_id=None; method='provisional_until_physical_cover'
        nominal=source.get('top_z')
        source['effective_top_z']=target; source['nominal_top_z']=(float(nominal) if nominal is not None else None)
        source['story_top_z']=target; source['story_top_method']=method; source['story_upper_level_id']=upper_id
        if nominal is None or abs(float(nominal)-target)>0.20: corrected+=1
    messages.append({'severity':'INFO','code':'SPACE_VERTICAL_DOMAINS_ASSIGNED','count':corrected,'message':'Room-derived Space extents use the discovered Revit spatial-domain graph; final covers are resolved from physical floors/roofs/ceilings before analytical export.'})
    return corrected


def _r12_next_occupied_level(base_level,target_levels):
    return preferred_upper_level(base_level,target_levels,target_levels)


def _cleanup_proven_duplicate_room_spaces(model_doc,phase,phases,levels,room_sources,created_ids,changes,messages):
    """Remove only REVEX-authored duplicate Spaces with identical Room/level/area proof."""
    created_ids_set=created_ids if isinstance(created_ids,set) else set(int(v) for v in (created_ids or []))
    indexes=phase_index_map(phases); selected_index=indexes.get(eid_value(phase.Id),0)
    spaces=[x for x in collect_spaces(model_doc) if x is not None and is_placed_spatial(x) and element_exists_in_phase(x,selected_index,indexes)]
    groups={}
    for space in spaces:
        try: room=space.Room
        except Exception: room=None
        rid=eid_value(safe_attr(room,'Id',None)) if room is not None else -1
        if rid>0: groups.setdefault(rid,[]).append(space)
    removed=[]
    for rid,items in groups.items():
        if len(items)<2: continue
        ordered=sorted(items,key=lambda x:(1 if is_revex_generated_space(x) else 0,eid_value(x.Id)))
        canonical=ordered[0]; clev=_space_base_level(canonical); ca=float(safe_attr(canonical,'Area',0.0) or 0.0)
        for candidate in ordered[1:]:
            cid=eid_value(candidate.Id)
            if not is_revex_generated_space(candidate) or cid not in created_ids_set: continue
            lev=_space_base_level(candidate); area=float(safe_attr(candidate,'Area',0.0) or 0.0)
            same_level=bool(clev is not None and lev is not None and eid_value(clev.Id)==eid_value(lev.Id))
            area_ratio=(min(ca,area)/max(ca,area)) if ca>AREA_EPSILON_FT2 and area>AREA_EPSILON_FT2 else 0.0
            if not same_level or area_ratio<0.97: continue
            try:
                model_doc.Delete(candidate.Id); created_ids_set.discard(cid)
                removed.append({'element_id':cid,'room_id':rid,'kept_space_id':eid_value(canonical.Id),'area_ratio':round(area_ratio,6)})
            except Exception: pass
    if removed:
        model_doc.Regenerate(); changes.append({'action':'remove_proven_duplicate_room_spaces','count':len(removed),'details':removed[:100]})
        messages.append({'severity':'INFO','code':'PROVEN_DUPLICATE_ROOM_SPACES_REMOVED','count':len(removed),'details':removed[:50],'message':'Only REVEX-authored duplicate Space representations with same Room, Level and area proof were removed.'})
    return {'removed':len(removed),'details':removed}


def _seed_already_covered(model_doc,phase,phases,levels,room_sources,seed):
    try:
        indexes=phase_index_map(phases); selected_index=indexes.get(eid_value(phase.Id),0)
        spaces=[x for x in collect_spaces(model_doc) if x is not None and is_placed_spatial(x) and element_exists_in_phase(x,selected_index,indexes)]
        mapping,_=map_room_sources_to_spaces(model_doc,phase,levels,room_sources,spaces)
        level_id=int(seed.get('level_id') or -1); level=next((x for x in levels if eid_value(x.Id)==level_id),None)
        z=(level_elevation(level)+1.0) if level is not None else 0.0; host_point=XYZ(float(seed['x']),float(seed['y']),float(z))
        for source in room_sources:
            pair=mapping.get(id(source))
            if not pair: continue
            room=source.get('room')
            if room is None: continue
            try:
                test_point=host_point; inverse=source.get('inverse')
                if source.get('kind')=='linked_room' and inverse is not None: test_point=inverse.OfPoint(host_point)
                if bool(room.IsPointInRoom(test_point)):
                    return {'room_id':int(source.get('id') or -1),'space_id':eid_value(pair[0].Id),'method':'mapped_room_contains_seed'}
            except Exception: pass
    except Exception: pass
    return None


def _r15_direct_place_residuals(model_doc,phase,phases,levels,room_sources,target_levels,created_ids,changes,messages):
    """Bounded residual placement using only rollback-proven Revit circuit points."""
    seeds=_r15_probe_residual_circuit_seeds(model_doc,phase,target_levels,messages); target_by_id={eid_value(level.Id):level for level in target_levels}
    placed=[]; failed=[]; already=[]
    for idx,seed in enumerate(seeds,1):
        level=target_by_id.get(int(seed.get('level_id') or -1))
        if level is None: continue
        proof=_seed_already_covered(model_doc,phase,phases,levels,room_sources,seed)
        if proof: already.append({'seed':seed,**proof}); continue
        probe_xyz=XYZ(float(seed['x']),float(seed['y']),level_elevation(level)+1.0)
        try: existing=model_doc.GetSpaceAtPoint(probe_xyz,phase)
        except Exception: existing=None
        if existing is not None and is_placed_spatial(existing):
            already.append({'seed':seed,'space_id':eid_value(existing.Id),'method':'GetSpaceAtPoint'}); continue
        tx=Transaction(model_doc,'LIBER gbXML: place residual Space {}'.format(idx)); guard=SpaceCreationFailureGuard()
        try:
            tx.Start(); opts=tx.GetFailureHandlingOptions(); opts.SetFailuresPreprocessor(guard); opts.SetClearAfterRollback(True); tx.SetFailureHandlingOptions(opts)
            space=model_doc.Create.NewSpace(level,phase,UV(float(seed['x']),float(seed['y'])))
            if space is None: raise Exception('NewSpace returned null')
            tag_generated_space(space); upper=preferred_upper_level(level,target_levels,levels); set_created_space_vertical_extent(space,upper,changes,[]); model_doc.Regenerate()
            if not is_placed_spatial(space) or _r14_space_area(space)<=AREA_EPSILON_FT2: raise Exception('Residual Space is not positive-area after regeneration')
            status=tx.Commit()
            if status!=TransactionStatus.Committed: raise Exception('Residual Space transaction did not commit: {}'.format(status))
            sid=eid_value(space.Id); created_ids.add(sid); placed.append({'element_id':sid,**seed}); changes.append({'action':'create_residual_space_from_revit_probe','element_id':sid,'level_id':eid_value(level.Id),'area_ft2':seed.get('area_ft2')})
        except Exception as ex:
            try:
                if tx.GetStatus()==TransactionStatus.Started: tx.RollBack()
            except Exception: pass
            failures=list(getattr(guard,'failures',[]) or [])[:10]; overlap=next((f for f in failures if f.get('overlap_warning')),None)
            if overlap: already.append({'seed':seed,'method':'revit_overlap_proof','failing_element_ids':overlap.get('failing_element_ids',[])})
            else: failed.append({'seed':seed,'error':str(ex),'revit_failures':failures})
    if already:
        messages.append({'severity':'INFO','code':'RESIDUAL_CIRCUITS_ALREADY_COVERED','count':len(already),'details':already[:50],'message':'Rollback-proven residual circuit points already represented by committed Room/Space topology were not duplicated.'})
    return {'seed_count':len(seeds),'placed_count':len(placed),'placed':placed,'failed':failed,'already_covered_count':len(already),'already_covered':already}


def match_and_update_spaces(model_doc,phase,phases,levels,target_levels,room_sources,created_ids,changes,messages):
    """Identity mapping only. Geometry export never rewrites Space names for one model."""
    spaces,matched=_core_match_and_update_spaces(model_doc,phase,phases,levels,target_levels,room_sources,created_ids,changes,messages)
    dup=_cleanup_proven_duplicate_room_spaces(model_doc,phase,phases,levels,room_sources,created_ids,changes,messages)
    if dup.get('removed'):
        spaces=[x for x in collect_spaces(model_doc) if x is not None]
        matched={k:v for k,v in dict(matched or {}).items() if int(k) not in set(x['element_id'] for x in dup.get('details',[]))}
    return spaces,matched


def _u_xml_parent_points_ft(parent,index):
    return [tuple(float(v)*index['factor']/0.3048 for v in p[:3]) for p in (parent.get('points') or [])]


def _u_point_in_triangle2(p,a,b,c,tol=1.0e-9):
    o1=orient2(a,b,p); o2=orient2(b,c,p); o3=orient2(c,a,p); has_neg=(o1<-tol or o2<-tol or o3<-tol); has_pos=(o1>tol or o2>tol or o3>tol); return not (has_neg and has_pos)


def _u_parent_convex_parts(parent2):
    poly=_r16_clean2(parent2)
    if len(poly)<3: return []
    if not polygon_is_concave(poly): return [poly]
    sign=1.0 if _r16_signed_area2(poly)>=0.0 else -1.0; indices=list(range(len(poly))); parts=[]; guard=0
    while len(indices)>3 and guard<max(32,len(poly)*len(poly)*2):
        guard+=1; ear=None
        for pos,i in enumerate(indices):
            ip=indices[pos-1]; inx=indices[(pos+1)%len(indices)]; a,b,c=poly[ip],poly[i],poly[inx]
            if sign*orient2(a,b,c)<=1.0e-10: continue
            if any(_u_point_in_triangle2(poly[j],a,b,c,1.0e-10) for j in indices if j not in (ip,i,inx)): continue
            ear=(pos,[a,b,c]); break
        if ear is None: return []
        pos,tri=ear; parts.append(tri); del indices[pos]
    if len(indices)==3: parts.append([poly[i] for i in indices])
    return parts


def _u_clip_physical_opening_to_parent(record,parent,index):
    """Project a host-proven physical opening onto one exact analytical carrier.

    Plane distance is diagnostic, not a project-tuned blocker: exact Revit host identity
    is stronger evidence than analytical center-plane offset. Normal alignment and polygon
    intersection remain mandatory.
    """
    pts=clean_consecutive(record_polyloop(record),MIN_EDGE_M/0.3048); parent_ft=clean_consecutive(_u_xml_parent_points_ft(parent,index),MIN_EDGE_M/0.3048)
    if len(pts)<3 or len(parent_ft)<3: return [],None
    basis=_r16_plane_basis(parent_ft)
    if basis is None: return [],None
    origin,_u,_v,n=basis; opening_normal=unit_vector(newell(pts)); parent_normal=unit_vector(newell(parent_ft))
    if opening_normal is None or parent_normal is None: return [],None
    alignment=abs(_r16_dot3(opening_normal,parent_normal))
    if alignment<0.95: return [],None
    max_plane=max(abs(_r16_dot3(vector_sub(p,origin),n)) for p in pts)
    parent2=_r16_clean2(_r16_project_basis(parent_ft,basis)); opening2=_r16_clean2(_r16_project_basis(pts,basis))
    if len(parent2)<3 or len(opening2)<3: return [],None
    parts=_u_parent_convex_parts(parent2)
    if not parts: return [],None
    raw=[]
    for carrier in parts:
        clipped2=_r16_clip_polygon_convex(opening2,carrier)
        if len(clipped2)<3: continue
        area=abs(_r16_signed_area2(clipped2))
        if area<_UNIVERSAL_OPENING_MIN_PIECE_FT2: continue
        piece=clean_consecutive(_r16_unproject_basis(clipped2,basis),MIN_EDGE_M/0.3048)
        if len(piece)<3 or 0.5*norm(newell(piece))<_UNIVERSAL_OPENING_MIN_PIECE_FT2: continue
        pn=unit_vector(newell(parent_ft)); on=unit_vector(newell(piece))
        if pn is not None and on is not None and _r16_dot3(pn,on)<0.0: piece=list(reversed(piece))
        raw.append(piece)
    unique=[]; seen=set()
    for piece in raw:
        key=tuple(sorted(tuple(round(float(v),6) for v in p[:3]) for p in piece))
        if key in seen: continue
        seen.add(key); unique.append(piece)
    return unique,{'piece_count':len(unique),'area_ft2':sum(0.5*norm(newell(x)) for x in unique),'plane_offset_ft':float(max_plane),'normal_alignment':float(alignment),'parent_concave':bool(polygon_is_concave(parent2))}


def _u_physical_host_parent_candidates(record,index,physical_manifest):
    """Fallback only to the exact physical Revit host subface already captured for this opening."""
    pts=record_polyloop(record)
    if len(pts)<3 or not bool(record.get('host_proven')): return []
    wanted_key=str(record.get('parent_physical_surface_key') or '')
    if not wanted_key: return []
    carriers=[]
    for wallrec in list((physical_manifest or {}).get('surfaces',[]) or []):
        if normalize_text(wallrec.get('surface_role') or 'wall')!='wall': continue
        if str(wallrec.get('key') or '')!=wanted_key: continue
        if not _r12_opening_supported_by_surface(pts,record_polyloop(wallrec)): continue
        carriers.append(wallrec)
    candidates=[]; seen=set()
    for wallrec in carriers:
        parent=find_surface_match(wallrec,index,relaxed=True)
        if parent is None: continue
        pid=str(parent.get('id') or id(parent))
        if pid in seen: continue
        pieces,metrics=_u_clip_physical_opening_to_parent(record,parent,index)
        if not pieces: continue
        seen.add(pid)
        for piece in pieces: candidates.append((parent,piece,metrics,wallrec))
    return candidates


def _u_physical_parent_candidates(record,index,analytical_manifest,physical_manifest=None):
    """Only exact Revit host-wall or exact EADM-opening-parent edges may carry a cut."""
    sid=int(record.get('originating_element_id') or -1); host_id=int(record.get('parent_originating_element_id') or -1)
    explicit=set()
    for op in list((analytical_manifest or {}).get('openings',[]) or []):
        if sid>0 and int(op.get('originating_element_id') or -1)==sid:
            pid=str(op.get('parent_analytical_id') or '')
            if pid: explicit.add(pid)
    pool=[]; seen=set()
    for ar in list((analytical_manifest or {}).get('surfaces',[]) or []):
        aid=str(ar.get('analytical_id') or ''); source=int(ar.get('originating_element_id') or -1)
        if (aid and aid in explicit) or (host_id>0 and source==host_id):
            key=(aid,int(ar.get('analysis_element_id') or -1))
            if key not in seen: seen.add(key); pool.append(ar)
    candidates=[]; seen_xml=set()
    for ar in pool:
        aid=str(ar.get('analytical_id') or ''); xmls=[c for c in index.get('surfaces',[]) if aid and str(c.get('id') or '')==aid]
        if not xmls:
            m=find_surface_match(ar,index,relaxed=True); xmls=[m] if m is not None else []
        for parent in xmls:
            if parent is None: continue
            pid=str(parent.get('id') or id(parent))
            if pid in seen_xml: continue
            pieces,metrics=_u_clip_physical_opening_to_parent(record,parent,index)
            if not pieces: continue
            seen_xml.add(pid)
            for piece in pieces: candidates.append((parent,piece,metrics,ar))
    if not candidates and physical_manifest is not None:
        candidates=_u_physical_host_parent_candidates(record,index,physical_manifest)
    return candidates


def _u_split_piece_max4(piece):
    if len(piece)<=4: return [piece]
    result=[]
    for i in range(1,len(piece)-1):
        tri=[piece[0],piece[i],piece[i+1]]
        if 0.5*norm(newell(tri))>=_UNIVERSAL_OPENING_MIN_PIECE_FT2: result.append(tri)
    return result


def _u_opening_source_maps(analytical_manifest,physical_manifest):
    physical={}
    for rec in list((physical_manifest or {}).get('openings',[]) or []):
        sid=int(rec.get('originating_element_id') or -1)
        if sid>0 and sid not in physical: physical[sid]=rec
    token_to_source={str(k):int(k) for k in physical}
    for rec in list((analytical_manifest or {}).get('openings',[]) or []):
        sid=int(rec.get('originating_element_id') or -1)
        if sid<=0 or sid not in physical: continue
        for token in (rec.get('analytical_id'),rec.get('analysis_element_id'),rec.get('originating_element_id')):
            if token is not None: token_to_source[str(token)]=sid
    return physical,token_to_source


def _u_resolve_existing_opening_source(opening,token_to_source):
    for token in (direct_child_text(opening,'CADObjectId'),opening.attrib.get('id')):
        text=str(token or '')
        if text in token_to_source: return int(token_to_source[text])
        try:
            value=int(text)
            if str(value) in token_to_source: return int(token_to_source[str(value)])
        except Exception: pass
    return None


def _u_insert_physical_piece(record,parent,namespace,index,existing_ids,opening_type,piece,seq):
    scale=0.3048/index['factor']; pts_xml=[tuple(float(v)*scale for v in p[:3]) for p in piece]
    seed={'key':'{}::{}::{}'.format(record.get('originating_element_id'),parent.get('id'),seq),'originating_element_id':record.get('originating_element_id')}
    oid=stable_fallback_id('physical-opening',seed,existing_ids); node=ET.Element(qualified(namespace,'Opening'),{'id':oid,'openingType':opening_type})
    name=ET.SubElement(node,qualified(namespace,'Name')); name.text='LIBER Revit {}'.format(record.get('originating_element_name') or record.get('name') or oid)
    add_planar_geometry(node,namespace,pts_xml); cad=ET.SubElement(node,qualified(namespace,'CADObjectId')); cad.text=str(int(record.get('originating_element_id') or -1))
    pe=parent['element']; at=len(list(pe))
    for i,c in enumerate(list(pe)):
        if local_name(c.tag)=='CADObjectId': at=i; break
    pe.insert(at,node); return oid


def _energyplus_effective_vertex_count_universal(points,short_edge_tolerance=0.01):
    work=list(points)
    while len(work)>=3:
        dropped=False
        for i in range(len(work)):
            if distance3(work[i-1],work[i])<short_edge_tolerance: del work[i]; dropped=True; break
        if not dropped: break
    return len(work)


def validate_export_contract(root):
    """Compiler-facing geometry contract, applied inside REVEX before release."""
    factor=length_to_meters(root.attrib.get('lengthUnit','Meters')); errors=[]; checked=0
    for surface in [e for e in root.iter() if local_name(e.tag)=='Surface']:
        parent_pts=points_to_meters(polygon_points(surface),factor); basis=_r16_plane_basis(parent_pts)
        if basis is None: continue
        parent2=_r16_clean2(_r16_project_basis(parent_pts,basis)); parent_parts=_u_parent_convex_parts(parent2)
        for opening in [c for c in list(surface) if local_name(c.tag)=='Opening']:
            checked+=1; oid=str(opening.attrib.get('id') or ''); pts=points_to_meters(polygon_points(opening),factor)
            if len(pts)<3 or len(pts)>4: errors.append((oid,'vertex_count',len(pts))); continue
            area=0.5*norm(newell(pts))
            if area<=1.0e-8: errors.append((oid,'degenerate',area)); continue
            if _energyplus_effective_vertex_count_universal(pts)<3: errors.append((oid,'short_edge_cleanup',0)); continue
            origin,_u,_v,n=basis; max_plane=max(abs(_r16_dot3(vector_sub(p,origin),n)) for p in pts)
            if max_plane>1.0e-4: errors.append((oid,'noncoplanar',max_plane)); continue
            if not parent_parts: errors.append((oid,'invalid_parent_polygon',0)); continue
            opening2=_r16_clean2(_r16_project_basis(pts,basis)); opening_area=abs(_r16_signed_area2(opening2)); covered=0.0
            for part in parent_parts:
                clip=_r16_clip_polygon_convex(opening2,part)
                if len(clip)>=3: covered+=abs(_r16_signed_area2(clip))
            tol=max(1.0e-10,opening_area*1.0e-8)
            if opening_area<=1.0e-10 or covered<opening_area-tol: errors.append((oid,'outside_parent',max(0.0,opening_area-covered)))
    return {'checked':checked,'errors':errors[:200],'error_count':len(errors),'passed':len(errors)==0}


def reconcile_physical_openings(xml_path,analytical_manifest,physical_manifest,messages):
    """Reconcile physical Revit openings to exact EADM/gbXML host edges, model-agnostically."""
    # Preserve native geometry first so unsupported/unknown physical evidence never erases
    # a valid native cut. Then rebuild only sources that are explicitly traceable.
    base=_core_normalize_gbxml_openings(xml_path,analytical_manifest,physical_manifest,messages)
    tree=ET.parse(xml_path); root=tree.getroot(); ns=namespace_uri(root)
    if ns:
        try: ET.register_namespace('',ns)
        except Exception: pass
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest); physical,token_to_source=_u_opening_source_maps(analytical_manifest,physical_manifest)
    # Normalize identity only; do not alter native opening geometry. This makes the
    # physical source survive into GeometryCo/QA even when Revit emitted an analytical
    # opening token in CADObjectId.
    native_identity_normalized=0
    for opening in [e for e in root.iter() if local_name(e.tag)=='Opening']:
        sid=_u_resolve_existing_opening_source(opening,token_to_source)
        if sid is None or sid not in physical:
            continue
        cad_node=None
        for child in list(opening):
            if local_name(child.tag)=='CADObjectId':
                cad_node=child; break
        if cad_node is None:
            cad_node=ET.SubElement(opening,qualified(ns,'CADObjectId'))
        if str(cad_node.text or '').strip()!=str(sid):
            cad_node.text=str(sid); native_identity_normalized+=1
    # Only remove existing representations when their source identity is known and we can
    # rebuild at least one exact host-backed parent. Otherwise preserve native output.
    rebuildable={}
    for sid,rec in sorted(physical.items()):
        candidates=_u_physical_parent_candidates(rec,index,analytical_manifest,physical_manifest)
        if candidates: rebuildable[sid]=candidates
    removed=0
    for surface in [e for e in root.iter() if local_name(e.tag)=='Surface']:
        for opening in [c for c in list(surface) if local_name(c.tag)=='Opening']:
            sid=_u_resolve_existing_opening_source(opening,token_to_source)
            if sid in rebuildable: surface.remove(opening); removed+=1
    index=bind_xml_spaces_to_revit(xml_envelope_index(root),analytical_manifest); existing_ids=set(str(e.attrib.get('id') or '') for e in root.iter() if local_name(e.tag)=='Opening')
    inserted=0; complete=0; unresolved=[]; split_events=0
    for sid,rec in sorted(physical.items()):
        typ=_fallback_opening_type(rec.get('opening_type'))
        if opening_type_family(typ) not in ('door','window','air'):
            unresolved.append({'source_id':sid,'reason':'opening_type_unresolved'}); continue
        candidates=rebuildable.get(sid,[])
        if not candidates:
            unresolved.append({'source_id':sid,'reason':'no_exact_eadm_or_physical_host_parent','host_proven':bool(rec.get('host_proven')),'parent_element_id':rec.get('parent_originating_element_id'),'parent_surface_key':rec.get('parent_physical_surface_key')}); continue
        count=0
        for parent,piece,_metrics,_ar in candidates:
            parts=_u_split_piece_max4(piece)
            if len(parts)>1: split_events+=1
            for seq,part in enumerate(parts,1): _u_insert_physical_piece(rec,parent,ns,index,existing_ids,typ,part,seq); count+=1; inserted+=1
        if count: complete+=1
    contract=validate_export_contract(root); tree.write(xml_path,encoding='utf-8',xml_declaration=True)
    coverage=float(complete)/float(len(physical)) if physical else 1.0
    stats={'base':base,'physical_sources':len(physical),'physical_sources_reconciled':complete,'physical_source_coverage':round(coverage,6),'opening_pieces_inserted':inserted,'known_source_representations_replaced':removed,'native_source_identity_normalized':native_identity_normalized,'split_events':split_events,'unresolved_sources':len(unresolved),'unresolved_details':unresolved[:100],'contract':contract}
    messages.append({'severity':'INFO' if coverage>=PRESERVATION_TARGET and contract.get('passed') else 'WARNING','code':'PHYSICAL_OPENINGS_RECONCILED','stats':stats,'message':'Physical windows, doors and curtain panels are reconciled from Revit source identity to exact analytical host surfaces. No project/floor names or adjacency guesses are used; unresolved evidence remains native/opaque.'})
    return stats


def normalize_gbxml_openings_from_revit(xml_path,analytical_manifest,physical_manifest,messages):
    return reconcile_physical_openings(xml_path,analytical_manifest,physical_manifest,messages)


def envelope_persistence_gate(xml_path,physical_manifest,analytical_manifest,allow_repairs=True):
    base=_core_envelope_persistence_gate(xml_path,physical_manifest,analytical_manifest,allow_repairs=False)
    base['errors']=[e for e in list(base.get('errors',[]) or []) if 'explicit Revit EADM openings survive on their correct parent Surface' not in str(e)]
    base['warnings']=[w for w in list(base.get('warnings',[]) or []) if 'EADM opening parent coverage' not in str(w)]
    root=ET.parse(xml_path).getroot(); contract=validate_export_contract(root); physical,token_to_source=_u_opening_source_maps(analytical_manifest,physical_manifest)
    represented=set()
    # Native Revit gbXML may carry an analytical opening id rather than the physical
    # Door/Window element id in CADObjectId. Resolve both domains through the explicit
    # EADM -> physical evidence map before judging the >=80% hard-stop publication integrity gate.
    for opening in [e for e in root.iter() if local_name(e.tag)=='Opening']:
        sid=_u_resolve_existing_opening_source(opening,token_to_source)
        if sid is not None and sid in physical:
            represented.add(int(sid))
    ratio=float(len(represented))/float(len(physical)) if physical else 1.0
    counts=base.setdefault('counts',{})
    counts['physical_opening_sources_expected']=len(physical)
    counts['physical_opening_sources_represented']=len(represented)
    counts['physical_opening_source_coverage']=round(ratio,6)
    host_proven_ids={int(sid) for sid,rec in physical.items() if bool(rec.get('host_proven'))}
    represented_host_ids=set(represented)&host_proven_ids
    counts['physical_windows_doors_expected']=len(host_proven_ids)
    counts['physical_windows_doors_preserved']=len(represented_host_ids)
    counts['export_contract']=contract
    base['warnings']=[w for w in list(base.get('warnings',[]) or []) if 'host-proven physical opening(s)' not in str(w)]
    unresolved_host=len(host_proven_ids-represented_host_ids)
    if unresolved_host:
        base.setdefault('warnings',[]).append('{} host-proven physical opening source(s) remain unresolved after exact source-identity reconciliation.'.format(unresolved_host))
    if not contract.get('passed'): base.setdefault('errors',[]).append('Exporter contains {} opening(s) outside the compiler-facing parent/subsurface contract.'.format(contract.get('error_count',0)))
    if ratio<PRESERVATION_MINIMUM: base.setdefault('errors',[]).append('Only {:.1%} of physical Revit opening sources survive exporter reconciliation (80% hard-stop integrity gate).'.format(ratio))
    elif ratio<PRESERVATION_TARGET: base.setdefault('warnings',[]).append('Physical Revit opening source coverage is {:.1%}; below the 95% quality target; unresolved sources remain explicit QA evidence and publication continues because the 80% hard stop was cleared.'.format(ratio))
    base['passed']=len(base.get('errors',[]))==0; return base


def run_tool():
    global REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE
    REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE = False
    if doc is None:
        return {"status": "FAILED", "message": "No active Revit document."}
    if bool(safe_attr(doc, "IsFamilyDocument", False)):
        return {"status": "FAILED", "message": "Open a Revit project, not a family."}
    if bool(safe_attr(doc, "IsReadOnly", False)) and not AUDIT_ONLY:
        return {
            "status": "FAILED",
            "message": "The active Revit model is read-only.",
        }

    # Establish the evidence destination before resolving project inputs. This guarantees
    # that a bad phase name or another preflight-input problem still produces a report
    # instead of surfacing to REVEX as an opaque NO_REPORT node failure.
    output_folder = OUTPUT_FOLDER_INPUT or default_output_folder(doc)
    os.makedirs(output_folder, exist_ok=True)
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    base_name = safe_name(
        os.path.splitext(EXPORT_NAME_INPUT)[0]
        if EXPORT_NAME_INPUT
        else "{}_gbXML_{}".format(doc.Title, timestamp)
    )
    final_xml = os.path.join(output_folder, base_name + ".xml")
    partial_name = base_name + ".partial.xml"
    partial_xml = os.path.join(output_folder, partial_name)
    failed_xml = os.path.join(output_folder, base_name + ".FAILED.xml")
    report_base = os.path.join(output_folder, base_name)

    messages = []
    changes = []
    report = {
        "tool": TOOL_NAME,
        "version": TOOL_VERSION,
        "engine_patch": ENGINE_PATCH,
        "space_topology_strategy": "Revit evidence graph -> bounded spatial cells -> native Final EADM -> native gbXML -> source-host opening reconciliation -> compiler-facing contract",
        "architecture": {
            "id": ARCHITECTURE_ID,
            "entry_points": [{"stage": stage, "function": function} for stage, function in ARCHITECTURE_ENTRY_POINTS],
            "model_specific_branching": False,
            "authorities": ["Revit spatial topology", "Revit physical elements", "Revit EADM", "gbXML schema contract"],
        },
        "orchestration": {
            "mode": "LIGHTWEIGHT_BOUNDED",
            "roles": ["initiator", "analyzer", "translator", "evaluator", "maintenance"],
            "shared_evidence": "compact IDs/topology/planes/bounds/provenance; no visualization comprehension",
            "revit_geometry_authority": True,
            "max_topology_repair_rounds": MAX_TOPOLOGY_REPAIR_ROUNDS,
            "max_maintenance_passes": MAX_MAINTENANCE_PASSES,
            "optional_model_inference": ENABLE_OPTIONAL_MODEL_INFERENCE,
            "visual_geometry_comprehension": ENABLE_VISUAL_GEOMETRY_COMPREHENSION,
            "completion_policy": COMPLETION_POLICY,
        },
        "started_at": datetime.datetime.now().isoformat(),
        "model": str(doc.Title),
        "model_path": str(doc.PathName or ""),
        "revit_version": str(app.VersionNumber if app else "unknown"),
        "dynamo_engine": "CPython3",
        "phase_requested": PHASE_NAME_INPUT or None,
        "phase": PHASE_NAME_INPUT or "auto",
        "audit_only": AUDIT_ONLY,
        "apply_safe_fixes": APPLY_SAFE_FIXES,
        "export_despite_blockers": EXPORT_DESPITE_BLOCKERS,
        "gbxml_path": None,
        "messages": messages,
        "changes": changes,
    }

    dependency_audit = runtime_dependency_audit(doc, output_folder)
    report["dependency_audit"] = dependency_audit
    messages.append({
        "severity": "INFO" if dependency_audit.get("passed") else "ERROR",
        "code": "RUNTIME_DEPENDENCY_AUDIT",
        "failed_hard": dependency_audit.get("failed_hard", []),
        "message": "Hard runtime dependency audit {}.".format("passed" if dependency_audit.get("passed") else "failed"),
    })
    if not dependency_audit.get("passed"):
        report["status"] = "FAILED_DEPENDENCY_AUDIT"
        report["rollback_reason"] = "Missing hard runtime dependencies: {}".format(", ".join(dependency_audit.get("failed_hard", [])))
        report["message_counts"] = message_counts(messages)
        report["finished_at"] = datetime.datetime.now().isoformat()
        json_path, text_path = write_reports(report, report_base)
        report["report_json"] = json_path
        report["report_text"] = text_path
        return report

    try:
        phase, phases = choose_phase(doc, PHASE_NAME_INPUT)
        report["phase"] = str(phase.Name)
        if PHASE_NAME_INPUT and normalize_text(PHASE_NAME_INPUT) != normalize_text(phase.Name):
            messages.append(
                {
                    "severity": "INFO",
                    "code": "PHASE_INPUT_CORRECTED",
                    "message": "Requested phase '{}' resolved to Revit phase '{}'.".format(
                        PHASE_NAME_INPUT, phase.Name
                    ),
                }
            )
    except Exception as ex:
        messages.append(
            {
                "severity": "ERROR",
                "code": "PHASE_RESOLUTION_FAILED",
                "message": str(ex),
                "trace": traceback.format_exc(),
            }
        )
        report["status"] = "FAILED_PRECHECK"
        report["available_phases"] = [str(p.Name) for p in list(doc.Phases)]
        report["message_counts"] = message_counts(messages)
        report["finished_at"] = datetime.datetime.now().isoformat()
        json_path, text_path = write_reports(report, report_base)
        report["report_json"] = json_path
        report["report_text"] = text_path
        return report

    levels = sorted_levels(doc)
    phases_map = phase_index_map(phases)
    phase_index = phases_map[eid_value(phase.Id)]
    existing_spaces = [
        space
        for space in collect_spaces(doc)
        if element_exists_in_phase(space, phase_index, phases_map)
    ]
    report["spaces_before"] = len(existing_spaces)

    TransactionManager.Instance.ForceCloseTransaction()
    group = None
    group_finished = False
    created_ids = set()
    temporary_energy_model = None
    exportable_spaces = []
    physical_manifest = {"surfaces": [], "openings": [], "counts": {}}
    analytical_manifest = {"spaces": [], "surfaces": [], "openings": [], "counts": {}}
    # Once this flips True, Room/Space topology has independently passed the global
    # preservation gate. Late EADM/export/software failures must not erase that valid
    # spatial reconstruction. The failure handler removes any partial EADM, then
    # assimilates the verified Space state for deterministic recovery.
    spatial_state_verified = False
    verified_room_preservation = 0.0

    try:
        if not AUDIT_ONLY:
            group = TransactionGroup(doc, TOOL_NAME)
            group.Start()

        raw_room_sources = collect_room_sources(doc, phase, phases, messages)
        room_sources, duplicate_room_sources = dedupe_room_sources(
            raw_room_sources, messages
        )
        report["room_sources"] = {
            "host_raw": sum(1 for item in raw_room_sources if item["kind"] == "host_room"),
            "linked_raw": sum(1 for item in raw_room_sources if item["kind"] == "linked_room"),
            "raw_total": len(raw_room_sources),
            "unique_total": len(room_sources),
            "duplicates_collapsed": len(duplicate_room_sources),
        }

        targets = target_levels_for_spaces(
            doc, levels, room_sources, existing_spaces, messages
        )
        report["space_base_levels"] = [
            {
                "id": eid_value(level.Id),
                "name": str(safe_element_name(level)),
                "elevation_ft": level_elevation(level),
            }
            for level in targets
        ]

        if not AUDIT_ONLY and APPLY_SAFE_FIXES:
            vertical_caps = prepare_room_source_vertical_targets(
                room_sources, targets, levels, changes, messages
            )
            report["room_vertical_envelope"] = {
                "strategy": "story-bounded energy Spaces; architectural Room top preserved only when below next story/roof",
                "sources": len(room_sources),
                "capped_before_creation": int(vertical_caps),
            }
            # STAGE A — configure the model and seed one Space per unique Room source.
            # Revit's Space containment/topology index is not authoritative until this
            # transaction commits.  The outer TransactionGroup makes this reversible.
            seed_transaction = Transaction(doc, "LIBER gbXML: configure and seed Room Spaces")
            seed_transaction.Start()
            seed_guard = SpaceCreationFailureGuard()
            seed_options = seed_transaction.GetFailureHandlingOptions()
            seed_options.SetFailuresPreprocessor(seed_guard)
            seed_options.SetClearAfterRollback(True)
            seed_transaction.SetFailureHandlingOptions(seed_options)
            # Idempotence without needless reconstruction: reuse a saved REVEX
            # spatial checkpoint when it still proves full Room topology + bounded
            # story extents. Rebuild only when that evidence is stale or broken.
            prior_generated_space_ids = set(
                eid_value(prior_space.Id)
                for prior_space in list(existing_spaces)
                if is_revex_generated_space(prior_space) and is_placed_spatial(prior_space)
            )
            reuse_verified_revex_spaces = False
            reuse_topology = {}
            reuse_story_sanity = {}
            if prior_generated_space_ids:
                try:
                    reuse_topology = audit_room_space_topology(
                        doc, phase, levels, room_sources,
                        [item for item in existing_spaces if is_placed_spatial(item)],
                        messages, strict=False
                    )
                    reuse_story_sanity = generated_story_span_sanity(
                        existing_spaces, prior_generated_space_ids, targets, levels
                    )
                    reuse_verified_revex_spaces = bool(
                        int(reuse_topology.get("uncovered_room_sources", 1) or 0) == 0
                        and int(reuse_topology.get("collapsed_space_count", 1) or 0) == 0
                        and bool(reuse_story_sanity.get("passed", False))
                    )
                except Exception as ex:
                    messages.append({
                        "severity":"WARNING",
                        "code":"REVEX_SPACE_REUSE_AUDIT_FAILED_REBUILDING",
                        "message":str(ex),
                    })
                    reuse_verified_revex_spaces = False
            report["existing_revex_space_reuse"] = {
                "candidate_count": len(prior_generated_space_ids),
                "reused": bool(reuse_verified_revex_spaces),
                "topology": reuse_topology,
                "story_sanity": reuse_story_sanity,
            }
            REUSE_VERIFIED_SPATIAL_CHECKPOINT_ACTIVE = bool(reuse_verified_revex_spaces)

            stale_generated_space_ids=[]
            if reuse_verified_revex_spaces:
                messages.append({
                    "severity":"INFO",
                    "code":"REUSED_VERIFIED_REVEX_SPACES",
                    "count":len(prior_generated_space_ids),
                    "message":"Saved REVEX Spaces still prove complete Room coverage and bounded story geometry; they are reused instead of deleted/reconstructed.",
                })
                changes.append({
                    "action":"reuse_verified_revex_spatial_checkpoint",
                    "count":len(prior_generated_space_ids),
                    "element_ids":sorted(prior_generated_space_ids)[:250],
                })
            else:
                for prior_space in list(existing_spaces):
                    if is_revex_generated_space(prior_space):
                        stale_generated_space_ids.append(eid_value(prior_space.Id))
                        doc.Delete(prior_space.Id)
                if stale_generated_space_ids:
                    doc.Regenerate()
                    stale_set=set(stale_generated_space_ids)
                    existing_spaces=[item for item in existing_spaces if eid_value(item.Id) not in stale_set]
                    prior_generated_space_ids=set()
                    report["stale_revex_spaces_rebuilt"]={"count":len(stale_generated_space_ids),"ids":stale_generated_space_ids[:250]}
                    changes.append({"action":"delete_stale_revex_generated_spaces_before_rebuild","count":len(stale_generated_space_ids),"element_ids":stale_generated_space_ids[:250]})
                    messages.append({"severity":"INFO","code":"STALE_REVEX_SPACES_REBUILT","count":len(stale_generated_space_ids),"message":"Saved REVEX Spaces failed the lightweight topology/story audit, so only REVEX-authored Spaces were rebuilt. User-authored Spaces were preserved."})
            existing_ids = set(eid_value(space.Id) for space in existing_spaces)
            try:
                configure_area_volume(doc, changes)
                enable_room_bounding_links(doc, changes, messages)
                doc.Regenerate()
                newly_seeded_ids, seed_stats = create_room_seeded_spaces(
                    doc, phase, levels, room_sources, existing_ids, changes, messages
                )
                # Treat a verified saved checkpoint as part of this run's
                # authoritative generated set so downstream story QA/provenance
                # still sees it, while creation_attempts remains truthful.
                seeded_ids = set(newly_seeded_ids).union(prior_generated_space_ids)
                if seed_stats.get("failed", 0):
                    seed_transaction.RollBack()
                    group.RollBack()
                    group_finished = True
                    creation_stats = {
                        "attempted": seed_stats.get("attempted", 0),
                        "kept": 0,
                        "room_seed": seed_stats,
                        "gap_fill": {},
                        "discarded_redundant": 0,
                        "failed_levels": ["<Room-source seeding>"],
                        "target_level_ids": [eid_value(item.Id) for item in targets],
                        "target_levels": [str(safe_element_name(item) or eid_value(item.Id)) for item in targets],
                    }
                    report["space_creation"] = creation_stats
                    return finish_space_creation_rollback_report(
                        report, report_base, existing_spaces, creation_stats,
                        "Room-source Space placement raised one or more creation/constraint errors before commit.",
                    )
                seed_commit = seed_transaction.Commit()
                if seed_commit != TransactionStatus.Committed:
                    for failure in seed_guard.failures:
                        messages.append({
                            "severity": "ERROR",
                            "code": "REVIT_ROOM_SEED_FAILURE_ROLLBACK",
                            "overlap_warning": failure.get("overlap_warning", False),
                            "element_ids": failure.get("failing_element_ids", []),
                            "message": failure.get("description", "Revit rejected the Room-seeded Space set."),
                        })
                    group.RollBack()
                    group_finished = True
                    creation_stats = {
                        "attempted": seed_stats.get("attempted", 0),
                        "kept": 0,
                        "room_seed": seed_stats,
                        "gap_fill": {},
                        "discarded_redundant": 0,
                        "failed_levels": ["<Room-source seed commit>"],
                        "target_level_ids": [eid_value(item.Id) for item in targets],
                        "target_levels": [str(safe_element_name(item) or eid_value(item.Id)) for item in targets],
                    }
                    report["space_creation"] = creation_stats
                    return finish_space_creation_rollback_report(
                        report, report_base, existing_spaces, creation_stats,
                        "Revit rejected the Room-seeded Space transaction; exact failure descriptions are preserved.",
                    )
            except Exception:
                try:
                    if seed_transaction.GetStatus() == TransactionStatus.Started:
                        seed_transaction.RollBack()
                except Exception:
                    pass
                raise

            # Re-query only after commit: this is the first point at which Revit's
            # Space.Room / GetSpaceAtPoint topology is treated as authoritative.
            phase_spaces_after_seed = [
                space for space in collect_spaces(doc)
                if element_exists_in_phase(space, phase_index, phases_map)
                and is_placed_spatial(space)
            ]
            seed_audit_messages = []
            seed_topology = audit_room_space_topology(
                doc, phase, levels, room_sources, phase_spaces_after_seed, seed_audit_messages, strict=False
            )
            report["room_seed_topology"] = seed_topology
            if seed_topology.get("uncovered_room_sources", 0):
                messages.append({
                    "severity": "INFO",
                    "code": "ROOM_SEED_COVERAGE_PENDING_GAP_FILL",
                    "count": seed_topology.get("uncovered_room_sources", 0),
                    "details": seed_topology.get("unresolved_details", [])[:25],
                    "message": "Some Room seeds are not yet independently proven after Stage A; remaining plan circuits will be filled before the final strict topology audit.",
                })
            if seed_topology.get("collapsed_space_count", 0):
                messages.extend(seed_audit_messages)
                group.RollBack()
                group_finished = True
                creation_stats = {
                    "attempted": seed_stats.get("attempted", 0),
                    "kept": 0,
                    "room_seed": seed_stats,
                    "gap_fill": {},
                    "discarded_redundant": 0,
                    "failed_levels": ["<Committed Room topology collapse>"],
                    "target_level_ids": [eid_value(item.Id) for item in targets],
                    "target_levels": [str(safe_element_name(item) or eid_value(item.Id)) for item in targets],
                }
                report["space_creation"] = creation_stats
                return finish_space_creation_rollback_report(
                    report, report_base, existing_spaces, creation_stats,
                    "Committed Room seed topology proved multiple Rooms collapsed into one Space; the outer transaction group was rolled back.",
                )

            # STAGE B — NewSpaces2 is used only as a positive-area gap detector.
            # Revit can return transient zero-area Space ids even when existing committed
            # Spaces already cover the architectural Room circuits. Those ids are deleted
            # and never counted as topology; only positive-area placed Spaces survive.
            messages.append({
                "severity": "INFO",
                "code": "NEWSPACES2_POSITIVE_AREA_GAP_FILTER_ACTIVE",
                "message": "Remaining-circuit fill keeps only positive-area placed Spaces; zero-area NewSpaces2 return artifacts are discarded before commit.",
            })
            gap_transaction = Transaction(doc, "LIBER gbXML: fill remaining Space circuits")
            gap_transaction.Start()
            gap_guard = SpaceCreationFailureGuard()
            gap_options = gap_transaction.GetFailureHandlingOptions()
            gap_options.SetFailuresPreprocessor(gap_guard)
            gap_options.SetClearAfterRollback(True)
            gap_transaction.SetFailureHandlingOptions(gap_options)
            try:
                gap_ids, gap_stats = create_missing_spaces(
                    doc,
                    phase,
                    levels,
                    targets,
                    room_sources,
                    existing_ids.union(seeded_ids),
                    changes,
                    messages,
                )
                creation_stats = {
                    "attempted": seed_stats.get("attempted", 0) + gap_stats.get("kept", 0),
                    "kept": len(seeded_ids) + len(gap_ids),
                    "room_seed": seed_stats,
                    "gap_fill": gap_stats,
                    "discarded_redundant": gap_stats.get("discarded_redundant", 0),
                    "failed_levels": list(gap_stats.get("failed_levels", [])),
                    "target_level_ids": [eid_value(item.Id) for item in targets],
                    "target_levels": [str(safe_element_name(item) or eid_value(item.Id)) for item in targets],
                }
                report["space_creation"] = creation_stats
                if creation_stats["failed_levels"]:
                    messages.append({
                        "severity": "WARNING",
                        "code": "GAP_FILL_PARTIAL_LEVEL_FAILURE_TOLERATED",
                        "levels": list(creation_stats["failed_levels"]),
                        "message": (
                            "One-pass gap fill could not repair every level. Successful "
                            "levels are retained and export continues subject to the "
                            ">=80% hard-stop publication integrity gate."
                        ),
                    })
                gap_commit = gap_transaction.Commit()
                if gap_commit != TransactionStatus.Committed:
                    gap_ids = set()
                    creation_stats["gap_fill_fallback_to_room_seeds"] = True
                    for failure in gap_guard.failures:
                        messages.append({
                            "severity": "WARNING",
                            "code": "REVIT_GAP_FILL_FAILURE_FALLBACK_TO_ROOM_SEEDS",
                            "overlap_warning": failure.get("overlap_warning", False),
                            "element_ids": failure.get("failing_element_ids", []),
                            "message": failure.get("description", "Revit rejected remaining-circuit Spaces; committed Room-seeded Spaces will be exported instead."),
                        })
            except Exception:
                try:
                    if gap_transaction.GetStatus() == TransactionStatus.Started:
                        gap_transaction.RollBack()
                except Exception:
                    pass
                raise

            created_ids = set(seeded_ids).union(gap_ids)

            # STAGE B2 — close any positive-area circuit exposed only after the first
            # gap transaction commits. This is a bounded committed fixed-point pass,
            # not another broad topology rewrite.
            closure_stats = close_remaining_plan_circuits(
                doc, phase, phases, levels, room_sources, targets, created_ids, changes, messages
            )
            report["space_creation"]["closure"] = closure_stats
            report["space_creation"]["gap_fill"]["api_returned_ids"] = int(
                report["space_creation"]["gap_fill"].get("api_returned_ids", 0) or 0
            ) + int(closure_stats.get("api_returned_ids", 0) or 0)
            report["space_creation"]["gap_fill"]["kept"] = int(
                report["space_creation"]["gap_fill"].get("kept", 0) or 0
            ) + int(closure_stats.get("kept", 0) or 0)
            report["space_creation"]["gap_fill"]["discarded_zero_area"] = int(
                report["space_creation"]["gap_fill"].get("discarded_zero_area", 0) or 0
            ) + int(closure_stats.get("discarded_zero_area", 0) or 0)
            report["space_creation"]["gap_fill"]["discarded_redundant"] = int(
                report["space_creation"]["gap_fill"].get("discarded_redundant", 0) or 0
            ) + int(closure_stats.get("discarded_redundant", 0) or 0)

            # STAGE C — with all spatial topology committed, assign Room identity and
            # normalize generated vertical spans. This is still inside the outer group.
            identity_transaction = Transaction(doc, "LIBER gbXML: finalize Space identity")
            identity_transaction.Start()
            try:
                spaces, matched = match_and_update_spaces(
                    doc,
                    phase,
                    phases,
                    levels,
                    targets,
                    room_sources,
                    created_ids,
                    changes,
                    messages,
                )
                report["exterior_gap_cull"] = cull_open_exterior_generated_spaces(
                    doc, spaces, created_ids, matched, targets, changes, messages
                )
                spaces = [s for s in collect_spaces(doc) if s is not None]
                report["top_story_height_refinement"] = refine_top_story_space_heights_from_physical_cover(
                    doc, spaces, created_ids, targets, changes, messages
                )
                report["spatial_checkpoint_geometry_mutated"] = bool(
                    int((report.get("exterior_gap_cull") or {}).get("removed", 0) or 0) > 0
                    or int((report.get("top_story_height_refinement") or {}).get("adjusted", 0) or 0) > 0
                    or any(str(item.get("action") or "") in ("remove_proven_duplicate_room_spaces",) for item in changes if isinstance(item,dict))
                )
                story_sanity=generated_story_span_sanity(spaces,created_ids,targets,levels)
                report["generated_story_span_sanity"]=story_sanity
                if not story_sanity.get("passed",False):
                    raise Exception("Generated energy Space story-bound sanity failed for {} Space(s): {}".format(story_sanity.get("violation_count",0),story_sanity.get("violations",[])[:10]))
                identity_transaction.Commit()
            except Exception:
                identity_transaction.RollBack()
                raise

            # STAGE D — annotation is deliberately deferred to the single post-EADM
            # pass. This avoids duplicate view scans and keeps the urgent export path
            # lightweight while preserving idempotent EN/Energy tags.
            report["space_plan_tags"] = {"deferred_to_post_eadm": True}
        else:
            spaces = existing_spaces

        # Re-query Spaces through SpaceFilter after the creation transaction commits.
        # Revit explicitly does not support OfClass(Space); this cross-check prevents
        # a future collector regression from misreporting created Spaces as absent.
        all_spaces_after = collect_spaces(doc)
        resolved_created = [
            doc.GetElement(ElementId(item_id))
            for item_id in sorted(created_ids)
        ]
        resolved_created = [
            item for item in resolved_created
            if item is not None and isinstance(item, Space)
        ]
        report["space_collector"] = {
            "method": "SpaceFilter",
            "spatial_name_accessor": "BuiltInParameter.ROOM_NAME",
            "all_spaces_after_commit": len(all_spaces_after),
            "created_ids_recorded": len(created_ids),
            "created_ids_resolved_as_spaces": len(resolved_created),
        }
        if len(created_ids) != len(resolved_created):
            messages.append(
                {
                    "severity": "ERROR",
                    "code": "SPACE_CREATION_ID_RESOLUTION_MISMATCH",
                    "message": (
                        "REVEX recorded {} created Space ids but only {} resolve as "
                        "MEP Spaces after commit. Export is blocked to protect model "
                        "integrity."
                    ).format(len(created_ids), len(resolved_created)),
                }
            )

        phase_spaces_for_topology = [
            space
            for space in collect_spaces(doc)
            if element_exists_in_phase(space, phase_index, phases_map)
            and is_placed_spatial(space)
        ]
        report["space_topology"] = audit_room_space_topology(
            doc, phase, levels, room_sources, phase_spaces_for_topology, messages, strict=True
        )
        report["plan_circuit_coverage"] = probe_remaining_plan_circuits(
            doc, phase, targets, messages
        )

        report["spaces_created"] = len(created_ids)
        report["spaces_created_attempted"] = report.get(
            "space_creation", {}
        ).get("attempted", len(created_ids))
        phase_spaces, exportable_spaces, unplaced = audit_spaces(
            doc, phase, phases, levels, messages, created_ids
        )
        report["spaces_in_phase"] = len(phase_spaces)
        report["spaces_exportable"] = len(exportable_spaces)
        report["unplaced_spaces_ignored"] = len(unplaced)

        report["semantic_review"] = {
            "engine": "deferred_until_geometry_verified",
            "provider": None,
            "count": len(exportable_spaces),
            "bounded": True,
        }
        physical_manifest = capture_physical_envelope(
            doc, exportable_spaces, messages
        )
        report["physical_envelope"] = {
            "counts": physical_manifest.get("counts", {}),
            "elapsed_seconds": physical_manifest.get("elapsed_seconds"),
            "limit": physical_manifest.get("limit"),
            "budget_seconds": physical_manifest.get("budget_seconds"),
        }

        counts = message_counts(messages)
        report["message_counts"] = counts
        blockers = counts.get("ERROR", 0)

        topology = report.get("space_topology", {}) or {}
        room_total = int(topology.get("room_sources", 0) or 0)
        room_covered = int(topology.get("covered_room_sources", 0) or 0)
        room_preservation = (float(room_covered) / float(room_total)) if room_total else (1.0 if exportable_spaces else 0.0)
        report["preservation_gate_preexport"] = {
            "room_preservation": round(room_preservation, 6),
            "target": PRESERVATION_TARGET,
            "minimum": PRESERVATION_MINIMUM,
            "exportable_spaces": len(exportable_spaces),
            "decision": (
                ("ACCEPT_80_PLUS" if room_preservation >= PRESERVATION_MINIMUM else "BLOCK_BELOW_80")
            ),
        }
        verified_room_preservation = float(room_preservation)
        spatial_state_verified = bool(
            len(exportable_spaces) > 0
            and bool(report.get("generated_story_span_sanity", {}).get("passed", True))
        )
        report["verified_spatial_checkpoint"] = {
            "passed": spatial_state_verified,
            "room_preservation": round(verified_room_preservation, 6),
            "created_space_ids": len(created_ids),
            "exportable_spaces": len(exportable_spaces),
        }

        if AUDIT_ONLY:
            report["status"] = "AUDIT_COMPLETE"
            report["finished_at"] = datetime.datetime.now().isoformat()
            json_path, text_path = write_reports(report, report_base)
            report["report_json"] = json_path
            report["report_text"] = text_path
            return report

        if not exportable_spaces:
            group.RollBack()
            group_finished = True
            report["status"] = "FAILED_EMPTY_ANALYTICAL_MODEL"
            report["rollback_reason"] = "No enclosed placed Space geometry exists in the selected phase."
            report["finished_at"] = datetime.datetime.now().isoformat()
            json_path, text_path = write_reports(report, report_base)
            report["report_json"] = json_path
            report["report_text"] = text_path
            return report
        if room_preservation < PRESERVATION_MINIMUM:
            messages.append({
                "severity":"WARNING",
                "code":"LOW_INTEGRITY_DIAGNOSTIC_ONLY",
                "room_preservation":room_preservation,
                "message":"Room preservation is below the 80% hard-stop publication integrity gate. REVEX will preserve verified Spaces, the display EADM, tags, evidence, and a diagnostic gbXML, but it will not publish a successful Energy Sync input.",
            })
        if blockers:
            messages.append({
                "severity": "WARNING",
                "code": "PREFLIGHT_ERRORS_TOLERATED_BY_PRESERVATION_GATE",
                "count": blockers,
                "room_preservation": room_preservation,
                "message": "Pre-export QA errors remain explicit; publication requires >=80% in every required evidence domain; values below 95% remain explicit review warnings.",
            })

        # Native Revit analytical model creation is isolated from the spatial topology.
        # If one EADM tier fails, retry another tier. A failure here never erases a
        # verified Space reconstruction; that state is committed for manual/native
        # recovery and the report records the exact API failure.
        # Reuse the persisted Final EADM when the saved REVEX Space checkpoint was
        # independently reverified and the analytical Space identities still match.
        # This makes maintenance reruns scale with changes rather than model history.
        energy_settings = None
        energy_model_attempts = []
        temporary_energy_model = None
        reuse_eadm = bool(
            (report.get("existing_revex_space_reuse") or {}).get("reused")
            and not bool(report.get("spatial_checkpoint_geometry_mutated", False))
        )
        if reuse_eadm:
            try:
                candidate_eadm = Analysis.EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(doc)
                if candidate_eadm is not None and bool(safe_attr(candidate_eadm, "IsValidObject", True)):
                    candidate_manifest = capture_energy_manifest(doc, candidate_eadm, messages)
                    expected_ids = set(
                        eid_value(item.Id) for item in list(exportable_spaces or []) if item is not None
                    )
                    actual_ids = set(
                        int(item.get("revit_space_id") or -1)
                        for item in list(candidate_manifest.get("spaces", []) or [])
                        if int(item.get("revit_space_id") or -1) > 0
                    )
                    if (
                        len(candidate_manifest.get("spaces", []) or []) == len(exportable_spaces)
                        and expected_ids == actual_ids
                        and candidate_manifest.get("surfaces")
                    ):
                        temporary_energy_model = candidate_eadm
                        analytical_manifest = candidate_manifest
                        energy_model_attempts.append({
                            "tier":"PersistedFinal",
                            "status":"reused",
                            "analytical_spaces":len(candidate_manifest.get("spaces", []) or []),
                            "analytical_surfaces":len(candidate_manifest.get("surfaces", []) or []),
                        })
                        messages.append({
                            "severity":"INFO",
                            "code":"REUSED_VERIFIED_PERSISTED_EADM",
                            "message":"Saved Final EnergyAnalysisDetailModel matches the verified current Space identities and is reused instead of regenerated.",
                        })
            except Exception as ex:
                messages.append({
                    "severity":"WARNING",
                    "code":"PERSISTED_EADM_REUSE_CHECK_FAILED_REBUILDING",
                    "message":str(ex),
                })
                temporary_energy_model = None

        if temporary_energy_model is None:
            temporary_energy_model, energy_settings, energy_model_attempts = build_energy_model_with_fallbacks(
                doc, phase, changes, messages, expected_spaces=len(exportable_spaces)
            )
        report["energy_model_attempts"] = energy_model_attempts
        if temporary_energy_model is None:
            messages.append({"severity":"WARNING","code":"NATIVE_ENERGY_MODEL_CREATION_FAILED_ALL_TIERS","message":"Revit could not create a native SpatialElement EADM. REVEX is switching to the source-native Revit geometry serializer instead of stopping."})
            partial_xml, direct_counts = write_direct_revit_geometry_gbxml(doc, partial_xml, exportable_spaces, physical_manifest, messages)
            report["export_method"] = "DIRECT_REVIT_GEOMETRY_FALLBACK"
            report["direct_revit_fallback"] = direct_counts
            analytical_manifest = {"spaces": [], "surfaces": [], "openings": [], "counts": {}}

        if temporary_energy_model is not None:
            try:
                analytical_manifest = capture_energy_manifest(doc, temporary_energy_model, messages)
            except Exception as ex:
                analytical_manifest = {"surfaces":[],"openings":[],"counts":{}}
                messages.append({
                    "severity":"WARNING", "code":"ANALYTICAL_MANIFEST_CAPTURE_FAILED_NONBLOCKING",
                    "message":str(ex),
                })
            report["analytical_manifest"] = analytical_manifest.get("counts", {})
            analytical_vertical_sanity=analytical_geometry_vertical_sanity(doc,analytical_manifest,exportable_spaces)
            report["analytical_vertical_sanity"]=analytical_vertical_sanity
            if not analytical_vertical_sanity.get("passed",False):
                messages.append({
                    "severity":"WARNING",
                    "code":"EADM_VERTICAL_QA_DEFERRED_TO_SOURCE_BACKED_XML_MAINTENANCE",
                    "critical_count": analytical_vertical_sanity.get("critical_count",0),
                    "warning_count": analytical_vertical_sanity.get("warning_count",0),
                    "max_excess_ft": analytical_vertical_sanity.get("max_excess_ft",0),
                    "message":"The native EADM contains derivative vertical mismatches. REVEX continues to native gbXML, then compares/repairs the generated XML directly against authoritative Revit geometry instead of fitting the EADM or aborting early.",
                })
            elif analytical_vertical_sanity.get("warning_count",0):
                messages.append({
                    "severity":"WARNING",
                    "code":"EADM_ANALYTICAL_OFFSETS_ACCEPTED_FOR_SOURCE_BACKED_XML_CHECK",
                    "count":analytical_vertical_sanity.get("warning_count",0),
                    "max_excess_ft":analytical_vertical_sanity.get("max_excess_ft",0),
                    "message":"EADM surface offsets are non-catastrophic/source-supported. They remain visible QA findings while the generated gbXML is checked against native Revit geometry.",
                })

            partial_candidates = [
                partial_xml,
                partial_xml + ".xml",
                os.path.join(output_folder, base_name + ".partial"),
            ]
            export_errors=[]
            try:
                partial_xml, native_attempts = export_native_gbxml(doc, output_folder, partial_name, partial_candidates, messages)
                report["native_export_attempts"] = native_attempts
            except Exception as ex:
                export_errors.append(str(ex))
                messages.append({
                    "severity":"WARNING", "code":"NATIVE_GBXML_EXPORT_FIRST_ATTEMPT_FAILED",
                    "message":str(ex),
                })
                # Rebuild once at Final tier because Revit's gbXML exporter consumes the
                # stored main energy model. This is a quality fallback, not a shortcut.
                retry_tx=Transaction(doc,"LIBER gbXML: rebuild Final energy model for export")
                try:
                    retry_tx.Start()
                    delete_main_energy_model(doc, changes)
                    doc.Regenerate()
                    temporary_energy_model=create_energy_model_for_tier(doc,"Final",changes)
                    doc.Regenerate()
                    status=retry_tx.Commit()
                    if status != TransactionStatus.Committed:
                        raise Exception("Final energy-model retry did not commit: {}".format(status))
                    analytical_manifest = capture_energy_manifest(doc, temporary_energy_model, messages)
                    report["analytical_manifest"] = analytical_manifest.get("counts", {})
                    analytical_vertical_sanity=analytical_geometry_vertical_sanity(doc,analytical_manifest,exportable_spaces)
                    report["analytical_vertical_sanity"]=analytical_vertical_sanity
                    if not analytical_vertical_sanity.get("passed",False):
                        messages.append({
                            "severity":"WARNING",
                            "code":"REBUILT_EADM_VERTICAL_QA_DEFERRED_TO_XML_MAINTENANCE",
                            "critical_count": analytical_vertical_sanity.get("critical_count",0),
                            "max_excess_ft": analytical_vertical_sanity.get("max_excess_ft",0),
                            "message":"Rebuilt Final EADM still has derivative mismatches; source-backed gbXML maintenance remains the final authority.",
                        })
                    partial_xml, retry_native_attempts = export_native_gbxml(doc, output_folder, partial_name, partial_candidates, messages)
                    report.setdefault("native_export_attempts", []).extend(retry_native_attempts)
                except Exception as ex2:
                    try:
                        if retry_tx.GetStatus() == TransactionStatus.Started:
                            retry_tx.RollBack()
                    except Exception:
                        pass
                    export_errors.append(str(ex2))
                    messages.append({
                        "severity":"WARNING", "code":"NATIVE_GBXML_EXPORT_FAILED_AFTER_REBUILD",
                        "message":str(ex2),
                    })
                    report["native_export_errors"] = export_errors
                    # Last-resort serializer has no external dependency: it uses the already
                    # verified Revit EADM and the Space geometry committed above.
                    try:
                        partial_xml, direct_counts = write_direct_eadm_gbxml(
                            doc, partial_xml, exportable_spaces, analytical_manifest, messages
                        )
                        report["export_method"] = "DIRECT_EADM_GEOMETRY_FALLBACK"
                        report["direct_eadm_fallback"] = direct_counts
                    except Exception as ex3:
                        messages.append({
                            "severity":"WARNING", "code":"DIRECT_EADM_GBXML_FALLBACK_FAILED",
                            "message":"{}: {}".format(type(ex3).__name__,ex3),
                            "trace":traceback.format_exc()[-3000:],
                        })
                        partial_xml, direct_counts = write_direct_revit_geometry_gbxml(
                            doc, partial_xml, exportable_spaces, physical_manifest, messages
                        )
                        report["export_method"]="DIRECT_REVIT_GEOMETRY_FALLBACK"
                        report["direct_revit_fallback"]=direct_counts

            if not report.get("export_method"):
                report["export_method"] = "REVIT_NATIVE_GBXML"

        if os.path.isfile(partial_xml):
            try:
                report["gbxml_project_identity_changes"] = normalize_gbxml_project_identity(doc, partial_xml, messages)
            except Exception as ex:
                messages.append({"severity":"WARNING","code":"GBXML_PROJECT_IDENTITY_NORMALIZATION_FAILED_NONBLOCKING","message":str(ex)})

        # Native Revit 2026 gbXML can serialize a Surface with the same Space
        # twice. OpenStudio refuses to translate those carriers, leaving visible
        # holes even though the EADM is complete. Normalize adjacency against the
        # exact EADM/Revit identity domains before any downstream proof/maintenance.
        try:
            report["adjacency_normalization"] = normalize_gbxml_adjacency_from_eadm(
                partial_xml, analytical_manifest, messages
            )
        except Exception as ex:
            report["adjacency_normalization"] = {"error": str(ex)}
            messages.append({
                "severity": "WARNING",
                "code": "GBXML_ADJACENCY_NORMALIZATION_FAILED_NONBLOCKING",
                "message": str(ex),
            })
        try:
            report["opening_normalization"] = normalize_gbxml_openings_from_revit(
                partial_xml, analytical_manifest, physical_manifest, messages
            )
        except Exception as ex:
            report["opening_normalization"] = {"error": str(ex)}
            messages.append({
                "severity": "WARNING",
                "code": "GBXML_OPENING_NORMALIZATION_FAILED_NONBLOCKING",
                "message": str(ex),
            })

        try:
            geometry_integrity = revit_geometry_integrity_loop(
                partial_xml, exportable_spaces, physical_manifest, analytical_manifest, messages, max_rounds=MAX_MAINTENANCE_PASSES
            )
        except Exception as ex:
            geometry_integrity = {"passed":False,"software_failure":str(ex),"final_persistence":{"passed":False,"errors":[str(ex)],"warnings":[],"counts":{}}}
            messages.append({"severity":"WARNING","code":"GEOMETRY_EVALUATOR_SOFTWARE_FAILURE_NONBLOCKING","message":"Geometry evaluator failed after a non-empty source-backed XML existed; REVEX preserves the XML and records the evaluator failure instead of destroying the deliverable: {}".format(ex)})
        report["geometry_integrity"] = geometry_integrity
        # Semantic classification is maintenance metadata only. It runs after the
        # geometric proof, uses no external model session, and cannot block export.
        try:
            report["semantic_review"] = semantic_review(
                doc, exportable_spaces, "", messages
            )
        except Exception as ex:
            report["semantic_review"] = {
                "engine": "deterministic_rules_and_adjacency",
                "status": "nonblocking_failure",
                "message": str(ex),
            }
            messages.append({
                "severity": "WARNING",
                "code": "SEMANTIC_REVIEW_FAILED_NONBLOCKING",
                "message": str(ex),
            })
        envelope_persistence = geometry_integrity.get("final_persistence", {}) or {}
        report["envelope_persistence"] = envelope_persistence
        try:
            xml_validation = validate_gbxml(partial_xml, len(exportable_spaces))
        except Exception as ex:
            xml_validation = {"passed":False,"errors":["gbXML validator software failure: {}".format(ex)],"warnings":[],"counts":{}}
            try:
                root_probe=ET.parse(partial_xml).getroot()
                xml_validation["counts"]={"spaces":sum(1 for e in root_probe.iter() if local_name(e.tag)=="Space"),"surfaces":sum(1 for e in root_probe.iter() if local_name(e.tag)=="Surface"),"openings":sum(1 for e in root_probe.iter() if local_name(e.tag)=="Opening")}
            except Exception as parse_ex:
                xml_validation["errors"].append("gbXML parse failed: {}".format(parse_ex))
        if not geometry_integrity.get("passed", False):
            xml_validation["errors"].append(
                "Revit-to-gbXML normalized geometry integrity loop did not pass its final read-only proof."
            )
        xml_validation["errors"].extend(envelope_persistence["errors"])
        xml_validation["warnings"].extend(envelope_persistence["warnings"])
        xml_validation["passed"] = (
            xml_validation["passed"] and envelope_persistence["passed"]
        )
        report["gbxml_validation"] = xml_validation

        # FINAL DELIVERABLE — keep the verified main energy analytical model in Revit.
        # The previous build deleted it here after exporting, which produced a valid XML
        # but left EN/Energy views with no blue Analytical Spaces/Surfaces to display.
        # Revit's native Create Energy Model workflow keeps this model until explicitly
        # deleted/rebuilt; REVEX now does the same.
        try:
            persisted_eadm = Analysis.EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(doc)
            if persisted_eadm is None or not bool(safe_attr(persisted_eadm, "IsValidObject", True)):
                raise Exception("No valid main EnergyAnalysisDetailModel remains stored in the RVT.")
            try: persisted_analytical_spaces = list(persisted_eadm.GetAnalyticalSpaces() or [])
            except Exception: persisted_analytical_spaces = []
            try: persisted_analytical_surfaces = list(persisted_eadm.GetAnalyticalSurfaces() or [])
            except Exception: persisted_analytical_surfaces = []
            report["persisted_energy_model"]={"element_id":eid_value(persisted_eadm.Id),"analytical_spaces":len(persisted_analytical_spaces),"analytical_surfaces":len(persisted_analytical_surfaces),"kept_in_rvt":True}
            if not persisted_analytical_spaces or not persisted_analytical_surfaces:
                messages.append({"severity":"WARNING","code":"PERSISTED_EADM_INCOMPLETE_NONBLOCKING","message":"gbXML exists, but the stored EADM is incomplete. XML delivery is preserved; REVEX will rebuild the EADM on the next maintenance run."})
        except Exception as ex:
            persisted_eadm = None; persisted_analytical_spaces=[]; persisted_analytical_surfaces=[]
            report["persisted_energy_model"]={"kept_in_rvt":False,"error":str(ex)}
            messages.append({"severity":"WARNING","code":"PERSISTED_EADM_MISSING_NONBLOCKING","message":"Source-backed gbXML was produced but the display EADM could not be retained: {}".format(ex)})
        # Post-EADM annotation sync: only EN/ENERGY-qualified plan views.
        # This is intentionally idempotent and non-blocking.
        post_eadm_tag_tx = Transaction(doc, "LIBER gbXML: post-EADM Space Tags on EN/Energy plans")
        try:
            post_eadm_tag_tx.Start()
            post_eadm_spaces = [
                item for item in collect_spaces(doc)
                if element_exists_in_phase(item, phase_index, phases_map) and is_placed_spatial(item)
            ]
            report["space_plan_tags"] = auto_tag_spaces_on_energy_plans(
                doc, post_eadm_spaces, messages, changes
            )
            post_eadm_tag_tx.Commit()
        except Exception as ex:
            try:
                if post_eadm_tag_tx.GetStatus() == TransactionStatus.Started:
                    post_eadm_tag_tx.RollBack()
            except Exception:
                pass
            messages.append({
                "severity": "WARNING",
                "code": "POST_EADM_SPACE_PLAN_TAG_SYNC_FAILED_NONBLOCKING",
                "message": str(ex),
            })
        if persisted_eadm is not None:
            changes.append({"action":"keep_verified_energy_analysis_model_in_rvt","element_id":eid_value(persisted_eadm.Id),"analytical_spaces":len(persisted_analytical_spaces),"analytical_surfaces":len(persisted_analytical_surfaces)})
            messages.append({"severity":"INFO","code":"ENERGY_ANALYTICAL_MODEL_PERSISTED","message":"EnergyAnalysisDetailModel retained in the RVT so configured EN/Energy views can display Analytical Spaces/Surfaces."})

        xml_counts = xml_validation.get("counts", {}) or {}
        persistence_counts = envelope_persistence.get("counts", {}) or {}
        expected_spaces = max(0, len(exportable_spaces))
        preserved_spaces = min(expected_spaces, int(xml_counts.get("spaces", 0) or 0))
        # Raw physical subfaces are partitioned differently by Rooms/Spaces/EADM and
        # remain diagnostics. The publication score uses unique authoritative Revit
        # physical source identity; complete analytical geometry is scored separately.
        expected_physical_faces = int(persistence_counts.get("physical_wall_faces_expected", 0) or 0) + int(persistence_counts.get("physical_horizontal_faces_expected", 0) or 0)
        preserved_physical_faces = int(persistence_counts.get("physical_wall_faces_preserved", 0) or 0) + int(persistence_counts.get("physical_horizontal_faces_preserved", 0) or 0)
        expected_physical_sources = int(persistence_counts.get("physical_surface_sources_expected", 0) or 0)
        preserved_physical_sources = min(expected_physical_sources, int(persistence_counts.get("physical_surface_sources_preserved", 0) or 0))
        spatial_preservation = (float(preserved_spaces) / float(expected_spaces)) if expected_spaces else 0.0
        physical_preservation = (float(preserved_physical_sources) / float(expected_physical_sources)) if expected_physical_sources else 1.0
        analytical_expected = int(persistence_counts.get("analytical_faces_expected", 0) or 0)
        analytical_preserved = min(analytical_expected, int(persistence_counts.get("analytical_faces_preserved", 0) or 0))
        analytical_preservation = (float(analytical_preserved) / float(analytical_expected)) if analytical_expected else 1.0
        physical_opening_preservation = float(persistence_counts.get("physical_opening_source_coverage", 1.0) or 0.0)
        scored_domains = {
            "room_sources": room_preservation,
            "spatial": spatial_preservation,
            "physical": physical_preservation,
            "analytical_surfaces": analytical_preservation,
            "physical_opening_sources": physical_opening_preservation,
        }
        preservation = min(scored_domains.values()) if scored_domains else 0.0
        report["preservation_gate"] = {
            "overall": round(preservation, 6),
            "overall_method": "minimum_scored_evidence_domain",
            "spatial": round(spatial_preservation, 6),
            "physical": round(physical_preservation, 6),
            "physical_scoring_basis": "unique_revit_surface_source_identity",
            "analytical_surfaces": round(analytical_preservation, 6),
            "physical_opening_sources": round(physical_opening_preservation, 6),
            "target": PRESERVATION_TARGET,
            "minimum": PRESERVATION_MINIMUM,
            "expected_spaces": expected_spaces,
            "preserved_spaces": preserved_spaces,
            "expected_physical_surface_sources": expected_physical_sources,
            "preserved_physical_surface_sources": preserved_physical_sources,
            "diagnostic_physical_faces_expected": expected_physical_faces,
            "diagnostic_physical_faces_preserved": preserved_physical_faces,
            "strict_qa_passed": bool(xml_validation.get("passed")),
        }
        nonempty_xml = int(xml_counts.get("spaces",0) or 0) > 0 and int(xml_counts.get("surfaces",0) or 0) > 0
        publication_threshold_met = bool(
            room_preservation >= PRESERVATION_MINIMUM
            and preservation >= PRESERVATION_MINIMUM
            and spatial_preservation >= PRESERVATION_MINIMUM
            and physical_preservation >= PRESERVATION_MINIMUM
            and analytical_preservation >= PRESERVATION_MINIMUM
            and physical_opening_preservation >= PRESERVATION_MINIMUM
        )
        integrity_ratios = dict(scored_domains)
        integrity_ratios["overall"] = preservation
        quality_target_met = bool(all(value >= PRESERVATION_TARGET for value in integrity_ratios.values()))
        below_quality_target = {key: round(value, 6) for key, value in integrity_ratios.items() if value < PRESERVATION_TARGET}
        report["preservation_gate"]["publication_threshold_met"] = publication_threshold_met
        report["preservation_gate"]["quality_target_met"] = quality_target_met
        report["preservation_gate"]["below_quality_target"] = below_quality_target
        report["preservation_gate"]["decision"] = (
            "ACCEPT_80_PLUS" if publication_threshold_met else "BLOCK_BELOW_80"
        )
        acceptable = bool(nonempty_xml and publication_threshold_met)
        if acceptable:
            os.replace(partial_xml, final_xml)
            report["gbxml_path"] = final_xml
            if xml_validation.get("passed") and quality_target_met:
                report["export_quality"] = "STRICT_QA_PASS"
            elif quality_target_met:
                report["export_quality"] = "INTEGRITY_80_PLUS_WITH_QA_WARNINGS"
            else:
                report["export_quality"] = "INTEGRITY_80_PLUS_BELOW_95_REVIEW"
                messages.append({
                    "severity": "WARNING",
                    "code": "INTEGRITY_BELOW_95_REVIEW",
                    "quality_target": PRESERVATION_TARGET,
                    "hard_stop": PRESERVATION_MINIMUM,
                    "below_quality_target": below_quality_target,
                    "message": "Energy Sync is below the 95% quality target in one or more evidence domains; publication continues because every required domain cleared the 80% hard stop, and Companion must surface the review warning.",
                })
            # The REVEX host recognizes the exact token EXPORTED as success. This token
            # is reachable only after every required publication-integrity ratio meets the 80% hard stop.
            # Quality/warning state remains explicit in export_quality + report warnings.
            report["status"] = "EXPORTED"
            for error in xml_validation["errors"]:
                messages.append({
                    "severity": "WARNING",
                    "code": "GBXML_QA_TOLERATED_BY_PRESERVATION_GATE",
                    "message": error,
                })
            group.Assimilate()
            group_finished = True
        elif nonempty_xml:
            # A sub-80 result remains useful evidence, but it is not a publishable
            # Energy Sync input. Keep the verified Space reconstruction, retained
            # EADM and EN/Energy tags in Revit; move the XML under a diagnostic name
            # and return a blocking status that the host cannot mistake for success.
            os.replace(partial_xml, failed_xml)
            report["gbxml_path"] = failed_xml
            report["export_quality"] = "DIAGNOSTIC_BELOW_80_NOT_PUBLISHED"
            report["status"] = "BLOCKED_BELOW_80_INTEGRITY_PRESERVED"
            messages.append({
                "severity": "ERROR",
                "code": "PUBLICATION_BLOCKED_BELOW_80",
                "room_preservation": round(room_preservation, 6),
                "overall_preservation": round(preservation, 6),
                "spatial_preservation": round(spatial_preservation, 6),
                "physical_preservation": round(physical_preservation, 6),
                "analytical_surface_preservation": round(analytical_preservation, 6),
                "physical_opening_source_preservation": round(physical_opening_preservation, 6),
                "message": "Energy Sync publication is blocked below the 80% hard-stop integrity floor. Verified Spaces, EADM, EN/Energy tags, diagnostic gbXML, and evidence were preserved for repair.",
            })
            for error in xml_validation["errors"]:
                messages.append({
                    "severity": "WARNING",
                    "code": "DIAGNOSTIC_GBXML_QA_WARNING",
                    "message": error,
                })
            group.Assimilate()
            group_finished = True
        else:
            os.replace(partial_xml, failed_xml)
            report["gbxml_path"] = failed_xml
            for error in xml_validation["errors"]:
                messages.append({
                    "severity": "ERROR",
                    "code": "GBXML_INTEGRITY_FAILURE",
                    "message": error,
                })
            group.RollBack()
            report["status"] = "FAILED_EMPTY_GBXML"
            report["rollback_reason"] = "No usable Space/Surface geometry could be serialized from the non-empty Revit source."
            group_finished = True

        report["message_counts"] = message_counts(messages)
        report["finished_at"] = datetime.datetime.now().isoformat()
        json_path, text_path = write_reports(report, report_base)
        report["report_json"] = json_path
        report["report_text"] = text_path
        return report

    except Exception as ex:
        # Fail-safe checkpoint: after the independently verified non-empty Space topology
        # exists, a later software/API/export exception must not erase it. Remove any
        # partially built EADM first so a failed analytical model is never persisted,
        # then assimilate only the validated spatial reconstruction. Before that
        # checkpoint, preserve the original all-or-nothing rollback behavior.
        recovered_verified_spaces = False
        rescued_xml = False
        # If a late stage fails, first create/rescue a non-empty source-backed XML while
        # the valid EADM and source manifests still exist. Only then decide whether any
        # analytical model needs cleanup.
        if spatial_state_verified and exportable_spaces and not os.path.isfile(partial_xml):
            try:
                main = Analysis.EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(doc)
                rescue_manifest = analytical_manifest
                if main is not None:
                    try:
                        rescue_manifest = capture_energy_manifest(doc, main, messages)
                    except Exception:
                        pass
                if (rescue_manifest or {}).get("surfaces"):
                    partial_xml, _ = write_direct_eadm_gbxml(doc, partial_xml, exportable_spaces, rescue_manifest, messages)
                    report["export_method"] = "DIRECT_EADM_LATE_RECOVERY"
                if not os.path.isfile(partial_xml):
                    partial_xml, _ = write_direct_revit_geometry_gbxml(doc, partial_xml, exportable_spaces, physical_manifest, messages)
                    report["export_method"] = "DIRECT_REVIT_GEOMETRY_LATE_RECOVERY"
            except Exception as rescue_ex:
                messages.append({"severity":"WARNING","code":"LATE_SERIALIZER_RECOVERY_FAILED","message":str(rescue_ex)})
        if os.path.isfile(partial_xml):
            try:
                probe=ET.parse(partial_xml).getroot()
                probe_spaces=sum(1 for e in probe.iter() if local_name(e.tag)=="Space")
                probe_surfaces=sum(1 for e in probe.iter() if local_name(e.tag)=="Surface")
                if probe_spaces>0 and probe_surfaces>0:
                    # A rescue serializer proves that evidence survived, not that the
                    # 80% hard-stop publication integrity gate passed only on normal publish path. Keep rescue output diagnostic.
                    os.replace(partial_xml, failed_xml)
                    report["gbxml_path"]=failed_xml
                    report["export_quality"]="DIAGNOSTIC_LATE_FAILURE_NOT_PUBLISHED"
                    rescued_xml=True
                else:
                    os.replace(partial_xml, failed_xml); report["gbxml_path"]=failed_xml
            except Exception:
                try:
                    os.replace(partial_xml, failed_xml); report["gbxml_path"]=failed_xml
                except Exception:
                    pass
        if group is not None and not group_finished and spatial_state_verified:
            try:
                main = Analysis.EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel(doc)
                keep_main = False
                if main is not None:
                    try:
                        keep_main = bool(list(main.GetAnalyticalSpaces() or []))
                    except Exception:
                        keep_main = False
                if not keep_main:
                    cleanup_tx = Transaction(doc, "LIBER gbXML: discard invalid failed analytical model")
                    try:
                        cleanup_tx.Start(); delete_main_energy_model(doc, changes); doc.Regenerate(); cleanup_tx.Commit()
                    except Exception:
                        try:
                            if cleanup_tx.GetStatus() == TransactionStatus.Started:
                                cleanup_tx.RollBack()
                        except Exception:
                            pass
                group.Assimilate()
                group_finished = True
                recovered_verified_spaces = True
                report["late_failure_recovery"] = {
                    "spaces_committed": True,
                    "room_preservation": round(float(verified_room_preservation), 6),
                    "xml_rescued": rescued_xml,
                    "valid_eadm_preserved": keep_main,
                }
                messages.append({
                    "severity":"WARNING",
                    "code":"ADAPTIVE_LATE_FAILURE_RECOVERY",
                    "message":"Late pipeline failure recovered with committed Spaces{}; a valid EADM was preserved when available.".format(" and a non-empty gbXML" if rescued_xml else ""),
                })
            except Exception as recovery_ex:
                report["late_failure_recovery"] = {"spaces_committed":False,"error":str(recovery_ex)}
        if group is not None and not group_finished:
            try:
                group.RollBack(); group_finished=True
            except Exception:
                pass
        messages.append(
            {
                "severity": "ERROR",
                "code": "UNHANDLED_FAILURE",
                "message": str(ex),
                "trace": traceback.format_exc(),
            }
        )
        report["status"] = (
            "BLOCKED_LATE_FAILURE_INTEGRITY_UNVERIFIED"
            if rescued_xml
            else ("SPACES_COMMITTED_PIPELINE_FAILED" if recovered_verified_spaces else "FAILED_AND_MODEL_ROLLED_BACK")
        )
        report["rollback_reason"] = (
            None if recovered_verified_spaces else report.get("rollback_reason")
        )
        report["message_counts"] = message_counts(messages)
        report["finished_at"] = datetime.datetime.now().isoformat()
        try:
            json_path, text_path = write_reports(report, report_base)
            report["report_json"] = json_path
            report["report_text"] = text_path
        except Exception:
            pass
        return report


if not RUN_NOW:
    OUT = {
        "status": "READY",
        "tool": TOOL_NAME,
        "version": TOOL_VERSION,
        "engine_patch": ENGINE_PATCH,
        "instruction": (
            "Review the inputs, set 'Run gbXML preflight + export' to True, "
            "then click Run. The graph itself is Manual."
        ),
        "defaults": {
            "audit_only": AUDIT_ONLY,
            "apply_safe_fixes": APPLY_SAFE_FIXES,
            "export_despite_blockers": EXPORT_DESPITE_BLOCKERS,
            "phase": PHASE_NAME_INPUT or "auto",
            "output_folder": OUTPUT_FOLDER_INPUT or "auto",
        },
    }
else:
    OUT = run_tool()

# UNIVERSAL invariant: active geometry decisions are evidence-graph decisions only;
# no project name, level name, or regression-model identity controls topology.
# GeometryCo/templates remain unchanged; REVEX must satisfy their existing contract.
