using Autodesk.Revit.DB;
using System.IO;

namespace Liber.Revex.Revit.Services;

public sealed class ViewCaptureService
{
    public string ExportPng(Document doc, View view, string folder, int pixelSize)
    {
        Directory.CreateDirectory(folder);
        string stem = Path.Combine(folder, "base");

        using var options = new ImageExportOptions
        {
            ExportRange = ExportRange.SetOfViews,
            FilePath = stem,
            FitDirection = FitDirectionType.Horizontal,
            HLRandWFViewsFileType = ImageFileType.PNG,
            ShadowViewsFileType = ImageFileType.PNG,
            ImageResolution = ImageResolution.DPI_150,
            ZoomType = ZoomFitType.FitToPage,
            PixelSize = Math.Clamp(pixelSize, 1024, 8192)
        };

        options.SetViewsAndSheets(new List<ElementId> { view.Id });
        doc.ExportImage(options);

        string? image = Directory
            .EnumerateFiles(folder, "*.png", SearchOption.TopDirectoryOnly)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();

        if (image == null)
            throw new InvalidOperationException("Revit completed image export but no PNG was found.");

        // Normalize the name for the web bridge.
        string normalized = Path.Combine(folder, "base.png");
        if (!string.Equals(image, normalized, StringComparison.OrdinalIgnoreCase))
        {
            if (File.Exists(normalized))
                File.Delete(normalized);
            File.Move(image, normalized);
        }

        return normalized;
    }
}
