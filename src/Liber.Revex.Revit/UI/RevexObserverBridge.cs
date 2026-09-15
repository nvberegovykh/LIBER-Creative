using Autodesk.Revit.UI;
using Liber.Revex.Revit.Revit;
using Liber.Revex.Revit.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows;

namespace Liber.Revex.Revit.UI;

/// <summary>
/// Read-only Observer bridge. It listens alongside the existing REVEX integration
/// bridge and exposes bounded family inspection through Revit ExternalEvent.
/// No transaction, save, or project mutation is performed here.
/// </summary>
internal static class RevexObserverBridge
{
    private sealed class BridgeState
    {
        public bool CoreAttached { get; set; }
    }

    private static readonly ConditionalWeakTable<WebView2, BridgeState> States = new();
    private static RevexObserverExternalHandler? _handler;
    private static ExternalEvent? _externalEvent;

    [ModuleInitializer]
    internal static void Install()
    {
        EventManager.RegisterClassHandler(
            typeof(WebView2),
            FrameworkElement.LoadedEvent,
            new RoutedEventHandler(OnWebViewLoaded));
    }

    internal static void Configure()
    {
        if (_externalEvent != null) return;
        _handler = new RevexObserverExternalHandler();
        _externalEvent = ExternalEvent.Create(_handler);
        RevexDiagnostics.Info("OBSERVER", "REVEX read-only Observer ExternalEvent ready.");
    }

    internal static void Release()
    {
        try { _externalEvent?.Dispose(); } catch { }
        _externalEvent = null;
        _handler = null;
    }

    private static void OnWebViewLoaded(object sender, RoutedEventArgs args)
    {
        if (sender is not WebView2 web) return;
        BridgeState state = States.GetValue(web, _ => new BridgeState());
        web.CoreWebView2InitializationCompleted -= OnCoreInitialized;
        web.CoreWebView2InitializationCompleted += OnCoreInitialized;
        if (web.CoreWebView2 is not null)
            AttachCore(web, state);
    }

    private static void OnCoreInitialized(object? sender, CoreWebView2InitializationCompletedEventArgs args)
    {
        if (!args.IsSuccess || sender is not WebView2 web || web.CoreWebView2 is null) return;
        AttachCore(web, States.GetValue(web, _ => new BridgeState()));
    }

    private static void AttachCore(WebView2 web, BridgeState state)
    {
        if (state.CoreAttached || web.CoreWebView2 is null) return;
        state.CoreAttached = true;
        web.CoreWebView2.WebMessageReceived += (_, e) => HandleWebMessage(web, e);
        RevexDiagnostics.Info("OBSERVER", "REVEX Observer WebView2 endpoint attached.");
    }

    private static void HandleWebMessage(WebView2 web, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string json = e.WebMessageAsJson ?? "";
            if (string.IsNullOrWhiteSpace(json)) return;

            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (!root.TryGetProperty("type", out JsonElement typeElement)) return;

            string type = typeElement.GetString() ?? "";
            if (!string.Equals(type, "liber:revex-observer-family-inspect-r144", StringComparison.Ordinal))
                return;

            if (_handler == null || _externalEvent == null)
                throw new InvalidOperationException("REVEX Observer is available only inside the active REVEX Revit add-in.");

            long elementId = ReadLong(root, "elementId");
            string focusId = ReadString(root, "focusId");
            string requestId = ReadString(root, "requestId");
            if (string.IsNullOrWhiteSpace(requestId))
                requestId = "observer-" + Guid.NewGuid().ToString("N")[..12];

            var request = new ObserverFamilyService.InspectRequest(elementId, focusId, requestId);
            _handler.Enqueue(new RevexObserverExternalHandler.WorkItem(
                request,
                (result, error) => _ = PostResultAsync(web, request, result, error)));
            _externalEvent.Raise();
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("OBSERVER", "Could not queue REVEX Observer request.", ex);
            _ = PostAsync(web, new
            {
                type = "liber:revex-observer-family-inspection-r144",
                ok = false,
                message = ex.Message
            });
        }
    }

    private static Task PostResultAsync(
        WebView2 web,
        ObserverFamilyService.InspectRequest request,
        ObserverFamilyService.InspectResult? result,
        string? error)
    {
        if (result == null)
        {
            return PostAsync(web, new
            {
                type = "liber:revex-observer-family-inspection-r144",
                ok = false,
                focusId = request.FocusId,
                requestId = request.RequestId,
                elementId = request.ElementId,
                message = error ?? "Family inspection failed."
            });
        }

        return PostAsync(web, new
        {
            type = "liber:revex-observer-family-inspection-r144",
            ok = true,
            focusId = request.FocusId,
            requestId = request.RequestId,
            elementId = request.ElementId,
            result
        });
    }

    private static async Task PostAsync(WebView2 web, object payload)
    {
        try
        {
            await web.Dispatcher.InvokeAsync(() =>
            {
                if (web.CoreWebView2 == null) return;
                string json = JsonSerializer.Serialize(payload);
                web.CoreWebView2.PostWebMessageAsJson(json);
            });
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("OBSERVER", "Could not return Observer result to Companion: " + ex.Message);
        }
    }

    private static string ReadString(JsonElement root, string property) =>
        root.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? (value.GetString() ?? "").Trim()
            : "";

    private static long ReadLong(JsonElement root, string property)
    {
        if (root.TryGetProperty(property, out JsonElement value) && value.TryGetInt64(out long number))
            return number;
        if (long.TryParse(root.TryGetProperty(property, out value) ? value.ToString() : "", out number))
            return number;
        throw new InvalidOperationException($"Invalid {property}.");
    }
}
