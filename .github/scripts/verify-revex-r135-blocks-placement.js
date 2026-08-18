'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');

const palette=fs.readFileSync('docs/liber-apps/apps/revex/blocks-palette-r126.js','utf8');
const bridge=fs.readFileSync('src/Liber.Revex.Revit/UI/RevexWebIntegrationBridge.cs','utf8');
const placement=fs.readFileSync('src/Liber.Revex.Revit/Services/FamilyPlacementService.cs','utf8');

const must=(text,needle,label)=>assert.ok(text.includes(needle),`${label}: missing ${needle}`);
const forbid=(text,needle,label)=>assert.ok(!text.includes(needle),`${label}: forbidden ${needle}`);

must(palette,"placementDistanceFt:3",'Walk placement distance contract');
must(palette,"viewer.camera.position.clone().addScaledVector(dir,3)",'3 ft target from active Walk camera');
must(palette,"return{x:target.x,y:-target.z,z:target.y",'Three-to-Revit coordinate inverse');
must(palette,"type:'liber:revex-family-place-r126'",'Companion placement command');
must(palette,"type:'liber:revex-family-transform-r126'",'Companion transform command');
must(palette,"button.hidden=!(hosted()&&v()?.walk)",'Walk-only family UI');

must(bridge,'PendingFamilies[token] = new PendingFamily(path, suggested, info.Length, DateTime.UtcNow, target);','opaque local family token store');
must(bridge,'type = "liber:revex-integration-family-r126"','browser family handoff event');
must(bridge,'token,\n                        name = suggested,\n                        bytes = info.Length','browser handoff contains opaque token metadata');
must(bridge,'new FamilyPlacementService.PlacementRequest(pending.Path, x, y, z, rotation, levelName, levelElevation)','Revit-side token resolution');
must(bridge,'RevexFamilyPlacementExternalHandler','Revit ExternalEvent handler');
must(bridge,'_familyExternalEvent.Raise();','Revit ExternalEvent raise');
must(bridge,'PendingFamilies.TryRemove(token','one-shot token cleanup');

must(placement,'double targetZ = double.IsFinite(request.Z) ? request.Z : level.Elevation;','exact Walk Z preservation');
must(placement,'XYZ point = new(request.X, request.Y, targetZ);','exact Walk target point');
must(placement,'TryNearestFacePlacement(doc, symbol, point)','face-host fallback');
must(placement,'doc.Create.NewFamilyInstance(reference, projection.XYZPoint, referenceDirection, symbol)','face-reference Revit placement');
must(placement,'TryNearestHostedPlacement(doc, symbol, level, point)','bounded element-host fallback');
must(placement,'MaxHostDistanceFt = 8.0','host search bound');
must(placement,'ComputeReferences = true','host face reference geometry');
must(placement,'MaxZipEntries = 2048','ZIP entry bound');
must(placement,'MaxExpandedZipBytes = 512L * 1024L * 1024L','ZIP expansion bound');
must(placement,'destination.StartsWith(root, StringComparison.OrdinalIgnoreCase)','ZIP path containment');
must(placement,"OrderByDescending(p => new FileInfo(p).Length)",'deterministic RFA selection by content size');
must(placement,'unsupported placement type','unsupported family fail-closed');
forbid(placement,'ZipFile.ExtractToDirectory(path, extractedFolder)','unbounded ZIP extraction');

console.log(JSON.stringify({
  REVEX_R135_BLOCKS_PLACEMENT:'PASSED',
  walkPlacementFt:3,
  exactWalkZ:true,
  opaqueToken:true,
  externalEvent:true,
  faceHostFallback:true,
  elementHostFallback:true,
  hostRadiusFt:8,
  boundedZip:true,
  unsupportedFamiliesFailClosed:true
}));