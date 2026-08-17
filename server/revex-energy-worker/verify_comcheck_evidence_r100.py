#!/usr/bin/env python3
from __future__ import annotations
import json
import tempfile
from pathlib import Path

import revex_comcheck_evidence as r100

ZTEXT = '''
G-002.00 BC CODE ANALYSIS
PROPOSED 4 STORY W/ PENTHOUSE
OCCUPANCY GROUP: R-2
SCOPE OF WORK: Proposed 4 Story with Penthouse & Cellar residential building, Occupancy Group R-2, 9 D.U.
PROFESSIONAL STATEMENT: THESE PLANS AND SPECIFICATIONS ARE IN COMPLIANCE WITH THE 2020 NYC ENERGY CONSERVATION CODE.
Table 504.3/504.4
Building Hight above grade plane 85' 65'
Zoning analysis Area Calculation
Floor Level Use Group BC Gross Area Gross Area Deduction Area Ultra Low Energy Building 5% Deduction Zoning Floor Area FAR
CELLAR FLOOR II 2455.25 SF 0 SF 0 SF 0 SF 0 SF 0.00
1ST FLOOR II 2449.69 SF 2449.69 SF 712.98 SF 87 SF 1650 SF 0.41
2ND FLOOR II 2408.64 SF 2408.64 SF 90.81 SF 116 SF 2202 SF 0.55
3RD FLOOR II 2409.5 SF 2409.5 SF 102.17 SF 115 SF 2192 SF 0.55
4TH FLOOR II 2409.5 SF 2409.5 SF 124.17 SF 114 SF 2171 SF 0.54
PENTHOUSE II 774.32 SF 774.32 SF 163.12 SF 31 SF 581 SF 0.15
Totals: 12906.9 SF 10451.65 SF 1,193.25 SF 463 SF 8795 SF 2.20
'''
ENTEXT = 'EN-008.00 COMCHECK ENVELOPE SCHEDULE WALL W1 NORTH 1600 SF R-13 R-8 WINDOW G1 NORTH 300 SF U 0.30 SHGC 0.30 DOOR D4 NORTH 80 SF U 0.30 ROOF R1 2409 SF R-15 R-26.4 FLOOR F1 2455 SF R-13 R-8'

