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
            var rawFailingIds = new HashSet<ElementId>();
            var protectedSpaceIds = new HashSet<ElementId>();

            foreach (FailureMessageAccessor failure in accessor.GetFailureMessages())
            {
                string description = (failure.GetDescriptionText() ?? string.Empty).Trim();
                if (!IsZeroHeightSpaceFailure(description))
                    continue;

                var failureIds = failure.GetFailingElementIds()
                    .Where(id => id != ElementId.InvalidElementId)
                    .Distinct()
                    .ToList();

                foreach (ElementId id in failureIds)
                    rawFailingIds.Add(id);

                // Failure processing can run after Revit has already discarded a transient
                // Space. In that case GetElement(id) legitimately returns null. The exact
                // failure description and the narrowly-scoped REVEX transaction name remain
                // sufficient authority to roll the isolated transaction back. Never let a
                // transient-id lookup failure escape as a modal dialog.
                foreach (ElementId id in failureIds.Where(id => doc.GetElement(id) is Space))
                    protectedSpaceIds.Add(id);
                rollbackRequired = true;
            }

            if (!rollbackRequired)
                return;

            RevexDiagnostics.Warn("GBXML",
                $"Rolling back REVEX transaction '{transaction}' because Revit reported the exact zero-height Space failure " +
                $"for {rawFailingIds.Count} failing id(s); {protectedSpaceIds.Count} still resolve to authoritative Spaces. " +
                "No Space is deleted; the exporter will use source-geometry fallback.");
            RevexDiagnostics.Stage("GBXML", "ZERO_HEIGHT_SPACE_ROLLBACK_SHIELD", "PASSED",
                $"transaction={transaction}; rawFailingIds={string.Join(",", rawFailingIds.Select(id => id.Value))}; " +
                $"protectedSpaceIds={string.Join(",", protectedSpaceIds.Select(id => id.Value))}; " +
                "authoritativeSpacesDeleted=0; transactionRolledBack=true; modalSuppressed=true; userTransactionsUntouched=true");
            args.SetProcessingResult(FailureProcessingResult.ProceedWithRollBack);
        }
        catch (Exception ex)
        {
            // Never interfere with Revit's normal failure UI if this narrowly-scoped shield itself fails.
            RevexDiagnostics.Warn("GBXML", $"Zero-height Space failure shield yielded to Revit: {ex.Message}");
        }
    }

    private static bool IsZeroHeightSpaceFailure(string description)
    {
        string normalized = (description ?? string.Empty).Trim().TrimEnd('.').Trim().ToLowerInvariant();
        return normalized == "space must have a height greater than 0" ||
               normalized == "space must have a height greater than zero";
    }
}
