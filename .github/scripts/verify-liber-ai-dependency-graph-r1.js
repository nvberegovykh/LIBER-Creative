'use strict';
const assert=require('assert');
const graphRuntime=require('../../docs/ai/runtime/dependency-graph-r1.js');
const graph=require('../../docs/ai/cases/meadowview-palladian-r1.dependency.json');
const handoff=require('../../docs/ai/cases/meadowview-palladian-r1.json');

assert.equal(graphRuntime.version,'20260918r1-dependency-graph');
assert.equal(handoff.userAssessment.acceptedBaselineAccuracyApprox,0.94);
assert.equal(handoff.objectState.candles.physicalCount,4);
assert.equal(handoff.objectState.candles.frontProjectionExpectedDominantAxes,2);
assert.equal(handoff.objectState.hanger.topology,'single-straight-central-rod');

const order=graphRuntime.topologicalOrder(graph);
assert(order.indexOf('physicalCandleCount')<order.indexOf('inv.candleTopology'));
assert(order.indexOf('inv.noGhost')<order.indexOf('formula.objectCoherent'));
assert(order.indexOf('formula.objectCoherent')<order.indexOf('formula.renderEligible'));

const base=graphRuntime.evaluateGraph(graph);
assert.equal(base.ok,true);
assert.equal(base.hardPass,true);
assert.equal(base.nodes['formula.objectCoherent'].value,true);
assert.equal(base.nodes.renderAllowed.value,false,'human launch false must block render');

const launched=graphRuntime.evaluateGraph(graph,{humanLaunch:true});
assert.equal(launched.nodes.renderAllowed.value,true,'all hard gates plus human launch should allow downstream renderer');

const ghost=graphRuntime.evaluateGraph(graph,{humanLaunch:true,centralGhostCandlePresent:true});
assert.equal(ghost.hardPass,false);
assert.equal(ghost.nodes['inv.noGhost'].pass,false);
assert.equal(ghost.nodes.renderAllowed.value,false);

const wrongCandles=graphRuntime.evaluateGraph(graph,{humanLaunch:true,physicalCandleCount:3});
assert.equal(wrongCandles.hardPass,false);
assert.equal(wrongCandles.nodes['inv.candleTopology'].pass,false);
assert.equal(wrongCandles.nodes.renderAllowed.value,false);

const wrongHanger=graphRuntime.evaluateGraph(graph,{humanLaunch:true,hangerTopology:'chain'});
assert.equal(wrongHanger.hardPass,false);
assert.equal(wrongHanger.nodes['inv.hanger'].pass,false);
assert.equal(wrongHanger.nodes.renderAllowed.value,false);

const rotated=graphRuntime.evaluateGraph(graph,{humanLaunch:true,outerCageYawDeg:5});
assert.equal(rotated.hardPass,false);
assert.equal(rotated.nodes['inv.cageFacing'].pass,false);
assert.equal(rotated.nodes.renderAllowed.value,false);

const downstream=graphRuntime.downstream(graph,['centralGhostCandlePresent']);
assert(downstream.includes('inv.noGhost'));
assert(downstream.includes('formula.objectCoherent'));
assert(downstream.includes('formula.renderEligible'));
assert(downstream.includes('renderAllowed'));

const closure=graphRuntime.dependencyClosure(graph,['renderAllowed']);
for(const required of ['surroundingsFrozen','physicalCandleCount','frontVisibleCandleAxes','centralGhostCandlePresent','hangerTopology','outerCageYawDeg','paperReady','humanLaunch']){
  assert(closure.includes(required),'render closure missing '+required);
}

const cycle={schema:'liber.ai.dependency-graph.v1',nodes:[
  {id:'a',kind:'formula',expr:{ref:'b'}},
  {id:'b',kind:'formula',expr:{ref:'a'}}
]};
assert.throws(()=>graphRuntime.topologicalOrder(cycle),/Dependency cycle/);

console.log('LIBER_AI_DEPENDENCY_GRAPH_R1=PASSED');
console.log(JSON.stringify({
  baseRenderAllowed:base.nodes.renderAllowed.value,
  launchedRenderAllowed:launched.nodes.renderAllowed.value,
  ghostRejected:!ghost.hardPass,
  rotatedFiveDegreesRejected:!rotated.hardPass,
  centralGhostDownstream:downstream
},null,2));
