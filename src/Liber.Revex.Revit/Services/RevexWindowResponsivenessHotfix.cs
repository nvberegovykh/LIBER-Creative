using Liber.Revex.Revit.UI;
using Microsoft.Web.WebView2.Wpf;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using WpfTextBox = System.Windows.Controls.TextBox;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Keeps the embedded REVEX surface lightweight without becoming a second owner of
/// WebView navigation or renderer recovery. RendairWindow remains authoritative for
/// WebView2 lifetime, ProcessFailed recovery, project binding and Engineering work.
///
/// This adapter only does two UI jobs:
/// 1) intercept the obsolete one-time LIBER dashboard boot and replace it with REVEX
///    Companion after the base WebView has finished initializing; and
/// 2) map the native DESIGN / ENGINEERING buttons to BIM / Energy while keeping the
///    visible Companion module and its URL query state synchronized.
/// </summary>
public static class RevexWindowResponsivenessHotfix
{
    private const string HostBuild = "20260817r105-host";
    private static readonly BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly ConditionalWeakTable<RendairWindow, RuntimeState> States = new();

    private sealed class RuntimeState
    {
        public bool CoreBound;
        public bool InitialRouteDone;
    }

    public static void Attach(RendairWindow window)
    {
        if (States.TryGetValue(window, out _)) return;
        States.Add(window, new RuntimeState());

        Button? design = Field<Button>(window, "_designMode");
        Button? engineering = Field<Button>(window, "_engineeringMode");
        design?.AddHandler(Button.ClickEvent, new RoutedEventHandler((_, _) => _ = RouteAsync(window, "bim", false)), true);
        engineering?.AddHandler(Button.ClickEvent, new RoutedEventHandler((_, _) => _ = RouteAsync(window, "energy", false)), true);

        window.Loaded += (_, _) => _ = BindWhenReadyAsync(window);
        RevexDiagnostics.Info("WEB", "REVEX responsiveness adapter attached: dashboard boot interception + synchronized mode routing; renderer recovery remains owned by RendairWindow.");
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

        // InitializeBrowserAsync owns creation and ultimately assigns LiberAppsUrl.
        // The previous adapter navigated before that assignment completed, so the base
        // assignment could overwrite Companion a few milliseconds later. Intercept the
        // obsolete dashboard navigation itself instead: one event, one redirect, no race.
        web.CoreWebView2.NavigationStarting += (_, e) =>
        {
            if (state.InitialRouteDone || !IsGeneralLiberDashboard(e.Uri)) return;
            state.InitialRouteDone = true;
            e.Cancel = true;
            _ = window.Dispatcher.BeginInvoke(new Action(() =>
            {
                if (!window.IsVisible) return;
                string mode = BoolField(window, "_engineeringModeActive") ? "energy" : "bim";
                Uri target = BuildCompanionUri(window, mode, fresh: true);
                RevexDiagnostics.Info("WEB", $"Replaced obsolete LIBER dashboard boot with REVEX Companion. mode={mode}; target={target}");
                web.Source = target;
            }));
        };

        Uri? current = web.Source;
        if (IsCompanion(current))
        {
            state.InitialRouteDone = true;
            return;
        }

        // If the dashboard navigation completed before this adapter attached, recover
        // once from the already-visible dashboard. Do not navigate from about:blank;
        // waiting for InitializeBrowserAsync avoids recreating the original race.
        if (IsGeneralLiberDashboard(current?.AbsoluteUri))
        {
            state.InitialRouteDone = true;
            string mode = BoolField(window, "_engineeringModeActive") ? "energy" : "bim";
            Uri target = BuildCompanionUri(window, mode, fresh: true);
            RevexDiagnostics.Info("WEB", $"Replacing already-loaded LIBER dashboard with REVEX Companion. mode={mode}; target={target}");
            web.Source = target;
        }
    }

    private static async Task RouteAsync(RendairWindow window, string mode, bool forceReload)
    {
        WebView2? web = Field<WebView2>(window, "_web");
        if (web?.CoreWebView2 == null) return;

        try
        {
            if (!forceReload && IsCompanion(web.Source))
            {
                string modeJson = JsonSerializer.Serialize(mode);
                string projectId = Field<WpfTextBox>(window, "_projectId")?.Text.Trim() ?? "";
                string specProjectId = Field<WpfTextBox>(window, "_specProjectId")?.Text.Trim() ?? "";
                string projectJson = JsonSerializer.Serialize(projectId);
                string specJson = JsonSerializer.Serialize(specProjectId);
                string result = await web.ExecuteScriptAsync($$$"""
                    (() => {
                      const mode = {{{modeJson}}};
                      const projectId = {{{projectJson}}};
                      const specProjectId = {{{specJson}}};
                      try {
                        const url = new URL(location.href);
                        url.searchParams.set('build', '{{{HostBuild}}}');
                        url.searchParams.set('host', 'revit');
                        url.searchParams.set('view', mode);
                        if (projectId) url.searchParams.set('projectId', projectId);
                        else url.searchParams.delete('projectId');
                        if (specProjectId) url.searchParams.set('specProjectId', specProjectId);
                        else url.searchParams.delete('specProjectId');
                        history.replaceState(history.state, '', url);
                      } catch (_) {}
                      if (projectId) {
                        window.dispatchEvent(new CustomEvent('revex:native-project-binding', {
                          detail: { projectId, specProjectId, view: mode }
                        }));
                      }
                      const button = document.querySelector(`[data-view="${mode}"]`);
                      if (button) { button.click(); return true; }
                      return false;
                    })();
                    """);
                if (string.Equals(result, "true", StringComparison.OrdinalIgnoreCase))
                {
                    RevexDiagnostics.Info("WEB", $"Native mode switch routed in-place to REVEX {mode}; URL view state synchronized.");
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("WEB", "In-place REVEX mode routing failed; using one clean Companion navigation: " + ex.Message);
        }

        Uri target = BuildCompanionUri(window, mode, fresh: true);
        RevexDiagnostics.Info("WEB", $"REVEX mode navigation. mode={mode}; target={target}");
        web.Source = target;
    }

    private static Uri BuildCompanionUri(RendairWindow window, string mode, bool fresh)
    {
        BridgeSettings? settings = Field<BridgeSettings>(window, "_bridgeSettings");
        string baseUrl = string.IsNullOrWhiteSpace(settings?.LiberRevexUrl)
            ? "https://liberpict.com/liber-apps/apps/revex/index.html"
            : settings!.LiberRevexUrl;
        string projectId = Field<WpfTextBox>(window, "_projectId")?.Text.Trim() ?? "";
        string specProjectId = Field<WpfTextBox>(window, "_specProjectId")?.Text.Trim() ?? "";

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

    private static bool BoolField(RendairWindow window, string name)
    {
        object? value = typeof(RendairWindow).GetField(name, PrivateInstance)?.GetValue(window);
        return value is bool flag && flag;
    }
}
