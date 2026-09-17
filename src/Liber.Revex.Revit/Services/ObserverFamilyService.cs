using Autodesk.Revit.DB;
using System.Globalization;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Read-only deep inspection of a loaded Revit family from the active project.
/// The service opens an editable family document only as an observation surface,
/// creates no Revit transaction, saves nothing, and always closes the family
/// document with saveModified=false.
/// </summary>
internal sealed class ObserverFamilyService
{
    internal sealed record InspectRequest(long ElementId, string FocusId, string RequestId);

    internal sealed record FamilyParameterSnapshot(
        string Name,
        string StorageType,
        bool IsInstance,
        bool IsReporting,
        string? Formula,
        string? Value);

    internal sealed record ObserverNode(
        long Id,
        string Class,
        string Kind,
        string Name,
        string Category,
        double[]? BboxMinFt,
        double[]? BboxMaxFt,
        IReadOnlyDictionary<string, string> Parameters,
        IReadOnlyDictionary<string, string> Associations);

    internal sealed record ObserverEdge(long From, long To, string Kind, string? Detail = null);

    internal sealed record ProjectInstanceSnapshot(
        long ElementId,
        string UniqueId,
        string Family,
        string Type,
        string PlacementType,
        long? HostElementId,
        string? HostUniqueId,
        string? HostFaceStableReference,
        double[] TransformOrigin,
        double[] TransformBasisX,
        double[] TransformBasisY,
        double[] TransformBasisZ,
        double[]? BboxMinFt,
        double[]? BboxMaxFt);

    internal sealed record InspectResult(
        string Schema,
        string FocusId,
        string RequestId,
        string ObservedAtUtc,
        ProjectInstanceSnapshot Instance,
        string FamilyDocumentTitle,
        string FamilyPlacementType,
        string FamilyCategory,
        IReadOnlyList<FamilyParameterSnapshot> FamilyParameters,
        IReadOnlyList<ObserverNode> Nodes,
        IReadOnlyList<ObserverEdge> Edges,
        IReadOnlyDictionary<string, int> Counts,
        IReadOnlyList<string> Warnings);

