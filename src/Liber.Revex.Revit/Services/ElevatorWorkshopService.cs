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
        double DoorHeightFt,
        double? CabLeftUFt = null,
        double? StopBaseZFt = null,
        int? StopIndex = null,
        string? VisibilityParameter = null);

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

    private const double Tol = 1.0 / (12.0 * 64.0); // 1/64 inch
    private const double PanelFaceGapFt = 0.25 / 12.0;

    internal WorkshopResult Execute(Document projectDocument, WorkshopRequest request)
    {
        if (projectDocument.IsFamilyDocument)
            throw new InvalidOperationException("Elevator workshop must start from the active project document.");

        return request.Action switch
        {
            "retire-rear-glass" => RetireRearGlass(projectDocument, request),
            "infill-right-opening" => InfillRightOpening(projectDocument, request),
            "build-right-frame" => BuildRightFrame(projectDocument, request),
            "build-single-car-panel" => BuildSingleCarPanel(projectDocument, request),
            "build-landing-stop" => BuildLandingStop(projectDocument, request),
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

            ICollection<ElementId> deleted;
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
                request, "S3", baselinePath, candidatePath, baselineHash, candidateHash,
                deleted.Select(id => id.Value).ToArray(), Array.Empty<long>(), before, after,
                new[]
                {
                    "Active project family was not replaced or reloaded.",
                    "Baseline family copy was saved before mutation.",
                    "Exactly one solid GenericForm was deleted.",
                    "Wall, reference-plane, dimension, and nested-family identities were preserved.",
                    "Candidate was saved only to the isolated temp workshop lane."
                });
        }
        finally { CloseWorkshop(familyDocument); }
    }

    private WorkshopResult InfillRightOpening(Document projectDocument, WorkshopRequest request)
    {
        InfillGeometry geometry = RequireGeometry(request, "S4");
        string sourcePath = ValidateWorkshopSource(geometry.SourceCandidatePath, request.FocusId, "S3_REAR_GLASS_RETIRED.rfa", "S4");
        string folder = Path.GetDirectoryName(sourcePath)
            ?? throw new InvalidOperationException("S4 source candidate has no parent folder.");
        string candidatePath = Path.Combine(folder, "S4_RIGHT_OPENING_INFILLED.rfa");
        string baselineHash = Sha256(sourcePath);

        Document? familyDocument = null;
        try
        {
            familyDocument = OpenFamilyCandidate(projectDocument, sourcePath, "S4");
            GenericForm aperture = RequireVoidForm(familyDocument, request.InternalElementId, "S4");
            BoundingBoxXYZ apertureBox = aperture.get_BoundingBox(null)
                ?? throw new InvalidOperationException("S4 aperture has no measurable bounding box.");

            (XYZ outward, XYZ right, string axis) = ValidateBasis(geometry, "S4");
            (double apertureMinU, double apertureMaxU) = URange(apertureBox, right);
            double apertureMinZ = apertureBox.Min.Z;
            double apertureMaxZ = apertureBox.Max.Z;
            double clearLeft = geometry.ClearLeftUFt;
            double clearRight = geometry.ClearRightUFt;
            double clearBottom = apertureMinZ;
            double clearTop = clearBottom + geometry.DoorHeightFt;

            ValidateOpeningGeometry(familyDocument, geometry, apertureMinU, apertureMaxU, clearBottom, apertureMaxZ, "S4");

            double wallDepth = ResolveCabWallThickness(familyDocument, apertureBox, axis);
            if (!(wallDepth > Tol && wallDepth < 2.0))
                throw new InvalidOperationException($"S4 resolved cab-wall depth is not credible: {wallDepth:R} ft.");

            FamilyInvariantSnapshot before = Snapshot(familyDocument);
            var addedIds = new List<long>();
            using (var tx = new Transaction(familyDocument, "LIBER:ELEVATOR:S4:INFILL_RIGHT_OPENING"))
            {
                tx.Start();
                XYZ planeOrigin = PlaneOrigin(axis, geometry.PlaneCoordFt);
                SketchPlane sketchPlane = SketchPlane.Create(
                    familyDocument,
                    Plane.CreateByNormalAndOrigin(outward.Negate(), planeOrigin));

                void AddRegion(double u0, double u1, double z0, double z1, string label)
                {
                    if (u1 - u0 <= Tol || z1 - z0 <= Tol) return;
                    Extrusion extrusion = familyDocument.FamilyCreate.NewExtrusion(
                        true,
                        RectangleProfile(planeOrigin, right, u0, u1, z0, z1),
                        sketchPlane,
                        wallDepth);
                    TryAssociateMaterial(familyDocument, extrusion, "_Elevator Cab Walls", "S4");
                    TryTag(extrusion, "LIBER:ELEVATOR:S4:" + label);
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
                VerifyAddedForms(before, tentative, addedIds.Count, "S4");
                VerifyCreatedSolids(familyDocument, addedIds, "S4");

                TransactionStatus committed = tx.Commit();
                if (committed != TransactionStatus.Committed)
                    throw new InvalidOperationException("Revit did not commit the isolated S4 infill transition.");
            }

            FamilyInvariantSnapshot after = Snapshot(familyDocument);
            VerifyAddedForms(before, after, addedIds.Count, "S4");
            SaveCopy(familyDocument, candidatePath);
            string candidateHash = Sha256(candidatePath);

            return Result(
                request, "S4", sourcePath, candidatePath, baselineHash, candidateHash,
                Array.Empty<long>(), addedIds, before, after,
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
        finally { CloseWorkshop(familyDocument); }
    }

    private WorkshopResult BuildRightFrame(Document projectDocument, WorkshopRequest request)
    {
        InfillGeometry geometry = RequireGeometry(request, "S5");
        string sourcePath = ValidateWorkshopSource(geometry.SourceCandidatePath, request.FocusId, "S4_RIGHT_OPENING_INFILLED.rfa", "S5");
        string folder = Path.GetDirectoryName(sourcePath)
            ?? throw new InvalidOperationException("S5 source candidate has no parent folder.");
        string candidatePath = Path.Combine(folder, "S5_RIGHT_FRAME.rfa");
        string baselineHash = Sha256(sourcePath);

        Document? familyDocument = null;
        try
        {
            familyDocument = OpenFamilyCandidate(projectDocument, sourcePath, "S5");
            GenericForm aperture = RequireVoidForm(familyDocument, request.InternalElementId, "S5");
            BoundingBoxXYZ apertureBox = aperture.get_BoundingBox(null)
                ?? throw new InvalidOperationException("S5 aperture has no measurable bounding box.");

            (XYZ outward, XYZ right, _) = ValidateBasis(geometry, "S5");
            (double apertureMinU, double apertureMaxU) = URange(apertureBox, right);
            double clearBottom = apertureBox.Min.Z;
            ValidateOpeningGeometry(familyDocument, geometry, apertureMinU, apertureMaxU, clearBottom, apertureBox.Max.Z, "S5");

            double frameWidth = RequireFamilyDouble(familyDocument, "Frame Width", "S5");
            double frameDepth = RequireFamilyDouble(familyDocument, "Frame Depth", "S5");
            if (!(frameWidth > Tol && frameWidth < 1.0))
                throw new InvalidOperationException($"S5 Frame Width is not credible: {frameWidth:R} ft.");
            if (!(frameDepth > Tol && frameDepth < 2.0))
                throw new InvalidOperationException($"S5 Frame Depth is not credible: {frameDepth:R} ft.");

            double clearLeft = geometry.ClearLeftUFt;
            double clearRight = geometry.ClearRightUFt;
            double clearTop = clearBottom + geometry.DoorHeightFt;
            double leftOuter = clearLeft - frameWidth;
            double rightOuter = clearRight + frameWidth;
            double headTop = clearTop + frameWidth;

            FamilyInvariantSnapshot before = Snapshot(familyDocument);
            var addedIds = new List<long>();
            using (var tx = new Transaction(familyDocument, "LIBER:ELEVATOR:S5:RIGHT_FRAME"))
            {
                tx.Start();
                XYZ planeOrigin = PlaneOrigin(geometry.PlaneAxis, geometry.PlaneCoordFt);
                SketchPlane sketchPlane = SketchPlane.Create(
                    familyDocument,
                    Plane.CreateByNormalAndOrigin(outward, planeOrigin));

                void AddFrame(double u0, double u1, double z0, double z1, string label)
                {
                    Extrusion extrusion = familyDocument.FamilyCreate.NewExtrusion(
                        true,
                        RectangleProfile(planeOrigin, right, u0, u1, z0, z1),
                        sketchPlane,
                        frameDepth);
                    TryAssociateMaterial(familyDocument, extrusion, "_Elevator Door Frame Finish", "S5");
                    TryTag(extrusion, "LIBER:ELEVATOR:S5:" + label);
                    addedIds.Add(extrusion.Id.Value);
                }

                AddFrame(leftOuter, clearLeft, clearBottom, headTop, "LEFT_JAMB");
                AddFrame(clearRight, rightOuter, clearBottom, headTop, "RIGHT_JAMB");
                AddFrame(clearLeft, clearRight, clearTop, headTop, "HEAD");

                if (addedIds.Count != 3)
                {
                    tx.RollBack();
                    throw new InvalidOperationException($"S5 expected three frame forms, observed {addedIds.Count}.");
                }

                familyDocument.Regenerate();
                FamilyInvariantSnapshot tentative = Snapshot(familyDocument);
                VerifyAddedForms(before, tentative, 3, "S5");
                VerifyCreatedSolids(familyDocument, addedIds, "S5");

                TransactionStatus committed = tx.Commit();
                if (committed != TransactionStatus.Committed)
                    throw new InvalidOperationException("Revit did not commit the isolated S5 frame transition.");
            }

            FamilyInvariantSnapshot after = Snapshot(familyDocument);
            VerifyAddedForms(before, after, 3, "S5");
            SaveCopy(familyDocument, candidatePath);
            string candidateHash = Sha256(candidatePath);

            return Result(
                request, "S5", sourcePath, candidatePath, baselineHash, candidateHash,
                Array.Empty<long>(), addedIds, before, after,
                new[]
                {
                    "S5 opened only the verified S4 candidate.",
                    $"Frame Width: {frameWidth:R} ft; Frame Depth: {frameDepth:R} ft.",
                    $"Frame U-range: {leftOuter:R} to {rightOuter:R} ft.",
                    $"Clear opening remained {clearLeft:R} to {clearRight:R} ft.",
                    "Exactly three solid frame forms were added: left jamb, right jamb, head.",
                    "Frame material is associated to _Elevator Door Frame Finish when available.",
                    "No project family was loaded or replaced."
                });
        }
        finally { CloseWorkshop(familyDocument); }
    }

    private WorkshopResult BuildSingleCarPanel(Document projectDocument, WorkshopRequest request)
    {
        InfillGeometry geometry = RequireGeometry(request, "S6");
        string sourcePath = ValidateWorkshopSource(geometry.SourceCandidatePath, request.FocusId, "S5_RIGHT_FRAME.rfa", "S6");
        string folder = Path.GetDirectoryName(sourcePath)
            ?? throw new InvalidOperationException("S6 source candidate has no parent folder.");
        string candidatePath = Path.Combine(folder, "S6_SINGLE_CAR_PANEL.rfa");
        string baselineHash = Sha256(sourcePath);

        if (geometry.CabLeftUFt is null || !double.IsFinite(geometry.CabLeftUFt.Value))
            throw new InvalidOperationException("S6 requires the proven cab-left U coordinate for pocket verification.");

        Document? familyDocument = null;
        try
        {
            familyDocument = OpenFamilyCandidate(projectDocument, sourcePath, "S6");
            GenericForm aperture = RequireVoidForm(familyDocument, request.InternalElementId, "S6");
            BoundingBoxXYZ apertureBox = aperture.get_BoundingBox(null)
                ?? throw new InvalidOperationException("S6 aperture has no measurable bounding box.");

            (XYZ outward, XYZ right, _) = ValidateBasis(geometry, "S6");
            (double apertureMinU, double apertureMaxU) = URange(apertureBox, right);
            double clearBottom = apertureBox.Min.Z;
            ValidateOpeningGeometry(familyDocument, geometry, apertureMinU, apertureMaxU, clearBottom, apertureBox.Max.Z, "S6");

            double frameWidth = RequireFamilyDouble(familyDocument, "Frame Width", "S6");
            double frameDepth = RequireFamilyDouble(familyDocument, "Frame Depth", "S6");
            double doorThickness = RequireFamilyDouble(familyDocument, "Door Thickness", "S6");
            if (!(doorThickness > Tol && doorThickness < 1.0))
                throw new InvalidOperationException($"S6 Door Thickness is not credible: {doorThickness:R} ft.");

            double clearLeft = geometry.ClearLeftUFt;
            double clearRight = geometry.ClearRightUFt;
            double clearWidth = clearRight - clearLeft;
            double overlap = Math.Min(frameWidth * 0.25, 0.5 / 12.0);
            double panelLeft = clearLeft - overlap;
            double panelRight = clearRight + overlap;
            double panelWidth = panelRight - panelLeft;
            double panelBottom = clearBottom;
            double panelTop = clearBottom + geometry.DoorHeightFt + frameWidth;

            double leftOuter = clearLeft - frameWidth;
            double openRight = leftOuter;
            double openLeft = openRight - panelWidth;
            double slideTravel = panelRight - openRight;
            double cabLeft = geometry.CabLeftUFt.Value;
            if (openLeft < cabLeft - Tol)
                throw new InvalidOperationException(
                    $"S6 panel cannot retreat into the proven left pocket: openLeft={openLeft:R}; cabLeft={cabLeft:R}; panelWidth={panelWidth:R}.");

            FamilyInvariantSnapshot before = Snapshot(familyDocument);
            var addedIds = new List<long>();
            using (var tx = new Transaction(familyDocument, "LIBER:ELEVATOR:S6:SINGLE_CAR_PANEL"))
            {
                tx.Start();
                XYZ faceOrigin = PlaneOrigin(geometry.PlaneAxis, geometry.PlaneCoordFt);
                XYZ panelOrigin = faceOrigin + outward.Multiply(PanelFaceGapFt);
                SketchPlane sketchPlane = SketchPlane.Create(
                    familyDocument,
                    Plane.CreateByNormalAndOrigin(outward, panelOrigin));

                Extrusion panel = familyDocument.FamilyCreate.NewExtrusion(
                    true,
                    RectangleProfile(panelOrigin, right, panelLeft, panelRight, panelBottom, panelTop),
                    sketchPlane,
                    doorThickness);
                TryAssociateDoorMaterial(familyDocument, panel, "S6");
                TryTag(panel, "LIBER:ELEVATOR:S6:SINGLE_CAR_PANEL");
                addedIds.Add(panel.Id.Value);

                familyDocument.Regenerate();
                FamilyInvariantSnapshot tentative = Snapshot(familyDocument);
                VerifyAddedForms(before, tentative, 1, "S6");
                VerifyCreatedSolids(familyDocument, addedIds, "S6");

                TransactionStatus committed = tx.Commit();
                if (committed != TransactionStatus.Committed)
                    throw new InvalidOperationException("Revit did not commit the isolated S6 single-panel transition.");
            }

            FamilyInvariantSnapshot after = Snapshot(familyDocument);
            VerifyAddedForms(before, after, 1, "S6");
            SaveCopy(familyDocument, candidatePath);
            string candidateHash = Sha256(candidatePath);

            return Result(
                request, "S6", sourcePath, candidatePath, baselineHash, candidateHash,
                Array.Empty<long>(), addedIds, before, after,
                new[]
                {
                    "S6 opened only the verified S5 candidate.",
                    $"Closed single-panel U-range: {panelLeft:R} to {panelRight:R} ft.",
                    $"Panel width: {panelWidth:R} ft; clear width: {clearWidth:R} ft; overlap each side: {overlap:R} ft.",
                    $"Panel height: {panelTop - panelBottom:R} ft; Door Thickness: {doorThickness:R} ft.",
                    $"Proven open retreat U-range: {openLeft:R} to {openRight:R} ft.",
                    $"Required leftward slide travel: {slideTravel:R} ft.",
                    $"Cab left pocket boundary: {cabLeft:R} ft.",
                    $"Panel face offset from cab boundary: {PanelFaceGapFt:R} ft; source Frame Depth remains {frameDepth:R} ft.",
                    "Exactly one car-door GenericForm was added.",
                    "Panel material is associated to _Elevator Cab Doors, falling back to _Elevator Door Finish.",
                    "No project family was loaded or replaced."
                });
        }
        finally { CloseWorkshop(familyDocument); }
    }

    private WorkshopResult BuildLandingStop(Document projectDocument, WorkshopRequest request)
    {
        InfillGeometry geometry = RequireGeometry(request, "S7");
        if (geometry.StopIndex is null || geometry.StopBaseZFt is null)
            throw new InvalidOperationException("S7 requires a native stop index and base elevation.");
        int stopIndex = geometry.StopIndex.Value;
        double stopBase = geometry.StopBaseZFt.Value;
        if (stopIndex < 1 || stopIndex > 10 || !double.IsFinite(stopBase))
            throw new InvalidOperationException("S7 stop index/elevation is outside the bounded elevator range.");

        string expectedSource = stopIndex == 1
            ? "S6_SINGLE_CAR_PANEL.rfa"
            : $"S7_STOP_{stopIndex - 1:D2}.rfa";
        string sourcePath = ValidateWorkshopSource(geometry.SourceCandidatePath, request.FocusId, expectedSource, $"S7.{stopIndex:D2}");
        string folder = Path.GetDirectoryName(sourcePath)
            ?? throw new InvalidOperationException("S7 source candidate has no parent folder.");
        string candidatePath = Path.Combine(folder, $"S7_STOP_{stopIndex:D2}.rfa");
        string baselineHash = Sha256(sourcePath);

        Document? familyDocument = null;
        try
        {
            string state = $"S7.{stopIndex:D2}";
            familyDocument = OpenFamilyCandidate(projectDocument, sourcePath, state);
            GenericForm aperture = RequireVoidForm(familyDocument, request.InternalElementId, state);
            BoundingBoxXYZ apertureBox = aperture.get_BoundingBox(null)
                ?? throw new InvalidOperationException($"{state} aperture has no measurable bounding box.");

            (XYZ outward, XYZ right, _) = ValidateBasis(geometry, state);
            (double apertureMinU, double apertureMaxU) = URange(apertureBox, right);
            ValidateOpeningWidthAndNative(familyDocument, geometry, apertureMinU, apertureMaxU, state);

            double frameWidth = RequireFamilyDouble(familyDocument, "Frame Width", state);
            double frameDepth = RequireFamilyDouble(familyDocument, "Frame Depth", state);
            double doorThickness = RequireFamilyDouble(familyDocument, "Door Thickness", state);
            double separation = ResolveLandingSeparation(familyDocument, state);
            if (stopIndex > 1 && string.IsNullOrWhiteSpace(geometry.VisibilityParameter))
                throw new InvalidOperationException($"{state} requires the source stop visibility parameter before creating repeated landing geometry.");

            double clearLeft = geometry.ClearLeftUFt;
            double clearRight = geometry.ClearRightUFt;
            double clearTop = stopBase + geometry.DoorHeightFt;
            double leftOuter = clearLeft - frameWidth;
            double rightOuter = clearRight + frameWidth;
            double headTop = clearTop + frameWidth;
            double overlap = Math.Min(frameWidth * 0.25, 0.5 / 12.0);
            double panelLeft = clearLeft - overlap;
            double panelRight = clearRight + overlap;
            double panelTop = clearTop + frameWidth;
            int expectedAdded = stopIndex == 1 ? 1 : 4;

            FamilyInvariantSnapshot before = Snapshot(familyDocument);
            var addedIds = new List<long>();
            using (var tx = new Transaction(familyDocument, $"LIBER:ELEVATOR:S7:LANDING_STOP_{stopIndex:D2}"))
            {
                tx.Start();
                XYZ faceOrigin = PlaneOrigin(geometry.PlaneAxis, geometry.PlaneCoordFt);

                if (stopIndex > 1)
                {
                    SketchPlane framePlane = SketchPlane.Create(
                        familyDocument,
                        Plane.CreateByNormalAndOrigin(outward, faceOrigin));
                    void AddFrame(double u0, double u1, double z0, double z1, string label)
                    {
                        Extrusion frame = familyDocument.FamilyCreate.NewExtrusion(
                            true,
                            RectangleProfile(faceOrigin, right, u0, u1, z0, z1),
                            framePlane,
                            frameDepth);
                        TryAssociateMaterial(familyDocument, frame, "_Elevator Door Frame Finish", state);
                        AssociateVisibility(familyDocument, frame, geometry.VisibilityParameter, state, true);
                        TryTag(frame, $"LIBER:ELEVATOR:{state}:FRAME:{label}");
                        addedIds.Add(frame.Id.Value);
                    }
                    AddFrame(leftOuter, clearLeft, stopBase, headTop, "LEFT_JAMB");
                    AddFrame(clearRight, rightOuter, stopBase, headTop, "RIGHT_JAMB");
                    AddFrame(clearLeft, clearRight, clearTop, headTop, "HEAD");
                }

                XYZ panelOrigin = faceOrigin + outward.Multiply(PanelFaceGapFt + separation);
                SketchPlane panelPlane = SketchPlane.Create(
                    familyDocument,
                    Plane.CreateByNormalAndOrigin(outward, panelOrigin));
                Extrusion panel = familyDocument.FamilyCreate.NewExtrusion(
                    true,
                    RectangleProfile(panelOrigin, right, panelLeft, panelRight, stopBase, panelTop),
                    panelPlane,
                    doorThickness);
                TryAssociateMaterial(familyDocument, panel, "_Elevator Door Finish", state);
                AssociateVisibility(familyDocument, panel, geometry.VisibilityParameter, state, stopIndex > 1);
                TryTag(panel, $"LIBER:ELEVATOR:{state}:LANDING_PANEL");
                addedIds.Add(panel.Id.Value);

                if (addedIds.Count != expectedAdded)
                {
                    tx.RollBack();
                    throw new InvalidOperationException($"{state} expected {expectedAdded} new forms, observed {addedIds.Count}.");
                }

                familyDocument.Regenerate();
                FamilyInvariantSnapshot tentative = Snapshot(familyDocument);
                VerifyAddedForms(before, tentative, expectedAdded, state);
                VerifyCreatedSolids(familyDocument, addedIds, state);

                TransactionStatus committed = tx.Commit();
                if (committed != TransactionStatus.Committed)
                    throw new InvalidOperationException($"Revit did not commit {state}.");
            }

            FamilyInvariantSnapshot after = Snapshot(familyDocument);
            VerifyAddedForms(before, after, expectedAdded, state);
            SaveCopy(familyDocument, candidatePath);
            string candidateHash = Sha256(candidatePath);

            return Result(
                request, state, sourcePath, candidatePath, baselineHash, candidateHash,
                Array.Empty<long>(), addedIds, before, after,
                new[]
                {
                    $"{state} continued strictly from {Path.GetFileName(sourcePath)}.",
                    $"Native stop base elevation: {stopBase:R} ft.",
                    $"Landing panel U-range: {panelLeft:R} to {panelRight:R} ft.",
                    $"Landing panel face separation from car-panel plane: {separation:R} ft.",
                    $"Visibility family parameter: {geometry.VisibilityParameter ?? "always-visible"}.",
                    stopIndex == 1
                        ? "Stop 1 reused the S5 frame and added only its landing panel."
                        : "This upper stop added one landing panel plus a three-piece matching frame.",
                    "Protected wall/reference/dimension/nested-family identities remained unchanged.",
                    "No project family was loaded or replaced."
                });
        }
        finally { CloseWorkshop(familyDocument); }
    }

    private static InfillGeometry RequireGeometry(WorkshopRequest request, string state) =>
        request.Infill ?? throw new InvalidOperationException($"{state} geometry is missing.");

    private static Document OpenFamilyCandidate(Document projectDocument, string sourcePath, string state)
    {
        Document familyDocument = projectDocument.Application.OpenDocumentFile(sourcePath);
        if (!familyDocument.IsFamilyDocument)
        {
            familyDocument.Close(false);
            throw new InvalidOperationException($"{state} source is not a Revit family document.");
        }
        return familyDocument;
    }

    private static GenericForm RequireVoidForm(Document familyDocument, long elementId, string state)
    {
        GenericForm aperture = familyDocument.GetElement(new ElementId(elementId)) as GenericForm
            ?? throw new InvalidOperationException($"{state} aperture element {elementId} is missing.");
        if (aperture.IsSolid)
            throw new InvalidOperationException($"{state} aperture target is solid; expected the preserved void GenericForm.");
        return aperture;
    }

    private static (XYZ Outward, XYZ Right, string Axis) ValidateBasis(InfillGeometry geometry, string state)
    {
        XYZ outward = UnitVector(geometry.OutwardNormal, state + " outwardNormal");
        XYZ right = UnitVector(geometry.ViewerRight, state + " viewerRight");
        if (Math.Abs(outward.DotProduct(right)) > 1e-6 || Math.Abs(outward.Z) > 1e-6 || Math.Abs(right.Z) > 1e-6)
            throw new InvalidOperationException($"{state} face basis is not an orthogonal horizontal basis.");
        string axis = geometry.PlaneAxis.Trim().ToLowerInvariant();
        if (axis is not "x" and not "y")
            throw new InvalidOperationException($"{state} planeAxis must be x or y.");
        return (outward, right, axis);
    }

    private static (double MinU, double MaxU) URange(BoundingBoxXYZ box, XYZ right)
    {
        double[] values = HorizontalCorners(box).Select(p => p.DotProduct(right)).ToArray();
        return (values.Min(), values.Max());
    }

    private static void ValidateOpeningWidthAndNative(
        Document document,
        InfillGeometry geometry,
        double apertureMinU,
        double apertureMaxU,
        string state)
    {
        double clearLeft = geometry.ClearLeftUFt;
        double clearRight = geometry.ClearRightUFt;
        if (!(clearRight - clearLeft > Tol))
            throw new InvalidOperationException($"{state} clear opening width is invalid.");
        if (clearLeft < apertureMinU - Tol || clearRight > apertureMaxU + Tol)
            throw new InvalidOperationException(
                $"{state} clear opening [{clearLeft:R},{clearRight:R}] falls outside existing aperture [{apertureMinU:R},{apertureMaxU:R}].");

        double nativeClear = RequireFamilyDouble(document, "Clear Opening", state);
        double nativeHeight = RequireFamilyDouble(document, "_Elevator Door Height", state);
        if (Math.Abs((clearRight - clearLeft) - nativeClear) > Tol)
            throw new InvalidOperationException(
                $"{state} planned clear opening does not match native family parameter: planned={clearRight - clearLeft:R}; native={nativeClear:R}.");
        if (Math.Abs(geometry.DoorHeightFt - nativeHeight) > Tol)
            throw new InvalidOperationException(
                $"{state} planned door height does not match native family parameter: planned={geometry.DoorHeightFt:R}; native={nativeHeight:R}.");
    }

    private static void ValidateOpeningGeometry(
        Document document,
        InfillGeometry geometry,
        double apertureMinU,
        double apertureMaxU,
        double clearBottom,
        double apertureMaxZ,
        string state)
    {
        ValidateOpeningWidthAndNative(document, geometry, apertureMinU, apertureMaxU, state);
        double clearTop = clearBottom + geometry.DoorHeightFt;
        if (!(clearTop > clearBottom + Tol) || clearTop > apertureMaxZ + Tol)
            throw new InvalidOperationException(
                $"{state} door height exceeds existing aperture: clearTop={clearTop:R}; apertureTop={apertureMaxZ:R}.");
    }

    private static double RequireFamilyDouble(Document document, string name, string state)
    {
        double? value = TryFamilyDouble(document, name);
        if (value is not > 0)
            throw new InvalidOperationException($"{state} family parameter '{name}' is unavailable or not a positive length.");
        return value.Value;
    }

    private static double? TryFamilyDouble(Document document, string name)
    {
        try
        {
            FamilyManager manager = document.FamilyManager;
            FamilyParameter? parameter = manager.GetParameters()
                .FirstOrDefault(p => string.Equals(p.Definition.Name, name, StringComparison.OrdinalIgnoreCase));
            return parameter == null || manager.CurrentType == null ? null : manager.CurrentType.AsDouble(parameter);
        }
        catch { return null; }
    }

    private static double ResolveLandingSeparation(Document document, string state)
    {
        foreach ((string elevatorName, string lobbyName) in new[]
        {
            ("Right Elevator Door Offset", "Right Lobby Door Offset"),
            ("Left Elevator Door Offset", "Left Lobby Door Offset")
        })
        {
            double? elevator = TryFamilyDouble(document, elevatorName);
            double? lobby = TryFamilyDouble(document, lobbyName);
            if (elevator is > 0 && lobby is >= 0)
            {
                double separation = Math.Abs(elevator.Value - lobby.Value);
                if (separation > Tol && separation < 2.0) return separation;
            }
        }
        throw new InvalidOperationException($"{state} could not derive the native landing/car door-plane separation.");
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
            "liber.revex.elevator.workshop.v3",
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
            genericForms, walls.Length, refs.Length, dimensions.Length, nested.Length,
            walls, refs, dimensions, nested);
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

    private static void VerifyAddedForms(FamilyInvariantSnapshot before, FamilyInvariantSnapshot after, int addedForms, string state)
    {
        if (after.GenericForms != before.GenericForms + addedForms)
            throw new InvalidOperationException(
                $"{state} expected GenericForms {before.GenericForms + addedForms}, observed {after.GenericForms}.");
        VerifyProtected(before, after, state);
    }

    private static void VerifyProtected(FamilyInvariantSnapshot before, FamilyInvariantSnapshot after, string state)
    {
        RequireSame(state, "walls", before.WallIds, after.WallIds);
        RequireSame(state, "reference planes", before.ReferencePlaneIds, after.ReferencePlaneIds);
        RequireSame(state, "dimensions", before.DimensionIds, after.DimensionIds);
        RequireSame(state, "nested families", before.NestedFamilyIds, after.NestedFamilyIds);
    }

    private static void VerifyCreatedSolids(Document document, IEnumerable<long> ids, string state)
    {
        foreach (long id in ids)
        {
            if (document.GetElement(new ElementId(id)) is not GenericForm form || !form.IsSolid)
                throw new InvalidOperationException($"{state} created invalid solid GenericForm {id}.");
        }
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
        if (!(u1 - u0 > Tol) || !(z1 - z0 > Tol))
            throw new InvalidOperationException("Rectangle profile has zero or negative size.");
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

    private static XYZ PlaneOrigin(string axis, double planeCoordFt) =>
        axis.Trim().ToLowerInvariant() == "x"
            ? new XYZ(planeCoordFt, 0, 0)
            : new XYZ(0, planeCoordFt, 0);

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
            throw new InvalidOperationException(label + " must contain three finite values.");
        XYZ vector = new(values[0], values[1], values[2]);
        double length = vector.GetLength();
        if (length < 1e-9)
            throw new InvalidOperationException(label + " is zero-length.");
        return vector.Divide(length);
    }

    private static double ResolveCabWallThickness(Document document, BoundingBoxXYZ aperture, string axis)
    {
        try { return RequireFamilyDouble(document, "Car Wall Thickness", "S4"); }
        catch { return axis == "x" ? aperture.Max.X - aperture.Min.X : aperture.Max.Y - aperture.Min.Y; }
    }

    private static void TryAssociateDoorMaterial(Document document, Extrusion extrusion, string state)
    {
        if (TryAssociateMaterial(document, extrusion, "_Elevator Cab Doors", state)) return;
        TryAssociateMaterial(document, extrusion, "_Elevator Door Finish", state);
    }

    private static bool TryAssociateMaterial(Document document, Extrusion extrusion, string familyParameterName, string state)
    {
        try
        {
            FamilyManager manager = document.FamilyManager;
            FamilyParameter? material = manager.GetParameters()
                .FirstOrDefault(p => string.Equals(p.Definition.Name, familyParameterName, StringComparison.OrdinalIgnoreCase));
            Parameter? formMaterial = extrusion.get_Parameter(BuiltInParameter.MATERIAL_ID_PARAM);
            if (material == null || formMaterial == null) return false;
            manager.AssociateElementParameterToFamilyParameter(formMaterial, material);
            return true;
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("ELEVATOR_WORKSHOP", $"Could not associate {state} material {familyParameterName}: " + ex.Message);
            return false;
        }
    }

    private static void AssociateVisibility(Document document, Element element, string? familyParameterName, string state, bool required)
    {
        if (string.IsNullOrWhiteSpace(familyParameterName))
        {
            if (required) throw new InvalidOperationException($"{state} visibility association is required but unresolved.");
            return;
        }
        FamilyManager manager = document.FamilyManager;
        FamilyParameter? visibility = manager.GetParameters()
            .FirstOrDefault(p => string.Equals(p.Definition.Name, familyParameterName, StringComparison.OrdinalIgnoreCase));
        Parameter? elementVisibility = element.LookupParameter("Visible");
        if (visibility == null || elementVisibility == null)
            throw new InvalidOperationException($"{state} could not bind Visible to family parameter {familyParameterName}.");
        manager.AssociateElementParameterToFamilyParameter(elementVisibility, visibility);
    }

    private static void TryTag(Element element, string value)
    {
        try
        {
            Parameter? comments = element.LookupParameter("Comments");
            if (comments is { IsReadOnly: false }) comments.Set(value);
        }
        catch { }
    }

    private static string ValidateWorkshopSource(string sourcePath, string focusId, string expectedFileName, string state)
    {
        if (string.IsNullOrWhiteSpace(sourcePath))
            throw new InvalidOperationException($"{state} source candidate path is empty.");
        string full = Path.GetFullPath(sourcePath);
        string root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "LIBER_REVEX", "observer-workshops"))
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetExtension(full), ".rfa", StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(full))
            throw new InvalidOperationException($"{state} source must be an existing .rfa inside the LIBER REVEX observer-workshops temp root.");
        string safeFocus = SafeFocus(focusId);
        string relative = Path.GetRelativePath(root, full);
        string first = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)[0];
        if (!string.Equals(first, safeFocus, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"{state} source candidate does not belong to the requested focus lane.");
        if (!string.Equals(Path.GetFileName(full), expectedFileName, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                $"{state} expected source artifact {expectedFileName}, observed {Path.GetFileName(full)}.");
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
        var options = new SaveAsOptions { OverwriteExistingFile = true, MaximumBackups = 1 };
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
