using Autodesk.Revit.DB;
using System.IO;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Produces a read-only browser package from the temporary all-model REVEX sync view.
/// Geometry is exported first as REVEX's browser-native Fine-detail tessellation stream,
/// with FBX retained only as a compatibility fallback. Every physical visible element
/// also carries indexed Revit metadata and a bounded loading proxy for immediate UX.
/// </summary>
public sealed class ViewerExportService
{
    private readonly RevexMeshExportService _mesh = new();

    public (string? fbxPath, string? meshPath, string? meshManifestPath, IReadOnlyList<string> meshPagePaths, string metadataPath, int elementCount) Export(Document doc, View3D view, string folder, string? ifcPath)
    {
        Directory.CreateDirectory(folder);

        string? fbxPath = null;
        try
        {
            var views = new ViewSet();
            views.Insert(view);

            var options = new FBXExportOptions
            {
                StopOnError = false,
                WithoutBoundaryEdges = true
            };

            bool ok = doc.Export(folder, "model", views, options);
            if (ok)
            {
                fbxPath = Directory.GetFiles(folder, "*.fbx", SearchOption.TopDirectoryOnly)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .FirstOrDefault();
            }
        }
        catch
        {
            // Metadata/viewer remain usable even if FBX export is unavailable.
        }

        RevexMeshExportService.Result? meshResult = null;
        try
        {
            meshResult = _mesh.Export(doc, view, folder);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("VIEWER", "REVEX browser-native high-detail mesh export failed; FBX remains available as fallback: " + ex.Message);
        }

        var elements = new List<object>();
        var categoryCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        foreach (Element element in new FilteredElementCollector(doc, view.Id)
                     .WhereElementIsNotElementType()
                     .Where(IsViewerRenderableElement))
        {
            try
            {
                Element? type = doc.GetElement(element.GetTypeId());
                BoundingBoxXYZ? box = PhysicalBoundingBox(element, view) ?? element.get_BoundingBox(view);
                string categoryKey = RevitCategoryClassifier.Key(element.Category);
                categoryCounts[categoryKey] = categoryCounts.GetValueOrDefault(categoryKey) + 1;
                string? level = element.LevelId == ElementId.InvalidElementId
                    ? null
                    : doc.GetElement(element.LevelId)?.Name;

                var materials = element.GetMaterialIds(false)
                    .Concat(element.GetMaterialIds(true))
                    .Distinct()
                    .Select(id => doc.GetElement(id))
                    .OfType<Material>()
                    .Select(m => new { id = m.Id.Value, uniqueId = m.UniqueId, name = m.Name, color = new[] { (int)m.Color.Red, (int)m.Color.Green, (int)m.Color.Blue }, transparency = m.Transparency, shininess = m.Shininess, smoothness = m.Smoothness })
                    .ToArray();

                bool curtainContainer = RevexMeshExportService.IsCurtainContainer(element);
                elements.Add(new
                {
                    id = element.Id.Value,
                    uniqueId = element.UniqueId,
                    ifcGuid = ExportUtils.GetExportId(doc, element.Id).ToString("N"),
                    category = element.Category?.Name ?? "",
                    categoryKey,
                    name = element.Name,
                    type = type?.Name ?? "",
                    typeUniqueId = type?.UniqueId,
                    family = ResolveFamilyName(element, type),
                    level,
                    geometryRole = curtainContainer ? "container" : "physical",
                    proxyEligible = !curtainContainer,
                    materials,
                    bbox = box == null ? null : new
                    {
                        min = new[] { box.Min.X, box.Min.Y, box.Min.Z },
                        max = new[] { box.Max.X, box.Max.Y, box.Max.Z },
                        unit = "revit_internal_feet"
                    }
                });
            }
            catch
            {
                // One malformed element must not abort a project sync.
            }
        }

        var levels = new FilteredElementCollector(doc)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .OrderBy(level => level.Elevation)
            .Select(level => new { id = level.Id.Value, uniqueId = level.UniqueId, name = level.Name, elevation = level.Elevation, unit = "revit_internal_feet" })
            .ToArray();
        double projectNorthAngle = 0.0;
        try { projectNorthAngle = doc.ActiveProjectLocation.GetProjectPosition(XYZ.Zero).Angle; } catch { }

        string metadataPath = Path.Combine(folder, "viewer-model.json");
        File.WriteAllText(metadataPath, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.viewer.v2",
            source = new
            {
                documentTitle = doc.Title,
                documentPath = doc.PathName,
                documentUniqueId = doc.ProjectInformation.UniqueId,
                viewName = view.Name,
                viewUniqueId = view.UniqueId,
                exportedAt = DateTime.UtcNow,
                projectNorthAngleRadians = projectNorthAngle,
                coordinateSystem = new { handedness = "revit", horizontal = new[] { "X", "Y" }, vertical = "Z", unit = "feet" }
            },
            levels,
            geometry = new
            {
                authority = ifcPath == null ? null : Path.GetFileName(ifcPath),
                display = meshResult?.ManifestPath == null ? (fbxPath == null ? null : Path.GetFileName(fbxPath)) : "geometry/" + Path.GetFileName(meshResult.ManifestPath),
                displayFallback = fbxPath == null ? null : Path.GetFileName(fbxPath),
                authorityFormat = ifcPath == null ? null : "ifc",
                displayFormat = meshResult?.ManifestPath == null ? (fbxPath == null ? null : "fbx") : "rvxmesh-gzip-pages",
                displayFallbackFormat = fbxPath == null ? null : "fbx",
                highDetail = meshResult == null ? null : new { elements = meshResult.ElementCount, metadataElements = elements.Count, missingMetadataElements = Math.Max(0, elements.Count - meshResult.ElementCount), coverage = elements.Count == 0 ? 1.0 : (double)meshResult.ElementCount / elements.Count, triangles = meshResult.TriangleCount, vertices = meshResult.VertexCount, bytes = meshResult.CompressedBytes }
            },
            geometryFallback = new
            {
                kind = "element-bounding-boxes",
                coordinateSystem = "revit-internal-feet",
                available = elements.Count > 0,
                note = "IFC is the immutable exchange model. REVEX mesh is the browser-native exact Revit tessellation; FBX is retained only as compatibility fallback. Categorized metadata provides an instant loading/index proxy."
            },
            categories = categoryCounts
                .OrderBy(pair => RevitCategoryClassifier.Order(pair.Key))
                .ThenBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair => new { key = pair.Key, count = pair.Value }),
            elements
        }, new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        }));

        CopyOfflineCompanion(folder);
        return (fbxPath, meshResult?.Path, meshResult?.ManifestPath, meshResult?.PagePaths ?? Array.Empty<string>(), metadataPath, elements.Count);
    }


    private static string ResolveFamilyName(Element element, Element? type)
    {
        // Loaded families expose their Family directly through the instance Symbol.
        // System-family types (Walls/Floors/Roofs/etc.) do not have a Family object,
        // but Revit exposes the same grouping identity through ElementType.FamilyName /
        // SYMBOL_FAMILY_NAME_PARAM. Keep Category only as the final deterministic fallback.
        if (element is FamilyInstance familyInstance)
        {
            string loaded = familyInstance.Symbol?.FamilyName ?? familyInstance.Symbol?.Family?.Name ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(loaded)) return loaded.Trim();
        }

        if (type is ElementType elementType)
        {
            try
            {
                string familyName = elementType.FamilyName ?? string.Empty;
                if (!string.IsNullOrWhiteSpace(familyName)) return familyName.Trim();
            }
            catch { }

            try
            {
                string parameterName = elementType.get_Parameter(BuiltInParameter.SYMBOL_FAMILY_NAME_PARAM)?.AsString() ?? string.Empty;
                if (!string.IsNullOrWhiteSpace(parameterName)) return parameterName.Trim();
            }
            catch { }
        }

        try
        {
            string parameterName = type?.get_Parameter(BuiltInParameter.SYMBOL_FAMILY_NAME_PARAM)?.AsString() ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(parameterName)) return parameterName.Trim();
        }
        catch { }

        return (element.Category?.Name ?? type?.Name ?? "System / Other").Trim();
    }

    private static readonly HashSet<string> NonModelCategoryNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Cameras", "Views", "Viewports", "Sheets", "Levels", "Grids", "Reference Planes",
        "Scope Boxes", "Project Information", "Internal Origin", "Survey Point", "Project Base Point",
        "Sections", "Elevations", "Callouts", "Lines", "Model Lines", "Detail Lines"
    };

    private static BoundingBoxXYZ? PhysicalBoundingBox(Element element, View3D view)
    {
        // Family instance bounding boxes can include symbolic/control geometry far outside
        // the visible solid. Use visible instance geometry for selection/navigation bounds.
        if (element is not FamilyInstance)
            return null;

        try
        {
            var options = new Options
            {
                View = view,
                IncludeNonVisibleObjects = false,
                // DetailLevel comes from the Fine REVEX sync view. Revit rejects
                // Options that assign both View and DetailLevel.
                ComputeReferences = false
            };
            GeometryElement? geometry = element.get_Geometry(options);
            if (geometry == null)
                return null;

            XYZ? min = null;
            XYZ? max = null;
            AccumulateGeometryBounds(geometry, ref min, ref max);
            if (min == null || max == null)
                return null;

            return new BoundingBoxXYZ { Min = min, Max = max };
        }
        catch
        {
            return null;
        }
    }

    private static void AccumulateGeometryBounds(GeometryElement geometry, ref XYZ? min, ref XYZ? max)
    {
        foreach (GeometryObject obj in geometry)
        {
            switch (obj)
            {
                case GeometryInstance instance:
                    GeometryElement instanceGeometry = instance.GetInstanceGeometry();
                    AccumulateGeometryBounds(instanceGeometry, ref min, ref max);
                    break;
                case Solid solid when solid.Faces.Size > 0:
                    try
                    {
                        BoundingBoxXYZ box = solid.GetBoundingBox();
                        AddBoundingBox(box, ref min, ref max);
                    }
                    catch { }
                    break;
                case Mesh mesh:
                    foreach (XYZ vertex in mesh.Vertices)
                        AddPoint(vertex, ref min, ref max);
                    break;
            }
        }
    }

    private static void AddBoundingBox(BoundingBoxXYZ box, ref XYZ? min, ref XYZ? max)
    {
        Transform transform = box.Transform ?? Transform.Identity;
        for (int xi = 0; xi <= 1; xi++)
        for (int yi = 0; yi <= 1; yi++)
        for (int zi = 0; zi <= 1; zi++)
        {
            var point = new XYZ(
                xi == 0 ? box.Min.X : box.Max.X,
                yi == 0 ? box.Min.Y : box.Max.Y,
                zi == 0 ? box.Min.Z : box.Max.Z);
            AddPoint(transform.OfPoint(point), ref min, ref max);
        }
    }

    private static void AddPoint(XYZ point, ref XYZ? min, ref XYZ? max)
    {
        min = min == null
            ? point
            : new XYZ(Math.Min(min.X, point.X), Math.Min(min.Y, point.Y), Math.Min(min.Z, point.Z));
        max = max == null
            ? point
            : new XYZ(Math.Max(max.X, point.X), Math.Max(max.Y, point.Y), Math.Max(max.Z, point.Z));
    }

    internal static bool IsViewerRenderableElement(Element element)
    {
        Category? category = element.Category;
        if (category == null || category.CategoryType != CategoryType.Model)
            return false;
        if (element is View || element is SpatialElement || element is ImportInstance ||
            element is BasePoint || element is CurveElement || element is SketchPlane)
            return false;

        string categoryName = category.Name ?? string.Empty;
        if (NonModelCategoryNames.Contains(categoryName))
            return false;

        string normalized = categoryName.Trim().ToLowerInvariant();
        if (normalized.Contains("analytical") || normalized.Contains("reference") ||
            normalized.Contains("room separation") || normalized.Contains("space separation") ||
            normalized.Contains("area boundary") || normalized.Contains("scope box") ||
            ((normalized.Contains("area") || normalized.Contains("zone") || normalized.Contains("boundary")) &&
             (normalized.Contains("lighting") || normalized.Contains("electrical") || normalized.Contains("energy"))))
            return false;

        return element.get_BoundingBox(null) != null;
    }

    private static void CopyOfflineCompanion(string folder)
    {
        string source = Path.Combine(AppPaths.InstallRoot, "Companion");
        if (!Directory.Exists(source))
            return;

        foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
        {
            string relative = Path.GetRelativePath(source, file);
            string target = Path.Combine(folder, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, true);
        }
    }
}
