using Autodesk.Revit.DB;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Isolated elevator-family workshop. This service never loads a changed family
/// back into the active project. It opens the project family with EditFamily,
/// materializes baseline/candidate .rfa files under the user's temp directory,
/// applies exactly one bounded transaction to that detached family document,
/// verifies protected topology, saves the candidate, and closes the family doc.
/// </summary>
internal sealed class ElevatorWorkshopService
{
    internal sealed record WorkshopRequest(
        long ProjectElementId,
        long InternalElementId,
        string FocusId,
        string RequestId,
        string Action);

    internal sealed record FamilyInvariantSnapshot(
        int GenericForms,
        int Walls,
        int ReferencePlanes,
        int Dimensions,
        int NestedFamilies,
        IReadOnlyList<long> WallIds,
        IReadOnlyList<long> ReferencePlaneIds,
        IReadOnlyList<long> DimensionIds,
        IReadOnlyList<long> NestedFamilyIds);

    internal sealed record WorkshopResult(
        string Schema,
        string FocusId,
        string RequestId,
        string Action,
        string State,
        long ProjectElementId,
        long InternalElementId,
        string BaselinePath,
        string CandidatePath,
        string BaselineSha256,
        string CandidateSha256,
        IReadOnlyList<long> DeletedElementIds,
        FamilyInvariantSnapshot Before,
        FamilyInvariantSnapshot After,
        string CompletedAtUtc,
        IReadOnlyList<string> Evidence);

    internal WorkshopResult Execute(Document projectDocument, WorkshopRequest request)
    {
        if (projectDocument.IsFamilyDocument)
            throw new InvalidOperationException("Elevator workshop must start from the active project document.");
        if (!string.Equals(request.Action, "retire-rear-glass", StringComparison.Ordinal))
            throw new InvalidOperationException("Unsupported elevator workshop action: " + request.Action);

        FamilyInstance projectInstance = projectDocument.GetElement(new ElementId(request.ProjectElementId)) as FamilyInstance
            ?? throw new InvalidOperationException($"Element {request.ProjectElementId} is not a FamilyInstance.");
        Family family = projectInstance.Symbol?.Family
            ?? throw new InvalidOperationException($"Family instance {request.ProjectElementId} has no family definition.");
        if (family.IsInPlace)
            throw new InvalidOperationException("In-place families are not supported by the isolated elevator workshop.");

        Document? familyDocument = null;
        try
        {
            familyDocument = projectDocument.EditFamily(family);
            Element target = familyDocument.GetElement(new ElementId(request.InternalElementId))
                ?? throw new InvalidOperationException($"Family element {request.InternalElementId} does not exist in {family.Name}.");
            if (target is not GenericForm targetForm || !targetForm.IsSolid)
                throw new InvalidOperationException($"Family element {request.InternalElementId} is not a solid GenericForm; refusing workshop mutation.");

            FamilyInvariantSnapshot before = Snapshot(familyDocument);
            string folder = CreateWorkshopFolder(request.FocusId);
            string baselinePath = Path.Combine(folder, "S2_BASE.rfa");
            string candidatePath = Path.Combine(folder, "S3_REAR_GLASS_RETIRED.rfa");
            SaveCopy(familyDocument, baselinePath);
            string baselineHash = Sha256(baselinePath);

            IReadOnlyCollection<ElementId> deleted;
            using (var tx = new Transaction(familyDocument, "LIBER:ELEVATOR:S3:RETIRE_REAR_GLASS"))
            {
                tx.Start();
                deleted = familyDocument.Delete(target.Id);
                if (deleted.Count != 1 || deleted.First().Value != target.Id.Value)
                {
                    tx.RollBack();
                    string ids = string.Join(",", deleted.Select(id => id.Value.ToString(CultureInfo.InvariantCulture)));
                    throw new InvalidOperationException(
                        $"Rear-glass removal would cascade to {deleted.Count} family elements ({ids}); transition was rolled back.");
                }

                familyDocument.Regenerate();
                FamilyInvariantSnapshot tentative = Snapshot(familyDocument);
                VerifyS3(before, tentative, target.Id.Value);
                TransactionStatus committed = tx.Commit();
                if (committed != TransactionStatus.Committed)
                    throw new InvalidOperationException("Revit did not commit the isolated rear-glass transition.");
            }

            FamilyInvariantSnapshot after = Snapshot(familyDocument);
            VerifyS3(before, after, target.Id.Value);
            SaveCopy(familyDocument, candidatePath);
            string candidateHash = Sha256(candidatePath);

            return new WorkshopResult(
                "liber.revex.elevator.workshop.v1",
                request.FocusId,
                request.RequestId,
                request.Action,
                "S3",
                request.ProjectElementId,
                request.InternalElementId,
                baselinePath,
                candidatePath,
                baselineHash,
                candidateHash,
                deleted.Select(id => id.Value).ToArray(),
                before,
                after,
                DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                new[]
                {
                    "Active project family was not replaced or reloaded.",
                    "Baseline family copy was saved before mutation.",
                    "Exactly one solid GenericForm was deleted.",
                    "Wall, reference-plane, dimension, and nested-family identities were preserved.",
                    "Candidate was saved only to the isolated temp workshop lane."
                });
        }
        finally
        {
            if (familyDocument != null)
            {
                try { familyDocument.Close(false); }
                catch (Exception ex) { RevexDiagnostics.Warn("ELEVATOR_WORKSHOP", "Workshop family close failed: " + ex.Message); }
            }
        }
    }

