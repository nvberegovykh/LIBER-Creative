const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('docs/liber-apps/apps/revex/viewer-polish-r68.js','utf8');
const method=source.slice(source.indexOf('  function walkEntryPosition('),source.indexOf('  function patchWalk('));
const enter=vm.runInNewContext(method+'\nwalkEntryPosition'),bounds={min:{x:-10,z:-20},max:{x:10,z:20}},target={x:0,z:0};
const check=(position,expected)=>{const actual=enter(bounds,target,position);assert(Math.abs(actual.x-expected.x)<1e-8);assert(Math.abs(actual.z-expected.z)<1e-8);};
check({x:0,z:100},{x:0,z:28});check({x:-100,z:0},{x:-18,z:0});check({x:0,z:24},{x:0,z:24});check({x:3,z:4},{x:3,z:4});check({x:0,z:0},{x:0,z:0});
const diagonal=enter(bounds,target,{x:100,z:100});assert(diagonal.x>bounds.max.x&&diagonal.x<18);assert.equal(diagonal.x,diagonal.z);
const outside=enter(bounds,{x:200,z:200},{x:100,z:100});assert.equal(outside.x,100);assert.equal(outside.z,100);
console.log('PASS: exterior overview approaches, near-edge and interior preservation, diagonal, degenerate and out-of-model targets');
