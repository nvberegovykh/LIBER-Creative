namespace Liber.Revex.Revit.Models;

public sealed record GbxmlEngineeringSettings
{
    private bool _createOrFixSpacesRequested = true;

    public bool AuditOnly { get; init; } = true;
    public string OutputFolder { get; init; } = "";
    public string XmlName { get; init; } = "";
    public string PhaseName { get; init; } = "";

    // Revit 2026 can let broad NewSpaces2 create positive-area plan circuits whose
    // vertical extent is still zero at transaction validation time. That produces the
    // native non-ignorable "Space must have a height greater than 0" modal before the
    // Python engine can normalize Upper Limit / Limit Offset. Production SYNC therefore
    // fails closed on broad topology mutation: existing Rooms/Spaces remain authoritative
    // and the already-source-bound simplified geometry fallback can complete the handoff.
    // Safe automatic gap filling may be re-enabled only as per-circuit atomic placement
    // that establishes a positive height before the same transaction is committed.
    public bool CreateOrFixSpaces
    {
        get => false;
        init => _createOrFixSpacesRequested = value;
    }

    public bool CreateOrFixSpacesRequested => _createOrFixSpacesRequested;
    public bool ExportDespiteBlockers { get; init; }
    public string MiniLmFolder { get; init; } = "";
}

public sealed record GbxmlEngineeringOutput(
    string Status,
    string ModelTitle,
    string ModelPath,
    string RunFolder,
    string OutputFolder,
    string? GbxmlPath,
    string? SummaryPath,
    string? ReportPath,
    string SummaryText,
    DateTime StartedAt,
    DateTime FinishedAt);
