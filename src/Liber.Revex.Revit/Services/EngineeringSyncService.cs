using Liber.Revex.Revit.Models;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Commits the Revit-derived energy evidence as a separate immutable revision.
/// Design Sync files and printing sets are excluded. Structured active-document
/// identity plus read-only T/Z/EN sheet PDFs are immutable managed-worker evidence.
/// </summary>
public sealed class EngineeringSyncService
{
    private const double PublicationMinimum = 0.80;
    private const double QualityTarget = 0.95;
    private const string StructuredScheduleEvidenceName = "REVIT-SCHEDULE-EVIDENCE.json";
    private const string GeometryEvidenceName = "REVIT-ENERGY-GEOMETRY.json";

    public EngineeringSyncOutput Create(
        GbxmlEngineeringOutput source,
        RevexProjectBinding binding,
        string weatherPath,
        string? sourceRevision = null)
    {
        string projectId = binding?.ProjectId?.Trim() ?? "";
        sourceRevision = string.IsNullOrWhiteSpace(sourceRevision) ? null : sourceRevision.Trim();
        if (!string.Equals(binding?.BindingVersion, "active-revit-evidence-v1", StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(binding?.IdentityEvidenceDigest))
            throw new InvalidOperationException("Engineering Sync requires the active Revit document's evidence-verified project binding.");
        RevexDiagnostics.Stage("ENERGY-SYNC", "VALIDATE_SOURCE", "STARTED",
            $"projectId={projectId}; gbxmlStatus={source.Status}; runFolder={source.RunFolder}");
        RevexDiagnostics.Dependency("ENERGY-SYNC", "Published >=80% gbXML hard-stop gate", File.Exists(source.GbxmlPath),
            source.GbxmlPath ?? "<missing>");
        RevexDiagnostics.Dependency("ENERGY-SYNC", "gbXML integrity report", File.Exists(source.ReportPath),
            source.ReportPath ?? "<missing>");
        if (!GbxmlEngineeringService.IsSuccessful(source, auditOnly: false) ||
            string.IsNullOrWhiteSpace(source.GbxmlPath) || !File.Exists(source.GbxmlPath))
            throw new InvalidOperationException("Only a Universal gbXML result that clears the >=80% hard-stop integrity gate can enter Energy Sync.");
        if (string.IsNullOrWhiteSpace(projectId))
            throw new InvalidOperationException("Choose a REVEX project before Energy Sync.");
        IReadOnlyDictionary<string, double> integrity = ValidatePublicationIntegrity(source);
        ValidateEnergyPageEvidence(source.RunFolder, binding);
        ValidateStructuredScheduleEvidence(source.RunFolder);
        GeometryEvidenceMetadata geometryMetadata = ValidateGeometryEvidence(
            source.RunFolder, source.GbxmlPath, source.ModelTitle, binding.DocumentFingerprint);
        string resolvedWeather = ResolveWeatherFile(weatherPath, Path.GetDirectoryName(source.GbxmlPath) ?? source.OutputFolder);
        WeatherMetadata weatherMeta = ValidateWeatherFile(resolvedWeather);
        RevexDiagnostics.Dependency("ENERGY-SYNC", "Weather input (.EPW)", true,
            $"{weatherMeta.City}, {weatherMeta.StateProvince}, {weatherMeta.Country}; WMO={weatherMeta.Wmo}; {resolvedWeather}");
        bool qualityTargetMet = integrity.Values.All(value => value >= QualityTarget);
        var belowQualityTarget = integrity.Where(row => row.Value < QualityTarget).ToDictionary(row => row.Key, row => row.Value, StringComparer.OrdinalIgnoreCase);
        RevexDiagnostics.Stage("ENERGY-SYNC", "VALIDATE_INTEGRITY_GATE", "PASSED",
            $"hardStop={PublicationMinimum:P0}; qualityTarget={QualityTarget:P0}; qualityTargetMet={qualityTargetMet}; " +
            string.Join("; ", integrity.OrderBy(row => row.Key).Select(row => $"{row.Key}={row.Value:P2}")));
        if (!qualityTargetMet)
            RevexDiagnostics.Warn("ENERGY-SYNC", "Integrity is below the 95% quality target and must be surfaced for review in Companion: " +
                string.Join(", ", belowQualityTarget.OrderBy(row => row.Key).Select(row => $"{row.Key}={row.Value:P1}")));

        AppPaths.Ensure();
        string revision = "eng_" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ");
        string staging = AppPaths.CreateEngineeringSyncStaging();
        try
        {
            string gbxml = CopyRequired(source.GbxmlPath, staging, "revit-energy.xml");
            string weather = CopyRequired(resolvedWeather, staging, "weather.epw");
            string? report = CopyOptional(source.ReportPath, staging, "gbxml-report.json");
            string? summary = CopyOptional(source.SummaryPath, staging, "gbxml-summary.txt");
            string geometryEvidence = CopyRequired(
                Path.Combine(source.RunFolder, GeometryEvidenceName),
                staging,
                "revit-energy-geometry.json");
            var evidence = new List<string>();
            evidence.Add(geometryEvidence);
            if (Directory.Exists(source.RunFolder))
            {
                string pageIndexSource = Path.Combine(source.RunFolder, "REVIT-PAGE-EVIDENCE.json");
                if (File.Exists(pageIndexSource))
                {
                    string target = Path.Combine(staging, "revit-page-index.json");
                    File.Copy(pageIndexSource, target, overwrite: true);
                    evidence.Add(target);
                }
                string identitySource = Path.Combine(source.RunFolder, "REVIT-PROJECT-IDENTITY.json");
                if (File.Exists(identitySource))
                {
                    string target = Path.Combine(staging, "revit-project-identity.json");
                    File.Copy(identitySource, target, overwrite: true);
                    evidence.Add(target);
                }
                string pageFolder = Path.Combine(source.RunFolder, "REVIT-PAGES");
                if (Directory.Exists(pageFolder))
                {
                    foreach (string path in Directory.GetFiles(pageFolder, "*.pdf", SearchOption.TopDirectoryOnly).OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
                    {
                        string target = Path.Combine(staging, Path.GetFileName(path));
                        File.Copy(path, target, overwrite: true);
                        evidence.Add(target);
                    }
                }
                foreach (string path in Directory.GetFiles(source.RunFolder, "*.json", SearchOption.TopDirectoryOnly))
                {
                    if (string.Equals(Path.GetFileName(path), "REVIT-PAGE-EVIDENCE.json", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(Path.GetFileName(path), "REVIT-PROJECT-IDENTITY.json", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(Path.GetFileName(path), GeometryEvidenceName, StringComparison.OrdinalIgnoreCase)) continue;
                    string target = Path.Combine(staging, "engine-" + Path.GetFileName(path));
                    File.Copy(path, target, overwrite: true);
                    evidence.Add(target);
                }
            }

            object Artifact(string path, string role) => new
            {
                role,
                name = Path.GetFileName(path),
                bytes = new FileInfo(path).Length,
                sha256 = Sha256(path)
            };

            var artifacts = new List<object> { Artifact(gbxml, "gbxml"), Artifact(weather, "weather-epw") };
            if (report != null) artifacts.Add(Artifact(report, "gbxml-report"));
            if (summary != null) artifacts.Add(Artifact(summary, "gbxml-summary"));
            foreach (string path in evidence)
            {
                string name = Path.GetFileName(path);
                string role = name.Equals("revit-page-index.json", StringComparison.OrdinalIgnoreCase)
                    ? "revit-page-index"
                    : name.Equals("revit-project-identity.json", StringComparison.OrdinalIgnoreCase)
                        ? "revit-project-identity"
                    : name.Equals("revit-energy-geometry.json", StringComparison.OrdinalIgnoreCase)
                        ? "revit-energy-geometry-evidence"
                    : name.Equals("engine-" + StructuredScheduleEvidenceName, StringComparison.OrdinalIgnoreCase)
                        ? "revit-schedule-evidence"
                    : name.StartsWith("REVIT_PAGE_", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)
                        ? "revit-page-pdf"
                        : "engine-evidence";
                artifacts.Add(Artifact(path, role));
            }
            string manifest = Path.Combine(staging, "engineering-sync.json");
            File.WriteAllText(manifest, JsonSerializer.Serialize(new
            {
                schema = "liber.revex.engineering-sync.v1",
                architecture = "REVIT_EVIDENCE_GRAPH_V1",
                engine = "LIBER gbXML 1.1.8 UNIVERSAL",
                revex = "0.8.19",
                correlationId = RevexDiagnostics.CurrentCorrelationId,
                initiator = RevexDiagnostics.CurrentInitiator,
                operation = RevexDiagnostics.CurrentOperation,
                projectId,
                sourceRevision,
                projectBinding = new
                {
                    version = binding.BindingVersion,
                    source = binding.BindingSource,
                    documentUniqueId = binding.DocumentUniqueId,
                    documentFingerprint = binding.DocumentFingerprint,
                    identityEvidenceDigest = binding.IdentityEvidenceDigest,
                    identityDisplayName = binding.IdentityDisplayName,
                    identityEvidenceSheets = binding.IdentityEvidenceSheets
                },
                revision,
                createdAt = DateTime.UtcNow,
                sourceModel = new { title = source.ModelTitle, path = source.ModelPath },
                geometryEvidence = new
                {
                    schema = geometryMetadata.Schema,
                    authority = geometryMetadata.Authority,
                    file = Path.GetFileName(geometryEvidence),
                    sha256 = Sha256(geometryEvidence),
                    gbxmlSha256 = geometryMetadata.GbxmlSha256,
                    documentFingerprint = binding.DocumentFingerprint,
                    geometryMetadata.LevelCount,
                    geometryMetadata.RoomCount,
                    geometryMetadata.SpaceCount,
                    geometryMetadata.PhysicalSurfaceCount,
                    geometryMetadata.PhysicalOpeningCount,
                    geometryMetadata.AnalyticalSurfaceCount,
                    geometryMetadata.AnalyticalOpeningCount
                },
                gbxmlStatus = source.Status,
                publicationIntegrity = new { threshold = PublicationMinimum, qualityTarget = QualityTarget, qualityTargetMet, lowestRatio = integrity.Values.Min(), belowQualityTarget, ratios = integrity },
                weather = new { city = weatherMeta.City, stateProvince = weatherMeta.StateProvince, country = weatherMeta.Country, dataSource = weatherMeta.DataSource, wmo = weatherMeta.Wmo, latitude = weatherMeta.Latitude, longitude = weatherMeta.Longitude, timeZone = weatherMeta.TimeZone, elevation = weatherMeta.Elevation, sourceFile = Path.GetFileName(resolvedWeather), file = Path.GetFileName(weather), sha256 = Sha256(weather) },
                artifacts,
                revitWrites = new { spaces = true, energyAnalysisDetailModel = true, enEnergyPlanTags = true, other = false },
                companionProcessing = new { geometryCo = "4.3.4", baselineAndProposed = true, reports = true, en1 = true, pageScan = "managed-ai-t-z-en-revit-pages", structuredProjectIdentity = "active-revit-document-t-z-title-evidence", structuredRevitSchedules = "active-revit-document-native-schedules", comcheckCurrentProjectCxl = true, comcheckConsent = "one-immutable-engineering-revision-only", projectComcheckFiling = true },
                writeBackToRevitAfterExport = false,
                pdfInsertion = false,
                printingSetChanges = false
            }, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));

            string root = AppPaths.CommitEngineeringSyncRevision(staging, revision);
            string Resolve(string path) => Path.Combine(root, Path.GetFileName(path));
            var output = new EngineeringSyncOutput(
                revision, projectId, root, Resolve(manifest), Resolve(gbxml),
                report == null ? null : Resolve(report), summary == null ? null : Resolve(summary),
                Resolve(weather), evidence.Select(Resolve).ToArray());
            RevexDiagnostics.Info("ENERGY-SYNC", $"Committed immutable engineering revision {revision}: {root}");
            RevexDiagnostics.Stage("ENERGY-SYNC", "COMMIT", "PASSED",
                $"revision={revision}; artifacts={artifacts.Count}; root={root}; revitWriteBackAfterExport=false");
            return output;
        }
        catch
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
            throw;
        }
    }


    public static string ResolveWeatherFile(string preferredPath, string? projectFolder)
    {
        var candidates = new List<string>();
        void Add(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            try
            {
                string full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path.Trim().Trim('"')));
                if (File.Exists(full) && full.EndsWith(".epw", StringComparison.OrdinalIgnoreCase)) candidates.Add(full);
            }
            catch { }
        }
        void AddFolder(string? path, bool recursive)
        {
            if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
            try { foreach (string file in Directory.EnumerateFiles(path, "*.epw", recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly)) Add(file); }
            catch { }
        }
        if (!string.IsNullOrWhiteSpace(preferredPath))
        {
            Add(preferredPath);
            if (candidates.Count == 0) throw new InvalidOperationException("The selected weather file does not exist or is not an .EPW file.");
            ValidateWeatherFile(candidates[0]);
            return candidates[0];
        }
        Add(Environment.GetEnvironmentVariable("REVEX_EPW"));
        string? folder = string.IsNullOrWhiteSpace(projectFolder) ? null : projectFolder;
        if (!string.IsNullOrWhiteSpace(folder) && File.Exists(folder)) folder = Path.GetDirectoryName(folder);
        for (int depth = 0; depth < 4 && !string.IsNullOrWhiteSpace(folder) && Directory.Exists(folder); depth++)
        {
            AddFolder(folder, false);
            foreach (string child in new[] { "ENERGY", "Energy", "energy", "WEATHER", "Weather", "weather", "WeatherData" }) AddFolder(Path.Combine(folder, child), true);
            folder = Directory.GetParent(folder)?.FullName;
        }
        var valid = new List<string>();
        foreach (string candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase)) { try { ValidateWeatherFile(candidate); valid.Add(candidate); } catch { } }
        if (valid.Count == 1) return valid[0];
        if (valid.Count > 1) throw new InvalidOperationException("REVEX found multiple valid project EPW files. Select the intended Weather file (.EPW) explicitly before SYNC ENGINEERING; weather is never guessed.");
        throw new InvalidOperationException("Select the project Weather file (.EPW) before SYNC ENGINEERING, or set REVEX_EPW to one valid EPW path.");
    }

