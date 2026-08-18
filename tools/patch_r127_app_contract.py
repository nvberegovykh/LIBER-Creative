#!/usr/bin/env python3
from pathlib import Path

p=Path('server/revex-energy-worker/app.py')
t=p.read_text(encoding='utf-8')
old='''        if str(result_manifest.get("status") or "").upper() == "COMPLETE":
            declared_rows = list(result_manifest.get("artifacts") or [])
            declared_names = {str(row.get("name") or "") for row in declared_rows}
            required_names = {
                "BASELINE_UPDATED_GEOMETRY.osm",
                "PROPOSED_UPDATED_GEOMETRY.osm",
                "EN-1_READY_TO_INSERT.xlsx",
                "COMcheck_PROJECT_INPUT_READY.cxl",
                "COMcheck_OFFICIAL_BACKSTOP_REPORT.pdf",
                "COMcheck_BACKSTOP_RESULT.json",
            }
            missing_outputs = sorted(required_names - declared_names)
            compiled = [row for row in declared_rows if row.get("kind") == "compiled-model" and str(row.get("name") or "").lower().endswith(".osm")]
            if missing_outputs or len(compiled) != 2 or result_manifest.get("comcheck", {}).get("officialDoeReport") is not True:
                return jsonify({
                    "error": "pipeline reported COMPLETE without the strict r49 output contract",
                    "missing": missing_outputs,
                    "compiledOsmCount": len(compiled),
                }), 500
'''
new='''        if str(result_manifest.get("status") or "").upper() == "COMPLETE":
            # Current package completeness is owned by the typed Energy contract. Exact
            # filenames remain only the external package boundary defined in one module.
            energy_root = Path(str(os.environ.get("REVEX_PIPELINE_IMPL") or "/opt/revex/energy/revex_energy_pipeline.py")).resolve().parent
            if str(energy_root) not in sys.path:
                sys.path.insert(0, str(energy_root))
            try:
                from revex_energy_contracts import FilingPackage, required_complete_names
                FilingPackage.discover(run_dir).require_complete()
            except Exception as exc:
                return jsonify({"error": f"pipeline reported COMPLETE with an incomplete typed FilingPackage: {exc}"}), 500
            declared_rows = list(result_manifest.get("artifacts") or [])
            declared_names = {str(row.get("name") or "") for row in declared_rows}
            missing_outputs = sorted(required_complete_names() - declared_names)
            compiled = [row for row in declared_rows if row.get("kind") == "compiled-model" and str(row.get("name") or "").lower().endswith(".osm")]
            if missing_outputs or len(compiled) != 2 or result_manifest.get("comcheck", {}).get("officialDoeReport") is not True:
                return jsonify({
                    "error": "pipeline reported COMPLETE without the typed filing/output contract",
                    "missing": missing_outputs,
                    "compiledOsmCount": len(compiled),
                }), 500
'''
if t.count(old) != 1:
    raise SystemExit(f'expected one strict output block, found {t.count(old)}')
t=t.replace(old,new)
p.write_text(t,encoding='utf-8')
print('REVEX_R127_TYPED_PACKAGE_PATCH=PASSED')
