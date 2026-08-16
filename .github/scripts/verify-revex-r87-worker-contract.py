from pathlib import Path
root = Path(__file__).resolve().parents[2]
text = (root/'server/revex-energy-worker/README_R87_GENERALIZATION.md').read_text(encoding='utf-8')
for marker in ('reusable normalization primitive','project-specific mappings','replayed server-side by project/revision','must never trigger Revit export'):
    assert marker in text, marker
print('PASS: generalized worker identity/replay contract documented.')
