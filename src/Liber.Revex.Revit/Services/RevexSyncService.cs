using Autodesk.Revit.DB;
using Liber.Revex.Revit.Models;
using System.IO;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

public sealed class RevexSyncService
{
    private readonly DesignBookScheduleService _schedules = new();
    private readonly ViewerExportService _viewer = new();
    private readonly SpatialReviewExportService _spatialReview = new();
    private readonly IfcExportService _ifc = new();
    private readonly PrintingSetExportService _printing = new();
    private readonly AffectedPlanExportService _affectedPlans = new();

    public RevexSyncOutput Sync(Document doc, View3D view, BridgeSettings settings, RevexProjectBinding projectBinding, RevexAffectedViewTracker.Snapshot changedSnapshot)
    {
        string revision = "rev_" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ");
        string staging = AppPaths.CreateSyncStaging();
        var stopwatch = Stopwatch.StartNew();
        RevexDiagnostics.Info("SYNC", $"Start revision={revision}; document={doc.Title}; staging={staging}");

        try
        {
            string stage = "Design Book / Spec Book schedule export";
            try
            {
                RevexDiagnostics.Info("SYNC", "Stage: " + stage);
                var scheduleResult = _schedules.Export(doc, view, staging);
                RevexDiagnostics.Info("SYNC", $"Schedules complete: {scheduleResult.scheduleCount}; elapsed={stopwatch.Elapsed}");

                stage = "IFC authority export";
                RevexDiagnostics.Info("SYNC", "Stage: " + stage);
                string ifcPath = _ifc.Export(doc, staging);
                RevexDiagnostics.Info("SYNC", $"IFC export returned: {ifcPath}; elapsed={stopwatch.Elapsed}");
                if (!File.Exists(ifcPath))
                    throw new InvalidOperationException("The IFC exporter returned a path that does not exist.");

                stage = "browser geometry and BIM metadata export";
                RevexDiagnostics.Info("SYNC", "Stage: " + stage);
                var viewerResult = _viewer.Export(doc, view, staging, ifcPath);
                int spatialReviewCount = _spatialReview.AppendToViewerMetadata(doc, view, viewerResult.metadataPath);
                RevexDiagnostics.Info("SYNC", $"Viewer export complete: elements={viewerResult.elementCount}; spatialReview={spatialReviewCount}; pages={viewerResult.meshPagePaths.Count}; manifest={viewerResult.meshManifestPath ?? "<none>"}; fbx={viewerResult.fbxPath ?? "<none>"}; elapsed={stopwatch.Elapsed}");
                if (viewerResult.meshManifestPath == null && viewerResult.fbxPath == null)
                    throw new InvalidOperationException("REVEX could not produce either the browser-native exact model stream or the FBX compatibility model. The revision was not published as a primitive-only BIM model.");

                stage = "printing sets / project Docs export";
                RevexDiagnostics.Info("SYNC", "Stage: " + stage);
                var printingResult = _printing.Export(doc, staging, revision);
                RevexDiagnostics.Info("SYNC", $"Printing sets complete: sets={printingResult.SetCount}; sheets={printingResult.SheetCount}; elapsed={stopwatch.Elapsed}");

                stage = "affected native Revit plan views export";
                RevexDiagnostics.Info("SYNC", "Stage: " + stage);
                var affectedPlanResult = _affectedPlans.Export(doc, staging, revision, changedSnapshot);
                RevexDiagnostics.Info("SYNC", $"Affected plans complete: views={affectedPlanResult.ViewCount}; changedElements={affectedPlanResult.ChangedElementCount}; elapsed={stopwatch.Elapsed}");

                stage = "project revision manifest";
                RevexDiagnostics.Info("SYNC", "Stage: " + stage);

            var binding = new RevexCentralBinding(
                doc.Title,
                doc.ProjectInformation.UniqueId,
                CentralModelBindingService.ResolveDocumentFingerprint(doc),
                CentralModelBindingService.ResolveCentralPath(doc),
                doc.IsWorkshared,
                string.IsNullOrWhiteSpace(settings.LiberProjectId) ? null : settings.LiberProjectId.Trim(),
                string.IsNullOrWhiteSpace(settings.LiberSpecProjectId) ? null : settings.LiberSpecProjectId.Trim(),
                projectBinding.BindingVersion,
                projectBinding.BindingSource,
                projectBinding.IdentityEvidenceDigest,
                projectBinding.IdentityDisplayName,
                projectBinding.IdentityEvidenceSheets,
                DateTime.UtcNow);

            string bindingPath = Path.Combine(staging, "project.json");
            File.WriteAllText(bindingPath, JsonSerializer.Serialize(new
            {
                schema = "liber.revex.project.v2",
                revision,
                central = binding,
                rules = new
                {
                    dataOwnership = "user-owned",
                    dataRoles = new
                    {
                        revitSource = new[] { "geometry", "rooms", "materials", "quantities", "source schedules" },
                        companionOverlay = new[] { "design decisions", "images", "bim issues", "approvals", "render history", "mappings" },
                        projectServices = new[] { "project documents", "project chat", "specification book" }
                    },
                    writeBackToRvt = false,
                    revisionIntegrity = new
                    {
                        sourceRevisions = "append-only",
                        overlayIdentity = "stable-revit-unique-id-or-stable-design-position-id",
                        sourceSyncMayUpdate = new[] { "geometry", "source schedule values", "source material/type metadata", "printing set snapshots" },
                        sourceSyncMayNotOverwrite = new[] { "design decisions", "design images", "comments", "bim issues", "approvals", "spec authored fields", "manual mappings", "chat", "manual project documents" },
                        removedSourceBehavior = "archive-or-mark-removed-never-delete-user-overlay",
                        printingSetBehavior = "one immutable document record per printing-set per REVEX revision",
                        affectedPlanBehavior = "only native Revit plan views touched by observed model changes are regenerated; exports share the REVEX revision id",
                        manualDocsBehavior = "never pruned or replaced by Revit sync"
                    }
                }
            }, JsonOptions), Encoding.UTF8);

            string integrityPath = Path.Combine(staging, "integrity.json");
            WriteIntegrityManifest(
                integrityPath,
                revision,
                staging,
                scheduleResult.scheduleCount,
                viewerResult.elementCount,
                printingResult.SetCount,
                printingResult.SheetCount,
                affectedPlanResult.ViewCount,
                affectedPlanResult.ChangedElementCount,
                binding);

            string finalFolder = AppPaths.CommitSyncRevision(staging, revision);
            RevexDiagnostics.Info("SYNC", $"Revision committed: {finalFolder}; total elapsed={stopwatch.Elapsed}");
            return new RevexSyncOutput(
                revision,
                finalFolder,
                MovePath(bindingPath, staging, finalFolder),
                MovePath(scheduleResult.designBookJson, staging, finalFolder),
                MovePath(scheduleResult.specPushJson, staging, finalFolder),
                ifcPath == null ? null : MovePath(ifcPath, staging, finalFolder),
                viewerResult.fbxPath == null ? null : MovePath(viewerResult.fbxPath, staging, finalFolder),
                viewerResult.meshPath == null ? null : MovePath(viewerResult.meshPath, staging, finalFolder),
                viewerResult.meshManifestPath == null ? null : MovePath(viewerResult.meshManifestPath, staging, finalFolder),
                viewerResult.meshPagePaths.Select(path => MovePath(path, staging, finalFolder)).ToArray(),
                MovePath(viewerResult.metadataPath, staging, finalFolder),
                MovePath(printingResult.ManifestPath, staging, finalFolder),
                printingResult.PdfPaths.Select(path => MovePath(path, staging, finalFolder)).ToArray(),
                MovePath(affectedPlanResult.ManifestPath, staging, finalFolder),
                affectedPlanResult.PdfPaths.Select(path => MovePath(path, staging, finalFolder)).ToArray(),
                MovePath(integrityPath, staging, finalFolder),
                scheduleResult.scheduleCount,
                viewerResult.elementCount,
                printingResult.SetCount,
                printingResult.SheetCount,
                affectedPlanResult.ViewCount,
                affectedPlanResult.ChangedElementCount);
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Error("SYNC", "Stage failed: " + stage, ex);
                AppPaths.Ensure();
                string log = Path.Combine(AppPaths.Logs, "last-sync-error.txt");
                try
                {
                    File.WriteAllText(log,
                        $"LIBER REVEX sync failure\nUTC: {DateTime.UtcNow:O}\nDocument: {doc.Title}\nStage: {stage}\n\n{ex}",
                        Encoding.UTF8);
                }
                catch { }
                throw new InvalidOperationException($"{stage} failed: {ex.Message}\n\nDiagnostic log: {log}", ex);
            }
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("SYNC", "Revision aborted; cleaning staging folder.", ex);
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
            throw;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static string MovePath(string stagingPath, string stagingFolder, string finalFolder) =>
        Path.Combine(finalFolder, Path.GetRelativePath(stagingFolder, stagingPath));

    private static void WriteIntegrityManifest(
        string path,
        string revision,
        string folder,
        int scheduleCount,
        int elementCount,
        int printingSetCount,
        int printingSheetCount,
        int affectedPlanViewCount,
        int changedElementCount,
        RevexCentralBinding binding)
    {
        var coreNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "project.json", "design-book.json", "spec-revit-push.json", "viewer-model.json", "printing-sets.json", "affected-plan-views.json"
        };
        var files = Directory.GetFiles(folder, "*", SearchOption.AllDirectories)
            .Where(file => !file.Equals(path, StringComparison.OrdinalIgnoreCase))
            .Where(file => coreNames.Contains(Path.GetFileName(file)) ||
                           Path.GetExtension(file).Equals(".fbx", StringComparison.OrdinalIgnoreCase) ||
                           Path.GetFileName(file).EndsWith(".rvxmesh.gz", StringComparison.OrdinalIgnoreCase) ||
                           Path.GetFileName(file).Equals("model.rvxpages.json", StringComparison.OrdinalIgnoreCase) ||
                           Path.GetExtension(file).Equals(".ifc", StringComparison.OrdinalIgnoreCase) ||
                           Path.GetExtension(file).Equals(".pdf", StringComparison.OrdinalIgnoreCase))
            .OrderBy(file => file, StringComparer.OrdinalIgnoreCase)
            .Select(file =>
            {
                var info = new FileInfo(file);
                using FileStream stream = File.OpenRead(file);
                using SHA256 sha = SHA256.Create();
                string hash = Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
                return new
                {
                    name = Path.GetRelativePath(folder, file).Replace('\\', '/'),
                    bytes = info.Length,
                    sha256 = hash
                };
            }).ToArray();

        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.integrity.v1",
            revision,
            createdAt = DateTime.UtcNow,
            central = new
            {
                binding.DocumentUniqueId,
                binding.DocumentFingerprint,
                binding.CentralPath,
                binding.ProjectId,
                binding.SpecProjectId
            },
            counts = new { schedules = scheduleCount, elements = elementCount, printingSets = printingSetCount, printingSheets = printingSheetCount, affectedPlanViews = affectedPlanViewCount, changedElements = changedElementCount },
            files
        }, JsonOptions), Encoding.UTF8);
    }
}
