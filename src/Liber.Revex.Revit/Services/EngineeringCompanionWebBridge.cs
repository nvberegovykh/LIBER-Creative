using Liber.Revex.Revit.Models;
using Microsoft.Web.WebView2.Wpf;
using System.IO;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

public static class EngineeringCompanionWebBridge
{
    private const string ManagedBridgeVersion = "20260813r49";
    private const string EnergyInputSelector = "input[data-liber-revex-energy-input='1']";

    public static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeAsync(WebView2 web)
    {
        if (web.CoreWebView2 == null) return (false, "REVEX Companion browser is not initialized.");
        string asset = Path.Combine(AppPaths.InstallRoot, "Engineering", "Companion", "native-managed-energy-bridge.js");
        if (!File.Exists(asset)) return (false, "The installed native managed Energy bridge is missing: " + asset);

        string script = await File.ReadAllTextAsync(asset);
        await web.ExecuteScriptAsync(script);
        string probe = await web.ExecuteScriptAsync($"String(window.__revexManagedEnergyBridge?.version || '') === {JsonSerializer.Serialize(ManagedBridgeVersion)}");
        if (!string.Equals(probe, "true", StringComparison.OrdinalIgnoreCase))
            return (false, "The native managed Energy bridge did not initialize in Companion.");
        return (true, "Native managed Energy bridge ready.");
    }

    public static async Task<(bool ok, string message)> AttachEngineeringSyncAsync(WebView2 web, EngineeringSyncOutput output)
    {
        string[] files = new[] { output.ManifestPath, output.GbxmlPath, output.GbxmlReportPath, output.GbxmlSummaryPath, output.WeatherPath }
            .Concat(output.EvidenceFiles ?? Array.Empty<string>()).Where(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path))
            .Select(path => Path.GetFullPath(path!)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (!File.Exists(output.ManifestPath) || !File.Exists(output.GbxmlPath) || !File.Exists(output.WeatherPath))
            return (false, "The Engineering Sync revision is incomplete or has no verified weather input.");

        var installed = await EnsureManagedEnergyBridgeAsync(web);
        if (!installed.ok) return installed;

        var set = await SetFilesAsync(web, EnergyInputSelector, "data-liber-revex-native-energy-input-ready", files);
        if (!set.ok) return set;

        string selectorJson = JsonSerializer.Serialize(EnergyInputSelector);
        string started = await web.ExecuteScriptAsync($$"""
            (() => {
              const bridge = window.__revexManagedEnergyBridge;
              const input = document.querySelector({{selectorJson}});
              if (!bridge?.processInput || !input?.files?.length) return false;
              void bridge.processInput(input.files);
              return true;
            })()
            """);
        if (!string.Equals(started, "true", StringComparison.OrdinalIgnoreCase))
            return (false, "The native managed Energy bridge could not start processing the attached Engineering revision.");

        return (true, $"Engineering revision {output.Revision} handed directly to the native managed-server bridge; legacy hosted Energy handlers were bypassed.");
    }

    public static async Task<(bool ok, string message)> AttachEnergyResultAsync(WebView2 web, EnergyPipelineOutput output)
    {
        string[] files = new[] { output.ResultManifestPath }.Concat(output.ArtifactPaths ?? Array.Empty<string>())
            .Where(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path)).Select(Path.GetFullPath).ToArray();
        if (!File.Exists(output.ResultManifestPath))
            return (false, "The Energy result manifest is missing.");
        // Backward-compatible diagnostic path only. Production managed results are written
        // directly to Firebase by the broker/worker and do not return through the RVT host.
        var set = await SetFilesAsync(web, "input[data-liber-revex-energy-output='1']", "data-liber-revex-native-energy-output-ready", files);
        if (!set.ok) return set;
        string selectorJson = JsonSerializer.Serialize("input[data-liber-revex-energy-output='1']");
        await web.ExecuteScriptAsync($"document.querySelector({selectorJson})?.dispatchEvent(new Event('change',{{bubbles:true}}))");
        return (true, $"Energy result {output.ResultRevision} attached to Companion.");
    }

    private static async Task<(bool ok, string message)> SetFilesAsync(
        WebView2 web, string selector, string markerAttribute, string[] files)
    {
        if (web.CoreWebView2 == null) return (false, "REVEX Companion browser is not initialized.");
        string selectorJson = JsonSerializer.Serialize(selector);
        bool ready = false;
        for (int attempt = 0; attempt < 80; attempt++)
        {
            string probe = await web.ExecuteScriptAsync($"Boolean(document.querySelector({selectorJson}))");
            if (string.Equals(probe, "true", StringComparison.OrdinalIgnoreCase)) { ready = true; break; }
            await Task.Delay(100);
        }
        if (!ready) return (false, "REVEX Companion did not expose its Engineering file input within 8 seconds.");

        string markerJson = JsonSerializer.Serialize(markerAttribute);
        string marked = await web.ExecuteScriptAsync($"(() => {{ const input=document.querySelector({selectorJson}); if(!input)return false; input.setAttribute({markerJson},'1'); return true; }})() ");
        if (!string.Equals(marked, "true", StringComparison.OrdinalIgnoreCase))
            return (false, "The Companion Engineering input disappeared before attachment.");

        string documentJson = await web.CoreWebView2.CallDevToolsProtocolMethodAsync("DOM.getDocument", "{\"depth\":1,\"pierce\":true}");
        using JsonDocument document = JsonDocument.Parse(documentJson);
        int rootNodeId = document.RootElement.GetProperty("root").GetProperty("nodeId").GetInt32();
        string markedSelector = $"input[{markerAttribute}='1']";
        string queryResult = await web.CoreWebView2.CallDevToolsProtocolMethodAsync("DOM.querySelector",
            JsonSerializer.Serialize(new { nodeId = rootNodeId, selector = markedSelector }));
        using JsonDocument query = JsonDocument.Parse(queryResult);
        int inputNodeId = query.RootElement.GetProperty("nodeId").GetInt32();
        if (inputNodeId == 0) return (false, "The Companion Engineering input could not be resolved.");

        await web.CoreWebView2.CallDevToolsProtocolMethodAsync("DOM.setFileInputFiles",
            JsonSerializer.Serialize(new { files, nodeId = inputNodeId }));
        await Task.Delay(100);
        return (true, "Engineering files attached to native Companion bridge.");
    }
}
