#!/usr/bin/env python3
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / 'src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.py'
GRAPH = ROOT / 'src/Liber.Revex.Revit/Engineering/Gbxml/LIBER_gbXML_Preflight_and_Export.dyn'
VERIFY = ROOT / 'src/Liber.Revex.Revit/Engineering/Energy/verify_revex_r49_energy.py'

source = ENGINE.read_text(encoding='utf-8-sig')
marker = 'def message_counts(messages):\n'
helper = '''def reconcile_publication_message_severity(messages, publication_threshold_met):\n    """Make final message severity agree with the explicit >=80% publication contract.\n\n    Strict read-only geometry proof remains recorded in geometry_integrity. When every\n    required evidence domain clears the hard stop, that proof is a review-quality warning,\n    not a fatal error. Below the hard stop the original ERROR remains untouched.\n    """\n    if not publication_threshold_met:\n        return messages\n    for item in messages:\n        if (\n            item.get("severity") == "ERROR"\n            and item.get("code") == "REVIT_TO_GBXML_GEOMETRY_INTEGRITY_FAILED"\n        ):\n            item["severity"] = "WARNING"\n            item["original_code"] = item.get("code")\n            item["code"] = "REVIT_TO_GBXML_GEOMETRY_INTEGRITY_REVIEW"\n            item["publication_threshold_met"] = True\n            item["message"] = (\n                "Final read-only Revit-to-gbXML strict geometry proof remains below the "\n                "quality target, but every required evidence domain cleared the 80% hard "\n                "stop. The gbXML is published with this explicit review warning."\n            )\n    return messages\n\n\n'''
if 'def reconcile_publication_message_severity(' not in source:
    if marker not in source:
        raise SystemExit('message-count marker missing')
    source = source.replace(marker, helper + marker, 1)

needle = '''        if acceptable:\n            os.replace(partial_xml, final_xml)\n            report["gbxml_path"] = final_xml\n'''
replacement = '''        if acceptable:\n            reconcile_publication_message_severity(messages, publication_threshold_met)\n            os.replace(partial_xml, final_xml)\n            report["gbxml_path"] = final_xml\n'''
if 'reconcile_publication_message_severity(messages, publication_threshold_met)' not in source:
    if needle not in source:
        raise SystemExit('acceptable publication marker missing')
    source = source.replace(needle, replacement, 1)
ENGINE.write_text(source, encoding='utf-8')

graph = json.loads(GRAPH.read_text(encoding='utf-8-sig'))
python_nodes = [node for node in graph['Nodes'] if node.get('NodeType') == 'PythonScriptNode']
if len(python_nodes) != 1:
    raise SystemExit('expected exactly one gbXML Python node')
python_nodes[0]['Code'] = source
GRAPH.write_text(json.dumps(graph, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

verify = VERIFY.read_text(encoding='utf-8')
if 'import ast\n' not in verify:
    verify = verify.replace('import importlib.util\nimport io\n', 'import importlib.util\nimport ast\nimport io\n', 1)
qa_anchor = '''    missing = [str(path) for path in required if not path.is_file()]\n    if missing:\n        raise AssertionError("Missing r49 filing structure dependencies: " + ", ".join(missing))\n\n'''
qa_block = '''    missing = [str(path) for path in required if not path.is_file()]\n    if missing:\n        raise AssertionError("Missing r49 filing structure dependencies: " + ", ".join(missing))\n\n    # Accepted >=80% gbXML must not remain internally marked as failed merely because\n    # the stricter read-only proof is below the 95% review target. Exercise the exact\n    # pure helper from the Revit exporter without importing its Revit/Python.NET runtime.\n    gbxml_engine = HERE.parent / "Gbxml" / "LIBER_gbXML_Preflight_and_Export.py"\n    gbxml_graph = HERE.parent / "Gbxml" / "LIBER_gbXML_Preflight_and_Export.dyn"\n    engine_source = gbxml_engine.read_text(encoding="utf-8-sig")\n    graph = json.loads(gbxml_graph.read_text(encoding="utf-8-sig"))\n    python_nodes = [node for node in graph["Nodes"] if node.get("NodeType") == "PythonScriptNode"]\n    assert len(python_nodes) == 1 and python_nodes[0]["Code"] == engine_source, "gbXML .dyn/Python identity drift"\n    engine_ast = ast.parse(engine_source)\n    helper_node = next(\n        node for node in engine_ast.body\n        if isinstance(node, ast.FunctionDef) and node.name == "reconcile_publication_message_severity"\n    )\n    helper_module = ast.Module(body=[helper_node], type_ignores=[])\n    ast.fix_missing_locations(helper_module)\n    helper_ns: dict = {}\n    exec(compile(helper_module, str(gbxml_engine), "exec"), helper_ns)\n    reconcile_messages = helper_ns["reconcile_publication_message_severity"]\n    accepted_messages = [\n        {"severity": "ERROR", "code": "REVIT_TO_GBXML_GEOMETRY_INTEGRITY_FAILED", "message": "strict proof"},\n        {"severity": "ERROR", "code": "OTHER_FATAL", "message": "must remain fatal"},\n    ]\n    reconcile_messages(accepted_messages, True)\n    assert accepted_messages[0]["severity"] == "WARNING"\n    assert accepted_messages[0]["code"] == "REVIT_TO_GBXML_GEOMETRY_INTEGRITY_REVIEW"\n    assert accepted_messages[0]["original_code"] == "REVIT_TO_GBXML_GEOMETRY_INTEGRITY_FAILED"\n    assert accepted_messages[1]["severity"] == "ERROR"\n    blocked_messages = [{"severity": "ERROR", "code": "REVIT_TO_GBXML_GEOMETRY_INTEGRITY_FAILED"}]\n    reconcile_messages(blocked_messages, False)\n    assert blocked_messages[0]["severity"] == "ERROR", "sub-80 geometry integrity failure was incorrectly downgraded"\n\n'''
if 'Accepted >=80% gbXML must not remain internally marked as failed' not in verify:
    if qa_anchor not in verify:
        raise SystemExit('verify QA anchor missing')
    verify = verify.replace(qa_anchor, qa_block, 1)
VERIFY.write_text(verify, encoding='utf-8')

print('Applied Midwood publication-consistency fix and synchronized .dyn/Python engine.')
