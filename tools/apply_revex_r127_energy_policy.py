#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "src/Liber.Revex.Revit/Engineering/Energy/revex_final_touchups_r125.py"
text = path.read_text(encoding="utf-8")

replacements = [
    (
        'VERSION = "20260817r125-final-touchups1"\nVT_CLEAR_FALLBACK = 0.60\nVT_TINTED_FALLBACK = 0.30',
        'VERSION = "20260817r127-fixed-vt0451"\nMISSING_VT = 0.45\nVT_CLEAR_FALLBACK = MISSING_VT\nVT_TINTED_FALLBACK = MISSING_VT',
    ),
    (
'''            cls = reference_envelope._class_for_row(row)\n            profile = profiles.get(cls) if reference_proven else None\n            value = _number(profile.get("vt")) if isinstance(profile, dict) else None\n            if value is not None:\n                authority = "APPROVED_SAME_ENVELOPE_REFERENCE_VT"\n            else:\n                value = VT_TINTED_FALLBACK if _tinted(row) else VT_CLEAR_FALLBACK\n                authority = "CODE_FALLBACK_TINTED" if _tinted(row) else "CODE_FALLBACK_CLEAR"''',
'''            # r127 filing policy: preserve an actual VT when supplied; if VT is absent,\n            # insert one deterministic project-wide value. Do not branch on tint/reference.\n            value = MISSING_VT\n            authority = "REVEX_FIXED_MISSING_VT_0_45"''',
    ),
    (
'''        # Same-envelope approved VT is the first non-current fallback.\n        if reference_envelope is not None:\n            try:\n                profiles = reference_envelope._approved_profiles(reference_envelope._reference_path())\n                cls = reference_envelope._class_for_row(row)\n                profile = profiles.get(cls)\n                value = _number(profile.get("vt")) if isinstance(profile, dict) else None\n                if value is not None:\n                    return float(value)\n            except Exception:\n                pass\n        return VT_TINTED_FALLBACK if _tinted(row) else VT_CLEAR_FALLBACK''',
'''        # r127 filing policy: all genuinely missing VT resolves to one stable value.\n        return MISSING_VT''',
    ),
    (
        '"policy": "NATIVE_SCHEDULE_TOTAL_OVER_REGION_RESUM; ACTUAL_VT_OVER_REFERENCE_OVER_CODE_FALLBACK",',
        '"policy": "NATIVE_SCHEDULE_TOTAL_OVER_REGION_RESUM; ACTUAL_VT_ELSE_FIXED_0_45",',
    ),
]

for old, new in replacements:
    if old not in text:
        raise SystemExit(f"r127 migration refused: expected source block missing: {old[:120]!r}")
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
print("REVEX_R127_ENERGY_POLICY_APPLIED", path)