    private static readonly HashSet<string> InterestingParameterNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Visible", "Material", "Cuts Geometry", "Work Plane", "Is Reference",
        "Defines Origin", "Label", "Value", "Solid/Void", "Family and Type",
        "Subcategory", "Wall Closure", "Host", "Reference"
    };

    internal InspectResult Inspect(Document projectDocument, InspectRequest request)
    {
        if (projectDocument.IsFamilyDocument)
            throw new InvalidOperationException("Observer family inspection must start from the active project document.");

        FamilyInstance instance = projectDocument.GetElement(new ElementId(request.ElementId)) as FamilyInstance
            ?? throw new InvalidOperationException($"Element {request.ElementId} is not a Revit FamilyInstance.");

        FamilySymbol symbol = instance.Symbol
            ?? throw new InvalidOperationException($"Family instance {request.ElementId} has no active symbol.");
        Family family = symbol.Family
            ?? throw new InvalidOperationException($"Family instance {request.ElementId} has no family definition.");
        if (family.IsInPlace)
            throw new InvalidOperationException("In-place families are not opened by the read-only Observer family inspector.");

        ProjectInstanceSnapshot projectSnapshot = SnapshotProjectInstance(projectDocument, instance, family, symbol);
        List<string> warnings = new();
        Document? familyDocument = null;

        try
        {
            familyDocument = projectDocument.EditFamily(family);
            FamilyManager manager = familyDocument.FamilyManager;
            List<FamilyParameterSnapshot> familyParameters = SnapshotFamilyParameters(manager, warnings);
            var nodes = new List<ObserverNode>();
            var edges = new List<ObserverEdge>();
            var seenEdges = new HashSet<string>(StringComparer.Ordinal);

            foreach (Element element in new FilteredElementCollector(familyDocument)
                         .WhereElementIsNotElementType()
                         .ToElements())
            {
                string kind = Classify(element);
                if (kind.Length == 0) continue;

                nodes.Add(SnapshotNode(familyDocument, manager, element, kind));

                try
                {
                    foreach (ElementId dependentId in element.GetDependentElements(null))
                        AddEdge(edges, seenEdges, element.Id.Value, dependentId.Value, "dependent");
                }
                catch (Exception ex)
                {
                    warnings.Add($"Dependent-elements read failed for {element.Id.Value}: {ex.Message}");
                }

                if (element is Dimension dimension)
                {
                    try
                    {
                        ReferenceArray refs = dimension.References;
                        for (int i = 0; i < refs.Size; ++i)
                        {
                            Reference r = refs.get_Item(i);
                            if (r.ElementId == ElementId.InvalidElementId) continue;
                            string? stable = null;
                            try { stable = r.ConvertToStableRepresentation(familyDocument); } catch { }
                            AddEdge(edges, seenEdges, dimension.Id.Value, r.ElementId.Value, "dimension-reference", stable);
                        }
                    }
                    catch (Exception ex)
                    {
                        warnings.Add($"Dimension-reference read failed for {element.Id.Value}: {ex.Message}");
                    }
                }

                if (element is FamilyInstance nested && nested.Host != null)
                    AddEdge(edges, seenEdges, nested.Id.Value, nested.Host.Id.Value, "nested-host");
            }

            var counts = nodes
                .GroupBy(node => node.Kind)
                .OrderBy(group => group.Key, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);

            string category = familyDocument.OwnerFamily?.FamilyCategory?.Name ?? family.FamilyCategory?.Name ?? "";
            string placement = familyDocument.OwnerFamily?.FamilyPlacementType.ToString() ?? family.FamilyPlacementType.ToString();

            return new InspectResult(
                "liber.revex.observer.family-inspection.v1",
                request.FocusId,
                request.RequestId,
                DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                projectSnapshot,
                familyDocument.Title,
                placement,
                category,
                familyParameters,
                nodes,
                edges,
                counts,
                warnings);
        }
        finally
        {
            if (familyDocument != null)
            {
                try { familyDocument.Close(false); }
                catch (Exception ex)
                {
                    RevexDiagnostics.Warn("OBSERVER", "Read-only family document close failed: " + ex.Message);
                }
            }
        }
    }

    private static ProjectInstanceSnapshot SnapshotProjectInstance(
        Document document,
        FamilyInstance instance,
        Family family,
        FamilySymbol symbol)
    {
        Transform transform = instance.GetTransform();
        BoundingBoxXYZ? bb = instance.get_BoundingBox(null);
        Element? host = instance.Host;
        string? hostFace = null;
        try { hostFace = instance.HostFace?.ConvertToStableRepresentation(document); } catch { }

        return new ProjectInstanceSnapshot(
            instance.Id.Value,
            instance.UniqueId,
            family.Name,
            symbol.Name,
            family.FamilyPlacementType.ToString(),
            host?.Id.Value,
            host?.UniqueId,
            hostFace,
            Point(transform.Origin),
            Point(transform.BasisX),
            Point(transform.BasisY),
            Point(transform.BasisZ),
            bb == null ? null : Point(bb.Min),
            bb == null ? null : Point(bb.Max));
    }

    private static List<FamilyParameterSnapshot> SnapshotFamilyParameters(FamilyManager manager, List<string> warnings)
    {
        var output = new List<FamilyParameterSnapshot>();
        FamilyType? type = manager.CurrentType;

        foreach (FamilyParameter parameter in manager.GetParameters().OrderBy(p => p.Definition.Name, StringComparer.Ordinal))
        {
            string? value = null;
            if (type != null)
            {
                try
                {
                    value = parameter.StorageType switch
                    {
                        StorageType.Double => type.AsDouble(parameter)?.ToString("R", CultureInfo.InvariantCulture),
                        StorageType.Integer => type.AsInteger(parameter)?.ToString(CultureInfo.InvariantCulture),
                        StorageType.String => type.AsString(parameter),
                        StorageType.ElementId => type.AsElementId(parameter)?.Value.ToString(CultureInfo.InvariantCulture),
                        _ => null
                    };
                }
                catch (Exception ex)
                {
                    warnings.Add($"Family parameter value read failed for {parameter.Definition.Name}: {ex.Message}");
                }
            }

            string? formula = null;
            try { formula = parameter.Formula; } catch { }

            output.Add(new FamilyParameterSnapshot(
                parameter.Definition.Name,
                parameter.StorageType.ToString(),
                parameter.IsInstance,
                parameter.IsReporting,
                formula,
                value));
        }

        return output;
    }

    private static ObserverNode SnapshotNode(Document document, FamilyManager manager, Element element, string kind)
    {
        BoundingBoxXYZ? bb = null;
        try { bb = element.get_BoundingBox(null); } catch { }

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var associations = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (Parameter p in element.Parameters)
        {
            string name;
            try { name = p.Definition.Name; }
            catch { continue; }

            try
            {
                FamilyParameter? associated = manager.GetAssociatedFamilyParameter(p);
                if (associated != null)
                    associations[name] = associated.Definition.Name;
            }
            catch { }

            if (!InterestingParameterNames.Contains(name)) continue;
            string? value = ParameterValue(p, document);
            if (value != null) values[name] = value;
        }

        if (element is Dimension dimension)
        {
            try
            {
                if (dimension.FamilyLabel != null)
                    values["FamilyLabel"] = dimension.FamilyLabel.Definition.Name;
            }
            catch { }
            try
            {
                if (!string.IsNullOrWhiteSpace(dimension.ValueString))
                    values["ValueString"] = dimension.ValueString;
            }
            catch { }
        }

        if (element is GenericForm form)
            values["IsSolid"] = form.IsSolid ? "true" : "false";
        if (element is ReferencePlane plane)
            values["ReferencePlaneName"] = plane.Name;
        if (element is FamilyInstance nested)
        {
            values["NestedFamily"] = nested.Symbol?.Family?.Name ?? "";
            values["NestedType"] = nested.Symbol?.Name ?? "";
        }

        return new ObserverNode(
            element.Id.Value,
            element.GetType().FullName ?? element.GetType().Name,
            kind,
            SafeName(element),
            element.Category?.Name ?? "",
            bb == null ? null : Point(bb.Min),
            bb == null ? null : Point(bb.Max),
            values,
            associations);
    }

    private static string Classify(Element element) => element switch
    {
        Wall => "wall",
        ReferencePlane => "reference-plane",
        Dimension => "dimension",
        GenericForm => "generic-form",
        FamilyInstance => "nested-family",
        _ => ""
    };

    private static string SafeName(Element element)
    {
        try { return element.Name ?? ""; }
        catch { return ""; }
    }

    private static string? ParameterValue(Parameter parameter, Document document)
    {
        try
        {
            string? formatted = parameter.AsValueString();
            if (!string.IsNullOrWhiteSpace(formatted)) return formatted;
        }
        catch { }

        try
        {
            return parameter.StorageType switch
            {
                StorageType.String => parameter.AsString(),
                StorageType.Integer => parameter.AsInteger().ToString(CultureInfo.InvariantCulture),
                StorageType.Double => parameter.AsDouble().ToString("R", CultureInfo.InvariantCulture),
                StorageType.ElementId => ElementIdValue(parameter.AsElementId(), document),
                _ => null
            };
        }
        catch { return null; }
    }

    private static string ElementIdValue(ElementId id, Document document)
    {
        if (id == ElementId.InvalidElementId) return "-1";
        Element? referenced = document.GetElement(id);
        return referenced == null ? id.Value.ToString(CultureInfo.InvariantCulture) : $"{id.Value}:{SafeName(referenced)}";
    }

    private static double[] Point(XYZ xyz) => new[] { xyz.X, xyz.Y, xyz.Z };

    private static void AddEdge(
        List<ObserverEdge> edges,
        HashSet<string> seen,
        long from,
        long to,
        string kind,
        string? detail = null)
    {
        if (from <= 0 || to <= 0 || from == to) return;
        string key = $"{from}|{to}|{kind}|{detail}";
        if (!seen.Add(key)) return;
        edges.Add(new ObserverEdge(from, to, kind, detail));
    }
}
