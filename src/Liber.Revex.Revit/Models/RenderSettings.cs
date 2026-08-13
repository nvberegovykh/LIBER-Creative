namespace Liber.Revex.Revit.Models;

public sealed record RenderSettings
{
    public bool AutoMaterialIntent { get; init; } = true;
    public bool PreserveGeometry { get; init; } = true;
    public bool RealisticOnly { get; init; } = true;
    public string Environment { get; init; } = "Natural daylight";
    public string Staging { get; init; } = "Preserve modeled objects only";
    public string People { get; init; } = "None";
    public int PixelSize { get; init; } = 2560;
    public string BatchNameContains { get; init; } = "RND";
}
