using Liber.Revex.Revit.Models;
using Microsoft.Web.WebView2.Wpf;
using System.IO;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

public static class CompanionWebBridge
{
    public static async Task<(bool ok, string message)> AttachSyncPackageAsync(
        WebView2 web,
        RevexSyncOutput output,
        string attemptId,
        string projectId,
        string documentUniqueId,
        string documentFingerprint,
        string identityEvidenceDigest)
    {
        if (web.CoreWebView2 == null)
            return (false, "REVEX Companion browser is not initialized.");

        // The exact browser model is paged in r49. Keep the manifest and every page
        // in the same native file-input transaction as project/design/spec metadata.
        // Previously the Revit exporter produced these files correctly, but this bridge
        // omitted them, so the browser rejected the new immutable revision and kept the
        // prior BIM pointer visible.
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
            output.ViewerMeshManifest,
            output.ViewerFbx
        }.Concat(output.ViewerMeshPages ?? Array.Empty<string>())
         .Concat(output.PrintingSetPdfs ?? Array.Empty<string>())
         .Concat(output.AffectedPlanPdfs ?? Array.Empty<string>())
         .Where(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path))
         .Select(path => Path.GetFullPath(path!))
         .Distinct(StringComparer.OrdinalIgnoreCase)
         .ToArray();

        string[] required = new[]
        {
            output.ProjectJson, output.DesignBookJson, output.SpecPushJson,
            output.ViewerMetadata, output.AffectedPlansManifest, output.IntegrityJson, output.ViewerIfc
        }.Where(path => !string.IsNullOrWhiteSpace(path)).Select(path => path!).ToArray();
        if (required.Length != 7 || required.Any(path => !File.Exists(path)))
            return (false, "The REVEX sync package is incomplete or has no IFC authority model; it was not published.");

        bool hasPagedGeometry = !string.IsNullOrWhiteSpace(output.ViewerMeshManifest) &&
                                File.Exists(output.ViewerMeshManifest) &&
                                output.ViewerMeshPages != null &&
                                output.ViewerMeshPages.Count > 0 &&
                                output.ViewerMeshPages.All(File.Exists);
        bool hasLegacyGeometry = !string.IsNullOrWhiteSpace(output.ViewerMesh) && File.Exists(output.ViewerMesh);
        if (!hasPagedGeometry && !hasLegacyGeometry)
            return (false, "The REVEX sync package has no complete exact Revit geometry stream; the prior BIM revision remains current.");
        if (string.IsNullOrWhiteSpace(attemptId) || string.IsNullOrWhiteSpace(projectId) ||
            string.IsNullOrWhiteSpace(documentUniqueId) || string.IsNullOrWhiteSpace(documentFingerprint) ||
            string.IsNullOrWhiteSpace(identityEvidenceDigest))
            return (false, "The native sync attempt has no complete project/document identity envelope; no files were attached.");

        RevexDiagnostics.Info("SYNC", hasPagedGeometry
            ? $"Companion attachment includes paged exact geometry: manifest={Path.GetFileName(output.ViewerMeshManifest)}; pages={output.ViewerMeshPages.Count}."
            : $"Companion attachment includes legacy exact geometry: {Path.GetFileName(output.ViewerMesh)}.");

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

        string envelopeJson = JsonSerializer.Serialize(new
        {
            attemptId,
            projectId,
            revision = output.Revision,
            documentUniqueId,
            documentFingerprint,
            identityEvidenceDigest
        });
        string markInput = $$"""
        (() => {
          const input = document.querySelector("input[data-liber-revex-sync-upload='1']");
          if (!input) return false;
          const envelope = {{envelopeJson}};
          window.__liberRevexNativeSyncEnvelope = Object.freeze(envelope);
          input.dataset.liberRevexNativeAttemptId = envelope.attemptId;
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

        return (true, $"Revision {output.Revision} attached with {(hasPagedGeometry ? output.ViewerMeshPages.Count + " exact geometry page(s)" : "exact geometry")}; Companion is validating and publishing it.");
    }
}
