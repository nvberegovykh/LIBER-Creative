"""Normalize overlapping analytical cuts without changing the source export.

Only two evidence-bound cases are supported: a curtain-panel door replacing its
glazed panel, and overlapping copies of the same door family/type. The union of
the opening footprint must remain exact. Original source IDs, paired faces and
the immutable OSM remain available. This is a reported analytical modelling
decision, not a claim that the per-element source polygons were lossless.
"""
from collections import defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import sys


def normalize(source, destination, report_path, core_path=None):
    core_path = core_path or Path('/opt/revex/energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler_core.py')
    spec = importlib.util.spec_from_file_location('revex_opening_core', core_path)
    core = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = core
    spec.loader.exec_module(core)
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    model = core.parse_osm(Path(source))
    props = core.additional_properties(model)
    grouped = defaultdict(list)
    for obj in model.by_type.get('OS:SubSurface', []):
        grouped[obj.fields[4]].append(obj)
    report = {'schema': 'liber.revex.analytical-opening-partition.v1',
              'sourceSha256': hashlib.sha256(Path(source).read_bytes()).hexdigest(),
              'sourceModified': False, 'repairs': [], 'unresolved': []}
    changes = {}
    for parent_id, children in grouped.items():
        parent = model.by_handle.get(parent_id)
        if parent is None:
            continue
        basis = core._plane_basis(core.vertices(parent))
        if basis is None:
            continue
        origin, _u, _v, normal = basis
        if any(abs(sum((p[i] - origin[i]) * normal[i] for i in range(3))) > 1e-5
               for child in children for p in core.vertices(child)):
            report['unresolved'].append({'parent': parent.name, 'reason': 'Opening is not coplanar with its parent.'})
            continue
        wall = Polygon(core._project_plane(core.vertices(parent), basis))
        polygons = {o.handle: Polygon(core._project_plane(core.vertices(o), basis)) for o in children}
        if not wall.is_valid or any(not p.is_valid for p in polygons.values()):
            continue
        tolerance = max(1e-8, wall.area * 1e-8)
        conflicts = [(a,b) for i,a in enumerate(children) for b in children[i+1:]
                     if polygons[a.handle].intersection(polygons[b.handle]).area > tolerance]
        if not conflicts:
            continue
        def identity(o):
            return props.get(o.handle, {}).get('CADObjectId', '')
        def label(o):
            return props.get(o.handle, {}).get('displayName', '')
        def order(o):
            return (0 if o.fields[2] == 'Door' else 1, identity(o))
        def safe_pair(a,b):
            if not identity(a) or not identity(b) or identity(a) == identity(b):
                return False
            if any(len(o.fields)>8 and o.fields[8] not in ('','1','1.0') for o in (a,b)):
                return False
            if a.fields[2] == b.fields[2] == 'Door':
                return bool(label(a)) and label(a) == label(b) and a.fields[3] == b.fields[3]
            door, panel = sorted((a,b), key=order)
            return (door.fields[2] == 'Door' and panel.fields[2] == 'FixedWindow'
                    and 'curtain' in label(door).lower() and 'curtain panels' in label(panel).lower())
        if any(not safe_pair(a,b) for a,b in conflicts):
            report['unresolved'].append({'parent':parent.name,'reason':'Opening types or source evidence do not justify automatic partition.'})
            continue
        original_union = unary_union(list(polygons.values()))
        if original_union.difference(wall).area > tolerance:
            report['unresolved'].append({'parent':parent.name,'reason':'Opening union extends outside its parent.'})
            continue
        assigned = Polygon()
        proposed = {}
        for child in sorted(children, key=order):
            region = polygons[child.handle].difference(assigned)
            if region.geom_type != 'Polygon' or region.is_empty or region.area <= tolerance or len(region.interiors):
                proposed = {}; break
            proposed[child.handle] = region
            assigned = assigned.union(region)
        if not proposed or original_union.symmetric_difference(assigned).area > tolerance:
            report['unresolved'].append({'parent':parent.name,'reason':'Partition cannot preserve every source and the exact union.'})
            continue
        for child in children:
            region = proposed[child.handle]
            if polygons[child.handle].symmetric_difference(region).area <= tolerance:
                continue
            points = core._unproject_plane(list(region.exterior.coords)[:-1], basis)
            if core._dot(core.newell_area_and_normal(points)[1], core.newell_area_and_normal(core.vertices(child))[1]) < 0:
                points.reverse()
            changes[child.handle] = points
        report['repairs'].append({'parent':parent.name, 'sourceIds':[identity(o) for o in children],
             'policy':'Curtain door cut takes precedence over panel; identical door types use stable source-ID order.',
             'openingUnionAreaM2':original_union.area, 'duplicatedAreaM2':sum(p.area for p in polygons.values())-original_union.area,
             'unionSymmetricDifferenceM2':original_union.symmetric_difference(assigned).area,
             'perElementAreasChanged':True, 'reviewRequired':True})
    # Both sides of an interior opening must remain congruent before committing.
    for handle, points in changes.items():
        obj = model.by_handle[handle]
        mate = model.by_handle.get(obj.fields[5]) if len(obj.fields)>5 and obj.fields[5] else None
        if mate:
            other = changes.get(mate.handle, core.vertices(mate))
            if sorted(tuple(round(x,7) for x in p) for p in points) != sorted(tuple(round(x,7) for x in p) for p in other):
                raise ValueError('Automatic opening partition would break a paired interior opening.')
    for handle, points in changes.items():
        core._set_vertices(model.by_handle[handle], points)
    Path(destination).parent.mkdir(parents=True, exist_ok=True)
    core.write_osm(Path(destination), model.objects)
    report['derivedSha256'] = hashlib.sha256(Path(destination).read_bytes()).hexdigest()
    report['changedOpenings'] = len(changes)
    Path(report_path).write_text(json.dumps(report, indent=2), encoding='utf-8')
    return report
