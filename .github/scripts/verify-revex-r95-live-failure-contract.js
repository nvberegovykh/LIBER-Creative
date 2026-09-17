'use strict';
const fs=require('fs');
const energy=fs.readFileSync('docs/liber-apps/apps/revex/energy-replay-r95.js','utf8');
const diag=fs.readFileSync('docs/liber-apps/apps/revex/energy-diagnostics-r68.js','utf8');
const guard=fs.readFileSync('server/revex-energy-worker/revex_energy_pipeline_guard.py','utf8');
const ui=fs.readFileSync('docs/liber-apps/apps/revex/ui-integrity.js','utf8');
for(const marker of [
  "const BUILD='20260817r116-final-energy1'",
  '__revexManagedEnergyActive','authorizeCurrentRevision','jobStatus===\'RUNNING\'',
  'function pipelineTerminal(status)',
  'if(pipelineTerminal(status))throw new Error(exactJobError(job,status))',
  "if(worker.status==='FAILED')throw new Error",
  'if(response?.ok===false)throw new Error',
  "if(status!=='COMPLETE')throw new Error",
  'return runHosted({auto:false,forcePrompt:true})'
]) if(!energy.includes(marker)) throw new Error('r95 Energy live-failure contract missing: '+marker);
if(energy.includes("dialog.close('approve')")||energy.includes('ENERGY_SYNC_LAUNCH_AUTHORIZED')) throw new Error('r95 still auto-closes authorization');
for(const marker of ['requiredIdentityFallback','event.preventDefault()','energy-identity-city','energy-identity-state','energy-identity-zip']) if(!diag.includes(marker)) throw new Error('r95 identity form guard missing: '+marker);
const identityCalls=(guard.match(/effective_request = _resolve_user_identity_request/g)||[]).length;
if(identityCalls<2) throw new Error('explicit identity is not reprojected at final consumer boundary');
if(!ui.includes("loadScript('energy-replay-r95.js?v=20260817r116-final-energy1','energy-replay-r95')")) throw new Error('current r116 Energy owner is not active');
if(!ui.includes("if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind")) throw new Error('ui runtime does not wait for import map');
console.log(JSON.stringify({REVEX_R95_LIVE_FAILURE_CONTRACT:'PASSED',currentBuild:'20260817r116-final-energy1',singleFlight:true,strictCompleteOnly:true,pipelineTerminalFailClosed:true,autoClose:false,manualRequiredFields:true,consumerBoundaryReprojection:true,moduleLoadAfterImportMap:true}));
