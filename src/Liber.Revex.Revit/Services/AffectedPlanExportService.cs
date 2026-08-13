using Autodesk.Revit.DB;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Exports only printable native Revit plan views affected by changes observed
/// since the last successful REVEX sync. Exports are produced from Revit itself,
/// never from the Companion viewport. Deleted-element changes conservatively mark
/// all printable plan views because Revit no longer exposes the deleted element's
/// former visibility/level membership.
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
                pdf = Path.Combine("affected-plans", Path.GetFileName(pdf)).Replace('\\', '/'),
                fileName = Path.GetFileName(pdf)
            });
        }

        if (failures.Count > 0) throw new InvalidOperationException("Affected Revit plan export failed for: " + string.Join(", ", failures));

        string manifest = Path.Combine(folder, "affected-plan-views.json");
        File.WriteAllText(manifest, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.affected-plan-views.v1",
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

        RevexDiagnostics.Info("PLANS", $"Affected plan export complete: changed={changes.ElementIds.Count}; views={affected.Count}");
        return new Result(manifest, pdfs, affected.Count, changes.ElementIds.Count);
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
