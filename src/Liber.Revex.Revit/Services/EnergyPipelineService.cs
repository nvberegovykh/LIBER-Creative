using Liber.Revex.Revit.Models;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

public sealed class EnergyPipelineService
{
    public async Task<EnergyPipelineOutput> RunAsync(EngineeringSyncOutput source, EnergyPipelineRequest request)
    {
        string correlationId = string.IsNullOrWhiteSpace(request.CorrelationId)
            ? RevexDiagnostics.NewCorrelationId("energy") : request.CorrelationId;
        using var workflow = RevexDiagnostics.BeginWorkflow("ENERGY_PIPELINE", request.Initiator, correlationId);
        try
        {
            AppPaths.Ensure();
            string runId = "energy_" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ");
            string root = Path.Combine(AppPaths.EngineeringEnergyRuns, runId);
            Directory.CreateDirectory(root);
            RevexDiagnostics.Stage("ENERGY", "INPUT", "STARTED",
                $"runFolder={root}; sourceRevision={source.Revision}; parentRun={Display(request.ParentCorrelationId, "none")}; standard={request.StandardVersion}");
            RevexDiagnostics.Dependency("ENERGY", "Engineering Sync manifest", File.Exists(source.ManifestPath), source.ManifestPath);
            RevexDiagnostics.Dependency("ENERGY", "Published gbXML", File.Exists(source.GbxmlPath), source.GbxmlPath);

            string weather = ResolveWeatherFile(root, source, request);
            RevexDiagnostics.Dependency("ENERGY", "Weather file (.EPW) payload", File.Exists(weather),
                $"path={weather}; bytes={(File.Exists(weather) ? new FileInfo(weather).Length : 0)}");
            string worker = Path.Combine(AppPaths.InstallRoot, "Engineering", "Energy", "revex_energy_pipeline.py");
            string requirements = Path.Combine(AppPaths.InstallRoot, "Engineering", "Energy", "requirements.txt");
            RevexDiagnostics.Dependency("ENERGY", "REVEX Energy worker", File.Exists(worker), worker);
            RevexDiagnostics.Dependency("ENERGY", "Python requirements", File.Exists(requirements), requirements);
            if (!File.Exists(worker)) throw new FileNotFoundException("The installed REVEX Energy worker is missing.", worker);

            (string python, string[] prefix) = ResolvePython();
            await EnsureDependenciesAsync(python, prefix, requirements, root);
            string requestPath = Path.Combine(root, "energy-request.json");
            File.WriteAllText(requestPath, JsonSerializer.Serialize(new
            {
                schema = "liber.revex.energy-request.v1",
                pipelineVersion = "0.8.19",
                correlationId,
                parentCorrelationId = request.ParentCorrelationId,
                initiator = request.Initiator,
                projectId = source.ProjectId,
                projectName = request.ProjectName,
                revision = source.Revision,
                gbxmlPath = source.GbxmlPath,
                engineeringSyncManifest = source.ManifestPath,
                outputFolder = root,
                openStudioCli = request.OpenStudioCli,
                weatherFile = weather,
                standardVersion = request.StandardVersion,
                identityPolicy = "LEAVE_APPLICANT_MODELER_SIGNATURE_SEAL_BLANK"
            }, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
            RevexDiagnostics.Dependency("ENERGY", "Worker request manifest", true, requestPath);

            var arguments = prefix.Concat(new[] { worker, "--request", requestPath }).ToArray();
            int exitCode = await RunProcessAsync(python, arguments, root,
                Path.Combine(root, "REVEX-ENERGY-WORKER.log"), "ENERGY-WORKER");
            string resultPath = Path.Combine(root, "energy-result.json");
            RevexDiagnostics.Dependency("ENERGY", "Energy result manifest", File.Exists(resultPath),
                $"path={resultPath}; workerExitCode={exitCode}");
            if (!File.Exists(resultPath))
                throw new InvalidOperationException($"REVEX Energy worker exited {exitCode} without a result manifest. See REVEX-ENERGY-WORKER.log.");

            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(resultPath));
            JsonElement result = doc.RootElement;
            string status = ReadString(result, "status", exitCode == 0 ? "COMPLETE" : "FAILED");
            string revision = ReadString(result, "resultRevision", runId);
            string? error = ReadString(result, "error", "");
            if (string.IsNullOrWhiteSpace(error)) error = null;
            var artifacts = new List<string>();
            if (result.TryGetProperty("artifacts", out JsonElement rows) && rows.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement row in rows.EnumerateArray())
                {
                    string relative = ReadString(row, "path", "");
                    if (string.IsNullOrWhiteSpace(relative)) continue;
                    string path = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
                    if (path.StartsWith(root, StringComparison.OrdinalIgnoreCase) && File.Exists(path)) artifacts.Add(path);
                }
            }
            bool complete = string.Equals(status, "COMPLETE", StringComparison.OrdinalIgnoreCase) && exitCode == 0;
            RevexDiagnostics.Stage("ENERGY", "RESULT", complete ? "PASSED" : "FAILED",
                $"status={status}; workerExitCode={exitCode}; revision={revision}; artifacts={artifacts.Count}; error={Display(error, "none")}; root={root}");
            workflow.Complete(complete,
                $"status={status}; workerExitCode={exitCode}; revision={revision}; artifacts={artifacts.Count}; result={resultPath}");
            return new EnergyPipelineOutput(status, revision, root, resultPath, error, artifacts);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error("ENERGY", "Energy pipeline host failed.", ex);
            workflow.Complete(false, ex.Message);
            throw;
        }
    }

