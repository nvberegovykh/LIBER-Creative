using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Liber.Revex.Revit.Revit;
using Liber.Revex.Revit.Services;
using System.Windows.Interop;

namespace Liber.Revex.Revit.UI;

public static class RendairWindowManager
{
    private static RendairWindow? _window;
    private static ExternalEvent? _externalEvent;
    private static RevitRequestHandler? _handler;
    private static int _activeDocumentRuntimeId;

    public static void Show(UIApplication uiapp)
    {
        if (_window != null)
        {
            if (_window.WindowState == System.Windows.WindowState.Minimized)
                _window.WindowState = System.Windows.WindowState.Normal;
            _window.Activate();
            return;
        }

        _handler = new RevitRequestHandler();
        _externalEvent = ExternalEvent.Create(_handler);
        _activeDocumentRuntimeId = uiapp.ActiveUIDocument?.Document.GetHashCode() ?? 0;

        _window = new RendairWindow(_handler, _externalEvent);
        RevexWindowResponsivenessHotfix.Attach(_window);
        _window.Closed += (_, _) =>
        {
            _externalEvent?.Dispose();
            _externalEvent = null;
            _handler = null;
            _window = null;
        };

        new WindowInteropHelper(_window)
        {
            Owner = uiapp.MainWindowHandle
        };

        _window.Show();
    }

    public static void OnViewActivated(object? sender, ViewActivatedEventArgs args)
    {
        try
        {
            int runtimeId = args.CurrentActiveView?.Document?.GetHashCode() ?? 0;
            if (runtimeId == 0 || runtimeId == _activeDocumentRuntimeId) return;
            _activeDocumentRuntimeId = runtimeId;
            _window?.NotifyActiveDocumentChanged();
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("PROJECT", "Active-document switch observation failed: " + ex.Message);
        }
    }

    public static void Close()
    {
        _window?.Close();
        _window = null;

        _externalEvent?.Dispose();
        _externalEvent = null;
        _handler = null;
        _activeDocumentRuntimeId = 0;
    }
}
