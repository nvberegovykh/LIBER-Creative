'use strict';

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { projectAccessRole } = require('./project-access');

const db = getFirestore();
const REGION = 'us-central1';
const CLAIM_TTL_MS = 10 * 60 * 1000;
const PAIR_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 60 * 1000;
const PUBLIC_RATE_WINDOW_MS = 60 * 60 * 1000;
const PUBLIC_RATE_LIMIT = 20;
const MAX_RESULT_BYTES = 700000;
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const FOCUS_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PROJECT_SCOPES = Object.freeze(['observer.read','observer.preview','observer.focus']);
const PUBLIC_SCOPES = Object.freeze(['observer.pair']);
const DISCOVERY_URL = 'https://liberpict.com/.well-known/liber-ai.json';
const COUNTER_URL = 'https://liberpict.com/ai/';
const GUIDE_URL = 'https://liberpict.com/ai/guide.json';
const CLAIM_URL = 'https://us-central1-liber-apps-cca20.cloudfunctions.net/claimRevexObserverAgentSession';
const MCP_URL = 'https://us-central1-liber-apps-cca20.cloudfunctions.net/revexObserverMcp';

const TOOL_DEFS = Object.freeze([
  { name:'observer_bootstrap', description:'Return the current LIBER/REVEX Observer guide, lease, scopes, project binding, pairing state, and active bridge status.', inputSchema:{type:'object',properties:{},additionalProperties:false} },
  { name:'observer_pair', description:'Bind this anonymous AI lease to one authorized REVEX project using a short one-time pairing code issued from that project.', scope:'observer.pair', inputSchema:{type:'object',properties:{pairCode:{type:'string'}},required:['pairCode'],additionalProperties:false} },
  { name:'observer_snapshot', description:'Snapshot the active REVEX project/revision/view/camera/selection/runtime owners through the authorized REVEX browser session.', scope:'observer.read', method:'snapshot', inputSchema:{type:'object',properties:{},additionalProperties:false} },
  { name:'observer_get_element', description:'Read one exposed REVEX element by Revit/REVEX identity.', scope:'observer.read', method:'getElement', inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false} },
  { name:'observer_query', description:'Query exposed REVEX elements with ids/text/category/family/type/limit filters.', scope:'observer.read', method:'query', inputSchema:{type:'object',properties:{filter:{type:'object'}},additionalProperties:false} },
  { name:'observer_graph', description:'Read a bounded relationship graph around one exposed REVEX element.', scope:'observer.read', method:'graph', inputSchema:{type:'object',properties:{id:{type:'string'},depth:{type:'number'}},required:['id'],additionalProperties:false} },
  { name:'observer_get_selection', description:'Read the current REVEX/Revit selection identity.', scope:'observer.read', method:'getSelection', inputSchema:{type:'object',properties:{},additionalProperties:false} },
  { name:'observer_create_focus', description:'Create one local bounded Observer focus in the active authorized REVEX browser session. This does not mutate Revit or project Firestore state.', scope:'observer.focus', method:'createFocus', inputSchema:{type:'object',properties:{spec:{type:'object'}},additionalProperties:false} },
  { name:'observer_get_focus', description:'Read one Observer focus by focusId.', scope:'observer.focus', method:'getFocus', inputSchema:{type:'object',properties:{focusId:{type:'string'}},required:['focusId'],additionalProperties:false} },
  { name:'observer_list_focus', description:'List local Observer focuses for the active project.', scope:'observer.focus', method:'listFocus', inputSchema:{type:'object',properties:{},additionalProperties:false} },
  { name:'observer_update_focus', description:'Update the bounded local Observer focus journal/state only; does not mutate Revit model state.', scope:'observer.focus', method:'updateFocus', inputSchema:{type:'object',properties:{focusId:{type:'string'},patch:{type:'object'}},required:['focusId'],additionalProperties:false} },
  { name:'observer_record_step', description:'Record expected/observed delta and evidence in the local Observer focus journal.', scope:'observer.focus', method:'recordStep', inputSchema:{type:'object',properties:{focusId:{type:'string'},step:{type:'object'}},required:['focusId'],additionalProperties:false} },
  { name:'observer_close_focus', description:'Close one local Observer focus.', scope:'observer.focus', method:'closeFocus', inputSchema:{type:'object',properties:{focusId:{type:'string'},status:{type:'string'}},required:['focusId'],additionalProperties:false} },
  { name:'observer_preview', description:'Run the read-only Observer revision/target/protected-invariant preview gate. Mutation remains unavailable.', scope:'observer.preview', method:'preview', inputSchema:{type:'object',properties:{operation:{type:'object'}},additionalProperties:false} },
  { name:'observer_release', description:'Revoke this AI session lease immediately.', inputSchema:{type:'object',properties:{},additionalProperties:false} }
]);

