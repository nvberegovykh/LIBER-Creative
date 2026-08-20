using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevitDataStorage = Autodesk.Revit.DB.ExtensibleStorage.DataStorage;

namespace Liber.Revex.Revit.Services;

internal sealed record FamilyMutationContext(
    string CommandId,
    string CorrelationId,
    string ProjectId,
    string BaseSourceRevision,
    string DocumentFingerprint,
    string Provider,
    string ProviderAssetName,
    string ProviderAssetSha256);

/// <summary>
/// Durable two-phase receipt lane for explicit cloud-to-Revit family mutations.
/// The local receipt is prepared before Revit commit. A per-command Extensible
/// Storage DataStorage witness is written in the same Revit transaction as the
/// mutation, so source sync can prove/reconstruct a committed mutation even when
/// the local folder was lost. Only cloud publication acknowledgement retires it.
/// </summary>
internal static class FamilyMutationReceiptService
{
    private const string ReceiptSchemaV2 = "liber.revex.family-mutation-receipt.v2";
    private const string LegacyReceiptSchemaV1 = "liber.revex.family-mutation-receipt.v1";
    private const string IntentReserved = "INTENT_RESERVED";
    private const string PreparedAwaitingCommit = "PREPARED_AWAITING_REVIT_COMMIT";
    private const string CompletedPendingSync = "COMPLETED_PENDING_SOURCE_SYNC";
    private const string AttachedToSource = "ATTACHED_TO_IMMUTABLE_SOURCE_REVISION";
    private const string RecoveryPending = "RECOVERY_PENDING";

    // Fixed for the lifetime of this v2 schema. Never regenerate this GUID.
    private static readonly Guid WitnessSchemaGuid = new("5f9629a0-dbd1-46ea-bf5c-a6bbcfb44761");
    private const string WitnessSchemaName = "LIBER_REVEX_FamilyMutationWitnessV2";
    private const string WitnessVendorId = "LIBR";
    private const string FieldCommandId = "CommandId";
    private const string FieldProjectId = "ProjectId";
    private const string FieldDocumentFingerprint = "DocumentFingerprint";
    private const string FieldOperation = "Operation";
    private const string FieldResultUniqueId = "ResultUniqueId";
    private const string FieldIdentityDigest = "IdentityDigest";
    private const string FieldPreparedDigest = "PreparedDigest";
    private const string FieldReceiptJson = "ReceiptJson";
    private const string FieldPayloadDigest = "PayloadDigest";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static readonly JsonSerializerOptions CompactJsonOptions = new()
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    internal sealed record PreparedReceipt(
        string CommandId,
        string ProjectId,
        string DocumentFingerprint,
        string Operation,
        string ResultUniqueId,
        string IdentityDigest,
        string PreparedDigest,
        string ReceiptJson);

    internal sealed record RecoveredMutation(
        FamilyPlacementService.PlacementResult Result,
        string ReceiptStatus,
        string? Message);

    private sealed record ReceiptResult(
        long ElementId,
        string UniqueId,
        string Family,
        string Type,
        string Level,
        string HostUniqueId,
        double[] BboxMin,
        double[] BboxMax,
        string PlacementType);

    private sealed record MutationWitness(
        string DataStorageUniqueId,
        string CommandId,
        string ProjectId,
        string DocumentFingerprint,
        string Operation,
        string ResultUniqueId,
        string IdentityDigest,
        string PreparedDigest,
        string ReceiptJson,
        string PayloadDigest);

    internal static RecoveredMutation? RecoverBeforeMutation(
        Document doc,
        FamilyMutationContext context,
        string operation,
        object request)
    {
        ValidateContext(context);
        ValidateOperation(operation);
        string incomingIdentityDigest = MutationIdentityDigest(context, operation, request);
        string pending = PendingPath(context.DocumentFingerprint, context.CommandId);
        string acknowledged = AcknowledgedPath(context.DocumentFingerprint, context.CommandId);
        MutationWitness? witness = ExactWitness(doc, context, incomingIdentityDigest);

