# r54 Energy preservation note

The r54 renderer work must not alter the existing r49 Energy acceptance semantics.

The current Energy regression guard already verifies the important boundary: an Engineering gbXML package that meets the existing >=80% publication hard floor may retain strict-review findings below the >=95% quality target, and the legacy `REVIT_TO_GBXML_GEOMETRY_INTEGRITY_FAILED` marker is reconciled to `REVIT_TO_GBXML_GEOMETRY_INTEGRITY_REVIEW` only on that accepted path. Any unrelated fatal error and any below-floor geometry failure remains fatal.

This is intentionally treated as a preservation contract rather than relaxed Energy QA. GeometryCo, native OpenStudio checks, both EnergyPlus runs, official COMcheck and EN-1 completion still have to succeed downstream.
