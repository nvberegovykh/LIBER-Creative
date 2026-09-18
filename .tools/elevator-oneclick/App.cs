using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Liber.ElevatorOneShot;

public sealed class App : IExternalApplication
{
    private const double MmPerFt = 304.8;
    private const double TolFt = 1.0 / (12.0 * 64.0);
    private const double FaceTolFt = 1.0 / (12.0 * 32.0);
    private static UIControlledApplication? _controlled;
    private static bool _handled;

    private sealed class Job
    {
        public string SourcePath { get; set; } = "";
        public string OutputPath { get; set; } = "";
        public string ResultPath { get; set; } = "";
        public string ManifestPath { get; set; } = "";
    }

    private sealed class ResultFile
    {
        public bool Ok { get; set; }
        public string? OutputPath { get; set; }
        public double? WidthMm { get; set; }
        public double? LengthMm { get; set; }
        public string? Error { get; set; }
        public List<string> Log { get; set; } = new();
    }

    private sealed record BoxSize(double X, double Y, double Z, int Count);

    public Result OnStartup(UIControlledApplication application)
    {
        _controlled = application;
        application.Idling += OnIdling;
        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        try { application.Idling -= OnIdling; } catch { }
        return Result.Succeeded;
    }

    private static void OnIdling(object? sender, IdlingEventArgs e)
    {
        if (_handled) return;
        string jobPath = Path.Combine(Path.GetTempPath(), "LIBER_ELEVATOR_ONESHOT_JOB.json");
        if (!File.Exists(jobPath)) return;

        _handled = true;
        try { if (_controlled != null) _controlled.Idling -= OnIdling; } catch { }

        if (sender is not UIApplication uiapp)
        {
            WriteEmergencyFailure(jobPath, "Could not obtain UIApplication from Revit Idling.");
            return;
        }

        Process(uiapp, jobPath);
    }

