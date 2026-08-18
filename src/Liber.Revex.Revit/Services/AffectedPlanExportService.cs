using Autodesk.Revit.DB;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Exports only printable native Revit plan views affected by changes observed
/// since the last successful REVEX sync. Exports are produced from Revit itself,
/// never from the Companion viewport. The manifest also carries normalized
/// view-space rectangles for still-existing changed elements so the server can
/// add revision clouds/change numbers to the exported PDF without guessing.
/// Deleted-element changes conservatively mark all printable plan views; when
/// Revit can no longer locate the deleted element, the report lists it as
/// unlocated rather than inventing a cloud location.
/// </summary>
public sealed class AffectedPlanExportService
{
    public sealed record Result(string ManifestPath, IReadOnlyList<string> PdfPaths, int ViewCount, int ChangedElementCount);

    public Result Export(Document doc, string folder, string revision, RevexAffectedViewTracker.Snapshot changes)
    {
        string planFolder = Path.Combine(folder, "affected-plans");
        Directory.CreateDirectory(planFolder);
        var views = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
            .Where(v => !v.IsTemplate && v.CanBePrinted)
            .Where(v => v.ViewType is ViewType.FloorPlan or ViewType.CeilingPlan or ViewType.AreaPlan or ViewType.EngineeringPlan)
            .OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var affected = new List<object>();
        var pdfs = new List<string>();
        var failures = new List<string>();
        foreach (ViewPlan view in views)
        {
            long[] visibleChanged;
            string reason;
            if (changes.HadDeletion)
            {
                visibleChanged = changes.ElementIds.ToArray();
                reason = "deletion-conservative";
            }
            else
            {
                var visible = new FilteredElementCollector(doc, view.Id)
                    .WhereElementIsNotElementType()
                    .ToElementIds()
                    .Select(id => id.Value)
                    .ToHashSet();
                visibleChanged = changes.ElementIds.Where(visible.Contains).ToArray();
                if (visibleChanged.Length == 0) continue;
                reason = "changed-elements-visible-in-view";
            }

            var cloudEvidence = ChangedRegions(doc, view, visibleChanged);
            string baseName = $"{Safe(view.Name)}__{revision}";
            string expected = Path.Combine(planFolder, baseName + ".pdf");
            try { if (File.Exists(expected)) File.Delete(expected); } catch { }
            var options = new PDFExportOptions
            {
                Combine = true,
                FileName = baseName,
                AlwaysUseRaster = false,
                ViewLinksInBlue = false
            };
            bool ok = false;
            try { ok = doc.Export(planFolder, new List<ElementId> { view.Id }, options); }
            catch (Exception ex) { RevexDiagnostics.Warn("PLANS", $"Affected plan export failed: {view.Name}; {ex.Message}"); }
            string? pdf = File.Exists(expected) ? expected : Directory.GetFiles(planFolder, "*.pdf")
                .Where(path => Path.GetFileNameWithoutExtension(path).StartsWith(baseName, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
            if (!ok || string.IsNullOrWhiteSpace(pdf) || !File.Exists(pdf)) { failures.Add(view.Name); continue; }
            pdfs.Add(pdf);

            Level? level = view.GenLevel;
            affected.Add(new
            {
                id = view.Id.Value,
                uniqueId = view.UniqueId,
                name = view.Name,
                viewType = view.ViewType.ToString(),
                levelId = level?.Id.Value,
                levelUniqueId = level?.UniqueId,
                levelName = level?.Name,
                levelElevation = level?.Elevation,
                reason,
                changedElementIds = visibleChanged,
                changedRegions = cloudEvidence.regions,
                unlocatedChangedElementIds = cloudEvidence.unlocated,
                cloudCoordinateSystem = "normalized-revit-plan-crop-v1",
                pdf = Path.Combine("affected-plans", Path.GetFileName(pdf)).Replace('\\', '/'),
                fileName = Path.GetFileName(pdf)
            });
        }

        if (failures.Count > 0) throw new InvalidOperationException("Affected Revit plan export failed for: " + string.Join(", ", failures));

        string manifest = Path.Combine(folder, "affected-plan-views.json");
        File.WriteAllText(manifest, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.affected-plan-views.v2",
            revision,
            documentTitle = doc.Title,
            documentUniqueId = doc.ProjectInformation.UniqueId,
            exportedAt = DateTime.UtcNow,
            source = "native-revit-plan-views",
            sourceRevision = revision,
            changedElementCount = changes.ElementIds.Count,
            hadDeletion = changes.HadDeletion,
            views = affected
        }, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }), Encoding.UTF8);

