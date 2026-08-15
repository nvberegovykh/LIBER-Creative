using Autodesk.Revit.DB;
using Liber.Revex.Revit.Models;
using System.IO;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

public sealed class BridgeSettings
{
    public string RendairUrl { get; set; } = "https://rendair.ai/sign-in";
    public string Rendair3DToolUrl { get; set; } = "https://rendair.ai/tools/3d-model-to-render";
    public string LiberAppsUrl { get; set; } = "https://liberpict.com/liber-apps/";
    public string LiberRevexUrl { get; set; } = "https://liberpict.com/liber-apps/apps/revex/index.html";
    public string BatchViewNameContains { get; set; } = "RND";
    public int DefaultPixelSize { get; set; } = 2560;
    public string? LiberProjectId { get; set; }
    public string? LiberSpecProjectId { get; set; }
    public Dictionary<string, RevexProjectBinding> DocumentProjectBindings { get; set; } = new(StringComparer.Ordinal);
}

public static class SettingsService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    public static BridgeSettings Load()
    {
        AppPaths.Ensure();
        string path = Path.Combine(AppPaths.Config, "settings.json");
        return LoadFromPath(path);
    }

    private static BridgeSettings LoadFromPath(string path)
    {
        try
        {
            if (!File.Exists(path))
                return new BridgeSettings();

            BridgeSettings settings = JsonSerializer.Deserialize<BridgeSettings>(File.ReadAllText(path), JsonOptions)
                                      ?? new BridgeSettings();
            settings.DocumentProjectBindings ??= new Dictionary<string, RevexProjectBinding>(StringComparer.Ordinal);
            return settings;
        }
        catch
        {
            return new BridgeSettings();
        }
    }

    public static void Save(BridgeSettings settings)
    {
        AppPaths.Ensure();
        string path = Path.Combine(AppPaths.Config, "settings.json");

        // RendairWindow is intentionally long-lived. Revit ExternalEvents can update
        // the durable active-document binding through a freshly loaded settings object
        // while the window still holds an older BridgeSettings instance. A later UI
        // SaveBridgeSettings() must never erase those newer document bindings.
        // Merge the durable binding map from disk before the atomic replacement.
        BridgeSettings durable = LoadFromPath(path);
        settings.DocumentProjectBindings ??= new Dictionary<string, RevexProjectBinding>(StringComparer.Ordinal);
        if (durable.DocumentProjectBindings != null)
        {
            foreach ((string fingerprint, RevexProjectBinding binding) in durable.DocumentProjectBindings)
            {
                if (!settings.DocumentProjectBindings.ContainsKey(fingerprint))
                    settings.DocumentProjectBindings[fingerprint] = binding;
            }
        }

        string temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temp, path, true);
    }

    public static RevexProjectBinding ResolveProjectBinding(
        Document doc,
        RevexProjectBinding? candidate,
        bool allowRebind)
    {
        BridgeSettings settings = Load();
        settings.DocumentProjectBindings ??= new Dictionary<string, RevexProjectBinding>(StringComparer.Ordinal);

        string fingerprint = CentralModelBindingService.ResolveDocumentFingerprint(doc);
        ProjectIdentityEvidence evidence = ProjectIdentityEvidenceService.Capture(doc);
        if (settings.DocumentProjectBindings.TryGetValue(fingerprint, out RevexProjectBinding? stored) &&
            !string.IsNullOrWhiteSpace(stored.ProjectId) &&
            string.Equals(stored.BindingVersion, "active-revit-evidence-v1", StringComparison.Ordinal) &&
            (!allowRebind || string.IsNullOrWhiteSpace(candidate?.ProjectId)))
        {
            RevexDiagnostics.Info("PROJECT", $"Active Revit document binding resolved from settings: document={doc.Title}; fingerprint={fingerprint}; project={stored.ProjectId}");
            RevexProjectBinding normalized = Normalize(stored, doc, fingerprint, evidence) with { BindingSource = "stored-active-document" };
            settings.DocumentProjectBindings[fingerprint] = normalized;
            Save(settings);
            return normalized;
        }

        // A global browser value or preserved revision is never active-document evidence.
        // Old pre-r49 bindings intentionally require one explicit repair selection.
        if (!allowRebind)
            throw new InvalidOperationException($"The active Revit model '{doc.Title}' has no r49 verified project binding. Select or type its project once, then sync again. Prior revisions and another open project cannot assign it.");

        string projectId = candidate?.ProjectId?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(projectId))
            throw new InvalidOperationException($"The active Revit model '{doc.Title}' is not connected to a REVEX project. Select its project once in Companion, then sync again.");
        if (!ProjectIdentityEvidenceService.ProjectNameMatches(evidence, candidate?.ProjectName))
            throw new InvalidOperationException($"The selected REVEX project name '{candidate?.ProjectName}' does not match the active Revit document's T/Z identity evidence ('{evidence.DisplayName}'). Open the intended Revit document or select the matching project; REVEX will not guess.");

        string expectedSpecProjectId = ExpectedSpecProjectId(projectId);
        string suppliedSpecProjectId = candidate?.SpecProjectId?.Trim() ?? "";
        if (suppliedSpecProjectId.Length > 0 && !string.Equals(suppliedSpecProjectId, expectedSpecProjectId, StringComparison.Ordinal))
            RevexDiagnostics.Warn("PROJECT", $"Rejected mixed BIM/Spec project pair: project={projectId}; suppliedSpec={suppliedSpecProjectId}; expectedSpec={expectedSpecProjectId}");

        var resolved = new RevexProjectBinding
        {
            BindingVersion = "active-revit-evidence-v1",
            BindingSource = "explicit-user-selection",
            DocumentFingerprint = fingerprint,
            DocumentTitle = doc.Title,
            DocumentUniqueId = doc.ProjectInformation?.UniqueId ?? "",
            CentralPath = CentralModelBindingService.ResolveCentralPath(doc),
            ProjectId = projectId,
            SpecProjectId = expectedSpecProjectId,
            ProjectName = candidate?.ProjectName?.Trim() ?? "",
            IdentityEvidenceDigest = evidence.Digest,
            IdentityDisplayName = evidence.DisplayName,
            IdentityEvidenceSheets = evidence.Sheets,
            BoundAtUtc = DateTime.UtcNow
        };
        settings.DocumentProjectBindings[fingerprint] = resolved;
        settings.LiberProjectId = resolved.ProjectId;
        settings.LiberSpecProjectId = resolved.SpecProjectId;
        Save(settings);
        RevexDiagnostics.Info("PROJECT", $"Bound active Revit document atomically: document={doc.Title}; fingerprint={fingerprint}; project={resolved.ProjectId}; spec={resolved.SpecProjectId}; explicitRebind={allowRebind}");
        return resolved;
    }

    public static string ExpectedSpecProjectId(string projectId) =>
        string.IsNullOrWhiteSpace(projectId) ? "" : "spec_" + projectId.Trim();

    private static RevexProjectBinding Normalize(RevexProjectBinding binding, Document doc, string fingerprint, ProjectIdentityEvidence evidence) =>
        binding with
        {
            BindingVersion = "active-revit-evidence-v1",
            DocumentFingerprint = fingerprint,
            DocumentTitle = doc.Title,
            DocumentUniqueId = doc.ProjectInformation?.UniqueId ?? "",
            CentralPath = CentralModelBindingService.ResolveCentralPath(doc),
            ProjectId = binding.ProjectId.Trim(),
            SpecProjectId = ExpectedSpecProjectId(binding.ProjectId),
            IdentityEvidenceDigest = evidence.Digest,
            IdentityDisplayName = evidence.DisplayName,
            IdentityEvidenceSheets = evidence.Sheets,
            BoundAtUtc = binding.BoundAtUtc == default ? DateTime.UtcNow : binding.BoundAtUtc
        };
}
