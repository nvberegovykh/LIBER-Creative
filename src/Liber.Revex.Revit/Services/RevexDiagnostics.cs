using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// One diagnostic spine for the Revit UI, ExternalEvent/Dynamo work and the
/// Companion-side worker. Human-readable lines feed the REVEX console while a
/// lossless JSONL sibling preserves correlation, dependency and exception data.
/// Diagnostics are deliberately fail-safe and can never destabilize REVEX.
/// </summary>
public static class RevexDiagnostics
{
    private sealed class WorkflowContext
    {
        public WorkflowContext(string correlationId, string operation, string initiator)
        {
            CorrelationId = correlationId;
            Operation = operation;
            Initiator = initiator;
        }

        public string CorrelationId { get; }
        public string Operation { get; }
        public string Initiator { get; }
        public string? LastStage { get; set; }
    }

    private sealed record ExceptionDetail(
        int Depth, string Type, string Message, int HResult, string? Source, string? StackTrace);

    private static readonly object Gate = new();
    private static readonly List<string> Buffer = new();
    private static readonly AsyncLocal<WorkflowContext?> CurrentWorkflow = new();
    private const int MaxBufferedLines = 5000;
    private static readonly string SessionId = $"{DateTime.Now:yyyyMMdd-HHmmss}-{Environment.ProcessId}";
    private static int GlobalHandlersInstalled;

    public static event Action<string>? Line;

    public static string? CurrentCorrelationId => CurrentWorkflow.Value?.CorrelationId;
    public static string? CurrentOperation => CurrentWorkflow.Value?.Operation;
    public static string? CurrentInitiator => CurrentWorkflow.Value?.Initiator;

    public static string SessionLogPath
    {
        get
        {
            AppPaths.Ensure();
            return Path.Combine(AppPaths.Logs, $"revex-session-{SessionId}.log");
        }
    }

    public static string SessionJsonlPath
    {
        get
        {
            AppPaths.Ensure();
            return Path.Combine(AppPaths.Logs, $"revex-session-{SessionId}.jsonl");
        }
    }

    public static string NewCorrelationId(string prefix = "run")
    {
        string safe = new(prefix.Where(char.IsLetterOrDigit).Take(18).ToArray());
        if (safe.Length == 0) safe = "run";
        return $"{safe.ToLowerInvariant()}-{DateTime.UtcNow:yyyyMMddTHHmmssfffZ}-{Guid.NewGuid():N}"[..(safe.Length + 1 + 20 + 8)];
    }

    public static WorkflowScope BeginWorkflow(string operation, string initiator, string? correlationId = null) =>
        new(operation, initiator, correlationId);

