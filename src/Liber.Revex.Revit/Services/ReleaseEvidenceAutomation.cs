using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Liber.Revex.Revit.Models;
using System.IO;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Publisher-only, noninteractive acceptance runner.  The production publisher
/// starts Revit with the staged add-in and the real release model.  This service
/// extracts active-document evidence and exercises BIM, Spec and Energy locally;
/// it never uploads a revision and it never saves the opened source RVT.
/// </summary>
public static class ReleaseEvidenceAutomation
{
    private enum AutomationState { Disabled, WaitingForDocument, WaitingForDynamo, Running, ExitPending }

    private static readonly object Gate = new();
    private static AutomationState _state = AutomationState.Disabled;
    private static bool _subscribed;
    private static bool _exitRequested;
    private static ExternalEvent? _dynamoInitializationEvent;
    private static DynamoInitializationHandler? _dynamoInitializationHandler;
    private static DateTime _dynamoInitializationRaisedAtUtc;
    private static bool _dynamoInitializationCompleted;
    private static Exception? _dynamoInitializationFailure;

    public static void TryStart(UIControlledApplication application)
    {
        string output = Environment.GetEnvironmentVariable("REVEX_RELEASE_EVIDENCE_OUTPUT")?.Trim() ?? "";
        if (output.Length == 0) return;
        lock (Gate)
        {
            if (_subscribed) return;
            if (!Path.IsPathFullyQualified(Environment.ExpandEnvironmentVariables(output)))
                throw new InvalidOperationException("REVEX_RELEASE_EVIDENCE_OUTPUT must be an absolute path.");
            _dynamoInitializationHandler = new DynamoInitializationHandler();
            _dynamoInitializationEvent = ExternalEvent.Create(_dynamoInitializationHandler);
            _dynamoInitializationCompleted = false;
            _dynamoInitializationFailure = null;
            application.Idling += OnIdling;
            application.DialogBoxShowing += OnDialogBoxShowing;
            _subscribed = true;
            _state = AutomationState.WaitingForDocument;
        }
        RevexDiagnostics.Info("RELEASE-QA", "Publisher evidence automation armed; waiting for the real Revit document.");
    }

    public static void Stop(UIControlledApplication application)
    {
        lock (Gate)
        {
            if (!_subscribed) return;
            try { application.Idling -= OnIdling; } catch { }
            try { application.DialogBoxShowing -= OnDialogBoxShowing; } catch { }
            try { _dynamoInitializationEvent?.Dispose(); } catch { }
            _dynamoInitializationEvent = null;
            _dynamoInitializationHandler = null;
            _subscribed = false;
            _state = AutomationState.Disabled;
        }
    }

