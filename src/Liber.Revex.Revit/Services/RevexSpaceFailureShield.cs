using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.DB.Mechanical;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Handles only REVEX gbXML transaction failures caused by transient MEP Spaces
/// whose vertical extent is invalid before the exporter can normalize/recreate them.
/// It never touches user transactions or unrelated Revit failures.
/// </summary>
public static class RevexSpaceFailureShield
{
    private const string TransactionPrefix = "LIBER gbXML";

    public static void OnFailuresProcessing(object? sender, FailuresProcessingEventArgs args)
    {
        try
        {
            FailuresAccessor accessor = args.GetFailuresAccessor();
            string transaction = accessor.GetTransactionName() ?? string.Empty;
            if (!transaction.StartsWith(TransactionPrefix, StringComparison.OrdinalIgnoreCase))
                return;

            Document doc = accessor.GetDocument();
            bool handled = false;
            var deleted = new HashSet<ElementId>();

            foreach (FailureMessageAccessor failure in accessor.GetFailureMessages())
            {
                string description = (failure.GetDescriptionText() ?? string.Empty).Trim();
                string normalized = description.ToLowerInvariant();
                bool zeroHeight =
                    (normalized.Contains("space") && normalized.Contains("height") &&
                     (normalized.Contains("greater than 0") || normalized.Contains("greater than zero") ||
                      normalized.Contains("negative") || normalized.Contains("zero")));

                if (!zeroHeight)
                    continue;

                var transientSpaceIds = failure.GetFailingElementIds()
                    .Where(id => id != ElementId.InvalidElementId)
                    .Where(id => doc.GetElement(id) is Space)
                    .Distinct()
                    .ToList();

                if (transientSpaceIds.Count == 0)
                    continue;

                try
                {
                    accessor.DeleteElements(transientSpaceIds);
                    foreach (ElementId id in transientSpaceIds) deleted.Add(id);
                    handled = true;
                }
                catch (Exception ex)
                {
                    RevexDiagnostics.Warn("GBXML", $"Could not remove transient zero-height Spaces during failure processing: {ex.Message}");
                }
            }

            if (!handled)
                return;

            RevexDiagnostics.Warn("GBXML",
                $"Removed {deleted.Count} transient zero-height Space(s) before Revit could show a blocking failure dialog. " +
                "Existing Rooms/Spaces remain authoritative; bounded residual placement continues afterward.");
            RevexDiagnostics.Stage("GBXML", "ZERO_HEIGHT_SPACE_SHIELD", "PASSED",
                $"transaction={transaction}; deletedTransientSpaces={deleted.Count}; userTransactionsUntouched=true");
            args.SetProcessingResult(FailureProcessingResult.ProceedWithCommit);
        }
        catch (Exception ex)
        {
            // Never interfere with Revit's normal failure UI if this narrowly-scoped shield itself fails.
            RevexDiagnostics.Warn("GBXML", $"Zero-height Space failure shield yielded to Revit: {ex.Message}");
        }
    }
}
