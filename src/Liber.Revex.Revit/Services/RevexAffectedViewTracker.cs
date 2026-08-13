using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using System.Collections.Concurrent;
using System.Threading;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Session-scoped, read-only change tracker used only to decide which native Revit
/// plan views should be regenerated/exported in the next REVEX revision. It never
/// writes parameters or model state.
/// </summary>
public static class RevexAffectedViewTracker
{
    private sealed class ChangeState
    {
        public HashSet<long> ElementIds { get; } = new();
        public bool HadDeletion { get; set; }
        public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
    }

    private static readonly ConcurrentDictionary<string, ChangeState> States = new(StringComparer.Ordinal);
    private static int _suspendCount;

    private sealed class Suspension : IDisposable
    {
        private bool _disposed;
        public Suspension() => Interlocked.Increment(ref _suspendCount);
        public void Dispose() { if (_disposed) return; _disposed = true; Interlocked.Decrement(ref _suspendCount); }
    }

    public static IDisposable Suspend() => new Suspension();

    private static string Key(Document doc)
    {
        try { return doc.ProjectInformation.UniqueId; }
        catch { return doc.Title; }
    }

    public static void OnDocumentChanged(object? sender, DocumentChangedEventArgs args)
    {
        if (Volatile.Read(ref _suspendCount) > 0) return;
        Document doc = args.GetDocument();
        if (doc == null) return;
        ChangeState state = States.GetOrAdd(Key(doc), _ => new ChangeState());
        lock (state)
        {
            foreach (ElementId id in args.GetAddedElementIds()) state.ElementIds.Add(id.Value);
            foreach (ElementId id in args.GetModifiedElementIds()) state.ElementIds.Add(id.Value);
            if (args.GetDeletedElementIds().Count > 0)
            {
                state.HadDeletion = true;
                foreach (ElementId id in args.GetDeletedElementIds()) state.ElementIds.Add(id.Value);
            }
            state.UpdatedAtUtc = DateTime.UtcNow;
        }
    }

    public sealed record Snapshot(IReadOnlySet<long> ElementIds, bool HadDeletion, DateTime UpdatedAtUtc);

    public static Snapshot Peek(Document doc)
    {
        if (!States.TryGetValue(Key(doc), out ChangeState? state))
            return new Snapshot(new HashSet<long>(), false, DateTime.UtcNow);
        lock (state)
            return new Snapshot(new HashSet<long>(state.ElementIds), state.HadDeletion, state.UpdatedAtUtc);
    }

    public static void Commit(Document doc)
    {
        States.TryRemove(Key(doc), out _);
    }
}
