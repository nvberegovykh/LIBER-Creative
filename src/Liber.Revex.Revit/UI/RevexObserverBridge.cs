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
/// Observer bridge for read-only family inspection plus the explicitly isolated
/// elevator workshop lane. The workshop may mutate only a detached family
/// document and may never load that candidate back into the active project.
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
    private static RevexElevatorWorkshopExternalHandler? _workshopHandler;
    private static ExternalEvent? _workshopExternalEvent;

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
        if (_externalEvent == null)
        {
            _handler = new RevexObserverExternalHandler();
            _externalEvent = ExternalEvent.Create(_handler);
            RevexDiagnostics.Info("OBSERVER", "REVEX read-only Observer ExternalEvent ready.");
        }
        if (_workshopExternalEvent == null)
        {
            _workshopHandler = new RevexElevatorWorkshopExternalHandler();
            _workshopExternalEvent = ExternalEvent.Create(_workshopHandler);
            RevexDiagnostics.Info("ELEVATOR_WORKSHOP", "REVEX isolated elevator workshop ExternalEvent ready.");
        }
    }

    internal static void Release()
    {
        try { _externalEvent?.Dispose(); } catch { }
        try { _workshopExternalEvent?.Dispose(); } catch { }
        _externalEvent = null;
        _handler = null;
        _workshopExternalEvent = null;
        _workshopHandler = null;
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

            if (string.Equals(type, "liber:revex-observer-family-inspect-r144", StringComparison.Ordinal))
            {
                QueueInspection(web, root);
                return;
            }
            if (string.Equals(type, "liber:revex-observer-elevator-workshop-r146", StringComparison.Ordinal))
            {
                QueueWorkshop(web, root);
                return;
            }
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("OBSERVER", "Could not queue REVEX Observer request.", ex);
            _ = PostAsync(web, new
            {
                type = "liber:revex-observer-error-r146",
                ok = false,
                message = ex.Message
            });
        }
    }

    private static void QueueInspection(WebView2 web, JsonElement root)
    {
        if (_handler == null || _externalEvent == null)
            throw new InvalidOperationException("REVEX Observer is available only inside the active REVEX Revit add-in.");

        long elementId = ReadLong(root, "elementId");
        string focusId = ReadString(root, "focusId");
        string requestId = RequestId(root, "observer");
        var request = new ObserverFamilyService.InspectRequest(elementId, focusId, requestId);
        _handler.Enqueue(new RevexObserverExternalHandler.WorkItem(
            request,
            (result, error) => _ = PostInspectionResultAsync(web, request, result, error)));
        _externalEvent.Raise();
    }

    private static void QueueWorkshop(WebView2 web, JsonElement root)
    {
        if (_workshopHandler == null || _workshopExternalEvent == null)
            throw new InvalidOperationException("REVEX elevator workshop is available only inside the active REVEX Revit add-in.");

        long projectElementId = ReadLong(root, "elementId");
        long internalElementId = ReadLong(root, "internalElementId");
        string focusId = ReadString(root, "focusId");
        string action = ReadString(root, "action");
        string requestId = RequestId(root, "workshop");

        ElevatorWorkshopService.InfillGeometry? geometry = null;
        if (action is "infill-right-opening" or "build-right-frame" or "build-single-car-panel" or "build-landing-stop")
        {
            geometry = new ElevatorWorkshopService.InfillGeometry(
                ReadString(root, "sourceCandidatePath"),
                ReadString(root, "planeAxis"),
                ReadDouble(root, "planeCoordFt"),
                ReadDoubleArray(root, "outwardNormal", 3),
                ReadDoubleArray(root, "viewerRight", 3),
                ReadDouble(root, "clearLeftUFt"),
                ReadDouble(root, "clearRightUFt"),
                ReadDouble(root, "doorHeightFt"),
                ReadNullableDouble(root, "cabLeftUFt"),
                ReadNullableDouble(root, "stopBaseZFt"),
                ReadNullableInt(root, "stopIndex"),
                ReadNullableString(root, "visibilityParameter"));
        }

        var request = new ElevatorWorkshopService.WorkshopRequest(
            projectElementId,
            internalElementId,
            focusId,
            requestId,
            action,
            geometry);
        _workshopHandler.Enqueue(new RevexElevatorWorkshopExternalHandler.WorkItem(
            request,
            (result, error) => _ = PostWorkshopResultAsync(web, request, result, error)));
        _workshopExternalEvent.Raise();
    }

    private static Task PostInspectionResultAsync(
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

    private static Task PostWorkshopResultAsync(
        WebView2 web,
        ElevatorWorkshopService.WorkshopRequest request,
        ElevatorWorkshopService.WorkshopResult? result,
        string? error)
    {
        return PostAsync(web, new
        {
            type = "liber:revex-observer-elevator-workshop-result-r146",
            ok = result != null,
            focusId = request.FocusId,
            requestId = request.RequestId,
            elementId = request.ProjectElementId,
            internalElementId = request.InternalElementId,
            action = request.Action,
            result,
            message = result == null ? error ?? "Elevator workshop transition failed." : null
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

    private static string RequestId(JsonElement root, string prefix)
    {
        string requestId = ReadString(root, "requestId");
        return string.IsNullOrWhiteSpace(requestId)
            ? prefix + "-" + Guid.NewGuid().ToString("N")[..12]
            : requestId;
    }

    private static string ReadString(JsonElement root, string property) =>
        root.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? (value.GetString() ?? "").Trim()
            : "";

    private static string? ReadNullableString(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out JsonElement value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        return value.ValueKind == JsonValueKind.String ? (value.GetString() ?? "").Trim() : value.ToString().Trim();
    }

    private static double ReadDouble(JsonElement root, string property)
    {
        if (root.TryGetProperty(property, out JsonElement value) && value.TryGetDouble(out double number) && double.IsFinite(number))
            return number;
        if (double.TryParse(root.TryGetProperty(property, out value) ? value.ToString() : "", out number) && double.IsFinite(number))
            return number;
        throw new InvalidOperationException($"Invalid {property}.");
    }

    private static double? ReadNullableDouble(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out JsonElement value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        if (value.TryGetDouble(out double number) && double.IsFinite(number))
            return number;
        if (double.TryParse(value.ToString(), out number) && double.IsFinite(number))
            return number;
        throw new InvalidOperationException($"Invalid {property}.");
    }

    private static int? ReadNullableInt(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out JsonElement value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        if (value.TryGetInt32(out int number)) return number;
        if (int.TryParse(value.ToString(), out number)) return number;
        throw new InvalidOperationException($"Invalid {property}.");
    }

    private static double[] ReadDoubleArray(JsonElement root, string property, int expected)
    {
        if (!root.TryGetProperty(property, out JsonElement value) || value.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException($"Invalid {property}.");
        double[] values = value.EnumerateArray()
            .Select(item => item.TryGetDouble(out double number) && double.IsFinite(number)
                ? number
                : throw new InvalidOperationException($"Invalid {property} value."))
            .ToArray();
        if (values.Length != expected)
            throw new InvalidOperationException($"{property} must contain {expected} values.");
        return values;
    }

    private static long ReadLong(JsonElement root, string property)
    {
        if (root.TryGetProperty(property, out JsonElement value) && value.TryGetInt64(out long number))
            return number;
        if (long.TryParse(root.TryGetProperty(property, out value) ? value.ToString() : "", out number))
            return number;
        throw new InvalidOperationException($"Invalid {property}.");
    }
}
