using Liber.Revex.Revit.Models;
using Microsoft.Web.WebView2.Wpf;
using System.IO;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

public static class CompanionWebBridge
{
    public static async Task<(bool ok, string message)> AttachSyncPackageAsync(
        WebView2 web,
        RevexSyncOutput output)
    {
        if (web.CoreWebView2 == null)
            return (false, "REVEX Companion browser is not initialized.");

        string[] files = new[]
        {
            output.ProjectJson,
            output.DesignBookJson,
            output.SpecPushJson,
            output.ViewerMetadata,
            output.PrintingSetsManifest,
            output.AffectedPlansManifest,
            output.IntegrityJson,
            output.ViewerIfc,
            output.ViewerMesh,
            output.ViewerFbx
        }.Concat(output.PrintingSetPdfs ?? Array.Empty<string>())
         .Concat(output.AffectedPlanPdfs ?? Array.Empty<string>())
         .Where(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path))
         .Select(path => Path.GetFullPath(path!))
         .ToArray();

        string[] required = new[]
        {
            output.ProjectJson, output.DesignBookJson, output.SpecPushJson,
            output.ViewerMetadata, output.AffectedPlansManifest, output.IntegrityJson, output.ViewerIfc
        }.Where(path => !string.IsNullOrWhiteSpace(path)).Select(path => path!).ToArray();
        if (required.Length != 7 || required.Any(path => !File.Exists(path)))
            return (false, "The REVEX sync package is incomplete or has no IFC authority model; it was not published.");

        // NavigationCompleted can fire before REVEX app.js has bound the hidden
        // file input's change handler. Wait for the hosted Companion's explicit
        // readiness barrier so the native file event can never be lost.
        bool ready = false;
        for (int attempt = 0; attempt < 80; attempt++)
        {
            string probe = await web.ExecuteScriptAsync("""
            (() => {
              const input = document.querySelector("input[data-liber-revex-sync-upload='1']");
              if (!input) return false;
              return window.__liberRevexNativeSyncReady === true ||
                     input.dataset.liberRevexSyncHandlerReady === '1';
            })();
            """);
            if (string.Equals(probe, "true", StringComparison.OrdinalIgnoreCase))
            {
                ready = true;
                break;
            }
            await Task.Delay(100);
        }
        if (!ready)
            return (false, "REVEX Companion loaded but its native sync handler did not become ready within 8 seconds.");

        const string markInput = """
        (() => {
          const input = document.querySelector("input[data-liber-revex-sync-upload='1']");
          if (!input) return false;
          input.setAttribute('data-liber-revex-native-ready', '1');
          return true;
        })();
        """;

        string marked = await web.ExecuteScriptAsync(markInput);
        if (!string.Equals(marked, "true", StringComparison.OrdinalIgnoreCase))
            return (false, "The hosted REVEX Companion did not expose its native sync input.");

        string documentJson = await web.CoreWebView2.CallDevToolsProtocolMethodAsync(
            "DOM.getDocument", "{\"depth\":1,\"pierce\":true}");
        using JsonDocument document = JsonDocument.Parse(documentJson);
        int rootNodeId = document.RootElement.GetProperty("root").GetProperty("nodeId").GetInt32();

        string queryJson = JsonSerializer.Serialize(new
        {
            nodeId = rootNodeId,
            selector = "input[data-liber-revex-native-ready='1']"
        });
        string queryResult = await web.CoreWebView2.CallDevToolsProtocolMethodAsync(
            "DOM.querySelector", queryJson);
        using JsonDocument query = JsonDocument.Parse(queryResult);
        int inputNodeId = query.RootElement.GetProperty("nodeId").GetInt32();
        if (inputNodeId == 0)
            return (false, "The REVEX Companion sync input disappeared before attachment.");

        // DevTools DOM.setFileInputFiles may itself fire the native file-input
        // change event. Arm a one-shot probe before setting files and only
        // dispatch a synthetic change if Chromium did not emit one. This keeps
        // one revision = one cloud publish.
        await web.ExecuteScriptAsync("""
        (() => {
          const input = document.querySelector("input[data-liber-revex-native-ready='1']");
          if (!input) return false;
          window.__liberRevexNativeFileEventSeen = false;
          input.addEventListener('change', () => {
            window.__liberRevexNativeFileEventSeen = true;
          }, { once: true });
          return true;
        })();
        """);

        await web.CoreWebView2.CallDevToolsProtocolMethodAsync(
            "DOM.setFileInputFiles",
            JsonSerializer.Serialize(new { files, nodeId = inputNodeId }));

        await Task.Delay(250);
        string eventSeen = await web.ExecuteScriptAsync(
            "Boolean(window.__liberRevexNativeFileEventSeen)");
        if (!string.Equals(eventSeen, "true", StringComparison.OrdinalIgnoreCase))
        {
            await web.ExecuteScriptAsync("""
            (() => {
              const input = document.querySelector("input[data-liber-revex-native-ready='1']");
              if (!input) return false;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })();
            """);
        }

        return (true, $"Revision {output.Revision} attached; Companion is validating and publishing it.");
    }
}
