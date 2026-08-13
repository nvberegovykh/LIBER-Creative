namespace Liber.Revex.Revit.Models;

public sealed record RevexProjectBinding
{
    public string BindingVersion { get; init; } = "";
    public string BindingSource { get; init; } = "";
    public string DocumentFingerprint { get; init; } = "";
    public string DocumentTitle { get; init; } = "";
    public string DocumentUniqueId { get; init; } = "";
    public string CentralPath { get; init; } = "";
    public string ProjectId { get; init; } = "";
    public string SpecProjectId { get; init; } = "";
    public string ProjectName { get; init; } = "";
    public string IdentityEvidenceDigest { get; init; } = "";
    public string IdentityDisplayName { get; init; } = "";
    public IReadOnlyList<string> IdentityEvidenceSheets { get; init; } = Array.Empty<string>();
    public DateTime BoundAtUtc { get; init; } = DateTime.UtcNow;
}

public enum RevitRequestKind
{
    ResolveActiveProjectBinding,
    CaptureCurrentView,
    CaptureBatch,
    SyncRevexProject,
    GbxmlEngineering
}

public sealed record RevitRequest(
    RevitRequestKind Kind,
    RenderSettings Settings,
    Action<RevitRequestResult> Callback,
    GbxmlEngineeringSettings? EngineeringSettings = null)
{
    public string CorrelationId { get; init; } = "revit-" + Guid.NewGuid().ToString("N")[..12];
    public string Initiator { get; init; } = "REVEX WPF";
    public DateTime EnqueuedAtUtc { get; init; } = DateTime.UtcNow;
    public RevexProjectBinding? ProjectBindingCandidate { get; init; }
    public bool AllowProjectRebind { get; init; }
}

public sealed record RevitRequestResult(
    bool Success,
    string Message,
    IReadOnlyList<TransferPackage> Packages,
    RevexSyncOutput? SyncOutput = null,
    GbxmlEngineeringOutput? EngineeringOutput = null,
    RevexProjectBinding? ProjectBinding = null)
{
    public static RevitRequestResult Fail(string message) =>
        new(false, message, Array.Empty<TransferPackage>());

    public static RevitRequestResult Ok(string message, IReadOnlyList<TransferPackage> packages) =>
        new(true, message, packages);

    public static RevitRequestResult Bound(string message, RevexProjectBinding binding) =>
        new(true, message, Array.Empty<TransferPackage>(), null, null, binding);

    public static RevitRequestResult Synced(string message, RevexSyncOutput output, RevexProjectBinding? binding = null) =>
        new(true, message, Array.Empty<TransferPackage>(), output, null, binding);

    public static RevitRequestResult Engineered(string message, GbxmlEngineeringOutput output, RevexProjectBinding? binding = null) =>
        new(true, message, Array.Empty<TransferPackage>(), null, output, binding);

    public static RevitRequestResult EngineeringFailed(string message, GbxmlEngineeringOutput? output = null, RevexProjectBinding? binding = null) =>
        new(false, message, Array.Empty<TransferPackage>(), null, output, binding);
}
