namespace Liber.Revex.Revit.Models;

public sealed record TransferPackage(
    string ViewName,
    string Folder,
    string ImagePath,
    string PromptPath,
    string ManifestPath,
    string Prompt,
    IReadOnlyList<MaterialSummary> Materials);

public sealed record MaterialSummary(
    string Semantic,
    int ElementCount,
    string Prompt);
