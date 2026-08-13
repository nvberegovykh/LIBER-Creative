using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Liber.Revex.Revit.Models;
using Liber.Revex.Revit.Services;
using System.Collections.Concurrent;

namespace Liber.Revex.Revit.Revit;

public sealed class RevitRequestHandler : IExternalEventHandler
{
    private readonly ConcurrentQueue<RevitRequest> _queue = new();
    private readonly TransferPackageService _transfer = new();

    public void Enqueue(RevitRequest request)
    {
        _queue.Enqueue(request);
        RevexDiagnostics.Info("REVIT", $"ExternalEvent queued: kind={request.Kind}; correlationId={request.CorrelationId}; initiator={request.Initiator}; queueDepth={_queue.Count}");
    }

    public void Execute(UIApplication app)
    {
        if (!_queue.TryDequeue(out RevitRequest? request))
            return;

        long queueWaitMs = Math.Max(0L, (long)(DateTime.UtcNow - request.EnqueuedAtUtc).TotalMilliseconds);
        using RevexDiagnostics.WorkflowScope workflow = RevexDiagnostics.BeginWorkflow(
            "REVIT-" + request.Kind, request.Initiator, request.CorrelationId);
        RevexDiagnostics.Stage("REVIT", "EXTERNAL_EVENT", "STARTED",
            $"kind={request.Kind}; queueWaitMs={queueWaitMs}; correlationId={request.CorrelationId}; initiator={request.Initiator}");
        RevitRequestResult result;
        try
        {
            UIDocument? uidoc = app.ActiveUIDocument;
            if (uidoc == null)
            {
                result = RevitRequestResult.Fail("No active Revit document.");
            }
            else
            {
                RevexDiagnostics.Info("REVIT", $"Document={uidoc.Document.Title}; ActiveView={uidoc.ActiveView?.Name ?? "<none>"}");
                bool requiresProjectBinding = request.Kind == RevitRequestKind.ResolveActiveProjectBinding ||
                                              request.Kind == RevitRequestKind.SyncRevexProject ||
                                              (request.Kind == RevitRequestKind.GbxmlEngineering &&
                                               request.EngineeringSettings?.AuditOnly == false);
                RevexProjectBinding? resolvedBinding = requiresProjectBinding
                    ? SettingsService.ResolveProjectBinding(uidoc.Document, request.ProjectBindingCandidate, request.AllowProjectRebind)
                    : null;
                result = request.Kind switch
                {
                    RevitRequestKind.ResolveActiveProjectBinding =>
                        RevitRequestResult.Bound("Active Revit document project binding resolved.", resolvedBinding!),
                    RevitRequestKind.CaptureCurrentView =>
                        CaptureCurrent(uidoc, request.Settings),
                    RevitRequestKind.CaptureBatch =>
                        CaptureBatch(uidoc, request.Settings),
                    RevitRequestKind.SyncRevexProject =>
                        SyncProject(uidoc, request.Settings, resolvedBinding!),
                    RevitRequestKind.GbxmlEngineering =>
                        RunGbxmlEngineering(app, uidoc, request.EngineeringSettings ?? new GbxmlEngineeringSettings()),
                    _ => RevitRequestResult.Fail("Unsupported request.")
                };
                if (resolvedBinding != null)
                    result = result with { ProjectBinding = resolvedBinding };
            }
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("REVIT", "ExternalEvent request failed.", ex);
            result = RevitRequestResult.Fail(ex.Message);
        }

        RevexDiagnostics.Info("REVIT", $"ExternalEvent complete: success={result.Success}; {result.Message}");
        bool callbackSuccess = true;
        try
        {
            request.Callback(result);
            RevexDiagnostics.Stage("REVIT", "CALLBACK", "PASSED",
                $"callbackSuccess=true; kind={request.Kind}; correlationId={request.CorrelationId}");
        }
        catch (Exception ex)
        {
            callbackSuccess = false;
            RevexDiagnostics.Error("REVIT", "UI callback disappeared or failed.", ex);
            RevexDiagnostics.Stage("REVIT", "CALLBACK", "FAILED",
                $"callbackSuccess=false; kind={request.Kind}; correlationId={request.CorrelationId}; error={ex.Message}");
        }
        workflow.Complete(result.Success && callbackSuccess,
            $"kind={request.Kind}; resultSuccess={result.Success}; callbackSuccess={callbackSuccess}; queueWaitMs={queueWaitMs}");
    }

