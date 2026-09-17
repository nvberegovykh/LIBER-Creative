using Autodesk.Revit.UI;
using Liber.Revex.Revit.Services;
using System.Security.Cryptography;
using System.Windows.Threading;

namespace Liber.Revex.Revit.Revit;

internal sealed class RevexFamilyPlacementExternalHandler : IExternalEventHandler
{
    private enum PumpState { Idle, WakeOutstanding, Executing, Closed }

    internal const string ReceiptCompletedPendingSync = "COMPLETED_PENDING_SOURCE_SYNC";
    internal const string ReceiptRecoveryPending = "RECOVERY_PENDING";
    internal const string ReceiptBlockedNotStarted = "BLOCKED_NOT_STARTED";
    internal const string ReceiptFailed = "FAILED";
    private const int MaxQueuedRequests = 16;
    private const int MaxWakeRetries = 8;

    internal sealed record WorkItem(
        FamilyPlacementService.PlacementRequest? Placement,
        FamilyPlacementService.TransformRequest? Transform,
        FamilyMutationContext Context,
        object ReceiptRequest,
        Action<FamilyPlacementService.PlacementResult?, string?, string> Callback);

    private readonly object _gate = new();
    private readonly Queue<WorkItem> _queue = new();
    private readonly Dispatcher _dispatcher = Dispatcher.CurrentDispatcher;
    private readonly FamilyPlacementService _service = new();
    private ExternalEvent? _externalEvent;
    private PumpState _pumpState = PumpState.Idle;
    private long _wakeGeneration;
    private int _wakeRetryCount;
    private bool _retryScheduled;

    internal void AttachExternalEvent(ExternalEvent externalEvent)
    {
        ArgumentNullException.ThrowIfNull(externalEvent);
        lock (_gate)
        {
            if (_pumpState == PumpState.Closed)
                throw new ObjectDisposedException(nameof(RevexFamilyPlacementExternalHandler));
            if (_externalEvent != null && !ReferenceEquals(_externalEvent, externalEvent))
                throw new InvalidOperationException("REVEX family request pump is already attached.");
            _externalEvent = externalEvent;
        }
    }

    internal void Enqueue(WorkItem item)
    {
        ArgumentNullException.ThrowIfNull(item);
        long generation = 0;
        bool raise = false;
        string? rejection = null;
        int queueDepth;
        lock (_gate)
        {
            if (_pumpState == PumpState.Closed || _externalEvent == null)
            {
                rejection = "The REVEX family request pump is not available. Re-open the REVEX window and choose the family again.";
            }
            else if (_queue.Count >= MaxQueuedRequests)
            {
                rejection = "REVEX is already processing the maximum number of family requests. Wait for the current Revit operation to finish and try again.";
            }
            else
            {
                _queue.Enqueue(item);
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
            FailRequest(item, rejection, ReceiptFailed);
            return;
        }
        RevexDiagnostics.Info("FAMILY", $"Family ExternalEvent queued: command={item.Context.CommandId}; queueDepth={queueDepth}.");
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
            WorkItem item;
            lock (_gate)
            {
                if (_pumpState == PumpState.Closed) return;
                if (_queue.Count == 0)
                {
                    // Atomic with Enqueue: a producer arriving after this transition
                    // owns a fresh wake, so no family request can be stranded.
                    _pumpState = PumpState.Idle;
                    return;
                }
                item = _queue.Dequeue();
            }

            if (!ExecuteOne(app, item))
            {
                FailRemainingAfterPendingTransaction();
                return;
            }
        }
    }

