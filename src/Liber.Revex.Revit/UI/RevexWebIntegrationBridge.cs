using Autodesk.Revit.UI;
using Liber.Revex.Revit.Revit;
using Liber.Revex.Revit.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
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
    private const int MaxPendingFamilyDownloads = 16;
    private static readonly Uri ArchitexturesCreate = new("https://architextures.org/create");
    private static readonly Uri BlocksFamilies = new("https://www.blocksrvt.com/en/families");

    private sealed class BridgeState
    {
        public string ArmedProvider { get; set; } = "";
        public bool CoreAttached { get; set; }
        public WebView2? ReturnTarget { get; set; }
        public Window? ProviderWindow { get; set; }
    }

    private sealed record PendingFamily(string Path, string Name, long Bytes, string Sha256, DateTime CreatedUtc, WebView2 Target);

    private static readonly ConditionalWeakTable<WebView2, BridgeState> States = new();
    private static readonly ConcurrentDictionary<string, PendingFamily> PendingFamilies = new();
    private static readonly object FamilyPumpGate = new();
    private static RevexFamilyPlacementExternalHandler? _familyHandler;
    private static ExternalEvent? _familyExternalEvent;
    private static long _familyPumpGeneration;
    private static Uri? _trustedCompanionSource;

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
        BridgeSettings settings = SettingsService.Load();
        if (!Uri.TryCreate(settings.LiberRevexUrl, UriKind.Absolute, out Uri? trustedSource) ||
            !string.Equals(trustedSource.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("REVEX native messaging requires a configured HTTPS Companion URL.");
        lock (FamilyPumpGate)
        {
            if (_familyExternalEvent != null) return;
            var handler = new RevexFamilyPlacementExternalHandler();
            ExternalEvent externalEvent = ExternalEvent.Create(handler);
            handler.AttachExternalEvent(externalEvent);
            _familyHandler = handler;
            _familyExternalEvent = externalEvent;
            _familyPumpGeneration = unchecked(_familyPumpGeneration + 1);
            _trustedCompanionSource = trustedSource;
        }
        RevexDiagnostics.Info("FAMILY", "REVEX Blocks family placement ExternalEvent ready.");
    }

    internal static void ReleaseFamilyPlacement()
    {
        RevexFamilyPlacementExternalHandler? handler;
        ExternalEvent? externalEvent;
        List<PendingFamily> pendingFiles = new();
        lock (FamilyPumpGate)
        {
            // Invalidate every async family download before detaching the pump.
            // Removing retained tokens under the same gate prevents a rapid
            // reconfigure from having its new tokens swept by the old release.
            _familyPumpGeneration = unchecked(_familyPumpGeneration + 1);
            handler = _familyHandler;
            externalEvent = _familyExternalEvent;
            _familyHandler = null;
            _familyExternalEvent = null;
            _trustedCompanionSource = null;
            foreach (var pair in PendingFamilies.ToArray())
                if (PendingFamilies.TryRemove(pair.Key, out PendingFamily? pending))
                    pendingFiles.Add(pending);
        }
        // Close first so every rejected queued callback runs (and deletes its
        // one-shot family file) before the Revit ExternalEvent is disposed.
        try { handler?.Close(); } catch { }
        try { externalEvent?.Dispose(); } catch { }
        foreach (PendingFamily pending in pendingFiles)
        {
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
        // The owned provider browser is an untrusted download surface. It never
        // receives the privileged host command dispatcher; only the REVEX app
        // WebView may send placement, receipt, sync, or integration commands.
        bool providerBrowser = !string.IsNullOrWhiteSpace(state.ArmedProvider) && state.ReturnTarget != null;
        if (!providerBrowser)
            web.CoreWebView2.WebMessageReceived += (_, e) => HandleWebMessage(web, state, e);
        web.CoreWebView2.DownloadStarting += (_, e) => HandleDownload(web, state, e);
        RevexDiagnostics.Info("INTEGRATION", providerBrowser
            ? "Untrusted provider download endpoint attached without host messaging."
            : "Trusted REVEX WebView2 integration endpoint attached.");
    }

    private static async void HandleWebMessage(WebView2 web, BridgeState state, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string rawJson = "";
        string messageType = "";
        try
        {
            if (!IsTrustedCompanionMessageSource(e.Source) || !IsTrustedCompanionMessageSource(web.Source?.AbsoluteUri))
            {
                RevexDiagnostics.Warn("INTEGRATION", "Rejected a native integration message from an untrusted WebView origin.");
                return;
            }
            rawJson = e.WebMessageAsJson ?? "";
            if (string.IsNullOrWhiteSpace(rawJson)) return;
            using JsonDocument doc = JsonDocument.Parse(rawJson);
            JsonElement root = doc.RootElement;
            if (!root.TryGetProperty("type", out JsonElement typeEl)) return;
            string type = messageType = typeEl.GetString() ?? "";

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
            if (string.Equals(type, "liber:revex-family-mutations-ack", StringComparison.Ordinal))
            {
                AcknowledgeFamilyMutations(root);
                await PostAsync(web, new
                {
                    type = "liber:revex-family-mutations-ack-result",
                    ok = true,
                    sourceRevision = ReadString(root, "sourceRevision")
                });
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
            if (string.Equals(messageType, "liber:revex-family-place-r126", StringComparison.Ordinal) ||
                string.Equals(messageType, "liber:revex-family-transform-r126", StringComparison.Ordinal))
            {
                await PostFamilyFailureAsync(
                    web,
                    rawJson,
                    string.Equals(messageType, "liber:revex-family-transform-r126", StringComparison.Ordinal) ? "transform" : "place",
                    ex.Message);
                return;
            }
            await PostAsync(web, new
            {
                type = "liber:revex-integration-error",
                provider = ReadProviderSafe(rawJson),
                message = ex.Message
            });
        }
    }

    internal static bool IsTrustedCompanionMessageSource(string? source)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out Uri? candidate)) return false;
        Uri? trusted;
        lock (FamilyPumpGate) trusted = _trustedCompanionSource;
        if (trusted == null) return false;
        if (!string.Equals(candidate.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(candidate.Scheme, trusted.Scheme, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(candidate.Host, trusted.Host, StringComparison.OrdinalIgnoreCase) ||
            candidate.Port != trusted.Port)
            return false;
        string candidatePath = Uri.UnescapeDataString(candidate.AbsolutePath).TrimEnd('/');
        string trustedPath = Uri.UnescapeDataString(trusted.AbsolutePath).TrimEnd('/');
        return string.Equals(candidatePath, trustedPath, StringComparison.OrdinalIgnoreCase);
    }

    private static Task PostFamilyFailureAsync(WebView2 web, string json, string action, string message)
    {
        string commandId = "", correlationId = "", projectId = "", baseSourceRevision = "", documentFingerprint = "";
        try
        {
            using JsonDocument document = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            JsonElement root = document.RootElement;
            commandId = ReadString(root, "commandId");
            correlationId = ReadString(root, "correlationId");
            projectId = ReadString(root, "projectId");
            baseSourceRevision = ReadString(root, "baseSourceRevision");
            documentFingerprint = ReadString(root, "documentFingerprint");
        }
        catch { }
        return PostAsync(web, new
        {
            type = "liber:revex-family-placement-r126",
            ok = false,
            action,
            commandId,
            correlationId,
            projectId,
            baseSourceRevision,
            documentFingerprint,
            receiptStatus = RevexFamilyPlacementExternalHandler.ReceiptFailed,
            message
        });
    }

    private static void QueueFamilyPlace(WebView2 web, JsonElement root)
    {
        RevexFamilyPlacementExternalHandler handler;
        lock (FamilyPumpGate)
            handler = _familyHandler ?? throw new InvalidOperationException("BIM-family placement is available only inside the REVEX Revit add-in.");
        string token = ReadString(root, "token");
        if (!PendingFamilies.TryGetValue(token, out PendingFamily? inspected))
            throw new InvalidOperationException("The Blocks family download token expired. Download the family again.");
        FamilyMutationContext context = ReadMutationContext(root, "blocks", inspected.Name, inspected.Sha256, requireAsset: true);
        if (!PendingFamilies.TryRemove(token, out PendingFamily? pending))
            throw new InvalidOperationException("This Blocks family download was already accepted for insertion.");
        if (!ReferenceEquals(pending.Target, web))
        {
            try { if (File.Exists(pending.Path)) File.Delete(pending.Path); } catch { }
            throw new InvalidOperationException("The family insertion token belongs to a different REVEX project window.");
        }
        double x = ReadDouble(root, "x"), y = ReadDouble(root, "y"), z = ReadDouble(root, "z");
        double rotation = ReadDouble(root, "rotationDegrees");
        string levelName = ReadString(root, "levelName");
        double levelElevation = ReadDouble(root, "levelElevation", z);
        var request = new FamilyPlacementService.PlacementRequest(pending.Path, x, y, z, rotation, levelName, levelElevation);
        var receiptRequest = new { x, y, z, rotationDegrees = rotation, levelName, levelElevation };
        handler.Enqueue(new RevexFamilyPlacementExternalHandler.WorkItem(request, null, context, receiptRequest, (result, error, receiptStatus) =>
        {
            try { _ = PostFamilyResultAsync(web, result, error, receiptStatus, "place", context); }
            finally
            {
                // The temporary RFA is no longer needed once this callback runs.
                // Cleanup must not be skipped if WebView/dispatcher shutdown makes
                // result publication throw synchronously.
                try { if (File.Exists(pending.Path)) File.Delete(pending.Path); } catch { }
            }
        }));
    }

    private static void QueueFamilyTransform(WebView2 web, JsonElement root)
    {
        RevexFamilyPlacementExternalHandler handler;
        lock (FamilyPumpGate)
            handler = _familyHandler ?? throw new InvalidOperationException("BIM-family placement is available only inside the REVEX Revit add-in.");
        FamilyMutationContext context = ReadMutationContext(root, "revex", "", "", requireAsset: false);
        string uniqueId = ReadString(root, "uniqueId");
        long? elementId = ReadOptionalLong(root, "elementId");
        if (uniqueId.Length == 0 && elementId == null)
            throw new InvalidOperationException("Family transform requires the exact Revit UniqueId (or a same-document ElementId compatibility hint).");
        double dx = ReadDouble(root, "dx"), dy = ReadDouble(root, "dy"), dz = ReadDouble(root, "dz");
        double rotateDegrees = ReadDouble(root, "rotateDegrees");
        var request = new FamilyPlacementService.TransformRequest(
            uniqueId,
            elementId,
            dx,
            dy,
            dz,
            rotateDegrees);
        var receiptRequest = new { uniqueId, elementIdHint = elementId, dx, dy, dz, rotateDegrees };
        handler.Enqueue(new RevexFamilyPlacementExternalHandler.WorkItem(null, request, context, receiptRequest,
            (result, error, receiptStatus) => _ = PostFamilyResultAsync(web, result, error, receiptStatus, "transform", context)));
    }

    private static Task PostFamilyResultAsync(
        WebView2 web,
        FamilyPlacementService.PlacementResult? result,
        string? error,
        string receiptStatus,
        string action,
        FamilyMutationContext context)
    {
        if (result == null)
            return PostAsync(web, new
            {
                type = "liber:revex-family-placement-r126",
                ok = false,
                action,
                commandId = context.CommandId,
                correlationId = context.CorrelationId,
                projectId = context.ProjectId,
                baseSourceRevision = context.BaseSourceRevision,
                documentFingerprint = context.DocumentFingerprint,
                receiptStatus,
                message = error ?? "Family placement failed."
            });
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
            placementType = result.PlacementType,
            hostUniqueId = result.HostUniqueId,
            commandId = context.CommandId,
            correlationId = context.CorrelationId,
            projectId = context.ProjectId,
            baseSourceRevision = context.BaseSourceRevision,
            documentFingerprint = context.DocumentFingerprint,
            receiptStatus,
            message = error
        });
    }

    private static FamilyMutationContext ReadMutationContext(
        JsonElement root,
        string provider,
        string assetName,
        string assetSha256,
        bool requireAsset)
    {
        string commandId = ReadString(root, "commandId");
        string correlationId = ReadString(root, "correlationId");
        string projectId = ReadString(root, "projectId");
        string baseSourceRevision = ReadString(root, "baseSourceRevision");
        string documentFingerprint = ReadString(root, "documentFingerprint");
        if (commandId.Length == 0 || correlationId.Length == 0 || projectId.Length == 0 ||
            !baseSourceRevision.StartsWith("rev_", StringComparison.Ordinal) ||
            !documentFingerprint.StartsWith("revitdoc_", StringComparison.Ordinal))
            throw new InvalidOperationException("Family mutation is missing its command/project/base-revision/document envelope. Refresh the bound project and try again.");
        if (requireAsset && (assetName.Length == 0 || assetSha256.Length != 64))
            throw new InvalidOperationException("The downloaded family asset is missing its exact SHA-256 evidence.");
        return new FamilyMutationContext(
            commandId,
            correlationId,
            projectId,
            baseSourceRevision,
            documentFingerprint,
            provider,
            assetName,
            assetSha256);
    }

    private static void AcknowledgeFamilyMutations(JsonElement root)
    {
        string projectId = ReadString(root, "projectId");
        string documentFingerprint = ReadString(root, "documentFingerprint");
        string sourceRevision = ReadString(root, "sourceRevision");
        if (!root.TryGetProperty("commandIds", out JsonElement ids) || ids.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("Family mutation acknowledgement has no command ids.");
        string[] commandIds = ids.EnumerateArray()
            .Where(value => value.ValueKind == JsonValueKind.String)
            .Select(value => (value.GetString() ?? "").Trim())
            .Where(value => value.Length > 0)
            .ToArray();
        if (commandIds.Length == 0)
            throw new InvalidOperationException("Family mutation acknowledgement has no command ids.");
        FamilyMutationReceiptService.Acknowledge(projectId, documentFingerprint, sourceRevision, commandIds);
        RevexDiagnostics.Info("FAMILY", $"Attached {commandIds.Length} family mutation receipt(s) to immutable source revision {sourceRevision}.");
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

    private static long? ReadOptionalLong(JsonElement root, string property)
    {
        if (!root.TryGetProperty(property, out JsonElement value) || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        if (value.TryGetInt64(out long number)) return number;
        return long.TryParse(value.ToString(), out number) ? number : null;
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
            providerWeb.CoreWebView2.Settings.IsWebMessageEnabled = false;
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
        long familyPumpGeneration = 0;
        if (family)
        {
            lock (FamilyPumpGate)
                familyPumpGeneration = _familyPumpGeneration;
        }

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
                    string sha256;
                    await using (FileStream stream = File.OpenRead(path))
                        sha256 = Convert.ToHexString(await SHA256.HashDataAsync(stream)).ToLowerInvariant();
                    List<PendingFamily> displaced = new();
                    lock (FamilyPumpGate)
                    {
                        if (familyPumpGeneration != _familyPumpGeneration || _familyHandler == null || _familyExternalEvent == null)
                            throw new InvalidOperationException("The REVEX Revit window closed while this family was downloading. Re-open REVEX and download the family again.");
                        // A Companion window owns at most one unconsumed download.
                        // A newly chosen family replaces (and deletes) the older
                        // unused token, while a global cap bounds multi-window use.
                        foreach (var pair in PendingFamilies.ToArray())
                        {
                            if (!ReferenceEquals(pair.Value.Target, target)) continue;
                            if (PendingFamilies.TryRemove(pair.Key, out PendingFamily? prior)) displaced.Add(prior);
                        }
                        if (PendingFamilies.Count >= MaxPendingFamilyDownloads)
                        {
                            foreach (PendingFamily prior in displaced)
                                try { if (File.Exists(prior.Path)) File.Delete(prior.Path); } catch { }
                            throw new InvalidOperationException("REVEX already has the maximum number of pending family downloads. Insert or close another project family before downloading again.");
                        }
                        PendingFamilies[token] = new PendingFamily(path, suggested, info.Length, sha256, DateTime.UtcNow, target);
                        retain = true;
                    }
                    foreach (PendingFamily prior in displaced)
                        try { if (File.Exists(prior.Path)) File.Delete(prior.Path); } catch { }
                    try
                    {
                        await PostAsync(target, new
                        {
                            type = "liber:revex-integration-family-r126",
                            provider,
                            token,
                            name = suggested,
                            bytes = info.Length,
                            sha256
                        });
                    }
                    catch
                    {
                        lock (FamilyPumpGate)
                        {
                            if (PendingFamilies.TryGetValue(token, out PendingFamily? invisible) &&
                                string.Equals(invisible.Path, path, StringComparison.OrdinalIgnoreCase))
                                PendingFamilies.TryRemove(token, out _);
                        }
                        retain = false;
                        throw;
                    }
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
