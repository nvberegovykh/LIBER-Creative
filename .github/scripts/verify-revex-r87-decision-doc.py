from pathlib import Path

root = Path(__file__).resolve().parents[2]
text = (root / 'REVEX-ENERGY-R87-DECISION.md').read_text(encoding='utf-8')
for marker in (
    'generalized before wiring',
    'Active-Revit identity normalizer',
    'Immutable revision replay',
    'No project-specific mappings',
    'live Midwood shape retained only as a regression fixture',
):
    assert marker in text, marker
print('PASS: r87 generalized action boundary is explicit.')