    private bool ExecuteOne(UIApplication app, WorkItem item)
    {
        FamilyPlacementService.PlacementResult? result = null;
        string? message = null;
        string receiptStatus = ReceiptFailed;
        bool reserved = false;
        bool committed = false;
        bool safeToContinue = true;
        try
        {
            var doc = app.ActiveUIDocument?.Document
                ?? throw new InvalidOperationException("No active Revit document is available for BIM-family placement.");

            string fingerprint = CentralModelBindingService.ResolveDocumentFingerprint(doc);
            if (!string.Equals(fingerprint, item.Context.DocumentFingerprint, StringComparison.Ordinal))
                throw new InvalidOperationException("The active Revit document no longer matches this family command. Re-open the intended project and choose Insert again.");
            var binding = SettingsService.ResolveProjectBinding(doc, candidate: null, allowRebind: false);
            if (!string.Equals(binding.ProjectId, item.Context.ProjectId, StringComparison.Ordinal))
                throw new InvalidOperationException("The active Revit project binding no longer matches this family command. No model change was made.");

            string operation = item.Placement != null ? "place" : item.Transform != null ? "transform" : "";
            if (operation.Length == 0)
                throw new InvalidOperationException("REVEX family placement request is empty.");

            // Reconcile an interrupted v2 command from its Revit witness before a
            // duplicate can reserve or mutate anything. Legacy ambiguous v1 intents
            // deliberately fail closed here.
            FamilyMutationReceiptService.RecoveredMutation? recovered = FamilyMutationReceiptService.RecoverBeforeMutation(
                doc,
                item.Context,
                operation,
                item.ReceiptRequest);
            if (recovered != null)
            {
                result = recovered.Result;
                committed = true;
                receiptStatus = recovered.ReceiptStatus;
                message = recovered.Message;
                RevexDiagnostics.Info("FAMILY", $"Recovered already-committed REVEX family command from its model witness/local receipt without repeating its mutation: id={result.ElementId}; command={item.Context.CommandId}; receipt={receiptStatus}.");
            }
            else
            {
                using VerifiedFamilyAsset? verifiedAsset = item.Placement != null
                    ? OpenVerifiedFamilyAsset(item.Placement.Path, item.Context.ProviderAssetSha256)
                    : null;
                FamilyPlacementService.PlacementRequest? verifiedPlacement = item.Placement == null
                    ? null
                    : item.Placement with { Path = verifiedAsset!.Path };
                if (item.Transform != null)
                    FamilyMutationReceiptService.AssertTransformOrigin(doc, item.Context, item.Transform.UniqueId);
                FamilyMutationReceiptService.Reserve(item.Context, operation, item.ReceiptRequest);
                reserved = true;

                void RecordCommittedWitness(FamilyPlacementService.PlacementResult candidate)
                {
                    FamilyMutationReceiptService.PreparedReceipt prepared = FamilyMutationReceiptService.PrepareForCommit(
                        item.Context,
                        operation,
                        item.ReceiptRequest,
                        candidate);
                    FamilyMutationReceiptService.RecordCommittedWitness(doc, prepared);
                }

                result = verifiedPlacement != null
                    ? _service.Place(doc, verifiedPlacement, RecordCommittedWitness)
                    : item.Transform != null
                        ? _service.Transform(doc, item.Transform, RecordCommittedWitness)
                        : throw new InvalidOperationException("REVEX family placement request is empty.");
                committed = true;
                receiptStatus = ReceiptCompletedPendingSync;
                try
                {
                    FamilyMutationReceiptService.Complete(doc, item.Context, operation, item.ReceiptRequest, result);
                }
                catch (Exception ex)
                {
                    // The Revit DataStorage witness is authoritative and source sync
                    // can rebuild the local cache without repeating the model edit.
                    receiptStatus = ReceiptRecoveryPending;
                    message = "The family was committed in Revit; its local receipt will be rebuilt from the model witness during Sync project. " + ex.Message;
                    RevexDiagnostics.Warn("FAMILY", "RECOVERY_PENDING: committed family witness will rebuild the local receipt: " + ex.Message);
                }
                RevexDiagnostics.Info("FAMILY", $"REVEX family placement complete: id={result.ElementId}; family={result.Family}; type={result.Type}; level={result.Level}.");
            }
        }
        catch (FamilyPlacementService.TransactionCommitException ex)
        {
            if (reserved && !ex.RecoveryPending)
                FamilyMutationReceiptService.Cancel(item.Context);
            receiptStatus = ex.RecoveryPending ? ReceiptRecoveryPending : ReceiptFailed;
            message = ex.RecoveryPending ? "RECOVERY_PENDING: " + ex.Message : ex.Message;
            safeToContinue = !ex.RecoveryPending;
            RevexDiagnostics.Error("FAMILY", "REVEX BIM-family transaction was not immediately committed.", ex);
        }
        catch (Exception ex)
        {
            // All failures before an exact TransactionStatus.Committed roll back the
            // Revit transaction, so their v2 local preparation is safe to cancel.
            if (reserved && !committed)
                FamilyMutationReceiptService.Cancel(item.Context);
            receiptStatus = ReceiptFailed;
            message = ex.Message;
            RevexDiagnostics.Error("FAMILY", "REVEX BIM-family placement failed.", ex);
        }
        try { item.Callback(result, message, receiptStatus); }
        catch (Exception ex) { RevexDiagnostics.Warn("FAMILY", "Family placement callback failed: " + ex.Message); }
        return safeToContinue;
    }

    private sealed class VerifiedFamilyAsset : IDisposable
    {
        private readonly FileStream _lock;

        internal VerifiedFamilyAsset(string path, FileStream fileLock)
        {
            Path = path;
            _lock = fileLock;
        }

        internal string Path { get; }

        public void Dispose()
        {
            _lock.Dispose();
            try { if (File.Exists(Path)) File.Delete(Path); } catch { }
        }
    }

