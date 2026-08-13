using Autodesk.Revit.UI;
using System.Reflection;
using Liber.Revex.Revit.Services;

namespace Liber.Revex.Revit;

public sealed class App : IExternalApplication
{
    public Result OnStartup(UIControlledApplication application)
    {
        RevexDiagnostics.InstallGlobalHandlers();
        string runtimeVersion = typeof(App).Assembly.GetName().Version?.ToString(3) ?? "unknown";
        RevexDiagnostics.Info("APP", $"LIBER REVEX {runtimeVersion} startup. Assembly={typeof(App).Assembly.Location}");
        RevexDiagnostics.LogEnvironmentSnapshot();
        application.ControlledApplication.DocumentChanged += RevexAffectedViewTracker.OnDocumentChanged;
        application.ViewActivated += UI.RendairWindowManager.OnViewActivated;
        const string tabName = "LIBER";
        try
        {
            application.CreateRibbonTab(tabName);
        }
        catch
        {
            // Ribbon tab already exists.
        }

        RibbonPanel panel = application.GetRibbonPanels(tabName)
            .FirstOrDefault(p => p.Name == "REVEX")
            ?? application.CreateRibbonPanel(tabName, "REVEX");

        string assemblyPath = Assembly.GetExecutingAssembly().Location;
        var button = new PushButtonData(
            "LiberRevexOpen",
            "REVEX",
            assemblyPath,
            "Liber.Revex.Revit.Commands.OpenRevexCommand")
        {
            ToolTip = "Open LIBER REVEX: BIM sync, Design Book, Spec Book, comments and isolated Rendair visualization."
        };

        panel.AddItem(button);
        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        try { application.ControlledApplication.DocumentChanged -= RevexAffectedViewTracker.OnDocumentChanged; } catch { }
        try { application.ViewActivated -= UI.RendairWindowManager.OnViewActivated; } catch { }
        RevexDiagnostics.Info("APP", "LIBER REVEX shutdown.");
        UI.RendairWindowManager.Close();
        return Result.Succeeded;
    }
}
