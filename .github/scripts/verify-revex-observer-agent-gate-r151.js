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
const deploy=read('server/firebase-functions/DEPLOY_OBSERVER_AGENT_CURRENT.ps1');
const launcher=read('DEPLOY_REVEX_OBSERVER_AI_CURRENT.cmd');
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

for(const name of functions){
  must(deploy,`'${name}'`,`Observer-only deployment must include ${name}`);
}
must(deploy,"$ObserverSaName = 'revex-observer-broker'",'Observer deployment must use its own runtime identity');
must(deploy,"'roles/datastore.user'",'Observer runtime must have bounded Firestore role');
must(deploy,"'roles/logging.logWriter'",'Observer runtime must have logging role');
must(deploy,"'--runtime','nodejs22'",'Observer runtime must stay Node 22');
must(deploy,"'--allow-unauthenticated'",'HTTP transport must remain reachable so app/MCP auth can be enforced inside handlers');
must(deploy,"REVEX_SOURCE_CANDIDATE=$SourceCandidate",'Observer functions must bind exact source SHA');
must(deploy,"Smoke-PublicObserver",'Observer deployment must smoke-test public claim/MCP path');
must(deploy,"observer_release",'deployment smoke test must revoke its test lease');
must(deploy,'Energy worker, renderer, Revit model, Storage rules, Firestore rules and project content are not redeployed','deployment scope must remain bounded');
mustNot(deploy,"runRevexEnergy","Observer-only deployment may not deploy Energy broker");
mustNot(deploy,"runRevexRender","Observer-only deployment may not deploy Render broker");
must(launcher,'git clone --depth 1 --branch main --single-branch','launcher must self-refresh from exact current main');
must(launcher,'DEPLOY_OBSERVER_AGENT_CURRENT.ps1','launcher must call bounded Observer deployment controller');
must(launcher,'rmdir /s /q "%WORK%"','launcher must remove disposable checkout');

console.log('REVEX_OBSERVER_AGENT_GATE_R153=PASSED');
