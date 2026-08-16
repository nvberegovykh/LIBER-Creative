#!/usr/bin/env python3
"""Small r95 smoke gate: explicit identity must survive to the exact r49 consumer."""
from __future__ import annotations
import ast, json, re, tempfile
from pathlib import Path
import revex_user_identity_en1 as r89
import revex_identity_content_agent as r88
import revex_energy_pipeline_r69 as r69

with tempfile.TemporaryDirectory(prefix='revex-r95-boundary-') as td:
    root=Path(td)
    facts=root/'facts.json'
    facts.write_text(json.dumps({
        'structuredIdentity':{'title':'18 Example Avenue','address':'18 Example Avenue'},
        'pages':[{'pageType':'T','confidence':.99,'project':{'title':'18 Example Avenue','address':'18 Example Avenue'}},{'pageType':'Z','confidence':.98,'project':{}}]
    }),encoding='utf-8')
    req=root/'request.json'
    req.write_text(json.dumps({'revision':'eng_test','pageFactsPath':str(facts),'sourceArtifacts':[],'comcheckContext':{'identityOverride':{'city':'Brooklyn','state':'NY','zip':'11225'}}}),encoding='utf-8')
    effective=r89.resolve_request(req,root)
    effective=r88.resolve_request(effective,root)
    effective=r69._resolved_request(effective,root)
    effective=r89.resolve_request(effective,root)
    request=json.loads(effective.read_text(encoding='utf-8'))
    projected=json.loads(Path(request['pageFactsPath']).read_text(encoding='utf-8'))

    pipeline=Path(__file__).resolve().parents[2]/'src/Liber.Revex.Revit/Engineering/Energy/revex_energy_pipeline.py'
    tree=ast.parse(pipeline.read_text(encoding='utf-8'))
    wanted={'_best_page_value','current_project_identity'}
    nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in wanted]
    ns={'re':re,'REQUIRED_PROJECT_IDENTITY':('title','address','city','state','zip'),'OPTIONAL_PROJECT_IDENTITY':('houseNumber','streetName','borough','block','lot','bin','communityBoard','jobType','architecturalJobNumber','mechanicalJobNumber','plumbingJobNumber')}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(pipeline),'exec'),ns)
    identity=ns['current_project_identity'](projected)
    assert identity['missing']==[], identity
    assert (identity['city'],identity['state'],identity['zip'])==('Brooklyn','NY','11225')
    print(json.dumps({'REVEX_R95_CONSUMER_BOUNDARY':'PASSED','identity':{k:identity[k] for k in ('title','address','city','state','zip')}}))
