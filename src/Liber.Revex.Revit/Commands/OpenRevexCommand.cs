using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace Liber.Revex.Revit.Commands;

[Transaction(TransactionMode.Manual)]
public sealed class OpenRevexCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        try
        {
            UI.RendairWindowManager.Show(commandData.Application);
            return Result.Succeeded;
        }
        catch (Exception ex)
        {
            message = ex.ToString();
            return Result.Failed;
        }
    }
}