    private static VerifiedFamilyAsset OpenVerifiedFamilyAsset(string path, string expectedSha256)
    {
        if (string.IsNullOrWhiteSpace(path) || expectedSha256.Length != 64)
            throw new InvalidOperationException("The family command has no exact provider-asset digest.");
        string folder = System.IO.Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException("The downloaded family path has no containing folder.");
        string extension = System.IO.Path.GetExtension(path);
        string verifiedPath = System.IO.Path.Combine(folder, $"verified-{Guid.NewGuid():N}{extension}");
        FileStream? lockedSnapshot = null;
        try
        {
            // Create the unexposed random snapshot exclusively, then reopen it as
            // read-only. A ReadWrite handle held through LoadFamily would conflict
            // with ZipFile/Revit readers on Windows even when FileShare.Read is set.
            using (FileStream snapshot = new(verifiedPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
            {
                using FileStream source = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
                source.CopyTo(snapshot);
                snapshot.Flush(flushToDisk: true);
                snapshot.Position = 0;
                string copiedSha = Convert.ToHexString(SHA256.HashData(snapshot)).ToLowerInvariant();
                if (!string.Equals(copiedSha, expectedSha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("The downloaded BIM family changed after provider verification. Download it again; no Revit mutation was run.");
            }

            // Reopen and re-hash under a read-only FileShare.Read lease. The second
            // digest closes the exclusive-create/reopen gap; after this handle opens,
            // Windows denies writers, replacement and deletion while allowing the
            // bounded ZIP reader or Revit LoadFamily to read the same exact bytes.
            lockedSnapshot = new FileStream(verifiedPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            string lockedSha = Convert.ToHexString(SHA256.HashData(lockedSnapshot)).ToLowerInvariant();
            if (!string.Equals(lockedSha, expectedSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The verified BIM family snapshot changed before it could be locked. Download it again; no Revit mutation was run.");
            lockedSnapshot.Position = 0;
            return new VerifiedFamilyAsset(verifiedPath, lockedSnapshot);
        }
        catch
        {
            lockedSnapshot?.Dispose();
            try { if (File.Exists(verifiedPath)) File.Delete(verifiedPath); } catch { }
            throw;
        }
    }

    internal void Close()
    {
        List<WorkItem> abandoned;
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
        foreach (WorkItem item in abandoned)
            FailRequest(item, "The REVEX window closed before Revit could process this family request. No queued family mutation was run.", ReceiptFailed);
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
            FailWake(generation, "Revit rejected the queued family operation before it started: " + ex.Message);
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
        FailWake(generation, $"Revit denied the queued family operation ({response}). No queued family mutation was run.");
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
            FailWake(generation, $"Revit did not accept the queued family operation after {MaxWakeRetries} bounded retries ({response}). No queued family mutation was run.");
            return;
        }
        _ = Task.Delay(50).ContinueWith(_ =>
        {
            try { _dispatcher.BeginInvoke(new Action(() => TryRaise(generation)), DispatcherPriority.Background); }
            catch (Exception ex) { FailWake(generation, "REVEX could not reschedule the queued family operation: " + ex.Message); }
        }, TaskScheduler.Default);
    }

    private void FailWake(long generation, string message)
    {
        List<WorkItem> failed;
        lock (_gate)
        {
            if (_pumpState != PumpState.WakeOutstanding || generation != _wakeGeneration) return;
            failed = _queue.ToList();
            _queue.Clear();
            _pumpState = PumpState.Idle;
            _wakeRetryCount = 0;
            _retryScheduled = false;
        }
        RevexDiagnostics.Error("FAMILY", message);
        foreach (WorkItem item in failed) FailRequest(item, message, ReceiptFailed);
    }

    private void FailRemainingAfterPendingTransaction()
    {
        const string message = "A prior family transaction is still being resolved by Revit. No later queued family mutation was started; wait for Revit to finish, then retry from the authoritative project state.";
        List<WorkItem> failed;
        lock (_gate)
        {
            if (_pumpState == PumpState.Closed) return;
            failed = _queue.ToList();
            _queue.Clear();
            _pumpState = PumpState.Idle;
            _wakeGeneration++;
            _wakeRetryCount = 0;
            _retryScheduled = false;
        }
        RevexDiagnostics.Warn("FAMILY", message);
        // These later commands never entered a Revit transaction and therefore
        // have no model witness to recover. Keep that truth distinct from the
        // uncertain command that stopped the pump so the client can safely offer
        // a fresh retry instead of suppressing it as RECOVERY_PENDING.
        foreach (WorkItem item in failed) FailRequest(item, message, ReceiptBlockedNotStarted);
    }

    private static void FailRequest(WorkItem item, string message, string receiptStatus)
    {
        try { item.Callback(null, message, receiptStatus); }
        catch (Exception ex) { RevexDiagnostics.Warn("FAMILY", "Rejected family-request callback failed: " + ex.Message); }
    }

    public string GetName() => "LIBER REVEX BIM family placement";
}
