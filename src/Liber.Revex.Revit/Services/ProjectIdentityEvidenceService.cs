using Autodesk.Revit.DB;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Liber.Revex.Revit.Services;

public sealed record ProjectIdentityEvidence(
    string Digest,
    string DisplayName,
    IReadOnlyList<string> Sheets,
    IReadOnlyDictionary<string, string> Fields,
    IReadOnlyList<string> Tokens,
    IReadOnlyDictionary<string, string> Normalized,
    IReadOnlyDictionary<string, string> NormalizedProvenance);

/// <summary>
/// Reads current-project identity only from the active Revit document. Project
/// Information plus printable T/Z/title-sheet and title-block parameters are
/// evidence; browser state, file paths, prior revisions and reference projects are not.
/// </summary>
public static class ProjectIdentityEvidenceService
{
    private static readonly Regex TokenPattern = new("[A-Z0-9]+", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly HashSet<string> Stop = new(StringComparer.OrdinalIgnoreCase)
    {
        "THE", "AND", "FOR", "PROJECT", "SHEET", "TITLE", "GENERAL", "NOTES", "NEW", "YORK", "NY"
    };

    public static ProjectIdentityEvidence Capture(Document doc)
    {
        var fields = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var sheets = new List<string>();
        Add(fields, "document.title", doc.Title);
        Add(fields, "document.projectInformationUniqueId", doc.ProjectInformation?.UniqueId);
        CaptureElement("project", doc.ProjectInformation, fields);

        foreach (ViewSheet sheet in new FilteredElementCollector(doc)
                     .OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
                     .Where(IsIdentitySheet)
                     .OrderBy(row => row.SheetNumber, StringComparer.OrdinalIgnoreCase))
        {
            string label = $"{sheet.SheetNumber} · {sheet.Name}".Trim(' ', '·');
            sheets.Add(label);
            string prefix = "sheet." + SafeKey(sheet.SheetNumber) + ".";
            Add(fields, prefix + "number", sheet.SheetNumber);
            Add(fields, prefix + "name", sheet.Name);
            CaptureElement(prefix + "parameter", sheet, fields);
            foreach (Element titleBlock in new FilteredElementCollector(doc, sheet.Id)
                         .OfCategory(BuiltInCategory.OST_TitleBlocks)
                         .WhereElementIsNotElementType())
            {
                CaptureElement(prefix + "titleBlock", titleBlock, fields);
                Element? type = doc.GetElement(titleBlock.GetTypeId());
                CaptureElement(prefix + "titleBlockType", type, fields);
            }
        }

        string displayName = First(fields,
            "project.Project Name", "project.Project Name (1)", "project.Address",
            "project.Building Name", "document.title");
        string canonical = string.Join("\n", fields.Select(row => row.Key.Trim() + "=" + row.Value.Trim()));
        string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        string[] tokens = TokenPattern.Matches(canonical)
            .Select(match => match.Value.ToUpperInvariant())
            .Where(token => token.Length >= 2 && !Stop.Contains(token))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(token => token, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        (IReadOnlyDictionary<string, string> normalized,
         IReadOnlyDictionary<string, string> normalizedProvenance) = NormalizeProjectFields(fields);
        RevexDiagnostics.Info("PROJECT", $"Captured active-document T/Z identity evidence: document={doc.Title}; sheets={sheets.Count}; fields={fields.Count}; digest={digest[..16]}…");
        return new ProjectIdentityEvidence(
            digest, displayName, sheets, fields, tokens,
            normalized, normalizedProvenance);
    }

    public static bool ProjectNameMatches(ProjectIdentityEvidence evidence, string? projectName)
    {
        string requested = projectName?.Trim() ?? "";
        if (requested.Length == 0) return true;
        string[] significant = TokenPattern.Matches(requested)
            .Select(match => match.Value.ToUpperInvariant())
            .Where(token => token.Length >= 2 && !Stop.Contains(token))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (significant.Length == 0) return true;
        var available = evidence.Tokens.ToHashSet(StringComparer.OrdinalIgnoreCase);
        string[] numeric = significant.Where(token => token.Any(char.IsDigit)).ToArray();
        if (numeric.Length > 0 && numeric.Any(available.Contains)) return true;
        return significant.Count(available.Contains) >= Math.Min(2, significant.Length);
    }

    private static bool IsIdentitySheet(ViewSheet sheet)
    {
        if (sheet.IsPlaceholder) return false;
        string number = (sheet.SheetNumber ?? "").Trim().ToUpperInvariant();
        string name = (sheet.Name ?? "").Trim().ToUpperInvariant();
        return number.StartsWith("T", StringComparison.Ordinal) ||
               number.StartsWith("Z", StringComparison.Ordinal) ||
               name.Contains("TITLE", StringComparison.Ordinal) ||
               name.Contains("COVER", StringComparison.Ordinal) ||
               name.Contains("ZONING", StringComparison.Ordinal) ||
               name.Contains("CODE", StringComparison.Ordinal);
    }

    private static void CaptureElement(string prefix, Element? element, IDictionary<string, string> fields)
    {
        if (element == null) return;
        foreach (Parameter parameter in element.Parameters.Cast<Parameter>())
        {
            try
            {
                string name = parameter.Definition?.Name?.Trim() ?? "";
                if (name.Length == 0) continue;
                string value = parameter.AsValueString()?.Trim() ?? parameter.AsString()?.Trim() ?? "";
                if (value.Length == 0) continue;
                Add(fields, prefix + "." + name, value);
            }
            catch { }
        }
    }

    private static void Add(IDictionary<string, string> fields, string key, string? value)
    {
        string text = value?.Trim() ?? "";
        if (text.Length == 0) return;
        string candidate = key;
        int suffix = 1;
        while (fields.ContainsKey(candidate) && !string.Equals(fields[candidate], text, StringComparison.Ordinal))
            candidate = key + " (" + (++suffix) + ")";
        fields[candidate] = text;
    }

    private static string First(IReadOnlyDictionary<string, string> fields, params string[] keys)
    {
        foreach (string key in keys)
            if (fields.TryGetValue(key, out string? value) && !string.IsNullOrWhiteSpace(value)) return value;
        return "";
    }

    private static (IReadOnlyDictionary<string, string> Values, IReadOnlyDictionary<string, string> Provenance)
        NormalizeProjectFields(IReadOnlyDictionary<string, string> fields)
    {
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var provenance = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        void Set(string name, params string[] acceptedKeys)
        {
            foreach (string key in acceptedKeys)
            {
                if (!fields.TryGetValue(key, out string? value) || string.IsNullOrWhiteSpace(value))
                    continue;
                values[name] = value.Trim();
                provenance[name] = key;
                return;
            }

            // A title block may expose an explicit Project-prefixed field. Generic
            // Address/City fields are deliberately excluded because they frequently
            // identify the architect or consultant instead of the project site.
            foreach (string key in acceptedKeys.Where(row => row.StartsWith("project.Project", StringComparison.OrdinalIgnoreCase)))
            {
                string parameter = key["project.".Length..];
                KeyValuePair<string, string>? match = fields.FirstOrDefault(row =>
                    row.Key.StartsWith("sheet.", StringComparison.OrdinalIgnoreCase) &&
                    row.Key.EndsWith("." + parameter, StringComparison.OrdinalIgnoreCase) &&
                    !string.IsNullOrWhiteSpace(row.Value));
                if (match is { } found && !string.IsNullOrWhiteSpace(found.Key))
                {
                    values[name] = found.Value.Trim();
                    provenance[name] = found.Key;
                    return;
                }
            }
        }

        Set("title", "project.Project Name", "project.Building Name", "document.title");
        Set("address", "project.Project Address");
        Set("city", "project.Project City", "project.Project City/Town", "project.City", "project.City/Town");
        Set("state", "project.Project State", "project.Project State/Province", "project.State", "project.State/Province");
        Set("zip", "project.Project ZIP", "project.Project Zip Code", "project.Project Postal Code", "project.ZIP", "project.Zip Code", "project.Postal Code");
        Set("projectNumber", "project.Project Number", "project.Number");
        Set("buildingName", "project.Building Name");
        Set("clientName", "project.Client Name", "project.Owner Name");
        return (values, provenance);
    }

    private static string SafeKey(string? value) => Regex.Replace(value?.Trim() ?? "sheet", "[^A-Za-z0-9._-]+", "_");
}
