const fs=require('fs');
function read(p){return fs.readFileSync(p,'utf8')}
function must(src,needle,label){if(!src.includes(needle))throw new Error(`${label}: missing ${needle}`)}
const exporter=read('src/Liber.Revex.Revit/Services/ViewerExportService.cs');
const helper=read('src/Liber.Revex.Revit/Services/ViewerPropertySnapshot.cs');
const runtime=read('docs/liber-apps/apps/revex/bim-properties-r117.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
for(const [needle,label] of [
  ['liber.revex.viewer.v3','viewer v3 schema'],
  ['ViewerPropertySnapshot.CaptureParameters(doc, element)','instance parameters'],
  ['ViewerPropertySnapshot.CaptureType(doc, type)','deduplicated type properties'],
  ['familyUniqueId = family.uniqueId','family identity'],
  ['hostUniqueId = host?.UniqueId','host identity'],
  ['workset = ViewerPropertySnapshot.ResolveWorkset','workset identity'],
  ['types = types.Values','type catalog']
])must(exporter,needle,label);
for(const [needle,label] of [
  ['parameter.StorageType','typed Revit parameter capture'],
  ['parameter.AsValueString()','formatted parameter value'],
  ['parameter.IsReadOnly','parameter editability evidence'],
  ['FamilyInstance instance => instance.Symbol?.Family','loaded family authority'],
  ['GetWorkset(element.WorksetId)','workset authority']
])must(helper,needle,label);
for(const [needle,label] of [
  ["Visible transmittance (VT/VLT)",'VT/VLT inspector label'],
  ["value:tinted?0.3:0.6",'NYCECC clear/tinted fallback'],
  ["NYCECC C303.1.3 / Table C303.1.3(3)",'code fallback provenance'],
  ["fallback:true",'fallback must be explicit'],
  ["does not overwrite Revit",'fallback non-authority warning'],
  ["Instance parameters",'instance parameter inspector'],
  ["Type parameters",'type parameter inspector'],
  ["revex:source-revision-loaded",'revision rehydration']
])must(runtime,needle,label);
must(ui,"bim-properties-r117.js?v=20260817r117-bim-properties1",'runtime loader');
if(/commitBimOverlay|saveBimAppearance|runEnergyServer/.test(runtime))throw new Error('BIM property runtime must remain read-only and must not mutate BIM/Energy authority.');
console.log('PASS r117 BIM property contract');
