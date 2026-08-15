#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / 'docs/liber-apps/apps/revex/index.html'
FIREBASE = ROOT / 'docs/liber-apps/js/firebase-loader.js'

index = INDEX.read_text(encoding='utf-8')
# Initial wiring, applied only when the old marker still exists.
optional_replacements = {
    '<link rel="stylesheet" href="render-agent.css?v=20260813r49" />': '<link rel="stylesheet" href="render-agent.css?v=20260815r49-google-render1" />\n  <link rel="stylesheet" href="workspace-r51.css?v=20260815r49-workspace1" />',
    '<div><div class="eyebrow">RENDAIR + WALLT + REVIT</div><h2 id="render-dialog-title">REVEX Render</h2><p id="render-context">Current BIM view</p></div>': '<div><div class="eyebrow">GOOGLE NANO BANANA 2 + REVEX</div><h2 id="render-dialog-title">REVEX Render</h2><p id="render-context">Current BIM view</p></div>',
    '<div class="render-workspace-head"><strong>Rendair</strong><span>live workspace inside REVEX</span></div>': '<div class="render-workspace-head"><strong>Nano Banana 2</strong><span>current REVEX viewport + camera context</span></div>',
    '<div id="render-frame-empty" class="render-frame-empty">Loading the Rendair workspace…</div>': '<div id="render-frame-empty" class="render-frame-empty">Preparing the REVEX AI render workspace…</div>',
    '<script src="../../js/firebase-loader.js"></script>': '<script src="../../js/firebase-loader.js?v=20260815r49-google-oauth1"></script>',
    '<script type="module" src="render-agent.js?v=20260813r49"></script>': '<script type="module" src="workspace-r51.js?v=20260815r49-workspace1"></script>\n  <script type="module" src="render-agent.js?v=20260815r49-google-render1"></script>',
}
for old, new in optional_replacements.items():
    if old in index:
        index = index.replace(old, new, 1)

# Remove the final hidden legacy labels as well.
index = index.replace('title="Rendair workspace"', 'title="REVEX AI render workspace"')
index = index.replace('WALLT prepares this from your request and REVEX context.', 'Describe the render intent; REVEX preserves geometry and refines it for Google AI.')
index = index.replace('WALLT is ready to operate the REVEX render workflow.', 'REVEX AI Render is ready for the current viewport.')
for required in [
    'render-agent.css?v=20260815r49-google-render1',
    'workspace-r51.css?v=20260815r49-workspace1',
    'workspace-r51.js?v=20260815r49-workspace1',
    'render-agent.js?v=20260815r49-google-render1',
    'firebase-loader.js?v=20260815r49-google-oauth1',
    'GOOGLE NANO BANANA 2 + REVEX',
]:
    if required not in index:
        raise SystemExit(f'final index wiring missing: {required}')
if 'Rendair' in index or 'RENDAIR' in index:
    raise SystemExit('Rendair label remains in REVEX render HTML')
INDEX.write_text(index, encoding='utf-8')

firebase = FIREBASE.read_text(encoding='utf-8')
if firebase.count('reauthenticateWithPopup') < 3:
    import_marker = '\t\tlinkWithPopup,\n\t\tsignInWithCustomToken,'
    if import_marker not in firebase:
        raise SystemExit('Firebase auth import marker missing')
    firebase = firebase.replace(import_marker, '\t\tlinkWithPopup,\n\t\treauthenticateWithPopup,\n\t\tsignInWithCustomToken,', 1)
    for section in ['window.firebase =', 'window.firebaseModular =']:
        start = firebase.find(section)
        marker = firebase.find(import_marker, start)
        if marker < 0:
            raise SystemExit(f'Firebase exposure marker missing after {section}')
        firebase = firebase[:marker] + firebase[marker:].replace(import_marker, '\t\tlinkWithPopup,\n\t\treauthenticateWithPopup,\n\t\tsignInWithCustomToken,', 1)
if firebase.count('reauthenticateWithPopup') < 3:
    raise SystemExit('reauthenticateWithPopup was not exported through all required Firebase surfaces')
FIREBASE.write_text(firebase, encoding='utf-8')
print('Applied/verified REVEX Google renderer + Walk wiring and removed legacy Rendair labels.')
