namespace Liber.Revex.Revit.Models;

public sealed class MaterialRule
{
    public string Name { get; set; } = "";
    public int Priority { get; set; } = 0;
    public string Semantic { get; set; } = "";
    public string[] MatchAny { get; set; } = Array.Empty<string>();
    public string[] Categories { get; set; } = Array.Empty<string>();
    public byte[] Rgb { get; set; } = new byte[] { 190, 190, 190 };
    public int Transparency { get; set; } = 0;
    public string Prompt { get; set; } = "";
}
