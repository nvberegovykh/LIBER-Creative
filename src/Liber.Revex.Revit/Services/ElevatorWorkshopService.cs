using Autodesk.Revit.DB;
using System.Globalization;
using System.Security.Cryptography;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Isolated elevator-family workshop. No candidate is ever loaded back into the
/// active Revit project here. Each state is a separate saved .rfa artifact and
/// each consequential transition is one named native Revit transaction.
/// </summary>
internal sealed class ElevatorWorkshopService
{
    internal sealed record InfillGeometry(
        string SourceCandidatePath,
        string PlaneAxis,
        double PlaneCoordFt,
        double[] OutwardNormal,
        double[] ViewerRight,
        double ClearLeftUFt,
        double ClearRightUFt,
        double DoorHeightFt);

    internal sealed record WorkshopRequest(
        long ProjectElementId,
        long InternalElementId,
        string FocusId,
        string RequestId,
        string Action,
        InfillGeometry? Infill = null);

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
        IReadOnlyList<long> AddedElementIds,
        FamilyInvariantSnapshot Before,
        FamilyInvariantSnapshot After,
        string CompletedAtUtc,
        IReadOnlyList<string> Evidence);

    internal WorkshopResult Execute(Document projectDocument, WorkshopRequest request)
    {
        if (projectDocument.IsFamilyDocument)
            throw new InvalidOperationException("Elevator workshop must start from the active project document.");

        return request.Action switch
        {
            "retire-rear-glass" => RetireRearGlass(projectDocument, request),
            "infill-right-opening" => InfillRightOpening(projectDocument, request),
            _ => throw new InvalidOperationException("Unsupported elevator workshop action: " + request.Action)
        };
    }

    private WorkshopResult RetireRearGlass(Document projectDocument, WorkshopRequest request)
    {
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

            return Result(
                request,
                "S3",
                baselinePath,
                candidatePath,
                baselineHash,
                candidateHash,
                deleted.Select(id => id.Value).ToArray(),
                Array.Empty<long>(),
                before,
                after,
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
            CloseWorkshop(familyDocument);
        }
    }

    private WorkshopResult InfillRightOpening(Document projectDocument, WorkshopRequest request)
    {
        InfillGeometry geometry = request.Infill
            ?? throw new InvalidOperationException("S4 infill geometry is missing.");
        string sourcePath = ValidateWorkshopSource(geometry.SourceCandidatePath, request.FocusId);
        string folder = Path.GetDirectoryName(sourcePath)
            ?? throw new InvalidOperationException("S4 source candidate has no parent folder.");
        string candidatePath = Path.Combine(folder, "S4_RIGHT_OPENING_INFILLED.rfa");
        string baselineHash = Sha256(sourcePath);

        Document? familyDocument = null;
        try
        {
            familyDocument = projectDocument.Application.OpenDocumentFile(sourcePath);
            if (!familyDocument.IsFamilyDocument)
                throw new InvalidOperationException("S4 source is not a Revit family document.");

            GenericForm aperture = familyDocument.GetElement(new ElementId(request.InternalElementId)) as GenericForm
                ?? throw new InvalidOperationException($"Aperture element {request.InternalElementId} is missing from the S3 candidate.");
            if (aperture.IsSolid)
                throw new InvalidOperationException("S4 aperture target is solid; expected the preserved void GenericForm.");
            BoundingBoxXYZ apertureBox = aperture.get_BoundingBox(null)
                ?? throw new InvalidOperationException("S4 aperture has no measurable bounding box.");

            XYZ outward = UnitVector(geometry.OutwardNormal, "outwardNormal");
            XYZ right = UnitVector(geometry.ViewerRight, "viewerRight");
            if (Math.Abs(outward.DotProduct(right)) > 1e-6 || Math.Abs(outward.Z) > 1e-6 || Math.Abs(right.Z) > 1e-6)
                throw new InvalidOperationException("S4 face basis is not an orthogonal horizontal basis.");
            string axis = geometry.PlaneAxis.Trim().ToLowerInvariant();
            if (axis is not "x" and not "y")
                throw new InvalidOperationException("S4 planeAxis must be x or y.");

            double[] uCorners = HorizontalCorners(apertureBox)
                .Select(p => p.DotProduct(right))
                .ToArray();
            double apertureMinU = uCorners.Min();
            double apertureMaxU = uCorners.Max();
            double apertureMinZ = apertureBox.Min.Z;
            double apertureMaxZ = apertureBox.Max.Z;
            double clearLeft = geometry.ClearLeftUFt;
            double clearRight = geometry.ClearRightUFt;
            double clearBottom = apertureMinZ;
            double clearTop = clearBottom + geometry.DoorHeightFt;
            const double tol = 1.0 / (12.0 * 64.0); // 1/64 inch

            if (!(clearRight - clearLeft > tol))
                throw new InvalidOperationException("S4 clear opening width is invalid.");
            if (clearLeft < apertureMinU - tol || clearRight > apertureMaxU + tol)
                throw new InvalidOperationException(
                    $"S4 right-aligned clear opening [{clearLeft:R},{clearRight:R}] falls outside existing aperture [{apertureMinU:R},{apertureMaxU:R}].");
            if (!(clearTop > clearBottom + tol) || clearTop > apertureMaxZ + tol)
                throw new InvalidOperationException(
                    $"S4 door height exceeds existing aperture: clearTop={clearTop:R}; apertureTop={apertureMaxZ:R}.");

            double wallDepth = ResolveCabWallThickness(familyDocument, apertureBox, axis);
            if (!(wallDepth > tol && wallDepth < 2.0))
                throw new InvalidOperationException($"S4 resolved cab-wall depth is not credible: {wallDepth:R} ft.");

            FamilyInvariantSnapshot before = Snapshot(familyDocument);
            var addedIds = new List<long>();
            using (var tx = new Transaction(familyDocument, "LIBER:ELEVATOR:S4:INFILL_RIGHT_OPENING"))
            {
                tx.Start();
                XYZ planeOrigin = axis == "x"
                    ? new XYZ(geometry.PlaneCoordFt, 0, 0)
                    : new XYZ(0, geometry.PlaneCoordFt, 0);
                XYZ sketchNormal = outward.Negate(); // from outside face into cab wall
                SketchPlane sketchPlane = SketchPlane.Create(
                    familyDocument,
                    Plane.CreateByNormalAndOrigin(sketchNormal, planeOrigin));

                void AddRegion(double u0, double u1, double z0, double z1, string label)
                {
                    if (u1 - u0 <= tol || z1 - z0 <= tol) return;
                    Extrusion extrusion = familyDocument.FamilyCreate.NewExtrusion(
                        true,
                        RectangleProfile(planeOrigin, right, u0, u1, z0, z1),
                        sketchPlane,
                        wallDepth);
                    TryAssociateCabWallMaterial(familyDocument, extrusion);
                    Parameter? comments = extrusion.LookupParameter("Comments");
                    if (comments is { IsReadOnly: false })
                        comments.Set("LIBER:ELEVATOR:S4:" + label);
                    addedIds.Add(extrusion.Id.Value);
                }

                AddRegion(apertureMinU, clearLeft, clearBottom, Math.Min(clearTop, apertureMaxZ), "LEFT_INFILL");
                AddRegion(clearRight, apertureMaxU, clearBottom, Math.Min(clearTop, apertureMaxZ), "RIGHT_JAMB_INFILL");
                AddRegion(clearLeft, clearRight, clearTop, apertureMaxZ, "HEAD_INFILL");
                if (addedIds.Count == 0)
                {
                    tx.RollBack();
                    throw new InvalidOperationException("S4 produced no infill regions; transition was rolled back.");
                }

                familyDocument.Regenerate();
                FamilyInvariantSnapshot tentative = Snapshot(familyDocument);
                VerifyS4(before, tentative, addedIds.Count);
                foreach (long id in addedIds)
                {
                    if (familyDocument.GetElement(new ElementId(id)) is not GenericForm form || !form.IsSolid)
                    {
                        tx.RollBack();
                        throw new InvalidOperationException($"S4 created invalid infill element {id}; transition was rolled back.");
                    }
                }

                TransactionStatus committed = tx.Commit();
                if (committed != TransactionStatus.Committed)
                    throw new InvalidOperationException("Revit did not commit the isolated S4 infill transition.");
            }

            FamilyInvariantSnapshot after = Snapshot(familyDocument);
            VerifyS4(before, after, addedIds.Count);
            SaveCopy(familyDocument, candidatePath);
            string candidateHash = Sha256(candidatePath);

            return Result(
                request,
                "S4",
                sourcePath,
                candidatePath,
                baselineHash,
                candidateHash,
                Array.Empty<long>(),
                addedIds,
                before,
                after,
                new[]
                {
                    "S4 opened the verified S3 candidate, not the active project family definition.",
                    $"Existing aperture U-range: {apertureMinU:R} to {apertureMaxU:R} ft.",
                    $"Surviving clear opening U-range: {clearLeft:R} to {clearRight:R} ft.",
                    $"Surviving clear opening Z-range: {clearBottom:R} to {clearTop:R} ft.",
                    $"Cab-wall infill depth: {wallDepth:R} ft.",
                    $"Created {addedIds.Count} bounded solid infill forms.",
                    "Primary wall/reference/dimension/nested-family identities remained unchanged.",
                    "No candidate was loaded into the active project."
                });
        }
        finally
        {
            CloseWorkshop(familyDocument);
        }
    }

    private static WorkshopResult Result(
        WorkshopRequest request,
        string state,
        string baselinePath,
        string candidatePath,
        string baselineHash,
        string candidateHash,
        IReadOnlyList<long> deleted,
        IReadOnlyList<long> added,
        FamilyInvariantSnapshot before,
        FamilyInvariantSnapshot after,
        IReadOnlyList<string> evidence) =>
        new(
            "liber.revex.elevator.workshop.v1",
            request.FocusId,
            request.RequestId,
            request.Action,
            state,
            request.ProjectElementId,
            request.InternalElementId,
            baselinePath,
            candidatePath,
            baselineHash,
            candidateHash,
            deleted,
            added,
            before,
            after,
            DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            evidence);

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
        VerifyProtected(before, after, "S3");
        if (after.WallIds.Contains(retiredId) || after.ReferencePlaneIds.Contains(retiredId) ||
            after.DimensionIds.Contains(retiredId) || after.NestedFamilyIds.Contains(retiredId))
            throw new InvalidOperationException("S3 target unexpectedly belongs to a protected topology class.");
    }

    private static void VerifyS4(FamilyInvariantSnapshot before, FamilyInvariantSnapshot after, int addedForms)
    {
        if (after.GenericForms != before.GenericForms + addedForms)
            throw new InvalidOperationException($"S4 expected GenericForms {before.GenericForms + addedForms}, observed {after.GenericForms}.");
        VerifyProtected(before, after, "S4");
    }

    private static void VerifyProtected(FamilyInvariantSnapshot before, FamilyInvariantSnapshot after, string state)
    {
        RequireSame(state, "walls", before.WallIds, after.WallIds);
        RequireSame(state, "reference planes", before.ReferencePlaneIds, after.ReferencePlaneIds);
        RequireSame(state, "dimensions", before.DimensionIds, after.DimensionIds);
        RequireSame(state, "nested families", before.NestedFamilyIds, after.NestedFamilyIds);
    }

    private static void RequireSame(string state, string label, IReadOnlyList<long> before, IReadOnlyList<long> after)
    {
        if (before.Count != after.Count || !before.SequenceEqual(after))
            throw new InvalidOperationException($"{state} changed protected {label}; transition must not be accepted.");
    }

    private static CurveArrArray RectangleProfile(
        XYZ planeOrigin,
        XYZ right,
        double u0,
        double u1,
        double z0,
        double z1)
    {
        XYZ P(double u, double z) => planeOrigin + right.Multiply(u) + XYZ.BasisZ.Multiply(z);
        XYZ p0 = P(u0, z0), p1 = P(u1, z0), p2 = P(u1, z1), p3 = P(u0, z1);
        var loop = new CurveArray();
        loop.Append(Line.CreateBound(p0, p1));
        loop.Append(Line.CreateBound(p1, p2));
        loop.Append(Line.CreateBound(p2, p3));
        loop.Append(Line.CreateBound(p3, p0));
        var profile = new CurveArrArray();
        profile.Append(loop);
        return profile;
    }

    private static IReadOnlyList<XYZ> HorizontalCorners(BoundingBoxXYZ box) => new[]
    {
        new XYZ(box.Min.X, box.Min.Y, 0),
        new XYZ(box.Min.X, box.Max.Y, 0),
        new XYZ(box.Max.X, box.Min.Y, 0),
        new XYZ(box.Max.X, box.Max.Y, 0)
    };

    private static XYZ UnitVector(double[] values, string label)
    {
        if (values == null || values.Length != 3 || values.Any(v => !double.IsFinite(v)))
            throw new InvalidOperationException("S4 " + label + " must contain three finite values.");
        XYZ vector = new(values[0], values[1], values[2]);
        double length = vector.GetLength();
        if (length < 1e-9)
            throw new InvalidOperationException("S4 " + label + " is zero-length.");
        return vector.Divide(length);
    }

    private static double ResolveCabWallThickness(Document document, BoundingBoxXYZ aperture, string axis)
    {
        try
        {
            FamilyManager manager = document.FamilyManager;
            FamilyParameter? parameter = manager.GetParameters()
                .FirstOrDefault(p => string.Equals(p.Definition.Name, "Car Wall Thickness", StringComparison.OrdinalIgnoreCase));
            if (parameter != null && manager.CurrentType != null)
            {
                double? value = manager.CurrentType.AsDouble(parameter);
                if (value is > 0) return value.Value;
            }
        }
        catch { }
        return axis == "x" ? aperture.Max.X - aperture.Min.X : aperture.Max.Y - aperture.Min.Y;
    }

    private static void TryAssociateCabWallMaterial(Document document, Extrusion extrusion)
    {
        try
        {
            FamilyManager manager = document.FamilyManager;
            FamilyParameter? material = manager.GetParameters()
                .FirstOrDefault(p => string.Equals(p.Definition.Name, "_Elevator Cab Walls", StringComparison.OrdinalIgnoreCase));
            Parameter? formMaterial = extrusion.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM);
            if (material != null && formMaterial != null)
                manager.AssociateElementParameterToFamilyParameter(formMaterial, material);
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("ELEVATOR_WORKSHOP", "Could not associate S4 cab-wall material: " + ex.Message);
        }
    }

    private static string ValidateWorkshopSource(string sourcePath, string focusId)
    {
        if (string.IsNullOrWhiteSpace(sourcePath))
            throw new InvalidOperationException("Workshop source candidate path is empty.");
        string full = Path.GetFullPath(sourcePath);
        string root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "LIBER_REVEX", "observer-workshops"))
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetExtension(full), ".rfa", StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(full))
            throw new InvalidOperationException("S4 source must be an existing .rfa inside the LIBER REVEX observer-workshops temp root.");
        string safeFocus = SafeFocus(focusId);
        string relative = Path.GetRelativePath(root, full);
        string first = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];
        if (!string.Equals(first, safeFocus, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("S4 source candidate does not belong to the requested focus lane.");
        return full;
    }

    private static string CreateWorkshopFolder(string focusId)
    {
        string path = Path.Combine(
            Path.GetTempPath(),
            "LIBER_REVEX",
            "observer-workshops",
            SafeFocus(focusId),
            DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string SafeFocus(string focusId)
    {
        string safe = new string((focusId ?? "elevator").Select(ch =>
            char.IsLetterOrDigit(ch) || ch is '.' or '-' or '_' ? ch : '_').ToArray()).Trim('_');
        if (string.IsNullOrWhiteSpace(safe)) safe = "elevator";
        return safe.Length > 80 ? safe[..80] : safe;
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

    private static void CloseWorkshop(Document? familyDocument)
    {
        if (familyDocument == null) return;
        try { familyDocument.Close(false); }
        catch (Exception ex) { RevexDiagnostics.Warn("ELEVATOR_WORKSHOP", "Workshop family close failed: " + ex.Message); }
    }
}