    private sealed record WeatherMetadata(string City, string StateProvince, string Country, string DataSource, string Wmo, double Latitude, double Longitude, double TimeZone, double Elevation);

    private sealed record GeometryEvidenceMetadata(
        string Schema,
        string Authority,
        string GbxmlSha256,
        int LevelCount,
        int RoomCount,
        int SpaceCount,
        int PhysicalSurfaceCount,
        int PhysicalOpeningCount,
        int AnalyticalSurfaceCount,
        int AnalyticalOpeningCount);

    private static WeatherMetadata ValidateWeatherFile(string path)
    {
        if (!File.Exists(path) || !path.EndsWith(".epw", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The selected weather input is not an EPW file.");
        string[] parts = (File.ReadLines(path).FirstOrDefault() ?? "").Split(',');
        if (parts.Length < 10 || !parts[0].Trim().Equals("LOCATION", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The selected .EPW has no valid LOCATION header.");
        bool Parse(int i, out double value) => double.TryParse(parts[i].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value);
        if (!Parse(6,out double lat) || lat < -90 || lat > 90 || !Parse(7,out double lon) || lon < -180 || lon > 180 || !Parse(8,out double tz) || tz < -14 || tz > 14 || !Parse(9,out double elev)) throw new InvalidOperationException("The selected .EPW LOCATION header contains invalid coordinates/time-zone/elevation values.");
        string city=parts[1].Trim(); if (string.IsNullOrWhiteSpace(city)) throw new InvalidOperationException("The selected .EPW LOCATION header has no city/station name.");
        return new WeatherMetadata(city,parts[2].Trim(),parts[3].Trim(),parts[4].Trim(),parts[5].Trim(),lat,lon,tz,elev);
    }

    private static string CopyRequired(string source, string folder, string name)
    {
        if (!File.Exists(source)) throw new FileNotFoundException("Required Energy Sync artifact is missing.", source);
        string target = Path.Combine(folder, name);
        File.Copy(source, target, overwrite: true);
        return target;
    }

    private static string? CopyOptional(string? source, string folder, string name)
    {
        if (string.IsNullOrWhiteSpace(source) || !File.Exists(source)) return null;
        string target = Path.Combine(folder, name);
        File.Copy(source, target, overwrite: true);
        return target;
    }

    private static string Sha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static GeometryEvidenceMetadata ValidateGeometryEvidence(
        string runFolder,
        string gbxmlPath,
        string expectedModelTitle,
        string expectedDocumentFingerprint)
    {
        string path = Path.Combine(runFolder, GeometryEvidenceName);
        if (!File.Exists(path))
            throw new InvalidOperationException("Processed Revit energy geometry evidence is missing. Engineering Sync was not published.");

        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement root = document.RootElement;
        string Text(JsonElement owner, string name) =>
            owner.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? ""
                : "";
        int Count(JsonElement owner, string name) =>
            owner.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.Array
                ? value.GetArrayLength()
                : 0;
        int NestedCount(JsonElement owner, string section, string name) =>
            owner.TryGetProperty(section, out JsonElement value) && value.ValueKind == JsonValueKind.Object
                ? Count(value, name)
                : 0;

        string schema = Text(root, "schema");
        string authority = Text(root, "authority");
        if (!string.Equals(schema, "liber.revex.revit-energy-geometry.v1", StringComparison.Ordinal) ||
            !string.Equals(authority, "active-revit-document-processed-energy-geometry", StringComparison.Ordinal))
            throw new InvalidOperationException("Processed Revit energy geometry evidence has an incompatible schema or authority.");

        if (!root.TryGetProperty("sourceDocument", out JsonElement sourceDocument) ||
            sourceDocument.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("Processed Revit energy geometry evidence has no source-document binding.");
        string modelTitle = Text(sourceDocument, "title");
        if (!string.Equals(modelTitle, expectedModelTitle, StringComparison.Ordinal))
            throw new InvalidOperationException("Processed Revit energy geometry evidence belongs to a different active model.");
        string documentFingerprint = Text(sourceDocument, "documentFingerprint");
        if (!string.Equals(documentFingerprint, expectedDocumentFingerprint, StringComparison.Ordinal))
            throw new InvalidOperationException("Processed Revit energy geometry evidence belongs to a different active-document fingerprint.");
        string coordinateSystem = Text(sourceDocument, "coordinateSystem");
        string linearUnit = Text(sourceDocument, "linearUnit");
        string areaUnit = Text(sourceDocument, "areaUnit");
        string phaseName = Text(sourceDocument, "phaseName");
        bool phaseValid = sourceDocument.TryGetProperty("phaseId", out JsonElement phaseId) &&
                          phaseId.TryGetInt64(out long phaseValue) && phaseValue >= 0 &&
                          !string.IsNullOrWhiteSpace(phaseName);
        if (!phaseValid ||
            !string.Equals(coordinateSystem, "REVIT_HOST_INTERNAL", StringComparison.Ordinal) ||
            !string.Equals(linearUnit, "foot", StringComparison.Ordinal) ||
            !string.Equals(areaUnit, "square-foot", StringComparison.Ordinal))
            throw new InvalidOperationException("Processed Revit energy geometry evidence has an invalid phase, coordinate system, or unit contract.");

        if (!root.TryGetProperty("gbxml", out JsonElement gbxml) || gbxml.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("Processed Revit energy geometry evidence has no gbXML digest binding.");
        string gbxmlSha = Text(gbxml, "sha256");
        if (!string.Equals(gbxmlSha, Sha256(gbxmlPath), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Processed Revit energy geometry evidence does not match the published gbXML bytes.");

        int levels = Count(root, "levels");
        int rooms = Count(root, "rooms");
        int spaces = Count(root, "spaces");
        int processedSpaces = Count(root, "processedSpaces");
        int physicalSurfaces = NestedCount(root, "physical", "surfaces");
        int physicalOpenings = NestedCount(root, "physical", "openings");
        int analyticalSurfaces = NestedCount(root, "analytical", "surfaces");
        int analyticalOpenings = NestedCount(root, "analytical", "openings");
        if (levels == 0 || (spaces == 0 && processedSpaces == 0) ||
            (physicalSurfaces == 0 && analyticalSurfaces == 0 && processedSpaces == 0))
            throw new InvalidOperationException("Processed Revit energy geometry evidence is empty or incomplete.");

        var excludedOriginalIds = new HashSet<long>();
        bool nativeExportable = false;
        foreach (JsonElement space in root.GetProperty("spaces").EnumerateArray())
        {
            string provenance = Text(space, "provenance");
            if (provenance is not ("PREEXISTING_UNTOUCHED" or "REVEX_CREATED"))
                throw new InvalidOperationException("Processed Revit energy geometry evidence contains a Space with unknown provenance.");
            bool exportable = space.TryGetProperty("exportable", out JsonElement exportableValue) &&
                              exportableValue.ValueKind == JsonValueKind.True;
            nativeExportable |= exportable;
            if (!exportable && provenance == "PREEXISTING_UNTOUCHED" &&
                space.TryGetProperty("id", out JsonElement idValue) && idValue.TryGetInt64(out long id))
                excludedOriginalIds.Add(id);
        }

        var repairedOriginalIds = new HashSet<long>();
        if (root.TryGetProperty("processedSpaces", out JsonElement processedRows) &&
            processedRows.ValueKind == JsonValueKind.Array)
        {
            var processedIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonElement row in processedRows.EnumerateArray())
            {
                string id = Text(row, "id");
                string provenance = Text(row, "provenance");
                string processedCoordinateSystem = Text(row, "coordinateSystem");
                string geometryMode = Text(row, "geometryMode");
                if (string.IsNullOrWhiteSpace(id) || !processedIds.Add(id) ||
                    provenance != "ROOM_DERIVED_ISOLATED_FROM_PREEXISTING_INVALID_SPACE" ||
                    processedCoordinateSystem != "REVIT_HOST_INTERNAL" ||
                    geometryMode != "ROOM_BOUNDARY_STORY_BOUNDED_2_5D")
                    throw new InvalidOperationException("Room-derived processed geometry has an invalid identity/provenance contract.");
                long sourceId = -1;
                double height = 0.0, area = 0.0, volume = 0.0;
                bool numeric = row.TryGetProperty("invalidOriginalSpaceId", out JsonElement originalId) && originalId.TryGetInt64(out sourceId) && sourceId >= 0 &&
                               row.TryGetProperty("heightFt", out JsonElement heightValue) && heightValue.TryGetDouble(out height) && height > 0.25 && height <= 20.0 / 0.3048 &&
                               row.TryGetProperty("areaFt2", out JsonElement areaValue) && areaValue.TryGetDouble(out area) && area > 0.0 &&
                               row.TryGetProperty("volumeFt3", out JsonElement volumeValue) && volumeValue.TryGetDouble(out volume) && volume > 0.0 &&
                               row.TryGetProperty("outerLoopFt", out JsonElement loop) && loop.ValueKind == JsonValueKind.Array && loop.GetArrayLength() >= 3;
                if (!numeric)
                    throw new InvalidOperationException("Room-derived processed geometry has invalid bounded geometry evidence.");
                repairedOriginalIds.Add(sourceId);
            }
        }
        if (!excludedOriginalIds.IsSubsetOf(repairedOriginalIds))
            throw new InvalidOperationException("An excluded invalid original Space has no bounded Room-derived processed representation.");
        if (!nativeExportable && processedSpaces == 0)
            throw new InvalidOperationException("Processed Revit energy geometry has no exportable native or Room-derived Space.");

        RevexDiagnostics.Dependency("ENERGY-SYNC", "Processed Revit energy geometry graph", true,
            $"levels={levels}; rooms={rooms}; nativeSpaces={spaces}; processedRoomSpaces={processedSpaces}; physicalSurfaces={physicalSurfaces}; analyticalSurfaces={analyticalSurfaces}; {path}");
        return new GeometryEvidenceMetadata(
            schema, authority, gbxmlSha, levels, rooms, spaces + processedSpaces,
            physicalSurfaces, physicalOpenings, analyticalSurfaces, analyticalOpenings);
    }

    private static void ValidateStructuredScheduleEvidence(string runFolder)
    {
        string path = Path.Combine(runFolder, StructuredScheduleEvidenceName);
        if (!File.Exists(path))
            throw new InvalidOperationException("Native Revit schedule evidence was not exported with the current gbXML run. Engineering Sync was not published.");

        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement root = document.RootElement;
        string schema = root.TryGetProperty("schema", out JsonElement schemaValue) ? schemaValue.GetString() ?? "" : "";
        string authority = root.TryGetProperty("authority", out JsonElement authorityValue) ? authorityValue.GetString() ?? "" : "";
        if (!string.Equals(schema, "liber.revex.engineering-schedule-evidence.v1", StringComparison.Ordinal) ||
            !string.Equals(authority, "active-revit-document-native-schedules", StringComparison.Ordinal))
            throw new InvalidOperationException("Native Revit schedule evidence has an incompatible schema or authority. Engineering Sync was not published.");

        int scheduleCount = root.TryGetProperty("scheduleCount", out JsonElement scheduleCountValue) && scheduleCountValue.TryGetInt32(out int schedules) ? schedules : 0;
        int capturedCount = root.TryGetProperty("capturedScheduleCount", out JsonElement capturedCountValue) && capturedCountValue.TryGetInt32(out int captured) ? captured : 0;
        int failedCount = root.TryGetProperty("failedScheduleCount", out JsonElement failedCountValue) && failedCountValue.TryGetInt32(out int failed) ? failed : 0;
        if (capturedCount + failedCount != scheduleCount)
            throw new InvalidOperationException("Native Revit schedule evidence counts are internally inconsistent. Engineering Sync was not published.");
        if (failedCount > 0)
            RevexDiagnostics.Warn("ENERGY-SCHEDULES", $"Current native schedule snapshot contains {failedCount} unreadable schedule(s); the failures are preserved in immutable evidence and downstream structured facts remain conflict/missing-safe.");
        RevexDiagnostics.Dependency("ENERGY-SYNC", "Native Revit schedule snapshot", true,
            $"schedules={scheduleCount}; captured={capturedCount}; failed={failedCount}; {path}");
    }

    private static void ValidateEnergyPageEvidence(string runFolder, RevexProjectBinding binding)
    {
        string identityPath = Path.Combine(runFolder, "REVIT-PROJECT-IDENTITY.json");
        string indexPath = Path.Combine(runFolder, "REVIT-PAGE-EVIDENCE.json");
        string pageFolder = Path.Combine(runFolder, "REVIT-PAGES");
        if (!File.Exists(identityPath))
            throw new InvalidOperationException("Active-document project identity evidence was not exported. Energy Sync was not published.");
        if (!File.Exists(indexPath) || !Directory.Exists(pageFolder))
            throw new InvalidOperationException("Immutable Revit T/Z/EN page evidence was not exported. Energy Sync was not published.");

        using (JsonDocument identity = JsonDocument.Parse(File.ReadAllText(identityPath)))
        {
            JsonElement root = identity.RootElement;
            string digest = root.TryGetProperty("digest", out JsonElement camel) ? camel.GetString() ?? ""
                : root.TryGetProperty("Digest", out JsonElement pascal) ? pascal.GetString() ?? "" : "";
            string authority = root.TryGetProperty("authority", out JsonElement authorityValue) ? authorityValue.GetString() ?? "" : "";
            if (!string.Equals(authority, "active-revit-document-t-z-title-evidence", StringComparison.Ordinal) ||
                !string.Equals(digest, binding.IdentityEvidenceDigest, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Active-document identity evidence does not match the exact project binding used for this Energy Sync.");
        }

        using JsonDocument index = JsonDocument.Parse(File.ReadAllText(indexPath));
        if (!index.RootElement.TryGetProperty("pages", out JsonElement pages) || pages.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("Revit page evidence index has no immutable page list.");
        bool hasIdentityPage = false;
        bool hasEnergyPage = false;
        foreach (JsonElement page in pages.EnumerateArray())
        {
            string discipline = page.TryGetProperty("discipline", out JsonElement disciplineValue) ? disciplineValue.GetString() ?? "" : "";
            string file = page.TryGetProperty("file", out JsonElement fileValue) ? Path.GetFileName(fileValue.GetString() ?? "") : "";
            if (file.Length == 0 || !File.Exists(Path.Combine(pageFolder, file)))
                throw new InvalidOperationException("Revit page evidence index points to a missing immutable PDF: " + file);
            hasIdentityPage |= discipline.Equals("T", StringComparison.OrdinalIgnoreCase) || discipline.Equals("Z", StringComparison.OrdinalIgnoreCase);
            hasEnergyPage |= discipline.Equals("EN", StringComparison.OrdinalIgnoreCase);
        }
        if (!hasIdentityPage || !hasEnergyPage)
            throw new InvalidOperationException("Energy Sync requires at least one active-document T/Z identity page and one EN technical-facts page. Missing evidence was not guessed or taken from another project.");
    }

    private static IReadOnlyDictionary<string, double> ValidatePublicationIntegrity(GbxmlEngineeringOutput source)
    {
        if (string.IsNullOrWhiteSpace(source.ReportPath) || !File.Exists(source.ReportPath))
            throw new InvalidOperationException("The publication-integrity report is missing.");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(source.ReportPath));
        JsonElement root = document.RootElement;
        if (!root.TryGetProperty("preservation_gate", out JsonElement gate) || gate.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("The gbXML report has no final publication-integrity gate.");
        double minimum = ReadRatio(gate, "minimum");
        double target = ReadRatio(gate, "target");
        bool thresholdMet = gate.TryGetProperty("publication_threshold_met", out JsonElement met) && met.ValueKind == JsonValueKind.True;
        var ratios = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
        {
            ["overall"] = ReadRatio(gate, "overall"),
            ["spatial"] = ReadRatio(gate, "spatial"),
            ["physical"] = ReadRatio(gate, "physical"),
            ["analyticalSurfaces"] = ReadRatio(gate, "analytical_surfaces"),
            ["physicalOpeningSources"] = ReadRatio(gate, "physical_opening_sources")
        };
        if (root.TryGetProperty("preservation_gate_preexport", out JsonElement preexport) && preexport.ValueKind == JsonValueKind.Object)
            ratios["roomSources"] = ReadRatio(preexport, "room_preservation");
        else
            ratios["roomSources"] = 0.0;
        if (minimum < PublicationMinimum || target < QualityTarget || !thresholdMet || ratios.Values.Any(value => value < PublicationMinimum))
            throw new InvalidOperationException("Energy Sync publication requires at least 80% integrity in every required Revit evidence domain; anything below 80% is preserved for repair and is not published. Results below 95% are published with a Companion quality warning.");
        return ratios;
    }

    private static double ReadRatio(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out double ratio))
            return 0.0;
        return ratio;
    }
}
