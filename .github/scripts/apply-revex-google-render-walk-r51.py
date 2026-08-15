#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / 'docs/liber-apps/apps/revex/index.html'
FIREBASE = ROOT / 'docs/liber-apps/js/firebase-loader.js'

index = INDEX.read_text(encoding='utf-8')
replacements = {
    '<link rel="stylesheet" href="render-agent.css?v=20260813r49" />': '<link rel="stylesheet" href="render-agent.css?v=20260815r49-google-render1" />\n  <link rel="stylesheet" href="workspace-r51.css?v=20260815r49-workspace1" />',
    '<div><div class="eyebrow">RENDAIR + WALLT + REVIT</div><h2 id="render-dialog-title">REVEX Render</h2><p id="render-context">Current BIM view</p></div>': '<div><div class="eyebrow">GOOGLE NANO BANANA 2 + REVEX</div><h2 id="render-dialog-title">REVEX Render</h2><p id="render-context">Current BIM view</p></div>',
    '<div class="render-workspace-head"><strong>Rendair</strong><span>live workspace inside REVEX</span></div>': '<div class="render-workspace-head"><strong>Nano Banana 2</strong><span>current REVEX viewport + camera context</span></div>',
    '<div id="render-frame-empty" class="render-frame-empty">Loading the Rendair workspace…</div>': '<div id="render-frame-empty" class="render-frame-empty">Preparing the REVEX AI render workspace…</div>',
    '<script src="../../js/firebase-loader.js"></script>': '<script src="../../js/firebase-loader.js?v=20260815r49-google-oauth1"></script>',
    '<script type="module" src="render-agent.js?v=20260813r49"></script>': '<script type="module" src="workspace-r51.js?v=20260815r49-workspace1"></script>\n  <script type="module" src="render-agent.js?v=20260815r49-google-render1"></script>',
}
for old, new in replacements.items():
    if old not in index:
        raise SystemExit(f'index marker missing: {old}')
    index = index.replace(old, new, 1)
INDEX.write_text(index, encoding='utf-8')

firebase = FIREBASE.read_text(encoding='utf-8')
# Add reauthenticateWithPopup once to the auth import and both exposed runtime objects.
import_marker = '\t\tlinkWithPopup,\n\t\tsignInWithCustomToken,'
if '\t\treauthenticateWithPopup,\n' not in firebase:
    if import_marker not in firebase:
        raise SystemExit('Firebase auth import marker missing')
    firebase = firebase.replace(import_marker, '\t\tlinkWithPopup,\n\t\treauthenticateWithPopup,\n\t\tsignInWithCustomToken,', 1)

# window.firebase exposure
compat_marker = '\t\tlinkWithPopup,\n\t\tsignInWithCustomToken,'
first = firebase.find(compat_marker, firebase.find('window.firebase ='))
if first < 0:
    raise SystemExit('Firebase compat exposure marker missing')
firebase = firebase[:first] + firebase[first:].replace(compat_marker, '\t\tlinkWithPopup,\n\t\treauthenticateWithPopup,\n\t\tsignInWithCustomToken,', 1)
# window.firebaseModular exposure
second_start = firebase.find('window.firebaseModular =')
second = firebase.find(compat_marker, second_start)
if second < 0:
    raise SystemExit('Firebase modular exposure marker missing')
firebase = firebase[:second] + firebase[second:].replace(compat_marker, '\t\tlinkWithPopup,\n\t\treauthenticateWithPopup,\n\t\tsignInWithCustomToken,', 1)

if firebase.count('reauthenticateWithPopup') < 3:
    raise SystemExit('reauthenticateWithPopup was not exported through all required Firebase surfaces')
FIREBASE.write_text(firebase, encoding='utf-8')
print('Applied REVEX Google renderer/Walk loader wiring.')
