'use strict';
for(const file of [
  './verify-revex-r98-source-contract.js',
  './verify-revex-r98-deploy-noqa.js',
  './verify-revex-r98-fast-repair.js',
  './verify-revex-r98-runtime-boundary.js',
  './verify-revex-r98-deployment-markers.js',
  './verify-revex-r98-no-project-fallback.js'
]) require(file);
console.log('REVEX_R98_AGGREGATE=PASSED');
