#!/usr/bin/env python3
from pathlib import Path

p = Path('server/revex-energy-worker/revex_energy_identity_normalizer.py')
s = p.read_text(encoding='utf-8')

old = """LOCALITY = re.compile(\n    r\"\\b([A-Za-z][A-Za-z .'-]{1,60}?)\\s*,?\\s+([A-Za-z]{2})\\s+(\\d{5}(?:-\\d{4})?)\\b\",\n    re.I,\n)\nSTATE_ZIP = re.compile(r\"\\b([A-Za-z]{2})\\s+(\\d{5}(?:-\\d{4})?)\\b\", re.I)\n"""
new = """LOCALITY = re.compile(\n    r\"\\b([A-Za-z][A-Za-z .'-]{1,60}?)\\s*,?\\s+([A-Za-z]{2})\\s*,?\\s*(\\d{5}(?:-\\d{4})?)\\b\",\n    re.I,\n)\nSTATE_ZIP = re.compile(r\"\\b([A-Za-z]{2})\\s*,?\\s*(\\d{5}(?:-\\d{4})?)\\b\", re.I)\nCOMMA_PROJECT_LOCALITY = re.compile(\n    r\",\\s*(?P<city>[A-Za-z][A-Za-z .'-]{1,60}?)\\s*,\\s*(?P<state>[A-Za-z]{2})\\s*,?\\s*(?P<zip>\\d{5}(?:-\\d{4})?)\\b\",\n    re.I,\n)\n"""
if old not in s:
    raise SystemExit('r90 regex anchor not found')
s = s.replace(old, new, 1)

old = """    # Common full-address case with no comma/newline between street and city.\n    full = FULL_ADDRESS_LOCALITY.match(source)\n"""
new = """    # Deterministic titleblock header form: STREET, CITY, STATE[, ]ZIP.\n    # This is intentionally dumb and bounded: the first comma after the verified project\n    # street starts city, the next comma starts state, and ZIP is the following 5 digits.\n    comma = COMMA_PROJECT_LOCALITY.search(source)\n    if comma:\n        parsed = _candidate(comma.group('city'), comma.group('state'), comma.group('zip'))\n        if parsed:\n            return parsed\n\n    # Common full-address case with no comma/newline between street and city.\n    full = FULL_ADDRESS_LOCALITY.match(source)\n"""
if old not in s:
    raise SystemExit('r90 parse anchor not found')
s = s.replace(old, new, 1)

old = """    source = flat(raw)\n    full = FULL_ADDRESS_LOCALITY.match(source)\n"""
new = """    source = flat(raw)\n    comma = COMMA_PROJECT_LOCALITY.search(source)\n    if comma:\n        return source[:comma.start()].strip(' ,;:-')\n    full = FULL_ADDRESS_LOCALITY.match(source)\n"""
if old not in s:
    raise SystemExit('r90 street-part anchor not found')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')

# Extend deterministic QA with both comma layouts actually emitted by titleblocks/PDF text.
q = Path('server/revex-energy-worker/verify_identity_normalizer.py')
t = q.read_text(encoding='utf-8')
anchor = "if __name__ == '__main__':\n"
insert = """# r90 deterministic project-header cases\nfor raw in (\n    '250 MIDWOOD STREET, BROOKLYN, NY 11225',\n    '250 MIDWOOD STREET, BROOKLYN, NY, 11225',\n    '79 WINTHROP STREET, BROOKLYN, NY 11225',\n):\n    parsed = normalizer.parse_locality(raw)\n    assert parsed == {'city': 'BROOKLYN', 'state': 'NY', 'zip': '11225'}, (raw, parsed)\n    street = normalizer._street_part(raw)\n    assert street.startswith(raw.split(',')[0]), (raw, street)\nprint('REVEX_R90_DETERMINISTIC_PROJECT_HEADER=PASSED')\n\n"""
if insert not in t:
    if anchor not in t:
        raise SystemExit('r90 QA anchor not found')
    t = t.replace(anchor, insert + anchor, 1)
    q.write_text(t, encoding='utf-8')

print('r90 deterministic header patch applied')
