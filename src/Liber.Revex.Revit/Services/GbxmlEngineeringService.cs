using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Liber.Revex.Revit.Models;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Runs the bundled, version-locked LIBER gbXML preflight graph through Dynamo for Revit.
/// REVEX owns the inputs, lifecycle, report capture and diagnostics. The Dynamo host is
/// initialized first, then the graph is executed through DynamoRevit's own journal automation
/// path so evaluation stays synchronous and Revit-bound instead of calling DynamoModel internals.
/// </summary>
public sealed class GbxmlEngineeringService
{
    private const string EngineVersion = "1.1.9";
    private const string GraphFileName = "LIBER_gbXML_Preflight_and_Export.dyn";
    private const string PythonFileName = "LIBER_gbXML_Preflight_and_Export.py";
    private const string GeometryEvidenceName = "REVIT-ENERGY-GEOMETRY.json";

    private static readonly IReadOnlyDictionary<string, string> InputNodes = new Dictionary<string, string>
    {
        ["run"] = "28eb1f7346144c3cbf8fd5acbf6d1011",
        ["audit"] = "9d1d1d5ed3884145a6097273871a2012",
        ["output"] = "74780108b89f4d36b070f167ce3a3013",
        ["name"] = "44b81de498e0412398357c7db4a74014",
        ["phase"] = "10b86c8e460b4f39823720458ada5015",
        ["fix"] = "5887fc26dfdf4c62a2f2f0cf8cf16016",
        ["force"] = "42d80fc6521149848ce3eb38c5127017",
        ["minilm"] = "2e72bdefeae74118b36705ab49c18018"
    };

    public GbxmlEngineeringOutput Run(UIApplication uiapp, Document doc, GbxmlEngineeringSettings settings)
    {
        DateTime started = DateTime.Now;
        AppPaths.Ensure();
        Directory.CreateDirectory(AppPaths.EngineeringGbxmlRuns);

        string outputFolder = ResolveOutputFolder(doc, settings.OutputFolder);
        Directory.CreateDirectory(outputFolder);
        settings = ResolvePhaseSetting(doc, settings);
        string sourceGraph = ResolveBundledGraph();
        string sourcePython = ResolveBundledPython();
        RevexDiagnostics.Dependency("GBXML", "Canonical Dynamo graph", File.Exists(sourceGraph), sourceGraph);
        RevexDiagnostics.Dependency("GBXML", "Canonical exporter Python", File.Exists(sourcePython), sourcePython);
        RevexDiagnostics.Stage("GBXML", "ENGINE_SELF_TEST", "STARTED", "validating graph/Python identity, size, version and eight-input contract");
        ValidateBundledEngine(sourceGraph, sourcePython);

        string runFolder = Path.Combine(AppPaths.EngineeringGbxmlRuns, started.ToString("yyyyMMdd-HHmmss-fff"));
        Directory.CreateDirectory(runFolder);
        string runGraph = Path.Combine(runFolder, GraphFileName);

        RevexDiagnostics.Info("GBXML", $"Engine {EngineVersion}; model={doc.Title}; audit={settings.AuditOnly}; phase={Display(settings.PhaseName, "auto")}; output={outputFolder}");
        RevexDiagnostics.Info("GBXML", $"InstallRoot={AppPaths.InstallRoot}");
        RevexDiagnostics.Info("GBXML", "Preparing version-locked Dynamo graph: " + runGraph);

        WriteRunGraph(sourceGraph, runGraph, settings with { OutputFolder = outputFolder });
        File.WriteAllText(Path.Combine(runFolder, "REVEX-GBXML-RUN.json"), JsonSerializer.Serialize(new
        {
            engine = EngineVersion,
            revex = "0.8.19",
            correlationId = RevexDiagnostics.CurrentCorrelationId,
            initiator = RevexDiagnostics.CurrentInitiator,
            operation = RevexDiagnostics.CurrentOperation,
            model = doc.Title,
            modelPath = doc.PathName,
            startedAt = started,
            settings = settings with { OutputFolder = outputFolder },
            installedGraph = sourceGraph,
            installedPython = sourcePython,
            runGraph,
            graphSha256 = Sha256(sourceGraph),
            pythonSha256 = Sha256(sourcePython)
        }, CreateJsonOptions(writeIndented: true)));

        RevexDiagnostics.Stage("GBXML", "DYNAMO", "STARTED", "starting synchronous DynamoRevit automation");
        ExecuteDynamo(uiapp, runGraph);

        // A successful Dynamo journal call means the workspace opened, not necessarily that a
        // Manual-saved graph actually evaluated. The REVEX run copy is forced Automatic below,
        // but retain one public DynamoModel.ForceRun() fallback so NO_REPORT can never be caused
        // merely by workspace run-mode semantics.
        if (!HasFreshEngineEvidence(outputFolder, started))
        {
            RevexDiagnostics.Warn("GBXML", "Dynamo returned without fresh engine evidence; forcing the current workspace evaluation once through DynamoModel.ForceRun().");
            ForceRunCurrentWorkspace();
            if (!HasFreshEngineEvidence(outputFolder, started))
                LogCurrentWorkspaceDiagnostics();
        }

        DateTime finished = DateTime.Now;
        string? summaryPath = FindNewest(outputFolder, "*_SUMMARY.txt", started);
        string? reportPath = FindNewest(outputFolder, "*_REPORT.json", started);
        (string? reportStatus, string? reportXmlPath) = ReadReportResult(reportPath);
        string? gbxmlPath = !string.IsNullOrWhiteSpace(reportXmlPath) && File.Exists(reportXmlPath)
            ? Path.GetFullPath(reportXmlPath)
            : FindNewestSuccessfulXml(outputFolder, started);
        string summary = summaryPath != null ? SafeRead(summaryPath) : string.Empty;
        string status = reportStatus ?? (settings.AuditOnly && summaryPath != null ? "AUDIT_COMPLETE_NO_JSON" : "NO_REPORT");
        if (string.Equals(status, "EXPORTED", StringComparison.OrdinalIgnoreCase) &&
            (string.IsNullOrWhiteSpace(gbxmlPath) || !File.Exists(gbxmlPath)))
            status = "EXPORTED_MISSING_XML";

        // The Dynamo exporter writes its geometry graph beside the gbXML, while an
        // immutable Engineering revision is assembled exclusively from this run's
        // private folder. Promote only the evidence named and digest-bound by this
        // exact fresh report; never scan for or accept a prior run's fixed filename.
        if (!settings.AuditOnly && string.Equals(status, "EXPORTED", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                PromoteGeometryEvidence(reportPath, gbxmlPath!, outputFolder, runFolder, doc, started);
            }
            catch (Exception ex)
            {
                status = "EXPORTED_MISSING_OR_INVALID_GEOMETRY_EVIDENCE";
                summary = (summary + Environment.NewLine + "Geometry evidence: " + ex.Message).Trim();
                RevexDiagnostics.Error("GBXML", "The fresh EXPORTED result could not be bound to immutable processed geometry evidence.", ex);
            }
        }

        RevexDiagnostics.Info("GBXML", $"Dynamo automation returned. status={status}; report={Display(reportPath, "none")}; xml={Display(gbxmlPath, "none")}; elapsed={(finished-started).TotalSeconds:F1}s");
        RevexDiagnostics.Dependency("GBXML", "Authoritative report", reportPath != null && File.Exists(reportPath), Display(reportPath, "none"));
        RevexDiagnostics.Dependency("GBXML", "Publishable gbXML", settings.AuditOnly || gbxmlPath != null && File.Exists(gbxmlPath), Display(gbxmlPath, "none"), required: !settings.AuditOnly);
        RevexDiagnostics.Stage("GBXML", "DYNAMO", IsSuccessful(new GbxmlEngineeringOutput(
            status, doc.Title, doc.PathName, runFolder, outputFolder, gbxmlPath, summaryPath, reportPath,
            summary, started, finished), settings.AuditOnly) ? "PASSED" : "FAILED",
            $"status={status}; elapsedMs={(long)(finished-started).TotalMilliseconds}");
        LogSummary(summary);
        if (!settings.AuditOnly)
            ExportEngineeringPageEvidence(doc, runFolder);

        return new GbxmlEngineeringOutput(
            status,
            doc.Title,
            doc.PathName,
            runFolder,
            outputFolder,
            gbxmlPath,
            summaryPath,
            reportPath,
            summary,
            started,
            finished);
    }

