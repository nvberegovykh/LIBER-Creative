#!/usr/bin/env python3
"""
OpenStudio Baseline + Proposed Geometry Compiler

Template-agnostic, fail-safe geometry replacement for paired baseline and proposed OpenStudio OSM files.
It imports exact geometry from a geometry OSM and transfers each template's
space/zone/construction/load behavior by handles, geometry, and object roles.
Schedule objects are immutable: compilation aborts if any existing schedule
object or existing schedule reference changes.

Designed for OpenStudio 3.x OSM text models. Shapely 2.1+ is required by
default for precise footprint/overlap matching.

Examples:
  python OpenStudio_Energy_Model_Geometry_Compiler.py --gui

  python OpenStudio_Energy_Model_Geometry_Compiler.py \
      --geometry "updated.osm" \
      --baseline "approved baseline.osm" \
      --proposed "approved proposed.osm" \
      --outdir "Compiled Energy Models"

Safety model:
- Exact new vertices, pairings, and opening-parent relationships are retained.
- Existing schedule definitions and protected schedule references are locked.
- No object-name lookup is required for constructions, schedules, zones, or HVAC.
- Space behavior is inferred by an offline architectural agent using room names,
  template examples, adjacency, level, size, exposure, geometry, and anonymous profiles.
- Ambiguous assignments stop compilation unless explicitly overridden in JSON.
- Direct objects attached to old spaces are cloned/remapped to matched new spaces.
- Surface/subsurface constructions are inferred from the template's own usage.
"""
from __future__ import annotations

import argparse
import copy
import csv
import difflib
import hashlib
import html as html_lib
import json
import queue
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import webbrowser
import zipfile
import sys
import traceback
import uuid
from collections import Counter, defaultdict
from datetime import datetime
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

UUID_RE = re.compile(r"^\{[0-9a-fA-F-]{36}\}$")

COMPILER_VERSION = "4.3.1"
MINIMUM_MAPPING_CONFIDENCE = 0.75

BASE_GEOMETRY_TYPES = {
    "OS:Space",
    "OS:Surface",
    "OS:SubSurface",
    "OS:ShadingSurfaceGroup",
    "OS:ShadingSurface",
    "OS:InteriorPartitionSurfaceGroup",
    "OS:InteriorPartitionSurface",
    "OS:DaylightingControl",
    "OS:IlluminanceMap",
}
GEOMETRY_TYPES = set(BASE_GEOMETRY_TYPES)
PRIMARY_GEOMETRY_TYPES = {"OS:Space", "OS:Surface", "OS:SubSurface"}
SCHEDULE_PREFIX = "OS:Schedule"
SPACE_ASSIGNMENT_FIELDS = {
    "space_type": 2,
    "construction_set": 3,
    "schedule_set": 4,
    "story": 9,
    "thermal_zone": 10,
    "part_of_total_floor_area": 11,
    "outdoor_air": 12,
    "building_unit": 13,
}
PROFILE_FIELDS = (2, 3, 4, 10, 11, 12, 13)

# Ordered architectural vocabulary for the offline space-use agent.  The
# conditioning family is not written into the model directly; it is used to
# learn which anonymous behavior profile in each approved template represents
# that family.  Specific phrases must precede generic tokens such as "room".
ARCHITECTURAL_USE_RULES = (
    ("mechanical_shaft", "unconditioned_core", 0.99, ("mechanicalshaft", "mechshaft", "serviceshaft", "shaft")),
    ("elevator", "unconditioned_core", 0.98, ("elevator", "lift")),
    ("crawlspace", "unconditioned_core", 0.97, ("crawlspace", "crawl")),
    ("plenum_or_attic", "unconditioned_core", 0.96, ("plenum", "attic")),
    ("amenity", "occupied_or_accessory", 0.99, ("amenity", "coworking", "communityroom", "clubroom", "lounge")),
    ("bedroom", "occupied_or_accessory", 0.99, ("bedroom", "sleepingroom")),
    ("living_room", "occupied_or_accessory", 0.99, ("livingroom", "familyroom")),
    ("kitchen", "occupied_or_accessory", 0.99, ("kitchen", "kitchenette")),
    ("bathroom", "occupied_or_accessory", 0.99, ("bathroom", "restroom", "toiletroom", "washroom", "powderroom")),
    ("laundry_closet", "occupied_or_accessory", 0.98, ("washerdryercloset", "laundrycloset", "wdcl")),
    ("walk_in_closet", "occupied_or_accessory", 0.98, ("walkincloset",)),
    ("package_room", "occupied_or_accessory", 0.98, ("packageroom", "mailroom")),
    ("vertical_circulation", "occupied_or_accessory", 0.98, ("interiorstair", "stairs", "stair")),
    ("circulation", "occupied_or_accessory", 0.98, ("hallway", "corridor", "foyer", "lobby")),
    ("building_service_room", "occupied_or_accessory", 0.96, ("electrichotwaterheaterroom", "mechanicalroom", "electricroom", "electricalroom", "waterroom", "sprinklerroom", "boilerroom", "equipmentcloset")),
    ("storage", "occupied_or_accessory", 0.96, ("refusestorage", "bicycleroom", "opencellar", "storage", "cellar", "bikeroom")),
    ("office", "occupied_or_accessory", 0.98, ("office", "workroom")),
    ("closet", "occupied_or_accessory", 0.96, ("closet", "wardrobe")),
    ("generic_room", "occupied_or_accessory", 0.90, ("room", "space")),
)

DEFAULT_SEMANTIC_CATEGORIES = {
    family: tuple(
        token
        for _use, rule_family, _confidence, tokens in ARCHITECTURAL_USE_RULES
        if rule_family == family
        for token in tokens
    )
    for family in ("unconditioned_core", "occupied_or_accessory")
}

# Objects that are geometry metadata, not template behavior.
GEOMETRY_METADATA_TYPES = {"OS:AdditionalProperties"}

# Types that are generated from geometry-dependent values when used.
GEOMETRY_DEPENDENT_CONSTRUCTIONS = {
    "OS:Construction:FfactorGroundFloor",
    "OS:Construction:CfactorUndergroundWall",
}


class CompileError(RuntimeError):
    pass


@dataclass
class OSMObject:
    obj_type: str
    fields: List[str]
    source_index: int = 0
    source_path: str = ""

    @property
    def handle(self) -> Optional[str]:
        return self.fields[0] if self.fields and UUID_RE.fullmatch(self.fields[0]) else None

    @handle.setter
    def handle(self, value: str) -> None:
        if self.fields:
            self.fields[0] = value
        else:
            self.fields = [value]

    @property
    def name(self) -> str:
        if self.handle and len(self.fields) > 1:
            return self.fields[1]
        return self.fields[0] if self.fields else ""

    def clone(self) -> "OSMObject":
        return OSMObject(self.obj_type, list(self.fields), self.source_index, self.source_path)


@dataclass
class ModelData:
    path: Path
    objects: List[OSMObject]
    by_handle: Dict[str, OSMObject] = field(init=False)
    by_type: Dict[str, List[OSMObject]] = field(init=False)

    def __post_init__(self) -> None:
        self.reindex()

    def reindex(self) -> None:
        self.by_handle = {}
        self.by_type = defaultdict(list)
        for obj in self.objects:
            self.by_type[obj.obj_type].append(obj)
            if obj.handle:
                if obj.handle in self.by_handle:
                    raise CompileError(f"Duplicate handle {obj.handle} in {self.path}")
                self.by_handle[obj.handle] = obj


def parse_osm(path: Path) -> ModelData:
    text = path.read_text(encoding="utf-8-sig", errors="strict")
    objects: List[OSMObject] = []
    tokens: List[str] = []
    buf: List[str] = []
    in_quote = False
    quote_char = ""
    in_comment = False
    source_index = 0

    def flush_token() -> None:
        tokens.append("".join(buf).strip())
        buf.clear()

    for ch in text:
        if in_comment:
            if ch in "\r\n":
                in_comment = False
                buf.append(" ")
            continue
        if not in_quote and ch == "!":
            in_comment = True
            continue
        if ch in ('"', "'"):
            if not in_quote:
                in_quote = True
                quote_char = ch
            elif quote_char == ch:
                in_quote = False
            buf.append(ch)
            continue
        if not in_quote and ch in ",;":
            flush_token()
            if ch == ";":
                while tokens and tokens[0] == "":
                    tokens.pop(0)
                if tokens:
                    objects.append(OSMObject(tokens[0], tokens[1:], source_index, str(path)))
                    source_index += 1
                tokens = []
            continue
        buf.append(ch)

    if in_quote:
        raise CompileError(f"Unterminated quote in {path}")
    if "".join(buf).strip() or any(t.strip() for t in tokens):
        raise CompileError(f"Trailing unterminated object in {path}")
    if not objects:
        raise CompileError(f"No OSM objects parsed from {path}")
    return ModelData(path, objects)


def model_summary(model: ModelData) -> Dict[str, int]:
    counts = Counter(o.obj_type for o in model.objects)
    return {
        "objects": len(model.objects),
        "spaces": counts.get("OS:Space", 0),
        "surfaces": counts.get("OS:Surface", 0),
        "subsurfaces": counts.get("OS:SubSurface", 0),
        "stories": counts.get("OS:BuildingStory", 0),
        "thermal_zones": counts.get("OS:ThermalZone", 0),
        "schedules": sum(v for k, v in counts.items() if k.startswith("OS:Schedule")),
        "constructions": sum(v for k, v in counts.items() if k.startswith("OS:Construction")),
        "loads": sum(v for k, v in counts.items() if k.startswith((
            "OS:People", "OS:Lights", "OS:ElectricEquipment", "OS:GasEquipment",
            "OS:OtherEquipment", "OS:SpaceInfiltration", "OS:WaterUse"
        ))),
        "hvac_plant": sum(v for k, v in counts.items() if any(token in k for token in (
            "AirLoopHVAC", "PlantLoop", "ZoneHVAC", "Coil:", "Fan:", "Boiler",
            "Chiller", "WaterHeater", "HeatExchanger", "Pump:"
        ))),
    }


def behavior_object_count(summary: Dict[str, int]) -> int:
    return (summary["schedules"] + summary["constructions"] + summary["loads"] +
            summary["hvac_plant"] + summary["thermal_zones"])


def validate_selection_roles(geometry: ModelData, templates: Sequence[Tuple[str, ModelData]]) -> List[str]:
    """Catch accidental role reversal before compiling.

    This is deliberately conservative: it rejects only clear reversals, while
    allowing a full OSM to be used as the geometry source.
    """
    errors: List[str] = []
    if not geometry.by_type.get("OS:Space") or not geometry.by_type.get("OS:Surface"):
        errors.append("NEW GEOMETRY must contain OS:Space and OS:Surface objects.")
    gs = model_summary(geometry)
    for role, template in templates:
        ts = model_summary(template)
        if not template.by_type.get("OS:Space") or not template.by_type.get("OS:Surface"):
            errors.append(f"{role} template must contain OS:Space and OS:Surface objects.")
            continue
        # Clear reversal: the selected 'template' is almost geometry-only while
        # the selected geometry contains a much richer approved-model payload.
        if behavior_object_count(ts) <= 25 and behavior_object_count(gs) >= max(45, behavior_object_count(ts) * 3):
            errors.append(
                f"{role} appears to be the geometry file, while NEW GEOMETRY appears to be an approved template. "
                f"Selection fingerprints: geometry behavior={behavior_object_count(gs)}, "
                f"{role.lower()} behavior={behavior_object_count(ts)}. Re-select the dedicated fields."
            )
        if ts["thermal_zones"] == 0:
            errors.append(f"{role} template has no thermal zones; it cannot preserve HVAC zoning safely.")
    return errors


def geometry_import_types(geometry: ModelData) -> set[str]:
    types = set(BASE_GEOMETRY_TYPES)
    # Building stories belong to the geometry arrangement when the source has
    # them. If it has none, template stories are retained and spaces are mapped
    # to the nearest template story.
    if geometry.by_type.get("OS:BuildingStory"):
        types.add("OS:BuildingStory")
    return types


def geometry_handle_set_for_types(model: ModelData, types: set[str]) -> set[str]:
    return {o.handle for o in model.objects if o.obj_type in types and o.handle}


def write_osm(path: Path, objects: Sequence[OSMObject]) -> None:
    lines: List[str] = []
    for obj in objects:
        if not obj.fields:
            lines.extend([f"{obj.obj_type};", ""])
            continue
        lines.append(f"{obj.obj_type},")
        for i, value in enumerate(obj.fields):
            lines.append(f"  {value}{';' if i == len(obj.fields)-1 else ','}")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def new_handle() -> str:
    return "{" + str(uuid.uuid4()) + "}"


def _float(value: str, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def geometry_vertex_start(obj_type: str) -> Optional[int]:
    """Return the first coordinate field index for geometry objects in OSM 3.x.

    OS:SubSurface has two scalar fields after Frame and Divider Name:
    Multiplier (field 8) and Number of Vertices (field 9). Coordinates therefore
    begin at field 10, not field 8. Keeping this schema in one function prevents
    repairs from overwriting those required fields.
    """
    return {
        "OS:Surface": 11,
        "OS:SubSurface": 10,
        "OS:ShadingSurface": 5,
        "OS:InteriorPartitionSurface": 5,
    }.get(obj_type)


def geometry_layout_errors(obj: OSMObject) -> List[str]:
    """Validate the scalar prefix and coordinate extensibles before geometry use."""
    start = geometry_vertex_start(obj.obj_type)
    if start is None:
        return []
    errors: List[str] = []
    if len(obj.fields) < start:
        return [f"{obj.obj_type} {obj.name} is truncated before vertex fields"]
    coords = obj.fields[start:]
    if len(coords) % 3 != 0:
        errors.append(
            f"{obj.obj_type} {obj.name} has {len(coords)} coordinate values; expected a multiple of 3"
        )
    for index, value in enumerate(coords, start):
        try:
            float(value)
        except (TypeError, ValueError):
            errors.append(f"{obj.obj_type} {obj.name} has nonnumeric coordinate field {index}: {value!r}")
            break
    if obj.obj_type == "OS:SubSurface":
        # Multiplier may be blank (OpenStudio default) or a positive number.
        multiplier = obj.fields[8] if len(obj.fields) > 8 else ""
        if multiplier:
            try:
                if float(multiplier) <= 0:
                    errors.append(f"OS:SubSurface {obj.name} has invalid Multiplier {multiplier!r}")
            except ValueError:
                errors.append(f"OS:SubSurface {obj.name} has nonnumeric Multiplier {multiplier!r}")
    # Number of Vertices may be blank or an integer matching the extensible
    # coordinate count. Surface and SubSurface use different scalar indices.
    count_index = {"OS:Surface": 10, "OS:SubSurface": 9}.get(obj.obj_type)
    if count_index is not None:
        declared = obj.fields[count_index] if len(obj.fields) > count_index else ""
        if declared:
            try:
                declared_n = int(float(declared))
                actual_n = len(coords) // 3 if len(coords) % 3 == 0 else -1
                if declared_n != actual_n:
                    errors.append(
                        f"{obj.obj_type} {obj.name} declares {declared_n} vertices but contains {actual_n}"
                    )
            except ValueError:
                errors.append(f"{obj.obj_type} {obj.name} has invalid Number of Vertices {declared!r}")
    return errors


def vertices(obj: OSMObject) -> List[Tuple[float, float, float]]:
    start = geometry_vertex_start(obj.obj_type)
    if start is None or len(obj.fields) < start:
        return []
    raw = obj.fields[start:]
    if len(raw) % 3 != 0:
        return []
    points: List[Tuple[float, float, float]] = []
    for i in range(0, len(raw), 3):
        try:
            points.append((float(raw[i]), float(raw[i+1]), float(raw[i+2])))
        except (TypeError, ValueError):
            return []
    return points


def transform_points(space: Optional[OSMObject], pts: Sequence[Tuple[float, float, float]]) -> List[Tuple[float, float, float]]:
    if not space:
        return list(pts)
    angle = math.radians(_float(space.fields[5]) if len(space.fields) > 5 else 0.0)
    ox = _float(space.fields[6]) if len(space.fields) > 6 else 0.0
    oy = _float(space.fields[7]) if len(space.fields) > 7 else 0.0
    oz = _float(space.fields[8]) if len(space.fields) > 8 else 0.0
    ca, sa = math.cos(angle), math.sin(angle)
    return [(ox + x*ca - y*sa, oy + x*sa + y*ca, oz + z) for x, y, z in pts]


def object_points_global(model: ModelData, obj: OSMObject) -> List[Tuple[float, float, float]]:
    pts = vertices(obj)
    if obj.obj_type == "OS:Surface" and len(obj.fields) > 4:
        return transform_points(model.by_handle.get(obj.fields[4]), pts)
    if obj.obj_type == "OS:SubSurface" and len(obj.fields) > 4:
        parent = model.by_handle.get(obj.fields[4])
        space = model.by_handle.get(parent.fields[4]) if parent and len(parent.fields) > 4 else None
        return transform_points(space, pts)
    return pts


def newell_area_and_normal(points: Sequence[Tuple[float, float, float]]) -> Tuple[float, Tuple[float, float, float]]:
    if len(points) < 3:
        return 0.0, (0.0, 0.0, 0.0)
    nx = ny = nz = 0.0
    for i, p in enumerate(points):
        q = points[(i+1) % len(points)]
        nx += (p[1]-q[1])*(p[2]+q[2])
        ny += (p[2]-q[2])*(p[0]+q[0])
        nz += (p[0]-q[0])*(p[1]+q[1])
    norm = math.sqrt(nx*nx + ny*ny + nz*nz)
    if norm <= 1e-15:
        return 0.0, (0.0, 0.0, 0.0)
    return 0.5*norm, (nx/norm, ny/norm, nz/norm)


def planarity_error(points: Sequence[Tuple[float, float, float]]) -> float:
    if len(points) < 4:
        return 0.0
    _, n = newell_area_and_normal(points)
    if n == (0.0, 0.0, 0.0):
        return float("inf")
    p0 = points[0]
    return max(abs((p[0]-p0[0])*n[0] + (p[1]-p0[1])*n[1] + (p[2]-p0[2])*n[2]) for p in points)


def _energyplus_effective_vertex_count(
    points: Sequence[Tuple[float, float, float]],
    short_edge_tolerance: float=0.01,
) -> int:
    """Approximate EnergyPlus short-edge vertex cleanup before simulation.

    EnergyPlus drops a vertex when two consecutive vertices are less than
    0.01 m apart. A triangle that loses one vertex becomes a fatal degenerate
    surface even when its mathematical area is nonzero.
    """
    work = list(points)
    while len(work) >= 3:
        dropped = False
        for index in range(len(work)):
            if math.dist(work[index - 1], work[index]) < short_edge_tolerance:
                del work[index]
                dropped = True
                break
        if not dropped:
            break
    return len(work)




def _vec_sub(a: Sequence[float], b: Sequence[float]) -> Tuple[float, float, float]:
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def _vec_add(a: Sequence[float], b: Sequence[float]) -> Tuple[float, float, float]:
    return (a[0]+b[0], a[1]+b[1], a[2]+b[2])


def _vec_scale(a: Sequence[float], value: float) -> Tuple[float, float, float]:
    return (a[0]*value, a[1]*value, a[2]*value)


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]


def _cross(a: Sequence[float], b: Sequence[float]) -> Tuple[float, float, float]:
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def _unit(a: Sequence[float]) -> Tuple[float, float, float]:
    n = math.sqrt(_dot(a, a))
    if n <= 1e-15:
        return (0.0, 0.0, 0.0)
    return (a[0]/n, a[1]/n, a[2]/n)


def _plane_basis(points: Sequence[Tuple[float, float, float]]) -> Optional[Tuple[Tuple[float,float,float],Tuple[float,float,float],Tuple[float,float,float],Tuple[float,float,float]]]:
    if len(points) < 3:
        return None
    _, normal = newell_area_and_normal(points)
    if normal == (0.0, 0.0, 0.0):
        return None
    longest = max(range(len(points)), key=lambda i: math.dist(points[i], points[(i+1) % len(points)]))
    u = _unit(_vec_sub(points[(longest+1) % len(points)], points[longest]))
    if u == (0.0, 0.0, 0.0):
        return None
    v = _unit(_cross(normal, u))
    return (points[0], u, v, normal)


def _project_plane(points: Sequence[Tuple[float,float,float]], basis: Tuple[Any,...]) -> List[Tuple[float,float]]:
    origin, u, v, _normal = basis
    return [(_dot(_vec_sub(point, origin), u), _dot(_vec_sub(point, origin), v)) for point in points]


def _unproject_plane(points: Sequence[Tuple[float,float]], basis: Tuple[Any,...]) -> List[Tuple[float,float,float]]:
    origin, u, v, _normal = basis
    return [_vec_add(origin, _vec_add(_vec_scale(u, x), _vec_scale(v, y))) for x, y in points]


def _set_vertices(obj: OSMObject, points: Sequence[Tuple[float,float,float]]) -> None:
    start = geometry_vertex_start(obj.obj_type)
    if start is None:
        raise CompileError(f"Object type {obj.obj_type} does not support vertices")
    if len(obj.fields) < start:
        raise CompileError(f"{obj.obj_type} {obj.name} is truncated before vertex fields")
    fields = list(obj.fields[:start])
    count_index = {"OS:Surface": 10, "OS:SubSurface": 9}.get(obj.obj_type)
    if count_index is not None:
        while len(fields) <= count_index:
            fields.append("")
        fields[count_index] = str(len(points))
    for point in points:
        fields.extend(f"{float(value):.14g}" for value in point)
    obj.fields = fields


def _inverse_transform_points(space: Optional[OSMObject], pts: Sequence[Tuple[float,float,float]]) -> List[Tuple[float,float,float]]:
    if not space:
        return list(pts)
    angle = math.radians(_float(space.fields[5]) if len(space.fields) > 5 else 0.0)
    ox = _float(space.fields[6]) if len(space.fields) > 6 else 0.0
    oy = _float(space.fields[7]) if len(space.fields) > 7 else 0.0
    oz = _float(space.fields[8]) if len(space.fields) > 8 else 0.0
    ca, sa = math.cos(angle), math.sin(angle)
    result=[]
    for gx, gy, gz in pts:
        dx, dy = gx-ox, gy-oy
        result.append((dx*ca + dy*sa, -dx*sa + dy*ca, gz-oz))
    return result


def _polygon_parts(geom: Any) -> List[Any]:
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    result=[]
    for child in getattr(geom, "geoms", []):
        result.extend(_polygon_parts(child))
    return result


def _projected_polygon_convexity(poly: Any) -> Dict[str, float]:
    area = float(poly.area)
    hull_area = float(poly.convex_hull.area)
    deficit = max(0.0, hull_area - area)
    tolerance = max(1e-10, area * 1e-8)
    return {
        "area": area,
        "convex_hull_area": hull_area,
        "convexity_deficit": deficit,
        "convexity_ratio": deficit / area if area > 0 else 0.0,
        "is_nonconvex": deficit > tolerance,
    }


def _merge_adjacent_convex_parts(parts: Sequence[Any], max_vertices: int=4) -> List[Any]:
    """Recombine a triangle mesh into exact convex triangles/quads.

    Constrained triangulation can create numerically fragile needle triangles
    along short boundary offsets. EnergyPlus may classify one of their nearly
    straight corners as collinear and reduce a three-sided face to fewer than
    three vertices. Prefer the longest shared edge at every merge so those
    slivers are absorbed first. A merge is accepted only when the exact union
    is one valid, hole-free, convex polygon with no more than max_vertices.
    """
    work = [part for part in parts if part is not None and not part.is_empty]
    total_area = sum(float(part.area) for part in work)
    tolerance = max(1e-10, total_area * 1e-10)
    while True:
        best: Optional[Tuple[float, int, int, Any]] = None
        for left in range(len(work)):
            for right in range(left + 1, len(work)):
                shared = float(
                    work[left].boundary.intersection(work[right].boundary).length
                )
                if shared <= tolerance:
                    continue
                merged = work[left].union(work[right])
                merged_parts = _polygon_parts(merged)
                if len(merged_parts) != 1:
                    continue
                polygon = merged_parts[0]
                coords = list(polygon.exterior.coords)[:-1]
                if (
                    not polygon.is_valid
                    or polygon.interiors
                    or len(coords) < 3
                    or len(coords) > max_vertices
                ):
                    continue
                metrics = _projected_polygon_convexity(polygon)
                if metrics["is_nonconvex"]:
                    continue
                area_error = abs(
                    float(polygon.area)
                    - float(work[left].area)
                    - float(work[right].area)
                )
                if area_error > tolerance:
                    continue
                candidate = (shared, left, right, polygon)
                if best is None or candidate[0] > best[0]:
                    best = candidate
        if best is None:
            break
        _shared, left, right, polygon = best
        work[left] = polygon
        del work[right]
    work.sort(key=lambda part: (
        round(float(part.centroid.x), 12),
        round(float(part.centroid.y), 12),
        round(float(part.area), 12),
    ))
    return work


def _triangulate_projected_polygon(poly: Any, basis: Tuple[Any, ...]) -> Tuple[List[List[Tuple[float,float,float]]], Dict[str,float]]:
    """Triangulate an already projected Polygon, including polygons with holes.

    Shapely 2.1 constrained Delaunay triangulation is used here because an
    opening carrier cut from the middle of a base surface leaves a hole in the
    opaque remainder. Unconstrained Delaunay triangles can cross that hole and
    silently duplicate area.
    """
    try:
        from shapely import constrained_delaunay_triangles
        from shapely.ops import unary_union
    except Exception as exc:
        raise CompileError(
            "Shapely 2.1 or newer is required for lossless non-convex surface repair around openings"
        ) from exc
    if not poly.is_valid or poly.area <= 1e-10:
        raise CompileError("Cannot triangulate an invalid projected polygon")
    piece_polys = [
        part for part in _polygon_parts(constrained_delaunay_triangles(poly))
        if part.area > 1e-10
    ]
    if not piece_polys:
        raise CompileError("Constrained surface decomposition produced no pieces")
    piece_polys = _merge_adjacent_convex_parts(piece_polys, max_vertices=4)
    union = unary_union(piece_polys)
    missing = float(poly.difference(union).area)
    extra = float(union.difference(poly).area)
    area_error = abs(sum(float(part.area) for part in piece_polys) - float(poly.area))
    tolerance = max(1e-9, float(poly.area) * 1e-9)
    if missing > tolerance or extra > tolerance or area_error > tolerance:
        raise CompileError(
            f"Constrained surface decomposition failed (missing={missing:.6g}, "
            f"extra={extra:.6g}, area_error={area_error:.6g})"
        )
    for part in piece_polys:
        metrics = _projected_polygon_convexity(part)
        if part.interiors or metrics["is_nonconvex"]:
            raise CompileError("Constrained surface decomposition returned a non-convex piece")
    pieces = [
        _unproject_plane(list(part.exterior.coords)[:-1], basis)
        for part in piece_polys
    ]
    return pieces, {
        "original_area": float(poly.area),
        "piece_area": sum(float(part.area) for part in piece_polys),
        "missing_area": missing,
        "extra_area": extra,
    }


