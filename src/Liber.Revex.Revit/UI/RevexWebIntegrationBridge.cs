using Liber.Revex.Revit.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;

namespace Liber.Revex.Revit.UI;

/// <summary>
/// Lightweight provider bridge shared by every REVEX WebView2 surface.
/// It never automates a provider website. A Companion modal explicitly arms a
/// provider, the user performs the download, and WebView2 hands that downloaded
/// file back to Companion as one local integration result.
/// </summary>
internal static class RevexWebIntegrationBridge
{
    private sealed class BridgeState
    {
        public string ArmedProvider { get; set; } = "";
        public bool CoreAttached { get; set; }
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
        RevexDiagnostics.Info("INTEGRATION", "WebView2 user-download bridge attached.");
    }

    private static void HandleWebMessage(WebView2 web, BridgeState state, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            string json = e.WebMessageAsJson ?? "";
            if (string.IsNullOrWhiteSpace(json)) return;
            using JsonDocument doc = JsonDocument.Parse(json);
            JsonElement root = doc.RootElement;
            if (!root.TryGetProperty("type", out JsonElement typeEl) ||
                !string.Equals(typeEl.GetString(), "liber:revex-integration-arm", StringComparison.Ordinal))
                return;

            string provider = root.TryGetProperty("provider", out JsonElement providerEl)
                ? (providerEl.GetString() ?? "").Trim().ToLowerInvariant()
                : "";
            bool active = !root.TryGetProperty("active", out JsonElement activeEl) || activeEl.ValueKind != JsonValueKind.False;
            state.ArmedProvider = active ? provider : "";
            RevexDiagnostics.Info("INTEGRATION", active
                ? $"Provider download handoff armed: {provider}."
                : "Provider download handoff disarmed.");
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("INTEGRATION", "Could not parse integration-arm message: " + ex.Message);
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
            try
            {
                if (operation.State != CoreWebView2DownloadState.Completed)
                {
                    await PostAsync(web, new
                    {
                        type = "liber:revex-integration-error",
                        provider,
                        message = "The provider download did not complete."
                    });
                    return;
                }

                FileInfo info = new(path);
                if (!info.Exists || info.Length <= 0)
                    throw new InvalidOperationException("Downloaded provider image is empty.");
                if (info.Length > 16 * 1024 * 1024)
                    throw new InvalidOperationException("Downloaded provider image exceeds the 16 MB REVEX material limit.");

                byte[] bytes = await File.ReadAllBytesAsync(path);
                string mime = extension switch
                {
                    ".jpg" or ".jpeg" => "image/jpeg",
                    ".webp" => "image/webp",
                    _ => "image/png"
                };
                string dataUrl = $"data:{mime};base64,{Convert.ToBase64String(bytes)}";
                await PostAsync(web, new
                {
                    type = "liber:revex-integration-file",
                    provider,
                    name = suggested,
                    dataUrl
                });
                RevexDiagnostics.Info("INTEGRATION", $"User download returned to Companion: provider={provider}; file={suggested}; bytes={bytes.Length}.");
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Error("INTEGRATION", "Could not return provider download to Companion.", ex);
                await PostAsync(web, new
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