    public static bool IsSuccessful(GbxmlEngineeringOutput output, bool auditOnly)
    {
        string status = (output.Status ?? string.Empty).Trim();
        if (auditOnly)
            return !status.Contains("EXCEPTION", StringComparison.OrdinalIgnoreCase) &&
                   !status.Contains("FAILED", StringComparison.OrdinalIgnoreCase) &&
                   !status.Contains("BLOCKED", StringComparison.OrdinalIgnoreCase);
        return status.Equals("EXPORTED", StringComparison.OrdinalIgnoreCase) &&
               !string.IsNullOrWhiteSpace(output.GbxmlPath) && File.Exists(output.GbxmlPath);
    }

    private static GbxmlEngineeringSettings ResolvePhaseSetting(Document doc, GbxmlEngineeringSettings settings)
    {
        string requested = (settings.PhaseName ?? string.Empty).Trim();
        if (requested.Length == 0)
            return settings;

        var phases = doc.Phases.Cast<Phase>().ToList();
        if (phases.Count == 0)
            return settings;

        Phase? exact = phases.LastOrDefault(p => string.Equals(p.Name?.Trim(), requested, StringComparison.OrdinalIgnoreCase));
        if (exact != null)
        {
            if (!string.Equals(exact.Name, requested, StringComparison.Ordinal))
                RevexDiagnostics.Info("GBXML", $"Phase input normalized to Revit phase: '{requested}' -> '{exact.Name}'.");
            return settings with { PhaseName = exact.Name };
        }

        string wanted = NormalizePhaseName(requested);
        Phase? normalized = phases.LastOrDefault(p => NormalizePhaseName(p.Name) == wanted);
        if (normalized != null)
        {
            RevexDiagnostics.Info("GBXML", $"Phase input normalized to Revit phase: '{requested}' -> '{normalized.Name}'.");
            return settings with { PhaseName = normalized.Name };
        }

        var ranked = phases
            .Select(p => new { Phase = p, Distance = Levenshtein(wanted, NormalizePhaseName(p.Name)) })
            .OrderBy(x => x.Distance)
            .ThenBy(x => x.Phase.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        if (ranked.Count > 0)
        {
            int threshold = Math.Max(1, Math.Min(2, (int)Math.Round(Math.Max(1, wanted.Length) * 0.15)));
            int best = ranked[0].Distance;
            bool unique = ranked.Count == 1 || ranked[1].Distance > best;
            if (unique && best <= threshold)
            {
                string resolved = ranked[0].Phase.Name;
                RevexDiagnostics.Warn("GBXML", $"Phase input '{requested}' was not an exact Revit phase; resolved deterministically to '{resolved}' (edit distance {best}).");
                return settings with { PhaseName = resolved };
            }
        }

        RevexDiagnostics.Warn("GBXML", $"Phase input '{requested}' does not match a Revit phase. The engine will block with a report instead of guessing. Available phases: {string.Join(", ", phases.Select(p => p.Name))}");
        return settings;
    }

    private static string NormalizePhaseName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        return new string(value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
    }

    private static int Levenshtein(string a, string b)
    {
        if (a.Length == 0) return b.Length;
        if (b.Length == 0) return a.Length;
        int[] previous = Enumerable.Range(0, b.Length + 1).ToArray();
        int[] current = new int[b.Length + 1];
        for (int i = 1; i <= a.Length; i++)
        {
            current[0] = i;
            for (int j = 1; j <= b.Length; j++)
            {
                int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + cost);
            }
            (previous, current) = (current, previous);
        }
        return previous[b.Length];
    }

