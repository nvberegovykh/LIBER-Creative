const fs=require('fs');
const read=p=>fs.readFileSync(p,'utf8');
const must=(s,n,m)=>{if(!s.includes(n))throw new Error(m+': '+n)};
const mustNot=(s,n,m)=>{if(s.includes(n))throw new Error(m+': '+n)};
const sum=xs=>xs.reduce((a,b)=>a+b,0);

const observer=read('docs/liber-apps/apps/revex/observer-focus-api-r143.js');
const recipe=read('docs/liber-apps/apps/revex/observer-coffee-area-r147.js');
const run=read('docs/liber-apps/apps/revex/focuses/rave-289-coffee-area.run.js');
const verify=read('docs/liber-apps/apps/revex/focuses/rave-289-coffee-area.verify.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const spec=JSON.parse(read('docs/liber-apps/apps/revex/focuses/rave-289-coffee-area.json'));
const expected=JSON.parse(read('docs/liber-apps/apps/revex/focuses/rave-289-coffee-area.expected.json'));
const discovery=JSON.parse(read('docs/.well-known/liber-ai.json'));

if(observer.includes('mutationAvailable:true'))throw new Error('Observer core must not expose mutation');
must(observer,'mutationAvailable:false','Observer core remains read-only');
must(observer,'snapshot','Observer snapshot API');
must(observer,'preview','Observer preview API');
must(observer,'recordStep','Observer journal API');

must(recipe,"const TARGET='rave289.coffee-area'",'coffee focus target');
must(recipe,"geometryMutation: false",'appearance-only expected delta');
must(recipe,"'overall envelope = 48in W x 96in H'",'envelope invariant');
must(recipe,"'left branch clear = 18in from counter to lower-left shelf'",'left branch invariant');
must(recipe,"'right branch clear = 12in from counter to Miele bottom'",'right branch invariant');
must(recipe,"'one Miele CVA 7445 upper-right'",'Miele identity/count invariant');
must(recipe,"'one Sub-Zero ID-24R lower-right'",'Sub-Zero identity/count invariant');
must(recipe,"'three shelf levels: lower-left only + two upper full-width'",'shelf topology invariant');
must(recipe,"'two visible left drawer fronts aligned visually to the two panel-ready ID-24R fronts'",'drawer-front invariant');
must(recipe,"'no invented room or walking depth'",'unknown-depth invariant');
must(recipe,'expectedRevision: focus.baseRevision','revision gate');
must(recipe,"state:'S1'",'pre-output state journal');
must(recipe,"state:'S2'",'post-output state journal');
mustNot(recipe,'setDoc(','coffee observer must not write Firestore');
mustNot(recipe,'.LoadFamily(','coffee observer must not load Revit families');
mustNot(recipe,'new Transaction(','coffee observer must not mutate Revit');

must(run,'window.RevexCoffeeAreaObserver.start()','authorized-session start helper');
must(run,'RAVE_289_COFFEE_OBSERVER_RESULT','start evidence marker');
must(verify,'root.RevexCoffeeAreaObserver.verify','post-output verifier');
must(verify,'RAVE_289_COFFEE_OBSERVER_VERIFY_RESULT','verify evidence marker');

must(ui,"observer-coffee-area-r147.js?v=20260915r147-coffee1",'coffee Observer recipe must load with REVEX runtime');

if(spec.authority.overall.widthIn!==48||spec.authority.overall.heightIn!==96)throw new Error('Authority envelope mismatch');
if(spec.authority.counter.topAffIn!==36.5)throw new Error('Counter AFF mismatch');
if(spec.authority.leftBranch.clearAboveCounterIn!==18||spec.authority.leftBranch.lowerShelfBottomAffIn!==54.5)throw new Error('Left branch mismatch');
if(spec.authority.rightBranch.clearAboveCounterIn!==12||spec.authority.rightBranch.mieleBottomAffIn!==48.5)throw new Error('Right branch mismatch');
if(spec.authority.miele.model!=='CVA 7445'||spec.authority.subZero.model!=='ID-24R')throw new Error('Appliance identity mismatch');
if(spec.expectedDelta.geometryMutation!==false)throw new Error('Focus spec must forbid geometry mutation');

if(spec.measurementPolicy?.mode!=='derive-deltas-from-exposed-parameters')throw new Error('Measurement policy must derive deltas from exposed anchors');
const main=spec.measurementPolicy?.mainVerticalChain?.map(x=>x.distanceIn)||[];
if(main.length!==6||Math.abs(sum(main)-96)>1e-9)throw new Error('Main vertical dimension chain must contain six measured segments summing to 96in');
const branch=spec.measurementPolicy?.rightBranch?.map(x=>x.distanceIn)||[];
if(branch.length!==2||branch[0]!==12||branch[1]!==17.9375)throw new Error('Miele right branch dimension chain mismatch');
if(spec.confidencePolicy?.softFloor!==0.75||spec.confidencePolicy?.softTarget!==0.95)throw new Error('Confidence floor/target mismatch');
if(JSON.stringify(spec.deliverables)!==JSON.stringify(['spec','render']))throw new Error('Expected two-deliverable set: spec + render');

if(expected?.expected?.mutation!==false)throw new Error('Expected-output contract may not allow geometry mutation');
if(Math.abs(expected.expected.dimensionChains.mainVerticalTotalIn-96)>1e-9)throw new Error('Expected-output main vertical total mismatch');
if(JSON.stringify(expected.expected.deliverables)!==JSON.stringify(['spec','render']))throw new Error('Expected-output deliverables mismatch');
if(expected.expected.confidence.softFloor!==0.75||expected.expected.confidence.softTarget!==0.95)throw new Error('Expected-output confidence policy mismatch');

const coffeeFocus=(discovery.provingFocuses||[]).find(x=>x.id==='rave289.coffee-area');
if(!coffeeFocus)throw new Error('Coffee focus missing from LIBER AI discovery');
if(coffeeFocus.observerGlobal!=='window.RevexCoffeeAreaObserver')throw new Error('Coffee discovery global mismatch');
if(coffeeFocus.observerStartMethod!=='start'||coffeeFocus.observerVerifyMethod!=='verify')throw new Error('Coffee discovery methods mismatch');

console.log('REVEX_OBSERVER_COFFEE_R147=PASSED');
