#!/usr/bin/env python3
from pathlib import Path

p = Path('server/revex-energy-worker/revex_energy_identity_normalizer.py')
s = p.read_text(encoding='utf-8')
if 'COMMA_PROJECT_LOCALITY = re.compile(' in s:
    print('r90 deterministic header patch already applied')
    raise SystemExit(0)

old = """LOCALITY = re.compile(\n    r\"\\b([A-Za-z][A-Za-z .'-]{1,60}?)\\s*,?\\s+([A-Za-z]{2})\\s+(\\d{5}(?:-\\d{4})?)\\b\",\n    re.I,\n)\nSTATE_ZIP = re.compile(r\"\\b([A-Za-z]{2})\\s+(\\d{5}(?:-\\d{4})?)\\b\", re.I)\n"""
new = """LOCALITY = re.compile(\n    r\"\\b([A-Za-z][A-Za-z .'-]{1,60}?)\\s*,?\\s+([A-Za-z]{2})\\s*,?\\s*(\\d{5}(?:-\\d{4})?)\\b\",\n    re.I,\n)\nSTATE_ZIP = re.compile(r\"\\b([A-Za-z]{2})\\s*,?\\s*(\\d{5}(?:-\\d{4})?)\\b\", re.I)\nCOMMA_PROJECT_LOCALITY = re.compile(\n    r\",\\s*(?P<city>[A-Za-z][A-Za-z .'-]{1,60}?)\\s*,\\s*(?P<state>[A-Za-z]{2})\\s*,?\\s*(?P<zip>\\d{5}(?:-\\d{4})?)\\b\",\n    re.I,\n)\n"""
if old not in s:
    raise SystemExit('r90 regex anchor not found')
s = s.replace(old, new, 1)

old = """    # Common full-address case with no comma/newline between street and city.\n    full = FULL_ADDRESS_LOCALITY.match(source)\n"""
new = """    # Deterministic titleblock header form: STREET, CITY, STATE[, ]ZIP.\n    comma = COMMA_PROJECT_LOCALITY.search(source)\n    if comma:\n        parsed = _candidate(comma.group('city'), comma.group('state'), comma.group('zip'))\n        if parsed:\n            return parsed\n\n    # Common full-address case with no comma/newline between street and city.\n    full = FULL_ADDRESS_LOCALITY.match(source)\n"""
if old not in s:
    raise SystemExit('r90 parse anchor not found')
s = s.replace(old, new, 1)

old = """    source = flat(raw)\n    full = FULL_ADDRESS_LOCALITY.match(source)\n"""
new = """    source = flat(raw)\n    comma = COMMA_PROJECT_LOCALITY.search(source)\n    if comma:\n        return source[:comma.start()].strip(' ,;:-')\n    full = FULL_ADDRESS_LOCALITY.match(source)\n"""
if old not in s:
    raise SystemExit('r90 street-part anchor not found')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print('r90 deterministic header patch applied')
