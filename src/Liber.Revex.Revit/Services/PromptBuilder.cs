using Liber.Revex.Revit.Models;
using System.Text;

namespace Liber.Revex.Revit.Services;

public static class PromptBuilder
{
    public static string Build(
        string viewName,
        RenderSettings settings,
        IReadOnlyList<MaterialSummary> materials)
    {
        var sb = new StringBuilder();

        sb.AppendLine("PHOTOREALISTIC ARCHITECTURAL SALES VISUALIZATION.");
        sb.AppendLine("Treat the uploaded Revit image as fixed project geometry and fixed camera.");
        sb.AppendLine("Do not redesign, reinterpret, simplify, extend, crop away, or invent architectural geometry.");
        sb.AppendLine("Preserve massing, floor and roof edges, wall locations, openings, glazing extents, doors, windows, stairs, railings, built-ins, proportions, camera position, perspective, and visible context.");
        sb.AppendLine("Flat/approximate colors in the Revit transfer image represent material intent only; replace them with physically plausible real-world materials while preserving their boundaries.");
        sb.AppendLine("Use believable PBR-scale texture, joints, roughness, reflection, transparency, and construction logic. Avoid plastic-looking surfaces, fantasy details, excessive bloom, oversaturation, warped lines, duplicated elements, extra windows/doors, or AI decoration.");
        sb.AppendLine("Lighting must be physically plausible, balanced, high-end real-estate/architecture photography with natural contrast and clean verticals while preserving the source camera.");
        sb.AppendLine($"Environment: {settings.Environment}.");
        sb.AppendLine($"Staging: {settings.Staging}.");
        sb.AppendLine($"People: {settings.People}.");
        sb.AppendLine($"Source Revit view: {viewName}.");

        if (materials.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("MATERIAL INTENT:");
            foreach (MaterialSummary mat in materials.OrderByDescending(m => m.ElementCount))
            {
                if (!string.IsNullOrWhiteSpace(mat.Prompt))
                    sb.AppendLine($"- {mat.Semantic}: {mat.Prompt} ({mat.ElementCount} visible elements)");
            }
        }

        sb.AppendLine();
        sb.AppendLine("Priority order: 1) geometry/camera fidelity, 2) material boundary fidelity, 3) physically realistic light/material response, 4) sales-quality polish.");
        return sb.ToString().Trim();
    }
}
