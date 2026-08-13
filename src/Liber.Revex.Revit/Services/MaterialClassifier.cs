using Autodesk.Revit.DB;
using Liber.Revex.Revit.Models;
using System.Text;
using System.Text.Json;
using System.IO;

namespace Liber.Revex.Revit.Services;

public sealed class MaterialClassifier
{
    private readonly IReadOnlyList<MaterialRule> _rules;

    public MaterialClassifier()
    {
        _rules = LoadRules();
    }

    public IReadOnlyList<MaterialAssignment> ClassifyVisibleElements(Document doc, View view)
    {
        var result = new List<MaterialAssignment>();

        IEnumerable<Element> elements = new FilteredElementCollector(doc, view.Id)
            .WhereElementIsNotElementType()
            .Where(e => e.Category is { CategoryType: CategoryType.Model });

        foreach (Element element in elements)
        {
            if (element.Category == null)
                continue;

            string haystack = BuildHaystack(doc, element);
            MaterialRule? rule = MatchRule(element.Category.Name, haystack);
            if (rule == null)
                continue;

            byte[] rgb = rule.Rgb.Length >= 3 ? rule.Rgb : new byte[] { 190, 190, 190 };
            result.Add(new MaterialAssignment(
                element.Id,
                SafeName(element),
                element.Category.Name,
                rule.Semantic,
                rgb[0], rgb[1], rgb[2],
                Math.Clamp(rule.Transparency, 0, 90),
                rule.Prompt,
                rule.Name));
        }

        return result;
    }

    private MaterialRule? MatchRule(string category, string haystack)
    {
        foreach (MaterialRule rule in _rules.OrderByDescending(r => r.Priority))
        {
            bool categoryMatch = rule.Categories.Length == 0 ||
                rule.Categories.Any(c => category.Contains(c, StringComparison.OrdinalIgnoreCase));

            bool nameMatch = rule.MatchAny.Length == 0 ||
                rule.MatchAny.Any(token => haystack.Contains(token, StringComparison.OrdinalIgnoreCase));

            if (categoryMatch && nameMatch)
                return rule;
        }

        return null;
    }

    private static string BuildHaystack(Document doc, Element element)
    {
        var sb = new StringBuilder();
        sb.Append(' ').Append(element.Category?.Name);
        sb.Append(' ').Append(SafeName(element));

        Element? type = doc.GetElement(element.GetTypeId());
        if (type != null)
            sb.Append(' ').Append(SafeName(type));

        if (element is FamilyInstance fi)
        {
            sb.Append(' ').Append(fi.Symbol?.FamilyName);
            sb.Append(' ').Append(fi.Symbol?.Name);
        }

        try
        {
            foreach (ElementId matId in element.GetMaterialIds(false))
            {
                if (doc.GetElement(matId) is Material mat)
                    sb.Append(' ').Append(mat.Name);
            }

            foreach (ElementId matId in element.GetMaterialIds(true))
            {
                if (doc.GetElement(matId) is Material mat)
                    sb.Append(' ').Append(mat.Name);
            }
        }
        catch
        {
            // Some elements do not expose materials.
        }

        return sb.ToString();
    }

    private static string SafeName(Element element)
    {
        try { return element.Name ?? ""; }
        catch { return ""; }
    }

    private static IReadOnlyList<MaterialRule> LoadRules()
    {
        AppPaths.Ensure();
        string path = Path.Combine(AppPaths.Config, "material-rules.json");

        try
        {
            string json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<List<MaterialRule>>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? new List<MaterialRule>();
        }
        catch
        {
            return new List<MaterialRule>();
        }
    }
}