function clean(value){ return String(value ?? '').trim(); }
function b64url(bytes=32){ return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(value){ return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function nowMs(){ return Date.now(); }
function iso(ms){ return new Date(ms).toISOString(); }
function assertProjectId(value){ const id=clean(value); if(!PROJECT_ID_RE.test(id)) throw new HttpsError('invalid-argument','projectId is invalid.'); return id; }
function assertFocusId(value){ const id=clean(value); if(!id) return ''; if(!FOCUS_ID_RE.test(id)) throw new HttpsError('invalid-argument','focusId is invalid.'); return id; }
function randomPairCode(){ let out=''; for(let i=0;i<8;i++) out+=PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)]; return `${out.slice(0,4)}-${out.slice(4)}`; }
function normalizePairCode(value){ return clean(value).toUpperCase().replace(/[^A-Z0-9]/g,''); }

async function accessFor(projectId, uid){
  const [projectSnap,userSnap]=await Promise.all([db.doc(`projects/${projectId}`).get(),db.doc(`users/${uid}`).get()]);
  if(!projectSnap.exists) throw new HttpsError('not-found','REVEX project not found.');
  const project=projectSnap.data()||{};
  const user=userSnap.exists?userSnap.data()||{}:{};
  const role=projectAccessRole(project,user,uid);
  if(!role) throw new HttpsError('permission-denied','You do not have access to this REVEX project.');
  return {project:{id:projectSnap.id,...project},user,role};
}
function cors(res){
  res.set('Access-Control-Allow-Origin','*');
  res.set('Access-Control-Allow-Headers','Authorization, Content-Type, Accept');
  res.set('Access-Control-Allow-Methods','POST, OPTIONS');
  res.set('Cache-Control','no-store');
}
function json(res,status,body){ cors(res); res.status(status).type('application/json').send(JSON.stringify(body)); }
function errorText(error){ return clean(error?.message||error||'Unknown error').slice(0,1200); }
function sessionRefForToken(token){ return db.doc(`revexObserverAgentSessions/${sha256(token)}`); }
function requestFingerprint(req){
  const forwarded=clean(req.get('x-forwarded-for')).split(',')[0].trim();
  const ua=clean(req.get('user-agent')).slice(0,240);
  return sha256(`observer-counter-v1|${forwarded}|${ua}`);
}
async function enforcePublicRate(req){
  const ref=db.doc(`revexObserverPublicCounterRate/${requestFingerprint(req)}`);
  const t=nowMs();
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref); const row=snap.exists?snap.data()||{}:{};
    const start=Number(row.windowStartMs||0);
    const fresh=!start||t-start>=PUBLIC_RATE_WINDOW_MS;
    const count=fresh?0:Number(row.count||0);
    if(count>=PUBLIC_RATE_LIMIT) throw new Error('counter_rate_limited');
    tx.set(ref,{windowStartMs:fresh?t:start,count:count+1,lastSeenAtMs:t,updatedAt:FieldValue.serverTimestamp()},{merge:false});
  });
}
async function loadSessionFromRequest(req){
  const auth=clean(req.get('authorization'));
  const match=auth.match(/^Bearer\s+(.+)$/i);
  if(!match) return {error:'missing_bearer'};
  const token=clean(match[1]);
  if(token.length<32) return {error:'invalid_bearer'};
  const ref=sessionRefForToken(token);
  const snap=await ref.get();
  if(!snap.exists) return {error:'unknown_session'};
  const session=snap.data()||{};
  if(session.revoked===true) return {error:'revoked_session'};
  if(Number(session.expiresAtMs||0)<=nowMs()) return {error:'expired_session'};
  return {token,ref,session};
}
function boundFocusOkay(session,args){
  const bound=clean(session.focusId);
  if(!bound) return true;
  const supplied=clean(args?.focusId||args?.operation?.focusId||args?.spec?.focusId);
  return !supplied || supplied===bound || supplied.startsWith(`${bound}.`);
}
function toolContent(value){ return [{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}]; }
function mcpResult(id,value,isError=false){ return {jsonrpc:'2.0',id,result:{content:toolContent(value),isError}}; }
function mcpError(id,code,message,data){ return {jsonrpc:'2.0',id,error:{code,message,...(data?{data}: {})}}; }

