using Autodesk.Revit.DB;
using System.Text;
using System.Text.Json;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Captures the active document's native Revit schedule state as read-only Engineering evidence.
/// This is not a Design Book/Spec Book formatter: every non-template ViewSchedule is preserved
/// independently with its native field order and table cells so managed Energy can consume current
/// project facts without rediscovering them from PDFs or inheriting values from a reference project.
/// </summary>
public sealed class EngineeringScheduleEvidenceService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public string Export(Document doc, string runFolder)
    {
        if (doc == null) throw new ArgumentNullException(nameof(doc));
        if (string.IsNullOrWhiteSpace(runFolder))
            throw new InvalidOperationException("Engineering schedule evidence requires the current gbXML run folder.");

        Directory.CreateDirectory(runFolder);
        List<ViewSchedule> schedules = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSchedule))
            .Cast<ViewSchedule>()
            .Where(schedule => !schedule.IsTemplate)
            .OrderBy(schedule => schedule.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(schedule => schedule.UniqueId, StringComparer.Ordinal)
            .ToList();

        var snapshots = new List<object>();
        var failures = new List<object>();
        foreach (ViewSchedule schedule in schedules)
        {
            try
            {
                TableData table = schedule.GetTableData();
                snapshots.Add(new
                {
                    name = schedule.Name,
                    uniqueId = schedule.UniqueId,
                    isMaterialTakeoff = schedule.Definition.IsMaterialTakeoff,
                    fields = ReadFields(schedule),
                    headerRows = ReadRows(schedule, table.GetSectionData(SectionType.Header), SectionType.Header),
                    bodyRows = ReadRows(schedule, table.GetSectionData(SectionType.Body), SectionType.Body)
                });
            }
            catch (Exception ex)
            {
                failures.Add(new { name = schedule.Name, uniqueId = schedule.UniqueId, error = ex.Message });
                RevexDiagnostics.Warn("ENERGY-SCHEDULES", $"Native schedule evidence could not read '{schedule.Name}': {ex.Message}");
            }
        }

        string path = Path.Combine(runFolder, "REVIT-SCHEDULE-EVIDENCE.json");
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            schema = "liber.revex.engineering-schedule-evidence.v1",
            authority = "active-revit-document-native-schedules",
            generatedAt = DateTime.UtcNow,
            source = new
            {
                documentTitle = doc.Title,
                documentPath = doc.PathName,
                documentUniqueId = doc.ProjectInformation.UniqueId,
                documentFingerprint = CentralModelBindingService.ResolveDocumentFingerprint(doc)
            },
            scheduleCount = schedules.Count,
            capturedScheduleCount = snapshots.Count,
            failedScheduleCount = failures.Count,
            schedules = snapshots,
            failures
        }, JsonOptions), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        RevexDiagnostics.Stage("ENERGY-SCHEDULES", "EXPORT", "PASSED",
            $"source=active Revit document; schedules={schedules.Count}; captured={snapshots.Count}; failed={failures.Count}; file={path}");
        return path;
    }

    private static List<object> ReadFields(ViewSchedule schedule)
    {
        var fields = new List<object>();
        int order = 0;
        foreach (ScheduleFieldId id in schedule.Definition.GetFieldOrder())
        {
            try
            {
                ScheduleField field = schedule.Definition.GetField(id);
                fields.Add(new
                {
                    order = order++,
                    fieldId = id.ToString(),
                    name = SafeFieldName(field),
                    columnHeading = field.ColumnHeading ?? "",
                    hidden = field.IsHidden,
                    fieldType = ReadProperty(field, "FieldType"),
                    horizontalAlignment = ReadProperty(field, "HorizontalAlignment"),
                    sheetColumnWidth = field.SheetColumnWidth
                });
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Warn("ENERGY-SCHEDULES", $"Could not read a field in '{schedule.Name}': {ex.Message}");
            }
        }
        return fields;
    }

    private static List<List<string>> ReadRows(ViewSchedule schedule, TableSectionData section, SectionType sectionType)
    {
        var rows = new List<List<string>>();
        int firstRow = section.FirstRowNumber;
        int firstColumn = section.FirstColumnNumber;
        for (int row = firstRow; row < firstRow + section.NumberOfRows; row++)
        {
            var cells = new List<string>();
            for (int column = firstColumn; column < firstColumn + section.NumberOfColumns; column++)
                cells.Add(schedule.GetCellText(sectionType, row, column) ?? "");
            rows.Add(cells);
        }
        return rows;
    }

    private static string SafeFieldName(ScheduleField field)
    {
        try { return field.GetName() ?? ""; }
        catch { return ""; }
    }

    private static string ReadProperty(object source, string name)
    {
        try { return source.GetType().GetProperty(name)?.GetValue(source)?.ToString() ?? ""; }
        catch { return ""; }
    }
}