with tempfile.TemporaryDirectory(prefix='revex-r116-comcheck-') as td:
    root = Path(td)
    zpdf = root / 'REVIT_PAGE_T_G-002.00_BC_CODE_ANALYSIS.pdf'; zpdf.write_bytes(b'%PDF-fixture')
    enpdf = root / 'REVIT_PAGE_EN_EN-008.00_COMCHECK.pdf'; enpdf.write_bytes(b'%PDF-fixture')
    facts = root / 'facts.json'
    facts.write_text(json.dumps({
        'structuredIdentity': {'title':'18 Example Street','address':'18 Example Street','city':'Brooklyn','state':'NY','zip':'11225'},
        'pages': [
            {'pageType':'T','sheetNumber':'G-002.00','sheetName':'BC CODE ANALYSIS','sourceFile':zpdf.name,'confidence':.99,'project':{},'bulk':{}},
            {'pageType':'EN','sheetNumber':'EN-008.00','sheetName':'COMCHECK','sourceFile':enpdf.name,'confidence':.99,'project':{},'envelope':[]},
        ],
    }), encoding='utf-8')
    request = root / 'request.json'
    request.write_text(json.dumps({'revision':'eng_test','pageFactsPath':str(facts),'sourceArtifacts':[str(zpdf),str(enpdf)],'outputFolder':str(root)}), encoding='utf-8')
    texts = {zpdf.name: ZTEXT, enpdf.name: ENTEXT}
    def loader(path: Path) -> str: return texts[path.name]
    def agent(selected: list[dict]) -> dict:
        assert [row['path'].name for row in selected] == [enpdf.name]
        return {'rows': [
            {'sourceFile':enpdf.name,'kind':'wall','assemblyType':'W1','description':'CMU wall','orientation':'NORTH','grossAreaFt2':1600,'uFactor':None,'shgc':None,'cavityR':13,'continuousR':8,'confidence':.99,'evidence':'WALL W1 NORTH 1600 SF R-13 R-8'},
            {'sourceFile':enpdf.name,'kind':'window','assemblyType':'G1','description':'Window','orientation':'NORTH','grossAreaFt2':300,'uFactor':.30,'shgc':.30,'cavityR':None,'continuousR':None,'confidence':.99,'evidence':'WINDOW G1 NORTH 300 SF U 0.30 SHGC 0.30'},
            {'sourceFile':enpdf.name,'kind':'door','assemblyType':'D4','description':'Exterior door','orientation':'NORTH','grossAreaFt2':80,'uFactor':.30,'shgc':None,'cavityR':None,'continuousR':None,'confidence':.99,'evidence':'DOOR D4 NORTH 80 SF U 0.30'},
            {'sourceFile':enpdf.name,'kind':'roof','assemblyType':'R1','description':'Roof','orientation':None,'grossAreaFt2':2409,'uFactor':None,'shgc':None,'cavityR':26.4,'continuousR':15,'confidence':.99,'evidence':'ROOF R1 2409 SF R-15 R-26.4'},
            {'sourceFile':enpdf.name,'kind':'floor','assemblyType':'F1','description':'Floor','orientation':None,'grossAreaFt2':2455,'uFactor':None,'shgc':None,'cavityR':13,'continuousR':8,'confidence':.99,'evidence':'FLOOR F1 2455 SF R-13 R-8'},
        ]}
    out = r100.resolve_request(request, root, envelope_agent=agent, pdf_text_loader=loader)
    assert out != request
    derived_request = json.loads(out.read_text(encoding='utf-8'))
    derived = json.loads(Path(derived_request['pageFactsPath']).read_text(encoding='utf-8'))
    sem = derived['comcheckSemantic']
    assert sem['floorAreaFt2'] == 10451.65
    assert sem['energyCode'].lower().startswith('2020 nyc energy conservation code')
    assert sem['wholeBuildingType'] == 'MULTIFAMILY'
    t = next(page for page in derived['pages'] if page['pageType'] == 'T')
    assert t['bulk']['stories'] == 4
    assert t['bulk']['buildingHeightFt'] == 65.0
    en = next(page for page in derived['pages'] if page['pageType'] == 'EN')
    assert len(en['envelope']) == 5
    assert r100._missing_core(derived) == []
    audit = json.loads((root / 'COMCHECK_EVIDENCE_RESOLUTION_R100.json').read_text(encoding='utf-8'))
    assert audit['status'] == 'RESOLVED'
    assert audit['deterministic']['buildingHeightFt'] == 65.0
    assert audit['deterministic']['floorAreaFt2']['column'] == 'Gross Area'

# Actual G-002 code-analysis semantics: allowable/required first, provided/proposed last.
assert r100._extract_height("Table 504.3/504.4\nBuilding Hight above grade plane 85' 65'") == 65.0
assert r100._extract_height("Building Height above grade plane 85'-0\" 65'-0\"") == 65.0
# The retired fake chain must not become an authority again.
assert r100._extract_height("MAX BUILDING HEIGHT 85' 65'") is None
assert r100._extract_zoning_gross_area('Zoning analysis Area Calculation Gross Area Totals: 100 SF 90 SF') is None
assert r100._extract_zoning_gross_area(ZTEXT) == 10451.65
source = Path(r100.__file__).read_text(encoding='utf-8').upper()
assert '250 MIDWOOD' not in source
assert '79 WINTHROP' not in source
print(json.dumps({
    'REVEX_R116_COMCHECK_EVIDENCE': 'PASSED',
    'buildingHeightAuthority': 'BUILDING HEIGHT/HIGHT ABOVE GRADE PLANE + PROVIDED/PROPOSED LAST VALUE',
    'buildingHeightFixtureFt': 65.0,
    'floorAreaSource': 'Zoning analysis Area Calculation / Gross Area / Totals',
    'qaFloor': r100.MIN_CONFIDENCE,
    'projectSpecificHardcode': False,
    'sourceEvidenceMutated': False,
}))
