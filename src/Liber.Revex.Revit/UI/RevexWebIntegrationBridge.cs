using Autodesk.Revit.UI;
using Liber.Revex.Revit.Revit;
using Liber.Revex.Revit.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;

namespace Liber.Revex.Revit.UI;

/// <summary>
/// Shared REVEX WebView2 integration endpoint.
/// Provider websites are never scraped or scripted. A user opens an owned browser,
/// interacts with the provider normally, and only a user-triggered supported
/// download crosses back into REVEX. Architextures returns image bytes; Blocks
/// returns an opaque family token whose local path never enters browser JavaScript.
/// </summary>
internal static class RevexWebIntegrationBridge
{
    private const long MaxMaterialBytes = 12L * 1024L * 1024L;
    private const long MaxFamilyBytes = 160L * 1024L * 1024L;
    private static readonly Uri ArchitexturesCreate = new("https://architextures.org/create");
    private static readonly Uri BlocksFamilies = new("https://www.blocksrvt.com/en/families");

    private sealed class BridgeState
    {
        public string ArmedProvider { get; set; } = "";
        public bool CoreAttached { get; set; }
        public WebView2? ReturnTarget { get; set; }
        public Window? ProviderWindow { get; set; }
    }

    private sealed record PendingFamily(string Path, string Name, long Bytes, DateTime CreatedUtc, WebView2 Target);

    private static readonly ConditionalWeakTable<WebView2, BridgeState> States = new();
    private static readonly ConcurrentDictionary<string, PendingFamily> PendingFamilies = new();
    private static RevexFamilyPlacementExternalHandler? _familyHandler;
    private static ExternalEvent? _familyExternalEvent;

    [ModuleInitializer]
    internal static void Install()
    {
        EventManager.RegisterClassHandler(
            typeof(WebView2),
            FrameworkElement.LoadedEvent,
            new RoutedEventHandler(OnWebViewLoaded));
    }

    internal static void ConfigureFamilyPlacement()
    {
        if (_familyExternalEvent != null) return;
        _familyHandler = new RevexFamilyPlacementExternalHandler();
        _familyExternalEvent = ExternalEvent.Create(_familyHandler);
        RevexDiagnostics.Info("FAMILY", "REVEX Blocks family placement ExternalEvent ready.");
    }

    internal static void ReleaseFamilyPlacement()
    {
        try { _familyExternalEvent?.Dispose(); } catch { }
        _familyExternalEvent = null;
        _familyHandler = null;
        foreach (var pair in PendingFamilies.ToArray())
        {
            if (!PendingFamilies.TryRemove(pair.Key, out PendingFamily? pending)) continue;
            try { if (File.Exists(pending.Path)) File.Delete(pending.Path); } catch { }
        }
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
        BridgeState state = States.GetValue(web, _ => new BridgeState());
        AttachCore(web, state);
    }

    private static void AttachCore(WebView2 web, BridgeState state)
    {
        if (state.CoreAttached || web.CoreWebView2 is null) return;
        state.CoreAttached = true;
        web.CoreWebView2.WebMessageReceived += (_, e) => HandleWebMessage(web, state, e);
        web.CoreWebView2.DownloadStarting += (_, e) => HandleDownload(web, state, e);
        RevexDiagnostics.Info("INTEGRATION", "REVEX WebView2 integration endpoint attached.");
    }