    private static void OnIdling(object? sender, IdlingEventArgs args)
    {
        if (sender is not UIApplication uiapp) return;
        if (_state == AutomationState.ExitPending)
        {
            args.SetRaiseWithoutDelay();
            TryPostExit(uiapp);
            return;
        }
        if (_state is not (AutomationState.WaitingForDocument or AutomationState.WaitingForDynamo)) return;
        UIDocument? uidoc = uiapp.ActiveUIDocument;
        if (uidoc?.Document == null)
        {
            args.SetRaiseWithoutDelay();
            return;
        }

        string output = Path.GetFullPath(Environment.ExpandEnvironmentVariables(
            Environment.GetEnvironmentVariable("REVEX_RELEASE_EVIDENCE_OUTPUT")!.Trim()));
        Directory.CreateDirectory(output);
        string resultPath = Environment.GetEnvironmentVariable("REVEX_RELEASE_EVIDENCE_RESULT")?.Trim() ??
                            Path.Combine(output, "REVEX-RELEASE-EVIDENCE-RESULT.json");

        if (_state == AutomationState.WaitingForDocument)
        {
            try
            {
                if (_dynamoInitializationEvent == null)
                    throw new InvalidOperationException("The release-evidence Dynamo ExternalEvent was not created.");
                _dynamoInitializationRaisedAtUtc = DateTime.UtcNow;
                _state = AutomationState.WaitingForDynamo;
                _dynamoInitializationEvent.Raise();
                RevexDiagnostics.Stage("RELEASE-QA", "DYNAMO_EXTERNAL_EVENT", "RAISED",
                    "UI-less synchronous Dynamo initialization was raised for a dedicated Revit ExternalEvent.");
                args.SetRaiseWithoutDelay();
                return;
            }
            catch (Exception ex)
            {
                FinishFailure(uiapp, uidoc.Document, resultPath, ex, args);
                return;
            }
        }

        if (!_dynamoInitializationCompleted)
        {
            if (DateTime.UtcNow - _dynamoInitializationRaisedAtUtc < TimeSpan.FromMinutes(3))
            {
                args.SetRaiseWithoutDelay();
                return;
            }
            FinishFailure(uiapp, uidoc.Document, resultPath,
                new TimeoutException("The dedicated Revit ExternalEvent did not initialize Dynamo within three minutes."), args);
            return;
        }

        if (_dynamoInitializationFailure != null)
        {
            FinishFailure(uiapp, uidoc.Document, resultPath, _dynamoInitializationFailure, args);
            return;
        }
        if (!GbxmlEngineeringService.IsDynamoHostInitialized())
        {
            FinishFailure(uiapp, uidoc.Document, resultPath,
                new InvalidOperationException("The Dynamo ExternalEvent completed without a usable automation host."), args);
            return;
        }

        RevexDiagnostics.Stage("RELEASE-QA", "DYNAMO_EXTERNAL_EVENT", "PASSED",
            "Dynamo UI-less synchronous host initialized outside Idling; journal graph execution is now deterministic.");
        _state = AutomationState.Running;
        try
        {
            Run(uiapp, uidoc.Document, output, resultPath);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("RELEASE-QA", "Real Revit release-evidence acceptance failed.", ex);
            WriteResult(resultPath, new
            {
                schema = "liber.revex.release-evidence-result.v1",
                status = "FAILED",
                finishedAt = DateTime.UtcNow,
                model = uidoc.Document.Title,
                modelPath = uidoc.Document.PathName,
                error = ex.Message,
                exception = ex.ToString(),
                diagnosticLog = RevexDiagnostics.SessionLogPath,
                diagnosticJsonl = RevexDiagnostics.SessionJsonlPath,
            });
        }
        finally
        {
            _state = AutomationState.ExitPending;
            _exitRequested = true;
            args.SetRaiseWithoutDelay();
            TryPostExit(uiapp);
        }
    }

    private sealed class DynamoInitializationHandler : IExternalEventHandler
    {
        public void Execute(UIApplication app)
        {
            try
            {
                GbxmlEngineeringService.InitializeDynamoAutomationHost(app);
                _dynamoInitializationFailure = null;
            }
            catch (Exception ex)
            {
                _dynamoInitializationFailure = ex;
                RevexDiagnostics.Error("RELEASE-QA", "Dedicated Dynamo initialization ExternalEvent failed.", ex);
            }
            finally
            {
                _dynamoInitializationCompleted = true;
            }
        }

        public string GetName() => "REVEX r49 UI-less Dynamo release-evidence initialization";
    }

    private static void FinishFailure(UIApplication uiapp, Document doc, string resultPath, Exception ex, IdlingEventArgs args)
    {
        RevexDiagnostics.Error("RELEASE-QA", "Real Revit release-evidence acceptance failed.", ex);
        WriteResult(resultPath, new
        {
            schema = "liber.revex.release-evidence-result.v1",
            status = "FAILED",
            finishedAt = DateTime.UtcNow,
            model = doc.Title,
            modelPath = doc.PathName,
            error = ex.Message,
            exception = ex.ToString(),
            diagnosticLog = RevexDiagnostics.SessionLogPath,
            diagnosticJsonl = RevexDiagnostics.SessionJsonlPath,
        });
        _state = AutomationState.ExitPending;
        _exitRequested = true;
        args.SetRaiseWithoutDelay();
        TryPostExit(uiapp);
    }