        RevexDiagnostics.Info("PLANS", $"Affected plan export complete: changed={changes.ElementIds.Count}; views={affected.Count}; cloudEvidence=v2");
        return new Result(manifest, pdfs, affected.Count, changes.ElementIds.Count);
    }

    private static (object[] regions, long[] unlocated) ChangedRegions(Document doc, ViewPlan view, IEnumerable<long> elementIds)
    {
        var regions = new List<object>();
        var unlocated = new List<long>();
        BoundingBoxXYZ crop;
        try { crop = view.CropBox; }
        catch
        {
            return (Array.Empty<object>(), elementIds.Distinct().ToArray());
        }

        Transform cropInverse;
        try { cropInverse = (crop.Transform ?? Transform.Identity).Inverse; }
        catch { cropInverse = Transform.Identity; }
        double minX = Math.Min(crop.Min.X, crop.Max.X), maxX = Math.Max(crop.Min.X, crop.Max.X);
        double minY = Math.Min(crop.Min.Y, crop.Max.Y), maxY = Math.Max(crop.Min.Y, crop.Max.Y);
        double width = Math.Max(maxX - minX, 1e-9), height = Math.Max(maxY - minY, 1e-9);

        foreach (long rawId in elementIds.Distinct())
        {
            Element? element = null;
            try { element = doc.GetElement(new ElementId(rawId)); } catch { }
            if (element == null) { unlocated.Add(rawId); continue; }
            BoundingBoxXYZ? box = null;
            try { box = element.get_BoundingBox(view) ?? element.get_BoundingBox(null); } catch { }
            if (box == null) { unlocated.Add(rawId); continue; }

            double left = double.PositiveInfinity, right = double.NegativeInfinity;
            double bottom = double.PositiveInfinity, top = double.NegativeInfinity;
            Transform elementTransform = box.Transform ?? Transform.Identity;
            for (int xi = 0; xi <= 1; xi++)
            for (int yi = 0; yi <= 1; yi++)
            for (int zi = 0; zi <= 1; zi++)
            {
                XYZ local = new(
                    xi == 0 ? box.Min.X : box.Max.X,
                    yi == 0 ? box.Min.Y : box.Max.Y,
                    zi == 0 ? box.Min.Z : box.Max.Z);
                XYZ model = elementTransform.OfPoint(local);
                XYZ projected = cropInverse.OfPoint(model);
                left = Math.Min(left, projected.X); right = Math.Max(right, projected.X);
                bottom = Math.Min(bottom, projected.Y); top = Math.Max(top, projected.Y);
            }
            if (!double.IsFinite(left) || !double.IsFinite(bottom)) { unlocated.Add(rawId); continue; }

            double nLeft = Math.Clamp((left - minX) / width, 0.0, 1.0);
            double nRight = Math.Clamp((right - minX) / width, 0.0, 1.0);
            double nBottom = Math.Clamp((bottom - minY) / height, 0.0, 1.0);
            double nTop = Math.Clamp((top - minY) / height, 0.0, 1.0);
            // Keep a visible cloud region even for point-like or tiny families.
            const double minSpan = 0.006;
            if (nRight - nLeft < minSpan)
            {
                double c = (nLeft + nRight) * 0.5;
                nLeft = Math.Max(0, c - minSpan * 0.5); nRight = Math.Min(1, c + minSpan * 0.5);
            }
            if (nTop - nBottom < minSpan)
            {
                double c = (nBottom + nTop) * 0.5;
                nBottom = Math.Max(0, c - minSpan * 0.5); nTop = Math.Min(1, c + minSpan * 0.5);
            }

            regions.Add(new
            {
                elementId = rawId,
                uniqueId = element.UniqueId,
                category = element.Category?.Name ?? "",
                normalizedRect = new { left = nLeft, bottom = nBottom, right = nRight, top = nTop },
                evidence = "current-revit-element-bounds-projected-to-plan-crop"
            });
        }
        return (regions.ToArray(), unlocated.ToArray());
    }

    private static string Safe(string? value)
    {
        string text = string.IsNullOrWhiteSpace(value) ? "plan" : value.Trim();
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var sb = new StringBuilder(text.Length);
        foreach (char c in text) sb.Append(invalid.Contains(c) || char.IsControl(c) ? '_' : c);
        string result = sb.ToString().Trim().Trim('.');
        return string.IsNullOrWhiteSpace(result) ? "plan" : result.Length > 90 ? result[..90] : result;
    }
}
