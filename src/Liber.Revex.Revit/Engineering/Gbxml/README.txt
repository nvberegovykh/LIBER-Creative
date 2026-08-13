LIBER gbXML Preflight + Export 1.1.8 — REVEX embedded engine

Revit 2026 / Dynamo 3.x / CPython3.

1.1.8 fixes SpatialElement name reads. Autodesk Revit 2026 exposes SpatialElement.Name as a setter-only override, so Room/Space names are read through BuiltInParameter.ROOM_NAME. Direct Name assignment is retained only for intentional safe Space updates.

The engine also retains:
- RoomFilter and SpaceFilter collection;
- safe automatic MEP Space creation with transaction rollback guard;
- deterministic phase resolution;
- Complex curtain-wall panel export and opening-role verification;
- physical / analytical / XML envelope persistence checks;
- JSON + TXT evidence for every run;
- optional MiniLM semantic QA that never controls geometry/export.

The standalone graph remains Manual. REVEX creates a private run copy and executes it through the verified headless runner.
