using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.DB.Mechanical;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Handles only REVEX gbXML transaction failures caused by MEP Spaces whose
/// vertical extent is invalid. Space elements are authoritative project evidence:
/// this shield never deletes, replaces, or detaches them. The only safe response is
/// to roll the owning REVEX transaction back before Revit can present a modal dialog.
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
            bool rollbackRequired = false;
            var protectedSpaceIds = new HashSet<ElementId>();

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

                var authoritativeSpaceIds = failure.GetFailingElementIds()
                    .Where(id => id != ElementId.InvalidElementId)
                    .Where(id => doc.GetElement(id) is Space)
                    .Distinct()
                    .ToList();

                if (authoritativeSpaceIds.Count == 0)
                    continue;

                foreach (ElementId id in authoritativeSpaceIds)
                    protectedSpaceIds.Add(id);
                rollbackRequired = true;
            }

            if (!rollbackRequired)
                return;

            RevexDiagnostics.Warn("GBXML",
                $"Rolling back REVEX transaction '{transaction}' because {protectedSpaceIds.Count} authoritative Space(s) " +
                "reported invalid vertical extent. No Space is deleted; the exporter will use source-geometry fallback.");
            RevexDiagnostics.Stage("GBXML", "ZERO_HEIGHT_SPACE_ROLLBACK_SHIELD", "PASSED",
                $"transaction={transaction}; protectedSpaceIds={string.Join(",", protectedSpaceIds.Select(id => id.Value))}; " +
                "authoritativeSpacesDeleted=0; transactionRolledBack=true; modalSuppressed=true; userTransactionsUntouched=true");
            args.SetProcessingResult(FailureProcessingResult.ProceedWithRollBack);
        }
        catch (Exception ex)
        {
            // Never interfere with Revit's normal failure UI if this narrowly-scoped shield itself fails.
            RevexDiagnostics.Warn("GBXML", $"Zero-height Space failure shield yielded to Revit: {ex.Message}");
        }
    }
}
