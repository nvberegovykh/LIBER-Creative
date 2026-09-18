'use strict';
const assert=require('assert');
const paper=require('../../docs/ai/runtime/object-paper-r1.js');
const example=require('../../docs/ai/examples/four-candle-lantern.object-paper.json');
const workflow=require('../../docs/ai/workflows/projection-render-gate.json');
const guide=require('../../docs/ai/guide.json');
const discovery=require('../../docs/.well-known/liber-ai.json');

assert.equal(paper.version,'20260918r1-object-paper');
assert.equal(workflow.objectPaper.runtime,'https://liberpict.com/ai/runtime/object-paper-r1.js');
assert.equal(workflow.objectPaper.readinessEvaluator,'LiberObjectPaper.evaluatePaperReady(paper)');
assert.equal(guide.objectPaper.evaluator,'LiberObjectPaper.evaluatePaperReady');
assert.equal(discovery.workflows.objectPaper.renderBlockedUntilReady,true);

const valid=paper.validatePaper(example);
assert.equal(valid.ok,true,valid.errors.join('; '));

const front=paper.projectedCoincidenceGroups(example,'front',{kind:'candle'},1e-6);
assert.equal(front.length,2,'front projection must collapse front/rear candle pairs to two visible axes');
assert(front.every(g=>g.length===2),'each front visible candle axis should represent two physical candles');

const iso=paper.measureAxonometry(example,'iso',1e-5);
assert.equal(iso.classification,'isometric','isometry must classify as the equal-foreshortening axonometric case');

const isoCandles=paper.projectedCoincidenceGroups(example,'iso',{kind:'candle'},1e-6);
assert.equal(isoCandles.length,4,'isometric 3/4 observation should separate all four candle axes in this example');

const corrections=paper.evaluateVectorCorrections(example);
assert.equal(corrections.length,1);
assert.equal(corrections[0].id,'no-central-ghost-candle');
assert.equal(corrections[0].pass,true,'no physical candle may occupy the forbidden central ghost axis');

const readiness=paper.evaluatePaperReady(example);
assert.equal(readiness.paperReady,true,JSON.stringify(readiness,null,2));
assert.match(readiness.next,/human launch authorization/i);

const bad=JSON.parse(JSON.stringify(example));
bad.object.geometry.vertices.push({id:'ghostA',p:[0,0,1]},{id:'ghostB',p:[0,0,3]});
bad.object.geometry.segments.push({id:'ghost.central',a:'ghostA',b:'ghostB',kind:'candle',authority:'hypothesis'});
const badReady=paper.evaluatePaperReady(bad);
assert.equal(badReady.paperReady,false,'fifth/central candle must fail paper gate');
assert(badReady.invariants.some(x=>x.id==='four-candles'&&!x.pass));
assert(badReady.corrections.some(x=>x.id==='no-central-ghost-candle'&&!x.pass));

console.log('LIBER_AI_OBJECT_PAPER_R1=PASSED');
console.log(JSON.stringify({
  frontCoincidenceGroups:front,
  isometricForeshortening:iso.foreshortening,
  isometricCandleGroups:isoCandles,
  paperReady:readiness.paperReady,
  ghostRejected:!badReady.paperReady
},null,2));
