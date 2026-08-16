using Liber.Revex.Revit.Models;
using Microsoft.Web.WebView2.Wpf;
using System.IO;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

public static class EngineeringCompanionWebBridge
{
    private const string ManagedBridgeVersion = "20260813r49";
    private const string ManagedEnergyInputSelector = "input[data-liber-revex-native-managed-energy='1']";
    private const string ManagedEnergyInputMarker = "data-liber-revex-native-managed-energy";
    private static readonly HashSet<string> ResumeAttempted = new(StringComparer.OrdinalIgnoreCase);

    public static Task<(bool ok, string message)> EnsureManagedEnergyBridgeAsync(WebView2 web)
    {
        // Initialization must be side-effect free. In particular, opening/reloading
        // Companion must never attach an old Engineering revision or start Energy.
        // The full downstream chain remains attached to the explicit SYNC ENGINEERING
        // action through AttachEngineeringSyncAsync below.
        return EnsureManagedEnergyBridgeCoreAsync(web);
    }

    private static async Task<(bool ok, string message)> EnsureManagedEnergyBridgeCoreAsync(WebView2 web)
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
        if (web.CoreWebView2 == null) return (false, "REVEX Companion browser is not initialized.");
        if (!File.Exists(output.ManifestPath) || !File.Exists(output.GbxmlPath) || !File.Exists(output.WeatherPath))
            return (false, "The Engineering Sync revision is incomplete or has no verified weather input.");

        string[] files = new[] { output.ManifestPath, output.GbxmlPath, output.GbxmlReportPath, output.GbxmlSummaryPath, output.WeatherPath }
            .Concat(output.EvidenceFiles ?? Array.Empty<string>())
            .Where(path => !string.IsNullOrWhiteSpace(path) && File.Exists(path))
            .Select(path => Path.GetFullPath(path!))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        string root = Path.GetFullPath(output.RootFolder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string prefix = root + Path.DirectorySeparatorChar;
        if (files.Any(path => !path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
            return (false, "The immutable Engineering Sync contains an artifact outside its committed revision folder.");
        if (files.GroupBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase).Any(group => group.Count() > 1))
            return (false, "The immutable Engineering Sync contains duplicate artifact names and cannot be mapped deterministically.");

        string[] names = files.Select(Path.GetFileName).ToArray();
        if (!names.Contains("engineering-sync.json", StringComparer.OrdinalIgnoreCase) ||
            !names.Any(name => name.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)) ||
            !names.Any(name => name.EndsWith(".epw", StringComparison.OrdinalIgnoreCase)))
            return (false, "The committed Engineering revision is missing its manifest, Revit gbXML, or EPW before browser handoff.");

        var installed = await EnsureManagedEnergyBridgeCoreAsync(web);
        if (!installed.ok) return installed;

        // Managed Energy owns a private file input that no hosted/legacy handler listens to.
        // CDP binds the exact immutable local files directly into that private FileList; REVEX
        // then calls processInput() itself and never dispatches a change event. This preserves
        // the zero-copy local handoff while eliminating both the old partial-input race and the
        // r75 virtual-host fetch/CORS/browser-policy failure.
        string selectorJson = JsonSerializer.Serialize(ManagedEnergyInputSelector);
        string prepared = await web.ExecuteScriptAsync($$"""
            (() => {
              document.querySelector({{selectorJson}})?.remove();
              const input = document.createElement('input');
              input.type = 'file';
              input.multiple = true;
              input.hidden = true;
              input.setAttribute('data-liber-revex-native-managed-energy','1');
              input.setAttribute('aria-hidden','true');
              document.body.appendChild(input);
              return true;
            })()
            """);
        if (!string.Equals(prepared, "true", StringComparison.OrdinalIgnoreCase))
            return (false, "The private managed Energy handoff input could not be created.");

        var set = await SetFilesAsync(web, ManagedEnergyInputSelector, ManagedEnergyInputMarker, files);
        if (!set.ok)
        {
            await web.ExecuteScriptAsync($"document.querySelector({selectorJson})?.remove()");
            return set;
        }

        string started = await web.ExecuteScriptAsync($$"""
            (() => {
              const bridge = window.__revexManagedEnergyBridge;
              const input = document.querySelector({{selectorJson}});
              if (!bridge?.processInput || !input?.files) return -1;
              const files = Array.from(input.files);
              if (files.length !== {{files.Length}}) return -files.length;
              const task = bridge.processInput(files);
              input.remove();
              void task;
              return files.length;
            })()
            """);
        if (!int.TryParse(started, out int startedCount) || startedCount != files.Length)
            return (false, $"The private managed Energy FileList did not start with the exact artifact count ({started}).");

        RevexDiagnostics.Info("ENERGY-SYNC",
            $"Engineering revision handed to Companion through private managed FileList: revision={output.Revision}; artifacts={files.Length}; " +
            string.Join(", ", names));
        return (true, $"Engineering revision {output.Revision} handed directly to the managed-server bridge from its immutable local revision folder.");
    }

