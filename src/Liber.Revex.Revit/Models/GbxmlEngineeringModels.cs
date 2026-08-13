namespace Liber.Revex.Revit.Models;

public sealed record GbxmlEngineeringSettings
{
    public bool AuditOnly { get; init; } = true;
    public string OutputFolder { get; init; } = "";
    public string XmlName { get; init; } = "";
    public string PhaseName { get; init; } = "";
    public bool CreateOrFixSpaces { get; init; } = true;
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
