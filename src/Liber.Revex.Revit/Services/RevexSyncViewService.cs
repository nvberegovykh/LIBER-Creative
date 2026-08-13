using Autodesk.Revit.DB;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Creates a temporary, unsectioned 3D view for a complete REVEX propagation pass.
/// The containing TransactionGroup is rolled back after export, so the RVT keeps no
/// helper view, parameters, or other synchronization artifacts.
/// </summary>
public sealed class RevexSyncViewScope : IDisposable
{
    private readonly TransactionGroup _group;
    private bool _disposed;

    internal RevexSyncViewScope(View3D view, TransactionGroup group)
    {
        View = view;
        _group = group;
    }

    public View3D View { get; }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            if (_group.GetStatus() == TransactionStatus.Started)
                _group.RollBack();
        }
        catch
        {
            try { _group.RollBack(); } catch { }
        }
        _group.Dispose();
    }
}

public static class RevexSyncViewService
{
    public static RevexSyncViewScope Create(Document doc)
    {
        ViewFamilyType? type = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewFamilyType))
            .Cast<ViewFamilyType>()
            .FirstOrDefault(v => v.ViewFamily == ViewFamily.ThreeDimensional);

        if (type == null)
            throw new InvalidOperationException("This Revit project has no 3D view family type available for REVEX sync.");

        var group = new TransactionGroup(doc, "REVEX temporary synchronization view");
        group.Start();
        try
        {
            View3D view;
            using (var tx = new Transaction(doc, "Create REVEX synchronization view"))
            {
                tx.Start();
                view = View3D.CreateIsometric(doc, type.Id);
                view.Name = $"REVEX_SYNC_{Guid.NewGuid():N}";
                view.DetailLevel = ViewDetailLevel.Fine;

                // The sync view is a render/model-delivery view, not an authoring-analysis view.
                // Keep physical Revit/Revit-link geometry while removing CAD references,
                // spatial volumes and analytical display objects that otherwise distort fit
                // and pollute the browser model with authoring-only primitives.
                try { view.AreAnalyticalModelCategoriesHidden = true; } catch { }
                try { view.AreImportCategoriesHidden = true; } catch { }
                try { view.ArePointCloudsHidden = true; } catch { }
                foreach (BuiltInCategory bic in new[]
                {
                    BuiltInCategory.OST_Rooms,
                    BuiltInCategory.OST_MEPSpaces,
                    BuiltInCategory.OST_Areas
                })
                {
                    try
                    {
                        Category? category = Category.GetCategory(doc, bic);
                        if (category != null && view.CanCategoryBeHidden(category.Id))
                            view.SetCategoryHidden(category.Id, true);
                    }
                    catch { }
                }

                tx.Commit();
            }
            return new RevexSyncViewScope(view, group);
        }
        catch
        {
            try { group.RollBack(); } catch { }
            group.Dispose();
            throw;
        }
    }
}
