using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Liber.Revex.Revit.Models;
using Liber.Revex.Revit.Services;
using System.Windows.Threading;

namespace Liber.Revex.Revit.Revit;

public sealed class RevitRequestHandler : IExternalEventHandler
{
    private enum PumpState { Idle, WakeOutstanding, Executing, Closed }

    private const int MaxQueuedRequests = 8;
    private const int MaxWakeRetries = 8;
    private readonly object _gate = new();
    private readonly Queue<RevitRequest> _queue = new();
    private readonly Dispatcher _dispatcher = Dispatcher.CurrentDispatcher;
    private readonly TransferPackageService _transfer = new();
    private ExternalEvent? _externalEvent;
    private PumpState _pumpState = PumpState.Idle;
    private long _wakeGeneration;
    private int _wakeRetryCount;
    private bool _retryScheduled;

    public void AttachExternalEvent(ExternalEvent externalEvent)
    {
        ArgumentNullException.ThrowIfNull(externalEvent);
        lock (_gate)
        {
            if (_pumpState == PumpState.Closed)
                throw new ObjectDisposedException(nameof(RevitRequestHandler));
            if (_externalEvent != null && !ReferenceEquals(_externalEvent, externalEvent))
                throw new InvalidOperationException("REVEX Revit request pump is already attached.");
            _externalEvent = externalEvent;
        }
    }

    public void Enqueue(RevitRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Kind == RevitRequestKind.ResolveActiveProjectBinding)
        {
            // Read-only active-document binding recovery is safe to queue implicitly:
            // it reads the active document fingerprint + T/Z identity and the durable
            // REVEX binding keyed to that fingerprint. It creates no transaction and
            // performs no Revit mutation. New/rebound projects still require an explicit
            // user selection during SYNC.
            RevexDiagnostics.Stage("REVIT", "READ_ONLY_BINDING_PROBE_QUEUED", "PASSED",
                $"kind={request.Kind}; initiator={request.Initiator}; queue=bounded-pump");
        }

        long generation = 0;
        bool raise = false;
        string? rejection = null;
        int queueDepth;
        lock (_gate)
        {
            if (_pumpState == PumpState.Closed || _externalEvent == null)
            {
                rejection = "The REVEX Revit request pump is not available. Re-open the REVEX window and try again.";
            }
            else if (_queue.Count >= MaxQueuedRequests)
            {
                rejection = "REVEX is already processing the maximum number of Revit requests. Wait for the current operation to finish and try again.";
            }
            else
            {
                _queue.Enqueue(request);
                if (_pumpState == PumpState.Idle)
                {
                    _pumpState = PumpState.WakeOutstanding;
                    _wakeRetryCount = 0;
                    generation = ++_wakeGeneration;
                    raise = true;
                }
            }
            queueDepth = _queue.Count;
        }