    private static async void HandleWebMessage(WebView2 web, BridgeState state, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string json = e.WebMessageAsJson ?? "";
            if (string.IsNullOrWhiteSpace(json)) return;
            using JsonDocument doc = JsonDocument.Parse(json);
            JsonElement root = doc.RootElement;
            if (!root.TryGetProperty("type", out JsonElement typeEl)) return;
            string type = typeEl.GetString() ?? "";

            if (string.Equals(type, "liber:revex-family-place-r126", StringComparison.Ordinal))
            {
                QueueFamilyPlace(web, root);
                return;
            }
            if (string.Equals(type, "liber:revex-family-transform-r126", StringComparison.Ordinal))
            {
                QueueFamilyTransform(web, root);
                return;
            }

            if (string.Equals(type, "liber:revex-integration-arm", StringComparison.Ordinal))
            {
                string provider = ReadProvider(root);
                bool active = !root.TryGetProperty("active", out JsonElement activeEl) || activeEl.ValueKind != JsonValueKind.False;
                state.ArmedProvider = active ? provider : "";
                RevexDiagnostics.Info("INTEGRATION", active
                    ? $"Provider download handoff armed: {provider}."
                    : "Provider download handoff disarmed.");
                return;
            }

            if (string.Equals(type, "liber:revex-integration-close", StringComparison.Ordinal))
            {
                if (state.ProviderWindow is { IsVisible: true } providerWindow)
                    providerWindow.Dispatcher.BeginInvoke(new Action(providerWindow.Close));
                state.ProviderWindow = null;
                return;
            }

            if (!string.Equals(type, "liber:revex-integration-open", StringComparison.Ordinal))
                return;

            string requestedProvider = ReadProvider(root);
            string requestedUrl = root.TryGetProperty("url", out JsonElement urlEl)
                ? (urlEl.GetString() ?? "").Trim()
                : "";
            Uri providerUri = ResolveProviderUri(requestedProvider, requestedUrl);
            await OpenProviderAsync(web, state, requestedProvider, providerUri);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("INTEGRATION", "Could not execute REVEX provider integration request.", ex);
            await PostAsync(web, new
            {
                type = "liber:revex-integration-error",
                provider = ReadProviderSafe(e.WebMessageAsJson),
                message = ex.Message
            });
        }
    }

    private static void QueueFamilyPlace(WebView2 web, JsonElement root)
    {
        if (_familyHandler == null || _familyExternalEvent == null)
            throw new InvalidOperationException("BIM-family placement is available only inside the REVEX Revit add-in.");
        string token = ReadString(root, "token");
        if (!PendingFamilies.TryGetValue(token, out PendingFamily? pending))
            throw new InvalidOperationException("The Blocks family download token expired. Download the family again.");
        double x = ReadDouble(root, "x"), y = ReadDouble(root, "y"), z = ReadDouble(root, "z");
        double rotation = ReadDouble(root, "rotationDegrees");
        string levelName = ReadString(root, "levelName");
        double levelElevation = ReadDouble(root, "levelElevation", z);
        var request = new FamilyPlacementService.PlacementRequest(pending.Path, x, y, z, rotation, levelName, levelElevation);
        _familyHandler.Enqueue(new RevexFamilyPlacementExternalHandler.WorkItem(request, null, (result, error) =>
        {
            _ = PostFamilyResultAsync(web, result, error, "place");
            if (PendingFamilies.TryRemove(token, out PendingFamily? remove))
                try { if (File.Exists(remove.Path)) File.Delete(remove.Path); } catch { }
        }));
        _familyExternalEvent.Raise();
    }

    private static void QueueFamilyTransform(WebView2 web, JsonElement root)
    {
        if (_familyHandler == null || _familyExternalEvent == null)
            throw new InvalidOperationException("BIM-family placement is available only inside the REVEX Revit add-in.");
        long elementId = ReadLong(root, "elementId");
        var request = new FamilyPlacementService.TransformRequest(
            elementId,
            ReadDouble(root, "dx"),
            ReadDouble(root, "dy"),
            ReadDouble(root, "dz"),
            ReadDouble(root, "rotateDegrees"));
        _familyHandler.Enqueue(new RevexFamilyPlacementExternalHandler.WorkItem(null, request,
            (result, error) => _ = PostFamilyResultAsync(web, result, error, "transform")));
        _familyExternalEvent.Raise();
    }

    private static Task PostFamilyResultAsync(WebView2 web, FamilyPlacementService.PlacementResult? result, string? error, string action)
    {
        if (result == null)
            return PostAsync(web, new { type = "liber:revex-family-placement-r126", ok = false, action, message = error ?? "Family placement failed." });
        return PostAsync(web, new
        {
            type = "liber:revex-family-placement-r126",
            ok = true,
            action,
            elementId = result.ElementId,
            uniqueId = result.UniqueId,
            family = result.Family,
            revitType = result.Type,
            level = result.Level,
            bboxMin = result.BboxMin,
            bboxMax = result.BboxMax,
            previewTriangles = result.PreviewTriangles,
            previewTruncated = result.PreviewTruncated,
            placementType = result.PlacementType
        });
    }

    private static string ReadProvider(JsonElement root) =>
        root.TryGetProperty("provider", out JsonElement providerEl)
            ? (providerEl.GetString() ?? "").Trim().ToLowerInvariant()
            : "";

    private static string ReadProviderSafe(string? json)
    {
        try { using JsonDocument doc = JsonDocument.Parse(json ?? "{}"); return ReadProvider(doc.RootElement); }
        catch { return ""; }
    }

    private static string ReadString(JsonElement root, string property) =>
        root.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? (value.GetString() ?? "").Trim()
            : "";

    private static double ReadDouble(JsonElement root, string property, double fallback = 0)
    {
        if (!root.TryGetProperty(property, out JsonElement value)) return fallback;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out double number) && double.IsFinite(number)) return number;
        return double.TryParse(value.ToString(), out number) && double.IsFinite(number) ? number : fallback;
    }

    private static long ReadLong(JsonElement root, string property)
    {
        if (root.TryGetProperty(property, out JsonElement value) && value.TryGetInt64(out long number)) return number;
        if (long.TryParse(root.TryGetProperty(property, out value) ? value.ToString() : "", out number)) return number;
        throw new InvalidOperationException($"Invalid {property}.");
    }

    private static Uri ResolveProviderUri(string provider, string requestedUrl)
    {
        Uri candidate = provider switch
        {
            "architextures" => ArchitexturesCreate,
            "blocks" => BlocksFamilies,
            _ => throw new InvalidOperationException("Unsupported REVEX provider.")
        };
        if (!string.IsNullOrWhiteSpace(requestedUrl) &&
            Uri.TryCreate(requestedUrl, UriKind.Absolute, out Uri? parsed) &&
            IsProviderUri(provider, parsed))
            candidate = parsed;
        return candidate;
    }

    private static bool IsProviderUri(string provider, Uri uri)
    {
        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)) return false;
        string host = uri.Host.Trim().TrimEnd('.').ToLowerInvariant();
        return provider switch
        {
            "architextures" => host == "architextures.org" || host.EndsWith(".architextures.org", StringComparison.Ordinal),
            "blocks" => host == "blocksrvt.com" || host.EndsWith(".blocksrvt.com", StringComparison.Ordinal),
            _ => false
        };
    }

    private static async Task OpenProviderAsync(WebView2 origin, BridgeState originState, string provider, Uri uri)
    {
        if (origin.CoreWebView2 is null)
            throw new InvalidOperationException("REVEX Companion browser is not ready yet.");
        CleanupStaleFamilies();
        if (originState.ProviderWindow is { IsVisible: true } existing)
        {
            existing.Activate();
            return;
        }

        var providerWeb = new WebView2();
        var window = new Window
        {
            Title = provider == "blocks" ? "REVEX · Blocks BIM Families" : "REVEX · Architextures Material",
            Width = 1320,
            Height = 860,
            MinWidth = 900,
            MinHeight = 640,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = providerWeb,
            ShowInTaskbar = false
        };
        Window? owner = Window.GetWindow(origin);
        if (owner is not null && owner.IsVisible) window.Owner = owner;

        BridgeState providerState = States.GetValue(providerWeb, _ => new BridgeState());
        providerState.ArmedProvider = provider;
        providerState.ReturnTarget = origin;
        providerState.ProviderWindow = window;
        originState.ProviderWindow = window;
        window.Closed += (_, _) =>
        {
            if (ReferenceEquals(originState.ProviderWindow, window)) originState.ProviderWindow = null;
            providerState.ArmedProvider = "";
            providerState.ReturnTarget = null;
            providerState.ProviderWindow = null;
            try { providerWeb.Dispose(); } catch { }
        };

        window.Show();
        try
        {
            await providerWeb.EnsureCoreWebView2Async(origin.CoreWebView2.Environment);
            AttachCore(providerWeb, providerState);
            providerWeb.CoreWebView2.Settings.AreDevToolsEnabled = false;
            providerWeb.CoreWebView2.Settings.IsStatusBarEnabled = false;
            providerWeb.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out Uri? target) && IsProviderUri(provider, target))
                {
                    args.Handled = true;
                    providerWeb.Source = target;
                }
            };
            providerWeb.Source = uri;
            await PostAsync(origin, new { type = "liber:revex-integration-opened", provider, url = uri.ToString() });
            RevexDiagnostics.Info("INTEGRATION", $"Owned provider browser opened: provider={provider}; url={uri}.");
        }
        catch
        {
            try { window.Close(); } catch { }
            throw;
        }
    }

    private static void HandleDownload(WebView2 web, BridgeState state, CoreWebView2DownloadStartingEventArgs e)
    {
        string provider = state.ArmedProvider;
        if (string.IsNullOrWhiteSpace(provider)) return;
        string suggested = SuggestedFileName(e.DownloadOperation, provider);
        string extension = Path.GetExtension(suggested).ToLowerInvariant();
        bool material = provider == "architextures" && extension is ".png" or ".jpg" or ".jpeg" or ".webp";
        bool family = provider == "blocks" && extension is ".rfa" or ".zip";
        if (!material && !family) return;

        string folder = Path.Combine(Path.GetTempPath(), "LIBER_REVEX", "integrations", provider);
        Directory.CreateDirectory(folder);
        string path = Path.Combine(folder, $"{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}{extension}");
        e.ResultFilePath = path;
        e.Handled = true;
        CoreWebView2DownloadOperation operation = e.DownloadOperation;

        async void StateChanged(object? _, object __)
        {
            if (operation.State == CoreWebView2DownloadState.InProgress) return;
            operation.StateChanged -= StateChanged;
            WebView2 target = state.ReturnTarget ?? web;
            bool retain = false;
            try
            {
                if (operation.State != CoreWebView2DownloadState.Completed)
                    throw new InvalidOperationException("The provider download did not complete.");
                FileInfo info = new(path);
                if (!info.Exists || info.Length <= 0) throw new InvalidOperationException("The provider download is empty.");

                if (material)
                {
                    if (info.Length > MaxMaterialBytes)
                        throw new InvalidOperationException($"Downloaded material image exceeds the {MaxMaterialBytes / 1024 / 1024} MB REVEX material limit.");
                    byte[] bytes = await File.ReadAllBytesAsync(path);
                    string mime = extension switch { ".jpg" or ".jpeg" => "image/jpeg", ".webp" => "image/webp", _ => "image/png" };
                    await PostAsync(target, new
                    {
                        type = "liber:revex-integration-material-r126",
                        provider,
                        name = suggested,
                        dataUrl = $"data:{mime};base64,{Convert.ToBase64String(bytes)}"
                    });
                    RevexDiagnostics.Info("INTEGRATION", $"Material download returned to Companion: file={suggested}; bytes={bytes.Length}.");
                }
                else
                {
                    if (info.Length > MaxFamilyBytes)
                        throw new InvalidOperationException($"Downloaded BIM family exceeds the {MaxFamilyBytes / 1024 / 1024} MB REVEX family limit.");
                    string token = Guid.NewGuid().ToString("N");
                    PendingFamilies[token] = new PendingFamily(path, suggested, info.Length, DateTime.UtcNow, target);
                    retain = true;
                    await PostAsync(target, new
                    {
                        type = "liber:revex-integration-family-r126",
                        provider,
                        token,
                        name = suggested,
                        bytes = info.Length
                    });
                    RevexDiagnostics.Info("INTEGRATION", $"Blocks family download armed for Revit placement: file={suggested}; bytes={info.Length}; token={token[..8]}…");
                }

                if (state.ProviderWindow is { IsVisible: true } providerWindow)
                    providerWindow.Dispatcher.BeginInvoke(new Action(providerWindow.Close));
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Error("INTEGRATION", "Could not return provider download to REVEX.", ex);
                await PostAsync(target, new { type = "liber:revex-integration-error", provider, message = ex.Message });
            }
            finally
            {
                if (!retain) try { if (File.Exists(path)) File.Delete(path); } catch { }
            }
        }
        operation.StateChanged += StateChanged;
    }

    private static void CleanupStaleFamilies()
    {
        DateTime threshold = DateTime.UtcNow.AddMinutes(-30);
        foreach (var pair in PendingFamilies.ToArray())
        {
            if (pair.Value.CreatedUtc >= threshold) continue;
            if (!PendingFamilies.TryRemove(pair.Key, out PendingFamily? pending)) continue;
            try { if (File.Exists(pending.Path)) File.Delete(pending.Path); } catch { }
        }
    }

    private static string SuggestedFileName(CoreWebView2DownloadOperation operation, string provider)
    {
        string disposition = operation.ContentDisposition ?? "";
        Match match = Regex.Match(disposition, "filename\\*?=(?:UTF-8''|\\\")?(?<name>[^\\\";]+)", RegexOptions.IgnoreCase);
        if (match.Success)
        {
            string name = Uri.UnescapeDataString(match.Groups["name"].Value.Trim().Trim('"'));
            if (!string.IsNullOrWhiteSpace(Path.GetExtension(name))) return Path.GetFileName(name);
        }
        try
        {
            Uri uri = new(operation.Uri);
            string name = Path.GetFileName(uri.LocalPath);
            if (!string.IsNullOrWhiteSpace(Path.GetExtension(name))) return name;
        }
        catch { }
        return provider == "blocks" ? "blocks-family.rfa" : "architextures.png";
    }

    private static Task PostAsync(WebView2 web, object payload)
    {
        string json = JsonSerializer.Serialize(payload);
        return web.Dispatcher.InvokeAsync(() =>
        {
            try { web.CoreWebView2?.PostWebMessageAsJson(json); }
            catch (Exception ex) { RevexDiagnostics.Warn("INTEGRATION", "Could not post integration result to Companion: " + ex.Message); }
        }).Task;
    }
}