    private static void Process(UIApplication uiapp, string jobPath)
    {
        Job? job = null;
        var log = new List<string>();
        Document? doc = null;

        try
        {
            job = JsonSerializer.Deserialize<Job>(File.ReadAllText(jobPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidOperationException("One-click job file is empty.");

            TryDelete(job.ManifestPath);

            string source = Path.GetFullPath(job.SourcePath);
            string output = Path.GetFullPath(job.OutputPath);
            string resultPath = Path.GetFullPath(job.ResultPath);

            if (!File.Exists(source))
                throw new FileNotFoundException("Elevator family was not found.", source);
            if (!string.Equals(Path.GetExtension(source), ".rfa", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Source is not an RFA.");
            if (string.Equals(source, output, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Output must be a different file. Original family will not be overwritten.");

            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            Directory.CreateDirectory(Path.GetDirectoryName(resultPath)!);

            log.Add("Source: " + source);
            log.Add("Output: " + output);
            log.Add("Opening family through native Revit 2026 API.");

            doc = uiapp.Application.OpenDocumentFile(source);
            if (!doc.IsFamilyDocument)
                throw new InvalidOperationException("Uploaded file did not open as a Revit family document.");

            FamilyManager fm = doc.FamilyManager;
            if (fm.CurrentType == null)
                throw new InvalidOperationException("Family has no current type to store parameter defaults.");

            double width;
            double length;
            bool widthInstance;
            bool lengthInstance;

            using (Transaction tx = new(doc, "LIBER: expose elevator Width + Length"))
            {
                if (tx.Start() != TransactionStatus.Started)
                    throw new InvalidOperationException("Could not start Revit family transaction.");

                try
                {
                    RepairFamily(doc, log, out width, out length, out widthInstance, out lengthInstance);
                    if (tx.Commit() != TransactionStatus.Committed)
                        throw new InvalidOperationException("Revit did not commit the family repair.");
                }
                catch
                {
                    try { if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack(); } catch { }
                    throw;
                }
            }

            SaveAsOptions save = new()
            {
                OverwriteExistingFile = true,
                MaximumBackups = 1,
                Compact = true
            };
            doc.SaveAs(output, save);
            log.Add("Saved validated Revit 2026 family.");
            log.Add("Width is " + (widthInstance ? "INSTANCE" : "TYPE") + " editable.");
            log.Add("Length is " + (lengthInstance ? "INSTANCE" : "TYPE") + " editable.");

            doc.Close(false);
            doc = null;

            var result = new ResultFile
            {
                Ok = true,
                OutputPath = output,
                WidthMm = Math.Round(width * MmPerFt, 1),
                LengthMm = Math.Round(length * MmPerFt, 1),
                Log = log
            };
            WriteResult(resultPath, result);
            MoveJobAside(jobPath);

            try { uiapp.OpenAndActivateDocument(output); }
            catch (Exception ex) { log.Add("Saved successfully, but could not auto-open output: " + ex.Message); }

            TaskDialog.Show("Elevator family ready",
                "Width and Length were exposed and flex-tested.\n\n" +
                Path.GetFileName(output) + "\n\n" +
                "Original family was not overwritten.");
        }
        catch (Exception ex)
        {
            try { doc?.Close(false); } catch { }
            log.Add("FAILED: " + ex.Message);
            log.Add(ex.ToString());

            string resultPath = job?.ResultPath;
            if (string.IsNullOrWhiteSpace(resultPath))
                resultPath = Path.Combine(Path.GetTempPath(), "LIBER_ELEVATOR_ONESHOT_RESULT.json");

            try
            {
                WriteResult(Path.GetFullPath(resultPath), new ResultFile
                {
                    Ok = false,
                    Error = ex.Message,
                    Log = log
                });
            }
            catch { }

            MoveJobAside(jobPath);
            try
            {
                TaskDialog.Show("Elevator family was not changed",
                    ex.Message + "\n\nThe original RFA was left untouched.");
            }
            catch { }
        }
    }

    private static void RepairFamily(
        Document doc,
        List<string> log,
        out double width,
        out double length,
        out bool widthInstance,
        out bool lengthInstance)
    {
        List<ReferencePlane> planes = new FilteredElementCollector(doc)
            .OfClass(typeof(ReferencePlane))
            .Cast<ReferencePlane>()
            .ToList();

        log.Add("Reference planes: " + planes.Count);

        ReferencePlane? left = NamedPlane(planes, "Left", "Gauche");
        ReferencePlane? right = NamedPlane(planes, "Right", "Droite");
        ReferencePlane? front = NamedPlane(planes, "Front", "Avant");
        ReferencePlane? back = NamedPlane(planes, "Back", "Rear", "Arriere", "Arrière");

        if (left == null || right == null)
        {
            (left, right) = ChooseOuterPair(planes, 'x');
        }
        if (front == null || back == null)
        {
            (back, front) = ChooseOuterPair(planes, 'y');
        }

        if (left == null || right == null || front == null || back == null)
            throw new InvalidOperationException(
                "Could not resolve Gauche/Droite/Avant/Arrière footprint reference planes. Found: " +
                string.Join(", ", planes.Select(p => p.Name)));

        width = PlaneDistance(left, right);
        length = PlaneDistance(front, back);
        if (width <= TolFt || length <= TolFt)
            throw new InvalidOperationException("Resolved elevator footprint is degenerate.");

        log.Add($"Footprint: {left.Name} ↔ {right.Name} = {width * MmPerFt:0.0} mm; " +
                $"{back.Name} ↔ {front.Name} = {length * MmPerFt:0.0} mm.");

        ViewPlan view = GetPlanView(doc)
            ?? throw new InvalidOperationException("Family has no usable plan view for controlling dimensions.");
        log.Add("Dimension view: " + view.Name);

        int locks = 0;
        foreach (ReferencePlane rp in new[] { left, right, front, back })
            locks += LockCoincidentFaces(doc, view, rp);
        log.Add($"Added {locks} new outer-face alignment lock(s); existing locks were preserved.");

        Dimension wdim = FindDimension(doc, left, right)
            ?? CreateDimension(doc, view, left, right, length);
        Dimension ldim = FindDimension(doc, front, back)
            ?? CreateDimension(doc, view, front, back, width);

        FamilyManager fm = doc.FamilyManager;
        FamilyParameter wparam = EnsureParameterForDimension(fm, wdim, "Width", width, log);
        FamilyParameter lparam = EnsureParameterForDimension(fm, ldim, "Length", length, log);

        doc.Regenerate();

        char widthAxis = PlaneAxis(left);
        char lengthAxis = PlaneAxis(front);
        if (widthAxis == lengthAxis)
            throw new InvalidOperationException("Width and Length reference planes resolved to the same model axis.");

        if (!FlexTest(doc, fm, wparam, width, widthAxis, (left, right), (front, back), log))
            throw new InvalidOperationException("Width parameter did not physically flex the family. Repair was rolled back.");
        if (!FlexTest(doc, fm, lparam, length, lengthAxis, (front, back), (left, right), log))
            throw new InvalidOperationException("Length parameter did not physically flex the family. Repair was rolled back.");

        widthInstance = wparam.IsInstance;
        lengthInstance = lparam.IsInstance;
    }

    private static ReferencePlane? NamedPlane(IEnumerable<ReferencePlane> planes, params string[] names)
    {
        HashSet<string> wanted = names.Select(Norm).ToHashSet();
        ReferencePlane? exact = planes.FirstOrDefault(p => wanted.Contains(Norm(p.Name)));
        if (exact != null) return exact;
        return planes.FirstOrDefault(p => wanted.Any(k => Norm(p.Name).Contains(k, StringComparison.Ordinal)));
    }

    private static (ReferencePlane? A, ReferencePlane? B) ChooseOuterPair(List<ReferencePlane> planes, char axis)
    {
        var rows = new List<(double C, ReferencePlane P)>();
        foreach (ReferencePlane rp in planes)
        {
            try
            {
                XYZ d = HorizontalUnit(rp.Direction);
                XYZ o = rp.GetPlane().Origin;
                if (axis == 'x' && Math.Abs(d.Y) >= Math.Abs(d.X) * 2.0)
                    rows.Add((o.X, rp));
                else if (axis == 'y' && Math.Abs(d.X) >= Math.Abs(d.Y) * 2.0)
                    rows.Add((o.Y, rp));
            }
            catch { }
        }
        if (rows.Count < 2) return (null, null);
        rows.Sort((a, b) => a.C.CompareTo(b.C));
        return (rows[0].P, rows[^1].P);
    }

    private static double PlaneDistance(ReferencePlane a, ReferencePlane b)
    {
        Plane p1 = a.GetPlane();
        Plane p2 = b.GetPlane();
        XYZ n = HorizontalUnit(p1.Normal);
        return Math.Abs((p2.Origin - p1.Origin).DotProduct(n));
    }

    private static char PlaneAxis(ReferencePlane rp)
    {
        XYZ n = HorizontalUnit(rp.GetPlane().Normal);
        return Math.Abs(n.X) >= Math.Abs(n.Y) ? 'x' : 'y';
    }

    private static XYZ HorizontalUnit(XYZ v)
    {
        XYZ h = new(v.X, v.Y, 0.0);
        if (h.GetLength() < 1e-9)
            throw new InvalidOperationException("Reference-plane normal/direction is not horizontal.");
        return h.Normalize();
    }

    private static ViewPlan? GetPlanView(Document doc)
    {
        List<ViewPlan> views = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewPlan))
            .Cast<ViewPlan>()
            .Where(v => !v.IsTemplate)
            .ToList();

        ViewPlan? preferred = views.FirstOrDefault(v =>
        {
            string n = Norm(v.Name);
            return (n.Contains("ref") || n.Contains("niveau") || n.Contains("level")) &&
                   (v.ViewType == ViewType.FloorPlan || v.ViewType == ViewType.CeilingPlan);
        });
        return preferred ?? views.FirstOrDefault(v =>
            v.ViewType == ViewType.FloorPlan || v.ViewType == ViewType.CeilingPlan)
            ?? views.FirstOrDefault();
    }

    private static Dimension? FindDimension(Document doc, ReferencePlane a, ReferencePlane b)
    {
        HashSet<long> target = new() { a.Id.Value, b.Id.Value };
        foreach (Dimension d in new FilteredElementCollector(doc).OfClass(typeof(Dimension)).Cast<Dimension>())
        {
            try
            {
                ReferenceArray refs = d.References;
                var ids = new List<long>();
                foreach (Reference r in refs) ids.Add(r.ElementId.Value);
                if (ids.Count == 2 && target.SetEquals(ids)) return d;
            }
            catch { }
        }
        return null;
    }

    private static Dimension CreateDimension(Document doc, ViewPlan view, ReferencePlane a, ReferencePlane b, double otherSpan)
    {
        Plane p1 = a.GetPlane();
        Plane p2 = b.GetPlane();
        XYZ n = HorizontalUnit(p1.Normal);
        XYZ t = HorizontalUnit(a.Direction);
        double signed = (p2.Origin - p1.Origin).DotProduct(n);
        if (Math.Abs(signed) < TolFt)
            throw new InvalidOperationException("Reference planes are coincident.");

        double span = Math.Abs(signed);
        double offset = Math.Max(Math.Max(span, otherSpan), 2.0) * 0.70;
        double z = view.GenLevel?.Elevation ?? 0.0;
        XYZ start = new(p1.Origin.X + t.X * offset, p1.Origin.Y + t.Y * offset, z);
        XYZ end = new(start.X + n.X * signed, start.Y + n.Y * signed, z);
        ReferenceArray ra = new();
        ra.Append(a.GetReference());
        ra.Append(b.GetReference());
        return doc.FamilyCreate.NewLinearDimension(view, Line.CreateBound(start, end), ra);
    }

    private static FamilyParameter? FamilyParameterByName(FamilyManager fm, string name)
    {
        string key = Norm(name);
        return fm.GetParameters().FirstOrDefault(p => Norm(p.Definition.Name) == key);
    }

    private static FamilyParameter EnsureParameterForDimension(
        FamilyManager fm, Dimension dim, string name, double span, List<string> log)
    {
        FamilyParameter? existingLabel = null;
        try { existingLabel = dim.FamilyLabel; } catch { }

        FamilyParameter? target = FamilyParameterByName(fm, name);

        if (existingLabel != null)
        {
            string oldName = existingLabel.Definition.Name;
            if (target == null && Norm(oldName) != Norm(name))
            {
                fm.RenameParameter(existingLabel, name);
                target = existingLabel;
                log.Add($"Renamed existing controlling parameter {oldName} → {name}.");
            }
            else if (Norm(oldName) == Norm(name))
            {
                target = existingLabel;
            }
        }

        if (target == null)
        {
            target = fm.AddParameter(name, GroupTypeId.Constraints, SpecTypeId.Length, true);
            log.Add($"Added instance parameter {name}.");
        }

        if (existingLabel == null || Norm(existingLabel.Definition.Name) != Norm(target.Definition.Name))
        {
            if (existingLabel != null && Norm(existingLabel.Definition.Name) != Norm(name))
                throw new InvalidOperationException(
                    $"{name} dimension is already driven by {existingLabel.Definition.Name}; refusing destructive relabel.");

            dim.FamilyLabel = target;
            log.Add($"Labeled controlling dimension with {name}.");
        }

        if (!target.IsInstance)
        {
            try
            {
                fm.MakeInstance(target);
                log.Add($"Converted {name} to an instance parameter.");
            }
            catch (Exception ex)
            {
                log.Add($"{name} remains type-based because Revit would not convert it: {ex.Message}");
            }
        }

        if (!string.IsNullOrWhiteSpace(target.Formula))
            throw new InvalidOperationException(
                $"{name} is formula-driven ({target.Formula}); refusing to silently break the formula.");

        fm.Set(target, span);
        return target;
    }

    private static int LockCoincidentFaces(Document doc, ViewPlan view, ReferencePlane rp)
    {
        Plane plane = rp.GetPlane();
        XYZ n = plane.Normal.Normalize();
        int made = 0;

        foreach (GenericForm form in new FilteredElementCollector(doc)
                     .OfClass(typeof(GenericForm)).Cast<GenericForm>())
        {
            foreach (PlanarFace face in SolidFaces(form))
            {
                try
                {
                    XYZ fn = face.FaceNormal.Normalize();
                    if (Math.Abs(Math.Abs(fn.DotProduct(n)) - 1.0) > 1e-4) continue;
                    double dist = Math.Abs((face.Origin - plane.Origin).DotProduct(n));
                    if (dist > FaceTolFt) continue;
                    doc.FamilyCreate.NewAlignment(view, rp.GetReference(), face.Reference);
                    made++;
                }
                catch
                {
                    // Duplicate or pre-existing constraints are intentionally preserved.
                }
            }
        }
        return made;
    }

    private static IEnumerable<PlanarFace> SolidFaces(Element element)
    {
        Options opt = new() { ComputeReferences = true };
        GeometryElement? geo = null;
        try { geo = element.get_Geometry(opt); } catch { }
        if (geo == null) yield break;

        foreach (GeometryObject obj in geo)
        {
            if (obj is not Solid solid || solid.Volume <= 1e-10) continue;
            foreach (Face face in solid.Faces)
                if (face is PlanarFace pf && pf.Reference != null)
                    yield return pf;
        }
    }

    private static BoxSize? ModelBox(Document doc)
    {
        BoxSize? direct = BoxFor(
            new FilteredElementCollector(doc).OfClass(typeof(GenericForm))
                .Cast<GenericForm>().Where(f => f.IsSolid).Cast<Element>());
        if (direct is { Count: > 0 }) return direct;

        var fallback = new List<Element>();
        fallback.AddRange(new FilteredElementCollector(doc).OfClass(typeof(FamilyInstance)).Cast<Element>());
        fallback.AddRange(new FilteredElementCollector(doc).OfClass(typeof(Wall)).Cast<Element>());
        return BoxFor(fallback);
    }

    private static BoxSize? BoxFor(IEnumerable<Element> elements)
    {
        double minX = double.PositiveInfinity, minY = double.PositiveInfinity, minZ = double.PositiveInfinity;
        double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity, maxZ = double.NegativeInfinity;
        int count = 0;
        var seen = new HashSet<long>();

        foreach (Element e in elements)
        {
            if (!seen.Add(e.Id.Value)) continue;
            try
            {
                BoundingBoxXYZ? b = e.get_BoundingBox(null);
                if (b == null) continue;
                double[] vals = { b.Min.X, b.Min.Y, b.Min.Z, b.Max.X, b.Max.Y, b.Max.Z };
                if (vals.Any(v => double.IsNaN(v) || double.IsInfinity(v))) continue;
                minX = Math.Min(minX, b.Min.X); minY = Math.Min(minY, b.Min.Y); minZ = Math.Min(minZ, b.Min.Z);
                maxX = Math.Max(maxX, b.Max.X); maxY = Math.Max(maxY, b.Max.Y); maxZ = Math.Max(maxZ, b.Max.Z);
                count++;
            }
            catch { }
        }

        return count == 0 ? null : new BoxSize(maxX - minX, maxY - minY, maxZ - minZ, count);
    }

    private static bool FlexTest(
        Document doc,
        FamilyManager fm,
        FamilyParameter parameter,
        double original,
        char axis,
        (ReferencePlane A, ReferencePlane B) driven,
        (ReferencePlane A, ReferencePlane B) cross,
        List<string> log)
    {
        BoxSize before = ModelBox(doc)
            ?? throw new InvalidOperationException("Could not measure model geometry before flex test.");

        double drivenBefore = PlaneDistance(driven.A, driven.B);
        double crossBefore = PlaneDistance(cross.A, cross.B);
        double delta = Math.Max(original * 0.10, 100.0 / MmPerFt);

        fm.Set(parameter, original + delta);
        doc.Regenerate();

        BoxSize after = ModelBox(doc)
            ?? throw new InvalidOperationException("Could not measure model geometry after flex test.");
        double drivenAfter = PlaneDistance(driven.A, driven.B);
        double crossAfter = PlaneDistance(cross.A, cross.B);

        fm.Set(parameter, original);
        doc.Regenerate();

        double bboxChanged = axis == 'x' ? after.X - before.X : after.Y - before.Y;
        double bboxCross = axis == 'x' ? after.Y - before.Y : after.X - before.X;
        double drivenChanged = drivenAfter - drivenBefore;
        double crossChanged = crossAfter - crossBefore;

        log.Add($"{parameter.Definition.Name} flex: requested +{delta * MmPerFt:0.0} mm; " +
                $"control refs {drivenChanged * MmPerFt:+0.0;-0.0;0.0} mm; " +
                $"model {char.ToUpperInvariant(axis)} {bboxChanged * MmPerFt:+0.0;-0.0;0.0} mm; " +
                $"perpendicular refs {crossChanged * MmPerFt:+0.0;-0.0;0.0} mm; " +
                $"bbox cross {bboxCross * MmPerFt:+0.0;-0.0;0.0} mm.");

        if (Math.Abs(drivenChanged - delta) > Math.Max(2.0 / MmPerFt, delta * 0.03))
            return false;
        if (Math.Abs(crossChanged) > Math.Max(2.0 / MmPerFt, delta * 0.03))
            return false;
        if (bboxChanged < Math.Max(delta * 0.35, 20.0 / MmPerFt))
            return false;
        return true;
    }

    private static string Norm(string? value)
    {
        string s = (value ?? "").ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var b = new StringBuilder(s.Length);
        foreach (char c in s)
        {
            UnicodeCategory cat = CharUnicodeInfo.GetUnicodeCategory(c);
            if (cat != UnicodeCategory.NonSpacingMark) b.Append(c);
        }
        return b.ToString().Trim().Normalize(NormalizationForm.FormC);
    }

    private static void WriteResult(string path, ResultFile result)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static void WriteEmergencyFailure(string jobPath, string error)
    {
        try
        {
            Job? job = JsonSerializer.Deserialize<Job>(File.ReadAllText(jobPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (job != null && !string.IsNullOrWhiteSpace(job.ResultPath))
                WriteResult(job.ResultPath, new ResultFile { Ok = false, Error = error, Log = new() { error } });
        }
        catch { }
        MoveJobAside(jobPath);
    }

    private static void MoveJobAside(string jobPath)
    {
        try
        {
            string done = jobPath + ".done";
            if (File.Exists(done)) File.Delete(done);
            File.Move(jobPath, done);
        }
        catch { }
    }

    private static void TryDelete(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }
}
