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
const start=read('AI_START_HERE.md');

must(main,"require('./observer-agent-broker')",'Firebase composition must load Observer broker');
for(const name of ['listRevexObserverAgentProjects','issueRevexObserverAgentClaim','claimRevexObserverAgentSession','pullRevexObserverAgentRequests','completeRevexObserverAgentRequest','revexObserverMcp']) must(main,name,'Firebase composition export missing');

must(broker,"CLAIM_TTL_MS = 10 * 60 * 1000",'claim TTL must be bounded');
must(broker,"SESSION_TTL_MS = 2 * 60 * 60 * 1000",'session TTL must be bounded');
must(broker,"sha256(claimKey)",'claim must be stored by digest');
must(broker,"sessionRefForToken(token)",'session bearer must resolve by digest');
must(broker,"'observer.read'",'read scope missing');
must(broker,"'observer.preview'",'preview scope missing');
must(broker,"'observer.focus'",'focus scope missing');
must(broker,"mutation:false",'agent discovery state must remain read-only');
must(broker,"observer_bootstrap",'bootstrap tool missing');
must(broker,"observer_release",'release tool missing');
must(broker,"No active authorized REVEX session is servicing this project",'active browser relay failure must be explicit');
mustNot(broker,"claimKey:claimKey",'raw claim key must never be persisted under an explicit claimKey field');
mustNot(broker,"accessToken:accessToken",'raw session bearer must never be persisted under an explicit accessToken field');

must(bridge,"root.RevexObserver",'browser relay must use current Observer owner');
must(bridge,"pullRevexObserverAgentRequests",'browser relay must pull through callable broker');
must(bridge,"completeRevexObserverAgentRequest",'browser relay must complete through callable broker');
mustNot(bridge,'accessToken','AI bearer must never enter the browser relay');
mustNot(bridge,'claimKey','one-time claim must never enter the browser relay');
must(ui,"observer-agent-bridge-r151.js?v=20260917r151-agent-gate1",'REVEX runtime must load agent bridge');

must(counter,"Issue one-time AI session key",'AI counter action missing');
must(counter,"issueRevexObserverAgentClaim",'AI counter must issue through authenticated callable');
must(counter,"listRevexObserverAgentProjects",'AI counter must resolve accessible projects');
must(counter,"Copy AI bootstrap instruction",'AI handoff must be one action');
mustNot(counter,'localStorage.setItem','counter must not persist AI secrets in localStorage');

if(guide.claimKey.singleUse!==true||guide.claimKey.ttlMinutes!==10)throw new Error('guide claim policy mismatch');
if(guide.session.ttlHours!==2||guide.session.revocable!==true)throw new Error('guide session policy mismatch');
if(!guide.tools.includes('observer_bootstrap')||!guide.tools.includes('observer_snapshot')||!guide.tools.includes('observer_release'))throw new Error('guide tools incomplete');

if(discovery.canonicalApi.counter!=='https://liberpict.com/ai/')throw new Error('counter discovery mismatch');
if(!/claimRevexObserverAgentSession$/.test(discovery.canonicalApi.claimEndpoint||''))throw new Error('claim endpoint discovery mismatch');
if(!/revexObserverMcp$/.test(discovery.canonicalApi.mcpEndpoint||''))throw new Error('MCP endpoint discovery mismatch');
if(discovery.security?.headlessCapabilityToken?.status!=='candidate-implemented-read-only-observer')throw new Error('headless capability status mismatch');
if(discovery.observer?.agentAccess?.mutation!==false)throw new Error('external Observer lease may not expose mutation');

must(start,'## AI counter — start here for a new AI session','AI_START_HERE must lead external agents to counter');
must(start,'observer_bootstrap','AI_START_HERE bootstrap instruction missing');
must(start,'The browser relay never receives the AI bearer','security boundary must separate browser and AI bearer');

console.log('REVEX_OBSERVER_AGENT_GATE_R151=PASSED');