exports.issueRevexObserverAnonymousClaim = onRequest({region:REGION,timeoutSeconds:20,memory:'256MiB',maxInstances:4}, async (req,res)=>{
  cors(res); if(req.method==='OPTIONS') return res.status(204).send('');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  try{
    await enforcePublicRate(req);
    const claimKey=`liber_claim_${b64url(24)}`;
    const claimHash=sha256(claimKey);
    const createdAtMs=nowMs(); const expiresAtMs=createdAtMs+CLAIM_TTL_MS;
    await db.doc(`revexObserverAgentClaims/${claimHash}`).set({
      schema:'liber.revex.observer-agent-claim.v2',kind:'PUBLIC_COUNTER',projectId:null,focusId:null,
      scopes:[...PUBLIC_SCOPES],ownerUid:null,accessRole:null,createdAtMs,expiresAtMs,
      createdAt:FieldValue.serverTimestamp(),claimedAt:null,claimed:false
    },{merge:false});
    return json(res,200,{
      ok:true,schema:'liber.revex.observer-agent-counter.v2',claimKey,claimExpiresAt:iso(expiresAtMs),
      claimUrl:CLAIM_URL,mcpUrl:MCP_URL,guideUrl:GUIDE_URL,discoveryUrl:DISCOVERY_URL,counterUrl:COUNTER_URL,
      projectBound:false,note:'No account required. This key opens one anonymous AI Observer lease. Pair a private project later with a one-time code issued from an authorized REVEX project session.'
    });
  }catch(error){
    const reason=errorText(error); return json(res,reason.includes('rate_limited')?429:500,{error:reason});
  }
});

exports.issueRevexObserverAgentClaim = onCall({region:REGION,timeoutSeconds:30}, async request=>{
  if(!request.auth?.uid) throw new HttpsError('unauthenticated','REVEX authorization is required for a project-bound claim.');
  const projectId=assertProjectId(request.data?.projectId);
  const focusId=assertFocusId(request.data?.focusId);
  const uid=String(request.auth.uid);
  const access=await accessFor(projectId,uid);
  const claimKey=`liber_claim_${b64url(24)}`;
  const claimHash=sha256(claimKey);
  const createdAtMs=nowMs(); const expiresAtMs=createdAtMs+CLAIM_TTL_MS;
  await db.doc(`revexObserverAgentClaims/${claimHash}`).set({
    schema:'liber.revex.observer-agent-claim.v2',kind:'AUTHORIZED_DIRECT',projectId,focusId:focusId||null,
    scopes:[...PROJECT_SCOPES],ownerUid:uid,accessRole:access.role,createdAtMs,expiresAtMs,
    createdAt:FieldValue.serverTimestamp(),claimedAt:null,claimed:false
  },{merge:false});
  return {ok:true,claimKey,projectId,focusId:focusId||null,scopes:[...PROJECT_SCOPES],claimExpiresAt:iso(expiresAtMs),claimUrl:CLAIM_URL,mcpUrl:MCP_URL,guideUrl:GUIDE_URL,discoveryUrl:DISCOVERY_URL,counterUrl:COUNTER_URL};
});

