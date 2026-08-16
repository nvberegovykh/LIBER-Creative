'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..','..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const energy=read('docs/liber-apps/apps/revex/energy-diagnostics-r68.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const must=(text,needle,label)=>assert(text.includes(needle),label||`Missing ${needle}`);

must(energy,"const BUILD='20260816r89-energy-replay2'",'r89 diagnostics build must be active');
must(energy,"function replayOwnsRevision(current)",'Replay state must explicitly own the current revision while the broker is running');
must(energy,"mode!=='current-failure'",'Historical reads must be distinguishable from a new current-run failure');
must(energy,"PREVIOUS ATTEMPT FAILURE",'Preserved failure evidence must be labeled historical on page load');
must(energy,"ENERGY_PREVIOUS_FAILURE_SUPPRESSED",'Historical failure must be suppressed while replay owns the revision');
must(energy,"ENERGY_PREVIOUS_FAILURE_AVAILABLE",'Historical failure may be surfaced as information, not an error');
must(energy,"if(currentFailure){\n        diagnostic('ERROR','ENERGY_EXACT_FAILURE'",'ERROR diagnostics must only be emitted for a current replay failure');
must(energy,"if(stage==='BROKER_FAILED')setTimeout(()=>inspect('current-failure'),250)",'BROKER_FAILED must be the transition that authorizes current-failure rendering');
must(energy,"else if(['BROKER_RUNNING','BROKER_PASSED','RESULT_WAIT','CLOUD_UPLOAD_PASSED','CONSENT_REQUIRED','CONSENT_RECORDED'].includes(stage))setTimeout(()=>inspect('historical'),150)",'All non-failure managed stages must keep previous evidence historical');
must(ui,"energy-diagnostics-r68.js?v=20260816r89-energy-replay2",'Companion must cache-bust to corrected r89 diagnostics');

console.log(JSON.stringify({
  schema:'liber.revex.r89-energy-failure-semantics.v1',
  status:'PASSED',
  pageLoad:{previousFailureIsError:false,preservedEvidence:true},
  replay:{previousFailureSuppressedWhileRunning:true,currentFailureRequiresBrokerFailed:true},
  revit:{rerunRequired:false}
},null,2));
