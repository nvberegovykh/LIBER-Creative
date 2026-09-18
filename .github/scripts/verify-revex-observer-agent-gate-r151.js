'use strict';
const fs=require('fs');
const read=p=>fs.readFileSync(p,'utf8');
const must=(s,n,m)=>{if(!s.includes(n))throw new Error(`${m}: ${n}`)};
const mustNot=(s,n,m)=>{if(s.includes(n))throw new Error(`${m}: ${n}`)};

const broker=read('server/firebase-functions/observer-agent-broker.js');
const main=read('server/firebase-functions/main.js');
const bridge=read('docs/liber-apps/apps/revex/observer-agent-bridge-r151.js');
const ui=read('docs/liber-apps/apps/revex/ui-integrity.js');
const counter=read('docs/ai/index.html');
const guide=JSON.parse(read('docs/ai/guide.json'));
const discovery=JSON.parse(read('docs/.well-known/liber-ai.json'));
const projectionRender=JSON.parse(read('docs/ai/workflows/projection-render-gate.json'));
const deploy=read('server/firebase-functions/DEPLOY_OBSERVER_AGENT_CURRENT.ps1');
const launcher=read('DEPLOY_REVEX_OBSERVER_AI_CURRENT.cmd');
const repair=read('server/firebase-functions/REPAIR_OBSERVER_AGENT_PUBLIC_ACCESS.ps1');
const repairLauncher=read('REPAIR_REVEX_OBSERVER_AI_ACCESS_CURRENT.cmd');
const functions=['issueRevexObserverAnonymousClaim','issueRevexObserverPairCode','claimRevexObserverAgentSession','pullRevexObserverAgentRequests','completeRevexObserverAgentRequest','revexObserverMcp'];

for(const name of functions) must(main,name,'Firebase composition export missing');

must(broker,"PUBLIC_SCOPES = Object.freeze(['observer.pair'])",'anonymous lease must start unpaired');
must(broker,"PROJECT_SCOPES = Object.freeze(['observer.read','observer.preview','observer.focus'])",'paired project scopes missing');
must(broker,'issueRevexObserverAnonymousClaim','public claim endpoint missing');
must(broker,"kind:'PUBLIC_COUNTER'",'public claim kind missing');
must(broker,'projectId:null','public counter must not bind a project');
must(broker,'ownerUid:null','public counter must not bind a user');
must(broker,'enforcePublicRate(req)','public counter must be rate limited');
must(broker,'issueRevexObserverPairCode','authorized Pair AI code endpoint missing');
must(broker,'accessFor(projectId,uid)','project pairing must verify REVEX access');
must(broker,'observer_pair','MCP pair tool missing');
must(broker,'pairSession(sessionRef,session,args?.pairCode)','MCP must bind through one-time pair code');
must(broker,"CLAIM_TTL_MS = 10 * 60 * 1000",'claim TTL mismatch');
must(broker,"PAIR_TTL_MS = 10 * 60 * 1000",'pair TTL mismatch');
must(broker,"SESSION_TTL_MS = 2 * 60 * 60 * 1000",'session TTL mismatch');
mustNot(broker,'accessToken:accessToken','raw bearer must not be persisted under explicit field');
mustNot(broker,"module.exports = { PROJECT_SCOPES, PUBLIC_SCOPES };",'Observer broker may not replace module.exports after declaring handlers');
must(broker,'module.exports.PROJECT_SCOPES = PROJECT_SCOPES;','Observer broker must append PROJECT_SCOPES without clobbering handlers');
must(broker,'module.exports.PUBLIC_SCOPES = PUBLIC_SCOPES;','Observer broker must append PUBLIC_SCOPES without clobbering handlers');

must(bridge,'issueRevexObserverPairCode','REVEX browser must issue pairing codes');
must(bridge,"button.textContent='Pair AI'",'Pair AI control missing');
must(bridge,'root.RevexObserver','browser relay must use existing Observer owner');
mustNot(bridge,'accessToken','AI bearer must never enter browser relay');
mustNot(bridge,'claimKey','public claim must never enter browser relay');
must(ui,"observer-agent-bridge-r151.js?v=20260917r151-agent-gate1",'runtime must load Observer relay');

must(counter,'No LIBER account is required here','counter must explicitly be accountless');
must(counter,'issueRevexObserverAnonymousClaim','counter must use public issue endpoint');
must(counter,'Take one AI session package','public package action missing');
must(counter,'Counter access and project authorization are intentionally separate','counter/project separation missing');
mustNot(counter,'firebase-service.js','public counter must not load Firebase auth runtime');
mustNot(counter,'Sign in','public counter must not request sign-in');

if(guide.publicCounter?.accountRequired!==false)throw new Error('guide counter must be accountless');
if(guide.publicCounter?.projectDataExposed!==false)throw new Error('guide counter may not expose project data');
if(guide.projectPairing?.browserAction!=='Pair AI'||guide.projectPairing?.aiTool!=='observer_pair')throw new Error('guide pairing contract mismatch');
if(JSON.stringify(guide.session?.initialScopes)!==JSON.stringify(['observer.pair']))throw new Error('initial anonymous scopes mismatch');
if(JSON.stringify(guide.session?.pairedScopes)!==JSON.stringify(['observer.read','observer.preview','observer.focus']))throw new Error('paired scopes mismatch');

