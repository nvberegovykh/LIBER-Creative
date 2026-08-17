using Liber.Revex.Revit.UI;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Windows;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Keeps the embedded REVEX surface deterministic without becoming a second owner of
/// project/data behavior. RendairWindow remains authoritative for project binding,
/// Engineering work and normal navigation.
///
/// This adapter does only host-level browser resilience:
/// 1) intercept the obsolete one-time LIBER dashboard boot and replace it with REVEX
///    Companion after the base WebView has initialized; and
/// 2) if WebView2 reports a renderer stall/exit, reload the exact current URL once.
///
/// Native DESIGN / ENGINEERING buttons intentionally control only the native Revit
/// control rail. Companion BIM / Energy tabs are independent browser controls. This
/// prevents overlapping ExecuteScriptAsync tab changes from blocking the WebView render
/// process while a user switches native modes quickly.
/// </summary>
public static class RevexWindowResponsivenessHotfix
{
    private const string HostBuild = "20260817r106-host";
    private static readonly BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly ConditionalWeakTable<RendairWindow, RuntimeState> States = new();

    private sealed class RuntimeState
    {
        public bool CoreBound;
        public bool InitialRouteDone;
        public bool RecoveryPending;
    }

    public static void Attach(RendairWindow window)
    {
        if (States.TryGetValue(window, out _)) return;
        States.Add(window, new RuntimeState());

        window.Loaded += (_, _) => _ = BindWhenReadyAsync(window);
        RevexDiagnostics.Info("WEB", "REVEX responsiveness adapter attached: dashboard interception + same-URL first-stall recovery; native mode rail is decoupled from Companion tabs.");
    }

    private static async Task BindWhenReadyAsync(RendairWindow window)
    {
        WebView2? web = Field<WebView2>(window, "_web");
        if (web == null) return;

        for (int attempt = 0; attempt < 120 && web.CoreWebView2 == null && window.IsVisible; attempt++)
            await Task.Delay(50);
        if (web.CoreWebView2 == null || !window.IsVisible) return;

        if (!States.TryGetValue(window, out RuntimeState? state))
        {
            state = new RuntimeState();
            States.Add(window, state);
        }
        if (state.CoreBound) return;
        state.CoreBound = true;

        // InitializeBrowserAsync owns WebView creation and assigns LiberAppsUrl once.
        // Intercept that obsolete dashboard navigation itself so there is no second
        // startup navigator racing the base window.
        web.CoreWebView2.NavigationStarting += (_, e) =>
        {
            if (state.InitialRouteDone || !IsGeneralLiberDashboard(e.Uri)) return;
            state.InitialRouteDone = true;
            e.Cancel = true;
            _ = window.Dispatcher.BeginInvoke(new Action(() =>
            {
                if (!window.IsVisible) return;
                Uri target = BuildCompanionUri(window, "bim", fresh: true);
                RevexDiagnostics.Info("WEB", $"Replaced obsolete LIBER dashboard boot with REVEX Companion. target={target}");
                web.Source = target;
            }));
        };

        // The base window historically waited for a second RenderProcessUnresponsive
        // event before recovery. WebView2 can emit only one event for a permanently hung
        // renderer, which leaves the visible Companion dead forever. Recover the first
        // event, but never reconstruct a URL or infer a module: reload exactly what the
        // user was looking at. A pending flag prevents repeated recovery storms.
        web.CoreWebView2.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessUnresponsive &&
                e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessExited)
                return;
            if (state.RecoveryPending || !window.IsVisible) return;

            Uri? current = web.Source;
            if (current == null) return;
            state.RecoveryPending = true;
            string currentUrl = current.AbsoluteUri;
            RevexDiagnostics.Warn("WEB", $"REVEX renderer recovery requested: kind={e.ProcessFailedKind}; preserving current={currentUrl}");
            _ = window.Dispatcher.BeginInvoke(new Action(() =>
            {
                try
                {
                    if (!window.IsVisible) return;
                    web.Reload();
                }
                catch (Exception ex)
                {
                    state.RecoveryPending = false;
                    RevexDiagnostics.Error("WEB", "Same-URL renderer recovery failed.", ex);
                }
            }));
        };

        web.CoreWebView2.NavigationCompleted += (_, _) => state.RecoveryPending = false;

        Uri? current = web.Source;
        if (IsCompanion(current))
        {
            state.InitialRouteDone = true;
            return;
        }

        // If the dashboard completed before the interception handler attached, replace
        // it once. Never navigate proactively from about:blank.
        if (IsGeneralLiberDashboard(current?.AbsoluteUri))
        {
            state.InitialRouteDone = true;
            Uri target = BuildCompanionUri(window, "bim", fresh: true);
            RevexDiagnostics.Info("WEB", $"Replacing already-loaded LIBER dashboard with REVEX Companion. target={target}");
            web.Source = target;
        }
    }

    private static Uri BuildCompanionUri(RendairWindow window, string mode, bool fresh)
    {
        BridgeSettings? settings = Field<BridgeSettings>(window, "_bridgeSettings");
        string baseUrl = string.IsNullOrWhiteSpace(settings?.LiberRevexUrl)
            ? "https://liberpict.com/liber-apps/apps/revex/index.html"
            : settings!.LiberRevexUrl;
        string projectId = Field<System.Windows.Controls.TextBox>(window, "_projectId")?.Text.Trim() ?? "";
        string specProjectId = Field<System.Windows.Controls.TextBox>(window, "_specProjectId")?.Text.Trim() ?? "";

        string separator = baseUrl.Contains('?') ? "&" : "?";
        string url = baseUrl + separator + "build=" + HostBuild +
                     "&host=revit" +
                     "&view=" + Uri.EscapeDataString(mode);
        if (fresh) url += "&fresh=" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!string.IsNullOrWhiteSpace(projectId))
            url += "&projectId=" + Uri.EscapeDataString(projectId);
        if (!string.IsNullOrWhiteSpace(specProjectId))
            url += "&specProjectId=" + Uri.EscapeDataString(specProjectId);
        return new Uri(url);
    }

    private static bool IsCompanion(Uri? uri) =>
        uri != null && uri.AbsolutePath.Contains("/liber-apps/apps/revex/", StringComparison.OrdinalIgnoreCase);

    private static bool IsGeneralLiberDashboard(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri)) return false;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out Uri? parsed)) return false;
        if (!parsed.Host.Equals("liberpict.com", StringComparison.OrdinalIgnoreCase) &&
            !parsed.Host.EndsWith(".liberpict.com", StringComparison.OrdinalIgnoreCase)) return false;
        string path = parsed.AbsolutePath.TrimEnd('/');
        return path.Equals("/liber-apps", StringComparison.OrdinalIgnoreCase);
    }

    private static T? Field<T>(RendairWindow window, string name) where T : class =>
        typeof(RendairWindow).GetField(name, PrivateInstance)?.GetValue(window) as T;
}