exports.issueRevexObserverPairCode = onCall({region:REGION,timeoutSeconds:30}, async request=>{
  if(!request.auth?.uid) throw new HttpsError('unauthenticated','Open REVEX while signed in before pairing an AI session.');
  const projectId=assertProjectId(request.data?.projectId);
  const focusId=assertFocusId(request.data?.focusId);
  const uid=String(request.auth.uid);
  const access=await accessFor(projectId,uid);
  const pairCode=randomPairCode(); const pairHash=sha256(normalizePairCode(pairCode));
  const createdAtMs=nowMs(); const expiresAtMs=createdAtMs+PAIR_TTL_MS;
  await db.doc(`revexObserverAgentPairs/${pairHash}`).set({
    schema:'liber.revex.observer-agent-pair.v1',projectId,focusId:focusId||null,ownerUid:uid,accessRole:access.role,
    scopes:[...PROJECT_SCOPES],createdAtMs,expiresAtMs,createdAt:FieldValue.serverTimestamp(),used:false,usedAt:null
  },{merge:false});
  return {ok:true,pairCode,projectId,focusId:focusId||null,expiresAt:iso(expiresAtMs),note:'Send this one-time pairing code to the AI session. It does not contain your Firebase credential.'};
});

exports.claimRevexObserverAgentSession = onRequest({region:REGION,timeoutSeconds:30}, async (req,res)=>{
  cors(res); if(req.method==='OPTIONS') return res.status(204).send('');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  try{
    const claimKey=clean(req.body?.claimKey);
    if(!/^liber_claim_[A-Za-z0-9_-]{20,}$/.test(claimKey)) return json(res,400,{error:'invalid_claim_key'});
    const claimRef=db.doc(`revexObserverAgentClaims/${sha256(claimKey)}`);
    const accessToken=`liber_obs_${b64url(32)}`; const tokenHash=sha256(accessToken);
    const sessionId=`obs_${b64url(12)}`; const claimedAtMs=nowMs(); const expiresAtMs=claimedAtMs+SESSION_TTL_MS;
    let claim=null;
    await db.runTransaction(async tx=>{
      const snap=await tx.get(claimRef); if(!snap.exists) throw new Error('unknown_claim');
      claim=snap.data()||{};
      if(claim.claimed===true||claim.claimedAt) throw new Error('claim_already_used');
      if(Number(claim.expiresAtMs||0)<=claimedAtMs) throw new Error('claim_expired');
      tx.update(claimRef,{claimed:true,claimedAt:FieldValue.serverTimestamp(),claimedAtMs,sessionId});
      tx.set(db.doc(`revexObserverAgentSessions/${tokenHash}`),{
        schema:'liber.revex.observer-agent-session.v2',sessionId,projectId:claim.projectId||null,focusId:claim.focusId||null,
        scopes:Array.isArray(claim.scopes)?claim.scopes:[...PUBLIC_SCOPES],ownerUid:claim.ownerUid||null,accessRole:claim.accessRole||null,
        paired:Boolean(claim.projectId),issuedAtMs:claimedAtMs,expiresAtMs,issuedAt:FieldValue.serverTimestamp(),revoked:false,lastUsedAtMs:claimedAtMs
      },{merge:false});
    });
    return json(res,200,{
      ok:true,schema:'liber.revex.observer-agent-session.v2',sessionId,accessToken,projectId:claim.projectId||null,focusId:claim.focusId||null,
      scopes:Array.isArray(claim.scopes)?claim.scopes:[...PUBLIC_SCOPES],paired:Boolean(claim.projectId),expiresAt:iso(expiresAtMs),mcpUrl:MCP_URL,guideUrl:GUIDE_URL,discoveryUrl:DISCOVERY_URL
    });
  }catch(error){
    const reason=errorText(error); const code=reason.includes('already_used')?409:reason.includes('expired')?410:reason.includes('unknown_claim')?404:500;
    return json(res,code,{error:reason});
  }
});