if(discovery.observer?.agentAccess?.counterAccountRequired!==false)throw new Error('discovery counter must be accountless');
if(discovery.observer?.agentAccess?.counterExposesProjectData!==false)throw new Error('discovery counter may not expose project data');
if(discovery.observer?.agentAccess?.pairTool!=='observer_pair')throw new Error('discovery pair tool mismatch');
if(discovery.security?.publicCounter?.accountRequired!==false)throw new Error('security discovery account policy mismatch');
if(discovery.security?.headlessCapabilityToken?.status!=='candidate-implemented-read-only-observer-with-separate-project-pairing')throw new Error('headless status mismatch');
if(projectionRender.schema!=='liber.ai.projection-render-workflow.v1')throw new Error('paper-before-render workflow schema mismatch');
if(projectionRender.launchContract?.humanAuthorizationRequired!==true)throw new Error('render launch must require human authorization');
if(projectionRender.launchContract?.defaultWhenNotAuthorized!=='stop-without-rendering')throw new Error('render must stop by default without human launch');
const gate=projectionRender.states?.find(row=>row.id==='P2_COHERENCE_GATE');
if(!gate||!String(gate.failAction||'').includes('Do not render'))throw new Error('coherence gate must block render on failure');
if(discovery.workflows?.paperBeforeRender?.humanLaunchRequired!==true)throw new Error('discovery must expose human render launch gate');

for(const name of functions){must(deploy,`'${name}'`,`Observer-only deployment must include ${name}`);must(repair,`'${name}'`,`Observer public-access repair must include ${name}`);}
must(deploy,"$ObserverSaName = 'revex-observer-broker'",'Observer deployment must use its own runtime identity');
must(deploy,"'roles/datastore.user'",'Observer runtime must have bounded Firestore role');
must(deploy,"'roles/logging.logWriter'",'Observer runtime must have logging role');
must(deploy,"'--runtime','nodejs22'",'Observer runtime must stay Node 22');
must(deploy,"'--allow-unauthenticated'",'function deployment must request unauthenticated HTTP transport');
must(deploy,"'run','services','add-iam-policy-binding'",'deployment must explicitly repair Gen2 Cloud Run invoker IAM');
must(deploy,"'allUsers'",'deployment must grant public transport to allUsers');
must(deploy,"'roles/run.invoker'",'deployment must use Cloud Run Invoker role');
must(deploy,"'--no-invoker-iam-check'",'deployment must have domain-restricted-sharing fallback');
must(deploy,'Probe-PublicTransport','deployment must verify unauthenticated transport before smoke testing');
must(deploy,"REVEX_SOURCE_CANDIDATE=$SourceCandidate",'Observer functions must bind exact source SHA');
must(deploy,"Smoke-PublicObserver",'Observer deployment must smoke-test public claim/MCP path');
must(deploy,"'Public anonymous claim'",'smoke test must identify the failing public-claim stage');
must(deploy,"'One-time claim exchange'",'smoke test must identify the claim-exchange stage');
must(deploy,"'MCP initialize'",'smoke test must identify MCP transport failure');
must(deploy,"observer_release",'deployment smoke test must revoke its test lease');
must(deploy,'Energy worker, renderer, Revit model, Storage rules, Firestore rules and project content are not redeployed','deployment scope must remain bounded');
mustNot(deploy,"runRevexEnergy","Observer-only deployment may not deploy Energy broker");
mustNot(deploy,"runRevexRender","Observer-only deployment may not deploy Render broker");

must(repair,"'run','services','add-iam-policy-binding'",'repair must set Cloud Run invoker IAM explicitly');
must(repair,"'roles/run.invoker'",'repair must use Cloud Run Invoker role');
must(repair,"'--no-invoker-iam-check'",'repair must have DRS fallback');
must(repair,'Scope: invocation IAM + smoke test only. No function rebuild','repair may not rebuild deployed functions');
must(repair,'Smoke-PublicObserver','repair must run end-to-end anonymous-session smoke test');
mustNot(repair,"'functions','deploy'",'access-only repair may not redeploy functions');
mustNot(repair,"runRevexEnergy",'access-only repair may not deploy Energy');
mustNot(repair,"runRevexRender",'access-only repair may not deploy Render');

must(launcher,'git clone --depth 1 --branch main --single-branch','launcher must self-refresh from exact current main');
must(launcher,'DEPLOY_OBSERVER_AGENT_CURRENT.ps1','launcher must call bounded Observer deployment controller');
must(launcher,'rmdir /s /q "%WORK%"','launcher must remove disposable checkout');
must(repairLauncher,'git clone --depth 1 --branch main --single-branch','repair launcher must self-refresh from main');
must(repairLauncher,'REPAIR_OBSERVER_AGENT_PUBLIC_ACCESS.ps1','repair launcher must call access-only controller');
must(repairLauncher,'rmdir /s /q "%WORK%"','repair launcher must remove disposable checkout');

console.log('REVEX_OBSERVER_AGENT_GATE_R155=PASSED');
