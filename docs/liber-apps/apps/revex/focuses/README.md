# REVEX Observer focus recipes

These files define bounded, read-only Observer focus recipes for current authorized REVEX sessions.

## Rave 289 coffee area

- Authority spec: `rave-289-coffee-area.json`
- Browser recipe: `../observer-coffee-area-r147.js`
- Global after load: `window.RevexCoffeeAreaObserver`
- Start: `window.RevexCoffeeAreaObserver.start()`
- Post-output verification: `window.RevexCoffeeAreaObserver.verify(focusId, evidence)`

The recipe never mutates Revit or Firestore. It creates/updates an Observer focus, snapshots the current authorized REVEX session, previews the expected appearance-only delta, and journals before/after evidence through the existing `window.RevexObserver` owner.

A successful `preview.canProceed` is necessary but not sufficient for promotion: the visible sheet/render pair must also preserve the focus's protected geometry and topology. No headless capability token is assumed.
