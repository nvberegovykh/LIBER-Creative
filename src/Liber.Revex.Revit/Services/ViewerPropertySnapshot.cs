using Autodesk.Revit.DB;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Captures the non-geometry Revit facts needed by the Companion inspector without
/// changing the model. Instance values remain instance-scoped; type values are
/// stored once per type by ViewerExportService so large projects do not duplicate
/// the same type parameter payload on every element.
/// </summary>
internal static class ViewerPropertySnapshot
{
    internal sealed record ParameterSnapshot(
        string Name,
        string Value,
        string StorageType,
        object? Raw,
        bool ReadOnly);

    internal sealed record TypeSnapshot(
        long Id,
        string UniqueId,
        string Name,
        string Category,
        string Family,
        long? FamilyId,
        string? FamilyUniqueId,
        IReadOnlyList<ParameterSnapshot> Parameters);

    internal static IReadOnlyList<ParameterSnapshot> CaptureParameters(Document doc, Element? element)
    {
        if (element == null)
            return Array.Empty<ParameterSnapshot>();

        var rows = new List<ParameterSnapshot>();
        foreach (Parameter parameter in element.Parameters)
        {
            try
            {
                if (!parameter.HasValue)
                    continue;

                string name = parameter.Definition?.Name?.Trim() ?? string.Empty;
                if (string.IsNullOrWhiteSpace(name))
                    continue;

                object? raw = null;
                string display = string.Empty;
                switch (parameter.StorageType)
                {
                    case StorageType.String:
                        raw = parameter.AsString();
                        display = parameter.AsString() ?? string.Empty;
                        break;
                    case StorageType.Integer:
                        raw = parameter.AsInteger();
                        display = parameter.AsValueString() ?? parameter.AsInteger().ToString();
                        break;
                    case StorageType.Double:
                        raw = parameter.AsDouble();
                        display = parameter.AsValueString() ?? parameter.AsDouble().ToString("G17", System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    case StorageType.ElementId:
                    {
                        ElementId id = parameter.AsElementId();
                        raw = id.Value;
                        display = doc.GetElement(id)?.Name
                                  ?? parameter.AsValueString()
                                  ?? id.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        break;
                    }
                    default:
                        display = parameter.AsValueString() ?? string.Empty;
                        break;
                }

                if (string.IsNullOrWhiteSpace(display) && raw == null)
                    continue;

                rows.Add(new ParameterSnapshot(
                    name,
                    string.IsNullOrWhiteSpace(display) ? Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty : display.Trim(),
                    parameter.StorageType.ToString(),
                    raw,
                    parameter.IsReadOnly));
            }
            catch
            {
                // A malformed/custom parameter is not allowed to abort the BIM sync.
            }
        }

        return rows
            .OrderBy(row => row.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(row => row.Value, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    internal static TypeSnapshot CaptureType(Document doc, Element type)
    {
        var (familyName, familyId, familyUniqueId) = ResolveFamily(type, type);
        return new TypeSnapshot(
            type.Id.Value,
            type.UniqueId,
            type.Name,
            type.Category?.Name ?? string.Empty,
            familyName,
            familyId,
            familyUniqueId,
            CaptureParameters(doc, type));
    }

    internal static (string name, long? id, string? uniqueId) ResolveFamily(Element element, Element? type)
    {
        try
        {
            Family? family = element switch
            {
                FamilyInstance instance => instance.Symbol?.Family,
                FamilySymbol symbol => symbol.Family,
                _ => null
            };
            if (family != null)
                return (family.Name, family.Id.Value, family.UniqueId);
        }
        catch { }

        string name = string.Empty;
        if (element is FamilyInstance familyInstance)
        {
            try { name = familyInstance.Symbol?.FamilyName ?? string.Empty; } catch { }
        }

        if (string.IsNullOrWhiteSpace(name) && type is ElementType elementType)
        {
            try { name = elementType.FamilyName ?? string.Empty; } catch { }
            if (string.IsNullOrWhiteSpace(name))
            {
                try { name = elementType.get_Parameter(BuiltInParameter.SYMBOL_FAMILY_NAME_PARAM)?.AsString() ?? string.Empty; } catch { }
            }
        }

        if (string.IsNullOrWhiteSpace(name))
            name = element.Category?.Name ?? type?.Name ?? "System / Other";

        return (name.Trim(), null, null);
    }

    internal static Element? ResolveHost(Element element)
    {
        try
        {
            return element is FamilyInstance instance ? instance.Host : null;
        }
        catch
        {
            return null;
        }
    }

    internal static string? ResolveWorkset(Document doc, Element element)
    {
        try
        {
            return doc.GetWorksetTable().GetWorkset(element.WorksetId)?.Name;
        }
        catch
        {
            return null;
        }
    }
}