async function pairSession(sessionRef,session,pairCode){
  if(session.paired&&session.projectId) return {alreadyPaired:true,projectId:session.projectId,focusId:session.focusId||null,scopes:session.scopes||[]};
  const normalized=normalizePairCode(pairCode);
  if(!/^[A-Z2-9]{8}$/.test(normalized)) throw new Error('Invalid pairing code.');
  const pairRef=db.doc(`revexObserverAgentPairs/${sha256(normalized)}`);
  let pair=null;
  await db.runTransaction(async tx=>{
    const pairSnap=await tx.get(pairRef); const sessionSnap=await tx.get(sessionRef);
    if(!pairSnap.exists) throw new Error('Unknown pairing code.');
    if(!sessionSnap.exists) throw new Error('Observer session no longer exists.');
    pair=pairSnap.data()||{}; const current=sessionSnap.data()||{};
    if(pair.used===true||pair.usedAt) throw new Error('Pairing code was already used.');
    if(Number(pair.expiresAtMs||0)<=nowMs()) throw new Error('Pairing code expired.');
    if(current.revoked===true||Number(current.expiresAtMs||0)<=nowMs()) throw new Error('Observer session expired or was revoked.');
    tx.update(pairRef,{used:true,usedAtMs:nowMs(),usedAt:FieldValue.serverTimestamp(),sessionId:current.sessionId});
    tx.update(sessionRef,{projectId:pair.projectId,focusId:pair.focusId||null,ownerUid:pair.ownerUid,accessRole:pair.accessRole||null,scopes:[...PROJECT_SCOPES],paired:true,pairedAtMs:nowMs(),pairedAt:FieldValue.serverTimestamp()});
  });
  return {paired:true,projectId:pair.projectId,focusId:pair.focusId||null,scopes:[...PROJECT_SCOPES]};
}

exports.pullRevexObserverAgentRequests = onCall({region:REGION,timeoutSeconds:30}, async request=>{
  if(!request.auth?.uid) throw new HttpsError('unauthenticated','REVEX browser authorization is required.');
  const projectId=assertProjectId(request.data?.projectId); const uid=String(request.auth.uid);
  await accessFor(projectId,uid);
  const bridge=request.data?.bridge||{}; const clientId=clean(bridge.clientId).slice(0,160)||`revex_${uid}`;
  await db.doc(`projects/${projectId}/revexObserverAgentBridge/current`).set({
    schema:'liber.revex.observer-agent-bridge.v1',projectId,uid,clientId,observerVersion:clean(bridge.observerVersion).slice(0,120)||null,
    revision:clean(bridge.revision).slice(0,160)||null,activeView:clean(bridge.activeView).slice(0,240)||null,lastSeenAtMs:nowMs(),lastSeenAt:FieldValue.serverTimestamp()
  },{merge:true});
  const snap=await db.collection(`projects/${projectId}/revexObserverAgentRequests`).where('status','==','PENDING').limit(12).get();
  const claimed=[];
  for(const doc of snap.docs){
    if(claimed.length>=4) break;
    try{
      const row=await db.runTransaction(async tx=>{
        const fresh=await tx.get(doc.ref); if(!fresh.exists) return null;
        const data=fresh.data()||{};
        if(data.status!=='PENDING'||Number(data.expiresAtMs||0)<=nowMs()) return null;
        if(clean(data.ownerUid)!==uid) return null;
        tx.update(doc.ref,{status:'CLAIMED',claimedByUid:uid,claimedByClientId:clientId,claimedAtMs:nowMs(),claimedAt:FieldValue.serverTimestamp()});
        return {requestId:doc.id,tool:clean(data.tool),method:clean(data.method),args:data.args||{},focusId:data.focusId||null};
      });
      if(row) claimed.push(row);
    }catch(_){ }
  }
  return {ok:true,requests:claimed};
});

