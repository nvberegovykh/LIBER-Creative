using System.IO;

namespace Liber.Revex.Revit.Services;

public static class AppPaths
{
    /// <summary>
    /// Physical folder containing Liber.Revex.Revit.dll. In a Revit add-in,
    /// AppContext.BaseDirectory points at Revit.exe, not at the add-in install folder.
    /// Every bundled REVEX asset must resolve from this assembly location.
    /// </summary>
    public static string InstallRoot
    {
        get
        {
            string? assemblyPath = typeof(AppPaths).Assembly.Location;
            string? folder = string.IsNullOrWhiteSpace(assemblyPath) ? null : Path.GetDirectoryName(assemblyPath);
            return !string.IsNullOrWhiteSpace(folder) ? folder : AppContext.BaseDirectory;
        }
    }

    public static string Root =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LIBER", "REVEX");

    public static string WebProfile => Path.Combine(Root, "WebView2");
    public static string Transfers => Path.Combine(Root, "Transfers");
    public static string Config => Path.Combine(Root, "Config");
    public static string Sync => Path.Combine(Root, "Sync");
    public static string SyncStaging => Path.Combine(Sync, "staging");
    public static string SyncRevisions => Path.Combine(Sync, "revisions");
    public static string Logs => Path.Combine(Root, "Logs");
    public static string Engineering => Path.Combine(Root, "Engineering");
    public static string EngineeringGbxmlRuns => Path.Combine(Engineering, "gbXML", "Runs");
    public static string EngineeringSync => Path.Combine(Engineering, "Sync");
    public static string EngineeringSyncStaging => Path.Combine(EngineeringSync, "staging");
    public static string EngineeringSyncRevisions => Path.Combine(EngineeringSync, "revisions");
    public static string EngineeringEnergyRuns => Path.Combine(Engineering, "Energy", "Runs");

    public static void Ensure()
    {
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(WebProfile);
        Directory.CreateDirectory(Transfers);
        Directory.CreateDirectory(Config);
        Directory.CreateDirectory(Sync);
        Directory.CreateDirectory(SyncStaging);
        Directory.CreateDirectory(SyncRevisions);
        Directory.CreateDirectory(Logs);
        Directory.CreateDirectory(Engineering);
        Directory.CreateDirectory(EngineeringGbxmlRuns);
        Directory.CreateDirectory(EngineeringSyncStaging);
        Directory.CreateDirectory(EngineeringSyncRevisions);
        Directory.CreateDirectory(EngineeringEnergyRuns);

        CopyDefaultConfigIfMissing("material-rules.json");
        CopyDefaultConfigIfMissing("settings.json");
    }

    public static string CreateSyncStaging()
    {
        Ensure();
        string folder = Path.Combine(SyncStaging, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        return folder;
    }

    public static string CommitSyncRevision(string stagingFolder, string revision)
    {
        Ensure();
        string safeRevision = string.Concat(revision.Select(c =>
            char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_'));
        string target = Path.Combine(SyncRevisions, safeRevision);
        if (Directory.Exists(target))
            target += "_" + Guid.NewGuid().ToString("N")[..8];
        Directory.Move(stagingFolder, target);
        return target;
    }

    public static string CreateEngineeringSyncStaging()
    {
        Ensure();
        string folder = Path.Combine(EngineeringSyncStaging, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        return folder;
    }

    public static string CommitEngineeringSyncRevision(string stagingFolder, string revision)
    {
        Ensure();
        string safeRevision = string.Concat(revision.Select(c =>
            char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_'));
        string target = Path.Combine(EngineeringSyncRevisions, safeRevision);
        if (Directory.Exists(target))
            target += "_" + Guid.NewGuid().ToString("N")[..8];
        Directory.Move(stagingFolder, target);
        return target;
    }

    private static void CopyDefaultConfigIfMissing(string fileName)
    {
        string target = Path.Combine(Config, fileName);
        if (File.Exists(target))
            return;

        string source = Path.Combine(InstallRoot, "Config", fileName);
        if (File.Exists(source))
            File.Copy(source, target);
    }
}