    private static void Run(UIApplication uiapp, Document doc, string output, string resultPath)
    {
        if (doc.IsFamilyDocument || doc.IsReadOnly)
            throw new InvalidOperationException("Release evidence requires one writable project document opened from the real RVT artifact.");
        string expectedToken = Environment.GetEnvironmentVariable("REVEX_RELEASE_EXPECTED_PROJECT")?.Trim() ?? "";
        string weatherPath = Environment.GetEnvironmentVariable("REVEX_RELEASE_EPW")?.Trim() ?? "";
        if (!File.Exists(weatherPath))
            throw new FileNotFoundException("The publisher's hash-verified EnergyPlus weather input is missing.", weatherPath);

        using RevexDiagnostics.WorkflowScope workflow = RevexDiagnostics.BeginWorkflow(
            "REVEX r49 real Revit publication acceptance", "PUBLISH_REVEX_R49");
        ProjectIdentityEvidence evidence = ProjectIdentityEvidenceService.Capture(doc);
        if (evidence.Sheets.Count == 0 || evidence.Fields.Count == 0 || string.IsNullOrWhiteSpace(evidence.DisplayName))
            throw new InvalidOperationException("The real model did not expose active-document T/Z identity evidence.");
        if (expectedToken.Length > 0 && !ProjectIdentityEvidenceService.ProjectNameMatches(evidence, expectedToken))
            throw new InvalidOperationException(
                $"Active-document identity '{evidence.DisplayName}' did not match required publication project '{expectedToken}'.");

        string projectId = Environment.GetEnvironmentVariable("REVEX_RELEASE_EVIDENCE_PROJECT_ID")?.Trim() ?? "";
        if (projectId.Length == 0) projectId = "release-evidence-" + evidence.Digest[..16];
        var binding = new RevexProjectBinding
        {
            BindingVersion = "active-revit-evidence-v1",
            BindingSource = "publisher-real-revit-evidence",
            DocumentFingerprint = CentralModelBindingService.ResolveDocumentFingerprint(doc),
            DocumentTitle = doc.Title,
            DocumentUniqueId = doc.ProjectInformation?.UniqueId ?? "",
            CentralPath = CentralModelBindingService.ResolveCentralPath(doc),
            ProjectId = projectId,
            SpecProjectId = SettingsService.ExpectedSpecProjectId(projectId),
            ProjectName = evidence.DisplayName,
            IdentityEvidenceDigest = evidence.Digest,
            IdentityDisplayName = evidence.DisplayName,
            IdentityEvidenceSheets = evidence.Sheets,
            BoundAtUtc = DateTime.UtcNow,
        };

        RevexDiagnostics.Stage("RELEASE-QA", "REAL_REVIT_IDENTITY", "PASSED",
            $"model={doc.Title}; sheets={evidence.Sheets.Count}; fields={evidence.Fields.Count}; digest={evidence.Digest}");

        RevexSyncOutput bim;
        var bridge = new BridgeSettings
        {
            LiberProjectId = binding.ProjectId,
            LiberSpecProjectId = binding.SpecProjectId,
        };
        using (RevexAffectedViewTracker.Suspend())
        using (RevexSyncViewScope syncView = RevexSyncViewService.Create(doc))
        {
            bim = new RevexSyncService().Sync(
                doc, syncView.View, bridge, binding, RevexAffectedViewTracker.Peek(doc));
        }
        RevexDiagnostics.Stage("RELEASE-QA", "REAL_REVIT_BIM_SPEC", "PASSED",
            $"revision={bim.Revision}; schedules={bim.ScheduleCount}; elements={bim.ElementCount}; sheets={bim.PrintingSheetCount}");

        string gbxmlFolder = Path.Combine(output, "gbxml");
        GbxmlEngineeringOutput gbxml = new GbxmlEngineeringService().Run(uiapp, doc, new GbxmlEngineeringSettings
        {
            AuditOnly = false,
            OutputFolder = gbxmlFolder,
            XmlName = "79_WINTHROP_RELEASE_EVIDENCE",
            CreateOrFixSpaces = true,
            ExportDespiteBlockers = false,
        });
        if (!GbxmlEngineeringService.IsSuccessful(gbxml, auditOnly: false))
        {
            string summary = string.IsNullOrWhiteSpace(gbxml.SummaryText)
                ? "<none>"
                : gbxml.SummaryText.Replace("\r", " ").Replace("\n", " ").Trim();
            if (summary.Length > 2000) summary = summary[..2000] + "…";
            throw new InvalidOperationException(
                $"Real Revit gbXML extraction did not clear its publication gate " +
                $"(status={gbxml.Status}; report={gbxml.ReportPath ?? "<none>"}; summary={summary}).");
        }

        EngineeringSyncOutput engineering = new EngineeringSyncService().Create(gbxml, binding, weatherPath);
        string sourcePath = doc.PathName;
        WriteResult(resultPath, new
        {
            schema = "liber.revex.release-evidence-result.v1",
            status = "PASSED",
            finishedAt = DateTime.UtcNow,
            model = doc.Title,
            modelPath = sourcePath,
            modelBytes = File.Exists(sourcePath) ? new FileInfo(sourcePath).Length : 0,
            identity = new
            {
                evidence.Digest,
                evidence.DisplayName,
                evidence.Sheets,
                fieldCount = evidence.Fields.Count,
                source = "active-revit-document-t-z-title-evidence",
            },
            bim = new
            {
                bim.Revision,
                bim.RootFolder,
                bim.IntegrityJson,
                bim.ScheduleCount,
                bim.ElementCount,
                bim.PrintingSetCount,
                bim.PrintingSheetCount,
                bim.AffectedPlanViewCount,
            },
            engineering = new
            {
                engineering.Revision,
                engineering.RootFolder,
                engineering.ManifestPath,
                engineering.GbxmlPath,
                engineering.WeatherPath,
                evidenceFiles = engineering.EvidenceFiles,
            },
            sourceRvtSaved = false,
            cloudMutation = false,
            diagnosticLog = RevexDiagnostics.SessionLogPath,
            diagnosticJsonl = RevexDiagnostics.SessionJsonlPath,
        });
        RevexDiagnostics.Stage("RELEASE-QA", "REAL_REVIT_EVIDENCE", "PASSED",
            $"engineeringRevision={engineering.Revision}; manifest={engineering.ManifestPath}");
        workflow.Complete(true, "Real Revit BIM, Spec and Energy evidence extraction passed.");
    }

    private static void WriteResult(string path, object value)
    {
        string full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path));
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        string temp = full + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(value, new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        }));
        File.Move(temp, full, true);
    }

    private static void TryPostExit(UIApplication uiapp)
    {
        try
        {
            RevitCommandId command = RevitCommandId.LookupPostableCommandId(PostableCommand.ExitRevit);
            if (uiapp.CanPostCommand(command)) uiapp.PostCommand(command);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("RELEASE-QA", "Could not post Revit exit yet: " + ex.Message);
        }
    }

    private static void OnDialogBoxShowing(object? sender, DialogBoxShowingEventArgs args)
    {
        if (!_exitRequested) return;
        try
        {
            RevexDiagnostics.Info("RELEASE-QA", "Discarding unsaved publisher-QA model changes during automated Revit exit: " + args.DialogId);
            if (args is TaskDialogShowingEventArgs task)
                task.OverrideResult((int)TaskDialogResult.No);
            else if (args is MessageBoxShowingEventArgs message)
                message.OverrideResult(7); // Win32 IDNO
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("RELEASE-QA", "Automated exit dialog handling failed: " + ex.Message);
        }
    }
}
