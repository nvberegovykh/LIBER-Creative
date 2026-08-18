using Autodesk.Revit.UI;
using Liber.Revex.Revit.Services;
using System.Collections.Concurrent;

namespace Liber.Revex.Revit.Revit;

internal sealed class RevexFamilyPlacementExternalHandler : IExternalEventHandler
{
    internal sealed record WorkItem(
        FamilyPlacementService.PlacementRequest? Placement,
        FamilyPlacementService.TransformRequest? Transform,
        Action<FamilyPlacementService.PlacementResult?, string?> Callback);

    private readonly ConcurrentQueue<WorkItem> _queue = new();
    private readonly FamilyPlacementService _service = new();

    internal void Enqueue(WorkItem item) => _queue.Enqueue(item);

    public void Execute(UIApplication app)
    {
        if (!_queue.TryDequeue(out WorkItem? item)) return;
        FamilyPlacementService.PlacementResult? result = null;
        string? error = null;
        try
        {
            var doc = app.ActiveUIDocument?.Document
                ?? throw new InvalidOperationException("No active Revit document is available for BIM-family placement.");
            result = item.Placement != null
                ? _service.Place(doc, item.Placement)
                : item.Transform != null
                    ? _service.Transform(doc, item.Transform)
                    : throw new InvalidOperationException("REVEX family placement request is empty.");
            RevexDiagnostics.Info("FAMILY", $"REVEX family placement complete: id={result.ElementId}; family={result.Family}; type={result.Type}; level={result.Level}.");
        }
        catch (Exception ex)
        {
            error = ex.Message;
            RevexDiagnostics.Error("FAMILY", "REVEX BIM-family placement failed.", ex);
        }
        try { item.Callback(result, error); }
        catch (Exception ex) { RevexDiagnostics.Warn("FAMILY", "Family placement callback failed: " + ex.Message); }
    }

    public string GetName() => "LIBER REVEX BIM family placement";
}