    private static string ResolveOutputFolder(Document doc, string requested)
    {
        if (!string.IsNullOrWhiteSpace(requested))
            return Path.GetFullPath(Environment.ExpandEnvironmentVariables(requested.Trim()));
        if (!string.IsNullOrWhiteSpace(doc.PathName))
        {
            string? modelFolder = Path.GetDirectoryName(doc.PathName);
            if (!string.IsNullOrWhiteSpace(modelFolder))
                return Path.Combine(modelFolder, "gbXML_EXPORT");
        }
        return Path.Combine(AppPaths.Engineering, "gbXML_EXPORT", SafeFileName(doc.Title));
    }

    private static string ResolveBundledGraph() => ResolveBundledAsset(GraphFileName);
    private static string ResolveBundledPython() => ResolveBundledAsset(PythonFileName);

    private static string ResolveBundledAsset(string fileName)
    {
        string[] roots =
        {
            AppPaths.InstallRoot,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LIBER", "REVEX", "App"),
            AppContext.BaseDirectory
        };
        foreach (string root in roots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            string candidate = Path.Combine(root, "Engineering", "Gbxml", fileName);
            RevexDiagnostics.Info("GBXML", "Bundled asset probe: " + candidate);
            if (File.Exists(candidate))
                return candidate;
        }
        throw new FileNotFoundException("REVEX gbXML engine asset is missing from the installed add-in: " + fileName);
    }

