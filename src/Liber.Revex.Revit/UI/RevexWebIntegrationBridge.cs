using Liber.Revex.Revit.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.IO;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;

namespace Liber.Revex.Revit.UI;

/// <summary>
/// Shared REVEX WebView2 integration endpoint.
///
/// Provider websites are never scripted or scraped. Companion requests an owned
/// provider browser, the user interacts with the provider normally, and only a
/// user-triggered supported image download is returned to the originating
/// Companion WebView as a lightweight integration result.
/// </summary>
internal static class RevexWebIntegrationBridge
{
    private const long MaxMaterialBytes = 12L * 1024L * 1024L;
    private static readonly Uri ArchitexturesCreate = new("https://architextures.org/create");

    private sealed class BridgeState
    {
        public string ArmedProvider { get; set; } = "";
        public bool CoreAttached { get; set; }
        public WebView2? ReturnTarget { get; set; }
        public Window? ProviderWindow { get; set; }
    }

    private static readonly ConditionalWeakTable<WebView2, BridgeState> States = new();

    [ModuleInitializer]
    internal static void Install()
    {
        EventManager.RegisterClassHandler(
            typeof(WebView2),
            FrameworkElement.LoadedEvent,
            new RoutedEventHandler(OnWebViewLoaded));
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
            RevexDiagnostics.Error("INTEGRATION", "Could not open REVEX provider browser.", ex);
            await PostAsync(web, new
            {
                type = "liber:revex-integration-error",
                provider = "architextures",
                message = ex.Message
            });
        }
    }

    private static string ReadProvider(JsonElement root) =>
        root.TryGetProperty("provider", out JsonElement providerEl)
            ? (providerEl.GetString() ?? "").Trim().ToLowerInvariant()
            : "";

    private static Uri ResolveProviderUri(string provider, string requestedUrl)
    {
        if (!string.Equals(provider, "architextures", StringComparison.Ordinal))
            throw new InvalidOperationException("Unsupported REVEX material provider.");

        Uri candidate = ArchitexturesCreate;
        if (!string.IsNullOrWhiteSpace(requestedUrl) &&
            Uri.TryCreate(requestedUrl, UriKind.Absolute, out Uri? parsed) &&
            IsArchitexturesUri(parsed))
            candidate = parsed;
        return candidate;
    }

    private static bool IsArchitexturesUri(Uri uri)
    {
        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)) return false;
        string host = uri.Host.Trim().TrimEnd('.').ToLowerInvariant();
        return host == "architextures.org" || host.EndsWith(".architextures.org", StringComparison.Ordinal);
    }

    private static async Task OpenProviderAsync(WebView2 origin, BridgeState originState, string provider, Uri uri)
    {
        if (origin.CoreWebView2 is null)
            throw new InvalidOperationException("REVEX Companion browser is not ready yet.");

        if (originState.ProviderWindow is { IsVisible: true } existing)
        {
            existing.Activate();
            return;
        }

        var providerWeb = new WebView2();
        var window = new Window
        {
            Title = "REVEX · Architextures Material",
            Width = 1320,
            Height = 860,
            MinWidth = 980,
            MinHeight = 680,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = providerWeb,
            ShowInTaskbar = false
        };
        Window? owner = Window.GetWindow(origin);
        if (owner is not null && owner.IsVisible)
            window.Owner = owner;

        BridgeState providerState = States.GetValue(providerWeb, _ => new BridgeState());
        providerState.ArmedProvider = provider;
        providerState.ReturnTarget = origin;
        providerState.ProviderWindow = window;
        originState.ProviderWindow = window;

        window.Closed += (_, _) =>
        {
            if (ReferenceEquals(originState.ProviderWindow, window))
                originState.ProviderWindow = null;
            providerState.ArmedProvider = "";
            providerState.ReturnTarget = null;
            providerState.ProviderWindow = null;
            try { providerWeb.Dispose(); } catch { }
        };

        window.Show();
        try
        {
            // Same environment/profile as Companion: login/cookies/cache are shared,
            // but the provider receives its own owned browser surface and cannot block
            // the BIM renderer or replace the Companion route.
            await providerWeb.EnsureCoreWebView2Async(origin.CoreWebView2.Environment);
            AttachCore(providerWeb, providerState);
            providerWeb.CoreWebView2.Settings.AreDevToolsEnabled = false;
            providerWeb.CoreWebView2.Settings.IsStatusBarEnabled = false;
            providerWeb.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out Uri? target) && IsArchitexturesUri(target))
                {
                    args.Handled = true;
                    providerWeb.Source = target;
                }
            };
            providerWeb.Source = uri;
            await PostAsync(origin, new
            {
                type = "liber:revex-integration-opened",
                provider,
                url = uri.ToString()
            });
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

        string suggested = SuggestedFileName(e.DownloadOperation);
        string extension = Path.GetExtension(suggested).ToLowerInvariant();
        if (extension is not ".png" and not ".jpg" and not ".jpeg" and not ".webp")
            return;

        string folder = Path.Combine(Path.GetTempPath(), "LIBER_REVEX", "integrations", provider);
        Directory.CreateDirectory(folder);
        string fileName = $"{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}{extension}";
        string path = Path.Combine(folder, fileName);

        e.ResultFilePath = path;
        e.Handled = true;
        CoreWebView2DownloadOperation operation = e.DownloadOperation;

        async void StateChanged(object? _, object __)
        {
            if (operation.State == CoreWebView2DownloadState.InProgress) return;
            operation.StateChanged -= StateChanged;
            WebView2 target = state.ReturnTarget ?? web;
            try
            {
                if (operation.State != CoreWebView2DownloadState.Completed)
                {
                    await PostAsync(target, new
                    {
                        type = "liber:revex-integration-error",
                        provider,
                        message = "The material download did not complete."
                    });
                    return;
                }

                FileInfo info = new(path);
                if (!info.Exists || info.Length <= 0)
                    throw new InvalidOperationException("Downloaded material image is empty.");
                if (info.Length > MaxMaterialBytes)
                    throw new InvalidOperationException($"Downloaded material image exceeds the {MaxMaterialBytes / 1024 / 1024} MB REVEX material limit.");

                byte[] bytes = await File.ReadAllBytesAsync(path);
                string mime = extension switch
                {
                    ".jpg" or ".jpeg" => "image/jpeg",
                    ".webp" => "image/webp",
                    _ => "image/png"
                };
                string dataUrl = $"data:{mime};base64,{Convert.ToBase64String(bytes)}";
                await PostAsync(target, new
                {
                    type = "liber:revex-integration-file",
                    provider,
                    name = suggested,
                    dataUrl
                });
                RevexDiagnostics.Info("INTEGRATION", $"User material download returned to Companion: provider={provider}; file={suggested}; bytes={bytes.Length}.");

                if (state.ProviderWindow is { IsVisible: true } providerWindow)
                    providerWindow.Dispatcher.BeginInvoke(new Action(providerWindow.Close));
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Error("INTEGRATION", "Could not return provider download to Companion.", ex);
                await PostAsync(target, new
                {
                    type = "liber:revex-integration-error",
                    provider,
                    message = ex.Message
                });
            }
            finally
            {
                try { if (File.Exists(path)) File.Delete(path); } catch { }
            }
        }

        operation.StateChanged += StateChanged;
    }

    private static string SuggestedFileName(CoreWebView2DownloadOperation operation)
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

        return "architextures.png";
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