    private static FamilyInvariantSnapshot Snapshot(Document document)
    {
        long[] walls = Ids<Wall>(document);
        long[] refs = Ids<ReferencePlane>(document);
        long[] dimensions = Ids<Dimension>(document);
        long[] nested = Ids<FamilyInstance>(document);
        int genericForms = new FilteredElementCollector(document)
            .WhereElementIsNotElementType()
            .OfClass(typeof(GenericForm))
            .GetElementCount();
        return new FamilyInvariantSnapshot(
            genericForms,
            walls.Length,
            refs.Length,
            dimensions.Length,
            nested.Length,
            walls,
            refs,
            dimensions,
            nested);
    }

    private static long[] Ids<T>(Document document) where T : Element =>
        new FilteredElementCollector(document)
            .WhereElementIsNotElementType()
            .OfClass(typeof(T))
            .ToElementIds()
            .Select(id => id.Value)
            .OrderBy(id => id)
            .ToArray();

    private static void VerifyS3(FamilyInvariantSnapshot before, FamilyInvariantSnapshot after, long retiredId)
    {
        if (after.GenericForms != before.GenericForms - 1)
            throw new InvalidOperationException($"S3 expected GenericForms {before.GenericForms - 1}, observed {after.GenericForms}.");
        RequireSame("walls", before.WallIds, after.WallIds);
        RequireSame("reference planes", before.ReferencePlaneIds, after.ReferencePlaneIds);
        RequireSame("dimensions", before.DimensionIds, after.DimensionIds);
        RequireSame("nested families", before.NestedFamilyIds, after.NestedFamilyIds);
        if (after.WallIds.Contains(retiredId) || after.ReferencePlaneIds.Contains(retiredId) ||
            after.DimensionIds.Contains(retiredId) || after.NestedFamilyIds.Contains(retiredId))
            throw new InvalidOperationException("S3 target unexpectedly belongs to a protected topology class.");
    }

    private static void RequireSame(string label, IReadOnlyList<long> before, IReadOnlyList<long> after)
    {
        if (before.Count != after.Count || !before.SequenceEqual(after))
            throw new InvalidOperationException($"S3 changed protected {label}; transition must not be accepted.");
    }

    private static string CreateWorkshopFolder(string focusId)
    {
        string safe = new string((focusId ?? "elevator").Select(ch =>
            char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_' ? ch : '_').ToArray()).Trim('_');
        if (string.IsNullOrWhiteSpace(safe)) safe = "elevator";
        if (safe.Length > 80) safe = safe[..80];
        string path = Path.Combine(
            Path.GetTempPath(),
            "LIBER_REVEX",
            "observer-workshops",
            safe,
            DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
        Directory.CreateDirectory(path);
        return path;
    }

    private static void SaveCopy(Document familyDocument, string path)
    {
        var options = new SaveAsOptions
        {
            OverwriteExistingFile = true,
            MaximumBackups = 1
        };
        familyDocument.SaveAs(path, options);
    }

    private static string Sha256(string path)
    {
        using FileStream stream = File.OpenRead(path);
        byte[] hash = SHA256.HashData(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
