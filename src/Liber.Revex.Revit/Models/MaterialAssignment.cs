using Autodesk.Revit.DB;

namespace Liber.Revex.Revit.Models;

public sealed record MaterialAssignment(
    ElementId ElementId,
    string ElementName,
    string Category,
    string Semantic,
    byte R,
    byte G,
    byte B,
    int Transparency,
    string Prompt,
    string MatchedRule);
