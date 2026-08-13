namespace Liber.Revex.Revit.Models;

public sealed record EngineeringSyncOutput(
    string Revision,
    string ProjectId,
    string RootFolder,
    string ManifestPath,
    string GbxmlPath,
    string? GbxmlReportPath,
    string? GbxmlSummaryPath,
    string WeatherPath,
    IReadOnlyList<string> EvidenceFiles);

public sealed record EnergyPipelineRequest
{
    public string CorrelationId { get; init; } = "";
    public string ParentCorrelationId { get; init; } = "";
    public string Initiator { get; init; } = "REVEX Engineering Sync automatic downstream";
    public string ProjectId { get; init; } = "";
    public string ProjectName { get; init; } = "";
    public string OpenStudioCli { get; init; } = "";
    public string WeatherFilePath { get; init; } = "";
    public string WeatherFileName { get; init; } = "";
    public string WeatherDataUrl { get; init; } = "";
    public string StandardVersion { get; init; } = "NYCECC 2020";
}

public sealed record EnergyPipelineOutput(
    string Status,
    string ResultRevision,
    string RootFolder,
    string ResultManifestPath,
    string? Error,
    IReadOnlyList<string> ArtifactPaths);
