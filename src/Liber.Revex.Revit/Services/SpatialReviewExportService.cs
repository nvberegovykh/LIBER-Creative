using Autodesk.Revit.DB;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Adds non-geometric review spatial data to viewer-model.json without polluting
/// the exact physical mesh contract. Rooms, MEP Spaces and Areas remain Revit-owned
/// source data and are exported from the same immutable revision as the BIM model.
/// </summary>
public sealed class SpatialReviewExportService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public int AppendToViewerMetadata(Document doc, View3D view, string metadataPath)
    {
        if (!File.Exists(metadataPath))
            throw new FileNotFoundException("REVEX viewer metadata does not exist.", metadataPath);

        var boundaryOptions = new SpatialElementBoundaryOptions
        {
            SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish
        };
        var rows = new List<object>();

        foreach (SpatialElement spatial in new FilteredElementCollector(doc)
                     .WhereElementIsNotElementType()
                     .OfType<SpatialElement>()
                     .OrderBy(element => element.Id.Value))
        {
            string category = spatial.Category?.Name?.Trim() ?? string.Empty;
            if (!IsReviewSpatialCategory(category)) continue;

            try
            {
                BoundingBoxXYZ? box = spatial.get_BoundingBox(view) ?? spatial.get_BoundingBox(null);
                var loops = new List<double[][]>();
                IList<IList<BoundarySegment>>? boundaries = spatial.GetBoundarySegments(boundaryOptions);
                if (boundaries != null)
                {
                    foreach (IList<BoundarySegment> boundary in boundaries)
                    {
                        var points = new List<double[]>();
                        foreach (BoundarySegment segment in boundary)
                        {
                            IList<XYZ> tessellated = segment.GetCurve().Tessellate();
                            for (int i = 0; i < tessellated.Count; i++)
                            {
                                XYZ point = tessellated[i];
                                if (points.Count > 0 && i == 0 && Same(points[^1], point)) continue;
                                points.Add(new[] { point.X, point.Y, point.Z });
                            }
                        }
                        if (points.Count >= 3) loops.Add(points.ToArray());
                    }
                }

                // Ignore unplaced/unbounded legacy records. The review surface should only
                // expose spatial positions that materially exist in the current model.
                if (box == null && loops.Count == 0) continue;

                string? level = spatial.LevelId == ElementId.InvalidElementId
                    ? null
                    : doc.GetElement(spatial.LevelId)?.Name;
                string number = spatial.LookupParameter("Number")?.AsString()?.Trim() ?? string.Empty;

                rows.Add(new
                {
                    id = spatial.Id.Value,
                    uniqueId = spatial.UniqueId,
                    category,
                    kind = category.Equals("Rooms", StringComparison.OrdinalIgnoreCase) ? "room"
                        : category.Equals("Spaces", StringComparison.OrdinalIgnoreCase) ? "space"
                        : "area",
                    name = spatial.Name,
                    number,
                    level,
                    geometryRole = "spatial-review",
                    proxyEligible = false,
                    bbox = box == null ? null : new
                    {
                        min = new[] { box.Min.X, box.Min.Y, box.Min.Z },
                        max = new[] { box.Max.X, box.Max.Y, box.Max.Z },
                        unit = "revit_internal_feet"
                    },
                    boundaryLoops = loops,
                    coordinateSystem = "revit-internal-feet"
                });
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Warn("VIEWER", $"Spatial review export skipped {category} {spatial.Id.Value}: {ex.Message}");
            }
        }

        JsonNode? parsed = JsonNode.Parse(File.ReadAllText(metadataPath));
        if (parsed is not JsonObject root)
            throw new InvalidOperationException("viewer-model.json is not a JSON object.");

        root["spatialElements"] = JsonSerializer.SerializeToNode(rows, JsonOptions);
        root["spatialReview"] = JsonSerializer.SerializeToNode(new
        {
            schema = "liber.revex.spatial-review.v1",
            authority = "same-current-revit-revision",
            categories = new[] { "Rooms", "Spaces", "Areas" },
            count = rows.Count,
            representation = "boundary-loops-and-bounds",
            writeBack = false
        }, JsonOptions);
        File.WriteAllText(metadataPath, root.ToJsonString(JsonOptions));
        RevexDiagnostics.Info("VIEWER", $"Spatial review metadata complete: positions={rows.Count}; source=same current Revit revision.");
        return rows.Count;
    }

    private static bool IsReviewSpatialCategory(string category) =>
        category.Equals("Rooms", StringComparison.OrdinalIgnoreCase) ||
        category.Equals("Spaces", StringComparison.OrdinalIgnoreCase) ||
        category.Equals("Areas", StringComparison.OrdinalIgnoreCase);

    private static bool Same(double[] prior, XYZ point) =>
        prior.Length >= 3 &&
        Math.Abs(prior[0] - point.X) < 1e-9 &&
        Math.Abs(prior[1] - point.Y) < 1e-9 &&
        Math.Abs(prior[2] - point.Z) < 1e-9;
}
