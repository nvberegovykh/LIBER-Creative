using Autodesk.Revit.DB;
using System.Security.Cryptography;
using System.Text;

namespace Liber.Revex.Revit.Services;

public static class CentralModelBindingService
{
    public static string ResolveDocumentFingerprint(Document doc)
    {
        string central = ResolveCentralPath(doc).Trim().Replace('\\', '/').ToUpperInvariant();
        string uniqueId = doc.ProjectInformation?.UniqueId?.Trim() ?? "";
        string seed = uniqueId + "\n" + central;
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
        return "revitdoc_" + Convert.ToHexString(hash).ToLowerInvariant()[..24];
    }

    public static string ResolveCentralPath(Document doc)
    {
        if (doc.IsWorkshared)
        {
            try
            {
                ModelPath central = doc.GetWorksharingCentralModelPath();
                string visible = ModelPathUtils.ConvertModelPathToUserVisiblePath(central);
                if (!string.IsNullOrWhiteSpace(visible))
                    return visible;
            }
            catch
            {
                // A detached/local document can report worksharing without a reachable central.
            }
        }

        return doc.PathName ?? "";
    }
}