exports.completeRevexObserverAgentRequest = onCall({region:REGION,timeoutSeconds:30}, async request=>{
  if(!request.auth?.uid) throw new HttpsError('unauthenticated','REVEX browser authorization is required.');
  const projectId=assertProjectId(request.data?.projectId); const requestId=clean(request.data?.requestId);
  if(!/^[A-Za-z0-9_-]{8,200}$/.test(requestId)) throw new HttpsError('invalid-argument','requestId is invalid.');
  const uid=String(request.auth.uid); await accessFor(projectId,uid);
  const ref=db.doc(`projects/${projectId}/revexObserverAgentRequests/${requestId}`); const success=request.data?.success===true;
  let result=request.data?.result??null; const serialized=JSON.stringify(result);
  if(Buffer.byteLength(serialized,'utf8')>MAX_RESULT_BYTES) result={truncated:true,error:'Observer result exceeded relay limit.',bytes:Buffer.byteLength(serialized,'utf8')};
  await db.runTransaction(async tx=>{
    const snap=await tx.get(ref); if(!snap.exists) throw new HttpsError('not-found','Observer request not found.');
    const row=snap.data()||{};
    if(clean(row.claimedByUid)!==uid||row.status!=='CLAIMED') throw new HttpsError('permission-denied','Observer request is not claimed by this REVEX session.');
    tx.update(ref,{status:success?'COMPLETE':'FAILED',result:success?result:null,error:success?null:clean(request.data?.error).slice(0,4000),completedAtMs:nowMs(),completedAt:FieldValue.serverTimestamp()});
  });
  return {ok:true};
});

async function dispatchToRevex(session,tool,args){
  if(!session.paired||!session.projectId||!session.ownerUid) throw new Error('Pair this AI session with an authorized REVEX project before using project Observer tools.');
  const requestId=`req_${b64url(12)}`; const ref=db.doc(`projects/${session.projectId}/revexObserverAgentRequests/${requestId}`); const createdAtMs=nowMs();
  await ref.set({
    schema:'liber.revex.observer-agent-request.v1',requestId,sessionId:session.sessionId,ownerUid:session.ownerUid,
    projectId:session.projectId,focusId:session.focusId||null,tool:tool.name,method:tool.method,args:args||{},status:'PENDING',
    createdAtMs,expiresAtMs:createdAtMs+REQUEST_TTL_MS,createdAt:FieldValue.serverTimestamp()
  },{merge:false});
  const deadline=nowMs()+25000;
  while(nowMs()<deadline){
    await new Promise(resolve=>setTimeout(resolve,250));
    const snap=await ref.get(); const row=snap.exists?snap.data()||{}:{};
    if(row.status==='COMPLETE') return row.result;
    if(row.status==='FAILED') throw new Error(clean(row.error)||'REVEX Observer bridge request failed.');
  }
  await ref.set({status:'EXPIRED',completedAtMs:nowMs(),error:'No active authorized REVEX bridge serviced this request within 25 seconds.'},{merge:true});
  throw new Error('No active authorized REVEX session is servicing this project. Open REVEX on the paired project and try again.');
}