def _convex_opening_carriers(parent_poly: Any, child_polys: Sequence[Any]) -> List[Tuple[Any, List[int]]]:
    """Create disjoint convex base-surface regions that contain child openings.

    The carrier boundary is an internal partition only: the exterior parent
    boundary and every opening vertex remain unchanged. Names are not used.
    """
    try:
        from shapely.ops import unary_union
    except Exception as exc:
        raise CompileError("Shapely is required for opening-aware surface decomposition") from exc
    if not child_polys:
        return []
    tolerance = max(1e-10, float(parent_poly.area) * 1e-9)
    margin = max(1e-5, math.sqrt(float(parent_poly.area)) * 1e-4)
    for index, child in enumerate(child_polys):
        if not child.is_valid or child.area <= tolerance:
            raise CompileError(f"Child opening polygon {index + 1} is invalid or degenerate")
        if not parent_poly.buffer(tolerance).covers(child):
            raise CompileError(
                f"Child opening polygon {index + 1} extends outside its non-convex parent; "
                "lossless parent decomposition is not possible"
            )

    def build(group: List[int]) -> Any:
        hull = unary_union([child_polys[index] for index in group]).convex_hull
        if hull.difference(parent_poly.buffer(tolerance)).area > tolerance:
            raise CompileError(
                "Openings span a concave recess in their parent surface; "
                "a single lossless convex carrier cannot contain them"
            )
        local_margin = margin
        for _attempt in range(20):
            candidate = hull.buffer(local_margin, join_style=2).intersection(parent_poly).buffer(0)
            parts = _polygon_parts(candidate)
            if len(parts) == 1:
                carrier = parts[0]
                metrics = _projected_polygon_convexity(carrier)
                if (
                    not carrier.interiors
                    and not metrics["is_nonconvex"]
                    and carrier.buffer(tolerance).covers(hull)
                    and carrier.area > hull.area + tolerance
                ):
                    return carrier
            local_margin *= 0.5
        raise CompileError(
            "Could not form a positive-area convex carrier around child openings "
            "without moving the parent or opening boundary"
        )

    groups: List[List[int]] = [[index] for index in range(len(child_polys))]
    while True:
        carriers = [build(group) for group in groups]
        merge_pair: Optional[Tuple[int, int]] = None
        for left in range(len(carriers)):
            for right in range(left + 1, len(carriers)):
                if carriers[left].intersection(carriers[right]).area > tolerance:
                    merge_pair = (left, right)
                    break
            if merge_pair:
                break
        if not merge_pair:
            return list(zip(carriers, groups))
        left, right = merge_pair
        groups[left] = sorted(groups[left] + groups[right])
        del groups[right]


def _partition_surface_around_openings(
    model: ModelData,
    surf: OSMObject,
    children: Sequence[OSMObject],
) -> Tuple[List[List[Tuple[float,float,float]]], Dict[str,int], Dict[str,float]]:
    """Return convex global-coordinate pieces and child-to-piece assignments."""
    try:
        from shapely.geometry import Polygon
        from shapely.ops import unary_union
    except Exception as exc:
        raise CompileError("Shapely is required for opening-aware surface decomposition") from exc
    parent_points = object_points_global(model, surf)
    basis = _plane_basis(parent_points)
    if basis is None:
        raise CompileError(f"Cannot partition degenerate casting surface {surf.name}")
    parent_poly = Polygon(_project_plane(parent_points, basis))
    if not parent_poly.is_valid or parent_poly.area <= 1e-10:
        raise CompileError(f"Cannot partition invalid casting surface {surf.name}")
    child_polys = [
        Polygon(_project_plane(object_points_global(model, child), basis))
        for child in children
    ]
    carriers = _convex_opening_carriers(parent_poly, child_polys)
    projected_pieces = [carrier for carrier, _indices in carriers]
    assignments: Dict[str, int] = {}
    for piece_index, (_carrier, indices) in enumerate(carriers):
        for child_index in indices:
            child_handle = children[child_index].handle
            if child_handle:
                assignments[child_handle] = piece_index

    carrier_union = unary_union(projected_pieces)
    remainder = parent_poly.difference(carrier_union)
    remainder_piece_area = 0.0
    for part in _polygon_parts(remainder):
        if part.area <= 1e-10:
            continue
        global_parts, part_metrics = _triangulate_projected_polygon(part, basis)
        projected_parts = [
            Polygon(_project_plane(points, basis))
            for points in global_parts
        ]
        projected_pieces.extend(projected_parts)
        remainder_piece_area += part_metrics["piece_area"]

    union = unary_union(projected_pieces)
    missing = float(parent_poly.difference(union).area)
    extra = float(union.difference(parent_poly).area)
    piece_area = sum(float(piece.area) for piece in projected_pieces)
    area_error = abs(piece_area - float(parent_poly.area))
    tolerance = max(1e-9, float(parent_poly.area) * 1e-9)
    if missing > tolerance or extra > tolerance or area_error > tolerance:
        raise CompileError(
            f"Opening-aware surface decomposition failed (missing={missing:.6g}, "
            f"extra={extra:.6g}, area_error={area_error:.6g})"
        )
    global_pieces = [
        _unproject_plane(list(piece.exterior.coords)[:-1], basis)
        for piece in projected_pieces
    ]
    return global_pieces, assignments, {
        "original_area": float(parent_poly.area),
        "piece_area": piece_area,
        "missing_area": missing,
        "extra_area": extra,
        "carrier_area": sum(float(carrier.area) for carrier, _indices in carriers),
        "remainder_piece_area": remainder_piece_area,
    }


def _triangulate_planar_polygon(points: Sequence[Tuple[float,float,float]]) -> Tuple[List[List[Tuple[float,float,float]]], Dict[str,float]]:
    try:
        from shapely.geometry import Polygon
        from shapely.ops import triangulate, unary_union
    except Exception as exc:
        raise CompileError("Shapely 2.1+ is required for lossless EnergyPlus opening decomposition") from exc
    basis = _plane_basis(points)
    if basis is None:
        raise CompileError("Cannot triangulate a degenerate opening")
    poly = Polygon(_project_plane(points, basis))
    if not poly.is_valid or poly.area <= 1e-10:
        raise CompileError("Cannot triangulate an invalid opening polygon")
    pieces=[]
    piece_polys=[]
    for triangle in triangulate(poly):
        clipped = triangle.intersection(poly)
        for part in _polygon_parts(clipped):
            coords=list(part.exterior.coords)[:-1]
            if part.area <= 1e-10:
                continue
            if len(coords) > 4:
                for nested in triangulate(part):
                    nested_clip=nested.intersection(part)
                    for npart in _polygon_parts(nested_clip):
                        ncoords=list(npart.exterior.coords)[:-1]
                        if 3 <= len(ncoords) <= 4 and npart.area > 1e-10:
                            piece_polys.append(npart)
                            pieces.append(_unproject_plane(ncoords, basis))
            elif 3 <= len(coords) <= 4:
                piece_polys.append(part)
                pieces.append(_unproject_plane(coords, basis))
    if not piece_polys:
        raise CompileError("Opening decomposition produced no EnergyPlus-compatible pieces")
    piece_polys = _merge_adjacent_convex_parts(piece_polys, max_vertices=4)
    pieces = [
        _unproject_plane(list(part.exterior.coords)[:-1], basis)
        for part in piece_polys
    ]
    union=unary_union(piece_polys)
    missing=float(poly.difference(union).area)
    extra=float(union.difference(poly).area)
    area_error=abs(sum(float(x.area) for x in piece_polys)-float(poly.area))
    tol=max(1e-9, float(poly.area)*1e-9)
    if missing > tol or extra > tol or area_error > tol:
        raise CompileError(
            f"Lossless opening decomposition failed (missing={missing:.6g}, extra={extra:.6g}, area_error={area_error:.6g})"
        )
    original_normal=newell_area_and_normal(points)[1]
    oriented=[]
    for piece in pieces:
        if _dot(newell_area_and_normal(piece)[1], original_normal) < 0:
            piece=list(reversed(piece))
        oriented.append(piece)
    return oriented, {"original_area": float(poly.area), "piece_area": sum(float(x.area) for x in piece_polys), "missing_area": missing, "extra_area": extra}


def _casting_surface_convexity(model: ModelData, obj: OSMObject) -> Optional[Dict[str, float]]:
    """Return planar polygon convexity metrics for an EnergyPlus shadow-casting object.

    Splitting is triggered only when the polygon is genuinely concave beyond
    floating-point tolerance. The boundary is never moved; the polygon is
    replaced by an exact union of coplanar triangles/quads.
    """
    if obj.obj_type == "OS:Surface":
        boundary = obj.fields[5].strip().lower() if len(obj.fields) > 5 else ""
        sun = obj.fields[7].strip().lower() if len(obj.fields) > 7 else ""
        if boundary != "outdoors" or sun != "sunexposed":
            return None
    elif obj.obj_type != "OS:ShadingSurface":
        return None
    try:
        from shapely.geometry import Polygon
    except Exception as exc:
        raise CompileError("Shapely 2.1+ is required for casting-surface convexity checks") from exc
    pts = object_points_global(model, obj)
    basis = _plane_basis(pts)
    if basis is None:
        raise CompileError(f"Cannot evaluate degenerate casting surface {obj.name}")
    poly = Polygon(_project_plane(pts, basis))
    if not poly.is_valid or poly.area <= 1e-10:
        raise CompileError(f"Casting surface {obj.name} is invalid or degenerate")
    return _projected_polygon_convexity(poly)


def _semantic_references(model: ModelData, handle: str, ignore_handles: Optional[set[str]]=None) -> List[Tuple[str,str,int]]:
    ignored=set(ignore_handles or set())
    result=[]
    for obj in model.objects:
        if obj.handle in ignored or obj.obj_type == "OS:AdditionalProperties":
            continue
        for index, value in enumerate(obj.fields):
            if value == handle:
                result.append((obj.obj_type, obj.name, index))
    return result


def repair_energyplus_geometry(model: ModelData, report: Optional[dict]=None, enabled: bool=True) -> List[dict]:
    """Apply only provably lossless geometry compatibility repairs.

    EnergyPlus 25.1 accepts at most four vertices for a detailed fenestration
    surface. A valid >4-vertex OpenStudio SubSurface is decomposed into coplanar
    triangles/quads whose exact union equals the source polygon. No boundary is
    moved, rounded, simplified, or discarded.
    """
    repairs=[]
    if not enabled:
        return repairs
    processed=set()
    additions=[]
    ap_additions=[]
    for sub in list(model.by_type.get("OS:SubSurface", [])):
        if not sub.handle or sub.handle in processed or len(vertices(sub)) <= 4:
            continue
        mate=model.by_handle.get(sub.fields[5]) if len(sub.fields)>5 and sub.fields[5] else None
        pair_handles={sub.handle}
        if mate and mate.obj_type == "OS:SubSurface" and mate.handle:
            pair_handles.add(mate.handle)
        refs=_semantic_references(model, sub.handle, pair_handles)
        if mate and mate.handle:
            refs += _semantic_references(model, mate.handle, pair_handles)
        if refs:
            raise CompileError(
                f"SubSurface {sub.name} has more than four vertices and is referenced by semantic objects {refs[:6]}; "
                "lossless splitting cannot preserve those references automatically."
            )
        global_points=object_points_global(model, sub)
        pieces, metrics=_triangulate_planar_polygon(global_points)
        if mate and mate.obj_type == "OS:SubSurface":
            mate_points=object_points_global(model, mate)
            if Counter(tuple(round(v,7) for v in point) for point in global_points) != Counter(tuple(round(v,7) for v in point) for point in mate_points):
                raise CompileError(f"Paired SubSurface {sub.name} has >4 vertices but its mate is not geometrically congruent")
            parent_a=model.by_handle.get(sub.fields[4]) if len(sub.fields)>4 else None
            parent_b=model.by_handle.get(mate.fields[4]) if len(mate.fields)>4 else None
            space_a=model.by_handle.get(parent_a.fields[4]) if parent_a and len(parent_a.fields)>4 else None
            space_b=model.by_handle.get(parent_b.fields[4]) if parent_b and len(parent_b.fields)>4 else None
            normal_a=newell_area_and_normal(global_points)[1]
            normal_b=newell_area_and_normal(mate_points)[1]
            pairs=[]
            for index, global_piece in enumerate(pieces,1):
                ga=list(global_piece)
                gb=list(global_piece)
                if _dot(newell_area_and_normal(ga)[1], normal_a) < 0: ga.reverse()
                if _dot(newell_area_and_normal(gb)[1], normal_b) < 0: gb.reverse()
                a=sub if index==1 else sub.clone()
                b=mate if index==1 else mate.clone()
                if index>1:
                    a.handle=new_handle(); b.handle=new_handle()
                    a.fields[1]=f"{sub.name}__EP_part_{index:02d}"
                    b.fields[1]=f"{mate.name}__EP_part_{index:02d}"
                    additions.extend([a,b])
                while len(a.fields)<=5: a.fields.append("")
                while len(b.fields)<=5: b.fields.append("")
                a.fields[5]=b.handle or ""; b.fields[5]=a.handle or ""
                _set_vertices(a, _inverse_transform_points(space_a, ga))
                _set_vertices(b, _inverse_transform_points(space_b, gb))
                pairs.append((a,b))
            for ap in list(model.by_type.get("OS:AdditionalProperties", [])):
                if len(ap.fields)>1 and ap.fields[1] in pair_handles:
                    original=ap.fields[1]
                    corresponding=[a if original==sub.handle else b for a,b in pairs]
                    for target in corresponding[1:]:
                        clone=ap.clone(); clone.handle=new_handle(); clone.fields[1]=target.handle or ""; ap_additions.append(clone)
            processed.update(pair_handles)
            repairs.append({"type":"paired_subsurface_decomposition","source":sub.name,"mate":mate.name,"original_vertices":len(global_points),"pieces":len(pieces),**metrics})
        else:
            parent=model.by_handle.get(sub.fields[4]) if len(sub.fields)>4 else None
            space=model.by_handle.get(parent.fields[4]) if parent and len(parent.fields)>4 else None
            created=[]
            for index, global_piece in enumerate(pieces,1):
                obj=sub if index==1 else sub.clone()
                if index>1:
                    obj.handle=new_handle(); obj.fields[1]=f"{sub.name}__EP_part_{index:02d}"; additions.append(obj)
                _set_vertices(obj, _inverse_transform_points(space, global_piece))
                created.append(obj)
            for ap in list(model.by_type.get("OS:AdditionalProperties", [])):
                if len(ap.fields)>1 and ap.fields[1]==sub.handle:
                    for target in created[1:]:
                        clone=ap.clone(); clone.handle=new_handle(); clone.fields[1]=target.handle or ""; ap_additions.append(clone)
            processed.add(sub.handle)
            repairs.append({"type":"subsurface_decomposition","source":sub.name,"original_vertices":len(global_points),"pieces":len(pieces),**metrics})
    # EnergyPlus shadow calculations require convex casting surfaces. OpenStudio
    # accepts concave exterior/shading polygons, so they can survive OSM loading
    # and ForwardTranslation but later produce Severe errors in
    # DetermineShadowingCombinations. Decompose only objects with no child
    # openings; every piece retains the original construction, space, exposure,
    # and exact boundary union. Names are diagnostics only.
    surface_additions=[]
    surface_ap_additions=[]
    for obj_type in ("OS:Surface", "OS:ShadingSurface"):
        for surf in list(model.by_type.get(obj_type, [])):
            if not surf.handle:
                continue
            metrics = _casting_surface_convexity(model, surf)
            if not metrics or not metrics.get("is_nonconvex"):
                continue
            children = [
                sub for sub in model.by_type.get("OS:SubSurface", [])
                if len(sub.fields) > 4 and sub.fields[4] == surf.handle
            ]
            ignored_references = {surf.handle}
            ignored_references.update(child.handle for child in children if child.handle)
            refs = _semantic_references(model, surf.handle, ignored_references)
            if refs:
                raise CompileError(
                    f"Non-convex casting surface {surf.name} is referenced by semantic objects {refs[:6]}; "
                    "lossless splitting cannot preserve those references automatically."
                )
            global_points = object_points_global(model, surf)
            child_piece_assignments: Dict[str, int] = {}
            if children:
                pieces, child_piece_assignments, area_metrics = _partition_surface_around_openings(
                    model, surf, children
                )
                repair_type = "nonconvex_casting_surface_with_openings_decomposition"
            else:
                pieces, area_metrics = _triangulate_planar_polygon(global_points)
                repair_type = "nonconvex_casting_surface_decomposition"
            original_normal = newell_area_and_normal(global_points)[1]
            space = model.by_handle.get(surf.fields[4]) if surf.obj_type == "OS:Surface" and len(surf.fields) > 4 else None
            created=[]
            for index, global_piece in enumerate(pieces, 1):
                piece=list(global_piece)
                if _dot(newell_area_and_normal(piece)[1], original_normal) < 0:
                    piece.reverse()
                target = surf if index == 1 else surf.clone()
                if index > 1:
                    target.handle = new_handle()
                    target.fields[1] = f"{surf.name}__EP_convex_part_{index:02d}"
                    surface_additions.append(target)
                local_piece = _inverse_transform_points(space, piece) if surf.obj_type == "OS:Surface" else piece
                _set_vertices(target, local_piece)
                created.append(target)
            reassigned_children = 0
            for child in children:
                piece_index = child_piece_assignments.get(child.handle or "", 0)
                if piece_index >= len(created):
                    raise CompileError(
                        f"Internal opening-aware decomposition error for casting surface {surf.name}"
                    )
                target_handle = created[piece_index].handle or ""
                if len(child.fields) <= 4:
                    raise CompileError(f"SubSurface {child.name} is truncated before its parent field")
                if child.fields[4] != target_handle:
                    child.fields[4] = target_handle
                    reassigned_children += 1
            for ap in list(model.by_type.get("OS:AdditionalProperties", [])):
                if len(ap.fields) > 1 and ap.fields[1] == surf.handle:
                    for target in created[1:]:
                        clone=ap.clone()
                        clone.handle=new_handle()
                        clone.fields[1]=target.handle or ""
                        surface_ap_additions.append(clone)
            repairs.append({
                "type": repair_type,
                "source": surf.name,
                "object_type": surf.obj_type,
                "original_vertices": len(global_points),
                "pieces": len(pieces),
                "child_openings": len(children),
                "reassigned_child_parents": reassigned_children,
                **{k:v for k,v in metrics.items() if k != "is_nonconvex"},
                **area_metrics,
            })

    if additions or ap_additions or surface_additions or surface_ap_additions:
        model.objects.extend(additions)
        model.objects.extend(ap_additions)
        model.objects.extend(surface_additions)
        model.objects.extend(surface_ap_additions)
        model.reindex()
    remaining_nonconvex = []
    for obj_type in ("OS:Surface", "OS:ShadingSurface"):
        for surf in model.by_type.get(obj_type, []):
            metrics = _casting_surface_convexity(model, surf)
            if metrics and metrics.get("is_nonconvex"):
                remaining_nonconvex.append(surf.name)
    if remaining_nonconvex:
        raise CompileError(
            "EnergyPlus compatibility repair left non-convex shadow-casting surfaces: "
            + ", ".join(remaining_nonconvex[:8])
        )
    if report is not None:
        report["energyplus_compatibility_repairs"]={
            "count":len(repairs),
            "repairs":repairs,
            "lossless":all(r.get("missing_area",0)<=1e-9 and r.get("extra_area",0)<=1e-9 for r in repairs),
        }
    return repairs

