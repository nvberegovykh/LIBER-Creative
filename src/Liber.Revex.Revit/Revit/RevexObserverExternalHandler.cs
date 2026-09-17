using Autodesk.Revit.UI;
using Liber.Revex.Revit.Services;
using System.Collections.Concurrent;

namespace Liber.Revex.Revit.Revit;

internal sealed class RevexObserverExternalHandler : IExternalEventHandler
{
    internal sealed record WorkItem(
        ObserverFamilyService.InspectRequest Request,
        Action<ObserverFamilyService.InspectResult?, string?> Callback);

    private readonly ConcurrentQueue<WorkItem> _queue = new();
    private readonly ObserverFamilyService _service = new();

    internal void Enqueue(WorkItem item) => _queue.Enqueue(item);

    public void Execute(UIApplication app)
    {
        if (!_queue.TryDequeue(out WorkItem? item)) return;

        ObserverFamilyService.InspectResult? result = null;
        string? error = null;

        try
        {
            var document = app.ActiveUIDocument?.Document
                ?? throw new InvalidOperationException("No active Revit project is available for Observer inspection.");

            result = _service.Inspect(document, item.Request);
            RevexDiagnostics.Info(
                "OBSERVER",
                $"Read-only family inspection complete: element={item.Request.ElementId}; focus={item.Request.FocusId}; nodes={result.Nodes.Count}; edges={result.Edges.Count}.");
        }
        catch (Exception ex)
        {
            error = ex.Message;
            RevexDiagnostics.Error("OBSERVER", "Read-only REVEX family inspection failed.", ex);
        }

        try { item.Callback(result, error); }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("OBSERVER", "Observer inspection callback failed: " + ex.Message);
        }
    }

    public string GetName() => "LIBER REVEX read-only Observer family inspection";
}
