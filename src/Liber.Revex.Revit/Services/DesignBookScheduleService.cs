using Autodesk.Revit.DB;
using Liber.Revex.Revit.Models;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Liber.Revex.Revit.Services;

/// <summary>
/// Read-only schedule former. It never adds parameters, renames materials or edits model schedules.
/// Design Book-classified schedules form the editable design layer. Every other project schedule
/// is exported as its own native Revit presentation snapshot. The legacy
/// {schedule,headers,rows} source shape is retained only as a compatibility projection.
/// </summary>
public sealed class DesignBookScheduleService
{
    private static readonly Regex DesignName = new(
        @"(room|material|finish|design|fixture|furniture|equipment|appliance|plumbing|lighting|door|window|casework|millwork|hardware|landscape)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public (string designBookJson, string specPushJson, int scheduleCount) Export(Document doc, View3D view, string folder)
    {
        Directory.CreateDirectory(folder);
        string rawFolder = Path.Combine(folder, "schedules");
        Directory.CreateDirectory(rawFolder);

        List<ViewSchedule> schedules = new FilteredElementCollector(doc)
            .OfClass(typeof(ViewSchedule))
            .Cast<ViewSchedule>()
            .Where(v => !v.IsTemplate)
            .OrderBy(v => v.Name)
            .ToList();

        // A schedule belongs to exactly one export lane:
        // - Design Book sources: schedules intentionally classified by the Design Book former.
        // - Spec Book sources: every other project schedule.
        // This prevents a design schedule from being duplicated into the Spec Book while ensuring
        // that all remaining project schedules form the specification source automatically.
        var designSchedules = schedules.Where(IsDesignSource).ToList();
        var designIds = designSchedules.Select(schedule => schedule.Id.Value).ToHashSet();
        var specSchedules = schedules.Where(schedule => !designIds.Contains(schedule.Id.Value)).ToList();

        var designScheduleSummaries = new List<object>();
        var specPushes = new List<object>();
        var specScheduleSummaries = new List<object>();
        var roomNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var materialLabels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int exportedDesignSchedules = 0;

        foreach (ViewSchedule schedule in designSchedules)
        {
            if (!TryReadSchedule(schedule, rawFolder, out ScheduleSnapshot snapshot))
                continue;

            string title = snapshot.Title;
            List<string> headers = snapshot.Headers;
            List<List<string>> rows = snapshot.Rows;

            string headingText = string.Join(" ", headers);
            bool material = schedule.Definition.IsMaterialTakeoff ||
                            headingText.Contains("Material", StringComparison.OrdinalIgnoreCase) ||
                            schedule.Name.Contains("Material", StringComparison.OrdinalIgnoreCase);
            bool room = schedule.Name.Contains("Room", StringComparison.OrdinalIgnoreCase) ||
                        headingText.Contains("Room", StringComparison.OrdinalIgnoreCase) ||
                        (headers.Any(h => h.Equals("Name", StringComparison.OrdinalIgnoreCase)) &&
                         headers.Any(h => h.Equals("Number", StringComparison.OrdinalIgnoreCase)));

            if (room)
                CollectRoomNames(headers, rows, roomNames);
            if (material)
                CollectMaterialLabels(headers, rows, materialLabels);

            designScheduleSummaries.Add(new
            {
                name = schedule.Name,
                uniqueId = schedule.UniqueId,
                isMaterialTakeoff = schedule.Definition.IsMaterialTakeoff,
                inferredKind = room ? "room" : material ? "material" : "design",
                headers,
                rowCount = rows.Count,
                presentation = snapshot.Presentation
            });
            exportedDesignSchedules++;
        }

        foreach (ViewSchedule schedule in specSchedules)
        {
            if (!TryReadSchedule(schedule, rawFolder, out ScheduleSnapshot snapshot))
                continue;

            specPushes.Add(new
            {
                schedule = snapshot.Title.Length > 0 ? snapshot.Title : schedule.Name,
                sourceScheduleId = schedule.UniqueId,
                headers = snapshot.Headers,
                rows = snapshot.Rows,
                presentation = snapshot.Presentation
            });

            specScheduleSummaries.Add(new
            {
                name = schedule.Name,
                uniqueId = schedule.UniqueId,
                headers = snapshot.Headers,
                rowCount = snapshot.Rows.Count,
                presentation = snapshot.Presentation
            });
        }

        // The approved 87 WINTHROP ST - DESIGN template remains the full Design Book.
        // Synced model types enrich it and form additional positions when direct design schedules
        // do not describe an item. Spec Book formation is separate and receives all non-design schedules.
        var modelGroups = CollectModelDesignGroups(doc, view, roomNames, materialLabels);
        var chapters = BuildChapters(roomNames, materialLabels, modelGroups);

        var project = new
        {
            schema = "liber.revex.designbook.v3",
            generatedAt = DateTime.UtcNow,
            source = new
            {
                documentTitle = doc.Title,
                documentPath = doc.PathName,
                documentUniqueId = doc.ProjectInformation.UniqueId,
                documentFingerprint = CentralModelBindingService.ResolveDocumentFingerprint(doc)
            },
            referenceTemplate = "87 WINTHROP ST - DESIGN",
            formation = new
            {
                strategy = "approved-template-plus-design-schedules-plus-synced-model",
                designScheduleSources = exportedDesignSchedules,
                specScheduleSources = specPushes.Count,
                specRule = "all-project-schedules-except-design-book-sources",
                syncedModelTypePositions = modelGroups.Count,
                preservesReferenceStructure = true,
                writeBackToRvt = false
            },
            chapters,
            schedules = designScheduleSummaries,
            excludedFromSpecBook = designSchedules.Select(schedule => schedule.Name).ToArray()
        };

        string designPath = Path.Combine(folder, "design-book.json");
        string specPath = Path.Combine(folder, "spec-revit-push.json");

        File.WriteAllText(designPath, JsonSerializer.Serialize(project, JsonOptions), Encoding.UTF8);
        File.WriteAllText(specPath, JsonSerializer.Serialize(new
        {
            schema = "liber.spec.revit.push.v3",
            type = "revit",
            rev = DateTime.UtcNow.ToString("O"),
            pushedAt = DateTime.UtcNow.ToString("O"),
            formation = new
            {
                rule = "all-project-schedules-except-design-book-sources",
                projectScheduleCount = schedules.Count,
                designBookScheduleCount = exportedDesignSchedules,
                specBookScheduleCount = specPushes.Count,
                scheduleStructure = "one-native-revit-presentation-per-schedule",
                compatibilityProjection = "headers-and-rows"
            },
            schedules = specScheduleSummaries,
            payload = specPushes
        }, JsonOptions), Encoding.UTF8);

        return (designPath, specPath, exportedDesignSchedules + specPushes.Count);
    }

    private static bool TryReadSchedule(ViewSchedule schedule, string rawFolder, out ScheduleSnapshot snapshot)
    {
        snapshot = new ScheduleSnapshot { Title = schedule.Name };

        string fileName = SafeFileName(schedule.Name) + ".txt";
        string rawPath = Path.Combine(rawFolder, fileName);
        try
        {
            // Keep a human-readable source artifact, but do not infer the schedule schema from it.
            schedule.Export(rawFolder, fileName, new ViewScheduleExportOptions());
        }
        catch
        {
            // Native table extraction below remains authoritative even if text export is unavailable.
        }

        try
        {
            TableData table = schedule.GetTableData();
            NativeScheduleSection header = ReadSection(schedule, table.GetSectionData(SectionType.Header), SectionType.Header);
            NativeScheduleSection body = ReadSection(schedule, table.GetSectionData(SectionType.Body), SectionType.Body);
            List<NativeScheduleField> fields = ReadFields(schedule);

            List<string> headers = fields
                .Where(field => !field.Hidden)
                .Select(field => field.ColumnHeading)
                .ToList();
            if (headers.Count == 0 && header.Rows.Count > 0)
                headers = header.Rows[^1].Cells.Select(cell => cell.Text).ToList();

            List<List<string>> rows = body.Rows
                .Select(row => row.Cells.Select(cell => cell.Text).ToList())
                .ToList();

            snapshot = new ScheduleSnapshot
            {
                Title = schedule.Name,
                Headers = headers,
                Rows = rows,
                Presentation = new NativeSchedulePresentation
                {
                    Source = "revit-table-data",
                    ScheduleName = schedule.Name,
                    ScheduleUniqueId = schedule.UniqueId,
                    IsMaterialTakeoff = schedule.Definition.IsMaterialTakeoff,
                    Fields = fields,
                    SortGroups = ReadSortGroups(schedule),
                    Definition = ReadDefinitionSettings(schedule),
                    Header = header,
                    Body = body
                }
            };
            return header.Rows.Count > 0 || body.Rows.Count > 0 || fields.Count > 0;
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("SCHEDULE", $"Native Revit table extraction failed for '{schedule.Name}': {ex.Message}");
            if (!File.Exists(rawPath)) return false;
            List<List<string>> grid = ParseDelimited(File.ReadAllText(rawPath));
            if (grid.Count == 0) return false;
            SplitGrid(grid, schedule.Name, out string title, out List<string> headers, out List<List<string>> rows);
            snapshot = new ScheduleSnapshot
            {
                Title = title,
                Headers = headers,
                Rows = rows,
                Presentation = new NativeSchedulePresentation
                {
                    Source = "revit-text-export-fallback",
                    ScheduleName = schedule.Name,
                    ScheduleUniqueId = schedule.UniqueId,
                    IsMaterialTakeoff = schedule.Definition.IsMaterialTakeoff,
                    Fields = ReadFields(schedule),
                    SortGroups = ReadSortGroups(schedule),
                    Definition = ReadDefinitionSettings(schedule)
                }
            };
            return headers.Count > 0 || rows.Count > 0;
        }
    }

    private static NativeScheduleSection ReadSection(
        ViewSchedule schedule,
        TableSectionData section,
        SectionType sectionType)
    {
        var rows = new List<NativeScheduleRow>();
        int firstRow = section.FirstRowNumber;
        int firstColumn = section.FirstColumnNumber;
        for (int row = firstRow; row < firstRow + section.NumberOfRows; row++)
        {
            var cells = new List<NativeScheduleCell>();
            for (int column = firstColumn; column < firstColumn + section.NumberOfColumns; column++)
            {
                cells.Add(new NativeScheduleCell
                {
                    ColumnIndex = column,
                    Text = schedule.GetCellText(sectionType, row, column) ?? "",
                    Merge = ReadMergedCell(section, row, column)
                });
            }
            rows.Add(new NativeScheduleRow { RowIndex = row, Cells = cells });
        }

        return new NativeScheduleSection
        {
            Section = sectionType.ToString(),
            FirstRow = firstRow,
            FirstColumn = firstColumn,
            RowCount = section.NumberOfRows,
            ColumnCount = section.NumberOfColumns,
            Rows = rows
        };
    }

    private static NativeMergedCell? ReadMergedCell(TableSectionData section, int row, int column)
    {
        try
        {
            object? merged = section.GetType().GetMethod("GetMergedCell", new[] { typeof(int), typeof(int) })?.Invoke(section, new object[] { row, column });
            if (merged == null) return null;
            return new NativeMergedCell
            {
                Top = ReadIntProperty(merged, "Top", row),
                Left = ReadIntProperty(merged, "Left", column),
                Bottom = ReadIntProperty(merged, "Bottom", row),
                Right = ReadIntProperty(merged, "Right", column)
            };
        }
        catch
        {
            return null;
        }
    }

    private static List<NativeScheduleField> ReadFields(ViewSchedule schedule)
    {
        var fields = new List<NativeScheduleField>();
        int order = 0;
        foreach (ScheduleFieldId id in schedule.Definition.GetFieldOrder())
        {
            try
            {
                ScheduleField field = schedule.Definition.GetField(id);
                fields.Add(new NativeScheduleField
                {
                    Order = order++,
                    FieldId = id.ToString(),
                    Name = SafeFieldName(field),
                    ColumnHeading = field.ColumnHeading ?? "",
                    Hidden = field.IsHidden,
                    SheetColumnWidth = field.SheetColumnWidth,
                    HorizontalAlignment = ReadPropertyText(field, "HorizontalAlignment"),
                    FieldType = ReadPropertyText(field, "FieldType")
                });
            }
            catch (Exception ex)
            {
                RevexDiagnostics.Warn("SCHEDULE", $"Could not read a field in '{schedule.Name}': {ex.Message}");
            }
        }
        return fields;
    }

    private static List<Dictionary<string, object?>> ReadSortGroups(ViewSchedule schedule)
    {
        var result = new List<Dictionary<string, object?>>();
        try
        {
            object definition = schedule.Definition;
            object? countValue = definition.GetType().GetMethod("GetSortGroupFieldCount", Type.EmptyTypes)?.Invoke(definition, null);
            int count = countValue is int value ? value : 0;
            var getter = definition.GetType().GetMethod("GetSortGroupField", new[] { typeof(int) });
            for (int index = 0; index < count; index++)
            {
                object? item = getter?.Invoke(definition, new object[] { index });
                if (item == null) continue;
                result.Add(new Dictionary<string, object?>
                {
                    ["order"] = index,
                    ["fieldId"] = ReadPropertyText(item, "FieldId"),
                    ["sortOrder"] = ReadPropertyText(item, "SortOrder"),
                    ["showHeader"] = ReadPropertyValue(item, "ShowHeader"),
                    ["showFooter"] = ReadPropertyValue(item, "ShowFooter"),
                    ["showFooterTitle"] = ReadPropertyValue(item, "ShowFooterTitle"),
                    ["showFooterCount"] = ReadPropertyValue(item, "ShowFooterCount"),
                    ["showBlankLine"] = ReadPropertyValue(item, "ShowBlankLine")
                });
            }
        }
        catch (Exception ex)
        {
            RevexDiagnostics.Warn("SCHEDULE", $"Could not read sort/group settings for '{schedule.Name}': {ex.Message}");
        }
        return result;
    }

    private static Dictionary<string, object?> ReadDefinitionSettings(ViewSchedule schedule)
    {
        object definition = schedule.Definition;
        return new Dictionary<string, object?>
        {
            ["isItemized"] = ReadPropertyValue(definition, "IsItemized"),
            ["showHeaders"] = ReadPropertyValue(definition, "ShowHeaders"),
            ["showTitle"] = ReadPropertyValue(definition, "ShowTitle"),
            ["showGrandTotal"] = ReadPropertyValue(definition, "ShowGrandTotal"),
            ["showGrandTotalTitle"] = ReadPropertyValue(definition, "ShowGrandTotalTitle"),
            ["showGrandTotalCount"] = ReadPropertyValue(definition, "ShowGrandTotalCount")
        };
    }

    private static object? ReadPropertyValue(object source, string name)
    {
        try
        {
            object? value = source.GetType().GetProperty(name)?.GetValue(source);
            return value == null || value is string || value is bool || value is int || value is long || value is double || value is decimal
                ? value
                : value.ToString();
        }
        catch
        {
            return null;
        }
    }

    private static string ReadPropertyText(object source, string name) => ReadPropertyValue(source, name)?.ToString() ?? "";

    private static int ReadIntProperty(object source, string name, int fallback)
    {
        try
        {
            object? value = source.GetType().GetProperty(name)?.GetValue(source);
            return value is int number ? number : fallback;
        }
        catch
        {
            return fallback;
        }
    }

    private static string SafeFieldName(ScheduleField field)
    {
        try { return field.GetName() ?? ""; }
        catch { return ""; }
    }

    private static bool IsDesignSource(ViewSchedule schedule)
    {
        if (schedule.Definition.IsMaterialTakeoff)
            return true;

        if (DesignName.IsMatch(schedule.Name))
            return true;

        try
        {
            string headings = string.Join(" ",
                schedule.Definition.GetFieldOrder()
                    .Select(id => schedule.Definition.GetField(id).ColumnHeading));
            return DesignName.IsMatch(headings);
        }
        catch
        {
            return false;
        }
    }

    private static void CollectRoomNames(IReadOnlyList<string> headers, IReadOnlyList<List<string>> rows, ISet<string> names)
    {
        int nameIndex = FindHeader(headers, "room name", "name", "room");
        if (nameIndex < 0)
            return;

        foreach (var row in rows)
        {
            if (nameIndex >= row.Count) continue;
            string value = row[nameIndex].Trim();
            if (value.Length > 0 && !value.Equals("Name", StringComparison.OrdinalIgnoreCase))
                names.Add(value);
        }
    }

    private static void CollectMaterialLabels(IReadOnlyList<string> headers, IReadOnlyList<List<string>> rows, ISet<string> labels)
    {
        int idx = FindHeader(headers, "material: name", "material name", "material", "description", "type", "family and type");
        if (idx < 0 && headers.Count > 0) idx = 0;

        foreach (var row in rows)
        {
            if (idx < 0 || idx >= row.Count) continue;
            string value = row[idx].Trim();
            if (value.Length > 0)
                labels.Add(value);
        }
    }

    private static List<object> BuildChapters(
        ISet<string> roomNames,
        ISet<string> materialLabels,
        IReadOnlyList<ModelDesignGroup> modelGroups)
    {
        var defaults = new[]
        {
            "FACADE", "MAIN LOBBY", "STAIRWELL", "TYPICAL CORRIDORS", "APARTMENT INTERIORS",
            "KITCHENS", "MAIN BATHROOM", "GUEST BATHROOM", "POWDER ROOM", "COMMON CELLAR",
            "LANDSCAPING", "ROOFTOP"
        };

        var chapterNames = new List<string>();
        foreach (string d in defaults)
            chapterNames.Add(d);

        foreach (string room in roomNames.OrderBy(x => x))
        {
            string c = ClassifyChapter(room);
            if (!chapterNames.Contains(c, StringComparer.OrdinalIgnoreCase))
                chapterNames.Add(c);
        }

        var materialArray = materialLabels.OrderBy(x => x).Take(500).ToArray();

        var chapters = chapterNames.Select((name, index) => (object)new
        {
            id = Slug(name),
            title = name,
            order = (index + 1) * 10,
            sourceKind = "approved-reference",
            roomAliases = roomNames.Where(r => ClassifyChapter(r).Equals(name, StringComparison.OrdinalIgnoreCase)).OrderBy(x => x).ToArray(),
            inspiration = Array.Empty<object>(),
            renders = Array.Empty<object>(),
            versions = new[]
            {
                new { id = "v1", name = "Version 1" },
                new { id = "v2", name = "Version 2" },
                new { id = "v3", name = "Version 3" }
            },
            items = TemplateItems(name).Select((item, k) => new
            {
                id = Slug(name) + "-" + Slug(item),
                label = item,
                description = "",
                source = "",
                status = "Not Selected",
                images = Array.Empty<object>(),
                comments = Array.Empty<object>(),
                candidateMaterials = CandidateMaterials(item, materialArray),
                order = (k + 1) * 10
            }).ToArray()
        }).ToList();

        int nextOrder = (chapters.Count + 1) * 10;
        foreach (var category in modelGroups
                     .GroupBy(group => group.CategoryKey)
                     .OrderBy(group => RevitCategoryClassifier.Order(group.Key))
                     .ThenBy(group => group.Key, StringComparer.OrdinalIgnoreCase))
        {
            string categoryKey = category.Key;
            string title = RevitCategoryClassifier.Title(categoryKey);
            var items = category
                .OrderBy(group => group.CategoryName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(group => group.Label, StringComparer.OrdinalIgnoreCase)
                .Select((group, index) => new
                {
                    id = $"revit-{Slug(categoryKey)}-{group.StableTypeKey}",
                    label = categoryKey == "other" ? $"{group.CategoryName} · {group.Label}" : group.Label,
                    description = $"{group.InstanceCount} synced Revit instance{(group.InstanceCount == 1 ? "" : "s")} · {group.CategoryName}",
                    source = "",
                    status = "Not Selected",
                    images = Array.Empty<object>(),
                    comments = Array.Empty<object>(),
                    candidateMaterials = group.Materials.OrderBy(value => value, StringComparer.OrdinalIgnoreCase).Take(24).ToArray(),
                    order = (index + 1) * 10,
                    revit = new
                    {
                        sourceKind = "synced-model-type",
                        categoryKey = group.CategoryKey,
                        category = group.CategoryName,
                        family = group.Family,
                        type = group.TypeName,
                        typeId = group.TypeId,
                        typeUniqueId = group.TypeUniqueId,
                        instanceCount = group.InstanceCount,
                        elementIds = group.ElementIds.Take(250).ToArray(),
                        elementIdsTruncated = group.ElementIds.Count > 250,
                        levels = group.Levels.OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToArray()
                    }
                }).ToArray();

            chapters.Add(new
            {
                id = "revit-" + Slug(categoryKey),
                title,
                order = nextOrder,
                sourceKind = "revit-model-fallback",
                roomAliases = Array.Empty<string>(),
                inspiration = Array.Empty<object>(),
                renders = Array.Empty<object>(),
                versions = new[]
                {
                    new { id = "v1", name = "Version 1" },
                    new { id = "v2", name = "Version 2" },
                    new { id = "v3", name = "Version 3" }
                },
                items
            });
            nextOrder += 10;
        }

        return chapters;
    }

    private static List<ModelDesignGroup> CollectModelDesignGroups(
        Document doc,
        View3D view,
        ISet<string> roomNames,
        ISet<string> materialLabels)
    {
        var groups = new Dictionary<string, ModelDesignGroup>(StringComparer.OrdinalIgnoreCase);

        foreach (Element element in new FilteredElementCollector(doc, view.Id)
                     .WhereElementIsNotElementType()
                     .Where(item => item.Category?.CategoryType == CategoryType.Model)
                     .Where(item => item is not View)
                     .Where(item => !IsNonDesignModelCategory(item.Category)))
        {
            try
            {
                string categoryKey = RevitCategoryClassifier.Key(element.Category);
                if (categoryKey == "rooms")
                {
                    if (!string.IsNullOrWhiteSpace(element.Name)) roomNames.Add(element.Name.Trim());
                    continue;
                }

                ElementId typeId = element.GetTypeId();
                Element? type = typeId == ElementId.InvalidElementId ? null : doc.GetElement(typeId);
                string categoryName = element.Category?.Name ?? "Other";
                string family = element is FamilyInstance instance ? instance.Symbol?.FamilyName ?? "" : "";
                string typeName = type?.Name ?? element.Name ?? categoryName;
                string label = family.Length > 0 && !family.Equals(typeName, StringComparison.OrdinalIgnoreCase)
                    ? $"{family} — {typeName}"
                    : typeName;
                string stableTypeKey = Slug(type?.UniqueId is { Length: > 0 } unique
                    ? unique
                    : $"{categoryName}-{typeId.Value}-{typeName}");
                string groupKey = $"{categoryKey}|{categoryName}|{typeId.Value}|{typeName}";

                if (!groups.TryGetValue(groupKey, out ModelDesignGroup? group))
                {
                    group = new ModelDesignGroup
                    {
                        CategoryKey = categoryKey,
                        CategoryName = categoryName,
                        Family = family,
                        TypeName = typeName,
                        Label = label,
                        StableTypeKey = stableTypeKey,
                        TypeId = typeId == ElementId.InvalidElementId ? null : typeId.Value,
                        TypeUniqueId = type?.UniqueId
                    };
                    groups[groupKey] = group;
                }

                group.InstanceCount++;
                group.ElementIds.Add(element.Id.Value);
                if (element.LevelId != ElementId.InvalidElementId && doc.GetElement(element.LevelId)?.Name is string level && level.Length > 0)
                    group.Levels.Add(level);

                foreach (Material material in element.GetMaterialIds(false)
                             .Concat(element.GetMaterialIds(true))
                             .Distinct()
                             .Select(id => doc.GetElement(id))
                             .OfType<Material>())
                {
                    if (material.Name.Length == 0) continue;
                    group.Materials.Add(material.Name);
                    materialLabels.Add(material.Name);
                }
            }
            catch
            {
                // One malformed family/type cannot prevent automatic formation.
            }
        }

        return groups.Values.ToList();
    }

    private static bool IsNonDesignModelCategory(Category? category)
    {
        if (category == null) return true;
        string name = category.Name ?? string.Empty;
        return name.Equals("Cameras", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Views", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Viewports", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Sheets", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Levels", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Grids", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Reference Planes", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Scope Boxes", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Lines", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Model Lines", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Detail Lines", StringComparison.OrdinalIgnoreCase);
    }

    private sealed class ModelDesignGroup
    {
        public string CategoryKey { get; init; } = "other";
        public string CategoryName { get; init; } = "Other";
        public string Family { get; init; } = "";
        public string TypeName { get; init; } = "";
        public string Label { get; init; } = "";
        public string StableTypeKey { get; init; } = "";
        public long? TypeId { get; init; }
        public string? TypeUniqueId { get; init; }
        public int InstanceCount { get; set; }
        public HashSet<long> ElementIds { get; } = new();
        public HashSet<string> Levels { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Materials { get; } = new(StringComparer.OrdinalIgnoreCase);
    }

    private sealed class ScheduleSnapshot
    {
        public string Title { get; init; } = "";
        public List<string> Headers { get; init; } = new();
        public List<List<string>> Rows { get; init; } = new();
        public NativeSchedulePresentation Presentation { get; init; } = new();
    }

    private sealed class NativeSchedulePresentation
    {
        public string Schema { get; init; } = "liber.revit.schedule.presentation.v1";
        public string Source { get; init; } = "";
        public string ScheduleName { get; init; } = "";
        public string ScheduleUniqueId { get; init; } = "";
        public bool IsMaterialTakeoff { get; init; }
        public List<NativeScheduleField> Fields { get; init; } = new();
        public List<Dictionary<string, object?>> SortGroups { get; init; } = new();
        public Dictionary<string, object?> Definition { get; init; } = new();
        public NativeScheduleSection Header { get; init; } = new();
        public NativeScheduleSection Body { get; init; } = new();
    }

    private sealed class NativeScheduleField
    {
        public int Order { get; init; }
        public string FieldId { get; init; } = "";
        public string Name { get; init; } = "";
        public string ColumnHeading { get; init; } = "";
        public bool Hidden { get; init; }
        public double SheetColumnWidth { get; init; }
        public string HorizontalAlignment { get; init; } = "";
        public string FieldType { get; init; } = "";
    }

    private sealed class NativeScheduleSection
    {
        public string Section { get; init; } = "";
        public int FirstRow { get; init; }
        public int FirstColumn { get; init; }
        public int RowCount { get; init; }
        public int ColumnCount { get; init; }
        public List<NativeScheduleRow> Rows { get; init; } = new();
    }

    private sealed class NativeScheduleRow
    {
        public int RowIndex { get; init; }
        public List<NativeScheduleCell> Cells { get; init; } = new();
    }

    private sealed class NativeScheduleCell
    {
        public int ColumnIndex { get; init; }
        public string Text { get; init; } = "";
        public NativeMergedCell? Merge { get; init; }
    }

    private sealed class NativeMergedCell
    {
        public int Top { get; init; }
        public int Left { get; init; }
        public int Bottom { get; init; }
        public int Right { get; init; }
    }

    private static string[] TemplateItems(string chapter)
    {
        string c = chapter.ToUpperInvariant();
        if (c.Contains("KITCHEN"))
            return new[] { "CABINETS", "HARDWARE", "COUNTERTOP", "BACKSPLASH", "KITCHEN APPLIANCES", "LIGHTING FIXTURES", "PLUMBING FIXTURES" };
        if (c.Contains("BATH") || c.Contains("POWDER"))
            return new[] { "PLUMBING FIXTURES", "FLOORING", "WALL MATERIAL", "VANITY", "LIGHTING FIXTURES", "GLASSWORK", "MIRRORS / MEDICINE CABINETS", "BATHROOM ACCESSORIES" };
        if (c.Contains("FACADE"))
            return new[] { "WINDOWS", "ENTRANCE DOOR", "FRONT FACADE FINISH", "METAL PANELS", "LIGHTING FIXTURES", "BALCONY RAILINGS", "BALCONY TILE", "SIGNAGE", "AWNING", "SIDE & BACK FACADE FINISH" };
        if (c.Contains("LANDSCAP") || c.Contains("ROOFTOP"))
            return new[] { "FENCE", "PAVERS", "PLANTERS", "LIGHTING FIXTURES" };
        if (c.Contains("STAIR"))
            return new[] { "FLOORING", "WALL MATERIAL", "LIGHTING FIXTURES", "STAIRWELL RAILINGS" };
        if (c.Contains("LOBBY"))
            return new[] { "FLOORING", "WALL MATERIAL", "MAILBOX", "LIGHTING FIXTURES", "SIGNAGE" };
        return new[] { "FLOORING", "WALL MATERIAL", "LIGHTING FIXTURES", "BASEBOARD", "DOORS / MOLDINGS", "SIGNAGE" };
    }

    private static string[] CandidateMaterials(string item, IReadOnlyList<string> materials)
    {
        string[] words = item.ToLowerInvariant().Split(new[] { ' ', '/', '&', '-' }, StringSplitOptions.RemoveEmptyEntries);
        var hits = materials.Where(m =>
        {
            string s = m.ToLowerInvariant();
            return words.Any(w => w.Length > 3 && s.Contains(w));
        }).Take(12).ToArray();

        return hits;
    }

    private static string ClassifyChapter(string room)
    {
        string s = room.ToLowerInvariant();
        if (s.Contains("lobby")) return "MAIN LOBBY";
        if (s.Contains("corridor") || s.Contains("hall")) return "TYPICAL CORRIDORS";
        if (s.Contains("stair")) return "STAIRWELL";
        if (s.Contains("kitchen")) return "KITCHENS";
        if (s.Contains("powder")) return "POWDER ROOM";
        if (s.Contains("guest") && s.Contains("bath")) return "GUEST BATHROOM";
        if (s.Contains("bath")) return "MAIN BATHROOM";
        if (s.Contains("cellar") || s.Contains("basement")) return "COMMON CELLAR";
        if (s.Contains("roof")) return "ROOFTOP";
        if (s.Contains("apartment") || s.Contains("living") || s.Contains("bedroom")) return "APARTMENT INTERIORS";
        return room.Trim().ToUpperInvariant();
    }

    private static int FindHeader(IReadOnlyList<string> headers, params string[] needles)
    {
        for (int i = 0; i < headers.Count; i++)
        {
            string h = headers[i].Trim().ToLowerInvariant();
            if (needles.Any(n => h == n || h.Contains(n)))
                return i;
        }
        return -1;
    }

    private static void SplitGrid(List<List<string>> grid, string fallback, out string title, out List<string> headers, out List<List<string>> rows)
    {
        title = "";
        headers = new();
        rows = new();

        var clean = grid.Where(r => r.Any(c => !string.IsNullOrWhiteSpace(c))).ToList();
        if (clean.Count == 0)
            return;

        int start = 0;
        if (clean[0].Count(c => !string.IsNullOrWhiteSpace(c)) == 1)
        {
            title = clean[0].First(c => !string.IsNullOrWhiteSpace(c)).Trim();
            start++;
        }

        if (start >= clean.Count)
            return;

        headers = clean[start].Select(c => c.Trim()).ToList();
        start++;

        for (int i = start; i < clean.Count; i++)
        {
            var row = clean[i].Select(c => c.Trim()).ToList();
            while (row.Count < headers.Count) row.Add("");
            if (row.Count > headers.Count) row = row.Take(headers.Count).ToList();
            rows.Add(row);
        }

        if (title.Length == 0)
            title = fallback;
    }

    private static List<List<string>> ParseDelimited(string text)
    {
        char delimiter = DetectDelimiter(text);
        var result = new List<List<string>>();
        var row = new List<string>();
        var cell = new StringBuilder();
        bool quoted = false;

        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i];
            if (quoted)
            {
                if (ch == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"')
                    {
                        cell.Append('"');
                        i++;
                    }
                    else quoted = false;
                }
                else cell.Append(ch);
            }
            else
            {
                if (ch == '"') quoted = true;
                else if (ch == delimiter)
                {
                    row.Add(cell.ToString());
                    cell.Clear();
                }
                else if (ch == '\n')
                {
                    row.Add(cell.ToString().TrimEnd('\r'));
                    cell.Clear();
                    result.Add(row);
                    row = new List<string>();
                }
                else cell.Append(ch);
            }
        }

        if (cell.Length > 0 || row.Count > 0)
        {
            row.Add(cell.ToString().TrimEnd('\r'));
            result.Add(row);
        }
        return result;
    }

    private static char DetectDelimiter(string text)
    {
        string head = string.Join("\n", text.Split('\n').Take(8));
        var counts = new Dictionary<char, int>
        {
            ['\t'] = head.Count(c => c == '\t'),
            [','] = head.Count(c => c == ','),
            [';'] = head.Count(c => c == ';')
        };
        return counts.OrderByDescending(kv => kv.Value).First().Key;
    }

    private static string SafeFileName(string name)
    {
        foreach (char c in Path.GetInvalidFileNameChars())
            name = name.Replace(c, '_');
        return name.Length > 90 ? name[..90] : name;
    }

    private static string Slug(string s) =>
        Regex.Replace(s.ToLowerInvariant(), @"[^a-z0-9]+", "-").Trim('-');

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
}