        if (File.Exists(acknowledged))
        {
            JsonElement acknowledgedRoot = ReadRoot(acknowledged);
            ValidateReceiptBinding(acknowledgedRoot, context, requireAttached: true);
            ValidateAcknowledgementDigest(acknowledgedRoot);
            string acknowledgedIdentity = Read(acknowledgedRoot, "identityDigest");
            if (acknowledgedIdentity.Length == 0 && string.Equals(Read(acknowledgedRoot, "schema"), LegacyReceiptSchemaV1, StringComparison.Ordinal))
                acknowledgedIdentity = MutationIdentityDigest(acknowledgedRoot);
            if (!string.Equals(acknowledgedIdentity, incomingIdentityDigest, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("This family mutation command is an altered replay of an acknowledged command; execution was blocked.");
            return new RecoveredMutation(PlacementResultFromReceipt(acknowledgedRoot), AttachedToSource, null);
        }

        if (File.Exists(pending))
        {
            JsonElement root = ReadRoot(pending);
            string schema = Read(root, "schema");
            string status = Read(root, "status");
            ValidateReceiptBinding(root, context, requireAttached: false);

            if (string.Equals(schema, LegacyReceiptSchemaV1, StringComparison.Ordinal))
            {
                if (string.Equals(status, CompletedPendingSync, StringComparison.Ordinal))
                {
                    if (!string.Equals(MutationIdentityDigest(root), incomingIdentityDigest, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("This family mutation command is an altered replay of a completed legacy command; execution was blocked.");
                    return new RecoveredMutation(PlacementResultFromReceipt(root), CompletedPendingSync, null);
                }
                throw new InvalidOperationException(
                    "This legacy family mutation contains an ambiguous v1 intent. REVEX will not retry it automatically because the prior Revit commit cannot be proven; reconcile it manually and use a new command.");
            }
            if (!string.Equals(schema, ReceiptSchemaV2, StringComparison.Ordinal))
                throw new InvalidOperationException("The existing family mutation receipt uses an unsupported schema; duplicate execution was blocked.");
            if (!string.Equals(Read(root, "identityDigest"), incomingIdentityDigest, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("This family mutation command is an altered replay with a different operation/target/request; execution was blocked.");

            if (witness != null)
                return RecoverWitness(witness, pending);

            if (string.Equals(status, IntentReserved, StringComparison.Ordinal) ||
                string.Equals(status, PreparedAwaitingCommit, StringComparison.Ordinal) ||
                string.Equals(status, CompletedPendingSync, StringComparison.Ordinal))
            {
                // A later ExternalEvent cannot overlap the old transaction. In v2,
                // no same-transaction witness means rolled back, undone or deleted.
                ArchivePending(pending, "NO_COMMITTED_REVIT_WITNESS");
                return null;
            }
            throw new InvalidOperationException("The existing family mutation receipt is not retryable; duplicate execution was blocked.");
        }

        if (witness != null)
            return RecoverWitness(witness, pending);
        return null;
    }

    private static RecoveredMutation RecoverWitness(MutationWitness witness, string pendingPath)
    {
        // ExactWitness has already authenticated the model witness and request
        // identity. Build the authoritative result before local promotion so a
        // disk/cache failure cannot be misreported as an uncommitted mutation.
        JsonElement authoritative = ValidatedWitnessReceipt(witness);
        FamilyPlacementService.PlacementResult result = PlacementResultFromReceipt(authoritative);
        try
        {
            JsonElement recovered = PromoteWitnessReceipt(witness, pendingPath);
            return new RecoveredMutation(PlacementResultFromReceipt(recovered), CompletedPendingSync, null);
        }
        catch (Exception ex)
        {
            return new RecoveredMutation(
                result,
                RecoveryPending,
                "The family is already committed in Revit, but its local receipt still needs recovery from the model witness. " + ex.Message);
        }
    }

    internal static void Reserve(FamilyMutationContext context, string operation, object request)
    {
        ValidateContext(context);
        ValidateOperation(operation);
        string identityDigest = MutationIdentityDigest(context, operation, request);
        string pending = PendingPath(context.DocumentFingerprint, context.CommandId);
        string acknowledged = AcknowledgedPath(context.DocumentFingerprint, context.CommandId);
        if (File.Exists(pending) || File.Exists(acknowledged)) throw DuplicateCommand();
        Directory.CreateDirectory(Path.GetDirectoryName(pending)!);
        var payload = new
        {
            schema = ReceiptSchemaV2,
            status = IntentReserved,
            operation,
            context,
            request,
            reservedAt = DateTime.UtcNow,
            preparedAt = (DateTime?)null,
            identityDigest,
            preparedDigest = (string?)null,
            completedAt = (DateTime?)null,
            result = (object?)null,
            attachedSourceRevision = (string?)null
        };
        using FileStream stream = new(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        JsonSerializer.Serialize(stream, payload, JsonOptions);
        stream.Flush(flushToDisk: true);
    }

    internal static PreparedReceipt PrepareForCommit(
        FamilyMutationContext context,
        string operation,
        object request,
        FamilyPlacementService.PlacementResult result)
    {
        ValidateContext(context);
        ValidateOperation(operation);
        string path = PendingPath(context.DocumentFingerprint, context.CommandId);
        if (!File.Exists(path))
            throw new InvalidOperationException("Family mutation intent disappeared before its Revit commit was prepared.");
        JsonElement reserved = ReadRoot(path);
        ValidateReceiptBinding(reserved, context, requireAttached: false);
        string identityDigest = MutationIdentityDigest(context, operation, request);
        if (!string.Equals(Read(reserved, "schema"), ReceiptSchemaV2, StringComparison.Ordinal) ||
            !string.Equals(Read(reserved, "status"), IntentReserved, StringComparison.Ordinal) ||
            !string.Equals(Read(reserved, "operation"), operation, StringComparison.Ordinal) ||
            !string.Equals(Read(reserved, "identityDigest"), identityDigest, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Family mutation intent is not in the exact v2 reservable state.");

        DateTime preparedAt = DateTime.UtcNow;
        DateTime? reservedAt = ReadDate(reserved, "reservedAt");
        ReceiptResult receiptResult = ResultPayload(result);
        string preparedDigest = Sha256Hex(JsonSerializer.Serialize(new
        {
            operation,
            context,
            request,
            result = receiptResult
        }, CompactJsonOptions));
        var prepared = new
        {
            schema = ReceiptSchemaV2,
            status = PreparedAwaitingCommit,
            operation,
            context,
            request,
            reservedAt,
            preparedAt,
            identityDigest,
            preparedDigest,
            completedAt = (DateTime?)null,
            result = receiptResult,
            attachedSourceRevision = (string?)null
        };
        string receiptJson = JsonSerializer.Serialize(prepared, CompactJsonOptions);
        WriteAtomic(path, prepared);
        return new PreparedReceipt(
            context.CommandId,
            context.ProjectId,
            context.DocumentFingerprint,
            operation,
            result.UniqueId,
            identityDigest,
            preparedDigest,
            receiptJson);
    }

    internal static void RecordCommittedWitness(Document doc, PreparedReceipt prepared)
    {
        if (!doc.IsModifiable)
            throw new InvalidOperationException("The Revit family mutation witness must be recorded inside the same open model transaction.");
        if (string.IsNullOrWhiteSpace(prepared.CommandId) || string.IsNullOrWhiteSpace(prepared.ResultUniqueId) ||
            string.IsNullOrWhiteSpace(prepared.PreparedDigest) || string.IsNullOrWhiteSpace(prepared.ReceiptJson))
            throw new InvalidOperationException("The prepared family mutation witness is incomplete.");
        string payloadDigest = Sha256Hex(prepared.ReceiptJson);
        _ = ValidatedWitnessReceipt(new MutationWitness(
            "",
            prepared.CommandId,
            prepared.ProjectId,
            prepared.DocumentFingerprint,
            prepared.Operation,
            prepared.ResultUniqueId,
            prepared.IdentityDigest,
            prepared.PreparedDigest,
            prepared.ReceiptJson,
            payloadDigest));
        if (ReadWitnesses(doc).Any(row =>
                string.Equals(row.CommandId, prepared.CommandId, StringComparison.Ordinal) &&
                string.Equals(row.DocumentFingerprint, prepared.DocumentFingerprint, StringComparison.Ordinal)))
            throw DuplicateCommand();

        Autodesk.Revit.DB.ExtensibleStorage.Schema schema = GetOrCreateWitnessSchema();
        RevitDataStorage storage = RevitDataStorage.Create(doc);
        using var entity = new Entity(schema);
        SetString(entity, schema, FieldCommandId, prepared.CommandId);
        SetString(entity, schema, FieldProjectId, prepared.ProjectId);
        SetString(entity, schema, FieldDocumentFingerprint, prepared.DocumentFingerprint);
        SetString(entity, schema, FieldOperation, prepared.Operation);
        SetString(entity, schema, FieldResultUniqueId, prepared.ResultUniqueId);
        SetString(entity, schema, FieldIdentityDigest, prepared.IdentityDigest);
        SetString(entity, schema, FieldPreparedDigest, prepared.PreparedDigest);
        SetString(entity, schema, FieldReceiptJson, prepared.ReceiptJson);
        SetString(entity, schema, FieldPayloadDigest, payloadDigest);
        storage.SetEntity(entity);
    }

    internal static void Complete(
        Document doc,
        FamilyMutationContext context,
        string operation,
        object request,
        FamilyPlacementService.PlacementResult result)
    {
        string identityDigest = MutationIdentityDigest(context, operation, request);
        MutationWitness witness = ExactWitness(doc, context, identityDigest)
            ?? throw new InvalidOperationException("The committed Revit family mutation witness is missing.");
        if (!string.Equals(witness.Operation, operation, StringComparison.Ordinal) ||
            !string.Equals(witness.ResultUniqueId, result.UniqueId, StringComparison.Ordinal))
            throw new InvalidOperationException("The committed Revit family mutation witness does not match the returned model result.");
        _ = PromoteWitnessReceipt(witness, PendingPath(context.DocumentFingerprint, context.CommandId));
    }

    internal static void Cancel(FamilyMutationContext context)
    {
        string path = PendingPath(context.DocumentFingerprint, context.CommandId);
        try
        {
            if (!File.Exists(path)) return;
            JsonElement root = ReadRoot(path);
            if (string.Equals(Read(root, "schema"), ReceiptSchemaV2, StringComparison.Ordinal) &&
                (string.Equals(Read(root, "status"), IntentReserved, StringComparison.Ordinal) ||
                 string.Equals(Read(root, "status"), PreparedAwaitingCommit, StringComparison.Ordinal)))
                File.Delete(path);
        }
        catch { }
    }

    internal static IReadOnlyList<JsonElement> CompletedForSync(
        Document doc,
        string projectId,
        string documentFingerprint)
    {
        var witnesses = new Dictionary<string, MutationWitness>(StringComparer.Ordinal);
        var acknowledgedCommands = new HashSet<string>(StringComparer.Ordinal);
        foreach (MutationWitness witness in ReadWitnesses(doc).Where(row =>
                     string.Equals(row.ProjectId, projectId, StringComparison.Ordinal) &&
                     string.Equals(row.DocumentFingerprint, documentFingerprint, StringComparison.Ordinal)))
        {
            _ = ValidatedWitnessReceipt(witness);
            if (witnesses.TryGetValue(witness.CommandId, out MutationWitness? prior) &&
                !string.Equals(prior.PayloadDigest, witness.PayloadDigest, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"Family mutation {witness.CommandId} has conflicting Revit witnesses; immutable source sync was blocked.");
            witnesses[witness.CommandId] = witness;
        }

        // Model evidence is authoritative and reconstructs a deleted local folder.
        foreach (MutationWitness witness in witnesses.Values)
        {
            string acknowledged = AcknowledgedPath(documentFingerprint, witness.CommandId);
            if (File.Exists(acknowledged))
            {
                JsonElement acknowledgedRoot = ReadRoot(acknowledged);
                ValidateAcknowledgementDigest(acknowledgedRoot);
                if (!acknowledgedRoot.TryGetProperty("context", out JsonElement acknowledgedContext) ||
                    !string.Equals(Read(acknowledgedRoot, "status"), AttachedToSource, StringComparison.Ordinal) ||
                    !string.Equals(Read(acknowledgedContext, "commandId"), witness.CommandId, StringComparison.Ordinal) ||
                    !string.Equals(Read(acknowledgedContext, "projectId"), projectId, StringComparison.Ordinal) ||
                    !string.Equals(Read(acknowledgedContext, "documentFingerprint"), documentFingerprint, StringComparison.Ordinal) ||
                    !string.Equals(ReceiptIdentityDigest(acknowledgedRoot), ReceiptIdentityDigest(ValidatedWitnessReceipt(witness)), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException($"Acknowledged family mutation {witness.CommandId} conflicts with its Revit witness; immutable source sync was blocked.");
                string pending = PendingPath(documentFingerprint, witness.CommandId);
                if (File.Exists(pending))
                {
                    JsonElement pendingRoot = ReadRoot(pending);
                    if (!string.Equals(ReceiptIdentityDigest(acknowledgedRoot), ReceiptIdentityDigest(pendingRoot), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException($"Family mutation {witness.CommandId} has conflicting acknowledged and pending receipts; immutable source sync was blocked.");
                    File.Delete(pending);
                }
                acknowledgedCommands.Add(witness.CommandId);
                continue;
            }
            _ = PromoteWitnessReceipt(witness, PendingPath(documentFingerprint, witness.CommandId));
        }

        string folder = PendingFolder(documentFingerprint);
        if (!Directory.Exists(folder)) return Array.Empty<JsonElement>();
        var rows = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (string path in Directory.GetFiles(folder, "*.json", SearchOption.TopDirectoryOnly)
                     .OrderBy(row => row, StringComparer.OrdinalIgnoreCase).ToArray())
        {
            JsonElement root = ReadRoot(path);
            string schema = Read(root, "schema");
            string status = Read(root, "status");
            if (!root.TryGetProperty("context", out JsonElement context))
                throw new InvalidOperationException($"Family mutation receipt {Path.GetFileName(path)} has no command context; immutable source sync was blocked.");
            if (!string.Equals(Read(context, "projectId"), projectId, StringComparison.Ordinal) ||
                !string.Equals(Read(context, "documentFingerprint"), documentFingerprint, StringComparison.Ordinal))
                throw new InvalidOperationException($"Family mutation receipt {Path.GetFileName(path)} is stored under the wrong document folder; immutable source sync was blocked.");
            string commandId = Read(context, "commandId");
            if (acknowledgedCommands.Contains(commandId)) continue;
            if (string.Equals(schema, LegacyReceiptSchemaV1, StringComparison.Ordinal))
            {
                if (!string.Equals(status, CompletedPendingSync, StringComparison.Ordinal))
                    throw new InvalidOperationException($"Legacy family mutation {commandId} has an ambiguous v1 intent; immutable source sync was blocked pending manual reconciliation.");
                rows[commandId] = root.Clone();
                continue;
            }
            if (!string.Equals(schema, ReceiptSchemaV2, StringComparison.Ordinal))
                throw new InvalidOperationException($"Family mutation {commandId} uses an unsupported receipt schema; immutable source sync was blocked.");
            if (!witnesses.TryGetValue(commandId, out MutationWitness? witness))
            {
                ArchivePending(path, "NO_COMMITTED_REVIT_WITNESS_DURING_SYNC");
                continue;
            }
            root = PromoteWitnessReceipt(witness, path);
            if (string.Equals(Read(root, "status"), CompletedPendingSync, StringComparison.Ordinal)) rows[commandId] = root.Clone();
        }
        return rows.Values.OrderBy(row => Read(row.GetProperty("context"), "commandId"), StringComparer.Ordinal).ToArray();
    }

    internal static void AssertTransformOrigin(Document doc, FamilyMutationContext context, string uniqueId)
    {
        if (string.IsNullOrWhiteSpace(uniqueId)) return;
        string expected = uniqueId.Trim();
        var receipts = new List<JsonElement>();
        foreach (string folder in new[]
                 {
                     PendingFolder(context.DocumentFingerprint),
                     Path.Combine(Root, "acknowledged", SafeKey(context.DocumentFingerprint))
                 }.Where(Directory.Exists))
        {
            foreach (string path in Directory.GetFiles(folder, "*.json", SearchOption.TopDirectoryOnly))
                try { receipts.Add(ReadRoot(path)); } catch { }
        }
        foreach (MutationWitness witness in ReadWitnesses(doc).Where(row =>
                     string.Equals(row.ProjectId, context.ProjectId, StringComparison.Ordinal) &&
                     string.Equals(row.DocumentFingerprint, context.DocumentFingerprint, StringComparison.Ordinal)))
            try { receipts.Add(ValidatedWitnessReceipt(witness)); } catch { }

        foreach (JsonElement root in receipts)
        {
            string schema = Read(root, "schema");
            if ((!string.Equals(schema, ReceiptSchemaV2, StringComparison.Ordinal) &&
                 !string.Equals(schema, LegacyReceiptSchemaV1, StringComparison.Ordinal)) ||
                !string.Equals(Read(root, "operation"), "place", StringComparison.Ordinal) ||
                !root.TryGetProperty("context", out JsonElement origin) ||
                !root.TryGetProperty("result", out JsonElement result))
                continue;
            if (string.Equals(Read(origin, "projectId"), context.ProjectId, StringComparison.Ordinal) &&
                string.Equals(Read(origin, "documentFingerprint"), context.DocumentFingerprint, StringComparison.Ordinal) &&
                string.Equals(Read(origin, "baseSourceRevision"), context.BaseSourceRevision, StringComparison.Ordinal) &&
                string.Equals(Read(origin, "correlationId"), context.CorrelationId, StringComparison.Ordinal) &&
                string.Equals(Read(result, "uniqueId"), expected, StringComparison.Ordinal))
                return;
        }
        throw new InvalidOperationException("The requested family UniqueId is not linked to the bound REVEX placement receipt. Select/insert it again before adjusting it.");
    }

    internal static void Acknowledge(
        string projectId,
        string documentFingerprint,
        string attachedSourceRevision,
        IEnumerable<string> commandIds)
    {
        if (string.IsNullOrWhiteSpace(projectId) || string.IsNullOrWhiteSpace(documentFingerprint) ||
            string.IsNullOrWhiteSpace(attachedSourceRevision) || !attachedSourceRevision.StartsWith("rev_", StringComparison.Ordinal))
            throw new InvalidOperationException("Family mutation acknowledgement is missing its exact project/document/source-revision binding.");
        foreach (string raw in commandIds.Distinct(StringComparer.Ordinal))
        {
            string commandId = SafeKey(raw);
            string pending = PendingPath(documentFingerprint, commandId);
            string acknowledged = AcknowledgedPath(documentFingerprint, commandId);
            if (File.Exists(acknowledged))
            {
                JsonElement existing = ReadRoot(acknowledged);
                ValidateAcknowledged(existing, projectId, documentFingerprint, attachedSourceRevision, commandId);
                if (File.Exists(pending))
                {
                    JsonElement pendingRoot = ReadRoot(pending);
                    if (!string.Equals(ReceiptIdentityDigest(existing), ReceiptIdentityDigest(pendingRoot), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException($"Family mutation receipt {commandId} has conflicting pending and acknowledged copies.");
                    File.Delete(pending);
                }
                continue;
            }
            if (!File.Exists(pending))
                throw new InvalidOperationException($"Family mutation receipt {commandId} is not pending acknowledgement.");
            JsonElement root = ReadRoot(pending);
            JsonElement context = root.GetProperty("context");
            string schema = Read(root, "schema");
            if ((!string.Equals(schema, ReceiptSchemaV2, StringComparison.Ordinal) &&
                 !string.Equals(schema, LegacyReceiptSchemaV1, StringComparison.Ordinal)) ||
                !string.Equals(Read(root, "status"), CompletedPendingSync, StringComparison.Ordinal) ||
                !string.Equals(Read(context, "projectId"), projectId, StringComparison.Ordinal) ||
                !string.Equals(Read(context, "documentFingerprint"), documentFingerprint, StringComparison.Ordinal) ||
                !string.Equals(Read(context, "commandId"), commandId, StringComparison.Ordinal))
                throw new InvalidOperationException($"Family mutation receipt {commandId} does not match the acknowledged source revision.");

            var amended = CopyProperties(root);
            amended["status"] = AttachedToSource;
            amended["attachedSourceRevision"] = attachedSourceRevision;
            amended["acknowledgedAt"] = DateTime.UtcNow;
            amended["acknowledgementDigest"] = ReceiptIdentityDigest(root);
            // Acknowledged-first is crash-safe: a both-files window is recovered by
            // deterministic receipt identity equality on the next acknowledgement.
            WriteNewAtomic(acknowledged, amended);
            File.Delete(pending);
        }
    }

    private static MutationWitness? ExactWitness(
        Document doc,
        FamilyMutationContext context,
        string expectedIdentityDigest)
    {
        MutationWitness[] matches = ReadWitnesses(doc).Where(row =>
            string.Equals(row.CommandId, context.CommandId, StringComparison.Ordinal) &&
            string.Equals(row.ProjectId, context.ProjectId, StringComparison.Ordinal) &&
            string.Equals(row.DocumentFingerprint, context.DocumentFingerprint, StringComparison.Ordinal)).ToArray();
        if (matches.Length == 0) return null;
        foreach (MutationWitness witness in matches) _ = ValidatedWitnessReceipt(witness);
        if (matches.Any(row => !string.Equals(row.IdentityDigest, expectedIdentityDigest, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("This family mutation command is an altered replay with a different operation/target/request; execution was blocked.");
        if (matches.Select(row => row.PayloadDigest).Distinct(StringComparer.OrdinalIgnoreCase).Count() != 1)
            throw new InvalidOperationException("Conflicting Revit witnesses exist for this family mutation command; duplicate execution was blocked.");
        return matches[0];
    }

    private static JsonElement PromoteWitnessReceipt(MutationWitness witness, string pendingPath)
    {
        JsonElement authoritative = ValidatedWitnessReceipt(witness);
        if (File.Exists(pendingPath))
        {
            JsonElement local = ReadRoot(pendingPath);
            string localStatus = Read(local, "status");
            if (!string.Equals(Read(local, "schema"), ReceiptSchemaV2, StringComparison.Ordinal) ||
                (!string.Equals(localStatus, PreparedAwaitingCommit, StringComparison.Ordinal) &&
                 !string.Equals(localStatus, CompletedPendingSync, StringComparison.Ordinal)))
                throw new InvalidOperationException("A model witness conflicts with a legacy/local family mutation receipt.");
            string localIdentity = MutationIdentityDigest(local);
            string localPrepared = PreparedEvidenceDigest(local);
            if (!string.Equals(Read(local, "identityDigest"), witness.IdentityDigest, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(localIdentity, witness.IdentityDigest, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Read(local, "preparedDigest"), witness.PreparedDigest, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(localPrepared, witness.PreparedDigest, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The local family mutation receipt conflicts with the authoritative Revit model witness.");
        }
        // Never return a mutable local result as authority. Reconstruct the
        // completed receipt from the validated same-transaction Revit witness.
        var promoted = CopyProperties(authoritative);
        promoted["status"] = CompletedPendingSync;
        promoted["completedAt"] = DateTime.UtcNow;
        promoted["commitWitness"] = new
        {
            schemaGuid = WitnessSchemaGuid.ToString("D"),
            dataStorageUniqueId = witness.DataStorageUniqueId,
            payloadDigest = witness.PayloadDigest
        };
        WriteAtomic(pendingPath, promoted);
        return ReadRoot(pendingPath);
    }

    private static JsonElement ValidatedWitnessReceipt(MutationWitness witness)
    {
        if (!string.Equals(Sha256Hex(witness.ReceiptJson), witness.PayloadDigest, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("witness payload digest mismatch");
        using JsonDocument document = JsonDocument.Parse(witness.ReceiptJson);
        JsonElement root = document.RootElement;
        string computedIdentityDigest = MutationIdentityDigest(root);
        string computedPreparedDigest = PreparedEvidenceDigest(root);
        if (!string.Equals(Read(root, "schema"), ReceiptSchemaV2, StringComparison.Ordinal) ||
            !string.Equals(Read(root, "status"), PreparedAwaitingCommit, StringComparison.Ordinal) ||
            !string.Equals(Read(root, "operation"), witness.Operation, StringComparison.Ordinal) ||
            !string.Equals(Read(root, "identityDigest"), witness.IdentityDigest, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(computedIdentityDigest, witness.IdentityDigest, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Read(root, "preparedDigest"), witness.PreparedDigest, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(computedPreparedDigest, witness.PreparedDigest, StringComparison.OrdinalIgnoreCase) ||
            !root.TryGetProperty("context", out JsonElement context) ||
            !root.TryGetProperty("result", out JsonElement result) ||
            !string.Equals(Read(context, "commandId"), witness.CommandId, StringComparison.Ordinal) ||
            !string.Equals(Read(context, "projectId"), witness.ProjectId, StringComparison.Ordinal) ||
            !string.Equals(Read(context, "documentFingerprint"), witness.DocumentFingerprint, StringComparison.Ordinal) ||
            !string.Equals(Read(result, "uniqueId"), witness.ResultUniqueId, StringComparison.Ordinal))
            throw new InvalidOperationException("witness payload binding mismatch");
        return root.Clone();
    }

    private static IEnumerable<MutationWitness> ReadWitnesses(Document doc)
    {
        Autodesk.Revit.DB.ExtensibleStorage.Schema? schema = Autodesk.Revit.DB.ExtensibleStorage.Schema.Lookup(WitnessSchemaGuid);
        if (schema == null) yield break;
        foreach (RevitDataStorage storage in new FilteredElementCollector(doc).OfClass(typeof(RevitDataStorage)).Cast<RevitDataStorage>())
        {
            Entity entity;
            try { entity = storage.GetEntity(schema); } catch { continue; }
            MutationWitness witness;
            using (entity)
            {
                if (!entity.IsValid()) continue;
                witness = new MutationWitness(
                    storage.UniqueId,
                    GetString(entity, schema, FieldCommandId),
                    GetString(entity, schema, FieldProjectId),
                    GetString(entity, schema, FieldDocumentFingerprint),
                    GetString(entity, schema, FieldOperation),
                    GetString(entity, schema, FieldResultUniqueId),
                    GetString(entity, schema, FieldIdentityDigest),
                    GetString(entity, schema, FieldPreparedDigest),
                    GetString(entity, schema, FieldReceiptJson),
                    GetString(entity, schema, FieldPayloadDigest));
            }
            yield return witness;
        }
    }

    private static Autodesk.Revit.DB.ExtensibleStorage.Schema GetOrCreateWitnessSchema()
    {
        Autodesk.Revit.DB.ExtensibleStorage.Schema? existing = Autodesk.Revit.DB.ExtensibleStorage.Schema.Lookup(WitnessSchemaGuid);
        if (existing != null)
        {
            foreach (string field in WitnessFieldNames())
            {
                using Field existingField = existing.GetField(field)
                    ?? throw new InvalidOperationException($"The existing REVEX family witness schema is missing field {field}.");
            }
            return existing;
        }
        var builder = new SchemaBuilder(WitnessSchemaGuid);
        builder.SetSchemaName(WitnessSchemaName);
        builder.SetVendorId(WitnessVendorId);
        builder.SetReadAccessLevel(AccessLevel.Public);
        builder.SetWriteAccessLevel(AccessLevel.Vendor);
        foreach (string field in WitnessFieldNames()) builder.AddSimpleField(field, typeof(string));
        return builder.Finish();
    }

    private static IEnumerable<string> WitnessFieldNames()
    {
        yield return FieldCommandId;
        yield return FieldProjectId;
        yield return FieldDocumentFingerprint;
        yield return FieldOperation;
        yield return FieldResultUniqueId;
        yield return FieldIdentityDigest;
        yield return FieldPreparedDigest;
        yield return FieldReceiptJson;
        yield return FieldPayloadDigest;
    }

    private static void SetString(Entity entity, Autodesk.Revit.DB.ExtensibleStorage.Schema schema, string name, string value)
    {
        using Field field = schema.GetField(name) ?? throw new InvalidOperationException($"Family witness schema field {name} is missing.");
        entity.Set<string>(field, value ?? "");
    }

    private static string GetString(Entity entity, Autodesk.Revit.DB.ExtensibleStorage.Schema schema, string name)
    {
        using Field field = schema.GetField(name) ?? throw new InvalidOperationException($"Family witness schema field {name} is missing.");
        return entity.Get<string>(field) ?? "";
    }

    private static void ValidateReceiptBinding(JsonElement root, FamilyMutationContext context, bool requireAttached)
    {
        if (!root.TryGetProperty("context", out JsonElement receiptContext) ||
            !string.Equals(Read(receiptContext, "commandId"), context.CommandId, StringComparison.Ordinal) ||
            !string.Equals(Read(receiptContext, "correlationId"), context.CorrelationId, StringComparison.Ordinal) ||
            !string.Equals(Read(receiptContext, "projectId"), context.ProjectId, StringComparison.Ordinal) ||
            !string.Equals(Read(receiptContext, "baseSourceRevision"), context.BaseSourceRevision, StringComparison.Ordinal) ||
            !string.Equals(Read(receiptContext, "documentFingerprint"), context.DocumentFingerprint, StringComparison.Ordinal) ||
            !string.Equals(Read(receiptContext, "provider"), context.Provider, StringComparison.Ordinal) ||
            !string.Equals(Read(receiptContext, "providerAssetName"), context.ProviderAssetName, StringComparison.Ordinal) ||
            !string.Equals(Read(receiptContext, "providerAssetSha256"), context.ProviderAssetSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The existing family mutation receipt does not match this project/document command envelope.");
        if (requireAttached && !string.Equals(Read(root, "status"), AttachedToSource, StringComparison.Ordinal))
            throw new InvalidOperationException("The acknowledged family mutation receipt is not terminal.");
    }

    private static void ValidateAcknowledged(JsonElement root, string projectId, string documentFingerprint, string sourceRevision, string commandId)
    {
        ValidateAcknowledgementDigest(root);
        if (!root.TryGetProperty("context", out JsonElement context) ||
            !string.Equals(Read(root, "status"), AttachedToSource, StringComparison.Ordinal) ||
            !string.Equals(Read(root, "attachedSourceRevision"), sourceRevision, StringComparison.Ordinal) ||
            !string.Equals(Read(context, "commandId"), commandId, StringComparison.Ordinal) ||
            !string.Equals(Read(context, "projectId"), projectId, StringComparison.Ordinal) ||
            !string.Equals(Read(context, "documentFingerprint"), documentFingerprint, StringComparison.Ordinal))
            throw new InvalidOperationException($"Family mutation receipt {commandId} was already acknowledged with a different binding.");
    }

    private static void ValidateAcknowledgementDigest(JsonElement root)
    {
        if (string.Equals(Read(root, "schema"), ReceiptSchemaV2, StringComparison.Ordinal) &&
            !string.Equals(Read(root, "acknowledgementDigest"), ReceiptIdentityDigest(root), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The v2 acknowledged family mutation receipt digest is invalid.");
    }

    private static void ValidateContext(FamilyMutationContext context)
    {
        if (string.IsNullOrWhiteSpace(context.CommandId) || string.IsNullOrWhiteSpace(context.CorrelationId) ||
            string.IsNullOrWhiteSpace(context.ProjectId) || string.IsNullOrWhiteSpace(context.DocumentFingerprint) ||
            string.IsNullOrWhiteSpace(context.BaseSourceRevision) || !context.BaseSourceRevision.StartsWith("rev_", StringComparison.Ordinal))
            throw new InvalidOperationException("Family mutation requires command/correlation/project/base-revision/document bindings.");
        _ = SafeKey(context.CommandId);
    }

    private static void ValidateOperation(string operation)
    {
        if (!string.Equals(operation, "place", StringComparison.Ordinal) && !string.Equals(operation, "transform", StringComparison.Ordinal))
            throw new InvalidOperationException("Family mutation operation must be place or transform.");
    }

    private static ReceiptResult ResultPayload(FamilyPlacementService.PlacementResult result) => new(
        result.ElementId, result.UniqueId, result.Family, result.Type, result.Level, result.HostUniqueId,
        result.BboxMin, result.BboxMax, result.PlacementType);

    private static string MutationIdentityDigest(FamilyMutationContext context, string operation, object request) =>
        Sha256Hex(JsonSerializer.Serialize(new
        {
            operation,
            context,
            request
        }, CompactJsonOptions));

    private static string MutationIdentityDigest(JsonElement receipt) =>
        Sha256Hex(JsonSerializer.Serialize(new
        {
            operation = Read(receipt, "operation"),
            context = receipt.GetProperty("context"),
            request = receipt.GetProperty("request")
        }, CompactJsonOptions));

    private static string PreparedEvidenceDigest(JsonElement receipt) =>
        Sha256Hex(JsonSerializer.Serialize(new
        {
            operation = Read(receipt, "operation"),
            context = receipt.GetProperty("context"),
            request = receipt.GetProperty("request"),
            result = receipt.GetProperty("result")
        }, CompactJsonOptions));

    private static FamilyPlacementService.PlacementResult PlacementResultFromReceipt(JsonElement root)
    {
        if (!root.TryGetProperty("result", out JsonElement result) || result.ValueKind != JsonValueKind.Object)
            throw new InvalidOperationException("The recovered family mutation receipt has no exact Revit result.");
        return new FamilyPlacementService.PlacementResult(
            ReadLong(result, "elementId"),
            Read(result, "uniqueId"),
            Read(result, "family"),
            Read(result, "type"),
            Read(result, "level"),
            ReadDoubleArray(result, "bboxMin"),
            ReadDoubleArray(result, "bboxMax"),
            Array.Empty<float>(),
            true,
            Read(result, "placementType"),
            Read(result, "hostUniqueId"));
    }

    private static long ReadLong(JsonElement owner, string property)
    {
        if (owner.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long parsed))
            return parsed;
        throw new InvalidOperationException($"The recovered family mutation result is missing {property}.");
    }

    private static double[] ReadDoubleArray(JsonElement owner, string property)
    {
        if (!owner.TryGetProperty(property, out JsonElement value) || value.ValueKind != JsonValueKind.Array)
            return new[] { 0d, 0d, 0d };
        double[] values = value.EnumerateArray()
            .Take(3)
            .Select(item => item.ValueKind == JsonValueKind.Number && item.TryGetDouble(out double parsed) ? parsed : 0d)
            .ToArray();
        return values.Length == 3 ? values : values.Concat(Enumerable.Repeat(0d, 3 - values.Length)).ToArray();
    }

    private static DateTime? ReadDate(JsonElement owner, string property)
    {
        if (owner.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String &&
            DateTime.TryParse(value.GetString(), out DateTime parsed)) return parsed;
        return null;
    }

    private static JsonElement ReadRoot(string path)
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.Clone();
    }

    private static Dictionary<string, object?> CopyProperties(JsonElement root)
    {
        var copy = new Dictionary<string, object?>();
        foreach (JsonProperty property in root.EnumerateObject()) copy[property.Name] = property.Value.Clone();
        return copy;
    }

    private static string ReceiptIdentityDigest(JsonElement root)
    {
        JsonElement context = root.GetProperty("context");
        JsonElement result = root.TryGetProperty("result", out JsonElement receiptResult) ? receiptResult : default;
        return Sha256Hex(JsonSerializer.Serialize(new
        {
            schema = Read(root, "schema"), operation = Read(root, "operation"),
            commandId = Read(context, "commandId"), projectId = Read(context, "projectId"),
            documentFingerprint = Read(context, "documentFingerprint"), baseSourceRevision = Read(context, "baseSourceRevision"),
            uniqueId = result.ValueKind == JsonValueKind.Object ? Read(result, "uniqueId") : "",
            preparedDigest = Read(root, "preparedDigest")
        }, CompactJsonOptions));
    }

    private static void ArchivePending(string path, string reason)
    {
        JsonElement root = ReadRoot(path);
        var archived = CopyProperties(root);
        archived["status"] = "RECOVERY_ARCHIVED";
        archived["recoveryReason"] = reason;
        archived["recoveredAt"] = DateTime.UtcNow;
        string command = root.TryGetProperty("context", out JsonElement context) ? Read(context, "commandId") : Path.GetFileNameWithoutExtension(path);
        string destination = Path.Combine(Root, "recovery", SafeKey(command) + "-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ") + ".json");
        WriteNewAtomic(destination, archived);
        File.Delete(path);
    }

    private static InvalidOperationException DuplicateCommand() =>
        new("This family mutation command was already accepted; duplicate execution was blocked.");

    private static string Read(JsonElement owner, string property) =>
        owner.ValueKind == JsonValueKind.Object && owner.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? "" : "";

    private static string Root => Path.Combine(AppPaths.Sync, "family-mutations");
    private static string PendingFolder(string fingerprint) => Path.Combine(Root, "pending", SafeKey(fingerprint));
    private static string PendingPath(string fingerprint, string commandId) => Path.Combine(PendingFolder(fingerprint), SafeKey(commandId) + ".json");
    private static string AcknowledgedPath(string fingerprint, string commandId) => Path.Combine(Root, "acknowledged", SafeKey(fingerprint), SafeKey(commandId) + ".json");

    private static string SafeKey(string value)
    {
        string safe = Regex.Replace(value?.Trim() ?? "", "[^A-Za-z0-9._-]+", "_");
        if (safe.Length == 0 || safe.Length > 160) throw new InvalidOperationException("Family mutation identifier is invalid.");
        return safe;
    }

    private static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value ?? ""))).ToLowerInvariant();

    private static void WriteAtomic(string path, object value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (FileStream stream = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, value, JsonOptions);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } }
    }

    private static void WriteNewAtomic(string path, object value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (FileStream stream = new(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, value, JsonOptions);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: false);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } }
    }
}
