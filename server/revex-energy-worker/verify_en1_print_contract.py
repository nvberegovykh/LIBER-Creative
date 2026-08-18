#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import tempfile

import revex_user_identity_en1 as en1
import revex_en1_print_contract as current

current.install(en1)
assert len(current.PRINT_SHEETS) == 17, current.PRINT_SHEETS
assert current.PRINT_SHEETS[0] == "Color legend"
assert current.PRINT_SHEETS[-1] == "HVAC Air-side"
assert current.PRINT_SCALE == 63
assert en1.EN1_PRINT_SHEETS == current.PRINT_SHEETS
assert en1._print_en1_pdf is current._print_pdf

reference = Path("/opt/revex/energy/References/EN-1_79_WINTHROP_AMENDMENT.xlsx")
if not reference.is_file():
    # Source-tree execution is allowed for syntax/contract checks. The production-image
    # acceptance below always has the packaged reference and therefore performs PDF export.
    candidate = Path(__file__).resolve().parents[2] / "src/Liber.Revex.Revit/Engineering/Energy/References/EN-1_79_WINTHROP_AMENDMENT.xlsx"
    reference = candidate

exported = False
if reference.is_file():
    with tempfile.TemporaryDirectory(prefix="revex-en1-print63-verify-") as tmp:
        root = Path(tmp)
        source = root / "EN-1_READY_TO_INSERT.xlsx"
        source.write_bytes(reference.read_bytes())
        pdf = root / "EN-1_READY_TO_INSERT.pdf"
        audit = current._print_pdf(source, pdf, root)
        assert pdf.is_file() and pdf.stat().st_size > 1024
        assert audit["status"] == "PASSED"
        assert audit["pageCount"] == 17
        assert audit["expectedPageCount"] == 17
        assert audit["printScalePercent"] == 63
        assert audit["fitToPage"] is False
        assert audit["selectedSheets"] == list(current.PRINT_SHEETS)
        assert all(row.get("passed") is True for row in audit["pageMarkers"])
        exported = True

print(json.dumps({
    "schema": "liber.revex.en1-print-contract-verification.v1",
    "status": "PASSED",
    "selectedSheets": len(current.PRINT_SHEETS),
    "colorLegendFirst": True,
    "hvacAirSideLast": True,
    "printScalePercent": current.PRINT_SCALE,
    "fitToPage": False,
    "productionPdfExportVerified": exported,
}, separators=(",", ":")))
