using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using System.IO.Compression;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// User-triggered BIM-family placement for the Walk palette. The provider file is
/// validated locally and placement occurs only through a Revit ExternalEvent.
/// Common point/level based families are placed directly; hosted/work-plane families
/// are attempted only against bounded nearby physical faces/hosts. Unsupported curve,
/// adaptive and view-only families fail visibly rather than being guessed.
/// </summary>
internal sealed class FamilyPlacementService
{
    internal sealed record PlacementRequest(
        string Path,
        double X,
        double Y,
        double Z,
        double RotationDegrees,
        string RequestedLevelName,
        double RequestedLevelElevation);

    internal sealed record TransformRequest(long ElementId, double Dx, double Dy, double Dz, double RotateDegrees);

    internal sealed record PlacementResult(
        long ElementId,
        string UniqueId,
        string Family,
        string Type,
        string Level,
        double[] BboxMin,
        double[] BboxMax,
        float[] PreviewTriangles,
        bool PreviewTruncated,
        string PlacementType);

    private const int MaxPreviewVertices = 120_000;
    private const double MaxHostDistanceFt = 8.0;
    private const int MaxZipEntries = 2048;
    private const long MaxExpandedZipBytes = 512L * 1024L * 1024L;

    internal PlacementResult Place(Document doc, PlacementRequest request)
    {
        string source = ResolveFamilyPath(request.Path, out string? extractedFolder);
        try
        {
            if (!File.Exists(source) || !string.Equals(Path.GetExtension(source), ".rfa", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The downloaded BIM asset does not contain a Revit .rfa family.");

            Family? family = null;
            FamilySymbol? symbol = null;
            FamilyInstance? instance = null;
            using (var tx = new Transaction(doc, "REVEX · Place BIM family"))
            {
                tx.Start();
                if (!doc.LoadFamily(source, new FamilyLoadOptions(), out family) || family == null)
                    family = FindLoadedFamily(doc, Path.GetFileNameWithoutExtension(source));
                if (family == null)
                    throw new InvalidOperationException("Revit could not load the downloaded family.");

                symbol = family.GetFamilySymbolIds()
                    .Select(id => doc.GetElement(id))
                    .OfType<FamilySymbol>()
                    .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
                if (symbol == null)
                    throw new InvalidOperationException("The downloaded family contains no placeable family type.");
                if (!symbol.IsActive) { symbol.Activate(); doc.Regenerate(); }

                string placementType = family.FamilyPlacementType.ToString();
                if (placementType.Contains("ViewBased", StringComparison.OrdinalIgnoreCase) ||
                    placementType.Contains("Detail", StringComparison.OrdinalIgnoreCase) ||
                    placementType.Contains("Adaptive", StringComparison.OrdinalIgnoreCase) ||
                    placementType.Contains("Curve", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Blocks family '{family.Name}' uses unsupported placement type {placementType}. REVEX Walk placement accepts 3D point/level/hosted families only.");

                Level level = ResolveLevel(doc, request.RequestedLevelName, request.RequestedLevelElevation, request.Z);
                double targetZ = double.IsFinite(request.Z) ? request.Z : level.Elevation;
                XYZ point = new(request.X, request.Y, targetZ);
                instance = TryLevelPlacement(doc, symbol, level, point);
                bool hosted = placementType.Contains("Hosted", StringComparison.OrdinalIgnoreCase) ||
                              placementType.Contains("WorkPlane", StringComparison.OrdinalIgnoreCase);
                if (instance == null && hosted)
                    instance = TryNearestFacePlacement(doc, symbol, point);
                if (instance == null && hosted)
                    instance = TryNearestHostedPlacement(doc, symbol, level, point);
                if (instance == null)
                    throw new InvalidOperationException($"REVEX could not place '{family.Name} · {symbol.Name}' safely at the Walk target. The family requires a host/placement rule that was not available within {MaxHostDistanceFt:0.#} ft.");

                if (Math.Abs(request.RotationDegrees) > 1e-8)
                    Rotate(doc, instance, request.RotationDegrees * Math.PI / 180.0);
                tx.Commit();
            }

            if (instance == null || symbol == null || family == null)
                throw new InvalidOperationException("Family placement completed without a Revit instance.");
            return Snapshot(doc, instance, family, symbol);
        }
        finally
        {
            if (!string.IsNullOrWhiteSpace(extractedFolder))
                try { Directory.Delete(extractedFolder, true); } catch { }
        }
    }

    internal PlacementResult Transform(Document doc, TransformRequest request)
    {
        FamilyInstance instance = doc.GetElement(new ElementId(request.ElementId)) as FamilyInstance
            ?? throw new InvalidOperationException("The placed REVEX family instance is no longer available in the active Revit document.");
        using (var tx = new Transaction(doc, "REVEX · Adjust BIM family"))
        {
            tx.Start();
            XYZ delta = new(request.Dx, request.Dy, request.Dz);
            if (delta.GetLength() > 1e-9)
                ElementTransformUtils.MoveElement(doc, instance.Id, delta);
            if (Math.Abs(request.RotateDegrees) > 1e-8)
                Rotate(doc, instance, request.RotateDegrees * Math.PI / 180.0);
            tx.Commit();
        }
        FamilySymbol symbol = doc.GetElement(instance.GetTypeId()) as FamilySymbol
            ?? throw new InvalidOperationException("The placed family type is no longer available.");
        return Snapshot(doc, instance, symbol.Family, symbol);
    }

    private static string ResolveFamilyPath(string source, out string? extractedFolder)
    {
        extractedFolder = null;
        string path = Path.GetFullPath(source ?? "");
        if (!File.Exists(path)) throw new FileNotFoundException("The downloaded BIM family file is missing.", path);
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".rfa") return path;
        if (ext != ".zip") throw new InvalidOperationException("REVEX BIM palette accepts .rfa or .zip family downloads.");

        extractedFolder = Path.Combine(Path.GetTempPath(), "LIBER_REVEX", "families", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(extractedFolder);
        string root = Path.GetFullPath(extractedFolder) + Path.DirectorySeparatorChar;
        using ZipArchive archive = ZipFile.OpenRead(path);
        if (archive.Entries.Count > MaxZipEntries)
            throw new InvalidOperationException($"Downloaded BIM ZIP contains too many entries ({archive.Entries.Count}; limit {MaxZipEntries}).");

        long expanded = 0;
        var extractedFamilies = new List<string>();
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name)) continue;
            expanded = checked(expanded + Math.Max(0, entry.Length));
            if (expanded > MaxExpandedZipBytes)
                throw new InvalidOperationException($"Downloaded BIM ZIP expands beyond the {MaxExpandedZipBytes / 1024 / 1024} MB REVEX limit.");

            string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            string destination = Path.GetFullPath(Path.Combine(extractedFolder, relative));
            if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Downloaded BIM ZIP contains an unsafe file path.");

            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            using Stream input = entry.Open();
            using FileStream output = File.Create(destination);
            input.CopyTo(output);
            if (string.Equals(Path.GetExtension(destination), ".rfa", StringComparison.OrdinalIgnoreCase))
                extractedFamilies.Add(destination);
        }

        string? family = extractedFamilies
            .OrderByDescending(p => new FileInfo(p).Length)
            .ThenBy(p => p, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        return family ?? throw new InvalidOperationException("The downloaded ZIP contains no Revit .rfa family.");
    }

    private static Family? FindLoadedFamily(Document doc, string name) =>
        new FilteredElementCollector(doc).OfClass(typeof(Family)).Cast<Family>()
            .FirstOrDefault(f => string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase));

    private static Level ResolveLevel(Document doc, string requestedName, double requestedElevation, double z)
    {
        var levels = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().ToList();
        if (levels.Count == 0) throw new InvalidOperationException("The active Revit document has no Levels.");
        if (!string.IsNullOrWhiteSpace(requestedName))
        {
            Level? exact = levels.FirstOrDefault(l => string.Equals(l.Name, requestedName, StringComparison.OrdinalIgnoreCase));
            if (exact != null) return exact;
        }
        double target = double.IsFinite(requestedElevation) ? requestedElevation : z;
        return levels.OrderBy(l => Math.Abs(l.Elevation - target)).First();
    }

    private static FamilyInstance? TryLevelPlacement(Document doc, FamilySymbol symbol, Level level, XYZ point)
    {
        using var sub = new SubTransaction(doc);
        try
        {
            sub.Start();
            FamilyInstance instance = doc.Create.NewFamilyInstance(point, symbol, level, StructuralType.NonStructural);
            sub.Commit();
            return instance;
        }
        catch
        {
            try { if (sub.GetStatus() == TransactionStatus.Started) sub.RollBack(); } catch { }
            return null;
        }
    }

    private static IEnumerable<Element> NearbyHosts(Document doc, XYZ point)
    {
        var hosts = new List<Element>();
        hosts.AddRange(new FilteredElementCollector(doc).OfClass(typeof(Wall)).WhereElementIsNotElementType());
        hosts.AddRange(new FilteredElementCollector(doc).OfClass(typeof(Floor)).WhereElementIsNotElementType());
        hosts.AddRange(new FilteredElementCollector(doc).OfClass(typeof(RoofBase)).WhereElementIsNotElementType());
        return hosts
            .Select(h => new { host = h, d = DistanceToBox(point, h.get_BoundingBox(null)) })
            .Where(x => x.d <= MaxHostDistanceFt)
            .OrderBy(x => x.d)
            .Take(20)
            .Select(x => x.host);
    }

    private static FamilyInstance? TryNearestFacePlacement(Document doc, FamilySymbol symbol, XYZ point)
    {
        var options = new Options
        {
            ComputeReferences = true,
            IncludeNonVisibleObjects = false,
            DetailLevel = ViewDetailLevel.Fine
        };
        foreach (Element host in NearbyHosts(doc, point))
        {
            GeometryElement? geometry;
            try { geometry = host.get_Geometry(options); }
            catch { continue; }
            if (geometry == null) continue;

            foreach (Face face in Faces(geometry))
            {
                Reference? reference = face.Reference;
                if (reference == null) continue;
                IntersectionResult? projection;
                try { projection = face.Project(point); }
                catch { continue; }
                if (projection == null || projection.XYZPoint == null || projection.Distance > MaxHostDistanceFt) continue;

                XYZ normal;
                try { normal = face.ComputeNormal(projection.UVPoint); }
                catch { continue; }
                if (normal == null || normal.GetLength() < 1e-9) continue;
                XYZ seed = Math.Abs(normal.Normalize().DotProduct(XYZ.BasisZ)) < 0.9 ? XYZ.BasisZ : XYZ.BasisX;
                XYZ referenceDirection = normal.CrossProduct(seed);
                if (referenceDirection.GetLength() < 1e-9) continue;
                referenceDirection = referenceDirection.Normalize();

                using var sub = new SubTransaction(doc);
                try
                {
                    sub.Start();
                    FamilyInstance instance = doc.Create.NewFamilyInstance(reference, projection.XYZPoint, referenceDirection, symbol);
                    sub.Commit();
                    return instance;
                }
                catch
                {
                    try { if (sub.GetStatus() == TransactionStatus.Started) sub.RollBack(); } catch { }
                }
            }
        }
        return null;
    }

    private static IEnumerable<Face> Faces(GeometryElement geometry)
    {
        foreach (GeometryObject obj in geometry)
        {
            switch (obj)
            {
                case Solid solid when solid.Faces.Size > 0:
                    foreach (Face face in solid.Faces) yield return face;
                    break;
                case GeometryInstance instance:
                    GeometryElement nested;
                    try { nested = instance.GetInstanceGeometry(); }
                    catch { continue; }
                    foreach (Face face in Faces(nested)) yield return face;
                    break;
            }
        }
    }

    private static FamilyInstance? TryNearestHostedPlacement(Document doc, FamilySymbol symbol, Level level, XYZ point)
    {
        foreach (Element host in NearbyHosts(doc, point))
        {
            XYZ hostPoint = ProjectToHost(host, point);
            using var sub = new SubTransaction(doc);
            try
            {
                sub.Start();
                FamilyInstance instance = doc.Create.NewFamilyInstance(hostPoint, symbol, host, level, StructuralType.NonStructural);
                sub.Commit();
                return instance;
            }
            catch
            {
                try { if (sub.GetStatus() == TransactionStatus.Started) sub.RollBack(); } catch { }
            }
        }
        return null;
    }

    private static XYZ ProjectToHost(Element host, XYZ point)
    {
        if (host is Wall wall && wall.Location is LocationCurve lc)
        {
            try
            {
                IntersectionResult? projection = lc.Curve.Project(point);
                if (projection != null) return new XYZ(projection.XYZPoint.X, projection.XYZPoint.Y, point.Z);
            }
            catch { }
        }
        BoundingBoxXYZ? box = host.get_BoundingBox(null);
        if (box == null) return point;
        return new XYZ(
            Math.Clamp(point.X, box.Min.X, box.Max.X),
            Math.Clamp(point.Y, box.Min.Y, box.Max.Y),
            host is Floor or RoofBase ? box.Max.Z : Math.Clamp(point.Z, box.Min.Z, box.Max.Z));
    }

    private static double DistanceToBox(XYZ point, BoundingBoxXYZ? box)
    {
        if (box == null) return double.PositiveInfinity;
        double dx = Math.Max(Math.Max(box.Min.X - point.X, 0), point.X - box.Max.X);
        double dy = Math.Max(Math.Max(box.Min.Y - point.Y, 0), point.Y - box.Max.Y);
        double dz = Math.Max(Math.Max(box.Min.Z - point.Z, 0), point.Z - box.Max.Z);
        return Math.Sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static void Rotate(Document doc, FamilyInstance instance, double radians)
    {
        XYZ point = instance.Location is LocationPoint lp
            ? lp.Point
            : Center(instance.get_BoundingBox(null)) ?? XYZ.Zero;
        Line axis = Line.CreateBound(point, point + XYZ.BasisZ * 10.0);
        ElementTransformUtils.RotateElement(doc, instance.Id, axis, radians);
    }

    private static PlacementResult Snapshot(Document doc, FamilyInstance instance, Family family, FamilySymbol symbol)
    {
        BoundingBoxXYZ? box = instance.get_BoundingBox(null);
        XYZ min = box?.Min ?? XYZ.Zero, max = box?.Max ?? XYZ.Zero;
        var vertices = new List<float>(Math.Min(MaxPreviewVertices * 3, 30_000));
        bool truncated = false;
        try
        {
            GeometryElement? geometry = instance.get_Geometry(new Options { DetailLevel = ViewDetailLevel.Fine, IncludeNonVisibleObjects = false, ComputeReferences = false });
            if (geometry != null) CollectTriangles(geometry, vertices, ref truncated);
        }
        catch { truncated = true; }
        string level = instance.LevelId == ElementId.InvalidElementId ? "" : doc.GetElement(instance.LevelId)?.Name ?? "";
        return new PlacementResult(instance.Id.Value, instance.UniqueId, family.Name, symbol.Name, level,
            new[] { min.X, min.Y, min.Z }, new[] { max.X, max.Y, max.Z }, vertices.ToArray(), truncated, family.FamilyPlacementType.ToString());
    }

    private static void CollectTriangles(GeometryElement geometry, List<float> vertices, ref bool truncated)
    {
        foreach (GeometryObject obj in geometry)
        {
            if (vertices.Count / 3 >= MaxPreviewVertices) { truncated = true; return; }
            switch (obj)
            {
                case GeometryInstance instance:
                    GeometryElement nested = instance.GetInstanceGeometry();
                    CollectTriangles(nested, vertices, ref truncated);
                    break;
                case Solid solid when solid.Faces.Size > 0:
                    foreach (Face face in solid.Faces)
                    {
                        Mesh mesh;
                        try { mesh = face.Triangulate(); } catch { continue; }
                        for (int i = 0; i < mesh.NumTriangles; i++)
                        {
                            MeshTriangle tri = mesh.get_Triangle(i);
                            for (int j = 0; j < 3; j++)
                            {
                                if (vertices.Count / 3 >= MaxPreviewVertices) { truncated = true; return; }
                                XYZ p = tri.get_Vertex(j);
                                vertices.Add((float)p.X); vertices.Add((float)p.Y); vertices.Add((float)p.Z);
                            }
                        }
                    }
                    break;
                case Mesh mesh:
                    for (int i = 0; i < mesh.NumTriangles; i++)
                    {
                        MeshTriangle tri = mesh.get_Triangle(i);
                        for (int j = 0; j < 3; j++)
                        {
                            if (vertices.Count / 3 >= MaxPreviewVertices) { truncated = true; return; }
                            XYZ p = tri.get_Vertex(j);
                            vertices.Add((float)p.X); vertices.Add((float)p.Y); vertices.Add((float)p.Z);
                        }
                    }
                    break;
            }
        }
    }

    private static XYZ? Center(BoundingBoxXYZ? box) => box == null ? null : (box.Min + box.Max) * 0.5;

    private sealed class FamilyLoadOptions : IFamilyLoadOptions
    {
        public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues) { overwriteParameterValues = false; return true; }
        public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues) { source = FamilySource.Project; overwriteParameterValues = false; return true; }
    }
}