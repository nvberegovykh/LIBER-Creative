using Autodesk.Revit.DB;
using Liber.Revex.Revit.Models;
using System.Text.Json;
using System.IO;

namespace Liber.Revex.Revit.Services;

public sealed class TransferPackageService
{
    private readonly MaterialClassifier _classifier = new();
    private readonly TransferViewService _transferViews = new();
    private readonly ViewCaptureService _capture = new();

    public TransferPackage Capture(Document doc, View3D source, RenderSettings settings)
    {
        string project = Sanitize(doc.Title);
        string view = Sanitize(source.Name);
        string stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss_fff");
        string folder = Path.Combine(AppPaths.Transfers, project, $"{stamp}_{view}");
        Directory.CreateDirectory(folder);

        IReadOnlyList<MaterialAssignment> assignments =
            settings.AutoMaterialIntent
                ? _classifier.ClassifyVisibleElements(doc, source)
                : Array.Empty<MaterialAssignment>();

        View3D? transferView = null;
        try
        {
            transferView = settings.AutoMaterialIntent
                ? _transferViews.CreateTransferView(doc, source, assignments)
                : source;

            string image = _capture.ExportPng(doc, transferView, folder, settings.PixelSize);

            var materials = assignments
                .GroupBy(a => new { a.Semantic, a.Prompt })
                .Select(g => new MaterialSummary(g.Key.Semantic, g.Count(), g.Key.Prompt))
                .OrderByDescending(m => m.ElementCount)
                .ToList();

            string prompt = PromptBuilder.Build(source.Name, settings, materials);
            string promptPath = Path.Combine(folder, "prompt.txt");
            File.WriteAllText(promptPath, prompt);

            string manifestPath = Path.Combine(folder, "transfer.json");
            var manifest = new
            {
                project = doc.Title,
                sourceView = source.Name,
                capturedAt = DateTimeOffset.Now,
                image,
                settings,
                materials,
                detectedAssignments = assignments.Select(a => new
                {
                    elementId = a.ElementId.Value,
                    a.ElementName,
                    a.Category,
                    a.Semantic,
                    rgb = new[] { a.R, a.G, a.B },
                    a.Transparency,
                    a.MatchedRule
                })
            };

            File.WriteAllText(manifestPath,
                JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));

            return new TransferPackage(source.Name, folder, image, promptPath, manifestPath, prompt, materials);
        }
        finally
        {
            if (transferView != null && transferView.Id != source.Id)
                _transferViews.DeleteTransferView(doc, transferView.Id);
        }
    }

    private static string Sanitize(string value)
    {
        char[] invalid = Path.GetInvalidFileNameChars();
        string cleaned = new(value.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        cleaned = cleaned.Trim();
        return string.IsNullOrWhiteSpace(cleaned) ? "Untitled" : cleaned;
    }
}
