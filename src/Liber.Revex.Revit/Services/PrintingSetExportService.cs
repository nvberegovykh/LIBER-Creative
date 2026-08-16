using Autodesk.Revit.DB;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Exports every saved Revit View/Sheet Set as one immutable combined PDF and,
/// for every page in that set, a second immutable one-page PDF exported directly
/// by Revit from the same authoritative view/sheet. REVEX Docs can therefore open
/// and share a selected sheet as an actual single-page PDF instead of a page anchor
/// into the multi-page set. No print-set/view/sheet settings are modified.
/// </summary>
public sealed class PrintingSetExportService
{
    public sealed record Result(string ManifestPath, IReadOnlyList<string> PdfPaths, int SetCount, int SheetCount);

    public Result Export(Document doc, string folder, string revision)
    {
        Directory.CreateDirectory(folder);
        string pdfFolder = Path.Combine(folder, "printing-sets");
        Directory.CreateDirectory(pdfFolder);

        var savedSets = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSheetSet))
            .Cast<ViewSheetSet>()
            .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var sets = new List<object>();
        var pdfPaths = new List<string>();
        int totalSheets = 0;

        if (savedSets.Count == 0)
        {
            var allSheets = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSheet))
                .Cast<ViewSheet>()
                .Where(s => !s.IsPlaceholder && s.CanBePrinted)
                .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (allSheets.Count > 0)
                ExportOne(doc, pdfFolder, revision, "all-sheets", "All Sheets", null, allSheets.Cast<View>().ToList(), sets, pdfPaths, ref totalSheets);
        }
        else
        {
            foreach (ViewSheetSet set in savedSets)
            {
                var views = set.OrderedViewList
                    .Where(v => v != null && !v.IsTemplate && v.CanBePrinted)
                    .ToList();
                if (views.Count == 0) continue;
                ExportOne(doc, pdfFolder, revision, Safe(set.UniqueId), set.Name, set.UniqueId, views, sets, pdfPaths, ref totalSheets);
            }
        }

        string manifestPath = Path.Combine(folder, "printing-sets.json");
        File.WriteAllText(manifestPath, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.printing-sets.v2",
            revision,
            documentTitle = doc.Title,
            documentUniqueId = doc.ProjectInformation.UniqueId,
            exportedAt = DateTime.UtcNow,
            source = "saved-revit-view-sheet-sets",
            sets
        }, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }), Encoding.UTF8);

        return new Result(manifestPath, pdfPaths, sets.Count, totalSheets);
    }

    private static void ExportOne(
        Document doc,
        string pdfFolder,
        string revision,
        string stableId,
        string name,
        string? uniqueId,
        IReadOnlyList<View> views,
        List<object> sets,
        List<string> pdfPaths,
        ref int totalSheets)
    {
        string baseName = $"{Safe(name)}__{revision}";
        string expected = Path.Combine(pdfFolder, baseName + ".pdf");
        DeleteIfPresent(expected);

        var options = new PDFExportOptions
        {
            Combine = true,
            FileName = baseName,
            AlwaysUseRaster = false,
            ViewLinksInBlue = false
        };
        var ids = views.Select(v => v.Id).ToList();
        bool ok = doc.Export(pdfFolder, ids, options);
        string? pdf = ResolveExport(pdfFolder, baseName, expected);
        if (!ok || string.IsNullOrWhiteSpace(pdf) || !File.Exists(pdf))
        {
            RevexDiagnostics.Warn("DOCS", $"Printing set export skipped/failed: {name}");
            return;
        }

        pdfPaths.Add(pdf);

        string setToken = Safe(stableId);
        if (setToken.Length > 24) setToken = setToken[..24];
        string singlePageFolder = Path.Combine(pdfFolder, "sheets", Safe(stableId));
        Directory.CreateDirectory(singlePageFolder);
        var pages = new List<object>(views.Count);

        for (int index = 0; index < views.Count; index++)
        {
            View view = views[index];
            ViewSheet? sheet = view as ViewSheet;
            string sheetNumber = sheet?.SheetNumber ?? view.Name;
            string singlePageBaseName = $"{setToken}__{index + 1:D3}__{Safe(sheetNumber)}__{revision}";
            string singleExpected = Path.Combine(singlePageFolder, singlePageBaseName + ".pdf");
            DeleteIfPresent(singleExpected);

            var singleOptions = new PDFExportOptions
            {
                Combine = true,
                FileName = singlePageBaseName,
                AlwaysUseRaster = false,
                ViewLinksInBlue = false
            };
            bool singleOk = doc.Export(singlePageFolder, new List<ElementId> { view.Id }, singleOptions);
            string? singlePdf = ResolveExport(singlePageFolder, singlePageBaseName, singleExpected);
            if (!singleOk || string.IsNullOrWhiteSpace(singlePdf) || !File.Exists(singlePdf))
                throw new InvalidOperationException($"REVEX could not export the required single-page PDF for {name} / {sheetNumber}.");

            pdfPaths.Add(singlePdf);
            string relativeSingle = Path.GetRelativePath(pdfFolder, singlePdf).Replace('\\', '/');
            pages.Add(new
            {
                page = index + 1,
                kind = sheet == null ? "view" : "sheet",
                sheetId = view.Id.Value,
                sheetUniqueId = view.UniqueId,
                sheetNumber,
                sheetName = view.Name,
                currentRevision = sheet == null ? null : CurrentRevision(sheet),
                printable = view.CanBePrinted,
                singlePagePdf = Path.Combine("printing-sets", relativeSingle).Replace('\\', '/'),
                singlePageFileName = Path.GetFileName(singlePdf)
            });
        }

        totalSheets += pages.Count;
        sets.Add(new
        {
            id = stableId,
            uniqueId,
            name,
            pdf = Path.Combine("printing-sets", Path.GetFileName(pdf)).Replace('\\', '/'),
            fileName = Path.GetFileName(pdf),
            pageCount = pages.Count,
            pages
        });
        RevexDiagnostics.Info("DOCS", $"Printing set exported: {name}; pages={pages.Count}; setPdf={pdf}; singlePagePdfs={pages.Count}");
    }

    private static string? ResolveExport(string folder, string baseName, string expected)
    {
        if (File.Exists(expected)) return expected;
        return Directory.GetFiles(folder, "*.pdf", SearchOption.TopDirectoryOnly)
            .Where(path => Path.GetFileNameWithoutExtension(path).StartsWith(baseName, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
    }

    private static void DeleteIfPresent(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static string? CurrentRevision(ViewSheet sheet)
    {
        try
        {
            return sheet.get_Parameter(BuiltInParameter.SHEET_CURRENT_REVISION)?.AsValueString()
                ?? sheet.get_Parameter(BuiltInParameter.SHEET_CURRENT_REVISION)?.AsString();
        }
        catch { return null; }
    }

    private static string Safe(string? value)
    {
        string text = string.IsNullOrWhiteSpace(value) ? "set" : value.Trim();
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var sb = new StringBuilder(text.Length);
        foreach (char c in text)
            sb.Append(invalid.Contains(c) || char.IsControl(c) ? '_' : c);
        string result = sb.ToString().Trim().Trim('.');
        return string.IsNullOrWhiteSpace(result) ? "set" : result.Length > 90 ? result[..90] : result;
    }
}
