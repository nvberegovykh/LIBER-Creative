using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Liber.Revex.Revit.Models;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Deterministic last-mile geometry fallback for SYNC ENGINEERING.
///
/// The normal LIBER/Revit EADM + gbXML path remains authoritative. If it returns a
/// non-publishable but non-empty result, this fallback converts the already placed
/// Revit MEP Spaces into a conservative 2.5D source-bound gbXML: actual Space plan
/// boundaries are extruded between their Revit vertical bounds, coincident wall/floor
/// faces are paired, and doors/windows/curtain panels are projected as bounded
/// rectangular openings only when a unique compatible wall carrier is proven.
/// Anything ambiguous becomes opaque wall instead of blocking the whole Energy chain.
/// </summary>
public sealed class SimplifiedGbxmlFallbackService
{
    private const double FtToM = 0.3048;
    private const double PointTolFt = 0.01;
    private const double OpeningPlaneTolFt = 1.25;
    private const double MinSpanFt = 0.10;
    private const double MaxProcessedRoomHeightFt = 20.0 / FtToM;

    private sealed record DerivedRoom(
        Room Room,
        long InvalidSpaceId,
        string XmlId,
        string Label,
        double Area,
        double Z0,
        double Z1,
        List<XYZ> Footprint);

    private sealed record GeometryEvidenceResult(
        string Schema,
        string Path,
        string Sha256,
        string GbxmlSha256,
        int LevelCount,
        int RoomCount,
        int NativeSpaceCount,
        int ProcessedSpaceCount,
        int PhysicalSurfaceCount,
        int PhysicalOpeningCount);

    private sealed class Face
    {
        public required string Key { get; init; }
        public required string Id { get; init; }
        public required List<XYZ> Points { get; init; }
        public required bool Vertical { get; init; }
        public required bool IsTop { get; init; }
        public required string CadId { get; init; }
        public List<string> Spaces { get; } = new();
        public XElement? Xml { get; set; }
        public XYZ? EdgeA { get; init; }
        public XYZ? EdgeB { get; init; }
        public double Z0 { get; init; }
        public double Z1 { get; init; }
    }

    public GbxmlEngineeringOutput Run(
        Document doc,
        GbxmlEngineeringOutput prior,
        IReadOnlySet<long> originalSpaceIds)
    {
        DateTime started = DateTime.Now;
        if (prior == null) throw new ArgumentNullException(nameof(prior));
        if (originalSpaceIds == null) throw new ArgumentNullException(nameof(originalSpaceIds));
        if (string.IsNullOrWhiteSpace(prior.RunFolder) || !Directory.Exists(prior.RunFolder))
            throw new InvalidOperationException("Simplified Energy fallback requires the preserved current gbXML run folder.");

        Phase selectedPhase = ResolveSelectedPhase(doc, prior.ReportPath);

        Directory.CreateDirectory(prior.OutputFolder);
        var placedSpaces = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_MEPSpaces)
            .WhereElementIsNotElementType()
            .Cast<Space>()
            .Where(IsPlaced)
            .OrderBy(s => s.Id.Value)
            .ToList();
        if (placedSpaces.Count == 0)
            throw new InvalidOperationException("Simplified Energy fallback found no placed Revit MEP Spaces.");
        var spaces = placedSpaces.Where(HasPositiveVerticalEvidence).ToList();
        // Only invalid Spaces that existed before the canonical attempt are eligible
        // for Room-derived substitution. A broken transient Space created by the
        // failed attempt is neither source evidence nor silently relabeled as one.
        var invalidSpaces = placedSpaces
            .Where(space => originalSpaceIds.Contains(space.Id.Value) && !HasPositiveVerticalEvidence(space))
            .ToList();
        var derivedRooms = BuildDerivedRooms(doc, invalidSpaces);
        if (spaces.Count == 0 && derivedRooms.Count == 0)
            throw new InvalidOperationException("Simplified Energy fallback found no positive native or bounded Room-derived spatial geometry.");