    private static string ResolveWeatherFile(string root, EngineeringSyncOutput source, EnergyPipelineRequest request)
    {
        var candidates = new List<(string path, string origin)>();
        void Add(string? path, string origin)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            try
            {
                string full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path.Trim().Trim('"')));
                if (File.Exists(full) && full.EndsWith(".epw", StringComparison.OrdinalIgnoreCase)) candidates.Add((full, origin));
            }
            catch { }
        }
        Add(source.WeatherPath, "immutable Engineering Sync weather artifact");
        Add(request.WeatherFilePath, "legacy request weather field");
        Add(Environment.GetEnvironmentVariable("REVEX_EPW"), "REVEX_EPW");

        string data = request.WeatherDataUrl ?? "";
        int comma = data.IndexOf(',');
        if (data.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && comma >= 0)
        {
            try
            {
                byte[] bytes = Convert.FromBase64String(data[(comma + 1)..]);
                if (bytes.Length >= 1024)
                {
                    string name = SafeFileName(request.WeatherFileName);
                    if (!name.EndsWith(".epw", StringComparison.OrdinalIgnoreCase)) name += ".epw";
                    string path = Path.Combine(root, name);
                    File.WriteAllBytes(path, bytes);
                    candidates.Add((path, "legacy Companion EPW payload"));
                }
            }
            catch (FormatException) { }
        }

        foreach (var candidate in candidates.DistinctBy(x => x.path, StringComparer.OrdinalIgnoreCase))
        {
            if (!IsValidEpw(candidate.path))
            {
                RevexDiagnostics.Warn("ENERGY", $"Rejected invalid EPW candidate: {candidate.path}; origin={candidate.origin}");
                continue;
            }
            string destination = Path.Combine(root, "weather.epw");
            if (!string.Equals(candidate.path, destination, StringComparison.OrdinalIgnoreCase)) File.Copy(candidate.path, destination, true);
            RevexDiagnostics.Info("ENERGY", $"Weather resolved from {candidate.origin}: {candidate.path}");
            return destination;
        }
        throw new InvalidOperationException("A valid Weather file (.EPW) is required for Energy processing.");
    }

    private static bool IsValidEpw(string path)
    {
        try
        {
            string[] parts = (File.ReadLines(path).FirstOrDefault() ?? "").Split(',');
            if (parts.Length < 10 || !parts[0].Trim().Equals("LOCATION", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(parts[1])) return false;
            bool Parse(int i, out double value) => double.TryParse(parts[i].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value);
            return Parse(6,out double lat) && lat >= -90 && lat <= 90 && Parse(7,out double lon) && lon >= -180 && lon <= 180 && Parse(8,out double tz) && tz >= -14 && tz <= 14 && Parse(9,out _);
        }
        catch { return false; }
    }

    private static (string exe, string[] prefix) ResolvePython()
    {
        string configured = Environment.GetEnvironmentVariable("REVEX_PYTHON") ?? "";
        var candidates = new List<(string exe, string[] prefix, string origin)>();
        if (File.Exists(configured)) candidates.Add((configured, Array.Empty<string>(), "REVEX_PYTHON"));
        string? python = FindOnPath("python.exe") ?? FindOnPath("python3.exe") ?? FindOnPath("python");
        if (python != null) candidates.Add((python, Array.Empty<string>(), "PATH"));
        string? launcher = FindOnPath("py.exe");
        if (launcher != null) candidates.Add((launcher, new[] { "-3" }, "PATH launcher"));
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (Directory.Exists(Path.Combine(local, "Programs", "Python")))
            candidates.AddRange(Directory.GetFiles(Path.Combine(local, "Programs", "Python"), "python.exe", SearchOption.AllDirectories)
                .OrderByDescending(path => path).Select(path => (path, Array.Empty<string>(), "LocalAppData")));

        foreach (var candidate in candidates.DistinctBy(item => item.exe, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var info = new ProcessStartInfo(candidate.exe)
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                foreach (string arg in candidate.prefix.Concat(new[] { "--version" })) info.ArgumentList.Add(arg);
                using Process process = Process.Start(info)!;
                string stdout = process.StandardOutput.ReadToEnd();
                string stderr = process.StandardError.ReadToEnd();
                bool exited = process.WaitForExit(5000);
                bool available = exited && process.ExitCode == 0;
                RevexDiagnostics.Dependency("ENERGY-DEPS", "Python 3 candidate", available,
                    $"origin={candidate.origin}; path={candidate.exe}; version={Display((stdout + " " + stderr).Trim(), "unknown")}", required: false);
                if (available)
                {
                    RevexDiagnostics.Dependency("ENERGY-DEPS", "Python 3 runtime", true,
                        $"origin={candidate.origin}; path={candidate.exe}; prefix={string.Join(' ', candidate.prefix)}; version={(stdout + " " + stderr).Trim()}");
                    return (candidate.exe, candidate.prefix);
                }
                if (!exited) try { process.Kill(entireProcessTree: true); } catch { }
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Dependency("ENERGY-DEPS", "Python 3 candidate", false,
                    $"origin={candidate.origin}; path={candidate.exe}; probeError={ex.GetType().Name}: {ex.Message}", required: false);
            }
        }
        RevexDiagnostics.Dependency("ENERGY-DEPS", "Python 3 runtime", false,
            $"probedCandidates={candidates.Count}; REVEX_PYTHON={Display(configured, "unset")}");
        throw new InvalidOperationException("Python 3 is required for GeometryCo and EnergyPlus report preparation. Set REVEX_PYTHON to python.exe.");
    }

    private static async Task EnsureDependenciesAsync(string python, string[] prefix, string requirements, string root)
    {
        const string modules = "bs4,openpyxl,pypdf,reportlab,shapely,PIL";
        string check = "import " + modules;
        RevexDiagnostics.Stage("ENERGY-DEPS", "PYTHON_IMPORTS", "STARTED", "modules=" + modules);
        int checkCode = await RunProcessAsync(python, prefix.Concat(new[] { "-c", check }).ToArray(), root,
            Path.Combine(root, "PYTHON-DEPENDENCY-CHECK.log"), "ENERGY-DEPS");
        if (checkCode == 0)
        {
            RevexDiagnostics.Dependency("ENERGY-DEPS", "Python modules", true, modules);
            return;
        }
        RevexDiagnostics.Dependency("ENERGY-DEPS", "Python modules", false,
            $"modules={modules}; importExitCode={checkCode}; automatic repair will use the version-locked requirements file");
        if (!File.Exists(requirements)) throw new FileNotFoundException("REVEX Energy requirements are missing.", requirements);
        RevexDiagnostics.Warn("ENERGY-DEPS", "Installing missing local Energy pipeline dependencies for the selected Python 3 runtime.");
        int installCode = await RunProcessAsync(python, prefix.Concat(new[] { "-m", "pip", "install", "-r", requirements }).ToArray(), root,
            Path.Combine(root, "PYTHON-DEPENDENCY-INSTALL.log"), "ENERGY-DEPS");
        if (installCode != 0) throw new InvalidOperationException("Python dependencies could not be installed. See PYTHON-DEPENDENCY-INSTALL.log.");
        RevexDiagnostics.Dependency("ENERGY-DEPS", "Python modules", true,
            $"modules={modules}; repairedFrom={requirements}");
    }

    private static async Task<int> RunProcessAsync(string fileName, IReadOnlyList<string> arguments, string cwd, string logPath, string channel)
    {
        var info = new ProcessStartInfo(fileName)
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (string argument in arguments) info.ArgumentList.Add(argument);
        string command = Quote(fileName) + " " + string.Join(" ", arguments.Select(Quote));
        RevexDiagnostics.Stage(channel, "PROCESS", "STARTED",
            $"command={command}; cwd={cwd}; log={logPath}");
        using var process = new Process { StartInfo = info };
        var output = new StringBuilder();
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            lock (output) output.AppendLine(e.Data);
            RevexDiagnostics.Info(channel, e.Data);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            lock (output) output.AppendLine(e.Data);
            RevexDiagnostics.Warn(channel, e.Data);
        };
        var elapsed = Stopwatch.StartNew();
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Process.Start returned false.");
            RevexDiagnostics.Info(channel, $"process started; pid={process.Id}; executable={fileName}");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync();
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Error(channel,
                $"process launch/wait failed; command={command}; cwd={cwd}; elapsedMs={elapsed.ElapsedMilliseconds}", ex);
            throw;
        }

        string captured;
        lock (output) captured = output.ToString();
        File.WriteAllText(logPath, captured);
        string tail = string.Join(" | ", captured.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries).TakeLast(24));
        string detail = $"pid={process.Id}; exitCode={process.ExitCode}; elapsedMs={elapsed.ElapsedMilliseconds}; log={logPath}; outputLines={captured.Count(c => c == '\n')}";
        if (process.ExitCode == 0)
            RevexDiagnostics.Stage(channel, "PROCESS", "PASSED", detail);
        else
            RevexDiagnostics.Stage(channel, "PROCESS", "FAILED", detail + "; tail=" + Display(tail, "<empty>"));
        return process.ExitCode;
    }

    private static string Quote(string value) =>
        value.Any(char.IsWhiteSpace) || value.Contains('"') ? "\"" + value.Replace("\"", "\\\"") + "\"" : value;

    private static string? FindOnPath(string name)
    {
        foreach (string folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            try { string path = Path.Combine(folder.Trim(), name); if (File.Exists(path)) return path; }
            catch { }
        }
        return null;
    }

    private static string SafeFileName(string value)
    {
        string name = Path.GetFileName(value ?? "weather.epw");
        foreach (char invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '_');
        return string.IsNullOrWhiteSpace(name) ? "weather.epw" : name;
    }

    private static string ReadString(JsonElement root, string property, string fallback) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback : fallback;

    private static string Display(string? value, string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value;
}
