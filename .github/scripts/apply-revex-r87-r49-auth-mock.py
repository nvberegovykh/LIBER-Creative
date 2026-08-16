#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[2]
target = root / '.github/scripts/verify-revex-r49.js'
text = target.read_text(encoding='utf-8')
needle = """  const Store={\n    syncEngineeringPackage:async()=>({projectId:'revex_current',revision:'eng_current'}),\n"""
replacement = """  const Store={\n    isCloud:()=>true,\n    user:{uid:'qa-user'},\n    syncEngineeringPackage:async()=>({projectId:'revex_current',revision:'eng_current'}),\n"""
assert text.count(needle) == 1, 'Could not isolate legacy managed-Energy Store mock exactly once'
assert "user:{uid:'qa-user'}" not in text, 'Authenticated Store mock already applied'
patched = text.replace(needle, replacement, 1)
assert patched.count("isCloud:()=>true") == 1
assert patched.count("user:{uid:'qa-user'}") == 1
assert len(patched) > 10000, 'Refusing to write an unexpectedly truncated r49 QA harness'
target.write_text(patched, encoding='utf-8')
print('PASS: legacy final-gate Store mock now represents an authenticated cloud session')
