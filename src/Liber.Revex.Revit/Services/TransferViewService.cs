using Autodesk.Revit.DB;
using Liber.Revex.Revit.Models;

namespace Liber.Revex.Revit.Services;

public sealed class TransferViewService
{
    public View3D CreateTransferView(
        Document doc,
        View3D source,
        IReadOnlyList<MaterialAssignment> assignments)
    {
        using var tx = new Transaction(doc, "LIBER REVEX transfer view");
        tx.Start();

        if (!source.CanViewBeDuplicated(ViewDuplicateOption.Duplicate))
            throw new InvalidOperationException("The selected 3D view cannot be duplicated for a Rendair transfer.");

        ElementId duplicateId = source.Duplicate(ViewDuplicateOption.Duplicate);
        var transferView = (View3D)doc.GetElement(duplicateId);

        transferView.Name = MakeUniqueViewName(doc, $"__RENDAIR__{source.Name}");

        // Decouple the transfer view from production view-template graphics.
        if (transferView.ViewTemplateId != ElementId.InvalidElementId)
            transferView.ViewTemplateId = ElementId.InvalidElementId;

        if (transferView.CanModifyDisplayStyle())
            transferView.DisplayStyle = DisplayStyle.Shading;

        if (transferView.CanModifyDetailLevel())
            transferView.DetailLevel = ViewDetailLevel.Fine;

        ElementId solidFillId = FindSolidFill(doc);

        foreach (MaterialAssignment a in assignments)
        {
            Element? element = doc.GetElement(a.ElementId);
            if (element?.Category == null)
                continue;

            var ogs = new OverrideGraphicSettings();

            var color = new Color(a.R, a.G, a.B);
            ogs.SetSurfaceForegroundPatternColor(color);
            ogs.SetSurfaceForegroundPatternVisible(true);

            if (solidFillId != ElementId.InvalidElementId)
                ogs.SetSurfaceForegroundPatternId(solidFillId);

            ogs.SetSurfaceTransparency(a.Transparency);

            // Keep geometry edges readable for the AI base image.
            ogs.SetProjectionLineColor(new Color(55, 55, 55));

            try
            {
                transferView.SetElementOverrides(a.ElementId, ogs);
            }
            catch
            {
                // Some non-graphical/model helper elements cannot be overridden.
            }
        }

        tx.Commit();
        return transferView;
    }

    public void DeleteTransferView(Document doc, ElementId viewId)
    {
        if (viewId == ElementId.InvalidElementId)
            return;

        using var tx = new Transaction(doc, "Delete LIBER REVEX transfer view");
        tx.Start();
        try
        {
            doc.Delete(viewId);
            tx.Commit();
        }
        catch
        {
            tx.RollBack();
        }
    }

    private static ElementId FindSolidFill(Document doc)
    {
        foreach (FillPatternElement fpe in new FilteredElementCollector(doc)
                     .OfClass(typeof(FillPatternElement))
                     .Cast<FillPatternElement>())
        {
            try
            {
                if (fpe.GetFillPattern().IsSolidFill)
                    return fpe.Id;
            }
            catch { }
        }

        return ElementId.InvalidElementId;
    }

    private static string MakeUniqueViewName(Document doc, string baseName)
    {
        string clean = baseName.Length > 180 ? baseName[..180] : baseName;
        var names = new HashSet<string>(
            new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Select(v => v.Name),
            StringComparer.OrdinalIgnoreCase);

        if (!names.Contains(clean))
            return clean;

        for (int i = 2; i < 999; i++)
        {
            string candidate = $"{clean}_{i}";
            if (!names.Contains(candidate))
                return candidate;
        }

        return $"{clean}_{Guid.NewGuid():N}"[..Math.Min(200, clean.Length + 33)];
    }
}
