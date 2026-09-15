/* Rave 289 coffee-area Observer recipe r147
 * Read-only focus/preview wrapper. No Revit mutation, no Firestore mutation.
 * Requires window.RevexObserver from observer-focus-api-r143.js.
 */
(function(root){
'use strict';
const BUILD='20260915r147-coffee1';
const TARGET='rave289.coffee-area';

const SPEC={
  focusId: TARGET,
  name: 'Rave 289 Coffee Area',
  target: '48in x 96in coffee appliance cabinet behind double pocket doors',
  temporary: true,
  scope: { elementIds: [], stableFaceRefs: [] },
  protected: [
    'overall envelope = 48in W x 96in H',
    'counter top = 36.5in AFF',
    'left branch clear = 18in from counter to lower-left shelf',
    'right branch clear = 12in from counter to Miele bottom',
    'one Miele CVA 7445 upper-right',
    'one Sub-Zero ID-24R lower-right',
    'three shelf levels: lower-left only + two upper full-width',
    'two visible left drawer fronts aligned visually to the two panel-ready ID-24R fronts',
    'no invented room or walking depth'
  ],
  expectedDelta: {
    kind: 'appearance-only-render-and-coordination-visualization',
    geometryMutation: false,
    allowed: ['materials','lighting','decorative objects that do not change protected geometry','annotation layout'],
    forbidden: ['envelope changes','branch topology changes','appliance count or placement changes','shelf span changes','drawer-front count changes','invented depth or clearance geometry']
  }
};

function requireObserver(){
  const o=root.RevexObserver;
  if(!o) throw new Error('REVEX Observer API is not ready.');
  return o;
}

function findExisting(o){
  return (o.listFocus?.()||[]).find(f=>String(f?.focusId||'').startsWith(TARGET+'.') || f?.name===SPEC.name) || null;
}

function start(){
  const o=requireObserver();
  const before=o.snapshot();
  let focus=findExisting(o);
  if(!focus || focus.status!=='ACTIVE') focus=o.createFocus(SPEC);
  else focus=o.updateFocus(focus.focusId,{protected:SPEC.protected,expectedDelta:SPEC.expectedDelta,captureSnapshot:true});
  const preview=o.preview({
    focusId: focus.focusId,
    operation: 'coffee-area-appearance-only',
    expectedRevision: focus.baseRevision,
    protectedInvariants: SPEC.protected
  });
  const step=o.recordStep(focus.focusId,{
    state:'S1',
    label:'Authority focus established; no mutation requested',
    result:preview.canProceed?'OBSERVED':'BLOCKED',
    expectedDelta:SPEC.expectedDelta,
    observedDelta:{geometryMutation:false},
    evidence:{before,preview},
    captureSnapshot:true
  });
  return Object.freeze({build:BUILD,before,focus:o.getFocus(focus.focusId),preview,step});
}

function verify(focusId, evidence={}){
  const o=requireObserver();
  const focus=o.getFocus(focusId)||findExisting(o);
  if(!focus) throw new Error('Coffee-area Observer focus not found.');
  const after=o.snapshot();
  const preview=o.preview({focusId:focus.focusId,operation:'coffee-area-post-render-verify',expectedRevision:focus.baseRevision,protectedInvariants:SPEC.protected});
  const event=o.recordStep(focus.focusId,{
    state:'S2',
    label:'Post-output Observer verification',
    result:preview.canProceed?'OBSERVED':'BLOCKED',
    expectedDelta:SPEC.expectedDelta,
    observedDelta:{geometryMutation:false},
    evidence:{after,...evidence,preview},
    captureSnapshot:false
  });
  return Object.freeze({build:BUILD,focus:o.getFocus(focus.focusId),after,preview,event});
}

root.RevexCoffeeAreaObserver=Object.freeze({build:BUILD,spec:Object.freeze(SPEC),start,verify});
try{root.dispatchEvent(new CustomEvent('revex:coffee-area-observer-ready',{detail:{build:BUILD}}));}catch(_){}
})(window);
