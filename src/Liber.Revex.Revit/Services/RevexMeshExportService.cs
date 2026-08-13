using Autodesk.Revit.DB;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Writes independently fetchable, gzip-compressed Revit tessellation pages.
/// Metadata is useful immediately while pages continue loading in the background.
/// Curtain hosts are containers only; their real panels and mullions are exported
/// as their own elements so the viewer never substitutes one host-sized box.
/// </summary>
public sealed class RevexMeshExportService
{
    private const long TargetPageRawBytes = 24L * 1024L * 1024L;
    private const double TessellationDetail = 0.35;

    public sealed record Result(
        string? Path,
        string ManifestPath,
        IReadOnlyList<string> PagePaths,
        int ElementCount,
        long TriangleCount,
        long VertexCount,
        long RawBytes,
        long CompressedBytes);

    private sealed class PageWriter : IDisposable
    {
        private readonly int _index;
        private readonly string _rawPath;
        private readonly FileStream _stream;
        private readonly BinaryWriter _writer;
        private bool _finished;
        public int ElementCount { get; private set; }
        public long TriangleCount { get; private set; }
        public long VertexCount { get; private set; }
        public long Length => _stream.Length;

        public PageWriter(string folder, int index)
        {
            _index = index;
            _rawPath = System.IO.Path.Combine(folder, $"model-page-{index:D4}.rvxmesh");
            _stream = File.Create(_rawPath);
            _writer = new BinaryWriter(_stream, Encoding.UTF8, leaveOpen: true);
            _writer.Write(Encoding.ASCII.GetBytes("RVXSCN2\0"));
            _writer.Write(2);
        }

        public void Write(byte[] record, long triangles, long vertices)
        {
            _writer.Write(record);
            ElementCount++;
            TriangleCount += triangles;
            VertexCount += vertices;
        }

        public PageResult Finish()
        {
            _writer.Write((byte)0);
            _writer.Flush();
            long rawBytes = _stream.Length;
            _writer.Dispose();
            _stream.Dispose();
            _finished = true;
            string gzipPath = _rawPath + ".gz";
            using (FileStream input = File.OpenRead(_rawPath))
            using (FileStream output = File.Create(gzipPath))
            using (var gzip = new GZipStream(output, CompressionLevel.Fastest))
                input.CopyTo(gzip);
            File.Delete(_rawPath);
            long compressedBytes = new FileInfo(gzipPath).Length;
            using FileStream hashInput = File.OpenRead(gzipPath);
            string sha = Convert.ToHexString(SHA256.HashData(hashInput)).ToLowerInvariant();
            return new PageResult(_index, gzipPath, ElementCount, TriangleCount, VertexCount, rawBytes, compressedBytes, sha);
        }

        public void Dispose()
        {
            if (_finished) return;
            try { _writer.Dispose(); } catch { }
            try { _stream.Dispose(); } catch { }
            try { if (File.Exists(_rawPath)) File.Delete(_rawPath); } catch { }
        }
    }

    private sealed record PageResult(int Index, string Path, int Elements, long Triangles, long Vertices, long RawBytes, long CompressedBytes, string Sha256);