        if (rejection != null)
        {
            FailRequest(request, rejection);
            return;
        }
        RevexDiagnostics.Info("REVIT", $"ExternalEvent queued: kind={request.Kind}; correlationId={request.CorrelationId}; initiator={request.Initiator}; queueDepth={queueDepth}");
        if (raise) TryRaise(generation);
    }

    public void Execute(UIApplication app)
    {
        lock (_gate)
        {
            if (_pumpState == PumpState.Closed) return;
            _pumpState = PumpState.Executing;
            _wakeGeneration++;
            _wakeRetryCount = 0;
            _retryScheduled = false;
        }

        while (true)
        {
            RevitRequest request;
            lock (_gate)
            {
                if (_pumpState == PumpState.Closed) return;
                if (_queue.Count == 0)
                {
                    // Atomic with Enqueue: a producer arriving after this transition
                    // creates a fresh wake. Pending is retried after Execute returns.
                    _pumpState = PumpState.Idle;
                    return;
                }
                request = _queue.Dequeue();
            }
            ExecuteOne(app, request);
        }
    }

    private void ExecuteOne(UIApplication app, RevitRequest request)
    {

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
            else if (request.Kind == RevitRequestKind.ResolveActiveProjectBinding)
            {
                RevexDiagnostics.Info("REVIT", $"Read-only project binding probe. Document={uidoc.Document.Title}; ActiveView={uidoc.ActiveView?.Name ?? "<none>"}");
                RevexProjectBinding binding = SettingsService.ResolveProjectBinding(uidoc.Document, candidate: null, allowRebind: false);
                RevexDiagnostics.Stage("REVIT", "READ_ONLY_BINDING_PROBE", "PASSED",
                    $"document={binding.DocumentTitle}; fingerprint={binding.DocumentFingerprint}; project={binding.ProjectId}; source={binding.BindingSource}; revitWrites=false");
                result = RevitRequestResult.Bound($"Recovered the active Revit model's verified REVEX project binding: {binding.ProjectId}.", binding);
            }
            else
            {
                RevexDiagnostics.Info("REVIT", $"Document={uidoc.Document.Title}; ActiveView={uidoc.ActiveView?.Name ?? "<none>"}");
                bool requiresProjectBinding = request.Kind == RevitRequestKind.SyncRevexProject ||
                                              (request.Kind == RevitRequestKind.GbxmlEngineering &&
                                               request.EngineeringSettings?.AuditOnly == false);
                RevexProjectBinding? resolvedBinding = requiresProjectBinding
                    ? SettingsService.ResolveProjectBinding(uidoc.Document, request.ProjectBindingCandidate, request.AllowProjectRebind)
                    : null;
                result = request.Kind switch
                {
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

    public void Close()
    {
        List<RevitRequest> abandoned;
        lock (_gate)
        {
            if (_pumpState == PumpState.Closed) return;
            _pumpState = PumpState.Closed;
            _wakeGeneration++;
            _retryScheduled = false;
            abandoned = _queue.ToList();
            _queue.Clear();
            _externalEvent = null;
        }
        foreach (RevitRequest request in abandoned)
            FailRequest(request, "The REVEX window closed before Revit could process this request. No queued model operation was run.");
    }

    private void TryRaise(long generation)
    {
        ExternalEvent? externalEvent;
        lock (_gate)
        {
            if (_pumpState != PumpState.WakeOutstanding || generation != _wakeGeneration || _queue.Count == 0)
                return;
            _retryScheduled = false;
            externalEvent = _externalEvent;
        }

        ExternalEventRequest response;
        try
        {
            response = externalEvent?.Raise() ?? ExternalEventRequest.Denied;
        }
        catch (Exception ex)
        {
            FailWake(generation, "Revit rejected the queued REVEX operation before it started: " + ex.Message);
            return;
        }

        if (response == ExternalEventRequest.Accepted)
        {
            lock (_gate)
            {
                if (_pumpState == PumpState.WakeOutstanding && generation == _wakeGeneration)
                {
                    _wakeRetryCount = 0;
                    _retryScheduled = false;
                }
            }
            return;
        }
        if (response == ExternalEventRequest.Pending || response == ExternalEventRequest.TimedOut)
        {
            ScheduleWakeRetry(generation, response);
            return;
        }
        FailWake(generation, $"Revit denied the queued REVEX operation ({response}). No queued model operation was run.");
    }

    private void ScheduleWakeRetry(long generation, ExternalEventRequest response)
    {
        bool terminal = false;
        lock (_gate)
        {
            if (_pumpState != PumpState.WakeOutstanding || generation != _wakeGeneration || _queue.Count == 0 || _retryScheduled)
                return;
            if (++_wakeRetryCount > MaxWakeRetries)
                terminal = true;
            else
                _retryScheduled = true;
        }
        if (terminal)
        {
            FailWake(generation, $"Revit did not accept the queued REVEX operation after {MaxWakeRetries} bounded retries ({response}). No queued model operation was run.");
            return;
        }
        _ = Task.Delay(50).ContinueWith(_ =>
        {
            try { _dispatcher.BeginInvoke(new Action(() => TryRaise(generation)), DispatcherPriority.Background); }
            catch (Exception ex) { FailWake(generation, "REVEX could not reschedule the queued Revit operation: " + ex.Message); }
        }, TaskScheduler.Default);
    }

    private void FailWake(long generation, string message)
    {
        List<RevitRequest> failed;
        lock (_gate)
        {
            if (_pumpState != PumpState.WakeOutstanding || generation != _wakeGeneration) return;
            failed = _queue.ToList();
            _queue.Clear();
            _pumpState = PumpState.Idle;
            _wakeRetryCount = 0;
            _retryScheduled = false;
        }
        RevexDiagnostics.Error("REVIT", message);
        foreach (RevitRequest request in failed) FailRequest(request, message);
    }

    private static void FailRequest(RevitRequest request, string message)
    {
        try { request.Callback(RevitRequestResult.Fail(message)); }
        catch (Exception ex) { RevexDiagnostics.Warn("REVIT", "Rejected-request callback failed: " + ex.Message); }
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
        bool sourceTopologyFallback = false;
        bool simplifiedGeometryFallback = false;
        // Capture provenance before the canonical exporter is allowed to create
        // REVEX-owned Spaces. The simplified fallback can then distinguish the
        // untouched source model from geometry created during this exact attempt.
        HashSet<long> originalSpaceIds = new FilteredElementCollector(uidoc.Document)
            .OfCategory(BuiltInCategory.OST_MEPSpaces)
            .WhereElementIsNotElementType()
            .Select(element => element.Id.Value)
            .ToHashSet();
        try
        {
            // A complete existing MEP Space topology is authoritative. The successful
            // Midwood checkpoint exported 158 source Spaces while reporting invalid
            // height metadata as warning-only evidence; re-entering NewSpaces2 against
            // that same saved topology is what raises Revit's non-ignorable zero-height
            // modal. Only genuinely unspatialized/incomplete models may mutate topology.
            settings = ApplyExistingSpatialCheckpointPolicy(uidoc.Document, settings);

            try
            {
                output = new GbxmlEngineeringService().Run(app, uidoc.Document, settings);
            }
            catch (Exception ex) when (
                !settings.AuditOnly &&
                settings.CreateOrFixSpaces &&
                IsRecoverableSpatialTopologyFailure(ex))
            {
                sourceTopologyFallback = true;
                RevexDiagnostics.Warn("GBXML",
                    "Revit rejected automatic Space topology at an ambiguous boundary branch. " +
                    "Retrying once from existing source spatial elements without NewSpace/NewSpaces2 mutation. " +
                    "Original error: " + ex.Message);
                RevexDiagnostics.Stage("GBXML", "SOURCE_TOPOLOGY_FALLBACK", "STARTED",
                    "automatic topology mutation disabled; existing source Rooms/Spaces remain authoritative");

                GbxmlEngineeringSettings fallbackSettings = settings with
                {
                    CreateOrFixSpaces = false
                };
                output = new GbxmlEngineeringService().Run(app, uidoc.Document, fallbackSettings);
                RevexDiagnostics.Stage("GBXML", "SOURCE_TOPOLOGY_FALLBACK", "PASSED",
                    $"status={output.Status}; gbxml={output.GbxmlPath ?? "<none>"}");
            }

            bool ok = GbxmlEngineeringService.IsSuccessful(output!, settings.AuditOnly);

            if (!settings.AuditOnly && !ok && output != null &&
                !string.IsNullOrWhiteSpace(output.RunFolder) && Directory.Exists(output.RunFolder))
            {
                simplifiedGeometryFallback = true;
                RevexDiagnostics.Stage("GBXML", "SIMPLIFIED_GEOMETRY_FALLBACK", "STARTED",
                    $"normalStatus={output.Status}; source=placed Revit MEP Spaces; policy=source-bound 2.5D simplification");
                output = new SimplifiedGbxmlFallbackService().Run(uidoc.Document, output, originalSpaceIds);
                ok = GbxmlEngineeringService.IsSuccessful(output, auditOnly: false);
                RevexDiagnostics.Stage("GBXML", "SIMPLIFIED_GEOMETRY_FALLBACK", ok ? "PASSED" : "FAILED",
                    $"status={output.Status}; gbxml={output.GbxmlPath ?? "<none>"}; ambiguous openings remain opaque");
            }

            if (ok && !settings.AuditOnly)
            {
                if (output == null || string.IsNullOrWhiteSpace(output.RunFolder))
                    throw new InvalidOperationException("Successful Engineering gbXML has no run folder for current Revit schedule evidence.");
                string scheduleEvidence = new EngineeringScheduleEvidenceService().Export(uidoc.Document, output.RunFolder);
                RevexDiagnostics.Dependency("ENERGY-SCHEDULES", "Current native Revit schedules", File.Exists(scheduleEvidence), scheduleEvidence);
            }

            string detail = settings.AuditOnly
                ? $"gbXML audit finished: {output?.Status ?? "UNKNOWN"}."
                : ok
                    ? simplifiedGeometryFallback
                        ? $"gbXML exact/EADM path could not clear publication, so REVEX exported a source-bound simplified Space geometry fallback and preserved the run for managed Energy: {output?.GbxmlPath}"
                        : sourceTopologyFallback
                            ? $"gbXML exported from preserved Revit spatial topology after automatic boundary-branch fallback: {output?.GbxmlPath}"
                            : $"gbXML exported: {output?.GbxmlPath}"
                    : sourceTopologyFallback
                        ? $"gbXML source-topology fallback finished but remained non-publishable: {output?.Status}. See the report and REVEX diagnostics."
                        : $"gbXML export blocked: {output?.Status}. See the report and REVEX diagnostics.";
            return ok
                ? RevitRequestResult.Engineered(detail, output!)
                : RevitRequestResult.EngineeringFailed(detail, output);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("GBXML", simplifiedGeometryFallback
                ? "Engineering simplified geometry fallback failed."
                : sourceTopologyFallback
                    ? "Engineering gbXML source-topology fallback failed."
                    : "Engineering gbXML execution failed.", ex);
            return RevitRequestResult.EngineeringFailed(ex.Message, output);
        }
    }

    private static GbxmlEngineeringSettings ApplyExistingSpatialCheckpointPolicy(
        Document doc,
        GbxmlEngineeringSettings settings)
    {
        if (settings.AuditOnly || !settings.CreateOrFixSpaces)
            return settings;

        static bool IsPlaced(Element element)
        {
            try
            {
                Parameter? area = element.get_Parameter(BuiltInParameter.ROOM_AREA);
                return element.Location != null && area != null && area.AsDouble() > 1.0e-6;
            }
            catch
            {
                return false;
            }
        }

        bool HasPositiveVerticalEvidence(Element element)
        {
            if (element is not Autodesk.Revit.DB.Mechanical.Space space)
                return false;
            try
            {
                if (space.Volume <= 1.0e-9)
                    return false;
                BoundingBoxXYZ? box = space.get_BoundingBox(null);
                if (box != null && box.Max.Z > box.Min.Z + 0.25)
                    return true;
                Level? lower = doc.GetElement(space.LevelId) as Level;
                Level? upper = space.UpperLimit;
                if (lower == null || upper == null)
                    return false;
                double bottom = lower.Elevation + space.BaseOffset;
                double top = upper.Elevation + space.LimitOffset;
                return top > bottom + 0.25;
            }
            catch
            {
                return false;
            }
        }

        List<Element> spaces = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_MEPSpaces)
            .WhereElementIsNotElementType()
            .ToElements()
            .Where(IsPlaced)
            .ToList();
        List<Element> positiveSpaces = spaces.Where(HasPositiveVerticalEvidence).ToList();
        List<Element> rooms = new FilteredElementCollector(doc)
            .OfCategory(BuiltInCategory.OST_Rooms)
            .WhereElementIsNotElementType()
            .ToElements()
            .Where(IsPlaced)
            .ToList();

        if (spaces.Count == 0)
        {
            RevexDiagnostics.Stage("GBXML", "EXISTING_SPATIAL_CHECKPOINT", "NOT_APPLICABLE",
                $"placedSpaces=0; placedRooms={rooms.Count}; automatic Space creation remains enabled");
            return settings;
        }

        // Revit 2026 ElementId values are 64-bit. Compare coverage by LevelId so extra
        // Spaces on one story cannot disguise a missing story on another.
        Dictionary<long, int> spacesByLevel = positiveSpaces
            .GroupBy(e => e.LevelId.Value)
            .ToDictionary(g => g.Key, g => g.Count());
        Dictionary<long, int> roomsByLevel = rooms
            .GroupBy(e => e.LevelId.Value)
            .ToDictionary(g => g.Key, g => g.Count());
        int coveredRooms = roomsByLevel.Sum(row => Math.Min(
            row.Value,
            spacesByLevel.TryGetValue(row.Key, out int count) ? count : 0));
        double roomCoverage = rooms.Count == 0 ? 1.0 : (double)coveredRooms / rooms.Count;
        bool completeCheckpoint = rooms.Count == 0
            ? positiveSpaces.Count > 0
            : roomCoverage >= 0.98 && positiveSpaces.Count >= Math.Max(1, rooms.Count - 1);

        if (!completeCheckpoint)
        {
            RevexDiagnostics.Stage("GBXML", "EXISTING_SPATIAL_CHECKPOINT", "INCOMPLETE",
                $"placedSpaces={spaces.Count}; positiveVerticalSpaces={positiveSpaces.Count}; placedRooms={rooms.Count}; roomLevelCoverage={roomCoverage:P1}; automatic Space repair remains enabled; invalid originals remain untouched and receive Room-derived isolated geometry if overlap prevents replacement");
            return settings;
        }

        RevexDiagnostics.Stage("GBXML", "EXISTING_SPATIAL_CHECKPOINT", "PASSED",
            $"placedSpaces={spaces.Count}; positiveVerticalSpaces={positiveSpaces.Count}; placedRooms={rooms.Count}; roomLevelCoverage={roomCoverage:P1}; topologyMutation=false; invalid height metadata remains warning-only");
        RevexDiagnostics.Info("GBXML",
            "Existing placed MEP Spaces are a complete spatial checkpoint. REVEX will not call NewSpace/NewSpaces2 for this run; native Revit Space geometry remains authoritative.");
        return settings with { CreateOrFixSpaces = false };
    }

    private static bool IsRecoverableSpatialTopologyFailure(Exception error)
    {
        for (Exception? current = error; current != null; current = current.InnerException)
        {
            string message = (current.Message ?? string.Empty).ToLowerInvariant();
            if (message.Length == 0) continue;

            if (message.Contains("ambiguous thermal boundary", StringComparison.Ordinal) ||
                message.Contains("analytical vertex", StringComparison.Ordinal) ||
                message.Contains("room/space boundary branch", StringComparison.Ordinal) ||
                (message.Contains("more than two", StringComparison.Ordinal) &&
                 (message.Contains("curve", StringComparison.Ordinal) ||
                  message.Contains("boundary", StringComparison.Ordinal))))
                return true;
        }
        return false;
    }
}
