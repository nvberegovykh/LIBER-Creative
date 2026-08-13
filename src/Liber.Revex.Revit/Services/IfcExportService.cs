using Autodesk.Revit.DB;
using System.IO;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Creates the immutable IFC authority model for each REVEX sync.
/// IFC export requires an open Revit transaction. The containing REVEX
/// TransactionGroup is rolled back after the complete sync, so committing this
/// export transaction does not leave helper/exporter changes in the RVT.
/// </summary>
public sealed class IfcExportService
{
    public string Export(Document doc, string folder)
    {
        Directory.CreateDirectory(folder);
        string requested = "model.ifc";
        string expected = Path.Combine(folder, requested);

        using var tx = new Transaction(doc, "REVEX IFC export");
        try
        {
            tx.Start();
            var options = new IFCExportOptions();
            bool ok = doc.Export(folder, requested, options);
            if (!ok)
                throw new InvalidOperationException("Revit returned false from the IFC exporter.");

            // Keep exporter-side changes stable until Document.Export has fully
            // completed. The outer REVEX TransactionGroup is rolled back later.
            TransactionStatus committed = tx.Commit();
            if (committed != TransactionStatus.Committed)
                throw new InvalidOperationException($"IFC export transaction ended with {committed}.");

            if (File.Exists(expected)) return expected;
            string? discovered = Directory.GetFiles(folder, "*.ifc", SearchOption.TopDirectoryOnly)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(discovered)) return discovered;
            throw new FileNotFoundException("Revit reported a successful IFC export but no IFC file was created.", expected);
        }
        catch (Exception ex)
        {
            try
            {
                if (tx.GetStatus() == TransactionStatus.Started)
                    tx.RollBack();
            }
            catch { }
            throw new InvalidOperationException("IFC authority export failed: " + ex.Message, ex);
        }
    }
}