    public static void InstallGlobalHandlers()
    {
        if (Interlocked.Exchange(ref GlobalHandlersInstalled, 1) != 0) return;
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Error("UNHANDLED", "AppDomain unhandled exception.", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
            Error("TASK", "Unobserved task exception.", e.Exception);
        try
        {
            if (System.Windows.Application.Current != null)
                System.Windows.Application.Current.DispatcherUnhandledException += (_, e) =>
                    Error("DISPATCHER", "WPF dispatcher exception.", e.Exception);
        }
        catch { }
    }

    public static void LogEnvironmentSnapshot()
    {
        try
        {
            Info("ENV", $"session={SessionId}; process={Environment.ProcessId}; processPath={Environment.ProcessPath ?? "<unknown>"}; " +
                $"os={RuntimeInformation.OSDescription}; arch={RuntimeInformation.ProcessArchitecture}; framework={RuntimeInformation.FrameworkDescription}; " +
                $"64bit={Environment.Is64BitProcess}; assembly={typeof(RevexDiagnostics).Assembly.Location}; installRoot={AppPaths.InstallRoot}; " +
                $"dataRoot={AppPaths.Root}; textLog={SessionLogPath}; jsonlLog={SessionJsonlPath}");
        }
        catch (Exception ex)
        {
            Warn("ENV", "Environment snapshot was incomplete: " + ex.Message);
        }
    }

    public static void Info(string source, string message) => Write("INFO", source, message, null, null);
    public static void Warn(string source, string message) => Write("WARN", source, message, null, null);
    public static void Error(string source, string message, Exception? exception = null) => Write("ERROR", source, message, exception, null);

    public static void Stage(string source, string stage, string status, string message)
    {
        string level = status.Contains("FAIL", StringComparison.OrdinalIgnoreCase) ||
                       status.Contains("BLOCK", StringComparison.OrdinalIgnoreCase) ? "ERROR" :
                       status.Contains("WARN", StringComparison.OrdinalIgnoreCase) ||
                       status.Contains("ABANDON", StringComparison.OrdinalIgnoreCase) ? "WARN" : "INFO";
        Write(level, source, $"status={status}; {message}", null, stage);
    }

    public static void Dependency(string source, string name, bool available, string detail, bool required = true)
    {
        string level = required && !available ? "ERROR" : !available ? "WARN" : "INFO";
        Write(level, source,
            $"dependency={name}; required={required}; available={available}; detail={detail}", null, "DEPENDENCY");
    }

    public static string Snapshot()
    {
        lock (Gate)
            return string.Join(Environment.NewLine, Buffer);
    }

    private static void Write(string level, string source, string message, Exception? exception, string? stage)
    {
        WorkflowContext? workflow = CurrentWorkflow.Value;
        if (workflow != null && !string.IsNullOrWhiteSpace(stage)) workflow.LastStage = stage;
        string? effectiveStage = string.IsNullOrWhiteSpace(stage) ? workflow?.LastStage : stage;
        string clean = Clean(message);
        string context = workflow == null
            ? $"[session={SessionId}]"
            : $"[run={workflow.CorrelationId}] [op={Clean(workflow.Operation)}] [by={Clean(workflow.Initiator)}]";
        string stageText = string.IsNullOrWhiteSpace(effectiveStage) ? string.Empty : $" [stage={Clean(effectiveStage)}]";
        string line = $"{DateTime.Now:HH:mm:ss.fff} [{level}] [{source}] {context}{stageText} {clean}";
        IReadOnlyList<ExceptionDetail> causes = ExceptionChain(exception);
        if (causes.Count > 0)
            line += " | cause=" + Clean(string.Join(" -> ", causes.Select(cause => cause.Type + ": " + cause.Message)));

        lock (Gate)
        {
            Buffer.Add(line);
            if (Buffer.Count > MaxBufferedLines)
                Buffer.RemoveRange(0, Buffer.Count - MaxBufferedLines);

            try
            {
                AppPaths.Ensure();
                File.AppendAllText(SessionLogPath, line + Environment.NewLine, Encoding.UTF8);
                if (exception != null)
                    File.AppendAllText(SessionLogPath, FormatExceptionText(exception), Encoding.UTF8);

                var structured = new
                {
                    at = DateTimeOffset.UtcNow,
                    sessionId = SessionId,
                    level,
                    source,
                    stage = effectiveStage,
                    message = clean,
                    correlationId = workflow?.CorrelationId,
                    operation = workflow?.Operation,
                    initiator = workflow?.Initiator,
                    processId = Environment.ProcessId,
                    threadId = Environment.CurrentManagedThreadId,
                    exceptions = causes
                };
                File.AppendAllText(SessionJsonlPath,
                    JsonSerializer.Serialize(structured) + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
                // Diagnostics must never destabilize REVEX.
            }
        }

        try { Line?.Invoke(line); } catch { }
    }

    private static string Clean(string? value) =>
        (value ?? string.Empty).Replace("\r", " ").Replace("\n", " ↵ ").Trim();

    private static IReadOnlyList<ExceptionDetail> ExceptionChain(Exception? exception)
    {
        var output = new List<ExceptionDetail>();
        Exception? current = exception;
        int depth = 0;
        while (current != null && depth++ < 16)
        {
            output.Add(new ExceptionDetail(
                depth - 1,
                current.GetType().FullName ?? current.GetType().Name,
                current.Message,
                current.HResult,
                current.Source,
                current.StackTrace));
            current = current.InnerException;
        }
        return output;
    }

    private static string FormatExceptionText(Exception exception)
    {
        var output = new StringBuilder();
        Exception? current = exception;
        int depth = 0;
        while (current != null && depth < 16)
        {
            output.AppendLine($"--- EXCEPTION[{depth}] {current.GetType().FullName} HResult=0x{current.HResult:X8} ---");
            output.AppendLine(current.Message);
            output.AppendLine(current.StackTrace ?? "<no stack trace>");
            current = current.InnerException;
            depth++;
        }
        return output.ToString();
    }

    public sealed class WorkflowScope : IDisposable
    {
        private readonly WorkflowContext? _parent;
        private readonly WorkflowContext _context;
        private readonly Stopwatch _elapsed = Stopwatch.StartNew();
        private bool _completed;
        private bool _disposed;

        internal WorkflowScope(string operation, string initiator, string? correlationId)
        {
            _parent = CurrentWorkflow.Value;
            _context = new WorkflowContext(
                string.IsNullOrWhiteSpace(correlationId) ? NewCorrelationId(operation) : correlationId.Trim(),
                string.IsNullOrWhiteSpace(operation) ? "UNKNOWN" : operation.Trim(),
                string.IsNullOrWhiteSpace(initiator) ? "UNKNOWN" : initiator.Trim());
            CurrentWorkflow.Value = _context;
            Stage("WORKFLOW", "BEGIN", "STARTED", "workflow entered");
        }

        public string CorrelationId => _context.CorrelationId;

        public void Complete(bool success, string message)
        {
            if (_completed || _disposed) return;
            _completed = true;
            Stage("WORKFLOW", "END", success ? "PASSED" : "FAILED",
                $"elapsedMs={_elapsed.ElapsedMilliseconds}; {message}");
        }

        public void Dispose()
        {
            if (_disposed) return;
            if (!_completed)
                Stage("WORKFLOW", "END", "ABANDONED",
                    $"elapsedMs={_elapsed.ElapsedMilliseconds}; scope exited without an explicit completion result");
            _disposed = true;
            CurrentWorkflow.Value = _parent;
        }
    }
}
