using Autodesk.Revit.DB;

namespace Liber.Revex.Revit.Services;

internal static class RevitCategoryClassifier
{
    public static string Key(Category? category)
    {
        if (category == null) return "other";
        long id = category.Id.Value;
        if (id == (long)BuiltInCategory.OST_Walls || id == (long)BuiltInCategory.OST_CurtainWallPanels) return "walls";
        if (id == (long)BuiltInCategory.OST_Doors) return "doors";
        if (id == (long)BuiltInCategory.OST_Roofs) return "roofs";
        if (id == (long)BuiltInCategory.OST_Floors) return "floors";
        if (id == (long)BuiltInCategory.OST_Windows) return "windows";
        if (id == (long)BuiltInCategory.OST_Rooms) return "rooms";
        if (id == (long)BuiltInCategory.OST_Ceilings) return "ceilings";
        if (id == (long)BuiltInCategory.OST_Stairs || id == (long)BuiltInCategory.OST_Railings) return "stairs-railings";
        if (id == (long)BuiltInCategory.OST_Furniture) return "furniture";
        if (id == (long)BuiltInCategory.OST_Casework) return "casework";
        if (id == (long)BuiltInCategory.OST_StructuralColumns) return "structural-columns";
        if (id == (long)BuiltInCategory.OST_StructuralFraming) return "structural-framing";
        if (id == (long)BuiltInCategory.OST_MechanicalEquipment) return "mechanical-equipment";
        if (id == (long)BuiltInCategory.OST_LightingFixtures) return "lighting-fixtures";
        if (id == (long)BuiltInCategory.OST_PlumbingFixtures) return "plumbing-fixtures";
        if (id == (long)BuiltInCategory.OST_ElectricalEquipment) return "electrical-equipment";
        if (id == (long)BuiltInCategory.OST_SpecialityEquipment) return "specialty-equipment";
        if (id == (long)BuiltInCategory.OST_GenericModel) return "generic-models";
        if (id == (long)BuiltInCategory.OST_Topography) return "site";
        return "other";
    }

    public static string Title(string key) => key switch
    {
        "walls" => "Walls",
        "doors" => "Doors",
        "windows" => "Windows",
        "floors" => "Floors",
        "roofs" => "Roofs",
        "rooms" => "Rooms",
        "ceilings" => "Ceilings",
        "stairs-railings" => "Stairs & Railings",
        "furniture" => "Furniture",
        "casework" => "Casework",
        "structural-columns" => "Structural Columns",
        "structural-framing" => "Structural Framing",
        "mechanical-equipment" => "Mechanical Equipment",
        "lighting-fixtures" => "Lighting Fixtures",
        "plumbing-fixtures" => "Plumbing Fixtures",
        "electrical-equipment" => "Electrical Equipment",
        "specialty-equipment" => "Specialty Equipment",
        "generic-models" => "Generic Models",
        "site" => "Site",
        _ => "Other Model Elements"
    };

    public static int Order(string key) => key switch
    {
        "walls" => 0,
        "doors" => 1,
        "windows" => 2,
        "floors" => 3,
        "roofs" => 4,
        "rooms" => 5,
        "ceilings" => 6,
        "stairs-railings" => 7,
        "casework" => 8,
        "furniture" => 9,
        "lighting-fixtures" => 10,
        "plumbing-fixtures" => 11,
        _ => 20
    };
}
