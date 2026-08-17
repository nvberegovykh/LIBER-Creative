using Liber.Revex.Revit.UI;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using WpfTextBox = System.Windows.Controls.TextBox;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Keeps the embedded REVEX surface lightweight and deterministic without changing
/// any BIM / Design / Spec / Energy data behavior. The Revit window used to boot the
/// full LIBER Apps dashboard and only changed the native left panel when DESIGN /
/// ENGINEERING was pressed. On some WebView2 GPUs that dashboard could leave the
/// renderer unresponsive before the actual Companion was even opened.
///
/// This adapter is deliberately additive: it routes the embedded browser straight to
/// REVEX Companion, maps the two native mode buttons to BIM / Energy, and recovers a
/// first renderer-unresponsive event to the same project/mode instead of reloading a
/// heavy unrelated shell.
/// </summary>
public static class RevexWindowResponsivenessHotfix
{
    private static readonly BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly ConditionalWeakTable<RendairWindow, RuntimeState> States = new();

    private sealed class RuntimeState
    {
        public bool CoreBound;
        public bool InitialRouteDone;
        public DateTime LastRecoveryUtc = DateTime.MinValue;
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
        RevexDiagnostics.Info("WEB", "REVEX responsiveness adapter attached: direct Companion boot + mode routing + first-event renderer recovery.");
    }

    private static async Task BindWhenReadyAsync(RendairWindow window)
    {
        WebView2? web = Field<WebView2>(window, "_web");
        if (web == null) return;

        for (int attempt = 0; attempt < 120 && web.CoreWebView2 == null && window.IsVisible; attempt++)
            await Task.Delay(50);
        if (web.CoreWebView2 == null || !window.IsVisible) return;

        RuntimeState state = States.GetOrCreateValue(window);
        if (!state.CoreBound)
        {
            state.CoreBound = true;
            web.CoreWebView2.ProcessFailed += (_, e) =>
            {
                if (e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessUnresponsive &&
                    e.ProcessFailedKind != CoreWebView2ProcessFailedKind.RenderProcessExited)
                    return;

                DateTime now = DateTime.UtcNow;
                if ((now - state.LastRecoveryUtc).TotalSeconds < 5) return;
                state.LastRecoveryUtc = now;

                _ = window.Dispatcher.BeginInvoke(new Action(() =>
                {
                    string mode = BoolField(window, "_engineeringModeActive") ? "energy" : "bim";
                    RevexDiagnostics.Warn("WEB", $"REVEX renderer recovery: kind={e.ProcessFailedKind}; mode={mode}; current={web.Source}");
                    try { web.CoreWebView2?.Stop(); } catch { }
                    web.Source = BuildCompanionUri(window, mode, fresh: true);
                }));
            };
        }

        // The native host is a REVEX tool. Do not spend its renderer budget on the
        // general LIBER dashboard first; the Account button can still navigate there
        // explicitly when the user asks for it.
        if (!state.InitialRouteDone)
        {
            state.InitialRouteDone = true;
            await Task.Delay(25);
            Uri? current = web.Source;
            bool onCompanion = IsCompanion(current);
            if (!onCompanion)
            {
                RevexDiagnostics.Info("WEB", "Skipping general LIBER dashboard in Revit; opening REVEX Companion directly.");
                web.Source = BuildCompanionUri(window, BoolField(window, "_engineeringModeActive") ? "energy" : "bim", fresh: true);
            }
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
                    RevexDiagnostics.Info("WEB", $"Native mode switch routed in-place to REVEX {mode}.");
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("WEB", "In-place REVEX mode routing failed; using a clean Companion navigation: " + ex.Message);
        }

        web.Source = BuildCompanionUri(window, mode, fresh: true);
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
        string url = baseUrl + separator + "build=20260817r101-host" +
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

    private static T? Field<T>(RendairWindow window, string name) where T : class =>
        typeof(RendairWindow).GetField(name, PrivateInstance)?.GetValue(window) as T;

    private static bool BoolField(RendairWindow window, string name) =>
        typeof(RendairWindow).GetField(name, PrivateInstance)?.GetValue(window) as bool? ?? false;
}