    public Result Export(Document doc, View3D view, string folder)
    {
        string pageFolder = System.IO.Path.Combine(folder, "geometry");
        Directory.CreateDirectory(pageFolder);
        var options = new Options { View = view, IncludeNonVisibleObjects = false, ComputeReferences = false, DetailLevel = ViewDetailLevel.Fine };
        var pages = new List<PageResult>();
        int pageIndex = 1, totalElements = 0;
        long totalTriangles = 0, totalVertices = 0;
        PageWriter page = new(pageFolder, pageIndex);

        IEnumerable<Element> elements = new FilteredElementCollector(doc, view.Id)
            .WhereElementIsNotElementType()
            .Where(ViewerExportService.IsViewerRenderableElement)
            .OrderBy(element => RevitCategoryClassifier.Order(RevitCategoryClassifier.Key(element.Category)))
            .ThenBy(element => element.Id.Value);

        try
        {
            foreach (Element element in elements)
            {
                if (IsCurtainContainer(element)) continue;
                try
                {
                    GeometryElement? geometry = element.get_Geometry(options);
                    if (geometry == null) continue;
                    long fallbackMaterialId = element.GetMaterialIds(false).Concat(element.GetMaterialIds(true))
                        .Select(id => id.Value).FirstOrDefault(-1L);
                    var parts = new Dictionary<long, List<float>>();
                    long elementTriangles = 0, elementVertices = 0;
                    AccumulateGeometry(geometry, fallbackMaterialId, parts, ref elementTriangles, ref elementVertices);
                    if (parts.Count == 0) continue;
                    byte[] record = BuildRecord(element.Id.Value, parts);
                    if (page.ElementCount > 0 && page.Length + record.LongLength > TargetPageRawBytes)
                    {
                        pages.Add(page.Finish());
                        page = new PageWriter(pageFolder, ++pageIndex);
                    }
                    page.Write(record, elementTriangles, elementVertices);
                    totalElements++;
                    totalTriangles += elementTriangles;
                    totalVertices += elementVertices;
                }
                catch (Exception ex)
                {
                    RevexDiagnostics.Warn("VIEWER", $"Paged geometry skipped element {element.Id.Value}: {ex.Message}");
                }
            }
            if (page.ElementCount > 0) pages.Add(page.Finish()); else page.Dispose();
        }
        catch
        {
            page.Dispose();
            throw;
        }

        if (pages.Count == 0) throw new InvalidOperationException("The active Revit view produced no physical browser geometry pages.");
        long rawBytes = pages.Sum(row => row.RawBytes), compressedBytes = pages.Sum(row => row.CompressedBytes);
        string manifestPath = System.IO.Path.Combine(pageFolder, "model.rvxpages.json");
        File.WriteAllText(manifestPath, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.geometry-pages.v1",
            format = "rvxmesh-gzip-pages",
            binaryFormat = "RVXSCN2",
            generatedAt = DateTime.UtcNow,
            targetPageRawBytes = TargetPageRawBytes,
            tessellationDetail = TessellationDetail,
            curtainWallPolicy = "host-container-excluded-panels-and-mullions-exact",
            totals = new { pages = pages.Count, elements = totalElements, triangles = totalTriangles, vertices = totalVertices, rawBytes, compressedBytes },
            pages = pages.Select(row => new { row.Index, file = System.IO.Path.GetFileName(row.Path), row.Elements, row.Triangles, row.Vertices, row.RawBytes, row.CompressedBytes, row.Sha256 })
        }, new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
        RevexDiagnostics.Info("VIEWER", $"REVEX paged mesh complete: pages={pages.Count}; elements={totalElements}; triangles={totalTriangles}; vertices={totalVertices}; raw={rawBytes}; gzip={compressedBytes}");
        return new Result(null, manifestPath, pages.Select(row => row.Path).ToArray(), totalElements, totalTriangles, totalVertices, rawBytes, compressedBytes);
    }

    internal static bool IsCurtainContainer(Element element)
    {
        try { return element is Wall wall && wall.CurtainGrid != null; }
        catch { return false; }
    }

    private static byte[] BuildRecord(long elementId, IReadOnlyDictionary<long, List<float>> parts)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        writer.Write((byte)1);
        writer.Write((double)elementId);
        writer.Write(parts.Count);
        foreach ((long materialId, List<float> data) in parts.OrderBy(pair => pair.Key))
        {
            writer.Write((double)materialId);
            writer.Write(data.Count / 6);
            foreach (float value in data) writer.Write(value);
        }
        writer.Flush();
        return stream.ToArray();
    }

    private static void AccumulateGeometry(GeometryElement geometry, long fallbackMaterialId, Dictionary<long, List<float>> parts, ref long triangleCount, ref long vertexCount)
    {
        foreach (GeometryObject obj in geometry)
        {
            switch (obj)
            {
                case GeometryInstance instance:
                    AccumulateGeometry(instance.GetInstanceGeometry(), fallbackMaterialId, parts, ref triangleCount, ref vertexCount);
                    break;
                case Solid solid when solid.Faces.Size > 0:
                    foreach (Face face in solid.Faces)
                    {
                        long materialId = face.MaterialElementId == ElementId.InvalidElementId ? fallbackMaterialId : face.MaterialElementId.Value;
                        AccumulateMesh(face.Triangulate(TessellationDetail), materialId, parts, ref triangleCount, ref vertexCount);
                    }
                    break;
                case Mesh mesh:
                    AccumulateMesh(mesh, fallbackMaterialId, parts, ref triangleCount, ref vertexCount);
                    break;
            }
        }
    }

    private static void AccumulateMesh(Mesh mesh, long materialId, Dictionary<long, List<float>> parts, ref long triangleCount, ref long vertexCount)
    {
        if (mesh.NumTriangles <= 0) return;
        if (!parts.TryGetValue(materialId, out List<float>? data)) parts[materialId] = data = new List<float>(Math.Min(mesh.NumTriangles * 18, 1_000_000));
        for (int i = 0; i < mesh.NumTriangles; i++)
        {
            MeshTriangle tri = mesh.get_Triangle(i);
            XYZ p0 = tri.get_Vertex(0), p1 = tri.get_Vertex(1), p2 = tri.get_Vertex(2);
            XYZ cross = (p1 - p0).CrossProduct(p2 - p0);
            double length = cross.GetLength();
            if (length < 1e-12) continue;
            XYZ n = new(cross.X / length, cross.Y / length, cross.Z / length);
            AddVertex(data, p0, n); AddVertex(data, p1, n); AddVertex(data, p2, n);
            triangleCount++; vertexCount += 3;
        }
    }

    private static void AddVertex(List<float> data, XYZ point, XYZ normal)
    {
        data.Add((float)point.X); data.Add((float)point.Z); data.Add((float)-point.Y);
        data.Add((float)normal.X); data.Add((float)normal.Z); data.Add((float)-normal.Y);
    }
}