async function bootstrap(session){
  let bridge=null;
  if(session.projectId){
    const bridgeSnap=await db.doc(`projects/${session.projectId}/revexObserverAgentBridge/current`).get();
    const row=bridgeSnap.exists?bridgeSnap.data()||{}:null;
    if(row){ const age=nowMs()-Number(row.lastSeenAtMs||0); bridge={online:age<7000,lastSeenAt:row.lastSeenAtMs?iso(Number(row.lastSeenAtMs)):null,observerVersion:row.observerVersion||null,revision:row.revision||null,activeView:row.activeView||null}; }
  }
  return {
    schema:'liber.revex.observer-agent-bootstrap.v2',sessionId:session.sessionId,paired:Boolean(session.paired&&session.projectId),
    projectId:session.projectId||null,focusId:session.focusId||null,scopes:session.scopes||[],expiresAt:iso(Number(session.expiresAtMs)),
    observerMethod:'snapshot -> invariants -> preview -> bounded owner -> observe again -> compare delta -> record step',
    discoveryUrl:DISCOVERY_URL,guideUrl:GUIDE_URL,counterUrl:COUNTER_URL,mcpUrl:MCP_URL,bridge,
    mutationAvailable:false,
    next:session.projectId?'Use the project Observer tools within the returned scopes.':'Ask an authorized REVEX collaborator to open the target project, press Pair AI, and send the one-time pairing code. Then call observer_pair.'
  };
}

exports.revexObserverMcp = onRequest({region:REGION,timeoutSeconds:60,memory:'512MiB'}, async (req,res)=>{
  cors(res); if(req.method==='OPTIONS') return res.status(204).send('');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const loaded=await loadSessionFromRequest(req); if(loaded.error) return json(res,401,{error:loaded.error});
  const {ref:sessionRef}=loaded; let session=loaded.session;
  await sessionRef.set({lastUsedAtMs:nowMs(),lastUsedAt:FieldValue.serverTimestamp()},{merge:true});
  const rpc=req.body||{}; const id=rpc.id??null;
  try{
    if(rpc.jsonrpc!=='2.0') return json(res,400,mcpError(id,-32600,'Expected JSON-RPC 2.0.'));
    if(rpc.method==='initialize') return json(res,200,{jsonrpc:'2.0',id,result:{protocolVersion:clean(rpc.params?.protocolVersion)||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'LIBER REVEX Observer',version:'20260917r152-public-counter1'}}});
    if(rpc.method==='notifications/initialized') return res.status(204).send('');
    if(rpc.method==='ping') return json(res,200,{jsonrpc:'2.0',id,result:{}});
    if(rpc.method==='tools/list'){
      const scopes=new Set(session.scopes||[]);
      const tools=TOOL_DEFS.filter(tool=>!tool.scope||scopes.has(tool.scope)).map(({scope,method,...tool})=>tool);
      return json(res,200,{jsonrpc:'2.0',id,result:{tools}});
    }
    if(rpc.method!=='tools/call') return json(res,200,mcpError(id,-32601,`Unsupported method: ${clean(rpc.method)}`));
    const name=clean(rpc.params?.name); const args=rpc.params?.arguments||{}; const tool=TOOL_DEFS.find(row=>row.name===name);
    if(!tool) return json(res,200,mcpResult(id,{error:`Unknown tool: ${name}`},true));
    if(tool.scope&&!new Set(session.scopes||[]).has(tool.scope)) return json(res,200,mcpResult(id,{error:`Missing scope: ${tool.scope}`},true));
    if(name==='observer_bootstrap') return json(res,200,mcpResult(id,await bootstrap(session)));
    if(name==='observer_release'){
      await sessionRef.set({revoked:true,revokedAtMs:nowMs(),revokedAt:FieldValue.serverTimestamp()},{merge:true});
      return json(res,200,mcpResult(id,{released:true,sessionId:session.sessionId}));
    }
    if(name==='observer_pair'){
      const paired=await pairSession(sessionRef,session,args?.pairCode);
      const fresh=await sessionRef.get(); session=fresh.data()||session;
      return json(res,200,mcpResult(id,{...paired,bootstrap:await bootstrap(session)}));
    }
    if(!boundFocusOkay(session,args)) return json(res,200,mcpResult(id,{error:`This lease is bound to focus ${session.focusId}.`},true));
    const result=await dispatchToRevex(session,tool,args);
    return json(res,200,mcpResult(id,result));
  }catch(error){ return json(res,200,mcpResult(id,{error:errorText(error)},true)); }
});

module.exports = { PROJECT_SCOPES, PUBLIC_SCOPES };