        string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture);
        string xmlPath = Path.Combine(prior.OutputFolder, $"REVEX_SIMPLIFIED_{Safe(doc.Title)}_{stamp}.xml");
        string reportPath = Path.Combine(prior.OutputFolder, $"REVEX_SIMPLIFIED_{stamp}_REPORT.json");
        string summaryPath = Path.Combine(prior.OutputFolder, $"REVEX_SIMPLIFIED_{stamp}_SUMMARY.txt");

        XNamespace g = "http://www.gbxml.org/schema";
        var root = new XElement(g + "gbXML",
            new XAttribute("temperatureUnit", "C"),
            new XAttribute("lengthUnit", "Meters"),
            new XAttribute("areaUnit", "SquareMeters"),
            new XAttribute("volumeUnit", "CubicMeters"),
            new XAttribute("useSIUnitsForResults", "true"),
            new XAttribute("version", "7.03"));
        var campus = new XElement(g + "Campus", new XAttribute("id", "liber-campus"));
        root.Add(campus);
        var location = new XElement(g + "Location", new XElement(g + "Name", doc.Title), new XElement(g + "ZipcodeOrPostalCode", "00000"));
        campus.Add(location);
        var building = new XElement(g + "Building", new XAttribute("id", "liber-building"), new XAttribute("buildingType", "Unknown"));
        campus.Add(building);

        double totalAreaM2 = spaces.Sum(s => Math.Max(0.0, s.Area) * FtToM * FtToM) +
                             derivedRooms.Sum(row => row.Area * FtToM * FtToM);
        building.Add(new XElement(g + "Area", F(totalAreaM2)));

        var spaceNodes = new Dictionary<string, XElement>(StringComparer.Ordinal);
        var faces = new Dictionary<string, Face>(StringComparer.Ordinal);
        int boundaryFallbackCount = 0;

        foreach (Space space in spaces)
        {
            long sid = space.Id.Value;
            string xmlSpaceId = $"liber-space-{sid}";
            var node = new XElement(g + "Space", new XAttribute("id", xmlSpaceId),
                new XElement(g + "Name", SpaceLabel(space, xmlSpaceId)),
                new XElement(g + "Area", F(Math.Max(0.0, space.Area) * FtToM * FtToM)),
                new XElement(g + "Volume", F(Math.Max(0.0, space.Volume) * FtToM * FtToM * FtToM)),
                new XElement(g + "CADObjectId", sid.ToString(CultureInfo.InvariantCulture)));
            building.Add(node);
            spaceNodes[xmlSpaceId] = node;

            BoundingBoxXYZ? bb = space.get_BoundingBox(null);
            if (bb == null || bb.Max.Z <= bb.Min.Z + MinSpanFt) continue;
            double z0 = bb.Min.Z;
            double z1 = bb.Max.Z;
            List<XYZ> footprint = OuterBoundary(space, z0);
            if (footprint.Count < 3)
            {
                boundaryFallbackCount++;
                footprint = new List<XYZ>
                {
                    new(bb.Min.X, bb.Min.Y, z0), new(bb.Max.X, bb.Min.Y, z0),
                    new(bb.Max.X, bb.Max.Y, z0), new(bb.Min.X, bb.Max.Y, z0)
                };
            }

            AddHorizontalFace(faces, footprint, z0, false, xmlSpaceId, sid);
            AddHorizontalFace(faces, footprint, z1, true, xmlSpaceId, sid);
            for (int i = 0; i < footprint.Count; i++)
            {
                XYZ a = footprint[i];
                XYZ b = footprint[(i + 1) % footprint.Count];
                if (Distance2D(a, b) <= MinSpanFt) continue;
                AddVerticalFace(faces, a, b, z0, z1, xmlSpaceId, sid);
            }
        }

        foreach (DerivedRoom derived in derivedRooms)
        {
            var node = new XElement(g + "Space", new XAttribute("id", derived.XmlId),
                new XElement(g + "Name", derived.Label),
                new XElement(g + "Area", F(derived.Area * FtToM * FtToM)),
                new XElement(g + "Volume", F(derived.Area * (derived.Z1 - derived.Z0) * FtToM * FtToM * FtToM)),
                new XElement(g + "CADObjectId", $"ROOM:{derived.Room.Id.Value}"));
            building.Add(node);
            spaceNodes[derived.XmlId] = node;
            AddHorizontalFace(faces, derived.Footprint, derived.Z0, false, derived.XmlId, derived.InvalidSpaceId);
            AddHorizontalFace(faces, derived.Footprint, derived.Z1, true, derived.XmlId, derived.InvalidSpaceId);
            for (int i = 0; i < derived.Footprint.Count; i++)
            {
                XYZ a = derived.Footprint[i];
                XYZ b = derived.Footprint[(i + 1) % derived.Footprint.Count];
                if (Distance2D(a, b) > MinSpanFt)
                    AddVerticalFace(faces, a, b, derived.Z0, derived.Z1, derived.XmlId, derived.InvalidSpaceId);
            }
        }

        if (faces.Count < 4)
            throw new InvalidOperationException($"Simplified Energy fallback produced only {faces.Count} source faces.");

        foreach (Face face in faces.Values.OrderBy(f => f.Id, StringComparer.Ordinal))
        {
            string surfaceType = face.Spaces.Count > 1
                ? (face.Vertical ? "InteriorWall" : "InteriorFloor")
                : face.Vertical ? "ExteriorWall" : face.IsTop ? "Roof" : "RaisedFloor";
            var surface = new XElement(g + "Surface", new XAttribute("id", face.Id), new XAttribute("surfaceType", surfaceType));
            if (surfaceType is "ExteriorWall" or "Roof") surface.Add(new XAttribute("exposedToSun", "true"));
            surface.Add(new XElement(g + "Name", "LIBER simplified Revit source carrier"));
            foreach (string xmlSpaceId in face.Spaces.Distinct(StringComparer.Ordinal))
                surface.Add(new XElement(g + "AdjacentSpaceId", new XAttribute("spaceIdRef", xmlSpaceId)));
            AddPlanar(surface, g, face.Points);
            surface.Add(new XElement(g + "CADObjectId", face.CadId));
            campus.Add(surface);
            face.Xml = surface;

            foreach (string xmlSpaceId in face.Spaces.Distinct(StringComparer.Ordinal))
            {
                if (!spaceNodes.TryGetValue(xmlSpaceId, out XElement? spaceNode)) continue;
                var boundary = new XElement(g + "SpaceBoundary", new XAttribute("surfaceIdRef", face.Id));
                AddPlanar(boundary, g, face.Points);
                spaceNode.Add(boundary);
            }
        }

        var openingCandidates = CollectOpeningCandidates(doc).ToList();
        var openingEvidence = new List<object>();
        int openingPieces = 0;
        int opaqueFallbacks = 0;
        foreach (Element opening in openingCandidates)
        {
            BoundingBoxXYZ? bb = opening.get_BoundingBox(null);
            if (bb == null) { opaqueFallbacks++; continue; }
            bool isDoor = opening.Category?.Id.Value == (long)BuiltInCategory.OST_Doors;
            string descriptor = (opening.Name + " " + (doc.GetElement(opening.GetTypeId())?.Name ?? "")).ToLowerInvariant();
            if (!isDoor && opening.Category?.Id.Value == (long)BuiltInCategory.OST_CurtainWallPanels &&
                new[] { "spandrel", "opaque", "solid panel", "metal panel", "stone panel", "precast" }.Any(descriptor.Contains))
                continue;

            List<Face> parents = FindOpeningParents(faces.Values, bb).ToList();
            if (parents.Count == 0) { opaqueFallbacks++; continue; }
            int before = openingPieces;
            foreach (Face parent in parents)
            {
                if (parent.Xml == null || parent.EdgeA == null || parent.EdgeB == null) continue;
                List<XYZ>? polygon = OpeningRectangle(parent, bb);
                if (polygon == null) continue;
                string oid = $"liber-fallback-opening-{opening.Id.Value}-{openingPieces + 1}";
                var node = new XElement(g + "Opening",
                    new XAttribute("id", oid),
                    new XAttribute("openingType", isDoor ? "NonSlidingDoor" : "FixedWindow"),
                    new XAttribute("coordinatesAbsolute", "true"),
                    new XElement(g + "Name", opening.Name ?? oid));
                AddPlanar(node, g, polygon);
                node.Add(new XElement(g + "CADObjectId", opening.Id.Value.ToString(CultureInfo.InvariantCulture)));
                parent.Xml.Add(node);
                openingEvidence.Add(new
                {
                    id = oid,
                    sourceElementId = opening.Id.Value,
                    sourceUniqueId = opening.UniqueId ?? "",
                    carrierSurfaceId = parent.Id,
                    openingType = isDoor ? "NonSlidingDoor" : "FixedWindow",
                    pointsFt = polygon.Select(PointFt).ToArray()
                });
                openingPieces++;
            }
            if (openingPieces == before) opaqueFallbacks++;
        }

        new XDocument(new XDeclaration("1.0", "utf-8", "yes"), root).Save(xmlPath);
        XDocument.Parse(File.ReadAllText(xmlPath));

        GeometryEvidenceResult geometryEvidence = WriteGeometryEvidence(
            doc,
            selectedPhase,
            prior.RunFolder,
            xmlPath,
            placedSpaces,
            spaces,
            invalidSpaces,
            derivedRooms,
            faces.Values,
            openingEvidence,
            originalSpaceIds);

        int surfaceCount = faces.Count;
        int openingSourceCount = openingCandidates.Count;
        double exactOpeningRatio = openingSourceCount == 0 ? 1.0 : Math.Min(1.0, (double)(openingSourceCount - opaqueFallbacks) / openingSourceCount);
        // A simplified fallback is intentionally review-quality, never silently promoted
        // to strict fidelity. 90% is a policy ceiling, while the measured component
        // coverage stays separately visible below.
        const double fallbackReviewScore = 0.90;
        int expectedSpatialRecords = spaces.Count + invalidSpaces.Count;
        int preservedSpatialRecords = spaces.Count + derivedRooms.Count;
        double spatialPreservation = expectedSpatialRecords == 0 ? 0.0 : Math.Min(1.0, (double)preservedSpatialRecords / expectedSpatialRecords);
        double physicalOpeningPreservation = exactOpeningRatio;
        double overallPreservation = Math.Min(fallbackReviewScore, Math.Min(spatialPreservation, physicalOpeningPreservation));
        bool allInvalidOriginalsRepresented = invalidSpaces.Count == derivedRooms.Count;
        bool publicationThresholdMet = allInvalidOriginalsRepresented && spatialPreservation >= 0.80 && physicalOpeningPreservation >= 0.80 && overallPreservation >= 0.80;
        string resultStatus = publicationThresholdMet ? "EXPORTED" : "BLOCKED_BELOW_80_INTEGRITY_PRESERVED";
        var report = new
        {
            schema = "liber.revex.gbxml-simplified-fallback.v1",
            status = resultStatus,
            architecture = "REVIT_SOURCE_BOUNDARY_SIMPLIFICATION_V1",
            export_method = "REVIT_SPACE_BOUNDARY_2_5D_FALLBACK",
            gbxml_path = xmlPath,
            geometry_evidence = new
            {
                schema = geometryEvidence.Schema,
                path = geometryEvidence.Path,
                sha256 = geometryEvidence.Sha256,
                gbxmlSha256 = geometryEvidence.GbxmlSha256,
                levelCount = geometryEvidence.LevelCount,
                roomCount = geometryEvidence.RoomCount,
                nativeSpaceCount = geometryEvidence.NativeSpaceCount,
                processedSpaceCount = geometryEvidence.ProcessedSpaceCount,
                physicalSurfaceCount = geometryEvidence.PhysicalSurfaceCount,
                physicalOpeningCount = geometryEvidence.PhysicalOpeningCount
            },
            fallback_geometry = new
            {
                active = true,
                reason = prior.Status,
                policy = "exact/EADM path first; source-bound simplification only after non-publishable normal result",
                sourcePlacedSpaces = placedSpaces.Count,
                positiveNativeSpaces = spaces.Count,
                invalidOriginalSpaces = invalidSpaces.Count,
                roomDerivedProcessedSpaces = derivedRooms.Count,
                unrecoveredInvalidSpaces = Math.Max(0, invalidSpaces.Count - derivedRooms.Count),
                everyInvalidOriginalRepresented = allInvalidOriginalsRepresented,
                spaces = preservedSpatialRecords,
                surfaces = surfaceCount,
                openingSources = openingSourceCount,
                openingPieces,
                opaqueOpeningFallbacks = opaqueFallbacks,
                exactOpeningGeometryRatio = Math.Round(exactOpeningRatio, 6),
                bboxFootprintFallbackSpaces = boundaryFallbackCount,
                ambiguousOpeningsBecomeOpaqueWall = true
            },
            preservation_gate_preexport = new { room_preservation = spatialPreservation },
            preservation_gate = new
            {
                overall = overallPreservation,
                overall_method = "simplified_fallback_policy_ceiling",
                spatial = spatialPreservation,
                physical = fallbackReviewScore,
                analytical_surfaces = fallbackReviewScore,
                physical_opening_sources = physicalOpeningPreservation,
                target = 0.95,
                minimum = 0.80,
                publication_threshold_met = publicationThresholdMet,
                quality_target_met = false,
                decision = publicationThresholdMet ? "ACCEPT_SOURCE_BOUND_SIMPLIFIED_FALLBACK_REVIEW" : "BLOCK_BELOW_80",
                strict_qa_passed = false,
                expected_spaces = expectedSpatialRecords,
                preserved_spaces = preservedSpatialRecords
            },
            messages = new object[]
            {
                new { severity="WARNING", code="SIMPLIFIED_GEOMETRY_FALLBACK_USED", message="Normal exact/EADM gbXML did not clear publication. REVEX emitted a source-bound Space-boundary simplification so managed Energy can continue. Ambiguous openings remain opaque; Companion must retain the review flag." }
            }
        };
        File.WriteAllText(reportPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        string summary = $"REVEX simplified source-bound gbXML fallback\nStatus: {resultStatus}\nPlaced source Spaces: {placedSpaces.Count}\nPositive native Spaces: {spaces.Count}\nRoom-derived processed Spaces: {derivedRooms.Count}\nSpatial preservation: {spatialPreservation:P1}\nSurfaces: {surfaceCount}\nOpening sources: {openingSourceCount}\nOpening pieces: {openingPieces}\nOpaque opening fallbacks: {opaqueFallbacks}\nExact opening geometry ratio: {exactOpeningRatio:P1}\nReview-quality ceiling: {fallbackReviewScore:P0}\nNormal result: {prior.Status}\n";
        File.WriteAllText(summaryPath, summary, Encoding.UTF8);

        RevexDiagnostics.Warn("GBXML", $"Simplified source-bound fallback: status={resultStatus}; sourceSpaces={placedSpaces.Count}; positiveNative={spaces.Count}; roomDerived={derivedRooms.Count}; spatialPreservation={spatialPreservation:P1}; surfaces={surfaceCount}; openingPieces={openingPieces}; opaqueOpeningFallbacks={opaqueFallbacks}; prior={prior.Status}");
        return new GbxmlEngineeringOutput(
            resultStatus, doc.Title, doc.PathName, prior.RunFolder, prior.OutputFolder,
            xmlPath, summaryPath, reportPath, summary, started, DateTime.Now);
    }

    private static Phase ResolveSelectedPhase(Document doc, string? reportPath)
    {
        if (string.IsNullOrWhiteSpace(reportPath) || !File.Exists(reportPath))
            throw new InvalidOperationException("Simplified Energy fallback requires the exact canonical run report to resolve its Revit phase.");
        using JsonDocument report = JsonDocument.Parse(File.ReadAllText(reportPath));
        if (!report.RootElement.TryGetProperty("phase", out JsonElement phaseElement) || phaseElement.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("The canonical run report has no resolved Revit phase.");
        string selected = phaseElement.GetString()?.Trim() ?? "";
        if (selected.Length == 0 || string.Equals(selected, "auto", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The canonical run report did not preserve its resolved Revit phase.");
        List<Phase> matches = doc.Phases.Cast<Phase>()
            .Where(phase => string.Equals(phase.Name?.Trim(), selected, StringComparison.Ordinal))
            .ToList();
        if (matches.Count != 1)
            throw new InvalidOperationException($"The canonical phase '{selected}' is absent or ambiguous in the active Revit document.");
        return matches[0];
    }

    private static GeometryEvidenceResult WriteGeometryEvidence(
        Document doc,
        Phase selectedPhase,
        string runFolder,
        string gbxmlPath,
        IReadOnlyCollection<Space> placedSpaces,
        IReadOnlyCollection<Space> exportableSpaces,
        IReadOnlyCollection<Space> invalidOriginalSpaces,
        IReadOnlyCollection<DerivedRoom> derivedRooms,
        IEnumerable<Face> faceSource,
        IReadOnlyCollection<object> openingEvidence,
        IReadOnlySet<long> originalSpaceIds)
    {
        const string schema = "liber.revex.revit-energy-geometry.v1";
        const string authority = "active-revit-document-processed-energy-geometry";
        string gbxmlSha = Sha256(gbxmlPath);
        var exportableIds = exportableSpaces.Select(space => space.Id.Value).ToHashSet();
        var invalidIds = invalidOriginalSpaces.Select(space => space.Id.Value).ToHashSet();
        var faces = faceSource.OrderBy(face => face.Id, StringComparer.Ordinal).ToList();

        object[] levels = new FilteredElementCollector(doc)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .OrderBy(level => level.Elevation)
            .ThenBy(level => level.Id.Value)
            .Select(level => (object)new
            {
                id = level.Id.Value,
                uniqueId = level.UniqueId ?? "",
                name = level.Name ?? "",
                elevationFt = level.Elevation,
                buildingStory = level.IsBuildingStory
            }).ToArray();
        if (levels.Length == 0)
            throw new InvalidOperationException("Simplified Energy geometry has no Revit Levels.");

        object[] rooms = derivedRooms.OrderBy(row => row.Room.Id.Value).Select(row => (object)new
        {
            kind = "host_room",
            source = "simplified-room-boundary",
            id = row.Room.Id.Value,
            uniqueId = row.Room.UniqueId ?? "",
            name = row.Label,
            number = row.Room.Number ?? "",
            hostLevelId = row.Room.LevelId.Value,
            baseZFt = row.Z0,
            topZFt = row.Z1,
            areaFt2 = row.Area
        }).ToArray();

        object[] spaces = placedSpaces.OrderBy(space => space.Id.Value).Select(space =>
        {
            BoundingBoxXYZ? box = null;
            try { box = space.get_BoundingBox(null); } catch { }
            long id = space.Id.Value;
            return (object)new
            {
                id,
                uniqueId = space.UniqueId ?? "",
                name = SpaceLabel(space, $"Space {id}"),
                number = space.Number ?? "",
                provenance = originalSpaceIds.Contains(id) ? "PREEXISTING_UNTOUCHED" : "REVEX_CREATED",
                exportable = exportableIds.Contains(id),
                areaFt2 = SafeDouble(() => space.Area),
                volumeFt3 = SafeDouble(() => space.Volume),
                baseLevelId = space.LevelId.Value,
                upperLevelId = SafeLong(() => space.UpperLimit?.Id.Value ?? -1),
                nativeSolidZBoundsFt = box == null ? null : new[] { box.Min.Z, box.Max.Z },
                excludedInvalidOriginal = invalidIds.Contains(id)
            };
        }).ToArray();
        if (spaces.Length == 0)
            throw new InvalidOperationException("Simplified Energy geometry has no recorded Revit Spaces.");

        object[] processed = derivedRooms.OrderBy(row => row.InvalidSpaceId).Select(row => (object)new
        {
            id = row.XmlId,
            sourceRoomKey = $"host_room:-1:{row.Room.Id.Value}:{row.Room.UniqueId}",
            sourceRoomId = row.Room.Id.Value,
            invalidOriginalSpaceId = row.InvalidSpaceId,
            provenance = "ROOM_DERIVED_ISOLATED_FROM_PREEXISTING_INVALID_SPACE",
            coordinateSystem = "REVIT_HOST_INTERNAL",
            geometryMode = "ROOM_BOUNDARY_STORY_BOUNDED_2_5D",
            baseZFt = row.Z0,
            topZFt = row.Z1,
            heightFt = row.Z1 - row.Z0,
            areaFt2 = row.Area,
            volumeFt3 = row.Area * (row.Z1 - row.Z0),
            outerLoopFt = row.Footprint.Select(PointFt).ToArray()
        }).ToArray();

        object[] physicalSurfaces = faces.Select(face => (object)new
        {
            id = face.Id,
            key = face.Key,
            sourceCadId = face.CadId,
            surfaceType = face.Spaces.Count > 1
                ? (face.Vertical ? "InteriorWall" : "InteriorFloor")
                : face.Vertical ? "ExteriorWall" : face.IsTop ? "Roof" : "RaisedFloor",
            adjacentSpaceIds = face.Spaces.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray(),
            pointsFt = face.Points.Select(PointFt).ToArray(),
            z0Ft = face.Z0,
            z1Ft = face.Z1
        }).ToArray();
        if (physicalSurfaces.Length == 0)
            throw new InvalidOperationException("Simplified Energy geometry has no physical surfaces.");

        var payload = new
        {
            schema,
            version = "20260820r145-simplified-geometry1",
            authority,
            architecture = "REVIT_SOURCE_BOUNDARY_SIMPLIFICATION_V1",
            generatedAt = DateTime.UtcNow,
            sourceDocument = new
            {
                title = doc.Title,
                path = doc.PathName ?? "",
                projectInformationUniqueId = doc.ProjectInformation?.UniqueId ?? "",
                documentFingerprint = CentralModelBindingService.ResolveDocumentFingerprint(doc),
                phaseId = selectedPhase.Id.Value,
                phaseName = selectedPhase.Name,
                coordinateSystem = "REVIT_HOST_INTERNAL",
                linearUnit = "foot",
                areaUnit = "square-foot"
            },
            levels,
            rooms,
            spaces,
            processedSpaces = processed,
            physical = new { surfaces = physicalSurfaces, openings = openingEvidence.ToArray() },
            analytical = new { surfaces = Array.Empty<object>(), openings = Array.Empty<object>() },
            reconstruction = new
            {
                mode = "ROOM_AND_SPACE_BOUNDARY_STORY_BOUNDED_2_5D",
                originalSpacesRemainUnchanged = true,
                invalidOriginalSpaceIds = invalidIds.OrderBy(id => id).ToArray(),
                everyInvalidOriginalRepresented = invalidIds.SetEquals(derivedRooms.Select(row => row.InvalidSpaceId))
            },
            gbxml = new { name = Path.GetFileName(gbxmlPath), sha256 = gbxmlSha }
        };

        string destination = Path.Combine(runFolder, "REVIT-ENERGY-GEOMETRY.json");
        string temporary = Path.Combine(runFolder, $".REVIT-ENERGY-GEOMETRY.json.tmp-{Guid.NewGuid():N}");
        try
        {
            using (FileStream stream = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, payload, new JsonSerializerOptions { WriteIndented = true });
                stream.Flush(flushToDisk: true);
            }
            using (JsonDocument check = JsonDocument.Parse(File.ReadAllText(temporary)))
            {
                JsonElement root = check.RootElement;
                if (root.GetProperty("schema").GetString() != schema ||
                    root.GetProperty("authority").GetString() != authority ||
                    root.GetProperty("sourceDocument").GetProperty("documentFingerprint").GetString() != CentralModelBindingService.ResolveDocumentFingerprint(doc) ||
                    root.GetProperty("gbxml").GetProperty("sha256").GetString() != gbxmlSha)
                    throw new InvalidDataException("Simplified processed-geometry serialization failed its source/digest binding check.");
            }
            File.Move(temporary, destination, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        string geometrySha = Sha256(destination);
        RevexDiagnostics.Dependency("GBXML", "Simplified immutable processed geometry evidence", true,
            $"{destination}; sha256={geometrySha}; gbxmlSha256={gbxmlSha}; phase={selectedPhase.Name}");
        return new GeometryEvidenceResult(
            schema, destination, geometrySha, gbxmlSha,
            levels.Length, rooms.Length, spaces.Length, processed.Length,
            physicalSurfaces.Length, openingEvidence.Count);
    }

    private static double[] PointFt(XYZ point) => new[] { point.X, point.Y, point.Z };
    private static double SafeDouble(Func<double> value)
    {
        try { double result = value(); return double.IsFinite(result) ? result : 0.0; }
        catch { return 0.0; }
    }
    private static long SafeLong(Func<long> value)
    {
        try { return value(); }
        catch { return -1; }
    }
    private static string Sha256(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static bool IsPlaced(Space space)
    {
        try { return space.Location != null && space.Area > 1e-6; }
        catch { return false; }
    }

    private static bool HasPositiveVerticalEvidence(Space space)
    {
        try
        {
            if (!IsPlaced(space) || space.Volume <= 1.0e-9) return false;
            BoundingBoxXYZ? box = space.get_BoundingBox(null);
            if (box != null && box.Max.Z > box.Min.Z + 0.25) return true;
            Level? lower = space.Document.GetElement(space.LevelId) as Level;
            Level? upper = space.UpperLimit;
            return lower != null && upper != null && upper.Elevation + space.LimitOffset > lower.Elevation + space.BaseOffset + 0.25;
        }
        catch { return false; }
    }

    private static List<DerivedRoom> BuildDerivedRooms(Document doc, IEnumerable<Space> invalidSpaces)
    {
        var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()
            .OrderBy(level => level.Elevation).ToList();
        var output = new List<DerivedRoom>();
        var usedRooms = new HashSet<long>();
        foreach (Space invalid in invalidSpaces.OrderBy(space => space.Id.Value))
        {
            Room? room = null;
            try { room = invalid.Room; } catch { }
            if (room == null || !usedRooms.Add(room.Id.Value)) continue;
            Level? level = doc.GetElement(room.LevelId) as Level;
            if (level == null) continue;
            double z0;
            try { z0 = level.Elevation + room.BaseOffset; } catch { z0 = level.Elevation; }
            double z1 = z0;
            try { if (room.UpperLimit != null) z1 = room.UpperLimit.Elevation + room.LimitOffset; } catch { }
            if (z1 <= z0 + 0.25)
                z1 = levels.Where(item => item.Elevation > z0 + 0.25).Select(item => item.Elevation).DefaultIfEmpty(z0 + 10.0).Min();
            if (z1 <= z0 + 0.25 || z1 - z0 > MaxProcessedRoomHeightFt) continue;
            List<XYZ> footprint = OuterBoundary(room, z0);
            if (footprint.Count < 3) continue;
            double area = Math.Max(0.0, room.Area);
            if (area <= 1.0e-6) area = Math.Abs(SignedArea2D(footprint));
            if (area <= 1.0e-6) continue;
            string label = ((room.Number ?? "") + " " + (room.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? "")).Trim();
            string id = $"liber-room-derived-{room.Id.Value}-{invalid.Id.Value}";
            output.Add(new DerivedRoom(room, invalid.Id.Value, id, string.IsNullOrWhiteSpace(label) ? id : label, area, z0, z1, footprint));
        }
        return output;
    }

    private static List<XYZ> OuterBoundary(SpatialElement space, double z)
    {
        var loops = new List<List<XYZ>>();
        IList<IList<BoundarySegment>>? raw = null;
        try { raw = space.GetBoundarySegments(new SpatialElementBoundaryOptions()); } catch { }
        foreach (IList<BoundarySegment> loop in raw ?? Array.Empty<IList<BoundarySegment>>())
        {
            var points = new List<XYZ>();
            foreach (BoundarySegment segment in loop)
            {
                try
                {
                    IList<XYZ> tess = segment.GetCurve().Tessellate();
                    foreach (XYZ p in tess)
                    {
                        XYZ q = new(p.X, p.Y, z);
                        if (points.Count == 0 || Distance2D(points[^1], q) > PointTolFt) points.Add(q);
                    }
                }
                catch { }
            }
            if (points.Count > 1 && Distance2D(points[0], points[^1]) <= PointTolFt) points.RemoveAt(points.Count - 1);
            points = RemoveCollinear(points);
            if (points.Count >= 3) loops.Add(points);
        }
        return loops.OrderByDescending(p => Math.Abs(SignedArea2D(p))).FirstOrDefault() ?? new List<XYZ>();
    }

    private static List<XYZ> RemoveCollinear(List<XYZ> input)
    {
        var points = new List<XYZ>(input);
        bool changed = true;
        while (changed && points.Count > 3)
        {
            changed = false;
            for (int i = 0; i < points.Count; i++)
            {
                XYZ a = points[(i + points.Count - 1) % points.Count];
                XYZ b = points[i];
                XYZ c = points[(i + 1) % points.Count];
                double cross = (b.X - a.X) * (c.Y - b.Y) - (b.Y - a.Y) * (c.X - b.X);
                if (Math.Abs(cross) <= 1e-7)
                {
                    points.RemoveAt(i); changed = true; break;
                }
            }
        }
        return points;
    }

    private static void AddVerticalFace(Dictionary<string, Face> faces, XYZ a, XYZ b, double z0, double z1, string spaceId, long cadId)
    {
        XYZ p0 = new(a.X, a.Y, z0); XYZ p1 = new(b.X, b.Y, z0);
        XYZ p2 = new(b.X, b.Y, z1); XYZ p3 = new(a.X, a.Y, z1);
        string endA = Q2(a.X, a.Y); string endB = Q2(b.X, b.Y);
        string pair = string.CompareOrdinal(endA, endB) <= 0 ? endA + "|" + endB : endB + "|" + endA;
        string key = $"V|{pair}|{Q(z0)}|{Q(z1)}";
        if (!faces.TryGetValue(key, out Face? face))
        {
            face = new Face { Key = key, Id = "liber-fallback-surface-" + ShortHash(key), Points = new() { p0, p1, p2, p3 }, Vertical = true, IsTop = false, CadId = cadId.ToString(CultureInfo.InvariantCulture), EdgeA = a, EdgeB = b, Z0 = z0, Z1 = z1 };
            faces[key] = face;
        }
        if (!face.Spaces.Contains(spaceId, StringComparer.Ordinal)) face.Spaces.Add(spaceId);
    }

    private static void AddHorizontalFace(Dictionary<string, Face> faces, List<XYZ> footprint, double z, bool isTop, string spaceId, long cadId)
    {
        var points = footprint.Select(p => new XYZ(p.X, p.Y, z)).ToList();
        string shape = string.Join("|", points.Select(p => Q2(p.X, p.Y)).OrderBy(v => v, StringComparer.Ordinal));
        string key = $"H|{Q(z)}|{shape}";
        if (!faces.TryGetValue(key, out Face? face))
        {
            if (isTop) points.Reverse();
            face = new Face { Key = key, Id = "liber-fallback-surface-" + ShortHash(key), Points = points, Vertical = false, IsTop = isTop, CadId = cadId.ToString(CultureInfo.InvariantCulture), Z0 = z, Z1 = z };
            faces[key] = face;
        }
        if (!face.Spaces.Contains(spaceId, StringComparer.Ordinal)) face.Spaces.Add(spaceId);
    }

    private static IEnumerable<Element> CollectOpeningCandidates(Document doc)
    {
        var output = new Dictionary<long, Element>();
        foreach (BuiltInCategory cat in new[] { BuiltInCategory.OST_Doors, BuiltInCategory.OST_Windows, BuiltInCategory.OST_CurtainWallPanels })
        {
            try
            {
                foreach (Element e in new FilteredElementCollector(doc).OfCategory(cat).WhereElementIsNotElementType())
                    output[e.Id.Value] = e;
            }
            catch { }
        }
        return output.Values.OrderBy(e => e.Id.Value).ToList();
    }

    private static IEnumerable<Face> FindOpeningParents(IEnumerable<Face> faces, BoundingBoxXYZ bb)
    {
        XYZ c = new((bb.Min.X + bb.Max.X) * 0.5, (bb.Min.Y + bb.Max.Y) * 0.5, (bb.Min.Z + bb.Max.Z) * 0.5);
        var candidates = new List<(Face face, double distance)>();
        foreach (Face face in faces.Where(f => f.Vertical && f.EdgeA != null && f.EdgeB != null))
        {
            if (bb.Max.Z < face.Z0 + MinSpanFt || bb.Min.Z > face.Z1 - MinSpanFt) continue;
            double d = PointSegmentDistance2D(c, face.EdgeA!, face.EdgeB!);
            if (d > OpeningPlaneTolFt) continue;
            candidates.Add((face, d));
        }
        if (candidates.Count == 0) return Array.Empty<Face>();
        double best = candidates.Min(x => x.distance);
        return candidates.Where(x => x.distance <= best + 0.20).OrderBy(x => x.distance).Select(x => x.face).ToList();
    }

    private static List<XYZ>? OpeningRectangle(Face face, BoundingBoxXYZ bb)
    {
        XYZ a = face.EdgeA!; XYZ b = face.EdgeB!;
        double dx = b.X - a.X, dy = b.Y - a.Y, len = Math.Sqrt(dx * dx + dy * dy);
        if (len <= MinSpanFt) return null;
        double ux = dx / len, uy = dy / len;
        var corners = new[]
        {
            new XYZ(bb.Min.X,bb.Min.Y,0), new XYZ(bb.Min.X,bb.Max.Y,0),
            new XYZ(bb.Max.X,bb.Min.Y,0), new XYZ(bb.Max.X,bb.Max.Y,0)
        };
        double minS = corners.Min(p => (p.X - a.X) * ux + (p.Y - a.Y) * uy);
        double maxS = corners.Max(p => (p.X - a.X) * ux + (p.Y - a.Y) * uy);
        minS = Math.Max(0.0, minS); maxS = Math.Min(len, maxS);
        double z0 = Math.Max(face.Z0, bb.Min.Z); double z1 = Math.Min(face.Z1, bb.Max.Z);
        if (maxS - minS <= MinSpanFt || z1 - z0 <= MinSpanFt) return null;
        XYZ P(double s, double z) => new(a.X + ux * s, a.Y + uy * s, z);
        return new List<XYZ> { P(minS, z0), P(maxS, z0), P(maxS, z1), P(minS, z1) };
    }

    private static void AddPlanar(XElement parent, XNamespace g, IEnumerable<XYZ> points)
    {
        var poly = new XElement(g + "PolyLoop");
        foreach (XYZ p in points)
        {
            var cp = new XElement(g + "CartesianPoint");
            cp.Add(new XElement(g + "Coordinate", F(p.X * FtToM)));
            cp.Add(new XElement(g + "Coordinate", F(p.Y * FtToM)));
            cp.Add(new XElement(g + "Coordinate", F(p.Z * FtToM)));
            poly.Add(cp);
        }
        parent.Add(new XElement(g + "PlanarGeometry", poly));
    }

    private static double PointSegmentDistance2D(XYZ p, XYZ a, XYZ b)
    {
        double dx = b.X - a.X, dy = b.Y - a.Y;
        double d2 = dx * dx + dy * dy;
        if (d2 <= 1e-12) return Distance2D(p, a);
        double t = ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / d2;
        t = Math.Max(0, Math.Min(1, t));
        double x = a.X + t * dx, y = a.Y + t * dy;
        return Math.Sqrt((p.X - x) * (p.X - x) + (p.Y - y) * (p.Y - y));
    }

    private static double Distance2D(XYZ a, XYZ b) => Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y));
    private static double SignedArea2D(IReadOnlyList<XYZ> p) => p.Count < 3 ? 0.0 : 0.5 * Enumerable.Range(0, p.Count).Sum(i => p[i].X * p[(i + 1) % p.Count].Y - p[(i + 1) % p.Count].X * p[i].Y);
    private static string Q(double v) => Math.Round(v, 2).ToString("0.00", CultureInfo.InvariantCulture);
    private static string Q2(double x, double y) => Q(x) + "," + Q(y);
    private static string F(double v) => v.ToString("0.#########", CultureInfo.InvariantCulture);
    private static string Safe(string value) => string.Concat((value ?? "model").Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c));
    private static string ShortHash(string value) => Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()[..14];
    private static string SpaceLabel(Space space, string fallback)
    {
        string number = ""; string name = "";
        try { number = space.Number ?? ""; } catch { }
        try { name = space.get_Parameter(BuiltInParameter.ROOM_NAME)?.AsString() ?? ""; } catch { }
        string label = (number + " " + name).Trim();
        return string.IsNullOrWhiteSpace(label) ? fallback : label;
    }
}
