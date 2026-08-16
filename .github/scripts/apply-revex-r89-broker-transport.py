#!/usr/bin/env python3
from pathlib import Path

path = Path('server/firebase-functions/index.js')
text = path.read_text(encoding='utf-8')
old = "        projectSource: { name: String(project.name || ''), code: String(project.code || ''), filingPath: 'NYCECC_APPENDIX_CA_PRM' },"
new = """        projectSource: {
          name: String(project.name || ''), code: String(project.code || ''), filingPath: 'NYCECC_APPENDIX_CA_PRM',
          identityOverride: comcheckConsent.projectIdentityOverride || {},
          en1Applicant: comcheckConsent.en1Applicant || {},
          en1Modeler: comcheckConsent.en1Modeler || {},
          identityOverridePolicy: 'USER_PROJECT_IDENTITY_ONLY_FILLS_MISSING_REVIT_FIELDS'
        },"""
if new in text:
    print('r89 broker transport already applied')
elif old in text:
    text = text.replace(old, new, 1)
    path.write_text(text, encoding='utf-8')
    print('r89 broker transport applied')
else:
    raise SystemExit('Expected broker projectSource transport anchor was not found; refusing a speculative patch.')