    // Retained only as non-invoked repair/reference code while the Energy chain is under
    // live stabilization. Startup initialization above is deliberately forbidden from
    // calling this. Remove it after the first verified clean end-to-end run rather than
    // changing the active chain again before that evidence exists.
    private static async Task TryResumeLatestEngineeringRevisionAsync(WebView2 web)
    {
        try
        {
            if (web.CoreWebView2 == null) return;
            string projectId = await ReadJsStringAsync(web,
                "String(window.__revexState?.projectId || new URL(location.href).searchParams.get('projectId') || '')");
            if (string.IsNullOrWhiteSpace(projectId)) return;

            EngineeringSyncOutput? latest = TryLoadLatestLocalRevision(projectId);
            if (latest == null) return;
            string resumeKey = projectId + ":" + latest.Revision;
            lock (ResumeAttempted)
            {
                if (!ResumeAttempted.Add(resumeKey)) return;
            }

            string cloudRevision = await ReadCloudEngineeringRevisionAsync(web, projectId);
            if (string.Equals(cloudRevision, latest.Revision, StringComparison.OrdinalIgnoreCase))
            {
                RevexDiagnostics.Info("ENERGY-SYNC", $"Local Engineering revision {latest.Revision} is already the current cloud revision; native resume skipped.");
                return;
            }

            RevexDiagnostics.Info("ENERGY-SYNC",
                $"Resuming preserved local Engineering revision {latest.Revision} after Companion/add-in restart; currentCloud={cloudRevision ?? "<none>"}.");
            var attached = await AttachEngineeringSyncAsync(web, latest);
            if (!attached.ok)
                RevexDiagnostics.Warn("ENERGY-SYNC", "Preserved Engineering revision resume did not start: " + attached.message);
            else
                RevexDiagnostics.Info("ENERGY-SYNC", attached.message);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("ENERGY-SYNC", "Preserved Engineering revision resume warning: " + ex.Message);
        }
    }

    private static EngineeringSyncOutput? TryLoadLatestLocalRevision(string projectId)
    {
        AppPaths.Ensure();
        if (!Directory.Exists(AppPaths.EngineeringSyncRevisions)) return null;
        foreach (DirectoryInfo folder in new DirectoryInfo(AppPaths.EngineeringSyncRevisions)
                     .EnumerateDirectories()
                     .OrderByDescending(row => row.LastWriteTimeUtc))
        {
            string manifestPath = Path.Combine(folder.FullName, "engineering-sync.json");
            if (!File.Exists(manifestPath)) continue;
            try
            {
                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(manifestPath));
                JsonElement root = document.RootElement;
                string manifestProject = root.TryGetProperty("projectId", out JsonElement projectValue) ? projectValue.GetString() ?? "" : "";
                string revision = root.TryGetProperty("revision", out JsonElement revisionValue) ? revisionValue.GetString() ?? "" : "";
                if (!string.Equals(manifestProject, projectId, StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(revision))
                    continue;

                string gbxml = Path.Combine(folder.FullName, "revit-energy.xml");
                string weather = Path.Combine(folder.FullName, "weather.epw");
                if (!File.Exists(gbxml) || !File.Exists(weather)) continue;
                string? report = OptionalFile(folder.FullName, "gbxml-report.json");
                string? summary = OptionalFile(folder.FullName, "gbxml-summary.txt");
                string[] evidence = Directory.GetFiles(folder.FullName, "*", SearchOption.TopDirectoryOnly)
                    .Where(path => !new[] { manifestPath, gbxml, weather, report, summary }.Where(x => !string.IsNullOrWhiteSpace(x))
                        .Contains(path, StringComparer.OrdinalIgnoreCase))
                    .OrderBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                return new EngineeringSyncOutput(revision, projectId, folder.FullName, manifestPath, gbxml, report, summary, weather, evidence);
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Warn("ENERGY-SYNC", $"Ignored unreadable preserved Engineering revision {folder.Name}: {ex.Message}");
            }
        }
        return null;
    }

    private static string? OptionalFile(string folder, string name)
    {
        string path = Path.Combine(folder, name);
        return File.Exists(path) ? path : null;
    }

    private static async Task<string> ReadCloudEngineeringRevisionAsync(WebView2 web, string projectId)
    {
        string key = "__revexNativeEngineeringProbe_" + Guid.NewGuid().ToString("N");
        string keyJson = JsonSerializer.Serialize(key);
        string projectJson = JsonSerializer.Serialize(projectId);
        await web.ExecuteScriptAsync($$"""
            (() => {
              const key = {{keyJson}};
              window[key] = '__pending__';
              Promise.resolve(window.RevexStore?.getEngineeringState?.({{projectJson}}))
                .then(state => { window[key] = String(state?.revision || state?.manifest?.revision || ''); })
                .catch(() => { window[key] = ''; });
              return true;
            })()
            """);
        for (int attempt = 0; attempt < 80; attempt++)
        {
            string value = await ReadJsStringAsync(web, $"String(window[{keyJson}] ?? '__pending__')");
            if (!string.Equals(value, "__pending__", StringComparison.Ordinal))
            {
                await web.ExecuteScriptAsync($"delete window[{keyJson}]");
                return value;
            }
            await Task.Delay(100);
        }
        await web.ExecuteScriptAsync($"delete window[{keyJson}]");
        return "";
    }

    private static async Task<string> ReadJsStringAsync(WebView2 web, string expression)
    {
        string raw = await web.ExecuteScriptAsync(expression);
        try { return JsonSerializer.Deserialize<string>(raw) ?? ""; }
        catch { return raw.Trim().Trim('"'); }
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