    private static void ValidateBundledEngine(string graph, string python)
    {
        JsonNode root = JsonNode.Parse(File.ReadAllText(graph))
            ?? throw new InvalidDataException("Bundled gbXML Dynamo graph is empty.");
        JsonArray nodes = root["Nodes"]?.AsArray()
            ?? throw new InvalidDataException("Bundled gbXML Dynamo graph has no Nodes array.");
        var ids = nodes.OfType<JsonObject>()
            .Select(n => n["Id"]?.GetValue<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        string[] missing = InputNodes.Values.Where(id => !ids.Contains(id)).ToArray();
        if (missing.Length > 0)
            throw new InvalidDataException("Bundled gbXML engine input contract is incomplete: " + string.Join(", ", missing));
        if (new FileInfo(graph).Length < 1024 || new FileInfo(python).Length < 1024)
            throw new InvalidDataException("Bundled gbXML engine files are unexpectedly small/corrupt.");

        JsonObject? pythonNode = nodes.OfType<JsonObject>().FirstOrDefault(n =>
            (n["ConcreteType"]?.GetValue<string>() ?? string.Empty).Contains("PythonNodeModels.PythonNode", StringComparison.Ordinal));
        string embeddedCode = pythonNode?["Code"]?.GetValue<string>() ?? string.Empty;
        string externalCode = File.ReadAllText(python);
        if (string.IsNullOrWhiteSpace(embeddedCode))
            throw new InvalidDataException("Bundled gbXML Dynamo graph has no embedded Python engine.");
        if (!string.Equals(NormalizeTextFile(embeddedCode), NormalizeTextFile(externalCode), StringComparison.Ordinal))
            throw new InvalidDataException("Bundled gbXML graph and external Python engine are out of sync.");
        if (!embeddedCode.Contains($"TOOL_VERSION = \"{EngineVersion}\"", StringComparison.Ordinal))
            throw new InvalidDataException("Bundled gbXML engine version does not match REVEX.");

        RevexDiagnostics.Info("GBXML", $"Engine self-test passed. graph={Path.GetFileName(graph)} sha256={Sha256(graph)[..16]}…; python sha256={Sha256(python)[..16]}…; inputs={InputNodes.Count}; embeddedPython=matched");
    }

    private static void WriteRunGraph(string sourceGraph, string runGraph, GbxmlEngineeringSettings settings)
    {
        JsonNode root = JsonNode.Parse(File.ReadAllText(sourceGraph))
            ?? throw new InvalidDataException("Bundled gbXML Dynamo graph is empty.");
        JsonArray nodes = root["Nodes"]?.AsArray()
            ?? throw new InvalidDataException("Bundled gbXML Dynamo graph has no Nodes array.");

        SetInput(nodes, InputNodes["run"], true);
        SetInput(nodes, InputNodes["audit"], settings.AuditOnly);
        SetInput(nodes, InputNodes["output"], settings.OutputFolder ?? string.Empty);
        SetInput(nodes, InputNodes["name"], settings.XmlName ?? string.Empty);
        SetInput(nodes, InputNodes["phase"], settings.PhaseName ?? string.Empty);
        SetInput(nodes, InputNodes["fix"], settings.CreateOrFixSpaces);
        SetInput(nodes, InputNodes["force"], settings.ExportDespiteBlockers);
        SetInput(nodes, InputNodes["minilm"], settings.MiniLmFolder ?? string.Empty);

        // The source graph stays Manual so a human opening it in Dynamo cannot accidentally
        // modify a project. REVEX writes a private per-run copy and makes only that copy
        // Automatic. DynamoRevit automation then evaluates it synchronously on open.
        JsonObject? dynamoView = root["View"]?["Dynamo"] as JsonObject;
        if (dynamoView == null)
            throw new InvalidDataException("gbXML Dynamo graph has no View.Dynamo run settings.");
        string sourceRunType = dynamoView["RunType"]?.GetValue<string>() ?? "<missing>";
        dynamoView["RunType"] = "Automatic";
        dynamoView["HasRunWithoutCrash"] = false;

        File.WriteAllText(runGraph, root.ToJsonString(CreateJsonOptions(writeIndented: false)));
        RevexDiagnostics.Info("GBXML", $"Run graph written. runType={sourceRunType}->Automatic; bytes={new FileInfo(runGraph).Length}; sha256={Sha256(runGraph)[..16]}…");
    }

    private static JsonSerializerOptions CreateJsonOptions(bool writeIndented) => new()
    {
        WriteIndented = writeIndented,
        TypeInfoResolver = new DefaultJsonTypeInfoResolver()
    };

    private static void SetInput(JsonArray nodes, string id, object value)
    {
        JsonObject? node = nodes.OfType<JsonObject>()
            .FirstOrDefault(n => string.Equals(n["Id"]?.GetValue<string>(), id, StringComparison.OrdinalIgnoreCase));
        if (node == null)
            throw new InvalidDataException("gbXML engine input node missing: " + id);
        node["InputValue"] = JsonValue.Create(value);
    }

    /// <summary>
    /// Returns true only when Revit's supported Dynamo command has created the shared
    /// DynamoRevit model. This probe never loads Dynamo and is therefore safe inside Idling.
    /// </summary>
    public static bool IsDynamoHostInitialized()
    {
        try
        {
            Assembly? assembly = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a =>
                a.GetType("Dynamo.Applications.DynamoRevit", false) != null);
            Type? dynamoType = assembly?.GetType("Dynamo.Applications.DynamoRevit", false);
            PropertyInfo? modelProperty = dynamoType?.GetProperty(
                "RevitDynamoModel", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            return modelProperty?.GetValue(null) != null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Initializes Dynamo's UI-less synchronous automation host from a dedicated Revit
    /// ExternalEvent. The publisher must never call this from an Idling handler because
    /// Dynamo legitimately subscribes to Idling while its host is being created.
    /// </summary>
    public static void InitializeDynamoAutomationHost(UIApplication uiapp)
    {
        if (IsDynamoHostInitialized())
        {
            RevexDiagnostics.Info("GBXML", "Dynamo UI-less automation host is already initialized.");
            return;
        }

        Assembly assembly = ResolveDynamoAssembly();
        Type dynamoType = assembly.GetType("Dynamo.Applications.DynamoRevit", throwOnError: true)!;
        Type dataType = assembly.GetType("Dynamo.Applications.DynamoRevitCommandData", throwOnError: true)!;
        Type keysType = assembly.GetType("Dynamo.Applications.JournalKeys", throwOnError: true)!;
        MethodInfo execute = ResolveDynamoExecute(dynamoType, dataType);
        object? target = execute.IsStatic ? null : Activator.CreateInstance(dynamoType);
        object initData = CreateDynamoCommandData(dataType, uiapp, new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [JournalKey(keysType, "ShowUiKey")] = bool.FalseString,
            [JournalKey(keysType, "AutomationModeKey")] = bool.TrueString,
            [JournalKey(keysType, "ModelShutDownKey")] = bool.TrueString
        });

        RevexDiagnostics.Info("GBXML", "Initializing Dynamo UI-less synchronous host in a dedicated Revit ExternalEvent context.");
        object? result = InvokeDynamo(execute, target, initData, "external-event initialization");
        EnsureDynamoSucceeded(result, "external-event initialization");
        if (!IsDynamoHostInitialized())
            throw new InvalidOperationException("Dynamo returned Succeeded without creating its shared Revit automation model.");
    }

    /// <summary>
    /// The publisher initializes Dynamo in a dedicated Revit ExternalEvent so its event
    /// subscriptions never occur inside the publisher's Idling callback. Normal interactive
    /// Energy export can still initialize a fresh UI-less model here because it already runs in
    /// the add-in's ExternalEvent. Once initialized, REVEX executes the run graph through
    /// DynamoRevit's synchronous journal automation path.
    /// </summary>
    private static void ExecuteDynamo(UIApplication uiapp, string graphPath)
    {
        Assembly assembly = ResolveDynamoAssembly();
        Type dynamoType = assembly.GetType("Dynamo.Applications.DynamoRevit", throwOnError: true)!;
        Type dataType = assembly.GetType("Dynamo.Applications.DynamoRevitCommandData", throwOnError: true)!;
        Type keysType = assembly.GetType("Dynamo.Applications.JournalKeys", throwOnError: true)!;

        MethodInfo execute = ResolveDynamoExecute(dynamoType, dataType);

        object? target = execute.IsStatic ? null : Activator.CreateInstance(dynamoType);

        if (!IsDynamoHostInitialized())
        {
            InitializeDynamoAutomationHost(uiapp);
        }
        else
        {
            RevexDiagnostics.Info("GBXML", "Dynamo stage 1/2: existing UI-less synchronous host verified; initialization safely skipped.");
        }

        var runJournal = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [JournalKey(keysType, "ShowUiKey")] = bool.FalseString,
            [JournalKey(keysType, "AutomationModeKey")] = bool.TrueString,
            [JournalKey(keysType, "DynPathKey")] = graphPath,
            [JournalKey(keysType, "DynPathExecuteKey")] = bool.TrueString,
            [JournalKey(keysType, "ForceManualRunKey")] = bool.FalseString,
            [JournalKey(keysType, "ModelShutDownKey")] = bool.FalseString
        };
        TryJournalKey(runJournal, keysType, "DynPathCheckExisting", bool.FalseString);
        TryJournalKey(runJournal, keysType, "ModelNodesInfo", string.Empty);
        object runData = CreateDynamoCommandData(dataType, uiapp, runJournal);

        RevexDiagnostics.Info("GBXML", "Dynamo stage 2/2: execute graph through DynamoRevit journal automation: " + graphPath);
        object? runResult = InvokeDynamo(execute, target, runData, "graph execution");
        EnsureDynamoSucceeded(runResult, "graph execution");
        RevexDiagnostics.Info("GBXML", "DynamoRevit synchronous graph execution returned to REVEX.");
    }

    private static MethodInfo ResolveDynamoExecute(Type dynamoType, Type dataType) =>
        dynamoType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            .Where(m => m.Name == "ExecuteCommand")
            .FirstOrDefault(m =>
            {
                ParameterInfo[] parameters = m.GetParameters();
                return parameters.Length == 1 && parameters[0].ParameterType.IsAssignableFrom(dataType);
            })
        ?? throw new MissingMethodException(dynamoType.FullName, "ExecuteCommand(DynamoRevitCommandData)");

    private static object CreateDynamoCommandData(Type dataType, UIApplication uiapp, IDictionary<string, string> journal)
    {
        object data = Activator.CreateInstance(dataType)
            ?? throw new InvalidOperationException("Could not create DynamoRevitCommandData.");
        PropertyInfo application = dataType.GetProperty("Application")
            ?? throw new MissingMemberException(dataType.FullName, "Application");
        PropertyInfo journalData = dataType.GetProperty("JournalData")
            ?? throw new MissingMemberException(dataType.FullName, "JournalData");
        application.SetValue(data, uiapp);
        journalData.SetValue(data, journal);
        return data;
    }

    private static object? InvokeDynamo(MethodInfo execute, object? target, object data, string stage)
    {
        try
        {
            return execute.Invoke(target, new[] { data });
        }
        catch (TargetInvocationException ex)
        {
            Exception inner = ex.InnerException ?? ex;
            throw new InvalidOperationException("Dynamo " + stage + " failed: " + inner.Message, inner);
        }
    }

    private static void EnsureDynamoSucceeded(object? result, string stage)
    {
        string text = result?.ToString() ?? "<null>";
        RevexDiagnostics.Info("GBXML", $"Dynamo {stage} result={text}");
        if (!string.Equals(text, "Succeeded", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Dynamo " + stage + " did not return Succeeded (actual: " + text + ").");
    }

    private static Assembly ResolveDynamoAssembly()
    {
        Assembly? loaded = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a =>
            string.Equals(a.GetName().Name, "DynamoRevitDS", StringComparison.OrdinalIgnoreCase) ||
            a.GetType("Dynamo.Applications.DynamoRevit", false) != null);
        if (loaded != null)
        {
            RevexDiagnostics.Dependency("GBXML", "DynamoRevitDS", true,
                $"already loaded; assembly={loaded.FullName}; location={loaded.Location}");
            RevexDiagnostics.Info("GBXML", "Using loaded Dynamo assembly: " + loaded.Location);
            return loaded;
        }

        var candidates = new List<string>();
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        candidates.Add(Path.Combine(programFiles, "Autodesk", "Revit 2026", "AddIns", "DynamoForRevit", "DynamoRevitDS.dll"));
        candidates.Add(Path.Combine(programFiles, "Autodesk", "Revit 2026", "AddIns", "DynamoForRevit", "Revit", "DynamoRevitDS.dll"));

        string root = Path.Combine(programFiles, "Autodesk", "Revit 2026", "AddIns", "DynamoForRevit");
        if (Directory.Exists(root))
        {
            try { candidates.AddRange(Directory.EnumerateFiles(root, "DynamoRevitDS.dll", SearchOption.AllDirectories)); }
            catch (Exception ex) { RevexDiagnostics.Warn("GBXML", "Dynamo search warning: " + ex.Message); }
        }

        foreach (string candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
            RevexDiagnostics.Dependency("GBXML", "DynamoRevitDS candidate", File.Exists(candidate), candidate, required: false);

        string? path = candidates.FirstOrDefault(File.Exists);
        if (path == null)
        {
            RevexDiagnostics.Dependency("GBXML", "Dynamo for Revit 2026", false,
                "No DynamoRevitDS.dll candidate exists. Repair/install Dynamo for Revit 2026.");
            throw new FileNotFoundException("Dynamo for Revit 2026 was not found. Repair/install Dynamo for Revit, then run the REVEX Engineering export again.");
        }

        RevexDiagnostics.Dependency("GBXML", "Dynamo for Revit 2026", true, path);
        RevexDiagnostics.Info("GBXML", "Loading Dynamo assembly: " + path);
        return Assembly.LoadFrom(path);
    }

    private static string JournalKey(Type keysType, string member)
    {
        FieldInfo? field = keysType.GetField(member, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        if (field?.GetValue(null) is string fs && fs.Length > 0) return fs;
        PropertyInfo? property = keysType.GetProperty(member, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        if (property?.GetValue(null) is string ps && ps.Length > 0) return ps;
        throw new MissingMemberException(keysType.FullName, member);
    }

    private static void TryJournalKey(IDictionary<string, string> journal, Type keysType, string member, string value)
    {
        try { journal[JournalKey(keysType, member)] = value; }
        catch (MissingMemberException) { RevexDiagnostics.Warn("GBXML", "Optional Dynamo journal key unavailable: " + member); }
    }

    private static bool HasFreshEngineEvidence(string outputFolder, DateTime started)
    {
        return FindNewest(outputFolder, "*_REPORT.json", started) != null ||
               FindNewest(outputFolder, "*_SUMMARY.txt", started) != null;
    }

    private static void ForceRunCurrentWorkspace()
    {
        Assembly assembly = ResolveDynamoAssembly();
        Type dynamoType = assembly.GetType("Dynamo.Applications.DynamoRevit", throwOnError: true)!;
        PropertyInfo modelProperty = dynamoType.GetProperty("RevitDynamoModel", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new MissingMemberException(dynamoType.FullName, "RevitDynamoModel");
        object model = modelProperty.GetValue(null)
            ?? throw new InvalidOperationException("Dynamo Revit model is unavailable after graph execution.");
        MethodInfo forceRun = model.GetType().GetMethod("ForceRun", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null, Type.EmptyTypes, null)
            ?? throw new MissingMethodException(model.GetType().FullName, "ForceRun()");
        try
        {
            forceRun.Invoke(model, null);
            RevexDiagnostics.Info("GBXML", "Dynamo ForceRun returned to REVEX.");
        }
        catch (TargetInvocationException ex)
        {
            Exception inner = ex.InnerException ?? ex;
            throw new InvalidOperationException("Dynamo ForceRun failed: " + inner.Message, inner);
        }
    }

    private static void LogCurrentWorkspaceDiagnostics()
    {
        try
        {
            Assembly assembly = ResolveDynamoAssembly();
            Type dynamoType = assembly.GetType("Dynamo.Applications.DynamoRevit", throwOnError: true)!;
            object? model = dynamoType.GetProperty("RevitDynamoModel", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)?.GetValue(null);
            object? workspace = model?.GetType().GetProperty("CurrentWorkspace", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(model);
            if (workspace == null)
            {
                RevexDiagnostics.Error("GBXML", "Dynamo produced no report and no current workspace was available for diagnostics.");
                return;
            }

            string fileName = ReadObjectProperty(workspace, "FileName") ?? "<unknown>";
            RevexDiagnostics.Error("GBXML", "Dynamo produced no report after ForceRun. CurrentWorkspace=" + fileName);
            object? nodesValue = workspace.GetType().GetProperty("Nodes", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(workspace);
            if (nodesValue is System.Collections.IEnumerable nodes)
            {
                foreach (object node in nodes)
                {
                    string typeName = node.GetType().FullName ?? node.GetType().Name;
                    if (!typeName.Contains("Python", StringComparison.OrdinalIgnoreCase)) continue;
                    string state = ReadObjectProperty(node, "State") ?? "<unknown>";
                    string name = ReadObjectProperty(node, "Name") ?? typeName;
                    RevexDiagnostics.Error("GBXML", $"Python node diagnostic: name={name}; state={state}; type={typeName}");

                    object? infosValue = node.GetType().GetProperty("Infos", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(node);
                    if (infosValue is System.Collections.IEnumerable infos)
                    {
                        int count = 0;
                        foreach (object info in infos)
                        {
                            if (count++ >= 12) break;
                            RevexDiagnostics.Error("GBXML", "Python node info: " + (info?.ToString() ?? "<null>"));
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("GBXML", "Could not read Dynamo workspace diagnostics: " + ex.Message);
        }
    }

    private static string? ReadObjectProperty(object target, string propertyName)
    {
        try
        {
            object? value = target.GetType().GetProperty(propertyName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(target);
            return value?.ToString();
        }
        catch { return null; }
    }

    private static string? FindNewest(string folder, string pattern, DateTime started)
    {
        if (!Directory.Exists(folder)) return null;
        try
        {
            return Directory.EnumerateFiles(folder, pattern, SearchOption.TopDirectoryOnly)
                .Select(path => new FileInfo(path))
                .Where(file => file.LastWriteTime >= started.AddSeconds(-3))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .Select(file => file.FullName)
                .FirstOrDefault();
        }
        catch { return null; }
    }

    private static (string? Status, string? GbxmlPath) ReadReportResult(string? reportPath)
    {
        if (string.IsNullOrWhiteSpace(reportPath) || !File.Exists(reportPath)) return (null, null);
        try
        {
            using JsonDocument report = JsonDocument.Parse(File.ReadAllText(reportPath));
            string? status = report.RootElement.TryGetProperty("status", out JsonElement statusElement)
                ? statusElement.GetString()
                : null;
            string? xml = report.RootElement.TryGetProperty("gbxml_path", out JsonElement xmlElement) && xmlElement.ValueKind == JsonValueKind.String
                ? xmlElement.GetString()
                : null;
            return (status, xml);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("GBXML", "Could not parse authoritative report: " + ex.Message);
            return (null, null);
        }
    }

    private static void PromoteGeometryEvidence(
        string? reportPath,
        string gbxmlPath,
        string outputFolder,
        string runFolder,
        Document doc,
        DateTime started)
    {
        if (string.IsNullOrWhiteSpace(reportPath) || !File.Exists(reportPath))
            throw new InvalidDataException("The authoritative fresh report is missing.");
        if (File.GetLastWriteTime(reportPath) < started.AddSeconds(-3))
            throw new InvalidDataException("The authoritative report predates this gbXML run.");

        string canonicalOutput = Path.GetFullPath(outputFolder).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string canonicalXml = Path.GetFullPath(gbxmlPath);
        string expectedSource = Path.GetFullPath(Path.Combine(canonicalOutput, GeometryEvidenceName));
        using JsonDocument report = JsonDocument.Parse(File.ReadAllText(reportPath));
        JsonElement root = report.RootElement;
        string Text(JsonElement owner, string name) =>
            owner.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? ""
                : "";

        if (!string.Equals(Text(root, "status"), "EXPORTED", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The authoritative report does not claim an EXPORTED result.");
        string reportXml = Text(root, "gbxml_path");
        if (string.IsNullOrWhiteSpace(reportXml) ||
            !string.Equals(Path.GetFullPath(reportXml), canonicalXml, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The authoritative report belongs to different gbXML bytes.");
        if (!root.TryGetProperty("geometry_evidence", out JsonElement metadata) || metadata.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("The authoritative report has no processed-geometry binding.");

        string sourceValue = Text(metadata, "path");
        if (string.IsNullOrWhiteSpace(sourceValue))
            throw new InvalidDataException("The authoritative report has no processed-geometry path.");
        string sourcePath = Path.GetFullPath(sourceValue);
        if (!string.Equals(sourcePath, expectedSource, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFileName(sourcePath), GeometryEvidenceName, StringComparison.Ordinal))
            throw new InvalidDataException("The processed-geometry path is outside this run's canonical output folder.");
        if (!File.Exists(sourcePath) || File.GetLastWriteTime(sourcePath) < started.AddSeconds(-3))
            throw new InvalidDataException("The processed-geometry file is missing or stale.");

        string geometrySha = Sha256(sourcePath);
        string xmlSha = Sha256(canonicalXml);
        if (!string.Equals(Text(metadata, "schema"), "liber.revex.revit-energy-geometry.v1", StringComparison.Ordinal) ||
            !string.Equals(Text(metadata, "sha256"), geometrySha, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Text(metadata, "gbxmlSha256"), xmlSha, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The report's processed-geometry digests do not match the fresh files.");

        using (JsonDocument evidence = JsonDocument.Parse(File.ReadAllText(sourcePath)))
        {
            JsonElement facts = evidence.RootElement;
            if (!string.Equals(Text(facts, "schema"), "liber.revex.revit-energy-geometry.v1", StringComparison.Ordinal) ||
                !string.Equals(Text(facts, "authority"), "active-revit-document-processed-energy-geometry", StringComparison.Ordinal))
                throw new InvalidDataException("The processed-geometry schema or authority is incompatible.");
            if (!facts.TryGetProperty("sourceDocument", out JsonElement sourceDocument) ||
                sourceDocument.ValueKind != JsonValueKind.Object ||
                !string.Equals(Text(sourceDocument, "title"), doc.Title, StringComparison.Ordinal) ||
                !string.Equals(Text(sourceDocument, "documentFingerprint"), CentralModelBindingService.ResolveDocumentFingerprint(doc), StringComparison.Ordinal))
                throw new InvalidDataException("The processed geometry belongs to a different active Revit document.");
            if (!facts.TryGetProperty("gbxml", out JsonElement evidenceXml) || evidenceXml.ValueKind != JsonValueKind.Object ||
                !string.Equals(Text(evidenceXml, "sha256"), xmlSha, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The processed geometry is bound to different gbXML bytes.");
        }

        string destination = Path.Combine(runFolder, GeometryEvidenceName);
        string temporary = Path.Combine(runFolder, $".{GeometryEvidenceName}.tmp-{Guid.NewGuid():N}");
        try
        {
            File.Copy(sourcePath, temporary, overwrite: false);
            if (!string.Equals(Sha256(temporary), geometrySha, StringComparison.OrdinalIgnoreCase))
                throw new IOException("The private geometry-evidence copy failed digest verification.");
            File.Move(temporary, destination, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
        RevexDiagnostics.Dependency("GBXML", "Immutable processed geometry evidence", true,
            $"{destination}; sha256={geometrySha}; gbxmlSha256={xmlSha}");
    }

    private static string? FindNewestSuccessfulXml(string folder, DateTime started)
    {
        if (!Directory.Exists(folder)) return null;
        try
        {
            return Directory.EnumerateFiles(folder, "*.xml", SearchOption.TopDirectoryOnly)
                .Select(path => new FileInfo(path))
                .Where(file => file.LastWriteTime >= started.AddSeconds(-3))
                .Where(file => !file.Name.Contains(".partial", StringComparison.OrdinalIgnoreCase))
                .Where(file => !file.Name.Contains(".FAILED", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .Select(file => file.FullName)
                .FirstOrDefault();
        }
        catch { return null; }
    }

    private static void ExportEngineeringPageEvidence(Document doc, string runFolder)
    {
        ProjectIdentityEvidence identity = ProjectIdentityEvidenceService.Capture(doc);
        string identityPath = Path.Combine(runFolder, "REVIT-PROJECT-IDENTITY.json");
        File.WriteAllText(identityPath, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.revit-project-identity.v1",
            authority = "active-revit-document-t-z-title-evidence",
            generatedAt = DateTime.UtcNow,
            model = doc.Title,
            documentUniqueId = doc.ProjectInformation?.UniqueId ?? "",
            documentFingerprint = CentralModelBindingService.ResolveDocumentFingerprint(doc),
            identity.Digest,
            identity.DisplayName,
            identity.Sheets,
            identity.Fields,
            identity.Tokens,
            normalized = identity.Normalized,
            normalizedProvenance = identity.NormalizedProvenance,
            prohibitedSources = new[] { "browser-last-project", "prior-revision", "reference-project", "file-path-guess" }
        }, CreateJsonOptions(writeIndented: true)));
        string pageFolder = Path.Combine(runFolder, "REVIT-PAGES");
        Directory.CreateDirectory(pageFolder);
        var sheets = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
            .Where(sheet => !sheet.IsPlaceholder && sheet.CanBePrinted)
            .Select(sheet => new
            {
                Sheet = sheet,
                Number = (sheet.SheetNumber ?? string.Empty).Trim(),
                Name = (sheet.Name ?? string.Empty).Trim()
            })
            .Select(row => new
            {
                row.Sheet, row.Number, row.Name,
                Discipline = IsEnergySheet(row.Number, row.Name) ? "EN" : IsZoningSheet(row.Number, row.Name) ? "Z" : IsTitleSheet(row.Number, row.Name) ? "T" : ""
            })
            .Where(row => row.Discipline.Length > 0)
            .OrderBy(row => row.Discipline, StringComparer.OrdinalIgnoreCase)
            .ThenBy(row => row.Number, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var pages = new List<object>();
        foreach (var row in sheets)
        {
            string baseName = $"REVIT_PAGE_{row.Discipline}_{SafeFileName(row.Number)}_{SafeFileName(row.Name)}";
            string expected = Path.Combine(pageFolder, baseName + ".pdf");
            try { if (File.Exists(expected)) File.Delete(expected); } catch { }
            try
            {
                var options = new PDFExportOptions
                {
                    Combine = true,
                    FileName = baseName,
                    AlwaysUseRaster = false,
                    ViewLinksInBlue = false
                };
                bool ok = doc.Export(pageFolder, new List<ElementId> { row.Sheet.Id }, options);
                string? pdf = File.Exists(expected) ? expected : Directory.GetFiles(pageFolder, "*.pdf")
                    .Where(path => Path.GetFileNameWithoutExtension(path).StartsWith(baseName, StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
                if (!ok || string.IsNullOrWhiteSpace(pdf) || !File.Exists(pdf))
                {
                    RevexDiagnostics.Warn("PAGE-EVIDENCE", $"Could not export {row.Discipline} sheet {row.Number} {row.Name}.");
                    continue;
                }
                pages.Add(new
                {
                    discipline = row.Discipline,
                    sheetNumber = row.Number,
                    sheetName = row.Name,
                    revitElementId = row.Sheet.Id.Value,
                    file = Path.GetFileName(pdf),
                    bytes = new FileInfo(pdf).Length,
                    sha256 = Sha256(pdf),
                    source = "native-revit-sheet-pdf"
                });
                RevexDiagnostics.Info("PAGE-EVIDENCE", $"Exported {row.Discipline} sheet {row.Number} -> {Path.GetFileName(pdf)}");
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Warn("PAGE-EVIDENCE", $"Sheet export failed for {row.Discipline} {row.Number}: {ex.Message}");
            }
        }

        string indexPath = Path.Combine(runFolder, "REVIT-PAGE-EVIDENCE.json");
        File.WriteAllText(indexPath, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.revit-page-evidence.v1",
            purpose = "managed-ai-page-scan-only",
            aiGeometryAuthority = false,
            geometrySource = "Revit/gbXML evidence graph only",
            generatedAt = DateTime.UtcNow,
            model = doc.Title,
            pageFolder = "REVIT-PAGES",
            identityFile = Path.GetFileName(identityPath),
            identityDigest = identity.Digest,
            pageCount = pages.Count,
            pages
        }, CreateJsonOptions(writeIndented: true)));
        RevexDiagnostics.Stage("PAGE-EVIDENCE", "EXPORT_T_Z_EN_SHEETS", "PASSED", $"pages={pages.Count}; identity={identityPath}; index={indexPath}");
    }

    private static bool IsEnergySheet(string number, string name)
    {
        string n = number.Trim().ToUpperInvariant();
        string title = name.Trim().ToUpperInvariant();
        return n.StartsWith("EN", StringComparison.Ordinal) || title.Contains("ENERGY", StringComparison.Ordinal) || title.StartsWith("EN ", StringComparison.Ordinal);
    }

    private static bool IsZoningSheet(string number, string name)
    {
        string n = number.Trim().ToUpperInvariant();
        string title = name.Trim().ToUpperInvariant();
        return n.StartsWith("Z", StringComparison.Ordinal) || title.Contains("ZONING", StringComparison.Ordinal);
    }

    private static bool IsTitleSheet(string number, string name)
    {
        string n = number.Trim().ToUpperInvariant();
        string title = name.Trim().ToUpperInvariant();
        return n.StartsWith("T", StringComparison.Ordinal) || title.Contains("TITLE", StringComparison.Ordinal) || title.Contains("COVER", StringComparison.Ordinal) || title.Contains("CODE", StringComparison.Ordinal);
    }

    private static string NormalizeTextFile(string value) => value.Replace("\r\n", "\n").Replace("\r", "\n").TrimEnd();

    private static string SafeRead(string path)
    {
        try { return File.ReadAllText(path); }
        catch (Exception ex) { return "Could not read summary: " + ex.Message; }
    }

    private static void LogSummary(string summary)
    {
        if (string.IsNullOrWhiteSpace(summary)) return;
        foreach (string raw in summary.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries).Take(48))
            RevexDiagnostics.Info("GBXML-REPORT", raw.Trim());
    }

    private static string Sha256(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string SafeFileName(string value)
    {
        foreach (char c in Path.GetInvalidFileNameChars()) value = value.Replace(c, '_');
        return string.IsNullOrWhiteSpace(value) ? "Revit_Model" : value.Trim();
    }

    private static string Display(string? value, string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value;
}