def normalized_name(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def semantic_name(s: str) -> str:
    s = s.lower()
    s = re.sub(r"^\s*sp[-_ ]*\d+", "", s)
    s = re.sub(r"\d+", "", s)
    return re.sub(r"[^a-z]+", "", s)


def additional_properties(model: ModelData) -> Dict[str, Dict[str, str]]:
    result: Dict[str, Dict[str, str]] = defaultdict(dict)
    for obj in model.by_type.get("OS:AdditionalProperties", []):
        if len(obj.fields) < 2:
            continue
        target = obj.fields[1]
        vals = obj.fields[2:]
        for i in range(0, len(vals)-2, 3):
            key, dtype, value = vals[i:i+3]
            result[target][key] = value
    return result


def space_volume(space: OSMObject, bbox: Optional[Tuple[float,float,float,float,float,float]] = None) -> float:
    if space.fields:
        v = _float(space.fields[-1], -1.0)
        if v >= 0:
            return v
    if bbox:
        return max(0.0, (bbox[1]-bbox[0])*(bbox[3]-bbox[2])*(bbox[5]-bbox[4]))
    return 0.0


@dataclass
class SpaceFeature:
    space: OSMObject
    bbox: Tuple[float,float,float,float,float,float]
    centroid: Tuple[float,float,float]
    footprint: Any
    area: float
    volume: float
    semantic: str
    properties: Dict[str,str]
    profile: Tuple[str, ...]


def safe_polygon(points: Sequence[Tuple[float,float,float]]) -> Any:
    try:
        from shapely.geometry import Polygon
        p = Polygon([(x,y) for x,y,_ in points])
        if not p.is_valid:
            p = p.buffer(0)
        return p if not p.is_empty else None
    except Exception:
        return None


def build_space_features(model: ModelData) -> Dict[str, SpaceFeature]:
    props = additional_properties(model)
    surfaces_by_space: Dict[str, List[OSMObject]] = defaultdict(list)
    for surf in model.by_type.get("OS:Surface", []):
        if len(surf.fields) > 4:
            surfaces_by_space[surf.fields[4]].append(surf)

    features: Dict[str, SpaceFeature] = {}
    for space in model.by_type.get("OS:Space", []):
        if not space.handle:
            continue
        pts: List[Tuple[float,float,float]] = []
        floor_polys = []
        for surf in surfaces_by_space.get(space.handle, []):
            gpts = object_points_global(model, surf)
            pts.extend(gpts)
            if len(surf.fields) > 2 and surf.fields[2] == "Floor":
                p = safe_polygon(gpts)
                if p is not None:
                    floor_polys.append(p)
        if not pts:
            bbox = (0,0,0,0,0,0)
            centroid = (0,0,0)
            footprint = None
            area = 0.0
        else:
            bbox = (min(p[0] for p in pts), max(p[0] for p in pts),
                    min(p[1] for p in pts), max(p[1] for p in pts),
                    min(p[2] for p in pts), max(p[2] for p in pts))
            try:
                from shapely.ops import unary_union
                if floor_polys:
                    footprint = unary_union(floor_polys)
                else:
                    from shapely.geometry import MultiPoint
                    footprint = MultiPoint([(p[0],p[1]) for p in pts]).convex_hull
                area = float(footprint.area) if footprint is not None else 0.0
                cx, cy = ((footprint.centroid.x, footprint.centroid.y) if footprint is not None else ((bbox[0]+bbox[1])/2,(bbox[2]+bbox[3])/2))
            except Exception:
                footprint = None
                area = max(0.0, (bbox[1]-bbox[0])*(bbox[3]-bbox[2]))
                cx, cy = (bbox[0]+bbox[1])/2, (bbox[2]+bbox[3])/2
            centroid = (cx, cy, (bbox[4]+bbox[5])/2)
        f = list(space.fields)
        while len(f) <= max(PROFILE_FIELDS):
            f.append("")
        profile = tuple(f[i] for i in PROFILE_FIELDS)
        features[space.handle] = SpaceFeature(
            space=space, bbox=bbox, centroid=centroid, footprint=footprint, area=area,
            volume=space_volume(space, bbox), semantic=semantic_name(space.name),
            properties=props.get(space.handle, {}), profile=profile,
        )
    return features


def architectural_space_classification(semantic: str) -> Optional[dict]:
    """Classify a normalized room label with an explainable architectural lexicon."""
    if not semantic:
        return None
    for use, family, confidence, tokens in ARCHITECTURAL_USE_RULES:
        matches = [token for token in tokens if token in semantic]
        if matches:
            return {
                "use": use,
                "family": family,
                "confidence": confidence,
                "matched_token": max(matches, key=len),
            }
    return None


def _space_adjacency(model: ModelData) -> Dict[str, set[str]]:
    """Return space adjacency from reciprocal Surface boundary references."""
    result: Dict[str, set[str]] = defaultdict(set)
    for surface in model.by_type.get("OS:Surface", []):
        if len(surface.fields) <= 6 or surface.fields[5] != "Surface":
            continue
        source_space = surface.fields[4]
        mate = model.by_handle.get(surface.fields[6])
        if not mate or mate.obj_type != "OS:Surface" or len(mate.fields) <= 4:
            continue
        target_space = mate.fields[4]
        if source_space and target_space and source_space != target_space:
            result[source_space].add(target_space)
            result[target_space].add(source_space)
    return result


def _space_context_texts(
    model: ModelData,
    features: Dict[str, SpaceFeature],
) -> Tuple[Dict[str, str], Dict[str, set[str]]]:
    """Build local-AI text that includes name, graph, level, size, and exposure."""
    adjacency = _space_adjacency(model)
    areas = sorted(feature.area for feature in features.values() if feature.area > 0)
    median_area = areas[len(areas) // 2] if areas else 1.0
    z_values = [feature.centroid[2] for feature in features.values()]
    z_min = min(z_values, default=0.0)
    z_max = max(z_values, default=z_min)
    outdoors = Counter(
        surface.fields[4]
        for surface in model.by_type.get("OS:Surface", [])
        if len(surface.fields) > 5 and surface.fields[5] == "Outdoors"
    )
    contexts: Dict[str, str] = {}
    for handle, feature in features.items():
        classification = architectural_space_classification(feature.semantic)
        use = classification["use"].replace("_", " ") if classification else "unknown architectural room"
        family = classification["family"].replace("_", " ") if classification else "unknown conditioning family"
        neighbour_uses: List[str] = []
        for neighbour in sorted(adjacency.get(handle, set())):
            other = features.get(neighbour)
            other_class = architectural_space_classification(other.semantic) if other else None
            neighbour_uses.append(
                other_class["use"].replace("_", " ")
                if other_class else (other.semantic if other and other.semantic else "unknown room")
            )
        area_ratio = feature.area / max(1e-9, median_area)
        size = "small" if area_ratio < 0.55 else "large" if area_ratio > 1.8 else "medium"
        if z_max - z_min < 0.5:
            level = "single level"
        else:
            relative_z = (feature.centroid[2] - z_min) / (z_max - z_min)
            level = "lowest level" if relative_z < 0.2 else "upper level" if relative_z > 0.8 else "middle level"
        exposure = "exterior exposed" if outdoors.get(handle, 0) else "interior"
        neighbours = ", ".join(neighbour_uses[:12]) if neighbour_uses else "none recorded"
        contexts[handle] = (
            f"Architectural space name: {feature.semantic or feature.space.name}. "
            f"Room use: {use}. Conditioning family: {family}. "
            f"Adjacent room uses: {neighbours}. "
            f"Building position: {level}; {size} floor area; {exposure}."
        )
    return contexts, adjacency


_LOCAL_AI_RUNTIME: Any = None
_LOCAL_AI_RUNTIME_ERROR: Optional[str] = None
_LOCAL_AI_EMBED_CACHE: Dict[str, List[float]] = {}


def _local_ai_embeddings(texts: Sequence[str]) -> Tuple[Optional[List[List[float]]], Optional[str], Optional[str]]:
    """Encode texts with the bundled model, caching identical context strings."""
    global _LOCAL_AI_RUNTIME, _LOCAL_AI_RUNTIME_ERROR
    if _LOCAL_AI_RUNTIME is None and _LOCAL_AI_RUNTIME_ERROR is None:
        try:
            module_dir = str(Path(__file__).resolve().parent)
            if module_dir not in sys.path:
                sys.path.insert(0, module_dir)
            from local_space_ai import LocalMiniLM
            _LOCAL_AI_RUNTIME = LocalMiniLM()
        except Exception as exc:
            _LOCAL_AI_RUNTIME_ERROR = str(exc)
    if _LOCAL_AI_RUNTIME is None:
        return None, None, _LOCAL_AI_RUNTIME_ERROR
    missing = [text for text in texts if text not in _LOCAL_AI_EMBED_CACHE]
    if missing:
        vectors = _LOCAL_AI_RUNTIME.encode(missing)
        _LOCAL_AI_EMBED_CACHE.update(zip(missing, vectors))
    return (
        [_LOCAL_AI_EMBED_CACHE[text] for text in texts],
        str(getattr(_LOCAL_AI_RUNTIME, "provider", "CPUExecutionProvider")),
        None,
    )


def _embedding_profile_scores(
    new_vector: Sequence[float],
    old_vectors: Dict[str, Sequence[float]],
    old_features: Dict[str, SpaceFeature],
) -> Tuple[Dict[Tuple[str, ...], float], float]:
    """Return profile probabilities from nearest pretrained semantic examples."""
    try:
        module_dir = str(Path(__file__).resolve().parent)
        if module_dir not in sys.path:
            sys.path.insert(0, module_dir)
        from local_space_ai import cosine_similarity
    except Exception:
        return {}, 0.0
    similarities: Dict[Tuple[str, ...], List[float]] = defaultdict(list)
    for handle, vector in old_vectors.items():
        similarities[old_features[handle].profile].append(cosine_similarity(new_vector, vector))
    prototype_scores: Dict[Tuple[str, ...], float] = {}
    for profile, values in similarities.items():
        strongest = sorted(values, reverse=True)[:3]
        prototype_scores[profile] = sum(strongest) / max(1, len(strongest))
    if not prototype_scores:
        return {}, 0.0
    top = max(prototype_scores.values())
    weights = {
        profile: math.exp((score - top) * 12.0)
        for profile, score in prototype_scores.items()
    }
    total = sum(weights.values())
    probabilities = {profile: weight / max(1e-12, total) for profile, weight in weights.items()}
    return probabilities, top


def bbox_overlap_3d(a: Tuple[float,...], b: Tuple[float,...]) -> float:
    dx=max(0.0,min(a[1],b[1])-max(a[0],b[0])); dy=max(0.0,min(a[3],b[3])-max(a[2],b[2])); dz=max(0.0,min(a[5],b[5])-max(a[4],b[4]))
    inter=dx*dy*dz
    va=max(1e-9,(a[1]-a[0])*(a[3]-a[2])*(a[5]-a[4]))
    vb=max(1e-9,(b[1]-b[0])*(b[3]-b[2])*(b[5]-b[4]))
    # Dice overlap penalizes a tiny space fully contained in a much larger one.
    return min(1.0, 2.0*inter/max(1e-9,va+vb))


def overlap_score(a: SpaceFeature, b: SpaceFeature) -> float:
    zov = max(0.0, min(a.bbox[5],b.bbox[5]) - max(a.bbox[4],b.bbox[4]))
    min_h = max(1e-9, min(a.bbox[5]-a.bbox[4], b.bbox[5]-b.bbox[4]))
    zscore = min(1.0, zov/min_h)
    if a.footprint is not None and b.footprint is not None:
        try:
            inter = a.footprint.intersection(b.footprint).area
            denom = max(1e-9, a.footprint.area + b.footprint.area)
            # Dice overlap is symmetric and resists false matches where a small
            # shaft is merely contained inside a large occupied room.
            return min(1.0, 2.0*inter/denom) * zscore
        except Exception:
            pass
    return bbox_overlap_3d(a.bbox,b.bbox)


def building_scale(features: Dict[str,SpaceFeature]) -> float:
    if not features:
        return 1.0
    xs=[f.centroid[0] for f in features.values()]; ys=[f.centroid[1] for f in features.values()]; zs=[f.centroid[2] for f in features.values()]
    return max(1.0, math.sqrt((max(xs)-min(xs))**2+(max(ys)-min(ys))**2+(max(zs)-min(zs))**2))


def candidate_score(
    new: SpaceFeature,
    old: SpaceFeature,
    scale: float,
    use_name_hints: bool = False,
    use_source_ids: bool = True,
) -> Tuple[float, Dict[str,float]]:
    """Score old/new spaces without requiring persistent names.

    Handles and stable exporter IDs are identity evidence. Otherwise the score
    is entirely geometric. Names can be enabled as a very small tie-breaker in
    config, but are ignored by default and can never force a profile match.
    """
    ov = overlap_score(new, old)
    dz = abs(new.centroid[2] - old.centroid[2])
    z = math.exp(-dz / max(0.5, scale * 0.08))
    dist = math.dist(new.centroid, old.centroid)
    near = math.exp(-dist / max(1.0, scale * 0.15))
    vr = min(new.volume, old.volume) / max(1e-9, max(new.volume, old.volume)) if new.volume > 0 and old.volume > 0 else 0.0
    ar = min(new.area, old.area) / max(1e-9, max(new.area, old.area)) if new.area > 0 and old.area > 0 else 0.0
    ndims = sorted((max(0.0, new.bbox[1]-new.bbox[0]), max(0.0, new.bbox[3]-new.bbox[2]), max(0.0, new.bbox[5]-new.bbox[4])))
    odims = sorted((max(0.0, old.bbox[1]-old.bbox[0]), max(0.0, old.bbox[3]-old.bbox[2]), max(0.0, old.bbox[5]-old.bbox[4])))
    shape = sum(min(a,b)/max(1e-9,max(a,b)) for a,b in zip(ndims,odims)) / 3.0
    handle_identity = 1.0 if new.space.handle and new.space.handle == old.space.handle else 0.0
    id_keys = ("gbXMLId", "CADObjectId")
    source_id = 0.0
    if use_source_ids:
        source_id = max((1.0 if new.properties.get(k) and new.properties.get(k) == old.properties.get(k) else 0.0) for k in id_keys)
    name_hint = 0.0
    if use_name_hints and new.semantic and old.semantic:
        name_hint = difflib.SequenceMatcher(None, new.semantic, old.semantic).ratio()

    score = 0.55*ov + 0.14*z + 0.12*near + 0.08*vr + 0.06*ar + 0.05*shape
    if use_name_hints:
        score = 0.97*score + 0.03*name_hint
    if source_id and z > 0.45:
        score = max(score, 0.96)
    if handle_identity:
        score = 1.0
    return min(1.0, score), {
        "overlap": ov,
        "z": z,
        "near": near,
        "volume": vr,
        "area": ar,
        "shape": shape,
        "handle_identity": handle_identity,
        "source_id": source_id,
        "name_hint": name_hint,
    }


def resolve_ref(model: ModelData, value: str) -> str:
    if not value:
        return ""
    o=model.by_handle.get(value)
    return f"{o.obj_type}:{o.name}" if o else value


def profile_description(model: ModelData, profile: Tuple[str,...]) -> Dict[str,str]:
    names=("space_type","construction_set","schedule_set","thermal_zone","part_of_total_floor_area","outdoor_air","building_unit")
    return {k: resolve_ref(model,v) if i in (0,1,2,3,5,6) else v for i,(k,v) in enumerate(zip(names,profile))}


def load_config(path: Optional[Path]) -> dict:
    if not path:
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def object_lookup(model: ModelData, token: str, allowed_type: Optional[str]=None) -> Optional[OSMObject]:
    if token in model.by_handle:
        o=model.by_handle[token]
        return o if allowed_type is None or o.obj_type==allowed_type else None
    n=normalized_name(token)
    matches=[o for o in model.objects if normalized_name(o.name)==n and (allowed_type is None or o.obj_type==allowed_type)]
    return matches[0] if len(matches)==1 else None


def match_spaces(template: ModelData, geometry: ModelData, config: dict, strict: bool=True) -> Tuple[Dict[str,str], Dict[str,Tuple[str,...]], List[dict], List[dict]]:
    """Map new spaces to anonymous template behavior profiles.

    The offline architectural agent chooses a template behavior profile first.
    It learns from room-use examples in the approved template, then gathers
    pretrained semantic, adjacency, level, size, exposure, and geometry evidence
    when a label alone is insufficient. Geometry chooses a source space only
    after the behavior profile is fixed, so an occupied amenity cannot inherit
    an unconditioned shaft profile merely because their old/new volumes overlap.
    """
    oldf = build_space_features(template)
    newf = build_space_features(geometry)
    if not oldf or not newf:
        raise CompileError("Both template and geometry must contain spaces with surfaces")
    scale = max(building_scale(oldf), building_scale(newf))
    overrides = config.get("space_overrides", {})
    threshold = max(MINIMUM_MAPPING_CONFIDENCE, float(config.get("minimum_match_score", MINIMUM_MAPPING_CONFIDENCE)))
    margin = float(config.get("ambiguity_margin", 0.08))
    use_name_hints = bool(config.get("use_name_hints", False))
    use_source_ids = bool(config.get("use_source_ids", True))
    use_semantic_fallback = bool(config.get("use_semantic_fallback", True))
    use_pretrained_local_ai = bool(config.get("use_pretrained_local_ai", True))
    semantic_threshold = max(
        MINIMUM_MAPPING_CONFIDENCE,
        float(config.get("semantic_profile_confidence", MINIMUM_MAPPING_CONFIDENCE)),
    )

    profiles = sorted({f.profile for f in oldf.values()}, key=lambda p: repr(p))
    single_profile = profiles[0] if len(profiles) == 1 else None
    profile_counts = Counter(feature.profile for feature in oldf.values())
    profile_total = sum(profile_counts.values())
    profile_priors = {
        profile: count / max(1, profile_total)
        for profile, count in profile_counts.items()
    }
    old_classes = {
        handle: architectural_space_classification(feature.semantic)
        for handle, feature in oldf.items()
    }
    new_classes = {
        handle: architectural_space_classification(feature.semantic)
        for handle, feature in newf.items()
    }
    use_evidence: Dict[str, Counter] = defaultdict(Counter)
    family_evidence: Dict[str, Counter] = defaultdict(Counter)
    for handle, classification in old_classes.items():
        if not classification:
            continue
        use_evidence[classification["use"]][oldf[handle].profile] += 1
        family_evidence[classification["family"]][oldf[handle].profile] += 1

    old_contexts, _old_adjacency = _space_context_texts(template, oldf)
    new_contexts, new_adjacency = _space_context_texts(geometry, newf)
    old_vectors: Dict[str, Sequence[float]] = {}
    new_vectors: Dict[str, Sequence[float]] = {}
    local_ai_provider: Optional[str] = None
    local_ai_error: Optional[str] = None
    if use_pretrained_local_ai:
        old_handles = list(oldf)
        new_handles = list(newf)
        context_order = [old_contexts[handle] for handle in old_handles] + [
            new_contexts[handle] for handle in new_handles
        ]
        vectors, local_ai_provider, local_ai_error = _local_ai_embeddings(context_order)
        if vectors:
            old_vectors = dict(zip(old_handles, vectors[: len(old_handles)]))
            new_vectors = dict(zip(new_handles, vectors[len(old_handles) :]))

    new_to_old: Dict[str,str] = {}
    new_profiles: Dict[str,Tuple[str,...]] = {}
    rows: List[dict] = []
    ambiguous: List[dict] = []

    for nh, nf in newf.items():
        override = overrides.get(nh) or overrides.get(nf.space.name)
        if override:
            old_token = override.get("match_old") if isinstance(override,dict) else str(override)
            old_obj = object_lookup(template, old_token, "OS:Space")
            if not old_obj or not old_obj.handle:
                raise CompileError(f"Invalid space override for {nf.space.name}: {old_token}")
            new_to_old[nh] = old_obj.handle
            new_profiles[nh] = oldf[old_obj.handle].profile
            rows.append({
                "new_space": nf.space.name, "new_handle": nh,
                "old_space": old_obj.name, "old_handle": old_obj.handle,
                "score": 1.0, "source_match_score": 1.0, "method": "override",
                "profile": profile_description(template, new_profiles[nh]), "ambiguous": False,
                "names_used": False, "suggestion_eligible": True,
                "minimum_confidence": threshold,
            })
            continue

        scored: List[Tuple[float,str,dict]] = []
        for oh, of in oldf.items():
            score, components = candidate_score(
                nf, of, scale,
                use_name_hints=use_name_hints,
                use_source_ids=use_source_ids,
            )
            scored.append((score, oh, components))
        scored.sort(reverse=True, key=lambda x:x[0])

        by_profile: Dict[Tuple[str,...], Tuple[float,str,dict]] = {}
        for raw_score, oh, components in scored:
            profile = oldf[oh].profile
            if profile not in by_profile or raw_score > by_profile[profile][0]:
                by_profile[profile] = (raw_score, oh, components)

        classification = new_classes.get(nh)
        category_profile = None
        category_confidence = 0.0
        category_name = None
        evidence_scope = None
        evidence_second = -1.0
        if use_semantic_fallback and classification:
            for scope, evidence in (
                ("room_use", use_evidence.get(classification["use"], Counter())),
                ("conditioning_family", family_evidence.get(classification["family"], Counter())),
            ):
                total = sum(evidence.values())
                if not total:
                    continue
                ranked_evidence = evidence.most_common()
                purity = ranked_evidence[0][1] / total
                confidence = min(float(classification["confidence"]), purity)
                if confidence >= semantic_threshold:
                    category_profile = ranked_evidence[0][0]
                    category_confidence = confidence
                    evidence_second = (
                        ranked_evidence[1][1] / total if len(ranked_evidence) > 1 else 0.0
                    )
                    category_name = classification["family"]
                    evidence_scope = scope
                    break

        embedding_probabilities: Dict[Tuple[str, ...], float] = {}
        embedding_similarity = 0.0
        if nh in new_vectors and old_vectors:
            embedding_probabilities, embedding_similarity = _embedding_profile_scores(
                new_vectors[nh], old_vectors, oldf
            )

        neighbour_votes: Counter = Counter()
        for neighbour in new_adjacency.get(nh, set()):
            neighbour_class = new_classes.get(neighbour)
            if not neighbour_class:
                continue
            evidence = family_evidence.get(neighbour_class["family"], Counter())
            total = sum(evidence.values())
            if not total:
                continue
            top_profile, top_count = evidence.most_common(1)[0]
            if top_count / total >= semantic_threshold:
                neighbour_votes[top_profile] += 1
        neighbour_total = sum(neighbour_votes.values())
        neighbour_probabilities = {
            profile: count / neighbour_total
            for profile, count in neighbour_votes.items()
        } if neighbour_total else {}

        geometry_ranked = sorted(
            ((score, profile, oh, comp) for profile, (score, oh, comp) in by_profile.items()),
            reverse=True, key=lambda x:x[0]
        )
        raw_geometry_score, geometry_profile, geometry_oh, geometry_comp = geometry_ranked[0]
        raw_second_geometry = geometry_ranked[1][0] if len(geometry_ranked) > 1 else -1.0
        geometry_separation = (
            1.0 if raw_second_geometry < 0
            else min(1.0, max(0.0, (raw_geometry_score - raw_second_geometry) / max(1e-9, margin)))
        )
        geometry_confidence = min(raw_geometry_score, geometry_separation)

        # If name/template evidence is insufficient, fuse every independent
        # evidence source.  The template prior is deliberately the lightest
        # signal; adjacency and the pretrained semantic model can overturn it.
        ensemble_probabilities: Dict[Tuple[str, ...], float] = defaultdict(float)
        ensemble_weight = 0.0
        if embedding_probabilities:
            for profile, probability in embedding_probabilities.items():
                ensemble_probabilities[profile] += 0.35 * probability
            ensemble_weight += 0.35
        if neighbour_probabilities:
            adjacency_weight = 0.30 if neighbour_total >= 3 else 0.15
            for profile, probability in neighbour_probabilities.items():
                ensemble_probabilities[profile] += adjacency_weight * probability
            ensemble_weight += adjacency_weight
        if geometry_ranked:
            geometry_weights = {
                profile: math.exp((score - raw_geometry_score) * 12.0)
                for score, profile, _oh, _comp in geometry_ranked
            }
            geometry_weight_total = sum(geometry_weights.values())
            for profile, weight in geometry_weights.items():
                ensemble_probabilities[profile] += 0.20 * weight / max(1e-12, geometry_weight_total)
            ensemble_weight += 0.20
        if profile_priors:
            for profile, probability in profile_priors.items():
                ensemble_probabilities[profile] += 0.15 * probability
            ensemble_weight += 0.15
        if ensemble_weight:
            ensemble_probabilities = {
                profile: score / ensemble_weight
                for profile, score in ensemble_probabilities.items()
            }

        if single_profile is not None:
            candidates = [(score, oh, comp) for score, oh, comp in scored if oldf[oh].profile == single_profile]
            source_score, best_oh, best_comp = candidates[0]
            best_profile = single_profile
            profile_score = 1.0
            second_profile_score = 0.0
            is_ambiguous = False
            method = "single_template_profile"
        elif category_profile is not None and category_profile in by_profile:
            best_profile = category_profile
            profile_score = category_confidence
            second_profile_score = evidence_second
            is_ambiguous = profile_score < threshold
            method = f"local_architectural_agent:{evidence_scope}"
        else:
            ensemble_ranked = sorted(
                ((probability, profile) for profile, probability in ensemble_probabilities.items()),
                reverse=True, key=lambda item: item[0]
            )
            if ensemble_ranked:
                profile_score, best_profile = ensemble_ranked[0]
                second_profile_score = ensemble_ranked[1][0] if len(ensemble_ranked) > 1 else 0.0
                method = "local_architectural_agent:context_ensemble"
            else:
                profile_score = geometry_confidence
                best_profile = geometry_profile
                second_profile_score = max(0.0, raw_second_geometry)
                method = "geometry_profile_match"
            is_ambiguous = profile_score < threshold

        # The selected old object is only a behavior source.  Prefer the same
        # architectural use inside the chosen profile, then the same family,
        # then geometry.  No old OS:Space replaces the new OS:Space object.
        profile_candidates = [
            (score, oh, comp)
            for score, oh, comp in scored
            if oldf[oh].profile == best_profile
        ]
        same_use_candidates = []
        same_family_candidates = []
        if classification:
            same_use_candidates = [
                item for item in profile_candidates
                if old_classes.get(item[1])
                and old_classes[item[1]]["use"] == classification["use"]
            ]
            same_family_candidates = [
                item for item in profile_candidates
                if old_classes.get(item[1])
                and old_classes[item[1]]["family"] == classification["family"]
            ]
        source_pool = same_use_candidates or same_family_candidates or profile_candidates
        source_score, best_oh, best_comp = source_pool[0]

        row = {
            "new_space": nf.space.name,
            "new_handle": nh,
            "old_space": oldf[best_oh].space.name,
            "old_handle": best_oh,
            "score": round(profile_score, 6),
            "source_match_score": round(source_score, 6),
            "second_profile_score": round(second_profile_score, 6),
            "components": {k: round(v, 6) for k, v in best_comp.items()},
            "method": method,
            "profile": profile_description(template, best_profile),
            "ambiguous": is_ambiguous,
            "suggestion_eligible": not is_ambiguous and profile_score >= threshold,
            "minimum_confidence": threshold,
            "names_used": bool(classification and method.startswith("local_architectural_agent")) or use_name_hints,
            "semantic_category_used": category_name,
            "architectural_use": classification["use"] if classification else None,
            "conditioning_family": classification["family"] if classification else None,
            "architectural_label_confidence": classification["confidence"] if classification else None,
            "architectural_matched_token": classification["matched_token"] if classification else None,
            "confidence_basis": evidence_scope if category_profile is not None else method.split(":", 1)[-1],
            "pretrained_model": "onnx-community/all-MiniLM-L6-v2-ONNX" if old_vectors else None,
            "local_ai_provider": local_ai_provider,
            "local_ai_error": local_ai_error,
            "pretrained_similarity": round(embedding_similarity, 6),
            "geometry_profile_score": round(raw_geometry_score, 6),
            "geometry_profile_confidence": round(geometry_confidence, 6),
            "adjacent_spaces_considered": len(new_adjacency.get(nh, set())),
        }
        if is_ambiguous:
            row["top_candidates"] = [
                {
                    "old_space": oldf[oh].space.name,
                    "old_handle": oh,
                    "score": round(score, 6),
                    "profile": profile_description(template, oldf[oh].profile),
                }
                for score, oh, _ in scored[:8]
            ]
            ambiguous.append(row)
        rows.append(row)
        new_to_old[nh] = best_oh
        new_profiles[nh] = best_profile

    return new_to_old, new_profiles, rows, ambiguous


def geometry_handle_set(model: ModelData) -> set[str]:
    return {o.handle for o in model.objects if o.obj_type in GEOMETRY_TYPES and o.handle}


def remap_collisions(objects: List[OSMObject], occupied: set[str]) -> Dict[str,str]:
    mapping={}; seen=set(occupied)
    for o in objects:
        if not o.handle: continue
        old=o.handle
        if old in seen:
            mapping[old]=new_handle(); o.handle=mapping[old]
        seen.add(o.handle)
    if mapping:
        for o in objects:
            o.fields=[mapping.get(v,v) for v in o.fields]
    return mapping


def schedule_state(model: ModelData) -> Dict[str,Any]:
    schedules={o.handle:(o.obj_type,tuple(o.fields)) for o in model.objects if o.handle and o.obj_type.startswith(SCHEDULE_PREFIX)}
    sh=set(schedules)
    refs={}
    for o in model.objects:
        if not o.handle: continue
        hits=tuple((i,v) for i,v in enumerate(o.fields) if v in sh)
        if hits:
            refs[o.handle]=(o.obj_type,hits)
    return {"objects":schedules,"references":refs}


def schedule_digest(state: Dict[str,Any]) -> str:
    payload=json.dumps({"objects":{k:[v[0],list(v[1])] for k,v in sorted(state["objects"].items())},"references":{k:[v[0],list(v[1])] for k,v in sorted(state["references"].items())}},sort_keys=True,separators=(",",":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def story_for_z(template: ModelData, z: float) -> str:
    stories=[]
    for o in template.by_type.get("OS:BuildingStory",[]):
        if o.handle and len(o.fields)>2 and o.fields[2] != "":
            stories.append((_float(o.fields[2]),o.handle))
    return min(stories,key=lambda x:abs(x[0]-z))[1] if stories else ""


def space_profile(space: OSMObject) -> Tuple[str,...]:
    f=list(space.fields)
    while len(f)<=max(PROFILE_FIELDS): f.append("")
    return tuple(f[i] for i in PROFILE_FIELDS)


def canonical_boundary(value: str) -> str:
    return "Ground" if value in {"Ground", "GroundFCfactorMethod"} else value


def construction_role(model: ModelData, surf: OSMObject) -> str:
    bc=canonical_boundary(surf.fields[5] if len(surf.fields)>5 else "")
    if bc!="Surface":
        return ""
    handle=surf.fields[3] if len(surf.fields)>3 else ""
    if not handle:
        return "blank"
    obj=model.by_handle.get(handle)
    if obj and obj.obj_type=="OS:Construction:AirBoundary":
        return "air"
    return "physical"


def surface_signature(model: ModelData, surf: OSMObject, profiles_by_space: Dict[str,Tuple[str,...]], include_profiles: bool=True, include_role: bool=True) -> Tuple[Any,...]:
    f=surf.fields
    st=f[2] if len(f)>2 else ""; bc=canonical_boundary(f[5] if len(f)>5 else ""); sun=f[8] if len(f)>8 else ""; wind=f[9] if len(f)>9 else ""
    role=construction_role(model,surf) if include_role else ""
    p=profiles_by_space.get(f[4],()) if len(f)>4 else ()
    other=()
    if bc=="Surface" and len(f)>6:
        mate=model.by_handle.get(f[6])
        if mate and len(mate.fields)>4:
            other=profiles_by_space.get(mate.fields[4],())
    base=(st,bc,sun,wind)
    if include_role:
        base=base+(role,)
    return base+(p,other) if include_profiles else base


def subsurface_signature(model: ModelData, sub: OSMObject, profiles_by_space: Dict[str,Tuple[str,...]], include_profiles: bool=True) -> Tuple[Any,...]:
    subtype=sub.fields[2] if len(sub.fields)>2 else ""
    parent=model.by_handle.get(sub.fields[4]) if len(sub.fields)>4 else None
    if not parent:
        return (subtype,"","",()) if include_profiles else (subtype,"","")
    st=parent.fields[2] if len(parent.fields)>2 else ""; bc=parent.fields[5] if len(parent.fields)>5 else ""
    p=profiles_by_space.get(parent.fields[4],()) if len(parent.fields)>4 else ()
    return (subtype,st,bc,p) if include_profiles else (subtype,st,bc)


def construction_fingerprint(model: ModelData, handle: str, seen: Optional[set[str]]=None) -> Tuple[Any,...]:
    if not handle:
        return ("blank",)
    obj=model.by_handle.get(handle)
    if not obj:
        return ("unresolved",handle)
    seen=set() if seen is None else set(seen)
    if handle in seen:
        return (obj.obj_type,"cycle")
    seen.add(handle)
    if obj.obj_type=="OS:Construction:FfactorGroundFloor":
        return (obj.obj_type,obj.fields[2] if len(obj.fields)>2 else "")
    if obj.obj_type=="OS:Construction:CfactorUndergroundWall":
        return (obj.obj_type,obj.fields[2] if len(obj.fields)>2 else "")
    if obj.obj_type=="OS:Construction":
        layers=[]
        for value in obj.fields[2:]:
            layers.append(construction_fingerprint(model,value,seen) if value in model.by_handle else ("literal",value))
        return (obj.obj_type,tuple(layers))
    return (obj.obj_type,tuple(obj.fields[2:]))


def choose_common(counter: Counter, context: str, strict: bool, warnings: List[str], model: Optional[ModelData]=None) -> str:
    if not counter:
        return ""
    if model is None:
        common=counter.most_common()
        if len(common)>1 and common[0][1]==common[1][1] and common[0][0]!=common[1][0]:
            msg=f"Ambiguous construction behavior for {context}: tie between {common[0][0]} and {common[1][0]}"
            if strict: raise CompileError(msg)
            warnings.append(msg+"; selected first deterministically")
        return common[0][0]
    grouped: Dict[Tuple[Any,...],Counter]=defaultdict(Counter)
    for handle,count in counter.items():
        grouped[construction_fingerprint(model,handle)][handle]+=count
    ranked=sorted(((sum(c.values()),fp,c) for fp,c in grouped.items()),reverse=True,key=lambda x:x[0])
    if len(ranked)>1 and ranked[0][0]==ranked[1][0] and ranked[0][1]!=ranked[1][1]:
        msg=f"Ambiguous construction behavior for {context}: physically different fingerprints have equal evidence"
        if strict: raise CompileError(msg)
        warnings.append(msg+"; selected first deterministically")
    return ranked[0][2].most_common(1)[0][0]


def infer_constructions(template: ModelData, geom_model: ModelData, geometry_source: ModelData, new_profiles: Dict[str,Tuple[str,...]], strict: bool, warnings: List[str], generated: List[OSMObject]) -> None:
    old_profiles={s.handle:space_profile(s) for s in template.by_type.get("OS:Space",[]) if s.handle}
    exact_role=defaultdict(Counter); exact_no_role=defaultdict(Counter)
    generic_role=defaultdict(Counter); generic_no_role=defaultdict(Counter)
    air_handles=Counter()
    for s in template.by_type.get("OS:Surface",[]):
        if len(s.fields)>3:
            exact_role[surface_signature(template,s,old_profiles,True,True)][s.fields[3]]+=1
            exact_no_role[surface_signature(template,s,old_profiles,True,False)][s.fields[3]]+=1
            generic_role[surface_signature(template,s,old_profiles,False,True)][s.fields[3]]+=1
            generic_no_role[surface_signature(template,s,old_profiles,False,False)][s.fields[3]]+=1
            c=template.by_handle.get(s.fields[3]) if s.fields[3] else None
            if c and c.obj_type=="OS:Construction:AirBoundary": air_handles[s.fields[3]]+=1
    if not air_handles:
        for c in template.by_type.get("OS:Construction:AirBoundary",[]):
            if c.handle: air_handles[c.handle]+=1
    sub_exact=defaultdict(Counter); sub_generic=defaultdict(Counter)
    for s in template.by_type.get("OS:SubSurface",[]):
        if len(s.fields)>3:
            sub_exact[subsurface_signature(template,s,old_profiles,True)][s.fields[3]]+=1
            sub_generic[subsurface_signature(template,s,old_profiles,False)][s.fields[3]]+=1

    generated_map: Dict[Tuple[str,str],str]={}
    for surf in geom_model.by_type.get("OS:Surface",[]):
        while len(surf.fields)<=3: surf.fields.append("")
        source_surf=geometry_source.by_handle.get(surf.handle or "") or surf
        key_role=surface_signature(geometry_source,source_surf,new_profiles,True,True)
        key_no_role=surface_signature(geometry_source,source_surf,new_profiles,True,False)
        gkey_role=surface_signature(geometry_source,source_surf,new_profiles,False,True)
        gkey_no_role=surface_signature(geometry_source,source_surf,new_profiles,False,False)
        role=construction_role(geometry_source,source_surf)
        if role=="air":
            if not air_handles:
                raise CompileError(f"Geometry requires an air-boundary construction for {surf.name}, but the template has none")
            chosen=air_handles.most_common(1)[0][0]
        else:
            # The template's assignment pattern for the two space profiles is the
            # source of truth. Source geometry's explicit/blank state is only a
            # fallback, preventing gbXML export artifacts from forcing constructions.
            candidates=(exact_no_role.get(key_no_role,Counter()) or exact_role.get(key_role,Counter()) or
                        generic_no_role.get(gkey_no_role,Counter()) or generic_role.get(gkey_role,Counter()))
            chosen=choose_common(candidates,f"surface {surf.name}",strict,warnings,template)
        cobj=template.by_handle.get(chosen) if chosen else None
        if cobj and cobj.obj_type=="OS:Construction:FfactorGroundFloor":
            # Geometry-dependent clone; one object per surface.
            pts=object_points_global(geom_model,surf)
            poly=safe_polygon(pts); area=float(poly.area) if poly is not None else newell_area_and_normal(pts)[0]
            # Actual exposed perimeter from outdoor walls in the same space touching this floor.
            z0=min((p[2] for p in pts),default=0.0); perimeter=0.0
            sp=surf.fields[4] if len(surf.fields)>4 else ""
            for wall in geom_model.by_type.get("OS:Surface",[]):
                if len(wall.fields)<=5 or wall.fields[4]!=sp or wall.fields[2]!="Wall" or wall.fields[5]!="Outdoors": continue
                wp=object_points_global(geom_model,wall)
                if not wp or abs(min(p[2] for p in wp)-z0)>0.05: continue
                edges=[math.dist((wp[i][0],wp[i][1]),(wp[(i+1)%len(wp)][0],wp[(i+1)%len(wp)][1])) for i in range(len(wp))]
                horizontal=[e for i,e in enumerate(edges) if abs(wp[i][2]-wp[(i+1)%len(wp)][2])<0.02]
                perimeter+=max(horizontal,default=0.0)
            if perimeter<=1e-8 and poly is not None:
                old_area=_float(cobj.fields[3],1.0) if len(cobj.fields)>3 else 1.0
                old_per=_float(cobj.fields[4],0.0) if len(cobj.fields)>4 else 0.0
                perimeter=float(poly.length)*(old_per/max(1e-9,math.sqrt(old_area)*4.0))
            clone=cobj.clone(); clone.handle=new_handle()
            while len(clone.fields)<=4: clone.fields.append("")
            clone.fields[1]=f"{cobj.name}__{surf.name}"; clone.fields[3]=f"{area:.14g}"; clone.fields[4]=f"{perimeter:.14g}"
            generated.append(clone); surf.fields[3]=clone.handle or ""
            if len(surf.fields)>5 and surf.fields[5] in {"Ground","GroundFCfactorMethod"}: surf.fields[5]="GroundFCfactorMethod"
            if len(surf.fields)>6: surf.fields[6]=""
        elif cobj and cobj.obj_type=="OS:Construction:CfactorUndergroundWall":
            pts=object_points_global(geom_model,surf); h=max((p[2] for p in pts),default=0)-min((p[2] for p in pts),default=0)
            clone=cobj.clone(); clone.handle=new_handle()
            while len(clone.fields)<=3: clone.fields.append("")
            clone.fields[1]=f"{cobj.name}__{surf.name}"; clone.fields[3]=f"{h:.14g}"
            generated.append(clone); surf.fields[3]=clone.handle or ""
            if len(surf.fields)>5 and surf.fields[5] in {"Ground","GroundFCfactorMethod"}: surf.fields[5]="GroundFCfactorMethod"
            if len(surf.fields)>6: surf.fields[6]=""
        else:
            surf.fields[3]=chosen

    for sub in geom_model.by_type.get("OS:SubSurface",[]):
        while len(sub.fields)<=3: sub.fields.append("")
        source_sub=geometry_source.by_handle.get(sub.handle or "") or sub
        key=subsurface_signature(geometry_source,source_sub,new_profiles,True); gkey=subsurface_signature(geometry_source,source_sub,new_profiles,False)
        sub.fields[3]=choose_common(sub_exact.get(key,Counter()) or sub_generic.get(gkey,Counter()),f"subsurface {sub.name}",strict,warnings,template)




def _pair_behavior_key(model: ModelData, obj: OSMObject, profiles: Dict[str,Tuple[str,...]], include_profiles: bool=True) -> Tuple[Any,...]:
    if obj.obj_type == "OS:Surface":
        mate=model.by_handle.get(obj.fields[6]) if len(obj.fields)>6 and obj.fields[6] else None
        first_profile=profiles.get(obj.fields[4],()) if len(obj.fields)>4 else ()
        second_profile=profiles.get(mate.fields[4],()) if mate and len(mate.fields)>4 else ()
        base=("surface",obj.fields[2] if len(obj.fields)>2 else "",mate.fields[2] if mate and len(mate.fields)>2 else "",canonical_boundary(obj.fields[5] if len(obj.fields)>5 else ""))
        return base+(first_profile,second_profile) if include_profiles else base
    mate=model.by_handle.get(obj.fields[5]) if len(obj.fields)>5 and obj.fields[5] else None
    parent=model.by_handle.get(obj.fields[4]) if len(obj.fields)>4 else None
    mate_parent=model.by_handle.get(mate.fields[4]) if mate and len(mate.fields)>4 else None
    first_profile=profiles.get(parent.fields[4],()) if parent and len(parent.fields)>4 else ()
    second_profile=profiles.get(mate_parent.fields[4],()) if mate_parent and len(mate_parent.fields)>4 else ()
    base=(
        "subsurface",
        obj.fields[2] if len(obj.fields)>2 else "",
        mate.fields[2] if mate and len(mate.fields)>2 else "",
        parent.fields[2] if parent and len(parent.fields)>2 else "",
        mate_parent.fields[2] if mate_parent and len(mate_parent.fields)>2 else "",
        canonical_boundary(parent.fields[5] if parent and len(parent.fields)>5 else ""),
    )
    return base+(first_profile,second_profile) if include_profiles else base


def _find_or_create_reversed_construction(
    lookup: ModelData,
    source_handle: str,
    generated: List[OSMObject],
    cache: Dict[str, str],
) -> str:
    """Return a construction whose material order is the reverse of source_handle.

    The lookup is anonymous/handle-based. Names are written only for human audit
    readability and are never used to select or match the construction.
    """
    if source_handle in cache:
        return cache[source_handle]
    source = lookup.by_handle.get(source_handle)
    if not source or source.obj_type != "OS:Construction":
        cache[source_handle] = source_handle
        return source_handle
    source_fp = _construction_layers_fingerprint(lookup, source_handle)
    reversed_fp = tuple(reversed(source_fp))
    if source_fp == reversed_fp:
        cache[source_handle] = source_handle
        return source_handle

    # Reuse an already demonstrated reverse assembly, independent of its name.
    for candidate in lookup.by_type.get("OS:Construction", []):
        if not candidate.handle:
            continue
        if _construction_layers_fingerprint(lookup, candidate.handle) == reversed_fp:
            cache[source_handle] = candidate.handle
            cache[candidate.handle] = source_handle
            return candidate.handle

    clone = source.clone()
    clone.handle = new_handle()
    while len(clone.fields) < 3:
        clone.fields.append("")
    base_name = source.name or "Construction"
    clone.fields[1] = f"{base_name} [Compiler Reversed]"
    clone.fields[3:] = list(reversed(source.fields[3:]))
    generated.append(clone)
    lookup.objects.append(clone)
    lookup.reindex()
    cache[source_handle] = clone.handle or ""
    cache[clone.handle or ""] = source_handle
    return clone.handle or ""


def _normalize_pair_orientation(
    lookup: ModelData,
    first_obj: OSMObject,
    second_obj: OSMObject,
    generated: List[OSMObject],
    reverse_cache: Dict[str, str],
) -> Optional[dict]:
    """Make a matched pair explicit so ForwardTranslator need not invent a reverse."""
    while len(first_obj.fields) <= 3:
        first_obj.fields.append("")
    while len(second_obj.fields) <= 3:
        second_obj.fields.append("")
    first = first_obj.fields[3]
    second = second_obj.fields[3]
    if not first or not second:
        return None

    first_ref = lookup.by_handle.get(first)
    second_ref = lookup.by_handle.get(second)
    if not first_ref or not second_ref:
        return None
    if first_ref.obj_type != "OS:Construction" or second_ref.obj_type != "OS:Construction":
        return None

    a = _construction_layers_fingerprint(lookup, first)
    b = _construction_layers_fingerprint(lookup, second)
    if a == tuple(reversed(b)):
        return None
    if a == b:
        if a == tuple(reversed(a)):
            return None
        reverse_handle = _find_or_create_reversed_construction(lookup, first, generated, reverse_cache)
        before = second
        second_obj.fields[3] = reverse_handle
        return {
            "first": first_obj.name,
            "second": second_obj.name,
            "before_second": resolve_ref(lookup, before),
            "after_second": resolve_ref(lookup, reverse_handle),
            "reason": "same non-symmetric layer order on both sides",
        }
    return None


def reconcile_paired_constructions(
    template: ModelData,
    geom_model: ModelData,
    report: dict,
    strict: bool = True,
    generated: Optional[List[OSMObject]] = None,
) -> None:
    """Canonicalize every matched pair to one demonstrated construction handle.

    OpenStudio's native matched-surface behavior is safest when both sides point
    to the same construction object; it reverses layer order internally when
    required. Different-but-equivalent handles can trigger conflict resolution.
    No construction or object name is used for selection.
    """
    generated = generated if generated is not None else []
    old_profiles = {sp.handle: space_profile(sp) for sp in template.by_type.get("OS:Space", []) if sp.handle}
    new_profiles = {sp.handle: space_profile(sp) for sp in geom_model.by_type.get("OS:Space", []) if sp.handle}
    exact = defaultdict(Counter)
    generic = defaultdict(Counter)

    def physically_equivalent(model: ModelData, a: str, b: str) -> bool:
        if not a or not b or a == b:
            return True
        ao = model.by_handle.get(a)
        bo = model.by_handle.get(b)
        if not ao or not bo:
            return False
        if ao.obj_type == "OS:Construction" and bo.obj_type == "OS:Construction":
            af = _construction_layers_fingerprint(model, a)
            bf = _construction_layers_fingerprint(model, b)
            return af == bf or af == tuple(reversed(bf))
        return construction_fingerprint(model, a) == construction_fingerprint(model, b)

    for obj_type, mate_index in (("OS:Surface", 6), ("OS:SubSurface", 5)):
        seen = set()
        for obj in template.by_type.get(obj_type, []):
            if not obj.handle or obj.handle in seen or len(obj.fields) <= mate_index or not obj.fields[mate_index]:
                continue
            mate = template.by_handle.get(obj.fields[mate_index])
            if not mate or mate.obj_type != obj_type:
                continue
            seen.update({obj.handle, mate.handle})
            pair = (obj.fields[3] if len(obj.fields) > 3 else "", mate.fields[3] if len(mate.fields) > 3 else "")
            exact[_pair_behavior_key(template, obj, old_profiles, True)][pair] += 1
            generic[_pair_behavior_key(template, obj, old_profiles, False)][pair] += 1
            exact[_pair_behavior_key(template, mate, old_profiles, True)][(pair[1], pair[0])] += 1
            generic[_pair_behavior_key(template, mate, old_profiles, False)][(pair[1], pair[0])] += 1

    canonicalized = []
    lookup = ModelData(template.path, list(template.objects) + list(generated))
    for obj_type, mate_index in (("OS:Surface", 6), ("OS:SubSurface", 5)):
        seen = set()
        for obj in geom_model.by_type.get(obj_type, []):
            if not obj.handle or obj.handle in seen or len(obj.fields) <= mate_index or not obj.fields[mate_index]:
                continue
            mate = geom_model.by_handle.get(obj.fields[mate_index])
            if not mate or mate.obj_type != obj_type:
                continue
            seen.update({obj.handle, mate.handle})
            while len(obj.fields) <= 3:
                obj.fields.append("")
            while len(mate.fields) <= 3:
                mate.fields.append("")
            first, second = obj.fields[3], mate.fields[3]
            selected = (first, second)

            if not physically_equivalent(lookup, first, second):
                candidates = exact.get(_pair_behavior_key(geom_model, obj, new_profiles, True), Counter()) or generic.get(
                    _pair_behavior_key(geom_model, obj, new_profiles, False), Counter()
                )
                if not candidates:
                    raise CompileError(
                        f"No translatable paired-construction behavior exists in the template for {obj_type} pair {obj.name} / {mate.name}"
                    )
                grouped = defaultdict(Counter)
                for pair, count in candidates.items():
                    a, b = pair
                    if not physically_equivalent(template, a, b):
                        continue
                    af = construction_fingerprint(template, a) if a else ("blank",)
                    bf = construction_fingerprint(template, b) if b else ("blank",)
                    key = tuple(sorted((repr(af), repr(bf))))
                    grouped[key][pair] += count
                if not grouped:
                    raise CompileError(
                        f"Template demonstrates only conflicting constructions for {obj_type} pair {obj.name} / {mate.name}"
                    )
                ranked = sorted(
                    ((sum(counter.values()), key, counter) for key, counter in grouped.items()),
                    reverse=True, key=lambda item: item[0]
                )
                if len(ranked) > 1 and ranked[0][0] == ranked[1][0] and ranked[0][1] != ranked[1][1]:
                    raise CompileError(f"Ambiguous paired-construction behavior for {obj_type} pair {obj.name} / {mate.name}")
                selected = ranked[0][2].most_common(1)[0][0]

            canonical = selected[0] or selected[1]
            before = (resolve_ref(lookup, first), resolve_ref(lookup, second))
            obj.fields[3] = canonical
            mate.fields[3] = canonical
            canonicalized.append({
                "object_type": obj_type,
                "first": obj.name,
                "second": mate.name,
                "before": before,
                "after": (resolve_ref(lookup, canonical), resolve_ref(lookup, canonical)),
            })

    report["paired_construction_reconciliation"] = {
        "canonicalized_pairs": len(canonicalized),
        "generated_reversed_constructions": 0,
        "pairs": canonicalized,
        "strategy": "one anonymous construction handle on both matched sides; OpenStudio reverses internally",
    }


def refs_to_handles(obj: OSMObject, handles: set[str]) -> List[Tuple[int,str]]:
    return [(i,v) for i,v in enumerate(obj.fields) if v in handles]


def clone_direct_space_objects(
    template: ModelData,
    retained: List[OSMObject],
    old_space_handles: set[str],
    new_to_old: Dict[str, str],
    geom_model: ModelData,
    report: dict,
    strict: bool,
    config: Optional[dict] = None,
) -> List[OSMObject]:
    """Remap objects directly assigned to spaces without silently duplicating loads.

    Infiltration is rebuilt from the template's demonstrated method. Other
    direct-space objects are cloned only for a one-old-to-one-new mapping unless
    explicit replication/drop permission is provided in config.
    """
    config = config or {}
    warnings = report.setdefault("warnings", [])
    by_old: Dict[str, List[OSMObject]] = defaultdict(list)
    source_keys: set[Tuple[str, int]] = set()
    multi: List[str] = []
    for obj in template.objects:
        if obj.obj_type in BASE_GEOMETRY_TYPES or obj.obj_type in {"OS:BuildingStory", "OS:AdditionalProperties"}:
            continue
        refs = refs_to_handles(obj, old_space_handles)
        if not refs:
            continue
        unique = {v for _, v in refs}
        if len(unique) != 1:
            multi.append(f"{obj.obj_type}:{obj.name}")
            continue
        old = next(iter(unique))
        by_old[old].append(obj)
        source_keys.add((obj.obj_type, obj.source_index))
    if multi:
        msg = f"Objects reference multiple old spaces and cannot be remapped generically: {multi[:10]}"
        if strict:
            raise CompileError(msg)
        warnings.append(msg + "; removed")

    # Remove source direct-space objects; replacements are generated below.
    retained[:] = [o for o in retained if (o.obj_type, o.source_index) not in source_keys]

    mapped_new_by_old: Dict[str, List[str]] = defaultdict(list)
    for new, old in new_to_old.items():
        mapped_new_by_old[old].append(new)

    non_infiltration_issues: List[str] = []
    allow_replication = bool(config.get("allow_direct_object_replication", False))
    allow_drop = bool(config.get("allow_unmapped_direct_object_drop", False))
    for old, objs in by_old.items():
        non_infil = [o for o in objs if o.obj_type != "OS:SpaceInfiltration:DesignFlowRate"]
        if not non_infil:
            continue
        n = len(mapped_new_by_old.get(old, []))
        if n == 0 and not allow_drop:
            non_infiltration_issues.append(
                f"{template.by_handle[old].name}: {len(non_infil)} direct object(s) would be dropped"
            )
        elif n > 1 and not allow_replication:
            non_infiltration_issues.append(
                f"{template.by_handle[old].name}: {len(non_infil)} direct object(s) would be replicated to {n} new spaces"
            )
    if non_infiltration_issues:
        raise CompileError(
            "Direct space loads/equipment cannot be transferred losslessly for this split/merge mapping. "
            + "; ".join(non_infiltration_issues[:12])
            + ". Resolve space mappings or explicitly enable replication/drop in config."
        )

    # Learn geometry-sensitive infiltration patterns by anonymous profile.
    old_profiles = {s.handle: space_profile(s) for s in template.by_type.get("OS:Space", []) if s.handle}
    infil_patterns: Dict[Tuple[str, ...], Dict[str, OSMObject]] = defaultdict(dict)
    for old, objs in by_old.items():
        p = old_profiles.get(old, ())
        for obj in objs:
            if obj.obj_type != "OS:SpaceInfiltration:DesignFlowRate" or len(obj.fields) <= 4:
                continue
            method = obj.fields[4]
            if method in {"Flow/ExteriorWallArea", "Flow/ExteriorArea"}:
                infil_patterns[p].setdefault("exterior", obj)
            elif method == "Flow/Space" and abs(_float(obj.fields[5] if len(obj.fields) > 5 else "0")) < 1e-12:
                infil_patterns[p].setdefault("zero", obj)
            else:
                infil_patterns[p].setdefault("generic", obj)

    # The same template-learned architectural vocabulary used by space mapping
    # also selects geometry-sensitive infiltration patterns.
    use_semantic_fallback = bool(config.get("use_semantic_fallback", True))
    direct_semantic_groups = {
        "elevator": ("elevator", "lift"),
        "shaft": ("mechshaft", "mechanicalshaft", "shaft"),
        "crawlspace": ("crawlspace", "crawl"),
    }
    group_presence: Dict[str, Counter] = defaultdict(Counter)
    if use_semantic_fallback:
        for old_space in template.by_type.get("OS:Space", []):
            if not old_space.handle:
                continue
            sem = semantic_name(old_space.name)
            present = any(o.obj_type == "OS:SpaceInfiltration:DesignFlowRate" for o in by_old.get(old_space.handle, []))
            for group, tokens in direct_semantic_groups.items():
                if any(token in sem for token in tokens):
                    group_presence[group][present] += 1
                    break

    has_exterior = Counter()
    for surf in geom_model.by_type.get("OS:Surface", []):
        if len(surf.fields) > 5 and surf.fields[2] == "Wall" and surf.fields[5] == "Outdoors":
            has_exterior[surf.fields[4]] += 1

    clones: List[OSMObject] = []
    counts = Counter()
    for new, old in new_to_old.items():
        source = list(by_old.get(old, []))
        profile = old_profiles.get(old, ())
        ns = geom_model.by_handle.get(new)
        # Start with the chosen template behavior source, then apply the same
        # template-learned architectural family evidence used by the mapper.
        should_have = any(
            o.obj_type == "OS:SpaceInfiltration:DesignFlowRate"
            for o in by_old.get(old, [])
        )
        if use_semantic_fallback:
            sem = semantic_name(ns.name if ns else "")
            for group, tokens in direct_semantic_groups.items():
                if not any(token in sem for token in tokens):
                    continue
                evidence = group_presence.get(group, Counter())
                total = sum(evidence.values())
                if total and max(evidence.values()) / total >= 0.80:
                    should_have = evidence[True] >= evidence[False]
                elif not total:
                    should_have = bool(infil_patterns.get(profile))
                break

        # Infiltration is selected for the new geometry; all other direct objects
        # follow the explicit one-to-one/authorized replication rule above.
        source = [o for o in source if o.obj_type != "OS:SpaceInfiltration:DesignFlowRate"]
        pat = infil_patterns.get(profile, {})
        chosen = pat.get("exterior") if has_exterior[new] else pat.get("zero")
        if should_have and chosen is None:
            chosen = pat.get("generic")
        if should_have and chosen is not None:
            source.append(chosen)

        for obj in source:
            c = obj.clone()
            c.handle = new_handle()
            c.fields = [new if v in old_space_handles else v for v in c.fields]
            if len(c.fields) > 1:
                c.fields[1] = f"{ns.name if ns else new} {obj.obj_type.split(':')[-1]}"
            clones.append(c)
            counts[obj.obj_type] += 1

    report["direct_space_objects"] = {
        "cloned": len(clones),
        "source_objects_removed": len(source_keys),
        "types": dict(counts),
        "replication_enabled": allow_replication,
        "unmapped_drop_enabled": allow_drop,
    }
    return clones


def update_zone_volumes(objects: List[OSMObject], spaces: List[OSMObject]) -> Dict[str,float]:
    sums=defaultdict(float)
    for s in spaces:
        if len(s.fields)>10 and s.fields[10]: sums[s.fields[10]]+=space_volume(s)
    for o in objects:
        if o.obj_type=="OS:ThermalZone" and o.handle in sums:
            while len(o.fields)<=4: o.fields.append("")
            o.fields[4]=f"{sums[o.handle]:.14g}"
    return dict(sums)


def _point_multiset(points: Sequence[Tuple[float,float,float]], digits: int=7) -> Counter:
    return Counter(tuple(round(float(value), digits) for value in point) for point in points)


def _construction_layers_fingerprint(model: ModelData, handle: str) -> Tuple[Any,...]:
    if not handle:
        return ("blank",)
    obj=model.by_handle.get(handle)
    if not obj:
        return ("unresolved",handle)
    if obj.obj_type != "OS:Construction":
        return construction_fingerprint(model,handle)
    # OS:Construction field 2 is Rendering Color; physical layers start at field 3.
    layers=[]
    for value in obj.fields[3:]:
        layers.append(construction_fingerprint(model,value) if value in model.by_handle else ("literal",value))
    return tuple(layers)


def _is_layered_construction(model: ModelData, handle: str) -> bool:
    obj = model.by_handle.get(handle) if handle else None
    return bool(obj and obj.obj_type == "OS:Construction")


def construction_is_symmetric(model: ModelData, handle: str) -> bool:
    """Return True when reversing the material order does not change the assembly.

    Non-layered construction objects (air boundaries, F/C-factor objects, etc.)
    are treated as intrinsically orientation-safe when the same handle is used.
    """
    if not handle:
        return True
    if not _is_layered_construction(model, handle):
        return True
    fp = _construction_layers_fingerprint(model, handle)
    return fp == tuple(reversed(fp))


def constructions_are_pair_compatible(model: ModelData, first: str, second: str) -> bool:
    """Check *orientation* compatibility for a matched surface/subsurface pair.

    Two sides of an interzone boundary must either use a symmetric assembly or
    use opposite layer orders.  Merely using the same non-symmetric construction
    on both sides is not considered normalized, because OpenStudio then creates
    an implicit reversed copy during forward translation.
    """
    if not first or not second:
        return True
    if first == second:
        # OpenStudio supports the same non-symmetric construction on matched
        # faces and creates the reverse internally during translation.
        return True

    first_obj = model.by_handle.get(first)
    second_obj = model.by_handle.get(second)
    if not first_obj or not second_obj:
        return False

    # Non-layered construction types do not have a meaningful material order.
    if first_obj.obj_type != "OS:Construction" or second_obj.obj_type != "OS:Construction":
        return construction_fingerprint(model, first) == construction_fingerprint(model, second)

    a = _construction_layers_fingerprint(model, first)
    b = _construction_layers_fingerprint(model, second)
    return a == tuple(reversed(b)) or (a == b and a == tuple(reversed(a)))


def validate_construction_pairs(model: ModelData) -> List[str]:
    errors=[]
    for obj_type, mate_index in (("OS:Surface",6),("OS:SubSurface",5)):
        seen=set()
        for obj in model.by_type.get(obj_type,[]):
            if not obj.handle or obj.handle in seen or len(obj.fields)<=mate_index or not obj.fields[mate_index]:
                continue
            mate=model.by_handle.get(obj.fields[mate_index])
            if not mate or mate.obj_type!=obj_type:
                continue
            seen.update({obj.handle,mate.handle})
            first=obj.fields[3] if len(obj.fields)>3 else ""
            second=mate.fields[3] if len(mate.fields)>3 else ""
            if not constructions_are_pair_compatible(model,first,second):
                errors.append(
                    f"Incompatible matched constructions for {obj_type} pair {obj.name} / {mate.name}: "
                    f"{resolve_ref(model,first)} vs {resolve_ref(model,second)}"
                )
    return errors


def validate_geometry(model: ModelData, include_energyplus_limits: bool=True) -> List[str]:
    errors=[]
    for obj_type in ("OS:Surface", "OS:SubSurface", "OS:ShadingSurface", "OS:InteriorPartitionSurface"):
        for obj in model.by_type.get(obj_type, []):
            errors.extend(geometry_layout_errors(obj))
    try:
        from shapely.geometry import Polygon
    except Exception:
        Polygon=None
    for surf in model.by_type.get("OS:Surface",[]):
        pts=vertices(surf); area,_=newell_area_and_normal(pts)
        if len(pts)<3 or area<=1e-8:
            errors.append(f"Degenerate surface {surf.name}")
            continue
        if include_energyplus_limits and _energyplus_effective_vertex_count(pts) < 3:
            errors.append(
                f"EnergyPlus-degenerate surface {surf.name}: short-edge cleanup "
                "would leave fewer than three vertices"
            )
        pe=planarity_error(pts)
        if pe>1e-4:
            errors.append(f"Nonplanar surface {surf.name}: {pe:.6g} m")
        basis=_plane_basis(pts)
        if Polygon is not None and basis is not None:
            poly=Polygon(_project_plane(pts,basis))
            if not poly.is_valid:
                errors.append(f"Self-intersecting/invalid surface polygon {surf.name}")
        edge_lengths=[math.dist(pts[i],pts[(i+1)%len(pts)]) for i in range(len(pts))]
        if edge_lengths and min(edge_lengths)<1e-7:
            errors.append(f"Duplicate or zero-length edge on surface {surf.name}")
    for sub in model.by_type.get("OS:SubSurface",[]):
        pts=vertices(sub); area,_=newell_area_and_normal(pts)
        if len(pts)<3 or area<=1e-8:
            errors.append(f"Degenerate subsurface {sub.name}")
            continue
        if include_energyplus_limits and _energyplus_effective_vertex_count(pts) < 3:
            errors.append(
                f"EnergyPlus-degenerate subsurface {sub.name}: short-edge cleanup "
                "would leave fewer than three vertices"
            )
        if include_energyplus_limits and len(pts)>4:
            errors.append(f"EnergyPlus-incompatible subsurface {sub.name}: {len(pts)} vertices (maximum 4)")
        pe=planarity_error(pts)
        if pe>1e-4:
            errors.append(f"Nonplanar subsurface {sub.name}: {pe:.6g} m")
        basis=_plane_basis(pts)
        if Polygon is not None and basis is not None:
            poly=Polygon(_project_plane(pts,basis))
            if not poly.is_valid:
                errors.append(f"Self-intersecting/invalid subsurface polygon {sub.name}")
        edge_lengths=[math.dist(pts[i],pts[(i+1)%len(pts)]) for i in range(len(pts))]
        if edge_lengths and min(edge_lengths)<1e-7:
            errors.append(f"Duplicate or zero-length edge on subsurface {sub.name}")
        parent=model.by_handle.get(sub.fields[4]) if len(sub.fields)>4 else None
        if parent and parent.obj_type=="OS:Surface":
            parent_points=vertices(parent)
            parent_basis=_plane_basis(parent_points)
            if parent_basis is not None:
                origin,_u,_v,normal=parent_basis
                max_distance=max((abs(_dot(_vec_sub(point,origin),normal)) for point in pts),default=0.0)
                if max_distance>1e-4:
                    errors.append(f"Subsurface {sub.name} is not coplanar with parent {parent.name}: {max_distance:.6g} m")
                if Polygon is not None:
                    ppoly=Polygon(_project_plane(parent_points,parent_basis))
                    spoly=Polygon(_project_plane(pts,parent_basis))
                    if ppoly.is_valid and spoly.is_valid:
                        outside=float(spoly.difference(ppoly.buffer(1e-7)).area)
                        if outside>max(1e-8,float(spoly.area)*1e-8):
                            errors.append(f"Subsurface {sub.name} extends outside parent {parent.name} by {outside:.6g} m2")
    if include_energyplus_limits:
        for obj_type in ("OS:Surface", "OS:ShadingSurface"):
            for surf in model.by_type.get(obj_type, []):
                pts = vertices(surf)
                if (
                    obj_type == "OS:ShadingSurface"
                    and len(pts) >= 3
                    and _energyplus_effective_vertex_count(pts) < 3
                ):
                    errors.append(
                        f"EnergyPlus-degenerate shading surface {surf.name}: "
                        "short-edge cleanup would leave fewer than three vertices"
                    )
                try:
                    metrics = _casting_surface_convexity(model, surf)
                except CompileError as exc:
                    errors.append(str(exc))
                    continue
                if metrics and metrics.get("is_nonconvex"):
                    errors.append(
                        f"EnergyPlus-incompatible non-convex casting surface {surf.name}: "
                        f"convexity deficit {metrics['convexity_deficit']:.6g} m2"
                    )
    # Paired surfaces and openings must be exactly congruent in world coordinates.
    for obj_type,mate_index in (("OS:Surface",6),("OS:SubSurface",5)):
        seen=set()
        for obj in model.by_type.get(obj_type,[]):
            if not obj.handle or obj.handle in seen or len(obj.fields)<=mate_index or not obj.fields[mate_index]:
                continue
            mate=model.by_handle.get(obj.fields[mate_index])
            if not mate or mate.obj_type!=obj_type:
                continue
            seen.update({obj.handle,mate.handle})
            if _point_multiset(object_points_global(model,obj)) != _point_multiset(object_points_global(model,mate)):
                errors.append(f"Geometrically mismatched {obj_type} pair {obj.name} / {mate.name}")
    return errors


def validate_references(model: ModelData) -> List[str]:
    errors=[]; handles=set(model.by_handle)
    for surf in model.by_type.get("OS:Surface",[]):
        if len(surf.fields)<=4 or surf.fields[4] not in handles or model.by_handle[surf.fields[4]].obj_type!="OS:Space":
            errors.append(f"Surface {surf.name} has invalid space")
        if len(surf.fields)>5 and surf.fields[5]=="Surface":
            mate=model.by_handle.get(surf.fields[6]) if len(surf.fields)>6 else None
            if not mate or mate.obj_type!="OS:Surface" or len(mate.fields)<=6 or mate.fields[6]!=surf.handle:
                errors.append(f"Nonreciprocal surface pair {surf.name}")
    for sub in model.by_type.get("OS:SubSurface",[]):
        parent=model.by_handle.get(sub.fields[4]) if len(sub.fields)>4 else None
        if not parent or parent.obj_type!="OS:Surface":
            errors.append(f"Subsurface {sub.name} has invalid parent")
        if len(sub.fields)>5 and sub.fields[5]:
            mate=model.by_handle.get(sub.fields[5])
            if not mate or mate.obj_type!="OS:SubSurface" or len(mate.fields)<=5 or mate.fields[5]!=sub.handle:
                errors.append(f"Nonreciprocal subsurface pair {sub.name}")
            elif parent:
                mate_parent=model.by_handle.get(mate.fields[4]) if len(mate.fields)>4 else None
                expected_parent=model.by_handle.get(parent.fields[6]) if len(parent.fields)>6 and parent.fields[5]=="Surface" else None
                if expected_parent and mate_parent and expected_parent.handle!=mate_parent.handle:
                    errors.append(f"Subsurface pair {sub.name} / {mate.name} is attached to nonmatching parent surfaces")
    dangling=[]
    for obj in model.objects:
        for index,value in enumerate(obj.fields[2:],2):
            if UUID_RE.fullmatch(value) and value not in handles:
                dangling.append((obj.obj_type,obj.name,index,value))
    if dangling:
        errors.append(f"{len(dangling)} dangling handle references; first {dangling[:5]}")
    return errors




def geometry_coordinate_digest(model: ModelData) -> str:
    """Hash geometry coordinates/transforms without names, handles, or assignments."""
    payload: List[Any] = []
    for obj in model.objects:
        if obj.obj_type == "OS:Space":
            f = list(obj.fields)
            while len(f) <= 8:
                f.append("")
            payload.append((obj.obj_type, tuple(f[5:9]), f[-1] if f else ""))
        elif obj.obj_type in {"OS:Surface", "OS:SubSurface", "OS:ShadingSurface", "OS:InteriorPartitionSurface"}:
            start = geometry_vertex_start(obj.obj_type)
            payload.append((obj.obj_type, tuple(obj.fields[start:] if start is not None else [])))
    payload.sort(key=lambda item: json.dumps(item, ensure_ascii=False, separators=(",", ":")))
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _face_feature(model: ModelData, obj: OSMObject) -> Dict[str, Any]:
    pts = object_points_global(model, obj)
    area, normal = newell_area_and_normal(pts)
    if pts:
        centroid = tuple(sum(p[i] for p in pts) / len(pts) for i in range(3))
        zmin = min(p[2] for p in pts)
        zmax = max(p[2] for p in pts)
    else:
        centroid = (0.0, 0.0, 0.0)
        zmin = zmax = 0.0
    if obj.obj_type == "OS:Surface":
        surface_type = obj.fields[2] if len(obj.fields) > 2 else ""
        boundary = canonical_boundary(obj.fields[5] if len(obj.fields) > 5 else "")
        space = obj.fields[4] if len(obj.fields) > 4 else ""
        parent = ""
    else:
        surface_type = obj.fields[2] if len(obj.fields) > 2 else ""
        parent = obj.fields[4] if len(obj.fields) > 4 else ""
        pobj = model.by_handle.get(parent)
        boundary = canonical_boundary(pobj.fields[5] if pobj and len(pobj.fields) > 5 else "")
        space = pobj.fields[4] if pobj and len(pobj.fields) > 4 else ""
    return {
        "obj": obj,
        "area": area,
        "normal": normal,
        "centroid": centroid,
        "zmin": zmin,
        "zmax": zmax,
        "surface_type": surface_type,
        "boundary": boundary,
        "space": space,
        "parent": parent,
    }


def _face_match_score(old: Dict[str, Any], new: Dict[str, Any], scale: float, parent_match: bool = False) -> float:
    if old["surface_type"] != new["surface_type"]:
        return -1.0
    bc = 1.0 if old["boundary"] == new["boundary"] else 0.0
    on = old["normal"]
    nn = new["normal"]
    dot = max(-1.0, min(1.0, on[0] * nn[0] + on[1] * nn[1] + on[2] * nn[2]))
    normal_score = abs(dot) if old["boundary"] == "Surface" else max(0.0, dot)
    area_score = min(old["area"], new["area"]) / max(1e-9, max(old["area"], new["area"]))
    dist = math.dist(old["centroid"], new["centroid"])
    near = math.exp(-dist / max(0.5, scale * 0.12))
    dz = abs(old["centroid"][2] - new["centroid"][2])
    zscore = math.exp(-dz / max(0.25, scale * 0.04))
    score = 0.28 * bc + 0.24 * normal_score + 0.22 * area_score + 0.15 * near + 0.11 * zscore
    if parent_match:
        score += 0.05
    return min(1.0, score)


def _match_story_handles(template: ModelData, geom_model: ModelData, needed: set[str]) -> Tuple[Dict[str, str], List[str]]:
    mapping: Dict[str, str] = {}
    issues: List[str] = []
    new_stories = [o for o in geom_model.by_type.get("OS:BuildingStory", []) if o.handle]
    if not new_stories:
        return mapping, issues
    for old_handle in sorted(needed):
        old = template.by_handle.get(old_handle)
        if not old or old.obj_type != "OS:BuildingStory":
            continue
        if old_handle in geom_model.by_handle:
            mapping[old_handle] = old_handle
            continue
        oz = _float(old.fields[2], 0.0) if len(old.fields) > 2 else 0.0
        ranked = []
        for new in new_stories:
            nz = _float(new.fields[2], 0.0) if len(new.fields) > 2 else 0.0
            ranked.append((abs(oz - nz), new.handle or "", abs(oz - nz), 0.0))
        ranked.sort()
        if not ranked:
            issues.append(f"Story {old.name} has no new-story candidate")
            continue
        best = ranked[0]
        if len(ranked) > 1 and abs(ranked[1][0] - best[0]) < 1e-7 and best[3] < 0.8:
            issues.append(f"Story {old.name} maps ambiguously between new stories")
            continue
        mapping[old_handle] = best[1]
    return mapping, issues


def _match_surface_handles(
    template: ModelData,
    geom_model: ModelData,
    new_to_old: Dict[str, str],
    needed: set[str],
    collision_map: Dict[str, str],
) -> Tuple[Dict[str, str], List[str], List[dict]]:
    mapping: Dict[str, str] = {}
    issues: List[str] = []
    rows: List[dict] = []
    needed_surfaces = [template.by_handle[h] for h in needed if h in template.by_handle and template.by_handle[h].obj_type == "OS:Surface"]
    if not needed_surfaces:
        return mapping, issues, rows
    new_features = {o.handle: _face_feature(geom_model, o) for o in geom_model.by_type.get("OS:Surface", []) if o.handle}
    old_features = {o.handle: _face_feature(template, o) for o in needed_surfaces if o.handle}
    new_by_old_space: Dict[str, List[str]] = defaultdict(list)
    for new_space, old_space in new_to_old.items():
        new_by_old_space[old_space].append(new_space)
    surfaces_by_space: Dict[str, List[str]] = defaultdict(list)
    for h, f in new_features.items():
        surfaces_by_space[f["space"]].append(h)
    scale = max(1.0, building_scale(build_space_features(template)), building_scale(build_space_features(geom_model)))
    used: set[str] = set()
    pending: List[Tuple[float, str, List[Tuple[float, str]]]] = []
    for old in needed_surfaces:
        oh = old.handle or ""
        same = collision_map.get(oh, oh)
        if same in new_features:
            mapping[oh] = same
            used.add(same)
            rows.append({"old": old.name, "new": new_features[same]["obj"].name, "score": 1.0, "method": "preserved_handle"})
            continue
        of = old_features[oh]
        candidates: List[str] = []
        for ns in new_by_old_space.get(of["space"], []):
            candidates.extend(surfaces_by_space.get(ns, []))
        ranked: List[Tuple[float, str]] = []
        for nh in candidates:
            nf = new_features[nh]
            score = _face_match_score(of, nf, scale)
            if score >= 0:
                ranked.append((score, nh))
        ranked.sort(reverse=True)
        if not ranked:
            issues.append(f"Surface {old.name} has no candidate in the mapped new space(s)")
            continue
        margin = ranked[0][0] - (ranked[1][0] if len(ranked) > 1 else 0.0)
        confidence = ranked[0][0] + 0.15 * max(0.0, margin)
        pending.append((confidence, oh, ranked))
    pending.sort(reverse=True)
    for _confidence, oh, ranked in pending:
        available = [(s, h) for s, h in ranked if h not in used]
        old = template.by_handle[oh]
        if not available:
            issues.append(f"Surface {old.name} competes for a new surface already assigned to another geometry reference")
            continue
        best_s, best_h = available[0]
        second_s = available[1][0] if len(available) > 1 else -1.0
        if best_s < 0.58 or (second_s >= 0 and best_s - second_s < 0.045 and best_s < 0.88):
            issues.append(
                f"Surface {old.name} is ambiguous (best={best_s:.3f}, second={second_s:.3f})"
            )
            continue
        mapping[oh] = best_h
        used.add(best_h)
        rows.append({"old": old.name, "new": new_features[best_h]["obj"].name, "score": round(best_s, 6), "method": "geometry_match"})
    return mapping, issues, rows


def _match_subsurface_handles(
    template: ModelData,
    geom_model: ModelData,
    new_to_old: Dict[str, str],
    surface_map: Dict[str, str],
    needed: set[str],
    collision_map: Dict[str, str],
) -> Tuple[Dict[str, str], List[str], List[dict]]:
    mapping: Dict[str, str] = {}
    issues: List[str] = []
    rows: List[dict] = []
    needed_subs = [template.by_handle[h] for h in needed if h in template.by_handle and template.by_handle[h].obj_type == "OS:SubSurface"]
    if not needed_subs:
        return mapping, issues, rows
    new_features = {o.handle: _face_feature(geom_model, o) for o in geom_model.by_type.get("OS:SubSurface", []) if o.handle}
    subs_by_parent: Dict[str, List[str]] = defaultdict(list)
    for h, f in new_features.items():
        subs_by_parent[f["parent"]].append(h)
    scale = max(1.0, building_scale(build_space_features(template)), building_scale(build_space_features(geom_model)))
    used: set[str] = set()
    for old in needed_subs:
        oh = old.handle or ""
        same = collision_map.get(oh, oh)
        if same in new_features:
            mapping[oh] = same
            used.add(same)
            rows.append({"old": old.name, "new": new_features[same]["obj"].name, "score": 1.0, "method": "preserved_handle"})
            continue
        of = _face_feature(template, old)
        old_parent = of["parent"]
        new_parent = surface_map.get(old_parent, "")
        candidates = list(subs_by_parent.get(new_parent, [])) if new_parent else []
        if not candidates:
            # Fallback to openings in all new spaces mapped from the old parent space.
            parent_obj = template.by_handle.get(old_parent)
            old_space = parent_obj.fields[4] if parent_obj and len(parent_obj.fields) > 4 else ""
            allowed_new_spaces = {n for n, o in new_to_old.items() if o == old_space}
            candidates = [h for h, f in new_features.items() if f["space"] in allowed_new_spaces]
        ranked = []
        for nh in candidates:
            if nh in used:
                continue
            score = _face_match_score(of, new_features[nh], scale, parent_match=(new_parent and new_features[nh]["parent"] == new_parent))
            if score >= 0:
                ranked.append((score, nh))
        ranked.sort(reverse=True)
        if not ranked:
            issues.append(f"SubSurface {old.name} has no candidate")
            continue
        best_s, best_h = ranked[0]
        second_s = ranked[1][0] if len(ranked) > 1 else -1.0
        if best_s < 0.58 or (second_s >= 0 and best_s - second_s < 0.045 and best_s < 0.88):
            issues.append(f"SubSurface {old.name} is ambiguous (best={best_s:.3f}, second={second_s:.3f})")
            continue
        mapping[oh] = best_h
        used.add(best_h)
        rows.append({"old": old.name, "new": new_features[best_h]["obj"].name, "score": round(best_s, 6), "method": "geometry_match"})
    return mapping, issues, rows


def remap_retained_geometry_references(
    template: ModelData,
    geom_model: ModelData,
    objects: List[OSMObject],
    old_geom_handles: set[str],
    new_to_old: Dict[str, str],
    collision_map: Dict[str, str],
    report: dict,
) -> None:
    """Remap every retained reference to removed template geometry or stop safely."""
    needed = {
        value
        for obj in objects
        for value in obj.fields
        if value in old_geom_handles
    }
    if not needed:
        report["geometry_reference_remap"] = {"changed_fields": 0, "needed_handles": 0, "surface_matches": [], "subsurface_matches": []}
        return

    mapping: Dict[str, str] = {}
    issues: List[str] = []
    old_to_new_spaces: Dict[str, List[str]] = defaultdict(list)
    for new, old in new_to_old.items():
        old_to_new_spaces[old].append(new)
    for old in needed:
        obj = template.by_handle.get(old)
        if not obj:
            continue
        if obj.obj_type == "OS:Space":
            choices = old_to_new_spaces.get(old, [])
            if len(choices) == 1:
                mapping[old] = choices[0]
            elif len(choices) > 1:
                issues.append(f"Space {obj.name} maps to {len(choices)} new spaces; a retained object requires one unique space")
            else:
                issues.append(f"Space {obj.name} has no new-space mapping")

    story_map, story_issues = _match_story_handles(template, geom_model, needed)
    mapping.update(story_map)
    issues.extend(story_issues)
    surface_map, surface_issues, surface_rows = _match_surface_handles(template, geom_model, new_to_old, needed, collision_map)
    mapping.update(surface_map)
    issues.extend(surface_issues)
    sub_map, sub_issues, sub_rows = _match_subsurface_handles(template, geom_model, new_to_old, surface_map, needed, collision_map)
    mapping.update(sub_map)
    issues.extend(sub_issues)

    # Other imported geometry classes: prefer preserved handle, then a unique exact name/type match.
    for old in needed:
        if old in mapping:
            continue
        old_obj = template.by_handle.get(old)
        if not old_obj:
            continue
        same = collision_map.get(old, old)
        same_obj = geom_model.by_handle.get(same)
        if same_obj and same_obj.obj_type == old_obj.obj_type:
            mapping[old] = same
            continue
        matches = [o for o in geom_model.by_type.get(old_obj.obj_type, []) if normalized_name(o.name) == normalized_name(old_obj.name) and o.handle]
        if len(matches) == 1:
            mapping[old] = matches[0].handle or ""
        elif old_obj.obj_type not in {"OS:Space", "OS:BuildingStory", "OS:Surface", "OS:SubSurface"}:
            issues.append(f"{old_obj.obj_type} {old_obj.name} could not be mapped uniquely")

    unresolved = sorted(h for h in needed if h not in mapping)
    if unresolved:
        detail = []
        for h in unresolved[:12]:
            o = template.by_handle.get(h)
            detail.append(f"{o.obj_type}:{o.name}" if o else h)
        issues.append("Unresolved removed-geometry handles: " + ", ".join(detail))
    if issues:
        raise CompileError(
            "Some approved-template objects are tied to old geometry and cannot be transferred without guessing. "
            + "; ".join(dict.fromkeys(issues))
        )

    changed = 0
    changed_objects = Counter()
    for obj in objects:
        for i, value in enumerate(obj.fields):
            if value in mapping:
                obj.fields[i] = mapping[value]
                changed += 1
                changed_objects[obj.obj_type] += 1
    report["geometry_reference_remap"] = {
        "needed_handles": len(needed),
        "mapped_handles": len(mapping),
        "changed_fields": changed,
        "changed_object_types": dict(changed_objects),
        "surface_matches": surface_rows,
        "subsurface_matches": sub_rows,
    }

def compile_template(template_path: Path, geometry_path: Path, output_path: Path, config: dict, strict: bool=True) -> dict:
    template=parse_osm(template_path); geometry=parse_osm(geometry_path)
    report={"template":str(template_path),"geometry":str(geometry_path),"output":str(output_path),"warnings":[]}
    source_space_identity = {
        (space.handle, space.name)
        for space in geometry.by_type.get("OS:Space", [])
        if space.handle
    }
    try:
        import shapely  # noqa: F401
    except Exception as exc:
        if not config.get("allow_bbox_only",False):
            raise CompileError("Shapely 2.1+ is required for precise space-overlap matching. Install with: py -m pip install \"shapely>=2.1,<3\"") from exc
        report["warnings"].append("Shapely unavailable; using lower-precision bounding-box matching")
    tv=template.by_type.get("OS:Version",[None])[0]; gv=geometry.by_type.get("OS:Version",[None])[0]
    tver=tv.fields[1] if tv and len(tv.fields)>1 else "unknown"; gver=gv.fields[1] if gv and len(gv.fields)>1 else "unknown"
    if tver!=gver and not config.get("allow_version_mismatch",False): raise CompileError(f"OSM version mismatch: {tver} vs {gver}")
    report["openstudio_version"]={"template":tver,"geometry":gver}

    raw_geometry_coordinate_sha = geometry_coordinate_digest(geometry)
    core_gerr=validate_geometry(geometry, include_energyplus_limits=False)
    if core_gerr: raise CompileError("Input geometry invalid: "+"; ".join(core_gerr[:10]))
    repair_energyplus_geometry(
        geometry, report, enabled=bool(config.get("smart_energyplus_geometry_repairs", True))
    )
    gerr=validate_geometry(geometry, include_energyplus_limits=True)
    if gerr: raise CompileError("Input geometry is not EnergyPlus-compatible after safe repair: "+"; ".join(gerr[:10]))
    source_geometry_coordinate_sha = geometry_coordinate_digest(geometry)
    report["source_geometry_lock"]={
        "raw_coordinate_sha256":raw_geometry_coordinate_sha,
        "compatible_coordinate_sha256":source_geometry_coordinate_sha,
        "object_decomposition_only":raw_geometry_coordinate_sha!=source_geometry_coordinate_sha,
    }

    schedule_before=schedule_state(template); report["schedule_lock_before_sha256"]=schedule_digest(schedule_before)
    new_to_old,new_profiles,mapping_rows,ambiguous=match_spaces(template,geometry,config,strict)
    report["space_mapping"]={"count":len(mapping_rows),"ambiguous_count":len(ambiguous),"rows":mapping_rows}
    if ambiguous and strict and not config.get("allow_ambiguous",False):
        output_path.parent.mkdir(parents=True,exist_ok=True)
        review_path=output_path.parent/f"{template_path.stem}_SPACE_MAPPING_REVIEW.json"
        review_path.write_text(json.dumps({"template":str(template_path),"geometry":str(geometry_path),"ambiguous":ambiguous,"all_mappings":mapping_rows},indent=2),encoding="utf-8")
        names=", ".join(r["new_space"] for r in ambiguous[:12])
        raise CompileError(f"{len(ambiguous)} ambiguous space assignments ({names}). Review {review_path.name} or provide space_overrides; no model was written.")

    import_types=geometry_import_types(geometry)
    old_geom_handles=geometry_handle_set_for_types(template, import_types)
    old_space_handles={s.handle for s in template.by_type.get("OS:Space",[]) if s.handle}
    # Remove only the template geometry classes that are actually being replaced.
    # Template stories remain when the new geometry has no story objects.
    retained=[o.clone() for o in template.objects if o.obj_type not in import_types and not (o.obj_type=="OS:AdditionalProperties" and len(o.fields)>1 and o.fields[1] in old_geom_handles)]

    imported=[o.clone() for o in geometry.objects if o.obj_type in import_types]
    new_geom_handles={o.handle for o in imported if o.handle}
    imported_ap=[o.clone() for o in geometry.by_type.get("OS:AdditionalProperties",[]) if len(o.fields)>1 and o.fields[1] in new_geom_handles]
    occupied={o.handle for o in retained if o.handle}
    collision_map=remap_collisions(imported+imported_ap,occupied)
    if collision_map:
        colliding_space_handles = {
            handle for handle, _name in source_space_identity if handle in collision_map
        }
        if colliding_space_handles:
            raise CompileError(
                "New-space identity lock failed: one or more new OS:Space handles collide "
                "with protected template objects. No new space handle will be rewritten."
            )
        new_to_old={collision_map.get(n,n):o for n,o in new_to_old.items()}
        new_profiles={collision_map.get(n,n):p for n,p in new_profiles.items()}
        report["warnings"].append(f"Remapped {len(collision_map)} colliding imported handles")

    geom_model=ModelData(geometry_path,[o for o in imported if o.obj_type in import_types])
    # Assign anonymous behavior profiles; preserve geometry transform fields, exact volume,
    # and source story assignment whenever source story objects are available.
    features=build_space_features(geom_model)
    source_has_stories=bool(geom_model.by_type.get("OS:BuildingStory"))
    for s in geom_model.by_type.get("OS:Space",[]):
        if not s.handle: continue
        while len(s.fields)<=14: s.fields.append("")
        p=new_profiles[s.handle]
        for idx,val in zip(PROFILE_FIELDS,p): s.fields[idx]=val
        zmin=features[s.handle].bbox[4]
        if source_has_stories:
            story_ref=s.fields[9]
            story_obj=geom_model.by_handle.get(story_ref) if story_ref else None
            if not story_obj or story_obj.obj_type!="OS:BuildingStory":
                s.fields[9]=story_for_z(geom_model,zmin)
        else:
            s.fields[9]=story_for_z(template,zmin)

    generated_constructions=[]
    infer_constructions(template,geom_model,geometry,new_profiles,strict,report["warnings"],generated_constructions)
    reconcile_paired_constructions(template,geom_model,report,strict,generated_constructions)

    direct=clone_direct_space_objects(template,retained,old_space_handles,new_to_old,geom_model,report,strict,config)
    remap_retained_geometry_references(
        template, geom_model, retained + direct, old_geom_handles, new_to_old, collision_map, report
    )
    compiled_geometry_coordinate_sha = geometry_coordinate_digest(geom_model)
    if compiled_geometry_coordinate_sha != source_geometry_coordinate_sha:
        raise CompileError("Exact-coordinate lock failed: imported geometry coordinates or transforms changed")
    compiled_space_identity = {
        (space.handle, space.name)
        for space in geom_model.by_type.get("OS:Space", [])
        if space.handle
    }
    if compiled_space_identity != source_space_identity:
        raise CompileError(
            "New-space identity lock failed: output OS:Space handles/names differ from "
            "the selected new geometry model"
        )
    space_identity_sha = hashlib.sha256(
        json.dumps(sorted(compiled_space_identity), ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    report["exact_geometry_lock"] = {
        "passed": True,
        "coordinate_sha256": source_geometry_coordinate_sha,
        "new_space_identity_passed": True,
        "new_space_identity_sha256": space_identity_sha,
        "spaces": len(geom_model.by_type.get("OS:Space", [])),
        "surfaces": len(geom_model.by_type.get("OS:Surface", [])),
        "subsurfaces": len(geom_model.by_type.get("OS:SubSurface", [])),
    }
    zone_volumes=update_zone_volumes(retained,geom_model.by_type.get("OS:Space",[]))
    report["zone_volumes_m3"]={resolve_ref(template,h):v for h,v in zone_volumes.items()}

    output_objects=retained+generated_constructions+geom_model.objects+imported_ap+direct
    output=ModelData(output_path,output_objects)
    errors=validate_geometry(output, include_energyplus_limits=True)+validate_references(output)+validate_construction_pairs(output)
    if errors: raise CompileError("Compiled model validation failed: "+"; ".join(errors[:12]))

    # Schedule hard lock: all original schedules must be field-for-field identical, and every original
    # non-space object must retain exactly the same schedule references. Cloned direct objects may add refs.
    schedule_after=schedule_state(output)
    changed=[]
    for h,state in schedule_before["objects"].items():
        if schedule_after["objects"].get(h)!=state: changed.append(("schedule_object",h))
    for h,state in schedule_before["references"].items():
        original_obj=template.by_handle.get(h)
        # Space objects were replaced; direct-space objects were cloned. All other original refs are immutable.
        if original_obj and original_obj.obj_type!="OS:Space" and h in output.by_handle:
            if schedule_after["references"].get(h)!=state: changed.append(("schedule_reference",h,original_obj.obj_type,original_obj.name))
    if changed: raise CompileError(f"Schedule lock failed; compilation aborted: {changed[:10]}")
    schedule_object_payload={"objects":schedule_before["objects"],"references":{}}
    report["schedule_lock"]={
        "passed":True,
        "schedule_objects":len(schedule_before["objects"]),
        "protected_reference_objects":len(schedule_before["references"]),
        "schedule_objects_sha256":schedule_digest(schedule_object_payload),
        "changed_schedule_objects":0,
        "changed_protected_schedule_references":0,
    }

    output_path.parent.mkdir(parents=True,exist_ok=True)
    write_osm(output_path,output_objects)

    # Reparse and validate the exact serialized OSM, not only the in-memory graph.
    # This catches schema-field shifts, omitted blank scalar fields, malformed
    # extensibles, and writer/parser disagreements before native OpenStudio runs.
    serialized = parse_osm(output_path)
    serialized_errors = (
        validate_geometry(serialized, include_energyplus_limits=True)
        + validate_references(serialized)
        + validate_construction_pairs(serialized)
    )
    if serialized_errors:
        raise CompileError(
            "Serialized OSM round-trip validation failed: " + "; ".join(serialized_errors[:12])
        )
    serialized_geometry_sha = geometry_coordinate_digest(
        ModelData(output_path, [
            o for o in serialized.objects if o.obj_type in geometry_import_types(serialized)
        ])
    )
    # The full-output digest includes the imported geometry classes and is compared
    # directly to the already validated compiled geometry digest.
    output_geometry_only = ModelData(
        output_path,
        [o for o in serialized.objects if o.obj_type in import_types],
    )
    serialized_space_identity = {
        (space.handle, space.name)
        for space in serialized.by_type.get("OS:Space", [])
        if space.handle
    }
    if serialized_space_identity != source_space_identity:
        raise CompileError(
            "Serialized new-space identity lock failed: OS:Space handles/names changed "
            "during file writing"
        )
    serialized_geometry_sha = geometry_coordinate_digest(output_geometry_only)
    if serialized_geometry_sha != source_geometry_coordinate_sha:
        raise CompileError(
            "Serialized OSM geometry lock failed: coordinates/transforms changed during file writing"
        )
    serialized_schedule = schedule_state(serialized)
    serialized_schedule_changes = []
    for h, state in schedule_before["objects"].items():
        if serialized_schedule["objects"].get(h) != state:
            serialized_schedule_changes.append(("schedule_object", h))
    for h, state in schedule_before["references"].items():
        original_obj = template.by_handle.get(h)
        if original_obj and original_obj.obj_type != "OS:Space" and h in serialized.by_handle:
            if serialized_schedule["references"].get(h) != state:
                serialized_schedule_changes.append(("schedule_reference", h, original_obj.obj_type, original_obj.name))
    if serialized_schedule_changes:
        raise CompileError(
            f"Serialized OSM schedule lock failed: {serialized_schedule_changes[:10]}"
        )
    report["serialized_roundtrip_validation"] = {
        "passed": True,
        "geometry_coordinate_sha256": serialized_geometry_sha,
        "geometry_layout_errors": 0,
        "reference_errors": 0,
        "construction_pair_errors": 0,
        "changed_schedule_objects": 0,
        "changed_protected_schedule_references": 0,
    }
    report["object_counts"]=dict(sorted(Counter(o.obj_type for o in output_objects).items()))
    return report


def compile_many(templates: List[Path], geometry: Path, outdir: Path, config_path: Optional[Path], strict: bool=True) -> Tuple[List[Path],Path]:
    config=load_config(config_path); outdir.mkdir(parents=True,exist_ok=True)
    reports=[]; outputs=[]
    # Precompute mapping reports even on failure by compiling one at a time.
    for template in templates:
        out=outdir/f"{template.stem}_UPDATED_GEOMETRY_FLEX.osm"
        try:
            rep=compile_template(template,geometry,out,config,strict)
            reports.append({"status":"success",**rep}); outputs.append(out)
        except Exception as exc:
            reports.append({"status":"failed","template":str(template),"geometry":str(geometry),"output":str(out),"error":str(exc),"traceback":traceback.format_exc()})
            report_path=outdir/"flexible_geometry_compile_report.json"
            report_path.write_text(json.dumps({"compiler":"OpenStudio Baseline + Proposed Geometry Compiler","strict":strict,"reports":reports},indent=2),encoding="utf-8")
            raise
    report_path=outdir/"flexible_geometry_compile_report.json"
    report_path.write_text(json.dumps({"compiler":"OpenStudio Baseline + Proposed Geometry Compiler","strict":strict,"reports":reports},indent=2),encoding="utf-8")
    return outputs,report_path




def model_openstudio_version(model: ModelData) -> str:
    obj = model.by_type.get("OS:Version", [None])[0]
    return obj.fields[1] if obj and len(obj.fields) > 1 else "unknown"


def role_config(config: dict, role: str) -> dict:
    """Merge global config with a role-specific baseline/proposed section."""
    if not config:
        return {}
    if not any(k in config for k in ("global", "baseline", "proposed")):
        return copy.deepcopy(config)
    merged = copy.deepcopy(config.get("global", {}))
    section = config.get(role.lower(), {})
    for key, value in section.items():
        if key == "space_overrides":
            base = dict(merged.get(key, {}))
            base.update(value or {})
            merged[key] = base
        elif key == "semantic_categories":
            base = dict(merged.get(key, {}))
            base.update(value or {})
            merged[key] = base
        else:
            merged[key] = value
    return merged


def preflight_pair(
    geometry_path: Path,
    baseline_path: Path,
    proposed_path: Path,
    config: Optional[dict] = None,
) -> dict:
    config = config or {}
    paths = [geometry_path, baseline_path, proposed_path]
    for path in paths:
        if not path or not Path(path).is_file():
            raise CompileError(f"File not found: {path}")
        if Path(path).suffix.lower() != ".osm":
            raise CompileError(f"Expected an .osm file: {path}")
    resolved = [Path(p).resolve() for p in paths]
    if len(set(resolved)) != 3:
        raise CompileError("New Geometry, Baseline, and Proposed must be three separately selected OSM files.")

    geometry = parse_osm(geometry_path)
    baseline = parse_osm(baseline_path)
    proposed = parse_osm(proposed_path)
    role_errors = validate_selection_roles(geometry, [("BASELINE", baseline), ("PROPOSED", proposed)])
    if role_errors:
        raise CompileError("Selection check failed: " + " ".join(role_errors))
    raw_geometry_sha = geometry_coordinate_digest(geometry)
    core_gerr = validate_geometry(geometry, include_energyplus_limits=False)
    if core_gerr:
        raise CompileError("New geometry failed geometric preflight: " + "; ".join(core_gerr[:10]))
    preflight_repairs: dict = {}
    repair_energyplus_geometry(
        geometry, preflight_repairs,
        enabled=bool(role_config(config, "baseline").get("smart_energyplus_geometry_repairs", True)),
    )
    gerr = validate_geometry(geometry, include_energyplus_limits=True)
    if gerr:
        raise CompileError("New geometry is not EnergyPlus-compatible after safe repair: " + "; ".join(gerr[:10]))
    versions = {
        "geometry": model_openstudio_version(geometry),
        "baseline": model_openstudio_version(baseline),
        "proposed": model_openstudio_version(proposed),
    }
    allow_version = bool(config.get("global", config).get("allow_version_mismatch", False)) if config else False
    if not allow_version and len(set(versions.values())) > 1:
        raise CompileError(
            "OpenStudio version mismatch: "
            + ", ".join(f"{k}={v}" for k, v in versions.items())
            + ". Save all three models in the same OpenStudio version before compiling."
        )

    result = {
        "compiler_version": COMPILER_VERSION,
        "versions": versions,
        "geometry": {
            "path": str(geometry_path),
            "summary": model_summary(geometry),
            "raw_coordinate_sha256": raw_geometry_sha,
            "compatible_coordinate_sha256": geometry_coordinate_digest(geometry),
            "compatibility_repairs": preflight_repairs.get("energyplus_compatibility_repairs", {"count":0,"repairs":[]}),
        },
        "baseline": {"path": str(baseline_path), "summary": model_summary(baseline)},
        "proposed": {"path": str(proposed_path), "summary": model_summary(proposed)},
        "mapping": {},
    }
    for role, template in (("baseline", baseline), ("proposed", proposed)):
        cfg = role_config(config, role)
        _, _, rows, ambiguous = match_spaces(template, geometry, cfg, strict=False)
        profile_distribution = Counter(
            row.get("profile", {}).get("thermal_zone", "Unlabeled profile")
            for row in rows
        )
        confidence_distribution = {
            "minimum": min((float(row.get("score", 0.0)) for row in rows), default=0.0),
            "below_75_percent": sum(
                1 for row in rows
                if float(row.get("score", 0.0)) < MINIMUM_MAPPING_CONFIDENCE
            ),
        }
        result["mapping"][role] = {
            "count": len(rows),
            "ambiguous_count": len(ambiguous),
            "rows": rows,
            "ambiguous": ambiguous,
            "behavior_profile_distribution": dict(profile_distribution),
            "confidence_distribution": confidence_distribution,
        }
    return result


def _write_mapping_csv(path: Path, rows: Sequence[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "New Model Space", "New Handle", "Architectural Use",
            "Template Behavior Source", "Template Source Handle",
            "Profile Confidence", "Source Geometry Compatibility",
            "Method", "Below 75% / Ambiguous", "Assigned Template Logic",
            "Adjacent Spaces Considered", "Local AI Provider",
        ])
        for row in rows:
            profile = row.get("profile", {})
            profile_text = "; ".join(f"{k}={v}" for k, v in profile.items() if v)
            writer.writerow([
                row.get("new_space", ""), row.get("new_handle", ""),
                row.get("architectural_use", ""), row.get("old_space", ""),
                row.get("old_handle", ""), row.get("score", ""),
                row.get("source_match_score", ""), row.get("method", ""),
                row.get("ambiguous", False), profile_text,
                row.get("adjacent_spaces_considered", ""),
                row.get("local_ai_provider", ""),
            ])


def _native_check_script_text() -> str:
    return r'''# OpenStudio native OSM load + forward translation check
abort("Usage: openstudio OpenStudio_Load_Check.rb model.osm") if ARGV.empty?
path = OpenStudio::Path.new(File.expand_path(ARGV[0]))
optional_model = OpenStudio::Model::Model.load(path)
if optional_model.empty?
  warn "FAIL: OpenStudio could not load #{path}"
  exit 2
end
model = optional_model.get
puts "PASS: OpenStudio loaded #{path}"
puts "Objects: #{model.numObjects}"
puts "Spaces: #{model.getSpaces.size}"
puts "Surfaces: #{model.getSurfaces.size}"
puts "SubSurfaces: #{model.getSubSurfaces.size}"
puts "Thermal Zones: #{model.getThermalZones.size}"

def message_text(message)
  message.respond_to?(:logMessage) ? message.logMessage.to_s : message.to_s
end

translator = OpenStudio::EnergyPlus::ForwardTranslator.new
workspace = translator.translateModel(model)
errors = translator.errors.map { |message| message_text(message) }
warnings = translator.warnings.map { |message| message_text(message) }
puts "FT_ERROR_COUNT=#{errors.size}"
puts "FT_WARNING_COUNT=#{warnings.size}"
errors.each { |message| warn "FT_ERROR: #{message}" }
warnings.each { |message| puts "FT_WARNING: #{message}" }
blocked = errors.any? || warnings.any? { |message|
  message =~ /currently unable to translate/i ||
  message =~ /could not resolve matched construction conflicts/i ||
  message =~ /more vertices than allowed/i
}
if blocked
  warn "FAIL: Forward translation contains blocking geometry/construction errors"
  exit 3
end
idf_path = OpenStudio::Path.new(File.join(File.dirname(File.expand_path(ARGV[0])), "NATIVE_CHECK_TRANSLATED.idf"))
unless workspace.save(idf_path, true)
  warn "FAIL: Could not save translated IDF"
  exit 4
end
puts "PASS: Forward translation completed without blocking errors"
puts "IDF_PATH=#{idf_path}"
'''



def _version_tuple(version: str) -> Tuple[int, ...]:
    values = re.findall(r"\d+", version or "")
    return tuple(int(v) for v in values[:3]) if values else tuple()


def query_openstudio_cli_version(cli: str, timeout: int = 25) -> dict:
    """Return the SDK version embedded in an OpenStudio CLI executable.

    A CLI can exist on PATH while belonging to an older OpenStudio install.  The
    OSM header is not enough: native validation must use the same SDK/IDD version.
    """
    path = str(Path(cli))
    attempts: List[Tuple[List[str], Optional[Path]]] = []
    attempts.append(([path, "--version"], None))
    attempts.append(([path, "-v"], None))
    temp_script: Optional[Path] = None
    try:
        fd, temp_name = tempfile.mkstemp(prefix="openstudio_sdk_version_", suffix=".rb")
        os.close(fd)
        temp_script = Path(temp_name)
        temp_script.write_text('puts OpenStudio.openStudioVersion\n', encoding='utf-8')
        attempts.append(([path, str(temp_script)], temp_script))
        outputs: List[str] = []
        for command, _ in attempts:
            try:
                completed = subprocess.run(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    timeout=timeout,
                    creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW") else 0),
                )
                output = completed.stdout or ""
                outputs.append(output)
                # Prefer an explicit semantic version.  Ignore unrelated Ruby or
                # EnergyPlus versions when the output labels OpenStudio.
                labeled = re.search(r"(?i)openstudio(?:\s+sdk)?[^0-9]{0,20}(\d+\.\d+\.\d+)", output)
                matches = re.findall(r"(?<!\d)(\d+\.\d+\.\d+)(?!\d)", output)
                version = labeled.group(1) if labeled else (matches[0] if matches else "")
                if version:
                    return {
                        "path": path,
                        "version": version,
                        "ok": True,
                        "returncode": completed.returncode,
                        "output": output[-4000:],
                    }
            except Exception as exc:
                outputs.append(str(exc))
        return {"path": path, "version": "unknown", "ok": False, "output": "\n".join(outputs)[-4000:]}
    finally:
        if temp_script:
            try:
                temp_script.unlink()
            except Exception:
                pass


def discover_openstudio_clis(explicit: Optional[str] = None) -> List[str]:
    """Find plausible CLI executables without selecting the first/oldest one."""
    candidates: List[str] = []
    if explicit:
        candidates.append(explicit)
    env_cli = os.environ.get("OPENSTUDIO_CLI")
    if env_cli:
        candidates.append(env_cli)
    for executable in ("openstudio", "openstudio.exe"):
        found = shutil.which(executable)
        if found:
            candidates.append(found)
    if os.name == "nt":
        roots = [
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            os.environ.get("LOCALAPPDATA", ""),
            "C:/",
        ]
        patterns = [
            "OpenStudio*/bin/openstudio.exe",
            "openstudio*/bin/openstudio.exe",
            "OpenStudio*/openstudio.exe",
            "openstudio*/openstudio.exe",
            "OpenStudioApplication*/bin/openstudio.exe",
            "openstudioapplication*/bin/openstudio.exe",
        ]
        for root in roots:
            if not root:
                continue
            root_path = Path(root)
            for pattern in patterns:
                try:
                    candidates.extend(str(p) for p in root_path.glob(pattern))
                except Exception:
                    pass
    unique: List[str] = []
    seen = set()
    for candidate in candidates:
        if not candidate:
            continue
        p = Path(candidate)
        resolved = str(p.resolve()) if p.is_file() else (shutil.which(candidate) or "")
        if not resolved:
            continue
        key = os.path.normcase(os.path.abspath(resolved))
        if key not in seen:
            seen.add(key)
            unique.append(resolved)
    return unique


def select_openstudio_cli(model_version: str, explicit: Optional[str] = None, require: bool = False) -> dict:
    """Select an exact SDK-version match; never silently use an older CLI."""
    target = (model_version or "").strip()
    candidates = discover_openstudio_clis(explicit)
    inspected = [query_openstudio_cli_version(path) for path in candidates]
    exact = [item for item in inspected if item.get("ok") and item.get("version") == target]
    if exact:
        # Prefer an explicitly selected exact match, otherwise newest path ordering.
        chosen = exact[0]
        return {"cli": chosen["path"], "version": chosen["version"], "matched": True, "candidates": inspected}

    if explicit:
        selected = inspected[0] if inspected else {"path": explicit, "version": "unknown", "ok": False}
        raise CompileError(
            f"Selected OpenStudio CLI is SDK {selected.get('version','unknown')}, but all input OSM files are {target}. "
            "Choose the openstudio.exe bundled with the matching OpenStudio installation. "
            f"Selected path: {selected.get('path', explicit)}"
        )

    if require:
        found_text = "; ".join(f"{x.get('version','unknown')} at {x.get('path','')}" for x in inspected) or "none"
        raise CompileError(
            f"Native OpenStudio validation requires SDK {target}, but no exact matching openstudio.exe was found. "
            f"Detected CLI installations: {found_text}. Open Advanced Options and select the matching executable."
        )
    return {"cli": None, "version": None, "matched": False, "candidates": inspected}


def find_openstudio_cli(explicit: Optional[str] = None, model_version: Optional[str] = None) -> Optional[str]:
    """Backward-compatible helper. With a model version, only an exact match is returned."""
    if model_version:
        return select_openstudio_cli(model_version, explicit=explicit, require=False).get("cli")
    candidates = discover_openstudio_clis(explicit)
    return candidates[0] if candidates else None

def _discover_energyplus_executable(cli: str) -> Optional[str]:
    cli_path=Path(cli).resolve()
    roots=[cli_path.parent,cli_path.parent.parent,cli_path.parent.parent.parent]
    candidates=[]
    for root in roots:
        candidates.extend([
            root/"EnergyPlus"/("energyplus.exe" if os.name=="nt" else "energyplus"),
            root/("energyplus.exe" if os.name=="nt" else "energyplus"),
        ])
    found=shutil.which("energyplus.exe" if os.name=="nt" else "energyplus")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    # Last-resort shallow scan around the selected exact-version CLI.
    for root in roots[:2]:
        try:
            for candidate in root.glob("**/energyplus.exe" if os.name=="nt" else "**/energyplus"):
                if candidate.is_file():
                    return str(candidate)
        except Exception:
            pass
    return None


def _critical_native_lines(output: str) -> List[str]:
    lines = [line.strip() for line in (output or "").splitlines() if line.strip()]
    benign = re.compile(
        r"FT_WARNING:.*(?:not symmetric, creating a reversed copy|creating a reversed copy|reference different constructions, choosing .* based on search distance)",
        re.I,
    )
    patterns = (
        r"^FT_ERROR:", r"^FAIL:", r"\*\*\s*Severe\s*\*\*", r"\*\*\s*Fatal\s*\*\*",
        r"EnergyPlus Terminated", r"currently unable to translate",
        r"could not resolve matched construction conflicts", r"more vertices than allowed",
        r"Traceback", r"Exception",
    )
    result = []
    for line in lines:
        if benign.search(line):
            continue
        if any(re.search(pattern, line, re.I) for pattern in patterns) and line not in result:
            result.append(line)
    return result


def native_failure_summary(result: dict, max_lines: int = 18) -> str:
    critical = list(result.get("critical_lines") or [])
    if not critical:
        critical = _critical_native_lines((result.get("output") or "") + "\n" + (result.get("energyplus_output") or ""))
    if not critical:
        details = []
        rc = result.get("returncode")
        ep_rc = result.get("energyplus_returncode")
        if rc not in (None, 0):
            details.append(f"OpenStudio validator exited with code {rc}")
        if ep_rc not in (None, 0):
            details.append(f"EnergyPlus exited with code {ep_rc}")
        if result.get("energyplus_smoke_attempted") and result.get("energyplus_smoke_passed") is False:
            details.append("EnergyPlus design-day smoke test did not pass")
        critical = details or ["Native validation did not pass; inspect the preserved full log."]
    log_path = result.get("full_log_path")
    if log_path:
        critical.append(f"Full native log: {log_path}")
    return "\n".join(critical[:max_lines])


def run_native_openstudio_check(cli: str, ruby_script: Path, model_path: Path, timeout: int = 300, label: str = "MODEL") -> dict:
    label = re.sub(r"[^A-Za-z0-9_-]+", "_", label.upper())
    full_log_path = model_path.parent / f"NATIVE_CHECK_{label}.log"
    try:
        completed = subprocess.run(
            [cli, str(ruby_script), str(model_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW") else 0),
        )
        output = completed.stdout or ""
        full_log_path.write_text(output, encoding="utf-8", errors="ignore")
        blocking_patterns = (
            r"currently unable to translate", r"could not resolve matched construction conflicts",
            r"more vertices than allowed", r"FT_ERROR:", r"FAIL: Forward translation",
        )
        blocked = any(re.search(pattern, output, re.I) for pattern in blocking_patterns)
        ft_warning_lines = re.findall(r"(?m)^FT_WARNING:.*$", output)
        benign_warning_lines = [line for line in ft_warning_lines if re.search(
            r"not symmetric, creating a reversed copy|creating a reversed copy|reference different constructions, choosing .* based on search distance",
            line, re.I
        )]
        result = {
            "attempted": True,
            "passed": completed.returncode == 0 and not blocked,
            "returncode": completed.returncode,
            "output": output[:12000] + ("\n... [middle omitted; see full log] ...\n" if len(output) > 24000 else "") + output[-12000:],
            "critical_lines": _critical_native_lines(output),
            "full_log_path": str(full_log_path),
            "cli": cli,
            "forward_translation_passed": completed.returncode == 0 and not blocked,
            "forward_translator_warning_count": len(ft_warning_lines),
            "benign_forward_translator_warning_count": len(benign_warning_lines),
            "energyplus_smoke_attempted": False,
            "energyplus_smoke_passed": None,
        }
        if not result["passed"]:
            return result
        match = re.search(r"(?m)^IDF_PATH=(.+)$", output)
        idf_path = Path(match.group(1).strip()) if match else model_path.parent / "NATIVE_CHECK_TRANSLATED.idf"
        energyplus = _discover_energyplus_executable(cli)
        result["energyplus_executable"] = energyplus
        if not energyplus or not idf_path.is_file():
            result["output"] += "\nSMOKE_CHECK_SKIPPED: EnergyPlus executable or translated IDF not found."
            return result
        smoke_dir = model_path.parent / f"ENERGYPLUS_GEOMETRY_SMOKE_{label}"
        if smoke_dir.exists():
            shutil.rmtree(smoke_dir, ignore_errors=True)
        smoke_dir.mkdir(parents=True, exist_ok=True)
        smoke = subprocess.run(
            [energyplus, "--design-day", "--output-directory", str(smoke_dir), str(idf_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW") else 0),
        )
        smoke_output = smoke.stdout or ""
        err_path = smoke_dir / "eplusout.err"
        err_text = err_path.read_text(encoding="utf-8", errors="ignore") if err_path.is_file() else ""
        severe = bool(re.search(r"\*\*\s*(Severe|Fatal)\s*\*\*", err_text, re.I))
        combined = smoke_output + "\n" + err_text
        with full_log_path.open("a", encoding="utf-8", errors="ignore") as f:
            f.write("\n--- ENERGYPLUS DESIGN-DAY GEOMETRY SMOKE TEST ---\n")
            f.write(combined)
        result.update({
            "energyplus_smoke_attempted": True,
            "energyplus_smoke_passed": smoke.returncode == 0 and not severe,
            "energyplus_returncode": smoke.returncode,
            "energyplus_error_file": str(err_path) if err_path.is_file() else None,
            "energyplus_output": combined[:12000] + ("\n... [middle omitted; see full log] ...\n" if len(combined) > 24000 else "") + combined[-12000:],
        })
        result["critical_lines"] = _critical_native_lines(output + "\n" + combined)
        result["passed"] = bool(result["passed"] and result["energyplus_smoke_passed"])
        return result
    except Exception as exc:
        try:
            full_log_path.write_text(str(exc), encoding="utf-8")
        except Exception:
            pass
        return {
            "attempted": True, "passed": False, "returncode": None,
            "output": str(exc), "critical_lines": [f"Exception: {exc}"],
            "full_log_path": str(full_log_path), "cli": cli,
            "forward_translation_passed": False,
            "energyplus_smoke_attempted": False, "energyplus_smoke_passed": None,
        }


def _write_validation_batch(path: Path) -> None:
    path.write_text(r'''@echo off
setlocal
cd /d "%~dp0"
where openstudio >nul 2>nul
if errorlevel 1 (
  echo OpenStudio CLI was not found in PATH.
  echo Enter the full path to openstudio.exe, for example:
  echo C:\openstudio-3.10.0\bin\openstudio.exe
  set /p OSCLI=OpenStudio CLI path: 
) else (
  set OSCLI=openstudio
)
"%OSCLI%" "%~dp0OpenStudio_Load_Check.rb" "%~dp0BASELINE_UPDATED_GEOMETRY.osm"
if errorlevel 1 goto :failed
"%OSCLI%" "%~dp0OpenStudio_Load_Check.rb" "%~dp0PROPOSED_UPDATED_GEOMETRY.osm"
if errorlevel 1 goto :failed
echo.
echo PASS: Both models loaded successfully in OpenStudio.
pause
exit /b 0
:failed
echo.
echo FAIL: One or both models failed the native OpenStudio load check.
pause
exit /b 2
''', encoding="utf-8", newline="\r\n")


def _report_status_card(role: str, report: dict) -> str:
    counts = report.get("object_counts", {})
    lock = report.get("schedule_lock", {})
    geom = report.get("exact_geometry_lock", {})
    mapping = report.get("space_mapping", {})
    mapping_rows = mapping.get("rows", [])
    minimum_confidence = min(
        (float(row.get("score", 0.0)) for row in mapping_rows),
        default=0.0,
    )
    profile_distribution = Counter(
        str(row.get("profile", {}).get("thermal_zone", "Unlabeled")).rsplit(":", 1)[-1]
        for row in mapping_rows
    )
    profile_text = ", ".join(
        f"{name}: {count}" for name, count in profile_distribution.items()
    )
    provider = next(
        (row.get("local_ai_provider") for row in mapping_rows if row.get("local_ai_provider")),
        "Rule/geometry fallback",
    )
    native = report.get("native_openstudio_check", {})
    native_text = "Not run"
    native_class = "warn"
    if native.get("attempted"):
        native_text = "Passed" if native.get("passed") else "Failed"
        native_class = "ok" if native.get("passed") else "bad"
    return f'''
    <section class="card">
      <h2>{html_lib.escape(role.title())}</h2>
      <div class="grid">
        <div><b>Result</b><span class="ok">Validated</span></div>
        <div><b>Spaces</b><span>{counts.get("OS:Space", 0):,}</span></div>
        <div><b>Surfaces</b><span>{counts.get("OS:Surface", 0):,}</span></div>
        <div><b>Openings</b><span>{counts.get("OS:SubSurface", 0):,}</span></div>
        <div><b>Space mappings</b><span>{mapping.get("count", 0):,}</span></div>
        <div><b>Ambiguous</b><span class="ok">{mapping.get("ambiguous_count", 0)}</span></div>
        <div><b>Minimum confidence</b><span class="ok">{100.0 * minimum_confidence:.1f}%</span></div>
        <div><b>Behavior profiles</b><span>{html_lib.escape(profile_text)}</span></div>
        <div><b>Local AI</b><span>{html_lib.escape(str(provider))}</span></div>
        <div><b>Schedule lock</b><span class="ok">Passed · {lock.get("schedule_objects", 0)} objects</span></div>
        <div><b>Exact coordinates</b><span class="ok">{'Passed' if geom.get('passed') else 'Unknown'}</span></div>
        <div><b>Native OpenStudio</b><span class="{native_class}">{native_text}</span></div>
      </div>
    </section>'''


def write_pair_reports(run_dir: Path, pair_report: dict) -> Tuple[Path, Path]:
    json_path = run_dir / "COMPILATION_AUDIT.json"
    json_path.write_text(json.dumps(pair_report, indent=2, ensure_ascii=False), encoding="utf-8")
    lines = [
        "OPENSTUDIO BASELINE + PROPOSED GEOMETRY COMPILATION",
        "=" * 62,
        f"Compiler version: {COMPILER_VERSION}",
        f"Completed: {pair_report.get('completed_at', '')}",
        f"Geometry: {pair_report.get('inputs', {}).get('geometry', '')}",
        f"Baseline template: {pair_report.get('inputs', {}).get('baseline', '')}",
        f"Proposed template: {pair_report.get('inputs', {}).get('proposed', '')}",
        "",
    ]
    for role in ("baseline", "proposed"):
        r = pair_report.get("reports", {}).get(role, {})
        c = r.get("object_counts", {})
        mapping_rows = r.get("space_mapping", {}).get("rows", [])
        minimum_confidence = min(
            (float(row.get("score", 0.0)) for row in mapping_rows),
            default=0.0,
        )
        profiles = Counter(
            str(row.get("profile", {}).get("thermal_zone", "Unlabeled")).rsplit(":", 1)[-1]
            for row in mapping_rows
        )
        provider = next(
            (row.get("local_ai_provider") for row in mapping_rows if row.get("local_ai_provider")),
            "Rule/geometry fallback",
        )
        lines.extend([
            role.upper(),
            "-" * 30,
            f"Output: {pair_report.get('outputs', {}).get(role, '')}",
            f"Spaces / surfaces / openings: {c.get('OS:Space', 0)} / {c.get('OS:Surface', 0)} / {c.get('OS:SubSurface', 0)}",
            f"Space mappings: {r.get('space_mapping', {}).get('count', 0)}; ambiguous: {r.get('space_mapping', {}).get('ambiguous_count', 0)}",
            f"Minimum profile confidence: {100.0 * minimum_confidence:.1f}%",
            f"Behavior profile distribution: {dict(profiles)}",
            f"Local AI execution provider: {provider}",
            f"Exact geometry lock: {r.get('exact_geometry_lock', {}).get('passed', False)}",
            f"Schedule lock: {r.get('schedule_lock', {}).get('passed', False)}; changed schedules: {r.get('schedule_lock', {}).get('changed_schedule_objects', 'n/a')}",
            f"Static reference/geometry validation: PASS",
            f"Native OpenStudio check: {r.get('native_openstudio_check', {}).get('passed') if r.get('native_openstudio_check', {}).get('attempted') else 'not run'}",
            f"Warnings: {len(r.get('warnings', []))}",
            "",
        ])
    txt_path = run_dir / "VALIDATION_SUMMARY.txt"
    txt_path.write_text("\n".join(lines), encoding="utf-8")

    cards = "".join(_report_status_card(role, pair_report.get("reports", {}).get(role, {})) for role in ("baseline", "proposed"))
    html_path = run_dir / "COMPILATION_AUDIT.html"
    html_path.write_text(f'''<!doctype html>
<html><head><meta charset="utf-8"><title>OpenStudio Geometry Compilation Audit</title>
<style>
body{{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f3f7f7;color:#102a2a}}header{{background:#0f5f5b;color:white;padding:28px 36px}}header h1{{margin:0 0 6px;font-size:28px}}header p{{margin:0;color:#d8fffb}}main{{max-width:1120px;margin:24px auto;padding:0 20px}}.card{{background:white;border:1px solid #d7e4e3;border-radius:14px;padding:22px;margin:18px 0;box-shadow:0 6px 20px rgba(15,95,91,.08)}}.grid{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}}.grid div{{background:#f6fbfa;border-radius:9px;padding:12px}}b{{display:block;color:#52706e;font-size:12px;text-transform:uppercase;margin-bottom:5px}}span{{font-size:16px}}.ok{{color:#087f5b;font-weight:700}}.warn{{color:#a56600;font-weight:700}}.bad{{color:#c92a2a;font-weight:700}}table{{width:100%;border-collapse:collapse}}td{{padding:8px;border-bottom:1px solid #e5eeee}}code{{word-break:break-all}}@media(max-width:760px){{.grid{{grid-template-columns:1fr}}}}
</style></head><body>
<header><h1>Geometry Compilation Complete</h1><p>Approved Baseline and Proposed templates rebuilt with exact new geometry</p></header>
<main>
<section class="card"><h2>Inputs</h2><table>
<tr><td>New Geometry</td><td><code>{html_lib.escape(pair_report.get('inputs',{}).get('geometry',''))}</code></td></tr>
<tr><td>Approved Baseline</td><td><code>{html_lib.escape(pair_report.get('inputs',{}).get('baseline',''))}</code></td></tr>
<tr><td>Approved Proposed</td><td><code>{html_lib.escape(pair_report.get('inputs',{}).get('proposed',''))}</code></td></tr>
<tr><td>OpenStudio versions</td><td>{html_lib.escape(str(pair_report.get('preflight',{}).get('versions',{})))}</td></tr>
</table></section>
{cards}
<section class="card"><h2>Safety guarantees applied</h2><p>Exact new-space identity and coordinate lock, 75% minimum behavior-profile confidence, local architectural context inference, reciprocal surface and parent validation, dangling-handle validation, immutable schedule-object lock, protected schedule-reference lock, independent Baseline/Proposed compilation, and atomic output commit.</p></section>
</main></body></html>''', encoding="utf-8")
    return html_path, txt_path


def compile_baseline_proposed_pair(
    geometry_path: Path,
    baseline_path: Path,
    proposed_path: Path,
    outdir: Path,
    config: Optional[dict] = None,
    openstudio_cli: Optional[str] = None,
    require_native_check: bool = False,
    progress: Optional[Any] = None,
) -> dict:
    """Compile both models atomically. No OSM output is committed unless both pass."""
    config = config or {}
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    staging = Path(tempfile.mkdtemp(prefix=".osm_compile_staging_", dir=str(outdir)))
    report: Dict[str, Any] = {
        "compiler": "OpenStudio Baseline + Proposed Geometry Compiler",
        "compiler_version": COMPILER_VERSION,
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "inputs": {"geometry": str(geometry_path), "baseline": str(baseline_path), "proposed": str(proposed_path)},
        "reports": {},
        "outputs": {},
    }
    try:
        if progress:
            progress("preflight", "Reading and validating all three OSM files…")
        preflight = preflight_pair(geometry_path, baseline_path, proposed_path, config)
        report["preflight"] = preflight
        if any(preflight["mapping"][role]["ambiguous_count"] for role in ("baseline", "proposed")):
            review = {
                role: preflight["mapping"][role]["ambiguous"]
                for role in ("baseline", "proposed")
                if preflight["mapping"][role]["ambiguous_count"]
            }
            review_path = outdir / f"SPACE_MAPPING_REVIEW_{timestamp}.json"
            review_path.write_text(json.dumps(review, indent=2), encoding="utf-8")
            raise CompileError(
                "Space mapping needs review before compilation. "
                + ", ".join(f"{role}: {preflight['mapping'][role]['ambiguous_count']}" for role in review)
                + f". Review file: {review_path}"
            )

        # Resolve the native validator before the expensive compilation begins.
        # An older CLI on PATH must never be used against a newer OSM schema.
        model_version = preflight["versions"]["geometry"]
        cli_selection = select_openstudio_cli(
            model_version,
            explicit=openstudio_cli,
            require=require_native_check,
        )
        report["openstudio_cli_selection"] = cli_selection

        outputs = {
            "baseline": staging / "BASELINE_UPDATED_GEOMETRY.osm",
            "proposed": staging / "PROPOSED_UPDATED_GEOMETRY.osm",
        }
        for role, template_path in (("baseline", baseline_path), ("proposed", proposed_path)):
            if progress:
                progress(role, f"Compiling {role.title()} template…")
            role_report = compile_template(template_path, geometry_path, outputs[role], role_config(config, role), strict=True)
            report["reports"][role] = role_report
            _write_mapping_csv(staging / f"SPACE_MAPPING_{role.upper()}.csv", role_report.get("space_mapping", {}).get("rows", []))

        ruby_script = staging / "OpenStudio_Load_Check.rb"
        ruby_script.write_text(_native_check_script_text(), encoding="utf-8")
        _write_validation_batch(staging / "Validate_Compiled_Models.bat")
        cli = cli_selection.get("cli")
        for role in ("baseline", "proposed"):
            native = {
                "attempted": False,
                "passed": None,
                "cli": cli,
                "cli_version": cli_selection.get("version"),
                "model_version": model_version,
                "skipped_reason": None if cli else "No exact SDK-version match was available; native validation was optional.",
            }
            if cli:
                if progress:
                    progress("native", f"Running OpenStudio load + translation + EnergyPlus geometry smoke test for {role.title()}…")
                native = run_native_openstudio_check(cli, ruby_script, outputs[role], label=role)
                native["cli_version"] = cli_selection.get("version")
                native["model_version"] = model_version
                report["reports"][role]["native_openstudio_check"] = native
                (staging / "INTERIM_COMPILATION_REPORT.json").write_text(
                    json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
                )
                if not native.get("passed"):
                    summary = native_failure_summary(native)
                    raise CompileError(
                        f"Native OpenStudio/EnergyPlus integrity pipeline failed for {role.title()}:\n{summary}\n\n"
                        "Benign ForwardTranslator reversed-copy warnings are not treated as failures. "
                        "See the live log and FAILED_COMPILE folder for the complete output."
                    )
                if require_native_check and native.get("energyplus_smoke_passed") is not True:
                    raise CompileError(
                        f"Exact native validation was required, but the EnergyPlus design-day geometry smoke test could not be completed for {role.title()}. "
                        f"Select the openstudio.exe bundled with OpenStudio Application so its matching EnergyPlus executable can be found. "
                        f"Details: {native.get('output','')[-2000:]}"
                    )
            report["reports"][role]["native_openstudio_check"] = native

        report["completed_at"] = datetime.now().isoformat(timespec="seconds")
        report["outputs"] = {role: str(outdir / path.name) for role, path in outputs.items()}
        report["output_directory"] = str(outdir)
        report["success"] = True
        if any(role_config(config, role).get("space_overrides") for role in ("baseline", "proposed")):
            (staging / "MAPPING_OVERRIDES_USED.json").write_text(
                json.dumps({role: role_config(config, role).get("space_overrides", {}) for role in ("baseline", "proposed")}, indent=2),
                encoding="utf-8",
            )
        write_pair_reports(staging, report)

        # Package the exact deliverables from staging before the atomic commit.
        zip_path = staging / "COMPILED_ENERGY_MODELS.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for file in sorted(staging.iterdir()):
                if file.is_file() and file != zip_path:
                    zf.write(file, file.name)

        if progress:
            progress("commit", "Both models passed. Committing outputs atomically…")
        generated_names = [p.name for p in staging.iterdir() if p.is_file()]
        existing = [outdir / name for name in generated_names if (outdir / name).exists()]
        if existing:
            backup = outdir / f"Previous_Compile_{timestamp}"
            backup.mkdir(parents=True, exist_ok=True)
            for old in existing:
                shutil.move(str(old), str(backup / old.name))
            report["previous_outputs_backup"] = str(backup)
        for file in list(staging.iterdir()):
            if file.is_file():
                shutil.move(str(file), str(outdir / file.name))
        # Rewrite reports after commit so final paths and backup are recorded.
        write_pair_reports(outdir, report)
        return report
    except Exception as exc:
        failure_dir = outdir / f"FAILED_COMPILE_{timestamp}"
        failure_dir.mkdir(parents=True, exist_ok=True)
        report["success"] = False
        report["failed_at"] = datetime.now().isoformat(timespec="seconds")
        report["error"] = str(exc)
        report["traceback"] = traceback.format_exc()
        (failure_dir / "FAILURE_REPORT.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        (failure_dir / "FAILURE_SUMMARY.txt").write_text(
            "Compilation stopped safely. No Baseline or Proposed OSM was committed.\n\n" + str(exc),
            encoding="utf-8",
        )
        # Preserve every staged model, native log, translated IDF, smoke-test
        # directory, mapping CSV, and review file. Previous versions discarded
        # the exact error needed to diagnose a failure.
        if staging.exists():
            shutil.copytree(staging, failure_dir, dirs_exist_ok=True)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)

def _app_settings_path() -> Path:
    base = Path(os.environ.get("APPDATA", str(Path.home())))
    return base / "OpenStudioGeometryCompiler" / "settings.json"


def _open_path(path: Path) -> None:
    path = Path(path)
    if os.name == "nt":
        os.startfile(str(path))  # type: ignore[attr-defined]
    else:
        webbrowser.open(path.resolve().as_uri())

def _set_windows_app_user_model_id() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "LIBER.OpenStudioGeometryCompiler"
        )
    except Exception:
        pass


def _apply_geometry_compiler_icon(root: Any) -> None:
    """Apply the packaged icon in source, launcher, and PyInstaller modes."""
    _set_windows_app_user_model_id()
    source_dir = Path(__file__).resolve().parent
    bundle_dir = Path(getattr(sys, "_MEIPASS", source_dir))
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable))
    candidates.extend([
        bundle_dir / "GeometryCompiler.ico",
        source_dir / "GeometryCompiler.ico",
    ])
    for icon_path in candidates:
        if not icon_path.is_file():
            continue
        try:
            root.iconbitmap(default=str(icon_path))
            root.after(0, lambda p=str(icon_path): root.iconbitmap(default=p))
            return
        except Exception:
            continue


class CompilerApp:
    def __init__(self, root: Any) -> None:
        import tkinter as tk
        from tkinter import ttk

        self.tk = tk
        self.ttk = ttk
        self.root = root
        self.root.title(f"OpenStudio Energy Model Geometry Compiler v{COMPILER_VERSION}")
        _apply_geometry_compiler_icon(self.root)
        self.root.geometry("1080x790")
        self.root.minsize(940, 700)
        self.root.configure(bg="#eef4f3")
        try:
            self.root.iconname("OpenStudio Compiler")
        except Exception:
            pass

        self.events: "queue.Queue[tuple]" = queue.Queue()
        self.busy = False
        self.preflight_result: Optional[dict] = None
        self.last_report: Optional[dict] = None
        self.config_data: dict = {
            "global": {
                "use_semantic_fallback": True,
                "use_pretrained_local_ai": True,
                "minimum_match_score": MINIMUM_MAPPING_CONFIDENCE,
                "semantic_profile_confidence": MINIMUM_MAPPING_CONFIDENCE,
            },
            "baseline": {"space_overrides": {}},
            "proposed": {"space_overrides": {}},
        }
        self.settings_path = _app_settings_path()

        self.geometry_var = tk.StringVar()
        self.baseline_var = tk.StringVar()
        self.proposed_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.cli_var = tk.StringVar()
        self.cli_info = tk.StringVar(value="Blank = automatically use only an exact SDK-version match.")
        self.config_file_var = tk.StringVar()
        self.require_native_var = tk.BooleanVar(value=True)
        self.semantic_fallback_var = tk.BooleanVar(value=True)
        self.pretrained_ai_var = tk.BooleanVar(value=True)
        self.geometry_info = tk.StringVar(value="Select the updated OSM. New spaces are retained; the local architectural agent assigns approved template behavior.")
        self.baseline_info = tk.StringVar(value="Select the approved Baseline OSM.")
        self.proposed_info = tk.StringVar(value="Select the approved Proposed OSM.")
        self.overall_status = tk.StringVar(value="Ready")
        self.baseline_status = tk.StringVar(value="Not compiled")
        self.proposed_status = tk.StringVar(value="Not compiled")

        style = ttk.Style()
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure("TFrame", background="#eef4f3")
        style.configure("Card.TFrame", background="#ffffff", relief="flat")
        style.configure("TLabel", background="#eef4f3", foreground="#173b39", font=("Segoe UI", 10))
        style.configure("Card.TLabel", background="#ffffff", foreground="#173b39", font=("Segoe UI", 10))
        style.configure("Title.TLabel", background="#0f625d", foreground="#ffffff", font=("Segoe UI Semibold", 23))
        style.configure("Subtitle.TLabel", background="#0f625d", foreground="#d6fffa", font=("Segoe UI", 10))
        style.configure("Section.TLabel", background="#ffffff", foreground="#0f625d", font=("Segoe UI Semibold", 12))
        style.configure("Info.TLabel", background="#ffffff", foreground="#5b7472", font=("Segoe UI", 9))
        style.configure("Good.TLabel", background="#ffffff", foreground="#087f5b", font=("Segoe UI Semibold", 10))
        style.configure("Bad.TLabel", background="#ffffff", foreground="#c92a2a", font=("Segoe UI Semibold", 10))
        style.configure("Primary.TButton", font=("Segoe UI Semibold", 11), padding=(18, 11), background="#0f766e", foreground="white")
        style.map("Primary.TButton", background=[("active", "#0b5f59"), ("disabled", "#9ab5b2")])
        style.configure("Secondary.TButton", font=("Segoe UI Semibold", 10), padding=(14, 9))
        style.configure("Browse.TButton", font=("Segoe UI", 9), padding=(10, 6))
        style.configure("Status.TLabelframe", background="#ffffff", bordercolor="#cbdedc", relief="solid")
        style.configure("Status.TLabelframe.Label", background="#ffffff", foreground="#0f625d", font=("Segoe UI Semibold", 11))
        style.configure("Treeview", rowheight=27, font=("Segoe UI", 9))
        style.configure("Treeview.Heading", font=("Segoe UI Semibold", 9))

        header = tk.Frame(root, bg="#0f625d", height=94)
        header.pack(fill="x")
        header.pack_propagate(False)
        ttk.Label(header, text="OpenStudio Energy Model Geometry Compiler", style="Title.TLabel").pack(anchor="w", padx=28, pady=(18, 2))
        ttk.Label(header, text="Exact new building geometry + approved Baseline and Proposed model behavior", style="Subtitle.TLabel").pack(anchor="w", padx=30)

        main = ttk.Frame(root, padding=(22, 16, 22, 16))
        main.pack(fill="both", expand=True)
        main.columnconfigure(0, weight=1)
        main.rowconfigure(6, weight=1)

        geom_card = ttk.Frame(main, style="Card.TFrame", padding=16)
        geom_card.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        geom_card.columnconfigure(0, weight=1)
        ttk.Label(geom_card, text="1. NEW GEOMETRY + SPACES", style="Section.TLabel").grid(row=0, column=0, sticky="w", columnspan=2)
        ttk.Entry(geom_card, textvariable=self.geometry_var, font=("Segoe UI", 10)).grid(row=1, column=0, sticky="ew", pady=(8, 4), padx=(0, 10))
        ttk.Button(geom_card, text="Browse Geometry…", style="Browse.TButton", command=lambda: self.browse_model("geometry")).grid(row=1, column=1, sticky="e", pady=(8, 4))
        ttk.Label(geom_card, textvariable=self.geometry_info, style="Info.TLabel").grid(row=2, column=0, columnspan=2, sticky="w")

        templates = ttk.Frame(main)
        templates.grid(row=1, column=0, sticky="ew", pady=(0, 10))
        templates.columnconfigure(0, weight=1)
        templates.columnconfigure(1, weight=1)
        self._template_card(templates, 0, "2A. APPROVED BASELINE TEMPLATE", self.baseline_var, self.baseline_info, "baseline")
        self._template_card(templates, 1, "2B. APPROVED PROPOSED TEMPLATE", self.proposed_var, self.proposed_info, "proposed")

        output_card = ttk.Frame(main, style="Card.TFrame", padding=16)
        output_card.grid(row=2, column=0, sticky="ew", pady=(0, 10))
        output_card.columnconfigure(0, weight=1)
        ttk.Label(output_card, text="3. OUTPUT FOLDER", style="Section.TLabel").grid(row=0, column=0, sticky="w", columnspan=2)
        ttk.Entry(output_card, textvariable=self.output_var, font=("Segoe UI", 10)).grid(row=1, column=0, sticky="ew", pady=(8, 4), padx=(0, 10))
        ttk.Button(output_card, text="Browse Output…", style="Browse.TButton", command=self.browse_output).grid(row=1, column=1, sticky="e", pady=(8, 4))
        ttk.Label(output_card, text="Outputs are committed only after BOTH models pass static checks and the native translation/geometry pipeline.", style="Info.TLabel").grid(row=2, column=0, columnspan=2, sticky="w")

        controls = ttk.Frame(main)
        controls.grid(row=3, column=0, sticky="ew", pady=(0, 10))
        controls.columnconfigure(0, weight=1)
        self.advanced_button = ttk.Button(controls, text="Advanced Options ▸", command=self.toggle_advanced)
        self.advanced_button.grid(row=0, column=0, sticky="w")
        self.review_button = ttk.Button(controls, text="Review Space Mappings", style="Secondary.TButton", command=self.show_mapping_review, state="disabled")
        self.review_button.grid(row=0, column=1, padx=(8, 8))
        self.preflight_button = ttk.Button(controls, text="Run Preflight", style="Secondary.TButton", command=self.start_preflight)
        self.preflight_button.grid(row=0, column=2, padx=(0, 8))
        self.compile_button = ttk.Button(controls, text="COMPILE BASELINE + PROPOSED", style="Primary.TButton", command=self.start_compile)
        self.compile_button.grid(row=0, column=3)

        self.advanced = ttk.Frame(main, style="Card.TFrame", padding=14)
        self.advanced.columnconfigure(1, weight=1)
        ttk.Label(self.advanced, text="OpenStudio CLI (native load validation)", style="Card.TLabel").grid(row=0, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(self.advanced, textvariable=self.cli_var).grid(row=0, column=1, sticky="ew", padx=(0, 8))
        ttk.Button(self.advanced, text="Browse…", command=self.browse_cli).grid(row=0, column=2, padx=(0, 6))
        ttk.Button(self.advanced, text="Auto-Match", command=self.auto_match_cli).grid(row=0, column=3)
        ttk.Label(self.advanced, textvariable=self.cli_info, style="Info.TLabel").grid(row=1, column=1, columnspan=3, sticky="w", pady=(4, 0))
        ttk.Checkbutton(self.advanced, text="Require full OpenStudio translation + EnergyPlus geometry smoke test", variable=self.require_native_var).grid(row=2, column=1, sticky="w", pady=(8, 0))
        ttk.Checkbutton(
            self.advanced,
            text="Use local architectural space-name agent (recommended)",
            variable=self.semantic_fallback_var,
        ).grid(row=3, column=1, columnspan=3, sticky="w", pady=(8, 0))
        ttk.Checkbutton(
            self.advanced,
            text="Use bundled pretrained MiniLM + adjacency/geometry context (GPU when available)",
            variable=self.pretrained_ai_var,
        ).grid(row=4, column=1, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(self.advanced, text="Minimum automatic confidence", style="Card.TLabel").grid(row=5, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Label(self.advanced, text="75% hard floor", style="Card.TLabel").grid(row=5, column=1, sticky="w", pady=(8, 0))
        ttk.Label(self.advanced, text="Optional mapping/config JSON", style="Card.TLabel").grid(row=6, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ttk.Entry(self.advanced, textvariable=self.config_file_var).grid(row=6, column=1, sticky="ew", padx=(0, 8), pady=(8, 0))
        ttk.Button(self.advanced, text="Browse…", command=self.browse_config).grid(row=6, column=2, pady=(8, 0))

        status_frame = ttk.LabelFrame(main, text="Compilation Status", style="Status.TLabelframe", padding=12)
        status_frame.grid(row=5, column=0, sticky="ew", pady=(0, 10))
        status_frame.columnconfigure(1, weight=1)
        ttk.Label(status_frame, text="Overall", style="Card.TLabel").grid(row=0, column=0, sticky="w", padx=(0, 15))
        ttk.Label(status_frame, textvariable=self.overall_status, style="Good.TLabel").grid(row=0, column=1, sticky="w")
        ttk.Label(status_frame, text="Baseline", style="Card.TLabel").grid(row=1, column=0, sticky="w", padx=(0, 15), pady=(4, 0))
        ttk.Label(status_frame, textvariable=self.baseline_status, style="Card.TLabel").grid(row=1, column=1, sticky="w", pady=(4, 0))
        ttk.Label(status_frame, text="Proposed", style="Card.TLabel").grid(row=2, column=0, sticky="w", padx=(0, 15), pady=(4, 0))
        ttk.Label(status_frame, textvariable=self.proposed_status, style="Card.TLabel").grid(row=2, column=1, sticky="w", pady=(4, 0))
        self.progress = ttk.Progressbar(status_frame, mode="indeterminate")
        self.progress.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(10, 0))

        log_card = ttk.Frame(main, style="Card.TFrame", padding=12)
        log_card.grid(row=6, column=0, sticky="nsew")
        log_card.rowconfigure(1, weight=1)
        log_card.columnconfigure(0, weight=1)
        ttk.Label(log_card, text="LIVE SAFETY LOG", style="Section.TLabel").grid(row=0, column=0, sticky="w", pady=(0, 6))
        self.log_text = tk.Text(log_card, height=9, wrap="word", bg="#f8fbfb", fg="#173b39", relief="flat", font=("Consolas", 9), padx=10, pady=8)
        self.log_text.grid(row=1, column=0, sticky="nsew")
        scroll = ttk.Scrollbar(log_card, orient="vertical", command=self.log_text.yview)
        scroll.grid(row=1, column=1, sticky="ns")
        self.log_text.configure(yscrollcommand=scroll.set, state="disabled")

        footer = ttk.Frame(main)
        footer.grid(row=7, column=0, sticky="ew", pady=(10, 0))
        footer.columnconfigure(0, weight=1)
        self.open_output_button = ttk.Button(footer, text="Open Output Folder", command=self.open_output, state="disabled")
        self.open_output_button.grid(row=0, column=1, padx=(8, 0))
        self.open_audit_button = ttk.Button(footer, text="Open Audit Report", command=self.open_audit, state="disabled")
        self.open_audit_button.grid(row=0, column=2, padx=(8, 0))

        self.load_settings()
        self.root.after(100, self.poll_events)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.log("Ready. Select the new geometry, approved Baseline, and approved Proposed OSM files.")

    def _template_card(self, parent: Any, column: int, title: str, variable: Any, info_variable: Any, role: str) -> None:
        card = self.ttk.Frame(parent, style="Card.TFrame", padding=16)
        card.grid(row=0, column=column, sticky="nsew", padx=((0, 5) if column == 0 else (5, 0)))
        card.columnconfigure(0, weight=1)
        self.ttk.Label(card, text=title, style="Section.TLabel").grid(row=0, column=0, sticky="w", columnspan=2)
        self.ttk.Entry(card, textvariable=variable, font=("Segoe UI", 9)).grid(row=1, column=0, sticky="ew", pady=(8, 4), padx=(0, 8))
        self.ttk.Button(card, text="Browse…", style="Browse.TButton", command=lambda: self.browse_model(role)).grid(row=1, column=1, pady=(8, 4))
        self.ttk.Label(card, textvariable=info_variable, style="Info.TLabel", wraplength=430, justify="left").grid(row=2, column=0, columnspan=2, sticky="w")

    def log(self, message: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{stamp}] {message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def load_settings(self) -> None:
        try:
            data = json.loads(self.settings_path.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        self.geometry_var.set(data.get("geometry", ""))
        self.baseline_var.set(data.get("baseline", ""))
        self.proposed_var.set(data.get("proposed", ""))
        self.output_var.set(data.get("output", ""))
        self.cli_var.set(data.get("openstudio_cli", ""))
        for role in ("geometry", "baseline", "proposed"):
            value = getattr(self, f"{role}_var").get()
            if value and Path(value).is_file():
                self.inspect_model(role, Path(value))
        if self.cli_var.get():
            try:
                info = query_openstudio_cli_version(self.cli_var.get())
                versions = []
                for role in ("geometry", "baseline", "proposed"):
                    value = getattr(self, f"{role}_var").get().strip()
                    if value and Path(value).is_file():
                        versions.append(model_openstudio_version(parse_osm(Path(value))))
                target = versions[0] if versions and len(set(versions)) == 1 else None
                if target and info.get("version") != target:
                    old_version = info.get("version", "unknown")
                    self.cli_var.set("")
                    self.cli_info.set(f"Ignored saved CLI SDK {old_version}; models are {target}. Auto-match will use only {target}.")
                else:
                    self.inspect_cli(self.cli_var.get())
            except Exception:
                self.cli_var.set("")
                self.cli_info.set("Ignored an unreadable saved CLI path. Blank = exact-version auto-match.")

    def save_settings(self) -> None:
        try:
            self.settings_path.parent.mkdir(parents=True, exist_ok=True)
            self.settings_path.write_text(json.dumps({
                "geometry": self.geometry_var.get(), "baseline": self.baseline_var.get(), "proposed": self.proposed_var.get(),
                "output": self.output_var.get(), "openstudio_cli": self.cli_var.get(),
            }, indent=2), encoding="utf-8")
        except Exception:
            pass

    def on_close(self) -> None:
        self.save_settings()
        self.root.destroy()

    def browse_model(self, role: str) -> None:
        from tkinter import filedialog
        current = getattr(self, f"{role}_var").get()
        path = filedialog.askopenfilename(title=f"Select {role.title()} OSM", initialdir=str(Path(current).parent) if current else None, filetypes=[("OpenStudio Model", "*.osm"), ("All files", "*.*")])
        if not path:
            return
        getattr(self, f"{role}_var").set(path)
        self.inspect_model(role, Path(path))
        if self.cli_var.get().strip():
            self.inspect_cli(self.cli_var.get().strip())
        self.preflight_result = None
        self.review_button.configure(state="disabled")
        if role == "geometry" and not self.output_var.get():
            self.output_var.set(str(Path(path).parent / "Compiled Energy Models"))
        self.save_settings()

    def inspect_model(self, role: str, path: Path) -> None:
        info_var = getattr(self, f"{role}_info")
        try:
            model = parse_osm(path)
            s = model_summary(model)
            version = model_openstudio_version(model)
            if role == "geometry":
                errors = validate_geometry(model, include_energyplus_limits=False)
                repairable = sum(1 for sub in model.by_type.get("OS:SubSurface", []) if len(vertices(sub)) > 4)
                if errors:
                    suffix = f"{len(errors)} geometry issue(s)"
                elif repairable:
                    suffix = f"geometry clean · {repairable} lossless EnergyPlus opening repair(s) queued"
                else:
                    suffix = "geometry clean · EnergyPlus-compatible"
                text = f"OpenStudio {version} · {s['spaces']:,} spaces · {s['surfaces']:,} surfaces · {s['subsurfaces']:,} openings · {suffix}"
            else:
                text = f"OpenStudio {version} · {s['spaces']:,} spaces · {s['thermal_zones']:,} zones · {s['schedules']:,} schedules · {s['hvac_plant']:,} HVAC/plant objects"
            info_var.set(text)
        except Exception as exc:
            info_var.set(f"Cannot read this OSM: {exc}")

    def browse_output(self) -> None:
        from tkinter import filedialog
        path = filedialog.askdirectory(title="Choose compiled-model output folder", initialdir=self.output_var.get() or None)
        if path:
            self.output_var.set(path)
            self.save_settings()

    def browse_cli(self) -> None:
        from tkinter import filedialog
        path = filedialog.askopenfilename(title="Select openstudio.exe", filetypes=[("OpenStudio CLI", "openstudio.exe"), ("Executable", "*.exe"), ("All files", "*.*")])
        if path:
            self.cli_var.set(path)
            self.inspect_cli(path)
            self.save_settings()

    def inspect_cli(self, path: str) -> None:
        try:
            info = query_openstudio_cli_version(path)
            model_versions = []
            for role in ("geometry", "baseline", "proposed"):
                value = getattr(self, f"{role}_var").get().strip()
                if value and Path(value).is_file():
                    model_versions.append(model_openstudio_version(parse_osm(Path(value))))
            target = model_versions[0] if model_versions and len(set(model_versions)) == 1 else None
            if info.get("ok"):
                if target and info.get("version") != target:
                    self.cli_info.set(f"MISMATCH: selected CLI SDK {info.get('version')} · models {target}. This CLI will not be used.")
                elif target:
                    self.cli_info.set(f"MATCHED: selected CLI SDK {info.get('version')} · models {target}.")
                else:
                    self.cli_info.set(f"Selected OpenStudio CLI SDK {info.get('version')}.")
            else:
                self.cli_info.set("Could not determine the SDK version of this executable.")
        except Exception as exc:
            self.cli_info.set(f"Could not inspect CLI: {exc}")

    def auto_match_cli(self) -> None:
        try:
            versions = []
            for role in ("geometry", "baseline", "proposed"):
                value = getattr(self, f"{role}_var").get().strip()
                if value and Path(value).is_file():
                    versions.append(model_openstudio_version(parse_osm(Path(value))))
            if not versions or len(set(versions)) != 1:
                self.cli_var.set("")
                self.cli_info.set("Select all three same-version OSM files first; blank still enables exact-version auto-match during compilation.")
                return
            target = versions[0]
            selection = select_openstudio_cli(target, explicit=None, require=False)
            if selection.get("cli"):
                self.cli_var.set(selection["cli"])
                self.cli_info.set(f"AUTO-MATCHED: OpenStudio SDK {selection.get('version')} · models {target}.")
            else:
                self.cli_var.set("")
                found = "; ".join(f"{x.get('version','unknown')} at {x.get('path','')}" for x in selection.get("candidates", [])) or "none"
                self.cli_info.set(f"No exact SDK {target} CLI found. Mismatched installations are ignored ({found}).")
            self.save_settings()
        except Exception as exc:
            self.cli_info.set(f"Auto-match failed: {exc}")

    def browse_config(self) -> None:
        from tkinter import filedialog
        path = filedialog.askopenfilename(title="Select optional compiler mapping JSON", filetypes=[("JSON", "*.json"), ("All files", "*.*")])
        if path:
            self.config_file_var.set(path)
            try:
                loaded = load_config(Path(path))
                self.config_data = loaded
                loaded_global = loaded.get("global", loaded) if isinstance(loaded, dict) else {}
                self.semantic_fallback_var.set(bool(loaded_global.get("use_semantic_fallback", True)))
                self.pretrained_ai_var.set(bool(loaded_global.get("use_pretrained_local_ai", True)))
                self.log(f"Loaded advanced configuration: {path}")
            except Exception as exc:
                self.log(f"Configuration could not be loaded: {exc}")

    def toggle_advanced(self) -> None:
        if self.advanced.winfo_ismapped():
            self.advanced.grid_remove()
            self.advanced_button.configure(text="Advanced Options ▸")
        else:
            self.advanced.grid(row=4, column=0, sticky="ew", pady=(0, 10))
            self.advanced_button.configure(text="Advanced Options ▾")

    def _paths(self) -> Tuple[Path, Path, Path, Path]:
        values = [self.geometry_var.get().strip(), self.baseline_var.get().strip(), self.proposed_var.get().strip(), self.output_var.get().strip()]
        labels = ["New Geometry", "Approved Baseline", "Approved Proposed", "Output Folder"]
        missing = [label for label, value in zip(labels, values) if not value]
        if missing:
            raise CompileError("Select: " + ", ".join(missing))
        return tuple(Path(v) for v in values)  # type: ignore[return-value]

    def _effective_config(self) -> dict:
        config = copy.deepcopy(self.config_data)
        file_path = self.config_file_var.get().strip()
        if file_path:
            loaded = load_config(Path(file_path))
            # File config is base; in-app mapping overrides take precedence.
            for role in ("baseline", "proposed"):
                base = loaded.setdefault(role, {}).setdefault("space_overrides", {})
                base.update(config.get(role, {}).get("space_overrides", {}))
            config = loaded
        config.setdefault("global", {})["use_semantic_fallback"] = bool(self.semantic_fallback_var.get())
        config["global"]["use_pretrained_local_ai"] = bool(self.pretrained_ai_var.get())
        config["global"].setdefault("use_name_hints", False)
        config["global"]["minimum_match_score"] = max(
            MINIMUM_MAPPING_CONFIDENCE,
            float(config["global"].get("minimum_match_score", MINIMUM_MAPPING_CONFIDENCE)),
        )
        config["global"]["semantic_profile_confidence"] = max(
            MINIMUM_MAPPING_CONFIDENCE,
            float(config["global"].get("semantic_profile_confidence", MINIMUM_MAPPING_CONFIDENCE)),
        )
        return config

    def set_busy(self, busy: bool, message: str = "") -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.preflight_button.configure(state=state)
        self.compile_button.configure(state=state)
        if busy:
            self.progress.start(12)
        else:
            self.progress.stop()
        if message:
            self.overall_status.set(message)

    def start_preflight(self) -> None:
        if self.busy:
            return
        try:
            geometry, baseline, proposed, _out = self._paths()
            config = self._effective_config()
        except Exception as exc:
            self.show_error("Cannot start preflight", exc)
            return
        self.set_busy(True, "Running preflight…")
        self.log("Preflight started: parsing geometry and both approved templates.")

        def worker() -> None:
            try:
                result = preflight_pair(geometry, baseline, proposed, config)
                self.events.put(("preflight_done", result))
            except Exception as exc:
                self.events.put(("task_error", "Preflight stopped", exc, traceback.format_exc()))
        threading.Thread(target=worker, daemon=True).start()

    def start_compile(self) -> None:
        if self.busy:
            return
        try:
            geometry, baseline, proposed, outdir = self._paths()
            config = self._effective_config()
        except Exception as exc:
            self.show_error("Cannot start compilation", exc)
            return
        cli_value = self.cli_var.get().strip() or None
        require_native = bool(self.require_native_var.get())
        self.set_busy(True, "Compiling safely…")
        self.baseline_status.set("Waiting")
        self.proposed_status.set("Waiting")
        self.log("Atomic pair compilation started. No model will be committed unless both pass.")

        def progress(phase: str, message: str) -> None:
            self.events.put(("progress", phase, message))

        def worker() -> None:
            try:
                result = compile_baseline_proposed_pair(
                    geometry, baseline, proposed, outdir, config,
                    openstudio_cli=cli_value,
                    require_native_check=require_native,
                    progress=progress,
                )
                self.events.put(("compile_done", result))
            except Exception as exc:
                self.events.put(("task_error", "Compilation stopped safely", exc, traceback.format_exc()))
        threading.Thread(target=worker, daemon=True).start()

    def poll_events(self) -> None:
        try:
            while True:
                event = self.events.get_nowait()
                kind = event[0]
                if kind == "progress":
                    _k, phase, message = event
                    self.overall_status.set(message)
                    self.log(message)
                    if phase == "baseline":
                        self.baseline_status.set("Compiling and validating…")
                    elif phase == "proposed":
                        self.baseline_status.set("Passed")
                        self.proposed_status.set("Compiling and validating…")
                elif kind == "preflight_done":
                    result = event[1]
                    self.preflight_result = result
                    b = result["mapping"]["baseline"]
                    p = result["mapping"]["proposed"]
                    total_amb = b["ambiguous_count"] + p["ambiguous_count"]
                    self.set_busy(False, "Preflight passed" if not total_amb else "Mapping review required")
                    self.baseline_status.set(f"Preflight: {b['count']} mapped · {b['ambiguous_count']} ambiguous")
                    self.proposed_status.set(f"Preflight: {p['count']} mapped · {p['ambiguous_count']} ambiguous")
                    self.review_button.configure(state="normal")
                    self.log(f"Preflight complete: Baseline {b['count']} spaces, Proposed {p['count']} spaces, {total_amb} ambiguous.")
                    self.log(f"Baseline behavior profiles: {b.get('behavior_profile_distribution', {})}")
                    self.log(f"Proposed behavior profiles: {p.get('behavior_profile_distribution', {})}")
                    provider = next(
                        (
                            row.get("local_ai_provider")
                            for role in ("baseline", "proposed")
                            for row in result["mapping"][role].get("rows", [])
                            if row.get("local_ai_provider")
                        ),
                        None,
                    )
                    if provider:
                        self.log(f"Local pretrained AI active via {provider}.")
                    if not total_amb:
                        from tkinter import messagebox
                        messagebox.showinfo(
                            "Preflight Passed",
                            "Both templates are compatible with the selected geometry.\n\n"
                            "Every space assignment is at least 75% confidence. "
                            "Review Space Mappings remains available for audit or bulk acceptance.",
                        )
                elif kind == "compile_done":
                    report = event[1]
                    self.last_report = report
                    self.set_busy(False, "COMPLETE — both models passed")
                    self.baseline_status.set("PASS — translated + EnergyPlus geometry-safe")
                    self.proposed_status.set("PASS — translated + EnergyPlus geometry-safe")
                    self.open_output_button.configure(state="normal")
                    self.open_audit_button.configure(state="normal")
                    self.log("SUCCESS: Baseline and Proposed were committed to the output folder.")
                    self.log("Deliverables: BASELINE_UPDATED_GEOMETRY.osm, PROPOSED_UPDATED_GEOMETRY.osm, audit reports, mappings, and ZIP bundle.")
                    self.save_settings()
                    from tkinter import messagebox
                    messagebox.showinfo("Compilation Complete", "Both models passed all compiler safety checks.\n\nBaseline and Proposed outputs are ready in the selected folder.")
                elif kind == "task_error":
                    _k, title, exc, tb = event
                    self.set_busy(False, "Stopped safely — no invalid pair committed")
                    self.baseline_status.set("Not committed")
                    self.proposed_status.set("Not committed")
                    self.log(f"STOPPED SAFELY: {exc}")
                    self.log(tb)
                    self.show_error(title, exc)
        except queue.Empty:
            pass
        self.root.after(100, self.poll_events)

    def show_error(self, title: str, exc: Exception) -> None:
        from tkinter import messagebox
        message = str(exc)
        if len(message) > 850:
            message = message[:850] + "…\n\nSee the live log and FAILED_COMPILE folder for full details."
        messagebox.showerror(title, message)

    def show_mapping_review(self) -> None:
        from tkinter import messagebox
        if not self.preflight_result:
            messagebox.showinfo("No preflight", "Run Preflight first.")
            return
        ambiguous: List[Tuple[str, dict]] = []
        all_rows: List[Tuple[str, dict]] = []
        for role in ("baseline", "proposed"):
            for row in self.preflight_result["mapping"][role]["rows"]:
                all_rows.append((role, row))
            for row in self.preflight_result["mapping"][role]["ambiguous"]:
                ambiguous.append((role, row))
        visible_rows = ambiguous or all_rows
        showing_ambiguous = bool(ambiguous)
        win = self.tk.Toplevel(self.root)
        win.title("Review Space-to-Template Behavior Assignments")
        win.geometry("1240x650")
        win.transient(self.root)
        frame = self.ttk.Frame(win, padding=14)
        frame.pack(fill="both", expand=True)
        message = (
            "Only assignments below the 75% floor are shown. Choose them individually; "
            "bulk acceptance never includes a sub-75% row."
            if showing_ambiguous else
            "All assignments meet the 75% floor. The output retains every NEW geometry space; "
            "the template space shown is only a behavior source."
        )
        self.ttk.Label(frame, text=message, style="TLabel", wraplength=1160, justify="left").pack(anchor="w", pady=(0, 8))
        tree = self.ttk.Treeview(
            frame,
            columns=("role", "new", "use", "suggested", "profile", "score", "status"),
            show="headings",
        )
        for col, text, width in (
            ("role", "Model", 80),
            ("new", "New Model Space", 215),
            ("use", "Local Agent Use", 155),
            ("suggested", "Template Behavior Source", 215),
            ("profile", "Assigned Logic", 190),
            ("score", "Confidence", 90),
            ("status", "Acceptance", 150),
        ):
            tree.heading(col, text=text)
            tree.column(col, width=width, anchor="w")
        tree.pack(fill="both", expand=True)
        rows_by_item: Dict[str, Tuple[str, dict]] = {}

        def confidence_text(row: dict) -> str:
            return f"{100.0 * float(row.get('score', 0.0)):.1f}%"

        def profile_text(row: dict) -> str:
            value = str(row.get("profile", {}).get("thermal_zone", "") or "Anonymous template profile")
            return value.rsplit(":", 1)[-1]

        def has_override(role: str, row: dict) -> bool:
            return row.get("new_handle") in self.config_data.get(role, {}).get("space_overrides", {})

        for role, row in visible_rows:
            eligible = bool(row.get("suggestion_eligible")) and float(row.get("score", 0.0)) >= MINIMUM_MAPPING_CONFIDENCE
            suggested = row.get("old_space") if eligible else "No safe ≥75% suggestion"
            status = "Override set" if has_override(role, row) else ("Suggested" if eligible else "Needs manual review")
            item = tree.insert(
                "",
                "end",
                values=(
                    role.title(),
                    row.get("new_space"),
                    str(row.get("architectural_use") or "context ensemble").replace("_", " "),
                    suggested,
                    profile_text(row),
                    confidence_text(row),
                    status,
                ),
            )
            rows_by_item[item] = (role, row)

        def choose(_event: Any = None) -> None:
            selected = tree.selection()
            if not selected:
                return
            item = selected[0]
            role, row = rows_by_item[item]
            candidates = row.get("top_candidates", [])
            if not candidates and row.get("old_handle"):
                candidates = [{
                    "old_space": row.get("old_space"),
                    "old_handle": row.get("old_handle"),
                    "score": row.get("score"),
                    "profile": row.get("profile", {}),
                }]
            dialog = self.tk.Toplevel(win)
            dialog.title(f"Choose behavior source for {row.get('new_space')}")
            dialog.geometry("720x430")
            dialog.transient(win)
            body = self.ttk.Frame(dialog, padding=12)
            body.pack(fill="both", expand=True)
            self.ttk.Label(
                body,
                text=f"{role.title()} · New model space: {row.get('new_space')}",
                style="Section.TLabel",
            ).pack(anchor="w", pady=(0, 4))
            self.ttk.Label(
                body,
                text="Only behavior is copied. The selected old space never replaces the new model space.",
                style="TLabel",
            ).pack(anchor="w", pady=(0, 8))
            lb = self.tk.Listbox(body, font=("Segoe UI", 10))
            lb.pack(fill="both", expand=True)
            for candidate in candidates:
                profile = candidate.get("profile", {})
                zone = str(profile.get("thermal_zone", "")).rsplit(":", 1)[-1]
                lb.insert(
                    "end",
                    f"{candidate.get('old_space')}   | geometric compatibility "
                    f"{100.0 * float(candidate.get('score', 0.0)):.1f}%   | {zone}",
                )
            if candidates:
                lb.selection_set(0)

            def apply_choice() -> None:
                idxs = lb.curselection()
                if not idxs:
                    return
                candidate = candidates[idxs[0]]
                self.config_data.setdefault(role, {}).setdefault("space_overrides", {})[row["new_handle"]] = {"match_old": candidate["old_handle"]}
                values = list(tree.item(item, "values"))
                values[3] = candidate["old_space"]
                values[4] = str(candidate.get("profile", {}).get("thermal_zone", "")).rsplit(":", 1)[-1]
                values[6] = "Override set"
                tree.item(item, values=values)
                dialog.destroy()
            self.ttk.Button(body, text="Use Selected Behavior Source", style="Primary.TButton", command=apply_choice).pack(anchor="e", pady=(10, 0))

        eligible_items = [
            item
            for item, (_role, row) in rows_by_item.items()
            if bool(row.get("suggestion_eligible"))
            and float(row.get("score", 0.0)) >= MINIMUM_MAPPING_CONFIDENCE
            and row.get("old_handle")
        ]

        def use_all_suggested() -> None:
            applied = 0
            for item in eligible_items:
                role, row = rows_by_item[item]
                self.config_data.setdefault(role, {}).setdefault("space_overrides", {})[
                    row["new_handle"]
                ] = {"match_old": row["old_handle"]}
                values = list(tree.item(item, "values"))
                values[6] = "Override set"
                tree.item(item, values=values)
                applied += 1
            bulk_button.configure(state="disabled", text=f"Used All Suggested ({applied})")
            self.log(f"Saved {applied} high-confidence mapping suggestions as explicit overrides.")

        tree.bind("<Double-1>", choose)
        buttons = self.ttk.Frame(frame)
        buttons.pack(fill="x", pady=(10, 0))
        self.ttk.Button(buttons, text="Choose Selected…", command=choose).pack(side="left")
        bulk_button = self.ttk.Button(
            buttons,
            text=f"USE ALL SUGGESTED ({len(eligible_items)})",
            style="Secondary.TButton",
            command=use_all_suggested,
            state="normal" if eligible_items else "disabled",
        )
        bulk_button.pack(side="left", padx=(8, 0))
        self.ttk.Button(buttons, text="Save Overrides and Re-run Preflight", style="Primary.TButton", command=lambda: (win.destroy(), self.start_preflight())).pack(side="right")

    def open_output(self) -> None:
        path = Path(self.output_var.get())
        if path.exists():
            _open_path(path)

    def open_audit(self) -> None:
        path = Path(self.output_var.get()) / "COMPILATION_AUDIT.html"
        if path.exists():
            _open_path(path)


def run_gui() -> int:
    import tkinter as tk
    root = tk.Tk()
    CompilerApp(root)
    root.mainloop()
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Fail-safe OpenStudio Baseline + Proposed geometry compiler")
    p.add_argument("--geometry", type=Path, help="New geometry + spaces OSM")
    p.add_argument("--baseline", type=Path, help="Approved Baseline OSM")
    p.add_argument("--proposed", type=Path, help="Approved Proposed OSM")
    p.add_argument("--template", type=Path, action="append", dest="templates", help="Legacy generic template mode")
    p.add_argument("--outdir", type=Path, default=Path("Compiled Energy Models"))
    p.add_argument("--config", type=Path)
    p.add_argument("--openstudio-cli", type=str)
    p.add_argument("--require-native-check", action="store_true")
    p.add_argument("--non-strict", action="store_true", help="Legacy generic mode only; not recommended")
    p.add_argument("--gui", action="store_true")
    args = p.parse_args(argv)
    if args.gui or not args.geometry:
        return run_gui()
    try:
        if args.baseline and args.proposed:
            config = load_config(args.config) if args.config else {}
            report = compile_baseline_proposed_pair(
                args.geometry, args.baseline, args.proposed, args.outdir, config,
                openstudio_cli=args.openstudio_cli, require_native_check=args.require_native_check,
                progress=lambda phase, message: print(f"[{phase}] {message}"),
            )
            print(report["outputs"]["baseline"])
            print(report["outputs"]["proposed"])
            print(Path(args.outdir) / "COMPILATION_AUDIT.json")
            return 0
        if args.templates:
            outputs, report = compile_many(args.templates, args.geometry, args.outdir, args.config, not args.non_strict)
            for output in outputs:
                print(output)
            print(report)
            return 0
        raise CompileError("Provide both --baseline and --proposed, or use --gui.")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__=="__main__":
    raise SystemExit(main())
