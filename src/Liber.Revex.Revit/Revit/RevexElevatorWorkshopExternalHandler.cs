using Autodesk.Revit.UI;
using Liber.Revex.Revit.Services;
using System.Collections.Concurrent;

namespace Liber.Revex.Revit.Revit;

internal sealed class RevexElevatorWorkshopExternalHandler : IExternalEventHandler
{
    internal sealed record WorkItem(
        ElevatorWorkshopService.WorkshopRequest Request,
        Action<ElevatorWorkshopService.WorkshopResult?, string?> Callback);

    private readonly ConcurrentQueue<WorkItem> _queue = new();
    private readonly ElevatorWorkshopService _service = new();

    internal void Enqueue(WorkItem item) => _queue.Enqueue(item);

    public void Execute(UIApplication app)
    {
        if (!_queue.TryDequeue(out WorkItem? item)) return;
        ElevatorWorkshopService.WorkshopResult? result = null;
        string? error = null;
        try
        {
            var document = app.ActiveUIDocument?.Document
                ?? throw new InvalidOperationException("No active Revit project is available for the elevator workshop.");
            result = _service.Execute(document, item.Request);
            RevexDiagnostics.Info(
                "ELEVATOR_WORKSHOP",
                $"Isolated elevator transition complete: focus={item.Request.FocusId}; state={result.State}; candidate={result.CandidatePath}.");
        }
        catch (Exception ex)
        {
            error = ex.Message;
            RevexDiagnostics.Error("ELEVATOR_WORKSHOP", "Isolated elevator transition failed.", ex);
        }

        try { item.Callback(result, error); }
        catch (Exception ex) { RevexDiagnostics.Warn("ELEVATOR_WORKSHOP", "Workshop callback failed: " + ex.Message); }
    }

    public string GetName() => "LIBER REVEX isolated elevator workshop";
}