    public string GetName() => "LIBER REVEX Revit requests";

    private RevitRequestResult CaptureCurrent(UIDocument uidoc, RenderSettings settings)
    {
        RevexDiagnostics.Info("CAPTURE", "CaptureCurrent entered.");
        if (uidoc.ActiveView is not View3D view || view.IsTemplate)
            return RevitRequestResult.Fail("Open the exact Revit 3D view you want to render, then send again.");

        TransferPackage package = _transfer.Capture(uidoc.Document, view, settings);
        RevexDiagnostics.Info("CAPTURE", "Captured image: " + package.ImagePath);
        return RevitRequestResult.Ok($"Captured {view.Name}.", new[] { package });
    }

    private RevitRequestResult CaptureBatch(UIDocument uidoc, RenderSettings settings)
    {
        string token = settings.BatchNameContains?.Trim() ?? "";
        if (token.Length == 0)
            return RevitRequestResult.Fail("Enter a batch view-name token.");

        List<View3D> views = new FilteredElementCollector(uidoc.Document)
            .OfClass(typeof(View3D))
            .Cast<View3D>()
            .Where(v => !v.IsTemplate &&
                        v.Name.Contains(token, StringComparison.OrdinalIgnoreCase))
            .OrderBy(v => v.Name)
            .ToList();

        if (views.Count == 0)
            return RevitRequestResult.Fail($"No 3D views contain '{token}' in their name.");

        var packages = new List<TransferPackage>();
        foreach (View3D view in views)
            packages.Add(_transfer.Capture(uidoc.Document, view, settings));

        return RevitRequestResult.Ok($"Captured {packages.Count} views.", packages);
    }

    private RevitRequestResult SyncProject(UIDocument uidoc, RenderSettings settings, RevexProjectBinding binding)
    {
        RevexDiagnostics.Info("SYNC", "Creating temporary all-model sync view.");
        BridgeSettings bridge = SettingsService.Load();
        bridge.LiberProjectId = binding.ProjectId;
        bridge.LiberSpecProjectId = binding.SpecProjectId;
        var changedSnapshot = RevexAffectedViewTracker.Peek(uidoc.Document);
        RevexSyncOutput sync;
        using (RevexAffectedViewTracker.Suspend())
        {
            using RevexSyncViewScope syncView = RevexSyncViewService.Create(uidoc.Document);
            sync = new RevexSyncService().Sync(uidoc.Document, syncView.View, bridge, binding, changedSnapshot);
        }
        // Clear only after the complete revision committed and the temporary sync view
        // rolled back under tracker suspension. A failed sync leaves user changes dirty.
        RevexAffectedViewTracker.Commit(uidoc.Document);
        RevexDiagnostics.Info("SYNC", "Revit sync service completed: " + sync.RootFolder);
        return RevitRequestResult.Synced(
            $"REVEX revision ready: IFC + viewer data + {sync.ScheduleCount} schedules + {sync.ElementCount} model elements + {sync.AffectedPlanViewCount} affected plan views.",
            sync);
    }
    private RevitRequestResult RunGbxmlEngineering(UIApplication app, UIDocument uidoc, GbxmlEngineeringSettings settings)
    {
        RevexDiagnostics.Info("GBXML", "Engineering gbXML request entered.");
        GbxmlEngineeringOutput? output = null;
        try
        {
            output = new GbxmlEngineeringService().Run(app, uidoc.Document, settings);
            bool ok = GbxmlEngineeringService.IsSuccessful(output, settings.AuditOnly);
            string detail = settings.AuditOnly
                ? $"gbXML audit finished: {output.Status}."
                : ok
                    ? $"gbXML exported: {output.GbxmlPath}"
                    : $"gbXML export blocked: {output.Status}. See the report and REVEX diagnostics.";
            return ok
                ? RevitRequestResult.Engineered(detail, output)
                : RevitRequestResult.EngineeringFailed(detail, output);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("GBXML", "Engineering gbXML execution failed.", ex);
            return RevitRequestResult.EngineeringFailed(ex.Message, output);
        }
    }

}
