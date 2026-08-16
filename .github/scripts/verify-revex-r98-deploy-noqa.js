'use strict';
const fs=require('fs');
const core=fs.readFileSync('src/Liber.Revex.Revit/Engineering/Energy/GeometryCo/OpenStudio_Energy_Model_Geometry_Compiler.py','utf8');
const worker=fs.readFileSync('server/revex-energy-worker/app.py','utf8');
const guard=fs.readFileSync('server/revex-energy-worker/revex_energy_pipeline_guard.py','utf8');
if(!core.includes('MINIMUM_MAPPING_CONFIDENCE = 0.75'))throw new Error('GeometryCo 75% floor changed');
if(!worker.includes('MIN_INTEGRITY = 0.80')||!worker.includes('QUALITY_TARGET = 0.95'))throw new Error('Engineering integrity floors changed');
if(!guard.includes('finalize_complete_result'))throw new Error('complete output finalization detached');
console.log('REVEX_R98_NO_QA_LOOSENING=PASSED');
