#!/usr/bin/env python3
"""One-shot source synchronizer for REVEX r125 gbXML geometry touch-ups.

The Dynamo graph embeds the exact Python exporter. This script inserts the r125
model-agnostic overrides immediately before execution, then writes the same source
back into the graph's Python node so GbxmlEngineeringService's byte-for-byte engine
identity check remains valid.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PY = ROOT / "src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py"
DYN = ROOT / "src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn"
MARKER = "# REVEX_R125_GEOMETRY_TOUCHUPS_BEGIN"
EXECUTION_MARKER = "\nif not RUN_NOW:\n"

BLOCK = r'''
# REVEX_R125_GEOMETRY_TOUCHUPS_BEGIN
# Final model-agnostic geometry reliability layer. Revit physical geometry remains
# authoritative; this only changes how a physical opening/panel is mapped across
# Revit/EADM/gbXML partition differences.
ENGINE_PATCH = str(ENGINE_PATCH) + "-R125-panel-location-full-door-top-envelope"
# A real Revit cover, not an arbitrary 30 ft search ceiling, defines the top of the
# uppermost generated Space. _r10_nearest_cover_z still chooses the nearest XY-overlapping
# physical roof/floor/ceiling, so removing this cap cannot jump through an intervening cover.
TOP_COVER_SEARCH_MAX_FT = float("inf")

_r125_base_classify_curtain_panel = classify_curtain_panel
_r125_base_element_opening_polyloop = element_opening_polyloop
_r125_base_capture_physical_envelope = capture_physical_envelope
_r125_base_physical_parent_candidates = _u_physical_parent_candidates


def classify_curtain_panel(source_doc, element):
    """Door stays Door; explicit opaque/empty stays opaque/empty; all other curtain panels are windows.

    Curtain-panel material metadata is often incomplete for System Panels. A non-door
    CurtainWallPanel is therefore treated as fenestration unless its type/name explicitly
    proves an opaque/spandrel panel. This preserves generic glazed panels without turning
    explicit metal/spandrel panels into windows.
    """
    role, opening_type, evidence = _r125_base_classify_curtain_panel(source_doc, element)
    if role in ("door", "glazing", "empty"):
        return role, opening_type, evidence
    descriptor = element_descriptor(source_doc, element)
    text = normalize_text(descriptor)
    explicit_opaque = any(token in text for token in (
        "spandrel", "opaque", "solid panel", "insulated panel",
        "metal panel", "stone panel", "precast panel", "shadow box",
    ))
    if explicit_opaque:
        return "opaque", None, "r125:explicit-name/type:opaque"
    try:
        curtain_panel_category = category_matches(element, BuiltInCategory.OST_CurtainWallPanels)
    except Exception:
        curtain_panel_category = False
    if curtain_panel_category:
        return "glazing", "FixedWindow", "r125:curtain-panel-nondoor-nonopaque"
    return role, opening_type, evidence


def element_opening_polyloop(element, transform, wall_points, bbox_points):
    """Preserve the whole physical door opening; keep face geometry for windows/panels.

    Complex glass-door families frequently contain a moving leaf plus fixed sidelites/transom.
    Selecting one largest face can shrink that assembly. The Revit instance bounding prism,
    projected to the proven host plane and later clipped by exact analytical carriers, is a
    safer whole-opening record for Doors.
    """
    face_points, method = _r125_base_element_opening_polyloop(
        element, transform, wall_points, bbox_points
    )
    is_door = False
    try:
        is_door = category_matches(element, BuiltInCategory.OST_Doors)
    except Exception:
        pass
    if not is_door:
        try:
            is_door = "door" in normalize_text(element_descriptor(doc, element))
        except Exception:
            is_door = False
    if is_door:
        bbox = bbox_opening_polyloop(bbox_points, wall_points)
        if len(bbox) >= 3 and 0.5 * norm(newell(bbox)) > 1.0e-8:
            return bbox, "bbox-whole-door-r125"
    return face_points, method


def _r125_opening_surface_intersection(opening_points, surface_points, plane_tol_ft=0.50):
    if len(opening_points or []) < 3 or len(surface_points or []) < 3:
        return False
    basis = wall_basis(surface_points)
    if basis is None:
        return False
    origin, _u, _v, normal = basis
    opening_normal = unit_vector(newell(opening_points))
    if opening_normal is None:
        return False
    if abs(sum(opening_normal[i] * normal[i] for i in range(3))) < 0.95:
        return False
    max_plane = max(
        abs(sum((point[i] - origin[i]) * normal[i] for i in range(3)))
        for point in opening_points
    )
    if max_plane > plane_tol_ft:
        return False
    return opening_overlap_ratio(opening_points, surface_points, surface_points) > 1.0e-5


def capture_physical_envelope(model_doc, spaces, messages):
    """Allow one physical curtain wall to own panels across many story-split carriers."""
    base = _r125_base_capture_physical_envelope(model_doc, spaces, messages)
    walls_by_source = {}
    for surface in list(base.get("surfaces", []) or []):
        if normalize_text(surface.get("surface_role") or "wall") != "wall":
            continue
        walls_by_source.setdefault(str(surface.get("source_key") or ""), []).append(surface)

    recovered = 0
    for record in list(base.get("openings", []) or []):
        if not bool(record.get("curtain_panel")):
            continue
        points = record_polyloop(record)
        if len(points) < 3:
            continue
        source_key = str(record.get("parent_source_key") or "")
        supports = []
        for carrier in walls_by_source.get(source_key, []):
            carrier_points = record_polyloop(carrier)
            if _r125_opening_surface_intersection(points, carrier_points):
                supports.append(carrier)
        if not supports:
            continue
        space_ids = []
        for carrier in supports:
            sid = int(carrier.get("space_revit_id") or -1)
            if sid > 0 and sid not in space_ids:
                space_ids.append(sid)
        # Unlike a normal hosted Window/Door, a curtain panel's physical host may span
        # several floor-separated Space domains. The PANEL geometry is the host proof.
        record["adjacent_revit_space_ids"] = space_ids
        record["host_support_count"] = len(supports)
        record["host_proven"] = True
        record["curtain_story_split_host"] = bool(len(space_ids) > 2 or len(supports) > 2)
        record["parent_physical_surface_key"] = supports[0].get("key") if len(supports) == 1 else ""
        recovered += 1

    counts = base.setdefault("counts", {})
    counts["r125_curtain_panels_geometry_host_proven"] = recovered
    messages.append({
        "severity": "INFO",
        "code": "CURTAIN_PANEL_GEOMETRY_HOST_PROOF_R125",
        "count": recovered,
        "message": (
            "Curtain panels are proven independently by recorded Revit panel geometry. "
            "One physical curtain-wall element may map to multiple floor-split analytical "
            "wall carriers; panel ownership is never limited to two Spaces."
        ),
    })
    return base


def _r125_piece_overlap(a, b, source_points):
    try:
        return opening_overlap_ratio(a, b, source_points)
    except Exception:
        return 0.0


def _r125_curtain_parent_candidates(record, index):
    """Map one recorded curtain panel to closest compatible analytical wall segment(s).

    Candidate walls must be coplanar enough to yield a positive exact clipped piece.
    Space identity and original wall CAD id improve ranking but are not hard gates because
    Revit may split one physical curtain-wall host into story Surfaces with different
    analytical identity. The final full-source-area contract remains mandatory.
    """
    points = record_polyloop(record)
    if len(points) < 3:
        return []
    expected = set(expected_xml_space_ids(record, index))
    host_id = int(record.get("parent_originating_element_id") or -1)
    source_area = 0.5 * norm(newell(points))
    if source_area < _UNIVERSAL_OPENING_MIN_PIECE_FT2:
        return []

    groups = []
    for parent in list(index.get("surfaces", []) or []):
        if "wall" not in normalize_text(parent.get("type") or ""):
            continue
        pieces, metrics = _u_clip_physical_opening_to_parent(record, parent, index)
        if not pieces or not metrics:
            continue
        plane = float(metrics.get("plane_offset_ft") or 0.0)
        if plane > 0.50:
            continue
        adjacent = set(parent.get("adjacent") or [])
        cad_match = host_id > 0 and str(parent.get("cad") or "") == str(host_id)
        space_match = bool(expected and expected.intersection(adjacent))
        # Bounded geometric ranking only. No project/floor/name heuristics.
        score = plane
        if cad_match:
            score -= 1.0
        if space_match:
            score -= 0.25
        groups.append({
            "parent": parent,
            "pieces": pieces,
            "metrics": metrics,
            "score": score,
            "cad_match": cad_match,
            "space_match": space_match,
        })

    groups.sort(key=lambda row: (row["score"], str(row["parent"].get("id") or "")))
    # Limit pathological search while keeping many normal story segments available.
    groups = groups[:24]
    chosen = []
    chosen_pieces = []
    running_area = 0.0
    tolerance = max(_UNIVERSAL_OPENING_MIN_PIECE_FT2 * 2.0, source_area * 0.005)
    for group in groups:
        usable = []
        for piece in group["pieces"]:
            area = 0.5 * norm(newell(piece)) if len(piece or []) >= 3 else 0.0
            if area < _UNIVERSAL_OPENING_MIN_PIECE_FT2:
                continue
            # Competing analytical carriers can geometrically overlap. Keep only the
            # best-ranked representation of a substantially identical panel piece.
            if any(_r125_piece_overlap(piece, old, points) >= 0.98 for old in chosen_pieces):
                continue
            if running_area + area > source_area + tolerance:
                continue
            usable.append(piece)
            running_area += area
            chosen_pieces.append(piece)
        if usable:
            chosen.append((group, usable))
        if abs(running_area - source_area) <= tolerance:
            break

    candidates = []
    for group, pieces in chosen:
        synthetic_source = {
            "key": "r125-panel-geometry-host",
            "space_revit_id": None,
            "source_key": str(record.get("parent_source_key") or ""),
        }
        for piece in pieces:
            candidates.append((group["parent"], piece, group["metrics"], synthetic_source))
    contract = _u_physical_reconstruction_contract(record, candidates)
    return candidates if contract.get("accepted") else []


def _u_physical_parent_candidates(record, index, analytical_manifest, physical_manifest=None):
    candidates = _r125_base_physical_parent_candidates(
        record, index, analytical_manifest, physical_manifest
    )
    if candidates and _u_physical_reconstruction_contract(record, candidates).get("accepted"):
        return candidates
    if not bool(record.get("curtain_panel")):
        return candidates
    recovered = _r125_curtain_parent_candidates(record, index)
    return recovered or candidates


# No arbitrary building-height clipping: actual Revit physical Z bounds plus actual Levels
# define the discovery domain; top Spaces resolve to the nearest real XY-overlapping cover.
# The existing discover_spatial_domains already uses _physical_model_z_bounds and probes every
# level inside that domain. With the 30 ft cover ceiling removed, bulkheads/penthouses are no
# longer truncated merely because they sit above a nominal/zoning building-height value.
# REVEX_R125_GEOMETRY_TOUCHUPS_END
'''


def update_python() -> str:
    source = PY.read_text(encoding="utf-8")
    if MARKER not in source:
        if EXECUTION_MARKER not in source:
            raise RuntimeError("gbXML exporter execution marker is missing")
        source = source.replace(EXECUTION_MARKER, "\n" + BLOCK.strip("\n") + EXECUTION_MARKER, 1)
        PY.write_text(source, encoding="utf-8", newline="\n")
    return source


def update_dynamo(source: str) -> None:
    graph = json.loads(DYN.read_text(encoding="utf-8-sig"))
    nodes = list(graph.get("Nodes") or [])
    python_nodes = [
        node for node in nodes
        if "PythonNodeModels.PythonNode" in str(node.get("ConcreteType") or "")
    ]
    if len(python_nodes) != 1:
        raise RuntimeError(f"Expected exactly one Python node, found {len(python_nodes)}")
    python_nodes[0]["Code"] = source
    DYN.write_text(json.dumps(graph, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")


def main() -> int:
    source = update_python()
    update_dynamo(source)
    # Re-read and prove byte-for-byte embedded identity.
    graph = json.loads(DYN.read_text(encoding="utf-8"))
    embedded = next(
        node["Code"] for node in graph["Nodes"]
        if "PythonNodeModels.PythonNode" in str(node.get("ConcreteType") or "")
    )
    if embedded.replace("\r\n", "\n").rstrip() != PY.read_text(encoding="utf-8").replace("\r\n", "\n").rstrip():
        raise RuntimeError("Dynamo embedded Python no longer matches external exporter")
    print(json.dumps({
        "REVEX_R125_GBXML_GEOMETRY_TOUCHUPS": "APPLIED",
        "wholeDoorOpening": True,
        "curtainPanelsByGeometry": True,
        "multiFloorCurtainHost": True,
        "topCoverHeightCapRemoved": True,
        "dynamoPythonMatched": True,
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
